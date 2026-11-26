import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Fonts ship inside the bundle: latin subset, and only the weights the console uses.
import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-semi-condensed/latin-500.css';
import '@fontsource/barlow-semi-condensed/latin-600.css';
import '@fontsource/barlow-semi-condensed/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';

// Order matters: shared tokens, then console foundations, then the primitives.
// Feature stylesheets arrive with their components and so always come after.
import '../shared/tokens.css';
import './shell/base.css';
import './lib/ui.css';
import './shell/shell.css';
import { App } from './App';
import { initTheme } from './lib/theme';

initTheme();

const root = document.getElementById('root');
if (!root) throw new Error('Switchyard console: #root is missing from the page.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
