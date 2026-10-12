// Installed or generated design kits land as drafts, and generation skips a
// draft. Every surface that offers kits for a project shows drafts through
// this list, with a Publish action, instead of hiding them: a hidden draft is
// how a teammate ended up generating off-brand with no error (Track B P0).
import { Badge, Button } from '@open-design/components';
import { useState } from 'react';
import type { DesignSystemSummary } from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './DraftDesignKitList.module.css';

export type PublishDesignSystemDraft = (system: DesignSystemSummary) => Promise<boolean>;

interface Props {
  drafts: DesignSystemSummary[];
  onPublish: PublishDesignSystemDraft;
  /** Called after a kit published successfully (e.g. to select it). */
  onPublished?: (system: DesignSystemSummary) => void;
  /** Hide the group heading when the host already labels the section. */
  showHeading?: boolean;
}

export function DraftDesignKitList({ drafts, onPublish, onPublished, showHeading = true }: Props) {
  const t = useT();
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  if (drafts.length === 0) return null;

  async function publish(system: DesignSystemSummary) {
    if (publishingId) return;
    setPublishingId(system.id);
    setFailedId(null);
    let ok = false;
    try {
      ok = await onPublish(system);
    } catch {
      ok = false;
    }
    setPublishingId(null);
    if (!ok) {
      setFailedId(system.id);
      return;
    }
    onPublished?.(system);
  }

  return (
    <div className={styles.group} data-testid="draft-design-kit-list">
      {showHeading ? (
        <div className={styles.heading} role="presentation">
          {t('designSystemPicker.draftGroup')}
        </div>
      ) : null}
      {drafts.map((system) => (
        <div
          key={system.id}
          className={styles.row}
          data-testid={`project-ds-picker-draft-${system.id}`}
        >
          <div className={styles.copy}>
            <span className={styles.title}>
              {system.title}
              <Badge tone="warning">{t('designSystemPicker.draftBadge')}</Badge>
            </span>
            <span className={styles.hint} role={failedId === system.id ? 'alert' : undefined}>
              {failedId === system.id
                ? t('designSystemPicker.publishFailed')
                : t('designSystemPicker.draftHint')}
            </span>
          </div>
          <Button
            variant="secondary"
            size="sm"
            loading={publishingId === system.id}
            disabled={publishingId !== null && publishingId !== system.id}
            data-testid={`project-ds-picker-publish-${system.id}`}
            aria-label={t('designSystemPicker.publishAria', { title: system.title })}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void publish(system)}
          >
            {t('designSystemPicker.publish')}
          </Button>
        </div>
      ))}
    </div>
  );
}
