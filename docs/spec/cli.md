# CLI (`packages/cli`, binary `spl2dql`)

Built for bulk migration and for CI. Nothing opens an outbound network connection, ever (ADR-023).

## Commands

```
spl2dql translate [file]            Translate one search. Reads stdin when file is "-" or omitted.
spl2dql batch <input...>            Translate searches and dashboards, or a whole Splunk app folder; write results plus a report.
spl2dql dashboard <input...>        Convert Splunk dashboards into Dynatrace dashboard files.
spl2dql mapping init <input...>     Write a mapping skeleton, filled in from Splunk configuration files where possible.
spl2dql mapping check <file>        Validate a mapping file.
spl2dql commands                    Print the support matrix (command, tier, notes).
spl2dql explain <code>              Explain a diagnostic code, e.g. SPL3001.
spl2dql serve                       Serve the web app on 127.0.0.1 (everything runs in the browser).
```

### Shared options

| Option | Meaning |
|---|---|
| `-m, --mapping <file>` | Mapping file (YAML or JSON). Also read from `spl2dql.mapping.yaml` in the working directory. |
| `--earliest <t>` `--latest <t>` | Time-picker range to apply, e.g. `-24h@h`, `now`. |
| `-o, --output <fmt>` | `dql` (default), `json` (the full `TranslateResult`), `pretty` (DQL plus notes, for terminals). |
| `--fail-on <level>` | Exit 1 when confidence is at or below `review` or `low`. Default: never fail on confidence. |
| `--strict` | Treat every missing mapping (`SPL4xxx`) as an error. |
| `--no-color`, `--quiet` | As usual. Colour is also disabled when stdout is not a terminal or `NO_COLOR` is set. |

### Inputs (`batch`, `dashboard`, `mapping init`)

A file named on the command line is always read. A directory is walked without following symbolic
links, and only files that are recognisably Splunk's are read (ADR-024):

| File | Read as |
|---|---|
| `*.spl`, `*.txt` | one search each |
| `savedsearches.conf` | one search per stanza, with its saved time range, schedule and disabled flag |
| `*.csv` (named explicitly) | a `search` column and an optional `name` / `title` column |
| `macros.conf`, `props.conf`, `transforms.conf`, `eventtypes.conf`, `tags.conf` | mapping sections, laid under the mapping file (mapping-config.md) |
| `*.xml` starting with `<dashboard>` or `<form>`; `*.json` with `dataSources` / `visualizations` | a dashboard (dashboards.md) |

So `spl2dql batch <splunk app folder>` is the whole workflow; `default/` is read before `local/`.

Inside a folder that was given, a file or folder that cannot be read (no permission, say) is
skipped with a note ("my_app/default/locked.spl could not be read (EACCES); it was skipped.");
a file or folder named on the command line that cannot be read is still an error (exit 2).

Every file is read through one open handle: the file whose type and size were checked is the file
that is read, and a symbolic link put at the name in the meantime is not followed. The mapping file
and the files `spl2dql serve` loads are read the same way.

Limits: 10 MB per file, 50,000 files, 100,000 searches, 10,000 dashboards, and **500 MB for all
inputs of one run together** (ADR-029). Over the total the run stops before reading further, with
"The inputs are larger than 500 MB in total; translate them in smaller batches." (exit 2).

A run is also charged for its work: the SPL it translates, after macro expansion (a search that
ends "too large" counts as the full input cap of 1,000,000 characters; a dashboard counts what its
own budget charged). Past **500 MB** the run stops the same way: "The run was cut short: It would
translate more than 500 MB of SPL; the rest was not translated. Translate the rest in smaller
batches." (exit 2). `dashboard` and `mapping init` are charged the same way.

A run writes at most **200 MB of DQL** (search files and dashboard files together). Each file is
measured before it is written; the one that would go over is not written, the run stops there with
"The run was cut short: It would write more than 200 MB of DQL; the rest was not written. Translate
the rest in smaller batches." (exit 2), and the report is still written and says the run was cut
short (`cutShort` in `report.json`). What was written stays complete.

One search or dashboard that cannot be translated, converted or written never ends a run, in
`batch`, `dashboard` and `mapping init`: it is named on stderr with the reason and skipped. The
command exits 2 only when nothing at all could be converted. `mapping init` lists at most 10,000
names per section (the mapping file's limit) and only names the mapping file accepts, so its output
always passes `mapping check`.

In reports a file is named by its path from the input given on the command line, with that input's
own name in front (`my_app/default/savedsearches.conf › Errors`, `one.spl`), never by an absolute
path.

### `batch`

```
spl2dql batch ./my_splunk_app --out ./out
spl2dql batch ./searches savedsearches.conf --mapping m.yaml --out ./out --report html,json
```

Writes `out/<name>.dql` for every search, `out/dashboards/<title>.json` for every dashboard, plus
`out/report.json` and/or `out/report.html` (the HTML report ends with the project's "not affiliated" line, ADR-031). A file is written only inside `--out`: never through a
symbolic link, and never into a folder whose real path leads outside `--out` (a folder on the way
that is a symbolic link is refused before anything is created behind it). After the file is opened
(`O_EXCL | O_NOFOLLOW`), and before any content is written, it is checked once more that the open
file is the regular file at its real path inside `--out`; if a second program swapped a folder in
the meantime, nothing is written and the file is skipped (an empty file may be left where the swap
pointed; that needs write access to the output folder). The HTML report is a single self-contained file (no
external assets, no scripts) with the same vocabulary as the web UI: a summary, the dashboards with
their panels, and for each search the SPL, the DQL and its notes. A report shows at most 20,000
characters of one query (or search), then a line saying how many more there are and which file holds
them, and at most 200 notes per search (with the number left out). Only what the report shows is
kept in memory while the run goes on. Past 100 MB of such detail, further searches and dashboards
are listed without it (name, file, confidence, counts) and the report says how many: "The report
reached its size limit: N search(es) and M dashboard(s) are listed without detail. Their files hold
everything." A report that cannot be built or written ends the run with "The report could not be
written: … The translated files are in <out>." (exit 2); the files already written stay. The HTML report drops control characters other than tab and
newline from everything it shows.

- A saved search is translated with its own saved time range. `--earliest` / `--latest` override it
  for every search; a range written in the SPL wins over both.
- `--skip-disabled` leaves out searches with `disabled = 1`; without it they are translated and
  marked "Switched off in Splunk" in the report.
- A dashboard panel that runs a saved search by name finds it in the `savedsearches.conf` given in
  the same run.
- One line on stderr says what was taken from the configuration files, and how many definitions
  could not be carried over (`mapping init` lists them).

### `dashboard`

```
spl2dql dashboard web_overview.xml > web_overview.json
spl2dql dashboard ./my_splunk_app --mapping m.yaml --out ./dashboards
```

One dashboard is printed on stdout; several need `--out <dir>` and are written as `<title>.json`.
Stderr gets one line per dashboard (panels converted, needing manual work, text; variables), the
panels that need manual work with their first reason, and the dashboard's notes. `-q` suppresses
it. A file named on the command line that is not a dashboard is a usage error (exit 2). A dashboard
that cannot be read or converted is named with the reason and skipped, as in `batch`; the command
exits 2 only when no dashboard could be converted.

### `mapping init`

Translates every search and dashboard panel, collects the names that are still unresolved (indexes,
sourcetypes, data models with the fields read from them, fields, macros, lookups, eventtypes), adds
everything read from the configuration files, and prints the result as YAML. The output is itself a
valid mapping file. Definitions that could not be carried over are listed as comments at the top
with the reason.

Reports never contain credentials. `--redact` replaces string literals in the reported SPL and DQL
with length-preserving placeholders, for sharing reports outside the team.

### `serve`

```
spl2dql serve [--port 4680] [--host 127.0.0.1]
```

Serves the built web app and prints its address. The server:

- binds only to `127.0.0.1`, `::1` or `localhost`, and refuses anything else;
- answers only requests whose `Host` is its own address (DNS-rebinding defence), and only GET/HEAD;
- serves a fixed list of files read once at start-up (no symbolic links, known file types only;
  never `_headers`);
  paths without an extension get the app page, so views can be reloaded;
- sends exactly the policy the hosted page gets: it reads the built `_headers` file once at
  start-up (path and `/dir/*` rules in order, indented `Name: value`, `! Name` to remove) and
  applies it to every response, including the separate policy for `/sw.js`
  (`default-src 'none'; connect-src 'self'; frame-ancestors 'none'`) and
  `Cross-Origin-Resource-Policy: cross-origin` for `/social.png`. Without a built `_headers` it
  uses the same rules built in. The file's caching rules are not applied: a loopback server sends
  `Cache-Control: no-store` for everything. No CORS headers;
- has no API, reads no credentials and opens no outbound connection.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Translation confidence at or below `--fail-on` |
| 2 | Usage error, unreadable input, invalid mapping file, nothing at all could be converted, or the run's 200 MB budget was reached |

## Conventions

- Results go to stdout; progress, notes and errors go to stderr. `translate` with `-o dql` prints only
  DQL so it can be piped.
- Output is stable: sorted, no timestamps unless `--report` is used (reports carry one generation
  time, in the header only).
- Error messages name the file and, where relevant, the line and column, then say what to do.
  Line and column come from line starts computed once per search (a binary search per note).
- Text from the input is made safe before it reaches the terminal: every escape sequence (colours
  included), carriage returns that are not part of CRLF and the Unicode bidirectional controls
  (U+202A–202E, U+2066–2069) are removed, other control characters become `?`. The CLI's own colours
  are added after that, so none can come from a search.
- `--help` on every command shows two realistic examples.
