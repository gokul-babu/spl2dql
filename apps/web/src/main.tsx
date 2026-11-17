import './editor/csp-styles.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';
import { viewFromHash } from './lib/route.ts';
import { readShareFromHash } from './lib/share.ts';
import { useApp } from './lib/store.ts';
import { appScript, SERVICE_WORKER_SCRIPT } from './lib/trusted.ts';

/**
 * The address decides the view; a share link (#q=…) also brings its search. A share link is applied
 * when it arrives (on load, or pasted into the address bar of an open tab); coming Back to it does
 * not undo the edits made since.
 */
let appliedShare = '';
function followAddress(): void {
  const { hash } = globalThis.location;
  if (hash.startsWith('#q=') && hash !== appliedShare) {
    appliedShare = hash;
    const shared = readShareFromHash(hash);
    if (shared !== undefined) useApp.getState().setSpl(shared);
  }
  useApp.getState().showView(viewFromHash(hash));
}
followAddress();
globalThis.addEventListener('popstate', followAddress);
globalThis.addEventListener('hashchange', followAddress);

// Installable and usable with no connection.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  try {
    navigator.serviceWorker.register(appScript(SERVICE_WORKER_SCRIPT)).catch(() => undefined);
  } catch {
    // A browser that refuses the worker still runs the app; it just does not start offline.
  }
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
