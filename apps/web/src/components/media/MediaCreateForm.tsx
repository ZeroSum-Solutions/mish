import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Button, Chip, Select, Textarea } from '@mish/components';
import type { ProjectFile, WorkspaceCollabContext } from '@mish/contracts';
import { useT } from '../../i18n';
import { mediaApi, MediaRequestError, type MediaCatalog, type MediaCatalogModel, type MediaCreateRequest } from './media-api';
import styles from './MediaWorkbench.module.css';

type CreateKind = MediaCreateRequest['surface'];
const KINDS: CreateKind[] = ['image', 'video'];
/** The capability a model must list to take a reference image, per kind. */
const REFERENCE_CAP: Record<CreateKind, string> = { image: 'i2i', video: 'i2v' };

export interface MediaCreateFormProps {
  projectId: string;
  files: readonly ProjectFile[];
  catalog: MediaCatalog | null;
  catalogError: string | null;
  workspaceContext?: WorkspaceCollabContext | null;
  onCreated: (taskId: string) => void;
}

function modelsFor(catalog: MediaCatalog | null, kind: CreateKind): MediaCatalogModel[] {
  return catalog ? catalog[kind] : [];
}

/**
 * AC-R10.1 creation form. Everything it offers comes from the daemon's model
 * catalogue: providers that have models for the chosen kind, those
 * providers' models, the catalogue's aspects and video lengths, and a
 * reference input only when the model lists the reference capability. It
 * posts to the same generate route `od media generate` uses.
 */
export function MediaCreateForm({ projectId, files, catalog, catalogError, workspaceContext, onCreated }: MediaCreateFormProps) {
  const t = useT();
  const id = useId();
  const [kind, setKind] = useState<CreateKind>('image');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState('');
  const [length, setLength] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kindModels = useMemo(() => modelsFor(catalog, kind), [catalog, kind]);
  const providers = useMemo(() => {
    const ids = new Set(kindModels.map((candidate) => candidate.provider));
    return (catalog?.providers ?? []).filter((candidate) => ids.has(candidate.id));
  }, [catalog, kindModels]);
  const providerModels = useMemo(
    () => kindModels.filter((candidate) => candidate.provider === provider),
    [kindModels, provider],
  );
  const selectedModel = providerModels.find((candidate) => candidate.id === model) ?? null;
  const selectedProvider = providers.find((candidate) => candidate.id === provider) ?? null;
  const acceptsReference = Boolean(selectedModel?.caps?.includes(REFERENCE_CAP[kind]));
  const referenceFiles = useMemo(
    () => files.filter((file) => file.type !== 'dir' && (file.kind === 'image' || file.mime?.startsWith('image/'))),
    [files],
  );

  // Keep provider and model valid for the chosen kind: prefer the
  // catalogue's default model, else the first one listed.
  useEffect(() => {
    if (kindModels.length === 0) {
      setProvider('');
      setModel('');
      return;
    }
    if (!providers.some((candidate) => candidate.id === provider)) {
      const preferred = kindModels.find((candidate) => candidate.default) ?? kindModels[0]!;
      setProvider(preferred.provider);
    }
  }, [kindModels, providers, provider]);
  useEffect(() => {
    if (providerModels.length === 0) return;
    if (!providerModels.some((candidate) => candidate.id === model)) {
      setModel((providerModels.find((candidate) => candidate.default) ?? providerModels[0]!).id);
    }
  }, [providerModels, model]);
  useEffect(() => {
    if (!acceptsReference) setReference('');
  }, [acceptsReference]);

  const aspects = catalog?.aspects ?? [];
  const lengths = catalog?.videoLengthsSec ?? [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !selectedModel) return;
    const text = prompt.trim();
    if (!text) {
      setError(t('mediaWorkbench.create.promptRequired'));
      return;
    }
    const request: MediaCreateRequest = {
      surface: kind,
      model: selectedModel.id,
      prompt: text,
      ...(aspect ? { aspect } : {}),
      ...(kind === 'video' && length ? { length: Number(length) } : {}),
      ...(acceptsReference && reference ? { image: reference } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const accepted = await mediaApi.create(projectId, request, workspaceContext);
      setPrompt('');
      onCreated(accepted.taskId);
    } catch (err) {
      const message = err instanceof MediaRequestError || err instanceof Error ? err.message : String(err);
      setError(t('mediaWorkbench.action.failed', { message }));
    } finally {
      setBusy(false);
    }
  }

  const titleId = `${id}-create`;
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.sectionTitle}>{t('mediaWorkbench.create.heading')}</h3>
      <form className={styles.form} aria-labelledby={titleId} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.segmented}>
          <legend>{t('mediaWorkbench.create.kind')}</legend>
          {KINDS.map((candidate) => (
            <Chip key={candidate} size="sm" selected={kind === candidate} onClick={() => setKind(candidate)}>
              {t(candidate === 'image' ? 'mediaWorkbench.kind.image' : 'mediaWorkbench.kind.video')}
            </Chip>
          ))}
        </fieldset>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          {t('mediaWorkbench.create.prompt')}
          <Textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <div className={styles.fieldRow}>
          <label className={styles.field}>
            {t('mediaWorkbench.create.provider')}
            <Select value={provider} disabled={providers.length === 0} onChange={(event) => { setProvider(event.target.value); setModel(''); }}>
              {providers.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.integrated
                    ? candidate.label
                    : t('mediaWorkbench.create.placeholderProvider', { label: candidate.label })}
                </option>
              ))}
            </Select>
          </label>
          <label className={styles.field}>
            {t('mediaWorkbench.create.model')}
            <Select value={model} disabled={providerModels.length === 0} onChange={(event) => setModel(event.target.value)}>
              {providerModels.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
              ))}
            </Select>
          </label>
        </div>
        <div className={styles.fieldRow}>
          {aspects.length > 0 ? (
            <label className={styles.field}>
              {t('mediaWorkbench.create.aspect')}
              <Select value={aspect} onChange={(event) => setAspect(event.target.value)}>
                <option value="">{t('mediaWorkbench.filter.any')}</option>
                {aspects.map((value) => <option key={value} value={value}>{value}</option>)}
              </Select>
            </label>
          ) : null}
          {kind === 'video' && lengths.length > 0 ? (
            <label className={styles.field}>
              {t('mediaWorkbench.create.length')}
              <Select value={length} onChange={(event) => setLength(event.target.value)}>
                <option value="">{t('mediaWorkbench.filter.any')}</option>
                {lengths.map((value) => <option key={value} value={String(value)}>{value}</option>)}
              </Select>
            </label>
          ) : null}
          {acceptsReference ? (
            <label className={styles.field}>
              {t('mediaWorkbench.create.reference')}
              <Select value={reference} onChange={(event) => setReference(event.target.value)}>
                <option value="">{t('mediaWorkbench.create.referenceNone')}</option>
                {referenceFiles.map((file) => <option key={file.name} value={file.name}>{file.name}</option>)}
              </Select>
            </label>
          ) : null}
        </div>
        {selectedProvider && !selectedProvider.integrated ? (
          <p className={styles.hint}>{t('mediaWorkbench.create.placeholderNotice')}</p>
        ) : null}
        {catalog && kindModels.length === 0 ? <p className={styles.hint}>{t('mediaWorkbench.create.noModels')}</p> : null}
        {catalogError ? <p className={styles.error} role="alert">{t('mediaWorkbench.create.catalogFailed')}</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.formFooter}>
          <Button type="submit" variant="primary" loading={busy} disabled={!selectedModel}>
            {t('mediaWorkbench.create.submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}
