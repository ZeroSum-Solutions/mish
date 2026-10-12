import type { DroppedDirectory } from './native-directory-drop';

/** DOM Files ownership only. Native guest/handle capabilities are separately gated. */
export interface ExternalFilesDrop {
  files: readonly File[];
  hasDirectory: boolean;
  /** Dropped folders, expanded later through the native host listing when one exists. */
  directories: readonly DroppedDirectory[];
}

interface DropTarget<TSnapshot> {
  getSnapshot: () => TSnapshot;
  onDrop: (drop: ExternalFilesDrop, snapshot: TSnapshot) => void | Promise<void>;
}

const claimedDrops = new WeakSet<Event>();
// Shared across coordinator instances: listener mount order cannot outrank DOM depth.
const registeredTargets = new WeakMap<Element, (event: DragEvent) => void>();

/** Native React uploaders claim the same DOM event before an ancestor can upload it. */
export function claimNativeFileDrop(event: { nativeEvent: DragEvent; currentTarget: Element; preventDefault: () => void; stopPropagation: () => void }): boolean {
  const native = event.nativeEvent;
  if (!isExternalFilesDrag(native) || claimedDrops.has(native) || native.defaultPrevented) return false;
  const nearest = native.composedPath().find(node => node instanceof Element && node.hasAttribute('data-native-file-drop'));
  if (nearest !== event.currentTarget) return false;
  claimedDrops.add(native);
  event.preventDefault(); event.stopPropagation();
  native.stopImmediatePropagation();
  return true;
}

function frozenCopy<T>(value: T): T {
  const copy = (item: unknown): unknown => {
    if (Array.isArray(item)) return Object.freeze(item.map(copy));
    if (item !== null && typeof item === 'object') return Object.freeze(Object.fromEntries(Object.entries(item).map(([key, child]) => [key, copy(child)])));
    return item;
  };
  return copy(value) as T;
}

export function isExternalFilesDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

export function collectDroppedFiles(event: DragEvent): ExternalFilesDrop {
  const transfer = event.dataTransfer;
  const items = Array.from(transfer?.items ?? []).filter((item) => item.kind === 'file');
  if (items.length === 0) return { files: Array.from(transfer?.files ?? []), hasDirectory: false, directories: [] };
  const files: File[] = [];
  const directories: DroppedDirectory[] = [];
  for (const item of items) {
    // Entries must be read during the drop event; Chromium invalidates them after.
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => DroppedDirectory['entry'] | null }).webkitGetAsEntry?.();
    if (entry?.isDirectory) { directories.push({ file: item.getAsFile(), entry }); continue; }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, hasDirectory: directories.length > 0, directories };
}

export function createDropCoordinator<TSnapshot>(options: DropTarget<TSnapshot> & {
  onAcknowledge?: (drop: ExternalFilesDrop, snapshot: TSnapshot) => void;
  onError?: (error: unknown) => void;
  /** Option (Alt) state of an external file drag over app DOM. */
  onDragModifier?: (optionHeld: boolean) => void;
  /** An external drag left the window without dropping. */
  onDragLeaveWindow?: () => void;
}) {
  function deliver(event: DragEvent, destination: DropTarget<TSnapshot>): void {
    if (claimedDrops.has(event) || event.defaultPrevented) return;
    claimedDrops.add(event);
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
    const snapshot = frozenCopy(destination.getSnapshot());
    const drop = collectDroppedFiles(event);
    options.onAcknowledge?.(drop, snapshot);
    try { void Promise.resolve(destination.onDrop(drop, snapshot)).catch((error: unknown) => options.onError?.(error)); }
    catch (error) { options.onError?.(error); }
  }
  function handleDrop(event: DragEvent, respectNativeOwners = true): void {
    if (!isExternalFilesDrag(event) || claimedDrops.has(event) || event.defaultPrevented) return;
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      const local = registeredTargets.get(node);
      if (local) { local(event); return; }
      // The nearest native uploader gets the event first. If it declines,
      // the bubble fallback can use the nearest enclosing registered target.
      if (respectNativeOwners && node.hasAttribute('data-native-file-drop')) return;
    }
    deliver(event, options);
  }
  return {
    handleDrop,
    registerTarget(element: Element, target: DropTarget<TSnapshot>): () => void {
      const route = (event: DragEvent) => deliver(event, target);
      registeredTargets.set(element, route);
      return () => { if (registeredTargets.get(element) === route) registeredTargets.delete(element); };
    },
    mount(root: Document): () => void {
      const over = (event: DragEvent) => {
        if (!isExternalFilesDrag(event)) return;
        event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        options.onDragModifier?.(event.altKey);
      };
      const leave = (event: DragEvent) => { if (event.relatedTarget == null) options.onDragLeaveWindow?.(); };
      const unclaimed = (event: DragEvent) => handleDrop(event, false);
      root.addEventListener('dragover', over, true);
      root.addEventListener('dragleave', leave, true);
      root.addEventListener('drop', handleDrop, true);
      root.addEventListener('drop', unclaimed);
      return () => { root.removeEventListener('dragover', over, true); root.removeEventListener('dragleave', leave, true); root.removeEventListener('drop', handleDrop, true); root.removeEventListener('drop', unclaimed); };
    },
  };
}
