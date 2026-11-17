/// <reference lib="webworker" />
import {
  type ConfigFile,
  type ConfigImport,
  checkDqlSyntax,
  convertDashboardSource,
  DashboardError,
  type DashboardSearch,
  type DashboardSource,
  InputError,
  importSplunkConfig,
  type SyntaxCheckResult,
  type TranslateOptions,
  type TranslateResult,
  translate,
} from '@spl2dql/core';
import type { InputFile } from './input-files.ts';
import { readSplunkFiles, type SplunkFiles } from './read-files.ts';
import { conversionCost, type KeptConversion, type KeptResult, keepConversion, keepResult, keepWithin } from './retained.ts';
import { type MappingRef, type MappingUse, resolveMapping } from './worker-mapping.ts';

/** One search, with its own saved time range when it comes from savedsearches.conf. */
export interface WorkItem {
  spl: string;
  earliest?: string;
  latest?: string;
}

export type WorkerRequest =
  | {
      id: number;
      kind: 'translate';
      items: WorkItem[];
      mapping?: MappingRef;
      timeRange?: { earliest?: string; latest?: string };
      strict?: boolean;
      /** Also run the offline syntax check on each result (the Translate view shows it). */
      check?: boolean;
    }
  | {
      id: number;
      kind: 'batch';
      items: WorkItem[];
      mapping?: MappingRef;
      timeRange?: { earliest?: string; latest?: string };
      /** Characters the results may keep in total; translation stops before the one that would go over. */
      budget: number;
    }
  | { id: number; kind: 'read'; files: InputFile[] }
  | {
      id: number;
      kind: 'dashboard';
      source: DashboardSource;
      mapping?: MappingRef;
      savedSearches?: [string, DashboardSearch][];
      /** Characters the conversion may keep; over it, the dashboard is not kept. */
      budget: number;
    }
  | { id: number; kind: 'import'; files: ConfigFile[]; mapping?: MappingRef };

/** A dashboard that converted, or the reason a file could not be read as one. */
export type DashboardOutcome =
  | { ok: true; name: string; conversion: KeptConversion; cost: number }
  | { ok: false; name: string; error: string; overBudget?: boolean };

export type WorkerResponse =
  | { id: number; kind: 'translate'; results: TranslateResult[]; syntax: (SyntaxCheckResult | undefined)[]; mappingUse: MappingUse }
  /** Results for the first `kept.length` items; fewer than asked means the budget was reached. */
  | { id: number; kind: 'batch'; kept: KeptResult[]; spent: number }
  | { id: number; kind: 'read'; found: SplunkFiles }
  | { id: number; kind: 'dashboard'; outcome: DashboardOutcome }
  | { id: number; kind: 'import'; imported: ConfigImport }
  /** The request failed; `input` marks a message meant for the person (a file over a limit). */
  | { id: number; kind: 'error'; message: string; input: boolean };

const post = (message: WorkerResponse): void => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
};

/** The syntax check only means something when there is DQL that is not all comments. */
function check(dql: string): SyntaxCheckResult | undefined {
  return dql.split('\n').some((l) => l.trim() && !l.startsWith('//')) ? checkDqlSyntax(dql) : undefined;
}

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  if (req.kind === 'read') return { id: req.id, kind: 'read', found: await readSplunkFiles(req.files) };
  const { mapping, use } = resolveMapping(req.mapping);
  if (req.kind === 'import') return { id: req.id, kind: 'import', imported: importSplunkConfig(req.files, mapping) };
  if (req.kind === 'dashboard') {
    const savedSearches = new Map(req.savedSearches ?? []);
    try {
      const conversion = keepConversion(convertDashboardSource(req.source, { ...(mapping ? { mapping } : {}), savedSearches }));
      const cost = conversionCost(conversion);
      if (cost > req.budget) return { id: req.id, kind: 'dashboard', outcome: { ok: false, name: req.source.name, error: '', overBudget: true } };
      return { id: req.id, kind: 'dashboard', outcome: { ok: true, name: req.source.name, conversion, cost } };
    } catch (err) {
      const error = err instanceof DashboardError ? err.message : 'This file could not be read as a dashboard.';
      return { id: req.id, kind: 'dashboard', outcome: { ok: false, name: req.source.name, error } };
    }
  }
  const options: TranslateOptions = {};
  if (mapping) options.mapping = mapping;
  if (req.kind === 'translate' && req.strict) options.strict = true;
  const one = translator(options, req.timeRange);
  if (req.kind === 'batch') {
    const { kept, spent } = keepWithin(req.items, (item) => keepResult(one(item)), req.budget);
    return { id: req.id, kind: 'batch', kept, spent };
  }
  const results = req.items.map(one);
  const syntax = results.map((r) => (req.check ? check(r.dql) : undefined));
  return { id: req.id, kind: 'translate', results, syntax, mappingUse: use };
}

/** Translates one item. The time picker wins; otherwise a saved search keeps its own saved range. */
function translator(options: TranslateOptions, picked: { earliest?: string; latest?: string } | undefined): (item: WorkItem) => TranslateResult {
  const picker = picked && (picked.earliest || picked.latest) ? picked : undefined;
  return (item) => {
    const range = picker ?? (item.earliest !== undefined || item.latest !== undefined ? item : undefined);
    if (!range) return translate(item.spl, options);
    const timeRange: { earliest?: string; latest?: string } = {};
    if (range.earliest) timeRange.earliest = range.earliest;
    if (range.latest) timeRange.latest = range.latest;
    return translate(item.spl, { ...options, timeRange });
  };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  handle(req).then(post, (err: unknown) => {
    // Nothing a request does may leave its caller waiting: every failure is answered at once.
    post({ id: req.id, kind: 'error', message: err instanceof Error ? err.message : String(err), input: err instanceof InputError });
  });
};
