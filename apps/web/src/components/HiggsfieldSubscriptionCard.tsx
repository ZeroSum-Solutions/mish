import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, DisclosureRow, IconButton } from '@open-design/components';
import type { BadgeTone } from '@open-design/components';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

/**
 * The HiggsField subscription as one compact provider row: name, a status
 * badge and the one action that matters (Connect, or a quiet re-check once
 * connected). The explanatory copy sits in the expandable details.
 */
export function HiggsfieldSubscriptionCard() {
  const { t } = useI18n();
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/media/config');
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!alive.current) return;
      const ready = data.providers?.higgsfield?.configured === true;
      setConnected(ready); if (ready) setPending(false); setError(false);
    } catch { if (alive.current) setError(true); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    window.addEventListener('focus', refresh);
    return () => { alive.current = false; window.removeEventListener('focus', refresh); };
  }, [refresh]);
  useEffect(() => {
    if (!pending) return;
    const interval = window.setInterval(() => { void refresh(); }, 3000);
    const timeout = window.setTimeout(() => { setPending(false); setError(true); }, 180000);
    return () => { window.clearInterval(interval); window.clearTimeout(timeout); };
  }, [pending, refresh]);
  const connect = async () => {
    setPending(true); setError(false);
    try {
      const response = await fetch('/api/media/higgsfield/login', { method: 'POST' });
      if (!response.ok) throw new Error();
    } catch { if (alive.current) { setPending(false); setError(true); } }
  };

  const badge: { tone: BadgeTone; label: string } = error
    ? { tone: 'danger', label: t('settings.providerStatusError') }
    : connected
      ? { tone: 'success', label: t('settings.providerStatusConnected') }
      : pending
        ? { tone: 'info', label: t('settings.providerStatusWaiting') }
        : { tone: 'neutral', label: t('settings.providerStatusNotConnected') };
  const statusLine = error
    ? t('settings.higgsfieldError')
    : connected
      ? t('settings.higgsfieldConnected')
      : pending
        ? t('settings.higgsfieldPending')
        : t('settings.higgsfieldDisconnected');

  return (
    <DisclosureRow
      data-provider="higgsfield"
      title="HiggsField"
      description={<span role="status" title={statusLine}>{statusLine}</span>}
      leading={<Icon name="image" size={16} />}
      status={<Badge tone={badge.tone} dot={badge.tone !== 'neutral'}>{badge.label}</Badge>}
      // One action in the row: Connect while disconnected, the quiet re-check
      // once connected. Disconnected, the re-check lives in the details.
      actions={connected ? (
        <IconButton size="sm" label={t('settings.higgsfieldRefresh')} onClick={() => { void refresh(); }}>
          <Icon name="refresh" size={16} />
        </IconButton>
      ) : (
        <Button size="sm" variant="primary" onClick={() => { void connect(); }} disabled={pending}>
          {t('settings.higgsfieldConnect')}
        </Button>
      )}
      detailsLabel={t('settings.providerDetails', { name: 'HiggsField' })}
    >
      <p>{t('settings.higgsfieldHint')}</p>
      {!connected ? (
        // Wrapped so the details' column flex keeps the button at its own width.
        <div>
          <Button size="sm" variant="ghost" onClick={() => { void refresh(); }}>
            <Icon name="refresh" size={14} />
            {t('settings.higgsfieldRefresh')}
          </Button>
        </div>
      ) : null}
    </DisclosureRow>
  );
}
