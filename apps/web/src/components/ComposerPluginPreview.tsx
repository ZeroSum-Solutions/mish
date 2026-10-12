// Hover preview panel for the composer "+" → Plugins flyout.
//
// Each plugin row shows a thumbnail and its full localized name.
// Hovering (or arrow-defaulting to) a plugin
// renders its live preview hero plus the title, a localized kind tag,
// the trust badge, and the description, so the choice is informed before
// the user clicks.
//
// It reuses the plugins-home preview stack (`inferPluginPreview` +
// `PreviewSurface`) so the hero looks identical to the gallery tile,
// and the localization helpers so the copy follows the active locale.

import { useMemo } from 'react';
import type {
  InstalledPluginRecord,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { useT } from '../i18n';
import { PreviewSurface } from './plugins-home/cards/PreviewSurface';
import { extractCategories } from './plugins-home/facets';
import {
  localizePluginDescription,
  localizePluginTitle,
} from './plugins-home/localization';
import { inferPluginPreview } from './plugins-home/preview';
import { TrustBadge } from './TrustBadge';
import { WorkbenchPreviewShell } from './workbench/WorkbenchPreviewShell';
import { WorkbenchHtmlPreview } from './workbench/WorkbenchHtmlPreview';
import { useInView } from './plugins-home/useInView';

// Map a plugin's primary facet (from `extractCategories`) to its localized
// chip label — the same taxonomy as the home Community filters, so the
// preview's "kind" tag reads identically to those chips.
function pluginKindLabel(
  slug: string | undefined,
  t: ReturnType<typeof useT>,
): string | null {
  switch (slug) {
    case 'prototype':
      return t('homeHero.chip.prototype');
    case 'live-artifact':
      return t('homeHero.chip.liveArtifact');
    case 'deck':
      return t('pluginsHome.facet.slides');
    case 'image':
      return t('homeHero.chip.image');
    case 'video':
      return t('homeHero.chip.video');
    case 'hyperframes':
      return t('homeHero.chip.hyperframes');
    case 'audio':
      return t('homeHero.chip.audio');
    default:
      return null;
  }
}

// Design-system plugins aren't one of the home Community facets, so
// `extractCategories` returns nothing for them. Detect them the same way
// the preview classifier does (mode / tag) so they still get a kind tag.
function isDesignSystemRecord(record: InstalledPluginRecord): boolean {
  const od = record.manifest?.od as { mode?: unknown } | undefined;
  if (typeof od?.mode === 'string' && od.mode.toLowerCase() === 'design-system') {
    return true;
  }
  return (record.manifest?.tags ?? []).some(
    (tag) => tag.toLowerCase() === 'design-system',
  );
}

export function ComposerPluginPreview({
  record,
  locale,
  workspaceContext = null,
}: {
  record: InstalledPluginRecord;
  locale: string;
  workspaceContext?: WorkspaceCollabContext | null;
}) {
  const t = useT();
  const preview = useMemo(
    () => inferPluginPreview(record, { preferBaked: true, workspaceContext }),
    [record, workspaceContext],
  );
  const title = localizePluginTitle(locale, record);
  const description = localizePluginDescription(locale, record);
  const kindLabel = useMemo(() => {
    const facet = pluginKindLabel(extractCategories(record)[0], t);
    if (facet) return facet;
    return isDesignSystemRecord(record) ? t('entry.navDesignSystems') : null;
  }, [record, t]);

  return (
    <div className="plus-menu__preview" data-plugin-id={record.id}>
      <div className="plus-menu__preview-meta">
        <div className="plus-menu__preview-title-row">
          <span className="plus-menu__preview-title" title={title}>
            {title}
          </span>
          {kindLabel ? (
            <span className="plus-menu__preview-kind">{kindLabel}</span>
          ) : null}
          <TrustBadge trust={record.trust} />
        </div>
        {description ? (
          <p className="plus-menu__preview-desc">{description}</p>
        ) : null}
      </div>
      <div className="plus-menu__preview-hero">
        {/* `eager` mounts media/iframe immediately — the panel is already a
            deliberate hover, so there is no off-screen cost to defer. */}
        {preview.kind === 'html' ? <WorkbenchPreviewShell title={title} thumbnail><WorkbenchHtmlPreview title={title} url={preview.src} thumbnail /></WorkbenchPreviewShell> : <PreviewSurface
          pluginId={record.id}
          pluginTitle={title}
          preview={preview}
          eager
        />}
      </div>
    </div>
  );
}

/** Compact instance of the same preview stack for every selectable plugin row. */
function ComposerPluginThumbnail({
  record,
  locale,
  workspaceContext = null,
}: {
  record: InstalledPluginRecord;
  locale: string;
  workspaceContext?: WorkspaceCollabContext | null;
}) {
  const preview = useMemo(
    () => inferPluginPreview(record, { preferBaked: true, workspaceContext }),
    [record, workspaceContext],
  );
  const { ref, inView } = useInView<HTMLSpanElement>({ rootMargin: '0px', once: false });
  return (
    <span ref={ref} className="plus-menu__plugin-thumb" data-plugin-id={record.id} data-testid="composer-plugin-thumbnail" aria-hidden>
      {/* Row previews release live documents as soon as they leave the list viewport. */}
      {inView && <PreviewSurface
        pluginId={record.id}
        pluginTitle={localizePluginTitle(locale, record)}
        preview={preview}
        eager
      />}
    </span>
  );
}

/** Shared selectable row for the home and project plugin pickers. */
export function ComposerPluginOption({
  record,
  locale,
  workspaceContext,
  previewed,
  onPreview,
  onPick,
}: {
  record: InstalledPluginRecord;
  locale: string;
  workspaceContext?: WorkspaceCollabContext | null;
  previewed: boolean;
  onPreview: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`plus-menu__item plus-menu__plugin-item${previewed ? ' is-previewed' : ''}`}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onPreview}
      onFocus={onPreview}
      onClick={onPick}
    >
      <ComposerPluginThumbnail record={record} locale={locale} workspaceContext={workspaceContext} />
      <span>{localizePluginTitle(locale, record)}</span>
    </button>
  );
}
