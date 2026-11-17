# Dashboards (`packages/core/src/dashboard`)

Converts a Splunk dashboard file into a Dynatrace dashboard document, offline. Decision: ADR-026.
The Dynatrace side follows the vendored reference in `third_party/dynatrace-for-ai/dashboards/`
(provenance `ref` below); anything not stated there is marked `inf`.

## 1. The rule that shapes everything

**A panel becomes a live tile only when its search translated completely** (confidence Exact or
Needs review). Otherwise the tile is a text tile that keeps the Splunk search, the DQL so far and
the reasons. A dashboard that shows a wrong number is worse than one that shows a gap.

```
Splunk file ─► readDashboard()  ─► DashboardModel ─► convertDashboard() ─► DashboardConversion
 Simple XML      xml.ts + simple-xml.ts   (model.ts)      convert.ts            { dashboard, tiles[],
 Studio JSON     studio.ts                                 translate() per panel   variables[], notes[] }
```

Public API (`@spl2dql/core`):

```ts
readDashboard(source: { name: string; text: string }): DashboardModel            // throws DashboardError
convertDashboard(model: DashboardModel, options?: ConvertOptions): DashboardConversion
convertDashboardSource(source, options?): DashboardConversion                    // both steps
interface ConvertOptions { mapping?: MappingConfig; strict?: boolean; savedSearches?: ReadonlyMap<string, DashboardSearch> }
```

`readDashboard` and `convertDashboard` are pure and total for well-formed models; the only error is
`DashboardError` with a plain message (not XML, not JSON, wrong root element, too large).

## 2. Reading Simple XML

Root `<dashboard>` or `<form>`. A root with a `<definition>` child holding JSON is Dashboard Studio
(§3). Read with the project's own XML reader (`xml.ts`): elements, attributes, text, CDATA, the five
predefined entities and numeric references. A `<!DOCTYPE>` is skipped as a whole — no entity it
declares is ever expanded, no external entity is ever read. Limits: 10 MB, depth 100, 200,000
elements, 2,000 panels, 500 inputs (the rest are left out with one dashboard note).

| Splunk | Model | Notes |
|---|---|---|
| `<label>`, `<description>` | `title`, `description` | Title falls back to the file name. The description is plain text (§4). |
| `<search id="x">` under the root | a base search | |
| `<search base="x"><query>…</query>` | base query, a pipe, then the query | The time range is inherited unless the panel sets its own. Chains of bases are followed up to 20 deep. A deeper chain, or a joined search longer than one translation accepts (1,000,000 characters), is refused when it is built: the panel's `unreadable` says why and it becomes a manual tile (ADR-029). |
| `<search ref="Name"/>`, `<searchName>` | `savedSearch` | Resolved from `ConvertOptions.savedSearches` (the CLI fills it from `savedsearches.conf`). |
| `<searchString>`, `<searchTemplate>`, `<searchPostProcess>`, `<earliestTime>`, `<latestTime>` | as the modern forms | Simple XML before Splunk 6.3. |
| `<row>` → `<panel>` → `chart` `table` `single` `event` `list` `map` `html` `viz` | panels with `row { index, column, span, stack }` | A visualization directly in a `<row>` counts as its own panel. Several visualizations in one `<panel>` stack. A panel `<title>` names its first visualization when that has none. |
| `<option name="charting.chart">` | `chartType` | Default `column`, as in Splunk. |
| `<html>` | a text panel | Reduced to Markdown: headings, paragraphs, list items, bold, italic, code, links. Scripts and styles are dropped. Text is data: every text node is escaped (§4 "Text in Markdown tiles"); code shows its text as written. An `<a href>` is a link only when its target passes the target test of §4; otherwise it is its text. |
| `<fieldset>` / `<panel>` → `<input type token>` | inputs | `<choice>`, `<default>` / `<initialValue>`, `<search>` or `<populatingSearch>` with `fieldForValue`. |
| `<valuePrefix>field="</valuePrefix>` (or `<prefix>`) | `filterField` | The token is then a whole condition on that field (§5). A field name over 200 characters is ignored, with a dashboard note. |
| `depends` / `rejects`, `<drilldown>`, own refresh, `script=`, `stylesheet=`, `<init>`, `<panel ref>` | `dropped` | Each is named in the notes of the panel or the dashboard. |

## 3. Reading Dashboard Studio

A JSON definition, either a `.json` file or inside `<definition><![CDATA[…]]></definition>`.

| Splunk | Model | Notes |
|---|---|---|
| `dataSources.*` of type `ds.search` | a search, with `queryParameters.earliest/latest` or the dashboard's `defaults` | |
| `ds.chain` (`extend`, `query`) | the extended search, a pipe, then the query | Chains up to 20 deep. A deeper chain, or a joined search over 1,000,000 characters, is refused as in §2. |
| `ds.savedSearch` (`ref`) | `savedSearch` | |
| `visualizations.*`: `splunk.line` `area` `column` `bar` `pie` `scatter` `bubble`, `markergauge` `fillergauge`, `singlevalue*`, `table`, `events`, `map`, `markdown` | panels | `viz.x` (early versions) is read as `splunk.x`. Any other type becomes a table with a note. |
| `splunk.rectangle`, `splunk.ellipse`, `splunk.image`, `abslayout.*` | — | Decoration; counted in one dashboard note. |
| `inputs.*`: `input.dropdown`, `input.multiselect`, `input.text`, `input.number`, `input.timerange` | inputs | Static `items`; for dynamic ones the value field is read from `frame(label, value)`. Other input types are noted and left out. At most 500 inputs. |
| `layout.structure[].position {x,y,w,h}` | `box` in canvas pixels | Each value is clamped to 0…100,000 (a negative or missing one takes the default, as before). `layout.tabs` + `layoutDefinitions`: tabs follow each other downwards, each under a heading (the tab label is escaped). At most 200 tabs (a note for the rest); a heading counts toward the 2,000 panels; a layout several tabs show is read once, for the first of them (a note counts the others). A visualization that is defined but not placed is added at the end. Values that should be text (`type`, `layoutId`, a default) are read only when they are text. |
| `splunk.markdown` | a text panel | Splunk's own Markdown, rebuilt (§4 "Text in Markdown tiles"). |
| `description` | `description` | Plain text (§4). |
| `eventHandlers` | `dropped` | Drilldown. |

## 4. Tiles

| Panel | Tile | Prov |
|---|---|---|
| search translated completely | `{ "type": "data", "title", "query": <DQL>, "visualization", "visualizationSettings": {}, "querySettings": {} }`, plus `description` when the panel has one | ref |
| search incomplete, missing, or a saved search that was not given | `{ "type": "markdown", "content" }`: `### title`, "**Not converted yet.** This Splunk panel needs manual work:", the reasons as a list, then the Splunk search and the DQL so far as indented code blocks | ref (tile type) |
| search not read (`unreadable`), or past the dashboard's budget | the same manual tile with the reason and no code blocks | — |
| text panel | `{ "type": "markdown", "content" }` | ref |
| dashboard description | a one-row Markdown tile at the top, the description escaped as plain text | ref |

Reasons for a manual tile are the errors of the translation plus the notes of the stages that were
not translated — not every note of the search.

Code in a manual tile is an *indented* block: a fenced block would be closed by the triple backticks
SPL uses for comments.

### Budget of one dashboard (ADR-029)

Searches are translated in order — panels first, then the searches that fill inputs — until
5,000,000 characters of SPL have been translated or 5,000,000 characters of DQL kept. A search is
charged for the work, not for the text as written: first its length once its tokens are rewritten
(§5), computed before that text is built; then its length once its macros are expanded, expanded no
further than the budget left; a translation that ends in "too large" (`SPL1006`) is charged the full
input cap of 1,000,000. A search longer than 1,000,000 characters once rewritten is not translated
(SPL1006 in its tile). From the first
search that does not fit, no further search is translated: its panel becomes a manual tile whose
reason is "The dashboard is too large to convert in one go, so this panel was not translated.
Convert it on its own, or split the dashboard.", and an input keeps only its fixed choices with a
note. Such a tile report carries no `spl` and no `result`, and the search text is not read at all,
so one large base search shared by many panels is not copied once per panel. Tokens are looked for
in the same searches only. (The second budget, on DQL kept, is not in ADR-029's table; it stops a
small search whose translation is large from being kept 2,000 times.)

### Text in Markdown tiles (ADR-029)

Text that comes from a Splunk file is data, not Markdown (`dashboard/markdown.ts`). The rules are
properties of the output, and `markdown.test.ts` checks them on every tile by a plain scan:

1. **Outside an indented code block the converter wrote, a tile contains no `<` and no backtick.**
   In text, `&` is written `&amp;`, `<` `&lt;`, `>` `&gt;`, a backtick `&#96;`, `[` `&#91;`, `]`
   `&#93;`, `(` `&#40;`, `)` `&#41;`; a character written as an entity can never start Markdown or
   HTML syntax, and a renderer that links bare addresses cannot take it into an address. The only
   raw `[ ] ( )` are those of a link the converter writes. Other punctuation keeps a backslash
   where it could matter: `\` `*` `|` `~` always; `_` unless it stands between two letters or
   digits; `!` at the end of a piece (a link may follow); `#` at the start or in a closing run;
   `-` `+` `=` and the `.` of a number at the start of a line. Input that already holds `&lt;` or
   `\<` is shown exactly as written (`&amp;lt;`, `\\&lt;`).
2. **No bare address is linkable:** `://` is written `\://` and `www.` (any case) `www\.` in text.
   The same rule is applied again to every assembled line (`sealLine`), since two safe pieces can
   meet and spell an address or a list marker; a leading `//` is written `\/\/` and an assembled
   line never starts with blanks.
3. **No code spans.** A backtick span in `splunk.markdown` and `<code>` in an `<html>` panel are
   ordinary escaped text. The Splunk search and the DQL of a manual tile stay in indented code
   blocks, written line by line after a line of the converter's own (`Splunk search:`,
   `DQL so far:`) and a blank line, so no list or paragraph can run on into them.
4. **A tile is cut at a line end, never inside a line.** Lines are kept while they fit (8,000
   characters for a text tile, 12,000 for a manual tile); the first that does not, and everything
   after it, is dropped, and the converter's own line "The rest of this text did not fit in the
   tile." closes the tile. Pieces of one line (a title, a reason, a description) are cut before
   they are written, between characters, with "…".

Plain text — titles, saved-search names, reasons, tab labels, descriptions (Simple XML and Dashboard
Studio: Splunk does not render them as Markdown), text nodes and `<code>` of `<html>` panels — is
one line (line breaks become spaces, control characters go), escaped as above.

**The link target test.** A link is written only when its target matches `^https?://` followed by
characters that are none of whitespace, control characters, `<` `>` `(` `)` `[` `]`, a backslash, a
backtick or a quote. Code blocks are split on CRLF, CR, LF, NEL, U+2028 and U+2029 and lose control
characters other than tab.

**Markdown that Splunk calls Markdown** — a Studio `splunk.markdown` — is rebuilt, never passed
through. It is read line by line into an allow-list and written out again:

| Read | Written |
|---|---|
| blank line | one blank line |
| `#` … `######` heading | the same level, its text rebuilt inline |
| `-` `*` `+` list item; `1.` `1)` item | `- text`; `1. text` |
| any other line | a paragraph line, rebuilt inline |
| fenced block (```` ``` ```` or `~~~`) | each line as escaped text |
| `**x**`, `__x__` / `*x*`, `_x_` | `**x**` / `*x*`, the inside escaped |
| `[text](target)` | `[text](target)` when the target passes the test, else the text |
| `![alt](target)` | `[alt](target)` when the target passes, else the alt text |
| anything else (code spans, HTML, autolinks, references, tables, quotes) | escaped text |

A link's text is escaped like any other text, at the start of a line too (`[1.](x) text` is the
paragraph `1\. text`, not a list item). Nothing from the input reaches the tile except through one
of these constructs, written by the converter itself. Reading is linear in the length of the text.

Document: `{ "name", "type": "dashboard", "content": { "version": 21, "variables": [], "tiles": {…}, "layouts": {…} } }`.
Tile keys are `"0"`, `"1"`, … and every tile has a layout entry with the same key. No `id` is
written: Dynatrace assigns one on import (ref).

### Visualization

Chosen from the Splunk panel and the **shape of the query result** (`TranslateResult.shape`): a time
axis exists when the result is a series (`makeTimeseries`, `timeseries`) or a table with a
`timestamp` column.

| Splunk | With a time axis | Without | Prov |
|---|---|---|---|
| chart `line` | `lineChart` | `categoricalBarChart` + note | ref |
| chart `area` | `areaChart` | `categoricalBarChart` + note | ref |
| chart `column`, `bar` | `barChart` | `categoricalBarChart` | ref |
| chart `pie` | `lineChart` + note | `pieChart` | ref |
| chart `scatter` | `scatterplot` | `scatterplot` | ref |
| chart `bubble` | `table` + note | `table` + note | — |
| chart `*gauge` | `gauge` | `gauge` | ref |
| `single` | `singleValue` | `singleValue` | ref |
| `table`, `event` | `table` | `table` | ref |
| `map`, custom | `table` + note | `table` + note | — |

`visualizationSettings` is left empty: Dynatrace picks the fields. This is deliberate — settings
that name fields would have to be right for every result shape.

### Layout

Dynatrace's grid is 24 columns wide (ref).

- **Simple XML.** A row's panels share the width equally (`x = floor(column × 24 / span)`). Heights
  in grid rows: single value 3, chart 6, table and others 7, a manual tile 7 (4 without a search),
  text by its length (2 to 8). A row is as tall as its tallest column and the last tile of each
  column fills the rest, so a row has one bottom edge.
- **Dashboard Studio.** Boxes are scaled from the area the panels really cover (the canvas margins
  are not part of the layout) to 24 columns, 50 px per grid row, at least 3 rows for a data tile.
  A tile that would overlap an earlier one moves down; then every tile moves up until it meets
  another, which closes the gaps rounding leaves. Both moves jump: a tile moving down skips past the
  tiles in its columns in top order, and moving up it stops at the lowest bottom edge already placed
  in its columns (a skyline per column). The result is the one moving a row at a time would give,
  in time that does not depend on how far apart the tiles are (ADR-029).

## 5. Tokens become variables

`TranslateOptions.tokens` (a map from token name to `{ variable, kind }`) switches the translator to
dashboard mode. The lowering keeps `$tok$` as ordinary text; a pass over the DQL AST
(`dashboard/tokens.ts`) then replaces each place where a token stands for a **whole value**:

| SPL | DQL | Notes | Prov |
|---|---|---|---|
| `f=$tok$`, one value or free text | `matchesValue(F, $tok)` | Case-insensitive and wildcard-aware like Splunk's `=`; a text default of `*` keeps meaning "anything". | inf |
| `f=$tok$`, `F` declared a number | `F == $tok:noquote` | | ref |
| `f=$tok$`, several values (multiselect, checkbox, or a dropdown with an "All" choice) | `in(F, array($tok))` | | ref |
| `f="*$tok$*"`, `"$tok$*"`, `"*$tok$"` | `contains(F, $tok, caseSensitive: false)`, `startsWith(…)`, `endsWith(…)` | | ref |
| `$tok$` as a search term | `matchesPhrase(content, $tok:triplequote)` | | ref |
| `x > $tok$` (`<`, `<=`, `>`, `>=`), in `search`, `where` or `eval` | `x > $tok:noquote` | | ref |
| `"$tok$"` as a value in `eval` | `$tok` | | ref |
| `head $tok$` | `limit $tok:noquote` | | ref |
| `by $tok$`, a field named by a token | `$tok:backtick` | `SPL4009`: the variable's values must be Grail field names. | ref |
| `earliest=$t.earliest$`, `latest=…`, or a panel range given as a token | nothing | The dashboard's time frame picker applies (ref: no time range in tile queries). A **literal** panel range is kept as `from:` / `to:`. | ref |
| a token that is only part of a value (`msg="code $n$ seen"`) | unchanged text | `SPL4009`. | — |

Before translation the search text is normalised: `$form.tok$` → `$tok$`, `$tok|s$` → `"$tok$"`,
and a token whose input has a `filterField` → `field="$tok$"`.

Variables (ref: `variables.md`):

| Input | Variable |
|---|---|
| filled by a search that translates | `{ "version": 2, "type": "query", "input": <DQL>, "multiple" }`. The query must return one field: when the input names a value field that the search really produces, `\| table <field>` is appended to the SPL before translation; otherwise a note asks for it. |
| fixed choices | `{ "version": 1, "type": "csv", "input": "a,b,c", "multiple" }`. `*` is not a value. Labels are not carried over (noted). |
| text, or nothing that could be carried over | `{ "version": 1, "type": "text", "defaultValue" }` |
| several values | `"defaultValue": "3420b2ac-f1cf-4b24-b62d-61ba1ba8ed05*"` (select all, ref) |
| a token used in a search but not declared by an input | a text variable, with a note that Splunk sets it from a click or a script |
| a time input | no variable; one dashboard note |

A default or a fixed choice is kept only when it is safe for every way the dashboard's queries use
the variable (ADR-029): a number (`-?digits[.digits]`) where a query writes it as it is
(`$v:noquote`), a plain field name (letters, digits, `_` and `.`, starting with a letter or `_`)
where a query uses it as a field name (`$v:backtick`), and no `"""` where a query puts it inside
triple quotes (`$v:triplequote`). Others are left out with a note on the
variable; a list variable with no safe choice left becomes a text variable.

Keys are the token name with anything but letters, digits and `_` replaced by `_`, prefixed `v_`
when they would not start with a letter, and numbered on collision. A variable no live tile (and no
kept variable's query) refers to is left out, with a note when it came from an input.

Runtime tokens (`$click.*$`, `$row.*$`, `$result.*$`, `$job.*$`, `$env:*$`, `$trellis.*$`) are not
inputs and get no variable.

## 6. What the caller gets

```ts
interface DashboardConversion {
  title: string; format: 'simple-xml' | 'dashboard-studio';
  dashboard: DynatraceDashboard;                  // write this as JSON
  tiles: TileReport[];                            // id, title, outcome: 'live' | 'manual' | 'text', visualization?, spl?, result?, notes[]
  variables: VariableReport[];                    // key, token, type, notes[], result?
  notes: string[];                                // dashboard-level
  counts: { live: number; manual: number; text: number };
}
```

Words (UI, CLI, reports): **Converted** (live), **Converted, check** (live with notes, UI only),
**Needs manual work** (manual), **Text**.

## 7. Not done

- Trellis, annotations, drilldowns, conditional visibility, per-panel refresh.
- `visualizationSettings` (axes, colours, thresholds, units).
- Dynatrace dashboard `segments`, tile `timeframe`.
- Custom visualizations and maps (shown as tables).
- Verification on a tenant: the document shape follows the vendored reference; nothing was imported
  into Dynatrace by this project.
