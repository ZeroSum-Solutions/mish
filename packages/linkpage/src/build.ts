import { url as checkUrl } from './blocks.ts';
import { connectors as defaults, loginNeeds } from './connectors.ts';
import { checkPage } from './spec.ts';
import { deriveTheme } from './style.ts';
import type { ConnectorFactory, ConnectorRef, FetchFn, Llm, LoginFetch, NeedsLogin, PageSpec, RawBlock, Signal, ThemeOptions } from './types.ts';
import { gatherCorpus, understandPerson } from './understand.ts';
import type { Person } from './understand.ts';
import { styleFromImages } from './vision.ts';

const first = (signals: Signal[], field: 'name' | 'bio' | 'avatar_url'): string => signals.map((s) => s[field]).find(Boolean) || '';

// Builds a page spec from the platforms a creator links.
//   sources: [{ connector: 'website', ref: 'https://example.com' }, { connector: 'instagram', ref: '@handle' }]
//   options: { slug, name, bio, avatar_url, signup: { endpoint }, links: [{ label, url, description, featured }],
//              theme: { palette: { bg, text, accent }, background } }
//   logins:  { instagram: fetchFn } a creator's own login per platform (a Composio fetch), so a connector can read
//            what is not public. Without one the platform is read as a visitor and reported in `needs`.
//   llm:     createLlm(...). With it the builder reads the person (who they are, beyond one product) and looks at
//            their images for style. Without it the page is built from the plain signals alone.
// A connector that fails is skipped and reported in `warnings`; the page is built from the rest.
export interface BuildSource {
  connector: string;
  ref: ConnectorRef;
}

export interface BuildOptions {
  slug?: string;
  name?: string;
  headline?: string;
  bio?: string;
  avatar_url?: string;
  signup?: { endpoint: string; [field: string]: unknown };
  links?: { label: string; url: string; description?: string; featured?: boolean; [field: string]: unknown }[];
  theme?: ThemeOptions;
}

export interface BuildInput {
  sources: BuildSource[];
  options?: BuildOptions;
  connectors?: Record<string, ConnectorFactory>;
  logins?: Record<string, LoginFetch | undefined>;
  llm?: Llm;
  fetch?: FetchFn;
}

export interface BuildResult {
  spec: PageSpec;
  warnings: string[];
  needs: NeedsLogin[];
  person: Person | null;
}

export async function buildPage({ sources, options = {}, connectors = defaults, logins = {}, llm, fetch }: BuildInput): Promise<BuildResult> {
  const warnings: string[] = [];
  const signals = (await Promise.all(sources.map(async ({ connector, ref }) => {
    try {
      const make = connectors[connector];
      if (!make) throw new Error('no such connector');
      const signal = await make({ fetch, login: logins[connector] }).read(ref);
      for (const w of signal.warnings || []) warnings.push(`${connector}: ${w}`);
      return signal;
    } catch (err) {
      warnings.push(`${connector}: ${(err as Error).message}`);
      return null;
    }
  }))).filter((s): s is Signal => Boolean(s));
  if (!signals.length) throw new Error(`nothing could be read (${warnings.join('; ')})`);

  const site = signals.find((s) => s.site)?.site;

  // Understanding the person: read their pages and posts together, then look at their pictures.
  let person: Person | null = null;
  const styleSignals = [...signals];
  if (llm) {
    try {
      person = await understandPerson({ signals, corpus: await gatherCorpus({ signals, fetch }), llm });
    } catch (err) {
      warnings.push(`understanding: ${(err as Error).message}`);
    }
    const images = [...new Set(signals.flatMap((s) => s.images || []).concat(site?.image_url || []))].slice(0, 5);
    try {
      const seen = await styleFromImages({ images, llm });
      if (seen) styleSignals.push(seen);
    } catch (err) {
      warnings.push(`vision: ${(err as Error).message}`);
    }
  }

  // Addresses come from other people's pages. One that is not a web address is dropped, not allowed to fail the build.
  const good = (value: unknown): string | null => {
    try { return checkUrl(value, 'an address'); } catch { return null; }
  };
  const dropped = { link: 0, social: 0, post: 0 };
  const warnDropped = (): void => {
    for (const [what, n] of Object.entries(dropped)) if (n) warnings.push(`${n} ${what} item${n === 1 ? '' : 's'} with an address that is not a web address ${n === 1 ? 'was' : 'were'} dropped`);
  };

  const social = new Map<string, NonNullable<Signal['links']>[number]>();
  for (const s of signals) {
    for (const l of s.links || []) {
      if (l.kind === 'link' || social.has(l.kind)) continue;
      if (good(l.url)) social.set(l.kind, l); else dropped.social++;
    }
  }

  const list: RawBlock[] = [];
  for (const l of options.links || []) {
    if (good(l.url)) list.push({ type: 'link', ...l }); else dropped.link++;
  }
  if (options.signup?.endpoint) list.push({ type: 'email', ...options.signup });
  const posts = signals.flatMap((s) => s.posts || []).filter((p) => {
    if (good(p.url)) return true;
    dropped.post++;
    return false;
  }).slice(0, 3).map((p) => (p.image_url && !good(p.image_url) ? { ...p, image_url: '' } : p));
  if (posts.length) list.push({ type: 'posts', heading: 'From the journal', items: posts });
  if (social.size) list.push({ type: 'social', items: [...social.values()].map((l) => ({ kind: l.kind, url: l.url, handle: l.handle || '' })) });

  warnDropped();

  // A thin read of the person is not trusted over what the creator's own pages say.
  const trusted = person && person.confidence !== 'low' ? person : null;
  const spec = checkPage({
    slug: options.slug,
    profile: {
      name: options.name || first(signals, 'name') || site?.title,
      // The name is already the title above it; "Alex Roth: potter" reads as "potter".
      headline: options.headline || trusted?.headline?.replace(new RegExp(`^${(options.name || first(signals, 'name') || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:,–-]\\s*`, 'i'), ''),
      bio: options.bio || trusted?.bio || first(signals, 'bio'),
      about: trusted?.about,
      themes: trusted?.themes,
      avatar_url: options.avatar_url || first(signals, 'avatar_url') || site?.image_url,
      site_url: site?.url,
    },
    theme: deriveTheme(styleSignals, options.theme),
    blocks: list,
  });
  return { spec, warnings, needs: loginNeeds(signals), person };
}
