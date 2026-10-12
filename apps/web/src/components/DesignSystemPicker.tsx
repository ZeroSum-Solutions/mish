// Shared design-system picker — the two-column popover (searchable list +
// live preview) used in BOTH the project chrome header and the home composer
// footer. It binds to a single design-system id: changing the selection calls
// `onChange(id | null)` where `null` means "不指定 / No design system".
//
// `variant` only swaps the trigger pill styling:
//   - 'project' (default): the chrome-header pill (`project-ds-picker-*`).
//   - 'footer': the home composer footer pill (`home-hero__footer-*`), so it
//     sits flush with the other footer options.
// The popover body is identical for both variants.
//
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DesignSystemSummary, WorkspaceCollabContext } from '@mish/contracts';
import { Button } from '@mish/components';
import { setDesignSystemApproval } from '../providers/registry';
import { isApprovedDesignSystem, matchesDesignSystemQuery } from '@mish/contracts';
import { designSystemIdentity } from '../runtime/design-system-identity';
import identityStyles from './DesignSystemIdentity.module.css';
import { isSelectableDesignSystem } from '../runtime/design-system-selection';
import { useI18n } from '../i18n';
import {
  localizeDesignSystemCategory,
  localizeDesignSystemSummary,
} from '../i18n/content';
import { navigate } from '../router';
import { setPendingDesignSystemCreateEntry } from '../analytics/ds-create-entry';
import { useBrandsByDesignSystemId } from '../runtime/brands';
import { DesignSystemKitPreview } from './DesignSystemKitPreview';
import { DraftDesignKitList, type PublishDesignSystemDraft } from './DraftDesignKitList';
import { DesignSystemPreviewModal } from './DesignSystemPreviewModal';
import { Icon } from './Icon';
import { ComposerPaletteIcon } from './chat/primitives/icons';

// Mirror DesignSystemsTab's user/official split so the picker's grouping lines
// up exactly with the "你的体系 / 官方预设" tabs in the Design Systems tab.
function isUserSystem(system: DesignSystemSummary): boolean {
  return system.source === 'user' || system.isEditable === true;
}

function isTeamSystem(system: DesignSystemSummary): boolean {
  return system.teamShared === true || system.teamSynced === true;
}

interface PopoverAnchor {
  left: number;
  width: number;
  maxHeight: number;
  // Vertical placement: when the trigger sits near the bottom of the
  // viewport (e.g. the composer-top picker) the popover opens upward,
  // anchored by `bottom`; otherwise it opens downward, anchored by `top`.
  top?: number;
  bottom?: number;
}

interface Props {
  designSystems: DesignSystemSummary[];
  selectedId: string | null;
  loading?: boolean;
  // Read-only viewer of a team-shared project cannot switch the design system.
  disabled?: boolean;
  onChange: (id: string | null) => void;
  /**
   * Trigger styling only; the popover is identical across variants.
   *   - 'project' (default): the chrome-header pill (`project-ds-picker-*`).
   *   - 'footer': the home composer input-card footer pill.
   *   - 'home': the borderless trigger in the home composer's row below the
   *     card, sitting flush with the working-directory picker.
   *   - 'icon': a text-free palette icon button matching the composer
   *     icon row (#5517's in-composer picker).
   */
  variant?: 'project' | 'footer' | 'home' | 'icon';
  /** Footer variant: visually-hidden label for the trigger button. */
  label?: string;
  /** Hide the recursive "Create" action when the picker is already on create. */
  showCreateAction?: boolean;
  /** Copying a reference guide may use drafts; binding projects may not. */
  includeUnpublished?: boolean;
  /** Project-owned identity used for preview reads while shell context catches up. */
  workspaceContext?: WorkspaceCollabContext | null;
  /**
   * Offer the caller's draft kits with a Publish action instead of hiding
   * them. Resolves true when the kit is now published; the picker then
   * selects it.
   */
  onPublishDraft?: PublishDesignSystemDraft;
}

export function DesignSystemPicker({
  designSystems,
  selectedId,
  loading,
  disabled = false,
  onChange,
  variant = 'project',
  label,
  showCreateAction = true,
  includeUnpublished = false,
  workspaceContext,
  onPublishDraft,
}: Props) {
  const { locale, t } = useI18n();
  const triggerDisabled = Boolean(loading || disabled);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState(false);
  const [approvedSystem, setApprovedSystem] = useState<{ system: DesignSystemSummary; source: DesignSystemSummary } | null>(null);
  // A refreshed catalog is authoritative even when only the receipt changed.
  const effectiveSystems = designSystems.map((system) => approvedSystem?.source === system ? approvedSystem.system : system);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [hovered, setHovered] = useState<DesignSystemSummary | null>(null);
  // Tracks whether the "不指定 / No design system" row is the active preview
  // target (hovered), so its right-pane blurb shows instead of a system preview.
  const [hoveredNone, setHoveredNone] = useState(false);
  const [previewModalSystem, setPreviewModalSystem] = useState<DesignSystemSummary | null>(null);

  function restoreTriggerFocus() {
    // A container-collapsed palette is opened from the composer's overflow.
    const trigger = triggerRef.current;
    const composer = trigger?.closest('[data-testid="chat-composer"]');
    const focusTarget = trigger && getComputedStyle(trigger).visibility !== 'hidden' && trigger.getClientRects().length
      ? trigger : composer?.querySelector<HTMLButtonElement>('[data-testid="chat-plus-trigger"]');
    window.requestAnimationFrame(() => focusTarget?.focus());
  }

  const selected = useMemo(
    () => effectiveSystems.find((d) => d.id === selectedId) ?? null,
    [designSystems, selectedId, approvedSystem],
  );

  // Map each `user:<id>` design system to its backing brand so a selected /
  // hovered brand previews the rich Brand Kit card instead of the thin
  // design-system summary. Fetched lazily on first open; a non-brand system
  // (bundled / imported) is absent from the map and keeps the thin preview.
  const brandsByDesignSystem = useBrandsByDesignSystemId(open);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        restoreTriggerFocus();
      }
      if (e.key === 'Tab') {
        const panel = popoverRef.current;
        const controls = panel ? [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, a[href]')]
          .filter((element) => element.getClientRects().length > 0) : [];
        const first = controls[0], last = controls.at(-1);
        if (!first || !last) return;
        if (!panel?.contains(document.activeElement) || (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
      const target = e.target as HTMLElement;
      if (target.getAttribute('role') === 'option' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        const options = [...popoverRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []];
        const index = options.indexOf(target);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1
          : (index + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        e.preventDefault();
        options[next]?.focus();
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return undefined;
    function updateAnchor() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const viewport = window.innerWidth;
      // A centered browsing surface gives the overview a usable canvas even
      // when its composer trigger sits close to the bottom of the window. It
      // stays a calm, bounded panel: never wider than 880px or taller than
      // 640px, and always inside the viewport with a 16px margin.
      const margin = 16;
      const popoverWidth = Math.min(880, viewport - margin * 2);
      const height = Math.min(640, window.innerHeight - margin * 2);
      setAnchor({
        top: Math.max(margin, (window.innerHeight - height) / 2),
        left: Math.max(margin, (viewport - popoverWidth) / 2),
        width: popoverWidth,
        maxHeight: height,
      });
    }
    updateAnchor();
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    return () => {
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
      setHovered(null);
      setHoveredNone(false);
    }
  }, [open]);

  // Resolve what the right pane previews. Priority: a hovered system, the
  // hovered "不指定" row, the selected system, then "不指定" when nothing is
  // selected (so opening with "不指定" active shows its blurb, not the hint).
  let previewSystem: DesignSystemSummary | null = null;
  let previewNone = false;
  if (open) {
    if (hovered) previewSystem = hovered;
    else if (hoveredNone) previewNone = true;
    else if (selectedId != null) previewSystem = selected;
    else previewNone = true;
  }

  const filtered = useMemo(() => {
    return effectiveSystems.filter((d) => {
      if (!showAll && !includeUnpublished && !isSelectableDesignSystem(d)) return false;
      const localizedSummary = localizeDesignSystemSummary(locale, d);
      const localizedCategory = localizeDesignSystemCategory(locale, d.category);
      return matchesDesignSystemQuery(d, query, `${localizedCategory} ${localizedSummary}`);
    });
  }, [query, designSystems, locale, includeUnpublished, showAll, approvedSystem]);

  useEffect(() => {
    if (hovered && !filtered.some((system) => system.id === hovered.id)) setHovered(null);
  }, [filtered, hovered]);

  // Personal drafts the caller could publish right here. Only offered when
  // the host wires a publisher; a draft is never directly selectable, since
  // generation would skip it.
  const draftSystems = useMemo(() => {
    if (!onPublishDraft || includeUnpublished) return [];
    return designSystems.filter((d) => {
      if (!isUserSystem(d) || isTeamSystem(d)) return false;
      if (!(d.title ?? '').trim() || d.status !== 'draft' || !isApprovedDesignSystem(d)) return false;
      const localizedSummary = localizeDesignSystemSummary(locale, d);
      const localizedCategory = localizeDesignSystemCategory(locale, d.category);
      return matchesDesignSystemQuery(d, query, `${localizedCategory} ${localizedSummary}`);
    });
  }, [designSystems, includeUnpublished, locale, onPublishDraft, query]);

  // Split the filtered list into the same scopes the Design Systems tab uses:
  // personal first, then team-shared systems, then official presets.
  const { userSystems, teamSystems, officialSystems } = useMemo(() => {
    const mine: DesignSystemSummary[] = [];
    const team: DesignSystemSummary[] = [];
    const official: DesignSystemSummary[] = [];
    for (const system of filtered) {
      if (isTeamSystem(system)) team.push(system);
      else if (isUserSystem(system)) mine.push(system);
      else official.push(system);
    }
    return { userSystems: mine, teamSystems: team, officialSystems: official };
  }, [filtered]);

  const selectDesignSystem = (id: string | null) => {
    onChange(id);
    setOpen(false);
    restoreTriggerFocus();
  };

  const selectDesignSystemOnKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string | null) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectDesignSystem(id);
  };

  const identityPrefix = useId();

  const renderOption = (d: DesignSystemSummary) => {
    const active = d.id === selectedId;
    const identity = designSystemIdentity(d, designSystems, locale);
    const identityId = `${identityPrefix}-${d.id}`;
    return (
      <button
        key={d.id}
        type="button"
        className={`project-ds-picker-option ${identityStyles.option}${active ? ' active' : ''}`}
        role="option"
        aria-selected={active}
        aria-label={`${d.title}${d.category ? `, ${d.category}` : ''}`}
        aria-describedby={identity ? identityId : undefined}
        onMouseEnter={() => {
          setHovered(d);
          setHoveredNone(false);
        }}
        onFocus={() => {
          setHovered(d);
          setHoveredNone(false);
        }}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => { if (includeUnpublished || isSelectableDesignSystem(d)) selectDesignSystem(d.id); else { setHovered(d); setHoveredNone(false); } }}
        onKeyDown={(event) => { if (includeUnpublished || isSelectableDesignSystem(d)) selectDesignSystemOnKeyDown(event, d.id); }}
        aria-disabled={!includeUnpublished && !isSelectableDesignSystem(d)}
        data-testid={`project-ds-picker-option-${d.id}`}
      >
        <div className="project-ds-picker-option-head">
          <div className="project-ds-picker-option-copy">
            <span className="project-ds-picker-option-title">{d.title}</span>
            <span className="project-ds-picker-option-meta">{d.category}{!isApprovedDesignSystem(d) ? ` · ${t('designSystemPicker.unreviewed')}` : ''}</span>
            {identity ? <span id={identityId} className={identityStyles.identity}>{identity}</span> : null}
          </div>
          <span className="project-ds-picker-option-swatches" aria-hidden="true">
            {d.swatches?.slice(0, 4).map((color, i) => <i key={i} className="project-ds-picker-option-swatch" style={{ background: color }} />)}
          </span>
          {active ? (
            <span
              className="project-ds-picker-option-check"
              data-testid={`project-ds-picker-option-${d.id}-check`}
            >
              <Icon name="check" size={12} strokeWidth={2} />
            </span>
          ) : null}
        </div>
      </button>
    );
  };

  // Clear: reset the search query and deselect any chosen system (back to "No
  // design system") without closing, so the user can keep browsing. Create:
  // jump to the standalone design-system creation page, closing the popover.
  const clearSelection = () => {
    setQuery('');
    onChange(null);
    inputRef.current?.focus();
  };
  const createDesignSystem = () => {
    setOpen(false);
    setPendingDesignSystemCreateEntry('composer_picker');
    navigate({ kind: 'design-system-create' });
  };

  const openSystemPreview = (system: DesignSystemSummary) => {
    setOpen(false);
    setPreviewModalSystem(system);
  };

  // The trigger shows a neutral palette icon rather than a few swatches: a 3-dot
  // slice of a system's palette often grabs only its neutrals (background/ink)
  // and drops the brand accent, so the pill read as a different colour scheme
  // than the full preview. The name + on-open preview convey the system instead.
  const triggerSwatches = <Icon name="palette" size={13} />;

  async function approve(system: DesignSystemSummary, approved = true) {
    if (!system.approval || approving) return;
    setApproving(true);
    setApprovalError(false);
    const updated = await setDesignSystemApproval(system.id, { approved, expectedRevision: system.approval.revision }, workspaceContext);
    setApproving(false);
    if (!updated || (approved && !isSelectableDesignSystem(updated))) { setApprovalError(true); return; }
    setApprovedSystem({ system: updated, source: designSystems.find(item => item.id === system.id) ?? system });
    setHovered(updated);
  }
  const blocked = !includeUnpublished && selected && !isSelectableDesignSystem(selected) ? selected : null;
  const approvalTarget = previewSystem && !isApprovedDesignSystem(previewSystem) ? previewSystem : blocked;

  const popover: ReactNode =
    open && anchor && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className="project-ds-picker-popover"
            role="dialog"
            aria-modal="true"
            aria-label={t('newproj.designSystem')}
            data-testid="project-ds-picker-popover"
            data-placement="center"
            style={{
              top: anchor.top,
              bottom: anchor.bottom,
              left: anchor.left,
              width: anchor.width,
              maxHeight: anchor.maxHeight,
            }}
          >
            <div className="project-ds-picker-search">
              {!includeUnpublished ? <label><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />{t('designSystemPicker.showAll')}</label> : null}
              {/* The field owns focus feedback (the shared shimmer border);
                  the header row itself draws no rule that could light up. */}
              <label className="project-ds-picker-field" data-ui-field-shell>
                <Icon name="search" size={14} />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('designSystemPicker.searchCompactPlaceholder')}
                  aria-label={t('designSystemPicker.searchCompactPlaceholder')}
                  data-testid="project-ds-picker-search"
                />
              </label>
              <button
                type="button"
                className="project-ds-picker-action"
                data-testid="project-ds-picker-clear"
                onClick={clearSelection}
              >
                {t('common.clear')}
              </button>
              {showCreateAction ? (
                <button
                  type="button"
                  className="project-ds-picker-action project-ds-picker-action--primary"
                  data-testid="project-ds-picker-create"
                  onClick={createDesignSystem}
                >
                  <Icon name="plus" size={12} strokeWidth={2} />
                  <span>{t('common.create')}</span>
                </button>
              ) : null}
            </div>
            <div className="project-ds-picker-body">
              <div className="project-ds-picker-list" role="listbox">
                <button
                  type="button"
                  className={`project-ds-picker-option${selectedId == null ? ' active' : ''}`}
                  role="option"
                  aria-selected={selectedId == null}
                  onMouseEnter={() => {
                    setHovered(null);
                    setHoveredNone(true);
                  }}
                  onFocus={() => {
                    setHovered(null);
                    setHoveredNone(true);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onClick={() => selectDesignSystem(null)}
                  onKeyDown={(event) => selectDesignSystemOnKeyDown(event, null)}
                >
                  <div className="project-ds-picker-option-head">
                    <span className="project-ds-picker-option-title">{t('designSystemPicker.noneTitle')}</span>
                    {selectedId == null ? (
                      <span
                        className="project-ds-picker-option-check"
                        data-testid="project-ds-picker-option-none-check"
                      >
                        <Icon name="check" size={12} strokeWidth={2} />
                      </span>
                    ) : null}
                  </div>
                </button>
                {userSystems.length > 0 ? (
                  <div
                    className="project-ds-picker-group-label"
                    role="presentation"
                    data-testid="project-ds-picker-group-mine"
                  >
                    {t('dsManager.yourSystems')}
                  </div>
                ) : null}
                {userSystems.map(renderOption)}
                {teamSystems.length > 0 ? (
                  <div
                    className="project-ds-picker-group-label"
                    role="presentation"
                    data-testid="project-ds-picker-group-team"
                  >
                    {t('pluginsView.tab.team')}
                  </div>
                ) : null}
                {teamSystems.map(renderOption)}
                {officialSystems.length > 0 ? (
                  <div
                    className="project-ds-picker-group-label"
                    role="presentation"
                    data-testid="project-ds-picker-group-official"
                  >
                    {t('dsManager.officialPresets')}
                  </div>
                ) : null}
                {officialSystems.map(renderOption)}
                {onPublishDraft ? (
                  <DraftDesignKitList
                    drafts={draftSystems}
                    onPublish={onPublishDraft}
                    onPublished={(system) => selectDesignSystem(system.id)}
                  />
                ) : null}
                {filtered.length === 0 && draftSystems.length === 0 ? (
                  <div className="project-ds-picker-empty">
                    {loading ? t('designSystemPicker.loading') : t('designSystemPicker.empty')}
                  </div>
                ) : null}
              </div>
              <div className="project-ds-picker-preview" data-testid="project-ds-picker-preview">
                {blocked ? <p role="alert">{t('designSystemPicker.approvalBlocked', { name: blocked.title })}</p> : null}
                {approvalTarget ? <Button variant="secondary" size="sm" loading={approving} onClick={() => void approve(approvalTarget)}>{t('designSystemPicker.approve')}</Button> : null}
                {previewSystem && isApprovedDesignSystem(previewSystem) ? <Button variant="ghost" size="sm" loading={approving} onClick={() => void approve(previewSystem, false)}>{t('designSystemPicker.unapprove')}</Button> : null}
                {approvalError ? <p role="alert">{t('designSystemPicker.approvalFailed')}</p> : null}
                {previewNone ? (
                  <div data-testid="project-ds-picker-preview-none">
                    <div className="project-ds-picker-preview-head">
                      <strong>{t('designSystemPicker.noneTitle')}</strong>
                    </div>
                    <p className="project-ds-picker-preview-summary">
                      {t('designSystemPicker.noneSummary')}
                    </p>
                    <p className="project-ds-picker-preview-hint">
                      {t('designSystemPicker.previewHint')}
                    </p>
                  </div>
                ) : previewSystem ? (
                  <div
                    className="project-ds-picker-preview-kit-wrap"
                    data-testid="project-ds-picker-preview-kit-wrap"
                  >
                    <DesignSystemKitPreview
                      system={previewSystem}
                      workspaceContext={workspaceContext}
                      brandSummary={brandsByDesignSystem.get(previewSystem.id) ?? null}
                      variant="compact"
                      showCover
                      className="project-ds-picker-preview-kit"
                      dataTestId="project-ds-picker-preview-kit"
                    />
                    <button
                      type="button"
                      className="project-ds-picker-preview-open"
                      data-testid="project-ds-picker-preview-expand"
                      onClick={() => openSystemPreview(previewSystem)}
                    >
                      <Icon name="eye" size={12} strokeWidth={1.9} />
                      <span>{t('designSystemPicker.openPreview')}</span>
                    </button>
                  </div>
                ) : (
                  <div className="project-ds-picker-preview-stage">
                    <div className="project-ds-picker-preview-empty">
                      {t('designSystemPicker.previewHint')}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const previewModal: ReactNode = previewModalSystem ? (
    <DesignSystemPreviewModal
      system={previewModalSystem}
      workspaceContext={workspaceContext}
      onClose={() => setPreviewModalSystem(null)}
    />
  ) : null;

  if (variant === 'icon') {
    return (
      <div
        ref={wrapRef}
        className="composer-ds-icon"
        data-testid="composer-design-system-picker"
      >
        <button
          ref={triggerRef}
          type="button"
          className={`icon-btn composer-ds-icon-trigger od-tooltip${open ? ' is-active' : ''}${selected ? ' is-picked' : ''}`}
          data-testid="composer-design-system-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={selected?.title ?? t('designSystemPicker.noneTitle')}
          data-tooltip={selected?.title ?? t('designSystemPicker.noneTitle')}
          disabled={loading}
          title={selected?.title ?? t('designSystemPicker.noneTitle')}
          onClick={() => setOpen((v) => !v)}
        >
          <ComposerPaletteIcon size={16} />
          {selected ? (
            <span className="composer-ds-icon-trigger-label">{selected.title}</span>
          ) : null}
        </button>
        {popover}
        {previewModal}
      </div>
    );
  }

  if (variant === 'home') {
    return (
      <div
        ref={wrapRef}
        className="home-hero__ds-row-picker"
        data-testid="home-hero-design-system-picker"
      >
        <button
          ref={triggerRef}
          type="button"
          className="home-hero__ds-row-trigger"
          data-testid="home-hero-design-system-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={triggerDisabled}
          title={selected?.title ?? t('newproj.designSystem')}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="palette" size={13} className="home-hero__ds-row-trigger-icon" />
          <span className="home-hero__ds-row-trigger-label">
            {loading
              ? t('designSystemPicker.loading')
              : selected?.title ?? t('newproj.designSystem')}
          </span>
          <Icon name="chevron-down" size={11} className="home-hero__ds-row-trigger-chevron" />
        </button>
        {popover}
        {previewModal}
      </div>
    );
  }

  if (variant === 'footer') {
    return (
      <div
        ref={wrapRef}
        className={`home-hero__footer-option home-hero__footer-option--select${open ? ' is-open' : ''}`}
        data-field-name="designSystem"
      >
        <span>{label ?? t('designSystemPicker.select')}</span>
        <button
          ref={triggerRef}
          type="button"
          className="home-hero__footer-select-trigger"
          data-testid="home-hero-footer-option-designSystem"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={triggerDisabled}
          onClick={() => setOpen((v) => !v)}
        >
          {triggerSwatches}
          <span className="home-hero__footer-select-label">
            {loading
              ? t('designSystemPicker.loading')
              : selected?.title ?? t('designSystemPicker.noneTitle')}
          </span>
          <Icon name="chevron-down" size={12} aria-hidden />
        </button>
        {popover}
        {previewModal}
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className={`project-ds-picker${open ? ' open' : ''}`}
      data-testid="project-ds-picker"
    >
      <button
        ref={triggerRef}
        type="button"
        className={`project-ds-picker-trigger${selected ? ' picked' : ''}`}
        data-testid="project-ds-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={triggerDisabled}
        title={selected?.title ?? t('designSystemPicker.select')}
      >
        {triggerSwatches}
        <span className="project-ds-picker-label">
          {loading
            ? t('designSystemPicker.loading')
            : selected?.title ?? t('designSystemPicker.select')}
        </span>
        <Icon name="chevron-down" size={11} />
      </button>
      {popover}
      {previewModal}
    </div>
  );
}
