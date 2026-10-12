// Remix into project: the three copy buttons on every Blocks and Components card.
//
// "Copy install command" and "Copy code" read GET /api/cult/copy/:id — the daemon's loopback-only
// view of the licensed source (the install URL, and the item's main file with its imports on the
// default aliases, as `od cult show <slug>` prints it); "Copy CLI" needs no request. `od cult add`
// and `npx shadcn@latest add` read the same item from GET /api/cult/r/<slug>.json. What is copied
// names the item by its public slug (`pricing-series-v`), and the code's file names and export
// names are brand-free. The rest of the source text stays as the kit ships it, so copied code can
// still name another company in its markup, sample data or local names, and npm package names
// stay exact. One polite status line says
// what was copied, or that the source is not available here.

import { useRef, useState } from 'react';
import { Button } from '@mish/components';
import { parseCultCopyResponse, type CultCatalogItem, type CultCopyInfo } from '@mish/contracts';

import { useT } from '../i18n';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import styles from './CatalogView.module.css';

type CopyKind = 'install' | 'code' | 'cli';
type CopyStatus = { kind: 'idle' } | { kind: 'done'; what: CopyKind } | { kind: 'failed' };

/** The `od` line for one item's public slug, run from inside the target project. */
export function cultCliCommand(slug: string): string {
  return `od cult add ${slug} --into .`;
}

/** The `npx` line for one served registry URL. */
export function cultInstallCommand(registryUrl: string): string {
  return `npx shadcn@latest add ${registryUrl}`;
}

async function fetchCopyInfo(id: string): Promise<CultCopyInfo> {
  const resp = await fetch(`/api/cult/copy/${encodeURIComponent(id)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return parseCultCopyResponse(await resp.json()).copy;
}

export function CultCopyActions({ item }: { item: CultCatalogItem }) {
  const t = useT();
  const [status, setStatus] = useState<CopyStatus>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const info = useRef<CultCopyInfo | null>(null);

  const copy = async (what: CopyKind) => {
    setBusy(true);
    try {
      let text: string;
      if (what === 'cli') text = cultCliCommand(item.slug);
      else {
        info.current ??= await fetchCopyInfo(item.id);
        text = what === 'install' ? cultInstallCommand(info.current.registryUrl) : info.current.mainFile.content;
      }
      setStatus((await copyToClipboard(text)) ? { kind: 'done', what } : { kind: 'failed' });
    } catch {
      setStatus({ kind: 'failed' });
    } finally {
      setBusy(false);
    }
  };

  const testId = (suffix: string) => `catalog-cult-copy-${suffix}-${item.id}`;
  return (
    <div className={styles.copyActions}>
      <div className={styles.copyButtons} role="group" aria-label={t('catalog.cult.copy.group', { title: item.displayTitle })}>
        <Button variant="primary" className={styles.copyButton} disabled={busy} data-testid={testId('code')} onClick={() => void copy('code')}>
          {t('catalog.cult.copy.code')}
        </Button>
        <Button variant="secondary" className={styles.copyButton} disabled={busy} data-testid={testId('install')} onClick={() => void copy('install')}>
          {t('catalog.cult.copy.install')}
        </Button>
        <Button variant="secondary" className={styles.copyButton} disabled={busy} data-testid={testId('cli')} onClick={() => void copy('cli')}>
          {t('catalog.cult.copy.cli')}
        </Button>
      </div>
      <p className={styles.detail} role="status" aria-live="polite" data-testid={testId('status')}>
        {status.kind === 'done' ? t(`catalog.cult.copy.done.${status.what}`) : null}
        {status.kind === 'failed' ? t('catalog.cult.copy.failed') : null}
      </p>
    </div>
  );
}
