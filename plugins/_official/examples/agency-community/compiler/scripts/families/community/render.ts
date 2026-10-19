/** Community poster system. All client text remains schema-bound and escaped.
 * The optional application prepares an email draft; it never sends or claims submission.
 * Layout and browser code are in this portable renderer so frozen exports stay complete. */

import { createHash } from 'node:crypto';
import { readCompilerResource } from '../../resources.ts';
import type { AssetRequirement } from '../../assets.ts';
import { presentSections } from '../../sections.ts';
import { parseCommunityRecipe, type CommunityRecipe, type CommunitySection } from './contract.ts';
import {
  BENEFITS_SECTION_ID, EVENTS_SECTION_ID, FAQ_SECTION_ID, FOOTER_SECTION_ID, HEADER_SECTION_ID,
  HERO_SECTION_ID, HOW_IT_WORKS_SECTION_ID, JOIN_SECTION_ID, TIERS_SECTION_ID, VOICES_SECTION_ID,
} from './slots.ts';

/** Every content section id that could be a nav target, in fixed page order (never header or
 * footer) — see restaurant's `NAV_TARGET_ORDER` for the pattern this mirrors (G5). `voices` is
 * optional and dropped from this list when the brief carries no member quotes. */
export const NAV_TARGET_ORDER = [BENEFITS_SECTION_ID, TIERS_SECTION_ID, HOW_IT_WORKS_SECTION_ID, EVENTS_SECTION_ID, VOICES_SECTION_ID, FAQ_SECTION_ID];

/** Fixed nav labels, keyed by the section id each one names — never model text (G5 round 2). */
export const NAV_LABELS: Record<string, string> = {
  [BENEFITS_SECTION_ID]: 'Benefits', [TIERS_SECTION_ID]: 'Membership', [HOW_IT_WORKS_SECTION_ID]: 'How it works',
  [EVENTS_SECTION_ID]: 'Events', [VOICES_SECTION_ID]: 'Members', [FAQ_SECTION_ID]: 'FAQ',
};

/** Relative to `compiler/scripts/`, read through `resources.ts` (disk, or a supplied table). */
const HYPERUI_CSS = 'catalog/hyperui/community.css';
/** The compiled Tailwind build for this page kind's blocks, read once and inlined once per page. */
function inlinedStyles(): string {
  return readCompilerResource(HYPERUI_CSS);
}

export function validateCommunityRecipe(input: unknown): CommunityRecipe {
  return parseCommunityRecipe(input);
}

/** No image, font or video assets. */
export function getCommunityAssetRequirements(_recipe: CommunityRecipe): AssetRequirement[] {
  return [];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
const e = escapeHtml;

/** One text slot: an element that carries its own data-od-id. */
function slot(tag: string, className: string, id: string, value: string): string {
  const classes = className ? ` class="${className}"` : '';
  return `<${tag}${classes} data-od-id="${id}">${e(value)}</${tag}>`;
}
/** A nullable atom: nothing at all when the brief states no such fact. */
function atom(tag: string, className: string, id: string, value: string | null): string {
  return value === null ? '' : slot(tag, className, id, value);
}
/** A nullable footer label rendered as plain text: nothing at all when null. Never an `<a>` — a
 * "Privacy"/"Terms"-style footer link never had a real page behind it here (G5). */
function atomLink(className: string, id: string, value: string | null): string {
  return value === null ? '' : `<li>${slot('span', className, id, value)}</li>`;
}
/** A nullable phone or email atom rendered as a real `tel:`/`mailto:` link: nothing at all when
 * null. The href is derived only from the filled atom's own text — never invented — and a phone
 * href keeps just its leading `+` and digits, since `tel:` does not accept spaces or punctuation. */
/** `tel:` keeps only digits, plus a leading "+" when the filled value itself starts with one
 * (never an interior "+", which `isPhoneNumber` refuses as a slot value but this transform must
 * not rely on that to stay safe on its own). */
function telHref(value: string): string {
  return `tel:${value.startsWith('+') ? '+' : ''}${value.replace(/\D/g, '')}`;
}
function mailHref(value: string): string {
  const recipient = value.split('@').map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('@');
  return `mailto:${recipient}`;
}
function atomContact(kind: 'phone' | 'email', className: string, id: string, value: string | null): string {
  if (value === null) return '';
  const href = kind === 'phone' ? telHref(value) : mailHref(value);
  return `<a href="${e(href)}" class="${className}" data-od-id="${id}">${e(value)}</a>`;
}
const str = (record: Record<string, unknown>, name: string) => record[name] as string;
const nullable = (record: Record<string, unknown>, name: string) => record[name] as string | null;
const items = (s: CommunitySection) => s.items ?? [];

export const COMMUNITY_STYLES = `
.community-page{--paper:#f4f3ef;--ink:#181918;--soft:#e8e7e0;--line:#cccdc5;--accent:#c4fb59;margin:0;background:var(--paper);color:var(--ink);font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55}
.community-page *{box-sizing:border-box}.community-page [hidden]{display:none!important}.community-page a{color:inherit;text-decoration:none}.community-page p,.community-page h1,.community-page h2,.community-page h3,.community-page blockquote{margin:0}.community-page ul,.community-page ol{list-style:none;margin:0;padding:0}.community-page h1,.community-page h2,.community-page h3{overflow-wrap:anywhere;text-wrap:balance}.community-page p,.community-page a,.community-page dd{overflow-wrap:anywhere}.community-page a,.community-page button,.community-page summary{touch-action:manipulation}.community-page :focus-visible{outline:3px solid #66862c;outline-offset:5px}.community-page .community-dark :focus-visible{outline-color:var(--accent)}
.community-wrap{width:min(1184px,calc(100% - 96px));margin-inline:auto}.community-section{padding-block:100px;scroll-margin-top:24px}.community-header{border-bottom:1px solid var(--line)}.community-header>.community-wrap{display:flex;align-items:center;gap:28px;min-height:96px}.community-brand{font-size:19px;line-height:1.1;font-weight:800;letter-spacing:-.045em;max-width:210px;margin-right:auto}.community-desktop-nav{display:flex;gap:24px;font-size:13px;font-weight:600}.community-desktop-nav a:hover,.community-contact a:hover{text-decoration:underline;text-underline-offset:5px}.community-mobile-nav{display:none}.community-button{display:inline-flex;align-items:center;justify-content:space-between;gap:24px;background:var(--accent);color:var(--ink)!important;border:1px solid var(--ink);padding:15px 22px;min-height:52px;font:700 14px/1.3 Arial,Helvetica,sans-serif;cursor:pointer;transition:background .2s ease-out}.community-button:after{content:'↗';font-size:20px;line-height:1}.community-button:hover{background:#d6ff8b}.community-header .community-button{min-height:44px;padding:11px 16px;font-size:12px}.community-secondary{padding:14px 20px;border:1px solid var(--line);font:700 14px Arial;background:transparent;cursor:pointer}
.community-hero{padding-block:74px 96px}.community-hero-copy{min-width:0}.community-hero-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:52px;align-items:center}.community-eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;max-width:48ch}.community-title{font-size:clamp(48px,5.9vw,82px);line-height:.99;letter-spacing:-.065em;font-weight:800;margin-top:26px!important;max-width:12ch}.community-lead{font-size:17px;line-height:1.6;max-width:53ch;margin-top:28px!important}.community-hero .community-button{margin-top:32px}.community-count{margin-top:20px!important;font-size:12px}.community-art{aspect-ratio:1/1.12;display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--ink);background:var(--soft);transform:rotate(-3deg)}.community-art>div{aspect-ratio:1;border:1px solid var(--ink);position:relative;overflow:hidden}.community-art-circle{background:var(--ink)}.community-art-circle:after{content:'';position:absolute;inset:12%;border-radius:50%;background:var(--paper)}.community-art-bars{background:repeating-linear-gradient(90deg,var(--ink) 0 12px,var(--paper) 12px 25px)}.community-art-cross:before,.community-art-cross:after{content:'';position:absolute;background:var(--ink);inset:43% 8%;transform:rotate(45deg)}.community-art-cross:after{transform:rotate(-45deg)}.community-art-disc{background:var(--ink)}.community-art-disc:after{content:'';position:absolute;inset:0;background:var(--paper);border-radius:100% 0 0 0}.community-heading{font-size:clamp(32px,4vw,54px);line-height:1.03;letter-spacing:-.055em;font-weight:800;max-width:15ch}.community-section-intro{display:flex;align-items:center;justify-content:space-between;gap:32px;margin-bottom:48px}.community-mark{font-size:80px;line-height:1}.community-benefits-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--line);border-left:1px solid var(--line)}.community-benefit{padding:32px 36px 40px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.community-index{font-size:12px;letter-spacing:.08em;display:block;margin-bottom:40px}.community-benefit h3,.community-tier h3{font-size:26px;line-height:1.1;letter-spacing:-.035em;font-weight:700}.community-benefit p{margin-top:16px;max-width:43ch;font-size:15px}
.community-dark{background:var(--ink);color:var(--paper);--line:#454743}.community-dark .community-lead{color:#c7c9c1}.community-tiers-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:48px;border-top:1px solid var(--line);border-left:1px solid var(--line)}.community-tier{padding:32px 26px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:flex-start}.community-tier-description{font-size:14px;min-height:66px;margin-top:18px!important;color:#c7c9c1}.community-price{font-size:32px;line-height:1.2;letter-spacing:-.045em;margin-top:24px!important}.community-tier>.community-button{width:100%;margin-block:28px}.community-tier-features{border-top:1px solid var(--line);padding-top:24px;margin-top:auto;width:100%;font-size:13px}.community-tier-features>p{text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:700;margin-bottom:18px}.community-tier-features li{display:flex;gap:12px;margin-top:14px;align-items:baseline}.community-check{font-size:16px}.community-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:80px}.community-steps li{display:flex;gap:28px;border-top:1px solid var(--line);padding-block:28px}.community-steps .community-index{margin:4px 0;flex-shrink:0}.community-steps h3,.community-events h3{font-size:22px;font-weight:700;letter-spacing:-.03em;line-height:1.2}.community-steps p,.community-events p{margin-top:12px;max-width:48ch;font-size:15px}.community-soft{background:var(--soft)}.community-events li{border-top:1px solid #babbb3;padding-block:28px;display:flex;justify-content:space-between;gap:32px}.community-events li>span{font-size:28px}.community-event-date{font-weight:700;font-size:12px!important;text-transform:uppercase;letter-spacing:.05em}.community-voices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:40px;margin-top:56px}.community-voices li{display:flex;flex-direction:column}.community-quote-mark{font-size:90px;line-height:.85}.community-voices blockquote{font-size:23px;line-height:1.3;letter-spacing:-.03em;margin-bottom:32px}.community-attribution{margin-top:auto;padding-top:18px;border-top:1px solid var(--line);font-size:12px}.community-attribution p:first-child{font-weight:700}.community-faq details{border-top:1px solid var(--line);padding-block:22px}.community-faq summary{position:relative;cursor:pointer;font-weight:700;font-size:18px;padding-right:36px;list-style:none}.community-faq summary::-webkit-details-marker{display:none}.community-faq summary:after{content:'+';position:absolute;right:0;top:0;font-size:24px;line-height:1}.community-faq details[open] summary:after{content:'−'}.community-faq p{font-size:15px;margin-top:20px;max-width:52ch}.community-join{border-top:1px solid var(--line);background:var(--soft)}.community-join .community-button{margin-top:28px}.community-contact{display:flex;flex-direction:column;gap:12px;font-size:14px;margin-top:30px}.community-contact a{text-decoration:underline;text-underline-offset:5px}.community-unavailable{display:block;margin-top:28px!important;font-weight:700}.community-application{background:var(--paper);border:1px solid var(--ink);padding:32px}.community-application label{display:block;margin-top:20px;margin-bottom:8px;font-size:13px;font-weight:700}.community-application input,.community-application select,.community-application textarea{width:100%;min-height:48px;border:1px solid var(--line);background:var(--paper);color:var(--ink);padding:12px;font:16px Arial;resize:vertical;border-radius:0}.community-form-note{font-size:12px;line-height:1.6;margin-top:20px!important;color:#50534b}.community-form-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:24px}.community-form-actions .community-button{margin-top:0}.community-application h3{font-size:24px;margin-top:20px}.community-application dl{margin-top:24px}.community-application dt{font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-top:18px;font-weight:700}.community-application dd{margin:5px 0 0;white-space:pre-wrap}.community-application [role=status]{font-size:13px;margin-top:18px}.community-footer{background:var(--ink);color:var(--paper);padding-block:48px;font-size:12px}.community-footer>.community-wrap{display:flex;align-items:start;gap:40px;flex-wrap:wrap;justify-content:space-between}.community-footer p{max-width:34ch}.community-footer ul{display:flex;flex-wrap:wrap;gap:20px;color:#b8bab2}.community-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.community-skip{position:fixed;top:8px;left:8px;z-index:99;padding:12px;background:var(--accent);transform:translateY(-200%)}.community-skip:focus{transform:translateY(0)}
@media(max-width:900px){.community-wrap{width:calc(100% - 48px)}.community-desktop-nav{display:none}.community-header>.community-wrap{min-height:80px;gap:16px}.community-mobile-nav{display:block;position:relative;font-size:12px}.community-mobile-nav summary{cursor:pointer;padding:12px 0}.community-mobile-nav nav{position:absolute;right:0;top:100%;z-index:5;min-width:200px;padding:12px;border:1px solid var(--ink);background:var(--paper);box-shadow:0 12px 24px #0002}.community-mobile-nav nav a{display:block;padding:12px}.community-hero-grid{gap:32px;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}.community-title{font-size:clamp(48px,7.2vw,64px)}.community-split{gap:40px;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr)}.community-tier{padding:28px 20px}.community-tier h3{font-size:23px}.community-tier-description{min-height:85px}.community-price{font-size:27px}.community-voices{gap:24px}.community-voices blockquote{font-size:20px}}
@media(max-width:600px){.community-wrap{width:calc(100% - 40px)}.community-section{padding-block:64px}.community-header>.community-wrap{min-height:76px;gap:12px}.community-brand{max-width:128px;font-size:16px}.community-header .community-button{max-width:125px;gap:12px;font-size:11px;padding:10px}.community-hero{padding-block:44px 58px}.community-hero-grid{grid-template-columns:1fr;gap:42px}.community-title{font-size:52px;max-width:13ch;letter-spacing:-.055em}.community-lead{font-size:16px;margin-top:24px!important}.community-art{width:70%;margin-left:auto;aspect-ratio:1.2;transform:rotate(-3deg)}.community-art>div{aspect-ratio:auto}.community-eyebrow{font-size:10px;max-width:40ch}.community-hero .community-button{margin-top:24px}.community-heading{font-size:38px}.community-section-intro{margin-bottom:30px}.community-mark{font-size:56px}.community-benefits-grid{grid-template-columns:1fr}.community-benefit{padding:28px}.community-index{margin-bottom:28px}.community-benefit h3{font-size:25px}.community-tiers-grid{grid-template-columns:1fr;margin-top:32px}.community-tier{padding:28px}.community-tier-description{min-height:0}.community-price{font-size:32px}.community-tier>.community-button{margin-block:24px}.community-split{grid-template-columns:1fr;gap:32px}.community-voices{grid-template-columns:1fr;gap:40px;margin-top:36px}.community-voices blockquote{font-size:26px}.community-quote-mark{font-size:70px}.community-application{padding:24px}.community-footer>.community-wrap{flex-direction:column;gap:24px}}
@media(prefers-reduced-motion:reduce){.community-page *, .community-page *:before,.community-page *:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

export const COMMUNITY_BROWSER_SOURCE = String.raw`
(() => {
  const form = document.querySelector('[data-community-application]');
  if (!form) return;
  const fields = form.querySelector('[data-community-fields]');
  const review = form.querySelector('[data-community-review]');
  const progress = form.querySelector('[data-community-progress]');
  const start = document.querySelector('[data-community-start]');
  const tier = form.elements.namedItem('tier');
  const open = () => { form.hidden = false; start.hidden = true; };
  start.addEventListener('click', (event) => { event.preventDefault(); open(); form.elements.namedItem('name').focus(); });
  document.querySelectorAll('[data-community-tier]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    open(); tier.value = link.dataset.communityTier; fields.hidden = false; review.hidden = true;
    progress.textContent = '1 / 2 — Your details';
    form.elements.namedItem('name').focus();
  }));
  const reviewApplication = (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const rows = [['Name', data.get('name')], ['Email', data.get('email')], ['Membership', data.get('tier') || 'Advice on a tier'], ['About your work', data.get('message')]];
    const summary = form.querySelector('[data-community-summary]'); summary.replaceChildren();
    rows.forEach(([label, value]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; summary.append(dt, dd); });
    const body = rows.map(([label, value]) => label + ': ' + value).join('\n\n');
    const subject = 'Membership enquiry — ' + form.dataset.brand;
    const href = form.dataset.mailto + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    const draft = form.querySelector('[data-community-draft]');
    // A conservative handoff bound: email apps impose different URI limits. Always retain a
    // manual path; a long encoded draft must not be offered as if it can reliably open.
    const tooLong = href.length > 2048;
    draft.hidden = tooLong; draft.href = tooLong ? form.dataset.mailto : href;
    form.querySelector('[data-community-manual]').hidden = !tooLong;
    form.querySelector('[data-community-copy-text]').value = 'To: ' + form.dataset.email + '\nSubject: ' + subject + '\n\n' + body;
    fields.hidden = true; review.hidden = false; progress.textContent = '2 / 2 — Review'; review.querySelector('h3').focus();
    form.querySelector('[data-community-status]').textContent = tooLong ? 'This application is too long for a reliable email link. Copy the details below into your email app. Nothing has been sent from this page.' : '';
  };
  // Sandboxed previews block native form submission before a submit event can fire.
  // A click handler also covers implicit Enter activation; validation stays local.
  form.querySelector('button[type="submit"]').addEventListener('click', reviewApplication);
  form.addEventListener('submit', reviewApplication);
  form.querySelector('[data-community-edit]').addEventListener('click', () => {
    fields.hidden = false; review.hidden = true; progress.textContent = '1 / 2 — Your details'; form.elements.namedItem('name').focus();
  });
  form.querySelector('[data-community-draft]').addEventListener('click', () => {
    form.querySelector('[data-community-status]').textContent = 'Your email app may open the draft. If it does not, copy the details manually. Nothing has been sent from this page.';
  });
  form.querySelector('[data-community-copy]').addEventListener('click', () => {
    form.querySelector('[data-community-manual]').hidden = false;
    const copy = form.querySelector('[data-community-copy-text]'); copy.focus(); copy.select();
    form.querySelector('[data-community-status]').textContent = 'Details selected. Copy them into your email app. Nothing has been sent from this page.';
  });
})();
`;

const WRAP = 'community-wrap';
const H2 = 'community-heading';
const JOIN_BUTTON = 'community-button';
const CHECK = '<span aria-hidden="true" class="community-check">↗</span>';
const section = (s: CommunitySection, body: string, theme = '') => `<section id="${s.id}" class="community-section ${theme}"><div class="${WRAP}">${body}</div></section>`;
const heading = (s: CommunitySection) => slot('h2', H2, `${s.id}--heading`, str(s.text, 'heading'));

function renderHeader(s: CommunitySection, recipe: CommunityRecipe): string {
  const renderedIds = new Set(presentSections(recipe.sections).map((s) => s.id));
  const nav = NAV_TARGET_ORDER.filter((id) => renderedIds.has(id)).slice(0, 4)
    .map((id) => `<a href="#${id}">${e(NAV_LABELS[id]!)}</a>`).join('');
  return `<header id="${s.id}" class="community-header"><div class="${WRAP}"><a href="#${HERO_SECTION_ID}" class="community-brand">`
    + slot('span', '', 'brand--name', recipe.brand.name) + `</a>`
    + slot('p', 'community-sr', 'brand--descriptor', recipe.brand.descriptor)
    + `<nav class="community-desktop-nav" aria-label="Main navigation">${nav}</nav>`
    + `<a href="#${JOIN_SECTION_ID}" class="${JOIN_BUTTON}" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`
    + `<details class="community-mobile-nav"><summary>Menu</summary><nav aria-label="Mobile navigation">${nav}</nav></details></div></header>`;
}
function renderHero(s: CommunitySection): string {
  return section(s, `<div class="community-hero-grid"><div class="community-hero-copy">`
    + slot('p', 'community-eyebrow', `${s.id}--eyebrow`, str(s.text, 'eyebrow'))
    + slot('h1', 'community-title', `${s.id}--heading`, str(s.text, 'heading'))
    + slot('p', 'community-lead', `${s.id}--body`, str(s.text, 'body'))
    + `<a href="#${JOIN_SECTION_ID}" class="${JOIN_BUTTON}" data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`
    + atom('p', 'community-count', `${s.id}--memberCount`, nullable(s.text, 'memberCount'))
    + `</div><div class="community-art" aria-hidden="true"><div class="community-art-circle"></div><div class="community-art-bars"></div><div class="community-art-cross"></div><div class="community-art-disc"></div></div></div>`, 'community-hero');
}
function renderBenefits(s: CommunitySection): string {
  const cards = items(s).map((item, i) => `<article class="community-benefit"><span class="community-index" aria-hidden="true">0${i + 1}</span>`
    + slot('h3', '', `${s.id}--items-${i}--title`, str(item, 'title'))
    + slot('p', '', `${s.id}--items-${i}--blurb`, str(item, 'blurb')) + `</article>`).join('');
  return section(s, `<div class="community-section-intro">${heading(s)}<span aria-hidden="true" class="community-mark">✳</span></div><div class="community-benefits-grid">${cards}</div>`);
}
function renderTiers(s: CommunitySection): string {
  const cards = items(s).map((item, i) => {
    const features = (item.features as string[]).map((f, j) => `<li>${CHECK}${slot('span', '', `${s.id}--items-${i}--features-${j}`, f)}</li>`).join('');
    return `<article class="community-tier">` + slot('h3', '', `${s.id}--items-${i}--name`, str(item, 'name'))
      + slot('p', 'community-tier-description', `${s.id}--items-${i}--description`, str(item, 'description'))
      + atom('p', 'community-price', `${s.id}--items-${i}--price`, nullable(item, 'price'))
      + `<a href="#${JOIN_SECTION_ID}" class="${JOIN_BUTTON}" data-community-tier="${e(str(item, 'name'))}" data-od-id="${s.id}--items-${i}--cta">${e(str(item, 'cta'))}</a>`
      + `<div class="community-tier-features"><p>What's included</p><ul>${features}</ul></div></article>`;
  }).join('');
  return section(s, heading(s) + slot('p', 'community-lead', `${s.id}--body`, str(s.text, 'body')) + `<div class="community-tiers-grid">${cards}</div>`, 'community-dark');
}
function renderHowItWorks(s: CommunitySection): string {
  const steps = items(s).map((item, i) => `<li><span class="community-index" aria-hidden="true">0${i + 1}</span><div>`
    + slot('h3', '', `${s.id}--items-${i}--title`, str(item, 'title'))
    + slot('p', '', `${s.id}--items-${i}--body`, str(item, 'body')) + `</div></li>`).join('');
  return section(s, `<div class="community-split">${heading(s)}<ol class="community-steps">${steps}</ol></div>`);
}
function renderEvents(s: CommunitySection): string {
  const rows = items(s).map((item, i) => `<li><div>`
    + slot('h3', '', `${s.id}--items-${i}--title`, str(item, 'title'))
    + atom('p', 'community-event-date', `${s.id}--items-${i}--date`, nullable(item, 'date'))
    + slot('p', '', `${s.id}--items-${i}--blurb`, str(item, 'blurb')) + `</div></li>`).join('');
  return section(s, `<div class="community-split">${heading(s)}<ul class="community-events">${rows}</ul></div>`, 'community-soft');
}
function renderVoices(s: CommunitySection): string {
  const cards = items(s).map((item, i) => `<li><span aria-hidden="true" class="community-quote-mark">“</span>`
    + slot('blockquote', '', `${s.id}--items-${i}--quote`, str(item, 'quote'))
    + `<div class="community-attribution">` + atom('p', '', `${s.id}--items-${i}--name`, nullable(item, 'name'))
    + slot('p', '', `${s.id}--items-${i}--role`, str(item, 'role')) + `</div></li>`).join('');
  return section(s, heading(s) + `<ul class="community-voices">${cards}</ul>`, 'community-dark');
}
function renderFaq(s: CommunitySection): string {
  const rows = items(s).map((item, i) => `<details><summary data-od-id="${s.id}--items-${i}--question">${e(str(item, 'question'))}</summary>`
    + slot('p', '', `${s.id}--items-${i}--answer`, str(item, 'answer')) + `</details>`).join('');
  return section(s, `<div class="community-split">${heading(s)}<div class="community-faq">${rows}</div></div>`);
}
function renderJoin(s: CommunitySection, recipe: CommunityRecipe): string {
  const phone = nullable(s.text, 'phone'), email = nullable(s.text, 'email');
  const destination = email !== null ? mailHref(email) : phone !== null ? telHref(phone) : null;
  const cta = destination === null ? slot('span', 'community-unavailable', `${s.id}--cta`, str(s.text, 'cta'))
    : `<a href="${e(destination)}" class="${JOIN_BUTTON}" data-community-start data-od-id="${s.id}--cta">${e(str(s.text, 'cta'))}</a>`;
  const tiers = recipe.sections.find((section) => section?.id === TIERS_SECTION_ID);
  const choices = tiers ? items(tiers).map((item) => `<option value="${e(str(item, 'name'))}">${e(str(item, 'name'))}</option>`).join('') : '';
  // Progressive enhancement only with a supplied email. Native links remain usable without JS.
  const form = email === null ? '' : `<form class="community-application" hidden data-community-application data-email="${e(email)}" data-mailto="${e(destination!)}" data-brand="${e(recipe.brand.name)}">
    <p class="community-eyebrow" data-community-progress>1 / 2 — Your details</p>
    <div data-community-fields><label for="community-name">Your name</label><input id="community-name" name="name" autocomplete="name" required maxlength="120">
    <label for="community-email">Your email</label><input id="community-email" name="email" type="email" autocomplete="email" required maxlength="254">
    <label for="community-tier">Membership</label><select id="community-tier" name="tier"><option value="">I'd like advice on a tier</option>${choices}</select>
    <label for="community-message">What do you make, and how would you use the space?</label><textarea id="community-message" name="message" rows="4" required maxlength="2000"></textarea>
    <p class="community-form-note">These details stay on this page. Review them before opening your email app.</p><button type="submit" class="${JOIN_BUTTON}">Review application</button></div>
    <div data-community-review hidden><h3 tabindex="-1">Review your application</h3><dl data-community-summary></dl><p class="community-form-note">Nothing has been sent. Open the draft or copy your details into your email app, then send them there.</p><div class="community-form-actions"><button type="button" data-community-edit class="community-secondary">Edit details</button><a data-community-draft class="${JOIN_BUTTON}" href="${e(destination!)}">Open email draft</a><button type="button" data-community-copy class="community-secondary">Copy details manually</button></div><p data-community-status role="status"></p><div data-community-manual hidden><label for="community-copy">Email details to copy</label><textarea id="community-copy" data-community-copy-text readonly rows="8"></textarea></div></div></form>`;
  return section(s, `<div class="community-split"><div>${heading(s)}`
    + slot('p', 'community-lead', `${s.id}--body`, str(s.text, 'body')) + cta + `</div><div>${form}`
    + `<div class="community-contact">` + atomContact('phone', '', `${s.id}--phone`, phone) + atomContact('email', '', `${s.id}--email`, email) + `</div>`
    + (destination === null ? `<p class="community-form-note">Contact details have not been supplied.</p>` : '') + `</div></div>`, 'community-join');
}
function renderFooter(s: CommunitySection): string {
  return `<footer id="${s.id}" class="community-footer"><div class="${WRAP}">`
    + slot('p', '', `${s.id}--tagline`, str(s.text, 'tagline'))
    + `<ul>` + atomLink('', `${s.id}--link1`, nullable(s.text, 'link1')) + atomLink('', `${s.id}--link2`, nullable(s.text, 'link2')) + atomLink('', `${s.id}--link3`, nullable(s.text, 'link3')) + `</ul>`
    + atom('p', '', `${s.id}--address`, nullable(s.text, 'address')) + `</div></footer>`;
}

const RENDERERS: Record<string, (s: CommunitySection, recipe: CommunityRecipe) => string> = {
  [HEADER_SECTION_ID]: renderHeader,
  [HERO_SECTION_ID]: renderHero,
  [BENEFITS_SECTION_ID]: renderBenefits,
  [TIERS_SECTION_ID]: renderTiers,
  [HOW_IT_WORKS_SECTION_ID]: renderHowItWorks,
  [EVENTS_SECTION_ID]: renderEvents,
  [VOICES_SECTION_ID]: renderVoices,
  [FAQ_SECTION_ID]: renderFaq,
  [JOIN_SECTION_ID]: renderJoin,
  [FOOTER_SECTION_ID]: renderFooter,
};

export function renderCommunity(recipe: CommunityRecipe, _resolvedAssetPaths: Record<string, string>): string {
  // A dropped optional section (a null slot) renders nothing at all.
  const rendered = presentSections(recipe.sections).map((section) => RENDERERS[section.id]!(section, recipe));
  const body = `${rendered[0]}<main>${rendered.slice(1, -1).join('')}</main>${rendered.at(-1)}`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src '${createHash('sha256').update(COMMUNITY_BROWSER_SOURCE).digest('base64').replace(/^/, 'sha256-')}'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
    + `<meta name="description" content="${e(recipe.brand.descriptor)}">`
    + `<title>${e(recipe.brand.name)}</title><style>${inlinedStyles()}\n${COMMUNITY_STYLES}</style></head>`
    + `<body class="community-page"><a class="community-skip" href="#${HERO_SECTION_ID}">Skip to content</a>${body}<script>${COMMUNITY_BROWSER_SOURCE}</script></body></html>\n`;
}

/** Read one text slot back out of saved HTML by its data-od-id. */
export function findCommunityTextSlot(html: string, odId: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(odId)) throw new Error('data-od-id: expected letters, digits and hyphens only');
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*\\sdata-od-id="${odId}"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? match[2]!.replace(/<[^>]*>/g, '').trim() : undefined;
}

/** Every data-od-id present in saved HTML, in document order. */
export function listCommunityTextSlots(html: string): string[] {
  return [...html.matchAll(/data-od-id="([^"]+)"/g)].map((match) => match[1]!);
}

export { SECTION_ORDER, COMMUNITY_NULLABLE_ATOMS, COMMUNITY_OPTIONAL_SECTIONS } from './slots.ts';
