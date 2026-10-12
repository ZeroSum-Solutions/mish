import { observeComponentTokens } from '../../component-token-evidence.js';
import { createHash } from 'node:crypto';
import type { ResourceCandidate, ResourceRef, ResourceSourceSnapshot } from '@open-design/contracts';
import type { CatalogueMaterial, CatalogueMaterialFile, CatalogueMaterialSource } from '../../adoption/catalogue-material.js';
import { canonicalJson } from '../../placement/adoption-plan.js';
import type { ResourceSourceAdapter } from '../../resources.js';
import { G02_REACT95_RECEIPT } from '../../targets/react/g02-react95-receipt.js';
import { validateReact95Receipt, type React95KitReceipt } from '../../targets/react/react95-receipt.js';
import type { React95Kit } from './kit-types.js';
import { REACT95_KIT } from './kit.generated.js';
import { REACT95_PROJECT_DEPENDENCIES, REACT95_TOOLCHAIN } from './pins.js';
import { REACT95_PREVIEWS } from './preview.generated.js';
import { REACT95_UNIT_LICENCE_PATH, react95UnitFiles, unitPathOf, type React95UnitFile } from './unit.js';

/**
 * R17: the Windows95 kit from the exact requested React95 source as a
 * catalogue material (apply/edit/save/second-project reuse/undo through the
 * existing catalogue adoption manager) and as a resource source (search,
 * inspect, isolated preview). Two templates are the admitted units; every
 * shipped upstream component is listed individually with its own readiness,
 * so the templates never stand in for the whole kit.
 */
export const REACT95_SOURCE_ID = 'react95' as const;
export const REACT95_STYLE_TAGS = ['windows95', 'win95', 'react95', 'retro'] as const;
const TEMPLATE_PREFIX = 'template-';
const COMPONENT_PREFIX = 'component-';
export const react95TemplateItemId = (templateId: string) => `${TEMPLATE_PREFIX}${templateId}`;
export const react95PreviewPath = (itemId: string) => `/api/workbench/kits/react95/${encodeURIComponent(itemId)}/preview`;
/** Response policy for the preview: a sandboxed document with inline script and style only, no network, no navigation. */
export const REACT95_PREVIEW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sourceUrl = (kit: React95Kit) => `${kit.source.repository}/tree/${kit.source.commit}`;
const shortCommit = (kit: React95Kit) => kit.source.commit.slice(0, 7);

/**
 * Components whose own upstream source shows a defect the templates had to
 * repair (source inspection and the receipt's computed contrast), so they are
 * `needs-repair` on their own rather than `unverified`.
 */
const COMPONENT_REPAIRS: Readonly<Record<string, string>> = {
  window: 'Upstream Window draws a resize handle without resizing, its close and menu buttons have no actions, WindowHeader has no active-window semantics, and the original theme\'s inactive title colors measure below 4.5:1; the window template supplies all four',
  'menu-list': 'Upstream MenuList has no keyboard controls ("TODO keyboard controls") and no focus style for items; the window template supplies arrow/Home/End/Escape/Enter handling and a focus style',
  'text-input': 'Upstream TextInput removes the focus outline; both templates restore a visible focus indicator',
};

export interface React95Materials extends CatalogueMaterialSource {
  readonly itemIds: readonly string[];
  /** The receipt-hashed isolated preview of a template item, or null for anything else. */
  preview(itemId: string): Promise<string | null>;
}

export class React95PreviewUnverifiedError extends Error {
  readonly reason = 'react95-preview-unverified';
  constructor() { super('The React95 preview document does not match its G02 receipt'); this.name = 'React95PreviewUnverifiedError'; }
}

const PATCH_WORDS: Readonly<Record<string, string>> = {
  'flat-layout': 'relative imports point at the flat unit file names',
  TS1205: 'inline `type` on type-only re-exports',
  TS1484: 'inline `type` on type-only imports',
  TS2591: '`Buffer` read from globalThis (a Node-only fallback browsers never take)',
};
function describePatch(kit: React95Kit, upstreamPath: string): string {
  const patch = kit.patches.find(entry => entry.path === upstreamPath);
  return patch ? `${patch.reasons.map(reason => PATCH_WORDS[reason]).join('; ')} (no behavior change)` : 'none';
}

function notice(kit: React95Kit, files: readonly { path: string; role: CatalogueMaterialFile['role'] }[], unit: readonly React95UnitFile[]): string {
  const upstream = unit.filter(file => file.upstream && file.path !== REACT95_UNIT_LICENCE_PATH && files.some(written => written.path === file.path));
  const authored = unit.filter(file => !file.upstream).map(file => file.path);
  const patched = new Set(kit.patches.map(patch => unitPathOf(patch.path)));
  return [
    `React95 source files in this unit come from ${kit.source.repository} at commit ${kit.source.commit}.`,
    `They are used under the licence in ${REACT95_UNIT_LICENCE_PATH}, reproduced verbatim below from the upstream LICENSE file (git blob ${kit.notices.code.gitBlob}).`,
    `The upstream package manifest links ${kit.source.manifestRepository}; this unit was not taken from that repository. The manifest version ${kit.source.packageVersion} is not a release pin.`,
    '',
    'Upstream files (git blob ids, comparable with `git ls-tree` of the commit):',
    ...upstream.map(file => `- ${file.path} (upstream ${file.upstream!.path}): blob ${file.upstream!.gitBlob}${patched.has(file.path) ? `, modified: ${describePatch(kit, file.upstream!.path)}` : ''}`),
    '',
    `Files written for this unit by Mishh Mashh (not upstream): ${authored.join(', ')}.`,
    '',
    'Fonts: none are shipped. The unit uses the system sans-serif font stack.',
    ...kit.notices.fonts.map(font => `The upstream pixel font "${font.family}" is a FontStruct recreation under its own terms (not the code licence); if a project opts in to it, carry these notices verbatim with the font file:\n\n${font.licence.text.trim()}\n\n${font.readme.text.trim()}`),
    '',
    'Packages the project declares and installs itself (checked, never installed by Mishh Mashh):',
    ...REACT95_PROJECT_DEPENDENCIES.map(dependency => `- ${dependency.name} ${dependency.range}`),
    `- react and react-dom (receipt-covered: React ${REACT95_TOOLCHAIN.react.split('.')[0]}), and react-is, a styled-components peer.`,
    `The published styled-components ${REACT95_TOOLCHAIN['styled-components']} package ships no licence file; its package.json declares "MIT". No licence text is reproduced for it here.`,
    '',
    `--- ${REACT95_UNIT_LICENCE_PATH} (upstream LICENSE, verbatim) ---`,
    kit.notices.code.text.trim(),
    '',
  ].join('\n');
}

export function createReact95Materials(options: { kit?: React95Kit; previews?: Readonly<Record<string, string>>; receipt?: React95KitReceipt | null } = {}): React95Materials {
  const kit = options.kit ?? REACT95_KIT;
  const previews = options.previews ?? REACT95_PREVIEWS;
  const receipt = options.receipt === undefined ? G02_REACT95_RECEIPT : options.receipt;
  const itemIds = kit.templates.map(template => react95TemplateItemId(template.id));
  const templateOf = (itemId: string) => itemId.startsWith(TEMPLATE_PREFIX) ? kit.templates.find(template => template.id === itemId.slice(TEMPLATE_PREFIX.length)) ?? null : null;
  return {
    sourceId: REACT95_SOURCE_ID,
    itemIds,
    async materialize(itemId: string): Promise<CatalogueMaterial | null> {
      const template = templateOf(itemId);
      if (!template) return null;
      const unit = react95UnitFiles(kit, template.id)!;
      const files: CatalogueMaterialFile[] = unit.map(file => ({ path: file.path, role: file.role, bytes: file.bytes }));
      const packageDependencies = REACT95_PROJECT_DEPENDENCIES.map(dependency => ({ ...dependency }));
      const revision = sha256(canonicalJson({
        source: 'react95-kit/1', item: itemId, adapter: 'react-source/v1', commit: kit.source.commit,
        files: files.map(file => ({ path: file.path, role: file.role, sha256: sha256(file.bytes) })), packageDependencies,
      }));
      const ref: ResourceRef = { sourceType: 'library', sourceId: REACT95_SOURCE_ID, itemId, revisionOrDigest: `sha256:${revision}` };
      const text = notice(kit, files, unit);
      return {
        ref, title: `React95 · ${template.title}`, origin: 'adapted', files, packageDependencies, target: 'react-source/v1',
        // The receipt proves these exact releases; an older install or declared floor is refused.
        dependencyMinimums: [{ name: 'styled-components', minimum: REACT95_TOOLCHAIN['styled-components'] }, { name: '@types/styled-components', minimum: REACT95_TOOLCHAIN['@types/styled-components'] }],
        // The receipt covers styled-components 5 only (v6 forwards unknown props to the DOM); any other installed major is refused.
        dependencyMajors: [{ name: 'styled-components', majors: [Number(REACT95_TOOLCHAIN['styled-components'].split('.')[0])] }],
        noticeFor: written => notice(kit, written, unit),
        rights: {
          status: 'permitted', licence: 'MIT (React95 source files, upstream LICENSE); template and adapter files authored in Mishh Mashh; no font shipped',
          notice: text, sourceUrl: sourceUrl(kit), packageName: `react95 source @ ${shortCommit(kit)}`,
        },
      };
    },
    async preview(itemId: string): Promise<string | null> {
      const template = templateOf(itemId);
      const html = template ? previews[template.id] : undefined;
      if (!template || html === undefined) return null;
      // Only the document the G02 receipt hashed is served.
      const recorded = receipt?.templates.find(entry => entry.template === template.id)?.outputs.preview.sha256;
      if (recorded !== sha256(html)) throw new React95PreviewUnverifiedError();
      return html;
    },
  };
}

const GRANTS: ResourceCandidate['operationGrants'] = [
  { operation: 'host-preview', state: 'permitted', reason: null },
  { operation: 'incorporation', state: 'permitted', reason: null },
  { operation: 'private-save', state: 'permitted', reason: null },
  { operation: 'private-reuse', state: 'permitted', reason: null },
  { operation: 'export', state: 'permitted', reason: null },
  { operation: 'redistribution', state: 'unknown', reason: 'Public reusable-unit sharing is separately gated and not assessed here' },
];

/**
 * Discovery and inspect. A template is `usable` only while the committed G02
 * React95 receipt validates against its exact unit; otherwise it stays
 * `unverified`. Components are individually tracked and never `usable` here.
 */
/** The receipt-covered React major with react-dom, plus the declared project dependencies. */
const REACT95_TARGET_DEPENDENCIES: readonly { name: string; range: string; scope: 'project' }[] = Object.freeze([
  { name: 'react', range: `^${REACT95_TOOLCHAIN.react}`, scope: 'project' as const },
  { name: 'react-dom', range: `^${REACT95_TOOLCHAIN['react-dom']}`, scope: 'project' as const },
  ...REACT95_PROJECT_DEPENDENCIES.map(dependency => ({ name: dependency.name, range: dependency.range, scope: 'project' as const })),
]);

export function createReact95ResourceSource(materials: React95Materials, options: { kit?: React95Kit; receipt?: React95KitReceipt | null } = {}): ResourceSourceAdapter {
  const kit = options.kit ?? REACT95_KIT;
  const receipt = options.receipt === undefined ? G02_REACT95_RECEIPT : options.receipt;
  return {
    sourceId: REACT95_SOURCE_ID,
    async list(): Promise<ResourceSourceSnapshot> {
      const receiptValid = validateReact95Receipt(receipt).ok;
      const items: ResourceCandidate[] = [];
      const attribution = (title: string) => ({ title: `React95 (react95-io/React95@${shortCommit(kit)}) · ${title}`, url: sourceUrl(kit) });
      for (const itemId of materials.itemIds) {
        const material = (await materials.materialize(itemId))!;
        const template = kit.templates.find(entry => react95TemplateItemId(entry.id) === itemId)!;
        const covered = receiptValid ? receipt!.templates.find(entry => entry.template === template.id) : undefined;
        const usable = !!covered;
        items.push({
          ref: material.ref, title: material.title, category: 'template', readiness: usable ? 'usable' : 'unverified',
          ...(usable ? { acceptanceEvidence: { sourceDigest: material.ref.revisionOrDigest, receiptId: `g02-react95-receipt:${covered!.unitSha256}`, passed: true as const } } : {}),
          componentTokenEvidence: observeComponentTokens(material.ref, material.files),
          compatibility: {
            nativeFormat: 'tsx', targets: ['react'], state: usable ? 'compatible' : 'unverified',
            reason: `react-source/v1: needs installed React ${REACT95_TOOLCHAIN.react.split('.')[0]} with react-dom, TypeScript, ${REACT95_PROJECT_DEPENDENCIES.map(d => `${d.name} ${d.range}`).join(' and ')} in the project`,
          },
          rightsStatus: 'permitted',
          fitReasons: [
            template.id === 'window-app'
              ? 'Purpose: desktop-like application window with close/reopen from a taskbar, pointer and keyboard resizing, focus handling and a keyboard File menu'
              : 'Purpose: responsive settings form with enabled, disabled, focus, invalid, saving, success and error/retry states through a declared local save action',
            'Theme: project-owned prop (original or high contrast); the host application is never restyled',
            'Font: system sans-serif; the upstream CC BY-SA 3.0 pixel font is not shipped (opt-in with its notices)',
            `Source: ${kit.source.repository} at ${kit.source.commit}; ${template.closure.length} vendored upstream files`,
            usable ? `G02 receipt: type-check, production build, SSR, Strict Mode hydration and ${covered!.checks.length} behavior/keyboard/isolation/contrast/cleanup checks passed` : 'G02 receipt: pending for this unit',
          ],
          previewCapability: { available: true, kind: 'html', url: react95PreviewPath(itemId), reason: null },
          // What the template brings into a React project. Declaring styled-components here is
          // also what makes its Enlarge preview a styled-components preview (AC-R07 preamble).
          targetDependencies: REACT95_TARGET_DEPENDENCIES.map(dependency => ({ ...dependency })),
          adoptionCapability: usable ? { available: true, reason: null } : { available: false, reason: 'acceptance-receipt-pending' },
          sourceAttribution: attribution(template.title),
          styleClass: 'retro', styleTags: [...REACT95_STYLE_TAGS], implementationOrigin: 'adapted', variantGroup: 'react95/templates',
          operationGrants: GRANTS.map(grant => ({ ...grant })),
          admissionStage: 'admitted', needDecision: 'required',
          needReason: 'Owner-required opt-in Windows95 kit (R17, candidate 37); offered only when the project or query asks for retro',
        });
      }
      for (const component of kit.inventory.components) {
        const digest = sha256(canonicalJson(component.files.map(file => ({ path: file.path, gitBlob: file.gitBlob }))));
        const usedBy = kit.templates.filter(template => component.files.some(file => template.closure.includes(file.path))).map(template => template.title);
        const repair = COMPONENT_REPAIRS[component.id];
        items.push({
          ref: { sourceType: 'library', sourceId: REACT95_SOURCE_ID, itemId: `${COMPONENT_PREFIX}${component.id}`, revisionOrDigest: `sha256:${digest}` },
          title: `React95 ${component.name}${component.legacy ? ' (deprecated upstream)' : ''}`, category: 'component',
          readiness: repair ? 'needs-repair' : 'unverified',
          compatibility: { nativeFormat: 'tsx', targets: ['react'], state: 'unverified', reason: 'Per-component render, state and dependency gate pending; tracked in the frozen inventory' },
          rightsStatus: 'permitted',
          fitReasons: [
            `Exported by upstream src/index.ts as ${component.exportPath}`,
            `${component.files.length} shipped file(s) frozen with git blob ids`,
            usedBy.length ? `Used by ${usedBy.join(' and ')}; exercised there, not admitted on its own` : 'Not used by an admitted template',
            ...(component.legacy ? ['Deprecated upstream'] : []),
            ...(repair ? [`Needs repair: ${repair}`] : []),
          ],
          previewCapability: { available: false, kind: 'none', reason: 'component-preview-pending' },
          adoptionCapability: { available: false, reason: repair ? 'component-needs-repair' : 'component-gate-pending' },
          sourceAttribution: attribution(component.name),
          styleClass: 'retro', styleTags: [...REACT95_STYLE_TAGS], implementationOrigin: 'official', variantGroup: 'react95/components',
          operationGrants: GRANTS.map(grant => ({ ...grant })),
          admissionStage: repair ? 'needs-repair' : 'discovered', needDecision: 'not-assessed',
          needReason: 'Tracked individually: two passing templates do not clear the whole kit',
        });
      }
      const listingDigest = sha256(canonicalJson(items.map(item => item.ref)));
      return { items, status: { sourceId: REACT95_SOURCE_ID, state: 'searched', reason: null, itemCount: items.length, listingDigest } };
    },
  };
}
