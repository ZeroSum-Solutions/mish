/**
 * The booking embed slot: a typed section that places a booking widget on a compiled page, so a
 * visitor can book from the site and the booking lands in the business's own booking system.
 *
 * The widget contract is the ZeroSum booking widget's: a hosted booking page the slot can frame
 * directly (`mode: 'iframe'`), or a script that turns each `[data-zs-booking]` element into a
 * frame of that page (`mode: 'script'`). Both modes keep a plain link to the hosted page, so the
 * slot still works with scripts or frames blocked.
 *
 * Family pages carry a strict Content-Security-Policy (`default-src 'none'`), which would block
 * both a frame and a third-party script. The slot widens it as little as works: `frame-src` gets
 * the booking origin(s), and in script mode `script-src` gets the one widget script URL. Booking
 * URLs must have plain DNS or IPv4 hosts, so a URL can never inject a CSP directive.
 *
 * Two steps, because the compiler's effect step authorizes only inline scripts it can hash:
 * `spliceBookingEmbeds` runs in the compiler's `compose` hook (before effects, so the page byte
 * budget covers the section) and adds the sections and `frame-src`; `finishBookingEmbeds` runs on
 * the finished page and adds the widget `<script>` and its `script-src` entry. Everything here is a
 * pure string function of its input.
 */

import { escapeHtml } from './html.ts';

export type BookingEmbedPlacement = { after: string } | { before: string };

export type BookingEmbed = {
  /** The new section's id: lowercase letters, digits and hyphens, unused on the page. */
  id: string;
  /** Where the section goes: after or before the element with this id. Omitted: the end of `<main>`, else just before the page's last `<footer>`, else the end of `<body>`. */
  placement?: BookingEmbedPlacement;
  /** The section heading, also the frame's accessible title. */
  heading: string;
  body?: string;
  /** The booking page's public key (the widget's `zsb1_…` key), written to `data-zs-booking`. */
  key: string;
  /** The hosted booking page (https), `<api>/book/<key>`: the frame's source in iframe mode, and the fallback link. */
  pageUrl: string;
  mode: 'iframe' | 'script';
  /** The widget script (https), `<api>/embed.js`. It frames `<its origin>/book/<key>`. Required in `script` mode, refused in `iframe` mode. */
  scriptUrl?: string;
  /** Frame height in CSS pixels, 320–2000. Default 720. */
  height?: number;
  /** The fallback link's text. Default "Open the booking page". */
  linkLabel?: string;
};

/** A slot after validation: defaults applied, URLs in normalized form. */
export type ParsedBookingEmbed = BookingEmbed & { height: number; linkLabel: string };

export class BookingEmbedError extends Error {
  readonly code = 'invalid-booking-embed';
  constructor(message: string) {
    super(`booking embed: ${message}`);
    this.name = 'BookingEmbedError';
  }
}

const ID = /^[a-z][a-z0-9-]{0,62}$/;
/** The widget's key format: it ignores any other `data-zs-booking` value, so another key would never mount. */
const KEY = /^zsb1_[A-Za-z0-9_-]{64}$/;
const FIELDS = new Set(['id', 'placement', 'heading', 'body', 'key', 'pageUrl', 'mode', 'scriptUrl', 'height', 'linkLabel']);
const DEFAULT_HEIGHT = 720;
const DEFAULT_LINK_LABEL = 'Open the booking page';
/** Loopback hosts that may use plain http, for local development. CSP cannot name an IPv6 host, so `[::1]` is not one. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
/** A DNS name or dotted IPv4 address as the URL parser normalizes it: lowercase letter-digit-hyphen labels. No `*`, `;` or `_`, so it is a valid CSP host. */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const fail = (message: string): never => { throw new BookingEmbedError(message); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) return fail(`${field} must be a non-empty string of at most ${max} characters`);
  return value;
}

/**
 * An https URL (http only for a loopback host), with no credentials or fragment, in its normalized
 * form. The host must be a plain DNS name or IPv4 address, so the origin is a safe CSP source.
 */
function webUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 2048) return fail(`${field} must be a URL of at most 2048 characters`);
  let url: URL;
  try { url = new URL(value); } catch { return fail(`${field} is not a URL`); }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !local) fail(`${field} must use https`);
  if (!HOST.test(url.hostname)) fail(`${field} must have a plain DNS or IPv4 host (letters, digits, hyphens and dots)`);
  if (url.username || url.password) fail(`${field} must not carry credentials`);
  if (url.hash) fail(`${field} must not carry a fragment`);
  return url.href;
}

/** Validates one slot and returns it with defaults applied and URLs normalized. Throws `BookingEmbedError`. */
export function parseBookingEmbed(input: unknown, label = 'bookingEmbeds[0]'): ParsedBookingEmbed {
  if (!isRecord(input)) return fail(`${label} must be an object`);
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) fail(`${label} has unknown field ${JSON.stringify(key)}`);
  const id = input.id;
  if (typeof id !== 'string' || !ID.test(id)) fail(`${label}.id must be lowercase letters, digits and hyphens`);
  let placement: BookingEmbedPlacement | undefined;
  if (input.placement !== undefined) {
    const raw = input.placement;
    const keys = isRecord(raw) ? Object.keys(raw) : [];
    if (!isRecord(raw) || keys.length !== 1 || (keys[0] !== 'after' && keys[0] !== 'before')) fail(`${label}.placement must be {"after": id} or {"before": id}`);
    const anchor = (raw as Record<string, unknown>)[keys[0]!];
    if (typeof anchor !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(anchor)) fail(`${label}.placement must name a plain element id`);
    placement = keys[0] === 'after' ? { after: anchor as string } : { before: anchor as string };
  }
  const heading = text(input.heading, `${label}.heading`, 120, true)!;
  const body = text(input.body, `${label}.body`, 400, false);
  const key = input.key;
  if (typeof key !== 'string' || !KEY.test(key)) fail(`${label}.key must be a widget key: "zsb1_" and 64 letters, digits, underscores or hyphens`);
  const mode = input.mode;
  if (mode !== 'iframe' && mode !== 'script') fail(`${label}.mode must be "iframe" or "script"`);
  const pageUrl = webUrl(input.pageUrl, `${label}.pageUrl`);
  // The page must be this key's booking page, so the widget and the fallback link book the same calendar.
  if (!new URL(pageUrl).pathname.endsWith(`/book/${key as string}`)) fail(`${label}.pageUrl must be the key's booking page, <api>/book/<key>`);
  let scriptUrl: string | undefined;
  if (mode === 'script') {
    scriptUrl = webUrl(input.scriptUrl, `${label}.scriptUrl`);
    // `script-src` gets this URL as written, and a CSP source path ending in `/` (or the bare
    // origin) allows every script beneath it. The widget script is `<api>/embed.js`, so only that.
    const script = new URL(scriptUrl);
    if (script.pathname !== '/embed.js' || script.search) fail(`${label}.scriptUrl must be the widget script, <api>/embed.js, with no query`);
    // The script frames `<its origin>/book/<key>`; the fallback link must be that same page.
    if (new URL(scriptUrl).origin !== new URL(pageUrl).origin) fail(`${label}.pageUrl and ${label}.scriptUrl must share an origin`);
    if (new URL(pageUrl).pathname !== `/book/${key as string}`) fail(`${label}.pageUrl must be <scriptUrl origin>/book/<key> in script mode, the page the widget frames`);
  } else if (input.scriptUrl !== undefined) fail(`${label}.scriptUrl is only used in script mode`);
  const height = input.height ?? DEFAULT_HEIGHT;
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 320 || height > 2000) fail(`${label}.height must be an integer from 320 to 2000`);
  const linkLabel = text(input.linkLabel, `${label}.linkLabel`, 80, false) ?? DEFAULT_LINK_LABEL;
  return {
    id: id as string, heading, key: key as string, pageUrl, mode: mode as BookingEmbed['mode'], height: height as number, linkLabel,
    ...(placement ? { placement } : {}), ...(body !== undefined ? { body } : {}), ...(scriptUrl ? { scriptUrl } : {}),
  };
}

/** Scoped styles, inlined once per page. They inherit the page's colours and type. */
export const BOOKING_EMBED_CSS = '.mish-booking{padding:4rem 1.5rem}.mish-booking__inner{max-width:56rem;margin-inline:auto}.mish-booking h2{margin:0 0 .75rem;font-size:1.875rem;line-height:1.2}.mish-booking__body{margin:0 0 1.5rem;max-width:40rem}.mish-booking__frame,.mish-booking__mount{display:block;width:100%;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:.75rem;background:transparent}.mish-booking__mount:empty{display:none}.mish-booking__fallback{margin:1rem 0 0}.mish-booking a{color:inherit;text-decoration:underline}';

/**
 * The section's markup. `withStyles` inlines `BOOKING_EMBED_CSS` (the first slot on a page). In
 * script mode this is the mount element only; `finishBookingEmbeds` adds the script. The widget
 * replaces the mount's children, so the fallback link sits beside it, and the empty mount is hidden
 * until the widget fills it.
 */
export function renderBookingEmbed(input: BookingEmbed, withStyles = true): string {
  const slot = parseBookingEmbed(input);
  const e = escapeHtml;
  const titleId = `${slot.id}-title`;
  const style = withStyles ? `<style data-mish-booking-style>${BOOKING_EMBED_CSS}</style>` : '';
  const link = `<a href="${e(slot.pageUrl)}" data-od-id="${slot.id}--link">${e(slot.linkLabel)}</a>`;
  const widget = slot.mode === 'iframe'
    ? `<iframe class="mish-booking__frame" src="${e(slot.pageUrl)}" title="${e(slot.heading)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-forms allow-same-origin" style="height:${slot.height}px" data-zs-booking-frame="${e(slot.key)}" data-od-id="${slot.id}--frame"></iframe><p class="mish-booking__fallback">${link}</p>`
    : `<div class="mish-booking__mount" data-zs-booking="${e(slot.key)}" data-zs-title="${e(slot.heading)}" style="min-height:${slot.height}px" data-od-id="${slot.id}--mount"></div><p class="mish-booking__fallback">${link}</p>`;
  const body = slot.body === undefined ? '' : `<p class="mish-booking__body" data-od-id="${slot.id}--body">${e(slot.body)}</p>`;
  return `<section id="${slot.id}" data-od-id="${slot.id}" class="mish-booking" data-mish-slot="booking-embed" aria-labelledby="${titleId}">${style}<div class="mish-booking__inner"><h2 id="${titleId}" data-od-id="${slot.id}--title">${e(slot.heading)}</h2>${body}${widget}</div></section>`;
}

type Attribute = { value: string; start: number; end: number; quote: string };
/**
 * `inert`: inside a `<template>`, whose content is not in the document. `foreign`: inside an inline
 * `<svg>` or `<math>`, where a booking section would be an SVG or MathML element and never render.
 * `inSelect`: inside a `<select>`, whose parser drops a section's tags (or, in newer browsers, keeps
 * them inside the picker). None of these is ever a place for the slot.
 */
type Tag = { name: string; close: boolean; start: number; end: number; selfClosing: boolean; inert: boolean; foreign: boolean; inSelect: boolean; attributes: Map<string, Attribute> };
const placeable = (tag: Tag) => !tag.inert && !tag.foreign && !tag.inSelect;

/** Elements whose content is text, never markup, so nothing inside one is an anchor. `<plaintext>` never ends. */
const RAW_TEXT = new Set(['iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'script', 'style', 'textarea', 'title', 'xmp']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** HTML start tags that end an inline `<svg>` or `<math>` ("breakout"), and the SVG and MathML elements whose content is HTML or text. */
const FOREIGN_BREAKOUT = new Set(['b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var']);
const FOREIGN_TEXT = new Set(['foreignobject', 'desc', 'title', 'mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** HTML maps these numeric references (0x80–0x9F) to windows-1252 characters. */
const C1: Record<number, number> = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178 };

const asciiLower = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

/**
 * Character references in an attribute value, decoded as HTML does: numeric ones with or without
 * `;` (zero, surrogates and out-of-range values become U+FFFD, 0x80–0x9F map to windows-1252), and
 * the basic names (`&amp` `&lt` `&gt` `&quot` also without `;` unless a letter, digit or `=`
 * follows). Any other name is kept as written; it can never match a plain anchor id.
 */
function decodeAttribute(value: string): string {
  return value.replace(/&#(?:([0-9]+)|[xX]([0-9a-fA-F]+));?|&(?:(amp|lt|gt|quot)(?:;|(?![=A-Za-z0-9]))|(apos);)/g, (_whole, dec?: string, hex?: string, legacy?: string, apos?: string) => {
    const name = legacy ?? apos;
    if (name) return ENTITIES[name]!;
    const code = Number.parseInt(dec ?? hex!, dec ? 10 : 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(C1[code] ?? code);
  });
}


const isTagEnd = (char: string | undefined) => char !== undefined && /[\t\n\f\r />]/.test(char);
const startsTag = (html: string, at: number, name: string) => asciiLower(html.slice(at, at + name.length)) === name && isTagEnd(html[at + name.length]);

/**
 * Where a `<script>` element's text ends: the offset of its `</script`, or `undefined` when it never
 * closes. Script text has escape states (HTML's "script data escaped" and "double escaped"): after
 * `<!--`, a `<script` hides the next `</script>`, until `-->`. Follows those states, so a
 * `</script>` that a browser treats as text never ends the element here either.
 */
function scriptTextEnd(html: string, from: number): number | undefined {
  let state: 'data' | 'escaped' | 'double' = 'data';
  let dashes = 0;
  for (let at = from; at < html.length; at += 1) {
    const char = html[at];
    if (state === 'data') {
      if (html.startsWith('<!--', at)) { state = 'escaped'; dashes = 2; at += 3; continue; }
      if (char === '<' && html[at + 1] === '/' && startsTag(html, at + 2, 'script')) return at;
      continue;
    }
    if (char === '-') { dashes += 1; continue; }
    if (char === '>' && dashes >= 2) { state = 'data'; dashes = 0; continue; }
    dashes = 0;
    if (char !== '<') continue;
    if (state === 'escaped') {
      if (html[at + 1] === '/' && startsTag(html, at + 2, 'script')) return at;
      if (startsTag(html, at + 1, 'script')) { state = 'double'; at += 'script'.length + 1; }
    } else if (html[at + 1] === '/' && startsTag(html, at + 2, 'script')) {
      state = 'escaped';
      at += 'script'.length + 2;
    }
  }
  return undefined;
}

/** Where a raw-text element's text ends: the offset of its end tag, or `undefined` when it never closes. */
function rawTextEnd(html: string, name: string, from: number): number | undefined {
  if (name === 'script') return scriptTextEnd(html, from);
  if (name === 'plaintext') return undefined;
  const end = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
  end.lastIndex = from;
  return end.exec(html)?.index;
}

const isSpace = (char: string | undefined) => char === '\t' || char === '\n' || char === '\f' || char === '\r' || char === ' ';
const isAsciiAlpha = (char: string | undefined) => char !== undefined && ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z'));

/** Where a comment whose text starts at `from` ends (past `-->`, `--!>`, or an abrupt `>` / `->`); `undefined` when the page ends inside it. */
function commentEnd(html: string, from: number): number | undefined {
  if (html[from] === '>') return from + 1;
  if (html.startsWith('->', from)) return from + 2;
  for (let at = html.indexOf('--', from); at >= 0; at = html.indexOf('--', at + 1)) {
    if (html[at + 2] === '>') return at + 3;
    if (html[at + 2] === '!' && html[at + 3] === '>') return at + 4;
  }
  return undefined;
}

/**
 * The tag that starts at `start` (a `<` followed by a letter, or `</` and a letter), read with
 * HTML's tag states: the name runs to whitespace, `/` or `>`; an attribute value is quoted only
 * right after `=`; the tag ends at the first `>` outside a quoted value. `undefined` when the page
 * ends inside the tag, which drops it, as in HTML. Attribute names are ASCII-lowercased and the
 * first of a repeated name wins.
 */
function readTag(html: string, start: number): Omit<Tag, 'inert' | 'foreign' | 'inSelect'> | undefined {
  const close = html[start + 1] === '/';
  let at = start + (close ? 2 : 1);
  const nameStart = at;
  while (at < html.length && !isSpace(html[at]) && html[at] !== '/' && html[at] !== '>') at += 1;
  const name = asciiLower(html.slice(nameStart, at));
  const attributes = new Map<string, Attribute>();
  const add = (key: string, raw: string, from: number, quote: string) => {
    if (!attributes.has(key)) attributes.set(key, { value: decodeAttribute(raw), start: from, end: from + raw.length, quote });
  };
  let selfClosing = false;
  while (at < html.length) {
    const char = html[at];
    if (char === '>') return { name, close, start, end: at + 1, selfClosing, attributes: close ? new Map() : attributes };
    selfClosing = false;
    if (isSpace(char)) { at += 1; continue; }
    if (char === '/') { selfClosing = html[at + 1] === '>'; at += 1; continue; }
    // An attribute name; its first character may be `=`.
    const keyStart = at;
    at += 1;
    while (at < html.length && !isSpace(html[at]) && html[at] !== '/' && html[at] !== '>' && html[at] !== '=') at += 1;
    const key = asciiLower(html.slice(keyStart, at));
    let equals = at;
    while (isSpace(html[equals])) equals += 1;
    if (html[equals] !== '=') { add(key, '', at, ''); at = equals; continue; }
    at = equals + 1;
    while (isSpace(html[at])) at += 1;
    const quote = html[at] === '"' || html[at] === "'" ? html[at]! : '';
    if (quote) {
      const end = html.indexOf(quote, at + 1);
      if (end < 0) return undefined;
      add(key, html.slice(at + 1, end), at + 1, quote);
      at = end + 1;
    } else {
      const valueStart = at;
      while (at < html.length && !isSpace(html[at]) && html[at] !== '>') at += 1;
      add(key, html.slice(valueStart, at), valueStart, '');
    }
  }
  return undefined;
}

/** `<` here opens markup (a tag, end tag, comment, doctype or bogus comment), not text. */
const opensMarkup = (html: string, at: number) => isAsciiAlpha(html[at + 1]) || html[at + 1] === '/' || html[at + 1] === '!' || html[at + 1] === '?';

/**
 * Inline `<svg>` and `<math>` are foreign content, which HTML parses by other rules: no raw text,
 * CDATA sections, HTML tags that end the element early, and text elements (`<title>`, `<desc>`,
 * `<foreignObject>`, MathML's token elements) whose content is HTML. The scanner follows only the
 * plain case, foreign elements and comments, which is what icons are, and refuses the rest rather
 * than guess where the element ends.
 */
/**
 * A `<select>` is parsed by rules of its own, and newer browsers parse it differently again, so the
 * scanner accepts only what every parser reads the same way inside one: options, option groups,
 * `<hr>`, text and comments. Anything else is refused.
 */
const SELECT_CONTENT = new Set(['option', 'optgroup', 'hr']);
const selectFail = (what: string) => fail(`the page's <select> contains ${what}, which the booking slot cannot place around safely`);
const foreignFail = (what: string) => fail(`the page's inline <svg> or <math> contains ${what}, which the booking slot cannot place around safely`);

/**
 * Tags outside comments and raw-text elements, with their attributes, read in one linear pass with
 * HTML's tokenizer rules: comments (including abrupt `<!-->` and `--!>`), bogus comments and the
 * doctype (`<!…>`, `<?…>`, `</` and a non-letter) skip to their end, and whitespace is HTML's ASCII
 * whitespace only, so a no-break space never ends a tag name or separates attributes. Names and
 * raw-text ends match ASCII case-insensitively, so offsets always index `html`. Tags inside an
 * inline `<svg>` or `<math>` are marked `foreign`; the `<svg>` or `<math>` tags themselves are not.
 */
function scanTags(html: string): Tag[] {
  const tags: Tag[] = [];
  let templates = 0;
  /** Open foreign elements, outermost first; empty in HTML content. */
  const foreign: string[] = [];
  let select = false;
  /** The select opened inside a template, so that template's end tag also ends the select. */
  let selectInTemplate = false;
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) break;
    const next = html[open + 1];
    const opensTag = isAsciiAlpha(next) || (next === '/' && isAsciiAlpha(html[open + 2]));
    if (!opensTag) {
      if (html.startsWith('<!--', open)) {
        const end = commentEnd(html, open + 4);
        if (end === undefined) break;
        at = end;
      } else if (foreign.length > 0 && html.startsWith('<![CDATA[', open)) {
        return foreignFail('a CDATA section');
      } else if (next === '!' || next === '?' || (next === '/' && open + 2 < html.length)) {
        if (next === '/' && html[open + 2] === '>') { at = open + 3; continue; }
        const end = html.indexOf('>', open + 2);
        if (end < 0) break;
        at = end + 1;
      } else {
        at = open + 1;
      }
      continue;
    }
    const read = readTag(html, open);
    if (!read) break;
    const inForeign = foreign.length > 0;
    let tag: Tag;
    if (select) {
      const ends = read.close && (read.name === 'select' || (read.name === 'template' && selectInTemplate));
      if (!ends && !(read.close ? read.name === 'option' || read.name === 'optgroup' : SELECT_CONTENT.has(read.name))) return selectFail(`<${read.close ? '/' : ''}${read.name}>`);
      if (ends) select = false;
      if (ends && read.name === 'template') templates -= 1;
      tag = { ...read, inert: templates > 0, foreign: false, inSelect: select };
    } else if (!inForeign) {
      if (!read.close && read.name === 'frameset' && templates === 0) return fail('a <frameset> page cannot take a booking embed: its frames replace the body');
      if (read.name === 'template' && read.close) templates = Math.max(0, templates - 1);
      tag = { ...read, inert: templates > 0, foreign: false, inSelect: false };
      if (read.name === 'template' && !read.close) templates += 1;
      if (read.name === 'select' && !read.close) { select = true; selectInTemplate = templates > 0; }
      if (!read.close && !read.selfClosing && (read.name === 'svg' || read.name === 'math')) foreign.push(read.name);
    } else if (read.close) {
      const index = foreign.lastIndexOf(read.name);
      if (index < 0) return foreignFail(`a stray </${read.name}>`);
      foreign.length = index;
      // The end tag that closes the outermost <svg> or <math> sits in HTML content again.
      tag = { ...read, inert: templates > 0, foreign: foreign.length > 0, inSelect: false };
    } else {
      const font = read.name === 'font' && ['color', 'face', 'size'].some((key) => read.attributes.has(key));
      if (FOREIGN_BREAKOUT.has(read.name) || font) return foreignFail(`an HTML <${read.name}>`);
      tag = { ...read, inert: templates > 0, foreign: true, inSelect: false };
      if (!read.selfClosing) {
        foreign.push(read.name);
        if (FOREIGN_TEXT.has(read.name)) {
          // Text only: the next markup must be this element's own end tag.
          let markup = html.indexOf('<', read.end);
          while (markup >= 0 && !opensMarkup(html, markup)) markup = html.indexOf('<', markup + 1);
          if (markup >= 0 && !(html[markup + 1] === '/' && startsTag(html, markup + 2, read.name))) return foreignFail(`markup inside <${read.name}>`);
        }
      }
    }
    tags.push(tag);
    at = tag.end;
    if (!inForeign && !tag.inSelect && !tag.close && RAW_TEXT.has(tag.name)) {
      const closing = rawTextEnd(html, tag.name, tag.end);
      if (closing === undefined) break;
      at = closing;
    }
  }
  return tags;
}

const idsOf = (tags: Tag[]) => tags.flatMap((tag) => { const id = tag.attributes.get('id'); return id ? [id.value] : []; });

/** The offset the slot goes at. Throws when the anchor is missing, repeated or not a container. */
function insertionOffset(tags: Tag[], placement: BookingEmbedPlacement | undefined): number {
  if (!placement) {
    const last = (name: string, close: boolean) => tags.filter((tag) => placeable(tag) && tag.close === close && tag.name === name).at(-1);
    const end = last('main', true) ?? last('footer', false) ?? last('body', true);
    if (!end) return fail('the page has no <main>, <footer> or <body> to place the slot in; give a placement');
    return end.start;
  }
  const anchor = 'after' in placement ? placement.after : placement.before;
  const owners = tags.filter((tag) => placeable(tag) && tag.attributes.get('id')?.value === anchor);
  if (owners.length !== 1) return fail(`placement anchor ${JSON.stringify(anchor)} must name exactly one element (found ${owners.length})`);
  const open = owners[0]!;
  if ('before' in placement) return open.start;
  if (VOID.has(open.name) || open.selfClosing) return fail(`placement anchor ${JSON.stringify(anchor)} is not a container element`);
  if (RAW_TEXT.has(open.name)) {
    const closing = tags.find((tag) => tag.start > open.start && tag.close && tag.name === open.name);
    return closing ? closing.end : fail(`placement anchor ${JSON.stringify(anchor)} is never closed`);
  }
  let depth = 0;
  for (const tag of tags) {
    // Tags in a <template>, an <svg> or a <select> never close the anchor: a browser ignores them there.
    if (tag.start < open.start || !placeable(tag) || tag.name !== open.name || (!tag.close && tag.selfClosing)) continue;
    depth += tag.close ? -1 : 1;
    if (depth === 0) return tag.end;
  }
  return fail(`placement anchor ${JSON.stringify(anchor)} is never closed`);
}

/** Content-Security-Policy `<meta>` tags, with their decoded `content` value and its bounds. */
function cspMetas(tags: Tag[]): Attribute[] {
  const metas: Attribute[] = [];
  for (const tag of tags) {
    if (tag.close || tag.inert || tag.foreign || tag.name !== 'meta' || asciiLower(tag.attributes.get('http-equiv')?.value.trim() ?? '') !== 'content-security-policy') continue;
    const content = tag.attributes.get('content');
    if (!content || content.quote !== '"') return fail('the page\'s Content-Security-Policy must quote its content with "');
    metas.push(content);
  }
  return metas;
}

/** `policy` without trailing `;` and whitespace. A loop, not a `/[…]+$/` replace, which is quadratic on a long run of them. */
function trimPolicyEnd(policy: string): string {
  let end = policy.length;
  while (end > 0 && (policy[end - 1] === ';' || isSpace(policy[end - 1]))) end -= 1;
  return policy.slice(0, end);
}

/** `policy` with `source` allowed by `directive`: added to it, replacing a lone `'none'`, or appended as a new directive. */
export function allowCspSource(policy: string, directive: 'frame-src' | 'script-src', source: string): string {
  if (!/^[!-~]+$/.test(source) || /[;,]/.test(source)) return fail(`${JSON.stringify(source)} is not a single CSP source expression`);
  const parts = policy.split(';');
  const index = parts.findIndex((part) => asciiLower(part.trim().split(/[\t\n\f\r ]+/)[0]!) === directive);
  if (index < 0) return `${trimPolicyEnd(policy)}; ${directive} ${source}`;
  const lead = parts[index]!.match(/^[\t\n\f\r ]*/)![0];
  const tokens = parts[index]!.trim().split(/[\t\n\f\r ]+/).slice(1);
  if (tokens.includes(source)) return policy;
  parts[index] = `${lead}${[directive, ...(tokens.length === 1 && asciiLower(tokens[0]!) === "'none'" ? [] : tokens), source].join(' ')}`;
  return parts.join(';');
}

/** Applies `allowCspSource` to every CSP `<meta>` on the page (each one is enforced). */
function allowOnPage(html: string, directive: 'frame-src' | 'script-src', sources: readonly string[]): string {
  let page = html;
  for (const meta of cspMetas(scanTags(page)).reverse()) {
    const value = sources.reduce((policy, source) => allowCspSource(policy, directive, source), meta.value);
    if (value === meta.value) continue;
    page = `${page.slice(0, meta.start)}${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}${page.slice(meta.end)}`;
  }
  return page;
}

/**
 * A CSP source expression for a validated URL: its origin, or its origin and path. CSP matching
 * percent-decodes paths, so every path character outside a plain set is percent-encoded; `;` and
 * `,` would otherwise end the source or the directive.
 */
function cspSource(url: string, withPath: boolean): string {
  const parsed = new URL(url);
  if (!withPath) return parsed.origin;
  const path = parsed.pathname.replace(/[^A-Za-z0-9\-._~\/%]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `${parsed.origin}${path}`;
}

const unique = (values: string[]) => [...new Set(values)];

/**
 * Validates a page's slot list: each slot, plus the rules across slots. Slot ids must differ, and
 * every script-mode slot must use the same widget script, because each copy of the script mounts
 * every `[data-zs-booking]` element on the page.
 */
export function parseBookingEmbeds(embeds: readonly unknown[]): ParsedBookingEmbed[] {
  const slots = embeds.map((embed, index) => parseBookingEmbed(embed, `bookingEmbeds[${index}]`));
  const ids = slots.flatMap((slot) => [slot.id, `${slot.id}-title`]);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) fail(`bookingEmbeds use the id ${JSON.stringify(repeated)} twice`);
  const scripts = unique(slots.flatMap((slot) => (slot.scriptUrl ? [slot.scriptUrl] : [])));
  if (scripts.length > 1) fail(`every script-mode slot on a page must use the same scriptUrl (found ${scripts.length}); the widget script mounts every booking element`);
  return slots;
}

/**
 * Step one, before effects: splices every slot into a rendered page, in order, and allows the
 * frame origins in `frame-src`. Refuses a static prototype (its controls are not wired, so a
 * booking widget would be a false promise), an id the page already uses, and an anchor that does
 * not resolve to exactly one element. Slots sharing an `after` anchor keep their order.
 */
export function spliceBookingEmbeds(html: string, embeds: readonly BookingEmbed[]): string {
  if (embeds.length === 0) return html;
  if (html.includes('data-od-output-scope="static-prototype"')) fail('a static prototype page cannot take a booking embed');
  const slots = parseBookingEmbeds(embeds);
  const used = new Set(idsOf(scanTags(html)));
  slots.forEach((slot, index) => {
    for (const id of [slot.id, `${slot.id}-title`]) if (used.has(id)) fail(`bookingEmbeds[${index}].id ${JSON.stringify(id)} is already used on the page`);
  });
  let page = html;
  const lastAfter = new Map<string, string>();
  for (const [index, slot] of slots.entries()) {
    // A later slot after the same anchor goes after the earlier slot, not between it and the anchor.
    const previous = slot.placement && 'after' in slot.placement ? lastAfter.get(slot.placement.after) : undefined;
    const offset = insertionOffset(scanTags(page), previous ? { after: previous } : slot.placement);
    page = `${page.slice(0, offset)}${renderBookingEmbed(slot, index === 0)}${page.slice(offset)}`;
    if (slot.placement && 'after' in slot.placement) lastAfter.set(slot.placement.after, slot.id);
  }
  // Script mode shares the page origin, so the frames are exactly the pageUrl origins.
  return allowOnPage(page, 'frame-src', unique(slots.map((slot) => cspSource(slot.pageUrl, false))));
}

/**
 * Step two, on the finished page: adds the widget script once, just before `</body>`, and allows
 * exactly that script URL in `script-src`. A no-op for iframe-only slots.
 */
export function finishBookingEmbeds(html: string, embeds: readonly BookingEmbed[]): string {
  const scripts = unique(parseBookingEmbeds(embeds).flatMap((slot) => (slot.scriptUrl ? [slot.scriptUrl] : [])));
  if (scripts.length === 0) return html;
  const bodyEnd = scanTags(html).filter((tag) => !tag.inert && tag.close && tag.name === 'body').at(-1);
  if (!bodyEnd) return fail('the page has no </body> for the widget script');
  const page = `${html.slice(0, bodyEnd.start)}${scripts.map((url) => `<script src="${escapeHtml(url)}" async data-mish-booking-script></script>`).join('')}${html.slice(bodyEnd.start)}`;
  return allowOnPage(page, 'script-src', scripts.map((url) => cspSource(url, true)));
}
