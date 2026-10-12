import React, { useId, useState } from 'react';

/**
 * The isolated catalogue preview of one React95 template (not part of any
 * unit). It renders inside the sandboxed preview document only: the theme
 * switch below changes the template's own project-owned theme prop, never the
 * host application's chrome.
 */
type ThemeName = 'original' | 'highContrast';
export interface PreviewProps { Template: React.ComponentType<{ theme?: ThemeName }> }

export function Preview({ Template }: PreviewProps) {
  const [theme, setTheme] = useState<ThemeName>('original');
  const name = useId();
  return (
    <>
      <fieldset className="od-preview-themes">
        <legend>Kit theme</legend>
        {(['original', 'highContrast'] as const).map(option => (
          <label key={option}>
            <input type="radio" name={name} value={option} checked={theme === option} onChange={() => setTheme(option)} />
            {option === 'original' ? 'Original' : 'High contrast'}
          </label>
        ))}
      </fieldset>
      <Template theme={theme} />
    </>
  );
}
