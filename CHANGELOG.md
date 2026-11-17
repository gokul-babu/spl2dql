# Changelog

All notable changes to spl2dql are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, a minor version may change
how a search translates; every such change is listed under "Changed".

The two packages, `spl2dql` (command line and web app) and `@spl2dql/core` (the translator as a
library), are released together under one version number.

## [Unreleased]

## [0.1.2] - 2026-11-17

### Changed

- No change in what the tool does. The repository's documentation was reorganised, and this version
  is built from it so the links in the packages point at pages that exist.

## [0.1.1] - 2026-11-17

### Fixed

- `strptime` with a backslash in the time format wrote a pattern Dynatrace could not read. The
  backslash is now escaped like a quote.
- The command line reads every input file, the mapping file and the web app's own files through
  one open handle, so the file it checked (a regular file within the size limit, not a symbolic
  link) is the file it reads, even if another program replaces the name in between.

### Changed

- Dependencies updated: `commander` 15.1.0 in the command line; `lucide-react` 1.71.0 in the web
  app.

## [0.1.0] - 2026-11-17

First public release.

### Added

- Translation of Splunk SPL searches to Dynatrace DQL, offline and deterministic, with a note for
  everything that needs a second look and a clear mark on what could not be translated.
- A mapping file for the names only you know: indexes, sourcetypes, fields, macros, lookups, field
  extractions, event types, tags and data models.
- Splunk's own files as input: `savedsearches.conf` (with saved time ranges), `macros.conf`,
  `props.conf`, `transforms.conf`, `eventtypes.conf`, `tags.conf`.
- Dashboard conversion from Simple XML and Dashboard Studio to Dynatrace dashboards, with inputs
  turned into variables. A panel goes live only when its search translated completely.
- Command line: `translate`, `batch` (HTML and JSON reports), `dashboard`, `mapping init`,
  `mapping check`, `serve`.
- A web app that does everything in the browser, shipped inside the command-line package and as a
  hosted page.
- `@spl2dql/core`, the translator as a library with no dependencies.
