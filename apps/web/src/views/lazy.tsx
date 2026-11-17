import { type ComponentType, lazy, useEffect, useState } from 'react';
import type { View } from '../lib/route.ts';

interface Entry {
  preload(): Promise<{ default: ComponentType }>;
  Lazy: ComponentType;
  loaded(): ComponentType | undefined;
}

/**
 * A view that loads on demand. Once its code has arrived it renders directly, so a view that was
 * preloaded (pointing at its link is enough) never shows the fallback.
 */
function entry(load: () => Promise<ComponentType>): Entry {
  let done: ComponentType | undefined;
  let pending: Promise<{ default: ComponentType }> | undefined;
  const preload = () => {
    pending ??= load().then((c) => {
      done = c;
      return { default: c };
    });
    // A failed load (no connection, no cached copy) may be tried again on the next visit.
    pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
  return { preload, Lazy: lazy(preload), loaded: () => done };
}

function Show(props: { of: Entry }) {
  const Loaded = props.of.loaded();
  const Lazy = props.of.Lazy;
  return Loaded ? <Loaded /> : <Lazy />;
}

const batch = entry(() => import('./BatchView.tsx').then((m) => m.BatchView));
const dashboards = entry(() => import('./DashboardsView.tsx').then((m) => m.DashboardsView));
const mapping = entry(() => import('./MappingView.tsx').then((m) => m.MappingView));
const reference = entry(() => import('./ReferenceView.tsx').then((m) => m.ReferenceView));

export function BatchView() {
  return <Show of={batch} />;
}
export function DashboardsView() {
  return <Show of={dashboards} />;
}
export function MappingView() {
  return <Show of={mapping} />;
}
export function ReferenceView() {
  return <Show of={reference} />;
}

const BY_VIEW: Partial<Record<View, Entry>> = { batch, dashboards, mapping, reference };

/** Starts loading a view's code ahead of the click. */
export function preloadView(view: View): void {
  BY_VIEW[view]?.preload().catch(() => undefined);
}

/**
 * Shown while a view's code loads. Empty at first, so a fast load does not flash; a word appears
 * only when the wait is long enough to notice.
 */
export function ViewFallback() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="h-full bg-canvas px-4 py-6 text-sm text-muted" aria-busy="true">
      {slow ? 'Loading…' : ''}
    </div>
  );
}
