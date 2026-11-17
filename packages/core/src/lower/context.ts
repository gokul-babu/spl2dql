import { DiagnosticCollector, type ReportOptions } from '../diagnostics/collector.ts';
import { bool, cmd, type DqlCommand, type DqlExpr, dpl, field as fieldExpr, named } from '../dql/ast.ts';
import { Scanner } from '../spl/scanner.ts';
import type { DatamodelMapping, FieldType, MappingConfig, Span, TranslateOptions } from '../types.ts';
import { dict } from '../util/dict.ts';

/** What the records flowing into a stage look like. */
export type SchemaKind = 'events' | 'table' | 'series';

export interface Schema {
  kind: SchemaKind;
  /** DQL field names known to exist. For "events" these are only the fields created upstream. */
  fields: string[];
}

/** Built-in Splunk → Grail field names (docs/spec/mapping-config.md). */
const BUILTIN_FIELDS: Readonly<Record<string, string>> = dict({
  _time: 'timestamp',
  _raw: 'content',
  host: 'host.name',
  source: 'log.source',
  index: 'dt.system.bucket',
});

/** `Dataset.field` or `Dataset.Child.field`, as fields are written in a data-model search. */
const DATASET_FIELD = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** Splunk fields that always exist on events, even without a mapping. */
const DEFAULT_SPL_FIELDS = new Set(['_time', '_raw', 'host', 'source', 'index', 'sourcetype', 'linecount', 'punct', 'splunk_server', 'timestamp']);

/** Thrown inside a command when part of it cannot be translated; caught by the stage driver. */
export class Untranslatable extends Error {
  readonly code: string;
  readonly span: Span;
  constructor(code: string, span: Span, detail: string) {
    super(detail);
    this.code = code;
    this.span = span;
  }
}

export interface PipelineState {
  schema: Schema;
  /** SPL field names created upstream (eval, rex, rename …). */
  created: Set<string>;
  /** Fields the user marked unresolvable (failed rex captures). */
  unresolved: Set<string>;
  /** Mapping-file extractions already emitted. */
  extracted: Set<string>;
  /** `from` + pattern of the parse commands already emitted (one pattern can create several fields). */
  extractedPatterns: Set<string>;
  /**
   * The pipeline reads a Splunk data model. Field names are then written `<dataset>.<field>`; the
   * prefix is dropped and the field resolved through the data model's own `fields` first.
   */
  datamodel?: { model: string; key: string; entry?: DatamodelMapping };
  /** Records have an explicit order (sort, timechart, stats …). */
  sorted: boolean;
  /** Sort keys of the most recent `sort`, for `reverse`. */
  lastSort?: DqlExpr[];
  /** The previous stage produced series arrays (timechart in series mode). */
  series: boolean;
  /** The previous stage was a sort (for reverse). */
  lastWasSort: boolean;
  /** An earlier stage could not be translated; fields it would have created are unknown. */
  opaqueUpstream: boolean;
  /** Types of fields created upstream (aggregates are numbers, eval results when known). */
  types: Map<string, FieldType>;
}

export interface SubPipeline {
  commands: DqlCommand[];
  /** Output fields when the sub-pipeline ends in a known table (stats, table, fields). */
  outputFields?: string[];
  /** Some stage inside could not be translated. */
  incomplete: boolean;
}

/** Shared by every pipeline of one translation (top level and subsearches). */
export class TranslationContext {
  readonly text: string;
  readonly mapping: MappingConfig;
  readonly options: TranslateOptions;
  readonly diags: DiagnosticCollector;

  /** Lowers `[ … ]` as a nested pipeline. Installed by the pipeline driver (avoids an import cycle). */
  lowerSub: (inner: Span, parent: Stage) => SubPipeline = () => ({ commands: [], incomplete: true });
  /** Lowers a subsearch used as a filter inside a search expression. Installed by the driver. */
  lowerSubsearchFilter: (node: { inner: Span; span: Span }, st: Stage) => DqlExpr | undefined = () => undefined;

  constructor(text: string, mapping: MappingConfig, options: TranslateOptions) {
    this.text = text;
    this.mapping = mapping;
    this.options = options;
    this.diags = new DiagnosticCollector(options.strict ?? false);
  }
}

/** One SPL stage being lowered. Command modules receive this. */
export class Stage {
  readonly tc: TranslationContext;
  readonly state: PipelineState;
  /** Stage index used for diagnostics and origins (a subsearch uses its parent's index). */
  readonly index: number;
  readonly command: string;
  readonly span: Span;
  readonly argsSpan: Span;
  /** True for the first stage of a pipeline. */
  readonly first: boolean;
  /** Lower-case names of the commands after this one in the same pipeline (a view, not a copy). */
  private readonly next: { names: readonly string[]; from: number };
  /** Commands emitted so far in this pipeline (before this stage). */
  readonly upstream: readonly DqlCommand[];
  /** Subsearch nesting depth; 0 for the top-level pipeline. */
  readonly depth: number;
  /** The previous stage produced series arrays (timechart in series mode). */
  readonly prevSeries: boolean;
  /** The previous stage was a sort. */
  readonly prevWasSort: boolean;

  /** Commands emitted by this stage. */
  readonly out: DqlCommand[] = [];
  /** Extraction parses that must run before this stage's commands. */
  readonly pre: DqlCommand[] = [];
  untranslated = false;

  constructor(init: {
    tc: TranslationContext;
    state: PipelineState;
    index: number;
    command: string;
    span: Span;
    argsSpan: Span;
    first: boolean;
    following: { names: readonly string[]; from: number };
    upstream: readonly DqlCommand[];
    depth: number;
    prevSeries: boolean;
    prevWasSort: boolean;
  }) {
    this.tc = init.tc;
    this.state = init.state;
    this.index = init.index;
    this.command = init.command;
    this.span = init.span;
    this.argsSpan = init.argsSpan;
    this.first = init.first;
    this.next = init.following;
    this.upstream = init.upstream;
    this.depth = init.depth;
    this.prevSeries = init.prevSeries;
    this.prevWasSort = init.prevWasSort;
  }

  get following(): readonly string[] {
    return this.next.names.slice(this.next.from);
  }

  get mapping(): MappingConfig {
    return this.tc.mapping;
  }

  scanner(): Scanner {
    return new Scanner(this.tc.text, this.argsSpan.start, this.argsSpan.end);
  }

  slice(span: Span): string {
    return this.tc.text.slice(span.start, span.end);
  }

  emit(command: Omit<DqlCommand, 'origin'>): void {
    this.out.push({ ...command, origin: [this.index] });
  }

  report(code: string, span: Span = this.span, options: ReportOptions = {}): void {
    this.tc.diags.report(code, span, this.index, options);
  }

  /** Marks the whole stage as not translated and leaves a comment line in the DQL. */
  giveUp(code: string, detail?: string, span: Span = this.span): void {
    this.untranslated = true;
    this.out.length = 0;
    this.report(code, span, detail === undefined ? {} : { detail });
    this.out.push({ name: '//', args: [], origin: [this.index], comment: `not translated: ${this.slice(this.span)}` });
  }

  /** Marks the stage as not translated without a new note (the cause was reported elsewhere). */
  giveUpSilently(): void {
    this.untranslated = true;
    this.out.length = 0;
    this.out.push({ name: '//', args: [], origin: [this.index], comment: `not translated: ${this.slice(this.span)}` });
  }

  /** The DQL name of an SPL field, reporting mapping notes. `define` = the stage creates it. */
  field(rawName: string, span: Span, define = false): string {
    const m = this.tc.mapping;
    const dm = this.state.datamodel;
    // In a data-model search `Authentication.user` is the field `user` of the dataset.
    const prefixed = dm !== undefined && !define && DATASET_FIELD.test(rawName) && !m.fields.has(rawName);
    const splName = prefixed ? rawName.slice(rawName.lastIndexOf('.') + 1) : rawName;
    const fromModel = dm !== undefined && !define ? dm.entry?.fields.get(splName) : undefined;
    const user = fromModel ?? m.fields.get(splName);
    const builtin = BUILTIN_FIELDS[splName];
    const dqlName = user ?? builtin ?? splName;
    if (define) {
      this.state.created.add(splName);
      return dqlName;
    }
    if (builtin !== undefined && user === undefined) this.tc.diags.reportOnce('SPL5002', span, this.index);
    if (this.state.schema.kind !== 'events') return dqlName;
    if (this.state.created.has(splName) || user !== undefined || builtin !== undefined) return dqlName;
    if (splName.includes('*')) return dqlName;
    // A data model's fields are already normalised; search-time extractions belong to raw events.
    const extraction = dm === undefined ? m.extractions.get(splName) : undefined;
    if (extraction) {
      if (!this.state.extracted.has(splName)) {
        this.state.extracted.add(splName);
        const key = `${extraction.from}\u0000${extraction.dpl}`;
        if (!this.state.extractedPatterns.has(key)) {
          this.state.extractedPatterns.add(key);
          // Like a Splunk search-time extraction, it only adds the field where the pattern matches:
          // a record of another shape keeps the value it already has.
          this.pre.push({
            ...cmd('parse', fieldExpr(extraction.from), dpl(extraction.dpl), named('preserveFieldsOnFailure', bool(true))),
            origin: [this.index],
          });
        }
      }
      return dqlName;
    }
    if (splName === 'sourcetype') {
      this.report('SPL4002', span, { subject: 'sourcetype', detail: 'The sourcetype field does not exist in Grail; map the sourcetype instead.' });
      return dqlName;
    }
    if (DEFAULT_SPL_FIELDS.has(splName)) return dqlName;
    if (dm !== undefined) {
      this.report('SPL4003', span, {
        subject: `datamodel:${dm.key}:${splName}`,
        detail: `"${splName}" has no entry under datamodels → ${dm.key} → fields in the mapping file; its Splunk name was kept.`,
      });
      return dqlName;
    }
    if (this.state.unresolved.has(splName) || this.state.opaqueUpstream) {
      this.report('SPL4003', span, {
        subject: splName,
        detail: `"${splName}" is unknown here; it may come from an earlier step that was not translated.`,
      });
      return dqlName;
    }
    this.report('SPL4003', span, {
      subject: splName,
      detail: `"${splName}" is not mapped and is not created earlier in the search; in Splunk it is probably extracted at search time.`,
    });
    return dqlName;
  }

  fieldType(dqlName: string): FieldType | undefined {
    if (dqlName === 'timestamp') return 'time';
    return this.state.types.get(dqlName) ?? this.tc.mapping.fieldTypes.get(dqlName);
  }

  /** Records the type of a field this stage creates. */
  setType(dqlName: string, type: FieldType | undefined): void {
    if (type) this.state.types.set(dqlName, type);
    else this.state.types.delete(dqlName);
  }

  /** The Splunk name of a DQL field (reverse of the mapping), for matching wildcards. */
  splName(dqlName: string): string {
    for (const [spl, dql] of this.tc.mapping.fields) if (dql === dqlName) return spl;
    for (const [spl, dql] of Object.entries(BUILTIN_FIELDS)) if (dql === dqlName) return spl;
    return dqlName;
  }

  /** True when the records are raw events that have not been ordered explicitly. */
  get unorderedEvents(): boolean {
    return this.state.schema.kind === 'events' && !this.state.sorted;
  }

  /** Sets the schema after a transforming command. */
  setTable(fields: string[]): void {
    this.state.schema = { kind: 'table', fields: unique(fields) };
    this.state.created = new Set(this.state.created);
    this.state.sorted = false;
  }

  /** Adds fields to a known table schema (no effect on raw events). */
  addFields(fields: string[]): void {
    if (this.state.schema.kind !== 'events') {
      this.state.schema = { kind: this.state.schema.kind, fields: unique([...this.state.schema.fields, ...fields]) };
    }
  }
}

export function newPipelineState(): PipelineState {
  return {
    schema: { kind: 'events', fields: [] },
    created: new Set(),
    unresolved: new Set(),
    extracted: new Set(),
    extractedPatterns: new Set(),
    sorted: false,
    series: false,
    lastWasSort: false,
    opaqueUpstream: false,
    types: new Map(),
  };
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
