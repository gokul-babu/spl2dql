# Sample Splunk app

A small, made-up Splunk app used by the tests and the web app's "Load the sample app" button. It has
the shapes a real app has:

| File | What is in it |
|---|---|
| `default/savedsearches.conf` | nine saved searches: stats, rex, time maths, eventtypes and tags, two data-model searches, one that cannot be translated, one that is switched off |
| `default/macros.conf` | three macros the searches use, and one eval-based macro that cannot be carried over |
| `default/props.conf`, `transforms.conf` | search-time field extractions |
| `default/eventtypes.conf`, `tags.conf` | eventtypes and the tags on them |
| `default/data/ui/views/web_overview.xml` | a Simple XML dashboard with inputs, a base search and a drilldown |
| `default/data/ui/views/security_posture.xml` | a Dashboard Studio dashboard with chained searches |
| `spl2dql.mapping.yaml` | a filled-in mapping, to see the difference a mapping makes |

```sh
spl2dql batch examples/splunk-app --out out                                              # without a mapping
spl2dql batch examples/splunk-app --out out -m examples/splunk-app/spl2dql.mapping.yaml  # with one
spl2dql mapping init examples/splunk-app                                                 # what still needs mapping
```

The names, hosts and searches are invented; nothing here comes from a real environment.
