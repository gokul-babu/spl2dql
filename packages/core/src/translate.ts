import { applyTokens, leftoverTokens } from './dashboard/tokens.ts';
import { DiagnosticCollector } from './diagnostics/collector.ts';
import { andAll, block, call, type DqlExpr, field, not } from './dql/ast.ts';
import { checkDqlSyntax } from './dql/check.ts';
import { OutputTooLarge, printCommand, printExpression, printQuery } from './dql/printer.ts';
import { MAX_INPUT, MAX_OUTPUT } from './limits.ts';
import { TranslationContext } from './lower/context.ts';
import { lowerPipeline, type PipelineResult } from './lower/pipeline.ts';
import { emptyMapping } from './mapping/config.ts';
import { expandMacros } from './spl/macros.ts';
import type { Confidence, Diagnostic, MacroMapping, MappingConfig, Span, StageResult, TranslateOptions, TranslateResult } from './types.ts';

export { MAX_INPUT, MAX_OUTPUT };

/**
 * Macros every Splunk installation with the Common Information Model has. A definition in the
 * mapping file wins. `drop_dm_object_name(X)` removes the dataset prefix `X.` from field names.
 */
const BUILTIN_MACROS: readonly [string, MacroMapping][] = [
  ['drop_dm_object_name(1)', { args: ['drop_dm_object_name'], definition: 'rename $drop_dm_object_name$.* as *' }],
];
const withBuiltins = new WeakMap<ReadonlyMap<string, MacroMapping>, ReadonlyMap<string, MacroMapping>>();

function macrosOf(mapping: MappingConfig): ReadonlyMap<string, MacroMapping> {
  const cached = withBuiltins.get(mapping.macros);
  if (cached) return cached;
  const all = new Map(BUILTIN_MACROS);
  for (const [k, v] of mapping.macros) all.set(k, v);
  withBuiltins.set(mapping.macros, all);
  return all;
}

/**
 * Translates one SPL search into DQL. Pure, synchronous and total: it never throws for any input
 * string, reads no clock and returns identical output for identical arguments.
 */
export function translate(spl: string, options: TranslateOptions = {}): TranslateResult {
  try {
    return translateUnchecked(typeof spl === 'string' ? spl : String(spl), options);
  } catch (error) {
    // Over the output budget: the translation stops and nothing partial is returned (ADR-029).
    if (error instanceof OutputTooLarge) return tooLarge(error.message || `The translated query would be longer than ${MAX_OUTPUT} characters.`);
    return internalError(spl, error);
  }
}

/**
 * Length of `spl` once its macros are expanded, or undefined when that would be longer than
 * `limit`; the expansion stops there, so a dashboard can charge its budget before translating.
 */
export function expandedLength(spl: string, options: TranslateOptions, limit: number): number | undefined {
  if (spl.length > limit) return undefined;
  try {
    const expansion = expandMacros(spl, macrosOf(options.mapping ?? emptyMapping()), limit);
    return expansion.events.some((e) => e.code === 'SPL1006') ? undefined : expansion.text.length;
  } catch {
    return undefined;
  }
}

/** The result of a search that is too large to translate (SPL1006, no DQL, no stages). */
export function tooLarge(detail: string): TranslateResult {
  const diags = new DiagnosticCollector(false);
  diags.report('SPL1006', { start: 0, end: 0 }, -1, { detail });
  return { dql: '', confidence: 'none', score: 0, diagnostics: diags.items, stages: [] };
}

function translateUnchecked(spl: string, options: TranslateOptions): TranslateResult {
  if (spl.length > MAX_INPUT) return tooLarge(`The search is longer than ${MAX_INPUT} characters.`);
  const mapping = options.mapping ?? emptyMapping();
  const expansion = expandMacros(spl, macrosOf(mapping));
  const overflow = expansion.events.find((e) => e.code === 'SPL1006');
  if (overflow) {
    return {
      dql: '',
      confidence: 'none',
      score: 0,
      diagnostics: [{ code: 'SPL1006', severity: 'error', message: overflow.detail, span: overflow.span, stageIndex: -1, subject: overflow.subject }],
      stages: [],
    };
  }
  const tc = new TranslationContext(expansion.text, mapping, options);
  tc.diags.mapSpan = expansion.mapSpan;

  if (expansion.text.trim() === '') {
    tc.diags.report('SPL1002', { start: 0, end: 0 }, -1, { detail: 'The search is empty.' });
    return { dql: '', confidence: 'none', score: 0, diagnostics: tc.diags.items, stages: [] };
  }

  const pipeline = lowerPipeline(tc, { start: 0, end: expansion.text.length }, 0);
  const lastStage = pipeline.stages[pipeline.stages.length - 1];
  const hasDql = pipeline.commands.some((c) => c.name !== '//');
  if (hasDql && lastStage && pipeline.state.schema.kind === 'events' && !pipeline.commands.some((c) => c.name === 'limit')) {
    tc.diags.reportOnce('SPL5006', lastStage.span, lastStage.index, 'DQL returns at most 1000 records unless the query sets a limit.');
  }
  let variables: string[] | undefined;
  if (options.tokens) {
    const pass = applyTokens(pipeline.commands, options.tokens, (name) =>
      name === 'timestamp' ? 'time' : (pipeline.state.types.get(name) ?? mapping.fieldTypes.get(name)),
    );
    variables = [...pass.used].sort();
    reportLeftoverTokens(tc, pipeline, pass.fieldChoosers);
  } else {
    reportTokens(tc, pipeline.stages);
  }
  const printed = printQuery({ commands: pipeline.commands }, MAX_OUTPUT);

  // Stage spans in the original input.
  const stageSpans = pipeline.stages.map((s) => expansion.mapSpan(s.span));
  for (const ev of expansion.events) {
    const idx = firstSpanHolding(stageSpans, ev.span.start);
    const diag: Diagnostic = {
      code: ev.code,
      severity: ev.code === 'SPL5005' ? 'info' : ev.code.startsWith('SPL4') ? (options.strict ? 'error' : 'warning') : 'error',
      message: ev.detail,
      span: ev.span,
      stageIndex: idx === -1 ? 0 : idx,
      subject: ev.subject,
    };
    tc.diags.add(diag);
  }

  // Offline syntax check of the generated text (comment-only output has nothing to check).
  const syntax = hasDql ? checkDqlSyntax(printed.text) : { ok: true, issues: [] };
  for (const issue of syntax.issues) {
    const cmdIdx = firstSpanHolding(printed.commandSpans, issue.span.start);
    const origin = pipeline.commands[cmdIdx]?.origin[0] ?? 0;
    tc.diags.add({
      code: 'SPL3017',
      severity: 'warning',
      message: `The generated DQL did not pass the offline syntax check: ${issue.message}`,
      hint: 'Check this line; it may need a manual fix.',
      span: stageSpans[origin] ?? { start: 0, end: 0 },
      stageIndex: origin,
    });
  }

  // Commands and notes indexed by stage once, instead of rescanned for every stage (ADR-029).
  const dqlByStage = new Map<number, Span[]>();
  pipeline.commands.forEach((c, ci) => {
    for (const index of new Set(c.origin)) {
      const list = dqlByStage.get(index) ?? [];
      list.push(printed.commandSpans[ci] as Span);
      dqlByStage.set(index, list);
    }
  });
  const flagged = new Set(tc.diags.items.filter((d) => d.severity !== 'info').map((d) => d.stageIndex));
  const stages: StageResult[] = pipeline.stages.map((s, i) => ({
    index: s.index,
    command: s.command,
    status: s.untranslated ? 'untranslated' : flagged.has(s.index) ? 'check' : 'exact',
    spl: stageSpans[i] as Span,
    dql: dqlByStage.get(s.index) ?? [],
  }));

  const diagnostics = sortDiagnostics(tc.diags.items);
  const { confidence, score } = scoreResult(stages, diagnostics);
  const result: TranslateResult = { dql: printed.text, confidence, score, diagnostics, stages };
  if (hasDql) result.shape = { kind: pipeline.state.schema.kind, fields: [...pipeline.state.schema.fields] };
  if (variables) result.variables = variables;
  return result;
}

/**
 * Translates a Splunk search expression — the definition of an eventtype or a tagged value — into
 * one DQL condition, for the `eventtypes` and `tags` sections of a mapping file. Returns no condition
 * when the search is more than a filter (it has pipes, a subsearch, or a part that cannot be
 * translated).
 */
export function translateCondition(search: string, options: TranslateOptions = {}): { condition?: string; diagnostics: Diagnostic[] } {
  try {
    const text = typeof search === 'string' ? search : String(search);
    if (text.trim() === '' || text.length > MAX_INPUT) return { diagnostics: [] };
    const mapping = options.mapping ?? emptyMapping();
    const expansion = expandMacros(text, macrosOf(mapping));
    const tc = new TranslationContext(expansion.text, mapping, options);
    tc.diags.mapSpan = expansion.mapSpan;
    const pipeline = lowerPipeline(tc, { start: 0, end: expansion.text.length }, 0);
    const diagnostics = sortDiagnostics(tc.diags.items);
    const [source, ...rest] = pipeline.commands;
    if (pipeline.stages.length !== 1 || pipeline.stages[0]?.untranslated || source?.name !== 'fetch') return { diagnostics };
    const parts: DqlExpr[] = [];
    for (const arg of source.args) {
      // A mapped index narrows the buckets; inside a condition that is a bucket comparison.
      if (arg.kind === 'named' && arg.name === 'bucket')
        parts.push(call('in', field('dt.system.bucket'), arg.value.k === 'block' ? arg.value : block([arg.value])));
    }
    for (const c of rest) {
      const value = c.args[0]?.value;
      if (c.args.length !== 1 || value === undefined || hasSubQuery(value)) return { diagnostics };
      if (c.name === 'filter') parts.push(value);
      else if (c.name === 'filterOut') parts.push(not(value));
      else return { diagnostics };
    }
    const all = andAll(parts);
    return all ? { condition: printExpression(all), diagnostics } : { diagnostics };
  } catch {
    return { diagnostics: [] };
  }
}

/** True when an expression holds a sub-query anywhere; a mapping condition cannot. */
function hasSubQuery(e: DqlExpr): boolean {
  switch (e.k) {
    case 'sub':
      return true;
    case 'call':
      return e.args.some((a) => hasSubQuery(a.value));
    case 'bin':
      return hasSubQuery(e.l) || hasSubQuery(e.r);
    case 'block':
      return e.items.some(hasSubQuery);
    case 'un':
    case 'assign':
    case 'dir':
    case 'index':
    case 'align':
      return hasSubQuery(e.e);
    default:
      return false;
  }
}

/** $token$, $form.token$, $token|s$: Splunk fills these in on a dashboard; here they are only text. */
const TOKEN = /\$[A-Za-z_][A-Za-z0-9_.]*(?:\|[A-Za-z]+)?\$/g;

/** Reports each dashboard token once per stage. `map` uses the same syntax for its own fields. */
function reportTokens(tc: TranslationContext, stages: readonly { index: number; command: string; span: Span }[]): void {
  for (const s of stages) {
    if (s.command === 'map') continue;
    const text = tc.text.slice(s.span.start, s.span.end);
    const seen = new Set<string>();
    for (const m of text.matchAll(TOKEN)) {
      const token = m[0];
      if (seen.has(token)) continue;
      seen.add(token);
      const start = s.span.start + m.index;
      tc.diags.report('SPL4009', { start, end: start + token.length }, s.index, {
        subject: token,
        detail: `${token} is a dashboard token; it was kept as plain text and will not be filled in.`,
      });
    }
  }
}

/**
 * Dashboard mode: a token that became a variable is fine. What is reported is a token still written
 * as `$name$` in the DQL (part of a longer value, or inside a stage that was not translated), and a
 * variable that chooses a field name.
 */
function reportLeftoverTokens(tc: TranslationContext, pipeline: PipelineResult, fieldChoosers: ReadonlySet<string>): void {
  const spanOf = (index: number): Span => pipeline.stages.find((s) => s.index === index)?.span ?? { start: 0, end: 0 };
  const seen = new Set<string>();
  for (const c of pipeline.commands) {
    const index = c.origin[0] ?? 0;
    for (const token of leftoverTokens(c.name === '//' ? (c.comment ?? '') : printCommand(c))) {
      const key = `${index}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tc.diags.report('SPL4009', spanOf(index), index, {
        subject: token,
        detail: `${token} is only part of a value here, so it could not become a dashboard variable; it was kept as plain text.`,
      });
    }
  }
  const first = pipeline.stages[0];
  for (const name of fieldChoosers) {
    tc.diags.report('SPL4009', first?.span ?? { start: 0, end: 0 }, first?.index ?? 0, {
      subject: `$${name}`,
      detail: `The variable $${name} chooses a field; its values must be Grail field names, not Splunk ones.`,
    });
  }
}

/**
 * Index of the first span that holds `offset` (start ≤ offset ≤ end), or -1. Spans are in order
 * (stage spans, printed command spans), so a binary search finds the first one whose end is not
 * before the offset; it holds the offset unless it starts after it.
 */
function firstSpanHolding(spans: readonly Span[], offset: number): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((spans[mid] as Span).end < offset) lo = mid + 1;
    else hi = mid;
  }
  const found = spans[lo];
  return found !== undefined && found.start <= offset ? lo : -1;
}

/** Confidence is a pure function of stage statuses and diagnostics (translation-engine.md). */
export function scoreResult(stages: StageResult[], diagnostics: Diagnostic[]): { confidence: Confidence; score: number } {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const score = Math.max(0, 100 - 40 * errors - 10 * warnings);
  if (stages.length === 0 || stages.every((s) => s.status === 'untranslated')) return { confidence: 'none', score: 0 };
  if (errors > 0 || stages.some((s) => s.status === 'untranslated')) return { confidence: 'low', score };
  if (stages.some((s) => s.status === 'check') || warnings > 0) return { confidence: 'review', score };
  return { confidence: 'high', score };
}

function sortDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...items].sort(
    (a, b) =>
      a.stageIndex - b.stageIndex || a.span.start - b.span.start || rank[a.severity] - rank[b.severity] || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}

function internalError(spl: unknown, error: unknown): TranslateResult {
  const length = typeof spl === 'string' ? spl.length : 0;
  const detail = error instanceof Error ? error.message : String(error);
  return {
    dql: '',
    confidence: 'none',
    score: 0,
    diagnostics: [
      {
        code: 'SPL1008',
        severity: 'error',
        message: `The translator hit an internal problem: ${detail.slice(0, 200)}`,
        hint: 'Please report the search (with sensitive values removed) so it can be fixed.',
        span: { start: 0, end: length },
        stageIndex: -1,
      },
    ],
    stages: [],
  };
}
