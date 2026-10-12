import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFontCheckResponse, type ResourceDetailResponse, type ResourceSearchResponse } from '@open-design/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { registerWorkbenchFontRoutes } from '../../src/routes/workbench-fonts.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { createFontsResourceSource } from '../../src/workbench/resources-fonts.js';
import { REPO_BUNDLED_PLUGINS_ROOT } from './fonts-fixture.js';
import { savedContext, projectState } from './context-ranking-fixture.js';

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

async function start(): Promise<string> {
  const fonts = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT });
  const app = express(); app.use(express.json());
  const deps = { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [fonts] };
  registerWorkbenchRoutes(app, deps);
  registerWorkbenchFontRoutes(app, { ...deps, fonts });
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('AC-R11 HTTP and od parity for fonts', () => {
  it('od workbench search/inspect --category font returns the same DTOs as HTTP', async () => {
    const baseUrl = await start();
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['search', '--category', 'font', '--limit', '100', '--json'], { baseUrl, write: value => output.push(value) })).toBe(0);
    const search = output[0] as ResourceSearchResponse;
    expect(search.sourceStatuses.find(status => status.sourceId === 'fonts')).toMatchObject({ state: 'searched' });
    const fraunces = search.results.find(item => item.ref.itemId === 'fraunces')!;
    expect(fraunces.fontProfile?.family).toBe('Fraunces');
    expect(await runWorkbenchCli(['inspect', '--ref', fraunces.refKey, '--json'], { baseUrl, write: value => output.push(value) })).toBe(0);
    expect((output[1] as ResourceDetailResponse).resource).toEqual(fraunces);
    const http = await fetch(`${baseUrl}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ facets: { category: 'font' }, limit: 100 }) });
    expect(((await http.json()) as ResourceSearchResponse).results).toEqual(search.results);
  });

  it('od workbench font-check and POST /api/workbench/fonts/check agree', async () => {
    const baseUrl = await start();
    const output: unknown[] = [];
    await runWorkbenchCli(['search', '--category', 'font', '--limit', '100', '--json'], { baseUrl, write: value => output.push(value) });
    const fraunces = (output[0] as ResourceSearchResponse).results.find(item => item.ref.itemId === 'fraunces')!;
    expect(await runWorkbenchCli(['font-check', '--ref', fraunces.refKey, '--prompt-file', '-', '--weights', '400,900', '--styles', 'italic', '--json'], { baseUrl, readStdin: async () => 'Hello Ж', write: value => output.push(value) })).toBe(0);
    const cli = parseFontCheckResponse(output[1]);
    const http = await fetch(`${baseUrl}/api/workbench/fonts/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refKey: fraunces.refKey, text: 'Hello Ж', weights: [400, 900], styles: ['italic'] }) });
    expect(http.status).toBe(200);
    expect(parseFontCheckResponse(await http.json())).toEqual(cli);
    expect(cli.glyphs.declared.missing).toEqual([{ char: 'Ж', codepoint: 'U+0416' }]);
    expect(await runWorkbenchCli(['font-check', '--ref', 'not-a-ref', '--json'], { baseUrl, write: value => output.push(value) })).toBe(3);
    expect(output[2]).toMatchObject({ status: 404, error: { code: 'resource-ref-unknown' } });
    expect(await runWorkbenchCli(['font-check', '--ref', fraunces.refKey, '--weights', 'bold', '--json'], { baseUrl, write: value => output.push(value) })).toBe(2);
  });

  it('a non-font resource cannot be font-checked', async () => {
    const fonts = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT });
    const app = express(); app.use(express.json());
    registerWorkbenchFontRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [fonts], fonts });
    server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const forged = Buffer.from(JSON.stringify([1, 'genui', 'genui', 'x', 'sha256:x'])).toString('base64url');
    const response = await fetch(`${baseUrl}/api/workbench/fonts/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refKey: forged, text: 'a' }) });
    expect(response.status).toBe(404);
  });

  it('serves font bytes, notices and the specimen with locked-down headers', async () => {
    const baseUrl = await start();
    const search = await fetch(`${baseUrl}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Fraunces', facets: { category: 'font' } }) });
    const fraunces = ((await search.json()) as ResourceSearchResponse).results[0]!;
    const file = fraunces.fontProfile!.localFiles[0]!;
    const bytes = await fetch(`${baseUrl}${file.url}`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('content-type')).toBe('font/woff2');
    expect(bytes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(bytes.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(bytes.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(Buffer.from(await bytes.arrayBuffer()).subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect((await fetch(`${baseUrl}/api/workbench/fonts/files/${'f'.repeat(64)}`)).status).toBe(404);
    const notice = await fetch(`${baseUrl}${file.notice.url}`);
    expect(notice.headers.get('content-type')).toContain('text/plain');
    expect(await notice.text()).toContain('Fraunces');
    const specimen = await fetch(`${baseUrl}/api/workbench/fonts/specimen?ref=${encodeURIComponent(fraunces.refKey)}&text=${encodeURIComponent('<script>x</script>')}&weight=900`);
    expect(specimen.status).toBe(200);
    expect(specimen.headers.get('content-type')).toContain('text/html');
    expect(specimen.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await specimen.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('HTTP and od search show the same constraint reasons and constraint report for a project', async () => {
    const fonts = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT });
    const app = express(); app.use(express.json());
    const state = projectState(savedContext({ spineCode: 'TL', constraints: [{ id: 'a11y', kind: 'accessibility', value: 'Support Greek and Georgian names' }] }));
    registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => [fonts], projectStateForRequest: () => state });
    server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['search', '--project', 'p', '--category', 'font', '--limit', '100', '--json'], { baseUrl, write: value => output.push(value) })).toBe(0);
    const cli = output[0] as ResourceSearchResponse;
    const http = await fetch(`${baseUrl}/api/workbench/resources/search`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-od-project-id': 'p' }, body: JSON.stringify({ projectId: 'p', facets: { category: 'font' }, limit: 100 }) });
    const body = await http.json() as ResourceSearchResponse;
    expect(body.results.map(item => [item.ref.itemId, item.fitReasons])).toEqual(cli.results.map(item => [item.ref.itemId, item.fitReasons]));
    expect(cli.fontConstraints).toEqual(body.fontConstraints);
    // With the pinned Google Fonts listing, Georgian is met too (no curated font declares it).
    expect(cli.fontConstraints?.requirements.map(requirement => [requirement.value, requirement.satisfiedCount === 0])).toEqual([['greek', false], ['georgian', false]]);
  });
});
