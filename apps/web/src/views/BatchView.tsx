import { type Confidence, safeFileName } from '@spl2dql/core';
import { zipSync } from 'fflate';
import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cap, LIMIT, MoreLine } from '../components/Capped.tsx';
import { DropZone, IngestSummary } from '../components/DropZone.tsx';
import { type BatchRow, CONFIDENCE_WORD, noteCount, useApp } from '../lib/store.ts';

/** The saved time range and schedule of a search from savedsearches.conf, in one line. */
function savedLine(r: BatchRow): string {
  const parts: string[] = [];
  if (r.disabled) parts.push('Switched off in Splunk');
  if (r.earliest !== undefined || r.latest !== undefined) parts.push(`${r.earliest ?? '…'} to ${r.latest ?? 'now'}`);
  if (r.schedule !== undefined) parts.push(`runs ${r.schedule}`);
  return parts.join(' · ');
}
const CONF_CLASS: Record<Confidence, string> = { high: 'mark-exact', review: 'mark-check', low: 'mark-untranslated', none: 'mark-untranslated' };
const CONF_MARK: Record<Confidence, string> = { high: '●', review: '▲', low: '■', none: '■' };
const ORDER: Confidence[] = ['none', 'low', 'review', 'high'];

export function BatchView() {
  const rows = useApp((s) => s.batch);
  const setSpl = useApp((s) => s.setSpl);
  const setView = useApp((s) => s.setView);
  const [filter, setFilter] = useState<Confidence | 'all'>('all');

  const shown = useMemo(
    () =>
      rows
        .filter((r) => filter === 'all' || r.result.confidence === filter)
        .sort((a, b) => ORDER.indexOf(a.result.confidence) - ORDER.indexOf(b.result.confidence) || (a.name < b.name ? -1 : 1)),
    [rows, filter],
  );

  const download = () => {
    const taken = new Set<string>(['report.json']);
    const files: Record<string, Uint8Array> = {};
    const enc = new TextEncoder();
    const report = rows.map((r) => {
      const file = `${safeFileName(r.name, taken)}.dql`;
      files[file] = enc.encode(`${r.result.dql}\n`);
      return {
        name: r.name,
        origin: r.origin,
        file,
        confidence: r.result.confidence,
        ...(r.earliest !== undefined ? { earliest: r.earliest } : {}),
        ...(r.latest !== undefined ? { latest: r.latest } : {}),
        ...(r.schedule !== undefined ? { schedule: r.schedule } : {}),
        ...(r.disabled ? { disabled: true } : {}),
        spl: r.spl,
        dql: r.result.dql,
        notes: r.result.diagnostics,
      };
    });
    files['report.json'] = enc.encode(`${JSON.stringify({ searches: report }, null, 2)}\n`);
    const blob = new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'spl2dql-results.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const counts = useMemo(() => {
    const c: Record<Confidence, number> = { high: 0, review: 0, low: 0, none: 0 };
    for (const r of rows) c[r.result.confidence]++;
    return c;
  }, [rows]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <DropZone title="Drop saved searches here" compact={rows.length > 0} sample={rows.length === 0}>
          <p>
            .spl and .txt files (one search each), savedsearches.conf with each search's saved time range, CSV files with a "search" column — or a whole Splunk
            app folder. macros.conf, props.conf, eventtypes.conf and tags.conf in the same drop are read into the mapping first. Files are read in this browser
            and never uploaded.
          </p>
        </DropZone>
        <IngestSummary here="batch" />
        {rows.length > 0 && (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <p className="text-sm">
                {rows.length} searches: {counts.high} exact, {counts.review} need review, {counts.low} incomplete, {counts.none} not translated
              </p>
              <label className="ml-auto flex items-center gap-2 text-sm">
                Show
                <select className="field" value={filter} onChange={(e) => setFilter(e.target.value as Confidence | 'all')}>
                  <option value="all">All</option>
                  {ORDER.map((c) => (
                    <option key={c} value={c}>
                      {CONFIDENCE_WORD[c]}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="control primary" onClick={download}>
                <Download size={16} aria-hidden />
                Download results
              </button>
            </div>
            <table className="mt-3 w-full border-collapse bg-surface text-sm" data-testid="batch-table">
              <thead>
                <tr className="text-left">
                  <th className="border-b border-line px-3 py-2">Search</th>
                  <th className="border-b border-line px-3 py-2">Confidence</th>
                  <th className="hidden border-b border-line px-3 py-2 min-[600px]:table-cell">Notes</th>
                  <th className="border-b border-line px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {cap(shown, LIMIT.batch).map((r) => (
                  <tr key={r.origin}>
                    <td className="border-b border-line px-3 py-2 [overflow-wrap:anywhere]">
                      {r.name}
                      <span className="block text-xs text-muted">{r.origin}</span>
                      {savedLine(r) !== '' && <span className="block text-xs text-muted">{savedLine(r)}</span>}
                    </td>
                    <td className="border-b border-line px-3 py-2 min-[600px]:whitespace-nowrap">
                      <span className={CONF_CLASS[r.result.confidence]} aria-hidden="true">
                        {CONF_MARK[r.result.confidence]}{' '}
                      </span>
                      {CONFIDENCE_WORD[r.result.confidence]}
                    </td>
                    <td className="hidden border-b border-line px-3 py-2 min-[600px]:table-cell">{noteCount(r.result.diagnostics)}</td>
                    <td className="border-b border-line px-3 py-2 text-right">
                      <button
                        type="button"
                        className="control"
                        onClick={() => {
                          setSpl(r.spl);
                          setView('translate');
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <MoreLine total={shown.length} limit={LIMIT.batch} noun={shown.length === 1 ? 'search' : 'searches'} download className="mt-3" />
          </>
        )}
      </div>
    </div>
  );
}
