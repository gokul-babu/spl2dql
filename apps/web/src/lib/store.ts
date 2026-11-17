import type { Confidence, Diagnostic, StageResult, SyntaxCheckResult, TileOutcome, TileReport, TranslateResult } from '@spl2dql/core';
import { create } from 'zustand';
import { type MappingUse, translateOne, WorkerStopped } from './engine.ts';
import { EXAMPLES } from './examples.ts';
import { DEFAULT_MAPPING, isEmptyMappingText } from './mapping-empty.ts';
import type { KeptConversion, KeptResult } from './retained.ts';
import { hashOf, type View } from './route.ts';
import { load, save } from './storage.ts';

export type { View };
export type Theme = 'system' | 'light' | 'dark';
export type Dialog = 'settings' | 'shortcuts' | 'about';

export interface BatchRow {
  name: string;
  origin: string;
  spl: string;
  /** Trimmed to what the Batch view shows and downloads (lib/retained.ts). */
  result: KeptResult;
  /** From savedsearches.conf. */
  earliest?: string;
  latest?: string;
  schedule?: string;
  disabled?: boolean;
}

export interface DashboardRow {
  /** File the dashboard came from. */
  origin: string;
  /** Trimmed to what the Dashboards view shows and downloads (lib/retained.ts). */
  conversion: KeptConversion;
}

/** What the last set of files contained, shown where they were dropped. */
export interface IngestNote {
  searches: number;
  dashboards: number;
  /** Definitions added to the mapping from Splunk configuration files. */
  added: number;
  /** Definitions that could not be carried over, with the reason. */
  skipped: { name: string; reason: string }[];
  /** Files that were not read, and dashboards that could not be. */
  problems: string[];
  /** The sample app was converted with the example mapping. */
  example?: boolean;
  /**
   * The drop produced more DQL than one drop may keep: what was not translated, by name, so the
   * count is visible and nothing is dropped silently (ADR-029).
   */
  overBudget?: { searches: string[]; dashboards: string[] };
}

interface AppState {
  view: View;
  spl: string;
  result: TranslateResult | undefined;
  syntax: SyntaxCheckResult | undefined;
  /** Which mapping the shown result used. */
  mappingUse: MappingUse;
  /** Why the last translation has no result, in words for the status line. */
  failure: string | undefined;
  activeStage: number | undefined;
  mappingText: string;
  /** An entry to put the caret on when the Mapping view opens. */
  mappingFocus: { section: string; name: string } | undefined;
  /** Searches that count as built-in examples: the five examples and the sample app's searches. */
  examples: ReadonlySet<string>;
  earliest: string;
  theme: Theme;
  fontSize: number;
  notesOpen: boolean;
  announce: string;
  batch: BatchRow[];
  dashboards: DashboardRow[];
  ingestNote: IngestNote | undefined;
  dialog: Dialog | undefined;
  /** Shows a view and adds it to the browser history. */
  setView(v: View): void;
  /** Shows a view because the address changed (Back, Forward, a link); the history already has it. */
  showView(v: View): void;
  setSpl(spl: string): void;
  setActiveStage(i: number | undefined): void;
  setMappingText(text: string): void;
  setMappingFocus(focus: { section: string; name: string } | undefined): void;
  addExamples(spls: Iterable<string>): void;
  setEarliest(e: string): void;
  setTheme(t: Theme): void;
  setFontSize(n: number): void;
  setNotesOpen(open: boolean): void;
  setDialog(d: Dialog | undefined): void;
  setBatch(rows: BatchRow[]): void;
  setDashboards(rows: DashboardRow[]): void;
  setIngestNote(note: IngestNote | undefined): void;
  forgetMapping(): void;
}

/**
 * The example mapping is used only while the person's own mapping is empty and the search is a
 * built-in example exactly as shipped (ADR-030). One edited character and it is their own search.
 */
export function usesExampleMapping(state: Pick<AppState, 'mappingText' | 'spl' | 'examples'>): boolean {
  return state.spl.trim() !== '' && state.examples.has(state.spl) && isEmptyMappingText(state.mappingText);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

export const useApp = create<AppState>((set, get) => {
  const retranslate = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++generation;
      const state = get();
      const { spl, earliest, mappingText } = state;
      if (spl.trim() === '') {
        set({ result: undefined, syntax: undefined, failure: undefined, mappingUse: 'none', announce: '' });
        return;
      }
      const mapping = usesExampleMapping(state) ? ({ example: true } as const) : { own: mappingText };
      try {
        const out = await translateOne({ spl }, { mapping, timeRange: earliest ? { earliest } : {} });
        if (mine !== generation || !out.result) return;
        set({
          result: out.result,
          syntax: out.syntax,
          mappingUse: out.mappingUse,
          failure: undefined,
          announce: `Translated. ${CONFIDENCE_WORD[out.result.confidence]}, ${noteCount(out.result.diagnostics)} notes.`,
        });
      } catch (e) {
        if (mine !== generation) return;
        const failure =
          e instanceof WorkerStopped && e.reason === 'timeout'
            ? 'This search took too long to translate and was stopped.'
            : 'The translator stopped unexpectedly. Change the search to try again.';
        set({ result: undefined, syntax: undefined, failure, announce: failure });
      }
    }, 150);
  };

  return {
    view: 'translate',
    spl: '',
    result: undefined,
    syntax: undefined,
    mappingUse: 'none',
    failure: undefined,
    mappingText: load('mapping') ?? DEFAULT_MAPPING,
    mappingFocus: undefined,
    examples: new Set(EXAMPLES.map((e) => e.spl)),
    activeStage: undefined,
    dialog: undefined,
    earliest: '',
    theme: (load('theme') as Theme | undefined) ?? 'system',
    fontSize: Number(load('fontSize') ?? 14) || 14,
    notesOpen: load('notesOpen') !== 'false',
    announce: '',
    batch: [],
    dashboards: [],
    ingestNote: undefined,
    setView: (view) => {
      if (view === get().view) return;
      try {
        const { pathname, search } = globalThis.location;
        globalThis.history.pushState(null, '', `${pathname}${search}${hashOf(view)}`);
      } catch {
        // No history (an unusual embedding): the view still changes.
      }
      set({ view });
    },
    showView: (view) => set({ view }),
    setSpl: (spl) => {
      set({ spl });
      retranslate();
    },
    setActiveStage: (activeStage) => set({ activeStage }),
    setMappingText: (mappingText) => {
      save('mapping', mappingText);
      set({ mappingText });
      retranslate();
    },
    setMappingFocus: (mappingFocus) => set({ mappingFocus }),
    addExamples: (spls) => {
      const examples = new Set(get().examples);
      for (const s of spls) examples.add(s);
      set({ examples });
      retranslate();
    },
    setEarliest: (earliest) => {
      set({ earliest });
      retranslate();
    },
    setTheme: (theme) => {
      save('theme', theme);
      set({ theme });
    },
    setFontSize: (fontSize) => {
      save('fontSize', String(fontSize));
      set({ fontSize });
    },
    setNotesOpen: (notesOpen) => {
      save('notesOpen', String(notesOpen));
      set({ notesOpen });
    },
    setDialog: (dialog) => set({ dialog }),
    setBatch: (batch) => set({ batch }),
    setDashboards: (dashboards) => set({ dashboards }),
    setIngestNote: (ingestNote) => set({ ingestNote }),
    forgetMapping: () => {
      save('mapping', undefined);
      get().setMappingText(DEFAULT_MAPPING);
    },
  };
});

export const CONFIDENCE_WORD: Record<Confidence, string> = {
  high: 'Exact',
  review: 'Needs review',
  low: 'Incomplete',
  none: 'Not translated',
};

export const STATUS_WORD: Record<StageResult['status'], string> = {
  exact: 'Exact',
  check: 'Check',
  untranslated: 'Not translated',
};

export const STATUS_MARK: Record<StageResult['status'], string> = {
  exact: '●',
  check: '▲',
  untranslated: '■',
};

/** How a dashboard panel came out; a converted panel with notes still needs a look. */
export type TileStatus = 'exact' | 'check' | 'untranslated' | 'text';

export function tileStatus(tile: Pick<TileReport, 'outcome' | 'notes'>): TileStatus {
  if (tile.outcome === 'text') return 'text';
  if (tile.outcome === 'manual') return 'untranslated';
  return tile.notes.length > 0 ? 'check' : 'exact';
}

export const TILE_WORD: Record<TileStatus, string> = {
  exact: 'Converted',
  check: 'Converted, check',
  untranslated: 'Needs manual work',
  text: 'Text',
};

export const TILE_MARK: Record<TileStatus, string> = { exact: '●', check: '▲', untranslated: '■', text: '≡' };

export const TILE_CLASS: Record<TileStatus, string> = { exact: 'mark-exact', check: 'mark-check', untranslated: 'mark-untranslated', text: 'text-muted' };

export const OUTCOME_WORD: Record<TileOutcome, string> = { live: 'Converted', manual: 'Needs manual work', text: 'Text' };

export function noteCount(diags: readonly Diagnostic[]): number {
  return diags.filter((d) => d.severity !== 'info').length;
}
