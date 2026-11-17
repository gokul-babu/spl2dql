import { type ConfigFile, configKind, type DashboardSource, InputError, parseCsvSearches, parseSavedSearches, type SearchInput } from '@spl2dql/core';
import { checkBudget, type InputFile, MAX_FILE } from './input-files.ts';

/** What a set of dropped or chosen files contains. */
export interface SplunkFiles {
  searches: SearchInput[];
  dashboards: DashboardSource[];
  configs: ConfigFile[];
  /** Files that are none of the kinds this app reads. */
  ignored: string[];
}

/**
 * Sorts files into searches, dashboards and Splunk configuration files, by name and content. Runs
 * in the worker: reading and parsing a large file never blocks the page. Nothing is uploaded.
 */
export async function readSplunkFiles(files: readonly InputFile[]): Promise<SplunkFiles> {
  checkBudget(files);
  const list = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  const out: SplunkFiles = { searches: [], dashboards: [], configs: [], ignored: [] };
  for (const f of list) {
    const name = f.path;
    const base = name.replace(/^.*[\\/]/, '');
    const lower = base.toLowerCase();
    const known = /\.(spl|txt|csv|conf|xml|json)$/.test(lower);
    if (!known) {
      out.ignored.push(name);
      continue;
    }
    if (f.size > MAX_FILE) throw new InputError(`${name} is larger than 10 MB.`);
    const text = f.text ?? (await f.blob?.text()) ?? '';
    if (configKind(base)) out.configs.push({ name, text });
    // A loop, not push(...list): one file can hold 100,000 searches, more arguments than a call takes.
    else if (lower.endsWith('.conf')) for (const s of parseSavedSearches(text, name)) out.searches.push(s);
    else if (lower.endsWith('.csv')) for (const s of parseCsvSearches(text, name)) out.searches.push(s);
    else if (lower.endsWith('.xml') || lower.endsWith('.json')) {
      const dashboard = lower.endsWith('.xml')
        ? /<(dashboard|form)[\s>]/.test(text.slice(0, 4000))
        : text.includes('"dataSources"') || text.includes('"visualizations"');
      if (dashboard) out.dashboards.push({ name, text });
      else out.ignored.push(name);
    } else out.searches.push({ name: base.replace(/\.(spl|txt)$/i, ''), spl: text.trim(), origin: name });
  }
  return out;
}
