import { getCommand } from '../commands/registry.ts';
import { bin, call, cmd, type DqlCommand, type DqlExpr, field, sub } from '../dql/ast.ts';
import { printedLength, UnprintableName } from '../dql/printer.ts';
import { MAX_OUTPUT } from '../limits.ts';
import { splitStages } from '../spl/split.ts';
import type { Span } from '../types.ts';
import { newPipelineState, type PipelineState, Stage, type SubPipeline, type TranslationContext, Untranslatable } from './context.ts';

export interface StageOutcome {
  index: number;
  command: string;
  span: Span;
  untranslated: boolean;
}

export interface PipelineResult {
  commands: DqlCommand[];
  stages: StageOutcome[];
  state: PipelineState;
}

const MAX_SUB_DEPTH = 16;
const MAX_STAGES = 5_000;
const DATA_SOURCES = new Set(['fetch', 'load', 'data', 'timeseries', 'metrics', 'smartscapeNodes', 'smartscapeEdges', 'describe', 'fieldsSnapshot']);

/**
 * Lowers one SPL pipeline. For a subsearch, `fixedIndex` is the parent stage's index so every
 * diagnostic and DQL command is attributed to the stage that contains the subsearch.
 */
export function lowerPipeline(tc: TranslationContext, region: Span, depth: number, fixedIndex?: number): PipelineResult {
  installHooks(tc);
  const split = splitStages(tc.text, region.start, region.end);
  const state = newPipelineState();
  const commands: DqlCommand[] = [];
  const stages: StageOutcome[] = [];

  if (split.problem) {
    tc.diags.report('SPL1001', split.problem.span, fixedIndex ?? stageIndexAt(split.stages, split.problem.span.start), {
      detail: split.problem.detail,
    });
  }

  if (split.stages.length > MAX_STAGES) {
    tc.diags.report('SPL1006', region, fixedIndex ?? 0, { detail: `The search has more than ${MAX_STAGES} pipeline stages.` });
    return { commands: [], stages: [], state };
  }
  const names = split.stages.map((s, i) => commandName(tc.text, s.span, i === 0 && !s.leadingPipe).name);
  /** Characters this pipeline's DQL takes so far; past MAX_OUTPUT the translation stops. */
  let printed = 0;

  split.stages.forEach((raw, i) => {
    const index = fixedIndex ?? i;
    const implicit = i === 0 && !raw.leadingPipe;
    const { name, argsStart } = commandName(tc.text, raw.span, implicit);
    const argsSpan = { start: argsStart, end: raw.span.end };
    const st = new Stage({
      tc,
      state,
      index,
      command: name || '(empty)',
      span: raw.span,
      argsSpan,
      first: i === 0,
      following: { names, from: i + 1 },
      upstream: commands,
      depth,
      prevSeries: state.series,
      prevWasSort: state.lastWasSort,
    });
    state.series = false;
    state.lastWasSort = false;

    if (raw.span.start >= raw.span.end) {
      st.untranslated = true;
      tc.diags.report('SPL1002', { start: raw.span.start, end: raw.span.start }, index, {
        detail: i === 0 && split.stages.length === 1 ? 'The search is empty.' : 'This pipeline stage is empty.',
      });
    } else if (tc.text[raw.span.start] === '`') {
      // An unresolved macro used as a whole stage; SPL4004 already explains it.
      st.giveUpSilently();
    } else {
      const def = getCommand(name);
      if (!def) {
        st.giveUp('SPL2001', `"${name}" is not a command the translator knows.`, { start: raw.span.start, end: argsStart });
      } else {
        if (i === 0 && raw.leadingPipe && !def.generating) {
          tc.diags.report('SPL1007', raw.span, index, { detail: `"${name}" cannot start a search.` });
        }
        try {
          def.lower(st);
        } catch (e) {
          // A stage too large for the call stack (a list of hundreds of thousands of names spread
          // into one call somewhere) is a stage that is too large, not an internal problem.
          if (e instanceof RangeError) st.giveUp('SPL1006', 'This stage is too large to translate.');
          else if (!(e instanceof Untranslatable)) throw e;
          else st.giveUp(e.code, e.message, e.span);
        }
      }
    }
    printed += measureStage(st, printed);
    if (st.untranslated) state.opaqueUpstream = true;
    // Extractions run before the stage that needs them — but after the data source it starts with.
    const source = st.out[0];
    const ordered = source && st.pre.length > 0 && DATA_SOURCES.has(source.name) ? [source, ...st.pre, ...st.out.slice(1)] : [...st.pre, ...st.out];
    for (const c of ordered) commands.push(c);
    stages.push({ index, command: st.command, span: raw.span, untranslated: st.untranslated });
  });

  if (depth === 0 && fixedIndex === undefined) {
    const firstReal = commands.find((c) => c.name !== '//');
    const flagged = tc.diags.items.some((d) => d.code === 'SPL1007');
    if (firstReal && !DATA_SOURCES.has(firstReal.name) && !flagged) {
      tc.diags.report('SPL1007', split.stages[0]?.span ?? region, 0);
    }
  }
  return { commands, stages, state };
}

/**
 * Prints the stage's commands once to know their length (OutputTooLarge past the output budget,
 * which ends the translation). A field name DQL cannot hold makes the stage not translated: every
 * name reaches the text through the printer, so this one check covers every command (ADR-029).
 */
function measureStage(st: Stage, printed: number): number {
  try {
    return printedLength([...st.pre, ...st.out], MAX_OUTPUT - printed);
  } catch (e) {
    if (!(e instanceof UnprintableName)) throw e;
    st.pre.length = 0;
    st.giveUp('SPL2012', `The field name "${clipName(e.fieldName)}" contains a backtick or a line break, which DQL cannot hold here.`);
    return printedLength(st.out, MAX_OUTPUT - printed);
  }
}

function clipName(name: string): string {
  const one = name.replace(/[\r\n]+/g, ' ');
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

function stageIndexAt(stages: { span: Span }[], offset: number): number {
  const i = stages.findIndex((s) => offset <= s.span.end);
  return i === -1 ? Math.max(0, stages.length - 1) : i;
}

export function commandName(text: string, span: Span, implicitSearch: boolean): { name: string; argsStart: number } {
  const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(span.start, Math.min(span.end, span.start + 64)));
  const word = m ? m[0].toLowerCase() : '';
  if (implicitSearch) {
    if (word === 'search' && /^search(\s|$)/i.test(text.slice(span.start, span.start + 7))) {
      return { name: 'search', argsStart: span.start + 6 };
    }
    return { name: 'search', argsStart: span.start };
  }
  return { name: word, argsStart: span.start + word.length };
}

function installHooks(tc: TranslationContext): void {
  tc.lowerSub = (inner, parent) => lowerSubPipeline(tc, inner, parent);
  tc.lowerSubsearchFilter = (node, st) => subsearchFilter(tc, node, st);
}

function lowerSubPipeline(tc: TranslationContext, inner: Span, parent: Stage): SubPipeline {
  if (parent.depth + 1 > MAX_SUB_DEPTH) {
    throw new Untranslatable('SPL1006', inner, `Subsearches are nested more than ${MAX_SUB_DEPTH} deep.`);
  }
  // A subsearch body is "search …" or "| generating …"; strip an explicit leading "search".
  const result = lowerPipeline(tc, inner, parent.depth + 1, parent.index);
  const incomplete = result.stages.some((s) => s.untranslated);
  const out: SubPipeline = {
    commands: result.commands.filter((c) => c.name !== '//'),
    incomplete,
  };
  if (result.state.schema.kind !== 'events') out.outputFields = result.state.schema.fields;
  return out;
}

/**
 * `[search … | fields f]` inside a search: `F in [ … | fields F ]` (spl-dql-mapping.md §4.9).
 */
function subsearchFilter(tc: TranslationContext, node: { inner: Span; span: Span }, st: Stage): DqlExpr | undefined {
  const subResult = lowerSubPipeline(tc, node.inner, st);
  if (subResult.incomplete) {
    throw new Untranslatable('SPL2007', node.span, 'The subsearch contains a step that could not be translated.');
  }
  // `fields f` keeps timestamp and content on raw events; they are not part of the subsearch result.
  const visible = subResult.outputFields?.filter((f) => f !== 'timestamp' && f !== 'content');
  const fields = visible && visible.length > 0 ? visible : subResult.outputFields;
  if (fields?.length !== 1) {
    throw new Untranslatable('SPL2007', node.span, 'Only a subsearch that returns exactly one field (… | fields f) can be translated.');
  }
  const f = fields[0] as string;
  st.report('SPL3001', node.span, { detail: 'The subsearch match is exact and case-sensitive in DQL.' });
  st.report('SPL3009', node.span, { detail: 'Splunk limits subsearch results by count and time; DQL limits them by size.' });
  const body = subResult.commands;
  const fieldsCmd = { ...cmd('fields', field(f)), origin: [st.index] };
  const last = body[body.length - 1];
  const beforeLast = body[body.length - 2];
  if (last && (last.name === 'fieldsKeep' || last.name === 'fields')) body[body.length - 1] = fieldsCmd;
  else if (!(last?.name === 'limit' && beforeLast?.name === 'fields')) body.push(fieldsCmd);
  return bin('in', field(f), sub(body));
}

/** Wraps an expression as `isFalseOrNull(expr)`; exported for commands that build NOT filters. */
export function falseOrNull(e: DqlExpr): DqlExpr {
  return call('isFalseOrNull', e);
}
