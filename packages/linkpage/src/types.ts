// Shared shapes for the link-page engine.

/** An injectable `fetch`, as the platform provides it. */
export type FetchFn = typeof globalThis.fetch;

/** A `fetch` that carries a creator's own login (for example a Composio fetch). */
export type LoginFetch = FetchFn;

export interface ColorSignal {
  hex: string;
  weight?: number;
}

export interface FontSignal {
  family: string;
  weight?: number;
}

export interface SignalLink {
  url: string;
  kind: string;
  label?: string;
  handle?: string;
}

export interface SignalPost {
  title: string;
  url: string;
  image_url?: string;
  published?: string;
}

export interface NeedsLogin {
  platform: string;
  why: string;
}

export interface SiteInfo {
  url: string;
  title?: string;
  image_url?: string;
}

/** What a connector saw. Every field is optional. */
export interface Signal {
  source?: string;
  name?: string;
  bio?: string;
  avatar_url?: string;
  site?: SiteInfo;
  links?: SignalLink[];
  posts?: SignalPost[];
  colors?: ColorSignal[];
  fonts?: FontSignal[];
  stats?: string;
  images?: string[];
  needs_login?: NeedsLogin;
  /** Things that went wrong but did not stop the read (for example a login that failed). */
  warnings?: string[];
  mood?: string;
  imagery?: string;
  notes?: string;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export type FontKind = 'serif' | 'sans' | 'mono' | 'display';

export interface FontChoice {
  family: string;
  kind: FontKind;
  stack: string;
  google: boolean;
}

export type Mood = 'editorial' | 'modern' | 'raw' | 'playful';

export interface Palette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  dark: boolean;
}

export interface Theme {
  mood: Mood;
  radius: number;
  background: string;
  palette: Palette;
  fonts: { heading: FontChoice; body: FontChoice };
}

export interface ThemeOptions {
  palette?: { bg?: string; text?: string; accent?: string };
  background?: string;
}

// Blocks -----------------------------------------------------------------------------------------

export interface LinkBlock {
  type: 'link';
  id: string;
  label: string;
  url: string;
  description: string;
  image_url: string;
  featured: boolean;
}

export interface SocialItem {
  kind: string;
  url: string;
  handle: string;
}

export interface SocialBlock {
  type: 'social';
  id: string;
  items: SocialItem[];
}

export interface PostItem {
  title: string;
  url: string;
  image_url: string;
}

export interface PostsBlock {
  type: 'posts';
  id: string;
  heading: string;
  items: PostItem[];
}

export interface EmailBlock {
  type: 'email';
  id: string;
  heading: string;
  button: string;
  note: string;
  endpoint: string;
}

export interface TextBlock {
  type: 'text';
  id: string;
  body: string;
}

export type Block = LinkBlock | SocialBlock | PostsBlock | EmailBlock | TextBlock;
export type BlockType = Block['type'];

/** A block as a person or builder writes it, before `checkPage` cleans it. Fields are loose on purpose. */
export interface RawBlock {
  type?: string;
  id?: string;
  [field: string]: unknown;
}

export interface Profile {
  name: string;
  headline: string;
  bio: string;
  about: string;
  themes: string[];
  avatar_url: string;
  site_url: string;
}

export interface PageSpec {
  version: 1;
  slug: string;
  profile: Profile;
  theme: Theme;
  blocks: Block[];
}

/** A page spec as written by hand or by the builder, before checking. */
export interface RawPageSpec {
  slug?: unknown;
  profile?: {
    name?: unknown;
    headline?: unknown;
    bio?: unknown;
    about?: unknown;
    themes?: unknown[];
    avatar_url?: unknown;
    site_url?: unknown;
  };
  theme?: Theme;
  blocks?: RawBlock[];
}

/** Gives the address a link points at: the address itself, or a tracked one. */
export interface BlockContext {
  href: (blockId: string, index: number, url: string) => string;
}

// Model ------------------------------------------------------------------------------------------

export interface LlmRequest {
  system: string;
  user: string;
  images?: string[];
}

/** Anything that can answer a request with one JSON value. */
export interface Llm {
  json: (request: LlmRequest) => Promise<unknown>;
}

/** What a connector reads: an address or handle, or (for `manual`) a signal typed in by hand. */
export type ConnectorRef = string | Signal;

export interface Connector {
  name: string;
  // Method syntax on purpose: each connector narrows `ref` to what it understands.
  read(ref: ConnectorRef): Promise<Signal>;
}

export interface ConnectorOptions {
  fetch?: FetchFn;
  login?: LoginFetch;
}

export type ConnectorFactory = (options?: ConnectorOptions) => Connector;
