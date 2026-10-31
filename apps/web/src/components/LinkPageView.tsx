// Link pages view: build a creator's link page from the places they already have online.
//
// Flow: add sources (website, Substack, Instagram, TikTok), connect Instagram / TikTok when a login
// would read more, fill the page details, Build, look at the sandboxed preview, Save edits, Export.
// Every step is also `od linkpage …` (apps/daemon/src/linkpage-cli.ts); the endpoints are in
// apps/daemon/src/routes/linkpage.ts and the contract in packages/contracts/src/api/linkpage.ts.
//
// This is not a project and not a skill: pages live in their own store, so it is an entry view
// (like Catalog) and not a New Project tab (docs/modes.md).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LINKPAGE_BACKGROUNDS,
  LINKPAGE_MAX_SOURCES,
  isLinkPageSlug,
  parseLinkPageBuildRequest,
} from '@mish/contracts';
import type {
  LinkPageBackground,
  LinkPageBuildOptions,
  LinkPageConnectorId,
  LinkPageLoginNeed,
  LinkPageSource,
  LinkPageSpec,
  LinkPageSummary,
} from '@mish/contracts';
import { Badge, Button, Chip, Input, Select, Textarea } from '@mish/components';

import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { connectConnector, fetchConnectorStatuses } from '../providers/registry';
import {
  buildLinkPage,
  exportLinkPage,
  getLinkPage,
  linkPageAssetUrl,
  linkPageRenderUrl,
  listLinkPages,
  putLinkPage,
  uploadLinkPageAsset,
} from '../state/linkpages';
import { buildZip } from '../runtime/zip';
import { listenForConnectorsChanged, notifyConnectorsChanged } from './connectors-events';
import styles from './LinkPageView.module.css';

export interface LinkPageViewProps {
  /** The view fetches nothing until it is first shown. */
  isActive?: boolean;
}

type SourceKind = Exclude<LinkPageConnectorId, 'manual'>;
const SOURCE_KINDS: SourceKind[] = ['website', 'substack', 'instagram', 'tiktok'];
const LOGIN_KINDS = ['instagram', 'tiktok'] as const;
type LoginKind = (typeof LOGIN_KINDS)[number];

const KIND_KEYS: Record<SourceKind, keyof Dict> = {
  website: 'linkPage.sources.kind.website',
  substack: 'linkPage.sources.kind.substack',
  instagram: 'linkPage.sources.kind.instagram',
  tiktok: 'linkPage.sources.kind.tiktok',
};
const BACKGROUND_KEYS: Record<LinkPageBackground, keyof Dict> = {
  glaze: 'linkPage.options.background.glaze',
  mesh: 'linkPage.options.background.mesh',
  grid: 'linkPage.options.background.grid',
  bubbles: 'linkPage.options.background.bubbles',
};
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

interface SourceRow {
  id: number;
  kind: SourceKind;
  ref: string;
}

type Busy = null | 'build' | 'save' | 'export' | 'avatar';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isWebKind = (kind: SourceKind) => kind === 'website' || kind === 'substack';

export function LinkPageView({ isActive = true }: LinkPageViewProps) {
  const t = useT();
  const nextId = useRef(2);
  const [slug, setSlug] = useState('');
  const [sources, setSources] = useState<SourceRow[]>([{ id: 1, kind: 'website', ref: '' }]);
  const [name, setName] = useState('');
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState('');
  const [paletteOn, setPaletteOn] = useState(false);
  const [palette, setPalette] = useState({ bg: '#ffffff', text: '#1a1a1a', accent: '#2255aa' });
  const [background, setBackground] = useState<LinkPageBackground | ''>('');
  // Fields the person has edited since the page was built or opened. Save sends only these (an empty one
  // clears the field); the rest keep what the page has, such as a headline the builder wrote.
  const [touched, setTouched] = useState<{ headline?: true; bio?: true; avatar?: true }>({});

  const [spec, setSpec] = useState<LinkPageSpec | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [needs, setNeeds] = useState<LinkPageLoginNeed[]>([]);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [saved, setSaved] = useState<LinkPageSummary[]>([]);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [connected, setConnected] = useState<Record<LoginKind, boolean>>({ instagram: false, tiktok: false });
  const [connecting, setConnecting] = useState<LoginKind | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const refreshConnections = useCallback(async () => {
    const statuses = await fetchConnectorStatuses();
    setConnected({
      instagram: statuses.instagram?.status === 'connected',
      tiktok: statuses.tiktok?.status === 'connected',
    });
  }, []);

  const refreshSaved = useCallback(async () => {
    try {
      setSaved(await listLinkPages());
    } catch {
      setError(t('linkPage.load.failed'));
    }
  }, [t]);

  useEffect(() => {
    if (!isActive || loadedOnce) return;
    setLoadedOnce(true);
    void refreshSaved();
    void refreshConnections();
  }, [isActive, loadedOnce, refreshSaved, refreshConnections]);

  useEffect(() => listenForConnectorsChanged(() => { void refreshConnections(); }), [refreshConnections]);

  const slugOk = isLinkPageSlug(slug);

  const sourceError = (row: SourceRow): string | null => {
    if (!row.ref.trim()) return null;
    if (isWebKind(row.kind)) {
      try {
        const url = new URL(row.ref.trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? null : t('linkPage.sources.invalidWeb');
      } catch {
        return t('linkPage.sources.invalidWeb');
      }
    }
    return /^@?[\w.]{1,64}$/.test(row.ref.trim()) ? null : t('linkPage.sources.invalidHandle');
  };

  const buildOptions = useMemo((): LinkPageBuildOptions => {
    const options: LinkPageBuildOptions = {};
    if (name.trim()) options.name = name.trim();
    if (headline.trim()) options.headline = headline.trim();
    if (bio.trim()) options.bio = bio.trim();
    if (avatar) options.avatar = avatar;
    if (paletteOn || background) {
      options.theme = {
        ...(paletteOn ? { palette } : {}),
        ...(background ? { background } : {}),
      };
    }
    return options;
  }, [name, headline, bio, avatar, paletteOn, palette, background]);

  const onBuild = async () => {
    setError(null);
    setNotice(null);
    const filled: LinkPageSource[] = sources
      .filter((row) => row.ref.trim())
      .map((row) => ({ connector: row.kind, ref: row.ref.trim() }));
    if (filled.length === 0) return setError(t('linkPage.sources.required'));
    if (!slugOk) return setError(t('linkPage.slug.invalid'));
    if (sources.some((row) => sourceError(row))) return;
    // Same validator the daemon and the CLI use, so a bad form reads the same everywhere.
    const request = parseLinkPageBuildRequest({ slug, sources: filled, options: buildOptions });
    if (!request.ok) return setError(t('linkPage.build.failed', { message: request.error }));
    setBusy('build');
    try {
      // The daemon uses the Instagram / TikTok login already connected in Mish; no id travels here.
      const result = await buildLinkPage(request.value);
      setSpec(result.spec);
      setTouched({});
      setWarnings(result.warnings);
      setNeeds(result.needs);
      setVersion((v) => v + 1);
      void refreshSaved();
    } catch (cause) {
      setError(t('linkPage.build.failed', { message: messageOf(cause) }));
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    if (!spec) return;
    setError(null);
    setNotice(null);
    setBusy('save');
    try {
      // Text, picture and background edits apply without rebuilding; colours need a Build.
      const next: LinkPageSpec = {
        ...spec,
        profile: {
          ...spec.profile,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(touched.headline ? { headline: headline.trim() } : {}),
          ...(touched.bio ? { bio: bio.trim() } : {}),
          ...(touched.avatar ? { avatar_url: avatar } : {}),
        },
        theme: { ...spec.theme, ...(background ? { background } : {}) },
      };
      const record = await putLinkPage(spec.slug, { spec: next });
      setSpec(record.spec);
      setTouched({});
      setVersion((v) => v + 1);
      setNotice(t('linkPage.save.done'));
      void refreshSaved();
    } catch (cause) {
      setError(t('linkPage.save.failed', { message: messageOf(cause) }));
    } finally {
      setBusy(null);
    }
  };

  const onExport = async () => {
    if (!spec) return;
    setError(null);
    setNotice(null);
    setBusy('export');
    try {
      const exported = await exportLinkPage(spec.slug);
      const zip = buildZip(
        exported.files.map((file) => ({
          path: file.path,
          content: file.encoding === 'base64'
            ? Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0))
            : file.content,
        })),
      );
      const url = URL.createObjectURL(zip);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${spec.slug}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (cause) {
      setError(t('linkPage.export.failed', { message: messageOf(cause) }));
    } finally {
      setBusy(null);
    }
  };

  const onAvatar = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    // The picture belongs to the saved page, whose address is spec.slug; the address field may say anything.
    if (!spec) return setError(t('linkPage.options.avatarNeedsPage'));
    const ext = IMAGE_EXTENSIONS[file.type];
    if (!ext) return setError(t('linkPage.options.avatarFailed', { message: t('linkPage.options.avatarHint') }));
    setBusy('avatar');
    try {
      const asset = await uploadLinkPageAsset(spec.slug, `avatar.${ext}`, file);
      setAvatar(asset.path);
      setTouched((x) => ({ ...x, avatar: true }));
      setVersion((v) => v + 1);
    } catch (cause) {
      setError(t('linkPage.options.avatarFailed', { message: messageOf(cause) }));
    } finally {
      setBusy(null);
    }
  };

  const onOpen = async (openSlug: string) => {
    setError(null);
    setNotice(null);
    try {
      const record = await getLinkPage(openSlug);
      setSlug(record.slug);
      setSpec(record.spec);
      setWarnings(record.warnings);
      setNeeds([]);
      setTouched({});
      setName(record.spec.profile.name);
      setHeadline(record.spec.profile.headline);
      setBio(record.spec.profile.bio);
      setAvatar(/^assets\//.test(record.spec.profile.avatar_url) ? record.spec.profile.avatar_url : '');
      setBackground((LINKPAGE_BACKGROUNDS as readonly string[]).includes(record.spec.theme.background) ? (record.spec.theme.background as LinkPageBackground) : '');
      setVersion((v) => v + 1);
    } catch (cause) {
      setError(t('linkPage.load.failed') + ' ' + messageOf(cause));
    }
  };

  const onNew = () => {
    setSlug('');
    setSources([{ id: nextId.current++, kind: 'website', ref: '' }]);
    setName('');
    setHeadline('');
    setBio('');
    setAvatar('');
    setPaletteOn(false);
    setBackground('');
    setSpec(null);
    setTouched({});
    setWarnings([]);
    setNeeds([]);
    setError(null);
    setNotice(null);
  };

  const onConnect = async (kind: LoginKind) => {
    setConnectError(null);
    setConnecting(kind);
    try {
      const result = await connectConnector(kind);
      if (result.error) setConnectError(t('linkPage.connect.failed', { message: result.error }));
      notifyConnectorsChanged();
      await refreshConnections();
    } catch (cause) {
      setConnectError(t('linkPage.connect.failed', { message: messageOf(cause) }));
    } finally {
      setConnecting(null);
    }
  };

  const updateSource = (id: number, patch: Partial<SourceRow>) =>
    setSources((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const working = busy !== null;

  return (
    <section className={styles.root} data-testid="link-page-view" aria-labelledby="link-page-title">
      <header>
        <h1 id="link-page-title" className={styles.title}>{t('linkPage.title')}</h1>
        <p className={styles.description}>{t('linkPage.description')}</p>
      </header>

      <div className={styles.layout}>
        <div className={styles.form}>
          <div className={styles.section} aria-labelledby="link-page-saved">
            <h2 id="link-page-saved" className={styles.sectionTitle}>{t('linkPage.saved.heading')}</h2>
            <div className={styles.saved}>
              {saved.length === 0 ? <p className={styles.hint}>{t('linkPage.saved.empty')}</p> : null}
              {saved.map((page) => (
                <Chip key={page.slug} selected={spec?.slug === page.slug} aria-label={t('linkPage.saved.open', { slug: page.slug })} onClick={() => { void onOpen(page.slug); }}>
                  {page.name || page.slug}
                </Chip>
              ))}
              <Button size="sm" variant="ghost" onClick={onNew}>{t('linkPage.saved.new')}</Button>
            </div>
          </div>

          <div className={styles.section} aria-labelledby="link-page-sources">
            <h2 id="link-page-sources" className={styles.sectionTitle}>{t('linkPage.sources.heading')}</h2>
            <p className={styles.hint}>{t('linkPage.sources.hint')}</p>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="link-page-slug">{t('linkPage.slug.label')}</label>
              <Input id="link-page-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="sam" maxLength={60} aria-invalid={slug !== '' && !slugOk} />
              <p className={slug !== '' && !slugOk ? styles.error : styles.hint}>{slug !== '' && !slugOk ? t('linkPage.slug.invalid') : t('linkPage.slug.hint')}</p>
            </div>
            {sources.map((row) => {
              const problem = sourceError(row);
              return (
                <div key={row.id} className={styles.field}>
                  <div className={styles.row}>
                    <Select className={styles.kindSelect} aria-label={t('linkPage.sources.heading')} value={row.kind} onChange={(e) => updateSource(row.id, { kind: e.target.value as SourceKind })}>
                      {SOURCE_KINDS.map((kind) => <option key={kind} value={kind}>{t(KIND_KEYS[kind])}</option>)}
                    </Select>
                    <Input
                      className={styles.rowGrow}
                      aria-label={`${t(KIND_KEYS[row.kind])}: ${t('linkPage.sources.refLabel')}`}
                      aria-invalid={problem !== null}
                      value={row.ref}
                      placeholder={isWebKind(row.kind) ? t('linkPage.sources.placeholder.web') : t('linkPage.sources.placeholder.handle')}
                      onChange={(e) => updateSource(row.id, { ref: e.target.value })}
                    />
                    {sources.length > 1 ? (
                      <Button size="sm" variant="ghost" aria-label={t('linkPage.sources.remove', { kind: t(KIND_KEYS[row.kind]) })} onClick={() => setSources((rows) => rows.filter((r) => r.id !== row.id))}>×</Button>
                    ) : null}
                  </div>
                  {problem ? <p className={styles.error}>{problem}</p> : null}
                </div>
              );
            })}
            <div className={styles.actions}>
              <Button
                size="sm"
                disabled={sources.length >= LINKPAGE_MAX_SOURCES}
                onClick={() => setSources((rows) => [...rows, { id: nextId.current++, kind: 'website', ref: '' }])}
              >
                {t('linkPage.sources.add')}
              </Button>
              {sources.length >= LINKPAGE_MAX_SOURCES ? <p className={styles.hint}>{t('linkPage.sources.tooMany', { max: LINKPAGE_MAX_SOURCES })}</p> : null}
            </div>
          </div>

          <div className={styles.section} aria-labelledby="link-page-connect" data-testid="link-page-connect">
            <h2 id="link-page-connect" className={styles.sectionTitle}>{t('linkPage.connect.heading')}</h2>
            <p className={styles.hint}>{t('linkPage.connect.explain')}</p>
            {LOGIN_KINDS.map((kind) => (
              <div key={kind} className={styles.account}>
                <span className={styles.accountName}>
                  {t(KIND_KEYS[kind])}
                  <Badge tone={connected[kind] ? 'success' : 'neutral'} dot>{connected[kind] ? t('linkPage.connect.connected') : t('linkPage.connect.notConnected')}</Badge>
                </span>
                {connected[kind] ? null : (
                  <Button size="sm" loading={connecting === kind} disabled={connecting !== null} onClick={() => { void onConnect(kind); }}>
                    {t('linkPage.connect.button', { platform: t(KIND_KEYS[kind]) })}
                  </Button>
                )}
              </div>
            ))}
            <div className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={() => { void refreshConnections(); }}>{t('linkPage.connect.refresh')}</Button>
              <p className={styles.hint}>{t('linkPage.connect.optional')}</p>
            </div>
            {connectError ? <p className={styles.error} role="alert">{connectError}</p> : null}
          </div>

          <div className={styles.section} aria-labelledby="link-page-options">
            <h2 id="link-page-options" className={styles.sectionTitle}>{t('linkPage.options.heading')}</h2>
            <p className={styles.hint}>{t('linkPage.options.autoHint')}</p>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="link-page-name">{t('linkPage.options.name')}</label>
              <Input id="link-page-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="link-page-headline">{t('linkPage.options.headline')}</label>
              <Input id="link-page-headline" value={headline} maxLength={90} onChange={(e) => { setHeadline(e.target.value); setTouched((x) => ({ ...x, headline: true })); }} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="link-page-bio">{t('linkPage.options.bio')}</label>
              <Textarea id="link-page-bio" value={bio} rows={3} maxLength={400} onChange={(e) => { setBio(e.target.value); setTouched((x) => ({ ...x, bio: true })); }} />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="link-page-avatar">{t('linkPage.options.avatar')}</label>
              <div className={styles.avatarRow}>
                {avatar && spec ? <img className={styles.avatar} src={linkPageAssetUrl(spec.slug, avatar, version)} alt="" /> : null}
                <input id="link-page-avatar" className={styles.fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy === 'avatar' || !spec} onChange={(e) => { void onAvatar(e.target.files?.[0]); e.target.value = ''; }} />
                {avatar ? <Button size="sm" variant="ghost" onClick={() => { setAvatar(''); setTouched((x) => ({ ...x, avatar: true })); }}>{t('linkPage.options.avatarRemove')}</Button> : null}
              </div>
              <p className={styles.hint}>{busy === 'avatar' ? t('linkPage.options.avatarUploading') : spec ? t('linkPage.options.avatarHint') : t('linkPage.options.avatarNeedsPage')}</p>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>{t('linkPage.options.palette')}</span>
              <Chip selected={paletteOn} onClick={() => setPaletteOn((on) => !on)}>{t('linkPage.options.paletteOverride')}</Chip>
              {paletteOn ? (
                <div className={styles.colours}>
                  {(['bg', 'text', 'accent'] as const).map((key) => (
                    <label key={key} className={styles.field}>
                      <span className={styles.hint}>{t(key === 'bg' ? 'linkPage.options.paletteBg' : key === 'text' ? 'linkPage.options.paletteText' : 'linkPage.options.paletteAccent')}</span>
                      <input className={styles.colourInput} type="color" value={palette[key]} onChange={(e) => setPalette((p) => ({ ...p, [key]: e.target.value }))} />
                    </label>
                  ))}
                </div>
              ) : null}
              <p className={styles.hint}>{t('linkPage.options.paletteHint')}</p>
            </div>
            <div className={styles.field} role="group" aria-label={t('linkPage.options.background')}>
              <span className={styles.label}>{t('linkPage.options.background')}</span>
              <div className={styles.chips}>
                <Chip selected={background === ''} onClick={() => setBackground('')}>{t('linkPage.options.background.auto')}</Chip>
                {LINKPAGE_BACKGROUNDS.map((effect) => (
                  <Chip key={effect} selected={background === effect} onClick={() => setBackground(effect)}>{t(BACKGROUND_KEYS[effect])}</Chip>
                ))}
              </div>
            </div>
          </div>

          <div className={styles.actions}>
            <Button variant="primary" loading={busy === 'build'} disabled={working} onClick={() => { void onBuild(); }}>
              {busy === 'build' ? t('linkPage.building') : t('linkPage.build')}
            </Button>
            <Button disabled={!spec || working} loading={busy === 'save'} onClick={() => { void onSave(); }}>
              {busy === 'save' ? t('linkPage.saving') : t('linkPage.save')}
            </Button>
            <Button disabled={!spec || working} loading={busy === 'export'} onClick={() => { void onExport(); }}>
              {busy === 'export' ? t('linkPage.exporting') : t('linkPage.export')}
            </Button>
          </div>
          <p className={styles.hint}>{t('linkPage.export.hint')}</p>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {notice ? <p className={styles.status} role="status">{notice}</p> : null}

          {warnings.length > 0 ? (
            <div className={styles.section} data-testid="link-page-warnings">
              <h2 className={styles.sectionTitle}>{t('linkPage.warnings.heading')}</h2>
              <ul className={styles.list}>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>
          ) : null}
          {needs.length > 0 ? (
            <div className={styles.section} data-testid="link-page-needs">
              <h2 className={styles.sectionTitle}>{t('linkPage.needs.heading')}</h2>
              <ul className={styles.list}>{needs.map((need) => <li key={need.platform}>{t('linkPage.needs.item', { platform: need.platform, why: need.why })}</li>)}</ul>
            </div>
          ) : null}
        </div>

        <aside className={styles.previewColumn} aria-label={t('linkPage.preview.heading')}>
          <h2 className={styles.sectionTitle}>{t('linkPage.preview.heading')}</h2>
          {spec ? (
            <>
              {/* No allow-same-origin: the page runs in an opaque origin and cannot reach the app. */}
              <iframe
                className={styles.frame}
                data-testid="link-page-preview"
                title={t('linkPage.preview.title', { name: spec.profile.name })}
                sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
                src={linkPageRenderUrl(spec.slug, version)}
              />
              <p className={styles.hint}>{t('linkPage.preview.note')}</p>
            </>
          ) : (
            <p className={styles.hint}>{t('linkPage.preview.empty')}</p>
          )}
        </aside>
      </div>
    </section>
  );
}
