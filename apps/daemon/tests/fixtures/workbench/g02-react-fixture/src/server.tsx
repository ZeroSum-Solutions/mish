import { renderToString } from 'react-dom/server';
import App from './App';

// Static preview: the same App rendered to HTML without a window.
export function renderPreview(): string {
  return renderToString(<App />);
}
