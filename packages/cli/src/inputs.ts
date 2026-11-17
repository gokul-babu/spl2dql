import { lstatSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

import {
  type ConfigFile,
  configKind,
  type DashboardSource,
  InputError,
  parseCsvSearches,
  parseSavedSearches,
  type SearchInput,
  safeFileName,
} from '@spl2dql/core';

import { readRegularFile } from './safe-fs.ts';

export { InputError, type SearchInput, safeFileName };

/** Everything found in the files and directories given on the command line. */
export interface Inputs {
  searches: SearchInput[];
  /** Splunk dashboards: Simple XML, or a Dashboard Studio definition. */
  dashboards: DashboardSource[];
  /** macros.conf, props.conf, transforms.conf, eventtypes.conf, tags.conf — in path order. */
  configs: ConfigFile[];
  /** Files and folders inside a given folder that could not be read, as notes (ADR-029). */
  skipped: string[];
}

const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 50_000;
const MAX_SEARCHES = 100_000;
const MAX_DASHBOARDS = 10_000;
/** All inputs of one run together (ADR-029). */
export const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

/**
 * Reads searches, dashboards and Splunk configuration files. Directories are walked without
 * following symbolic links (so a link cannot pull in files from elsewhere or loop). In a directory
 * only files that are recognisably Splunk's are read: .spl and .txt searches, the known .conf
 * files, and .xml/.json files that are dashboards. A file named on the command line is always read.
 */
export function readInputs(paths: readonly string[], cwd: string, maxTotalBytes = MAX_TOTAL_BYTES): Inputs {
  const out: Inputs = { searches: [], dashboards: [], configs: [], skipped: [] };
  const unreadable = (path: string, e: unknown): void => {
    const code = (e as NodeJS.ErrnoException)?.code;
    out.skipped.push(`${shown(path)} could not be read${code ? ` (${code})` : ''}; it was skipped.`);
  };
  let files = 0;
  let bytes = 0;
  // What reports call a file: its path from the input given on the command line (a folder keeps its
  // own name in front), never an absolute path.
  let root = '';
  let label = '';
  const shown = (path: string): string => {
    const rel = relative(root, path);
    return (rel === '' ? label : `${label}/${rel}`).split(sep).join('/');
  };
  const visit = (path: string, explicit: boolean): void => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch (e) {
      if (!explicit) return void unreadable(path, e);
      throw new InputError(`Cannot read ${path}: it does not exist or is not accessible.`);
    }
    if (st.isSymbolicLink()) {
      if (explicit) throw new InputError(`${path} is a symbolic link; pass the file it points to.`);
      return;
    }
    if (st.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(path).sort();
      } catch (e) {
        // Inside a folder that was given, one that cannot be read is skipped with a note.
        if (!explicit) return void unreadable(path, e);
        throw new InputError(`Cannot read the folder ${path}.`);
      }
      for (const entry of entries) visit(join(path, entry), false);
      return;
    }
    if (!st.isFile()) return;
    const ext = extname(path).toLowerCase();
    const name = basename(path);
    const lower = name.toLowerCase();
    const config = configKind(name) !== undefined;
    const known = ext === '.spl' || ext === '.txt' || ext === '.xml' || ext === '.json' || config || lower === 'savedsearches.conf';
    if (!explicit && !known) return;
    if (st.size > MAX_FILE) {
      if (explicit) throw new InputError(`${path} is larger than 10 MB.`);
      return;
    }
    if (++files > MAX_FILES) throw new InputError(`More than ${MAX_FILES} files; translate them in smaller batches.`);
    bytes += st.size;
    if (bytes > maxTotalBytes) {
      throw new InputError(`The inputs are larger than ${Math.round(maxTotalBytes / 1024 / 1024)} MB in total; translate them in smaller batches.`);
    }
    let text: string;
    try {
      // Read through one handle, so a name that changed after the checks above cannot bring in a
      // link's target or a larger file.
      text = readRegularFile(path, MAX_FILE).toString('utf8');
    } catch (e) {
      bytes -= st.size;
      files--;
      if (!explicit) return void unreadable(path, e);
      throw new InputError(`Cannot read ${path}.`);
    }
    const origin = shown(path);
    if (config) out.configs.push({ name: origin, text });
    else if (lower === 'savedsearches.conf' || ext === '.conf') for (const s of parseSavedSearches(text, origin)) out.searches.push(s);
    else if (ext === '.csv') for (const s of parseCsvSearches(text, origin)) out.searches.push(s);
    else if (ext === '.xml' || ext === '.json') {
      if (looksLikeDashboard(text, ext)) out.dashboards.push({ name: origin, text });
      else if (explicit) throw new InputError(`${path} is not a Splunk dashboard (Simple XML or a Dashboard Studio definition).`);
    } else out.searches.push({ name: name.replace(/\.(spl|txt)$/i, ''), spl: text.trim(), origin });
    if (out.searches.length > MAX_SEARCHES) throw new InputError(`More than ${MAX_SEARCHES} searches; translate them in smaller batches.`);
    if (out.dashboards.length > MAX_DASHBOARDS) throw new InputError(`More than ${MAX_DASHBOARDS} dashboards; convert them in smaller batches.`);
  };
  for (const p of paths) {
    root = resolve(cwd, p);
    label = basename(root) || 'input';
    visit(root, true);
  }
  return out;
}

/** A cheap look at the start of a file, so a folder walk does not pick up unrelated XML or JSON. */
function looksLikeDashboard(text: string, ext: string): boolean {
  const head = text.slice(0, 4000);
  if (ext === '.xml') return /<(dashboard|form)[\s>]/.test(head);
  return text.includes('"dataSources"') || text.includes('"visualizations"');
}
