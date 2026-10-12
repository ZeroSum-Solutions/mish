import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import App from './App';

// Production client entry: hydrates the static (server-rendered) preview.
hydrateRoot(document.getElementById('root')!, <StrictMode><App /></StrictMode>);
