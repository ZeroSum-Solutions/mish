import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import styled, { ThemeProvider } from 'styled-components';
import { AppBar } from './react95.AppBar.AppBar';
import { Button } from './react95.Button.Button';
import { MenuList, MenuListItem } from './react95.MenuList.MenuList';
import { Separator } from './react95.Separator.Separator';
import { TextInput } from './react95.TextInput.TextInput';
import { Toolbar } from './react95.Toolbar.Toolbar';
import { Window, WindowContent, WindowHeader } from './react95.Window.Window';
import highContrast from './react95.common.themes.highContrast';
import original from './react95.common.themes.original';

/**
 * Windows95 application window (React95 kit template, react-source/v1).
 *
 * The upstream Window draws a resize handle and a close button but implements
 * neither; this template supplies them: close and reopen from the taskbar,
 * pointer and keyboard resizing, focus handling and a keyboard-operable File
 * menu. Every style is scoped under the template's own root, so the project's
 * page keeps its own styles; the theme is a prop the project chooses.
 * The font is the platform's system sans-serif: no font file ships with this
 * unit (the upstream pixel font is CC BY-SA 3.0 and stays opt-in).
 */
export type React95ThemeName = 'original' | 'highContrast';
const THEMES = { original, highContrast } as const;

const MIN = { width: 280, height: 200 };
const MAX = { width: 960, height: 720 };
const STEP = 16;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

const Desktop = styled.div`
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 16px;
  line-height: 1.4;
  color: ${({ theme }) => theme.materialText};
  background: ${({ theme }) => theme.desktopBackground};
  min-height: 420px;
  display: flex;
  flex-direction: column;
  & *,
  & *::before,
  & *::after {
    box-sizing: border-box;
  }
  & [role='menuitem']:focus {
    outline: 2px dotted ${({ theme }) => theme.materialTextInvert};
    outline-offset: -4px;
    color: ${({ theme }) => theme.materialTextInvert};
    background: ${({ theme }) => theme.hoverBackground};
  }
  & [data-od-resize]:focus {
    outline: 2px dotted ${({ theme }) => theme.materialText};
  }
  & input:focus,
  & textarea:focus {
    outline: 2px dotted ${({ theme }) => theme.canvasText};
    outline-offset: -4px;
  }
  /* Every pointer target is at least 44px at every width (upstream sizes are 27-36px). */
  & button {
    min-height: 44px;
    min-width: 44px;
  }
  & [role='menuitem'] {
    min-height: 44px;
  }
  & textarea {
    min-height: 44px;
  }
  & [data-od-resize] {
    width: 44px;
    height: 44px;
    bottom: 4px;
    right: 4px;
  }
`;

const Workspace = styled.div`
  flex: 1;
  padding: 24px;
  @media (max-width: 767px) {
    padding: 8px;
  }
`;

const AppWindow = styled(Window)`
  display: flex;
  flex-direction: column;
  width: var(--od-window-width);
  height: var(--od-window-height);
  max-width: 100%;
  @media (max-width: 767px) {
    width: 100%;
    height: auto;
    min-height: 320px;
    & [data-od-resize] {
      display: none;
    }
  }
`;

const Header = styled(WindowHeader)`
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: auto;
  min-height: 48px;
  line-height: 1.2;
  gap: 8px;
  /* Upstream inactive title colors fall below 4.5:1; the inactive state keeps
     the bevel and reads in the material colors instead. */
  &[data-od-active='false'] {
    color: ${({ theme }) => theme.materialText};
    background: ${({ theme }) => theme.material};
  }
`;

const Title = styled.h2`
  margin: 0;
  font-size: 1rem;
  font-weight: bold;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const MenuAnchor = styled.div`
  position: relative;
`;

const Menu = styled(MenuList)`
  position: absolute;
  left: 0;
  top: 100%;
  z-index: 2;
  min-width: 180px;
`;

const Body = styled(WindowContent)`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Label = styled.label`
  font-weight: bold;
`;

const Status = styled.p`
  margin: 0;
  padding: 2px 8px;
`;

const Taskbar = styled(AppBar)`
  & > div {
    gap: 8px;
  }
`;

export interface React95WindowAppProps {
  /** Project-owned theme choice; the host application's own chrome is never restyled. */
  theme?: React95ThemeName;
  title?: string;
  initialText?: string;
}

export default function React95WindowApp({ theme = 'original', title = 'Notepad', initialText = 'Hello from Windows95.' }: React95WindowAppProps) {
  const ids = useId();
  const titleId = `${ids}-title`;
  const menuId = `${ids}-menu`;
  const textId = `${ids}-text`;
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [size, setSize] = useState({ width: 480, height: 320 });
  const [text, setText] = useState(initialText);
  const [saved, setSaved] = useState(true);
  const windowRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLSpanElement>(null);
  const fileButtonRef = useRef<HTMLButtonElement>(null);
  const taskButtonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const focusAfter = useRef<'window' | 'taskbar' | 'file' | null>(null);

  // Focus moves only after the state that makes its target exist has rendered.
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === 'window') fileButtonRef.current?.focus();
    else if (target === 'taskbar') taskButtonRef.current?.focus();
    else if (target === 'file') fileButtonRef.current?.focus();
  });
  useEffect(() => { if (menuOpen) itemRefs.current[0]?.focus(); }, [menuOpen]);

  const closeWindow = useCallback(() => {
    setMenuOpen(false);
    setOpen(false);
    focusAfter.current = 'taskbar';
  }, []);
  const toggleFromTaskbar = useCallback(() => {
    if (open) { closeWindow(); return; }
    setOpen(true);
    setActive(true);
    focusAfter.current = 'window';
  }, [open, closeWindow]);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    focusAfter.current = 'file';
  }, []);
  const choose = useCallback((action: 'new' | 'save' | 'close') => {
    if (action === 'close') { closeWindow(); return; }
    if (action === 'new') { setText(''); setSaved(false); }
    if (action === 'save') setSaved(true);
    closeMenu();
  }, [closeWindow, closeMenu]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const items = itemRefs.current.filter((item): item is HTMLLIElement => item !== null);
    const index = items.findIndex(item => item === document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    } else if (event.key === 'Tab') {
      setMenuOpen(false);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    }
  };
  const onFileKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setMenuOpen(true); }
  };

  // Consumer-owned resizing: the upstream handle is decorative, so it becomes a
  // keyboard slider and a pointer drag target here. Listeners are removed on
  // release and on unmount.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => { dragCleanup.current?.(); }, []);
  useEffect(() => {
    const handle = resizeRef.current;
    if (!open || !handle) return undefined;
    handle.setAttribute('data-od-resize', '');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', 'Resize window');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-valuemin', String(MIN.width));
    handle.setAttribute('aria-valuemax', String(MAX.width));
    const onKeyDown = (event: KeyboardEvent) => {
      const step = event.shiftKey ? STEP * 4 : STEP;
      const delta = { ArrowRight: [step, 0], ArrowLeft: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step] }[event.key];
      if (!delta) return;
      event.preventDefault();
      setSize(current => ({ width: clamp(current.width + delta[0]!, MIN.width, MAX.width), height: clamp(current.height + delta[1]!, MIN.height, MAX.height) }));
    };
    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      dragCleanup.current?.();
      const start = { x: event.clientX, y: event.clientY };
      const from = { ...sizeRef.current };
      const view = handle.ownerDocument.defaultView!;
      const onMove = (move: PointerEvent) => {
        setSize({ width: clamp(from.width + move.clientX - start.x, MIN.width, MAX.width), height: clamp(from.height + move.clientY - start.y, MIN.height, MAX.height) });
      };
      const stop = () => {
        view.removeEventListener('pointermove', onMove);
        view.removeEventListener('pointerup', stop);
        view.removeEventListener('pointercancel', stop);
        dragCleanup.current = null;
      };
      view.addEventListener('pointermove', onMove);
      view.addEventListener('pointerup', stop);
      view.addEventListener('pointercancel', stop);
      dragCleanup.current = stop;
    };
    handle.addEventListener('keydown', onKeyDown);
    handle.addEventListener('pointerdown', onPointerDown);
    return () => {
      handle.removeEventListener('keydown', onKeyDown);
      handle.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);
  useEffect(() => {
    resizeRef.current?.setAttribute('aria-valuenow', String(size.width));
    resizeRef.current?.setAttribute('aria-valuetext', `${size.width} by ${size.height} pixels`);
  }, [size, open]);

  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setActive(false); setMenuOpen(false); }
  };

  return (
    <ThemeProvider theme={THEMES[theme]}>
      <Desktop data-od-react95="window-app">
        <Workspace>
          {open ? (
            <AppWindow
              ref={windowRef}
              resizable
              resizeRef={resizeRef}
              role="region"
              aria-labelledby={titleId}
              onFocus={() => setActive(true)}
              onBlur={onBlur}
              onMouseDown={() => setActive(true)}
              style={{ '--od-window-width': `${size.width}px`, '--od-window-height': `${size.height}px` } as React.CSSProperties}
            >
              <Header active={active} data-od-active={String(active)}>
                <Title id={titleId}>{title}</Title>
                <Button aria-label={`Close ${title}`} onClick={closeWindow}>
                  <span aria-hidden="true">×</span>
                </Button>
              </Header>
              <Toolbar>
                <MenuAnchor>
                  <Button
                    ref={fileButtonRef}
                    variant="menu"
                    size="sm"
                    active={menuOpen}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-controls={menuOpen ? menuId : undefined}
                    onClick={() => setMenuOpen(value => !value)}
                    onKeyDown={onFileKeyDown}
                  >
                    File
                  </Button>
                  {menuOpen ? (
                    <Menu id={menuId} aria-label="File" onKeyDown={onMenuKeyDown}>
                      <MenuListItem ref={node => { itemRefs.current[0] = node; }} tabIndex={-1} onClick={() => choose('new')}>New</MenuListItem>
                      <MenuListItem ref={node => { itemRefs.current[1] = node; }} tabIndex={-1} onClick={() => choose('save')}>Save</MenuListItem>
                      <Separator as="li" role="separator" />
                      <MenuListItem ref={node => { itemRefs.current[2] = node; }} tabIndex={-1} onClick={() => choose('close')}>Close window</MenuListItem>
                    </Menu>
                  ) : null}
                </MenuAnchor>
              </Toolbar>
              <Body>
                <Label htmlFor={textId}>Document text</Label>
                <TextInput
                  id={textId}
                  multiline
                  rows={6}
                  fullWidth
                  value={text}
                  onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => { setText(event.target.value); setSaved(false); }}
                />
              </Body>
              <Status role="status">{saved ? 'All changes saved' : 'Unsaved changes'}</Status>
            </AppWindow>
          ) : null}
        </Workspace>
        <Taskbar position="relative" aria-label="Taskbar">
          <Toolbar>
            <Button ref={taskButtonRef} active={open} aria-pressed={open} onClick={toggleFromTaskbar}>
              {title}
            </Button>
          </Toolbar>
        </Taskbar>
      </Desktop>
    </ThemeProvider>
  );
}
