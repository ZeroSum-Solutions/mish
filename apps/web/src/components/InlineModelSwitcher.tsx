// InlineModelSwitcher — top-bar chip exposing CLI/BYOK + model picker.
//
// Lives in the entry view's sticky top-bar so users can swap between a
// local CLI and BYOK (and the active model under either) without having
// to open the full Settings dialog. The chip is intentionally narrow —
// it shows the active mode + agent/provider + model in one line and
// opens a compact popover for switching. All persistence is delegated
// upward through the same callbacks `AvatarMenu` already uses, so the
// switcher inherits autosave + daemon sync without re-implementing it.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from 'react';
import type { AmrWalletSnapshot } from '@mish/contracts';
import { Chip, VisuallyHidden } from '@mish/components';
import { useT } from '../i18n';
import {
  agentIdToTracking,
  byokProtocolToTracking,
  modelIdForTracking,
} from '@mish/contracts/analytics';
import { useAnalytics } from '../analytics/provider';
import {
  amrHandoffDeviceId,
  attributedAmrUrl,
  recordAmrEntry,
  type AmrEntryAttribution,
} from '../analytics/amr-attribution';
import { amrPlansUrlForProfile } from '../runtime/amr-guidance';
import { getResolvedDeviceId } from '../analytics/client';
import {
  trackDeepSeekCampaignModelBenefitSurfaceView,
  trackExecutionSettingsPopoverClick,
} from '../analytics/events';
import {
  beginAmrAuthTracking,
  confirmAmrAuthTracking,
  observeAmrAuthTracking,
  reconcileAmrAuthAttemptId,
  resolveAmrAuthTracking,
} from '../analytics/amr-auth';
import {
  useWorkspaceBillingResponse,
  useWorkspaceContext,
  workspaceBillingBalanceUsd,
} from '../collab/useWorkspaceContext';
import { KNOWN_PROVIDERS } from '../state/config';
import { fetchProviderModels } from '../providers/provider-models';
import { SUGGESTED_MODELS_BY_PROTOCOL } from '../state/apiProtocols';
import {
  canUpgradeVelaPlan,
  cancelVelaLogin,
  fetchAmrWalletSnapshot,
  fetchVelaLoginStatus,
  formatVelaBalanceUsd,
  startVelaLogin,
  type VelaLoginStatus,
} from '../providers/daemon';
import type { AgentInfo, ApiProtocol, AppConfig, ExecMode } from '../types';
import { apiProtocolLabel } from '../utils/apiProtocol';
import { isVisibleLocalCliAgent } from '../utils/visibleAgents';
import { AgentIcon } from './AgentIcon';
import { Icon } from './Icon';
import { modelProviderIconSrc } from './modelProviderIcon';
import { PlanBadge } from './PlanBadge';
import {
  AMR_LOGIN_STATUS_EVENT,
  AMR_LOGIN_POLL_INTERVAL_MS,
  AMR_LOGIN_STARTUP_SETTLE_MS,
  amrLoginPollOutcome,
  amrLoginStatusEventReason,
  isAmrSessionAuthenticated,
  notifyAmrLoginStatusChanged,
} from './amrLoginPolling';
import { orderAgentsWithMishFirst } from './agentOrdering';
import { anchorSelectionInView } from './pickerSelectionAnchor';
import {
  agentModelIsSelectable,
  defaultAgentModelId,
  effectiveAgentModelChoice,
  normalizeAgentModelChoice,
} from './agentModelSelection';
import {
  InlineModelList,
  orderModelOptionsByAvailability,
} from './modelOptions';
import { SelectionGroup, SelectionIndicator } from './ui/SelectionIndicator';
import styles from './InlineModelSwitcher.module.css';
import {
  mergeProviderModelOptions,
  providerModelsCacheKey,
  type ProviderModelsCache,
} from './providerModelsCache';
import { isDeepSeekV4FlashCampaignModel } from '../campaigns/deepseek-v4-flash';
import { useDeepSeekV4FlashCampaignVisibility } from '../campaigns/use-deepseek-v4-flash-campaign';

/**
 * AC-R02.3 pre-submit capability check: which of the current agent's models
 * cannot take the attachment(s) currently staged for this turn, and why. The
 * switcher never fetches this itself — a host that already called
 * `POST /api/workbench/sessions/:id/model/preflight` (or ran the model's own
 * candidate through the same logic locally) passes it in. Omitting the prop
 * leaves every row exactly as it rendered before this existed.
 */
export interface InlineModelSwitcherAttachmentWarning {
  /** Model IDs (within the currently selected agent) that cannot take the
   *  staged attachment. Scoped to one agent, not a cross-agent map, because
   *  the popover only ever shows one agent's models at a time. */
  unsupportedModelIds: ReadonlySet<string>;
  /** Short, human-readable reason shown as the row's title and read by
   *  screen readers; never a raw error code. */
  reason: string;
}

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  providerModelsCache?: ProviderModelsCache;
  compact?: boolean;
  openSignal?: number;
  showExecutionOptions?: boolean;
  nativeOnly?: boolean;
  preserveRequestedModel?: boolean;
  daemonLive: boolean;
  onModeChange: (mode: ExecMode) => void;
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string; serviceTier?: string },
  ) => void;
  onApiProtocolChange: (protocol: ApiProtocol) => void;
  onApiModelChange: (model: string) => void;
  /** Lets the home picker warm the shared cache itself. Without it the picker
   *  only READS the cache (warmed by Settings/onboarding), so on a fresh load
   *  the BYOK list falls back to the small static seed list. */
  onProviderModelsCacheChange?: Dispatch<SetStateAction<ProviderModelsCache>>;
  onOpenSettings: (
    section?:
      | 'execution'
      | 'media'
      | 'composio'
      | 'language'
      | 'appearance'
      | 'notifications'
      | 'pet'
      | 'about',
  ) => void;
  /**
   * Home only: the pinned "Build with Jev" row at the top of the popover. It is
   * not a provider model — it switches the composer into the agency fast lane
   * (`POST /api/agency/build`), the same mode as Home's "Build with Jev" chip.
   * While it is on, the chip names it instead of the model; picking a model,
   * an agent, an execution mode, a BYOK provider or a BYOK model turns it off,
   * so the chip never names the mode over a configuration the user just chose.
   * Omitted everywhere else.
   */
  buildWithJev?: {
    active: boolean;
    onChange: (active: boolean) => void;
  };
  /** See {@link InlineModelSwitcherAttachmentWarning}. Omitted by every
   *  caller that does not yet track staged attachments. */
  attachmentWarning?: InlineModelSwitcherAttachmentWarning;
}

const API_PROTOCOL_TABS: Array<{ id: ApiProtocol; title: string }> = [
  { id: 'anthropic', title: 'Anthropic' },
  { id: 'openai', title: 'OpenAI' },
  { id: 'azure', title: 'Azure' },
  { id: 'google', title: 'Google' },
  { id: 'aihubmix', title: 'AIHubMix' },
];

const AMR_REMINDER_SEEN_KEY = 'mish:inline-amr-cli-reminder-seen:v2';
let amrReminderSeenFallback = false;

function readAmrReminderSeen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage
      ? window.localStorage.getItem(AMR_REMINDER_SEEN_KEY) === '1'
      : amrReminderSeenFallback;
  } catch {
    return amrReminderSeenFallback;
  }
}

function markAmrReminderSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    if (window.localStorage) {
      window.localStorage.setItem(AMR_REMINDER_SEEN_KEY, '1');
      return;
    }
  } catch {
    // Ignore storage failures; the reminder is purely advisory UI.
  }
  amrReminderSeenFallback = true;
}

function displayAgentName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.id === 'amr' ? 'Mishh Mashh' : agent.name;
}

function displayAgentChipName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.id === 'amr' ? 'Mishh Mashh' : displayAgentName(agent);
}

/**
 * Roving tab focus for a horizontal tablist: Arrow keys step (wrapping) in
 * VISUAL order, so in a right-to-left layout ArrowLeft moves to the next tab;
 * Home and End jump to the ends. Returns null for keys the tablist ignores.
 */
export function stepTablistKey<T>(order: readonly T[], current: T, key: string, rtl: boolean): T | null {
  if (order.length === 0) return null;
  if (key === 'Home') return order[0]!;
  if (key === 'End') return order[order.length - 1]!;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const forward = (key === 'ArrowRight') !== rtl;
  const index = Math.max(0, order.indexOf(current));
  return order[(index + (forward ? 1 : -1) + order.length) % order.length]!;
}

export function InlineModelSwitcher({
  config,
  agents,
  providerModelsCache,
  compact = false,
  openSignal,
  showExecutionOptions = false,
  nativeOnly = false,
  preserveRequestedModel = false,
  daemonLive,
  onModeChange,
  onAgentChange,
  onAgentModelChange,
  onApiProtocolChange,
  onApiModelChange,
  onProviderModelsCacheChange,
  onOpenSettings,
  buildWithJev,
  attachmentWarning,
}: Props) {
  const t = useT();
  // Read through a ref so the model sinks below keep their identities; only an
  // explicit pick (never a normalization effect) turns the mode off.
  const buildWithJevRef = useRef(buildWithJev);
  buildWithJevRef.current = buildWithJev;
  const leaveBuildWithJev = useCallback(() => {
    const current = buildWithJevRef.current;
    if (current?.active) current.onChange(false);
  }, []);
  const jevActive = buildWithJev?.active === true;
  const analytics = useAnalytics();
  // This flag is a reserved presentation branch with no trigger wired yet.
  // It remains available for a real unpaid-audience signal reaching this
  // component without surfacing an unlimited-use claim in the model picker.
  const campaignNeedsUpgrade = false;
  const campaignVisibility = useDeepSeekV4FlashCampaignVisibility();
  // recvqfYKutwWlQ: gate the AMR upgrade entry on billing permission below,
  // not just plan tier — a team member without `canManageBilling` (owner-only)
  // can't act on an upgrade even when the tier itself is upgradeable.
  const {
    context: workspaceContext,
    loading: workspaceContextLoading,
  } = useWorkspaceContext();
  const workspaceBillingResponse = useWorkspaceBillingResponse();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const compactModelListRef = useRef<HTMLDivElement | null>(null);
  const compactSelectionAnchoredRef = useRef(false);
  const campaignBenefitTrackedForOpenRef = useRef(false);
  // Viewport clamp for the popover (issue #99): the anchor chip can sit
  // anywhere on screen (home hero mid-page, chat composer at the bottom), so
  // a fixed downward placement runs past the screen edge once the model list
  // is long. On open, mode/layout changes and resize/scroll, keep horizontal
  // bounds on screen, cap height and flip upward when below is tight.
  const [popoverPlacement, setPopoverPlacement] = useState<{
    up: boolean;
    maxHeight: number;
    offsetX: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPopoverPlacement(null);
      return;
    }
    const update = () => {
      const anchor = wrapRef.current?.getBoundingClientRect();
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const bounds = popover.getBoundingClientRect();
      // Measure the CSS placement (including Home's left-align override),
      // without accumulating the displacement from a previous update.
      const left = bounds.left - (Number.parseFloat(popover.style.translate) || 0);
      // Clamp the card's RESTING width, not its transformed box: the open
      // happens mid enter animation (`scale(var(--enter-scale))`, top/bottom
      // LEFT origin, so the left edge is exact but the box is ~4% narrow), and
      // nothing re-measures when the animation ends. Clamping the scaled width
      // left the settled card a few px past the right edge once the docked
      // nav rail pushed Home's chip toward it (D13).
      const width = Math.max(bounds.width, popover.offsetWidth);
      const clampedLeft = Math.max(12, Math.min(left, window.innerWidth - 12 - width));
      const viewportHeight = window.innerHeight;
      const below = viewportHeight - anchor.bottom - 16;
      const above = anchor.top - 16;
      const up = below < 280 && above > below;
      const next = {
        up,
        maxHeight: Math.max(160, Math.min(560, up ? above : below)),
        offsetX: clampedLeft - left,
      };
      setPopoverPlacement(current => current?.up === next.up && current.maxHeight === next.maxHeight && current.offsetX === next.offsetX ? current : next);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (wrapRef.current) observer?.observe(wrapRef.current);
    if (popoverRef.current) observer?.observe(popoverRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, config.mode]);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const providerModelsFetchingRef = useRef<Set<string>>(new Set());
  const [amrStatus, setAmrStatus] = useState<VelaLoginStatus | null>(null);
  const [amrWalletSnapshot, setAmrWalletSnapshot] =
    useState<AmrWalletSnapshot | null>(null);
  const [amrWalletReady, setAmrWalletReady] = useState(false);
  const [amrLoginPending, setAmrLoginPending] = useState(false);
  const [amrLoginError, setAmrLoginError] = useState<string | null>(null);
  const [amrReminderSeen, setAmrReminderSeen] = useState(readAmrReminderSeen);
  const [showAmrReminderInPopover, setShowAmrReminderInPopover] =
    useState(false);
  const amrPollRef = useRef<number | null>(null);
  const amrLoginStartedAtRef = useRef<number | null>(null);
  const amrLoginStartPendingRef = useRef(false);
  const amrLoginCancelRequestedRef = useRef(false);
  const amrAuthAttemptIdRef = useRef<string | null>(null);

  const stopAmrPolling = useCallback(() => {
    if (amrPollRef.current !== null) {
      window.clearInterval(amrPollRef.current);
      amrPollRef.current = null;
    }
  }, []);

  const refreshAmrStatus = useCallback(async () => {
    const next = await fetchVelaLoginStatus();
    if (next?.authAttemptId) {
      amrAuthAttemptIdRef.current = next.authAttemptId;
    }
    const authAttemptId = amrAuthAttemptIdRef.current;
    if (next && authAttemptId) {
      observeAmrAuthTracking(analytics.track, next, authAttemptId);
    }
    if (next) {
      setAmrStatus(next);
      const pendingStartup =
        amrLoginStartedAtRef.current !== null &&
        Date.now() - amrLoginStartedAtRef.current < AMR_LOGIN_STARTUP_SETTLE_MS;
      if (isAmrSessionAuthenticated(next)) {
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
      } else if (next.loginInFlight) {
        setAmrLoginPending(true);
      } else if (!pendingStartup) {
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
      }
    }
    return next;
  }, [analytics.track]);

  const startAmrPolling = useCallback((
    startedAt = Date.now(),
    authAttemptId = amrAuthAttemptIdRef.current,
  ) => {
    stopAmrPolling();
    amrLoginStartedAtRef.current = startedAt;
    if (authAttemptId) amrAuthAttemptIdRef.current = authAttemptId;
    const tick = async () => {
      const next = await refreshAmrStatus();
      const outcome = amrLoginPollOutcome(next, startedAt);
      if (outcome === 'signed-in') {
        if (authAttemptId) {
          resolveAmrAuthTracking(analytics.track, 'success', undefined, {
            authAttemptId,
            signedInUserId: next?.user?.id ?? null,
          });
        }
        notifyAmrLoginStatusChanged();
        stopAmrPolling();
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
        return;
      }
      if (outcome === 'stopped' || outcome === 'timed-out') {
        stopAmrPolling();
        if (outcome === 'timed-out') {
          if (authAttemptId) {
            resolveAmrAuthTracking(analytics.track, 'timeout', 'login_timeout', {
              authAttemptId,
            });
            void cancelVelaLogin(authAttemptId).then((result) =>
              notifyAmrLoginStatusChanged(
                result.canceled === true ? 'login-canceled' : 'status-changed',
              ),
            );
          }
          console.error('[amr-login] poll timed out waiting for a signed-in status');
        } else {
          if (authAttemptId) {
            resolveAmrAuthTracking(analytics.track, 'failed', 'login_stopped', {
              authAttemptId,
            });
          }
          console.error('[amr-login] poll loop stopped without a terminal status');
        }
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
        setAmrLoginError(t('settings.amrLoginErrorCompact'));
      }
    };
    amrPollRef.current = window.setInterval(() => {
      void tick();
    }, AMR_LOGIN_POLL_INTERVAL_MS);
  }, [analytics.track, refreshAmrStatus, stopAmrPolling, t]);

  const handleAmrSignIn = useCallback(async (
    attribution?: AmrEntryAttribution | null,
  ) => {
    const startedAt = Date.now();
    amrLoginStartedAtRef.current = startedAt;
    amrLoginCancelRequestedRef.current = false;
    setAmrLoginError(null);
    setAmrLoginPending(true);
    const provisionalAuthAttemptId = beginAmrAuthTracking(
      attribution,
      startedAt,
    );
    amrAuthAttemptIdRef.current = provisionalAuthAttemptId;
    const odDeviceId = amrHandoffDeviceId({
      metricsConsent: config.telemetry?.metrics === true,
      resolvedDeviceId: getResolvedDeviceId(),
      installationId: config.installationId,
    });
    amrLoginStartPendingRef.current = true;
    const result = await startVelaLogin(
      attribution,
      odDeviceId,
      provisionalAuthAttemptId,
    ).finally(() => {
      amrLoginStartPendingRef.current = false;
    });
    const authAttemptId = reconcileAmrAuthAttemptId(
      provisionalAuthAttemptId,
      result.authAttemptId,
      { joinedExisting: result.alreadyRunning === true },
    );
    amrAuthAttemptIdRef.current = authAttemptId;
    if (result.ok || result.alreadyRunning) {
      confirmAmrAuthTracking(analytics.track, authAttemptId, {
        joinedExisting: result.alreadyRunning === true,
      });
    }
    observeAmrAuthTracking(analytics.track, result, authAttemptId);
    if (amrLoginCancelRequestedRef.current) {
      if (result.ok || result.alreadyRunning) {
        const cancelResult = await cancelVelaLogin(authAttemptId);
        if (!cancelResult.ok) {
          amrLoginCancelRequestedRef.current = false;
          amrLoginStartedAtRef.current = null;
          setAmrLoginPending(false);
          setAmrLoginError(t('settings.amrLoginErrorCompact'));
          return;
        }
        if (cancelResult.canceled !== true) {
          const next = await refreshAmrStatus();
          amrLoginCancelRequestedRef.current = false;
          if (next?.loginInFlight) {
            startAmrPolling(
              startedAt,
              next.authAttemptId ?? authAttemptId,
            );
          }
          return;
        }
        resolveAmrAuthTracking(analytics.track, 'cancelled', undefined, {
          authAttemptId,
        });
        amrLoginCancelRequestedRef.current = false;
        amrLoginStartedAtRef.current = null;
        setAmrLoginPending(false);
        setAmrStatus((current) => (
          current
            ? { ...current, loggedIn: false, loginInFlight: false, user: null }
            : current
        ));
        notifyAmrLoginStatusChanged('login-canceled');
        return;
      }
      resolveAmrAuthTracking(analytics.track, 'cancelled', undefined, {
        authAttemptId,
      });
      amrLoginCancelRequestedRef.current = false;
      amrLoginStartedAtRef.current = null;
      setAmrLoginPending(false);
      return;
    }
    if (!result.ok && !result.alreadyRunning) {
      resolveAmrAuthTracking(analytics.track, 'failed', 'spawn_failed', {
        authAttemptId,
      });
      console.error('[amr-login] startVelaLogin failed', result);
      amrLoginStartedAtRef.current = null;
      setAmrLoginPending(false);
      setAmrLoginError(result.error || t('settings.amrLoginErrorCompact'));
      return;
    }
    notifyAmrLoginStatusChanged('login-started');
    startAmrPolling(startedAt, authAttemptId);
  }, [
    analytics.track,
    config.installationId,
    config.telemetry?.metrics,
    refreshAmrStatus,
    startAmrPolling,
    t,
  ]);

  const handleAmrCancelLogin = useCallback(async () => {
    const loginStartPending = amrLoginStartPendingRef.current;
    const authAttemptId = amrAuthAttemptIdRef.current;
    stopAmrPolling();
    setAmrLoginError(null);
    const result = authAttemptId
      ? await cancelVelaLogin(authAttemptId)
      : { ok: false, canceled: false };
    if (!result.ok) {
      amrLoginStartedAtRef.current = null;
      setAmrLoginPending(false);
      setAmrLoginError(t('settings.amrLoginErrorCompact'));
      return;
    }
    if (result.canceled !== true) {
      const next = await refreshAmrStatus();
      if (loginStartPending && next?.loginInFlight !== true) {
        amrLoginCancelRequestedRef.current = true;
        return;
      }
      if (next?.loginInFlight) {
        startAmrPolling(
          amrLoginStartedAtRef.current ?? Date.now(),
          next.authAttemptId ?? null,
        );
      }
      return;
    }
    if (authAttemptId) {
      resolveAmrAuthTracking(analytics.track, 'cancelled', undefined, {
        authAttemptId,
      });
    }
    amrLoginStartedAtRef.current = null;
    setAmrLoginPending(false);
    setAmrStatus((current) => (
      current
        ? { ...current, loggedIn: false, loginInFlight: false, user: null }
        : current
    ));
    notifyAmrLoginStatusChanged('login-canceled');
  }, [
    analytics.track,
    refreshAmrStatus,
    startAmrPolling,
    stopAmrPolling,
    t,
  ]);

  const handleAgentButtonClick = useCallback(
    async (agentId: string) => {
      trackExecutionSettingsPopoverClick(analytics.track, {
        page_name: 'home',
        area: 'execution_settings_popover',
        element: 'agent_card',
        cli_provider_id: agentIdToTracking(agentId),
      });
      leaveBuildWithJev();
      onAgentChange?.(agentId);
      if (agentId !== 'amr') return;
      if (amrLoginPending) {
        await handleAmrCancelLogin();
        return;
      }
      const attribution = recordAmrEntry(
        analytics.track,
        'inline_model_switcher_amr_row',
        new Date(),
        { metricsConsent: config.telemetry?.metrics === true },
      );
      const latest = await refreshAmrStatus();
      if (isAmrSessionAuthenticated(latest)) return;
      await handleAmrSignIn(attribution);
    },
    [
      amrLoginPending,
      analytics.track,
      handleAmrCancelLogin,
      handleAmrSignIn,
      leaveBuildWithJev,
      onAgentChange,
      refreshAmrStatus,
    ],
  );

  // Focus return: whichever path closes the card (Escape, outside press, a
  // choice that closes it), focus that was inside the card goes back to the
  // chip instead of dropping to <body>. A control the user moved to outside
  // the card keeps its focus.
  const focusInsidePopoverRef = useRef(false);
  const wasOpenRef = useRef(open);
  useEffect(() => {
    if (!open) return;
    focusInsidePopoverRef.current = false;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      focusInsidePopoverRef.current =
        target instanceof Node && Boolean(popoverRef.current?.contains(target));
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [open]);
  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!wasOpen || open) return;
    const focusWasInside = focusInsidePopoverRef.current;
    focusInsidePopoverRef.current = false;
    if (!focusWasInside) return;
    const active = document.activeElement;
    const focusDropped =
      active == null || active === document.body || !active.isConnected;
    if (focusDropped) chipRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      const target = e.target as Node;
      if (wrapRef.current.contains(target)) return;
      // The model catalog renders inside this card (no portaled list), so
      // every click that belongs to the switcher lands inside `wrapRef`.
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const scrollContainer = wrapRef.current?.closest('.entry-main--scroll');
    if (!(scrollContainer instanceof HTMLElement)) return;
    let frame = 0;
    const updateAnchorVisibility = () => {
      frame = 0;
      const trigger = chipRef.current;
      const triggerRect = trigger?.getBoundingClientRect();
      if (!triggerRect) return;
      const scrollRect = scrollContainer.getBoundingClientRect();
      const topbar = scrollContainer.querySelector<HTMLElement>('.entry-main__topbar');
      const anchorInTopbar = trigger ? topbar?.contains(trigger) === true : false;
      const topbarBottom = topbar?.getBoundingClientRect().bottom;
      const safeTop = anchorInTopbar
        ? scrollRect.top
        : Math.max(scrollRect.top, topbarBottom ?? scrollRect.top);
      const safeBottom = Math.min(window.innerHeight, scrollRect.bottom);
      const safeLeft = Math.max(0, scrollRect.left);
      const safeRight = Math.min(window.innerWidth, scrollRect.right);
      if (
        triggerRect.bottom <= safeTop ||
        triggerRect.top >= safeBottom ||
        triggerRect.right <= safeLeft ||
        triggerRect.left >= safeRight
      ) {
        setOpen(false);
      }
    };
    const scheduleVisibilityUpdate = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(updateAnchorVisibility);
    };
    updateAnchorVisibility();
    scrollContainer.addEventListener('scroll', scheduleVisibilityUpdate, {
      passive: true,
    });
    window.addEventListener('resize', scheduleVisibilityUpdate);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      scrollContainer.removeEventListener('scroll', scheduleVisibilityUpdate);
      window.removeEventListener('resize', scheduleVisibilityUpdate);
    };
  }, [open]);

  useEffect(() => {
    if (open && agents.some((agent) => agent.id === 'amr' && agent.available)) {
      void refreshAmrStatus();
    }
    return () => stopAmrPolling();
  }, [agents, open, refreshAmrStatus, stopAmrPolling]);

  useEffect(() => {
    const onStatusChange = (event: Event) => {
      const reason = amrLoginStatusEventReason(event);
      if (reason === 'login-started') {
        const startedAt = Date.now();
        amrLoginStartedAtRef.current = startedAt;
        setAmrLoginError(null);
        setAmrLoginPending(true);
        startAmrPolling(startedAt);
      } else if (reason === 'login-canceled') {
        amrLoginStartedAtRef.current = null;
        stopAmrPolling();
        setAmrLoginPending(false);
      }
      void refreshAmrStatus().then((next) => {
        if (next?.authAttemptId) {
          amrAuthAttemptIdRef.current = next.authAttemptId;
        }
        if (isAmrSessionAuthenticated(next)) {
          amrLoginStartedAtRef.current = null;
          stopAmrPolling();
          return;
        }
        if (next?.loginInFlight) {
          startAmrPolling(
            amrLoginStartedAtRef.current ?? Date.now(),
            next.authAttemptId ?? null,
          );
        }
      });
    };
    window.addEventListener(AMR_LOGIN_STATUS_EVENT, onStatusChange);
    return () => {
      window.removeEventListener(AMR_LOGIN_STATUS_EVENT, onStatusChange);
    };
  }, [refreshAmrStatus, startAmrPolling, stopAmrPolling]);

  const installedAgents = useMemo(
    () =>
      orderAgentsWithMishFirst(
        agents.filter((a) => a.available && isVisibleLocalCliAgent(a)),
      ),
    [agents],
  );
  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );
  const amrInstalled = installedAgents.some((a) => a.id === 'amr');
  const shouldOfferAmrReminder =
    config.mode === 'daemon' && config.agentId !== 'amr' && amrInstalled;
  const showAmrReminder = shouldOfferAmrReminder && !amrReminderSeen;

  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const normalizedCurrentChoice = normalizeAgentModelChoice(currentAgent, currentChoice);
  const effectiveCurrentChoice = preserveRequestedModel ? currentChoice : effectiveAgentModelChoice(currentAgent, currentChoice) ?? currentChoice;
  const currentAgentId = currentAgent?.id ?? null;
  const normalizedCurrentModelId = normalizedCurrentChoice?.model ?? null;
  const normalizedCurrentReasoning = normalizedCurrentChoice?.reasoning;
  const normalizedCurrentServiceTier = normalizedCurrentChoice?.serviceTier;
  const currentAgentModels = currentAgent?.models ?? [];
  const currentAgentModelIds = currentAgentModels.map((m) => m.id);
  const configuredModelId =
    typeof effectiveCurrentChoice.model === 'string' && effectiveCurrentChoice.model
      ? effectiveCurrentChoice.model
      : null;
  const currentModelId =
    !preserveRequestedModel && currentAgent?.id === 'amr' &&
    configuredModelId &&
    configuredModelId !== 'default' &&
    !currentAgentModelIds.includes(configuredModelId)
      ? defaultAgentModelId(currentAgent)
      : configuredModelId ?? defaultAgentModelId(currentAgent);
  const currentModelOption =
    currentAgentModels.find((m) => m.id === currentModelId) ?? null;
  const activeReasoningOptions = currentModelOption?.enabled === false
    ? []
    : (currentModelOption?.reasoningOptions ?? currentAgent?.reasoningOptions ?? []).filter(
        (option) => option.enabled !== false,
      );
  const currentReasoningId = activeReasoningOptions.some(
    (option) => option.id === effectiveCurrentChoice.reasoning,
  )
    ? effectiveCurrentChoice.reasoning!
    : activeReasoningOptions.find((option) => option.default)?.id ?? activeReasoningOptions[0]?.id ?? null;
  const currentServiceTierOptions =
    currentModelOption?.enabled === false
      ? []
      : (currentModelOption?.serviceTierOptions ?? []).filter(
          (tier) => tier.enabled !== false && tier.id !== 'default',
        );
  const currentServiceTierId = currentServiceTierOptions.some(
    (tier) => tier.id === currentChoice.serviceTier,
  )
    ? currentChoice.serviceTier!
    : 'default';
  // Settings hosts may retain a dormant native agent while BYOK is active;
  // conversation hosts keep that native choice in their scoped picker draft.
  // Do not let campaign UI read dormant AMR state: in BYOK mode the visible
  // model comes from `config.model` and usage is billed by the user's provider.
  const deepSeekCampaignVisibleForCurrentExecution =
    campaignVisibility.visible
    && config.mode === 'daemon'
    && currentAgent?.id === 'amr';

  useEffect(() => {
    if (preserveRequestedModel || !currentAgentId || !normalizedCurrentModelId) return;
    const nextChoice: {
      model: string;
      reasoning?: string;
      serviceTier?: string;
    } = {
      model: normalizedCurrentModelId,
      reasoning: normalizedCurrentReasoning,
    };
    if (normalizedCurrentServiceTier !== undefined) {
      nextChoice.serviceTier = normalizedCurrentServiceTier;
    }
    onAgentModelChange(currentAgentId, nextChoice);
  }, [
    currentAgentId,
    normalizedCurrentModelId,
    normalizedCurrentReasoning,
    normalizedCurrentServiceTier,
    onAgentModelChange,
    preserveRequestedModel,
  ]);

  const currentModelLabel =
    currentModelOption?.label ?? null;
  const inlineAgentModelOptions = useMemo(() => {
    const models = currentAgentModels;
    if (currentAgent?.id !== 'amr') return models;
    return orderModelOptionsByAvailability(models);
  }, [currentAgent?.id, currentAgentModels]);

  /**
   * The ONLY path from a model row to `onAgentModelChange` in this component.
   * Both model lists (the compact home list and the execution-settings picker)
   * write through here, so the availability gate cannot be forgotten by a list
   * added later — there is no second sink to forget it in. Returns false when
   * the pick was refused, which is the signal a row should not close the panel
   * or report a selection that did not happen.
   */
  const applyAgentModel = useCallback(
    (modelId: string, extra?: { reasoning?: string; serviceTier?: string }) => {
      const agentId = currentAgent?.id;
      if (!agentId) return false;
      if (!agentModelIsSelectable(currentAgent, modelId)) {
        return false;
      }
      onAgentModelChange?.(agentId, { model: modelId, ...extra });
      leaveBuildWithJev();
      return true;
    },
    [currentAgent, leaveBuildWithJev, onAgentModelChange],
  );

  const pickAgentModel = (modelId: string) => {
    const nextModel = currentAgentModels.find((model) => model.id === modelId);
    const nextReasoningOptions = nextModel?.reasoningOptions ?? currentAgent?.reasoningOptions ?? [];
    // Clear unsupported preferences in the explicit pick, before the host merges them.
    return applyAgentModel(modelId, {
      serviceTier: undefined,
      reasoning: nextReasoningOptions.some(
        (option) => option.enabled !== false && option.id === currentChoice.reasoning,
      ) ? currentChoice.reasoning : undefined,
    });
  };

  /**
   * Compact-list rows carry the same verdict the sink enforces, so a locked row
   * is rendered as locked instead of as a normal row whose click silently
   * reverts (issue: clicking a model in the home list did nothing).
   */
  const compactModelRows = useMemo(
    () =>
      inlineAgentModelOptions.map((model) => ({
        model,
        selectable: agentModelIsSelectable(currentAgent, model.id),
      })),
    [currentAgent, inlineAgentModelOptions],
  );

  // The compact list caps at six visible rows and scrolls, so a longer catalog
  // used to open on row one with the model actually in effect below the fold —
  // the hunting OPEND-2812 reports. Anchor the list on the row it already marks
  // `aria-checked`; nothing new is remembered here, the selection is read back
  // out of the rendered list. Once per open, so a later re-render (the catalog
  // arriving, the popover re-measuring) cannot yank the list back under a user
  // who has started browsing it.
  useLayoutEffect(() => {
    if (!open) {
      compactSelectionAnchoredRef.current = false;
      return;
    }
    if (compactSelectionAnchoredRef.current || !compactModelListRef.current) return;
    compactSelectionAnchoredRef.current = true;
    anchorSelectionInView(compactModelListRef.current, '[aria-checked="true"]');
  }, [compactModelRows, open]);

  useEffect(() => {
    if (!open) {
      campaignBenefitTrackedForOpenRef.current = false;
      return;
    }
    if (!compact || !deepSeekCampaignVisibleForCurrentExecution
      || campaignBenefitTrackedForOpenRef.current) {
      return;
    }
    // One impression per campaign model actually on screen, not one for the
    // popover: the campaign runs two models and product compares their reach
    // separately, so a single row-agnostic event would make Pro and Flash
    // indistinguishable in the funnel.
    const visibleCampaignModelIds = compactModelRows
      .filter(({ model }) => isDeepSeekV4FlashCampaignModel(model.id))
      .map(({ model }) => model.id);
    if (visibleCampaignModelIds.length === 0) return;
    campaignBenefitTrackedForOpenRef.current = true;
    for (const modelId of visibleCampaignModelIds) {
      trackDeepSeekCampaignModelBenefitSurfaceView(analytics.track, {
        page_name: 'home',
        area: 'execution_settings_popover',
        element: 'deepseek_v4_pro_benefit',
        campaign_id: 'deepseek_v4_pro',
        user_state: campaignNeedsUpgrade ? 'unpaid' : 'paid',
        model_id: modelId,
      });
    }
  }, [
    analytics.track,
    campaignNeedsUpgrade,
    compact,
    compactModelRows,
    deepSeekCampaignVisibleForCurrentExecution,
    open,
  ]);

  /** Where a refused model pick sends the user instead — the same plans
   *  destination the settings picker's upgrade lock already opens. */
  // `null` when no AMR console origin is configured: upgrade entries are
  // then unavailable (the button is hidden, the disabled-option lock has no
  // upgrade action).
  const amrPlansUrl = amrPlansUrlForProfile(
    amrStatus?.profile ?? config.agentCliEnv?.amr?.MISH_AMR_PROFILE,
  );
  const openAmrModelUpgrade = useCallback(() => {
    if (!amrPlansUrl) return;
    const attribution = recordAmrEntry(
      analytics.track,
      campaignNeedsUpgrade
        ? 'deepseek_model_switcher_upgrade'
        : 'inline_amr_upgrade',
      new Date(),
      {
        metricsConsent: config.telemetry?.metrics === true,
        ...(campaignNeedsUpgrade
          ? {
              campaignId: 'deepseek_v4_pro' as const,
              conversionSource: 'deepseek_model_switcher_upgrade' as const,
            }
          : {}),
      },
    );
    const deviceId = amrHandoffDeviceId({
      metricsConsent: config.telemetry?.metrics === true,
      resolvedDeviceId: getResolvedDeviceId(),
      installationId: config.installationId,
    });
    window.open(
      attributedAmrUrl(amrPlansUrl, attribution, deviceId),
      '_blank',
      'noopener,noreferrer',
    );
  }, [
    amrPlansUrl,
    analytics.track,
    campaignNeedsUpgrade,
    config.installationId,
    config.telemetry?.metrics,
  ]);
  const amrLoggedIn = isAmrSessionAuthenticated(amrStatus);

  useEffect(() => {
    if (!amrLoggedIn || workspaceContext?.workspaceType === 'team') {
      setAmrWalletSnapshot(null);
      setAmrWalletReady(workspaceContext?.workspaceType === 'team');
      return;
    }
    let cancelled = false;
    setAmrWalletReady(false);
    void fetchAmrWalletSnapshot().then((next) => {
      if (cancelled) return;
      setAmrWalletSnapshot(next);
      setAmrWalletReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    amrLoggedIn,
    amrStatus?.profile,
    amrStatus?.user?.id,
    amrStatus?.user?.email,
    workspaceContext?.workspaceType,
  ]);

  // Signed-in rows show the current plan instead of a redundant "Signed in" +
  // check mark. When the plan can't be resolved (free user, stale local config,
  // upstream not yet fetched), show no status at all. Signed-in-without-plan is
  // distinguished from signed-out (which keeps the sign-in CTA) by `amrLoggedIn`,
  // never by plan presence.
  const amrPlanLabel = amrLoggedIn
    ? amrStatus?.account?.plan?.trim() || null
    : null;
  const scopedWorkspaceBalance = formatVelaBalanceUsd(
    workspaceBillingBalanceUsd(workspaceBillingResponse, workspaceContext),
  );
  const amrBalanceLabel = amrLoggedIn && !workspaceContextLoading
    ? workspaceContext?.workspaceType === 'team'
      ? scopedWorkspaceBalance
      : scopedWorkspaceBalance ??
        formatVelaBalanceUsd(amrStatus?.account?.balanceUsd) ??
        (amrWalletSnapshot?.status === 'available'
          ? formatVelaBalanceUsd(amrWalletSnapshot.balanceUsd)
          : null)
    : null;
  const amrBalanceDisplayLabel = amrLoggedIn
    ? amrBalanceLabel ??
      (
        workspaceContextLoading
          ? t('common.loading')
          : workspaceContext?.workspaceType === 'team'
            ? workspaceBillingResponse
              ? t('settings.amrWalletUnavailable')
              : t('common.loading')
            : amrWalletReady
              ? t('settings.amrWalletUnavailable')
              : t('common.loading')
      )
    : null;
  // Personal workspaces always resolve `canManageBilling` true (the user is
  // their own owner), so this does not affect the personal-workspace upgrade
  // path.
  const amrCanUpgrade =
    amrLoggedIn &&
    canUpgradeVelaPlan(amrStatus?.account?.plan) &&
    Boolean(workspaceContext?.permissions?.canManageBilling) &&
    amrPlansUrl !== null;
  const amrActionLabel = amrLoginPending
    ? t('settings.amrSigningIn')
    : amrLoggedIn
      ? amrPlanLabel ?? ''
      : t('settings.amrSignIn');
  const amrPendingHoverLabel = t('settings.amrCancelSignIn');
  // Visually hidden state for screen readers keeps announcing "signed in" even
  // when no plan label is shown.
  const amrInlineStatus = amrLoginError
    ? amrLoginError
    : amrLoggedIn
      ? amrPlanLabel ?? t('settings.amrSignedIn')
      : amrLoginPending
        ? t('settings.amrSigningIn')
        : t('settings.amrSignIn');
  const amrStatusIconName = amrLoginPending ? 'spinner' : null;

  const apiProtocol = config.apiProtocol ?? 'anthropic';
  const providerForProtocol = useMemo(
    () =>
      KNOWN_PROVIDERS.find(
        (p) =>
          p.protocol === apiProtocol &&
          (config.apiProviderBaseUrl
            ? p.baseUrl === config.apiProviderBaseUrl
            : false),
      ) ?? KNOWN_PROVIDERS.find((p) => p.protocol === apiProtocol),
    [apiProtocol, config.apiProviderBaseUrl],
  );
  const providerModelsKey = useMemo(
    () =>
      providerModelsCacheKey(
        apiProtocol,
        config.baseUrl,
        config.apiKey,
        config.apiVersion ?? '',
      ),
    [apiProtocol, config.apiKey, config.apiVersion, config.baseUrl],
  );
  const fetchedApiModelOptions = providerModelsCache?.[providerModelsKey] ?? [];

  // Warm the shared provider-models cache from the home picker itself. The
  // picker otherwise depends on Settings/onboarding having fetched first, so on
  // a fresh load the BYOK list shows only the small static seed list instead of
  // the live catalogue. We fetch when the panel is open in BYOK mode and the
  // preconditions for the active protocol are met (AIHubMix's catalogue is
  // public, so it needs no key; every other protocol needs one). Results are
  // keyed identically to Settings (`providerModelsKey`), so a single fetch
  // serves both surfaces and replaces any stale slot.
  useEffect(() => {
    if (!open || config.mode !== 'api' || !onProviderModelsCacheChange) return;
    if (apiProtocol === 'azure' || apiProtocol === 'ollama') return;
    if (apiProtocol !== 'aihubmix' && !config.apiKey.trim()) return;
    const baseUrl = config.baseUrl.trim();
    if (!/^https?:\/\//i.test(baseUrl)) return;
    const key = providerModelsKey;
    if (fetchedApiModelOptions.length) return;
    if (providerModelsFetchingRef.current.has(key)) return;
    providerModelsFetchingRef.current.add(key);
    let active = true;
    void fetchProviderModels({
      protocol: apiProtocol,
      baseUrl,
      apiKey: config.apiKey,
    })
      .then((result) => {
        if (active && result.ok && result.models?.length) {
          onProviderModelsCacheChange((current) => ({
            ...current,
            [key]: result.models ?? [],
          }));
        }
      })
      .catch(() => {
        // Non-fatal: the picker falls back to the static seed list.
      })
      .finally(() => {
        providerModelsFetchingRef.current.delete(key);
      });
    return () => {
      active = false;
    };
  }, [
    open,
    config.mode,
    config.apiKey,
    config.baseUrl,
    apiProtocol,
    providerModelsKey,
    fetchedApiModelOptions.length,
    onProviderModelsCacheChange,
  ]);

  const suggestedApiModelIds = useMemo(
    () =>
      Array.from(
        new Set(
          providerForProtocol?.preferredModels.length
            ? providerForProtocol.preferredModels
            : SUGGESTED_MODELS_BY_PROTOCOL[apiProtocol],
        ),
      ),
    [apiProtocol, providerForProtocol],
  );
  const apiModelOptions = useMemo(
    () => mergeProviderModelOptions(fetchedApiModelOptions, suggestedApiModelIds),
    [fetchedApiModelOptions, suggestedApiModelIds],
  );
  const apiModelIds = useMemo(
    () => apiModelOptions.map((model) => model.id),
    [apiModelOptions],
  );
  const apiModelChoices = useMemo(
    () => apiModelOptions.map((model) => ({ ...model, label: model.label })),
    [apiModelOptions],
  );

  // Chip text — keep it tight so the pill doesn't wrap on small viewports.
  // CLI: "Claude · Sonnet 4.5"; BYOK: "Anthropic · sonnet-4.5".
  const chipMode =
    config.mode === 'daemon'
      ? t('inlineSwitcher.chipCli')
      : t('inlineSwitcher.chipByok');
  const chipPrimary =
    config.mode === 'daemon'
      ? currentAgent
        ? displayAgentChipName(currentAgent)
        : t('inlineSwitcher.noAgent')
      : apiProtocolLabel(apiProtocol);
  const chipModel =
    config.mode === 'daemon'
      ? isDeepSeekV4FlashCampaignModel(currentModelId)
        ? currentModelLabel ?? 'DeepSeek V4 Flash'
        : currentModelLabel && currentModelId !== 'default'
          ? currentModelLabel
          : preserveRequestedModel && currentModelId && currentModelId !== 'default'
            ? currentModelId
            : t('inlineSwitcher.modelDefault')
      : config.model.trim() || t('inlineSwitcher.modelDefault');

  // Compact home chip surfaces the selected model name + a connection-status
  // dot; label/tooltip fall back to the agent name. In CLI mode the agent's
  // `available` flag is the connection signal (reachable on PATH); API/BYOK is
  // a user-configured endpoint, treated as connected.
  const chipConnected =
    config.mode === 'daemon' ? currentAgent?.available === true : true;
  /**
   * 紧凑 chip 的读屏标签 / 提示里那个「谁在跑」。
   *
   * **必须跟着 `config.mode` 分岔**,和非紧凑那支的 `chipPrimary` 同一条规则。
   * 原来无条件取 `displayAgentName(currentAgent)`,而 API/BYOK 模式下
   * `config.agentId` 还留着上一个 daemon agent —— 真机上配好 OpenRouter 之后
   * chip 念的是「Claude Code · google/gemini-2.5-flash」,可那一轮真正跑的是
   * `byok-opencode`。可见文字只有模型名,所以只有读屏用户会被念错。
   */
  const chipAgentLabel =
    config.mode === 'daemon'
      ? currentAgent
        ? displayAgentName(currentAgent)
        : t('inlineSwitcher.chipTitle')
      : apiProtocolLabel(apiProtocol);

  // "Build with Jev" is not a model, but while it is on it IS what Send runs,
  // so the chip names it instead of the model it would otherwise show.
  const chipModelShown = jevActive ? t('inlineSwitcher.buildWithJev') : chipModel;

  const handleChipClick = useCallback(() => {
    const nextOpen = !open;
    if (nextOpen && showAmrReminder) {
      setShowAmrReminderInPopover(true);
      setAmrReminderSeen(true);
      markAmrReminderSeen();
    } else if (!nextOpen) {
      setShowAmrReminderInPopover(false);
    }
    setOpen(nextOpen);
  }, [open, showAmrReminder]);

  useEffect(() => {
    if (!open || config.mode !== 'daemon' || config.agentId === 'amr') {
      setShowAmrReminderInPopover(false);
    }
  }, [config.agentId, config.mode, open]);

  // ── One card (wave 2): the popover is a single card with two tabs —
  // Model (the searchable catalog rendered in place, no second floating
  // list) and Agent / Provider (execution mode plus who runs it). The
  // compact no-options variant keeps its plain model list.
  const fullPanel = !(compact && !showExecutionOptions);
  const panelIdBase = `inline-switcher-${useId().replace(/:/g, '')}`;
  const modelPanelHasContent =
    !nativeOnly && config.mode === 'api'
      ? true
      : Boolean(currentAgent?.models && currentAgent.models.length > 0);
  const [panelTab, setPanelTab] = useState<'model' | 'source'>('model');
  const tabRefs = useRef<Record<'model' | 'source', HTMLButtonElement | null>>({
    model: null,
    source: null,
  });
  // Every open starts on the catalog — the thing people come here to change —
  // unless the current agent has no models to offer. Until the user picks a
  // tab or acts inside one, the default follows the catalog (agents can arrive
  // after the card opened); after that, nothing moves them off it. A change
  // made on the Agent tab (mode, agent) often gives the Model tab content;
  // following it there would hide the list the user is working in.
  const panelTabChosenRef = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      panelTabChosenRef.current = false;
      return;
    }
    if (panelTabChosenRef.current) return;
    setPanelTab(modelPanelHasContent ? 'model' : 'source');
  }, [open, modelPanelHasContent]);
  const choosePanelTab = (tab: 'model' | 'source') => {
    panelTabChosenRef.current = true;
    setPanelTab(tab);
  };
  /** Capture-phase click on a tabpanel: the user is working in this tab. */
  const keepPanelTab = () => {
    panelTabChosenRef.current = true;
  };
  const activePanelTab = panelTab;
  const sourceTabLabel =
    !nativeOnly && config.mode === 'api'
      ? t('inlineSwitcher.providerLabel')
      : t('inlineSwitcher.agentLabel');
  const panelTabs: Array<{ id: 'model' | 'source'; label: string; value: string | null }> = [
    { id: 'model', label: t('inlineSwitcher.modelLabel'), value: null },
    { id: 'source', label: sourceTabLabel, value: chipPrimary },
  ];
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const order: Array<'model' | 'source'> = ['model', 'source'];
    const rtl = event.currentTarget.closest('[dir]')?.getAttribute('dir') === 'rtl';
    const next = stepTablistKey(order, activePanelTab, event.key, rtl);
    if (next == null) return;
    event.preventDefault();
    choosePanelTab(next);
    tabRefs.current[next]?.focus();
  };

  const buildWithJevRow = buildWithJev ? (
    // Pinned above every provider's models: a mode, not a model. A toggle
    // button rather than another option, so the card keeps exactly one
    // model listbox.
    <div className={styles.jevRow} data-testid="inline-model-switcher-build-with-jev-row">
      <button
        type="button"
        aria-pressed={jevActive}
        aria-label={t('inlineSwitcher.buildWithJev')}
        aria-describedby={`${panelIdBase}-jev-hint`}
        className={styles.jevButton}
        data-testid="inline-model-switcher-build-with-jev"
        onClick={() => {
          if (!jevActive) buildWithJev.onChange(true);
          setOpen(false);
        }}
      >
        <span className={styles.jevIcon} aria-hidden="true">
          <Icon name="sparkles" size={14} />
        </span>
        <span className={styles.jevText}>
          <span className={styles.jevTitle}>{t('inlineSwitcher.buildWithJev')}</span>
          <span className={styles.jevHint} id={`${panelIdBase}-jev-hint`}>{t('inlineSwitcher.buildWithJevHint')}</span>
        </span>
        {jevActive ? <Icon name="check" size={14} className={styles.agentCheck} /> : null}
      </button>
    </div>
  ) : null;

  const modeSegment = (
    <div className={styles.section}>
      <span className={styles.sectionLabel}>{t('inlineSwitcher.modeLabel')}</span>
      <div className={styles.modeSeg} role="group" aria-label={t('inlineSwitcher.modeLabel')}>
        <button
          type="button"
          aria-pressed={config.mode === 'daemon'}
          className={styles.modeSegBtn}
          data-testid="inline-model-switcher-mode-daemon"
          disabled={!daemonLive && config.mode !== 'daemon'}
          onClick={() => {
            trackExecutionSettingsPopoverClick(analytics.track, {
              page_name: 'home',
              area: 'execution_settings_popover',
              element: 'mode_local_cli',
            });
            // Optional-call so a transient Fast Refresh state where a
            // parent has not yet re-rendered with the new prop signature
            // does not crash the entire entry view. The same defensive
            // pattern is applied to every callback below.
            leaveBuildWithJev();
            onModeChange?.('daemon');
            if (!daemonLive) {
              setOpen(false);
              onOpenSettings?.('execution');
            }
          }}
          title={
            !daemonLive
              ? t('inlineSwitcher.daemonOffline')
              : t('inlineSwitcher.useCli')
          }
        >
          {t('inlineSwitcher.chipCli')}
        </button>
        <button
          type="button"
          aria-pressed={config.mode === 'api'}
          className={styles.modeSegBtn}
          data-testid="inline-model-switcher-mode-api"
          onClick={() => {
            trackExecutionSettingsPopoverClick(analytics.track, {
              page_name: 'home',
              area: 'execution_settings_popover',
              element: 'mode_byok',
            });
            leaveBuildWithJev();
            onModeChange?.('api');
          }}
          title={t('inlineSwitcher.useByok')}
        >
          {t('inlineSwitcher.chipByok')}
        </button>
      </div>
    </div>
  );

  const amrAccountRow = amrInstalled ? (
    <div
      className={
        'inline-switcher__account' +
        (config.agentId === 'amr' ? ' is-active' : '')
      }
    >
      <button
        type="button"
        role="radio"
        aria-checked={config.agentId === 'amr'}
        aria-label={`Mishh Mashh ${amrInlineStatus}`}
        className="inline-switcher__account-id inline-switcher__account-select"
        data-testid="inline-model-switcher-agent-amr"
        title={amrLoginPending ? amrPendingHoverLabel : undefined}
        onClick={() => void handleAgentButtonClick('amr')}
      >
        <span className="inline-switcher__account-id-icon">
          <AgentIcon id="amr" size={24} />
          {showAmrReminderInPopover && config.agentId !== 'amr' ? (
            <span
              className="inline-switcher__amr-reminder-dot inline-switcher__amr-reminder-dot--account"
              data-testid="inline-model-switcher-account-amr-reminder"
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span className="inline-switcher__account-text">
          <span className="inline-switcher__account-name-row">
            <span className="inline-switcher__account-name">
              Mishh Mashh
            </span>
            {amrLoggedIn ? (
              <PlanBadge plan={amrPlanLabel} size="md" />
            ) : null}
          </span>
          {amrLoggedIn && amrBalanceDisplayLabel ? (
            <span className="inline-switcher__account-subtitle">
              <span className="inline-switcher__account-stat">
                <span className="inline-switcher__account-stat-label">
                  {t('settings.amrBalance')}
                </span>
                <span className="inline-switcher__account-stat-value">
                  {amrBalanceDisplayLabel}
                </span>
              </span>
            </span>
          ) : null}
        </span>
      </button>
      {amrLoginError ? (
        <span className="inline-switcher__account-status is-error">
          {amrLoginError}
        </span>
      ) : amrLoggedIn ? (
        amrCanUpgrade ? (
          <button
            type="button"
            className="inline-switcher__account-upgrade"
            data-testid="inline-model-switcher-account-upgrade"
            onClick={(e) => {
              e.stopPropagation();
              if (!amrPlansUrl) return;
              const attribution = recordAmrEntry(
                analytics.track,
                'inline_amr_upgrade',
                new Date(),
                { metricsConsent: config.telemetry?.metrics === true },
              );
              const deviceId = amrHandoffDeviceId({
                metricsConsent: config.telemetry?.metrics === true,
                resolvedDeviceId: getResolvedDeviceId(),
                installationId: config.installationId,
              });
              window.open(
                attributedAmrUrl(
                  amrPlansUrl,
                  attribution,
                  deviceId,
                ),
                '_blank',
                'noopener,noreferrer',
              );
            }}
          >
            {t('settings.amrUpgrade')}
          </button>
        ) : null
      ) : (
        <button
          type="button"
          className="inline-switcher__account-action"
          data-testid="inline-model-switcher-account-action"
          title={amrLoginPending ? amrPendingHoverLabel : undefined}
          onClick={() => {
            if (amrLoginPending) {
              void handleAmrCancelLogin();
              return;
            }
            const attribution = recordAmrEntry(
              analytics.track,
              'inline_model_switcher_amr_row',
              new Date(),
              { metricsConsent: config.telemetry?.metrics === true },
            );
            void handleAmrSignIn(attribution);
          }}
        >
          {amrStatusIconName ? (
            <Icon name={amrStatusIconName} size={13} />
          ) : null}
          {amrActionLabel}
        </button>
      )}
    </div>
  ) : null;

  const reasoningRow =
    config.mode === 'daemon' && currentAgent && currentModelId && currentReasoningId ? (
      <label className={styles.tuningRow}>
        <span className={styles.tuningLabel}>{t('avatar.reasoningLabel')}</span>
        <select
          className={styles.tuningSelect}
          data-testid="inline-model-switcher-reasoning"
          aria-label={t('avatar.reasoningLabel')}
          value={currentReasoningId}
          onChange={(event) => {
            const reasoning = event.target.value;
            if (!activeReasoningOptions.some((option) => option.id === reasoning)) return;
            applyAgentModel(currentModelId, { reasoning });
          }}
        >
          {activeReasoningOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </label>
    ) : null;
  const serviceTierRow =
    config.mode === 'daemon' &&
    currentAgent &&
    currentModelId &&
    currentServiceTierOptions.length > 0 ? (
      <label className={styles.tuningRow}>
        <span className={styles.tuningLabel}>
          {t('avatar.serviceTierLabel')}
        </span>
        <select
          className={styles.tuningSelect}
          data-testid="inline-model-switcher-service-tier"
          aria-label={t('avatar.serviceTierLabel')}
          value={currentServiceTierId}
          onChange={(event) => {
            const tier = event.target.value;
            if (tier !== 'default' && !currentServiceTierOptions.some((option) => option.id === tier)) return;
            applyAgentModel(currentModelId, {
              serviceTier: tier === 'default' ? undefined : tier,
            });
          }}
        >
          <option value="default">{t('common.default')}</option>
          {currentServiceTierOptions.map((tier) => (
            <option key={tier.id} value={tier.id}>{tier.label}</option>
          ))}
        </select>
      </label>
    ) : null;
  const modelTuningRows =
    reasoningRow || serviceTierRow ? (
      <div className={styles.tuning}>
        {reasoningRow}
        {serviceTierRow}
      </div>
    ) : null;
  return (
    <div
      className={`inline-switcher${compact ? ' inline-switcher--compact' : ''}`}
      ref={wrapRef}
      data-testid="inline-model-switcher"
    >
      <button
        ref={chipRef}
        type="button"
        className={
          'inline-switcher__chip od-tooltip' +
          (compact ? ' inline-switcher__chip--icon' : '') +
          (showAmrReminder ? ' has-amr-reminder' : '')
        }
        data-testid="inline-model-switcher-chip"
        onClick={handleChipClick}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          jevActive
            ? chipModelShown
            : compact
              ? `${showExecutionOptions ? `${t('sessionModel.nextTurn')}: ` : ''}${chipAgentLabel} · ${chipModel}`
              : `${chipMode} · ${chipPrimary} · ${chipModel}`
        }
        data-tooltip={
          jevActive
            ? t('inlineSwitcher.buildWithJevHint')
            : compact
              ? `${showExecutionOptions ? `${t('sessionModel.nextTurn')}: ` : ''}${chipAgentLabel} · ${chipModel}`
              : `${chipMode} · ${chipPrimary} · ${chipModel}`
        }
        data-build-with-jev={jevActive ? 'true' : undefined}
        data-tooltip-placement="bottom"
      >
        {showAmrReminder ? (
          <span
            className="inline-switcher__amr-reminder-dot inline-switcher__amr-reminder-dot--chip"
            data-testid="inline-model-switcher-amr-reminder"
            aria-hidden="true"
          />
        ) : null}
        {compact ? (
          <>
            {/* Same agent logo (with the BYOK link-glyph fallback) the full
                chip leads with, so the compact pill still says which agent the
                model belongs to. */}
            <span className="inline-switcher__chip-icon" aria-hidden="true">
              {jevActive ? (
                <Icon name="sparkles" size={16} />
              ) : config.mode === 'daemon' && currentAgent ? (
                <AgentIcon id={currentAgent.id} size={18} />
              ) : (
                <span className="inline-switcher__byok-glyph">
                  <Icon name="link" size={14} />
                </span>
              )}
            </span>
            {/* Divider sits right after the agent logo; the status dot then
                leads the model name so the dot reads as part of the model
                label rather than trailing the logo. */}
            <span className="inline-switcher__chip-divider" aria-hidden="true" />
            <span
              className="inline-switcher__chip-conn"
              data-connected={chipConnected ? 'true' : 'false'}
              aria-hidden="true"
            />
            <span className="inline-switcher__chip-model-name">{chipModelShown}</span>
          </>
        ) : (
          <>
            <span className="inline-switcher__chip-icon" aria-hidden="true">
              {jevActive ? (
                <Icon name="sparkles" size={16} />
              ) : config.mode === 'daemon' && currentAgent ? (
                <AgentIcon id={currentAgent.id} size={18} />
              ) : (
                <span className="inline-switcher__byok-glyph">
                  <Icon name="link" size={14} />
                </span>
              )}
            </span>
            <span className="inline-switcher__chip-text">
              <span className="inline-switcher__chip-mode">{chipMode}</span>
              <span className="inline-switcher__chip-sep" aria-hidden="true">
                ·
              </span>
              <span className="inline-switcher__chip-primary">{chipPrimary}</span>
              <span className="inline-switcher__chip-sep" aria-hidden="true">
                ·
              </span>
              <span className="inline-switcher__chip-model">{chipModelShown}</span>
            </span>
            <Icon
              name="chevron-down"
              size={12}
              className="inline-switcher__chip-chevron"
            />
          </>
        )}
      </button>

      {open ? (
        <div
          ref={popoverRef}
          className={`inline-switcher__popover ${styles.card}${fullPanel ? ` ${styles.cardFull}` : ''}${popoverPlacement?.up ? ' inline-switcher__popover--up' : ''}`}
          role="dialog"
          aria-label={t('inlineSwitcher.chipTitle')}
          data-testid="inline-model-switcher-popover"
          style={popoverPlacement ? { maxHeight: `${popoverPlacement.maxHeight}px`, overflowY: 'auto', translate: `${popoverPlacement.offsetX}px 0` } : undefined}
        >
          {fullPanel ? (
            <>
              <SelectionGroup>
                <div
                  className={styles.tabs}
                  role="tablist"
                  aria-label={t('inlineSwitcher.chipTitle')}
                >
                  {panelTabs.map((tab) => {
                    const selected = activePanelTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        ref={(node) => { tabRefs.current[tab.id] = node; }}
                        type="button"
                        role="tab"
                        id={`${panelIdBase}-tab-${tab.id}`}
                        aria-selected={selected}
                        aria-controls={`${panelIdBase}-panel-${tab.id}`}
                        tabIndex={selected ? 0 : -1}
                        className={styles.tab}
                        data-testid={`inline-model-switcher-tab-${tab.id}`}
                        onClick={() => choosePanelTab(tab.id)}
                        onKeyDown={onTabKeyDown}
                      >
                        <SelectionIndicator active={selected} />
                        <span className={styles.tabLabel}>{tab.label}</span>
                        {tab.value ? (
                          <span className={styles.tabValue}>{tab.value}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </SelectionGroup>

              <div
                role="tabpanel"
                id={`${panelIdBase}-panel-model`}
                aria-labelledby={`${panelIdBase}-tab-model`}
                className={styles.panel}
                hidden={activePanelTab !== 'model'}
                data-testid="inline-model-switcher-panel-model"
                onClickCapture={keepPanelTab}
              >
                {buildWithJevRow}
                {!nativeOnly && config.mode === 'api' ? (
                  apiModelOptions.length > 0 ? (
                    <InlineModelList
                      data-testid="inline-model-switcher-api-model"
                      listTestId="inline-model-switcher-api-model-popover"
                      searchInputTestId="inline-model-switcher-api-model-search"
                      ariaLabel={t('inlineSwitcher.modelLabel')}
                      searchPlaceholder={t('inlineSwitcher.searchModels')}
                      emptyLabel={t('inlineSwitcher.noModelMatches')}
                      autoFocusSearch
                      models={apiModelChoices}
                      value={config.model}
                      onChange={(nextValue) => {
                        trackExecutionSettingsPopoverClick(analytics.track, {
                          page_name: 'home',
                          area: 'execution_settings_popover',
                          element: 'model_dropdown',
                          execution_mode: 'byok',
                          provider_id:
                            byokProtocolToTracking(apiProtocol) ?? undefined,
                          model_id: modelIdForTracking(nextValue),
                        });
                        leaveBuildWithJev();
                        onApiModelChange?.(nextValue);
                      }}
                      additionalOptions={
                        config.model && !apiModelIds.includes(config.model)
                          ? [
                              {
                                value: config.model,
                                label: `${config.model} ${t('inlineSwitcher.customSuffix')}`,
                              },
                            ]
                          : undefined
                      }
                    />
                  ) : (
                    <p className={styles.hint}>
                      {t('inlineSwitcher.openSettingsForModel')}
                    </p>
                  )
                ) : currentAgent && currentAgent.models && currentAgent.models.length > 0 ? (
                  <InlineModelList
                    data-testid="inline-model-switcher-agent-model"
                    listTestId="inline-model-switcher-agent-model-popover"
                    searchInputTestId="inline-model-switcher-agent-model-search"
                    ariaLabel={t('inlineSwitcher.modelLabel')}
                    searchPlaceholder={t('inlineSwitcher.searchModels')}
                    emptyLabel={t('inlineSwitcher.noModelMatches')}
                    autoFocusSearch
                    models={inlineAgentModelOptions}
                    // Only AMR's catalog genuinely spans multiple model
                    // vendors — every other agent's model list is one
                    // provider's own ids (o1/o3/o4-mini alongside gpt-*,
                    // for instance), which the company heuristic would
                    // otherwise split into misleading fake "companies".
                    groupByCompany={currentAgent.id === 'amr'}
                    value={currentModelId ?? ''}
                    onChange={(nextValue) => {
                      // Same explicit preference filtering and availability sink
                      // as the compact list; undefined keys must reach the merge.
                      if (!pickAgentModel(nextValue)) {
                        return;
                      }
                      trackExecutionSettingsPopoverClick(analytics.track, {
                        page_name: 'home',
                        area: 'execution_settings_popover',
                        element: 'model_dropdown',
                        execution_mode: 'local_cli',
                        model_id: modelIdForTracking(nextValue),
                      });
                    }}
                    additionalOptions={
                      !currentModelId ||
                      currentAgent.models.some((m) => m.id === currentModelId)
                        ? undefined
                        : currentAgent.id !== 'amr'
                          ? [
                              {
                                value: currentModelId,
                                label: `${currentModelId} ${t('inlineSwitcher.customSuffix')}`,
                              },
                            ]
                          : currentModelId === 'default'
                            // A session that explicitly asked for the AMR default
                            // keeps that choice visible as the selected row.
                            ? [{ value: 'default', label: t('inlineSwitcher.modelDefault') }]
                            : undefined
                    }
                    disabledOptionHint={
                      currentAgent.id === 'amr'
                        ? (option) =>
                            option.enabled === false
                              ? t('settings.amrModelUpgradeHint')
                              : null
                        : undefined
                    }
                    onDisabledOptionUpgrade={
                      currentAgent.id === 'amr' && amrPlansUrl
                        ? openAmrModelUpgrade
                        : undefined
                    }
                  />
                ) : (
                  <p className={styles.hint}>
                    {t('inlineSwitcher.openSettingsForModel')}
                  </p>
                )}
                {modelTuningRows}
              </div>

              <div
                role="tabpanel"
                id={`${panelIdBase}-panel-source`}
                aria-labelledby={`${panelIdBase}-tab-source`}
                className={styles.panel}
                hidden={activePanelTab !== 'source'}
                data-testid="inline-model-switcher-panel-source"
                onClickCapture={keepPanelTab}
              >
                {nativeOnly ? null : modeSegment}
                {!nativeOnly && config.mode === 'api' ? (
                  <div className={styles.section}>
                    <span className={styles.sectionLabel}>
                      {t('inlineSwitcher.providerLabel')}
                    </span>
                    <div className={styles.providerChips} role="group" aria-label={t('inlineSwitcher.providerLabel')}>
                      {(showExecutionOptions ? [...API_PROTOCOL_TABS, { id: 'ollama' as const, title: 'Ollama' }, { id: 'senseaudio' as const, title: 'SenseAudio' }] : API_PROTOCOL_TABS).map((tab) => {
                        const active = apiProtocol === tab.id;
                        return (
                          <Chip
                            key={tab.id}
                            size="sm"
                            selected={active}
                            data-testid={`inline-model-switcher-provider-${tab.id}`}
                            onClick={() => {
                              // Unlike Settings (which skips unmapped protocols),
                              // report the click even when the protocol has no v2
                              // provider_id (e.g. aihubmix) — just omit the field.
                              trackExecutionSettingsPopoverClick(analytics.track, {
                                page_name: 'home',
                                area: 'execution_settings_popover',
                                element: 'byok_provider_tab',
                                provider_id:
                                  byokProtocolToTracking(tab.id) ?? undefined,
                              });
                              leaveBuildWithJev();
                              onApiProtocolChange?.(tab.id);
                            }}
                          >
                            {tab.title}
                          </Chip>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className={`${styles.section} ${styles.agentSection}`}>
                    <span className={styles.sectionLabel}>
                      {t('inlineSwitcher.agentLabel')}
                    </span>
                    {installedAgents.length === 0 ? (
                      <p className={styles.hint}>
                        {t('inlineSwitcher.noAgentsDetected')}
                      </p>
                    ) : (
                      <div
                        className="inline-switcher__agent-grid"
                        role="radiogroup"
                        aria-label={t('inlineSwitcher.agentLabel')}
                      >
                        {installedAgents
                          .filter((a) => a.id !== 'amr')
                          .map((a) => {
                          const active = config.agentId === a.id;
                          const agentName = displayAgentChipName(a);
                          return (
                            <div
                              key={a.id}
                              className="inline-switcher__agent-row"
                            >
                              <button
                                type="button"
                                role="radio"
                                aria-checked={active}
                                aria-label={agentName}
                                className={
                                  'inline-switcher__agent' +
                                  (active ? ' is-active' : '')
                                }
                                data-testid={`inline-model-switcher-agent-${a.id}`}
                                onClick={() => void handleAgentButtonClick(a.id)}
                                title={a.version ? `${agentName} · ${a.version}` : agentName}
                              >
                                <AgentIcon id={a.id} size={20} />
                                <span className="inline-switcher__agent-name">
                                  {agentName}
                                </span>
                                {active ? (
                                  <Icon name="check" size={14} className={styles.agentCheck} />
                                ) : null}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {amrAccountRow}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {buildWithJevRow}
              {!nativeOnly && config.mode === 'api' ? (
                // Compact list variant without execution options: the BYOK
                // provider's catalogue, never the CLI agent's (regression: the
                // compact home popover kept listing the local CLI agent's
                // cloud models while the chip showed the BYOK model).
                apiModelOptions.length > 0 ? (
                  <InlineModelList
                    data-testid="inline-model-switcher-api-model"
                    listTestId="inline-model-switcher-api-model-popover"
                    searchInputTestId="inline-model-switcher-api-model-search"
                    ariaLabel={t('inlineSwitcher.modelLabel')}
                    searchPlaceholder={t('inlineSwitcher.searchModels')}
                    emptyLabel={t('inlineSwitcher.noModelMatches')}
                    models={apiModelChoices}
                    value={config.model}
                    onChange={(nextValue) => {
                      trackExecutionSettingsPopoverClick(analytics.track, {
                        page_name: 'home',
                        area: 'execution_settings_popover',
                        element: 'model_dropdown',
                        execution_mode: 'byok',
                        provider_id:
                          byokProtocolToTracking(apiProtocol) ?? undefined,
                        model_id: modelIdForTracking(nextValue),
                      });
                      leaveBuildWithJev();
                      onApiModelChange?.(nextValue);
                    }}
                    additionalOptions={
                      config.model && !apiModelIds.includes(config.model)
                        ? [
                            {
                              value: config.model,
                              label: `${config.model} ${t('inlineSwitcher.customSuffix')}`,
                            },
                          ]
                        : undefined
                    }
                  />
                ) : (
                  <p className={styles.hint}>
                    {t('inlineSwitcher.openSettingsForModel')}
                  </p>
                )
              ) : (
                // Compact home popover: a plain list of the CURRENT agent's model
                // names — switching agents lives in the execution settings entry
                // below.
                <div className="inline-switcher__row">
                  {currentAgent && compactModelRows.length > 0 ? (
                    <div
                      className={`inline-switcher__agent-grid ${styles.compactList}`}
                      role="radiogroup"
                      aria-label={t('inlineSwitcher.modelLabel')}
                      ref={compactModelListRef}
                    >
                      {compactModelRows.map(({ model: m, selectable }) => {
                        const active = !jevActive && currentModelId === m.id;
                        // A model above the caller's plan is shown, but honestly:
                        // disabled with the reason the settings picker already uses,
                        // never as a normal row whose click gets reverted.
                        const lockedHint = selectable
                          ? null
                          : t('settings.amrModelUpgradeHint');
                        const attachmentHint = attachmentWarning?.unsupportedModelIds.has(m.id)
                          ? attachmentWarning.reason
                          : null;
                        return (
                          <div key={m.id} className="inline-switcher__agent-row">
                            <button
                              type="button"
                              role="radio"
                              aria-checked={active}
                              aria-disabled={selectable ? undefined : 'true'}
                              title={lockedHint ?? m.id}
                              className={
                                'inline-switcher__agent' +
                                (active ? ' is-active' : '') +
                                (selectable ? '' : ' is-locked')
                              }
                              data-testid={`inline-model-switcher-compact-model-${m.id}`}
                              onClick={() => {
                                // The sink is the authority, not the row's styling:
                                // a refused pick routes to the plans page (same as
                                // the settings picker's lock) instead of writing a
                                // choice the config would revert.
                                if (!pickAgentModel(m.id)) {
                                  if (amrCanUpgrade || campaignNeedsUpgrade) {
                                    openAmrModelUpgrade();
                                  }
                                  return;
                                }
                                trackExecutionSettingsPopoverClick(analytics.track, {
                                  page_name: 'home',
                                  area: 'execution_settings_popover',
                                  element: 'model_dropdown',
                                  execution_mode: 'local_cli',
                                  model_id: modelIdForTracking(m.id),
                                });
                                setOpen(false);
                              }}
                            >
                              <span
                                className="inline-switcher__agent-logo"
                                aria-hidden="true"
                              >
                                {(() => {
                                  const src = modelProviderIconSrc(m.id);
                                  return src ? (
                                    <img
                                      src={src}
                                      alt=""
                                      width={16}
                                      height={16}
                                    />
                                  ) : (
                                    <AgentIcon id={currentAgent.id} size={16} />
                                  );
                                })()}
                              </span>
                              <span className="inline-switcher__agent-name">
                                {m.label}
                                {m.id !== 'default' && m.id !== m.label ? (
                                  <span className="inline-switcher__model-id">{m.id}</span>
                                ) : null}
                              </span>
                              {lockedHint ? (
                                <span
                                  className="inline-switcher__agent-lock"
                                  data-testid={`inline-model-switcher-compact-model-lock-${m.id}`}
                                >
                                  <Icon name="lock" size={12} />
                                  <VisuallyHidden>{lockedHint}</VisuallyHidden>
                                </span>
                              ) : null}
                              {attachmentHint ? (
                                <span
                                  className="inline-switcher__agent-attachment-warning"
                                  data-testid={`inline-model-switcher-compact-model-attachment-warning-${m.id}`}
                                  title={attachmentHint}
                                >
                                  <Icon name="alert-triangle" size={12} />
                                  {t('workbench.preflight.modelBadge')}
                                  <VisuallyHidden>{attachmentHint}</VisuallyHidden>
                                </span>
                              ) : null}
                              {active ? (
                                <Icon name="check" size={14} className={styles.agentCheck} />
                              ) : null}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className={styles.hint}>
                      {t('inlineSwitcher.openSettingsForModel')}
                    </p>
                  )}
                </div>
              )}
              {modelTuningRows}
            </>
          )}

          {!nativeOnly && config.mode === 'api' && !config.apiKey ? (
            <div className={styles.warn} role="status">
              <Icon name="alert-triangle" size={14} />
              <span>{t('inlineSwitcher.missingApiKey')}</span>
            </div>
          ) : null}

          <div className={styles.footer}>
            <button
              type="button"
              className={`inline-switcher__more ${styles.footerButton}`}
              data-testid="inline-model-switcher-open-settings"
              onClick={() => {
                trackExecutionSettingsPopoverClick(analytics.track, {
                  page_name: 'home',
                  area: 'execution_settings_popover',
                  element: 'open_execution_settings',
                });
                setOpen(false);
                onOpenSettings?.('execution');
              }}
            >
              <Icon name="settings" size={14} />
              <span>{t('inlineSwitcher.openFullSettings')}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
