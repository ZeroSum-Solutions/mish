/** Daemon/agent state must never be exposed as project content. Shared by file APIs and snapshots. */
export const PRIVATE_PROJECT_ENTRY_NAMES = [
  '.file-versions', '.live-artifacts', '.mcp.json', '.claude', '.codex', '.opencode',
] as const;
export const PRIVATE_PROJECT_ENTRY_PREFIXES = ['.mcp.json.'] as const;
const privateNames = new Set<string>(PRIVATE_PROJECT_ENTRY_NAMES);
export function isReservedProjectSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return privateNames.has(lower) || PRIVATE_PROJECT_ENTRY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
