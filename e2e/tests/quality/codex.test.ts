import { T } from '../../lib/timeouts.ts';
import { expect, test, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as judge from '../../benchmarks/quality/judge.ts';
test('Codex subscription vision adapter pins priority, images and schema and refuses API auth', async () => {
  const root = await mkdtemp(join(tmpdir(),'quality-codex-'));
  const binary = join(root,'codex');
  await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='login'){console.error('Logged in using ChatGPT');}else{let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const args=process.argv.slice(2);fs.writeFileSync('../received.json',JSON.stringify({args,input,apiKey:!!process.env.OPENAI_API_KEY}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({grade:'C'}));console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));});}`, {mode:0o700});
  vi.stubEnv('PATH',root); vi.stubEnv('OPENAI_API_KEY','synthetic'); vi.stubEnv('OPENAI_BASE_URL','https://billed');
  try {
    const result = await judge.callCodex('evidence', ['image.png'], {type:'object'}, 'gpt-6.1-sol', root, T.short);
    expect(result.models).toEqual([]); // The CLI did not emit an actual model identity.
    expect(result.receipt).toMatchObject({requestedModel:'gpt-6.1-sol',observedModels:[]});
    const received=JSON.parse(await readFile(join(root,'received.json'),'utf8'));
    expect(received.args).toContain('service_tier="priority"'); expect(received.args).toContain('forced_login_method="chatgpt"');
    expect(received.args).toContain('--ignore-user-config'); expect(received.args).toContain('--output-schema');
    expect(received.args[received.args.indexOf('-i')+1]).toBe('image.png'); expect(received.apiKey).toBe(false);
    await writeFile(binary,`#!${process.execPath}\nconsole.error('Logged in using an API key');`,{mode:0o700});
    await expect(judge.callCodex('evidence', ['image.png'], {}, 'gpt-6.1-sol',root,T.short)).rejects.toThrow(/subscription|API billing/i);
    await expect(judge.callCodex('evidence', ['image.png'], {}, 'gpt-other',root,T.short)).rejects.toThrow(/model/i);
  } finally { vi.unstubAllEnvs(); await rm(root,{recursive:true,force:true}); }
});

test.each([0, 1])('keeps sanitised error events and scratch on Codex failure (exit %s)', async code => {
  const root = await mkdtemp(join(tmpdir(), 'quality-codex-failure-'));
  await writeFile(join(root, 'codex'), `#!${process.execPath}\nif(process.argv[2]==='login'){console.error('Logged in using ChatGPT');}else{process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'error',message:'Authorization: Bearer fake-private-token api_key=sk-private'}));console.log(JSON.stringify({type:'turn.failed',error:{message:'image budget exceeded'}}));process.exit(${code});});}`, {mode:0o700});
  vi.stubEnv('PATH', root);
  try {
    const error = await judge.callCodex('evidence', [], {}, 'gpt-6.1-sol', root, T.short).catch(e => e);
    expect(error.receipt.events).toEqual(expect.arrayContaining([expect.objectContaining({type:'turn.failed'})]));
    expect(JSON.stringify(error.receipt)).toContain('image budget exceeded');
    expect(JSON.stringify(error.receipt)).not.toContain('fake-private-token');
    expect(JSON.stringify(error.receipt)).not.toContain('sk-private');
    const disk = JSON.parse(await readFile(join(error.receipt.scratch, 'failure.json'), 'utf8'));
    expect(disk).toEqual(error.receipt);
  } finally { vi.unstubAllEnvs(); await rm(root, {recursive:true,force:true}); }
});
test('sanitises credentials embedded in diagnostic strings', async () => {
  const { sanitiseDiagnostic } = await import('../../benchmarks/quality/subscription.ts');
  const raw = 'body {"access_token":"private-json-secret"} Authorization: Basic private-basic Cookie: session=private-cookie';
  const value = String(sanitiseDiagnostic(raw));
  expect(value).not.toContain('private-json-secret'); expect(value).not.toContain('private-basic'); expect(value).not.toContain('private-cookie');
  expect(value).toContain('[REDACTED]');
});
