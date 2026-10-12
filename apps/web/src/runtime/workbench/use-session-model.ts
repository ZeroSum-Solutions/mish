import { readHomeModelHandoff } from './home-model-handoff';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { parseSessionModelChoice, type ModelPreflightResult, type SessionModelChoice, type SessionModelSnapshot, type WorkspaceCollabContext } from '@open-design/contracts';
import type { AppConfig, ApiProtocol, AgentModelChoice } from '../../types';
import { workspaceAccountScopedCacheKey } from '../../collab/workspace-identity';
import { getSessionModel, postModelPreflight, putSessionModel } from '../../providers/workbench';
import { switchApiProtocolConfig } from '../../components/SettingsDialog';
import { SessionModelController } from './session-model-controller';
import { configForSessionChoice, requireSessionChoiceFromConfig, sessionChoiceFromConfig } from './session-model-config';
import { configForExecutionMode, configForExecutionProtocol, emptyExecutionModelDrafts, rememberExecutionModelDraft } from './execution-model-drafts';
const idle = { choice: null, snapshot: null, status: 'loading' as const, error: null };
const noop = () => () => {};

/**
 * AC-R02.3 select-time gate: the state of the in-flight (or most recently
 * concluded) capability/availability preflight for a CANDIDATE picker
 * selection — checked with no attachments, before that candidate is ever
 * persisted through `SessionModelController.select`. `choice` is the exact
 * candidate the active check describes, so a caller can tell whether a
 * displayed mismatch/verification-failure still matches what is currently
 * selected in the picker.
 */
export type SessionModelPickerPreflight =
  | { status: 'checking'; choice: SessionModelChoice }
  | { status: 'mismatch'; choice: SessionModelChoice; result: ModelPreflightResult }
  | { status: 'network-error'; choice: SessionModelChoice };
/** A picker check that has not answered by now counts as a failed check
 *  ("couldn't verify"): the previous choice stays selected. */
export const PICKER_PREFLIGHT_TIMEOUT_MS = 15_000;
/** The longest a send waits for the picker to settle, across re-picks. */
export const PICKER_SETTLE_MAX_WAIT_MS = 45_000;
/**
 * How a wait for a settled picker ended:
 * - `settled`: a render with no pending check committed; the caller reads the
 *   settled choice.
 * - `cancelled`: the view unmounted or moved to another project or
 *   conversation; the caller must drop the send.
 * - `timed-out`: the picker did not settle within `PICKER_SETTLE_MAX_WAIT_MS`.
 */
export type PickerSettleOutcome = 'settled' | 'cancelled' | 'timed-out';
type PickerSettleWaiter = { resolve: (outcome: PickerSettleOutcome) => void; timer: ReturnType<typeof setTimeout> };

export function useSessionModel(defaults: AppConfig, projectId: string, sessionId: string | null, workspaceContext: WorkspaceCollabContext | null) {
  const scopeKey = workspaceAccountScopedCacheKey(workspaceContext);
  const defaultsRef = useRef(defaults); defaultsRef.current = defaults;
  const key = `od:session-model-pending:${scopeKey}:${projectId}:${sessionId}`;
  const draftsRef = useRef({ key, value: emptyExecutionModelDrafts() });
  if (draftsRef.current.key !== key) draftsRef.current = { key, value: emptyExecutionModelDrafts() };
  const activeScopeRef = useRef<string | null>(key); activeScopeRef.current = key;
  const assertCurrent = () => {
    if (activeScopeRef.current !== key || workspaceAccountScopedCacheKey(workspaceContext) !== scopeKey) throw new Error('session-model-scope-changed');
  };
  const controller = useMemo(() => {
    if (!sessionId) return null;
    let initial = null;
    let revision: number | undefined;
    const home = readHomeModelHandoff(projectId, scopeKey);
    try { initial = sessionChoiceFromConfig(defaultsRef.current); } catch { /* Picker can recover an unconfigured default. */ }
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Number.isSafeInteger(saved.revision) && saved.revision >= 0) { initial = parseSessionModelChoice(saved.choice); revision = saved.revision; }
      }
    } catch { /* Public pending-choice recovery is best effort; server remains authoritative. */ }
    if (home?.sessionId === sessionId && home.choice && !home.ready) { initial = home.choice; revision = home.modelRevision; }
    return new SessionModelController(sessionId, initial, {
      get: async id => { assertCurrent(); const result = await getSessionModel(id, projectId, workspaceContext); assertCurrent(); return result; },
      put: async (id, input) => { assertCurrent(); const result = await putSessionModel(id, projectId, input, workspaceContext); assertCurrent(); return result; },
    }, revision, home?.sessionId === sessionId && home.modelSaveFailed);
  }, [key, projectId, sessionId, scopeKey]);
  // Render-time (not effect) snapshot of the live controller identity, so an
  // async callback resuming after an `await` can tell whether IT is stale
  // (a session switch replaced `controller`) as soon as the next render has
  // happened — not only after a `useEffect` commits. Same idiom as the
  // `sessionModelChoiceRef`/`activeConversationIdRef` pattern in
  // ProjectView.tsx/DesignSystemFlow.tsx.
  const controllerRef = useRef(controller); controllerRef.current = controller;
  const rawState = useSyncExternalStore(controller?.subscribe ?? noop, controller?.getSnapshot ?? (() => idle));
  const [executionError, setExecutionError] = useState<{ key: string; error: unknown } | null>(null);
  // AC-R02.3: a picker selection pending its select-time preflight is
  // reflected as `saving` — the SAME status a controller-level persist
  // already uses while a PUT is in flight — so every existing "wait for
  // ready" caller blocks for the gate too, instead of racing past a
  // candidate that has not been accepted (or rejected) yet. `choice`/`config`
  // below stay derived from `rawState.choice`, which this overlay never
  // touches, so the previously saved selection keeps displaying until (and
  // unless) the gate actually calls `controller.select`.
  const [pickerPreflight, setPickerPreflight] = useState<SessionModelPickerPreflight | null>(null);
  const pickerPreflightEpochRef = useRef(0);
  /**
   * AC-R02.3: a send that finds the choice moving under it waits here instead
   * of being refused. It resolves `settled` in an effect, after a commit in
   * which no picker check is pending, so every value the caller reads from
   * that render (the live choice, a callback rebuilt for it) already
   * describes the settled choice. Registering a waiter forces one render, so
   * a caller whose check settled before it asked still gets that commit.
   * Every wait ends: each check times out (`PICKER_PREFLIGHT_TIMEOUT_MS`),
   * each wait is capped (`PICKER_SETTLE_MAX_WAIT_MS`), and unmount or a
   * project/conversation change ends it as `cancelled`.
   */
  const pickerSettledWaitersRef = useRef<PickerSettleWaiter[]>([]);
  const [, requestPickerSettledRender] = useState(0);
  const settlePickerWaiters = useCallback((outcome: PickerSettleOutcome) => {
    for (const waiter of pickerSettledWaitersRef.current.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(outcome);
    }
  }, []);
  const whenPickerSettled = useCallback(() => new Promise<PickerSettleOutcome>(resolve => {
    const waiter: PickerSettleWaiter = {
      resolve,
      timer: setTimeout(() => {
        pickerSettledWaitersRef.current = pickerSettledWaitersRef.current.filter(candidate => candidate !== waiter);
        resolve('timed-out');
      }, PICKER_SETTLE_MAX_WAIT_MS),
    };
    pickerSettledWaitersRef.current.push(waiter);
    requestPickerSettledRender(tick => tick + 1);
  }), []);
  // Cleanup runs on unmount and when the controller (project/conversation
  // scope) changes, before the settle effect below can resolve the waiters.
  useEffect(() => () => settlePickerWaiters('cancelled'), [controller, settlePickerWaiters]);
  const state = pickerPreflight?.status === 'checking' ? { ...rawState, status: 'saving' as const }
    : executionError?.key === key && rawState.status === 'ready' ? { ...rawState, status: 'error' as const, error: executionError.error }
    : rawState;
  useEffect(() => {
    if (pickerPreflight?.status === 'checking' || pickerSettledWaitersRef.current.length === 0) return;
    settlePickerWaiters('settled');
  });
  useEffect(() => {
    activeScopeRef.current = key;
    void controller?.load().catch(() => undefined);
    return () => { if (activeScopeRef.current === key) activeScopeRef.current = null; };
  }, [controller, key]);
  useEffect(() => {
    if (!controller || !state.choice || !state.snapshot) return;
    try {
      if (state.status === 'ready' && state.snapshot.choice && JSON.stringify(state.choice) === JSON.stringify(state.snapshot.choice)) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, JSON.stringify({ choice: state.choice, revision: state.snapshot.revision }));
    } catch { /* Never store credentials here. */ }
  }, [controller, key, state]);
  const [preferences, setPreferences] = useState<AppConfig['agentModels']>({});
  const [invalidConfig, setInvalidConfig] = useState<AppConfig | null>(null);
  useEffect(() => { setInvalidConfig(null); setPreferences({}); setPickerPreflight(null); pickerPreflightEpochRef.current += 1; }, [controller]);
  const config = invalidConfig ?? (state.choice ? configForSessionChoice({ ...defaults, agentModels: { ...defaults.agentModels, ...preferences } }, state.choice, true) : defaults);
  const configRef = useRef(config); configRef.current = config;
  /**
   * AC-R02.3 select-time gate: a candidate `choice` is checked with a
   * no-attachments preflight BEFORE it is ever handed to
   * `controller.select` (the existing persist/PUT path). A passing result
   * persists exactly as the old synchronous `chooseConfig` did; a mismatch
   * or a failed preflight CALL (network) both leave the controller
   * untouched — the previously saved choice stays selected/displayed, and
   * `pickerPreflight` carries the truthful outcome for a caller to render.
   * `epoch` discards a stale result from a superseded candidate (the user
   * picked again before the first check returned).
   */
  const runPickerPreflight = useCallback((choice: SessionModelChoice, next: AppConfig) => {
    if (!controller || !sessionId) return;
    const epoch = ++pickerPreflightEpochRef.current;
    const stale = () => epoch !== pickerPreflightEpochRef.current || controllerRef.current !== controller;
    setPickerPreflight({ status: 'checking', choice });
    // A check that does not answer in time is a failed check: abort the
    // request and fall through to the "couldn't verify" state below.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('picker-preflight-timeout')), PICKER_PREFLIGHT_TIMEOUT_MS);
    const timedOut = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
    });
    // Wrapped in `Promise.resolve().then(...)` so a `postModelPreflight`
    // that throws SYNCHRONOUSLY (never expected from the real
    // fetch-returning implementation, but possible from an incomplete test
    // double) still lands in the `.catch` below as a truthful
    // "couldn't verify" state, instead of crashing the caller that
    // triggered this picker selection.
    Promise.race([Promise.resolve().then(() => postModelPreflight(sessionId, projectId, {
      agentId: choice.agentId, modelId: choice.modelId,
      ...(choice.byokBinding ? { byokBinding: choice.byokBinding } : {}),
    }, workspaceContext, { signal: abort.signal })), timedOut]).then((result) => {
      if (stale()) return;
      if (!result.ok) { setPickerPreflight({ status: 'mismatch', choice, result }); return; }
      setPickerPreflight(null);
      setInvalidConfig(null); setExecutionError(null); setPreferences(next.agentModels);
      void controller.select(choice).catch(() => undefined);
    }).catch(() => {
      if (stale()) return;
      setPickerPreflight({ status: 'network-error', choice });
    }).finally(() => clearTimeout(timer));
  }, [controller, sessionId, projectId, workspaceContext]);
  const chooseConfig = useCallback((next: AppConfig) => {
    if (!controller || draftsRef.current.key !== key || workspaceAccountScopedCacheKey(workspaceContext) !== scopeKey) return;
    draftsRef.current.value = rememberExecutionModelDraft(rememberExecutionModelDraft(draftsRef.current.value, configRef.current), next);
    try {
      const choice = requireSessionChoiceFromConfig(next);
      runPickerPreflight(choice, next);
    } catch (error) { setInvalidConfig(next); controller.rejectSelection(error); }
  }, [controller, key, scopeKey, workspaceContext, runPickerPreflight]);
  const executionConfig = useCallback((snapshot: SessionModelSnapshot) => {
    assertCurrent();
    try { const config = configForSessionChoice(configRef.current, snapshot.choice!); setExecutionError(null); return config; }
    catch (error) { setExecutionError({ key, error }); throw error; }
  }, [controller, key, scopeKey]);
  const ensureSaved = useCallback(async (): Promise<SessionModelSnapshot> => {
    if (!controller) throw new Error('session-model-session-required');
    if (!controller.state.choice) {
      let choice: SessionModelChoice;
      try { choice = requireSessionChoiceFromConfig(defaultsRef.current); }
      catch (error) { controller.rejectSelection(error); throw error; }
      await controller.select(choice);
    }
    assertCurrent();
    const snapshot = await controller.ensureSaved();
    assertCurrent();
    return snapshot;
  }, [controller, key, scopeKey]);
  const retry = () => {
    if (!controller) return;
    setExecutionError(null);
    if (!invalidConfig) return controller.retry().catch(() => undefined);
    try {
      // Settings repairs the existing carrier; the explicit retry keeps the
      // user's concrete model rather than replacing it with a new default.
      const next = invalidConfig.mode === 'api' || invalidConfig.agentId === 'byok-opencode'
        ? { ...switchApiProtocolConfig(defaultsRef.current, invalidConfig.apiProtocol ?? 'anthropic'), model: invalidConfig.model }
        : invalidConfig;
      const choice = requireSessionChoiceFromConfig(next);
      setInvalidConfig(null); setExecutionError(null); setPreferences(next.agentModels);
      return controller.select(choice).catch(() => undefined);
    } catch (error) { controller.rejectSelection(error); }
  };
  return { config, state, ensureSaved, executionConfig, retry, pickerPreflight, whenPickerSettled,
    onModeChange: (mode: AppConfig['mode']) => chooseConfig(configForExecutionMode(configRef.current, mode, rememberExecutionModelDraft(draftsRef.current.value, configRef.current), defaultsRef.current)),
    onAgentChange: (agentId: string) => chooseConfig({ ...configRef.current, mode: 'daemon', agentId }),
    onAgentModelChange: (agentId: string, choice: AgentModelChoice) => chooseConfig({ ...configRef.current, mode: 'daemon', agentId,
      agentModels: { ...configRef.current.agentModels, [agentId]: { ...configRef.current.agentModels?.[agentId], ...choice } } }),
    onApiProtocolChange: (protocol: ApiProtocol) => chooseConfig(configForExecutionProtocol(configRef.current, protocol, rememberExecutionModelDraft(draftsRef.current.value, configRef.current), defaultsRef.current)),
    onApiModelChange: (model: string) => chooseConfig({ ...configRef.current, model }),
  };
}
