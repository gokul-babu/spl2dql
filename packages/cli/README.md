# spl2dql

Move a Splunk app to Dynatrace from the terminal: saved searches to DQL, dashboards to Dynatrace
dashboards. Offline — it never connects to anything.

```sh
npx spl2dql --help
echo 'index=web status>=500 | stats count by host | sort -count | head 10' | npx spl2dql translate
```

```dql
fetch logs
| filter status >= 500
| filter isNotNull(host.name)
| summarize count = count(), by:{host.name}
| sort count desc
| limit 10
```

…plus notes on stderr, for example that index `web` has no entry in the mapping file yet. With a
mapping file (`spl2dql.mapping.yaml`) the same search reads only the right Grail bucket and uses
your real field names, such as `http.status`.

Every SPL stage is marked **Exact**, **Check** or **Not translated**, with a note and a stable code
(`spl2dql explain SPL3001`) saying what differs and what to do. A command with no DQL equivalent
becomes a `// not translated:` line; everything around it is still translated. The same search
always produces the same DQL — there is no AI in the translation path.

Requires Node.js 24 or later.

## Commands

```sh
spl2dql translate [file]              # one search (stdin when omitted); -o dql | json | pretty
spl2dql batch <inputs...> --out dir   # a Splunk app folder, searches, dashboards → .dql, dashboard JSON, HTML/JSON report
spl2dql dashboard <inputs...>         # Splunk dashboards (Simple XML, Dashboard Studio) → Dynatrace dashboard files
spl2dql mapping init <inputs...>      # a mapping skeleton, filled in from the app's .conf files
spl2dql mapping check <file>          # validate a mapping file
spl2dql commands                      # the support matrix (109 SPL commands)
spl2dql explain <code>                # what a note code means
spl2dql serve                         # the web app on 127.0.0.1 — everything runs in your browser
```

A typical migration:

```sh
spl2dql mapping init ./my_splunk_app > spl2dql.mapping.yaml   # macros and extractions come from the app; add where the data lives
spl2dql batch ./my_splunk_app --out ./out --fail-on low
```

`batch` reads what a Splunk app holds: `savedsearches.conf` (each search with its saved time range),
dashboards, and `macros.conf`, `props.conf`, `transforms.conf`, `eventtypes.conf` and `tags.conf`,
so macros, field extractions, eventtypes and tags resolve without retyping them. Data models
(`tstats … from datamodel=…`) are read through a `datamodels` section of the mapping file.

A dashboard panel becomes a live tile only when its search translated completely; otherwise the
tile keeps the Splunk search and says what is missing. Inputs become dashboard variables.

| Exit code | Meaning |
|---|---|
| 0 | success |
| 1 | confidence at or below `--fail-on` |
| 2 | usage error, unreadable input or invalid mapping file |

## Privacy

spl2dql never opens a network connection, reads no credentials and sends no telemetry. Your
searches stay on your machine.

`spl2dql serve` listens on 127.0.0.1 only, accepts only GET and HEAD, checks the Host header, and
serves a fixed set of files; the web app translates in your browser.

It will stay that way: spl2dql does not connect to your Dynatrace tenant and has no AI in it. To load
a converted dashboard you use your own tool, with your own credentials (`dtctl apply -f <file>`).

## Not affiliated

spl2dql is an independent open-source project. It is not affiliated with, endorsed by or supported
by Splunk Inc., Cisco or Dynatrace. Splunk, SPL, Dynatrace and DQL are trademarks of their
respective owners and are used only to describe what this tool works with. Provided without
warranty; check every translated query before relying on it.

Apache-2.0.
