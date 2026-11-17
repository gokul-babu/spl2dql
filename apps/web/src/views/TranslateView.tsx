import type { EditorView } from '@codemirror/view';
import type { StageResult } from '@spl2dql/core';
import { Copy, Link2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cap, LIMIT, MoreLine } from '../components/Capped.tsx';
import { CodeEditor } from '../components/CodeEditor.tsx';
import { NotesPanel } from '../components/NotesPanel.tsx';
import { Seam } from '../components/Seam.tsx';
import type { LineMarker } from '../editor/extensions.ts';
import { EXAMPLES } from '../lib/examples.ts';
import { lineIndex } from '../lib/lines.ts';
import { shareUrl } from '../lib/share.ts';
import { CONFIDENCE_WORD, STATUS_MARK, STATUS_WORD, useApp } from '../lib/store.ts';
import { preloadView } from './lazy.tsx';

const STATUS_CLASS: Record<StageResult['status'], string> = { exact: 'mark-exact', check: 'mark-check', untranslated: 'mark-untranslated' };
const CONF_CLASS = { high: 'mark-exact', review: 'mark-check', low: 'mark-untranslated', none: 'mark-untranslated' } as const;
const CONF_MARK = { high: '●', review: '▲', low: '■', none: '■' } as const;

/**
 * The DQL pane shows at most this much. The engine allows up to 1,000,000 characters, but a result
 * of about 900,000 measured a 330 ms stall and 56,000 DOM nodes in the editor, so from half that
 * the pane says the result is too long to show; copying still copies all of it (ADR-029).
 */
export const MAX_PANE = 500_000;

const WIDE = '(min-width: 900px)';
function subscribeWide(change: () => void): () => void {
  const q = globalThis.matchMedia?.(WIDE);
  q?.addEventListener('change', change);
  return () => q?.removeEventListener('change', change);
}
/** Two panes side by side (true) or stacked (false). */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => globalThis.matchMedia?.(WIDE).matches ?? true,
    () => true,
  );
}

export function TranslateView() {
  const spl = useApp((s) => s.spl);
  const setSpl = useApp((s) => s.setSpl);
  const result = useApp((s) => s.result);
  const syntax = useApp((s) => s.syntax);
  const mappingUse = useApp((s) => s.mappingUse);
  const failure = useApp((s) => s.failure);
  const active = useApp((s) => s.activeStage);
  const setActive = useApp((s) => s.setActiveStage);
  const earliest = useApp((s) => s.earliest);
  const setEarliest = useApp((s) => s.setEarliest);
  const left = useRef<EditorView | null>(null);
  const right = useRef<EditorView | null>(null);
  const examplesRef = useRef<HTMLSelectElement>(null);
  const [tick, setTick] = useState(0);
  const [copied, setCopied] = useState<'dql' | 'link' | undefined>();
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const wide = useWide();
  const empty = spl.trim() === '';
  const shown = empty ? undefined : result;
  const fullDql = shown?.dql ?? '';
  const tooLong = fullDql.length > MAX_PANE;
  const dql = tooLong ? '' : fullDql;
  const stages = shown?.stages ?? [];
  const splLines = useMemo(() => lineIndex(spl), [spl]);
  const dqlLines = useMemo(() => lineIndex(dql), [dql]);
  const untranslated = stages.filter((s) => s.status === 'untranslated').length;
  const confidence = shown?.confidence;

  const leftMarkers: LineMarker[] = useMemo(
    () =>
      stages.map((s) => ({
        line: splLines.lineOf(s.spl.start),
        mark: STATUS_MARK[s.status],
        cls: STATUS_CLASS[s.status],
        label: `Stage ${s.index + 1}: ${STATUS_WORD[s.status]}`,
      })),
    [stages, splLines],
  );
  const rightMarkers: LineMarker[] = useMemo(
    () =>
      stages.flatMap((s) =>
        s.dql[0]
          ? [
              {
                line: dqlLines.lineOf(s.dql[0].start),
                mark: STATUS_MARK[s.status],
                cls: STATUS_CLASS[s.status],
                label: `From stage ${s.index + 1}: ${STATUS_WORD[s.status]}`,
              },
            ]
          : [],
      ),
    [stages, dqlLines],
  );
  const leftRanges = useMemo(() => {
    const out: { from: number; to: number; cls: string; line?: boolean }[] = [];
    for (const d of shown?.diagnostics ?? []) {
      if (d.severity === 'info' || d.span.end <= d.span.start) continue;
      out.push({ from: d.span.start, to: d.span.end, cls: d.severity === 'error' ? 'cm-diag-error' : 'cm-diag-warning' });
    }
    const st = stages.find((s) => s.index === active);
    if (st)
      for (let l = splLines.lineOf(st.spl.start); l <= splLines.lineOf(Math.max(st.spl.start, st.spl.end - 1)); l++)
        out.push({ from: splLines.startOf(l), to: splLines.startOf(l), cls: 'cm-stage-active', line: true });
    return out;
  }, [shown, stages, active, splLines]);
  const rightRanges = useMemo(() => {
    const st = stages.find((s) => s.index === active);
    return (st?.dql ?? []).flatMap((d) => {
      const out: { from: number; to: number; cls: string; line: boolean }[] = [];
      for (let l = dqlLines.lineOf(d.start); l <= dqlLines.lineOf(Math.max(d.start, d.end - 1)); l++)
        out.push({ from: dqlLines.startOf(l), to: dqlLines.startOf(l), cls: 'cm-stage-active', line: true });
      return out;
    });
  }, [stages, active, dqlLines]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure the seam whenever either text changes.
  useEffect(() => bump(), [bump, dql, spl]);

  const focusStage = useCallback(
    (i: number) => {
      setActive(i);
      const st = stages.find((s) => s.index === i);
      if (!st) return;
      left.current?.dispatch({ selection: { anchor: Math.min(st.spl.start, left.current.state.doc.length) }, scrollIntoView: true });
      const first = st.dql[0];
      if (first && right.current)
        right.current.dispatch({ effects: [], scrollIntoView: true, selection: { anchor: Math.min(first.start, right.current.state.doc.length) } });
      left.current?.focus();
    },
    [stages, setActive],
  );

  const onCursor = useCallback(
    (pos: number) => {
      const st = stages.find((s) => pos >= s.spl.start && pos <= s.spl.end);
      setActive(st?.index);
    },
    [stages, setActive],
  );

  const canCopyDql = fullDql !== '' && confidence !== undefined && confidence !== 'none';
  const copy = async (what: 'dql' | 'link') => {
    if (what === 'dql' && !canCopyDql) return;
    try {
      await navigator.clipboard.writeText(what === 'dql' ? fullDql : shareUrl(spl));
      setCopied(what);
      setTimeout(() => setCopied(undefined), 1500);
    } catch {
      setCopied(undefined);
    }
  };

  // Keyboard: Mod+Shift+C copy DQL, F8 / Shift+F8 notes, Alt+Up/Down stages, Mod+K examples.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        void copy('dql');
      } else if (e.key === 'F8' && shown) {
        e.preventDefault();
        const notes = shown.diagnostics.filter((d) => d.severity !== 'info');
        if (notes.length === 0) return;
        const cur = notes.findIndex((n) => n.stageIndex === active);
        const next = notes[(cur + (e.shiftKey ? notes.length - 1 : 1) + notes.length) % notes.length];
        if (next) focusStage(next.stageIndex);
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && stages.length > 0) {
        e.preventDefault();
        const cur = active ?? -1;
        const nxt = Math.max(0, Math.min(stages.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        focusStage(nxt);
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        examplesRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const copyLabel = confidence === 'low' ? 'Copy incomplete DQL' : 'Copy DQL';
  const narrowEmpty = !wide && empty;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto min-[900px]:overflow-hidden">
      {narrowEmpty && <StartPanel onPick={setSpl} />}
      <div
        className={`grid grid-cols-[minmax(0,1fr)] ${narrowEmpty ? 'grid-rows-[auto_200px]' : 'grid-rows-[auto_280px_auto_auto]'} min-[900px]:min-h-0 min-[900px]:flex-1 min-[900px]:grid-cols-[minmax(0,1fr)_56px_minmax(0,1fr)] min-[900px]:grid-rows-[auto_minmax(0,1fr)]`}
      >
        {/* SPL header */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 min-[900px]:col-start-1 min-[900px]:row-start-1">
          <h2 className="text-sm font-semibold">Splunk SPL</h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              <span>From</span>
              <input
                className="field w-24 font-code"
                value={earliest}
                onChange={(e) => setEarliest(e.target.value)}
                placeholder="-24h@h"
                aria-label="From (start of the time range)"
                title="Start of the time range, as a Splunk time modifier"
                spellCheck={false}
              />
            </label>
            <select
              ref={examplesRef}
              className="field font-semibold"
              aria-label="Load an example search"
              value=""
              onChange={(e) => {
                const ex = EXAMPLES[Number(e.target.value)];
                if (ex) setSpl(ex.spl);
              }}
            >
              <option value="" disabled>
                Examples
              </option>
              {EXAMPLES.map((ex, i) => (
                <option key={ex.title} value={i}>
                  {ex.title}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="min-h-0 border-line bg-surface min-[900px]:col-start-1 min-[900px]:row-start-2">
          <CodeEditor
            value={spl}
            onChange={setSpl}
            onCursor={onCursor}
            language="spl"
            label="Splunk SPL search"
            placeholder="Paste a Splunk search, or pick an example."
            markers={leftMarkers}
            ranges={leftRanges}
            viewRef={left}
            onGeometry={bump}
            wrap
          />
        </div>
        {/* Seam (wide) / marker strip (narrow) */}
        <div className="hidden border-b border-line bg-canvas min-[900px]:col-start-2 min-[900px]:row-start-1 min-[900px]:block" />
        <div className="hidden min-h-0 min-[900px]:col-start-2 min-[900px]:row-start-2 min-[900px]:block">
          <Seam stages={stages} left={left} right={right} active={active} onActivate={setActive} tick={tick} />
        </div>
        <div
          className={`items-center gap-1 overflow-x-auto border-y border-line bg-canvas px-4 py-1 min-[900px]:hidden ${narrowEmpty ? 'hidden' : 'flex'}`}
          role="toolbar"
          aria-label="Stages"
        >
          {cap(stages, LIMIT.stages).map((s) => (
            <button
              key={s.index}
              type="button"
              className={`control quiet ${STATUS_CLASS[s.status]}`}
              onClick={() => focusStage(s.index)}
              aria-label={`Stage ${s.index + 1}: ${STATUS_WORD[s.status]}`}
            >
              {STATUS_MARK[s.status]} {s.index + 1}
            </button>
          ))}
          <MoreLine total={stages.length} limit={LIMIT.stages} noun="stages" className="shrink-0 whitespace-nowrap" />
        </div>
        {/* DQL */}
        <div
          className={`h-[340px] min-h-0 flex-col min-[900px]:col-start-3 min-[900px]:row-span-2 min-[900px]:row-start-1 min-[900px]:flex min-[900px]:h-auto ${narrowEmpty ? 'hidden' : 'flex'}`}
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
            <h2 className="text-sm font-semibold">Dynatrace DQL</h2>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="control"
                disabled={empty}
                onClick={() => void copy('link')}
                title="The search is stored in the link itself, not on a server."
              >
                <Link2 size={16} aria-hidden />
                {copied === 'link' ? 'Copied' : 'Copy link'}
              </button>
              <button
                type="button"
                className={`control ${confidence === 'low' ? '' : 'primary'}`}
                disabled={!canCopyDql}
                onClick={() => void copy('dql')}
                data-testid="copy-dql"
              >
                <Copy size={16} aria-hidden />
                {copied === 'dql' ? 'Copied' : copyLabel}
              </button>
            </div>
          </div>
          <div className="relative min-h-0 flex-1 bg-surface">
            <CodeEditor
              value={dql}
              readOnly
              language="dql"
              label="Dynatrace DQL query (read only)"
              markers={rightMarkers}
              ranges={rightRanges}
              viewRef={right}
              onGeometry={bump}
              wrap
            />
            {empty && wide && (
              <div className="absolute inset-0 overflow-auto bg-surface">
                <StartPanel onPick={setSpl} />
              </div>
            )}
            {tooLong && (
              <p className="absolute inset-0 bg-surface px-4 py-4 text-sm" data-testid="too-long">
                This DQL is {fullDql.length.toLocaleString('en-US')} characters long, too long to show here. {copyLabel} still copies all of it.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Status line: what blocks the query first, then the confidence, then the quieter syntax check. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-line bg-canvas px-4 py-2 text-sm" data-testid="status">
        {failure && (
          <span data-testid="failure">
            <span className="mark-error" aria-hidden="true">
              ■{' '}
            </span>
            {failure}
          </span>
        )}
        {shown && untranslated > 0 && untranslated === stages.length && (
          <span className="font-semibold">
            <span className="mark-untranslated" aria-hidden="true">
              ■{' '}
            </span>
            None of this search could be translated.
          </span>
        )}
        {shown && untranslated > 0 && untranslated < stages.length && (
          <span className="font-semibold" data-testid="blocking">
            <span className="mark-untranslated" aria-hidden="true">
              ■{' '}
            </span>
            {untranslated} of {stages.length} stages not translated
          </span>
        )}
        {shown ? (
          <span className={untranslated > 0 ? '' : 'font-semibold'} data-testid="confidence">
            <span className={CONF_CLASS[shown.confidence]} aria-hidden="true">
              {CONF_MARK[shown.confidence]}{' '}
            </span>
            {CONFIDENCE_WORD[shown.confidence]}
          </span>
        ) : (
          !failure && <span className="text-muted">Nothing translated yet.</span>
        )}
        {shown && syntax && (
          <span className="text-xs text-muted" data-testid="syntax">
            Syntax check (offline){' '}
            {syntax.ok ? (
              'passed'
            ) : (
              <span className="mark-untranslated">
                found {syntax.issues.length} problem{syntax.issues.length === 1 ? '' : 's'}
              </span>
            )}
          </span>
        )}
      </div>
      <NotesPanel result={shown} mappingUse={mappingUse} onSelect={focusStage} />
    </div>
  );
}

/** The empty state: the examples, the two file views, and where everything runs. */
function StartPanel(props: { onPick: (spl: string) => void }) {
  const setView = useApp((s) => s.setView);
  return (
    <div className="border-b border-line bg-surface px-4 py-4 min-[900px]:border-b-0" data-testid="start">
      <h2 className="text-sm font-semibold">Start from an example</h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <li key={ex.title}>
            <button type="button" className="control" onClick={() => props.onPick(ex.spl)}>
              {ex.title}
            </button>
          </li>
        ))}
      </ul>
      <h2 className="mt-6 text-sm font-semibold">Or bring your own files</h2>
      <p className="mt-1 max-w-[60ch] text-sm text-muted">
        A folder of saved searches, a savedsearches.conf, or Splunk dashboards. macros.conf and props.conf from the same app fill in macros and field
        extractions for you.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="control" onClick={() => setView('batch')} onPointerEnter={() => preloadView('batch')}>
          Translate saved searches
        </button>
        <button type="button" className="control" onClick={() => setView('dashboards')} onPointerEnter={() => preloadView('dashboards')}>
          Convert dashboards
        </button>
      </div>
      <p className="mt-6 text-xs text-muted">Everything runs in this browser; nothing is uploaded.</p>
    </div>
  );
}
