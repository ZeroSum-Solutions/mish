import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { useAnalytics } from '../analytics/provider';
import {
  trackDesignSystemsTemplatesModalClick,
  trackDesignSystemsTemplatesModalSharePopoverClick,
  trackDesignSystemsTemplatesModalSurfaceView,
} from '../analytics/events';
import { useT } from '../i18n';
import {
  fetchDesignSystem,
  fetchDesignSystemPreview,
  fetchDesignSystemShowcase,
} from '../providers/registry';
import type { DesignSystemDetail, DesignSystemSummary } from '../types';
import { DesignSpecView } from './DesignSpecView';
import { DesignSystemKitPreview } from './DesignSystemKitPreview';
import { PreviewModal } from './PreviewModal';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import {
  beginWorkspaceResourceScopedRead,
  resolveWorkspaceResourceReadIdentity,
  workspaceResourceReadIdentityFromContext,
  workspaceResourceReadIdentityKey,
  type WorkspaceResourceReadIdentity,
} from '../collab/workspace-identity';

interface Props {
  system: DesignSystemSummary;
  onClose: () => void;
  initialViewId?: 'showcase' | 'kit' | 'tokens';
  /** Exact project scope wins over the shell context while it is resolving. */
  workspaceContext?: WorkspaceCollabContext | null;
  /** Exact read-only authority; omitted callers use the ambient Workspace state. */
  resourceReadIdentity?: WorkspaceResourceReadIdentity | null;
}

function isDesignSystemDetail(system: DesignSystemSummary): system is DesignSystemDetail {
  return typeof (system as { body?: unknown }).body === 'string';
}

// Resolve authority once, then scope all loading state to the resource witness.
export function DesignSystemPreviewModal(props: Props) {
  const workspaceState = useWorkspaceContext();
  const ambient = resolveWorkspaceResourceReadIdentity(workspaceState);
  const identity = props.workspaceContext !== undefined
    ? workspaceResourceReadIdentityFromContext(props.workspaceContext)
    : props.resourceReadIdentity === undefined ? ambient : props.resourceReadIdentity;
  return <ScopedDesignSystemPreviewModal {...props} identity={identity}
    key={`${props.system.id}:${workspaceResourceReadIdentityKey(identity)}`} />;
}

function ScopedDesignSystemPreviewModal({ system, onClose, initialViewId = 'showcase', identity: resourceReadIdentity }: Props & { identity: WorkspaceResourceReadIdentity | null }) {
  const t = useT();
  const analytics = useAnalytics();
  const trackRef = useRef(analytics.track);
  trackRef.current = analytics.track;
  const resourceReadIdentityKey = workspaceResourceReadIdentityKey(resourceReadIdentity);
  const resourceReadIdentityRef = useRef(resourceReadIdentity);
  resourceReadIdentityRef.current = resourceReadIdentity;
  const surfaceViewFiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (surfaceViewFiredRef.current === system.id) return;
    surfaceViewFiredRef.current = system.id;
    trackDesignSystemsTemplatesModalSurfaceView(analytics.track, {
      page_name: 'design_systems',
      area: 'templates_modal',
      templates_id: system.id,
      templates_type: system.source ?? 'library',
    });
  }, [analytics.track, system.id, system.source]);

  const [showcaseHtml, setShowcaseHtml] = useState<string | null | undefined>(undefined);
  const [tokensHtml, setTokensHtml] = useState<string | null | undefined>(undefined);
  const [showcaseError, setShowcaseError] = useState(false);
  const [tokensError, setTokensError] = useState(false);
  const htmlStatus = useRef<Record<'showcase' | 'tokens', 'unrequested' | 'loading' | 'loaded' | 'error'>>({ showcase: 'unrequested', tokens: 'unrequested' });
  const [specBody, setSpecBody] = useState<string | null | undefined>(undefined);
  const [detail, setDetail] = useState<DesignSystemDetail | null | undefined>(
    () => (isDesignSystemDetail(system) ? system : undefined),
  );
  const detailBody = detail?.body ?? (isDesignSystemDetail(system) ? system.body : undefined);

  useEffect(() => {
    let cancelled = false;
    const read = beginWorkspaceResourceScopedRead(resourceReadIdentityRef.current);
    setDetail(isDesignSystemDetail(system) ? system : undefined);
    void fetchDesignSystem(system.id, read.context).then((next) => {
      if (cancelled || !read.isStillCurrent(resourceReadIdentityRef.current)) return;
      if (next) setDetail(next);
    });
    return () => {
      cancelled = true;
    };
  }, [system, resourceReadIdentityKey]);

  const initialViewIdRef = useRef<string | null>(null);
  const handleView = useCallback(
    (viewId: string) => {
      if (initialViewIdRef.current === null) {
        initialViewIdRef.current = viewId;
      } else if (initialViewIdRef.current !== viewId) {
        initialViewIdRef.current = viewId;
        if (viewId === 'showcase' || viewId === 'kit' || viewId === 'tokens') {
          trackDesignSystemsTemplatesModalClick(trackRef.current, {
            page_name: 'design_systems',
            area: 'templates_modal',
            element: viewId === 'kit' ? 'open_design_set' : viewId,
            templates_id: system.id,
            templates_type: system.source ?? 'library',
          });
        }
      }
      if (viewId !== 'showcase' && viewId !== 'tokens') return;
      if (htmlStatus.current[viewId] === 'loading' || htmlStatus.current[viewId] === 'loaded') return;
      htmlStatus.current[viewId] = 'loading';
      const read = beginWorkspaceResourceScopedRead(resourceReadIdentityRef.current);
      const setHtml = viewId === 'showcase' ? setShowcaseHtml : setTokensHtml;
      const setError = viewId === 'showcase' ? setShowcaseError : setTokensError;
      const fetchHtml = viewId === 'showcase' ? fetchDesignSystemShowcase : fetchDesignSystemPreview;
      setHtml(null);
      setError(false);
      const finish = (html: string | null) => {
        if (!read.isStillCurrent(resourceReadIdentityRef.current)) return;
        htmlStatus.current[viewId] = html ? 'loaded' : 'error';
        setHtml(html);
        setError(!html);
      };
      void fetchHtml(system.id, read.context).then(finish).catch(() => finish(null));
    },
    [system.id, system.source, resourceReadIdentityKey],
  );

  const handleSidebarToggle = useCallback(
    (open: boolean) => {
      if (!open || specBody !== undefined) return;
      if (detailBody !== undefined) {
        setSpecBody(detailBody);
        return;
      }
      const read = beginWorkspaceResourceScopedRead(resourceReadIdentityRef.current);
      setSpecBody(null);
      void fetchDesignSystem(system.id, read.context).then((nextDetail) => {
        if (read.isStillCurrent(resourceReadIdentityRef.current)) {
          setSpecBody(nextDetail?.body ?? null);
        }
      });
    },
    [detailBody, system.id, specBody, resourceReadIdentityKey],
  );

  const modal = (
    <PreviewModal
      title={system.title}
      subtitle={system.summary || system.category}
      views={[
        { id: 'showcase', label: t('ds.showcase'), html: showcaseHtml, error: showcaseError ? t('preview.errorBody') : null },
        {
          id: 'kit',
          label: t('ds.kitVisualize'),
          custom: (
            <DesignSystemKitPreview
              system={system}
              resourceReadIdentity={resourceReadIdentity}
              variant="panel"
              showCover={false}
              className="ds-modal-kit-preview"
              dataTestId="design-system-modal-kit"
            />
          ),
        },
        { id: 'tokens', label: t('ds.tokens'), html: tokensHtml, error: tokensError ? t('preview.errorBody') : null },
      ]}
      initialViewId={initialViewId}
      onView={handleView}
      exportTitleFor={(viewId) => (viewId === 'kit' ? system.title : `${system.title} - ${viewId}`)}
      onClose={onClose}
      onFullscreenClick={() =>
        trackDesignSystemsTemplatesModalClick(analytics.track, {
          page_name: 'design_systems',
          area: 'templates_modal',
          element: 'fullscreen',
          templates_id: system.id,
          templates_type: system.source ?? 'library',
        })
      }
      onShareClick={() =>
        trackDesignSystemsTemplatesModalClick(analytics.track, {
          page_name: 'design_systems',
          area: 'templates_modal',
          element: 'share',
          templates_id: system.id,
          templates_type: system.source ?? 'library',
        })
      }
      onSidebarToggleClick={() =>
        trackDesignSystemsTemplatesModalClick(analytics.track, {
          page_name: 'design_systems',
          area: 'templates_modal',
          element: 'design_md',
          templates_id: system.id,
          templates_type: system.source ?? 'library',
        })
      }
      onSharePopoverItemClick={(item) =>
        trackDesignSystemsTemplatesModalSharePopoverClick(analytics.track, {
          page_name: 'design_systems',
          area: 'templates_modal_share_popover',
          element: item,
          templates_id: system.id,
          templates_type: system.source ?? 'library',
        })
      }
      sidebar={{
        label: t('ds.specToggle'),
        defaultOpen: false,
        onToggle: handleSidebarToggle,
        contentKey: `${system.id}:${resourceReadIdentityKey}`,
        content: (
          <DesignSpecView
            source={specBody}
            loadingLabel={t('ds.specLoading')}
          />
        ),
      }}
    />
  );

  if (typeof document === 'undefined') return modal;
  return createPortal(modal, document.body);
}
