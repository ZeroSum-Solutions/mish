import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DesignSystemSummary } from '@open-design/contracts';

const exec = promisify(execFile);

/** Obtain mock response fixtures from the public daemon seed/approval paths. */
export async function approvedDesignSystemFixtures(titles: readonly string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'od-web-kit-fixtures-'));
  const namespace = `web-kits-${randomUUID()}`;
  const repo = path.resolve('../..');
  const tool = path.join(repo, 'tools/dev/bin/tools-dev.mjs');
  const env = { ...process.env, OD_DATA_DIR: path.join(root, 'data'), AMR_HOME: path.join(root, 'amr'), OPEN_DESIGN_VELA_TELEMETRY: 'off' };
  const run = (args: string[]) => exec(process.execPath, [tool, ...args, '--namespace', namespace, '--tools-dev-root', root, '--no-env-file', '--json'], { cwd: repo, env, maxBuffer: 8 * 1024 * 1024 });
  const stop = async () => { await run(['stop', 'daemon']); await rm(root, { recursive: true, force: true }); };
  try {
    await run(['start', 'daemon']);
    const { stdout } = await run(['status']);
    const status = JSON.parse(stdout) as { apps: { daemon: { url: string } } };
    const url = status.apps.daemon.url;
    async function request(route: string, method = 'GET', body?: unknown) {
      const response = await fetch(url + route, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error(`Kit fixture ${method} ${route}: ${await response.text()}`);
      return response.json();
    }
    const builtIn = (await request('/api/design-systems') as { designSystems: DesignSystemSummary[] }).designSystems.find(kit => kit.id === 'neutral-product')!;
    if (builtIn.approval?.status !== 'approved') throw new Error('Built-in approval seed is missing');
    const kits = new Map<string, DesignSystemSummary>([['Neutral Product', builtIn]]);
    for (const title of titles) {
      const created = await request('/api/design-systems', 'POST', { title, status: 'published' }) as { designSystem: DesignSystemSummary };
      const id = created.designSystem.id;
      const catalog = await request('/api/design-systems') as { designSystems: DesignSystemSummary[] };
      const kit = catalog.designSystems.find(item => item.id === id)!;
      const approved = await request(`/api/design-systems/${encodeURIComponent(id)}/approval`, 'PUT', { approved: true, expectedRevision: kit.approval!.revision }) as { designSystem: DesignSystemSummary };
      kits.set(title, approved.designSystem);
    }
    return { kits, request, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
