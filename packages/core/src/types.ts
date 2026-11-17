/** Offsets into a string, UTF-16 code units, end exclusive. */
export interface Span {
  start: number;
  end: number;
}

export type Severity = 'error' | 'warning' | 'info';

export type Confidence = 'high' | 'review' | 'low' | 'none';

export type StageStatus = 'exact' | 'check' | 'untranslated';

export interface Diagnostic {
  /** Stable code, e.g. "SPL3001". See docs/spec/spl-dql-mapping.md §2. */
  code: string;
  severity: Severity;
  /** Plain-language description of this occurrence. */
  message: string;
  /** What to do about it. */
  hint?: string;
  /** Where in the SPL input this applies. */
  span: Span;
  /** 0-based index of the SPL pipeline stage; -1 for query-level notes. */
  stageIndex: number;
  /** The environment name involved, for SPL4xxx (index, field, macro, lookup …). */
  subject?: string;
}

export interface StageResult {
  index: number;
  /** Lower-case SPL command name, "search" for the implicit leading search. */
  command: string;
  status: StageStatus;
  /** Span of the stage in the SPL input (without the separating pipe). */
  spl: Span;
  /** Spans of the DQL lines this stage produced. Empty when nothing was emitted. */
  dql: Span[];
}

export interface TimeRange {
  /** Splunk time-picker value, e.g. "-24h@h". */
  earliest?: string;
  latest?: string;
}

/** A Splunk dashboard token and the Dynatrace dashboard variable that replaces it. */
export interface DashboardToken {
  /** Variable key, used as `$key` in DQL. */
  variable: string;
  /** One value, several values (multiselect), free text, or the dashboard's time range. */
  kind: 'single' | 'multiple' | 'text' | 'time';
}

export interface TranslateOptions {
  mapping?: MappingConfig;
  timeRange?: TimeRange;
  /** Raise every missing-mapping note (SPL4xxx) to an error. */
  strict?: boolean;
  /**
   * Dashboard tokens by name (without the dollar signs). Given when a dashboard panel is translated:
   * `host=$tok$` then becomes a condition on the variable instead of plain text.
   */
  tokens?: ReadonlyMap<string, DashboardToken>;
}

/** What the records look like after the last stage: raw events, a table, or time-series arrays. */
export interface ResultShape {
  kind: 'events' | 'table' | 'series';
  /** Field names known to exist. For events only the fields the search created. */
  fields: string[];
}

export interface TranslateResult {
  dql: string;
  confidence: Confidence;
  /** 0–100, only meant for sorting batch results. */
  score: number;
  diagnostics: Diagnostic[];
  stages: StageResult[];
  /** Shape of the result, used to choose a visualization. Missing when nothing was translated. */
  shape?: ResultShape;
  /** Dashboard variables the DQL refers to (only with `options.tokens`). */
  variables?: string[];
}

// ---------------------------------------------------------------------------------------------------
// Mapping file (docs/spec/mapping-config.md). Validated by parseMappingConfig().

export type FieldType = 'number' | 'string' | 'time' | 'duration' | 'boolean' | 'ip';

export interface IndexMapping {
  dataObject: string;
  buckets: readonly string[];
  filter?: string;
}

export interface SourcetypeMapping {
  filter?: string;
  extractions: readonly string[];
}

export interface ExtractionMapping {
  from: string;
  dpl: string;
}

export interface MacroMapping {
  args: readonly string[];
  definition: string;
}

export interface LookupMapping {
  path: string;
  key?: string;
  columns?: readonly string[];
}

export interface DatamodelMapping {
  dataObject: string;
  buckets: readonly string[];
  filter?: string;
  /** Data-model field name (without the dataset prefix) → Grail field name. */
  fields: ReadonlyMap<string, string>;
}

export interface MappingConfig {
  version: 1;
  defaults: { dataObject: string; timeframe?: string; timezone: string };
  indexes: ReadonlyMap<string, IndexMapping>;
  sourcetypes: ReadonlyMap<string, SourcetypeMapping>;
  fields: ReadonlyMap<string, string>;
  fieldTypes: ReadonlyMap<string, FieldType>;
  extractions: ReadonlyMap<string, ExtractionMapping>;
  macros: ReadonlyMap<string, MacroMapping>;
  lookups: ReadonlyMap<string, LookupMapping>;
  eventtypes: ReadonlyMap<string, string>;
  tags: ReadonlyMap<string, string>;
  metrics: ReadonlyMap<string, string>;
  /** Splunk data model, or "Model.Dataset", → where its data is in Grail. */
  datamodels: ReadonlyMap<string, DatamodelMapping>;
}

export interface MappingIssue {
  /** JSON pointer to the offending value, e.g. "/indexes/web/buckets/0". */
  path: string;
  message: string;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; issues: E };
