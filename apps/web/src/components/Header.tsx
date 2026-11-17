import { Info, Settings } from 'lucide-react';
import type { MouseEvent } from 'react';
import { hashOf, VIEW_LABEL, VIEWS, type View } from '../lib/route.ts';
import { useApp } from '../lib/store.ts';
import { preloadView } from '../views/lazy.tsx';

/** What the tool is, in one sentence. The same words are in index.html (the static shell). */
export const TAGLINE = 'Translates Splunk searches to Dynatrace DQL, dashboards included.';

/**
 * The name, what it does, the views and the three header controls. index.html carries a static copy
 * of this markup so the first paint already shows it; keep the two in step.
 */
export function Header() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const setDialog = useApp((s) => s.setDialog);

  const go = (e: MouseEvent<HTMLAnchorElement>, v: View) => {
    // A modified click opens the view in a new tab, as with any link.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setView(v);
  };

  return (
    <header className="app-header">
      <h1 className="app-name">spl2dql</h1>
      <p className="app-line">{TAGLINE}</p>
      <nav aria-label="Views" className="app-nav">
        {VIEWS.map((v) => (
          <a
            key={v}
            href={v === 'translate' ? './' : hashOf(v)}
            className={`control nav-link ${view === v ? '' : 'quiet'}`}
            aria-current={view === v ? 'page' : undefined}
            onClick={(e) => go(e, v)}
            onPointerEnter={() => preloadView(v)}
            onFocus={() => preloadView(v)}
          >
            {VIEW_LABEL[v]}
          </a>
        ))}
      </nav>
      <div className="app-tools">
        <button type="button" className="control quiet" popoverTarget="mode-info" data-testid="mode">
          <span className="mark-exact" aria-hidden="true">
            ●
          </span>
          Runs in your browser
        </button>
        <div id="mode-info" popover="auto" className="m-auto max-w-sm rounded-[6px] border border-line bg-surface p-4 text-sm text-ink shadow-lg">
          <p>Everything happens in this browser. No search, mapping or result leaves this device.</p>
        </div>
        <button type="button" className="control quiet icon-button" aria-label="About" title="About" onClick={() => setDialog('about')}>
          <Info size={18} aria-hidden />
        </button>
        <button type="button" className="control quiet icon-button" aria-label="Settings" title="Settings" onClick={() => setDialog('settings')}>
          <Settings size={18} aria-hidden />
        </button>
      </div>
    </header>
  );
}
