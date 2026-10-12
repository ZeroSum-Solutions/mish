import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildProjectDesignTokenSuggestions } from '../src/project-design-token-suggestions.js';
import { designSystemRevision, setDesignSystemApproval } from '../src/design-systems/approval.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('offers approved kit tokens and returns an empty hint with a typed notice for an unreviewed, draft or edited kit', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'od-token-approval-'));
  const kits = path.join(root, 'kits');
  const dir = path.join(kits, 'kit');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'DESIGN.md'), '# Kit\n\n--accent: #1e5a78;');
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ status: 'published' }));
  const read = () => buildProjectDesignTokenSuggestions({
    projectId: 'project-1', project: { designSystemId: 'user:kit' }, projectsRoot: root,
    designSystemsRoot: path.join(root, 'built-in'), userDesignSystemsRoot: kits,
    listFiles: async () => [], resolveProjectDir: () => root, query: { props: ['color'], values: { color: '#1e5a78' } },
  });
  expect(await read()).toMatchObject({ suggestions: [], designSystemNotice: { reason: 'unreviewed', designSystemId: 'user:kit' } });
  await setDesignSystemApproval(kits, 'user:kit', true, await designSystemRevision(dir));
  expect((await read()).suggestions).toEqual(expect.arrayContaining([expect.objectContaining({ token: '--accent', value: '#1e5a78' })]));
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ status: 'draft' }));
  expect(await read()).toMatchObject({ suggestions: [], designSystemNotice: { reason: 'draft', designSystemId: 'user:kit' } });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ status: 'published' }));
  await writeFile(path.join(dir, 'DESIGN.md'), '# Edited kit\n\n--accent: #000;');
  expect(await read()).toMatchObject({ suggestions: [], designSystemNotice: { reason: 'unreviewed', designSystemId: 'user:kit' } });
});
