# Privacy

spl2dql has no accounts, no analytics and no cookies.

- **The command-line tool** reads the files you point it at and writes the files you ask for. It
  opens no outbound connection. `spl2dql serve` listens on your own machine only.
- **The web app** — the hosted page and the copy `spl2dql serve` opens — does all its work in your
  browser. Searches, dashboards, Splunk configuration files and your mapping are never uploaded;
  the page contains no code that could send them, and its Content-Security-Policy forbids
  connections to any other site. The repository's tests check both.
- **What stays in your browser:** your settings and your mapping, in the browser's local storage
  for that site, so they are there on your next visit. Clearing the site's data removes them.
  A link made with "Copy link" carries the search text inside the link itself; whoever you send it
  to can read that search, so remove sensitive values first. The mapping is never put in a link.
- **What the host of the page sees:** like any website, the company that serves the hosted page
  (Cloudflare) processes the request for the page's files — your IP address, browser type and the
  time. Cloudflare also asks browsers to report failed connections to the page to it ("network
  error logging"); such a report says that a request failed, not what you were doing. This project
  adds no tracking on top of that and does not look at those logs for individual visitors. After
  the page has loaded it works without a connection.
- **Reports** written by `spl2dql batch` contain your searches. Use `--redact` before sharing one.

Questions: open an issue at https://github.com/gokul-babu/spl2dql/issues (do not include
anything sensitive).
