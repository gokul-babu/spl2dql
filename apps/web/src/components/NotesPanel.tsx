import { collectMappingNeeds, type Diagnostic, type StageResult, type TranslateResult } from '@spl2dql/core';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MappingUse } from '../lib/engine.ts';
import { isEmptyMappingText } from '../lib/mapping-empty.ts';
import { useApp } from '../lib/store.ts';
import { cap, LIMIT, MoreLine } from './Capped.tsx';

const SEV_MARK: Record<Diagnostic['severity'], string> = { error: '■', warning: '▲', info: '●' };
const SEV_CLASS: Record<Diagnostic['severity'], string> = { error: 'mark-error', warning: 'mark-check', info: 'mark-info' };

/** SPL4001–4008 are fixed in the mapping file; a dashboard token (SPL4009) is not. */
const MAPPING_CODE = /^SPL400[1-8]$/;

/** How many distinct names these notes ask the mapping for. */
function nameCount(notes: readonly Diagnostic[]): number {
  const n = collectMappingNeeds(notes);
  return (
    n.indexes.length +
    n.sourcetypes.length +
    n.fields.length +
    n.macros.length +
    n.lookups.length +
    n.eventtypes.length +
    n.metrics.length +
    n.datamodels.length
  );
}

/**
 * Adds mapping entries for these notes to the mapping text and opens Mapping at the first one. The
 * YAML library loads only now; it is not part of the first paint.
 */
async function addAndOpen(notes: readonly Diagnostic[]): Promise<void> {
  const { addEntries, entriesFor } = await import('../lib/mapping-text.ts');
  const state = useApp.getState();
  const entries = entriesFor(notes);
  const changed = entries.length > 0 ? addEntries(state.mappingText, entries) : undefined;
  if (changed && changed.added > 0) state.setMappingText(changed.text);
  const first = entries[0];
  state.setMappingFocus(changed && first ? { section: first.section, name: first.name } : undefined);
  state.setView('mapping');
}

/** The marks, with their words, where the marks are used. */
export function Legend() {
  return (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted" data-testid="legend">
      <span>
        <span className="mark-exact" aria-hidden="true">
          ●
        </span>{' '}
        Exact
      </span>
      <span>
        <span className="mark-check" aria-hidden="true">
          ▲
        </span>{' '}
        Check
      </span>
      <span>
        <span className="mark-untranslated" aria-hidden="true">
          ■
        </span>{' '}
        Not translated
      </span>
    </p>
  );
}

/** One line above the notes about the mapping: the example mapping in use, a broken mapping, or names to add. */
function MappingLine(props: { use: MappingUse; missing: readonly Diagnostic[]; grouped: boolean; showNames: boolean; onToggle: () => void }) {
  const setView = useApp((s) => s.setView);
  const openMapping = (
    <button type="button" className="control" onClick={() => setView('mapping')}>
      Open Mapping
    </button>
  );
  if (props.use === 'example') {
    return (
      <p className="mapping-line" data-testid="mapping-line">
        <span>
          <span className="mark-info" aria-hidden="true">
            ●{' '}
          </span>
          Using the example mapping. Your own searches need yours.
        </span>
        {openMapping}
      </p>
    );
  }
  if (props.use === 'invalid') {
    return (
      <p className="mapping-line" data-testid="mapping-line">
        <span>
          <span className="mark-error" aria-hidden="true">
            ■{' '}
          </span>
          The mapping file has a problem, so it was not used.
        </span>
        {openMapping}
      </p>
    );
  }
  if (!props.grouped) return null;
  const count = nameCount(props.missing);
  return (
    <p className="mapping-line" data-testid="mapping-line">
      <span>
        <span className="mark-check" aria-hidden="true">
          ▲{' '}
        </span>
        {count === 1 ? '1 name needs a mapping.' : `${count} names need a mapping.`}
      </span>
      <button type="button" className="control" onClick={() => void addAndOpen(props.missing)}>
        Add them to the mapping
      </button>
      <button type="button" className="control quiet" aria-expanded={props.showNames} aria-controls="notes-list" onClick={props.onToggle}>
        {props.showNames ? 'Hide the names' : 'Show the names'}
      </button>
    </p>
  );
}

/**
 * Notes grouped by stage; selecting one focuses that stage in both panes. Notes of a stage that was
 * not translated carry ■ and come first: they are what blocks the query (ADR-030).
 */
export function NotesPanel(props: { result: TranslateResult | undefined; mappingUse: MappingUse; onSelect: (stage: number) => void }) {
  const open = useApp((s) => s.notesOpen);
  const setOpen = useApp((s) => s.setNotesOpen);
  const mappingText = useApp((s) => s.mappingText);
  const [showNames, setShowNames] = useState(false);
  const result = props.result;

  const { notes, info, missing, blocked } = useMemo(() => {
    const status = new Map<number, StageResult['status']>();
    for (const s of result?.stages ?? []) status.set(s.index, s.status);
    const all = result?.diagnostics ?? [];
    const visible = all.filter((d) => d.severity !== 'info');
    const isBlocked = (d: Diagnostic) => status.get(d.stageIndex) === 'untranslated';
    const sorted = [...visible.filter(isBlocked), ...visible.filter((d) => !isBlocked(d))];
    return {
      notes: sorted,
      info: all.length - visible.length,
      missing: visible.filter((d) => MAPPING_CODE.test(d.code)),
      blocked: new Set(sorted.filter(isBlocked)),
    };
  }, [result]);

  // The person's own search with an empty mapping: one line instead of a warning per name.
  const grouped = props.mappingUse === 'own' && missing.length > 0 && isEmptyMappingText(mappingText);
  const shown = grouped && !showNames ? notes.filter((d) => !MAPPING_CODE.test(d.code)) : notes;

  return (
    <section aria-label="Notes" className="flex shrink-0 flex-col border-t border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <button type="button" className="control quiet -ml-2" aria-expanded={open} aria-controls="notes-list" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={16} aria-hidden /> : <ChevronUp size={16} aria-hidden />}
          {notes.length === 0 ? 'No notes' : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}
        </button>
        {info > 0 && <span className="text-xs text-muted">{info} for information</span>}
        {result && <MappingLine use={props.mappingUse} missing={missing} grouped={grouped} showNames={showNames} onToggle={() => setShowNames(!showNames)} />}
        {notes.length > 0 && (
          <div className="ml-auto">
            <Legend />
          </div>
        )}
      </div>
      {open && (
        <ol id="notes-list" className="max-h-64 overflow-auto px-4 pb-3" data-testid="notes">
          {cap(shown, LIMIT.notes).map((d) => {
            const isBlocked = blocked.has(d);
            return (
              <li
                key={`${d.code}-${d.stageIndex}-${d.span.start}-${d.message}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line py-2 first:border-t-0"
                data-blocking={isBlocked ? 'true' : undefined}
              >
                <span className={`${isBlocked ? 'mark-untranslated' : SEV_CLASS[d.severity]} w-4 shrink-0 text-center`} aria-hidden="true">
                  {isBlocked ? '■' : SEV_MARK[d.severity]}
                </span>
                <span className="sr-only">{isBlocked ? 'Not translated' : d.severity === 'error' ? 'Error' : 'Check'}:</span>
                <button type="button" className="text-left text-sm font-semibold hover:underline" onClick={() => props.onSelect(d.stageIndex)}>
                  Stage {d.stageIndex + 1}
                </button>
                <span className="min-w-0 basis-full text-sm min-[600px]:basis-0 min-[600px]:flex-1">
                  {d.message}
                  {d.hint && <span className="block text-xs text-muted">{d.hint}</span>}
                </span>
                <span className="font-code text-xs text-muted">{d.code}</span>
                {/* With the example mapping in use, the person's own mapping is not involved. */}
                {MAPPING_CODE.test(d.code) && props.mappingUse !== 'example' && (
                  <button type="button" className="control" onClick={() => void addAndOpen([d])}>
                    Add mapping
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {open && <MoreLine total={shown.length} limit={LIMIT.notes} noun="notes" className="px-4 pb-3" />}
    </section>
  );
}
