import { claimNativeFileDrop, collectDroppedFiles } from '../runtime/intake/drop-coordinator';
import { useWorkbenchIntake } from './WorkbenchIntake';
// Lovart-style centered hero for the entry Home view.
//
// The prompt textarea is the canonical creation surface: the user
// either types freely or selects a type below to reveal matching
// starters, then presses Run / Enter to spawn a project. The hero is
// kept dependency-free (no plugin list / project list) so it can be
// composed with the recent-projects strip and plugins section
// without owning their data lifecycles.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Button, Chip, PreviewCard, PreviewCardMedia, PreviewCardCaption, PreviewCardTitle,
  PreviewCardDescription, VisuallyHidden,
} from '@mish/components';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
  SyntheticEvent as ReactSyntheticEvent,
} from 'react';
import type {
  ChatSessionMode,
  ConnectorDetail,
  DesignProfile,
  DesignSystemSummary,
  InputFieldSpec,
  InstalledPluginRecord,
  McpServerConfig,
  WorkspaceCollabContext,
  WorkspaceContextItem,
} from '@mish/contracts';
import { DesignSystemPicker } from './DesignSystemPicker';
import type { SkillSummary } from '../types';
import { Icon, type IconName } from './Icon';
import { useAnalytics } from '../analytics/provider';
import {
  trackContextLinkResult,
  trackFigmaHelpModalSurfaceView,
  trackHomeChatComposerClick,
  trackProjectReferenceModalSurfaceView,
} from '../analytics/events';
import {
  chipsForGroup,
  HOME_APPLY_TEMPLATE_EVENT,
  orderedCreateChips,
  findChip,
  JEV_SITE_CHIP_ID,
  type ChipGroup,
  type HomeHeroChip,
} from './home-hero/chips';
import { homeHeroChipLabel } from './home-hero/chip-labels';
import { PixelScanLogo } from './home-hero/PixelScanLogo';
import { ScenarioArt } from './home-hero/ScenarioArt';
import { useEdgeAutoScroll, EdgeScrollZones } from './home-hero/EdgeAutoScroll';
import {
  isSubChipParent,
  subChipsForChip,
  type HomeHeroSubChip,
} from './home-hero/sub-chips';
import { prototypeSpineChips } from './home-hero/spine-chips';
import { ReferenceCard } from './home-hero/ReferenceCard';
import { compactCardStyle, compactCardTitle } from './home-hero/card-labels';
import {
  agencyFamilySlug,
  buildWebsiteCards,
  familyPluginRecord,
  referenceFamilyId,
  familyCardLine,
  websiteCardsForSpine,
  type WebsiteCard,
} from './plugins-home/websiteCards';
import { referenceSeedPrompt } from './plugins-home/referenceSeedPrompt';
import {
  inlineMentionToken,
  type InlineMentionEntity,
} from '../utils/inlineMentions';
import { useI18n, useT } from '../i18n';
import { localizePluginDescription, localizePluginTitle } from './plugins-home/localization';
import { isUserFacingPluginOption } from './plugins-home/visibility';
import {
  examplePresetSeedPrompt,
  pluginPresetQuery,
  renderPluginPresetQuery,
} from './plugins-home/presetSeedPrompt';
import type { Locale } from '../i18n/types';
import {
  localizeSkillDescription,
  localizeSkillName,
} from '../i18n/content';
import { PreviewSurface } from './plugins-home/cards/PreviewSurface';
import { TextSurface } from './plugins-home/cards/TextSurface';
import { pluginCategoryLabel } from './plugins-home/categoryLabel';
import { readHomeGuideStage, writeHomeGuideStage } from './home-hero/firstRunGuide';
import { curatedPluginPriorityForChip } from './plugins-home/curatedPriority';
import { comparePluginGalleryOrder } from './plugins-home/pluginPopularity';
import { sortByVisualAppeal } from './plugins-home/visualScore';
import { applyFacetSelection } from './plugins-home/facets';
import { notifyCompletionFeedbackGesture } from '../utils/notifications';
import { inferPluginPreview } from './plugins-home/preview';
import { pluginSubfacetLabel } from './plugins-home/subfacetLabel';
import { useDeckPreviewScale } from '../lib/use-deck-preview-scale';
import { ComposerPlusMenu, PLUS_SUBMENU_RESOURCE_KIND } from './ComposerPlusMenu';
import { ContextChipHoverCard } from './ContextChipHoverCard';
import { workspaceContextDetailLine, workspaceContextKindLabel } from './workspace-context';
import { FigmaHelpModal } from './FigmaHelpModal';
import { TemplatePicker } from './home-hero/TemplatePicker';
import { TypePillRow } from './home-hero/TypePillRow';
import { LibraryPicker } from './LibraryPicker';
import { assetTitle } from './LibraryAssetMeta';
import { libraryAssetRawUrl } from '../providers/registry';
import type { LibraryAsset } from '@mish/contracts';
import { WorkingDirPicker } from './WorkingDirPicker';
import {
  ProjectReferenceModal,
  type ProjectReferenceSelection,
} from './ProjectReferenceModal';
import {
  LexicalComposerInput,
  type LexicalComposerInputHandle,
  type CaretRect,
} from './composer/LexicalComposerInput';
import { CaretFloatingLayer } from './composer/CaretFloatingLayer';
import { publicFaviconUrl } from '../utils/publicFavicon';

export interface HomeHeroSubmitHandler {
  (): void;
}

// The homepage prompt input now shares the project composer's Lexical
// editor, so the forwarded handle is a small focus surface rather than a
// raw <textarea>. HomeView drives `focusEnd()` after seeding a prompt
// example / picking a plugin.
export interface HomeHeroHandle {
  focus(): void;
  focusEnd(): void;
  // Flash the send button twice — fired after a plugin Use action or an
  // example-prompt card seeds the composer, to pull the eye to the next step.
  pulseSend(): void;
}

export interface ExamplePromptInfo {
  title: string;
  artifactType: string;
  brief: Record<string, string>;
}

interface Props {
  workspaceContext?: WorkspaceCollabContext | null;
  active?: boolean;
  // Arms the first-run guidance trail (prototype chip → first preset
  // card sheen). Tri-state: true = brand-new user (no projects), false =
  // existing user, undefined = projects still loading — the guide neither
  // arms nor completes until the answer is known.
  firstRunGuide?: boolean;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: HomeHeroSubmitHandler;
  // Wiring for the dormant `ComposerModePicker` (see the composer footer
  // below). Nothing in HomeHero reads these while the picker is off screen —
  // the host keeps its own `sessionMode` state, which now stays on the app
  // default. They are kept declared so the HomeView call site (and the restore
  // path) stays intact.
  sessionMode?: ChatSessionMode;
  onSessionModeChange?: (mode: ChatSessionMode) => void;
  activePluginTitle: string | null;
  // True when the active plugin chip shows a user-picked plugin (Community card
  // or example-prompt preset) rather than a task-type chip's default plugin —
  // an explicit pick owns its own clear (×) button even when a task chip is set.
  activePluginIsExplicit?: boolean;
  activePluginRecord?: InstalledPluginRecord | null;
  activeChipId: string | null;
  // Prototype's selected second-level scene is owned by HomeView so action
  // metadata and persistence stay aligned with the visible filter selection.
  activePrototypeSubtypeId?: string | null;
  onClearActivePlugin: () => void;
  onClearActiveChip?: () => void;
  activeSkillId?: string | null;
  activeSkillTitle?: string | null;
  activeSkillRecord?: SkillSummary | null;
  onClearActiveSkill?: () => void;
  selectedPluginContexts?: InstalledPluginRecord[];
  selectedMcpContexts?: McpServerConfig[];
  selectedConnectorContexts?: ConnectorDetail[];
  // Context-only selections (staged through the plain `Use` action, no inline
  // @mention pill). These have no in-prompt representation, so the active row
  // renders a removable chip for each — otherwise a kept-in-payload context
  // would be invisible and unremovable (silent context drift).
  contextOnlyPlugins?: InstalledPluginRecord[];
  contextOnlyMcpServers?: McpServerConfig[];
  contextOnlyConnectors?: ConnectorDetail[];
  contextWorkspaceItems?: WorkspaceContextItem[];
  onRemovePluginContext?: (pluginId: string) => void;
  onRemoveMcpContext?: (serverId: string) => void;
  onRemoveConnectorContext?: (connectorId: string) => void;
  onAddWorkspaceContext?: (item: WorkspaceContextItem) => void;
  onRemoveWorkspaceContext?: (id: string) => void;
  onAddPlugin?: () => void;
  onAddConnector?: () => void;
  onAddMcp?: () => void;
  onOpenPluginDetails?: (record: InstalledPluginRecord) => void;
  onOpenSkillDetails?: (skill: SkillSummary) => void;
  pluginInputFields?: InputFieldSpec[];
  pluginInputValues?: Record<string, unknown>;
  pluginInputTemplate?: string | null;
  onPluginInputValuesChange?: (values: Record<string, unknown>) => void;
  inlineEditableInputNames?: string[];
  footerInputNames?: string[];
  designSystems?: DesignSystemSummary[];
  // Persistent design-system selection, surfaced as a borderless picker in the
  // row below the composer (next to the working-directory picker) so it is
  // available for every product kind. `null` = "No design system".
  selectedDesignSystemId?: string | null;
  onDesignSystemChange?: (id: string | null) => void;
  /** The catalogue has not arrived yet; the picker says so instead of looking empty. */
  designSystemsLoading?: boolean;
  /** Publish one of the caller's draft kits; resolves true on success. */
  onPublishDesignSystemDraft?: (system: DesignSystemSummary) => Promise<boolean>;
  stagedFiles?: File[];
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (index: number) => void;
  /** Opens the "Import from Figma" dialog; omit to hide the menu entry. */
  onImportFigma?: () => void;
  pluginOptions: InstalledPluginRecord[];
  pluginsLoading: boolean;
  skillOptions?: SkillSummary[];
  skillsLoading?: boolean;
  mcpOptions?: McpServerConfig[];
  mcpLoading?: boolean;
  connectorOptions?: ConnectorDetail[];
  pendingPluginId: string | null;
  pendingChipId: string | null;
  submitDisabled?: boolean;
  // True while the submitted run is still creating its project/conversation
  // (#4082). Distinct from `submitDisabled`: it swaps the send button into a
  // visible Sending… state instead of leaving it silently idle.
  submitting?: boolean;
  preparingPrompt?: boolean;
  onImprovePrompt?: () => void;
  designBriefRevision?: number;
  onDetachDesignBrief?: () => void;
  onPickPlugin: (record: InstalledPluginRecord, nextPrompt: string | null) => void;
  onPickExamplePlugin?: (record: InstalledPluginRecord, chipId: string, promptText: string) => void;
  onPickSkill?: (skill: SkillSummary, nextPrompt: string | null) => void;
  onPickMcp?: (server: McpServerConfig, nextPrompt: string) => void;
  onPickConnector?: (connector: ConnectorDetail, nextPrompt: string) => void;
  onPickChip: (chip: HomeHeroChip) => void;
  // Stored design-index profiles, the reference half of the Prototype strip.
  // Separate from `pluginOptions`: these are profiles, not installs, and they
  // arrive on their own refresh cycle (see `useDesignIndexProfiles`).
  designIndexProfiles?: DesignProfile[];
  designIndexLoading?: boolean;
  designIndexFailed?: boolean;
  // The Prototype strip's pinned first card: instead of the user picking a
  // family here, Jev picks one from the brief when Send is pressed. The mode
  // itself lives in HomeView — the hero draws the card and reports the pick.
  jevChoosesActive?: boolean;
  // True while that one Jev call is in flight; the composer is disabled and
  // says so for the whole window.
  jevChoosing?: boolean;
  // Jev's own result line under the strip: an unrouted decision with its
  // candidates, a routed family whose generator is missing, or a Jev failure.
  // Never an error banner — the brief survives and the user can send again.
  jevChoosesNotice?: string | null;
  onPickJevChooses?: () => void;
  // A reference card was picked: seed the composer with `prompt` and, when the
  // routed family has an installed generator, bind it. `familyRecord` is null
  // for an unrouted reference — the current plugin binding then stays as it is.
  onPickDesignReference?: (
    profile: DesignProfile,
    prompt: string,
    familyRecord: InstalledPluginRecord | null,
  ) => void;
  contextItemCount: number;
  error: string | null;
  showActivePluginChip?: boolean;
  workingDir?: string | null;
  recentDirs?: string[];
  onPickWorkingDir?: () => Promise<string | null> | string | null | void;
  onPickLocalCodeDir?: () => Promise<string | null> | string | null | void;
  onSelectRecentWorkingDir?: (dir: string) => void;
  onClearWorkingDir?: () => void;
  onExamplePromptStatusChange?: (info: ExamplePromptInfo | null) => void;
  // "…or start a blank project" — creates an empty project directly (no dialog,
  // no design system / template / prompt) and enters it. Omit to hide the link.
  onStartBlankProject?: () => void;
  executionSwitcher?: ReactNode;
  // Personalized first-run starting point (spec §7). Rendered directly under
  // the composer card — before the template section — so a brand-new user sees
  // their recommended entry without scrolling.
  recommendationSlot?: ReactNode;
}

type HomeMentionTab = 'all' | 'files' | 'plugins' | 'skills' | 'mcp' | 'connectors';

// In the combined "All" overview, every surface is capped to a handful of top
// matches so no single section floods the picker. The dedicated "Design files"
// tab is exempt: staged files are the user's own finite content, so that tab
// lists every match (the results panel scrolls) and its count reflects the true
// total rather than the truncated preview.
const HOME_MENTION_ALL_TAB_PREVIEW = 6;

interface HomeMentionOption {
  id: string;
  icon: IconName;
  title: string;
  description: string;
  meta: string;
  pluginRecord?: InstalledPluginRecord;
  disabled?: boolean;
  onPick: () => void;
}

interface HomeMentionSection {
  id: Exclude<HomeMentionTab, 'all'>;
  label: string;
  options: HomeMentionOption[];
}

interface SelectedPromptExample {
  label: string;
  promptText: string;
}

const EMPTY_PLUGIN_CONTEXTS: InstalledPluginRecord[] = [];
const EMPTY_MCP_CONTEXTS: McpServerConfig[] = [];
const EMPTY_CONNECTOR_CONTEXTS: ConnectorDetail[] = [];
const EMPTY_INPUT_FIELDS: InputFieldSpec[] = [];
const EMPTY_PLUGIN_INPUT_VALUES: Record<string, unknown> = {};
const EMPTY_INPUT_NAMES: string[] = [];
const EMPTY_DESIGN_SYSTEMS: DesignSystemSummary[] = [];
const EMPTY_STAGED_FILES: File[] = [];
const EMPTY_SKILLS: SkillSummary[] = [];
const EMPTY_MCP_OPTIONS: McpServerConfig[] = [];
const EMPTY_CONNECTOR_OPTIONS: ConnectorDetail[] = [];
const EMPTY_WORKSPACE_ITEMS: WorkspaceContextItem[] = [];
const EMPTY_DESIGN_PROFILES: DesignProfile[] = [];

export const HomeHero = forwardRef<HomeHeroHandle, Props>(function HomeHero(
  {
    workspaceContext = null,
    active = true,
    prompt,
    onPromptChange,
    onSubmit,
    firstRunGuide,
    activePluginTitle,
    activePluginIsExplicit = false,
    activePluginRecord = null,
    activeSkillId = null,
    activeSkillTitle = null,
    activeSkillRecord = null,
    activeChipId,
    onClearActivePlugin,
    onClearActiveChip = onClearActivePlugin,
    onClearActiveSkill = () => undefined,
    selectedPluginContexts = EMPTY_PLUGIN_CONTEXTS,
    contextOnlyPlugins = EMPTY_PLUGIN_CONTEXTS,
    contextOnlyMcpServers = EMPTY_MCP_OPTIONS,
    contextOnlyConnectors = EMPTY_CONNECTOR_OPTIONS,
    contextWorkspaceItems = EMPTY_WORKSPACE_ITEMS,
    onRemovePluginContext = () => undefined,
    onRemoveMcpContext = () => undefined,
    onRemoveConnectorContext = () => undefined,
    onAddWorkspaceContext = () => undefined,
    onRemoveWorkspaceContext = () => undefined,
    onAddPlugin = () => undefined,
    onAddConnector = () => undefined,
    onAddMcp = () => undefined,
    onOpenPluginDetails = () => undefined,
    onOpenSkillDetails = () => undefined,
    pluginInputFields = EMPTY_INPUT_FIELDS,
    pluginInputValues = EMPTY_PLUGIN_INPUT_VALUES,
    onPluginInputValuesChange = () => undefined,
    footerInputNames = EMPTY_INPUT_NAMES,
    designSystems = EMPTY_DESIGN_SYSTEMS,
    selectedDesignSystemId = null,
    onDesignSystemChange,
    designSystemsLoading = false,
    onPublishDesignSystemDraft,
    stagedFiles = EMPTY_STAGED_FILES,
    onAddFiles = () => undefined,
    onImportFigma,
    onRemoveFile = () => undefined,
    pluginOptions,
    pluginsLoading,
    skillOptions = EMPTY_SKILLS,
    skillsLoading = false,
    mcpOptions = EMPTY_MCP_OPTIONS,
    mcpLoading = false,
    connectorOptions = EMPTY_CONNECTOR_OPTIONS,
    pendingPluginId,
    pendingChipId,
    submitDisabled = false,
    submitting = false,
    preparingPrompt = false,
    onImprovePrompt,
    designBriefRevision,
    onDetachDesignBrief,
    onPickPlugin,
    onPickExamplePlugin = () => undefined,
    onPickSkill = () => undefined,
    onPickMcp = () => undefined,
    onPickConnector = () => undefined,
    onPickChip,
    activePrototypeSubtypeId,
    designIndexProfiles = EMPTY_DESIGN_PROFILES,
    designIndexLoading = false,
    designIndexFailed = false,
    jevChoosesActive = false,
    jevChoosing = false,
    jevChoosesNotice = null,
    onPickJevChooses,
    onPickDesignReference,
    contextItemCount,
    error,
    showActivePluginChip = true,
    workingDir = null,
    recentDirs = [],
    onPickWorkingDir,
    onPickLocalCodeDir,
    onSelectRecentWorkingDir,
    onClearWorkingDir,
    onExamplePromptStatusChange,
    onStartBlankProject,
    executionSwitcher,
    recommendationSlot,
  },
  ref,
) {
  const { locale, t } = useI18n();
  const intake = useWorkbenchIntake();
  const analytics = useAnalytics();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionTab, setMentionTab] = useState<HomeMentionTab>('all');
  const [hoveredPlugin, setHoveredPlugin] = useState<InstalledPluginRecord | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false);
  const [projectReferenceOpen, setProjectReferenceOpen] = useState(false);
  const [figmaHelpOpen, setFigmaHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const homeHeroRef = useRef<HTMLElement | null>(null);
  // Two-flash attention pulse on the send button; armed via the
  // imperative `pulseSend()` handle, cleared when the animation ends.
  const [sendAttention, setSendAttention] = useState(false);
  // First-run guidance trail (see home-hero/firstRunGuide.ts): which rail
  // chip is pulsing, and whether the first example-prompt card is pulsing.
  const [guidePulseChipId, setGuidePulseChipId] = useState<string | null>(null);
  const [guidePulseFirstPreset, setGuidePulseFirstPreset] = useState(false);
  // Selected second-level sub-category slug (Prototype / Slide deck rail).
  // Deck remains a local example filter. Prototype is controlled by HomeView:
  // every scene binds the Prototype action, while Mobile/Wireframe additionally
  // retain the project metadata from their former top-level actions.
  const [localSelectedSubcategory, setLocalSelectedSubcategory] = useState<string | null>(null);
  const selectedSubcategory =
    activeChipId === 'prototype' && activePrototypeSubtypeId !== undefined
      ? activePrototypeSubtypeId
      : localSelectedSubcategory;
  // The Prototype row's own selection: an atlas spine code, or null for All.
  // Deliberately NOT `prototypeSubtypeId` — that field still carries the legacy
  // keyword scene a persisted draft or a queued mobile/wireframe intent
  // restores, and a spine is a different axis entirely.
  const [prototypeSpineCode, setPrototypeSpineCode] = useState<string | null>(null);
  // Footer Template pill preview: the create-rail card the pointer is over,
  // so hovering a card below previews it in the pill (cleared on rail-leave).
  const [previewTemplateId, setPreviewTemplateId] = useState<string | null>(null);
  // A committed pick or Clear must win over a lingering hover-preview. The rail
  // that sets previewTemplateId unmounts the instant a template becomes active,
  // so its onMouseLeave never fires; without this reset the stale preview keeps
  // the pill showing the old template even after Clear nulls the value.
  useEffect(() => {
    setPreviewTemplateId(null);
  }, [activeChipId]);
  const [selectedPromptExample, setSelectedPromptExample] = useState<SelectedPromptExample | null>(null);
  const [previewHomeFileKey, setPreviewHomeFileKey] = useState<string | null>(null);
  const [stagedFilePreviewUrls, setStagedFilePreviewUrls] = useState<Map<string, string>>(() => new Map());
  // Lexical-driven @-trigger state (replaces the old end-anchored
  // getContextMention regex) + the caret box the popover anchors to.
  const [mentionTrigger, setMentionTrigger] = useState<{ query: string } | null>(null);
  const [caretRect, setCaretRect] = useState<CaretRect | null>(null);
  const editorRef = useRef<LexicalComposerInputHandle | null>(null);
  const promptEditorRef = useRef<HTMLDivElement | null>(null);
  const mentionPickerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shortcutsMenuRef = useRef<HTMLDivElement>(null);
  // One Jev call runs between the Send press and the create, and the composer
  // is disabled for the whole window — same shape as `submitting`, its own
  // wording ("Jev is choosing…") so the wait reads as a decision, not a send.
  const sendBusy = submitting || jevChoosing;
  // The composer is LOCKED while Jev is choosing, not merely un-sendable.
  //
  // Everything the composer holds — the brief, the staged files, the bound
  // plugin and skill, the staged contexts, the design system, the working
  // directory — is part of the payload Jev's answer is about to be applied
  // to. A change to any of it during that window would be applied to a create
  // the user never asked for, so every mutation passes through one gate
  // rather than each control growing its own `disabled`: a control added
  // later is covered by construction, and a menu or portal that cannot carry
  // a disabled state still cannot mutate.
  const composerLocked = jevChoosing || preparingPrompt;
  // Keep the locked execution switcher out of keyboard and pointer navigation.
  // Set `inert` imperatively because React 18 does not reliably serialize its
  // boolean JSX prop into the DOM attribute — same pattern as
  // `UserActionCard.tsx`.
  //
  // Node-aware on purpose. `EntryShell` drops and restores the switcher when
  // the user leaves Home and comes back, so the wrapper this applies to can be
  // replaced while one lock is still running. A ref snapshot plus an effect
  // keyed only on the lock would leave the replacement live and the node that
  // left still marked. React re-runs a callback ref whenever its identity
  // changes — which the lock does — calling it with null for the outgoing node
  // first, so both halves land here.
  const executionSwitcherNodeRef = useRef<HTMLDivElement | null>(null);
  const executionSwitcherRef = useCallback(
    (node: HTMLDivElement | null) => {
      const previous = executionSwitcherNodeRef.current;
      if (previous && previous !== node) previous.removeAttribute('inert');
      executionSwitcherNodeRef.current = node;
      if (!node) return;
      if (composerLocked) node.setAttribute('inert', '');
      else node.removeAttribute('inert');
    },
    [composerLocked],
  );

  /**
   * Stops an ACTIVATION before it reaches a locked subtree we do not own.
   * Capture phase, so the descendant's own handler never runs.
   *
   * Activation only. Swallowing every key would trap a descendant that already
   * had focus when the lock arrived — it could not Tab out or Escape — and a
   * locked composer is not a captured one. Navigation and dismissal stay the
   * user's; only "do the thing" is refused.
   */
  const ACTIVATION_KEYS = new Set([' ', 'Spacebar', 'Enter']);
  function swallowWhileLocked(event: ReactSyntheticEvent) {
    if (!composerLocked) return;
    if (event.type === 'keydown') {
      const key = (event as ReactKeyboardEvent).key;
      if (!ACTIVATION_KEYS.has(key)) return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function whenUnlocked<A extends unknown[], R>(
    fn: ((...args: A) => R) | undefined,
  ): (...args: A) => R | undefined {
    return (...args: A) => (composerLocked ? undefined : fn?.(...args));
  }
  const sendBusyLabel = jevChoosing
    ? t('homeHero.jevChooses.choosing')
    : t('chat.comments.sending');
  // An attachment alone is a valid send everywhere else on Home — but Jev is
  // asked to read a BRIEF, and `POST /api/agency/route` refuses an empty one.
  // Where Jev actually routes, the text IS the request, so Send waits for it.
  // Off Prototype the mode is dormant and Send is the ordinary Home send, so
  // the rule follows the routing condition rather than the persisted flag.
  const jevWillRoute = jevChoosesActive && activeChipId === 'prototype';
  const hasSubmittableBrief = jevWillRoute
    ? prompt.trim().length > 0
    : prompt.trim().length > 0 || stagedFiles.length > 0 || Boolean(intake?.pendingIds.length);
  const canSubmit = hasSubmittableBrief && !submitDisabled && !sendBusy;
  const previewHomeFile = useMemo(() => {
    if (!previewHomeFileKey) return null;
    return stagedFiles.find((file, index) => homeFileKey(file, index) === previewHomeFileKey) ?? null;
  }, [previewHomeFileKey, stagedFiles]);
  const previewHomeFileUrl = previewHomeFileKey ? stagedFilePreviewUrls.get(previewHomeFileKey) ?? null : null;
  // "Build with Jev" sends a client brief, not an agent prompt, so the
  // composer asks for one.
  const jevSiteActive = activeChipId === JEV_SITE_CHIP_ID;
  const placeholder = jevSiteActive
    ? t('homeHero.jevSite.placeholder')
    : t('homeHero.placeholder');
  const mentionActive = Boolean(mentionTrigger);
  const mentionQuery = mentionTrigger?.query ?? '';
  const sendEnabled = canSubmit;
  function handleSend() {
    if (sendBusy || submitDisabled) return;
    if (canSubmit) {
      notifyCompletionFeedbackGesture();
      onSubmit();
      return;
    }
  }
  const fileMatches = useMemo(
    () =>
      mentionActive
        ? stagedFiles
            .map((file, index) => ({ file, index }))
            .filter(({ file }) => fileMatchesQuery(file, mentionQuery))
        : [],
    [mentionActive, mentionQuery, stagedFiles],
  );
  const pluginMatches = useMemo(
    () =>
      mentionActive
        ? pluginOptions.filter(
            (plugin) => isUserFacingPluginOption(plugin)
              && pluginMatchesQuery(plugin, mentionQuery, locale),
          )
        : [],
    [locale, mentionActive, mentionQuery, pluginOptions],
  );
  const skillMatches = useMemo(
    () =>
      mentionActive
        ? skillOptions.filter((skill) => skillMatchesQuery(skill, mentionQuery, locale))
        : [],
    [locale, mentionActive, mentionQuery, skillOptions],
  );
  const mcpMatches = useMemo(
    () =>
      mentionActive
        ? mcpOptions.filter((server) => mcpServerMatchesQuery(server, mentionQuery)).slice(0, 6)
        : [],
    [mcpOptions, mentionActive, mentionQuery],
  );
  const connectorMatches = useMemo(
    () =>
      mentionActive
        ? connectorOptions.filter((connector) => connectorMatchesQuery(connector, mentionQuery)).slice(0, 6)
        : [],
    [connectorOptions, mentionActive, mentionQuery],
  );
  // Three layers keep this shut under the lock, because one dismiss only
  // clears what happened to be open at that instant: the picker cannot render
  // (here), a fresh trigger is refused (`handleTrigger`), and an option cannot
  // be activated even if one were somehow on screen (`onMouseDown` below).
  const pickerOpen = active && mentionActive && !composerLocked;
  const tabs: Array<{ id: HomeMentionTab; label: string; count: number }> = [
    // The All overview previews at most HOME_MENTION_ALL_TAB_PREVIEW files, so
    // its badge counts the previewed slice — not the full staged total — to keep
    // the count aligned with what that tab actually renders. The dedicated files
    // tab below lists every match and reports the true total.
    { id: 'all', label: t('common.all'), count: Math.min(fileMatches.length, HOME_MENTION_ALL_TAB_PREVIEW) + pluginMatches.length + skillMatches.length + mcpMatches.length + connectorMatches.length },
    { id: 'files', label: t('chat.mentionTabFiles'), count: fileMatches.length },
    { id: 'plugins', label: t('entry.navPlugins'), count: pluginMatches.length },
    { id: 'skills', label: t('homeHero.skills'), count: skillMatches.length },
    { id: 'mcp', label: 'MCP', count: mcpMatches.length },
    { id: 'connectors', label: 'Connectors', count: connectorMatches.length },
  ];
  const showFiles = mentionTab === 'all' || mentionTab === 'files';
  const showPlugins = mentionTab === 'all' || mentionTab === 'plugins';
  const showSkills = mentionTab === 'all' || mentionTab === 'skills';
  const showMcp = mentionTab === 'all' || mentionTab === 'mcp';
  const showConnectors = mentionTab === 'all' || mentionTab === 'connectors';
  const visibleSections: HomeMentionSection[] = [
    showFiles
      ? {
          id: 'files',
          label: t('chat.mentionSectionFiles'),
          options: (mentionTab === 'files' ? fileMatches : fileMatches.slice(0, HOME_MENTION_ALL_TAB_PREVIEW)).map(({ file, index }) => ({
            id: `file-${index}-${file.name}`,
            icon: isImageFile(file) ? 'image' : 'file',
            title: file.name,
            description: file.type || t('chat.mentionTabFiles'),
            meta: formatFileSize(file.size),
            onPick: () => pickFile(file),
          })),
        }
      : null,
    showPlugins
      ? {
          id: 'plugins',
          label: t('entry.navPlugins'),
          options: pluginMatches.map((plugin) => ({
            id: `plugin-${plugin.id}`,
            icon: 'sparkles',
            title: localizePluginTitle(locale, plugin),
            description: localizePluginDescription(locale, plugin) || plugin.id,
            meta: pendingPluginId === plugin.id ? t('homeHero.applying') : getPluginSourceLabel(plugin),
            pluginRecord: plugin,
            disabled: pendingPluginId !== null,
            onPick: () => pickPlugin(plugin),
          })),
        }
      : null,
    showSkills
      ? {
          id: 'skills',
          label: t('homeHero.skills'),
          options: skillMatches.map((skill) => ({
            id: `skill-${skill.id}`,
            icon: skill.id === activeSkillId ? 'check' : 'file',
            title: localizeSkillName(locale, skill),
            description: localizeSkillDescription(locale, skill) || skill.id,
            meta: skill.id === activeSkillId ? t('common.active') : skill.mode,
            onPick: () => pickSkill(skill),
          })),
        }
      : null,
    showMcp
      ? {
          id: 'mcp',
          label: 'MCP',
          options: mcpMatches.map((server) => ({
            id: `mcp-${server.id}`,
            icon: 'link',
            title: server.label || server.id,
            description: server.url || server.command || server.id,
            meta: server.transport,
            onPick: () => pickMcp(server),
          })),
        }
      : null,
    showConnectors
      ? {
          id: 'connectors',
          label: 'Connectors',
          options: connectorMatches.map((connector) => ({
            id: `connector-${connector.id}`,
            icon: 'link',
            title: connector.name,
            description: connector.description || connector.provider || connector.id,
            meta: connector.accountLabel ?? connector.provider,
            onPick: () => pickConnector(connector),
          })),
        }
      : null,
  ].filter((section): section is HomeMentionSection => Boolean(section?.options.length));
  const visiblePickerOptions = visibleSections.flatMap((section) => section.options);
  const visibleLoading =
    (mentionTab === 'all' && (pluginsLoading || skillsLoading || mcpLoading)) ||
    (mentionTab === 'plugins' && pluginsLoading) ||
    (mentionTab === 'skills' && skillsLoading) ||
    (mentionTab === 'mcp' && mcpLoading);
  const promptMentionEntities = useMemo(
    () =>
      buildHomeMentionEntities({
        activePluginRecord,
        activeSkillId,
        activeSkillTitle,
        mcpOptions,
        pluginOptions,
        connectorOptions,
        contextWorkspaceItems,
        selectedPluginContexts,
        stagedFiles,
        skillOptions,
      }),
    [
      activePluginRecord,
      activeSkillId,
      activeSkillTitle,
      mcpOptions,
      pluginOptions,
      connectorOptions,
      contextWorkspaceItems,
      selectedPluginContexts,
      stagedFiles,
      skillOptions,
    ],
  );
  const fieldByName = useMemo(
    () => new Map(pluginInputFields.map((field) => [field.name, field])),
    [pluginInputFields],
  );
  const footerInputNameSet = useMemo(
    () => new Set(footerInputNames),
    [footerInputNames],
  );
  const footerInputFields = useMemo(
    () => footerInputNames
      .map((name) => fieldByName.get(name))
      .filter((field): field is InputFieldSpec => Boolean(field)),
    [fieldByName, footerInputNames],
  );
  const activeCreateChip = useMemo(
    () => activeChipId
      ? chipsForGroup('create').find((chip) => chip.id === activeChipId) ?? null
      : null,
    [activeChipId],
  );
  // Footer Template picker options: the ordered create-scenario chips (pure
  // project-type templates — Slides / Prototype / Wireframe / Document / …).
  // Excludes action chips (Brand Kit / Figma) that navigate away instead of
  // seeding a template, so the dropdown matches the rail's template set.
  const templateChips = useMemo(
    () => orderedCreateChips().filter((chip) => chip.action.kind === 'apply-scenario'),
    [],
  );
  // The type pills lead with "Build with Jev": it is not a template (it binds
  // no scenario plugin), but it is a way to create, and pinning it first keeps
  // it on screen however narrow the row gets.
  const typePillChips = useMemo(() => {
    const jevSite = findChip(JEV_SITE_CHIP_ID);
    return jevSite ? [jevSite, ...templateChips] : templateChips;
  }, [templateChips]);
  // A surface outside the hero (e.g. the workspace tabs-bar) can hand off a
  // template pick through this window event; apply the chip exactly as if it
  // was clicked here. Deliberately depless (re-subscribes each render) so the
  // listener always sees the current handlers without threading them through
  // refs.
  useEffect(() => {
    function onApplyTemplate(event: Event) {
      const chipId = (event as CustomEvent<{ chipId?: string }>).detail?.chipId;
      if (!chipId) return;
      const chip = templateChips.find((item) => item.id === chipId);
      if (chip) handlePickTaskChip(chip);
    }
    window.addEventListener(HOME_APPLY_TEMPLATE_EVENT, onApplyTemplate);
    return () => window.removeEventListener(HOME_APPLY_TEMPLATE_EVENT, onApplyTemplate);
  });
  const activeExamplePlugins = useMemo(
    () =>
      activeChipId
        ? homeHeroExamplePluginsForChip(activeChipId, pluginOptions, locale)
        : [],
    [activeChipId, locale, pluginOptions],
  );
  // Derive sub-category pills from the FULL install set so the rail mirrors the
  // Community section exactly — same sub-category set and same order. (Earlier
  // this read only `activeExamplePlugins` to guarantee non-empty slices, but
  // that left the rail showing fewer types than Community; the empty case is
  // now handled by the full-catalog fallback in `filteredExamplePlugins`.)
  const activeSubChips = useMemo(
    () => subChipsForChip(activeChipId, pluginOptions),
    [activeChipId, pluginOptions],
  );
  // Prototype is organised by the Website Shape Atlas, not by the catalog's
  // keyword facets: its row is the nine spines, and its cards are websites.
  const prototypeActive = activeChipId === 'prototype';
  const spineChips = useMemo(() => prototypeSpineChips(), []);
  const websiteCards = useMemo(
    () => (prototypeActive ? buildWebsiteCards(pluginOptions, designIndexProfiles) : []),
    [prototypeActive, pluginOptions, designIndexProfiles],
  );
  const visibleWebsiteCards = useMemo(
    () => websiteCardsForSpine(websiteCards, prototypeSpineCode),
    [websiteCards, prototypeSpineCode],
  );
  const subTypeRowChips = prototypeActive ? spineChips : activeSubChips;
  const subTypeRowSelection = prototypeActive ? prototypeSpineCode : selectedSubcategory;
  // When a sub-category pill is active, show the SAME set the Community section
  // shows for that sub-category — every matching plugin from the full install
  // set, in the same visual-appeal order — rather than the small curated
  // example showcase. This keeps the example-prompt count consistent with the
  // Community count badge (e.g. Brand / design shows all 16, not just 1).
  // Atoms are excluded to match Community's `visiblePlugins` derivation, and
  // `applyFacetSelection` is the exact filter Community uses — it requires the
  // plugin's primary category to be this chip AND match the sub-category, so a
  // deck/image plugin that merely carries a "brand" tag is not pulled in.
  const filteredExamplePlugins = useMemo(() => {
    if (!selectedSubcategory || !isSubChipParent(activeChipId)) return activeExamplePlugins;
    // Mobile shares the existing Apps facet. Wireframe is a generation
    // constraint rather than a plugin taxonomy, so keep the Prototype starter
    // pool visible while the selected action carries its lo-fi metadata.
    const facetSubcategory =
      activeChipId === 'prototype' && selectedSubcategory === 'mobile'
        ? 'app-prototypes'
        : activeChipId === 'prototype' && selectedSubcategory === 'wireframe'
          ? null
          : selectedSubcategory;
    if (!facetSubcategory) return activeExamplePlugins;
    const pool = pluginOptions.filter((plugin) => plugin.manifest?.od?.kind !== 'atom');
    return sortByVisualAppeal(
      applyFacetSelection(pool, { category: activeChipId, subcategory: facetSubcategory }),
    );
  }, [activeExamplePlugins, activeChipId, selectedSubcategory, pluginOptions]);

  // First-run guide, beat 1: pulse the Prototype chip for brand-new users only
  // when Home could not bind a default type. A successfully seeded default has
  // already completed that choice, so skip the redundant pulse and let beat 2
  // guide the user to its first example card.
  // The settle delay lets the hero finish its entrance before the sheen.
  useEffect(() => {
    if (firstRunGuide !== true) return;
    if (readHomeGuideStage() !== 'chip') return;
    if (activeChipId) {
      writeHomeGuideStage('card');
      setGuidePulseChipId(null);
      return;
    }
    const arm = window.setTimeout(() => setGuidePulseChipId('prototype'), 900);
    const disarm = window.setTimeout(() => setGuidePulseChipId(null), 3600);
    return () => {
      window.clearTimeout(arm);
      window.clearTimeout(disarm);
    };
  }, [firstRunGuide, activeChipId]);

  // Users with existing projects never see the trail — complete ANY
  // unfinished stage silently. A chip pick during the loading window can
  // move the stage to 'card' before we know the user is not new, so 'chip'
  // alone is not enough to close off.
  useEffect(() => {
    if (firstRunGuide !== false) return;
    if (readHomeGuideStage() !== 'done') writeHomeGuideStage('done');
  }, [firstRunGuide]);

  const activePromptExamples = useMemo(
    () => activeChipId && activeExamplePlugins.length === 0
      ? homeHeroChipPromptExamples(activeChipId, locale)
      : [],
    [activeChipId, activeExamplePlugins.length, locale],
  );

  // Beat 2: once the picked chip's example cards render, pulse the first
  // card exactly once, then the trail is done (the send pulse takes over
  // after a card pick).
  useEffect(() => {
    if (firstRunGuide !== true) return;
    if (readHomeGuideStage() !== 'card') return;
    // Either card surface counts: plugin preset tiles, or the static
    // prompt-example fallback a presetless chip renders instead.
    const hasExampleCards =
      filteredExamplePlugins.length > 0 ||
      activePromptExamples.length > 0 ||
      visibleWebsiteCards.length > 0;
    if (!activeChipId || !hasExampleCards) return;
    const arm = window.setTimeout(() => {
      setGuidePulseFirstPreset(true);
      writeHomeGuideStage('done');
    }, 500);
    const disarm = window.setTimeout(() => setGuidePulseFirstPreset(false), 3200);
    return () => {
      window.clearTimeout(arm);
      window.clearTimeout(disarm);
    };
  }, [
    firstRunGuide,
    activeChipId,
    filteredExamplePlugins.length,
    activePromptExamples.length,
    visibleWebsiteCards.length,
  ]);
  const authoringLayoutActive =
    activeChipId === 'create-plugin' || pendingChipId === 'create-plugin';
  const promptMaxHeight = authoringLayoutActive
    ? HOME_HERO_AUTHORING_PROMPT_MAX_HEIGHT
    : HOME_HERO_PROMPT_MAX_HEIGHT;
  const inputCardStyle = {
    '--home-hero-prompt-max-height': `${promptMaxHeight}px`,
  } as CSSProperties;

  useEffect(() => {
    if (selectedIndex >= visiblePickerOptions.length) setSelectedIndex(0);
  }, [selectedIndex, visiblePickerOptions.length]);

  useEffect(() => {
    if (!pickerOpen) setHoveredPlugin(null);
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const isInsideMentionSurface = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      return (
        promptEditorRef.current?.contains(target) ||
        mentionPickerRef.current?.contains(target)
      );
    };
    const closePicker = () => {
      setMentionTrigger(null);
      setMentionTab('all');
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!isInsideMentionSurface(event.target)) closePicker();
    };
    const closeOnOutsideMouse = (event: MouseEvent) => {
      if (!isInsideMentionSurface(event.target)) closePicker();
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      if (!isInsideMentionSurface(event.target)) closePicker();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('mousedown', closeOnOutsideMouse, true);
    document.addEventListener('focusin', closeOnOutsideFocus);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('mousedown', closeOnOutsideMouse, true);
      document.removeEventListener('focusin', closeOnOutsideFocus);
    };
  }, [pickerOpen]);

  useEffect(() => {
    setSelectedPromptExample(null);
    setLocalSelectedSubcategory(null);
    setPrototypeSpineCode(null);
  }, [activeChipId]);

  useEffect(() => {
    if (!shortcutsOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && shortcutsMenuRef.current?.contains(target)) return;
      // The dropdown is portaled to <body>, so it's outside shortcutsMenuRef;
      // recognize it explicitly or a click on a menu item would close the menu
      // before the item's handler runs.
      if (target instanceof Element && target.closest('[data-shortcuts-panel]')) return;
      setShortcutsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShortcutsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [shortcutsOpen]);

  useEffect(() => {
    const urls = new Map<string, string>();
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      stagedFiles.forEach((file, index) => {
        if (isImageFile(file)) urls.set(homeFileKey(file, index), URL.createObjectURL(file));
      });
    }
    setStagedFilePreviewUrls(urls);
    return () => {
      if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [stagedFiles]);

  useEffect(() => {
    if (previewHomeFileKey && !previewHomeFile) setPreviewHomeFileKey(null);
  }, [previewHomeFileKey, previewHomeFile]);

  useEffect(() => {
    if (!previewHomeFileKey) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setPreviewHomeFileKey(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewHomeFileKey]);

  // Shared by the imperative pulseSend() handle (plugin Use / preset picks
  // routed through HomeView) and the component-internal static
  // prompt-example path — every "composer just got seeded" flow shows the
  // same Send cue.
  function triggerSendAttention() {
    // Drop the class for a frame so a pulse requested mid-animation
    // restarts instead of being swallowed.
    setSendAttention(false);
    requestAnimationFrame(() => setSendAttention(true));
  }

  useImperativeHandle(
    ref,
    (): HomeHeroHandle => ({
      focus() {
        editorRef.current?.focus();
      },
      focusEnd() {
        editorRef.current?.focus();
      },
      pulseSend() {
        triggerSendAttention();
      },
    }),
    [],
  );

  // Insert an atomic @mention pill at the active trigger and return the
  // editor's new serialized text. The pill replaces the in-flight `@query`
  // (Lexical's insertMention handles the range), so callers can forward the
  // resulting text to the host pick handler without computing offsets.
  function insertHomeMention(token: string, entity: InlineMentionEntity): string {
    editorRef.current?.insertMention({ token, entity });
    return editorRef.current?.getText() ?? prompt;
  }

  function pickPlugin(record: InstalledPluginRecord) {
    const token = pluginMentionText(record);
    const next = insertHomeMention(token, {
      id: record.id,
      kind: 'plugin',
      label: record.title,
      token,
    });
    onPickPlugin(record, next);
  }

  function pickFile(file: File) {
    const token = inlineMentionToken(file.name);
    insertHomeMention(token, { id: file.name, kind: 'file', label: file.name, token });
    setSelectedIndex(0);
    // The file is already staged; the editor's onChange has updated the
    // prompt text, so there is nothing else to forward to the host.
  }

  function pickSkill(skill: SkillSummary) {
    const token = inlineMentionToken(skill.name);
    const next = insertHomeMention(token, {
      id: skill.id,
      kind: 'skill',
      label: skill.name,
      token,
    });
    onPickSkill(skill, next);
  }

  function pickMcp(server: McpServerConfig) {
    const label = server.label || server.id;
    const token = inlineMentionToken(label);
    const next = insertHomeMention(token, { id: server.id, kind: 'mcp', label, token });
    onPickMcp(server, next);
  }

  function pickConnector(connector: ConnectorDetail) {
    const token = inlineMentionToken(connector.name);
    const next = insertHomeMention(token, {
      id: connector.id,
      kind: 'connector',
      label: connector.name,
      token,
    });
    onPickConnector(connector, next);
  }

  function insertInlineMentionSeparator() {
    const current = editorRef.current?.getText() ?? prompt;
    if (current.trim() && !/\s$/.test(current)) {
      editorRef.current?.insertText(' ');
    }
  }

  function appendWorkspacePrompt(item: WorkspaceContextItem) {
    if (composerLocked) return;
    onAddWorkspaceContext(item);
    insertInlineMentionSeparator();
    editorRef.current?.insertMention({
      token: inlineMentionToken(item.label),
      entity: { id: item.id, kind: 'workspace', label: item.label },
    });
    onPromptChange(editorRef.current?.getText() ?? prompt);
    dismissMentionPicker();
    requestAnimationFrame(() => editorRef.current?.focus());
  }

  function handleReferenceProjects(selections: ProjectReferenceSelection[]) {
    for (const selection of selections) {
      const path = selection.resolvedDir.trim();
      const label = selection.project.name || selection.project.id;
      appendWorkspacePrompt(
        {
          id: `project:${selection.project.id}`,
          kind: 'project',
          label,
          title: label,
          path: selection.project.id,
          ...(path ? { absolutePath: path } : {}),
        }
      );
    }
    setProjectReferenceOpen(false);
    trackContextLinkResult(analytics.track, {
      page_name: 'home',
      area: 'chat_composer',
      context_kind: 'project',
      result: 'success',
      count: selections.length,
    });
  }

  async function handleLinkLocalCodeContext() {
    const selected = await onPickLocalCodeDir?.();
    if (!selected) {
      trackContextLinkResult(analytics.track, {
        page_name: 'home',
        area: 'chat_composer',
        context_kind: 'local_code',
        result: 'cancelled',
      });
      return;
    }
    const label = selected.split(/[/\\]/).filter(Boolean).pop() || selected;
    appendWorkspacePrompt(
      {
        id: `local-code:${selected}`,
        kind: 'local-code',
        label,
        title: label,
        path: selected,
        absolutePath: selected,
      }
    );
    trackContextLinkResult(analytics.track, {
      page_name: 'home',
      area: 'chat_composer',
      context_kind: 'local_code',
      result: 'success',
      count: 1,
    });
  }

  function mishSystemPicker() {
    const trigger = homeHeroRef.current?.querySelector<HTMLButtonElement>(
      '[data-testid="home-hero-design-system-trigger"]',
    );
    if (!trigger || trigger.disabled) return;
    window.requestAnimationFrame(() => {
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      trigger.focus({ preventScroll: true });
    });
  }

  // Lexical reports the active @-trigger derived from the caret. HomeHero
  // has no slash surface, so only the mention branch is wired.
  function handleTrigger({
    mention: nextMention,
    anchorRect,
  }: {
    mention: { q: string } | null;
    slash: { q: string } | null;
    anchorRect: CaretRect | null;
  }) {
    if (!active || composerLocked) {
      // The editor reports a trigger whenever the caret moves, including from
      // an update that was already queued when the lock landed. Refusing it
      // here is what stops the picker coming back after the dismiss.
      setCaretRect(null);
      setMentionTrigger(null);
      setMentionTab('all');
      return;
    }
    setCaretRect(anchorRect);
    if (nextMention) {
      setMentionTrigger((prev) => {
        if (!prev || prev.query !== nextMention.q) setSelectedIndex(0);
        return { query: nextMention.q };
      });
    } else {
      setMentionTrigger(null);
      setMentionTab('all');
    }
  }

  function dismissMentionPicker() {
    setMentionTrigger(null);
    setMentionTab('all');
    setHoveredPlugin(null);
    setSelectedIndex(0);
    setCaretRect(null);
  }

  useEffect(() => {
    if (!active) dismissMentionPicker();
  }, [active]);

  // A picker opened before Send keeps every file, plugin, skill, MCP and
  // connector option mounted and callable; the lock has to reach it too. It
  // reopens the moment the user types `@` again.
  useEffect(() => {
    if (composerLocked) dismissMentionPicker();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerLocked]);

  // Routes popover navigation keys from the Lexical editor over the visible
  // picker option union. Returns true when consumed so the editor can
  // preventDefault.
  function handlePopoverKey(
    key: 'ArrowDown' | 'ArrowUp' | 'Tab' | 'Enter' | 'Escape',
  ): boolean {
    if (!mentionActive) return false;
    if (key === 'Escape') {
      setMentionTrigger(null);
      return true;
    }
    if (visiblePickerOptions.length === 0) return false;
    if (key === 'ArrowDown') {
      setSelectedIndex((idx) => (idx + 1) % visiblePickerOptions.length);
      return true;
    }
    if (key === 'ArrowUp') {
      setSelectedIndex(
        (idx) => (idx - 1 + visiblePickerOptions.length) % visiblePickerOptions.length,
      );
      return true;
    }
    if (key === 'Tab' || key === 'Enter') {
      const selected = visiblePickerOptions[selectedIndex] ?? visiblePickerOptions[0];
      if (selected && !selected.disabled) selected.onPick();
      return true;
    }
    return false;
  }

  function handleFiles(files: File[]) {
    if (composerLocked) return;
    if (files.length === 0) return;
    if (intake) intake.add(files, { destination: { kind: 'pending' }, context: intake.target.context }, { toMessage: true });
    else onAddFiles(files);
  }

  // "Import from library": the home composer has no project yet, so we fetch
  // each picked asset's bytes and stage them as regular files. They ride the
  // existing upload-on-submit path into the new project's design files.
  async function importLibraryAssets(assets: LibraryAsset[]) {
    const files: File[] = [];
    for (const asset of assets) {
      const file = await fileFromLibraryAsset(asset);
      if (file) files.push(file);
    }
    handleFiles(files);
  }

  function removeFileChip(index: number, file: File) {
    if (composerLocked) return;
    const nextPrompt = stripHomeMentionToken(prompt, file.name);
    if (nextPrompt !== prompt) onPromptChange(nextPrompt);
    onRemoveFile(index);
  }

  function usePromptExample(example: string) {
    trackHomeChatComposerClick(analytics.track, {
      page_name: 'home',
      area: 'chat_composer',
      element: 'example_prompt',
      chip_id: activeChipId ?? 'prototype',
    });
    setSelectedPromptExample({
      label: promptExampleChipLabel(example),
      promptText: example,
    });
    onExamplePromptStatusChange?.({
      title: promptExampleChipLabel(example),
      artifactType: activeChipId ?? 'prototype',
      brief: briefForChipId(activeChipId ?? 'prototype'),
    });
    onPromptChange(example);
    editorRef.current?.setText(example);
    setSelectedIndex(0);
    requestAnimationFrame(() => editorRef.current?.focus());
    triggerSendAttention();
  }

  function pickExamplePluginPreset(record: InstalledPluginRecord, chipId: string, promptText: string) {
    trackHomeChatComposerClick(analytics.track, {
      page_name: 'home',
      area: 'chat_composer',
      element: 'example_prompt',
      chip_id: chipId,
      plugin_id: record.sourceMarketplaceEntryName ?? record.id,
      plugin_type: record.marketplaceTrust ?? 'official',
    });
    setSelectedPromptExample({
      label: record.title,
      promptText,
    });
    onExamplePromptStatusChange?.({
      title: record.title,
      artifactType: chipId,
      brief: briefForPluginPreset(record, chipId),
    });
    onPickExamplePlugin(record, chipId, promptText);
  }

  // The Prototype strip's pinned card. It clears the example-prompt marker a
  // card pick may have staged: that marker rides the create payload as
  // `examplePromptContext` and claims the project is a curated example send,
  // which is exactly the legacy path this mode must never take. The editor's
  // own onChange only clears it when the text changes, and a family card's
  // seeded brief can go to Jev unedited.
  function pickJevChoosesCard() {
    setSelectedPromptExample(null);
    onExamplePromptStatusChange?.(null);
    onPickJevChooses?.();
  }

  // A stored design reference. Deliberately NOT routed through
  // `pickExamplePluginPreset`: that path tracks an installed preset, stamps the
  // example-prompt status line and marks the pick as an example choice. A
  // reference binds a family generator only when the router resolved one, and
  // carries its own single analytics emission keyed on the profile digest.
  function pickDesignReference(profile: DesignProfile) {
    const familyId = referenceFamilyId(profile);
    const familyRecord = familyPluginRecord(pluginOptions, familyId);
    trackHomeChatComposerClick(analytics.track, {
      page_name: 'home',
      area: 'chat_composer',
      element: 'design_reference',
      chip_id: activeChipId ?? 'prototype',
      reference_id: profile.source?.digest ?? '',
      // The routed family is a property of the PROFILE, so it is reported
      // whether or not its generator is installed: an uninstalled family is
      // exactly the case the funnel needs to see.
      ...(familyId ? { routed_family_id: familyId } : {}),
      ...(familyRecord
        ? {
            plugin_id: familyRecord.sourceMarketplaceEntryName ?? familyRecord.id,
            plugin_type: familyRecord.marketplaceTrust ?? 'official',
          }
        : {}),
    });
    onPickDesignReference?.(profile, referenceSeedPrompt(profile), familyRecord);
  }

  // The task-type rail (原型 / 幻灯片 / HyperFrames / 视频 / …). Records which
  // task type the user picked before delegating to the host's chip handler.
  function handlePickTaskChip(chip: HomeHeroChip) {
    trackHomeChatComposerClick(analytics.track, {
      page_name: 'home',
      area: 'chat_composer',
      element: 'task_chip',
      chip_id: chip.id,
    });
    // First chip pick completes the guide's first beat; the preset-card
    // pulse arms once the example cards for this chip render.
    if (readHomeGuideStage() === 'chip') {
      writeHomeGuideStage('card');
      setGuidePulseChipId(null);
    }
    onPickChip(chip);
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!claimNativeFileDrop(event)) return;
    if (composerLocked) return;
    setDragActive(false);
    if (intake) {
      void intake.acceptDrop(collectDroppedFiles(event.nativeEvent), { destination: { kind: 'pending' }, context: intake.target.context }, { toMessage: true });
    } else handleFiles(Array.from(event.dataTransfer.files ?? []));
  }

  function openActivePluginDetails() {
    if (activePluginRecord) onOpenPluginDetails(activePluginRecord);
  }

  function openActiveSkillDetails() {
    if (activeSkillRecord) onOpenSkillDetails(activeSkillRecord);
  }

  // Inline-backed plugin/MCP/connector contexts already render as @mention pills
  // in the editor. This row should mount only for content that has a visible chip
  // here; the aggregate context count is just an aria label when the row exists.
  const showActivePluginRow = Boolean(showActivePluginChip && activePluginTitle);
  const showActiveContextRow =
    stagedFiles.length > 0 ||
    Boolean(intake?.pendingMessageFiles.length) ||
    showActivePluginRow ||
    Boolean(activeSkillTitle) ||
    contextOnlyPlugins.length > 0 ||
    contextOnlyMcpServers.length > 0 ||
    contextOnlyConnectors.length > 0 ||
    contextWorkspaceItems.length > 0;
  let optionRenderIndex = 0;

  return (
    <section ref={homeHeroRef} className="home-hero" data-testid="home-hero">
      {/* #5517 hero header: the Mishh Mashh logotype replaces the small
          brand-mark + name pair, and the tagline subtitle is dropped. The
          static wordmark is now a WebGL pixel-scan effect (round 7) — the
          title heading below it is dropped too, since the animated wordmark
          alone carries the brand moment. */}
      <span className="home-hero__logo-wrap">
        <PixelScanLogo className="home-hero__logo home-hero__logo--tiles" />
      </span>

      {/* Capsule type row: the 10 top-level create-scenario types as pill chips above
          the composer (per product — replaces the fanned card carousel); the
          selected pill carries the accent tint, click switches. */}
      <TypePillRow
        chips={typePillChips}
        activeChipId={activeChipId}
        disabled={pluginsLoading || pendingChipId !== null || pendingPluginId !== null || jevChoosing}
        labelFor={(id) => homeHeroChipLabel(id, t)}
        onPick={handlePickTaskChip}
      />

      {/* #5517 wraps the input card + workdir row into one visible composer
          card so they read as a single surface. */}
      <div className="home-hero__composer-card">
      <div
        className={`home-hero__input-card${
          authoringLayoutActive ? ' home-hero__input-card--compact-authoring' : ''
        }${dragActive ? ' is-drag-active' : ''}`}
        style={inputCardStyle}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes('Files')) setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
          setDragActive(false);
        }}
        data-native-file-drop
        onDrop={handleDrop}
      >
        {showActiveContextRow ? (
          <div
            className="home-hero__active"
            aria-label={
              contextItemCount > 0
                ? t('homeHero.contextItemsResolved', { n: contextItemCount })
                : undefined
            }
          >
            {intake?.pendingMessageFiles.length ? <span className="home-hero__active-file-group" data-testid="home-hero-intake-files">
              {intake.pendingMessageFiles.map(file => <span key={`${file.batchId}:${file.clientFileId}`} className="home-hero__active-chip home-hero__active-chip--context home-hero__active-chip--file" title={`${file.filename} · ${formatFileSize(file.size)}`}>
                <Icon name="file" size={14} /><span className="home-hero__active-label">{file.filename}</span>
                <button type="button" className="home-hero__active-chip-remove" disabled={composerLocked} aria-label={t('chat.removeAria', { name: file.filename })} onClick={() => intake.removePending(file.batchId, file.clientFileId)}><Icon name="close" size={12} /></button>
              </span>)}
            </span> : null}
            {stagedFiles.length > 0 ? (
              <span className="home-hero__active-file-group" data-testid="home-hero-staged-files">
                {stagedFiles.map((file, index) => {
                  const key = homeFileKey(file, index);
                  const previewUrl = stagedFilePreviewUrls.get(key) ?? null;
                  const fileBody = (
                    <>
                      {previewUrl ? (
                        <img
                          className="home-hero__active-thumb"
                          src={previewUrl}
                          alt=""
                          aria-hidden
                          draggable={false}
                        />
                      ) : (
                        <span className="home-hero__active-icon" aria-hidden>
                          <Icon name={isImageFile(file) ? 'image' : 'file'} size={12} />
                        </span>
                      )}
                      <span className="home-hero__active-label">{file.name}</span>
                      <span className="home-hero__active-meta">{formatFileSize(file.size)}</span>
                    </>
                  );
                  return (
                    <span
                      key={key}
                      className="home-hero__active-chip home-hero__active-chip--context home-hero__active-chip--file"
                      title={`${file.name} · ${formatFileSize(file.size)}`}
                    >
                      <span className="home-hero__active-order" aria-label={`Attachment ${index + 1}`}>
                        {index + 1}
                      </span>
                      {previewUrl ? (
                        <button
                          type="button"
                          className="home-hero__active-chip-body home-hero__active-file-body"
                          onClick={() => setPreviewHomeFileKey(key)}
                          aria-label={`Preview ${file.name}`}
                        >
                          {fileBody}
                        </button>
                      ) : (
                        <span className="home-hero__active-file-body">
                          {fileBody}
                        </span>
                      )}
                      <button
                        type="button"
                        className="home-hero__active-clear od-tooltip"
                        disabled={composerLocked}
                        onClick={() => removeFileChip(index, file)}
                        aria-label={t('chat.removeAria', { name: file.name })}
                        title={t('homeHero.removeFile')}
                        data-tooltip={t('homeHero.removeFile')}
                      >
                        <Icon name="close" size={9} />
                      </button>
                    </span>
                  );
                })}
              </span>
            ) : null}
            {showActivePluginRow ? (
              <span className="home-hero__active-chip" data-testid="home-hero-active-plugin">
                <button
                  type="button"
                  className="home-hero__active-chip-body"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    openActivePluginDetails();
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    openActivePluginDetails();
                  }}
                  onClick={openActivePluginDetails}
                  disabled={!activePluginRecord}
                  title={activePluginRecord ? t('homeHero.pluginTitle', { title: activePluginRecord.title }) : undefined}
                >
                  <span className="home-hero__active-icon" aria-hidden>
                    <Icon name="sliders" size={12} />
                  </span>
                  <span className="home-hero__active-label">{activePluginTitle}</span>
                </button>
                {activeCreateChip && !activePluginIsExplicit ? null : (
                  <button
                    type="button"
                    className="home-hero__active-clear od-tooltip"
                    disabled={composerLocked}
                    onClick={() => {
                      trackHomeChatComposerClick(analytics.track, {
                        page_name: 'home',
                        area: 'chat_composer',
                        element: 'plugin_chip_clear',
                        chip_id: activePluginRecord?.id,
                      });
                      whenUnlocked(onClearActivePlugin)();
                    }}
                    aria-label={t('homeHero.clearActivePlugin')}
                    title={t('homeHero.clearActivePlugin')}
                    data-tooltip={t('homeHero.clearActivePlugin')}
                  >
                    <Icon name="close" size={9} />
                  </button>
                )}
              </span>
            ) : null}
            {activeSkillTitle ? (
              <span
                className="home-hero__active-chip home-hero__active-chip--skill"
                data-testid="home-hero-active-skill"
              >
                <button
                  type="button"
                  className="home-hero__active-chip-body"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    openActiveSkillDetails();
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    openActiveSkillDetails();
                  }}
                  onClick={openActiveSkillDetails}
                  disabled={!activeSkillRecord}
                  title={activeSkillRecord ? activeSkillRecord.description || activeSkillTitle : undefined}
                >
                  <span className="home-hero__active-icon" aria-hidden>
                    <Icon name="sparkles" size={12} />
                  </span>
                  <span className="home-hero__active-label">{t('homeHero.skillPrefix', { title: activeSkillTitle })}</span>
                </button>
                <button
                  type="button"
                  className="home-hero__active-clear od-tooltip"
                  disabled={composerLocked}
                  onClick={whenUnlocked(onClearActiveSkill)}
                  aria-label={t('homeHero.clearActiveSkill')}
                  title={t('homeHero.clearActiveSkill')}
                  data-tooltip={t('homeHero.clearActiveSkill')}
                >
                  <Icon name="close" size={9} />
                </button>
              </span>
            ) : null}
            {contextOnlyPlugins.map((plugin) => (
              <ContextChipHoverCard
                key={`ctx-plugin-${plugin.id}`}
                className="home-hero__active-chip home-hero__active-chip--context"
                data-testid={`home-hero-context-plugin-${plugin.id}`}
                typeLabel="Plugin"
                detail={plugin.id}
              >
                <span className="home-hero__active-icon" aria-hidden>
                  <Icon name="sliders" size={12} />
                </span>
                <span className="home-hero__active-label">{plugin.title}</span>
                <button
                  type="button"
                  className="home-hero__active-clear od-tooltip"
                  disabled={composerLocked}
                  onClick={() => {
                    trackHomeChatComposerClick(analytics.track, {
                      page_name: 'home',
                      area: 'chat_composer',
                      element: 'context_remove',
                      resource_kind: 'plugin',
                      resource_id: plugin.id,
                    });
                    whenUnlocked(onRemovePluginContext)(plugin.id);
                  }}
                  aria-label={t('chat.removeAria', { name: plugin.title })}
                  title={t('common.close')}
                  data-tooltip={t('common.close')}
                  data-testid={`home-hero-context-clear-${plugin.id}`}
                >
                  <Icon name="close" size={9} />
                </button>
              </ContextChipHoverCard>
            ))}
            {contextOnlyMcpServers.map((server) => {
              const label = server.label || server.id;
              return (
                <ContextChipHoverCard
                  key={`ctx-mcp-${server.id}`}
                  className="home-hero__active-chip home-hero__active-chip--context"
                  data-testid={`home-hero-context-mcp-${server.id}`}
                  typeLabel="MCP server"
                  detail={server.url || server.id}
                >
                  <span className="home-hero__active-icon" aria-hidden>
                    <Icon name="sliders" size={12} />
                  </span>
                  <span className="home-hero__active-label">{label}</span>
                  <button
                    type="button"
                    className="home-hero__active-clear od-tooltip"
                    disabled={composerLocked}
                    onClick={() => {
                      trackHomeChatComposerClick(analytics.track, {
                        page_name: 'home',
                        area: 'chat_composer',
                        element: 'context_remove',
                        resource_kind: 'mcp',
                        resource_id: server.id,
                      });
                      whenUnlocked(onRemoveMcpContext)(server.id);
                    }}
                    aria-label={t('chat.removeAria', { name: label })}
                    title={t('common.close')}
                    data-tooltip={t('common.close')}
                    data-testid={`home-hero-context-clear-${server.id}`}
                  >
                    <Icon name="close" size={9} />
                  </button>
                </ContextChipHoverCard>
              );
            })}
            {contextOnlyConnectors.map((connector) => (
              <ContextChipHoverCard
                key={`ctx-connector-${connector.id}`}
                className="home-hero__active-chip home-hero__active-chip--context"
                data-testid={`home-hero-context-connector-${connector.id}`}
                typeLabel="Connector"
                detail={connector.provider || connector.id}
              >
                <span className="home-hero__active-icon" aria-hidden>
                  <Icon name="link" size={12} />
                </span>
                <span className="home-hero__active-label">{connector.name}</span>
                <button
                  type="button"
                  className="home-hero__active-clear od-tooltip"
                  disabled={composerLocked}
                  onClick={() => {
                    trackHomeChatComposerClick(analytics.track, {
                      page_name: 'home',
                      area: 'chat_composer',
                      element: 'context_remove',
                      resource_kind: 'connector',
                      resource_id: connector.id,
                    });
                    whenUnlocked(onRemoveConnectorContext)(connector.id);
                  }}
                  aria-label={t('chat.removeAria', { name: connector.name })}
                  title={t('common.close')}
                  data-tooltip={t('common.close')}
                  data-testid={`home-hero-context-clear-${connector.id}`}
                >
                  <Icon name="close" size={9} />
                </button>
              </ContextChipHoverCard>
            ))}
            {contextWorkspaceItems.map((item) => (
              <ContextChipHoverCard
                key={`ctx-workspace-${item.id}`}
                className="home-hero__active-chip home-hero__active-chip--context"
                data-testid={`home-hero-context-workspace-${item.id}`}
                typeLabel={workspaceContextKindLabel(item.kind)}
                detail={workspaceContextDetailLine(item)}
              >
                <span className="home-hero__active-icon" aria-hidden>
                  <Icon name={item.kind === 'local-code' ? 'terminal' : 'folder'} size={12} />
                </span>
                <span className="home-hero__active-label">{item.label}</span>
                <button
                  type="button"
                  className="home-hero__active-clear od-tooltip"
                  disabled={composerLocked}
                  onClick={() => {
                    trackHomeChatComposerClick(analytics.track, {
                      page_name: 'home',
                      area: 'chat_composer',
                      element: 'context_remove',
                      resource_kind: 'workspace',
                      resource_id: item.id,
                    });
                    // The mention strip is part of the removal, not a
                    // preamble to it: doing it first rewrote the brief Jev is
                    // reading even when the removal itself was refused.
                    whenUnlocked(() => {
                      const nextPrompt = stripHomeMentionToken(prompt, item.label);
                      if (nextPrompt !== prompt) onPromptChange(nextPrompt);
                      onRemoveWorkspaceContext(item.id);
                    })();
                  }}
                  aria-label={t('chat.removeAria', { name: item.label })}
                  title={t('common.close')}
                  data-tooltip={t('common.close')}
                  data-testid={`home-hero-context-clear-${item.id}`}
                >
                  <Icon name="close" size={9} />
                </button>
              </ContextChipHoverCard>
            ))}
          </div>
        ) : null}
        <div className="home-hero__prompt-surface">
          <div ref={promptEditorRef} className="home-hero__prompt-editor home-hero__lexical">
            <LexicalComposerInput
              ref={editorRef}
              testId="home-hero-input"
              draft={prompt}
              // The whole composer is inert while Jev is choosing: the brief in
              // the editor IS the question already asked, and editing it now
              // would only invalidate the answer on its way back.
              inputDisabled={jevChoosing}
              placeholder=""
              title={placeholder}
              steadyCaret
              knownEntities={promptMentionEntities}
              onChange={(plainText) => {
                // A programmatic seed (host setPrompt → draft prop →
                // SeedingPlugin) echoes back through Lexical's onChange. The
                // old <textarea> never fired onChange for a controlled-value
                // change, so skip the echo here: otherwise seeding would run
                // the host's handlePromptChange — flipping promptEditedByUser
                // (spurious "replace prompt?" dialogs) and re-extracting plugin
                // inputs from the seeded text. Real user edits always differ
                // from the current prompt.
                if (plainText === prompt) return;
                onPromptChange(plainText);
                if (selectedPromptExample && plainText !== selectedPromptExample.promptText) {
                  setSelectedPromptExample(null);
                  onExamplePromptStatusChange?.(null);
                }
              }}
              onTrigger={handleTrigger}
              onEnterSend={handleSend}
              onPasteFiles={handleFiles}
              popoverOpen={pickerOpen && visiblePickerOptions.length > 0}
              onPopoverKey={handlePopoverKey}
              comboboxAria={{
                expanded: pickerOpen,
                activeId: pickerOpen ? `home-hero-option-${selectedIndex}` : null,
              }}
            />

          </div>
        </div>
        <CaretFloatingLayer caret={caretRect} open={pickerOpen}>
          <div
            ref={mentionPickerRef}
            id="home-hero-context-picker"
            className="home-hero__plugin-picker home-hero__plugin-picker--floating"
            role="listbox"
            aria-label={t('homeHero.contextSearchResults')}
            data-testid="home-hero-plugin-picker"
          >
            <div className="home-hero__mention-tabs" role="tablist" aria-label={t('homeHero.contextSurfaces')}>
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={mentionTab === item.id}
                  className={`home-hero__mention-tab${mentionTab === item.id ? ' is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setMentionTab(item.id);
                    setSelectedIndex(0);
                  }}
                >
                  <span>{item.label}</span>
                  {item.count > 0 ? <span>{item.count}</span> : null}
                </button>
              ))}
            </div>
            <div className="home-hero__plugin-picker-results">
              {visibleLoading && visiblePickerOptions.length === 0 ? (
                <div className="home-hero__plugin-picker-empty">{t('homeHero.loadingContext')}</div>
              ) : null}
              {!visibleLoading && visiblePickerOptions.length === 0 ? (
                <div className="home-hero__plugin-picker-empty">
                  {mentionQuery ? (
                    <>{t('homeHero.noResults', { query: mentionQuery })}</>
                  ) : (
                    <>{t('homeHero.searchPrompt')}</>
                  )}
                </div>
              ) : null}
              {visibleSections.map((section) => (
                <div key={section.id} className="home-hero__mention-section">
                  <div className="home-hero__mention-section-label">{section.label}</div>
                  {section.options.map((item) => {
                    const optionIndex = optionRenderIndex;
                    optionRenderIndex += 1;
                    return (
                      <button
                        key={item.id}
                        id={`home-hero-option-${optionIndex}`}
                        type="button"
                        role="option"
                        aria-selected={optionIndex === selectedIndex}
                        className={`home-hero__plugin-option${
                          optionIndex === selectedIndex ? ' is-active' : ''
                        }`}
                        onMouseEnter={() => {
                          setSelectedIndex(optionIndex);
                          setHoveredPlugin(item.pluginRecord ?? null);
                        }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          if (composerLocked || item.disabled) return;
                          item.onPick();
                        }}
                        disabled={item.disabled || composerLocked}
                      >
                        <span className="home-hero__plugin-option-icon" aria-hidden>
                          <Icon name={item.icon} size={13} />
                        </span>
                        <span className="home-hero__plugin-option-main">
                          <span>{item.title}</span>
                          <span>{item.description}</span>
                        </span>
                        <span className="home-hero__plugin-option-meta">
                          {item.meta}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {hoveredPlugin ? (
                <div
                  className="home-hero__plugin-hover-card"
                  data-testid="home-hero-plugin-hover-card"
                >
                  <div>
                    <span className="home-hero__plugin-hover-kicker">
                      {getPluginSourceLabel(hoveredPlugin)}
                    </span>
                    <strong>{localizePluginTitle(locale, hoveredPlugin)}</strong>
                    <p>{localizePluginDescription(locale, hoveredPlugin) || hoveredPlugin.id}</p>
                  </div>
                  <div className="home-hero__plugin-hover-meta">
                    <span>{t('homeHero.parameters', { n: (hoveredPlugin.manifest?.od?.inputs ?? []).length })}</span>
                    {getPluginQueryPreview(hoveredPlugin) ? (
                      <span>{getPluginQueryPreview(hoveredPlugin)}</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      dismissMentionPicker();
                      onOpenPluginDetails(hoveredPlugin);
                    }}
                  >
                    {t('homeHero.details')}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </CaretFloatingLayer>
        {onImprovePrompt ? (
          <div className="home-hero__prompt-actions">
            <Button type="button" size="sm" variant="ghost" data-testid="home-improve-prompt-button"
              loading={preparingPrompt} disabled={!prompt.trim() || sendBusy || composerLocked}
              onClick={onImprovePrompt}>
              {t('workbench.improve.button')}
            </Button>
            {designBriefRevision ? (
              <Chip size="sm" trailing="×" data-testid="home-improve-prompt-attached"
                aria-label={`${t('workbench.improve.attached', { revision: designBriefRevision })}. ${t('workbench.improve.detach')}`}
                title={t('workbench.improve.detach')} onClick={onDetachDesignBrief}>
                {t('workbench.improve.attached', { revision: designBriefRevision })}
              </Chip>
            ) : null}
          </div>
        ) : null}
        <div className="home-hero__input-foot">
          <input
            ref={fileInputRef}
            data-testid="home-hero-file-input"
            type="file"
            multiple
            // Hidden, but still reachable programmatically and by a keyboard
            // path — the lock has to be on the element, not only on its
            // change handler.
            disabled={composerLocked}
            style={{ display: 'none' }}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              handleFiles(files);
              event.target.value = '';
            }}
          />
          <div className="home-hero__foot-left">
            <ComposerPlusMenu
              workspaceContext={workspaceContext}
              triggerTestId="home-hero-plus-trigger"
              disabled={composerLocked}
              placementPreference="down"
              onOpen={() =>
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_menu_open',
                })
              }
              onSubmenuOpen={(submenu) => {
                // Home never passes the working-dir submenu (it keeps its own
                // footer picker), so only the resource submenus reach here.
                if (submenu === 'toolbox' || submenu === 'workingDir') return;
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_submenu_open',
                  resource_kind: PLUS_SUBMENU_RESOURCE_KIND[submenu],
                });
              }}
              onSearchUsed={(submenu) => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_search',
                  resource_kind: PLUS_SUBMENU_RESOURCE_KIND[submenu],
                });
              }}
              connectors={connectorOptions}
              onPickConnector={(connector) => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_pick',
                  resource_kind: 'connector',
                  resource_id: connector.id,
                });
                pickConnector(connector);
              }}
              onAddConnector={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_add',
                  resource_kind: 'connector',
                });
                onAddConnector();
              }}
              plugins={pluginOptions}
              onPickPlugin={(record) => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_pick',
                  resource_kind: 'plugin',
                  resource_id: record.id,
                });
                pickPlugin(record);
              }}
              onAddPlugin={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_add',
                  resource_kind: 'plugin',
                });
                onAddPlugin();
              }}
              skills={skillOptions}
              onPickSkill={(skill) => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_pick',
                  resource_kind: 'skill',
                  resource_id: skill.id,
                });
                pickSkill(skill);
              }}
              mcpServers={mcpOptions}
              onPickMcp={(server) => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_pick',
                  resource_kind: 'mcp',
                  resource_id: server.id,
                });
                pickMcp(server);
              }}
              onAddMcp={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_add',
                  resource_kind: 'mcp',
                });
                onAddMcp();
              }}
              onAttachFiles={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'attachment',
                });
                fileInputRef.current?.click();
              }}
              onReferenceProject={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_pick',
                  resource_kind: 'workspace',
                  resource_id: 'reference-project',
                });
                trackProjectReferenceModalSurfaceView(analytics.track, {
                  page_name: 'home',
                  area: 'project_reference_modal',
                });
                setProjectReferenceOpen(true);
              }}
              onLinkLocalCode={onPickLocalCodeDir ? () => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'plus_pick',
                  resource_kind: 'workspace',
                  resource_id: 'local-code',
                });
                void handleLinkLocalCodeContext();
              } : undefined}
              onSelectFromLibrary={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'library',
                });
                setLibraryPickerOpen(true);
              }}
              onImportFigma={onImportFigma ? () => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'figma_import',
                });
                onImportFigma();
              } : undefined}
              onShowFigmaHelp={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'figma_help',
                });
                trackFigmaHelpModalSurfaceView(analytics.track, {
                  page_name: 'home',
                  area: 'figma_help_modal',
                });
                setFigmaHelpOpen(true);
              }}
              onMishSystems={onDesignSystemChange ? () => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'design_system_open',
                });
                mishSystemPicker();
              } : undefined}
            />
            {libraryPickerOpen ? (
              <LibraryPicker
                onClose={() => setLibraryPickerOpen(false)}
                onConfirm={(assets) => importLibraryAssets(assets)}
              />
            ) : null}
            {projectReferenceOpen ? (
              <ProjectReferenceModal
                workspaceContext={workspaceContext}
                onClose={() => {
                  // Only the dismiss paths (X / backdrop / Escape / Cancel)
                  // land here — a confirmed pick closes via
                  // handleReferenceProjects, which reports 'success'.
                  trackContextLinkResult(analytics.track, {
                    page_name: 'home',
                    area: 'chat_composer',
                    context_kind: 'project',
                    result: 'cancelled',
                  });
                  setProjectReferenceOpen(false);
                }}
                onSelect={handleReferenceProjects}
              />
            ) : null}
            {figmaHelpOpen ? (
              <FigmaHelpModal onClose={() => setFigmaHelpOpen(false)} />
            ) : null}
            <TemplatePicker
              templates={templateChips}
              activeChipId={activeChipId}
              previewChipId={previewTemplateId}
              disabled={pluginsLoading || composerLocked}
              pickDisabled={pluginsLoading || pendingChipId !== null || pendingPluginId !== null || composerLocked}
              labelFor={(id) => homeHeroChipLabel(id, t)}
              onPick={handlePickTaskChip}
            />
            {footerInputFields.length > 0 ? (
              <div className="home-hero__footer-options" data-testid="home-hero-footer-options">
                {footerInputFields.map((field) => (
                  <FooterInputOption
                    key={field.name}
                    field={field}
                    value={pluginInputValues[field.name]}
                    designSystems={designSystems}
                    onChange={(value) => {
                      onPluginInputValuesChange({
                        ...pluginInputValues,
                        [field.name]: value,
                      });
                    }}
                    t={t}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <div className="home-hero__foot-right">
            {/* No mode picker on Home (2026-09-08, product): the 「设计 ×」 chip
                used to sit here, left of the model switcher. The project
                composer dropped the same chooser first (2026-08-19 — see the
                matching comment in `ChatComposer.tsx`); Home was the last
                surface still carrying it, and every Home request defaulted
                past it to Design anyway.

                Behaviour is unchanged, only the control is gone: `HomeView`
                still owns the `sessionMode` state that feeds `conversationMode`
                (plus the task profile and plugin provenance), and with nothing
                calling `setSessionMode` it stays on the app default, `design`.

                To restore: re-add `import { ComposerModePicker } from
                './ComposerModePicker'`, re-destructure the `sessionMode` /
                `onSessionModeChange` props (still declared above, still passed
                by `HomeView`), and render the picker here with the
                `trackComposerSessionModeClick` call it had. Pinned by
                `tests/components/HomeView.mode-picker-removed.test.tsx`. */}
            {executionSwitcher ? (
              // An opaque host node, so it cannot take the gate. `inert` is the
              // real answer in a browser — it removes the subtree from focus
              // and from hit-testing — and it is set imperatively below. jsdom
              // does not implement it, so the group also swallows activation in
              // the capture phase. `pointer-events: none` alone said nothing to
              // a descendant that already had focus.
              <div
                ref={executionSwitcherRef}
                className="home-hero__execution-switcher"
                data-testid="home-hero-execution-switcher"
                onClickCapture={swallowWhileLocked}
                onKeyDownCapture={swallowWhileLocked}
                {...(composerLocked
                  ? { 'aria-disabled': true, style: { pointerEvents: 'none' as const } }
                  : {})}
              >
                {executionSwitcher}
              </div>
            ) : null}
            <button
              type="button"
              className={`home-hero__submit od-tooltip${sendAttention ? ' home-hero__attention-sheen' : ''}${sendBusy ? ' is-sending' : ''}`}
              data-testid="home-hero-submit"
              onClick={handleSend}
              onAnimationEnd={() => setSendAttention(false)}
              disabled={!sendEnabled}
              title={sendBusy ? sendBusyLabel : sendEnabled ? t('homeHero.run') : t('homeHero.typeSomethingToRun')}
              data-tooltip={sendBusy ? sendBusyLabel : sendEnabled ? t('homeHero.run') : t('homeHero.typeSomethingToRun')}
              aria-label={sendBusy ? sendBusyLabel : t('homeHero.run')}
              aria-busy={sendBusy}
            >
              <Icon name={sendBusy ? 'spinner' : 'arrow-up'} size={17} />
            </button>
          </div>
        </div>
      </div>

      {onDesignSystemChange || onPickWorkingDir ? (
        <div className="home-hero__workdir-row">
          {onDesignSystemChange ? (
            <DesignSystemPicker
              variant="home"
              designSystems={designSystems}
              selectedId={selectedDesignSystemId}
              loading={designSystemsLoading}
              disabled={composerLocked}
              onChange={whenUnlocked(onDesignSystemChange)}
              {...(onPublishDesignSystemDraft ? { onPublishDraft: onPublishDesignSystemDraft } : {})}
            />
          ) : null}
          {onDesignSystemChange && onPickWorkingDir ? (
            <span className="home-hero__workdir-divider" aria-hidden />
          ) : null}
          {onPickWorkingDir ? (
            <WorkingDirPicker
              className="home-hero__working-dir-picker"
              disabled={composerLocked}
              emptyLabel={t('homeWorkingDir.triggerShort')}
              workingDir={workingDir}
              recentDirs={recentDirs}
              onPickDirectory={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'working_dir',
                });
                void whenUnlocked(onPickWorkingDir)();
              }}
              onSelectRecent={(dir) => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'working_dir_recent',
                });
                whenUnlocked(onSelectRecentWorkingDir)(dir);
              }}
              onClear={() => {
                trackHomeChatComposerClick(analytics.track, {
                  page_name: 'home',
                  area: 'chat_composer',
                  element: 'working_dir_clear',
                });
                whenUnlocked(onClearWorkingDir)();
              }}
            />
          ) : null}
        </div>
      ) : null}
      </div>

      {recommendationSlot}

      {subTypeRowChips.length > 0 && isSubChipParent(activeChipId) ? (
        <SubTypeRow
          subChips={subTypeRowChips}
          selectedSlug={subTypeRowSelection}
          // The spine row is static atlas data: it is ready before the catalog
          // is, and must not sit disabled while plugins load.
          pluginsLoading={jevChoosing || (prototypeActive ? false : pluginsLoading)}
          onPickSubChip={(sub) => {
            trackHomeChatComposerClick(analytics.track, {
              page_name: 'home',
              area: 'chat_composer',
              element: 'subcategory_chip',
              chip_id: activeChipId ?? undefined,
              subcategory: sub.slug,
            });
            if (prototypeActive) {
              setPrototypeSpineCode((current) => (current === sub.slug ? null : sub.slug));
              return;
            }
            const next = selectedSubcategory === sub.slug ? null : sub;
            setLocalSelectedSubcategory(next?.slug ?? null);
          }}
          onSelectAll={() => {
            trackHomeChatComposerClick(analytics.track, {
              page_name: 'home',
              area: 'chat_composer',
              element: 'subcategory_chip',
              chip_id: activeChipId ?? undefined,
              subcategory: 'all',
            });
            if (prototypeActive) {
              setPrototypeSpineCode(null);
              return;
            }
            setLocalSelectedSubcategory(null);
          }}
        />
      ) : (
        // Keep one stable subtype-row slot even for modes without subtypes.
        // Cold Home cannot know whether catalog settlement will bind the
        // default Prototype or restore a persisted non-subtype mode.
        <div
          className="home-hero__subtype-row home-hero__subtype-row--reserved"
          aria-hidden="true"
        />
      )}

      {/* Prototype is the websites' strip: the family generators and the stored
          references, and nothing the daemon bundled. The branch is TERMINAL —
          once the Prototype chip is active the legacy example rail is
          unreachable, whatever the catalog holds. A catalog with no website
          source at all (no agency family installed, an empty or failed index)
          shows the strip's own empty state or its notice; falling through to
          the rail there would put the daemon's bundled examples back under
          Prototype, which is exactly what this strip exists to prevent. */}
      {pluginsLoading ? (
        <PluginPromptPresetsLoading />
      ) : prototypeActive ? (
        <WebsiteCardStrip
          cards={visibleWebsiteCards}
          locale={locale}
          activePluginId={activePluginRecord?.id ?? null}
          pendingPluginId={pendingPluginId}
          notice={
            designIndexLoading
              ? t('homeHero.reference.loading')
              : designIndexFailed
                ? t('homeHero.reference.failed')
                : null
          }
          jevNotice={jevChoosing ? t('homeHero.jevChooses.choosing') : jevChoosesNotice}
          jevChoosesActive={jevChoosesActive}
          jevChoosing={jevChoosing}
          onPickJevChooses={pickJevChoosesCard}
          pulseFirstPreset={guidePulseFirstPreset}
          workspaceContext={workspaceContext}
          onPickFamily={pickExamplePluginPreset}
          onPickReference={pickDesignReference}
        />
      ) : filteredExamplePlugins.length > 0 && activeChipId ? (
        <PluginPromptPresets
          chipId={activeChipId}
          plugins={filteredExamplePlugins}
          activePluginId={activePluginRecord?.id ?? null}
          pendingPluginId={pendingPluginId}
          locale={locale}
          onPick={pickExamplePluginPreset}
          pulseFirstPreset={guidePulseFirstPreset}
          workspaceContext={workspaceContext}
        />
      ) : activePromptExamples.length > 0 ? (
        <div
          className="home-hero__prompt-examples"
          data-testid="home-hero-prompt-examples"
        >
          <div className="home-hero__prompt-examples-title">
            {t('homeHero.promptExamples')}
          </div>
          <div
            className={`home-hero__prompt-examples-grid${activeChipId === 'web-clone' ? ' home-hero__prompt-examples-grid--sites' : ''}`}
          >
            {activePromptExamples.map((example, index) =>
              webCloneExampleSite(example) ? (
                <WebClonePromptExampleCard
                  key={example}
                  example={example}
                  pulse={guidePulseFirstPreset && index === 0}
                  onPick={usePromptExample}
                />
              ) : (
                <button
                  key={example}
                  type="button"
                  className={`home-hero__prompt-example${guidePulseFirstPreset && index === 0 ? ' home-hero__attention-sheen' : ''}`}
                  data-testid="home-hero-prompt-example"
                  onClick={() => usePromptExample(example)}
                >
                  <span>{example}</span>
                </button>
              ),
            )}
          </div>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="home-hero__error">
          {error}
        </div>
      ) : null}
      {previewHomeFile && previewHomeFileUrl ? createPortal(
        <div
          className="staged-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={previewHomeFile.name}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewHomeFileKey(null);
          }}
        >
          <div className="staged-preview-card">
            <div className="staged-preview-head">
              <span title={previewHomeFile.name}>{previewHomeFile.name}</span>
              <button
                type="button"
                className="icon-only od-tooltip"
                onClick={() => setPreviewHomeFileKey(null)}
                aria-label={t('common.close')}
                title={t('common.close')}
                data-tooltip={t('common.close')}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <img src={previewHomeFileUrl} alt={previewHomeFile.name} />
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
});

function PluginPromptPresetsLoading() {
  const { t } = useI18n();
  return (
    <div
      className="home-hero__prompt-examples home-hero__plugin-presets-wrap"
      data-testid="home-hero-examples-loading"
      aria-busy="true"
    >
      <div className="home-hero__prompt-examples-title">
        {t('homeHero.promptExamples')}
      </div>
      <div className="home-hero__rail-scroller">
        <div className="home-hero__plugin-presets-loading" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <span className="home-hero__plugin-preset-loading" key={index}>
              <span className="home-hero__plugin-preset-loading-preview" />
              <span className="home-hero__plugin-preset-loading-title" />
            </span>
          ))}
        </div>
      </div>
      <VisuallyHidden>{t('common.loading')}</VisuallyHidden>
    </div>
  );
}

function PluginPromptPresets({
  activePluginId,
  chipId,
  locale,
  onPick,
  pendingPluginId,
  plugins,
  pulseFirstPreset = false,
  workspaceContext = null,
}: {
  activePluginId: string | null;
  chipId: string;
  locale: Locale;
  onPick: (record: InstalledPluginRecord, chipId: string, promptText: string) => void;
  pendingPluginId: string | null;
  plugins: InstalledPluginRecord[];
  workspaceContext?: WorkspaceCollabContext | null;
  // First-run guide: the first card carries the attention sheen.
  pulseFirstPreset?: boolean;
}) {
  const { t } = useI18n();
  // Same edge hover/click auto-scroll as the scenario rail, so this row is
  // reachable without a trackpad when it overflows.
  const edgeScroll = useEdgeAutoScroll(plugins.length);
  return (
    <div
      className="home-hero__prompt-examples home-hero__plugin-presets-wrap"
      data-testid="home-hero-plugin-presets"
    >
      <div className="home-hero__prompt-examples-title">
        {t('homeHero.promptExamples')}
      </div>
      <div className="home-hero__rail-scroller">
        <div
          ref={edgeScroll.scrollRef}
          className="home-hero__plugin-presets"
          role="list"
        >
          {plugins.map((record, index) => (
            <PluginPromptPresetCard
              key={record.id}
              chipId={chipId}
              locale={locale}
              record={record}
              active={activePluginId === record.id}
              pending={pendingPluginId === record.id}
              disabled={pendingPluginId !== null}
              pulse={pulseFirstPreset && index === 0}
              onPick={onPick}
              workspaceContext={workspaceContext}
            />
          ))}
        </div>
        <EdgeScrollZones {...edgeScroll} />
      </div>
    </div>
  );
}

/**
 * The Prototype strip: website cards only.
 *
 * Family cards keep the ordinary preset card and its click path — picking one
 * still binds that generator. Reference cards are stored design profiles and
 * take their own path (see `pickDesignReference`). The index notice sits above
 * the rail rather than replacing it, so a slow or failed index read still
 * leaves the family cards usable.
 */
function WebsiteCardStrip({
  activePluginId,
  cards,
  jevChoosesActive = false,
  jevChoosing = false,
  jevNotice = null,
  locale,
  notice,
  onPickFamily,
  onPickJevChooses,
  onPickReference,
  pendingPluginId,
  pulseFirstPreset = false,
  workspaceContext = null,
}: {
  activePluginId: string | null;
  cards: WebsiteCard[];
  jevChoosesActive?: boolean;
  jevChoosing?: boolean;
  jevNotice?: string | null;
  locale: Locale;
  notice: string | null;
  onPickFamily: (record: InstalledPluginRecord, chipId: string, promptText: string) => void;
  onPickJevChooses?: (() => void) | undefined;
  onPickReference: (profile: DesignProfile) => void;
  pendingPluginId: string | null;
  pulseFirstPreset?: boolean;
  workspaceContext?: WorkspaceCollabContext | null;
}) {
  const { t } = useI18n();
  const edgeScroll = useEdgeAutoScroll(cards.length);
  return (
    <div
      // The strip's own modifier: every card here carries a two-row caption
      // (title + the route line), which the shared preset card geometry does
      // not reserve room for. The height correction is scoped to this class so
      // every other rail keeps its geometry (see home-hero.css).
      className="home-hero__prompt-examples home-hero__plugin-presets-wrap home-hero__website-strip"
      data-testid="home-hero-website-cards"
    >
      <div className="home-hero__prompt-examples-title">{t('homeHero.promptExamples')}</div>
      {notice ? (
        <p className="home-hero__website-notice" data-testid="home-hero-website-notice">
          {notice}
        </p>
      ) : null}
      {jevNotice ? (
        <p className="home-hero__website-notice" data-testid="home-hero-jev-notice">
          {jevNotice}
        </p>
      ) : null}
      {/* The rail always renders, even under a spine that stores nothing: the
          pinned card is spine-agnostic, so the empty state is a line BELOW the
          rail rather than a replacement for it. */}
      <div className="home-hero__rail-scroller">
        <div ref={edgeScroll.scrollRef} className="home-hero__plugin-presets" role="list">
          <JevChoosesCard
            active={jevChoosesActive}
            choosing={jevChoosing}
            disabled={pendingPluginId !== null}
            onPick={onPickJevChooses}
          />
          {cards.map((card, index) =>
            card.kind === 'family' ? (
              <PluginPromptPresetCard
                key={`family:${card.record.id}`}
                chipId="prototype"
                locale={locale}
                record={card.record}
                active={activePluginId === card.record.id}
                pending={pendingPluginId === card.record.id}
                disabled={pendingPluginId !== null || jevChoosing}
                // Beat 2 of the first-run trail points at the first WEBSITE
                // card. Jev chooses is a mode, never a starting point.
                pulse={pulseFirstPreset && index === 0}
                subtitle={familyCardLine(card)}
                displayTitle={compactCardTitle(localizePluginTitle(locale, card.record), agencyFamilySlug(card.record))}
                displaySubtitle={compactCardStyle(card.skin, localizePluginTitle(locale, card.record))}
                onPick={onPickFamily}
                workspaceContext={workspaceContext}
              />
            ) : (
              <ReferenceCard
                key={`reference:${card.profile.source.digest}`}
                profile={card.profile}
                disabled={pendingPluginId !== null || jevChoosing}
                onPick={onPickReference}
              />
            ),
          )}
        </div>
        <EdgeScrollZones {...edgeScroll} />
      </div>
      {cards.length === 0 ? (
        <p className="home-hero__website-empty" data-testid="home-hero-website-empty">
          {t('homeHero.reference.emptySpine')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Prototype strip's pinned first card.
 *
 * It binds nothing. Picking it says "Jev decides which family builds this",
 * and the decision is made once, from the brief, when the user presses Send
 * (see HomeView's `submit`). Under every spine tab, because Jev's decision is
 * spine-agnostic — the tab filters what the user browses, not what Jev may
 * choose.
 */
function JevChoosesCard({
  active,
  choosing,
  disabled,
  onPick,
}: {
  active: boolean;
  choosing: boolean;
  disabled: boolean;
  onPick?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const title = t('homeHero.jevChooses.title');
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <span className="home-hero__plugin-preset-cell" role="listitem">
      <PreviewCard
        type="button"
        className={`home-hero__plugin-preset${active ? ' is-active' : ''}${choosing ? ' is-pending' : ''}`}
        data-testid="home-hero-jev-chooses"
        selected={active}
        pending={choosing}
        disabled={disabled || choosing}
        onClick={() => onPick?.()}
      >
        <PreviewCardMedia className="home-hero__plugin-preset-preview" aria-hidden>
          {imageFailed ? <TextSurface pluginTitle={title} /> : (
            <img
              src="/images/jev-card.webp"
              alt=""
              decoding="async"
              onError={() => setImageFailed(true)}
            />
          )}
          {active ? (
            <span className="home-hero__plugin-preset-check" aria-hidden>
              <Icon name="check" size={12} />
            </span>
          ) : null}
        </PreviewCardMedia>
        <PreviewCardCaption className="home-hero__plugin-preset-meta">
          <PreviewCardTitle className="home-hero__plugin-preset-title">{title}</PreviewCardTitle>
          <PreviewCardDescription className="home-hero__plugin-preset-subtitle">
            {choosing ? t('homeHero.jevChooses.choosing') : t('homeHero.jevChooses.subtitle')}
          </PreviewCardDescription>
        </PreviewCardCaption>
      </PreviewCard>
    </span>
  );
}

const FIRST_PARTY_WEB_CLONE_SITE_ICONS: Record<string, string> = {
  'example.com': '/logo.svg',
};

// Null unless the domain is a public hostname (audit L8), so a typed project
// name or LAN host never reaches the favicon service.
function webCloneFaviconUrl(domain: string): string | null {
  return publicFaviconUrl(domain, 128);
}

// A Website-clone text example ("Website URL to clone: https://example.com") —
// pull the site out so the card can show the site's own mark + bare domain
// instead of the raw prompt line. First-party bundled examples use local assets
// so the first screen is stable without waiting on a remote favicon service.
// Returns null for non-URL examples so the generic text card renders unchanged.
function webCloneExampleSite(example: string): { domain: string; iconUrl: string | null; fallbackIconUrl?: string } | null {
  const match = example.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return null;
  let hostname: string;
  try {
    hostname = new URL(match[0]).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!hostname || !hostname.includes('.')) return null;
  const firstPartyIcon = FIRST_PARTY_WEB_CLONE_SITE_ICONS[hostname];
  const favicon = webCloneFaviconUrl(hostname);
  return {
    domain: hostname,
    // Null renders the monogram badge instead of a remote favicon.
    iconUrl: firstPartyIcon ?? favicon,
    ...(firstPartyIcon && favicon ? { fallbackIconUrl: favicon } : {}),
  };
}

function WebClonePromptExampleCard({
  example,
  pulse,
  onPick,
}: {
  example: string;
  pulse: boolean;
  onPick: (example: string) => void;
}) {
  const [iconStage, setIconStage] = useState<'primary' | 'fallback' | 'failed'>('primary');
  const site = webCloneExampleSite(example);
  const domain = site?.domain ?? example;
  const monogram = (domain.replace(/[^a-z0-9]/i, '')[0] ?? '?').toUpperCase();
  let iconUrl: string | null = null;
  if (site && iconStage === 'primary') {
    iconUrl = site.iconUrl;
  } else if (site && iconStage === 'fallback') {
    iconUrl = site.fallbackIconUrl ?? null;
  }
  return (
    <button
      type="button"
      className={`home-hero__prompt-example home-hero__prompt-example--site${pulse ? ' home-hero__attention-sheen' : ''}`}
      data-testid="home-hero-prompt-example"
      onClick={() => onPick(example)}
      title={domain}
    >
      <span className="home-hero__site-badge" aria-hidden>
        {site && iconUrl ? (
          <img
            src={iconUrl}
            alt=""
            loading="eager"
            fetchPriority="high"
            onError={() => {
              setIconStage((stage) => (stage === 'primary' && site.fallbackIconUrl ? 'fallback' : 'failed'));
            }}
          />
        ) : (
          <span className="home-hero__site-monogram">{monogram}</span>
        )}
      </span>
      <span className="home-hero__site-domain">{domain}</span>
    </button>
  );
}

function PluginPromptPresetCard({
  active,
  chipId,
  disabled,
  locale,
  onPick,
  pending,
  pulse = false,
  record,
  subtitle = null,
  displayTitle,
  displaySubtitle,
  workspaceContext = null,
}: {
  active: boolean;
  chipId: string;
  disabled: boolean;
  locale: Locale;
  onPick: (record: InstalledPluginRecord, chipId: string, promptText: string) => void;
  pending: boolean;
  pulse?: boolean;
  record: InstalledPluginRecord;
  subtitle?: string | null;
  displayTitle?: string;
  displaySubtitle?: string | null;
  workspaceContext?: WorkspaceCollabContext | null;
}) {
  const { t } = useI18n();
  // Example-prompt preset tiles are thumbnails too — prefer the cheap baked
  // hover-pan clip when one exists (same as the gallery cards).
  const preview = useMemo(
    () => inferPluginPreview(record, { preferBaked: true, workspaceContext }),
    [record, workspaceContext],
  );
  // Home cards keep their richer structured-preview path as the last-resort
  // fallback (the detail modal injects a simpler one).
  const seedPrompt = examplePresetSeedPrompt(record, locale, () =>
    pluginPresetPromptPreview(record, locale, chipId),
  ).text;
  // Deck preset thumbnails render the iframe at a fixed 1280 design width scaled
  // to cover the preview cell, so the Home thumbnail fills its frame. The
  // full deck remains available through the existing preview actions.
  const odMode = (record.manifest?.od as { mode?: unknown } | undefined)?.mode;
  const presetPreviewRef = useRef<HTMLSpanElement>(null);
  useDeckPreviewScale(presetPreviewRef, odMode === 'deck' && preview.kind === 'html', 'cover');
  const title = localizePluginTitle(locale, record);
  const captionTitle = displayTitle ?? compactCardTitle(title);
  const captionSubtitle = displaySubtitle === undefined ? subtitle : displaySubtitle;
  // Commercial category ("品类") chip — same signal the gallery tile and the
  // Create page picker show, so the example row reads like the reference
  // template galleries. Null for records without a known category.
  const categoryLabel = pluginCategoryLabel(record, t);
  return (
    <span className="home-hero__plugin-preset-cell" role="listitem">
      <PreviewCard
        type="button"
        className={`home-hero__plugin-preset${active ? ' is-active' : ''}${pending ? ' is-pending' : ''}${pulse ? ' home-hero__attention-sheen' : ''}`}
        data-testid="home-hero-plugin-preset"
        data-plugin-id={record.id}
        aria-label={[title, subtitle].filter(Boolean).join(' — ')}
        {...(typeof odMode === 'string' ? { 'data-od-mode': odMode } : {})}
        selected={active}
        pending={pending}
        disabled={disabled}
        onClick={() => onPick(record, chipId, seedPrompt)}
      >
        <PreviewCardMedia className="home-hero__plugin-preset-preview" aria-hidden ref={presetPreviewRef}>
          <PreviewSurface
            pluginId={record.id}
            pluginTitle={title}
            preview={preview}
            eager
          />
          {active ? (
            <span className="home-hero__plugin-preset-check" aria-hidden>
              <Icon name="check" size={12} />
            </span>
          ) : null}
        </PreviewCardMedia>
        <PreviewCardCaption className="home-hero__plugin-preset-meta">
          {/* Category tag dropped (dogfood 2026-07-28): the filter chips above
              the rail already scope the row, so the per-card pill was noise. */}
          <PreviewCardTitle className="home-hero__plugin-preset-title" title={title}>
            {captionTitle}
          </PreviewCardTitle>
          {captionSubtitle ? (
            <PreviewCardDescription className="home-hero__plugin-preset-subtitle" title={subtitle ?? captionSubtitle} data-testid="home-hero-family-line">
              {captionSubtitle}
            </PreviewCardDescription>
          ) : null}
        </PreviewCardCaption>
      </PreviewCard>
    </span>
  );
}

function promptExampleChipLabel(example: string): string {
  const normalized = example.replace(/\s+/g, ' ').trim();
  const [beforeDash] = normalized.split(/\s[—-]\s/u, 1);
  const candidate = beforeDash?.trim() || normalized;
  return candidate.length > 64 ? `${candidate.slice(0, 61).trimEnd()}...` : candidate;
}

function homeFileKey(file: File, index: number): string {
  return `${file.name}-${file.size}-${file.lastModified}-${index}`;
}

const LIBRARY_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'text/html': 'html',
  'text/css': 'css',
  'text/plain': 'txt',
  'application/json': 'json',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
};

/** Fetch a library asset's bytes and wrap them in a named File for staging. */
async function fileFromLibraryAsset(asset: LibraryAsset): Promise<File | null> {
  if (asset.kind === 'file') return null;
  try {
    const resp = await fetch(libraryAssetRawUrl(asset.id));
    if (!resp.ok) return null;
    const blob = await resp.blob();
    let name =
      asset.relPath?.split('/').pop() ||
      assetTitle(asset).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) ||
      `library-${asset.id.slice(0, 8)}`;
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
      const ext = LIBRARY_MIME_EXT[(blob.type || asset.mime || '').toLowerCase()];
      if (ext) name = `${name}.${ext}`;
    }
    return new File([blob], name, { type: blob.type || asset.mime || 'application/octet-stream' });
  } catch {
    return null;
  }
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(file.name);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value /= 1024;
  }
  return `${bytes} B`;
}

const HOME_HERO_PROMPT_MAX_HEIGHT = 180;
const HOME_HERO_AUTHORING_PROMPT_MAX_HEIGHT = 132;

function pluginMentionText(record: InstalledPluginRecord): string {
  return inlineMentionToken(record.title);
}

function buildHomeMentionEntities({
  activePluginRecord,
  activeSkillId,
  activeSkillTitle,
  connectorOptions,
  contextWorkspaceItems,
  mcpOptions,
  pluginOptions,
  selectedPluginContexts,
  stagedFiles,
  skillOptions,
}: {
  activePluginRecord: InstalledPluginRecord | null;
  activeSkillId: string | null;
  activeSkillTitle: string | null;
  connectorOptions: ConnectorDetail[];
  contextWorkspaceItems: WorkspaceContextItem[];
  mcpOptions: McpServerConfig[];
  pluginOptions: InstalledPluginRecord[];
  selectedPluginContexts: InstalledPluginRecord[];
  stagedFiles: File[];
  skillOptions: SkillSummary[];
}): InlineMentionEntity[] {
  const entities: InlineMentionEntity[] = [];
  for (const item of contextWorkspaceItems) {
    entities.push({
      id: item.id,
      kind: 'workspace',
      label: item.label,
      token: inlineMentionToken(item.label),
      title: `Workspace: ${item.label}`,
    });
  }
  const fileSeen = new Set<string>();
  for (const file of stagedFiles) {
    if (fileSeen.has(file.name)) continue;
    fileSeen.add(file.name);
    entities.push({
      id: file.name,
      kind: 'file',
      label: file.name,
      token: inlineMentionToken(file.name),
      title: `File: ${file.name}`,
    });
  }
  const pluginSeen = new Set<string>();
  for (const plugin of [...selectedPluginContexts, ...pluginOptions]) {
    if (pluginSeen.has(plugin.id)) continue;
    pluginSeen.add(plugin.id);
    entities.push({
      id: plugin.id,
      kind: 'plugin',
      label: plugin.title,
      token: pluginMentionText(plugin),
      title: `Plugin: ${plugin.title}`,
    });
  }
  if (activePluginRecord && !pluginSeen.has(activePluginRecord.id)) {
    entities.push({
      id: activePluginRecord.id,
      kind: 'plugin',
      label: activePluginRecord.title,
      token: pluginMentionText(activePluginRecord),
      title: `Plugin: ${activePluginRecord.title}`,
    });
  }
  const skillSeen = new Set<string>();
  for (const skill of skillOptions) {
    if (skillSeen.has(skill.id)) continue;
    skillSeen.add(skill.id);
    entities.push({
      id: skill.id,
      kind: 'skill',
      label: skill.name,
      token: inlineMentionToken(skill.name),
      title: `Skill: ${skill.name}`,
    });
    if (skill.id !== skill.name) {
      entities.push({
        id: skill.id,
        kind: 'skill',
        label: skill.id,
        token: inlineMentionToken(skill.id),
        title: `Skill: ${skill.name}`,
      });
    }
  }
  if (activeSkillId && activeSkillTitle && !skillSeen.has(activeSkillId)) {
    entities.push({
      id: activeSkillId,
      kind: 'skill',
      label: activeSkillTitle,
      token: inlineMentionToken(activeSkillTitle),
      title: `Skill: ${activeSkillTitle}`,
    });
  }
  for (const server of mcpOptions) {
    const label = server.label || server.id;
    entities.push({
      id: server.id,
      kind: 'mcp',
      label,
      token: inlineMentionToken(label),
      title: `MCP: ${label}`,
    });
    if (server.id !== label) {
      entities.push({
        id: server.id,
        kind: 'mcp',
        label: server.id,
        token: inlineMentionToken(server.id),
        title: `MCP: ${label}`,
      });
    }
  }
  for (const connector of connectorOptions) {
    entities.push({
      id: connector.id,
      kind: 'connector',
      label: connector.name,
      token: inlineMentionToken(connector.name),
      title: `Connector: ${connector.name}`,
    });
    if (connector.id !== connector.name) {
      entities.push({
        id: connector.id,
        kind: 'connector',
        label: connector.id,
        token: inlineMentionToken(connector.id),
        title: `Connector: ${connector.name}`,
      });
    }
  }
  return entities;
}

function FooterInputOption({
  field,
  value,
  designSystems,
  onChange,
  t,
}: {
  field: InputFieldSpec;
  value: unknown;
  designSystems: DesignSystemSummary[];
  onChange: (value: unknown) => void;
  t: ReturnType<typeof useT>;
}) {
  const label = footerInputLabel(field, t);
  if (field.name === 'speakerNotes') {
    const checked = footerSpeakerNotesEnabled(value);
    return (
      <button
        type="button"
        className={`home-hero__footer-switch${checked ? ' is-on' : ''}`}
        aria-label={label}
        aria-pressed={checked}
        data-testid="home-hero-footer-option-speakerNotes"
        onClick={() => onChange(checked ? 'no speaker notes' : 'include speaker notes')}
      >
        <span>{t('homeHero.footer.speakerNotes')}</span>
        <i aria-hidden />
      </button>
    );
  }
  if (field.name === 'designSystem') {
    // The composer binds its design-system choice as a TITLE string in the
    // plugin input (used by the apply query template). The shared picker is
    // id-based, so adapt: "不指定 / No design system" (or an unset value) maps
    // to a null id; otherwise resolve the title to its system id.
    const noneTitle = t('designSystemPicker.noneTitle');
    const currentTitle = value === undefined || value === null ? '' : String(value).trim();
    const selectedId =
      currentTitle && currentTitle !== noneTitle && currentTitle !== 'the active project design system'
        ? designSystems.find((system) => system.title === currentTitle)?.id ?? null
        : null;
    return (
      <DesignSystemPicker
        variant="footer"
        label={label}
        designSystems={designSystems}
        selectedId={selectedId}
        onChange={(id) =>
          onChange(id == null ? noneTitle : designSystems.find((system) => system.id === id)?.title ?? noneTitle)
        }
      />
    );
  }
  if (field.type === 'select' && Array.isArray(field.options)) {
    return (
      <FooterSelectOption
        fieldName={field.name}
        label={label}
        value={value === undefined || value === null ? '' : String(value)}
        options={[
          ...(field.placeholder ? [{ value: '', label: field.placeholder }] : []),
          ...field.options.map((option) => ({
            value: option,
            label: footerInputValueLabel(field, option, t),
            icon: footerInputValueIcon(field, option),
            modelIcon: field.name === 'model' ? modelOptionIcon(option, footerInputValueLabel(field, option, t)) : undefined,
            ratioIcon: field.name === 'ratio' ? ratioOptionIcon(option) : undefined,
          })),
        ]}
        onChange={onChange}
      />
    );
  }
  return (
    <label className="home-hero__footer-option home-hero__footer-option--text" data-field-name={field.name}>
      <span>{label}</span>
      <input
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder ?? ''}
        aria-label={label}
        data-testid={`home-hero-footer-option-${field.name}`}
      />
    </label>
  );
}

function FooterSelectOption({
  fieldName,
  label,
  value,
  options,
  searchable = false,
  searchPlaceholder,
  onChange,
}: {
  fieldName: string;
  label: string;
  value: string;
  options: FooterSelectItemOption[];
  searchable?: boolean;
  searchPlaceholder?: string;
  onChange: (value: unknown) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const visibleOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) => (
      option.label.toLowerCase().includes(query) ||
      option.value.toLowerCase().includes(query) ||
      (option.description ?? '').toLowerCase().includes(query) ||
      (option.meta ?? '').toLowerCase().includes(query) ||
      (option.group ?? '').toLowerCase().includes(query)
    ));
  }, [options, search]);
  const groupedOptions = useMemo(() => {
    const groups: { label: string | null; options: FooterSelectItemOption[] }[] = [];
    for (const option of visibleOptions) {
      const groupLabel = option.group ?? null;
      const last = groups[groups.length - 1];
      if (last && last.label === groupLabel) {
        last.options.push(option);
      } else {
        groups.push({ label: groupLabel, options: [option] });
      }
    }
    return groups;
  }, [visibleOptions]);
  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  return (
    <div
      ref={ref}
      className={`home-hero__footer-option home-hero__footer-option--select${open ? ' is-open' : ''}`}
      data-field-name={fieldName}
    >
      <span>{label}</span>
      <button
        type="button"
        className="home-hero__footer-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`home-hero-footer-option-${fieldName}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        {selected?.preview ? <DesignSystemOptionPreview option={selected.preview} compact /> : null}
        {selected?.icon ? <FooterOptionIcon name={selected.icon} compact /> : null}
        {selected?.modelIcon ? <ModelOptionIcon icon={selected.modelIcon} compact /> : null}
        {selected?.ratioIcon ? <RatioOptionIcon icon={selected.ratioIcon} compact /> : null}
        <span className="home-hero__footer-select-label">{selected?.label ?? value}</span>
        <Icon name="chevron-down" size={12} aria-hidden />
      </button>
      {open ? (
        <div
          className={`home-hero__footer-select-menu${searchable ? ' home-hero__footer-select-menu--searchable' : ''}`}
          role="listbox"
          data-testid={`home-hero-footer-option-${fieldName}-menu`}
        >
          {searchable ? (
            <div className="home-hero__footer-select-search">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder ?? label}
                autoFocus
                data-testid={`home-hero-footer-option-${fieldName}-search`}
              />
              <div className="home-hero__footer-select-count">
                {t('homeHero.footer.availableCount', { n: visibleOptions.length })}
              </div>
            </div>
          ) : null}
          {groupedOptions.length === 0 ? (
            <div className="home-hero__footer-select-empty">{t('homeHero.footer.noMatches')}</div>
          ) : (
            groupedOptions.map((group, index) => (
              <div
                className="home-hero__footer-select-group"
                key={`${group.label ?? 'ungrouped'}:${group.options[0]?.value ?? index}`}
              >
                {group.label ? (
                  <div className="home-hero__footer-select-group-label">{group.label}</div>
                ) : null}
                {group.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    className={`home-hero__footer-select-item${option.value === value ? ' is-selected' : ''}`}
                    onClick={() => {
                      onChange(option.submitValue ?? option.value);
                      setOpen(false);
                    }}
                  >
                    {option.preview ? <DesignSystemOptionPreview option={option.preview} /> : null}
                    {option.icon ? <FooterOptionIcon name={option.icon} /> : null}
                    {option.modelIcon ? <ModelOptionIcon icon={option.modelIcon} /> : null}
                    {option.ratioIcon ? <RatioOptionIcon icon={option.ratioIcon} /> : null}
                    <span className="home-hero__footer-select-copy">
                      <span className="home-hero__footer-select-label">{option.label}</span>
                      {option.description ? (
                        <span className="home-hero__footer-select-description">{option.description}</span>
                      ) : null}
                    </span>
                    {option.meta ? <span className="home-hero__footer-select-meta">{option.meta}</span> : null}
                    {option.value === value ? <Icon name="check" size={14} aria-hidden /> : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

interface FooterSelectItemOption {
  value: string;
  submitValue?: string;
  label: string;
  group?: string;
  icon?: IconName;
  description?: string;
  meta?: string;
  modelIcon?: ModelOptionIconSpec;
  ratioIcon?: RatioOptionIconSpec;
  preview?: {
    title: string;
    swatches?: string[];
    logoUrl?: string;
  };
}

interface ModelOptionIconSpec {
  label: string;
  tone:
    | 'openai'
    | 'dalle'
    | 'seed'
    | 'sense'
    | 'grok'
    | 'google'
    | 'router'
    | 'flux'
    | 'elevenlabs'
    | 'fishaudio'
    | 'minimax'
    | 'suno'
    | 'audio'
    | 'custom';
  src?: string;
}

interface RatioOptionIconSpec {
  width: number;
  height: number;
  tone: 'square' | 'wide' | 'tall' | 'standard' | 'portrait' | 'custom';
}

function FooterOptionIcon({
  name,
  compact = false,
}: {
  name: IconName;
  compact?: boolean;
}) {
  return (
    <span
      className={`home-hero__footer-option-icon${compact ? ' home-hero__footer-option-icon--compact' : ''}`}
      aria-hidden
    >
      <Icon name={name} size={13} />
    </span>
  );
}

function ModelOptionIcon({
  icon,
  compact = false,
}: {
  icon: ModelOptionIconSpec;
  compact?: boolean;
}) {
  return (
    <span
      className={`home-hero__model-option-icon home-hero__model-option-icon--${icon.tone}${compact ? ' home-hero__model-option-icon--compact' : ''}`}
      aria-hidden
    >
      {icon.src ? <img src={icon.src} alt="" draggable={false} /> : icon.label}
    </span>
  );
}

function RatioOptionIcon({
  icon,
  compact = false,
}: {
  icon: RatioOptionIconSpec;
  compact?: boolean;
}) {
  return (
    <span
      className={`home-hero__ratio-option-icon home-hero__ratio-option-icon--${icon.tone}${compact ? ' home-hero__ratio-option-icon--compact' : ''}`}
      aria-hidden
    >
      <i style={{ width: icon.width, height: icon.height }} />
    </span>
  );
}

function DesignSystemOptionPreview({
  option,
  compact = false,
}: {
  option: { title: string; swatches?: string[]; logoUrl?: string };
  compact?: boolean;
}) {
  const swatches = (option.swatches ?? []).filter(Boolean).slice(0, compact ? 2 : 3);
  const initial = option.title.trim().charAt(0).toUpperCase() || 'D';
  return (
    <span
      className={`home-hero__ds-option-preview${compact ? ' home-hero__ds-option-preview--compact' : ''}`}
      aria-hidden
    >
      {option.logoUrl ? (
        <img src={option.logoUrl} alt="" loading="lazy" />
      ) : swatches.length > 0 ? (
        swatches.map((swatch, index) => (
          <i key={`${swatch}-${index}`} style={{ background: swatch }} />
        ))
      ) : (
        <b>{initial}</b>
      )}
    </span>
  );
}

function footerInputLabel(field: InputFieldSpec, t: ReturnType<typeof useT>): string {
  switch (field.name) {
    case 'designSystem':
      return t('homeHero.footer.designSystem');
    case 'fidelity':
      return t('newproj.fidelityLabel');
    case 'speakerNotes':
      return t('homeHero.footer.speakerNotes');
    case 'model':
      return t('newproj.modelLabel');
    case 'ratio':
      return t('homeHero.footer.ratio');
    case 'duration':
      return t('homeHero.footer.duration');
    case 'resolution':
      return t('homeHero.footer.resolution');
    default:
      return field.label ?? field.name;
  }
}

function footerInputValueLabel(field: InputFieldSpec, value: string, t: ReturnType<typeof useT>): string {
  if (field.name === 'fidelity') {
    if (value === 'wireframe') return t('newproj.fidelityWireframe');
    if (value === 'high-fidelity') return t('newproj.fidelityHigh');
  }
  if (field.name === 'speakerNotes') {
    return footerSpeakerNotesEnabled(value) ? t('homeHero.footer.speakerNotes') : t('homeHero.footer.noSpeakerNotes');
  }
  return optionLabelMap(field)[value] ?? value;
}

function footerSpeakerNotesEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !(
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'none' ||
    normalized.includes('no speaker')
  );
}

function footerInputValueIcon(field: InputFieldSpec, value: string): IconName | undefined {
  if (field.name === 'fidelity') {
    if (value === 'wireframe') return 'grid';
    if (value === 'high-fidelity') return 'sparkles';
  }
  return undefined;
}

function modelOptionIcon(value: string, label: string): ModelOptionIconSpec {
  const normalized = `${value} ${label}`.toLowerCase();
  if (normalized.includes('dall-e')) return { label: 'OpenAI', tone: 'dalle', src: '/model-icons/openai.svg' };
  if (normalized.includes('gpt-image') || normalized.includes('openai') || normalized.includes('sora')) {
    return { label: 'OpenAI', tone: 'openai', src: '/model-icons/openai.svg' };
  }
  if (normalized.includes('seedream') || normalized.includes('seededit') || normalized.includes('seedance') || normalized.includes('doubao') || normalized.includes('bytedance')) {
    return { label: 'ByteDance', tone: 'seed', src: '/model-icons/bytedance.svg' };
  }
  if (normalized.includes('senseaudio')) return { label: 'SA', tone: 'sense' };
  if (normalized.includes('grok') || normalized.includes('xai') || normalized.includes('xai/')) {
    return { label: 'xAI', tone: 'grok', src: '/model-icons/x.svg' };
  }
  if (normalized.includes('gemini') || normalized.includes('imagen') || normalized.includes('veo') || normalized.includes('google') || normalized.includes('nano-banana')) {
    return { label: 'Google Gemini', tone: 'google', src: '/model-icons/google-gemini.svg' };
  }
  if (normalized.includes('flux') || normalized.includes('bfl') || normalized.includes('black-forest')) {
    return { label: 'FLUX', tone: 'flux', src: '/model-icons/flux.svg' };
  }
  if (normalized.includes('openrouter')) return { label: 'OpenRouter', tone: 'router', src: '/model-icons/openrouter.svg' };
  if (normalized.includes('imagerouter') || normalized.includes('/')) return { label: 'IR', tone: 'router' };
  if (normalized.includes('eleven')) {
    return { label: 'ElevenLabs', tone: 'elevenlabs', src: '/model-icons/elevenlabs.svg' };
  }
  if (normalized.includes('fish')) {
    return { label: 'Fish Audio', tone: 'fishaudio', src: '/model-icons/fishaudio.svg' };
  }
  if (normalized.includes('minimax')) {
    return { label: 'MiniMax', tone: 'minimax', src: '/model-icons/minimax.svg' };
  }
  if (normalized.includes('suno')) return { label: 'Suno', tone: 'suno', src: '/model-icons/suno.svg' };
  if (
    normalized.includes('udio') ||
    normalized.includes('audio') ||
    normalized.includes('voice')
  ) {
    return { label: modelInitials(label), tone: 'audio' };
  }
  return { label: modelInitials(label || value), tone: 'custom' };
}

function modelInitials(input: string): string {
  const cleaned = input
    .replace(/^[^a-z0-9]+/i, '')
    .replace(/^(gpt|model)[-_ ]*/i, '')
    .trim();
  const parts = cleaned.split(/[^a-z0-9]+/i).filter(Boolean);
  const initials = parts.length >= 2
    ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`
    : (parts[0] ?? cleaned).slice(0, 2);
  return initials.toUpperCase() || 'M';
}

function ratioOptionIcon(value: string): RatioOptionIconSpec {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  const rawWidth = Number(match?.[1] ?? 1);
  const rawHeight = Number(match?.[2] ?? 1);
  const ratioWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : 1;
  const ratioHeight = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 1;
  const maxEdge = 17;
  const scale = maxEdge / Math.max(ratioWidth, ratioHeight);
  const width = Math.max(8, Math.round(ratioWidth * scale));
  const height = Math.max(8, Math.round(ratioHeight * scale));
  const normalized = `${ratioWidth}:${ratioHeight}`;
  const tone = (() => {
    if (normalized === '1:1') return 'square';
    if (normalized === '16:9') return 'wide';
    if (normalized === '9:16') return 'tall';
    if (normalized === '4:3') return 'standard';
    if (normalized === '3:4') return 'portrait';
    return ratioWidth > ratioHeight ? 'wide' : ratioHeight > ratioWidth ? 'tall' : 'custom';
  })();
  return { width, height, tone };
}

function optionLabelMap(field: InputFieldSpec): Record<string, string> {
  const labels = (field as { optionLabels?: unknown }).optionLabels;
  return labels && typeof labels === 'object' && !Array.isArray(labels)
    ? labels as Record<string, string>
    : {};
}

function stripHomeMentionToken(value: string, label: string): string {
  const token = inlineMentionToken(label);
  return value.replace(
    new RegExp(`(^|[\\s([{"'])${escapeRegExp(token)}(?=$|\\s|[.,;:!?)}\\]"'])([^\\S\\r\\n])?`, 'g'),
    '$1',
  );
}

function fileMatchesQuery(file: File, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [file.name, file.type || '']
    .join(' ')
    .toLowerCase()
    .includes(q);
}

function pluginMatchesQuery(plugin: InstalledPluginRecord, query: string, locale: Locale): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    plugin.title,
    localizePluginTitle(locale, plugin),
    plugin.id,
    plugin.sourceKind,
    plugin.manifest?.description ?? '',
    localizePluginDescription(locale, plugin),
    ...(plugin.manifest?.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

function skillMatchesQuery(skill: SkillSummary, query: string, locale: Locale): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    skill.id,
    skill.name,
    localizeSkillName(locale, skill),
    skill.description,
    localizeSkillDescription(locale, skill),
    skill.mode,
    skill.surface ?? '',
    ...skill.triggers,
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

function mcpServerMatchesQuery(server: McpServerConfig, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    server.id,
    server.label ?? '',
    server.transport,
    server.url ?? '',
    server.command ?? '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

function connectorMatchesQuery(connector: ConnectorDetail, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    connector.id,
    connector.name,
    connector.provider,
    connector.category,
    connector.description ?? '',
    connector.accountLabel ?? '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPluginSourceLabel(plugin: InstalledPluginRecord): string {
  return plugin.sourceKind === 'bundled' ? 'Official' : 'My plugin';
}

function getPluginQueryPreview(plugin: InstalledPluginRecord): string {
  const raw = plugin.manifest?.od?.useCase?.query;
  const value =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw.en ?? raw['zh-CN'] ?? Object.values(raw).find((entry): entry is string => (
            typeof entry === 'string' && entry.length > 0
          )) ?? ''
        : '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 96 ? `${trimmed.slice(0, 96)}…` : trimmed;
}

interface RailGroupProps {
  group: ChipGroup;
  activeChipId: string | null;
  pendingChipId: string | null;
  pendingPluginId: string | null;
  pluginsLoading: boolean;
  onPickChip: (chip: HomeHeroChip) => void;
  variant?: 'rail' | 'tabs';
  // First-run guide: this chip carries the attention sheen.
  pulseChipId?: string | null;
  // Hover-preview hook: the create rail reports which chip the pointer is over
  // (or null on leave) so the footer Template picker can preview it.
  onHoverChip?: (chipId: string | null) => void;
  children?: ReactNode;
}

function RailGroup({
  group,
  activeChipId,
  pendingChipId,
  pendingPluginId,
  pluginsLoading,
  onPickChip,
  variant = 'rail',
  pulseChipId = null,
  onHoverChip,
  children,
}: RailGroupProps) {
  const t = useT();
  // The inline create rail leads with the slide deck and runs through the core
  // build scenarios in a fixed order (see `orderedCreateChips`); every other
  // group renders in catalog order.
  const chips = useMemo(
    () => (group === 'create' ? orderedCreateChips() : chipsForGroup(group)),
    [group],
  );
  const isTabs = variant === 'tabs';

  // Edge auto-scroll so the overflowing scenario rail stays reachable without a
  // trackpad (see EdgeAutoScroll). Only the tabs variant scrolls; for the
  // legacy rail variant scrollRef stays unattached and the hook is inert.
  const edgeScroll = useEdgeAutoScroll(chips.length);

  const cards = chips.map((chip) => {
    const isActive = activeChipId === chip.id;
    const isPending = pendingChipId === chip.id;
    const disabled = pluginsLoading || isPending || pendingPluginId !== null;
    const nextStep = homeHeroChipTitle(chip, t);
    // Card variant (the default create rail): an illustrated scenario card —
    // an intent thumbnail (ScenarioArt) + title + one-line description. The
    // full "what happens next" sentence stays on the native `title` tooltip
    // instead of an inline line that resized the card on hover. The legacy
    // `rail`/pill markup is kept for any caller that still asks for `variant="rail"`.
    if (isTabs) {
      const description = homeHeroChipDescription(chip.id, t);
      const cardCls = ['home-hero__type-tab', `home-hero__type-tab--${group}`, 'home-hero__scenario-card'];
      if (isActive) cardCls.push('is-active');
      if (isPending) cardCls.push('is-pending');
      if (pulseChipId === chip.id) cardCls.push('home-hero__attention-sheen');
      return (
        <button
          key={chip.id}
          type="button"
          className={cardCls.join(' ')}
          data-chip-id={chip.id}
          data-testid={`home-hero-rail-${chip.id}`}
          onClick={() => onPickChip(chip)}
          onMouseEnter={() => onHoverChip?.(chip.id)}
          disabled={disabled}
          role="tab"
          aria-selected={isActive}
          title={nextStep}
        >
          <span className="home-hero__scenario-card-art" aria-hidden>
            <ScenarioArt chipId={chip.id} fallbackIcon={chip.icon} />
          </span>
          <span className="home-hero__scenario-card-body">
            <span className="home-hero__scenario-card-title home-hero__type-tab-label">
              {homeHeroChipLabel(chip.id, t)}
            </span>
            {description ? (
              <span className="home-hero__scenario-card-desc">{description}</span>
            ) : null}
          </span>
        </button>
      );
    }
    const cls = ['home-hero__rail-chip', `home-hero__rail-chip--${group}`];
    if (isActive) cls.push('is-active');
    if (isPending) cls.push('is-pending');
    if (pulseChipId === chip.id) cls.push('home-hero__attention-sheen');
    return (
      <button
        key={chip.id}
        type="button"
        className={cls.join(' ')}
        data-chip-id={chip.id}
        data-testid={`home-hero-rail-${chip.id}`}
        onClick={() => onPickChip(chip)}
        disabled={disabled}
        aria-pressed={isActive}
        title={nextStep}
      >
        <Icon
          name={chip.icon}
          size={14}
          className="home-hero__rail-chip-icon"
        />
        <span className="home-hero__rail-chip-label">
          {homeHeroChipLabel(chip.id, t)}
        </span>
      </button>
    );
  });

  if (isTabs) {
    return (
      <div
        className="home-hero__scenario-cards-wrap"
        onMouseLeave={() => onHoverChip?.(null)}
      >
        <div
          ref={edgeScroll.scrollRef}
          className={`home-hero__type-tabs home-hero__type-tabs--${group} home-hero__scenario-cards`}
          data-testid="home-hero-type-tabs"
          data-rail-group={group}
          role="tablist"
          aria-label={t('homeHero.railAria')}
        >
          {cards}
          {children}
        </div>
        <EdgeScrollZones {...edgeScroll} />
      </div>
    );
  }

  return (
    <div
      className={`home-hero__rail-group home-hero__rail-group--${group}`}
      data-rail-group={group}
    >
      {cards}
      {children}
    </div>
  );
}

function SubTypeChip({
  sub,
  isActive,
  pluginsLoading,
  onPick,
}: {
  sub: HomeHeroSubChip;
  isActive: boolean;
  pluginsLoading: boolean;
  onPick: (sub: HomeHeroSubChip) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={`home-hero__subtype-chip${isActive ? ' is-active' : ''}`}
      data-sub-chip-id={sub.slug}
      data-testid={`home-hero-subtype-${sub.slug}`}
      onClick={() => onPick(sub)}
      disabled={pluginsLoading}
      role="tab"
      aria-selected={isActive}
    >
      <Icon name={sub.icon} size={13} className="home-hero__subtype-chip-icon" />
      <span className="home-hero__subtype-chip-label">
        {homeHeroSubChipLabel(sub, t)}
      </span>
    </button>
  );
}

export function SubTypeRow({
  subChips,
  selectedSlug,
  pluginsLoading,
  onPickSubChip,
  onSelectAll,
}: {
  subChips: HomeHeroSubChip[];
  selectedSlug: string | null;
  pluginsLoading: boolean;
  onPickSubChip: (sub: HomeHeroSubChip) => void;
  onSelectAll: () => void;
}) {
  const t = useT();
  const allActive = selectedSlug === null;
  const rowRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  // How many sub-chips fit on one line after the always-present "All" chip;
  // the rest collapse into a "More" dropdown so the row never wraps.
  const [visibleCount, setVisibleCount] = useState(subChips.length);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  // Measure against the always-full hidden ghost row so chip widths are stable
  // no matter what the visible row currently shows, then pick the largest
  // prefix that fits (reserving room for the More button when it's needed).
  const measure = useCallback(() => {
    const row = rowRef.current;
    const ghost = measureRef.current;
    if (!row || !ghost) return;
    // `clientWidth` includes the row's own horizontal padding, which no chip
    // can occupy. Counting it as usable width let a chip that does not fit
    // beside More survive the cutoff and wrap the row.
    const style = row.ownerDocument.defaultView?.getComputedStyle(row) ?? null;
    const padding = style
      ? (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
      : 0;
    const avail = row.clientWidth - padding;
    if (avail <= 0) return;
    const gap = 5;
    const allWidth = ghost.querySelector<HTMLElement>('[data-measure="all"]')?.offsetWidth ?? 0;
    const moreWidth = ghost.querySelector<HTMLElement>('[data-measure="more"]')?.offsetWidth ?? 0;
    const chipEls = Array.from(ghost.querySelectorAll<HTMLElement>('[data-measure="chip"]'));
    // Everything (All + every chip) fits: no More button needed.
    let full = allWidth;
    for (const el of chipEls) full += gap + el.offsetWidth;
    if (full <= avail) {
      setVisibleCount(chipEls.length);
      return;
    }
    // Overflow: reserve the More button and count the fitting prefix.
    const budget = avail - gap - moreWidth;
    let used = allWidth;
    let count = 0;
    for (let i = 0; i < chipEls.length; i++) {
      const next = used + gap + chipEls[i]!.offsetWidth;
      if (next <= budget) {
        used = next;
        count = i + 1;
      } else {
        break;
      }
    }
    setVisibleCount(count);
  }, []);

  // Chip widths are a function of their LABELS, so the measurement has to be
  // redone when the labels change — switching locale rewrites every chip
  // without resizing the row, and a resize is the only other thing that
  // triggers this.
  const labelSignature = useMemo(
    () => [
      t('common.all'),
      t('homeHero.subTypeMore'),
      ...subChips.map((sub) => homeHeroSubChipLabel(sub, t)),
    ].join('\u0000'),
    [subChips, t],
  );

  useLayoutEffect(() => {
    measure();
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [measure, subChips, labelSignature]);

  // Close the More menu on outside pointer / Escape.
  useEffect(() => {
    if (!moreOpen) return undefined;
    function onDown(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMoreOpen(false);
    }
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [moreOpen]);

  const visibleChips = subChips.slice(0, visibleCount);
  const overflowChips = subChips.slice(visibleCount);
  const overflowActive = overflowChips.some((sub) => sub.slug === selectedSlug);
  const allChip = (
    <button
      type="button"
      className={`home-hero__subtype-chip${allActive ? ' is-active' : ''}`}
      data-sub-chip-id="all"
      data-testid="home-hero-subtype-all"
      onClick={onSelectAll}
      disabled={pluginsLoading}
      role="tab"
      aria-selected={allActive}
    >
      <span className="home-hero__subtype-chip-label">{t('common.all')}</span>
    </button>
  );

  return (
    <div
      ref={rowRef}
      className="home-hero__subtype-row"
      data-testid="home-hero-subtype-row"
      role="tablist"
      aria-label={t('homeHero.subTypeAria')}
    >
      {allChip}
      {visibleChips.map((sub) => (
        <SubTypeChip
          key={sub.slug}
          sub={sub}
          isActive={sub.slug === selectedSlug}
          pluginsLoading={pluginsLoading}
          onPick={onPickSubChip}
        />
      ))}
      {overflowChips.length > 0 ? (
        <div className="home-hero__subtype-more" ref={moreRef}>
          <button
            type="button"
            className={`home-hero__subtype-chip home-hero__subtype-more-btn${overflowActive ? ' is-active' : ''}`}
            data-testid="home-hero-subtype-more"
            onClick={() => setMoreOpen((open) => !open)}
            disabled={pluginsLoading}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
          >
            <span className="home-hero__subtype-chip-label">{t('homeHero.subTypeMore')}</span>
            <Icon name="chevron-down" size={12} className="home-hero__subtype-chip-icon" />
          </button>
          {moreOpen ? (
            <div className="home-hero__subtype-more-menu" role="menu" aria-label={t('homeHero.subTypeMore')}>
              {overflowChips.map((sub) => {
                const isActive = sub.slug === selectedSlug;
                return (
                  <button
                    key={sub.slug}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={`home-hero__subtype-more-item${isActive ? ' is-active' : ''}`}
                    data-testid={`home-hero-subtype-more-${sub.slug}`}
                    disabled={pluginsLoading}
                    onClick={() => {
                      setMoreOpen(false);
                      onPickSubChip(sub);
                    }}
                  >
                    <Icon name={sub.icon} size={13} className="home-hero__subtype-chip-icon" />
                    <span className="home-hero__subtype-chip-label">
                      {homeHeroSubChipLabel(sub, t)}
                    </span>
                    {isActive ? <Icon name="check" size={13} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* Hidden ghost row: always the full set, used only to measure chip
          widths so the visible row can compute how many fit. */}
      <div className="home-hero__subtype-measure" aria-hidden ref={measureRef}>
        <span className="home-hero__subtype-chip" data-measure="all">
          <span className="home-hero__subtype-chip-label">{t('common.all')}</span>
        </span>
        {subChips.map((sub) => (
          <span key={sub.slug} className="home-hero__subtype-chip" data-measure="chip">
            <Icon name={sub.icon} size={13} className="home-hero__subtype-chip-icon" />
            <span className="home-hero__subtype-chip-label">
              {homeHeroSubChipLabel(sub, t)}
            </span>
          </span>
        ))}
        <span className="home-hero__subtype-chip home-hero__subtype-more-btn" data-measure="more">
          <span className="home-hero__subtype-chip-label">{t('homeHero.subTypeMore')}</span>
          <Icon name="chevron-down" size={12} className="home-hero__subtype-chip-icon" />
        </span>
      </div>
    </div>
  );
}

function homeHeroSubChipLabel(
  sub: HomeHeroSubChip,
  t: ReturnType<typeof useT>,
): string {
  // A chip whose vocabulary the product owns (the atlas spines) names its own
  // dictionary key; facet-derived chips fall through to the catalog labels.
  if (sub.labelKey) return t(sub.labelKey);
  if (sub.slug === 'mobile') return t('homeHero.chip.mobile');
  if (sub.slug === 'wireframe') return t('homeHero.chip.wireframe');
  return pluginSubfacetLabel(sub.slug, sub.label, t);
}

interface ShortcutsMenuProps {
  activeChipId: string | null;
  pendingChipId: string | null;
  pendingPluginId: string | null;
  pluginsLoading: boolean;
  open: boolean;
  refNode: RefObject<HTMLDivElement>;
  onOpenChange: (open: boolean) => void;
  onPickChip: (chip: HomeHeroChip) => void;
}

function ShortcutsMenu({
  activeChipId,
  pendingChipId,
  pendingPluginId,
  pluginsLoading,
  open,
  refNode,
  onOpenChange,
  onPickChip,
}: ShortcutsMenuProps) {
  const t = useT();
  const shortcuts = useMemo(() => chipsForGroup('migrate'), []);
  const disabled = pluginsLoading || pendingPluginId !== null;
  const hasActiveShortcut = shortcuts.some((chip) => chip.id === activeChipId);
  const hasPendingShortcut = shortcuts.some((chip) => chip.id === pendingChipId);
  const triggerClass = [
    'home-hero__type-tab',
    'home-hero__type-tab--more',
    hasActiveShortcut ? 'is-active' : '',
    hasPendingShortcut ? 'is-pending' : '',
  ].filter(Boolean).join(' ');

  // The trigger lives inside the horizontally-scrolling rail, whose
  // `overflow-x: auto` also clips vertically — so an in-flow dropdown gets
  // truncated. Portal the panel to the body with fixed positioning anchored to
  // the trigger, and keep it aligned as the rail scrolls or the window resizes.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(
    null,
  );
  useEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPanelPos({
        top: Math.round(rect.bottom + 6),
        right: Math.round(window.innerWidth - rect.right),
      });
    };
    update();
    window.addEventListener('resize', update);
    // Capture phase: scroll events don't bubble, so this is how the panel
    // follows the trigger when the rail itself scrolls.
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  return (
    <div
      ref={refNode}
      className="home-hero__shortcut-menu"
      data-testid="home-hero-shortcuts"
      data-rail-group="migrate"
    >
      <button
        ref={triggerRef}
        type="button"
        className={triggerClass}
        data-testid="home-hero-shortcuts-trigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('homeHero.moreShortcuts')}
        title={t('homeHero.moreShortcuts')}
        onClick={() => onOpenChange(!open)}
      >
        <Icon name="more-horizontal" size={16} className="home-hero__type-tab-icon" />
      </button>
      {open && panelPos
        ? createPortal(
        <div
          className="home-hero__shortcut-menu-panel"
          role="menu"
          aria-label={t('homeHero.moreShortcuts')}
          data-testid="home-hero-shortcuts-menu"
          data-shortcuts-panel=""
          data-rail-group="migrate"
          style={{ position: 'fixed', top: panelPos.top, right: panelPos.right }}
        >
          {shortcuts.map((chip) => {
            const isActive = activeChipId === chip.id;
            const isPending = pendingChipId === chip.id;
            const cls = ['home-hero__shortcut-menu-item'];
            if (isActive) cls.push('is-active');
            if (isPending) cls.push('is-pending');
            return (
              <button
                key={chip.id}
                type="button"
                role="menuitem"
                className={cls.join(' ')}
                data-chip-id={chip.id}
                data-testid={`home-hero-rail-${chip.id}`}
                disabled={pluginsLoading || isPending || pendingPluginId !== null}
                title={homeHeroChipTitle(chip, t)}
                onClick={() => onPickChip(chip)}
              >
                <Icon name={chip.icon} size={14} className="home-hero__shortcut-menu-icon" />
                <span>{homeHeroChipLabel(chip.id, t)}</span>
              </button>
            );
          })}
        </div>,
          document.body,
        )
        : null}
    </div>
  );
}

// Scenario subtitle shown under the title on the illustrated card rail.
function homeHeroChipDescription(chipId: string, t: ReturnType<typeof useT>): string {
  switch (chipId) {
    case 'prototype': return t('homeHero.chip.prototypeDesc');
    case 'web-clone': return t('homeHero.chip.webCloneDesc');
    case 'wireframe': return t('homeHero.chip.wireframeDesc');
    case 'mobile': return t('homeHero.chip.mobileDesc');
    case 'deck': return t('homeHero.chip.deckDesc');
    case 'document': return t('homeHero.chip.documentDesc');
    case 'image': return t('homeHero.chip.imageDesc');
    case 'video': return t('homeHero.chip.videoDesc');
    case 'audio': return t('homeHero.chip.audioDesc');
    case 'hyperframes': return t('homeHero.chip.hyperframesDesc');
    case 'webgl': return t('homeHero.chip.webglDesc');
    case 'live-artifact': return t('homeHero.chip.liveArtifactDesc');
    case 'create-brand-kit': return t('homeHero.chip.createBrandKitDesc');
    default: return '';
  }
}

// The hover "what happens next" line — describes how the scenario will be
// consumed once picked (e.g. "Open a chat that builds a clickable prototype").
function homeHeroChipTitle(chip: HomeHeroChip, t: ReturnType<typeof useT>): string {
  switch (chip.id) {
    case 'prototype': return t('homeHero.chip.prototypeNext');
    case 'web-clone': return t('homeHero.chip.webCloneNext');
    case 'wireframe': return t('homeHero.chip.wireframeNext');
    case 'mobile': return t('homeHero.chip.mobileNext');
    case 'deck': return t('homeHero.chip.deckNext');
    case 'document': return t('homeHero.chip.documentNext');
    case 'image': return t('homeHero.chip.imageNext');
    case 'video': return t('homeHero.chip.videoNext');
    case 'audio': return t('homeHero.chip.audioNext');
    case 'live-artifact': return t('homeHero.chip.liveArtifactHint');
    case 'hyperframes': return t('homeHero.chip.hyperframesHint');
    case 'create-brand-kit': return t('homeHero.chip.createBrandKitHint');
    case 'create-plugin': return t('homeHero.chip.createPluginHint');
    case 'figma': return t('homeHero.chip.figmaHint');
    case 'template': return t('homeHero.chip.templateHint');
    default: return homeHeroChipLabel(chip.id, t);
  }
}

// Generic catch-all scenario routers are not real "example" templates: they
// ship no concrete seed for the gallery and only exist as the silent default
// binding a media surface carries (see scenario-defaults.ts). Keep them out of
// the example-prompt presets so e.g. the "Media generation (default scenario)"
// card never appears under the audio/image/video chips — and, because the
// example card's selected state is keyed on the active plugin id, never shows
// up pre-selected when a media mode is entered.
//
// `example-web-clone` is the Website clone chip's own base scenario, not a
// concrete example. The per-site examples are plain text prompt cards (from
// HOME_PROMPT_EXAMPLES) rather than plugins, so hide the base plugin to keep the
// preset rail empty for web-clone and let those text cards show instead.
const EXAMPLE_PRESET_HIDDEN_PLUGIN_IDS = new Set<string>([
  'od-media-generation',
  'example-web-clone',
]);

export function homeHeroExamplePluginsForChip(
  chipId: string,
  plugins: InstalledPluginRecord[],
  locale: Locale,
): InstalledPluginRecord[] {
  // The top-level rail is a curated showcase capped at 18 for most chips. The
  // deck chip is the exception: surface the FULL slide-template library so every
  // bundled deck is reachable as an example prompt straight from "All" (without
  // first picking a sub-category), keeping the rail in parity with the Community
  // section's "Slides" count.
  const showcaseLimit = chipId === 'deck' ? Number.POSITIVE_INFINITY : 18;
  const presets = plugins
    .filter((plugin) => !EXAMPLE_PRESET_HIDDEN_PLUGIN_IDS.has(plugin.id))
    .filter((plugin) => (
      pluginMatchesExampleChip(plugin, chipId) ||
      curatedPluginPriorityForChip(plugin, chipId) !== null
    ))
    .filter((plugin) => (
      Boolean(pluginPresetQuery(plugin, locale)) ||
      curatedPluginPriorityForChip(plugin, chipId) !== null
    ))
    .sort((a, b) => comparePluginPresetOrder(a, b, chipId))
    .slice(0, showcaseLimit);
  if (chipId === 'image') {
    return movePluginPresetToEnd(presets, 'example-hatch-pet');
  }
  return presets;
}

function comparePluginPresetOrder(
  a: InstalledPluginRecord,
  b: InstalledPluginRecord,
  chipId: string,
): number {
  // Gallery order (OPEND-449): pins first, default seeds + no-preview tiles sunk
  // to the bottom, then usage popularity for non-prototype chips. The prototype
  // chip stays curation-governed, so popularity is skipped and it keeps its
  // curated order.
  const curationGoverned = chipId === 'prototype';
  const gallery = comparePluginGalleryOrder(a.id, b.id, curationGoverned, curationGoverned);
  if (gallery !== 0) return gallery;
  const aCurated = curatedPluginPriorityForChip(a, chipId);
  const bCurated = curatedPluginPriorityForChip(b, chipId);
  if (aCurated !== null || bCurated !== null) {
    if (aCurated !== null && bCurated === null) return -1;
    if (aCurated === null && bCurated !== null) return 1;
    if (aCurated !== bCurated) return (aCurated ?? 0) - (bCurated ?? 0);
  }
  const rankDelta = pluginPresetRank(b, chipId) - pluginPresetRank(a, chipId);
  if (rankDelta !== 0) return rankDelta;
  return (a.title || a.id).localeCompare(b.title || b.id);
}

function movePluginPresetToEnd(
  records: InstalledPluginRecord[],
  pluginId: string,
): InstalledPluginRecord[] {
  const index = records.findIndex((record) => record.id === pluginId);
  if (index < 0 || index === records.length - 1) return records;
  const record = records[index]!;
  return [
    ...records.slice(0, index),
    ...records.slice(index + 1),
    record,
  ];
}

export function pluginMatchesExampleChip(record: InstalledPluginRecord, chipId: string): boolean {
  const slugs = pluginRecordSlugs(record);
  const has = (...values: string[]) => values.some((value) => slugs.has(value));
  const hasPart = (...values: string[]) => {
    const all = [...slugs];
    return values.some((value) =>
      all.some((slug) => slug === value || slug.includes(value) || slug.split('-').includes(value)),
    );
  };
  switch (chipId) {
    case 'prototype':
      return has('prototype') || hasPart('web-prototype');
    case 'web-clone':
      // Website reproduction flows (e.g. example-web-clone / site-clone kits).
      return has('web-clone', 'website-clone', 'site-clone') || hasPart('web-clone', 'website-clone');
    case 'wireframe':
      // Lo-fi / sketch / whiteboard explorations (e.g. wireframe-sketch).
      return (
        hasPart('wireframe') ||
        has('low-fidelity', 'lo-fi-mockup', 'sketch-wireframe', 'whiteboard-sketch', 'hand-drawn')
      );
    case 'mobile':
      // Native mobile app prototypes: iOS / Android phone screens.
      return (
        (hasPart('mobile') ||
          has('ios-app', 'android-app', 'phone-screen', 'app-mockup', 'app-ui')) &&
        !hasPart('video', 'audio', 'image', 'hyperframes')
      );
    case 'document':
      // Documents: resumes, reports, invoices, papers, briefs, PDFs.
      return (
        (has('resume', 'cv', 'invoice', 'document', 'docs', 'report', 'paper') ||
          hasPart(
            'resume',
            'documentation',
            'invoice',
            'report',
            'whitepaper',
            'academic-paper',
            'case-report',
            'meeting-notes',
            'runbook',
            'eguide',
            'letter',
            'dossier',
            'memo',
          )) &&
        !hasPart('video', 'audio', 'hyperframes', 'deck', 'slides')
      );
    case 'deck':
      return has('deck', 'slides', 'slide-deck') || hasPart('slide', 'deck');
    case 'hyperframes':
      return hasPart('hyperframes', 'hyperframe');
    case 'live-artifact':
      return has('live-artifact') || hasPart('live-artifact');
    case 'webgl':
      return (
        has('webgl', 'webgl2', 'shader', 'gpu') ||
        hasPart('webgl', 'shader', 'gpu')
      );
    case 'image':
      return (has('image') || hasPart('image-template')) && !hasPart('video', 'audio', 'live-artifact');
    case 'video':
      return (has('video') || hasPart('video-template')) && !hasPart('hyperframes', 'audio');
    case 'audio':
      // Exclude video / HyperFrames templates that merely carry an
      // `audio-reactive` tag (substring-matched by hasPart('audio')): their
      // home is the Video / HyperFrames chips, not the audio gallery.
      return (has('audio') || hasPart('audio')) && !hasPart('video', 'hyperframes');
    default:
      return false;
  }
}

function pluginPresetRank(record: InstalledPluginRecord, chipId: string): number {
  const slugs = pluginRecordSlugs(record);
  let score = 0;
  if (record.sourceKind === 'bundled') score += 20;
  if (record.id.startsWith('example-')) score += 12;
  if (record.id.includes('template')) score += 8;
  if (inferPluginPreview(record).kind !== 'text') score += 6;
  if (slugs.has(chipId)) score += 4;
  if (record.manifest?.od?.preview) score += 3;
  return score;
}

function pluginRecordSlugs(record: InstalledPluginRecord): Set<string> {
  const od = record.manifest?.od ?? {};
  const rawValues = [
    record.id,
    record.title,
    record.manifest?.name,
    record.manifest?.title,
    fieldString(od, 'mode'),
    fieldString(od, 'surface'),
    fieldString(od, 'scenario'),
    fieldString(od, 'taskKind'),
    ...(record.manifest?.tags ?? []),
  ];
  return new Set(rawValues.map((value) => slugifyHomeValue(value ?? '')).filter(Boolean));
}

function fieldString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function slugifyHomeValue(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function pluginPresetPromptPreview(
  record: InstalledPluginRecord,
  locale: Locale,
  chipId: string,
): string {
  const query = pluginPresetQuery(record, locale);
  const rendered = query
    ? renderPluginPresetQuery(record, query)
    : localizePluginDescription(locale, record);
  return textPromptForPluginPreset(record, rendered, chipId, locale);
}

function textPromptForPluginPreset(
  record: InstalledPluginRecord,
  prompt: string,
  chipId: string,
  locale: Locale,
): string {
  const cleaned = prompt.trim();
  const structured = parseStructuredPresetPrompt(cleaned);
  if (structured !== null) {
    return describeStructuredPresetPrompt(record, structured, chipId, locale);
  }
  if (cleaned.length > 0) return cleaned;
  return fallbackPluginPresetPrompt(record, chipId, locale);
}

function parseStructuredPresetPrompt(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function describeStructuredPresetPrompt(
  record: InstalledPluginRecord,
  structured: unknown,
  chipId: string,
  locale: Locale,
): string {
  const artifact = pluginPresetArtifactLabel(chipId);
  const title = localizePluginTitle(locale, record).trim();
  const strings = collectStructuredPromptStrings(structured);
  const main =
    strings.find((item) => isMainPromptField(item.key) && item.value.length >= 8)?.value ??
    strings.find((item) => item.value.length >= 16)?.value ??
    (localizePluginDescription(locale, record) || title);
  const detailValues = uniquePromptStrings(
    strings
      .filter((item) => item.value !== main)
      .filter((item) => isUsefulPromptDetail(item.value))
      .map((item) => item.value),
  ).slice(0, 4);
  const details = detailValues.length > 0
    ? ` Include ${detailValues.join('; ')}.`
    : '';
  return `Create ${englishArticle(artifact)} ${artifact} with the "${title}" preset. ${main}${englishSentenceEnd(main)}${details}`;
}

function collectStructuredPromptStrings(
  value: unknown,
  path: string[] = [],
): Array<{ key: string; value: string }> {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    return [{ key: path[path.length - 1] ?? '', value: text }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStructuredPromptStrings(item, [...path, String(index)]));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectStructuredPromptStrings(child, [...path, key]),
    );
  }
  return [];
}

function isMainPromptField(key: string): boolean {
  return [
    'instruction',
    'prompt',
    'description',
    'subject',
    'brief',
    'goal',
  ].includes(key.toLowerCase());
}

function isUsefulPromptDetail(value: string): boolean {
  if (value.length < 8) return false;
  if (/^l\d+:/iu.test(value)) return false;
  return true;
}

function uniquePromptStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function englishSentenceEnd(value: string): string {
  return /[.!?。！？]$/u.test(value.trim()) ? '' : '.';
}

function pluginPresetArtifactLabel(chipId: string): string {
  switch (chipId) {
    case 'prototype': return 'interactive prototype';
    case 'deck': return 'PPT slide deck';
    case 'image': return 'image';
    case 'video': return 'video';
    case 'hyperframes': return 'HyperFrames motion video';
    case 'audio': return 'audio clip';
    default: return 'design artifact';
  }
}

function englishArticle(noun: string): 'a' | 'an' {
  return /^[aeiou]/iu.test(noun) ? 'an' : 'a';
}

function fallbackPluginPresetPrompt(
  record: InstalledPluginRecord,
  chipId: string,
  locale: Locale,
): string {
  const artifact = pluginPresetArtifactLabel(chipId);
  const title = localizePluginTitle(locale, record);
  const description = localizePluginDescription(locale, record).trim();
  return `Create ${englishArticle(artifact)} ${artifact} with the "${title}" preset${description ? `: ${description}` : '.'}`;
}

const HOME_PROMPT_EXAMPLES: Record<Locale, Record<string, string[]>> = {
  "en": {
    "web-clone": [
      "Website URL to clone: https://example.com",
    ],
    prototype: [
      "Design a high-converting website for an AI CRM with a clear hero, feature story, proof points, and trial CTA",
      "Create a desktop dashboard for a team knowledge base with search, recent updates, permissions, and collaboration entry points",
      "Redesign onboarding for a financial SaaS product so new users can connect data, finish setup, and see first value fast",
      "Prototype a mobile fitness coaching app covering goal setup, weekly plans, workout check-ins, and progress review",
    ],
    wireframe: [
      "Wireframe a SaaS dashboard with navigation, key metrics, a data table, and an empty state",
      "Sketch the lo-fi flow for a checkout: cart, shipping, payment, and confirmation screens",
      "Lay out a content management screen with list, detail, and edit states in greybox fidelity",
      "Wireframe an onboarding wizard covering account, workspace, invite, and first-run steps",
    ],
    mobile: [
      "Design a mobile banking app with home balance, transactions, transfer, and card management screens",
      "Lay out a food delivery app covering browse, restaurant detail, cart, and order tracking",
      "Prototype a habit-tracker app with today view, streak detail, add-habit, and stats screens",
      "Design a messaging app with chat list, conversation, profile, and settings screens",
    ],
    document: [
      "Draft a one-page resume for a senior product designer with summary, experience, skills, and selected work",
      "Write a polished project proposal with problem, approach, timeline, and budget sections",
      "Create a product one-pager covering the pitch, key features, pricing, and a call to action",
      "Generate a tidy meeting brief with agenda, decisions, owners, and next steps",
    ],
    deck: [
      "Research the market opportunity for a product launch, including competitors, target users, pricing hypotheses, and launch narrative",
      "Generate a weekly team status report with progress, risks, metric changes, and next-week priorities",
      "Design an investor pitch with market sizing, growth model, product advantage, and three-year forecast data",
      "Create a strategic business review deck covering quarterly performance, root causes, opportunities, and next actions",
    ],
    image: [
      "Generate a glassmorphism AI workspace poster with multi-screen collaboration, soft lighting, and a premium launch mood",
      "Create an ecommerce hero image for new wireless headphones that highlights material detail, lifestyle context, and core benefits",
      "Design a minimalist tech launch key visual with a clean composition, strong product focus, and restrained launch copy",
      "Make a social teaser set for a product drop, including countdown, close-up detail, benefit reveal, and launch-day visual",
    ],
    video: [
      "Make an 8-second product reveal film that moves from silhouette to close-up detail and ends on the brand mark",
      "Generate an app feature demo video that follows the user journey, key states, and final outcome",
      "Create a vertical brand opener with rhythmic typography, product close-ups, and a clean logo ending for short-form video",
      "Turn a website into a 15-second social ad by extracting the hero claim, interaction highlights, and a clear CTA",
    ],
    hyperframes: [
      "Build a captioned product launch short with title cards, feature shots, rhythmic transitions, and an ending CTA",
      "Generate an audio-reactive data visualization where bars, particles, and titles respond to narration beats",
      "Create a 3-second logo outro using line convergence, subtle elasticity, and the brand color system",
      "Make an animated flight-route map showing city nodes, route growth, mileage data, and a final summary frame",
    ],
    audio: [
      "Generate a product startup sound that feels light, trustworthy, slightly futuristic, and suitable for a desktop app launch",
      "Create a 20-second podcast intro bed with a warm opening, clear pulse, and a clean handoff into voiceover",
      "Make a seamless ambient loop for a meditation app using soft nature textures, low-frequency warmth, and calm pacing",
      "Generate a branded notification sound set for success, reminder, and error states while keeping one sonic identity",
    ],
  },

};

export const HOME_PROMPT_EXAMPLE_CHIP_IDS = [
  'prototype',
  'deck',
  'image',
  'video',
  'hyperframes',
  'audio',
] as const;

// Every supported locale must resolve its own localized example prompts; a
// missing locale entry would silently bleed English into the home composer,
// which is the regression this table exists to prevent.
export function homeHeroChipPromptExamplesForLocale(chipId: string, locale: Locale): string[] {
  return HOME_PROMPT_EXAMPLES[locale]?.[chipId] ?? HOME_PROMPT_EXAMPLES.en[chipId] ?? [];
}

function homeHeroChipPromptExamples(chipId: string, locale: Locale): string[] {
  return homeHeroChipPromptExamplesForLocale(chipId, locale);
}


function briefForChipId(chipId: string): Record<string, string> {
  switch (chipId) {
    case 'prototype':
      return { artifact_type: 'web prototype', audience: 'product evaluators', fidelity: 'high-fidelity' };
    case 'web-clone':
      return { artifact_type: 'website clone', source: 'target URL', fidelity: 'source-first visual reproduction' };
    case 'wireframe':
      return { artifact_type: 'lo-fi wireframe', audience: 'product team', fidelity: 'wireframe' };
    case 'mobile':
      return { artifact_type: 'mobile app prototype', audience: 'product evaluators', platform: 'iOS & Android' };
    case 'document':
      return { artifact_type: 'document (resume / report / PDF)', audience: 'readers' };
    case 'deck':
      return { artifact_type: 'pitch deck / presentation', audience: 'decision makers', slide_count: '10-15 pages' };
    case 'image':
      return { artifact_type: 'image', style: 'cinematic, high-quality, on-brand' };
    case 'video':
      return { artifact_type: 'video', style: 'cinematic, high-quality, on-brand' };
    case 'hyperframes':
      return { artifact_type: 'motion graphic / animated sequence', style: 'cinematic, polished transitions' };
    case 'audio':
      return { artifact_type: 'audio', style: 'professional, polished, brand-appropriate' };
    default:
      return { artifact_type: chipId };
  }
}

function briefForPluginPreset(record: InstalledPluginRecord, chipId: string): Record<string, string> {
  const brief: Record<string, string> = { ...briefForChipId(chipId) };
  const fields = record.manifest?.od?.inputs ?? [];
  for (const field of fields) {
    const value = field.default ?? field.placeholder;
    if (value != null && typeof value === 'string' && value.trim()) {
      brief[field.name] = value;
    }
  }
  return brief;
}
