import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type Confidence,
  type ConfigImport,
  collectMappingNeeds,
  convertDashboardSource,
  DashboardError,
  type DashboardSearch,
  type Diagnostic,
  expandedLength,
  explainDiagnostic,
  importSplunkConfig,
  listCommands,
  MAX_INPUT,
  type MappingConfig,
  mergeMappingSections,
  type TranslateOptions,
  type TranslateResult,
  translate,
} from '@spl2dql/core';
import { Command, CommanderError, Option } from 'commander';
import { stringify as toYaml } from 'yaml';
import { InputError, type Inputs, readInputs, safeFileName } from './inputs.ts';
import { loadMapping, loadMappingFile, MappingError, validateMapping } from './mapping.ts';
import {
  boardDetailSize,
  CONFIDENCE_WORD,
  type DashboardEntry,
  detailSize,
  dropBoardDetail,
  dropDetail,
  htmlReport,
  jsonReport,
  type ReportEntry,
  reportBoard,
  reportResult,
  shown,
  summary,
} from './report.ts';
import { prepareOutDir, writeInside } from './safe-fs.ts';

export interface CliIO {
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown; isTTY?: boolean };
  stdin: AsyncIterable<Buffer | string>;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Injected clock for report headers (tests). */
  now?: () => Date;
  /** The run's budgets; tests set small ones. Defaults MAX_RUN_OUTPUT, MAX_RUN_WORK, MAX_REPORT_DETAIL. */
  maxRunOutput?: number;
  maxRunWork?: number;
  maxReportDetail?: number;
}

export const EXIT = { ok: 0, confidence: 1, usage: 2 } as const;
/** Printed by --version. A test keeps it equal to the version in package.json. */
const VERSION = '0.1.2';
const MAX_STDIN = 10 * 1024 * 1024;
/** DQL one run may write, dashboards included (ADR-029). */
export const MAX_RUN_OUTPUT = 200 * 1024 * 1024;
/** SPL one run may translate, after macro expansion (ADR-029). */
export const MAX_RUN_WORK = 500 * 1024 * 1024;
/** Report text with per-search detail; past it, searches are listed without detail (ADR-029). */
export const MAX_REPORT_DETAIL = 100 * 1024 * 1024;
/** The mapping file's own limits (docs/spec/mapping-config.md), for the skeleton `mapping init` writes. */
const MAX_SECTION = 10_000;
const SPL_NAME = /^[^\s`"|[\]]{1,256}$/;
const FIELD_KEY = /^[A-Za-z_@][A-Za-z0-9_.:@-]{0,255}$/;
const DATAMODEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,7}$/;
const CONF_RANK: Record<Confidence, number> = { none: 0, low: 1, review: 2, high: 3 };

class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** Runs the CLI. Returns the exit code instead of exiting, so it can be tested in-process. */
export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const color = !!io.stdout.isTTY && io.env.NO_COLOR === undefined;
  const runBudget = io.maxRunOutput ?? MAX_RUN_OUTPUT;
  const workBudget = io.maxRunWork ?? MAX_RUN_WORK;
  const reportBudget = io.maxReportDetail ?? MAX_REPORT_DETAIL;
  // Text from searches can contain terminal escape sequences; strip them from everything printed.
  // Our own colours are the only escapes written: a Painted part is coloured after its text has
  // been made safe, so no colour code can come from the input.
  const render = (parts: readonly (string | Painted)[]): string =>
    parts.map((p) => (typeof p === 'string' ? safeText(p) : color ? `\u001b[${p.code}m${safeText(p.text)}\u001b[0m` : safeText(p.text))).join('');
  const say = (s: string): void => {
    io.stdout.write(safeText(s));
  };
  const note = (...parts: (string | Painted)[]): void => {
    io.stderr.write(render(parts));
  };

  const program = new Command()
    .name('spl2dql')
    .description('Move a Splunk app to Dynatrace: SPL searches to DQL queries, dashboards to Dynatrace dashboards. Runs fully offline.')
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: say, writeErr: note })
    .showHelpAfterError();

  const shared = (c: Command): Command =>
    c
      .option('-m, --mapping <file>', 'mapping file (YAML or JSON); default spl2dql.mapping.yaml when present')
      .option('--earliest <time>', 'time-picker earliest, e.g. -24h@h')
      .option('--latest <time>', 'time-picker latest, e.g. now')
      .option('--strict', 'treat every missing mapping (SPL4xxx) as an error')
      .addOption(new Option('--fail-on <level>', 'exit 1 when confidence is at or below this level').choices(['review', 'low']))
      .option('-q, --quiet', 'do not print notes');

  /**
   * The mapping to translate with: the mapping file, with definitions from Splunk configuration
   * files (macros.conf, props.conf …) found among the inputs laid underneath. The mapping file wins.
   */
  const resolveMapping = (o: Record<string, unknown>, inputs?: Inputs): { mapping?: MappingConfig; imported?: ConfigImport; data: Record<string, unknown> } => {
    const loaded = loadMappingFile(o.mapping as string | undefined, io.cwd);
    const data = loaded?.data ?? { version: 1 };
    if (!inputs || inputs.configs.length === 0) return loaded ? { mapping: loaded.mapping, data } : { data };
    const imported = importSplunkConfig(inputs.configs, loaded?.mapping);
    const merged = mergeMappingSections(data, imported.sections);
    return { mapping: validateMapping(merged, 'The mapping built from the Splunk configuration files'), imported, data: merged };
  };

  const describeImport = (imported: ConfigImport | undefined): void => {
    if (!imported) return;
    const c = imported.counts;
    const parts = [
      c.macros > 0 ? `${c.macros} macro(s)` : '',
      c.extractions > 0 ? `${c.extractions} field extraction(s)` : '',
      c.eventtypes > 0 ? `${c.eventtypes} eventtype(s)` : '',
      c.tags > 0 ? `${c.tags} tag(s)` : '',
    ].filter(Boolean);
    if (parts.length > 0) note(`Using ${parts.join(', ')} from the Splunk configuration files.\n`);
    if (imported.skipped.length > 0) note(`${imported.skipped.length} definition(s) could not be carried over; "spl2dql mapping init" lists them.\n`);
  };

  const optionsFrom = (o: Record<string, unknown>, inputs?: Inputs): { mapping?: MappingConfig; translate: TranslateOptions; imported?: ConfigImport } => {
    const { mapping, imported } = resolveMapping(o, inputs);
    const translateOptions: TranslateOptions = {};
    if (mapping) translateOptions.mapping = mapping;
    if (o.earliest || o.latest) {
      translateOptions.timeRange = {};
      if (o.earliest) translateOptions.timeRange.earliest = String(o.earliest);
      if (o.latest) translateOptions.timeRange.latest = String(o.latest);
    }
    if (o.strict) translateOptions.strict = true;
    const out: { mapping?: MappingConfig; translate: TranslateOptions; imported?: ConfigImport } = { translate: translateOptions };
    if (mapping) out.mapping = mapping;
    if (imported) out.imported = imported;
    return out;
  };

  const failsOn = (o: Record<string, unknown>, c: Confidence): boolean => {
    const level = o.failOn as 'review' | 'low' | undefined;
    return level !== undefined && CONF_RANK[c] <= CONF_RANK[level];
  };

  const printNotes = (spl: string, diags: readonly Diagnostic[], name?: string): void => {
    const where = lineCol(spl);
    for (const d of diags) {
      if (d.severity === 'info') continue;
      const at = where(d.span.start);
      const tag = d.severity === 'error' ? paint('error', 31) : paint('note', 33);
      note(`${name ? `${name}:` : ''}${at.line}:${at.col} `, tag, ` ${d.code} ${d.message}\n`);
    }
  };

  program
    .command('translate')
    .description('Translate one search. Reads standard input when the file is "-" or omitted.')
    .argument('[file]', 'file with the SPL search')
    .addOption(new Option('-o, --output <format>', 'output format').choices(['dql', 'json', 'pretty']).default('dql'))
    .addHelpText(
      'after',
      "\nExamples:\n  spl2dql translate search.spl -m mapping.yaml\n  echo 'index=web | stats count by host' | spl2dql translate -o pretty\n",
    )
    .action(async (file: string | undefined, o: Record<string, unknown>) => {
      const spl = file && file !== '-' ? readText(resolve(io.cwd, file)) : await readStdin(io.stdin);
      const { translate: options } = optionsFrom(o);
      const result = translate(spl, options);
      if (o.output === 'json') {
        say(`${JSON.stringify(result, null, 2)}\n`);
      } else if (o.output === 'pretty') {
        say(`${result.dql}\n\n${CONFIDENCE_WORD[result.confidence]}\n`);
        for (const d of result.diagnostics)
          say(`  ${d.severity === 'error' ? '■' : d.severity === 'warning' ? '▲' : '●'} stage ${d.stageIndex + 1} ${d.code}: ${d.message}\n`);
      } else {
        say(`${result.dql}\n`);
        if (!o.quiet) printNotes(spl, result.diagnostics);
      }
      if (failsOn(o, result.confidence)) throw new Exit(EXIT.confidence);
    });

  program
    .command('batch')
    .description('Translate everything in files or a Splunk app folder: saved searches, dashboards, and the macros and extractions they use.')
    .argument('<inputs...>', 'files or directories')
    .requiredOption('--out <dir>', 'output directory')
    .option('--report <formats>', 'report formats: html,json', 'html,json')
    .option('--redact', 'replace quoted values, IP and e-mail addresses in the report')
    .option('--skip-disabled', 'leave out saved searches that are switched off in Splunk (disabled = 1)')
    .addHelpText(
      'after',
      '\nReads .spl and .txt searches, savedsearches.conf (with each search\'s saved time range), CSV files with a\n"search" column, Splunk dashboards (Simple XML and Dashboard Studio), and macros.conf, props.conf,\ntransforms.conf, eventtypes.conf and tags.conf, whose definitions are used during translation.\n\nExamples:\n  spl2dql batch ./my_splunk_app --out ./out\n  spl2dql batch savedsearches.conf macros.conf --mapping m.yaml --out ./out --report html --redact\n',
    )
    .action(async (paths: string[], o: Record<string, unknown>) => {
      const inputs = readInputs(paths, io.cwd);
      for (const n of inputs.skipped) note(paint('note', 33), ` ${n}\n`);
      const searches = o.skipDisabled ? inputs.searches.filter((s) => !s.disabled) : inputs.searches;
      if (searches.length === 0 && inputs.dashboards.length === 0) throw new InputError('No searches or dashboards found in the given inputs.');
      const { translate: options, mapping, imported } = optionsFrom(o, inputs);
      describeImport(imported);
      const out = prepareOutDir(resolve(io.cwd, String(o.out)));
      const formats = new Set(
        String(o.report)
          .split(',')
          .map((f) => f.trim().toLowerCase())
          .filter(Boolean),
      );
      for (const f of formats) if (f !== 'html' && f !== 'json') throw new InputError(`Unknown report format "${f}". Use html and/or json.`);
      const taken = new Set<string>(['report.html', 'report.json']);
      const entries: ReportEntry[] = [];
      // The run's budget of DQL written (ADR-029). Each file is checked before it is written, so
      // what was written stays complete and the report can still say where the run stopped.
      let written = 0;
      let cutShort: string | undefined;
      let failed = 0;
      const fits = (size: number): boolean => {
        if (written + size <= runBudget) {
          written += size;
          return true;
        }
        cutShort = `It would write more than ${Math.round(runBudget / 1024 / 1024)} MB of DQL; the rest was not written. Translate the rest in smaller batches.`;
        return false;
      };
      // The run's budget of work: SPL translated, after macro expansion; a search that ends "too
      // large" counts as the full input cap (ADR-029, third round).
      let worked = 0;
      const canWork = (size: number): boolean => {
        if (worked + size <= workBudget) return true;
        cutShort = `It would translate more than ${Math.round(workBudget / 1024 / 1024)} MB of SPL; the rest was not translated. Translate the rest in smaller batches.`;
        return false;
      };
      // The report's budget: past it, searches and dashboards are listed without their detail.
      let detail = 0;
      const withDetail = (size: number): boolean => {
        if (detail + size > reportBudget) return false;
        detail += size;
        return true;
      };
      for (const s of searches) {
        if (cutShort !== undefined) break;
        try {
          // The search's own saved time range applies unless --earliest/--latest overrides it.
          const perSearch: TranslateOptions = { ...options };
          if (!options.timeRange && (s.earliest !== undefined || s.latest !== undefined)) {
            perSearch.timeRange = {};
            if (s.earliest !== undefined) perSearch.timeRange.earliest = s.earliest;
            if (s.latest !== undefined) perSearch.timeRange.latest = s.latest;
          }
          const expanded = expandedLength(s.spl, perSearch, MAX_INPUT) ?? MAX_INPUT;
          if (!canWork(expanded)) break;
          const result = translate(s.spl, perSearch);
          worked += result.diagnostics.some((d) => d.code === 'SPL1006') ? MAX_INPUT : expanded;
          if (!fits(result.dql.length + 1)) break;
          const file = `${safeFileName(s.name, taken)}.dql`;
          writeInside(out, file, `${result.dql}\n`);
          // Only what the report shows is kept for the rest of the run.
          const entry: ReportEntry = { name: s.name, origin: s.origin, file, spl: shown(s.spl, s.origin), result: reportResult(result, file) };
          if (!withDetail(detailSize(entry))) dropDetail(entry);
          if (s.earliest !== undefined) entry.earliest = s.earliest;
          if (s.latest !== undefined) entry.latest = s.latest;
          if (s.schedule !== undefined) entry.schedule = s.schedule;
          if (s.disabled) entry.disabled = true;
          entries.push(entry);
          if (!o.quiet) printNotes(s.spl, result.diagnostics, s.name);
        } catch (e) {
          failed++;
          note(paint('error', 31), ` The search "${s.name}" (${s.origin}) was skipped: ${messageOf(e)}\n`);
        }
      }

      // Dashboards: one Dynatrace dashboard document each, in out/dashboards/.
      const savedSearches = new Map<string, DashboardSearch>();
      for (const s of inputs.searches) {
        const ref: DashboardSearch = { spl: s.spl };
        if (s.earliest !== undefined) ref.earliest = s.earliest;
        if (s.latest !== undefined) ref.latest = s.latest;
        savedSearches.set(s.name, ref);
      }
      const boards: DashboardEntry[] = [];
      const takenBoards = new Set<string>();
      for (const d of inputs.dashboards) {
        // A dashboard starts only while the work budget lasts; it is charged what it really did.
        if (cutShort !== undefined || !canWork(1)) break;
        try {
          const conversion = convertDashboardSource(d, { ...(mapping ? { mapping } : {}), ...(o.strict ? { strict: true } : {}), savedSearches });
          worked += conversion.work;
          const json = `${JSON.stringify(conversion.dashboard, null, 2)}\n`;
          if (!fits(json.length)) break;
          const file = `dashboards/${safeFileName(conversion.title, takenBoards)}.json`;
          writeInside(out, file, json);
          const board = reportBoard(conversion, file, d.name);
          if (!withDetail(boardDetailSize(board))) dropBoardDetail(board);
          boards.push({ origin: d.name, file, conversion: board });
        } catch (e) {
          failed++;
          note(paint('note', 33), ` ${d.name}: ${messageOf(e)} It was skipped.\n`);
        }
      }

      const generated = (io.now?.() ?? new Date()).toISOString();
      const reportOptions = cutShort === undefined ? { redact: !!o.redact } : { redact: !!o.redact, cutShort };
      // A report that cannot be built or written ends the run with a plain message; the files
      // already written stay.
      try {
        if (formats.has('json')) writeInside(out, 'report.json', jsonReport(entries, generated, reportOptions, boards));
        if (formats.has('html')) writeInside(out, 'report.html', htmlReport(entries, generated, reportOptions, boards));
      } catch (e) {
        note(paint('error', 31), ` The report could not be written: ${messageOf(e)} The translated files are in ${out}.\n`);
        throw new Exit(EXIT.usage);
      }
      const s = summary(entries);
      const lines: string[] = [];
      if (entries.length > 0)
        lines.push(`${entries.length} searches → ${out}\nExact ${s.high}, needs review ${s.review}, incomplete ${s.low}, not translated ${s.none}`);
      if (boards.length > 0) {
        const t = boards.reduce((a, b) => ({ live: a.live + b.conversion.counts.live, manual: a.manual + b.conversion.counts.manual }), { live: 0, manual: 0 });
        lines.push(`${boards.length} dashboards → ${join(out, 'dashboards')}\n${t.live} panels converted, ${t.manual} need manual work`);
      }
      if (lines.length > 0) note(`${lines.join('\n')}\n`);
      if (cutShort !== undefined) {
        note(paint('error', 31), ` The run was cut short: ${cutShort}\n`);
        throw new Exit(EXIT.usage);
      }
      // Skipped items are reported above; the run fails only when nothing could be converted.
      if (entries.length === 0 && boards.length === 0 && failed > 0) throw new Exit(EXIT.usage);
      if (entries.some((e) => failsOn(o, e.result.confidence))) throw new Exit(EXIT.confidence);
    });

  program
    .command('dashboard')
    .description('Convert Splunk dashboards (Simple XML or Dashboard Studio) into Dynatrace dashboard files.')
    .argument('<inputs...>', 'dashboard files, or directories that contain them')
    .option('-m, --mapping <file>', 'mapping file (YAML or JSON); default spl2dql.mapping.yaml when present')
    .option('--out <dir>', 'write one <name>.json per dashboard here; without it one dashboard is printed')
    .option('--strict', 'treat every missing mapping (SPL4xxx) as an error')
    .option('-q, --quiet', 'do not print the panel summary')
    .addHelpText(
      'after',
      '\nA panel becomes a live tile only when its search translated completely. Otherwise the tile keeps the\nSplunk search and says what is missing. Inputs become dashboard variables.\n\nExamples:\n  spl2dql dashboard web_overview.xml > web_overview.json\n  spl2dql dashboard ./my_splunk_app --mapping m.yaml --out ./dashboards\n',
    )
    .action((paths: string[], o: Record<string, unknown>) => {
      const inputs = readInputs(paths, io.cwd);
      for (const n of inputs.skipped) note(paint('note', 33), ` ${n}\n`);
      if (inputs.dashboards.length === 0) throw new InputError('No Splunk dashboards found in the given inputs.');
      if (inputs.dashboards.length > 1 && !o.out)
        throw new InputError(`${inputs.dashboards.length} dashboards found; give --out <dir> to write one file each.`);
      const { mapping, imported } = resolveMapping(o, inputs);
      describeImport(imported);
      const savedSearches = new Map<string, DashboardSearch>();
      for (const s of inputs.searches) {
        const ref: DashboardSearch = { spl: s.spl };
        if (s.earliest !== undefined) ref.earliest = s.earliest;
        if (s.latest !== undefined) ref.latest = s.latest;
        savedSearches.set(s.name, ref);
      }
      const out = o.out ? prepareOutDir(resolve(io.cwd, String(o.out))) : undefined;
      const taken = new Set<string>();
      let converted = 0;
      let written = 0;
      let worked = 0;
      for (const d of inputs.dashboards) {
        if (worked >= workBudget) {
          note(
            paint('error', 31),
            ` The run was cut short: it would translate more than ${Math.round(workBudget / 1024 / 1024)} MB of SPL. Convert the rest in smaller batches.\n`,
          );
          throw new Exit(EXIT.usage);
        }
        let conversion: ReturnType<typeof convertDashboardSource>;
        try {
          conversion = convertDashboardSource(d, { ...(mapping ? { mapping } : {}), ...(o.strict ? { strict: true } : {}), savedSearches });
          worked += conversion.work;
          const json = `${JSON.stringify(conversion.dashboard, null, 2)}\n`;
          if (written + json.length > runBudget) {
            note(
              paint('error', 31),
              ` The run was cut short: it would write more than ${Math.round(runBudget / 1024 / 1024)} MB of DQL. Convert the rest in smaller batches.\n`,
            );
            throw new Exit(EXIT.usage);
          }
          written += json.length;
          if (out) writeInside(out, `${safeFileName(conversion.title, taken)}.json`, json);
          else say(json);
          converted++;
        } catch (e) {
          if (e instanceof Exit) throw e;
          // One dashboard that cannot be read or written never ends the run (ADR-029).
          note(paint('note', 33), ` ${d.name}: ${messageOf(e)} It was skipped.\n`);
          continue;
        }
        if (o.quiet) continue;
        const c = conversion.counts;
        note(`${conversion.title}: ${c.live} panels converted, ${c.manual} need manual work, ${c.text} text; ${conversion.variables.length} variable(s)\n`);
        for (const t of conversion.tiles) {
          if (t.outcome !== 'manual') continue;
          note('  ', paint('▲', 33), ` ${t.title || '(no title)'}: ${t.notes[0] ?? 'needs manual work'}\n`);
        }
        for (const n of conversion.notes) note(`  ${n}\n`);
      }
      if (converted === 0) throw new Exit(EXIT.usage);
    });

  const mapping = program.command('mapping').description('Create or check a mapping file.');
  mapping
    .command('init')
    .description('Write a mapping skeleton: every name the searches and dashboards use, filled in from Splunk configuration files where possible.')
    .argument('<inputs...>', 'files or directories (searches, dashboards, macros.conf, props.conf, eventtypes.conf …)')
    .option('-m, --mapping <file>', 'existing mapping file; only names it does not cover are listed')
    .addHelpText(
      'after',
      '\nmacros.conf, props.conf (EXTRACT-, REPORT-), transforms.conf, eventtypes.conf and tags.conf among the inputs\nare read and their definitions written into the skeleton, so only what is specific to Dynatrace is left to fill in.\n\nExamples:\n  spl2dql mapping init ./my_splunk_app > spl2dql.mapping.yaml\n  spl2dql mapping init savedsearches.conf macros.conf -m spl2dql.mapping.yaml\n',
    )
    .action((paths: string[], o: Record<string, unknown>) => {
      const inputs = readInputs(paths, io.cwd);
      for (const n of inputs.skipped) note(paint('note', 33), ` ${n}\n`);
      const { mapping: existing, imported } = resolveMapping(o, inputs);
      const opts: TranslateOptions = existing ? { mapping: existing } : {};
      const diags: Diagnostic[] = [];
      // One search or dashboard that cannot be read never ends the run (ADR-029). The run's work
      // budget applies here too.
      let worked = 0;
      const stop = (): never => {
        note(
          paint('error', 31),
          ` The run was cut short: it would translate more than ${Math.round(workBudget / 1024 / 1024)} MB of SPL. Run it on fewer files.\n`,
        );
        throw new Exit(EXIT.usage);
      };
      for (const s of inputs.searches) {
        const expanded = expandedLength(s.spl, opts, MAX_INPUT) ?? MAX_INPUT;
        if (worked + expanded > workBudget) stop();
        try {
          const result = translate(s.spl, opts);
          worked += result.diagnostics.some((d) => d.code === 'SPL1006') ? MAX_INPUT : expanded;
          for (const d of result.diagnostics) diags.push(d);
        } catch (e) {
          note(paint('note', 33), ` The search "${s.name}" (${s.origin}) was skipped: ${messageOf(e)}\n`);
        }
      }
      let panels = 0;
      for (const d of inputs.dashboards) {
        if (worked >= workBudget) stop();
        try {
          const conversion = convertDashboardSource(d, existing ? { mapping: existing } : {});
          worked += conversion.work;
          for (const t of conversion.tiles) {
            if (!t.result) continue;
            panels++;
            for (const d of t.result.diagnostics) diags.push(d);
          }
          for (const v of conversion.variables) if (v.result) for (const d of v.result.diagnostics) diags.push(d);
        } catch (e) {
          if (!(e instanceof DashboardError)) note(paint('note', 33), ` ${d.name}: ${messageOf(e)} It was skipped.\n`);
        }
      }
      const needs = collectMappingNeeds(diags);
      const skeleton: Record<string, unknown> = { version: 1 };
      // Held to the mapping file's own limits (names it accepts, 10,000 entries per section), so the
      // skeleton always reads back as a valid mapping file.
      let capped = false;
      const keys = (names: string[], pattern: RegExp): string[] => {
        const ok = names.filter((n) => pattern.test(n));
        if (ok.length > MAX_SECTION) capped = true;
        return ok.slice(0, MAX_SECTION);
      };
      const blank = (names: string[], value: (n: string) => unknown): Record<string, unknown> | undefined => {
        const list = keys(names, SPL_NAME);
        return list.length > 0 ? Object.fromEntries(list.map((n) => [n, value(n)])) : undefined;
      };
      const sections: [string, Record<string, unknown> | undefined][] = [
        ['indexes', blank(needs.indexes, () => ({ dataObject: 'logs', buckets: [] }))],
        ['sourcetypes', blank(needs.sourcetypes, () => ({ filter: 'true' }))],
        [
          'datamodels',
          needs.datamodels.length > 0
            ? Object.fromEntries(
                needs.datamodels
                  .filter((m) => DATAMODEL_NAME.test(m.name))
                  .slice(0, MAX_SECTION)
                  .map((m) => [m.name, { dataObject: 'logs', filter: 'true', fields: Object.fromEntries(keys(m.fields, FIELD_KEY).map((f) => [f, f])) }]),
              )
            : undefined,
        ],
        [
          'fields',
          blank(
            needs.fields.filter((n) => FIELD_KEY.test(n)),
            (n) => n,
          ),
        ],
        ['macros', blank(needs.macros, () => ({ definition: 'TODO' }))],
        ['lookups', blank(needs.lookups, (n) => ({ path: `/lookups/${n.replace(/[^A-Za-z0-9_.-]/g, '_')}` }))],
        ['eventtypes', blank(needs.eventtypes, () => 'true')],
      ];
      for (const [k, v] of sections) if (v) skeleton[k] = v;
      // Definitions read from the Splunk configuration files, on top of the blanks above.
      const filled = imported ? mergeMappingSections(skeleton, imported.sections) : skeleton;
      const header = [
        `# Mapping skeleton generated by spl2dql from ${inputs.searches.length} search(es) and ${panels} dashboard panel(s).`,
        '# Fill in every value; see docs/spec/mapping-config.md.',
      ];
      if (capped) header.push(`# A section had more than ${MAX_SECTION} names; only the first ${MAX_SECTION} are listed.`);
      if (imported) {
        const c = imported.counts;
        header.push(
          `# Read from Splunk configuration files: ${c.macros} macro(s), ${c.extractions} extraction(s), ${c.eventtypes} eventtype(s), ${c.tags} tag(s).`,
        );
        if (imported.skipped.length > 0) {
          header.push('#', '# Not carried over (do these by hand):');
          for (const sk of imported.skipped.slice(0, 200)) header.push(`#   ${sk.section} ${oneLine(sk.name)}: ${oneLine(sk.reason)}`);
          if (imported.skipped.length > 200) header.push(`#   … and ${imported.skipped.length - 200} more`);
        }
      }
      say(`${header.join('\n')}\n${toYaml(filled, { lineWidth: 0 })}`);
    });
  mapping
    .command('check')
    .description('Validate a mapping file.')
    .argument('<file>', 'mapping file')
    .action((file: string) => {
      loadMapping(file, io.cwd);
      note(`${file}: no problems found.\n`);
    });

  program
    .command('commands')
    .description('Print the support matrix: command, tier, notes.')
    .addOption(new Option('-o, --output <format>', 'output format').choices(['table', 'json']).default('table'))
    .action((o: Record<string, unknown>) => {
      const list = listCommands();
      if (o.output === 'json') return void say(`${JSON.stringify(list, null, 2)}\n`);
      const tierWord = { T1: 'exact', T2: 'review', T3: 'none' } as const;
      for (const c of list) say(`${c.name.padEnd(18)} ${tierWord[c.tier].padEnd(7)} ${c.summary}\n`);
    });

  program
    .command('explain')
    .description('Explain a note code, e.g. SPL3001.')
    .argument('<code>', 'note code')
    .action((code: string) => {
      const doc = explainDiagnostic(code);
      if (!doc) throw new InputError(`Unknown code "${code}". Codes look like SPL3001.`);
      say(`${doc.code} (${doc.severity})\n${doc.title}\nWhat to do: ${doc.hint}\n`);
    });

  program
    .command('serve')
    .description('Open the web app locally: serves it on 127.0.0.1 only. Everything runs in your browser.')
    .option('--port <port>', 'port', '4680')
    .option('--host <host>', 'loopback address to bind', '127.0.0.1')
    .action(async (o: Record<string, unknown>) => {
      const { startServer } = await import('./serve/server.ts');
      const handle = await startServer({ port: Number(o.port), host: String(o.host) });
      note(`spl2dql web app on ${handle.url}\nPress Ctrl+C to stop.\n`);
      await handle.closed;
    });

  for (const c of program.commands) if (['translate', 'batch'].includes(c.name())) shared(c);

  try {
    await program.parseAsync(['node', 'spl2dql', ...argv]);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    if (e instanceof CommanderError) return e.exitCode === 0 ? EXIT.ok : EXIT.usage;
    if (e instanceof MappingError) {
      note(paint('error', 31), ` ${e.message}\n`);
      for (const i of e.issues) note(`  ${i.path || '/'}: ${i.message}\n`);
      return EXIT.usage;
    }
    if (e instanceof InputError) {
      note(paint('error', 31), ` ${e.message}\n`);
      return EXIT.usage;
    }
    const message = e instanceof Error ? e.message : String(e);
    note(paint('error', 31), ` ${message}\n`);
    return EXIT.usage;
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readText(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    if (text.length > MAX_STDIN) throw new InputError(`${path} is larger than 10 MB.`);
    return text;
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError(`Cannot read ${path}.`);
  }
}

async function readStdin(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  let out = '';
  for await (const chunk of stdin) {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (out.length > MAX_STDIN) throw new InputError('Standard input is larger than 10 MB.');
  }
  return out;
}

/**
 * Line and column of offsets in `text`. The line starts are found once; each lookup is a binary
 * search, so printing many notes for a long search stays fast (ADR-029).
 */
function lineCol(text: string): (offset: number) => { line: number; col: number } {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - (starts[lo] as number) + 1 };
  };
}

/** One line, safe inside a YAML comment. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Text from the input made safe for a terminal: every escape sequence (CSI such as colours, OSC,
 * DCS and the other string controls, two-character escapes) is removed; a carriage return that
 * is not part of CRLF (it would let a note overwrite its own line) and the Unicode bidirectional
 * controls (which reorder what is shown) are removed; other control characters become "?".
 */
export function safeText(s: string): string {
  return s
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/\u001b[\]P^_X][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b[ -~]?/g, '')
    .replace(/\r(?!\n)/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '?');
}

/** A part printed in colour when the terminal shows colours. */
interface Painted {
  text: string;
  code: number;
}

function paint(text: string, code: number): Painted {
  return { text, code };
}

export type { TranslateResult };
