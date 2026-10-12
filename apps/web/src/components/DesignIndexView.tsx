// Design index tab: three panels over the daemon's design-index and agency
// routes — Search (facet query over the stored profiles), Profile (label a
// page or a text with Jev) and Route (send a brief to a spine, an archetype
// and a family).
//
// Jev costs a call and about half a second, so every Jev-backed request runs
// on an explicit button press. The only reads that fire when the view opens
// are the taxonomy (which builds the facet selects) and the first unfiltered
// list; neither touches Jev. An unrouted decision is a result, not an error:
// five of the nine spines have no family yet, so "no family" is the honest
// answer, and the Route panel renders it in the same card as a routed one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DESIGN_INDEX_DEFAULT_LIMIT,
  DESIGN_INDEX_DEFAULT_MIN,
  DESIGN_INDEX_QUERY_LIST_KEYS,
  DESIGN_INDEX_QUERY_SCALAR_KEYS,
  DESIGN_STYLE_AXES,
  type AgencyBuildAguiState,
  type AgencyBuildAguiStepName,
  type AgencyBuildComposition,
  type AgencyBuildEvent,
  type AgencyBuildListItem,
  type AgencyBuildRepairResponse,
  type AgencyBuildSnapshot,
  type AgencyEffectPlacementId,
  type AgencyEffectsInput,
  type AgencyFamilyEffectsResponse,
  type AgencyFamilyOptionalSection,
  type AgencyOutputScope,
  type AgencyRouteResponse,
  type DesignIndexAddResponse,
  type DesignIndexFindResponse,
  type DesignIndexProfileRequest,
  type DesignIndexProfileResponse,
  type DesignIndexQueryScalarKey,
  type DesignIndexTaxonomyResponse,
  type DesignProfile,
  type DesignProfileSourceKind,
  type DesignTaxonomy,
  type DesignTaxonomyLabel,
  type RouteDecision,
} from '@mish/contracts';
import type {
  SectionCatalogDirectionOption,
  SectionCatalogEntry,
  SectionCatalogSpineCode,
} from '@mish/contracts/api/section-catalog';

import { Badge, Button, EmptyState } from '@mish/components';

import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import {
  AgencyBuildRepairError,
  cancelAgencyBuild,
  fetchAgencyBuild,
  fetchAgencyFamilyEffects,
  fetchAgencyFamilySections,
  fetchMotionSitesConnectionStatus,
  fetchSections,
  forkAgencyBuild,
  listAgencyBuilds,
  repairAgencyBuild,
  startAgencyBuild,
} from '../providers/registry';
import { notifyDesignIndexChanged } from '../state/design-index';
import { useAgencyBuildAgui } from '../hooks/useAgencyBuildAgui';
import {
  agencyBuildTimeline,
  type AgencyBuildStepStatus,
} from '../lib/agency-build-agui';
import {
  AgencyBuildProgress,
  BUILD_STATUS_KEY,
  BUILD_TERMINAL,
  JevErrorNotice,
  effectKindLabel,
  type JevFailure,
} from './AgencyBuildProgress';
import { ALL_FACET_KEYS, collapsedFacetKeys, isListFacetKey, type FacetKey } from './design-index-facets';
import {
  atlasArchetypeOptions,
  atlasSpineOptions,
  registryFamilyIds,
} from './plugins-home/websiteCards';
import buildCardStyles from './AgencyBuildProgress.module.css';
import styles from './DesignIndexView.module.css';
import { Icon } from './Icon';
import { FirstDraftCard } from './design-index/FirstDraftCard';
import { SelectionGroup, SelectionIndicator } from './ui/SelectionIndicator';

type Translate = ReturnType<typeof useT>;
type Panel = 'search' | 'profile' | 'route';
type ListKey = (typeof DESIGN_INDEX_QUERY_LIST_KEYS)[number];
/**
 * Every scalar facet except `text`, which has its own input. Typing the state
 * over this union rather than over the style axes alone is what lets the route
 * facets below live in the same object the query builder already reads.
 */
type ScalarFacetKey = Exclude<DesignIndexQueryScalarKey, 'text'>;

const PANELS: Panel[] = ['search', 'profile', 'route'];
const PROFILE_KINDS: DesignProfileSourceKind[] = ['html', 'prompt', 'brief', 'spec'];

// The repeatable facets and the taxonomy vocabulary each one draws from. The
// query key is singular (`?section=hero`) while the taxonomy field is plural,
// so the mapping is spelled out rather than derived.
const LIST_FACET_SOURCE: Record<ListKey, (taxonomy: DesignTaxonomy) => DesignTaxonomyLabel[]> = {
  section: (taxonomy) => taxonomy.sections,
  component: (taxonomy) => taxonomy.components,
  mechanic: (taxonomy) => taxonomy.mechanics,
  depth: (taxonomy) => taxonomy.depth,
};


function emptyLists(): Record<ListKey, string[]> {
  return { section: [], component: [], mechanic: [], depth: [] };
}

/** The whole Profile panel form — what a returned profile is tied back to. */
interface ProfileForm {
  kind: DesignProfileSourceKind;
  title: string;
  ref: string;
  id: string;
  input: string;
}

function emptyProfileForm(): ProfileForm {
  return { kind: 'html', title: '', ref: '', id: '', input: '' };
}

function sameProfileForm(a: ProfileForm, b: ProfileForm): boolean {
  return a.kind === b.kind
    && a.title === b.title
    && a.ref === b.ref
    && a.id === b.id
    && a.input === b.input;
}

function topEntries(labels: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(labels)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function meanQuality(profile: DesignProfile): number {
  const scores = Object.values(profile.quality).map((result) => result.score);
  if (scores.length === 0) return 0;
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function profileTitle(profile: DesignProfile, t: Translate): string {
  return profile.source.title || profile.source.id || t('designIndex.untitled');
}

function kindLabel(kind: DesignProfileSourceKind, t: Translate): string {
  if (kind === 'html') return t('designIndex.profile.kindHtml');
  if (kind === 'prompt') return t('designIndex.profile.kindPrompt');
  if (kind === 'brief') return t('designIndex.profile.kindBrief');
  return t('designIndex.profile.kindSpec');
}

function jevFailure(status: number, failedMessage: string, t: Translate): JevFailure {
  if (status === 503) return { message: t('designIndex.error.jevUnavailable'), jevUnavailable: true };
  if (status === 502) return { message: failedMessage, jevUnavailable: false };
  return { message: t('designIndex.error.request'), jevUnavailable: false };
}

/** The verify mode the Route panel's Build button offers — `off` is not one of them: nothing in
 * this panel ever starts a build that skips the faithfulness check outright. */
type VerifyMode = 'strict' | 'advisory' | 'after';
/**
 * The Route panel's Composition choice (`AgencyBuildRequest.composition`). `family` (the default)
 * sends no field. `blocks` and `auto` are only accepted with `verify: 'strict'` and without a
 * `sectionSelection`, so choosing either pins verify to strict and turns the section picker off.
 */
const COMPOSITIONS: readonly AgencyBuildComposition[] = ['family', 'blocks', 'auto'];

function isComposed(composition: AgencyBuildComposition): boolean {
  return composition !== 'family';
}

/** A keep/drop choice for one optional section; no entry means Jev decides. */
type SectionHint = 'keep' | 'drop';
/** What one section control shows: an explicit hint, or `auto` (Jev decides). */
type SectionChoice = SectionHint | 'auto';

/**
 * Localised section labels, keyed by `family/sectionId`. The daemon's `label` is the family
 * schema's English `x-optional.label`; a section missing here falls back to it.
 */
const SECTION_LABEL_KEYS: Record<string, keyof Dict> = {
  'watson/watson-about': 'designIndex.build.sectionLabel.watson.watson-about',
  'fervor/testimonial': 'designIndex.build.sectionLabel.fervor.testimonial',
  'wrenfield/reviews': 'designIndex.build.sectionLabel.wrenfield.reviews',
  'maben/maben-latest-projects': 'designIndex.build.sectionLabel.maben.maben-latest-projects',
  'halcyon/support': 'designIndex.build.sectionLabel.halcyon.support',
  'maren/reviews': 'designIndex.build.sectionLabel.maren.reviews',
  'emmpo/emmpo-community': 'designIndex.build.sectionLabel.emmpo.emmpo-community',
  'marketing-site/marketing-site-proof': 'designIndex.build.sectionLabel.marketing-site.marketing-site-proof',
  'app-shell/app-shell-empty': 'designIndex.build.sectionLabel.app-shell.app-shell-empty',
  'crm-dashboard/crm-dashboard-activity': 'designIndex.build.sectionLabel.crm-dashboard.crm-dashboard-activity',
  'listings/listings-reviews': 'designIndex.build.sectionLabel.listings.listings-reviews',
  'publication/publication-authors': 'designIndex.build.sectionLabel.publication.publication-authors',
  'nonprofit/nonprofit-impact': 'designIndex.build.sectionLabel.nonprofit.nonprofit-impact',
  'docs-hub/docs-hub-api': 'designIndex.build.sectionLabel.docs-hub.docs-hub-api',
  'docs-hub/docs-hub-changelog': 'designIndex.build.sectionLabel.docs-hub.docs-hub-changelog',
  'docs-hub/docs-hub-community': 'designIndex.build.sectionLabel.docs-hub.docs-hub-community',
  'restaurant/restaurant-reviews': 'designIndex.build.sectionLabel.restaurant.restaurant-reviews',
  'halcyon/events': 'designIndex.build.sectionLabel.halcyon.events',
  'halcyon/membership': 'designIndex.build.sectionLabel.halcyon.membership',
  'nonprofit/nonprofit-stories': 'designIndex.build.sectionLabel.nonprofit.nonprofit-stories',
  'nonprofit/nonprofit-events': 'designIndex.build.sectionLabel.nonprofit.nonprofit-events',
  'fervor/work': 'designIndex.build.sectionLabel.fervor.work',
  'wrenfield/trust': 'designIndex.build.sectionLabel.wrenfield.trust',
  'community/community-voices': 'designIndex.build.sectionLabel.community.community-voices',
};

function sectionLabel(family: string, section: AgencyFamilyOptionalSection, t: Translate): string {
  const key = SECTION_LABEL_KEYS[`${family}/${section.id}`];
  return key ? t(key) : section.label;
}

/** A family's optional sections as the keep/drop controls see them. */
type FamilySectionsState =
  | { status: 'idle' | 'loading' | 'failed'; sections: [] }
  | { status: 'ready'; sections: AgencyFamilyOptionalSection[]; outputScope?: AgencyOutputScope };

/**
 * Loads `family`'s optional sections whenever it changes (`null` loads nothing). A failed request
 * is `failed`, with `retry` to ask again — never an empty list, which means "no optional sections".
 */
function useFamilySections(family: string | null): FamilySectionsState & { retry: () => void } {
  const [state, setState] = useState<FamilySectionsState>({ status: 'idle', sections: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!family) {
      setState({ status: 'idle', sections: [] });
      return;
    }
    let live = true;
    setState({ status: 'loading', sections: [] });
    void fetchAgencyFamilySections(family).then((result) => {
      if (!live) return;
      setState(result.ok
        ? { status: 'ready', sections: result.sections, ...(result.outputScope ? { outputScope: result.outputScope } : {}) }
        : { status: 'failed', sections: [] });
    });
    return () => {
      live = false;
    };
  }, [family, attempt]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { ...state, retry };
}

/** A family's effect placements as the Effects block sees them — same shape as the sections. */
type FamilyEffectsState =
  | { status: 'idle' | 'loading' | 'failed'; offer: null }
  | { status: 'ready'; offer: AgencyFamilyEffectsResponse };

/**
 * Loads `family`'s effect placements (`GET /api/agency/families/:family/effects`) whenever it
 * changes (`null` loads nothing). A failed request is `failed`, with `retry` — never an empty
 * offer, which means "this family offers no placements".
 */
function useFamilyEffects(family: string | null): FamilyEffectsState & { retry: () => void } {
  const [state, setState] = useState<FamilyEffectsState>({ status: 'idle', offer: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!family) {
      setState({ status: 'idle', offer: null });
      return;
    }
    let live = true;
    setState({ status: 'loading', offer: null });
    void fetchAgencyFamilyEffects(family).then((result) => {
      if (!live) return;
      setState(result.ok ? { status: 'ready', offer: result.offer } : { status: 'failed', offer: null });
    });
    return () => {
      live = false;
    };
  }, [family, attempt]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { ...state, retry };
}

/** The Effects block's mode: `auto` (the default: Jev picks per placement) or `off`. */
type EffectsMode = 'auto' | 'off';

/**
 * The request's `effects` from the Effects block: `off`, or the explicit per-placement picks (only
 * placements the family still offers), or nothing at all — `auto` with no pick is the daemon's own
 * default, sent as no field, exactly like a section with no keep/drop hint.
 */
function effectsRequestOf(
  mode: EffectsMode,
  picks: Partial<Record<AgencyEffectPlacementId, string>>,
  offer: AgencyFamilyEffectsResponse | null,
): AgencyEffectsInput | undefined {
  if (mode === 'off') return 'off';
  if (!offer) return undefined;
  const hints: Record<string, string> = {};
  for (const entry of offer.placements) {
    const pick = picks[entry.placement];
    if (pick && (pick === 'none' || entry.allow.some((component) => component.id === pick))) hints[entry.placement] = pick;
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

/** `GET /api/sections`'s picker state: `idle` before a spine is known, `loading` while the fetch
 * is in flight, `failed` on any transport/parse error (mirrors `FamilySectionsState`), `ready`
 * with the merged, spine-filtered entries and the five design directions. */
type SectionCatalogState =
  | { status: 'idle' | 'loading' | 'failed'; entries: []; directions: [] }
  | { status: 'ready'; entries: SectionCatalogEntry[]; directions: SectionCatalogDirectionOption[] };

/** Loads the selectable section catalog for `spine` (a `SectionCatalogSpineCode`, or `null` before
 * a brief has routed) whenever it changes — the same shape `useFamilySections` uses for the
 * family's own optional sections, kept separate because this is a different catalog entirely
 * (design decision §1/§2: HyperUI/family/MotionSites sections, not a family's own keep/drop). */
function useSectionCatalog(spine: SectionCatalogSpineCode | null): SectionCatalogState & { retry: () => void } {
  const [state, setState] = useState<SectionCatalogState>({ status: 'idle', entries: [], directions: [] });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!spine) {
      setState({ status: 'idle', entries: [], directions: [] });
      return;
    }
    let live = true;
    setState({ status: 'loading', entries: [], directions: [] });
    void fetchSections({ spine }).then((result) => {
      if (!live) return;
      setState(result.ok
        ? { status: 'ready', entries: result.entries, directions: result.directions }
        : { status: 'failed', entries: [], directions: [] });
    });
    return () => {
      live = false;
    };
  }, [spine, attempt]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { ...state, retry };
}

/**
 * `build.verify` (the deferred verdict) names how many slots are flagged, but not how many were
 * checked — that lives only on the `verify` progress event that reported it. The last one in
 * `events` is this build's own count, whatever the current verdict; a `'cancelled'`/`'jev-*'`
 * skip also reports through this same event's `reason`, since the daemon sends no other line
 * saying why the check did not run. See `AgencyBuildEvent.reason` and `AgencyBuildVerifyVerdict`.
 */
function lastVerifyEventOf(events: AgencyBuildEvent[]): AgencyBuildEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === 'verify') return event;
  }
  return undefined;
}

/**
 * The verdict line under a `verify: 'after'` build's progress — absent for every other verify
 * mode, since only `after` carries a `build.verify` at all. `repairResult`, once set, takes over
 * from the ordinary pending/clean/flagged reading: it is the one message that names how many a
 * repair actually fixed, which `build.verify.flagged` alone (now just `remaining`) cannot say.
 */
function buildVerdictText(
  build: AgencyBuildSnapshot | null,
  events: AgencyBuildEvent[],
  repairResult: AgencyBuildRepairResponse | null,
  t: Translate,
): string | null {
  if (repairResult) {
    return t('designIndex.build.repaired', {
      repaired: repairResult.repaired.length,
      remaining: repairResult.remaining.length,
    });
  }
  const verify = build?.verify;
  if (!verify) return null;
  if (verify.status === 'pending') return t('designIndex.build.verdict.pending');
  const lastVerify = lastVerifyEventOf(events);
  if (verify.status === 'skipped') {
    return t('designIndex.build.verdict.skipped', { reason: lastVerify?.reason ?? '' });
  }
  const checked = lastVerify?.counts?.checked ?? 0;
  // Sample-data (x-mock) slots the check skipped. The contract requires the count; a build
  // persisted before it existed has none, which is "not reported", never a silent 0.
  const illustrative: unknown = lastVerify?.counts ? (lastVerify.counts as { illustrative?: unknown }).illustrative : undefined;
  const suffix = typeof illustrative !== 'number'
    ? lastVerify?.counts ? ` · ${t('designIndex.build.event.illustrativeNotReported')}` : ''
    : illustrative > 0 ? ` · ${t('designIndex.build.event.illustrative', { count: illustrative })}` : '';
  if (verify.flagged.length === 0) return t('designIndex.build.verdict.clean', { checked }) + suffix;
  return t('designIndex.build.verdict.flagged', { flagged: verify.flagged.length, checked }) + suffix;
}

interface Props {
  /**
   * Whether this view is the one on screen. `EntryShell` keeps every entry
   * view mounted, so without the flag the taxonomy and the first list would
   * load on every Home launch for a tab nobody opened.
   */
  isActive?: boolean;
  /**
   * Opens Settings on the `media` section, where `JevKeyCard` renders — the
   * only section this view ever needs. Wired up by `EntryShell`. Without it,
   * a 503's "Open Settings" button does not render — never an inert one.
   */
  onOpenSettings?: (section: 'media') => void;
  /**
   * Opens the project a finished build published, the way every other view
   * opens one. Wired up by `EntryShell`. Without it the "Open project" link
   * does not render — the same rule the Settings button follows.
   */
  onOpenProject?: (projectId: string) => void;
}

export function DesignIndexView({ isActive = true, onOpenSettings, onOpenProject }: Props) {
  const t = useT();
  const [panel, setPanel] = useState<Panel>('search');
  const [taxonomy, setTaxonomy] = useState<DesignTaxonomy | null>(null);
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);

  // Search panel.
  const [lists, setLists] = useState<Record<ListKey, string[]>>(emptyLists);
  const [scalars, setScalars] = useState<Partial<Record<ScalarFacetKey, string>>>({});
  const [text, setText] = useState('');
  const [minText, setMinText] = useState(String(DESIGN_INDEX_DEFAULT_MIN));
  const [found, setFound] = useState<DesignIndexFindResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Profile panel. The five inputs live in one object so a result can be tied
  // to the exact inputs that produced it (see `profileFormRef`).
  const [profileForm, setProfileForm] = useState<ProfileForm>(emptyProfileForm);
  const [profile, setProfile] = useState<DesignProfile | null>(null);
  const [profiling, setProfiling] = useState(false);
  const [profileError, setProfileError] = useState<JevFailure | null>(null);
  const [adding, setAdding] = useState(false);
  const [addNotice, setAddNotice] = useState<string | null>(null);

  // Route panel.
  const [brief, setBrief] = useState('');
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<JevFailure | null>(null);

  // Build, started from a routed decision. Nothing here runs on its own: a build spends model
  // credit and writes a project, so it waits for the button exactly as routing does.
  const [build, setBuild] = useState<AgencyBuildSnapshot | null>(null);
  const [buildError, setBuildError] = useState<JevFailure | null>(null);
  const [verifyMode, setVerifyMode] = useState<VerifyMode>('strict');
  const [composition, setComposition] = useState<AgencyBuildComposition>('family');
  // The routed family's optional sections, and the person's keep/drop choice for each. A section
  // with no entry is Jev's call; only explicit choices travel as the request's `sections`.
  const [sectionHints, setSectionHints] = useState<Record<string, SectionHint>>({});
  const routedFamily = decision?.decision === 'routed' && decision.family ? decision.family.id : null;
  const familySections = useFamilySections(routedFamily);
  const referenceSections = familySections.sections.filter(section => sectionHints[section.id] === 'keep').map(section => ({ id: section.id, name: section.label, purpose: section.type }));
  const referenceExcludedSections = [...new Set(familySections.sections.filter(section => sectionHints[section.id] === 'drop').flatMap(section => [section.label, section.type]))];
  // A new routed family brings its own optional sections; the previous family's choices go.
  useEffect(() => {
    setSectionHints({});
  }, [routedFamily]);
  // Effects (Sol ruling 2026-09-25): Auto (the default) or Off, and — once the routed family's
  // placements are known — an explicit component (or none) per placement. A placement with no pick
  // stays Jev's call. Cleared on a new routed family, like the section hints.
  const [effectsMode, setEffectsMode] = useState<EffectsMode>('auto');
  const [effectPicks, setEffectPicks] = useState<Partial<Record<AgencyEffectPlacementId, string>>>({});
  const familyEffects = useFamilyEffects(routedFamily);
  useEffect(() => {
    setEffectsMode('auto');
    setEffectPicks({});
  }, [routedFamily]);
  // The selectable section overlay (design decision §1/§2/§3): one extra section — from HyperUI,
  // a family's own reference sections, MotionSites, or the local-corpus prompts — placed on top
  // of the routed family's fixed recipe. `entryId` null means "no overlay"; the rest only matter
  // once one is chosen. Cleared alongside `sectionHints` on a new routed family, since the
  // catalog is spine-filtered and a placement id is family-specific either way.
  const [sectionSelectionEntryId, setSectionSelectionEntryId] = useState<string | null>(null);
  const [placementMode, setPlacementMode] = useState<'append' | 'replace-optional'>('append');
  const [placementSectionId, setPlacementSectionId] = useState('');
  const [directionId, setDirectionId] = useState('');
  /** A `SectionCatalogEntry.id` (`motionsites-prompt:…`/`zerosum-kit:…`) for untrusted design
   * guidance — independent of `sectionSelectionEntryId`'s own catalog id, since a reference
   * describes layout/typography/motion cues, not a section to insert. Empty means none. */
  const [designReferenceId, setDesignReferenceId] = useState('');
  const routedSpine = decision?.decision === 'routed' ? (decision.spine.code as SectionCatalogSpineCode) : null;
  const sectionCatalog = useSectionCatalog(routedSpine);
  useEffect(() => {
    setSectionSelectionEntryId(null);
    setPlacementMode('append');
    setPlacementSectionId('');
    setDirectionId('');
    setDesignReferenceId('');
  }, [routedFamily]);
  const [starting, setStarting] = useState(false);
  // The repair pass for a `verify: 'after'` build whose deferred check flagged something.
  // `repairResult` is what the verdict shows once a repair completes — see `buildVerdictText` —
  // and is cleared whenever the build it belongs to is, the same as every other build-scoped
  // state here.
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState<AgencyBuildRepairResponse | null>(null);
  const [repairError, setRepairError] = useState<JevFailure | null>(null);
  // The builds this daemon still remembers (survives a restart), and "start from this build".
  const [recentBuilds, setRecentBuilds] = useState<AgencyBuildListItem[]>([]);
  const [forkingId, setForkingId] = useState<string | null>(null);
  const [forkError, setForkError] = useState<JevFailure | null>(null);
  /** The one open build stream (`GET .../:id/agui`) and what it has said so far. The hook closes
   * it on unmount; a new build or a new brief closes it through `reset`. */
  const buildStream = useAgencyBuildAgui();
  const { reset: resetBuildStream, close: closeBuildStream, follow: followBuildStream } = buildStream;
  // The recent build whose section controls are open, and the choices made there. Prefilled from
  // that build's own saved hints; only choices that differ from them travel with the fork.
  const [forkSectionsId, setForkSectionsId] = useState<string | null>(null);
  const [forkChoices, setForkChoices] = useState<Record<string, SectionChoice>>({});
  const forkSectionsFamily = recentBuilds.find((entry) => entry.id === forkSectionsId)?.family ?? null;
  const forkFamilySections = useFamilySections(forkSectionsFamily);
  /**
   * The id of whatever build `attachBuild` currently points the panel at — a plain ref, not
   * `build?.id`, because `runRepair`'s two awaits need to read it as it stands the moment each
   * one resolves, not as it stood at the call that started them. A repair started on build A must
   * never land on build B's state just because the user pressed Run again before it settled: both
   * `repairAgencyBuild` and the `fetchAgencyBuild` refresh that follows it check this ref after
   * every await and bail out the instant it no longer names the build the repair belongs to.
   */
  const attachedBuildIdRef = useRef<string | null>(null);
  /**
   * Whether this view is still mounted. A build POST outlives a navigation, and what happens when
   * it lands has to differ: a stream opened after the cleanup ran would never be closed again and
   * would reconnect for as long as the tab is open.
   */
  const mountedRef = useRef(true);
  /**
   * Guards the Build button against a second click in the same tick. `starting` cannot: React
   * paints the disabled attribute a tick later, and by then the second POST has already gone —
   * answering 409 while the daemon runs the first build and the panel has thrown away its stream.
   */
  const buildStartingRef = useRef(false);

  // A Jev profile takes about twenty seconds, a route about half a second —
  // long enough for the visible input to have moved on before the answer
  // lands. A result that no longer belongs to what is on screen must not be
  // shown, and must never be the thing "Add to index" stores. These refs carry
  // the live input values into the async continuations, which would otherwise
  // close over the values as they were at submit time. Every edit also clears
  // the result it invalidates, so the panels are guarded twice: the edit drops
  // a settled result, and the snapshot check drops an in-flight one.
  const profileFormRef = useRef(profileForm);
  const briefRef = useRef(brief);

  function updateProfileForm(patch: Partial<ProfileForm>) {
    const next = { ...profileFormRef.current, ...patch };
    profileFormRef.current = next;
    setProfileForm(next);
    setProfile(null);
    setProfileError(null);
    setAddNotice(null);
  }

  // A build belongs to the brief that produced it, so an edit drops it the way it drops the
  // decision — and closes the stream, which would otherwise keep reconnecting to a build the
  // panel no longer shows.
  function clearBuild() {
    resetBuildStream();
    attachedBuildIdRef.current = null;
    setBuild(null);
    setBuildError(null);
    setRepairing(false);
    setRepairResult(null);
    setRepairError(null);
  }

  /** Re-reads the persisted build history. Safe to call as often as needed — it is a plain GET,
   * never a Jev or model call. */
  const refreshRecentBuilds = useCallback(async () => {
    const list = await listAgencyBuilds();
    if (!mountedRef.current) return;
    setRecentBuilds(list);
  }, []);

  /**
   * Points the panel at `snapshot` and follows it to its end — what a routed Build press and a
   * "Start from this build" press both end in, once each has its own way of getting a queued
   * snapshot. The following itself (the replay/live handling, the terminal-status read on a stale
   * view, the re-attach on a dropped stream) is `useAgencyBuildAgui().follow`, shared with Home's
   * "Build with Jev" card, so both surfaces stay with a running build the same way.
   */
  function attachBuild(snapshot: AgencyBuildSnapshot) {
    clearBuild();
    attachedBuildIdRef.current = snapshot.id;
    setBuild(snapshot);
    followBuildStream(snapshot, {
      isCurrent: () => mountedRef.current && attachedBuildIdRef.current === snapshot.id,
      onSettled: setBuild,
      onProgress: setBuild,
      onLost: () => setBuildError({ message: t('designIndex.error.request'), jevUnavailable: false }),
    });
  }

  function updateBrief(value: string) {
    briefRef.current = value;
    setBrief(value);
    setDecision(null);
    setRouteError(null);
    clearBuild();
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closeBuildStream();
    };
  }, [closeBuildStream]);

  // The Profile panel locks while either of its two requests is in flight: an
  // edit during the add would clear the profile being stored.
  const profileBusy = profiling || adding;

  const searchQuery = useMemo(() => {
    const params = new URLSearchParams();
    for (const key of DESIGN_INDEX_QUERY_LIST_KEYS) {
      for (const value of lists[key]) params.append(key, value);
    }
    for (const key of DESIGN_INDEX_QUERY_SCALAR_KEYS) {
      if (key === 'text') {
        if (text.trim()) params.append('text', text.trim());
        continue;
      }
      const value = (scalars as Record<string, string | undefined>)[key];
      if (value) params.append(key, value);
    }
    params.append('min', minText.trim() || String(DESIGN_INDEX_DEFAULT_MIN));
    params.append('limit', String(DESIGN_INDEX_DEFAULT_LIMIT));
    return params.toString();
  }, [lists, scalars, text, minText]);

  const runSearch = useCallback(async (query: string) => {
    setSearching(true);
    setSearchError(null);
    try {
      const resp = await fetch(`/api/design-index?${query}`);
      if (!resp.ok) {
        setSearchError(t('designIndex.searchFailed'));
        return;
      }
      setFound((await resp.json()) as DesignIndexFindResponse);
    } catch {
      setSearchError(t('designIndex.searchFailed'));
    } finally {
      setSearching(false);
    }
  }, [t]);

  const loadTaxonomy = useCallback(async () => {
    try {
      const resp = await fetch('/api/design-index/taxonomy');
      if (!resp.ok) {
        setTaxonomyError(t('designIndex.taxonomyFailed'));
        return;
      }
      const json = (await resp.json()) as DesignIndexTaxonomyResponse;
      setTaxonomy(json.taxonomy);
    } catch {
      setTaxonomyError(t('designIndex.taxonomyFailed'));
    }
  }, [t]);

  // The taxonomy, the first unfiltered list and the build history are the only reads on open —
  // none of them touch Jev or the model.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (!isActive || bootedRef.current) return;
    bootedRef.current = true;
    void loadTaxonomy();
    void runSearch(searchQuery);
    void refreshRecentBuilds();
  }, [isActive, loadTaxonomy, runSearch, searchQuery, refreshRecentBuilds]);

  // A build the panel is watching just ended: the history it just joined is worth re-reading, so
  // a build started elsewhere (the CLI, another tab) shows up here without a manual reload too.
  useEffect(() => {
    if (build && BUILD_TERMINAL.includes(build.status)) void refreshRecentBuilds();
  }, [build, refreshRecentBuilds]);

  function setScalarFacet(key: ScalarFacetKey, value: string) {
    setScalars((current) => ({ ...current, [key]: value }));
  }

  /**
   * Picking a spine drops an archetype that belongs to another one: the two
   * filters are ANDed, so the stale pair would silently match nothing.
   */
  function pickSpine(value: string) {
    setScalars((current) => {
      const next = { ...current, spine: value };
      const allowed = atlasArchetypeOptions(value || null).map((archetype) => archetype.id);
      if (next.archetype && !allowed.includes(next.archetype)) next.archetype = '';
      return next;
    });
  }

  function addListValue(key: ListKey, value: string) {
    if (!value) return;
    setLists((current) => (
      current[key].includes(value)
        ? current
        : { ...current, [key]: [...current[key], value] }
    ));
  }

  function removeListValue(key: ListKey, value: string) {
    setLists((current) => ({ ...current, [key]: current[key].filter((item) => item !== value) }));
  }

  /**
   * Drops every facet and the free text, keeps the probability floor, and re-runs the search
   * with the query those cleared filters produce (the same shape `searchQuery` builds).
   */
  function clearFilters() {
    setLists(emptyLists());
    setScalars({});
    setText('');
    const params = new URLSearchParams();
    params.append('min', minText.trim() || String(DESIGN_INDEX_DEFAULT_MIN));
    params.append('limit', String(DESIGN_INDEX_DEFAULT_LIMIT));
    void runSearch(params.toString());
  }

  // A facet the panel is already filtering by is doing real work no matter how it now scores, so
  // it never collapses.
  const setFacetKeys = useMemo(() => {
    const set = new Set<FacetKey>();
    for (const key of DESIGN_INDEX_QUERY_LIST_KEYS) if (lists[key].length > 0) set.add(key);
    for (const key of (['spine', 'archetype', 'family'] as const)) if (scalars[key]) set.add(key);
    for (const axis of DESIGN_STYLE_AXES) if (scalars[axis]) set.add(axis);
    return set;
  }, [lists, scalars]);

  // Which facets are dominated enough by one bucket, over the profiles the Search panel has
  // loaded, to hide behind "More filters" by default (design contract §7, move 6).
  const collapsedFacets = useMemo(
    () => collapsedFacetKeys(ALL_FACET_KEYS, found?.profiles ?? [], setFacetKeys),
    [found, setFacetKeys],
  );

  async function removeProfile(digest: string) {
    try {
      const resp = await fetch(`/api/design-index/${encodeURIComponent(digest)}`, {
        method: 'DELETE',
      });
      if (!resp.ok) {
        setSearchError(t('designIndex.removeFailed'));
        return;
      }
    } catch {
      setSearchError(t('designIndex.removeFailed'));
      return;
    }
    // Home shows the same profiles as reference cards; tell it the index moved.
    notifyDesignIndexChanged();
    await runSearch(searchQuery);
  }

  async function runProfile() {
    // The inputs as they are at the press. Anything this request produces is
    // only valid while the panel still shows them.
    const snapshot = profileFormRef.current;
    const stale = () => !sameProfileForm(profileFormRef.current, snapshot);
    setProfiling(true);
    setProfileError(null);
    setAddNotice(null);
    const body: DesignIndexProfileRequest = {
      kind: snapshot.kind,
      input: snapshot.input,
      ...(snapshot.title.trim() ? { title: snapshot.title.trim() } : {}),
      ...(snapshot.ref.trim() ? { ref: snapshot.ref.trim() } : {}),
      ...(snapshot.id.trim() ? { id: snapshot.id.trim() } : {}),
      add: false,
    };
    try {
      const resp = await fetch('/api/design-index/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (stale()) return;
      if (!resp.ok) {
        setProfileError(
          jevFailure(resp.status, t('designIndex.error.profileFailed'), t),
        );
        return;
      }
      const json = (await resp.json()) as DesignIndexProfileResponse;
      if (stale()) return;
      setProfile(json.profile);
    } catch {
      if (stale()) return;
      setProfileError({ message: t('designIndex.error.request'), jevUnavailable: false });
    } finally {
      setProfiling(false);
    }
  }

  async function addProfile() {
    if (!profile) return;
    setAdding(true);
    setAddNotice(null);
    try {
      const resp = await fetch('/api/design-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      if (!resp.ok) {
        setAddNotice(t('designIndex.profile.addFailed'));
        return;
      }
      const json = (await resp.json()) as DesignIndexAddResponse;
      setAddNotice(
        json.added ? t('designIndex.profile.added') : t('designIndex.profile.duplicate'),
      );
      // A duplicate stored nothing, so only a real add moves Home's cards.
      if (json.added) notifyDesignIndexChanged();
    } catch {
      setAddNotice(t('designIndex.profile.addFailed'));
    } finally {
      setAdding(false);
    }
  }

  async function runRoute() {
    const snapshot = briefRef.current;
    const stale = () => briefRef.current !== snapshot;
    // A new decision replaces the one the previous build was made from, so that build's result —
    // and its stream — go with it. Re-routing the same brief takes this path without an edit, so
    // `updateBrief`'s own clear is not enough.
    clearBuild();
    setRouting(true);
    setRouteError(null);
    try {
      const resp = await fetch('/api/agency/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: snapshot }),
      });
      if (stale()) return;
      if (!resp.ok) {
        setRouteError(jevFailure(resp.status, t('designIndex.error.routeFailed'), t));
        return;
      }
      const json = (await resp.json()) as AgencyRouteResponse;
      if (stale()) return;
      setDecision(json.decision);
    } catch {
      if (stale()) return;
      setRouteError({ message: t('designIndex.error.request'), jevUnavailable: false });
    } finally {
      setRouting(false);
    }
  }

  async function runBuild(family: string) {
    // Synchronous, before the first `await`: two clicks in one tick must produce one build.
    if (buildStartingRef.current) return;
    buildStartingRef.current = true;
    // The previous result stays on screen until this build is actually under way. Clearing first
    // would blank the panel and then, on a 409, leave nothing but the error — while the daemon
    // carries on running the build whose stream was just thrown away.
    setStarting(true);
    const hints = Object.fromEntries(
      familySections.sections.flatMap((section) => (sectionHints[section.id] ? [[section.id, sectionHints[section.id]!]] : [])),
    ) as Record<string, SectionHint>;
    // A picked entry needs BOTH a placement anchor and a direction to be a valid selection; the
    // picker's own "start build" gate keeps these in step (`sectionPickerReady` below), but the
    // request is built defensively either way — an incomplete pick simply sends no `sectionSelection`
    // rather than an ambiguous half-one.
    // A composed build (`blocks`/`auto`) is already made of selected sections and only runs
    // strict: the daemon refuses it with a `sectionSelection` or any other verify mode.
    const composed = isComposed(composition);
    const selection = !composed && sectionSelectionEntryId && placementSectionId.trim() && directionId
      ? {
        entryId: sectionSelectionEntryId,
        placement: placementMode === 'append'
          ? { mode: 'append' as const, afterSectionId: placementSectionId.trim() }
          : { mode: 'replace-optional' as const, targetSectionId: placementSectionId.trim() },
        directionId,
      }
      : undefined;
    // A composed page has no effect placements, so a composed build sends no effect picks. It also
    // sends `family: 'auto'`: a named family would make `auto` record `family-named` and never try
    // blocks, and the family route a `blocks` build falls back to is then routed like Home's.
    const effects = composed ? undefined : effectsRequestOf(effectsMode, effectPicks, familyEffects.status === 'ready' ? familyEffects.offer : null);
    const started = await startAgencyBuild({
      brief: briefRef.current,
      family: composed ? 'auto' : family,
      verify: composed ? 'strict' : verifyMode,
      ...(composed ? { composition } : {}),
      ...(effects !== undefined ? { effects } : {}),
      ...(Object.keys(hints).length > 0 ? { sections: hints } : {}),
      ...(selection ? { sectionSelection: selection } : {}),
      ...(selection && designReferenceId.trim() ? { designReferenceId: designReferenceId.trim() } : {}),
    });
    buildStartingRef.current = false;
    // Gone while the POST was in flight. Do not open a stream the cleanup can no longer close.
    if (!mountedRef.current) return;
    setStarting(false);
    if (!started.ok) {
      // A missing Jev key is the one failure a Settings trip fixes, and it is the structured
      // code that says so — never the daemon's English sentence.
      if (started.code === 'JEV_UNAVAILABLE') {
        setBuildError({ message: t('designIndex.error.jevUnavailable'), jevUnavailable: true });
      } else if (started.code === 'BUILD_BUSY') {
        setBuildError({ message: t('designIndex.build.busy'), jevUnavailable: false });
      } else if (started.code === 'MOTIONSITES_LOGIN_REQUIRED') {
        setBuildError({ message: t('designIndex.build.section.reference.loginRequired'), jevUnavailable: false });
      } else if (started.code === 'MOTIONSITES_PAID_ACCESS_REQUIRED') {
        setBuildError({ message: t('designIndex.build.section.reference.paidAccessRequired'), jevUnavailable: false });
      } else {
        setBuildError({ message: t('designIndex.build.startFailed'), jevUnavailable: false });
      }
      return;
    }
    attachBuild(started.build);
  }

  /**
   * "Start from this build": the same family, brief and options as a saved build, publishing to a
   * NEW project. `buildId` is one of `recentBuilds` — the button that calls this only renders for
   * an entry the daemon has already said is forkable, but the daemon re-checks regardless (a
   * build's forkability cannot change while this list is stale, but the check is free either way).
   */
  /**
   * The fork's `sections`: the open controls' choices that differ from the saved build's own
   * hints — `auto` where a saved hint is reset to "Let Jev decide". Nothing for a build whose
   * controls are not open (the fork then reuses the saved hints as they are).
   */
  function forkSectionOverride(buildId: string): Record<string, SectionChoice> | undefined {
    if (forkSectionsId !== buildId || forkFamilySections.status !== 'ready') return undefined;
    const saved = recentBuilds.find((entry) => entry.id === buildId)?.sections ?? {};
    const override: Record<string, SectionChoice> = {};
    for (const section of forkFamilySections.sections) {
      const choice = forkChoices[section.id];
      if (choice !== undefined && choice !== (saved[section.id] ?? 'auto')) override[section.id] = choice;
    }
    return Object.keys(override).length > 0 ? override : undefined;
  }

  async function startFromBuild(buildId: string) {
    if (buildStartingRef.current) return;
    buildStartingRef.current = true;
    setForkingId(buildId);
    setForkError(null);
    const result = await forkAgencyBuild(buildId, { sections: forkSectionOverride(buildId) });
    buildStartingRef.current = false;
    if (!mountedRef.current) return;
    setForkingId(null);
    if (!result.ok) {
      if (result.code === 'JEV_UNAVAILABLE') {
        setForkError({ message: t('designIndex.error.jevUnavailable'), jevUnavailable: true });
      } else if (result.code === 'BUILD_BUSY') {
        setForkError({ message: t('designIndex.build.busy'), jevUnavailable: false });
      } else if (result.code === 'BUILD_NOT_FORKABLE') {
        setForkError({ message: t('designIndex.build.recent.notForkable'), jevUnavailable: false });
      } else if (result.code === 'MOTIONSITES_LOGIN_REQUIRED') {
        setForkError({ message: t('designIndex.build.section.reference.loginRequired'), jevUnavailable: false });
      } else if (result.code === 'MOTIONSITES_PAID_ACCESS_REQUIRED') {
        setForkError({ message: t('designIndex.build.section.reference.paidAccessRequired'), jevUnavailable: false });
      } else {
        setForkError({ message: t('designIndex.build.startFailed'), jevUnavailable: false });
      }
      return;
    }
    // Same hand-off a routed Build press makes: the panel now watches the new build.
    attachBuild(result.build);
  }

  /**
   * The repair pass for the attached build's own deferred verdict — `POST .../:id/repair` takes
   * no body, since what to repair is always the build's own `verify.flagged`, never a caller
   * choice. Synchronous on the daemon's side, so its answer is the outcome: `repairResult` is
   * what the verdict block reads afterwards, and the one extra read (`fetchAgencyBuild`) is what
   * brings `build.verify.flagged` down to `remaining` so the flagged list matches it.
   */
  async function runRepair() {
    if (!build) return;
    // Pinned once, not re-read from `build` after either await: the closure variable is what
    // this repair is FOR, and `attachedBuildIdRef` is what the panel is showing NOW — the two
    // are allowed to diverge the moment a second Run press attaches a new build mid-repair, and
    // every check below stops this repair from writing over that new build's state.
    const buildId = build.id;
    const stale = () => !mountedRef.current || attachedBuildIdRef.current !== buildId;
    setRepairing(true);
    setRepairError(null);
    try {
      const result = await repairAgencyBuild(buildId);
      if (stale()) return;
      setRepairResult(result);
      const latest = await fetchAgencyBuild(buildId);
      if (stale()) return;
      if (latest) setBuild(latest);
    } catch (err) {
      if (stale()) return;
      if (err instanceof AgencyBuildRepairError && err.code === 'BUILD_REPAIR_IN_PROGRESS') {
        setRepairError({ message: t('designIndex.build.error.repairInProgress'), jevUnavailable: false });
      } else if (err instanceof AgencyBuildRepairError && err.code === 'BUILD_NOT_REPAIRABLE') {
        setRepairError({
          message: t('designIndex.build.error.notRepairable', { message: err.message }),
          jevUnavailable: false,
        });
      } else if (err instanceof AgencyBuildRepairError && err.code === 'JEV_UNAVAILABLE') {
        setRepairError({ message: t('designIndex.error.jevUnavailable'), jevUnavailable: true });
      } else {
        setRepairError({ message: t('designIndex.error.request'), jevUnavailable: false });
      }
    } finally {
      // A build attached after this repair started already reset `repairing` to `false` itself
      // (via `attachBuild`'s `clearBuild`) and may since have started its OWN repair — `stale()`
      // stops this `finally` from clobbering that unrelated `true` back to `false`.
      if (!stale()) setRepairing(false);
    }
  }

  /**
   * One facet's label and control, whichever kind it is. `renderFacet` is called once per key in
   * `ALL_FACET_KEYS`, split between the always-visible group and the "More filters" disclosure by
   * `collapsedFacets` — the control itself does not know which group it landed in.
   */
  function renderFacet(key: FacetKey) {
    if (isListFacetKey(key)) {
      return (
        <label key={key} className={styles.facet}>
          <span className={styles.facetLabel}>{t(`designIndex.facet.${key}`)}</span>
          <select
            className={styles.select}
            value=""
            onChange={(event) => addListValue(key, event.target.value)}
            data-testid={`design-index-facet-${key}`}
          >
            <option value="">{t('designIndex.facet.any')}</option>
            {(taxonomy ? LIST_FACET_SOURCE[key](taxonomy) : []).map((label) => (
              <option key={label.id} value={label.id}>{label.id}</option>
            ))}
          </select>
          {lists[key].length > 0 ? (
            <span className={styles.chips}>
              {lists[key].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={styles.chip}
                  aria-label={t('designIndex.facet.drop', { value })}
                  onClick={() => removeListValue(key, value)}
                >
                  {value}
                </button>
              ))}
            </span>
          ) : null}
        </label>
      );
    }

    if (key === 'spine') {
      return (
        <label key={key} className={styles.facet}>
          <span className={styles.facetLabel}>{t('designIndex.facet.spine')}</span>
          <select
            className={styles.select}
            value={scalars.spine ?? ''}
            onChange={(event) => pickSpine(event.target.value)}
            data-testid="design-index-facet-spine"
          >
            <option value="">{t('designIndex.facet.any')}</option>
            {atlasSpineOptions().map((spine) => (
              <option key={spine.code} value={spine.code}>
                {spine.code} · {spine.name}
              </option>
            ))}
          </select>
        </label>
      );
    }

    if (key === 'archetype') {
      return (
        <label key={key} className={styles.facet}>
          <span className={styles.facetLabel}>{t('designIndex.facet.archetype')}</span>
          <select
            className={styles.select}
            value={scalars.archetype ?? ''}
            onChange={(event) => setScalarFacet('archetype', event.target.value)}
            data-testid="design-index-facet-archetype"
          >
            <option value="">{t('designIndex.facet.any')}</option>
            {atlasArchetypeOptions(scalars.spine ?? null).map((archetype) => (
              <option key={archetype.id} value={archetype.id}>
                {archetype.id} · {archetype.name}
              </option>
            ))}
          </select>
        </label>
      );
    }

    if (key === 'family') {
      return (
        <label key={key} className={styles.facet}>
          <span className={styles.facetLabel}>{t('designIndex.facet.family')}</span>
          <select
            className={styles.select}
            value={scalars.family ?? ''}
            onChange={(event) => setScalarFacet('family', event.target.value)}
            data-testid="design-index-facet-family"
          >
            <option value="">{t('designIndex.facet.any')}</option>
            {registryFamilyIds().map((family) => (
              <option key={family} value={family}>{family}</option>
            ))}
          </select>
        </label>
      );
    }

    return (
      <label key={key} className={styles.facet}>
        <span className={styles.facetLabel}>{t(`designIndex.facet.${key}`)}</span>
        <select
          className={styles.select}
          value={scalars[key] ?? ''}
          onChange={(event) => setScalarFacet(key, event.target.value)}
          data-testid={`design-index-facet-${key}`}
        >
          <option value="">{t('designIndex.facet.any')}</option>
          {(taxonomy ? taxonomy.style[key] : []).map((label) => (
            <option key={label.id} value={label.id}>{label.id}</option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <section className={styles.root} aria-labelledby="design-index-title" data-testid="design-index-view">
      <header className={styles.hero}>
        <h1 id="design-index-title" className={styles.title}>{t('designIndex.title')}</h1>
        <p className={styles.lede}>{t('designIndex.lede')}</p>
      </header>

      {/* The panel switch is the segmented track; the shared indicator glides the thumb. */}
      <SelectionGroup>
        <div className={styles.panels} role="tablist" aria-label={t('designIndex.panelsAria')}>
          {PANELS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={panel === id}
              className={`${styles.panelTab}${panel === id ? ` ${styles.panelTabActive}` : ''}`}
              onClick={() => setPanel(id)}
              data-testid={`design-index-panel-${id}`}
            >
              <SelectionIndicator active={panel === id} />
              {id === 'search' ? t('designIndex.panelSearch') : null}
              {id === 'profile' ? t('designIndex.panelProfile') : null}
              {id === 'route' ? t('designIndex.panelRoute') : null}
            </button>
          ))}
        </div>
      </SelectionGroup>

      {taxonomyError ? <p className={styles.error} role="alert">{taxonomyError}</p> : null}

      {panel === 'search' ? (
        <div role="tabpanel" className={styles.panel} data-testid="design-index-search-panel">
          {/* One toolbar row: the free-text search, the probability floor, the panel's one
              primary action and the live count. The facets sit below in one filter card. */}
          <div className={styles.toolbar}>
            <label className={styles.searchField} data-ui-field-shell>
              <Icon name="search" size={14} className={styles.searchIcon} />
              <input
                className={styles.searchInput}
                type="search"
                value={text}
                aria-label={t('designIndex.facet.text')}
                placeholder={t('designIndex.facet.textPlaceholder')}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !searching) void runSearch(searchQuery);
                }}
                data-testid="design-index-facet-text"
              />
            </label>
            <label className={styles.minField}>
              <span className={styles.minLabel}>{t('designIndex.facet.min')}</span>
              <input
                className={styles.minInput}
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={minText}
                onChange={(event) => setMinText(event.target.value)}
                data-testid="design-index-facet-min"
              />
            </label>
            <Button
              variant="primary"
              disabled={searching}
              onClick={() => { void runSearch(searchQuery); }}
              data-testid="design-index-search"
            >
              {t('designIndex.searchRun')}
            </Button>
            {found ? (
              <span className={styles.count} data-testid="design-index-count">
                {t('designIndex.resultCount', { count: found.profiles.length, total: found.total })}
              </span>
            ) : null}
          </div>

          <div className={styles.filterCard}>
            <div className={styles.facets} aria-label={t('designIndex.facetsAria')} data-testid="design-index-facets">
              {ALL_FACET_KEYS.filter((key) => !collapsedFacets.has(key)).map((key) => renderFacet(key))}
            </div>

            {collapsedFacets.size > 0 ? (
              <details className={styles.moreFilters} data-testid="design-index-more-filters">
                <summary className={styles.moreFiltersSummary}>
                  <Icon name="chevron-down" size={14} className={styles.moreFiltersChevron} />
                  {t('designIndex.facet.moreFilters')}
                </summary>
                <div className={styles.facets}>
                  {ALL_FACET_KEYS.filter((key) => collapsedFacets.has(key)).map((key) => renderFacet(key))}
                </div>
              </details>
            ) : null}
          </div>

          {searchError ? <p className={styles.error} role="alert">{searchError}</p> : null}

          {found && found.profiles.length === 0 ? (
            <EmptyState
              className={styles.empty}
              icon={<Icon name={found.total === 0 ? 'layers-filled' : 'search'} size={20} />}
              title={found.total === 0 ? t('designIndex.emptyTitle') : t('designIndex.noMatches')}
              description={found.total === 0 ? t('designIndex.emptyBody') : undefined}
              action={found.total === 0 ? (
                <Button variant="secondary" onClick={() => setPanel('profile')} data-testid="design-index-empty-profile">
                  {t('designIndex.emptyAction')}
                </Button>
              ) : (
                <Button variant="secondary" onClick={clearFilters} data-testid="design-index-empty-clear">
                  {t('designIndex.clearFilters')}
                </Button>
              )}
            />
          ) : null}

          {found && found.profiles.length > 0 ? (
            <div className={styles.grid}>
              {found.profiles.map((item) => (
                <ProfileCard
                  key={item.source.digest}
                  profile={item}
                  t={t}
                  onRemove={() => { void removeProfile(item.source.digest); }}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {panel === 'profile' ? (
        <div role="tabpanel" className={styles.panel} data-testid="design-index-profile-panel">
          <div className={styles.facets}>
            <label className={styles.facet}>
              <span className={styles.facetLabel}>{t('designIndex.profile.kind')}</span>
              <select
                className={styles.select}
                value={profileForm.kind}
                disabled={profileBusy}
                onChange={(event) => updateProfileForm({
                  kind: event.target.value as DesignProfileSourceKind,
                })}
                data-testid="design-index-profile-kind"
              >
                {PROFILE_KINDS.map((value) => (
                  <option key={value} value={value}>{kindLabel(value, t)}</option>
                ))}
              </select>
            </label>
            <label className={styles.facet}>
              <span className={styles.facetLabel}>{t('designIndex.profile.titleField')}</span>
              <input
                className={styles.input}
                value={profileForm.title}
                disabled={profileBusy}
                onChange={(event) => updateProfileForm({ title: event.target.value })}
                data-testid="design-index-profile-title"
              />
            </label>
            <label className={styles.facet}>
              <span className={styles.facetLabel}>{t('designIndex.profile.ref')}</span>
              <input
                className={styles.input}
                value={profileForm.ref}
                disabled={profileBusy}
                onChange={(event) => updateProfileForm({ ref: event.target.value })}
                data-testid="design-index-profile-ref"
              />
            </label>
            <label className={styles.facet}>
              <span className={styles.facetLabel}>{t('designIndex.profile.id')}</span>
              <input
                className={styles.input}
                value={profileForm.id}
                disabled={profileBusy}
                onChange={(event) => updateProfileForm({ id: event.target.value })}
                data-testid="design-index-profile-id"
              />
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.facetLabel}>{t('designIndex.profile.input')}</span>
            <textarea
              className={styles.textarea}
              rows={10}
              value={profileForm.input}
              disabled={profileBusy}
              placeholder={t('designIndex.profile.inputPlaceholder')}
              onChange={(event) => updateProfileForm({ input: event.target.value })}
              data-testid="design-index-profile-input"
            />
          </label>

          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={profileBusy}
              onClick={() => { void runProfile(); }}
              data-testid="design-index-profile-run"
            >
              {t('designIndex.profile.run')}
            </Button>
            <Button
              variant="secondary"
              disabled={!profile || profileBusy}
              onClick={() => { void addProfile(); }}
              data-testid="design-index-profile-add"
            >
              {t('designIndex.profile.add')}
            </Button>
            {addNotice ? <span className={styles.count} data-testid="design-index-add-notice">{addNotice}</span> : null}
          </div>

          {profileError ? (
            <JevErrorNotice
              error={profileError}
              onOpenSettings={onOpenSettings}
              testId="design-index-profile-open-settings"
              t={t}
            />
          ) : null}

          {profile ? (
            <div className={styles.result}>
              <ProfileCard profile={profile} t={t} />
              <div className={styles.tables}>
                <LabelTable title={t('designIndex.label.sections')} labels={profile.sections} t={t} />
                <LabelTable title={t('designIndex.label.components')} labels={profile.components} t={t} />
                <LabelTable title={t('designIndex.label.mechanics')} labels={profile.mechanics} t={t} />
                <LabelTable title={t('designIndex.label.depth')} labels={profile.depth} t={t} />
                <div className={styles.table}>
                  <h3 className={styles.tableTitle}>{t('designIndex.label.style')}</h3>
                  <dl className={styles.rows}>
                    {DESIGN_STYLE_AXES.map((axis) => (
                      <div key={axis} className={styles.row}>
                        <dt className={styles.rowKey}>{t(`designIndex.facet.${axis}`)}</dt>
                        <dd className={styles.rowValue}>
                          {profile.style[axis].choice} · {percent(profile.style[axis].confidence)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <div className={styles.table}>
                  <h3 className={styles.tableTitle}>{t('designIndex.label.quality')}</h3>
                  <dl className={styles.rows}>
                    {Object.entries(profile.quality).map(([dimension, result]) => (
                      <div key={dimension} className={styles.row}>
                        <dt className={styles.rowKey}>{dimension}</dt>
                        <dd className={styles.rowValue}>{result.score.toFixed(2)} · {result.legend}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {panel === 'route' ? (
        <div role="tabpanel" className={styles.panel} data-testid="design-index-route-panel">
          <label className={styles.field}>
            <span className={styles.facetLabel}>{t('designIndex.route.brief')}</span>
            <textarea
              className={styles.textarea}
              rows={10}
              value={brief}
              disabled={routing}
              placeholder={t('designIndex.route.briefPlaceholder')}
              onChange={(event) => updateBrief(event.target.value)}
              data-testid="design-index-route-brief"
            />
          </label>

          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={routing}
              onClick={() => { void runRoute(); }}
              data-testid="design-index-route-run"
            >
              {t('designIndex.route.run')}
            </Button>
          </div>

          {routeError ? (
            <JevErrorNotice
              error={routeError}
              onOpenSettings={onOpenSettings}
              testId="design-index-route-open-settings"
              t={t}
            />
          ) : null}

          {decision ? <DecisionCard decision={decision} t={t} /> : null}

          {/* A routed decision with a family is one way into this panel — the Run button starts a
              build from it. A build already attached (via a routed Run OR "Start from this
              build") is the other: that build is real and spending money on the daemon whether or
              not a decision is showing, so its progress, cancel button and outcome must stay
              visible even when `decision` is null — the common shape for a fork pressed straight
              from the recent-builds list. `canRun` is false in that second case: there is no
              family to start a NEW build from, only a build already under way to watch. */}
          {(decision?.decision === 'routed' && decision.family) || build ? (
            <BuildPanel
              family={decision?.decision === 'routed' && decision.family ? decision.family.id : (build?.family ?? '')}
              build={build}
              events={buildStream.view?.events ?? []}
              liveState={buildStream.view?.state ?? null}
              steps={buildStream.view ? agencyBuildTimeline(buildStream.view) : null}
              error={buildError}
              verifyMode={verifyMode}
              starting={starting}
              canRun={decision?.decision === 'routed' && Boolean(decision.family)}
              onVerifyModeChange={setVerifyMode}
              composition={composition}
              onCompositionChange={setComposition}
              sections={decision?.decision === 'routed' && decision.family ? familySections : { status: 'idle', sections: [], retry: familySections.retry }}
              sectionHints={sectionHints}
              onSectionHintChange={(id, hint) => setSectionHints((current) => {
                const { [id]: _previous, ...rest } = current;
                return hint ? { ...rest, [id]: hint } : rest;
              })}
              sectionCatalog={sectionCatalog}
              sectionSelectionEntryId={sectionSelectionEntryId}
              onSectionSelectionEntryIdChange={setSectionSelectionEntryId}
              placementMode={placementMode}
              onPlacementModeChange={setPlacementMode}
              placementSectionId={placementSectionId}
              onPlacementSectionIdChange={setPlacementSectionId}
              directionId={directionId}
              onDirectionIdChange={setDirectionId}
              designReferenceId={designReferenceId}
              onDesignReferenceIdChange={setDesignReferenceId}
              effects={decision?.decision === 'routed' && decision.family ? familyEffects : { status: 'idle', offer: null, retry: familyEffects.retry }}
              effectsMode={effectsMode}
              onEffectsModeChange={setEffectsMode}
              effectPicks={effectPicks}
              onEffectPickChange={(placement, pick) => setEffectPicks((current) => {
                const { [placement]: _previous, ...rest } = current;
                return pick ? { ...rest, [placement]: pick } : rest;
              })}
              onRun={() => {
                if (decision?.decision === 'routed' && decision.family) void runBuild(decision.family.id);
              }}
              onCancel={() => { if (build) void cancelAgencyBuild(build.id); }}
              repairing={repairing}
              repairResult={repairResult}
              repairError={repairError}
              onRepair={() => { void runRepair(); }}
              {...(onOpenSettings ? { onOpenSettings } : {})}
              {...(onOpenProject ? { onOpenProject } : {})}
              t={t}
            />
          ) : null}

          {/* Flagship "client brief → working first draft": the routed brief, the family's section
              choices and the picked insertable section, built on an installed kit by one agent
              run (POST /api/build-on-brand, the same route `od build-on-brand` calls). */}
          {decision ? (
            <FirstDraftCard
              brief={brief}
              decision={decision}
              sectionHints={sectionHints}
              {...(referenceSections.length ? { referenceSections } : {})}
              {...(referenceExcludedSections.length ? { referenceExcludedSections } : {})}
              catalogEntryId={
                sectionSelectionEntryId
                && sectionCatalog.entries.some((entry) => entry.id === sectionSelectionEntryId && entry.availability === 'insertable')
                  ? sectionSelectionEntryId
                  : null
              }
              {...(onOpenProject ? { onOpenProject } : {})}
            />
          ) : null}

          <RecentBuildsPanel
            builds={recentBuilds}
            forkingId={forkingId}
            error={forkError}
            onStartFrom={(id) => { void startFromBuild(id); }}
            sectionsOpenId={forkSectionsId}
            onToggleSections={(id) => {
              setForkChoices({});
              setForkSectionsId((current) => (current === id ? null : id));
            }}
            sections={forkFamilySections}
            sectionChoices={forkChoices}
            onSectionChoiceChange={(id, choice) => setForkChoices((current) => ({ ...current, [id]: choice }))}
            {...(onOpenSettings ? { onOpenSettings } : {})}
            {...(onOpenProject ? { onOpenProject } : {})}
            t={t}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Building the routed family, from the Route panel — or watching a build "Start from this build"
 * already put under way, which carries no routed decision of its own.
 *
 * The Run button starts nothing until it is pressed, and `canRun` says whether pressing it would
 * do anything: false for a build attached from a fork, since there is no routed family to start a
 * NEW build from there, only the one already running to watch. Everything this panel shows is
 * built from this locale's words and the event's own numbers: the daemon's messages are fixed
 * English, and the model's output never leaves the daemon at all.
 */
function BuildPanel({
  family,
  build,
  events,
  liveState,
  steps,
  error,
  verifyMode,
  starting,
  canRun,
  onVerifyModeChange,
  composition,
  onCompositionChange,
  sections,
  sectionHints,
  onSectionHintChange,
  sectionCatalog,
  sectionSelectionEntryId,
  onSectionSelectionEntryIdChange,
  placementMode,
  onPlacementModeChange,
  placementSectionId,
  onPlacementSectionIdChange,
  directionId,
  onDirectionIdChange,
  designReferenceId,
  onDesignReferenceIdChange,
  effects,
  effectsMode,
  onEffectsModeChange,
  effectPicks,
  onEffectPickChange,
  onRun,
  onCancel,
  repairing,
  repairResult,
  repairError,
  onRepair,
  onOpenSettings,
  onOpenProject,
  t,
}: {
  family: string;
  build: AgencyBuildSnapshot | null;
  events: AgencyBuildEvent[];
  /** The AG-UI stream's state while the build runs: its live status and deferred verdict. */
  liveState: AgencyBuildAguiState | null;
  /** The step timeline, from STEP events only; null when no stream is attached. */
  steps: Array<{ name: AgencyBuildAguiStepName; status: AgencyBuildStepStatus }> | null;
  error: JevFailure | null;
  verifyMode: VerifyMode;
  starting: boolean;
  canRun: boolean;
  onVerifyModeChange: (mode: VerifyMode) => void;
  composition: AgencyBuildComposition;
  onCompositionChange: (composition: AgencyBuildComposition) => void;
  /** The routed family's optional sections; `ready` with none (or `idle`) hides the controls. */
  sections: FamilySectionsState & { retry: () => void };
  sectionHints: Record<string, SectionHint>;
  onSectionHintChange: (id: string, hint: SectionHint | undefined) => void;
  /** The selectable section catalog (design decision §1/§2), spine-filtered for the routed family. */
  sectionCatalog: SectionCatalogState & { retry: () => void };
  sectionSelectionEntryId: string | null;
  onSectionSelectionEntryIdChange: (id: string | null) => void;
  placementMode: 'append' | 'replace-optional';
  onPlacementModeChange: (mode: 'append' | 'replace-optional') => void;
  placementSectionId: string;
  onPlacementSectionIdChange: (id: string) => void;
  directionId: string;
  onDirectionIdChange: (id: string) => void;
  designReferenceId: string;
  onDesignReferenceIdChange: (id: string) => void;
  /** The routed family's effect placements; `idle` (a watched fork) hides the block. */
  effects: FamilyEffectsState & { retry: () => void };
  effectsMode: EffectsMode;
  onEffectsModeChange: (mode: EffectsMode) => void;
  effectPicks: Partial<Record<AgencyEffectPlacementId, string>>;
  onEffectPickChange: (placement: AgencyEffectPlacementId, pick: string | undefined) => void;
  onRun: () => void;
  onCancel: () => void;
  repairing: boolean;
  repairResult: AgencyBuildRepairResponse | null;
  repairError: JevFailure | null;
  onRepair: () => void;
  onOpenSettings?: (section: 'media') => void;
  onOpenProject?: (projectId: string) => void;
  t: Translate;
}) {
  const running = build !== null && !BUILD_TERMINAL.includes(build.status);
  // A `verify: 'after'` build shows its pending verdict as soon as it publishes: the snapshot only
  // changes at attach and at the end, the stream's state with every event.
  const shownBuild = build && running && liveState?.verdict?.status === 'pending'
    ? { ...build, verify: liveState.verdict }
    : build;
  const verdictText = buildVerdictText(shownBuild, events, repairResult, t);
  // Only a `done` verdict with something still flagged is repairable — see
  // `repairNotReadyReason` on the daemon, which this mirrors for the button's own enabled state.
  const canRepair = build?.verify?.status === 'done' && build.verify.flagged.length > 0;
  // C16: the build's own answer once there is one, the live stream's while it runs, and the
  // family's (from its sections response) before any build — so the label shows before Run.
  const outputScope = build?.outputScope ?? liveState?.outputScope ?? (sections.status === 'ready' ? sections.outputScope : undefined);
  const composed = isComposed(composition);
  const controlsDisabled = starting || running || repairing || !canRun;

  return (
    <div className={buildCardStyles.card} data-testid="design-index-build">
      {outputScope === 'static-prototype' ? <StaticPrototypeBadge testId="design-index-build-output-scope" t={t} /> : null}
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={starting || running || repairing || !canRun}
          onClick={onRun}
          data-testid="design-index-build-run"
        >
          {/* A composed build sends family 'auto' (its fallback may route another family), so the
              label names the composition, not the routed family. */}
          {composition === 'blocks'
            ? t('designIndex.build.runBlocks')
            : composition === 'auto'
              ? t('designIndex.build.runAuto')
              : t('designIndex.build.run', { family })}
        </Button>
        <label className={styles.facetLabel}>
          <span>{t('designIndex.build.composition.label')}</span>
          <select
            className={styles.select}
            value={composition}
            disabled={controlsDisabled}
            onChange={(event) => {
              const next = COMPOSITIONS.find((entry) => entry === event.target.value) ?? 'family';
              onCompositionChange(next);
            }}
            data-testid="design-index-build-composition"
          >
            <option value="family">{t('designIndex.build.composition.family')}</option>
            <option value="blocks">{t('designIndex.build.composition.blocks')}</option>
            <option value="auto">{t('designIndex.build.composition.auto')}</option>
          </select>
        </label>
        <label className={styles.facetLabel}>
          <span>{t('designIndex.build.verifyMode.label')}</span>
          {/* A composed build only runs strict, so the other modes are not offered while one is
              chosen; the person's own choice comes back when they return to Family. */}
          <select
            className={styles.select}
            value={composed ? 'strict' : verifyMode}
            disabled={controlsDisabled || composed}
            onChange={(event) => onVerifyModeChange(event.target.value as VerifyMode)}
            aria-describedby={composed ? 'design-index-build-composition-hint' : undefined}
            data-testid="design-index-build-verify-mode"
          >
            <option value="strict">{t('designIndex.build.verifyMode.strict')}</option>
            {composed ? null : <option value="advisory">{t('designIndex.build.verifyMode.advisory')}</option>}
            {composed ? null : <option value="after">{t('designIndex.build.verifyMode.after')}</option>}
          </select>
        </label>
        {running ? (
          <Button
            variant="secondary"
            onClick={onCancel}
            data-testid="design-index-build-cancel"
          >
            {t('designIndex.build.cancel')}
          </Button>
        ) : null}
      </div>

      {composed && canRun ? (
        <p className={styles.note} id="design-index-build-composition-hint" data-testid="design-index-build-composition-hint">
          {t('designIndex.build.composition.strictHint')}
        </p>
      ) : null}

      {sections.status === 'failed' || (sections.status === 'ready' && sections.sections.length > 0) ? (
        <SectionHintControls
          family={family}
          sections={sections}
          value={(id) => sectionHints[id] ?? 'auto'}
          onChange={(id, choice) => onSectionHintChange(id, choice === 'auto' ? undefined : choice)}
          disabled={starting || running || repairing || !canRun}
          testIdPrefix="design-index-build"
          t={t}
        />
      ) : null}

      {canRun && effects.status !== 'idle' ? (
        <EffectsControls
          effects={effects}
          mode={effectsMode}
          onModeChange={onEffectsModeChange}
          picks={effectPicks}
          onPickChange={onEffectPickChange}
          disabled={starting || running || repairing || composed}
          testIdPrefix="design-index-build"
          t={t}
        />
      ) : null}
      {canRun && composed && effects.status !== 'idle' ? (
        <p className={styles.note} data-testid="design-index-build-composition-effects-hint">
          {t('designIndex.build.composition.effectsOffHint')}
        </p>
      ) : null}

      {canRun ? (
        <SectionPickerControls
          catalog={sectionCatalog}
          entryId={sectionSelectionEntryId}
          onEntryIdChange={onSectionSelectionEntryIdChange}
          placementMode={placementMode}
          onPlacementModeChange={onPlacementModeChange}
          placementSectionId={placementSectionId}
          onPlacementSectionIdChange={onPlacementSectionIdChange}
          directionId={directionId}
          onDirectionIdChange={onDirectionIdChange}
          designReferenceId={designReferenceId}
          onDesignReferenceIdChange={onDesignReferenceIdChange}
          disabled={starting || running || repairing || composed}
          testIdPrefix="design-index-build"
          t={t}
        />
      ) : null}

      <AgencyBuildProgress
        build={build}
        events={events}
        liveState={liveState}
        steps={steps}
        error={error}
        {...(onOpenSettings ? { onOpenSettings } : {})}
        {...(onOpenProject ? { onOpenProject } : {})}
        t={t}
      >
        {/* The deferred verdict, `verify: 'after'` builds only — `verdictText` is null for every
            other mode, since `build.verify` itself is never set on those. */}
        {verdictText !== null ? (
          <p className={buildCardStyles.note} data-testid="design-index-build-verdict">{verdictText}</p>
        ) : null}

        {build?.verify?.status === 'done' && build.verify.flagged.length > 0 ? (
          <ul className={buildCardStyles.rows} data-testid="design-index-build-flagged">
            {build.verify.flagged.map((path) => (
              <li key={path} className={buildCardStyles.row}>{path}</li>
            ))}
          </ul>
        ) : null}

        {canRepair ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={buildCardStyles.secondary}
              disabled={repairing}
              onClick={onRepair}
              data-testid="design-index-build-repair"
            >
              {repairing ? t('designIndex.build.repairing') : t('designIndex.build.repair')}
            </button>
          </div>
        ) : null}

        {repairError ? (
          <div data-testid="design-index-build-repair-error">
            <JevErrorNotice
              error={repairError}
              {...(onOpenSettings ? { onOpenSettings } : {})}
              testId="design-index-build-repair-open-settings"
              t={t}
            />
          </div>
        ) : null}
      </AgencyBuildProgress>
    </div>
  );
}

/**
 * The Effects block (Sol ruling 2026-09-25), in the section picker's own visual style: Auto (the
 * default) or Off, then — for Auto — one select per placement the routed family offers, listing the
 * reviewed components it allows there as "name · kind". A placement left on Auto is Jev's call;
 * None asks for nothing there. A family that offers no placements says so in one line.
 */
function EffectsControls({
  effects,
  mode,
  onModeChange,
  picks,
  onPickChange,
  disabled,
  testIdPrefix,
  t,
}: {
  effects: FamilyEffectsState & { retry: () => void };
  mode: EffectsMode;
  onModeChange: (mode: EffectsMode) => void;
  picks: Partial<Record<AgencyEffectPlacementId, string>>;
  onPickChange: (placement: AgencyEffectPlacementId, pick: string | undefined) => void;
  disabled: boolean;
  testIdPrefix: string;
  t: Translate;
}) {
  return (
    <fieldset className={styles.facetLabel} data-testid={`${testIdPrefix}-effects`}>
      <legend>{t('designIndex.build.effects.label')}</legend>
      <label className={styles.facetLabel}>
        <span>{t('designIndex.build.effects.modeLabel')}</span>
        <select
          className={styles.select}
          value={mode}
          disabled={disabled}
          onChange={(event) => onModeChange(event.target.value === 'off' ? 'off' : 'auto')}
          data-testid={`${testIdPrefix}-effects-mode`}
        >
          <option value="auto">{t('designIndex.build.effects.mode.auto')}</option>
          <option value="off">{t('designIndex.build.effects.mode.off')}</option>
        </select>
      </label>
      {mode === 'off' ? null : effects.status === 'loading' ? (
        <p className={styles.note} data-testid={`${testIdPrefix}-effects-loading`}>{t('designIndex.build.effects.loading')}</p>
      ) : effects.status === 'failed' ? (
        <div data-testid={`${testIdPrefix}-effects-error`}>
          <p className={styles.error} role="alert">{t('designIndex.build.effects.loadFailed')}</p>
          <Button variant="secondary" onClick={effects.retry} data-testid={`${testIdPrefix}-effects-retry`}>
            {t('designIndex.build.sections.retry')}
          </Button>
        </div>
      ) : effects.status === 'ready' && effects.offer.placements.length === 0 ? (
        <p className={styles.note} data-testid={`${testIdPrefix}-effects-none`}>{t('designIndex.build.effects.none')}</p>
      ) : effects.status === 'ready' ? (
        <>
          <p className={styles.note}>{t('designIndex.build.effects.hint')}</p>
          {effects.offer.placements.map((entry) => (
            <label key={entry.placement} className={styles.facetLabel}>
              <span><code>{entry.placement}</code></span>
              <select
                className={styles.select}
                value={picks[entry.placement] ?? ''}
                disabled={disabled}
                onChange={(event) => onPickChange(entry.placement, event.target.value || undefined)}
                data-testid={`${testIdPrefix}-effect-${entry.placement}`}
              >
                <option value="">{t('designIndex.build.effects.placementAuto')}</option>
                <option value="none">{t('designIndex.build.effects.placementNone')}</option>
                {entry.allow.map((component) => (
                  <option key={component.id} value={component.id}>
                    {`${component.name} · ${effectKindLabel(component.kind, t)}`}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </>
      ) : null}
    </fieldset>
  );
}

/**
 * C16: app and dashboard families build static prototypes — their navigation, forms and controls
 * are not wired. The badge names that, and the hint says what it means.
 */
function StaticPrototypeBadge({ testId, t }: { testId: string; t: Translate }) {
  return (
    <p className={styles.scopeNote} role="note" data-testid={testId}>
      <span className={styles.scopeBadge}>{t('designIndex.build.outputScope.staticPrototype')}</span>
      <span>{t('designIndex.build.outputScope.staticPrototypeHint')}</span>
    </p>
  );
}

/** A build this daemon still remembers can start a new project from — it finished and published
 * one. Mirrors `canFork` in `apps/daemon/src/routes/agency-build.ts`; kept in step by hand, the
 * same way `AgencyBuildRepairReason` and this file's other daemon-shaped checks already are. */
/**
 * The keep/drop controls for a family's optional sections — the Build panel's and a recent
 * build's "Start from" row share them. A failed load shows its own sentence and a retry, so the
 * controls never silently vanish as if the family had no optional sections.
 */
function SectionHintControls({
  family,
  sections,
  value,
  onChange,
  disabled,
  testIdPrefix,
  t,
}: {
  family: string;
  sections: FamilySectionsState & { retry: () => void };
  value: (id: string) => SectionChoice;
  onChange: (id: string, choice: SectionChoice) => void;
  disabled: boolean;
  testIdPrefix: string;
  t: Translate;
}) {
  return (
    <fieldset className={styles.facetLabel} data-testid={`${testIdPrefix}-sections`}>
      <legend>{t('designIndex.build.sections.label')}</legend>
      {sections.status === 'failed' ? (
        <div data-testid={`${testIdPrefix}-sections-error`}>
          <p className={styles.error} role="alert">{t('designIndex.build.sections.loadFailed')}</p>
          <Button
            variant="secondary"
            onClick={sections.retry}
            data-testid={`${testIdPrefix}-sections-retry`}
          >
            {t('designIndex.build.sections.retry')}
          </Button>
        </div>
      ) : sections.status === 'ready' && sections.sections.length === 0 ? (
        <p className={styles.note}>{t('designIndex.build.sections.none')}</p>
      ) : (
        <>
          <p className={styles.note}>{t('designIndex.build.sections.hint')}</p>
          {sections.sections.map((section) => (
            <label key={section.id} className={styles.facetLabel}>
              <span>{sectionLabel(family, section, t)} <code>{section.id}</code></span>
              <select
                className={styles.select}
                value={value(section.id)}
                disabled={disabled}
                onChange={(event) => {
                  const next = event.target.value;
                  onChange(section.id, next === 'keep' || next === 'drop' ? next : 'auto');
                }}
                data-testid={`${testIdPrefix}-section-${section.id}`}
              >
                <option value="auto">{t('designIndex.build.sections.auto')}</option>
                <option value="keep">{t('designIndex.build.sections.keep')}</option>
                <option value="drop">{t('designIndex.build.sections.drop')}</option>
              </select>
            </label>
          ))}
        </>
      )}
    </fieldset>
  );
}

/** "Free account" / "Paid access" / "Sign in" — a `local` entry needs no account and is never one
 * of the three. `connected` is `null` while the connection status is still loading or unreachable,
 * which reads as "Sign in" for a gated entry (the safe fallback: an unknown connection is not
 * proof of one). Mirrors `od sections`' own `sectionsAccessLabel` in `apps/daemon/src/cli.ts`. */
function sectionAccessLabel(access: SectionCatalogEntry['access'], connected: boolean | null, t: Translate): string {
  if (access === 'local') return t('designIndex.build.section.access.local');
  if (connected !== true) return t('designIndex.build.section.access.signIn');
  return access === 'paid-account' ? t('designIndex.build.section.access.paid') : t('designIndex.build.section.access.free');
}

function sectionAvailabilityLabel(availability: SectionCatalogEntry['availability'], t: Translate): string {
  if (availability === 'adapter-needed') return t('designIndex.build.section.availability.adapterNeeded');
  if (availability === 'reference-only') return t('designIndex.build.section.availability.referenceOnly');
  return t('designIndex.build.section.availability.insertable');
}

/** A whole landing-page prompt a build can take as its design reference: a MotionSites or
 * local-corpus `page-composition` entry. A Cult UI Pro page is also `page-composition`, but it is a
 * catalogued block layout awaiting an adapter, not a reference prompt, so it lists with the other
 * not-yet-insertable entries instead. */
function isDesignReferenceStartingPoint(entry: SectionCatalogEntry): boolean {
  return entry.sectionKind === 'page-composition' && (entry.sourceKind === 'motionsites-prompt' || entry.sourceKind === 'local-corpus');
}

/**
 * The selectable-section picker (design decision §1/§2/§3): one extra section on top of the
 * routed family's fixed recipe, from the catalog `GET /api/sections` serves. Only
 * `availability: "insertable"` entries (the closed v1 roster) are choosable as `entryId`; every
 * other entry renders informationally, so the catalog stays browsable even though most of it is
 * not yet placeable (Cult UI Pro entries among them, as "Adapter needed"). A MotionSites or
 * local-corpus `sectionKind: "page-composition"` entry (a whole prompt, never a section) renders as
 * its own "starting point" card whose action sets the design reference instead of a section choice — the same `designReferenceId` a MotionSites/local-corpus
 * reference always is (`fetchMotionSitesDesignReference`, daemon side).
 */
function SectionPickerControls({
  catalog,
  entryId,
  onEntryIdChange,
  placementMode,
  onPlacementModeChange,
  placementSectionId,
  onPlacementSectionIdChange,
  directionId,
  onDirectionIdChange,
  designReferenceId,
  onDesignReferenceIdChange,
  disabled,
  testIdPrefix,
  t,
}: {
  catalog: SectionCatalogState & { retry: () => void };
  entryId: string | null;
  onEntryIdChange: (id: string | null) => void;
  placementMode: 'append' | 'replace-optional';
  onPlacementModeChange: (mode: 'append' | 'replace-optional') => void;
  placementSectionId: string;
  onPlacementSectionIdChange: (id: string) => void;
  directionId: string;
  onDirectionIdChange: (id: string) => void;
  designReferenceId: string;
  onDesignReferenceIdChange: (id: string) => void;
  disabled: boolean;
  testIdPrefix: string;
  t: Translate;
}) {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void fetchMotionSitesConnectionStatus().then((status) => {
      if (live) setConnected(status === 'connected');
    });
    return () => {
      live = false;
    };
  }, []);

  if (catalog.status === 'idle') return null;
  if (catalog.status === 'failed') {
    return (
      <div data-testid={`${testIdPrefix}-section-picker-error`}>
        <p className={styles.error} role="alert">{t('designIndex.build.section.loadFailed')}</p>
        <Button variant="secondary" onClick={catalog.retry} data-testid={`${testIdPrefix}-section-picker-retry`}>
          {t('designIndex.build.sections.retry')}
        </Button>
      </div>
    );
  }
  if (catalog.status === 'loading') {
    return <p className={styles.note} data-testid={`${testIdPrefix}-section-picker-loading`}>{t('designIndex.build.section.loading')}</p>;
  }

  const insertable = catalog.entries.filter((entry) => entry.availability === 'insertable');
  const startingPoints = catalog.entries.filter(isDesignReferenceStartingPoint);
  const other = catalog.entries.filter((entry) => entry.availability !== 'insertable' && !isDesignReferenceStartingPoint(entry));

  return (
    <fieldset className={styles.facetLabel} data-testid={`${testIdPrefix}-section-picker`}>
      <legend>{t('designIndex.build.section.label')}</legend>

      {insertable.length === 0 ? (
        <p className={styles.note}>{t('designIndex.build.section.none')}</p>
      ) : (
        <ul className={styles.rows} aria-label={t('designIndex.build.section.label')}>
          {insertable.map((entry) => (
            <li key={entry.id} className={styles.row}>
              <label>
                <input
                  type="radio"
                  name={`${testIdPrefix}-section-entry`}
                  checked={entryId === entry.id}
                  disabled={disabled}
                  onChange={() => onEntryIdChange(entry.id)}
                  data-testid={`${testIdPrefix}-section-entry-${entry.id}`}
                />
                {' '}
                {entry.title} <code>{entry.sectionKind}</code>
                {' — '}
                {sectionAccessLabel(entry.access, connected, t)}
                {' · '}
                {sectionAvailabilityLabel(entry.availability, t)}
              </label>
            </li>
          ))}
        </ul>
      )}

      {entryId ? (
        <div className={styles.rows} data-testid={`${testIdPrefix}-section-placement`}>
          <label className={styles.facetLabel}>
            <span>{t('designIndex.build.section.placement.label')}</span>
            <select
              className={styles.select}
              value={placementMode}
              disabled={disabled}
              onChange={(event) => onPlacementModeChange(event.target.value === 'replace-optional' ? 'replace-optional' : 'append')}
              data-testid={`${testIdPrefix}-section-placement-mode`}
            >
              <option value="append">{t('designIndex.build.section.placement.append')}</option>
              <option value="replace-optional">{t('designIndex.build.section.placement.replaceOptional')}</option>
            </select>
          </label>
          <label className={styles.facetLabel}>
            <span>{placementMode === 'append' ? t('designIndex.build.section.placement.afterSectionId') : t('designIndex.build.section.placement.targetSectionId')}</span>
            <input
              type="text"
              className={styles.input}
              value={placementSectionId}
              disabled={disabled}
              onChange={(event) => onPlacementSectionIdChange(event.target.value)}
              data-testid={`${testIdPrefix}-section-placement-id`}
            />
          </label>
          <label className={styles.facetLabel}>
            <span>{t('designIndex.build.section.direction.label')}</span>
            <select
              className={styles.select}
              value={directionId}
              disabled={disabled}
              onChange={(event) => onDirectionIdChange(event.target.value)}
              data-testid={`${testIdPrefix}-section-direction`}
            >
              <option value="">{t('designIndex.build.section.direction.choose')}</option>
              {catalog.directions.map((direction) => (
                <option key={direction.id} value={direction.id}>{direction.label}</option>
              ))}
            </select>
          </label>
          <label className={styles.facetLabel}>
            <span>{t('designIndex.build.section.reference.label')}</span>
            <input
              type="text"
              className={styles.input}
              value={designReferenceId}
              disabled={disabled}
              placeholder={t('designIndex.build.section.reference.placeholder')}
              onChange={(event) => onDesignReferenceIdChange(event.target.value)}
              data-testid={`${testIdPrefix}-section-reference`}
            />
          </label>
        </div>
      ) : null}

      {startingPoints.length > 0 ? (
        <div data-testid={`${testIdPrefix}-section-starting-points`}>
          <p className={styles.note}>{t('designIndex.build.section.startingPoints.label')}</p>
          <ul className={styles.rows}>
            {startingPoints.map((entry) => (
              <li key={entry.id} className={styles.startingPointRow}>
                <span className={styles.startingPointTitle}>{entry.title} <span className={styles.startingPointAccess}>— {sectionAccessLabel(entry.access, connected, t)}</span></span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.startingPointAction}
                  disabled={disabled}
                  onClick={() => onDesignReferenceIdChange(entry.id)}
                  data-testid={`${testIdPrefix}-section-starting-point-${entry.id}`}
                >
                  {t('designIndex.build.section.startingPoints.useAsReference')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {other.length > 0 ? (
        <details data-testid={`${testIdPrefix}-section-other`}>
          <summary>{t('designIndex.build.section.other.label')}</summary>
          <ul className={styles.rows}>
            {other.map((entry) => (
              <li key={entry.id} className={styles.row}>
                {entry.title} <code>{entry.sectionKind}</code>
                {' — '}
                {sectionAccessLabel(entry.access, connected, t)}
                {' · '}
                {sectionAvailabilityLabel(entry.availability, t)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </fieldset>
  );
}

function canStartFrom(build: AgencyBuildListItem): boolean {
  return build.status === 'done' && typeof build.projectId === 'string';
}

/**
 * The builds this daemon still remembers — survives a restart, per `agency-build-store.ts` —
 * newest first, with a "Start from this build" action on any that finished and published a
 * project. Nothing here reads the brief or the model's output: `AgencyBuildListItem` never carries
 * either, the same rule the rest of this panel follows.
 */
function RecentBuildsPanel({
  builds,
  forkingId,
  error,
  onStartFrom,
  sectionsOpenId,
  onToggleSections,
  sections,
  sectionChoices,
  onSectionChoiceChange,
  onOpenSettings,
  onOpenProject,
  t,
}: {
  builds: AgencyBuildListItem[];
  forkingId: string | null;
  error: JevFailure | null;
  onStartFrom: (buildId: string) => void;
  /** The build whose section controls are open, if any. */
  sectionsOpenId: string | null;
  onToggleSections: (buildId: string) => void;
  /** The open build's family sections. */
  sections: FamilySectionsState & { retry: () => void };
  sectionChoices: Record<string, SectionChoice>;
  onSectionChoiceChange: (id: string, choice: SectionChoice) => void;
  onOpenSettings?: (section: 'media') => void;
  onOpenProject?: (projectId: string) => void;
  t: Translate;
}) {
  return (
    <div className={styles.card} data-testid="design-index-recent-builds">
      <h3 className={styles.tableTitle}>{t('designIndex.build.recent.title')}</h3>

      {error ? (
        <div data-testid="design-index-recent-builds-error">
          <JevErrorNotice
            error={error}
            {...(onOpenSettings ? { onOpenSettings } : {})}
            testId="design-index-recent-builds-open-settings"
            t={t}
          />
        </div>
      ) : null}

      {builds.length === 0 ? (
        <p className={styles.note}>{t('designIndex.build.recent.empty')}</p>
      ) : (
        <ol className={styles.rows}>
          {builds.map((build) => (
            <li key={build.id} className={styles.row} data-testid="design-index-recent-build">
              <span className={styles.rowKey}>
                {t(BUILD_STATUS_KEY[build.status])}
                {build.family ? ` · ${build.family}` : ''}
                {` · ${new Date(build.startedAt).toLocaleString()}`}
                {build.outputScope === 'static-prototype' ? (
                  <span className={styles.scopeBadge} data-testid="design-index-recent-build-output-scope">
                    {t('designIndex.build.outputScope.staticPrototype')}
                  </span>
                ) : null}
              </span>
              <span className={styles.rowValue}>
                {build.projectId && onOpenProject ? (
                  <Button
                    variant="secondary"
                    onClick={() => onOpenProject(build.projectId!)}
                    data-testid="design-index-recent-build-open-project"
                  >
                    {t('designIndex.build.openProject')}
                  </Button>
                ) : null}
                {canStartFrom(build) && build.family ? (
                  <Button
                    variant="secondary"
                    aria-expanded={sectionsOpenId === build.id}
                    disabled={forkingId === build.id}
                    onClick={() => onToggleSections(build.id)}
                    data-testid="design-index-recent-build-sections-toggle"
                  >
                    {t('designIndex.build.recent.sections')}
                  </Button>
                ) : null}
                {canStartFrom(build) ? (
                  <Button
                    variant="secondary"
                    disabled={forkingId === build.id}
                    onClick={() => onStartFrom(build.id)}
                    data-testid="design-index-recent-build-start-from"
                  >
                    {t('designIndex.build.recent.startFrom')}
                  </Button>
                ) : null}
              </span>
              {sectionsOpenId === build.id && build.family && sections.status !== 'idle' && sections.status !== 'loading' ? (
                <SectionHintControls
                  family={build.family}
                  sections={sections}
                  value={(id) => sectionChoices[id] ?? build.sections?.[id] ?? 'auto'}
                  onChange={onSectionChoiceChange}
                  disabled={forkingId === build.id}
                  testIdPrefix="design-index-recent-build"
                  t={t}
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function LabelTable({
  title,
  labels,
  t,
}: {
  title: string;
  labels: Record<string, number>;
  t: Translate;
}) {
  const rows = topEntries(labels, Object.keys(labels).length);
  return (
    <div className={styles.table}>
      <h3 className={styles.tableTitle}>{title}</h3>
      <dl className={styles.rows}>
        <div className={styles.rowHead}>
          <dt className={styles.rowKey}>{t('designIndex.label.name')}</dt>
          <dd className={styles.rowValue}>{t('designIndex.label.probability')}</dd>
        </div>
        {rows.map(([label, probability]) => (
          <div key={label} className={styles.row}>
            <dt className={styles.rowKey}>{label}</dt>
            <dd className={styles.rowValue}>{percent(probability)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ProfileCard({
  profile,
  t,
  onRemove,
}: {
  profile: DesignProfile;
  t: Translate;
  onRemove?: () => void;
}) {
  const { source, route, style } = profile;
  const family = route.resolved.familyId;
  return (
    <article className={styles.card} data-testid="design-index-result">
      <header className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{profileTitle(profile, t)}</h2>
        <Badge>{kindLabel(source.kind, t)}</Badge>
        {onRemove ? (
          <Button
            variant="ghost"
            size="sm"
            className={styles.remove}
            onClick={onRemove}
            data-testid="design-index-remove"
          >
            {t('designIndex.remove')}
          </Button>
        ) : null}
      </header>

      {source.ref ? (
        <p className={styles.cardRef}>
          {isHttpUrl(source.ref) ? (
            <a href={source.ref} target="_blank" rel="noreferrer">{source.ref}</a>
          ) : (
            source.ref
          )}
        </p>
      ) : null}

      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.route.spine')}</dt>
          <dd className={styles.rowValue}>{route.spine.choice} · {percent(route.spine.confidence)}</dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.route.archetype')}</dt>
          <dd className={styles.rowValue}>
            {route.resolved.archetypeId ?? route.archetype?.choice ?? '—'}
          </dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.route.family')}</dt>
          <dd className={styles.rowValue}>{family ?? t('designIndex.label.noFamily')}</dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.label.sections')}</dt>
          <dd className={styles.rowValue}>
            {topEntries(profile.sections, 3).map(([label, p]) => `${label} ${percent(p)}`).join(', ') || '—'}
          </dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.label.components')}</dt>
          <dd className={styles.rowValue}>
            {topEntries(profile.components, 3).map(([label, p]) => `${label} ${percent(p)}`).join(', ') || '—'}
          </dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.label.ground')}</dt>
          <dd className={styles.rowValue}>{style.ground.choice}</dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.label.topology')}</dt>
          <dd className={styles.rowValue}>{style.topology.choice}</dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.label.quality')}</dt>
          <dd className={styles.rowValue}>{meanQuality(profile).toFixed(2)}</dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.label.truthRisk')}</dt>
          <dd className={styles.rowValue}>{percent(profile.truthRisk)}</dd>
        </div>
      </dl>
    </article>
  );
}

// An unrouted decision renders in this same card, with the reason and the
// "no family yet" line, so the UI never dresses a missing family as a failure.
function DecisionCard({ decision, t }: { decision: RouteDecision; t: Translate }) {
  const routed = decision.decision === 'routed';
  return (
    <article className={styles.card} data-testid="design-index-decision">
      <header className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{decision.spine.name}</h2>
        <span className={styles.badge}>
          {routed ? t('designIndex.route.routed') : t('designIndex.route.unrouted')}
        </span>
      </header>

      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.route.spine')}</dt>
          <dd className={styles.rowValue}>
            {decision.spine.code} · {percent(decision.spine.confidence)}
          </dd>
        </div>
        <div className={styles.row}>
          <dt className={styles.rowKey}>{t('designIndex.route.archetype')}</dt>
          <dd className={styles.rowValue}>
            {decision.archetype
              ? `${decision.archetype.name} · ${percent(decision.archetype.confidence)}`
              : '—'}
          </dd>
        </div>
        {decision.family ? (
          <div className={styles.row}>
            <dt className={styles.rowKey}>{t('designIndex.route.family')}</dt>
            <dd className={styles.rowValue}>
              {decision.family.id} · {percent(decision.family.probability)} ·{' '}
              {t('designIndex.route.basis')} {decision.family.basis} ·{' '}
              {t('designIndex.route.transfer')} {decision.family.transfer}
            </dd>
          </div>
        ) : null}
        {decision.reason ? (
          <div className={styles.row}>
            <dt className={styles.rowKey}>{t('designIndex.route.reason')}</dt>
            <dd className={styles.rowValue}>{decision.reason}</dd>
          </div>
        ) : null}
      </dl>

      {decision.candidates.length > 0 ? (
        <div className={styles.table}>
          <h3 className={styles.tableTitle}>{t('designIndex.route.candidates')}</h3>
          <dl className={styles.rows}>
            {decision.candidates.map((candidate) => (
              <div key={candidate.family} className={styles.row}>
                <dt className={styles.rowKey}>{candidate.family}</dt>
                <dd className={styles.rowValue}>
                  {percent(candidate.probability)} · {candidate.basis}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <p className={styles.note}>{t('designIndex.route.noFamilySpine')}</p>
      )}

      {decision.warnings.length > 0 ? (
        <div className={styles.table}>
          <h3 className={styles.tableTitle}>{t('designIndex.route.warnings')}</h3>
          <ul className={styles.warnings}>
            {decision.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
