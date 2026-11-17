# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (security
advisories) on this repository, not in a public issue. Include the input that triggers the problem
with any sensitive values removed. You will get an answer within a week. Fixes are released for
the latest version only.

## What the tool protects

Saved searches, dashboards and Splunk configuration files often contain internal host names, IP
addresses and user names. spl2dql keeps them on the user's machine, always: it has no online
features at all, and none are planned.


- The translator (`@spl2dql/core`), the web app and its built bundles contain no network code, and
  the CLI opens no outbound connection. CI fails if any appears (`pnpm boundaries`). The built web app
  ships a Content-Security-Policy that allows no third-party origin.
- Nothing reads a credential, a token or an API key.
- `spl2dql serve` binds to the loopback address only, accepts only GET and HEAD, checks the Host
  header (DNS-rebinding defence), sends no CORS headers, and serves a fixed list of files read at
  start-up. It has no API.
- The HTML batch report contains no JavaScript and a CSP that forbids scripts; `--redact` masks quoted
  values, IP and e-mail addresses before a report is shared.
- Every parser of untrusted text has size and depth limits and is covered by property tests that
  feed it random input. Every step that can multiply its input (macro expansion, `foreach`,
  repeated groups in a regular expression, a dashboard that reuses one search in many panels) has
  a budget, and so has the size of the DQL one search may produce.

## Supply chain

- pnpm refuses dependency versions published less than seven days ago and runs no dependency
  install scripts. The lockfile is committed; CI installs it frozen and runs `pnpm audit`.
  Dependabot proposes updates under the same seven-day rule, and pull requests are checked for
  vulnerable or copyleft-licensed additions.
- Every GitHub Action is pinned to a commit. Workflows get a read-only token; the two jobs that
  need more (uploading code-scanning results, creating a release) ask for exactly that.
- CodeQL analyses the code and the workflows on every push. gitleaks scans the whole history for
  credentials in CI, and the same scan runs in the commit hook (`.githooks/pre-commit`).
- Releases are published to npm by the release workflow through npm trusted publishing: there is
  no npm token to steal, and each version carries a provenance statement tying it to the commit
  and the workflow run that built it. `npm audit signatures` checks it after an install.
- The packages have no install scripts. `scripts/check-packages.ts` opens the packed files before
  a release and fails on anything that is not on a short allow-list.
- `pnpm gate` runs all of the above, plus every test suite, on the commit about to be published.

## The hosted page

https://spl2dql.pages.dev is the same static web app that `spl2dql serve` opens, served by
Cloudflare Pages. It has no server side, no analytics and no third-party script, font or image.
It is sent with a Content-Security-Policy that allows the page to load only its own files and
forbids other sites from framing it; the same policy is in the page itself, so a copy served from
anywhere else is restricted too. An end-to-end test loads the built page and fails if the browser
makes a request to any other origin. See [PRIVACY.md](PRIVACY.md).

## Files it reads

Everything spl2dql reads is treated as untrusted text: searches, mapping files, Splunk `.conf` files
and dashboards.

- Dashboards are read with the project's own XML reader. It never expands an entity declared in a
  `<!DOCTYPE>` and never reads an external entity, so a crafted file cannot make it read another
  file or expand without bound. Size, depth and element count are limited.
- Text from a Splunk dashboard that ends up in a Dynatrace Markdown tile is treated as data:
  titles and names are escaped, an HTML panel is reduced to plain Markdown (scripts and styles are
  dropped, only `http(s)` links are kept), and images become plain links, so that importing a
  converted dashboard never makes a browser fetch from a third party.
- Names taken from files (macros, fields, tokens, dashboard ids) are never used as keys of a plain
  object, so a name such as `__proto__` cannot change the program's behaviour.
- Output files are written only inside the output directory, never through a symbolic link, at
  any level of the path.

