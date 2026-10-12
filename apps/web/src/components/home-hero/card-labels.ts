/** Presentation labels only. Catalog titles and generator identifiers stay intact. */
export function compactCardTitle(title: string, family: string | null = null): string {
  const normalized = title.replace(/\s+/gu, ' ').trim();
  const withoutStatus = normalized.replace(/^DRAFT\s*[—–:-]\s*/iu, '');
  const name = withoutStatus.split(/\s[—–-]\s/u, 1)[0]?.trim() || normalized;
  const firstWord = name.split(' ', 1)[0];
  return family && firstWord?.toLowerCase() === family ? firstWord : name;
}

/** The atlas uses "Cinematic and immersive", etc.; cards show the short style name. */
export function compactCardStyle(style: string, title: string): string | null {
  const name = style.split(' and ', 1)[0]?.trim();
  const status = title.match(/^(DRAFT)\s*[—–:-]/iu)?.[1];
  return [status, name].filter(Boolean).join(' · ') || null;
}
