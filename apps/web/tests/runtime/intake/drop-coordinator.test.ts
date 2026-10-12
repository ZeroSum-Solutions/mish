// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDropCoordinator } from '../../../src/runtime/intake/drop-coordinator';

afterEach(() => { document.body.replaceChildren(); });

function drop(target: Element, files: File[], types = ['Files']) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types, files, items: files.map((file) => ({ kind: 'file', getAsFile: () => file })) } });
  target.dispatchEvent(event); return event;
}

describe('external Files coordinator', () => {
  it('chooses the most specific registered target across mounted coordinators regardless of listener order', () => {
    const project = document.createElement('div'); const composer = document.createElement('div'); project.append(composer); document.body.append(project);
    const appDrop = vi.fn(); const projectDrop = vi.fn(); const composerDrop = vi.fn();
    const app = createDropCoordinator({ getSnapshot: () => 'app', onDrop: appDrop });
    const local = createDropCoordinator({ getSnapshot: () => 'project', onDrop: projectDrop });
    const disposeApp = app.mount(document); const disposeLocal = local.mount(document);
    const unregisterProject = app.registerTarget(project, { getSnapshot: () => 'project', onDrop: projectDrop });
    const unregisterComposer = local.registerTarget(composer, { getSnapshot: () => 'composer', onDrop: composerDrop });
    try {
      drop(composer, [new File(['html'], 'scaffold.html')]);
      expect(composerDrop).toHaveBeenCalledTimes(1); expect(appDrop).not.toHaveBeenCalled(); expect(projectDrop).not.toHaveBeenCalled();
    } finally { unregisterComposer(); unregisterProject(); disposeLocal(); disposeApp(); }
  });

  it('routes a declined native drop to its enclosing intake target and removes the fallback on disposal', () => {
    const outer = document.createElement('div'); const native = document.createElement('div'); native.setAttribute('data-native-file-drop', ''); outer.append(native); document.body.append(outer);
    const declined = vi.fn(); native.addEventListener('drop', declined);
    const fallback = vi.fn(); const local = vi.fn(); const acknowledge = vi.fn();
    const owner = createDropCoordinator({ getSnapshot: () => 'shell', onDrop: fallback, onAcknowledge: acknowledge });
    const dispose = owner.mount(document); const unregister = owner.registerTarget(outer, { getSnapshot: () => 'project-folder', onDrop: local });
    const file = new File(['pdf'], 'reference.pdf'); const event = drop(native, [file]);
    expect(declined).toHaveBeenCalledWith(event); expect(event.defaultPrevented).toBe(true);
    expect(local).toHaveBeenCalledExactlyOnceWith({ files: [file], hasDirectory: false, directories: [] }, 'project-folder');
    expect(acknowledge).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
    unregister(); dispose();
    expect(drop(native, [file]).defaultPrevented).toBe(false); expect(local).toHaveBeenCalledTimes(1);
  });

  it('lets a nested native file surface own its transfer while shell drops still use intake', () => {
    const native = document.createElement('div'); native.setAttribute('data-native-file-drop', ''); const child = document.createElement('span'); native.append(child); document.body.append(native);
    const fallback = vi.fn(); const local = vi.fn((event: Event) => event.preventDefault()); native.addEventListener('drop', local);
    const owner = createDropCoordinator({ getSnapshot: () => 'shell', onDrop: fallback }); const dispose = owner.mount(document);
    const file = new File(['source'], 'design.fig'); const nativeEvent = drop(child, [file]);
    expect(local).toHaveBeenCalledWith(nativeEvent); expect(fallback).not.toHaveBeenCalled();
    drop(document.body, [file]); expect(fallback).toHaveBeenCalledTimes(1); dispose();
  });
  it('honors the nearest owner between native regions and registered intake regions', () => {
    const outer = document.createElement('div'); const inner = document.createElement('div'); inner.setAttribute('data-native-file-drop', ''); outer.append(inner); document.body.append(outer);
    const fallback = vi.fn(); const registered = vi.fn(); const native = vi.fn((event: Event) => event.preventDefault()); inner.addEventListener('drop', native);
    const owner = createDropCoordinator({ getSnapshot: () => 'shell', onDrop: fallback }); const dispose = owner.mount(document); const unregister = owner.registerTarget(outer, { getSnapshot: () => 'outer', onDrop: registered });
    drop(inner, [new File(['a'], 'a.fig')]); expect(native).toHaveBeenCalledTimes(1); expect(registered).not.toHaveBeenCalled();
    inner.removeAttribute('data-native-file-drop'); outer.setAttribute('data-native-file-drop', ''); const stopInner = owner.registerTarget(inner, { getSnapshot: () => 'inner', onDrop: registered });
    drop(inner, [new File(['b'], 'b.txt')]); expect(registered).toHaveBeenCalledTimes(1); expect(registered.mock.calls[0]![1]).toBe('inner'); expect(native).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
    stopInner(); unregister(); dispose();
  });
  it('claims an external event once, acknowledges synchronously and freezes context', () => {
    let context = { projectId: 'first', conversationId: 'conversation', dir: '', workspace: { workspaceId: 'one', memberId: 'member' } };
    const accepted = vi.fn(); const acknowledge = vi.fn();
    const owner = createDropCoordinator({ getSnapshot: () => context, onDrop: accepted, onAcknowledge: acknowledge });
    const dispose = owner.mount(document);
    const file = new File(['bytes'], 'one.bin'); const event = drop(document.body, [file]);
    expect(event.defaultPrevented).toBe(true); expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledTimes(1); owner.handleDrop(event as DragEvent);
    expect(accepted).toHaveBeenCalledTimes(1);
    context.workspace.workspaceId = 'two'; context = { ...context, projectId: 'second' };
    expect(accepted.mock.calls[0]![1]).toEqual({ projectId: 'first', conversationId: 'conversation', dir: '', workspace: { workspaceId: 'one', memberId: 'member' } });
    dispose();
  });

  it('uses the innermost declared local folder target before the global destination', () => {
    const outer = document.createElement('div'); const inner = document.createElement('div'); outer.append(inner); document.body.append(outer);
    const global = vi.fn(); const local = vi.fn(); const parent = vi.fn();
    const owner = createDropCoordinator({ getSnapshot: () => ({ dir: '' }), onDrop: global });
    const dispose = owner.mount(document);
    const unregisterOuter = owner.registerTarget(outer, { getSnapshot: () => ({ dir: 'outer' }), onDrop: parent });
    const unregisterInner = owner.registerTarget(inner, { getSnapshot: () => ({ dir: 'frozen/folder' }), onDrop: local });
    drop(inner, [new File(['a'], 'a.txt')]);
    expect(local.mock.calls[0]![1]).toEqual({ dir: 'frozen/folder' });
    expect(global).not.toHaveBeenCalled(); expect(parent).not.toHaveBeenCalled();
    unregisterInner(); unregisterOuter(); dispose();
  });

  it('leaves internal tab reorder and text drags untouched', () => {
    const accepted = vi.fn(); const owner = createDropCoordinator({ getSnapshot: () => null, onDrop: accepted });
    const dispose = owner.mount(document);
    const event = drop(document.body, [], ['application/x-od-file-tab', 'text/plain']);
    expect(event.defaultPrevented).toBe(false); expect(accepted).not.toHaveBeenCalled(); dispose();
  });

  it('reports directory entries without uploading zero-byte directory stand-ins', () => {
    const accepted = vi.fn(); const owner = createDropCoordinator({ getSnapshot: () => null, onDrop: accepted });
    const dispose = owner.mount(document);
    const event = new Event('drop', { bubbles: true, cancelable: true });
    const file = new File([], 'folder');
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file], items: [{ kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: true }) }] } });
    document.body.dispatchEvent(event);
    expect(accepted.mock.calls[0]![0]).toMatchObject({ files: [], hasDirectory: true }); dispose();
  });

  it('hands a dropped folder to the editor target that received it, not the global destination', () => {
    const editor = document.createElement('div'); document.body.append(editor);
    const global = vi.fn(); const local = vi.fn();
    const owner = createDropCoordinator({ getSnapshot: () => 'shell', onDrop: global });
    const dispose = owner.mount(document); const unregister = owner.registerTarget(editor, { getSnapshot: () => 'editor-folder', onDrop: local });
    const folder = new File([], 'Brand Kit'); const loose = new File(['a'], 'a.txt');
    const entry = { isDirectory: true, isFile: false, name: 'Brand Kit', fullPath: '/Brand Kit' };
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [folder, loose], items: [
      { kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => entry },
      { kind: 'file', getAsFile: () => loose, webkitGetAsEntry: () => ({ isDirectory: false }) },
    ] } });
    editor.dispatchEvent(event);
    expect(global).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledExactlyOnceWith({ files: [loose], hasDirectory: true, directories: [{ file: folder, entry }] }, 'editor-folder');
    unregister(); dispose();
  });

  it('reports the Option modifier of external file drags only', () => {
    const modifier = vi.fn(); const leave = vi.fn();
    const owner = createDropCoordinator({ getSnapshot: () => null, onDrop: vi.fn(), onDragModifier: modifier, onDragLeaveWindow: leave });
    const dispose = owner.mount(document);
    const over = (types: string[], altKey: boolean) => {
      const event = new Event('dragover', { bubbles: true, cancelable: true });
      Object.defineProperties(event, { dataTransfer: { value: { types, dropEffect: 'none' } }, altKey: { value: altKey } });
      document.body.dispatchEvent(event);
    };
    over(['Files'], true); over(['Files'], false); over(['application/x-od-file-tab'], true);
    expect(modifier.mock.calls).toEqual([[true], [false]]);
    const exit = new Event('dragleave', { bubbles: true }); Object.defineProperty(exit, 'relatedTarget', { value: null });
    document.body.dispatchEvent(exit);
    const inside = new Event('dragleave', { bubbles: true }); Object.defineProperty(inside, 'relatedTarget', { value: document.body });
    document.body.dispatchEvent(inside);
    expect(leave).toHaveBeenCalledTimes(1);
    dispose(); over(['Files'], true); expect(modifier).toHaveBeenCalledTimes(2);
  });
});
