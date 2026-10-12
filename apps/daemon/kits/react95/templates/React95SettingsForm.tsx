import React, { useEffect, useId, useRef, useState } from 'react';
import styled, { ThemeProvider } from 'styled-components';
import { Button } from './react95.Button.Button';
import { Checkbox } from './react95.Checkbox.Checkbox';
import { GroupBox } from './react95.GroupBox.GroupBox';
import { Radio } from './react95.Radio.Radio';
import { TextInput } from './react95.TextInput.TextInput';
import { Window, WindowContent, WindowHeader } from './react95.Window.Window';
import highContrast from './react95.common.themes.highContrast';
import original from './react95.common.themes.original';

/**
 * Windows95 settings form (React95 kit template, react-source/v1).
 *
 * A responsive form/control template with every control state the kit has to
 * prove: enabled, disabled, focus, invalid, saving, success and error with
 * retry. Saving goes through the `onSave` action the project supplies; the
 * default is a declared local fixture (no network, no backend claim). Styles
 * are scoped under the template's root; the theme is a project-owned prop and
 * the font is the platform's system sans-serif (no font file ships).
 */
export type React95ThemeName = 'original' | 'highContrast';
const THEMES = { original, highContrast } as const;

export interface SettingsValues { name: string; email: string; updates: boolean; density: 'comfortable' | 'compact' }
export type SaveSettings = (values: SettingsValues, options: { simulateFailure: boolean }) => Promise<void>;

/** Declared fixture action: resolves on the next tick, or rejects when the user asks for a simulated failure. */
export const fixtureSave: SaveSettings = (_values, { simulateFailure }) => new Promise((resolve, reject) => {
  setTimeout(() => (simulateFailure ? reject(new Error('Simulated server error')) : resolve()), 0);
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const Scope = styled.div`
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 16px;
  line-height: 1.4;
  color: ${({ theme }) => theme.materialText};
  background: ${({ theme }) => theme.desktopBackground};
  padding: 24px;
  & *,
  & *::before,
  & *::after {
    box-sizing: border-box;
  }
  /* Upstream text inputs remove their focus outline; the template restores a visible one. */
  & input:focus,
  & textarea:focus {
    outline: 2px dotted ${({ theme }) => theme.canvasText};
    outline-offset: -4px;
  }
  @media (max-width: 767px) {
    padding: 8px;
  }
  /* Every pointer target is at least 44px at every width (upstream sizes are 20-36px). */
  & button {
    min-height: 44px;
    min-width: 44px;
  }
  & input[type='text'],
  & input[type='email'] {
    min-height: 44px;
  }
  & label {
    min-height: 44px;
  }
`;

const FormWindow = styled(Window)`
  display: block;
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 1rem;
  font-weight: bold;
`;

const Fields = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  @media (max-width: 767px) {
    grid-template-columns: 1fr;
  }
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
`;

const Label = styled.label`
  font-weight: bold;
`;

const Hint = styled.p`
  margin: 0;
  font-size: 0.875rem;
`;

const FieldError = styled.p`
  margin: 0;
  font-weight: bold;
`;

const Choices = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0 24px;
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
  @media (max-width: 767px) {
    & > button {
      flex: 1 1 100%;
    }
  }
`;

const Message = styled.div`
  margin-top: 16px;
  padding: 8px;
  border: 2px solid ${({ theme }) => theme.borderDarkest};
  background: ${({ theme }) => theme.canvas};
  color: ${({ theme }) => theme.canvasText};
`;

export interface React95SettingsFormProps {
  theme?: React95ThemeName;
  onSave?: SaveSettings;
}

type Phase = 'editing' | 'saving' | 'saved' | 'failed';

export default function React95SettingsForm({ theme = 'original', onSave = fixtureSave }: React95SettingsFormProps) {
  const ids = useId();
  const id = (name: string) => `${ids}-${name}`;
  const [values, setValues] = useState<SettingsValues>({ name: 'Ada', email: '', updates: true, density: 'comfortable' });
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [phase, setPhase] = useState<Phase>('editing');
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'name' | 'email' | 'retry' | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === 'name') nameRef.current?.focus();
    else if (target === 'email') emailRef.current?.focus();
    else if (target === 'retry') retryRef.current?.focus();
  });

  const update = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    setValues(current => ({ ...current, [key]: value }));
    if (phase !== 'saving') setPhase('editing');
  };

  const validate = (): boolean => {
    const next: { name?: string; email?: string } = {};
    if (!values.name.trim()) next.name = 'Enter a display name.';
    if (!EMAIL.test(values.email.trim())) next.email = 'Enter an email address such as name@example.com.';
    setErrors(next);
    if (next.name) focusAfter.current = 'name';
    else if (next.email) focusAfter.current = 'email';
    return !next.name && !next.email;
  };

  const save = async () => {
    if (!validate()) { setPhase('editing'); return; }
    setPhase('saving');
    try {
      await onSave(values, { simulateFailure });
      if (mounted.current) setPhase('saved');
    } catch {
      if (!mounted.current) return;
      setPhase('failed');
      focusAfter.current = 'retry';
    }
  };

  const describedBy = (field: 'name' | 'email', hint?: string) => [hint, errors[field] ? id(`${field}-error`) : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <ThemeProvider theme={THEMES[theme]}>
      <Scope data-od-react95="settings-form">
        <FormWindow role="region" aria-labelledby={id('title')}>
          <WindowHeader>
            <Title id={id('title')}>Account settings</Title>
          </WindowHeader>
          <WindowContent>
            <form noValidate aria-labelledby={id('title')} onSubmit={event => { event.preventDefault(); void save(); }}>
              <GroupBox label="Profile">
                <Fields>
                  <Field>
                    <Label htmlFor={id('name')}>Display name</Label>
                    <TextInput
                      id={id('name')}
                      ref={nameRef}
                      fullWidth
                      autoComplete="name"
                      value={values.name}
                      aria-invalid={errors.name ? true : undefined}
                      aria-describedby={describedBy('name')}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => update('name', event.target.value)}
                    />
                    {errors.name ? <FieldError id={id('name-error')}>Error: {errors.name}</FieldError> : null}
                  </Field>
                  <Field>
                    <Label htmlFor={id('email')}>Email</Label>
                    <TextInput
                      id={id('email')}
                      ref={emailRef}
                      type="email"
                      fullWidth
                      autoComplete="email"
                      value={values.email}
                      aria-invalid={errors.email ? true : undefined}
                      aria-describedby={describedBy('email', id('email-hint'))}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) => update('email', event.target.value)}
                    />
                    <Hint id={id('email-hint')}>Used only for account notices.</Hint>
                    {errors.email ? <FieldError id={id('email-error')}>Error: {errors.email}</FieldError> : null}
                  </Field>
                  <Field>
                    <Label htmlFor={id('account')}>Account ID</Label>
                    <TextInput id={id('account')} fullWidth disabled value="ACC-0042" aria-describedby={id('account-hint')} />
                    <Hint id={id('account-hint')}>Assigned by the system; it cannot be changed.</Hint>
                  </Field>
                </Fields>
              </GroupBox>
              <GroupBox label="Preferences">
                <Checkbox label="Email me product updates" checked={values.updates} onChange={event => update('updates', event.target.checked)} />
                <Checkbox label="Beta features (not available on this plan)" checked={false} disabled />
                <Choices role="radiogroup" aria-label="Layout density">
                  <Radio name={id('density')} value="comfortable" label="Comfortable" checked={values.density === 'comfortable'} onChange={() => update('density', 'comfortable')} />
                  <Radio name={id('density')} value="compact" label="Compact" checked={values.density === 'compact'} onChange={() => update('density', 'compact')} />
                </Choices>
              </GroupBox>
              <GroupBox label="Test the save action">
                <Checkbox label="Simulate a server error on save" checked={simulateFailure} onChange={event => setSimulateFailure(event.target.checked)} />
              </GroupBox>
              <Actions>
                <Button type="button" disabled={phase === 'saving'} onClick={() => { setValues({ name: 'Ada', email: '', updates: true, density: 'comfortable' }); setErrors({}); setPhase('editing'); }}>
                  Reset
                </Button>
                <Button type="submit" primary disabled={phase === 'saving'}>
                  {phase === 'saving' ? 'Saving…' : 'Save'}
                </Button>
              </Actions>
              <div role="status" aria-live="polite">
                {phase === 'saving' ? <Message>Saving your settings…</Message> : null}
                {phase === 'saved' ? <Message>Saved: your settings are up to date.</Message> : null}
              </div>
              {phase === 'failed' ? (
                <Message role="alert">
                  Error: the settings could not be saved. Your changes are kept.{' '}
                  <Button ref={retryRef} type="button" onClick={() => void save()}>Retry</Button>
                </Message>
              ) : null}
            </form>
          </WindowContent>
        </FormWindow>
      </Scope>
    </ThemeProvider>
  );
}
