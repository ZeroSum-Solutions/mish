import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, lstat, open, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { parseAttachIntakeResponse, parseClearIntakeRequest, parseIntakeBatchSnapshot, parseIntakeFilePutResponse, parseListIntakeBatchesResponse, type IntakeBatchSnapshot, type IntakeFileOutcome } from '@open-design/contracts';
import { withReadabilityNotice } from './intake-policy.js';
import { fetchWithScopedToolToken, resolveDaemonUrl } from '../daemon-url.js';
import type { WorkbenchCliOptions } from '../workbench-cli.js';
const usage = 'od workbench intake [--file <path> ...] [--project <id>] [--dir <relative-folder>] [--batch <id>] --json\nod workbench intake show [--batch <id>] [--project <id>] --json\nod workbench intake clear --batch <id> [--file-id <id> ...] --json\nod workbench intake attach --batch <id> --project <id> --conversation <id> [--file-id <id> ...] --json\nod workbench intake retry --batch <id> --file-id <id> [--project <id>] --json\nod workbench intake download --batch <id> --file-id <id> --output <path> [--project <id>] --json\nAll commands accept --daemon-url and paired --workspace / --workspace-member.';
/** Every printed receipt labels opaque stored files (AC-R01.3); the HTTP shapes stay unchanged. */
const labeled = <T extends { files: IntakeFileOutcome[] }>(value: T) => ({ ...value, files: value.files.map(withReadabilityNotice) });
const labeledList = (value: { batches: IntakeBatchSnapshot[] }) => ({ batches: value.batches.map(labeled) });
class InvalidIntakeInput extends Error {}
class DownloadMismatch extends Error {}
class DownloadOutputChanged extends Error {}
class DaemonRefusal extends Error {
  constructor(public status: number, public payload: unknown) { super('Daemon refused intake'); }
}
function parse(args: string[]) {
  const modes = ['show','clear','attach','download','retry']; const mode = modes.includes(args[0] ?? '') ? args[0]! : 'add';
  const rest = mode === 'add' ? args : args.slice(1), flags: Record<string,string> = {}, files: string[] = [], fileIds: string[] = [];
  const allowed = ['--daemon-url','--workspace','--workspace-member','--batch', ...(mode === 'add' ? ['--file','--project','--dir'] : mode === 'attach' ? ['--project','--conversation','--file-id'] : mode === 'clear' ? ['--file-id'] : mode === 'download' ? ['--file-id','--output','--project'] : mode === 'show' ? ['--project'] : mode === 'retry' ? ['--file-id','--project'] : [])];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!; if (flag === '--json') { if (flag in flags) throw new Error('Duplicate --json'); flags[flag]='true'; continue; }
    if (!allowed.includes(flag)) throw new Error(`Unknown intake option: ${flag}`);
    const value = rest[++i]; if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--file') files.push(value); else if (flag === '--file-id') fileIds.push(value); else { if (flag in flags) throw new Error(`Duplicate option: ${flag}`); flags[flag] = value; }
  }
  if (!flags['--json']) throw new Error('--json is required');
  if (mode === 'add' && (!files.length || files.length > 20)) throw new Error('Choose 1–20 --file inputs');
  if (['clear','attach','download','retry'].includes(mode) && !flags['--batch']) throw new Error(`${mode} requires --batch`);
  if (mode === 'attach' && (!flags['--project'] || !flags['--conversation'])) throw new Error('attach requires --project and --conversation');
  if (fileIds.length) { try { parseClearIntakeRequest({ clientFileIds: fileIds }); } catch { throw new Error('Choose 1–20 distinct UUID --file-id inputs'); } }
  if (mode === 'download' && (fileIds.length !== 1 || !flags['--output'] || flags['--output'] === '-')) throw new Error('download requires one --file-id and an explicit --output file path');
  if (mode === 'retry' && fileIds.length !== 1) throw new Error('retry requires one --file-id');
  if (flags['--dir'] && !flags['--project']) throw new Error('--dir requires --project');
  if (('--workspace' in flags) !== ('--workspace-member' in flags) || ['--workspace','--workspace-member'].some(flag => flag in flags && !flags[flag]!.trim())) throw new Error('Pass --workspace and --workspace-member together');
  return { mode, flags, files, fileIds };
}
/** Client-owned export only; the existing receipt download remains the authority boundary. */
async function saveDownload(response: Response, file: IntakeFileOutcome | undefined, output: string) {
  const reader = response.body?.getReader();
  if (!reader || !file?.stored) { await reader?.cancel(); throw new DownloadMismatch(); }
  const saved = file.stored, target = path.resolve(output); let handle: FileHandle | undefined;
  try {
    try { handle = await open(target, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') throw new InvalidIntakeInput('Output already exists; choose a new output file'); throw error; }
    const hash = createHash('sha256'); let size = 0;
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > saved.size || size > file.descriptor.size) throw new DownloadMismatch();
      hash.update(chunk.value); await handle.writeFile(chunk.value);
    }
    const contentHash = hash.digest('hex');
    if (size !== saved.size || size !== file.descriptor.size || contentHash !== saved.contentHash) throw new DownloadMismatch();
    await handle.sync();
    const owned = await handle.stat(), current = await lstat(target).catch(() => undefined);
    if (current?.dev !== owned.dev || current.ino !== owned.ino) throw new DownloadOutputChanged();
    return { clientFileId: file.clientFileId, assetId: saved.assetId, filename: file.descriptor.filename, size, contentHash, output: target };
  } catch (error) {
    if (handle) {
      // Do not unlink a replacement another process put at the output path.
      const owned = await handle.stat(), current = await lstat(target).catch(() => undefined);
      if (current?.dev === owned.dev && current.ino === owned.ino) await unlink(target);
    }
    throw error;
  } finally { await handle?.close(); await reader.cancel().catch(() => {}); }
}
export async function runIntakeCli(args: string[], options: WorkbenchCliOptions = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`));
  if (args.length === 1 && ['--help','-h'].includes(args[0]!)) { write({usage}); return 0; }
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(args); } catch (error) { write({error:{code:'invalid-cli-input',message:error instanceof Error ? error.message : 'Invalid intake input'}}); return 2; }
  try {
    const {mode,flags,files,fileIds} = parsed, env = options.env ?? process.env;
    const base = (await resolveDaemonUrl({flagUrl:flags['--daemon-url'] ?? options.baseUrl ?? null,env})).replace(/\/$/,'')+'/api/workbench/intake';
    const headers = { ...(flags['--project'] ? {'x-od-project-id':flags['--project']} : {}), ...(flags['--workspace'] ? {'x-od-workspace-id':flags['--workspace']!.trim(),'x-od-workspace-member-id':flags['--workspace-member']!.trim()} : {}) };
    const call = async (suffix: string, init: RequestInit = {}): Promise<unknown> => {
      const response = await fetchWithScopedToolToken(base+suffix,{...init,headers:{...headers,...init.headers}}, env); const body: unknown = await response.json();
      if (!response.ok) throw new DaemonRefusal(response.status,body); return body;
    };
    const batchPath = flags['--batch'] ? `/${encodeURIComponent(flags['--batch'])}` : '';
    if (mode === 'show') { write(batchPath ? labeled(parseIntakeBatchSnapshot(await call(batchPath))) : labeledList(parseListIntakeBatchesResponse(await call(`?state=pending${flags['--project'] ? `&projectId=${encodeURIComponent(flags['--project'])}` : ''}`)))); return 0; }
    if (mode === 'clear') { write(labeled(parseIntakeBatchSnapshot(await call(batchPath,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify(fileIds.length ? {clientFileIds:fileIds} : {})})))); return 0; }
    if (mode === 'attach') { write(labeled(parseAttachIntakeResponse(await call(batchPath+'/attach',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:flags['--project'],conversationId:flags['--conversation'],...(fileIds.length ? {clientFileIds:fileIds} : {})})})))); return 0; }
    if (mode === 'retry') {
      const result = parseIntakeFilePutResponse(await call(`${batchPath}/files/${encodeURIComponent(fileIds[0]!)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-od-intake-retry': 'placement' }, body: new Uint8Array(0) }));
      write({ ...result, file: withReadabilityNotice(result.file) }); return result.file.hasSuccessfulAttachment ? 0 : 3;
    }
    if (mode === 'download') {
      const snapshot = parseIntakeBatchSnapshot(await call(batchPath)), fileId = fileIds[0]!;
      const response = await fetchWithScopedToolToken(`${base}${batchPath}/files/${encodeURIComponent(fileId)}/download`, { headers, redirect: 'error' }, env);
      if (!response.ok) throw new DaemonRefusal(response.status, await response.json());
      const receipt = await saveDownload(response, snapshot.files.find(file => file.clientFileId === fileId), flags['--output']!);
      write({ intakeBatchId: snapshot.intakeBatchId, ...receipt }); return 0;
    }
    const descriptors = await Promise.all(files.map(async (file,order) => {
      let info; try { info = await stat(file); } catch { throw new InvalidIntakeInput('Unable to read the local input file'); }
      if (!info.isFile()) throw new InvalidIntakeInput('Choose ordinary local files');
      return { clientFileId:randomUUID(),order,filename:path.basename(file),size:info.size };
    }));
    let snapshot: IntakeBatchSnapshot;
    if (batchPath) {
      snapshot = parseIntakeBatchSnapshot(await call(batchPath));
      if (snapshot.files.length !== files.length) throw new InvalidIntakeInput('Reselection must supply all files in original batch order');
      // Validate the entire reselection before any raw PUT can change a sibling.
      for (let index = 0; index < descriptors.length; index++) {
        const selected = descriptors[index]!, frozen = snapshot.files[index]!.descriptor;
        if (selected.filename !== frozen.filename || selected.size !== frozen.size) throw new InvalidIntakeInput('Reselected file name and size must match the frozen descriptor');
      }
      if (flags['--project'] && (snapshot.destination.kind !== 'project' || snapshot.destination.projectId !== flags['--project'])) throw new InvalidIntakeInput('Reselection cannot change the frozen project');
      if (flags['--dir'] && (snapshot.destination.kind !== 'project' || (snapshot.destination.dir ?? '') !== flags['--dir'])) throw new InvalidIntakeInput('Reselection cannot change the frozen folder');
    } else {
      snapshot = parseIntakeBatchSnapshot(await call('',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({intakeBatchId:randomUUID(),destination:flags['--project'] ? {kind:'project',projectId:flags['--project'],...(flags['--dir'] ? {dir:flags['--dir']} : {})} : {kind:'pending'},files:descriptors})}));
    }
    const refusals: unknown[] = [];
    for (let index = 0; index < files.length; index++) {
      const outcome = snapshot.files[index]!;
      if (outcome.state === 'stored' || outcome.state === 'cleared' || (outcome.state === 'failed' && !outcome.retryable)) continue;
      // Node fetch streams the local file with duplex:half; no base64/whole-file buffer.
      const stream = createReadStream(files[index]!);
      try {
        parseIntakeFilePutResponse(await call(`/${snapshot.intakeBatchId}/files/${outcome.clientFileId}`,{method:'PUT',headers:{'content-type':'application/octet-stream'},body:stream as unknown as NonNullable<RequestInit['body']>,duplex:'half'} as RequestInit));
      } catch (error) { if (error instanceof DaemonRefusal) refusals.push({clientFileId:outcome.clientFileId,status:error.status,response:error.payload}); else throw error; }
      finally { stream.destroy(); }
    }
    snapshot = parseIntakeBatchSnapshot(await call(`/${snapshot.intakeBatchId}`));
    write(refusals.length ? {batch:labeled(snapshot),refusals} : labeled(snapshot));
    return refusals.length || snapshot.files.some(file => file.error || file.state === 'failed' || file.state === 'needs-reselection') ? 3 : 0;
  } catch (error) {
    if (error instanceof DownloadOutputChanged) { write({error:{code:'intake-download-output-changed',message:'The output path changed during download'}}); return 1; }
    if (error instanceof DownloadMismatch) { write({error:{code:'intake-download-mismatch',message:'Downloaded bytes do not match the saved intake receipt'}}); return 1; }
    if (error instanceof InvalidIntakeInput) { write({error:{code:'invalid-cli-input',message:error.message}}); return 2; }
    if (error instanceof DaemonRefusal) { write({status:error.status,...(typeof error.payload === 'object' && error.payload !== null ? error.payload : {error:{code:'transport-or-server-failure',message:'Invalid daemon refusal'}})}); return error.status === 400 ? 2 : [401,403,404,409,413,415,422].includes(error.status) ? 3 : 1; }
    write({error:{code:'transport-or-server-failure',message:'Unable to complete intake'}}); return 1;
  }
}
