import { backgroundCss, backgroundHtml, backgroundJs } from './background.ts';
import { esc, renderBlock } from './blocks.ts';
import { trackedUrl } from './machine.ts';
import type { PageSpec, Theme } from './types.ts';

const fontLinks = (theme: Theme): string => {
  const families = [...new Set([theme.fonts.heading, theme.fonts.body].filter((f) => f.google).map((f) => f.family))];
  return families.length
    ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${families.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;600`).join('&')}&display=swap">`
    : '';
};

function css({ palette: p, fonts, radius }: Theme): string {
  const r = Math.min(radius, 28);
  return `:root{--bg:${p.bg};--surface:${p.surface};--text:${p.text};--muted:${p.muted};--accent:${p.accent};--on-accent:${p.accentText};--radius:${r}px;--heading:${fonts.heading.stack};--body:${fonts.body.stack}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 var(--body);-webkit-font-smoothing:antialiased}
main{max-width:520px;margin:0 auto;padding:48px 16px 64px;display:flex;flex-direction:column;gap:14px}
header{text-align:center;margin-bottom:10px}header img{width:96px;height:96px;border-radius:999px;object-fit:cover;border:2px solid var(--surface)}
h1{font:600 34px/1.1 var(--heading);margin:14px 0 6px;letter-spacing:-.01em}.headline{font:italic 400 19px/1.3 var(--heading);margin:0 0 8px}h2{text-align:center}h2{font:600 22px/1.2 var(--heading);margin:10px 0 4px}
.bio{color:var(--muted);margin:0 auto;max-width:36ch}
a{color:inherit;text-decoration:none}
.link,.post{display:flex;align-items:center;gap:14px;padding:14px 18px;background:color-mix(in srgb,var(--bg) 72%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid color-mix(in srgb,var(--text) 14%,transparent);border-radius:var(--radius);transition:transform .15s,border-color .15s}
.link:hover,.post:hover{transform:translateY(-2px);border-color:var(--accent)}
.link strong{display:block;font-weight:600}.link small{display:block;color:var(--muted)}
.link--featured{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}.link--featured small{color:inherit;opacity:.85}
.link img,.post img{width:52px;height:52px;border-radius:calc(var(--radius) / 2);object-fit:cover;flex:none}
.social{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
.social a{padding:8px 16px;border:1px solid color-mix(in srgb,var(--text) 25%,transparent);border-radius:max(var(--radius),999px);font-size:14px}
.social a:hover{border-color:var(--accent);color:var(--accent)}.social small{margin-left:6px;color:var(--muted)}
.posts{display:flex;flex-direction:column;gap:10px}
.email{background:color-mix(in srgb,var(--bg) 72%,transparent);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid color-mix(in srgb,var(--text) 14%,transparent);padding:22px;border-radius:var(--radius);text-align:center}
.email form{display:flex;gap:8px;margin-top:12px}.email input[type=email]{flex:1;min-width:0;padding:12px 14px;font:inherit;color:var(--text);background:var(--bg);border:1px solid color-mix(in srgb,var(--text) 25%,transparent);border-radius:var(--radius)}
.email button{padding:12px 18px;font:600 15px var(--body);background:var(--accent);color:var(--on-accent);border:0;border-radius:var(--radius);cursor:pointer}.email button:disabled{opacity:.6}
.trap{position:absolute;left:-9999px}.note,.status{font-size:13px;color:var(--muted);margin:10px 0 0}
.text{text-align:center;color:var(--muted)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(max-width:420px){.email form{flex-direction:column}}`;
}

const SIGNUP_JS = `document.querySelectorAll('form[data-signup]').forEach(function(f){var s=f.parentNode.querySelector('.status'),b=f.querySelector('button');
f.addEventListener('submit',function(e){e.preventDefault();var d=new FormData(f),m=String(d.get('email')||'').trim();
if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(m)){s.hidden=false;s.textContent='That email looks incomplete.';return}
b.disabled=true;fetch(f.action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'signup',email:m,website:d.get('website')||'',page:location.pathname})})
.then(function(r){if(!r.ok)throw 0;f.hidden=true;s.hidden=false;s.textContent='Thank you, you are on the list.'},function(){b.disabled=false;s.hidden=false;s.textContent='Not saved. Please try again.'})})})`;

// opts.trackBase: send each click through `${trackBase}/${slug}/${blockId}/${index}` so it can be counted.
// opts.origin: the address the whole site is served at (its own root, not a path under a shared host), used for the canonical link.
// opts.machine: the page ships llms.txt and links.json beside it, so say so in the head for agents and crawlers.
export interface RenderOptions {
  trackBase?: string;
  origin?: string;
  machine?: boolean;
}

export function renderPage(spec: PageSpec, { trackBase = '', origin = '', machine = false }: RenderOptions = {}): string {
  const href = (id: string, index: number, target: string): string => (trackBase ? trackedUrl(trackBase, spec.slug, id, index) : target);
  const { profile, theme } = spec;
  const sameAs = spec.blocks.flatMap((b) => (b.type === 'social' ? b.items.map((i) => i.url) : []));
  const ld = { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: profile.name, description: profile.bio || undefined, image: profile.avatar_url || undefined, url: profile.site_url || undefined, jobTitle: profile.headline || undefined, knowsAbout: profile.themes?.length ? profile.themes : undefined, sameAs } };
  const effect = theme.background;
  const body = spec.blocks.map((b) => renderBlock(b, { href })).join('\n');
  const needsJs = spec.blocks.some((b) => b.type === 'email');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(profile.name)}</title><meta name="description" content="${esc(profile.bio)}">
<meta name="theme-color" content="${esc(theme.palette.bg)}">${origin ? `<link rel="canonical" href="${esc(origin.replace(/\/$/, ''))}/">` : ''}
<meta property="og:title" content="${esc(profile.name)}"><meta property="og:description" content="${esc(profile.bio)}">${profile.avatar_url ? `<meta property="og:image" content="${esc(profile.avatar_url)}">` : ''}
${machine ? '<link rel="alternate" type="text/plain" href="llms.txt" title="llms.txt"><link rel="alternate" type="application/json" href="links.json" title="Links as JSON">' : ''}
${fontLinks(theme)}<style>${css(theme)}${backgroundCss}</style>
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script></head>
<body>${backgroundHtml(effect)}<main>
<header>${profile.avatar_url ? `<img src="${esc(profile.avatar_url)}" alt="${esc(profile.name)}">` : ''}<h1>${esc(profile.name)}</h1>${profile.headline ? `<p class="headline">${esc(profile.headline)}</p>` : ''}${profile.bio ? `<p class="bio">${esc(profile.bio)}</p>` : ''}</header>
${body}
</main>${needsJs ? `<script>${SIGNUP_JS}</script>` : ''}${backgroundHtml(effect) ? `<script>${backgroundJs}</script>` : ''}</body></html>
`;
}
