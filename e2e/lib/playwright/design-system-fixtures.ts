import type { APIRequestContext } from '@playwright/test';
import type { DesignSystemSummary } from '@mish/contracts';

export async function approveDesignSystem(request: APIRequestContext, id: string, headers: Record<string, string> = {}): Promise<DesignSystemSummary> {
  // Finish package migration/derived files before approving the exact bytes
  // that file browsing and Team publication will use.
  if (id.startsWith('user:')) {
    const files = await request.get(`/api/design-systems/${encodeURIComponent(id)}/files`, { headers });
    if (!files.ok()) throw new Error(await files.text());
  }
  const response = await request.get('/api/design-systems', { headers });
  if (!response.ok()) throw new Error(await response.text());
  const catalog = await response.json() as { designSystems: DesignSystemSummary[] };
  const kit = catalog.designSystems.find(system => system.id === id);
  if (!kit?.approval) throw new Error(`Missing kit inspection: ${id}`);
  const approved = await request.put(`/api/design-systems/${encodeURIComponent(id)}/approval`, {
    headers, data: { approved: true, expectedRevision: kit.approval.revision },
  });
  if (!approved.ok()) throw new Error(await approved.text());
  return (await approved.json() as { designSystem: DesignSystemSummary }).designSystem;
}

/** UI mocks consume genuine approved API snapshots, including the built-in seed. */
export async function seedApprovedDesignSystems(request: APIRequestContext, fixtures: readonly { id: string; title: string }[]): Promise<DesignSystemSummary[]> {
  const response = await request.get('/api/design-systems');
  if (!response.ok()) throw new Error(await response.text());
  const { designSystems } = await response.json() as { designSystems: DesignSystemSummary[] };
  const approved: DesignSystemSummary[] = [];
  for (const fixture of fixtures) {
    let kit = designSystems.find(system => system.id === fixture.id);
    if (!kit) {
      const created = await request.post('/api/design-systems', { data: { title: fixture.title, status: 'published' } });
      if (!created.ok()) throw new Error(await created.text());
      kit = (await created.json() as { designSystem: DesignSystemSummary }).designSystem;
      if (kit.id !== fixture.id) throw new Error(`Fixture identity mismatch: ${kit.id} != ${fixture.id}`);
    }
    approved.push(kit.approval?.status === 'approved' ? kit : await approveDesignSystem(request, kit.id));
  }
  return approved;
}
