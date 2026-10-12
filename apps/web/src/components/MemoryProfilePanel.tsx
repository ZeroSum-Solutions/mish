// Structured editor for the singleton user profile (id `user_profile`, type
// `profile`). The profile is the PRE-loop foundation: the daemon injects it
// into every task brief, so a few labelled fields here become the default
// context the agent infers intent from.
//
// Persistence:
//   - GET  /api/memory/user_profile  → { entry: { body } } (404 → empty form)
//   - PUT  /api/memory/user_profile  → body assembled as `- <Label>: <value>`
//     lines; the daemon renders that as a key/value block in the prompt.
import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Input, Select, Textarea } from '@open-design/components';
import { PROFILE_MEMORY_ID } from '@open-design/contracts';
import type { MemoryEntry } from '@open-design/contracts';
import { Icon } from './Icon';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { en } from '../i18n/locales/en';

import styles from './MemoryProfilePanel.module.css';

// Ordered profile fields. Each `label` is the human key written to the body
// (`- <label>: <value>`); the `labelKey` is its localized caption. The labels
// are stable English strings so the body the daemon stores stays parseable
// regardless of the UI locale. `kind` picks the control: free text, a longer
// note, one choice from a list, or several choices from a list. Choice values
// are stored as the option's ENGLISH words (its leading emoji dropped): a
// locale-independent id that still reads as plain prose to the agent. The UI
// translates them only at render, and legacy values saved in another locale
// map back to their option when the body is read.
type ProfileFieldKind = 'text' | 'note' | 'select' | 'multi';
type ProfileSection = 'about' | 'work' | 'defaults';

const ORG_SIZE_OPTIONS: ReadonlyArray<keyof Dict> = [
  'settings.onboardingOrgSolo',
  'settings.onboardingOrgTeam',
  'settings.onboardingOrgStartup',
  'settings.onboardingOrgGrowth',
  'settings.onboardingOrgMidMarket',
  'settings.onboardingOrgEnterprise',
];
const USE_CASE_OPTIONS: ReadonlyArray<keyof Dict> = [
  'settings.onboardingUseProduct',
  'settings.onboardingUseDesignSystem',
  'settings.onboardingUsePrototype',
  'settings.onboardingUseLanding',
  'settings.onboardingUseAds',
  'settings.onboardingUseDashboard',
  'settings.onboardingUseDeck',
  'settings.onboardingUseMarketing',
  'settings.onboardingUseEngineering',
  'settings.onboardingUseAgency',
];
const SOURCE_OPTIONS: ReadonlyArray<keyof Dict> = [
  'settings.onboardingSourceX',
  'settings.onboardingSourceGithub',
  'settings.onboardingSourceYoutube',
  'settings.onboardingSourceTiktok',
  'settings.onboardingSourceReddit',
  'settings.onboardingSourceLinkedin',
  'settings.onboardingSourceMetaSocial',
  'settings.onboardingSourceSearch',
  'settings.onboardingSourceAiTool',
  'settings.onboardingSourceFriend',
  'settings.onboardingSourceCommunity',
  'settings.onboardingSourceEmail',
  'settings.onboardingSourceBlog',
  'settings.onboardingSourceOther',
];

const PROFILE_FIELDS: ReadonlyArray<{
  label: string;
  labelKey: keyof Dict;
  placeholderKey: keyof Dict;
  kind: ProfileFieldKind;
  section: ProfileSection;
  options?: ReadonlyArray<keyof Dict>;
}> = [
  { label: 'Role', labelKey: 'settings.memoryProfileRole', placeholderKey: 'settings.memoryProfileRolePlaceholder', kind: 'text', section: 'about' },
  { label: 'Organization size', labelKey: 'settings.onboardingOrgSizeLabel', placeholderKey: 'settings.onboardingSelectPlaceholder', kind: 'select', section: 'about', options: ORG_SIZE_OPTIONS },
  { label: 'Use cases', labelKey: 'settings.onboardingUseCaseLabel', placeholderKey: 'settings.onboardingSelectMultiplePlaceholder', kind: 'multi', section: 'work', options: USE_CASE_OPTIONS },
  { label: 'Discovery source', labelKey: 'settings.onboardingSourceLabel', placeholderKey: 'settings.onboardingSelectPlaceholder', kind: 'select', section: 'about', options: SOURCE_OPTIONS },
  { label: 'Company / Team', labelKey: 'settings.memoryProfileCompany', placeholderKey: 'settings.memoryProfileCompanyPlaceholder', kind: 'text', section: 'work' },
  { label: 'Domain', labelKey: 'settings.memoryProfileDomain', placeholderKey: 'settings.memoryProfileDomainPlaceholder', kind: 'text', section: 'work' },
  { label: 'Primary audience', labelKey: 'settings.memoryProfileAudience', placeholderKey: 'settings.memoryProfileAudiencePlaceholder', kind: 'text', section: 'work' },
  { label: 'Aesthetic / taste', labelKey: 'settings.memoryProfileAesthetic', placeholderKey: 'settings.memoryProfileAestheticPlaceholder', kind: 'note', section: 'defaults' },
  { label: 'Default deliverables', labelKey: 'settings.memoryProfileDeliverables', placeholderKey: 'settings.memoryProfileDeliverablesPlaceholder', kind: 'text', section: 'defaults' },
  { label: 'Locale / Language', labelKey: 'settings.memoryProfileLocale', placeholderKey: 'settings.memoryProfileLocalePlaceholder', kind: 'text', section: 'defaults' },
  { label: 'Current goals', labelKey: 'settings.memoryProfileGoals', placeholderKey: 'settings.memoryProfileGoalsPlaceholder', kind: 'note', section: 'defaults' },
];

const SECTIONS: ReadonlyArray<{ id: ProfileSection; titleKey: keyof Dict; order: readonly string[] }> = [
  { id: 'about', titleKey: 'settings.memoryProfileSectionAbout', order: ['Role', 'Organization size', 'Discovery source'] },
  { id: 'work', titleKey: 'settings.memoryProfileSectionWork', order: ['Company / Team', 'Domain', 'Primary audience', 'Use cases'] },
  { id: 'defaults', titleKey: 'settings.memoryProfileSectionDefaults', order: ['Default deliverables', 'Locale / Language', 'Aesthetic / taste', 'Current goals'] },
];

/** An option's words without its decorative leading emoji ("🎨 Designer" → "Designer"). */
export function profileOptionValue(label: string): string {
  return label.replace(/^[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\s]+/u, '').trim();
}

/** Splits a stored multi-choice value ("Landing pages, Design system") into its items. */
export function splitProfileList(value: string): string[] {
  return value.split(/\s*[,;]\s*/).map((item) => item.trim()).filter(Boolean);
}

const OPTION_LOCALE_DICTS: ReadonlyArray<Dict> = [en];

/** The stored (locale-independent) value of a choice option. */
function storedOptionValue(key: keyof Dict): string {
  return profileOptionValue(en[key]);
}

/** Maps a stored choice — English option label — to
 *  its stored value; legacy or custom values that match no option stay as written. */
function canonicalChoice(options: ReadonlyArray<keyof Dict>, raw: string): string {
  const needle = raw.trim().toLocaleLowerCase();
  for (const key of options) {
    for (const dict of OPTION_LOCALE_DICTS) {
      if (profileOptionValue(dict[key]).toLocaleLowerCase() === needle) return storedOptionValue(key);
    }
  }
  return raw.trim();
}

function canonicalFieldValue(field: (typeof PROFILE_FIELDS)[number], value: string): string {
  if (!field.options) return value;
  if (field.kind === 'select') return canonicalChoice(field.options, value);
  if (field.kind === 'multi') {
    const items = splitProfileList(value).map((item) => canonicalChoice(field.options!, item));
    return Array.from(new Set(items)).join(', ');
  }
  return value;
}

// Parse a stored profile body back into the structured fields. The body is a
// set of `- <Label>: <value>` lines; we match each known label case-
// insensitively so a hand-edited file still hydrates the form.
function parseProfileBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*-\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const rawLabel = (m[1] ?? '').trim().toLowerCase();
    const value = (m[2] ?? '').trim();
    const field = PROFILE_FIELDS.find((f) => f.label.toLowerCase() === rawLabel);
    if (field) out[field.label] = canonicalFieldValue(field, value);
  }
  return out;
}

// Assemble the structured fields back into a `- <Label>: <value>` body. Empty
// fields are dropped so the stored body stays free of placeholder noise.
function assembleProfileBody(values: Record<string, string>): string {
  return PROFILE_FIELDS.map((f) => {
    const v = (values[f.label] ?? '').trim();
    return v ? `- ${f.label}: ${v}` : null;
  })
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function MemoryProfilePanel({ enabled }: { enabled: boolean }) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/memory/${encodeURIComponent(PROFILE_MEMORY_ID)}`);
      if (resp.status === 404) {
        setValues({});
        return;
      }
      if (!resp.ok) return;
      const json = (await resp.json()) as { entry?: MemoryEntry };
      setValues(parseProfileBody(json.entry?.body ?? ''));
    } catch {
      // Network blips leave the form empty rather than crashing the panel.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = useCallback(async () => {
    setBusy(true);
    setSaved(false);
    try {
      const resp = await fetch(`/api/memory/${encodeURIComponent(PROFILE_MEMORY_ID)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'profile',
          name: t('settings.memoryProfileName'),
          description: t('settings.memoryProfileDescription'),
          body: assembleProfileBody(values),
        }),
      });
      if (resp.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      }
    } finally {
      setBusy(false);
    }
  }, [values, t]);

  const setField = (label: string, value: string) =>
    setValues((prev) => ({ ...prev, [label]: value }));
  const disabled = !enabled || loading;

  const renderControl = (field: (typeof PROFILE_FIELDS)[number], labelId: string) => {
    const value = values[field.label] ?? '';
    // Choice options: the stored value is locale-independent, the label is
    // translated for the current locale.
    const options = (field.options ?? []).map((key) => ({
      value: storedOptionValue(key),
      label: profileOptionValue(t(key)),
    }));
    const optionValues = options.map((option) => option.value);
    if (field.kind === 'select') {
      // A stored value that is not one of today's options (hand-edited)
      // stays selectable rather than being lost.
      const choices = value && !optionValues.includes(value)
        ? [{ value, label: value }, ...options]
        : options;
      return (
        <Select
          aria-labelledby={labelId}
          value={value}
          disabled={disabled}
          onChange={(e) => setField(field.label, e.target.value)}
        >
          <option value="">{t(field.placeholderKey)}</option>
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </Select>
      );
    }
    if (field.kind === 'multi') {
      const selected = splitProfileList(value);
      const extras = selected.filter((item) => !optionValues.includes(item));
      const toggle = (choice: string) => {
        const next = selected.includes(choice)
          ? selected.filter((item) => item !== choice)
          : [...selected, choice];
        setField(field.label, next.join(', '));
      };
      return (
        <div className={styles.chips} role="group" aria-labelledby={labelId}>
          {[...extras.map((extra) => ({ value: extra, label: extra })), ...options].map((choice) => (
            <Chip
              key={choice.value}
              size="sm"
              selected={selected.includes(choice.value)}
              disabled={disabled}
              onClick={() => toggle(choice.value)}
            >
              {choice.label}
            </Chip>
          ))}
        </div>
      );
    }
    if (field.kind === 'note') {
      return (
        <Textarea
          aria-labelledby={labelId}
          rows={3}
          value={value}
          placeholder={t(field.placeholderKey)}
          disabled={disabled}
          onChange={(e) => setField(field.label, e.target.value)}
        />
      );
    }
    return (
      <Input
        aria-labelledby={labelId}
        type="text"
        value={value}
        placeholder={t(field.placeholderKey)}
        disabled={disabled}
        onChange={(e) => setField(field.label, e.target.value)}
      />
    );
  };

  return (
    <div className={styles.panel} data-testid="memory-profile-panel">
      <div className={styles.head}>
        <span className={styles.headIcon} aria-hidden>
          <Icon name="home" size={16} />
        </span>
        <div>
          <h4 className={styles.title}>{t('settings.memoryProfileTitle')}</h4>
          <p className={styles.hint}>{t('settings.memoryProfileHint')}</p>
        </div>
      </div>

      {SECTIONS.map((section) => (
        <fieldset key={section.id} className={styles.section}>
          <legend className={styles.sectionTitle}>{t(section.titleKey)}</legend>
          <div className={styles.fields}>
            {section.order.map((label) => {
              const field = PROFILE_FIELDS.find((f) => f.label === label)!;
              const labelId = `memory-profile-${field.label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
              const wide = field.kind === 'note' || field.kind === 'multi';
              return (
                <div key={field.label} className={`${styles.field}${wide ? ` ${styles.wide}` : ''}`}>
                  <span className={styles.fieldLabel} id={labelId}>{t(field.labelKey)}</span>
                  {renderControl(field, labelId)}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

      <div className={styles.actions}>
        {saved ? (
          <span className={styles.savedPill} role="status" aria-live="polite">
            <Icon name="check" size={14} />
            {t('settings.memoryProfileSaved')}
          </span>
        ) : null}
        <Button variant="primary" onClick={() => void onSave()} disabled={!enabled} loading={busy}>
          {t('settings.memoryProfileSave')}
        </Button>
      </div>
    </div>
  );
}
