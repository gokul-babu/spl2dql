import type { Confidence, DashboardConversion, Diagnostic, TileReport, TranslateResult, VariableReport } from '@spl2dql/core';

/**
 * What a dropped file's results keep in memory, and what that costs (ADR-029, second round).
 *
 * One drop keeps at most 50,000,000 characters. A translation alone stays under the engine's
 * 1,000,000-character cap, but many small searches that expand through macros can each come close
 * to it, so the whole drop gets a budget too. Results are trimmed in the worker to what the Batch
 * and Dashboards views show or download, and the budget is charged for what is kept.
 */
export const MAX_KEPT = 50_000_000;

/** A batch search's result as the Batch view keeps it: the table, the counts and the download. */
export interface KeptResult {
  dql: string;
  confidence: Confidence;
  diagnostics: Diagnostic[];
}

/** A dashboard tile as the Dashboards view keeps it: the preview and the selected tile's detail. */
export type KeptTile = Omit<TileReport, 'result'> & { result?: { dql: string } };
export type KeptVariable = Omit<VariableReport, 'result'>;
export type KeptConversion = Omit<DashboardConversion, 'tiles' | 'variables'> & { tiles: KeptTile[]; variables: KeptVariable[] };

export function keepResult(r: TranslateResult): KeptResult {
  return { dql: r.dql, confidence: r.confidence, diagnostics: r.diagnostics };
}

/**
 * Results of `items` in order, each charged by `resultCost`, stopping before the one that would take
 * the total over `budget`. Fewer results than items means the budget was reached.
 */
export function keepWithin<T>(items: readonly T[], produce: (item: T) => KeptResult, budget: number): { kept: KeptResult[]; spent: number } {
  const kept: KeptResult[] = [];
  let spent = 0;
  for (const item of items) {
    const k = produce(item);
    const cost = resultCost(k);
    if (spent + cost > budget) break;
    spent += cost;
    kept.push(k);
  }
  return { kept, spent };
}

/** Characters a kept search holds: its DQL and the text of its notes (up to 10,000 of them). */
export function resultCost(r: KeptResult): number {
  let n = r.dql.length;
  for (const d of r.diagnostics) n += 64 + d.message.length + (d.hint?.length ?? 0) + (d.subject?.length ?? 0);
  return n;
}

/**
 * Drops what the Dashboards view neither shows nor downloads: the per-tile and per-variable
 * translation details (stages, notes as objects, shapes). The Dynatrace dashboard document, every
 * tile's DQL, Splunk search and notes stay.
 */
export function keepConversion(c: DashboardConversion): KeptConversion {
  return {
    ...c,
    tiles: c.tiles.map(({ result, ...tile }) => (result ? { ...tile, result: { dql: result.dql } } : tile)),
    variables: c.variables.map(({ result: _result, ...v }) => v),
  };
}

/** Characters a kept dashboard holds: everything in it, the downloadable document included. */
export function conversionCost(c: KeptConversion): number {
  return JSON.stringify(c).length;
}

/**
 * The budget for one drop. A test may lower it through `globalThis.__spl2dqlKeepLimit` (the only way
 * to reach it without 50 MB of input); nothing can raise it.
 */
export function keepLimit(): number {
  const override = (globalThis as { __spl2dqlKeepLimit?: unknown }).__spl2dqlKeepLimit;
  return typeof override === 'number' && override >= 0 ? Math.min(override, MAX_KEPT) : MAX_KEPT;
}
