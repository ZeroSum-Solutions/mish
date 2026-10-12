import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
const resolvePackage = createRequire(import.meta.url).resolve;
export function resolveHiggsfieldCliPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OD_HIGGSFIELD_BIN?.trim()) return env.OD_HIGGSFIELD_BIN.trim();
  try { return join(dirname(resolvePackage('@higgsfield/cli/package.json')), 'vendor', process.platform === 'win32' ? 'hf.exe' : 'hf'); }
  catch { throw new Error('HiggsField CLI is unavailable; install @higgsfield/cli or update Mishh Mashh'); }
}
export function runHiggsfieldCli(args: readonly string[], input = '', timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveHiggsfieldCliPath(), [...args, '--json', '--no-color'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, env: { ...process.env, HIGGSFIELD_INSTALL_METHOD: 'npm' } });
    let output = ''; let tooLarge = false;
    child.stdout.on('data', chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 2 * 1024 * 1024) { tooLarge = true; child.kill(); } });
    // Provider stderr may contain secrets or signed URLs; never echo it.
    child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('error', () => reject(new Error('HiggsField CLI could not start')));
    child.on('close', code => code === 0 && !tooLarge ? resolve(output) : reject(new Error('HiggsField CLI request failed; check its sign-in and subscription before retrying')));
  });
}
let account: { configured: boolean; checkedAt: number } | undefined;
export async function higgsfieldSubscriptionConfigured(): Promise<boolean> {
  if (account && Date.now() - account.checkedAt < 10000) return account.configured;
  let configured = false;
  try { const result: unknown = JSON.parse(await runHiggsfieldCli(['account', 'status'], '', 10000)); configured = result !== null && typeof result === 'object' && typeof (result as Record<string, unknown>).subscription_plan_type === 'string'; } catch { /* A missing login is a Settings state, not a boot failure. */ }
  account = { configured, checkedAt: Date.now() }; return configured;
}
let loginRunning = false;
export function startHiggsfieldSubscriptionLogin(): void {
  if (loginRunning) return;
  const child = spawn(resolveHiggsfieldCliPath(), ['auth', 'login', '--no-color'], { shell: false, stdio: 'ignore', timeout: 180000, env: { ...process.env, HIGGSFIELD_INSTALL_METHOD: 'npm' } });
  loginRunning = true;
  const finished = () => { loginRunning = false; account = undefined; };
  child.on('error', finished); child.on('close', finished);
}
