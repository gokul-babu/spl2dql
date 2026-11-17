/**
 * The view is part of the URL so Back, Forward and reload work (ADR-030). The fragment carries it,
 * because the page is static: a path would need the host to rewrite every address to index.html.
 *
 *   (no fragment)     Translate
 *   #q=<compressed>   Translate with a shared search (lib/share.ts; unchanged since M4)
 *   #/batch           Batch
 *   #/dashboards      Dashboards
 *   #/mapping         Mapping
 *   #/reference       Reference
 *
 * Anything else opens Translate.
 */
export type View = 'translate' | 'batch' | 'dashboards' | 'mapping' | 'reference';

export const VIEWS: readonly View[] = ['translate', 'batch', 'dashboards', 'mapping', 'reference'];

export const VIEW_LABEL: Record<View, string> = {
  translate: 'Translate',
  batch: 'Batch',
  dashboards: 'Dashboards',
  mapping: 'Mapping',
  reference: 'Reference',
};

export function viewFromHash(hash: string): View {
  const m = /^#\/([a-z]+)$/.exec(hash);
  const name = m?.[1] as View | undefined;
  return name && name !== 'translate' && VIEWS.includes(name) ? name : 'translate';
}

/** The fragment of a view; Translate has none. */
export function hashOf(view: View): string {
  return view === 'translate' ? '' : `#/${view}`;
}

/** The page title names the view. */
export function titleOf(view: View): string {
  return `${VIEW_LABEL[view]} – spl2dql`;
}
