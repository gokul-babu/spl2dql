/**
 * Pure parsers for the files people export searches in. No I/O: the CLI reads files from disk and the
 * web app reads dropped files, then both call these.
 */
import { uniqueName } from '../util/unique.ts';
import { confTrue, parseConf } from './conf.ts';

/** One search to translate, with a name used for the output file and the report. */
export interface SearchInput {
  name: string;
  spl: string;
  /** Where it came from: a file path, or "file › stanza". */
  origin: string;
  /** Time range saved with the search (`dispatch.earliest_time` / `dispatch.latest_time`). */
  earliest?: string;
  latest?: string;
  /** The search is switched off in Splunk (`disabled = 1`). */
  disabled?: boolean;
  /** `cron_schedule` of a scheduled search or alert. */
  schedule?: string;
  description?: string;
}

export class InputError extends Error {}

const MAX_ROWS = 100_000;

/**
 * savedsearches.conf: one search per `[stanza]` that has a non-empty `search = …`. The saved time
 * range, the schedule and the disabled flag come along; `[default]` supplies the time range for
 * stanzas that do not set their own, as in Splunk.
 */
export function parseSavedSearches(text: string, origin: string): SearchInput[] {
  const out: SearchInput[] = [];
  const stanzas = parseConf(text);
  const defaults = stanzas.find((s) => s.name === 'default')?.values;
  for (const stanza of stanzas) {
    if (stanza.name === 'default') continue;
    const spl = stanza.values.get('search');
    if (spl === undefined || spl === '') continue;
    const item: SearchInput = { name: stanza.name, spl, origin: `${origin} › ${stanza.name}` };
    const get = (key: string): string | undefined => {
      const v = stanza.values.get(key) ?? defaults?.get(key);
      return v === undefined || v === '' ? undefined : v;
    };
    const earliest = get('dispatch.earliest_time');
    const latest = get('dispatch.latest_time');
    if (earliest !== undefined) item.earliest = earliest;
    if (latest !== undefined) item.latest = latest;
    if (confTrue(stanza.values.get('disabled'))) item.disabled = true;
    const schedule = stanza.values.get('cron_schedule');
    if (schedule !== undefined && schedule !== '' && confTrue(stanza.values.get('enableSched') ?? stanza.values.get('is_scheduled') ?? '1')) {
      item.schedule = schedule;
    }
    const description = stanza.values.get('description');
    if (description !== undefined && description !== '') item.description = description;
    out.push(item);
  }
  return out;
}

/** A CSV with a "search" column and an optional "name" (or "title") column. RFC 4180 quoting. */
export function parseCsvSearches(text: string, origin: string): SearchInput[] {
  const rows = parseCsv(text);
  if (rows.length > MAX_ROWS) throw new InputError(`${origin}: more than ${MAX_ROWS} rows.`);
  const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const searchCol = header.indexOf('search');
  const nameCol = header.indexOf('name') !== -1 ? header.indexOf('name') : header.indexOf('title');
  if (searchCol === -1) throw new InputError(`${origin}: the CSV needs a "search" column.`);
  return rows
    .map((r, i) => ({
      name: (nameCol !== -1 ? r[nameCol]?.trim() : undefined) || `row-${i + 2}`,
      spl: (r[searchCol] ?? '').trim(),
      origin: `${origin} › row ${i + 2}`,
    }))
    .filter((s) => s.spl !== '');
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x !== ''));
}

/** A file name that is safe on every platform and cannot climb out of the output directory. */
export function safeFileName(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFKC')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 100) || 'search';
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base) ? `_${base}` : base;
  return uniqueName(reserved, taken, (n) => `${reserved}-${n}`);
}
