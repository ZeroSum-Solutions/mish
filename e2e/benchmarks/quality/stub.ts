import { createServer } from 'node:http';
import { STUB_BRIEF_PREVIEW } from '../../resources/quality-brief-preview.ts';
import type { AddressInfo } from 'node:net';
export async function startStub(options: { agencyWithoutPages?: boolean; previewDelayMs?: number; chatStatus?: string; status?: string; unsafePath?: string; cancelFails?: boolean; neverTerminal?: boolean; htmlSuffix?: string; files?: Record<string, string | Buffer>; kitFiles?: Record<string, string | Buffer>; runMetadata?: Record<string, unknown> } = {}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const projects = new Map<string, Record<string, string | Buffer>>();
  const canceled = new Set<string>();
  const appConfig: { improvePromptTransformer?: string | null } = {};
  const agencyBuilds = new Map<string, string>();
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += String(chunk);
    const path = new URL(req.url!, 'http://stub').pathname;
    requests.push({ method: req.method!, path, body: text ? JSON.parse(text) : null });
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (path === '/api/health') return json({ ok: true });
    // compare mode: chat-run projects, Improve prompt writers, and the agency build path.
    const page = (title: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:20px system-ui;margin:32px}</style></head><body><main><h1>${title}</h1><p>Synthetic compare fixture.</p><a href="#contact">Contact</a><section id="contact"><h2>Contact</h2></section></main></body></html>`;
    if (path === '/api/app-config' && req.method === 'GET') return json({ config: { improvePromptTransformer: appConfig.improvePromptTransformer ?? null } });
    if (path === '/api/app-config' && req.method === 'PUT') { const body = JSON.parse(text) as Record<string, unknown>; appConfig.improvePromptTransformer = body.improvePromptTransformer as string | null; return json({ config: appConfig }); }
    if (path === '/api/workbench/briefs/transformer') return json({ status: { lane: appConfig.improvePromptTransformer ?? 'terra', terraModel: 'stub-terra', terraKeyAvailable: true, fallbackModel: 'stub-claude' } });
    if (path === '/api/workbench/briefs/preview' && req.method === 'POST') { if (options.previewDelayMs) await new Promise(resolve => setTimeout(resolve, options.previewDelayMs)); const body = JSON.parse(text) as { originalText: string }; return json({ ...STUB_BRIEF_PREVIEW, originalText: body.originalText, assumptions: [`stub writer ${appConfig.improvePromptTransformer ?? 'terra'}`] }); }
    if (path === '/api/projects' && req.method === 'POST') { const body = JSON.parse(text) as { id: string }; projects.set(body.id, {}); return json({ project: { id: body.id } }, 201); }
    if (path === '/api/workbench/briefs/attach' && req.method === 'POST') { const body = JSON.parse(text) as { projectId: string }; return json({ id: `brief-${body.projectId}`, brief: { revision: 1, hash: 'a'.repeat(64) } }, 201); }
    if (path === '/api/runs' && req.method === 'POST') {
      const body = JSON.parse(text) as { projectId: string; brief?: unknown };
      const files = projects.get(body.projectId); if (!files) return json({ error: 'no project' }, 404);
      files['landing.html'] = page(body.brief ? 'Built from a brief' : 'Built from the request'); files['notes.md'] = 'Synthetic notes';
      return json({ runId: `${body.projectId}-run` }, 202);
    }
    const pkg = /^\/api\/runs\/([^/]+)\/result-package$/u.exec(path);
    if (pkg) return json({ artifacts: [{ file: 'landing.html' }] });
    if (path === '/api/agency/build' && req.method === 'POST') {
      const projectId = `agency-project-${projects.size + 1}`; projects.set(projectId, options.agencyWithoutPages ? { 'notes.md': 'No page' } : { 'index.html': page('Agency build') });
      agencyBuilds.set(`agency-${projectId}`, projectId);
      return json({ build: { id: `agency-${projectId}`, status: 'building', startedAt: new Date().toISOString(), events: [] } }, 202);
    }
    const agency = /^\/api\/agency\/builds\/([^/]+)$/u.exec(path);
    if (agency && agencyBuilds.has(agency[1]!)) return json({ build: { id: agency[1], status: 'done', projectId: agencyBuilds.get(agency[1]!), family: 'stub', provider: 'deepseek', model: 'stub-fill', startedAt: new Date().toISOString(), events: [] } });
    if (path === '/api/version') return json({ version: 'stub' });
    if (path === '/api/build-on-brand' && req.method === 'POST') {
      const request = JSON.parse(text) as { designSystemId: string };
      const projectId = `project-${projects.size + 1}`;
      const files: Record<string, string | Buffer> = { 'tokens.css': ':root{--bg:#faf5ee;--fg:#41352e}', 'assets/photo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250"><rect width="400" height="250" fill="#d6c5b0"/></svg>' };
      const pages = ['index.html', 'services.html', 'about.html', 'contact.html'];
      for (const page of pages) files[page] = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="tokens.css"><title>Stub fixture</title><style>body{background:var(--bg);color:var(--fg);font:20px system-ui;margin:32px}img{max-width:100%}@media(prefers-reduced-motion:reduce){*{animation:none}}</style></head><body><nav>${pages.map(file => `<a href="${file}">${file}</a>`).join(' | ')}</nav><h1>Synthetic benchmark fixture</h1><p>${page}. This is harness evidence only.</p><img src="assets/photo.svg" alt="Synthetic colour block">${options.htmlSuffix ?? ''}</body></html>`;
      Object.assign(files, options.files);
      projects.set(projectId, files);
      return json({ projectId, conversationId: `${projectId}-conversation`, runId: `${projectId}-run`, plan: { pageCount: 4, useLibrary: true, target: 'static-html', designSystem: { id: request.designSystemId, binding: { tokensStylesheet: 'tokens.css' } }, pages: pages.map((file, i) => ({ file, role: ['home', 'services', 'about', 'contact'][i], sections: [{ role: 'hero', source: 'kit' }, { role: 'footer', source: 'kit' }] })), libraryInserts: [] } }, 202);
    }
    if (options.kitFiles && /^\/api\/design-systems\/[^/]+\/files$/u.test(path)) return json({ files: [{ path: 'assets', kind: 'folder' }, ...Object.keys(options.kitFiles).map(path => ({ path, kind: 'file' }))] });
    if (options.kitFiles && /^\/api\/design-systems\/[^/]+\/static$/u.test(path)) {
      const name = new URL(req.url!, 'http://stub').searchParams.get('path') ?? '';
      const bytes = options.kitFiles[name]; if (bytes !== undefined) { res.end(bytes); return; }
    }
    const runMatch = /^\/api\/runs\/([^/]+)(\/cancel)?$/u.exec(path);
    if (runMatch) {
      if (runMatch[2]) { if (options.cancelFails) return json({}, 500); canceled.add(runMatch[1]!); return json({ ok: true }); }
      const chat = !runMatch[1]!.startsWith('project-');
      return json({ status: canceled.has(runMatch[1]!) ? 'canceled' : options.neverTerminal ? 'running' : (chat ? options.chatStatus : undefined) ?? options.status ?? 'succeeded', model: 'stub', agentId: 'stub', ...options.runMetadata });
    }
    const match = /^\/api\/projects\/([^/]+)\/(.+)$/u.exec(path);
    const files = match && projects.get(match[1]!);
    if (files && match) {
      if (match[2] === 'site-check') return json({ ok: true, pages: Object.keys(files).filter(file => file.endsWith('.html')), rules: [{ id: 'pages-present', ok: true, detail: 'Synthetic stub check' }] });
      if (match[2] === 'files') return json({ files: Object.keys(files).map(name => ({ name, path: options.unsafePath ?? name, type: 'file' })) });
      if (match[2]!.startsWith('raw/')) { const value = files[decodeURIComponent(match[2]!.slice(4))]; if (value !== undefined) { res.end(value); return; } }
    }
    json({ error: 'not found' }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
