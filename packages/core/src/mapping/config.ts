import { checkDqlExpression } from '../dql/check.ts';
import type {
  DatamodelMapping,
  ExtractionMapping,
  FieldType,
  IndexMapping,
  LookupMapping,
  MacroMapping,
  MappingConfig,
  MappingIssue,
  Result,
  SourcetypeMapping,
} from '../types.ts';

/** An empty mapping: every name falls back to the built-in defaults. */
export function emptyMapping(): MappingConfig {
  return {
    version: 1,
    defaults: { dataObject: 'logs', timezone: 'UTC' },
    indexes: new Map(),
    sourcetypes: new Map(),
    fields: new Map(),
    fieldTypes: new Map(),
    extractions: new Map(),
    macros: new Map(),
    lookups: new Map(),
    eventtypes: new Map(),
    tags: new Map(),
    metrics: new Map(),
    datamodels: new Map(),
  };
}

const TOP_KEYS = [
  'version',
  'defaults',
  'indexes',
  'sourcetypes',
  'fields',
  'fieldTypes',
  'extractions',
  'macros',
  'lookups',
  'eventtypes',
  'tags',
  'metrics',
  'datamodels',
] as const;

const DATA_OBJECT = /^[a-z][a-z0-9_.]{0,63}$/;
const BUCKET = /^[A-Za-z0-9_-]{1,128}$/;
// Grail field names: dotted identifiers, plus "-", ":" and "@" seen in real data. No backticks or quotes.
const DQL_FIELD = /^[A-Za-z_@][A-Za-z0-9_.:@-]{0,255}$/;
const LOOKUP_PATH = /^\/lookups\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const SPL_NAME = /^[^\s`"|[\]]{1,256}$/;
const DATAMODEL = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/;
const TIMEFRAME = /^-?\d+(s|m|h|d|w|M|q|y)(@[a-zA-Z0-9]+)?$/;
const FIELD_TYPES: readonly FieldType[] = ['number', 'string', 'time', 'duration', 'boolean', 'ip'];
const MAX_ENTRIES = 10_000;
const MAX_TEXT = 10_000;

/**
 * Validates a parsed mapping file (YAML/JSON already decoded by the caller). Unknown keys are errors
 * so typos are caught. Never throws for any input.
 */
export function parseMappingConfig(input: unknown): Result<MappingConfig, MappingIssue[]> {
  const issues: MappingIssue[] = [];
  const out = emptyMapping();
  const v = new Validator(issues);

  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: '', message: 'The mapping file must be a map of sections.' }] };
  }
  for (const key of Object.keys(input)) {
    if (!(TOP_KEYS as readonly string[]).includes(key)) {
      issues.push({ path: `/${esc(key)}`, message: `Unknown section "${key}".` });
    }
  }
  if (input.version !== 1) {
    issues.push({ path: '/version', message: 'Set "version: 1".' });
  }

  const defaults = input.defaults;
  if (defaults !== undefined) {
    if (v.record(defaults, '/defaults', ['dataObject', 'timeframe', 'timezone'])) {
      if (defaults.dataObject !== undefined && v.pattern(defaults.dataObject, '/defaults/dataObject', DATA_OBJECT, 'a data object name such as "logs"')) {
        out.defaults.dataObject = defaults.dataObject;
      }
      if (defaults.timeframe !== undefined && defaults.timeframe !== null) {
        if (v.pattern(defaults.timeframe, '/defaults/timeframe', TIMEFRAME, 'a relative time such as "-24h"')) {
          out.defaults.timeframe = defaults.timeframe;
        }
      }
      if (defaults.timezone !== undefined) {
        if (v.string(defaults.timezone, '/defaults/timezone') && isValidZone(defaults.timezone)) {
          out.defaults.timezone = defaults.timezone;
        } else if (typeof defaults.timezone === 'string') {
          issues.push({ path: '/defaults/timezone', message: `"${defaults.timezone}" is not a known time zone.` });
        }
      }
    }
  }

  out.indexes = v.section(input.indexes, '/indexes', SPL_NAME, (val, p): IndexMapping | undefined => {
    if (!v.record(val, p, ['dataObject', 'buckets', 'filter'])) return undefined;
    const m: IndexMapping = { dataObject: out.defaults.dataObject, buckets: [] };
    if (val.dataObject !== undefined && v.pattern(val.dataObject, `${p}/dataObject`, DATA_OBJECT, 'a data object name such as "logs"')) {
      m.dataObject = val.dataObject;
    }
    if (val.buckets !== undefined) m.buckets = v.stringList(val.buckets, `${p}/buckets`, BUCKET, 'a bucket name');
    if (val.filter !== undefined) {
      const f = v.dqlFilter(val.filter, `${p}/filter`);
      if (f !== undefined) m.filter = f;
    }
    return m;
  });

  out.sourcetypes = v.section(input.sourcetypes, '/sourcetypes', SPL_NAME, (val, p): SourcetypeMapping | undefined => {
    if (!v.record(val, p, ['filter', 'extractions'])) return undefined;
    const m: SourcetypeMapping = { extractions: [] };
    if (val.filter !== undefined) {
      const f = v.dqlFilter(val.filter, `${p}/filter`);
      if (f !== undefined) m.filter = f;
    }
    if (val.extractions !== undefined) m.extractions = v.stringList(val.extractions, `${p}/extractions`, SPL_NAME, 'a field name');
    return m;
  });

  out.fields = v.section(input.fields, '/fields', SPL_NAME, (val, p) =>
    v.pattern(val, p, DQL_FIELD, 'a Grail field name such as "host.name"') ? val : undefined,
  );

  out.fieldTypes = v.section(input.fieldTypes, '/fieldTypes', DQL_FIELD, (val, p) => {
    if (typeof val === 'string' && (FIELD_TYPES as readonly string[]).includes(val)) return val as FieldType;
    issues.push({ path: p, message: `Use one of: ${FIELD_TYPES.join(', ')}.` });
    return undefined;
  });

  out.extractions = v.section(input.extractions, '/extractions', SPL_NAME, (val, p): ExtractionMapping | undefined => {
    if (!v.record(val, p, ['from', 'dpl'])) return undefined;
    const from = val.from === undefined ? 'content' : val.from;
    if (!v.pattern(from, `${p}/from`, DQL_FIELD, 'a Grail field name')) return undefined;
    if (!v.text(val.dpl, `${p}/dpl`)) return undefined;
    return { from, dpl: val.dpl };
  });

  out.macros = v.section(input.macros, '/macros', /^[A-Za-z0-9_.:-]+(\(\d{1,2}\))?$/, (val, p, key): MacroMapping | undefined => {
    const definition = typeof val === 'string' ? val : isRecord(val) ? val.definition : undefined;
    if (isRecord(val) && !v.record(val, p, ['args', 'definition'])) return undefined;
    if (!v.text(definition, typeof val === 'string' ? p : `${p}/definition`)) return undefined;
    const args = isRecord(val) && val.args !== undefined ? v.stringList(val.args, `${p}/args`, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'an argument name') : [];
    const arity = /\((\d+)\)$/.exec(key);
    const declared = arity ? Number(arity[1]) : 0;
    if (declared !== args.length) {
      issues.push({ path: p, message: `The macro name says ${declared} argument(s) but "args" lists ${args.length}.` });
      return undefined;
    }
    return { args, definition };
  });

  out.lookups = v.section(input.lookups, '/lookups', SPL_NAME, (val, p): LookupMapping | undefined => {
    if (!v.record(val, p, ['path', 'key', 'columns'])) return undefined;
    if (!v.pattern(val.path, `${p}/path`, LOOKUP_PATH, 'a Grail file path starting with "/lookups/"')) return undefined;
    if (val.path.includes('..')) {
      issues.push({ path: `${p}/path`, message: 'The path must not contain "..".' });
      return undefined;
    }
    const m: LookupMapping = { path: val.path };
    if (val.key !== undefined && v.pattern(val.key, `${p}/key`, DQL_FIELD, 'a column name')) m.key = val.key;
    if (val.columns !== undefined) m.columns = v.stringList(val.columns, `${p}/columns`, DQL_FIELD, 'a column name');
    return m;
  });

  out.eventtypes = v.section(input.eventtypes, '/eventtypes', SPL_NAME, (val, p) => v.dqlFilter(val, p));
  out.tags = v.section(input.tags, '/tags', SPL_NAME, (val, p) => v.dqlFilter(val, p));
  out.metrics = v.section(input.metrics, '/metrics', SPL_NAME, (val, p) =>
    v.pattern(val, p, DQL_FIELD, 'a metric key such as "dt.host.cpu.usage"') ? val : undefined,
  );

  out.datamodels = v.section(input.datamodels, '/datamodels', DATAMODEL, (val, p): DatamodelMapping | undefined => {
    if (!v.record(val, p, ['dataObject', 'buckets', 'filter', 'fields'])) return undefined;
    let dataObject = out.defaults.dataObject;
    if (val.dataObject !== undefined && v.pattern(val.dataObject, `${p}/dataObject`, DATA_OBJECT, 'a data object name such as "logs"')) {
      dataObject = val.dataObject;
    }
    const buckets = val.buckets !== undefined ? v.stringList(val.buckets, `${p}/buckets`, BUCKET, 'a bucket name') : [];
    const fields = v.section(val.fields, `${p}/fields`, SPL_NAME, (f, fp) =>
      v.pattern(f, fp, DQL_FIELD, 'a Grail field name such as "user.name"') ? f : undefined,
    );
    const m: DatamodelMapping = { dataObject, buckets, fields };
    if (val.filter !== undefined) {
      const f = v.dqlFilter(val.filter, `${p}/filter`);
      if (f !== undefined) m.filter = f;
    }
    return m;
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
}

class Validator {
  private readonly issues: MappingIssue[];
  constructor(issues: MappingIssue[]) {
    this.issues = issues;
  }

  record(val: unknown, path: string, allowed: readonly string[]): val is Record<string, unknown> {
    if (!isRecord(val)) {
      this.issues.push({ path, message: 'Expected a map.' });
      return false;
    }
    for (const key of Object.keys(val)) {
      if (!allowed.includes(key)) this.issues.push({ path: `${path}/${esc(key)}`, message: `Unknown key "${key}". Allowed: ${allowed.join(', ')}.` });
    }
    return true;
  }

  string(val: unknown, path: string): val is string {
    if (typeof val !== 'string') {
      this.issues.push({ path, message: 'Expected text.' });
      return false;
    }
    return true;
  }

  text(val: unknown, path: string): val is string {
    if (!this.string(val, path)) return false;
    if (val.length === 0 || val.length > MAX_TEXT) {
      this.issues.push({ path, message: `Expected 1 to ${MAX_TEXT} characters.` });
      return false;
    }
    return true;
  }

  pattern(val: unknown, path: string, re: RegExp, what: string): val is string {
    if (typeof val !== 'string' || !re.test(val)) {
      this.issues.push({ path, message: `Expected ${what}.` });
      return false;
    }
    return true;
  }

  stringList(val: unknown, path: string, re: RegExp, what: string): string[] {
    if (!Array.isArray(val)) {
      this.issues.push({ path, message: 'Expected a list.' });
      return [];
    }
    if (val.length > MAX_ENTRIES) {
      this.issues.push({ path, message: `At most ${MAX_ENTRIES} entries.` });
      return [];
    }
    const out: string[] = [];
    val.forEach((item, i) => {
      if (this.pattern(item, `${path}/${i}`, re, what)) out.push(item);
    });
    return out;
  }

  dqlFilter(val: unknown, path: string): string | undefined {
    if (!this.text(val, path)) return undefined;
    const check = checkDqlExpression(val);
    if (!check.ok) {
      const first = check.issues[0];
      this.issues.push({ path, message: `Not a valid DQL condition: ${first?.message ?? 'syntax error'}` });
      return undefined;
    }
    return val;
  }

  section<T>(val: unknown, path: string, keyPattern: RegExp, each: (value: unknown, path: string, key: string) => T | undefined): Map<string, T> {
    const out = new Map<string, T>();
    if (val === undefined || val === null) return out;
    if (!isRecord(val)) {
      this.issues.push({ path, message: 'Expected a map.' });
      return out;
    }
    const keys = Object.keys(val);
    if (keys.length > MAX_ENTRIES) {
      this.issues.push({ path, message: `At most ${MAX_ENTRIES} entries.` });
      return out;
    }
    for (const key of keys) {
      const p = `${path}/${esc(key)}`;
      if (!keyPattern.test(key)) {
        this.issues.push({ path: p, message: `"${key}" is not a valid name here.` });
        continue;
      }
      const item = each(val[key], p, key);
      if (item !== undefined) out.set(key, item);
    }
    return out;
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function esc(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

const FIXED_OFFSET = /^(UTC|Z|[+-]\d{2}:\d{2})$/;

export function isValidZone(zone: string): boolean {
  if (FIXED_OFFSET.test(zone)) return true;
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
