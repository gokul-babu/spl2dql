import type { Confidence, DashboardConversion, Diagnostic, TileOutcome, TranslateResult } from '@spl2dql/core';

/** What a report needs of one translation; the rest of the result is not kept for the whole run. */
export interface ReportResult {
  dql: string;
  confidence: Confidence;
  score: number;
  /** The first MAX_NOTES_SHOWN notes. */
  diagnostics: Diagnostic[];
  /** Notes left out of the report; they are only counted. */
  moreNotes?: number;
  /** Warnings and errors among all the notes, for the report's index. */
  attention: number;
}

export interface ReportEntry {
  name: string;
  origin: string;
  file: string;
  spl: string;
  result: ReportResult;
  /** From savedsearches.conf: the saved time range, the schedule, and whether Splunk has it switched off. */
  earliest?: string;
  latest?: string;
  schedule?: string;
  disabled?: boolean;
  /** Set when the report's budget was reached: the search is listed without SPL, DQL and notes. */
  noDetail?: true;
}

/** What a report needs of one converted dashboard. */
export interface ReportBoard {
  title: string;
  format: DashboardConversion['format'];
  counts: DashboardConversion['counts'];
  notes: string[];
  variables: { key: string; token: string; type: string; notes: string[] }[];
  tiles: { title: string; outcome: TileOutcome; visualization?: string; spl?: string; result?: { confidence: Confidence; dql: string }; notes: string[] }[];
  /** Set when the report's budget was reached: panels are listed without SPL, DQL and notes. */
  noDetail?: true;
}

export interface DashboardEntry {
  origin: string;
  /** Name of the Dynatrace dashboard file that was written. */
  file: string;
  conversion: ReportBoard;
}

/** Characters of one query (or search) a report shows; the rest is in the file it names. */
export const MAX_SHOWN = 20_000;

/** The text as a report shows it: at most MAX_SHOWN characters, then a line saying where the rest is. */
export function shown(text: string, where: string): string {
  if (text.length <= MAX_SHOWN) return text;
  return `${text.slice(0, MAX_SHOWN)}\n… ${text.length - MAX_SHOWN} more characters; the full text is in ${where}.`;
}

/** Notes of one search a report lists; a search can have up to 10,001. */
export const MAX_NOTES_SHOWN = 200;

/** Characters of detail one search adds to a report. */
export function detailSize(e: ReportEntry): number {
  let n = e.spl.length + e.result.dql.length;
  for (const d of e.result.diagnostics) n += d.message.length + 60;
  return n;
}

/** Lists the search without its detail. */
export function dropDetail(e: ReportEntry): void {
  e.spl = '';
  const { moreNotes: _dropped, ...rest } = e.result;
  e.result = { ...rest, dql: '', diagnostics: [] };
  e.noDetail = true;
}

/** Characters of detail one dashboard adds to a report. */
export function boardDetailSize(b: ReportBoard): number {
  let n = 0;
  for (const t of b.tiles) n += (t.spl?.length ?? 0) + (t.result?.dql.length ?? 0) + t.notes.reduce((a, x) => a + x.length, 0);
  return n;
}

/** Lists the dashboard's panels without their detail. */
export function dropBoardDetail(b: ReportBoard): void {
  b.tiles = b.tiles.map((t) => {
    const tile: ReportBoard['tiles'][number] = { title: t.title, outcome: t.outcome, notes: [] };
    if (t.visualization !== undefined) tile.visualization = t.visualization;
    return tile;
  });
  b.noDetail = true;
}

/** The sentence a report shows when its budget was reached. */
function withoutDetail(entries: readonly ReportEntry[], dashboards: readonly DashboardEntry[]): string | undefined {
  const searches = entries.filter((e) => e.noDetail).length;
  const boards = dashboards.filter((d) => d.conversion.noDetail).length;
  if (searches === 0 && boards === 0) return undefined;
  return `The report reached its size limit: ${searches} search(es) and ${boards} dashboard(s) are listed without detail. Their files hold everything.`;
}

/** Keeps of a translation only what the report shows. */
export function reportResult(result: TranslateResult, where: string): ReportResult {
  const out: ReportResult = {
    dql: shown(result.dql, where),
    confidence: result.confidence,
    score: result.score,
    diagnostics: result.diagnostics.slice(0, MAX_NOTES_SHOWN),
    attention: result.diagnostics.filter((d) => d.severity !== 'info').length,
  };
  if (result.diagnostics.length > MAX_NOTES_SHOWN) out.moreNotes = result.diagnostics.length - MAX_NOTES_SHOWN;
  return out;
}

/** Keeps of a dashboard conversion only what the report shows. */
export function reportBoard(c: DashboardConversion, file: string, origin: string): ReportBoard {
  return {
    title: c.title,
    format: c.format,
    counts: c.counts,
    notes: c.notes,
    variables: c.variables.map((v) => ({ key: v.key, token: v.token, type: v.type, notes: v.notes })),
    tiles: c.tiles.map((t) => {
      const tile: ReportBoard['tiles'][number] = { title: t.title, outcome: t.outcome, notes: t.notes };
      if (t.visualization !== undefined) tile.visualization = t.visualization;
      if (t.spl !== undefined) tile.spl = shown(t.spl, origin);
      if (t.result) tile.result = { confidence: t.result.confidence, dql: shown(t.result.dql, file) };
      return tile;
    }),
  };
}

export const OUTCOME_WORD: Record<TileOutcome, string> = {
  live: 'Converted',
  manual: 'Needs manual work',
  text: 'Text',
};

export const CONFIDENCE_WORD: Record<Confidence, string> = {
  high: 'Exact',
  review: 'Needs review',
  low: 'Incomplete',
  none: 'Not translated',
};

const ORDER: Confidence[] = ['none', 'low', 'review', 'high'];

export function summary(entries: readonly ReportEntry[]): Record<Confidence, number> {
  const s: Record<Confidence, number> = { high: 0, review: 0, low: 0, none: 0 };
  for (const e of entries) s[e.result.confidence]++;
  return s;
}

/** Replaces quoted values, IPv4 addresses and e-mail addresses with same-length placeholders. */
export function redact(text: string): string {
  return redactQuoted(text)
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, (m) => m.replace(/\d/g, '0'))
    .replace(/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}\b/g, (m) => 'x'.repeat(m.length));
}

const MAX_QUOTED = 4000;

/**
 * Replaces the inside of every double-quoted string of at most MAX_QUOTED characters or escape
 * pairs with "x"s — what `/"((?:[^"\\]|\\.){0,4000})"/g` matches, in linear time: where the string
 * that starts at each position would end, and how long it is, is computed once from the right, so
 * text full of escaped quotes is not rescanned from every quote (ADR-029).
 */
function redactQuoted(text: string): string {
  const n = text.length;
  // end[i]: index of the closing quote of a string body starting at i, or -1; units[i]: its length.
  const end = new Int32Array(n + 2).fill(-1);
  const units = new Int32Array(n + 2);
  for (let i = n - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '"') {
      end[i] = i;
    } else if (c === '\\') {
      const next = text[i + 1];
      if (next !== undefined && !/[\n\r\u2028\u2029]/.test(next)) {
        end[i] = end[i + 2] as number;
        units[i] = (units[i + 2] as number) + 1;
      }
    } else {
      end[i] = end[i + 1] as number;
      units[i] = (units[i + 1] as number) + 1;
    }
  }
  let out = '';
  let copied = 0;
  for (let p = 0; p < n; p++) {
    if (text[p] !== '"') continue;
    const close = end[p + 1] as number;
    if (close === -1 || (units[p + 1] as number) > MAX_QUOTED) continue;
    out += `${text.slice(copied, p + 1)}${'x'.repeat(close - p - 1)}"`;
    copied = close + 1;
    p = close;
  }
  return out + text.slice(copied);
}

export interface ReportOptions {
  redact: boolean;
  /** Set when the run stopped early: why, in one sentence. */
  cutShort?: string;
}

export function jsonReport(entries: readonly ReportEntry[], generated: string, opts: ReportOptions, dashboards: readonly DashboardEntry[] = []): string {
  const r = (t: string): string => (opts.redact ? redact(t) : t);
  const notesOf = (result: ReportResult): unknown[] =>
    result.diagnostics.map((d) => ({ code: d.code, severity: d.severity, stage: d.stageIndex, message: r(d.message) }));
  const body: Record<string, unknown> = {
    generated,
    ...(opts.cutShort !== undefined ? { cutShort: opts.cutShort } : {}),
    ...(withoutDetail(entries, dashboards) !== undefined ? { withoutDetail: withoutDetail(entries, dashboards) } : {}),
    summary: summary(entries),
    searches: entries.map((e) => ({
      name: e.name,
      origin: e.origin,
      file: e.file,
      confidence: e.result.confidence,
      score: e.result.score,
      ...(e.earliest !== undefined ? { earliest: e.earliest } : {}),
      ...(e.latest !== undefined ? { latest: e.latest } : {}),
      ...(e.schedule !== undefined ? { schedule: e.schedule } : {}),
      ...(e.disabled ? { disabled: true } : {}),
      ...(e.noDetail ? { detail: false } : { spl: r(e.spl), dql: r(e.result.dql), notes: notesOf(e.result) }),
      ...(e.result.moreNotes !== undefined ? { moreNotes: e.result.moreNotes } : {}),
    })),
  };
  if (dashboards.length > 0) {
    body.dashboards = dashboards.map((d) => ({
      title: d.conversion.title,
      origin: d.origin,
      file: d.file,
      format: d.conversion.format,
      tiles: d.conversion.counts,
      notes: d.conversion.notes.map(r),
      variables: d.conversion.variables.map((v) => ({ key: v.key, token: v.token, type: v.type, notes: v.notes.map(r) })),
      panels: d.conversion.tiles.map((t) => ({
        title: r(t.title),
        outcome: t.outcome,
        ...(t.visualization !== undefined ? { visualization: t.visualization } : {}),
        ...(t.spl !== undefined ? { spl: r(t.spl) } : {}),
        ...(t.result ? { confidence: t.result.confidence, dql: r(t.result.dql) } : {}),
        notes: t.notes.map(r),
      })),
    }));
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text for the HTML report: escaped, and without control characters other than tab and newline. */
export function escapeHtml(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

/**
 * A single self-contained HTML file. It contains no scripts at all and a CSP that forbids them, so
 * nothing in a translated search can execute when the report is opened.
 */
export function htmlReport(entries: readonly ReportEntry[], generated: string, opts: ReportOptions, dashboards: readonly DashboardEntry[] = []): string {
  const r = (t: string): string => escapeHtml(opts.redact ? redact(t) : t);
  const saved = (e: ReportEntry): string => {
    const parts: string[] = [];
    if (e.disabled) parts.push('Switched off in Splunk');
    if (e.earliest !== undefined || e.latest !== undefined) parts.push(`Time range ${r(e.earliest ?? '…')} to ${r(e.latest ?? 'now')}`);
    if (e.schedule !== undefined) parts.push(`Schedule ${r(e.schedule)}`);
    return parts.length > 0 ? `<p class="o">${parts.join(' · ')}</p>` : '';
  };
  const boards = dashboards
    .map((d, i) => {
      const c = d.conversion;
      const tiles = c.tiles
        .map(
          (t) =>
            `<tr class="t-${t.outcome}"><td>${r(t.title || '(no title)')}</td><td>${OUTCOME_WORD[t.outcome]}</td><td>${t.visualization ? escapeHtml(t.visualization) : ''}</td><td>${
              t.notes.length > 0 ? `<ul>${t.notes.map((n) => `<li>${r(n)}</li>`).join('')}</ul>` : ''
            }</td></tr>`,
        )
        .join('');
      const vars =
        c.variables.length > 0
          ? `<p class="o">Variables: ${c.variables.map((v) => `<code>$${escapeHtml(v.key)}</code> (${v.type}, from <code>$${r(v.token)}$</code>)`).join(', ')}</p>`
          : '';
      const notes = [...c.notes, ...c.variables.flatMap((v) => v.notes.map((n) => `$${v.key}: ${n}`))];
      return `<section id="d${i}" class="${c.counts.manual > 0 ? 'review' : 'high'}">
<h2>${r(c.title)} <span class="c">${c.counts.live} converted · ${c.counts.manual} need manual work · ${c.counts.text} text</span></h2>
<p class="o">${r(d.origin)} → <code>${escapeHtml(d.file)}</code></p>
${vars}
${notes.length > 0 ? `<ul>${notes.map((n) => `<li class="warning"><span aria-hidden="true">▲</span> ${r(n)}</li>`).join('')}</ul>` : ''}
<table class="tiles"><thead><tr><th>Panel</th><th>Result</th><th>Shown as</th><th>To check</th></tr></thead><tbody>${tiles}</tbody></table>
</section>`;
    })
    .join('\n');
  const boardTotals = dashboards.reduce(
    (a, d) => ({ live: a.live + d.conversion.counts.live, manual: a.manual + d.conversion.counts.manual, text: a.text + d.conversion.counts.text }),
    { live: 0, manual: 0, text: 0 },
  );
  const s = summary(entries);
  const sorted = [...entries].sort((a, b) => ORDER.indexOf(a.result.confidence) - ORDER.indexOf(b.result.confidence) || a.name.localeCompare(b.name));
  const mark = (d: Diagnostic): string => (d.severity === 'error' ? '■' : d.severity === 'warning' ? '▲' : '●');
  const rows = sorted
    .map((e, i) => {
      return `<section id="s${i}" class="${e.result.confidence}">
<h2>${r(e.name)} <span class="c">${CONFIDENCE_WORD[e.result.confidence]}</span></h2>
<p class="o">${r(e.origin)}</p>
${saved(e)}
${e.noDetail ? `<p class="o">Listed without detail; the full DQL is in <code>${escapeHtml(e.file)}</code>.</p>` : `<div class="g"><div><h3>Splunk SPL</h3><pre>${r(e.spl)}</pre></div><div><h3>Dynatrace DQL</h3><pre>${r(e.result.dql)}</pre></div></div>`}
${e.result.diagnostics.length > 0 ? `<ul>${e.result.diagnostics.map((d) => `<li class="${d.severity}"><span aria-hidden="true">${mark(d)}</span> <b>${d.code}</b> stage ${d.stageIndex + 1}: ${r(d.message)}</li>`).join('')}${e.result.moreNotes !== undefined ? `<li class="info">… and ${e.result.moreNotes} more notes</li>` : ''}</ul>` : ''}
</section>`;
    })
    .join('\n');
  const index = sorted
    .map((e, i) => `<tr><td><a href="#s${i}">${r(e.name)}</a></td><td>${CONFIDENCE_WORD[e.result.confidence]}</td><td>${e.result.attention}</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>spl2dql report</title>
<style>
:root{--canvas:#EEF1F0;--surface:#FBFCFB;--ink:#17232B;--muted:#51616B;--line:#CBD3D1;--exact:#0B6E78;--check:#9A5B00;--blocked:#A8214F}
@media (prefers-color-scheme:dark){:root{--canvas:#1A2227;--surface:#222C32;--ink:#E6ECEA;--muted:#9DAAB0;--line:#37444B;--exact:#4FB8C2;--check:#E0A64A;--blocked:#F07A9E}}
body{margin:0;padding:24px 16px;background:var(--canvas);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto}h1{font-size:24px}h2{font-size:18px;margin:0 0 4px}h3{font-size:13px;color:var(--muted);margin:0 0 4px;font-weight:600}
table{border-collapse:collapse;width:100%;background:var(--surface)}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left}
section{background:var(--surface);border-left:4px solid var(--line);padding:16px;margin:16px 0}
section.high{border-color:var(--exact)}section.review{border-color:var(--check)}section.low,section.none{border-color:var(--blocked)}
.c{font-size:13px;font-weight:600;color:var(--muted)}.o{color:var(--muted);font-size:13px;margin:0 0 8px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:760px){.g{grid-template-columns:1fr}}
pre{white-space:pre-wrap;word-break:break-word;background:var(--canvas);padding:8px;margin:0;font:13px/1.55 ui-monospace,monospace}
li.error span{color:var(--blocked)}li.warning span{color:var(--check)}li.info span{color:var(--muted)}ul{padding-left:18px;margin:8px 0 0}
code{font:13px/1.4 ui-monospace,monospace}table.tiles{margin-top:12px;background:none}table.tiles td{vertical-align:top}table.tiles ul{margin:0}
tr.t-manual td:nth-child(2){color:var(--blocked);font-weight:600}.cut{border-left:4px solid var(--blocked);padding:8px 12px;background:var(--surface)}tr.t-live td:nth-child(2){color:var(--exact);font-weight:600}
</style></head><body><main>
<h1>spl2dql report</h1>
<p>${entries.length} searches · Exact ${s.high} · Needs review ${s.review} · Incomplete ${s.low} · Not translated ${s.none}${
    dashboards.length > 0
      ? `<br>${dashboards.length} dashboards · ${boardTotals.live} panels converted · ${boardTotals.manual} need manual work · ${boardTotals.text} text`
      : ''
  }<br><span class="c">Generated ${escapeHtml(generated)}${opts.redact ? ' · values redacted' : ''}</span></p>
${opts.cutShort !== undefined ? `<p class="cut"><b>This run was cut short.</b> ${escapeHtml(opts.cutShort)}</p>` : ''}
${withoutDetail(entries, dashboards) !== undefined ? `<p class="cut">${escapeHtml(withoutDetail(entries, dashboards) as string)}</p>` : ''}
${dashboards.length > 0 ? `<h2>Dashboards</h2>\n${boards}` : ''}
${entries.length > 0 ? `${dashboards.length > 0 ? '<h2>Searches</h2>\n' : ''}<table><thead><tr><th>Search</th><th>Confidence</th><th>Notes</th></tr></thead><tbody>${index}</tbody></table>` : ''}
${rows}
<p class="c">Made with spl2dql, an independent open-source project that is not affiliated with, endorsed by or supported by Splunk Inc., Cisco or Dynatrace. Splunk, SPL, Dynatrace and DQL are trademarks of their respective owners. Provided without warranty; check every translated query before relying on it.</p>
</main></body></html>
`;
}
