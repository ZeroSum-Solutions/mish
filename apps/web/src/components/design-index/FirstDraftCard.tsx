// Flagship "client brief → working first draft" (docs/plans/2026-10-09-flagship/plan.md):
// the Design Index Route panel's last steps. After the brief is routed and the family and its
// sections are edited, the person picks an installed kit and builds. One POST /api/build-on-brand
// (the same route `od build-on-brand` calls) creates the project bound to the kit and starts one
// agent run; this card follows the run to the site check, opens the project for the desktop and
// mobile preview, and deploys through the existing Vercel route.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BuildOnBrandRequest,
  BuildOnBrandResult,
  DeployConfigResponse,
  DeployProjectFileResponse,
  DesignSystemSummary,
  RouteDecision,
  ReferenceSection,
  RunDesignBriefBinding,
  SiteCheckResult,
} from '@mish/contracts';
import { REFERENCE_SPINES } from '@mish/contracts';
import { Button, Select, Spinner } from '@mish/components';

import { useI18n, useT } from '../../i18n';
import { DeployPublicAccessToggle, deployAccessOf, useDeployAccessMessage, type DeployLinkAccess } from '../DeployPublicAccessToggle';
import { designSystemIdentity } from '../../runtime/design-system-identity';
import { isSelectableDesignSystem } from '../../runtime/design-system-selection';
import { WorkbenchImprovePrompt } from '../workbench/WorkbenchImprovePrompt';
import { WorkbenchReferences } from '../workbench/WorkbenchReferences';
import styles from './FirstDraftCard.module.css';

type Translate = ReturnType<typeof useT>;

interface Props {
  brief: string;
  decision: RouteDecision;
  /** The family's optional sections the person kept or dropped. */
  sectionHints: Record<string, 'keep' | 'drop'>;
  /** Named sections explicitly kept in the routed family; automatic sections are suggested by the search service. */
  referenceSections?: ReferenceSection[];
  referenceExcludedSections?: string[];
  /** The insertable catalogue section picked in the section picker, if any. */
  catalogEntryId?: string | null;
  onOpenProject?: (projectId: string) => void;
  onOpenSettings?: () => void;
  /** Run status poll interval (ms). */
  pollMs?: number;
}

type KitsState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; kits: DesignSystemSummary[] };
type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
type Failure = { kind: 'agent' | 'kit' | 'start' | 'run'; message: string; detail?: string };
type DeployState =
  | { status: 'idle' }
  | { status: 'deploying' }
  | { status: 'unconfigured' }
  | { status: 'done'; url: string; access: DeployLinkAccess }
  | { status: 'failed'; message: string };

const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'canceled', 'cancelled']);

async function readError(response: Response): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    return { code: body.error?.code ?? 'UNKNOWN', message: body.error?.message ?? '', ...(body.error?.details ? { details: body.error.details } : {}) };
  } catch {
    return { code: 'UNKNOWN', message: '' };
  }
}

function failureOf(error: { code: string; message: string; details?: Record<string, unknown> }, t: Translate): Failure {
  if (error.code === 'AGENT_UNAVAILABLE') {
    const fix = typeof error.details?.fix === 'string' ? error.details.fix : error.message;
    return { kind: 'agent', message: t('firstDraft.error.agentUnavailable'), detail: fix };
  }
  if (error.code === 'DESIGN_SYSTEM_NOT_INSTALLED') {
    return { kind: 'kit', message: error.details?.reason === 'draft' ? t('firstDraft.error.kitDraft') : t('firstDraft.error.kitMissing'), detail: error.message };
  }
  return { kind: 'start', message: t('firstDraft.error.startFailed'), ...(error.message ? { detail: error.message } : {}) };
}

function statusLabel(status: RunStatus, t: Translate): string {
  switch (status) {
    case 'queued': return t('firstDraft.status.queued');
    case 'running': return t('firstDraft.status.running');
    case 'succeeded': return t('firstDraft.status.succeeded');
    case 'failed': return t('firstDraft.status.failed');
    default: return t('firstDraft.status.canceled');
  }
}

export function FirstDraftCard({ brief, decision, sectionHints, referenceSections, referenceExcludedSections, catalogEntryId, onOpenProject, onOpenSettings, pollMs = 3000 }: Props) {
  const { t, locale } = useI18n();
  const [kits, setKits] = useState<KitsState>({ status: 'loading' });
  const [kitId, setKitId] = useState('');
  const [pageCount, setPageCount] = useState(4);
  const [useLibrary, setUseLibrary] = useState(true);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<BuildOnBrandResult | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [check, setCheck] = useState<SiteCheckResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [deploy, setDeploy] = useState<DeployState>({ status: 'idle' });
  // The card's deploy is the link a person shares with a client, so it asks Vercel to turn
  // deployment protection off by default, as the file viewer's deploy modal does.
  const [deployPublic, setDeployPublic] = useState(true);
  const deployAccessMessage = useDeployAccessMessage();
  // Step 4, Improve prompt (B8-1): the first-draft project the brief lives in, the dialog, and
  // the accepted revision the build binds to. All three belong to one kit.
  const [improveProjectId, setImproveProjectId] = useState<string | null>(null);
  const [improveOpen, setImproveOpen] = useState(false);
  const [improving, setImproving] = useState(false);
  const [acceptedBrief, setAcceptedBrief] = useState<RunDesignBriefBinding | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void fetch('/api/design-systems')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { designSystems?: DesignSystemSummary[] };
        if (live) setKits({ status: 'ready', kits: (body.designSystems ?? []).filter(isSelectableDesignSystem) });
      })
      .catch(() => {
        if (live) setKits({ status: 'failed' });
      });
    return () => {
      live = false;
    };
  }, []);

  const referenceSpine = REFERENCE_SPINES.find(code => code === decision.spine.code);

  const route = useMemo((): NonNullable<BuildOnBrandRequest['route']> => {
    const sections = Object.keys(sectionHints).length > 0 ? { sections: sectionHints } : {};
    return {
      spine: decision.spine.code,
      ...(decision.decision === 'routed' && decision.family ? { family: decision.family.id } : {}),
      ...sections,
      ...(catalogEntryId ? { catalogEntryIds: [catalogEntryId] } : {}),
    };
  }, [decision, sectionHints, catalogEntryId]);

  // Follow the run to its end, then read the site check once.
  useEffect(() => {
    if (!result) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(result.runId)}`);
        const run = response.ok ? ((await response.json()) as { status?: string; error?: string }) : null;
        if (!live) return;
        const status = (run?.status === 'cancelled' ? 'canceled' : run?.status) as RunStatus | undefined;
        if (status) setRunStatus(status);
        if (status && TERMINAL.has(status)) {
          if (status === 'succeeded') {
            const checked = await fetch(`/api/projects/${encodeURIComponent(result.projectId)}/site-check`);
            if (live && checked.ok) setCheck((await checked.json()) as SiteCheckResult);
          } else if (live) {
            setFailure({ kind: 'run', message: t('firstDraft.error.runFailed'), ...(run?.error ? { detail: run.error } : {}) });
          }
          return;
        }
      } catch {
        // A dropped poll is retried on the next tick.
      }
      if (live) timer = setTimeout(() => { void poll(); }, pollMs);
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [result, pollMs, t]);

  const build = useCallback(async () => {
    if (startingRef.current || !kitId) return;
    startingRef.current = true;
    setStarting(true);
    setFailure(null);
    setCheck(null);
    setRunStatus(null);
    setDeploy({ status: 'idle' });
    const request: BuildOnBrandRequest = {
      brief,
      designSystemId: kitId,
      pageCount,
      useLibrary,
      route,
      ...(acceptedBrief && improveProjectId ? { designBrief: { projectId: improveProjectId, ...acceptedBrief } } : {}),
    };
    try {
      const response = await fetch('/api/build-on-brand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!mountedRef.current) return;
      if (response.status !== 202) {
        setFailure(failureOf(await readError(response), t));
        return;
      }
      const started = (await response.json()) as BuildOnBrandResult;
      // The brief's project now holds this draft; a later build starts a fresh project.
      setAcceptedBrief(null);
      setImproveProjectId(null);
      setResult(started);
      setRunStatus('queued');
    } catch {
      if (mountedRef.current) setFailure({ kind: 'start', message: t('firstDraft.error.startFailed') });
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  }, [brief, kitId, pageCount, useLibrary, route, acceptedBrief, improveProjectId, t]);

  const improvePrompt = useCallback(async () => {
    if (!kitId || improving) return;
    setFailure(null);
    if (improveProjectId) {
      setImproveOpen(true);
      return;
    }
    setImproving(true);
    try {
      const response = await fetch('/api/build-on-brand/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ designSystemId: kitId, brief }),
      });
      if (!mountedRef.current) return;
      if (response.status !== 201) {
        setFailure(failureOf(await readError(response), t));
        return;
      }
      const { projectId } = (await response.json()) as { projectId: string };
      setImproveProjectId(projectId);
      setImproveOpen(true);
    } catch {
      if (mountedRef.current) setFailure({ kind: 'start', message: t('firstDraft.error.request') });
    } finally {
      if (mountedRef.current) setImproving(false);
    }
  }, [kitId, improving, improveProjectId, brief, t]);

  // The project the card is showing now; a deploy answer for an older build is dropped.
  const currentProjectRef = useRef<string | null>(null);
  currentProjectRef.current = result?.projectId ?? null;

  const deployToVercel = useCallback(async () => {
    if (!result || deploy.status === 'deploying') return;
    const projectId = result.projectId;
    const current = () => mountedRef.current && currentProjectRef.current === projectId;
    const settle = (next: DeployState) => {
      if (current()) setDeploy(next);
    };
    setDeploy({ status: 'deploying' });
    try {
      const configResponse = await fetch('/api/deploy/config?providerId=vercel-self');
      const config = configResponse.ok ? ((await configResponse.json()) as DeployConfigResponse) : null;
      if (!config?.configured) {
        settle({ status: 'unconfigured' });
        return;
      }
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: 'index.html', providerId: 'vercel-self', target: 'preview', publicAccess: deployPublic }),
      });
      if (!response.ok) {
        const error = await readError(response);
        settle({ status: 'failed', message: error.message || error.code });
        return;
      }
      const deployed = (await response.json()) as DeployProjectFileResponse;
      settle({ status: 'done', url: deployed.url, access: deployAccessOf(deployed) });
    } catch {
      settle({ status: 'failed', message: t('firstDraft.error.request') });
    }
  }, [result, deploy.status, deployPublic, t]);

  const kitOptions = kits.status === 'ready' ? kits.kits : [];
  const canBuild = Boolean(kitId) && Boolean(brief.trim()) && !starting;
  const running = result !== null && runStatus !== null && !TERMINAL.has(runStatus);

  return (
    <article className={styles.card} data-testid="first-draft-card">
      <header className={styles.head}>
        <h2 className={styles.title}>{t('firstDraft.title')}</h2>
      </header>
      <p className={styles.lead}>{t('firstDraft.lead')}</p>

      <div className={styles.controls}>
        <label className={styles.field}>
          <span className={styles.label}>{t('firstDraft.kit')}</span>
          <Select
            className={styles.select}
            value={kitId}
            disabled={starting || running}
            onChange={(event) => {
              setKitId(event.target.value);
              setImproveProjectId(null);
              setAcceptedBrief(null);
            }}
            data-testid="first-draft-kit"
          >
            <option value="">{t('firstDraft.kitPlaceholder')}</option>
            {kitOptions.map((kit) => {
              const identity = designSystemIdentity(kit, kitOptions, locale);
              return <option key={kit.id} value={kit.id}>{kit.title}{identity ? ` · ${identity}` : ''}</option>;
            })}
          </Select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{t('firstDraft.pages')}</span>
          <Select
            className={styles.select}
            value={String(pageCount)}
            disabled={starting || running}
            onChange={(event) => setPageCount(Number(event.target.value))}
            data-testid="first-draft-pages"
          >
            {[3, 4, 5].map((count) => <option key={count} value={String(count)}>{count}</option>)}
          </Select>
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={useLibrary}
            disabled={starting || running}
            onChange={(event) => setUseLibrary(event.target.checked)}
            data-testid="first-draft-use-library"
          />
          <span>{t('firstDraft.useLibrary')}</span>
        </label>
      </div>
      {kits.status === 'failed' ? <p className={styles.error}>{t('firstDraft.kitLoadFailed')}</p> : null}
      {kits.status === 'ready' && kitOptions.length === 0 ? <p className={styles.note}>{t('firstDraft.kitNone')}</p> : null}

      <WorkbenchReferences brief={brief} spineCode={referenceSpine} sectionAdditions={referenceSections} excludedSections={referenceExcludedSections} contextKey={JSON.stringify({ sectionHints, family: decision.family?.id })} />

      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={!canBuild || running || improving || result !== null}
          onClick={() => { void improvePrompt(); }}
          data-testid="first-draft-improve"
        >
          {acceptedBrief ? t('firstDraft.improveAgain') : t('firstDraft.improve')}
        </Button>
        <Button variant="primary" loading={starting || running} disabled={!kitId || !brief.trim()} onClick={() => { void build(); }} data-testid="first-draft-build">
          {t('firstDraft.build')}
        </Button>
      </div>

      {acceptedBrief ? (
        <p className={styles.note} role="status" data-testid="first-draft-brief-accepted">
          {t('firstDraft.briefAccepted', { revision: String(acceptedBrief.revision) })}
        </p>
      ) : null}

      {improveOpen && improveProjectId ? (
        <WorkbenchImprovePrompt
          projectId={improveProjectId}
          draft={brief}
          spineCode={referenceSpine}
          onUse={(binding) => {
            setAcceptedBrief(binding);
            setImproveOpen(false);
          }}
          onClose={() => setImproveOpen(false)}
        />
      ) : null}

      {failure ? (
        <div className={styles.failure} role="alert" data-testid={`first-draft-failure-${failure.kind}`}>
          <p className={styles.failureTitle}>{failure.message}</p>
          {failure.detail ? <p className={styles.failureDetail}>{failure.detail}</p> : null}
          {failure.kind === 'agent' && onOpenSettings ? (
            <Button variant="secondary" size="sm" onClick={onOpenSettings}>{t('firstDraft.openSettings')}</Button>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className={styles.result} role="group" aria-label={t('firstDraft.title')}>
          {runStatus ? (
            <span className={styles.status} role="status" data-testid="first-draft-status">
              {running ? <Spinner size="sm" /> : null}
              {statusLabel(runStatus, t)}
            </span>
          ) : null}
          <p className={styles.note}>
            {t('firstDraft.planned', { pages: result.plan.pages.map((page) => page.file).join(', ') })}
          </p>
          {(result.warnings ?? []).length > 0 ? (
            <ul className={styles.warnings}>
              {(result.warnings ?? []).map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}
          <div className={styles.actions}>
            {onOpenProject ? (
              <Button variant="secondary" onClick={() => onOpenProject(result.projectId)} data-testid="first-draft-open-project">
                {t('firstDraft.openProject')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={runStatus !== 'succeeded' || deploy.status === 'deploying'}
              onClick={() => { void deployToVercel(); }}
              data-testid="first-draft-deploy"
            >
              {deploy.status === 'deploying' ? t('firstDraft.deploying') : t('firstDraft.deploy')}
            </Button>
          </div>
          <div className={styles.deployAccess}>
            <DeployPublicAccessToggle checked={deployPublic} onChange={setDeployPublic} disabled={deploy.status === 'deploying'} />
          </div>
          <p className={styles.note}>{t('firstDraft.previewHint')}</p>
          {check ? (
            <section className={styles.check} data-testid="first-draft-site-check" aria-label={t('firstDraft.siteCheck')}>
              <h3 className={styles.checkTitle}>
                {t('firstDraft.siteCheck')} · {check.ok ? t('firstDraft.siteCheckOk') : t('firstDraft.siteCheckFailed')}
              </h3>
              <ul className={styles.rules}>
                {check.rules.map((rule) => (
                  <li key={rule.id} className={rule.ok ? styles.rulePass : styles.ruleFail}>
                    <span className={styles.ruleMark} aria-hidden="true">{rule.ok ? '✓' : '✗'}</span>
                    <code className={styles.ruleId}>{rule.id}</code>
                    <span className={styles.ruleDetail}>{rule.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {deploy.status === 'unconfigured' ? (
            <p className={styles.note} role="status" data-testid="first-draft-deploy-unconfigured">{t('firstDraft.deployUnconfigured')}</p>
          ) : null}
          {deploy.status === 'done' ? (
            <p className={styles.note} data-testid="first-draft-deployed">
              {t('firstDraft.deployDone')}{' '}
              <a href={deploy.url} target="_blank" rel="noreferrer" data-testid="first-draft-deploy-url">{deploy.url}</a>{' '}
              <span data-testid="first-draft-deploy-access" data-access={deploy.access}>{deployAccessMessage(deploy.access)}</span>
            </p>
          ) : null}
          {deploy.status === 'failed' ? (
            <p className={styles.error} role="alert">{t('firstDraft.deployFailed', { message: deploy.message })}</p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
