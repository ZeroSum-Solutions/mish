import type { DesignSystemSummary } from '@mish/contracts';

/** Show source details only when an installed title cannot identify one kit. */
export function designSystemIdentity(
  system: DesignSystemSummary,
  installed: readonly DesignSystemSummary[],
  locale: string,
): string {
  if (!installed.some((other) => other.id !== system.id && other.title.trim() === system.title.trim())) return '';
  const revision = system.updatedAt ?? system.createdAt;
  const date = revision ? new Date(revision) : null;
  return date && Number.isFinite(date.getTime())
    ? `${system.id} · ${new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(date)}`
    : system.id;
}
