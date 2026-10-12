import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Atlas Digest G4 review. Every text that teaches an agent the media
// generate→wait loop must match what the CLI now prints:
//
//   done        {"taskId":…,"status":"done","file":{…}}           exit 0
//   superseded  {"taskId":…,"status":"done","error":{"nextStep":"output-superseded",…}}  exit 5
//   handoff     {"taskId":…,"status":"running","nextSince":n}       exit 0 / 2
//
// A done result now carries `taskId`, so a loop that keeps polling "whenever
// the output contains a taskId" no longer describes the contract; loops key
// on `status`. And a superseded output is not a content refusal: it has its
// own next step, `output-superseded`, with its own sentence.
//
// Both prompt implementations carry these texts (docs/prompt-composition.md):
// the daemon copies and the API/BYOK copies in packages/contracts. OD Next
// carries no media loop or next-step text (only IMAGE_PROVIDER_DEFAULTS_CONTRACT),
// so there is nothing to change on that side.

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

/** The template literal as the model reads it: escaped backticks unescaped. */
function asRendered(text: string): string {
  return text.replace(/\\`/g, '`');
}

function templateBody(text: string, exportName: string): string {
  for (const marker of [`export const ${exportName} = \``, `const ${exportName} = \``]) {
    const start = text.indexOf(marker);
    if (start < 0) continue;
    let index = start + marker.length;
    while (index < text.length) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '`') return text.slice(start + marker.length, index);
      index += 1;
    }
  }
  throw new Error(`${exportName} not found`);
}

const daemonMedia = source('../../src/prompts/media-contract.ts');
const contractsMedia = source('../../../../packages/contracts/src/prompts/media-contract.ts');
const daemonSystem = source('../../src/prompts/system.ts');
const cli = source('../../src/cli.ts');

const replyBodies = {
  daemon: asRendered(templateBody(daemonMedia, 'MEDIA_USER_REPLY_CONTRACT')),
  contracts: asRendered(templateBody(contractsMedia, 'MEDIA_USER_REPLY_CONTRACT')),
};

const loopTexts = {
  'daemon MEDIA_GENERATION_CONTRACT': templateBody(daemonMedia, 'MEDIA_GENERATION_CONTRACT'),
  'daemon MEDIA_DISPATCH_HINT': templateBody(daemonSystem, 'MEDIA_DISPATCH_HINT'),
  'od media help': cli.slice(cli.indexOf('function printMediaHelp'), cli.indexOf('// Subcommand: od mcp')),
};

const resultTexts = {
  ...loopTexts,
  'contracts MEDIA_GENERATION_CONTRACT': templateBody(contractsMedia, 'MEDIA_GENERATION_CONTRACT'),
};

describe('output-superseded reply contract', () => {
  it.each(Object.entries(replyBodies))('%s copy gives a replaced output its own sentence', (_name, body) => {
    const normalized = body.replace(/\s+/g, ' ');
    expect(normalized).toContain('closed set of ten values');
    expect(body).toContain('`output-superseded`');
    const supersededLines = body
      .split('\n- ')
      .filter((entry) => entry.includes('`output-superseded`'));
    expect(supersededLines.length).toBeGreaterThan(0);
    for (const entry of supersededLines) {
      expect(entry).not.toMatch(/content review|内容审核|Reword/);
    }
    expect(normalized).toContain('The image was replaced before it could be used. Generate it again.');
    expect(body).toContain('图片在交付前被替换了 —— 重新生成一次。');
  });
});

describe('generate→wait result shape', () => {
  it.each(Object.entries(resultTexts))('%s documents the task-bound result', (_name, text) => {
    const normalized = text.replace(/\s+/g, ' ');
    expect(normalized).toMatch(/"status"\s*:\s*"done"/);
    expect(normalized).toContain('output-superseded');
    expect(normalized).toMatch(/exit[s]? \\?`?5/);
  });

  it.each(Object.entries(loopTexts))('%s loop keys on status, not on the presence of taskId', (_name, text) => {
    expect(text).toContain("in ('queued','running')");
    expect(text).not.toContain("print(d.get('taskId',''))\"");
    expect(text).not.toContain(".get('taskId',''))\"");
    expect(asRendered(text)).not.toContain('Whenever the output contains a `taskId`');
  });
});
