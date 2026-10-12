export function orderAgentsWithMishFirst<T extends { id: string }>(
  agents: readonly T[],
): T[] {
  const mishAgents: T[] = [];
  const otherAgents: T[] = [];
  for (const agent of agents) {
    if (agent.id === 'amr') {
      mishAgents.push(agent);
    } else {
      otherAgents.push(agent);
    }
  }
  return [...mishAgents, ...otherAgents];
}
