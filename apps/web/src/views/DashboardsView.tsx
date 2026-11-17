import { safeFileName } from '@spl2dql/core';
import { zipSync } from 'fflate';
import {
  ChartArea,
  ChartBar,
  ChartColumn,
  ChartLine,
  ChartPie,
  ChartScatter,
  Copy,
  Download,
  FileText,
  Gauge,
  Hash,
  type LucideIcon,
  Table2,
  Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { cap, LIMIT, MoreLine } from '../components/Capped.tsx';
import { DropZone, IngestSummary } from '../components/DropZone.tsx';
import type { KeptTile } from '../lib/retained.ts';
import { type DashboardRow, TILE_CLASS, TILE_MARK, TILE_WORD, tileStatus, useApp } from '../lib/store.ts';

/** What a tile will draw, as a figure in the layout preview: the preview is a schematic of the dashboard. */
const FIGURE: Readonly<Record<string, LucideIcon>> = {
  lineChart: ChartLine,
  areaChart: ChartArea,
  barChart: ChartColumn,
  categoricalBarChart: ChartBar,
  pieChart: ChartPie,
  scatterplot: ChartScatter,
  gauge: Gauge,
  singleValue: Hash,
  table: Table2,
};

function figureOf(tile: KeptTile): LucideIcon {
  if (tile.outcome === 'manual') return Wrench;
  if (tile.outcome === 'text') return FileText;
  return FIGURE[tile.visualization ?? ''] ?? Table2;
}

function saveFile(name: string, content: BlobPart, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function fileOf(row: DashboardRow, taken: Set<string>): string {
  return `${safeFileName(row.conversion.title, taken)}.json`;
}

/**
 * Splunk dashboards → Dynatrace dashboards. The preview is the converted layout itself: every tile
 * sits where it will sit in Dynatrace and says whether it is live or needs manual work.
 */
export function DashboardsView() {
  const rows = useApp((s) => s.dashboards);
  const [index, setIndex] = useState(0);
  const [tileId, setTileId] = useState<string>();
  const row = rows[Math.min(index, rows.length - 1)];

  // A new set of files starts at its first dashboard; a new dashboard at its first tile that needs work.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the list itself is replaced.
  useEffect(() => {
    setIndex(0);
  }, [rows]);
  useEffect(() => {
    const tiles = row?.conversion.tiles ?? [];
    setTileId((tiles.find((t) => t.outcome === 'manual') ?? tiles.find((t) => t.outcome === 'live') ?? tiles[0])?.id);
  }, [row]);

  const downloadAll = () => {
    const taken = new Set<string>();
    const files: Record<string, Uint8Array> = {};
    const enc = new TextEncoder();
    for (const r of rows) files[fileOf(r, taken)] = enc.encode(`${JSON.stringify(r.conversion.dashboard, null, 2)}\n`);
    saveFile('spl2dql-dashboards.zip', zipSync(files) as Uint8Array<ArrayBuffer>, 'application/zip');
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <DropZone title="Drop Splunk dashboards here" compact={rows.length > 0} sample={rows.length === 0}>
          <p>
            Simple XML and Dashboard Studio files, or a whole Splunk app folder. A panel becomes a live tile only when its search translated completely;
            otherwise the tile keeps the Splunk search and says what is missing. Inputs become dashboard variables.
          </p>
          {rows.length === 0 && (
            <p className="mt-2">
              Add savedsearches.conf and macros.conf from the same app so panels that use them resolve. Files are read in this browser and never uploaded.
            </p>
          )}
        </DropZone>
        <IngestSummary here="dashboards" />

        {row && (
          <div className="mt-6 grid gap-6 min-[900px]:grid-cols-[240px_minmax(0,1fr)]">
            <nav aria-label="Converted dashboards">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="whitespace-nowrap text-sm font-semibold">
                  {rows.length} dashboard{rows.length === 1 ? '' : 's'}
                </h2>
                {rows.length > 1 && (
                  <button type="button" className="control ml-auto" onClick={downloadAll}>
                    <Download size={16} aria-hidden />
                    Download all
                  </button>
                )}
              </div>
              <ul className="mt-2 flex gap-1 overflow-x-auto min-[900px]:flex-col min-[900px]:overflow-visible" data-testid="dashboard-list">
                {cap(rows, LIMIT.dashboards).map((r, i) => {
                  const c = r.conversion.counts;
                  return (
                    <li key={r.origin} className="shrink-0">
                      <button
                        type="button"
                        className={`w-full border px-3 py-2 text-left text-sm ${r === row ? 'border-exact bg-surface' : 'border-transparent hover:border-line'}`}
                        aria-current={r === row ? 'true' : undefined}
                        onClick={() => setIndex(i)}
                      >
                        <span className="block font-semibold">{r.conversion.title}</span>
                        <span className="block text-xs text-muted">
                          <span className="mark-exact" aria-hidden="true">
                            ●
                          </span>{' '}
                          {c.live} converted
                          {c.manual > 0 && (
                            <>
                              {' '}
                              <span className="mark-untranslated" aria-hidden="true">
                                ■
                              </span>{' '}
                              {c.manual} manual
                            </>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <MoreLine total={rows.length} limit={LIMIT.dashboards} noun="dashboards" download className="mt-2" />
            </nav>
            <Detail row={row} tileId={tileId} onTile={setTileId} />
          </div>
        )}
      </div>
    </div>
  );
}

function Detail(props: { row: DashboardRow; tileId: string | undefined; onTile: (id: string) => void }) {
  const { conversion } = props.row;
  const c = conversion.counts;
  const tile = conversion.tiles.find((t) => t.id === props.tileId);
  const layouts = conversion.dashboard.content.layouts;
  const file = fileOf(props.row, new Set());

  return (
    <section aria-label={conversion.title} className="min-w-0" data-testid="dashboard-detail">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{conversion.title}</h2>
          <p className="text-sm" data-testid="dashboard-counts">
            {c.live} converted · {c.manual} need manual work · {c.text} text · {conversion.variables.length} variable
            {conversion.variables.length === 1 ? '' : 's'}
          </p>
        </div>
        <button
          type="button"
          className="control primary ml-auto"
          onClick={() => saveFile(file, `${JSON.stringify(conversion.dashboard, null, 2)}\n`, 'application/json')}
        >
          <Download size={16} aria-hidden />
          Download dashboard
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">
        Import <span className="font-code">{file}</span> in the Dynatrace Dashboards app, or run <span className="font-code">dtctl apply -f {file}</span>
      </p>

      {/* The converted layout on Dynatrace's 24-column grid. */}
      <ul className="tile-grid mt-4" aria-label="Tiles, laid out as in the converted dashboard" data-testid="tile-grid">
        {cap(conversion.tiles, LIMIT.tiles).map((t) => {
          const box = layouts[t.id];
          if (!box) return null;
          const status = tileStatus(t);
          const Figure = figureOf(t);
          return (
            <li key={t.id} style={{ gridColumn: `${box.x + 1} / span ${box.w}`, gridRow: `${box.y + 1} / span ${box.h}` }} className="min-h-0 min-w-0">
              <button
                type="button"
                className={`tile ${t.id === props.tileId ? 'selected' : ''}`}
                aria-pressed={t.id === props.tileId}
                onClick={() => props.onTile(t.id)}
              >
                <span className="block truncate font-semibold">
                  <span className={TILE_CLASS[status]} aria-hidden="true">
                    {TILE_MARK[status]}{' '}
                  </span>
                  {t.title || 'Untitled'}
                </span>
                {/* A one-row tile has room for its title only; its status is in the mark and the detail below. */}
                {box.h > 1 ? (
                  <span className="block truncate text-muted">
                    {TILE_WORD[status]}
                    {t.visualization ? ` · ${t.visualization}` : ''}
                  </span>
                ) : (
                  <span className="sr-only">{TILE_WORD[status]}</span>
                )}
                {box.h >= 4 && (
                  <span className="tile-figure" aria-hidden="true">
                    <Figure size={28} strokeWidth={1.5} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <MoreLine total={conversion.tiles.length} limit={LIMIT.tiles} noun="tiles" download className="mt-2" />

      {tile && <TileDetail tile={tile} />}

      {conversion.variables.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Variables</h3>
          <ul className="mt-2 border-t border-line bg-surface text-sm" data-testid="variables">
            {cap(conversion.variables, LIMIT.list).map((v) => (
              <li key={v.key} className="border-b border-line px-3 py-2">
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-code font-semibold">${v.key}</span>
                  <span>{VARIABLE_WORD[v.type]}</span>
                  <span className="text-muted">
                    replaces <span className="font-code">${v.token}$</span>
                  </span>
                </p>
                {v.notes.length > 0 && (
                  <div className="mt-1">
                    <NoteList notes={v.notes} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <MoreLine total={conversion.variables.length} limit={LIMIT.list} noun="variables" download className="mt-2" />
        </div>
      )}

      {conversion.notes.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Left out of this dashboard</h3>
          <div className="mt-1 text-sm">
            <NoteList notes={conversion.notes} />
          </div>
        </div>
      )}
    </section>
  );
}

const VARIABLE_WORD = { query: 'Filled by a query', csv: 'Fixed list', text: 'Free text' } as const;

function NoteList(props: { notes: readonly string[]; blocking?: boolean }) {
  return (
    <>
      <ul className="space-y-1">
        {cap(props.notes, LIMIT.list).map((n) => (
          <li key={n} className="flex gap-2">
            <span className={props.blocking ? 'mark-untranslated' : 'mark-check'} aria-hidden="true">
              {props.blocking ? '■' : '▲'}
            </span>
            <span>{n}</span>
          </li>
        ))}
      </ul>
      <MoreLine total={props.notes.length} limit={LIMIT.list} noun="notes" className="mt-1" />
    </>
  );
}

function TileDetail(props: { tile: KeptTile }) {
  const { tile } = props;
  const setSpl = useApp((s) => s.setSpl);
  const setView = useApp((s) => s.setView);
  const [copied, setCopied] = useState(false);
  const status = tileStatus(tile);
  const dql = tile.result?.dql ?? '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(dql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the DQL stays selectable.
    }
  };

  return (
    <div className="mt-4 border border-line bg-surface p-4" data-testid="tile-detail">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{tile.title || 'Untitled'}</h3>
        <span className="text-sm">
          <span className={TILE_CLASS[status]} aria-hidden="true">
            {TILE_MARK[status]}{' '}
          </span>
          {TILE_WORD[status]}
          {tile.visualization ? ` · shown as ${tile.visualization}` : ''}
        </span>
        {tile.spl !== undefined && (
          <div className="ml-auto flex flex-wrap gap-2">
            {tile.outcome === 'live' && (
              <button type="button" className="control" onClick={() => void copy()}>
                <Copy size={16} aria-hidden />
                {copied ? 'Copied' : 'Copy DQL'}
              </button>
            )}
            <button
              type="button"
              className="control"
              onClick={() => {
                setSpl(tile.spl ?? '');
                setView('translate');
              }}
            >
              Open in Translate
            </button>
          </div>
        )}
      </div>
      {tile.spl !== undefined && (
        <div className="mt-3 grid gap-4 min-[760px]:grid-cols-2">
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-muted">Splunk SPL</h4>
            <pre className="code-block">{tile.spl}</pre>
          </div>
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-muted">{tile.outcome === 'live' ? 'Dynatrace DQL' : 'DQL so far'}</h4>
            <pre className="code-block">{dql === '' ? 'Nothing could be translated.' : dql}</pre>
          </div>
        </div>
      )}
      {tile.notes.length > 0 && (
        <div className="mt-3 text-sm">
          <h4 className="text-xs font-semibold text-muted">{tile.outcome === 'manual' ? 'What is missing' : 'To check'}</h4>
          <div className="mt-1">
            <NoteList notes={tile.notes} blocking={tile.outcome === 'manual'} />
          </div>
        </div>
      )}
      {tile.outcome === 'text' && tile.notes.length === 0 && <p className="mt-2 text-sm text-muted">A text panel, carried over as a Markdown tile.</p>}
    </div>
  );
}
