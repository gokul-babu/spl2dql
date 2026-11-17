# Translation engine (`packages/core`)

How SPL text becomes DQL text. What each SPL command translates *to* is in
`docs/spec/spl-dql-mapping.md`; this file specifies the machinery.

## Public API

```ts
export function translate(spl: string, options?: TranslateOptions): TranslateResult;
export function translateCondition(search: string, options?: TranslateOptions): { condition?: string; diagnostics: Diagnostic[] };
export function parseMappingConfig(input: unknown): Result<MappingConfig, MappingIssue[]>;
export function importSplunkConfig(files: ConfigFile[], mapping?: MappingConfig): ConfigImport;       // mapping-config.md
export function readDashboard(source: DashboardSource): DashboardModel;                             // dashboards.md
export function convertDashboard(model: DashboardModel, options?: ConvertOptions): DashboardConversion;
export function listCommands(): CommandSupport[];        // drives the reference page and `spl2dql commands`
export function explainDiagnostic(code: DiagnosticCode): DiagnosticDoc;

export interface TranslateOptions {
  mapping?: MappingConfig;                 // see mapping-config.md
  timeRange?: { earliest?: string; latest?: string };   // the Splunk time-picker value, e.g. "-24h@h"
  format?: boolean;                        // pretty-print, default true
  strict?: boolean;                        // raise every SPL4xxx (missing mapping) to an error; default false
  tokens?: ReadonlyMap<string, DashboardToken>;   // dashboard mode: `$tok$` becomes a variable (dashboards.md §5)
}

export interface TranslateResult {
  dql: string;
  confidence: 'high' | 'review' | 'low' | 'none';
  score: number;                           // 0–100, for sorting batches
  diagnostics: Diagnostic[];
  stages: StageResult[];                   // the source map
  shape?: { kind: 'events' | 'table' | 'series'; fields: string[] };   // what the result looks like
  variables?: string[];                    // dashboard variables the DQL refers to (with options.tokens)
}

export interface StageResult {
  index: number;                           // 0-based SPL pipeline position
  command: string;                         // "search", "stats", …
  status: 'exact' | 'check' | 'untranslated';
  spl: Span;                               // offsets into the input
  dql: Span[];                             // offsets into `dql`; empty when untranslated
}

export interface Diagnostic {
  code: DiagnosticCode;                    // "SPL3001"
  severity: 'error' | 'warning' | 'info';
  message: string;                         // plain language, written for the person migrating
  hint?: string;                           // what to do about it
  span: Span;                              // in the SPL input
  stageIndex: number;
}

export interface Span { start: number; end: number }     // UTF-16 offsets, end exclusive
```

`translate` is pure, synchronous and total: it never throws for any string input, never reads a
clock, and returns byte-identical output for identical arguments.

## Pipeline

```
 1 expand         macros replaced from mapping.macros (span map back to the input)
 2 split          text → stages at top-level `|`
 3 lower          each stage → its command module → DQL AST commands (tagged with the stage)
 4 print          DQL AST → text + spans
 5 check          offline syntax check of the printed DQL
 6 score          diagnostics → status per stage, confidence, score
```

There is no separate pipeline IR (ADR-015). Command modules lower straight to DQL AST nodes; the
services the planned normalisation passes would have provided live on the lowering context.

### Splitting and scanning

The stage splitter (`src/spl/split.ts`) runs on raw text and only tracks nesting: it splits at `|`
outside double-quoted strings, `[...]` subsearches, `(...)` groups, backtick macro calls and
```` ``` ```` comments. A query that does not begin with `|` has an implicit leading `search`.

Arguments are read with `Scanner` (`src/spl/scanner.ts`) plus two expression parsers: the search
parser (`src/spl/search.ts`, Splunk search precedence NOT > OR > AND) and the eval parser
(`src/spl/expr.ts`, Pratt-style). Every token and node carries a `Span`.

### Command modules

```ts
export interface CommandDef {
  name: string;
  aliases?: readonly string[];          // e.g. bucket → bin
  tier: 'T1' | 'T2' | 'T3';
  summary: string;                      // Reference page and `spl2dql commands`
  generating?: boolean;                 // may follow a leading pipe
  lower(st: Stage): void;               // reads args with st.scanner(), emits with st.emit()
}
```

Command modules live in `src/commands/<family>.ts` (filter, fields, stats, order, extract, combine,
generating) and are registered in `src/commands/registry.ts`. A command that cannot be translated
throws `Untranslatable(code, span, detail)`; the driver turns that into an untranslated stage. A
command absent from the registry becomes an untranslated stage with `SPL2001`.

### The lowering context (`src/lower/context.ts`)

| Service | Purpose |
|---|---|
| `st.field(name, span, define?)` | The only way an SPL field becomes a DQL field: user mapping, then built-ins, then identity. Reports `SPL5002`, `SPL4002`, `SPL4003`; inserts a mapping-file extraction (`parse`) before the stage on first use. |
| `st.fieldType(name)` | From the mapping's `fieldTypes`, or the type of a field created upstream (aggregates are numbers, eval results when known). |
| `st.state.schema` | `events` (raw records), `table` (known columns after a transforming command) or `series` (after `timechart` in series mode). |
| `st.unorderedEvents` | Raw events with no explicit order — drives the `sort timestamp desc` that `head`, `dedup` and `first()` need. |
| `tc.lowerSub(span, stage)` | Lowers a `[ … ]` subsearch as a nested pipeline whose notes belong to the parent stage. |

### DQL AST and printer

```ts
interface DqlQuery   { commands: DqlCommand[] }
interface DqlCommand { name: string; args: DqlArg[]; origin: number[]; comment?: string }
type DqlArg  = { kind: 'pos'; value: DqlExpr } | { kind: 'named'; name: string; value: DqlExpr };
```

Printer rules (`src/dql/printer.ts`, the only place DQL text is produced):

- One command per line; continuation commands start with `| `.
- Command parameters are printed `name:value`; function parameters `name: value`, as in Dynatrace's
  documentation.
- `by:` and `on:` values are always wrapped in `{ }`; two or more aggregations are wrapped in `{ }`.
- Strings are double-quoted with `\"`, `\\`, `\n`, `\r`, `\t` escaped. A field name that is not a
  plain dotted identifier is wrapped in backticks. A field name holding a backtick, a carriage
  return or a line feed is never printed: no source confirms an escape for a backtick inside a
  backticked name (ADR-029). The printer refuses it; the stage that holds it is not translated
  (`SPL2012`). Every name reaches the text through the printer, so this one check covers every
  command.
- The printer can be given a length: it stops (and the translation with it) as soon as any piece it
  builds is longer, so a query whose text would grow far past the output budget is never built.
- An untranslated stage prints as `// not translated: <original SPL>` on one line — line breaks in
  the SPL are replaced by spaces so nothing after them can become DQL. Comments are never printed
  inside sub-queries.
- Mixed `and`/`or` are always parenthesised; long chains of one operator are printed iteratively.

### Offline syntax check

A recursive-descent DQL parser (`src/dql/parser.ts`) plus a catalogue generated from the vendored
Apache-2.0 DQL reference (`scripts/gen-dql-catalog.ts` → `src/dql/catalog.generated.ts`): unknown
command, unknown function, unknown named parameter, unbalanced brackets or quotes. It cannot know
whether a field or bucket exists. The UI and CLI call it "Syntax check (offline)" and never "valid";
"verified" is reserved for a tenant response.

### Status, confidence, score

| Stage status | Rule |
|---|---|
| `untranslated` | the stage was not translated |
| `check` | translated, and at least one warning or error note points at it |
| `exact` | translated with no warning |

| Confidence | Rule |
|---|---|
| `none` | no stage could be translated, or the input is empty |
| `low` | at least one stage is `untranslated`, or any error-severity diagnostic exists |
| `review` | every stage translated; at least one warning |
| `high` | every stage `exact` and no warnings |

`score = max(0, 100 − 40·errors − 10·warnings)`. It exists only to sort batch results.

### Safety rules for the engine

- Every lookup table indexed by user text is a null-prototype object (`src/util/dict.ts`) or a
  `Map`, so names such as `constructor` or `__proto__` never reach `Object.prototype`.
- Every tokenizer loop advances at least one character per step; every recursive parser has a depth
  limit; input size, term count, subsearch depth and macro expansion are capped (`SPL1006`).
- Loops and regular expressions over user text are linear: no expression with two blank runs next
  to each other, no rescanning of the text or of the notes once per item.
- No list read from the input is spread into a call (`push(...list)`, `Math.max(...list)`): a long
  one exceeds the call stack. `util/array.ts` appends with a loop.
- `translate()` catches anything unexpected and returns `SPL1008`; property tests assert that this
  never happens.

### Limits (ADR-029)

Every step that can multiply its input has a budget (`src/limits.ts`). Going over one is a
diagnostic and a stage or a translation that is not done; it is never an exception.

| What | Limit | Over it |
|---|---|---|
| SPL of one translation, after macro expansion | 1,000,000 characters | `SPL1006`, nothing translated |
| subsearch nesting / macro nesting / terms in one search / stages | 16 / 10 / 20,000 / 5,000 | `SPL1006` (`SPL1005` for macros) |
| macro expansion | the length of each expansion is computed before its text is built | `SPL1006` |
| printed DQL of one translation | 1,000,000 characters | `SPL1006`; the translation stops and returns no DQL and no stages (confidence None), so nothing partial looks complete. Each stage's commands are measured as they are lowered, so a pipeline that repeats itself (`eventstats` on raw events doubles the text per stage) stops early |
| `foreach` | listed fields × template length ≤ 200,000 characters | `SPL1006`, the stage is not translated |
| regex → DPL | 2,000 pattern items after `(…){n}` is written out, and 10,000 characters of DPL (the mapping file's own limit for an extraction), counted while it is written | refused like any other regex the converter cannot express (`SPL2006`); a converter error of any kind, a stack overflow included, is a refusal too |
| expression nesting in printed DQL | 1,000 levels | `SPL1006`, the translation stops (the call stack would not hold more) |
| `replace` value pairs | 500 (each pair nests one `if()` in the next) | `SPL1006`, the stage is not translated |
| a function that needs an argument, called with none (`isnum()`) | — | `SPL1004`, like any expression that cannot be read |
| a stage too large for the call stack (hundreds of thousands of names in one command) | — | `SPL1006`, the stage is not translated; lists read from the input are passed to `cmdOf` / `callOf`, never spread into a call |
| notes of one translation | 10,000 | later ones are dropped; one closing `SPL1006` note says so (an error, so the result never looks better than the notes it lost) |

Stage statuses and the stage of a macro or syntax note are found through one index built per
translation (binary search over the ordered stage and command spans), not by rescanning.

## Invariants (each has a test)

1. `translate(x)` returns for every string `x` (property test with arbitrary strings).
2. Deterministic: two calls with equal arguments return deeply equal results.
3. Stage spans lie inside the input and are in order. (Stages produced by one macro share its span.)
4. Every DQL command's span belongs to the `dql` list of the stage it came from.
5. `high` confidence implies the offline syntax check reported nothing.
6. No diagnostic is emitted without a code registered in `src/diagnostics/registry.ts`, and every
   registered code except SPL1006 (tested in `limits.test.ts` and `budgets.test.ts`), SPL1008 and SPL3017 is triggered by
   a conformance case.
7. Every DQL line is a command, a `| ` continuation or a single-line `// ` comment.
