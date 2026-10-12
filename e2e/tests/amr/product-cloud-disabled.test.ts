// @vitest-environment node
import { expect, test } from 'vitest';
import { createSmokeSuite } from '@/vitest/suite';

test('team desktop daemon does not expose upstream cloud sign-in or AMR', {timeout:180_000}, async () => {
  const suite = await createSmokeSuite('product-cloud-disabled');
  await suite.with.toolsDev(async ({webUrl}) => {
    for (const endpoint of ['/api/vela/login/status', '/api/vela/models']) {
      const response = await fetch(new URL(endpoint, webUrl));
      expect(response.status).toBe(404);
    }
    const response = await fetch(new URL('/api/agents',webUrl));
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.agents.some((agent: {id:string}) => agent.id === 'amr')).toBe(false);
  });
});
