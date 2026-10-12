import { useEffect, useRef, useState } from 'react';
import type { BrandSummary, WorkspaceCollabContext } from '@mish/contracts';
import { useT } from '../i18n';
import { designSystemStaticUrl, fetchDesignSystem, fetchDesignSystemShowcase } from '../providers/registry';
import {
  brandSummaryToKit,
  useDesignKit,
} from '../runtime/design-kit';
import type { DesignSystemDetail, DesignSystemSummary } from '../types';
import { DesignKitView } from './DesignKitView';
import { DesignSystemOverview } from './DesignSystemOverview';
import {
  designSystemLogoHost,
  isUserSystem,
} from './design-system-metadata';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import {
  beginWorkspaceResourceScopedRead,
  resolveWorkspaceResourceReadIdentity,
  workspaceResourceReadIdentityFromContext,
  workspaceResourceReadIdentityKey,
  type WorkspaceResourceReadIdentity,
} from '../collab/workspace-identity';

interface DesignSystemKitPreviewProps {
  system: DesignSystemSummary;
  brandSummary?: BrandSummary | null;
  variant?: 'panel' | 'compact';
  showCover?: boolean;
  className?: string;
  dataTestId?: string;
  workspaceContext?: WorkspaceCollabContext | null;
  resourceReadIdentity?: WorkspaceResourceReadIdentity | null;
}

export function DesignSystemKitPreview({
  system,
  brandSummary,
  variant = 'panel',
  showCover = false,
  className,
  dataTestId = 'design-system-kit-preview',
  workspaceContext,
  resourceReadIdentity,
}: DesignSystemKitPreviewProps) {
  const workspaceState = useWorkspaceContext();
  const ambientResourceReadIdentity = resolveWorkspaceResourceReadIdentity(workspaceState);
  // ProjectView/Picker already own an exact route context. It must win over
  // ambient provisional identity; only callers without an explicit context
  // consume the ambient `{ context, generation }` read witness.
  const effectiveResourceReadIdentity = workspaceContext !== undefined
    ? workspaceResourceReadIdentityFromContext(workspaceContext)
    : resourceReadIdentity === undefined
      ? ambientResourceReadIdentity
      : resourceReadIdentity;
  if (brandSummary) {
    return (
      <BrandDesignSystemKitPreview
        key={`${system.id}:${workspaceResourceReadIdentityKey(effectiveResourceReadIdentity)}`}
        summary={brandSummary}
        variant={variant}
        showCover={showCover}
        className={className}
        dataTestId={dataTestId}
        resourceReadIdentity={effectiveResourceReadIdentity}
      />
    );
  }

  return (
    <RegistryDesignSystemKitPreview
      key={`${system.id}:${workspaceResourceReadIdentityKey(effectiveResourceReadIdentity)}`}
      system={system}
      variant={variant}
      showCover={showCover}
      className={className}
      dataTestId={dataTestId}
      resourceReadIdentity={effectiveResourceReadIdentity}
    />
  );
}

function BrandDesignSystemKitPreview({
  summary,
  variant,
  showCover,
  className,
  dataTestId,
  resourceReadIdentity,
}: {
  summary: BrandSummary;
  variant: 'panel' | 'compact';
  showCover: boolean;
  className?: string;
  dataTestId: string;
  resourceReadIdentity: WorkspaceResourceReadIdentity | null;
}) {
  const workspaceContext = resourceReadIdentity?.context ?? null;
  const kit = brandSummaryToKit(summary, workspaceContext);
  const resourceReadIdentityKey = workspaceResourceReadIdentityKey(resourceReadIdentity);
  return (
    <div className={className} data-testid={dataTestId}>
      <KitPreviewView
        kit={kit}
        workspaceContext={resourceReadIdentity?.context ?? null}
        workspaceReadGeneration={resourceReadIdentityKey}
        variant={variant}
        showCover={showCover}
        dataTestId={`${dataTestId}-view`}
      />
    </div>
  );
}

function RegistryDesignSystemKitPreview({
  system,
  variant,
  showCover,
  className,
  dataTestId,
  resourceReadIdentity,
}: {
  system: DesignSystemSummary;
  variant: 'panel' | 'compact';
  showCover: boolean;
  className?: string;
  dataTestId: string;
  resourceReadIdentity: WorkspaceResourceReadIdentity | null;
}) {
  const t = useT();
  const effectiveResourceReadIdentity = resourceReadIdentity;
  const resourceReadIdentityKey = workspaceResourceReadIdentityKey(effectiveResourceReadIdentity);
  const resourceReadIdentityRef = useRef(effectiveResourceReadIdentity);
  resourceReadIdentityRef.current = effectiveResourceReadIdentity;
  const workspaceContext = effectiveResourceReadIdentity?.context ?? null;
  const [detail, setDetail] = useState<DesignSystemDetail | null>(null);
  const [detailResolved, setDetailResolved] = useState(false);
  const [showcaseHtml, setShowcaseHtml] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = beginWorkspaceResourceScopedRead(resourceReadIdentityRef.current);
    setDetail(null);
    setDetailResolved(false);
    // Let quick pointer passes show the thumbnail without starting detail reads.
    const timer = setTimeout(() => {
      void fetchDesignSystem(system.id, read.context)
        .then((next) => {
          if (cancelled || !read.isStillCurrent(resourceReadIdentityRef.current)) return;
          setDetail(next);
          setDetailResolved(true);
        })
        .catch(() => {
          if (!cancelled && read.isStillCurrent(resourceReadIdentityRef.current)) {
            setDetailResolved(true);
          }
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [system.id, resourceReadIdentityKey]);

  useEffect(() => {
    if (!showCover || (system.previewImagePath && !imageFailed)) return;
    let cancelled = false;
    const read = beginWorkspaceResourceScopedRead(resourceReadIdentityRef.current);
    const timer = setTimeout(() => {
      void fetchDesignSystemShowcase(system.id, read.context).then((html) => {
        if (!cancelled && read.isStillCurrent(resourceReadIdentityRef.current)) setShowcaseHtml(html);
      }).catch(() => undefined);
    }, 100);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [system.id, system.previewImagePath, resourceReadIdentityKey, showCover, imageFailed]);

  const projectId = detail?.projectId ?? system.projectId;
  const host = designSystemLogoHost(system) || undefined;
  const { kit, loading } = useDesignKit({
    designSystemId: system.id,
    title: system.title,
    projectId,
    body: detail?.body,
    packageInfo: detail?.packageInfo,
    previewImagePath: detail?.previewImagePath ?? system.previewImagePath,
    swatches: system.swatches,
    showcaseHtml: null,
    editable: isUserSystem(system),
    host,
    workspaceContext,
    workspaceReadGeneration: resourceReadIdentityKey,
  });

  const pending = !detailResolved || loading || !kit;

  return (
    <div className={className} data-testid={dataTestId}>
      {pending && variant === 'compact' ? (
        <>
          <DesignSystemOverview dataTestId={`${dataTestId}-placeholder`} onImageError={() => setImageFailed(true)} kit={{
            showcaseHtml,
            name: system.title,
            description: system.summary,
            category: system.category,
            referenceImageUrl: system.previewImagePath
              ? designSystemStaticUrl(system.id, system.previewImagePath, workspaceContext) : undefined,
            colors: (system.swatches ?? []).map((hex) => ({ hex, name: hex, role: 'source', usage: '' })),
            typography: {}, fonts: [], editable: false, canUpload: false, logoAlternates: [],
          }} />
          <div className="ds-overview-loading" role="status" aria-busy="true">{t('designSystemPicker.loadingPreview')}</div>
        </>
      ) : pending ? (
        <div
          className="design-system-kit-preview-loading"
          role="status"
          aria-busy="true"
          data-testid={`${dataTestId}-loading`}
        >
          {t('designSystemPicker.loadingPreview')}
        </div>
      ) : (
        <KitPreviewView
          kit={{ ...kit, showcaseHtml }}
          onImageError={() => setImageFailed(true)}
          workspaceContext={workspaceContext}
          workspaceReadGeneration={resourceReadIdentityKey}
          variant={variant}
          showCover={showCover}
          dataTestId={`${dataTestId}-view`}
        />
      )}
    </div>
  );
}

function KitPreviewView(props: Parameters<typeof DesignKitView>[0] & { onImageError?: () => void }) {
  return props.variant === 'compact'
    ? <DesignSystemOverview kit={props.kit} dataTestId={props.dataTestId ?? 'design-system-overview'} workspaceContext={props.workspaceContext} workspaceReadGeneration={props.workspaceReadGeneration} onImageError={props.onImageError} />
    : <DesignKitView {...props} />;
}
