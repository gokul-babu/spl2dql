import { Component, type ReactNode, Suspense, useEffect, useRef } from 'react';
import { AboutDialog, SettingsDialog, ShortcutsDialog } from './components/Dialogs.tsx';
import { Header } from './components/Header.tsx';
import { titleOf, VIEW_LABEL } from './lib/route.ts';
import { useApp } from './lib/store.ts';
import { BatchView, DashboardsView, MappingView, ReferenceView, ViewFallback } from './views/lazy.tsx';
import { TranslateView } from './views/TranslateView.tsx';

/** A view whose code could not be loaded (no connection and no cached copy) says so instead of going blank. */
class ViewBoundary extends Component<{ children: ReactNode; view: string }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidUpdate(prev: { view: string }) {
    if (prev.view !== this.props.view && this.state.failed) this.setState({ failed: false });
  }
  override render() {
    if (this.state.failed) {
      return (
        <p className="px-4 py-6 text-sm" role="alert">
          <span className="mark-error" aria-hidden="true">
            ■{' '}
          </span>
          This page could not be loaded. Reload to try again.
        </p>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const view = useApp((s) => s.view);
  const theme = useApp((s) => s.theme);
  const fontSize = useApp((s) => s.fontSize);
  const announce = useApp((s) => s.announce);
  const setDialog = useApp((s) => s.setDialog);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--code-size', `${fontSize}px`);
  }, [fontSize]);

  useEffect(() => {
    document.title = titleOf(view);
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === '?' && !(t?.closest('.cm-editor') || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT')) {
        e.preventDefault();
        setDialog('shortcuts');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setDialog]);

  return (
    <div className="flex h-full flex-col">
      {/* A button, not a link: the address fragment names views, so it must not change. */}
      <button type="button" className="control primary skip-link" onClick={() => main.current?.focus()}>
        Skip to content
      </button>
      <Header />
      <main ref={main} id="main" tabIndex={-1} className="min-h-0 flex-1" aria-label={VIEW_LABEL[view]}>
        <ViewBoundary view={view}>
          <Suspense fallback={<ViewFallback />}>
            {view === 'translate' && <TranslateView />}
            {view === 'batch' && <BatchView />}
            {view === 'dashboards' && <DashboardsView />}
            {view === 'mapping' && <MappingView />}
            {view === 'reference' && <ReferenceView />}
          </Suspense>
        </ViewBoundary>
      </main>
      <div className="sr-only" aria-live="polite" data-testid="live">
        {announce}
      </div>
      <SettingsDialog />
      <ShortcutsDialog />
      <AboutDialog />
    </div>
  );
}
