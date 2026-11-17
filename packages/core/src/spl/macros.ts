import type { MacroMapping, Span } from '../types.ts';
import { findQuoteEnd } from './split.ts';

export interface MacroEvent {
  code: 'SPL1005' | 'SPL4004' | 'SPL5005' | 'SPL1006';
  /** Span in the original text. */
  span: Span;
  detail: string;
  subject: string;
}

interface Segment {
  expStart: number;
  expEnd: number;
  origStart: number;
  origEnd: number;
  macro: boolean;
}

export interface Expansion {
  text: string;
  events: MacroEvent[];
  /** Maps a span of the expanded text back to the original text. */
  mapSpan(span: Span): Span;
}

const MAX_DEPTH = 10;
const MAX_EXPANDED = 1_000_000;

class Overflow extends Error {}

interface Budget {
  left: number;
}

/**
 * Expands backtick macro calls textually before parsing (spl-dql-mapping.md §4.9). Unknown macros
 * are left in place; the parsers drop them and SPL4004 explains why.
 */
export function expandMacros(text: string, macros: ReadonlyMap<string, MacroMapping>, limit = MAX_EXPANDED): Expansion {
  const events: MacroEvent[] = [];
  if (macros.size === 0 && !text.includes('`')) {
    return { text, events, mapSpan: (s) => s };
  }
  const segments: Segment[] = [];
  let out = '';
  let last = 0;
  let i = 0;
  const budget: Budget = { left: limit - text.length };

  const copy = (from: number, to: number): void => {
    if (to <= from) return;
    segments.push({ expStart: out.length, expEnd: out.length + (to - from), origStart: from, origEnd: to, macro: false });
    out += text.slice(from, to);
  };

  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const q = findQuoteEnd(text, i);
      i = q === -1 ? text.length : q + 1;
      continue;
    }
    if (c !== '`') {
      i++;
      continue;
    }
    if (text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3);
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    const close = text.indexOf('`', i + 1);
    if (close === -1) break;
    const call = text.slice(i + 1, close);
    const span = { start: i, end: close + 1 };
    let result: string | undefined;
    try {
      result = expandCall(call, span, macros, events, [], 0, budget);
    } catch (e) {
      if (!(e instanceof Overflow)) throw e;
      events.push({ code: 'SPL1006', span, detail: `Macro expansion makes the search longer than ${limit} characters.`, subject: call });
      return { text, events, mapSpan: (s) => s };
    }
    if (result !== undefined) {
      copy(last, i);
      segments.push({ expStart: out.length, expEnd: out.length + result.length, origStart: span.start, origEnd: span.end, macro: true });
      out += result;
      last = close + 1;
    }
    i = close + 1;
  }
  copy(last, text.length);

  // Segments follow each other without gaps or overlap: a binary search finds the one holding an
  // offset (one note per offset, so a search with many macros and many notes stays fast).
  const mapOffset = (offset: number, isEnd: boolean): number => {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid] as Segment;
      if (isEnd ? offset <= s.expStart : offset < s.expStart) hi = mid - 1;
      else if (isEnd ? offset > s.expEnd : offset >= s.expEnd) lo = mid + 1;
      else if (s.macro) return isEnd ? s.origEnd : s.origStart;
      else return s.origStart + (offset - s.expStart);
    }
    return isEnd ? text.length : Math.min(offset, text.length);
  };
  return {
    text: out,
    events,
    mapSpan: (sp) => {
      const start = mapOffset(sp.start, false);
      const end = sp.end <= sp.start ? start : mapOffset(sp.end, true);
      return { start, end: Math.max(start, end) };
    },
  };
}

function expandCall(
  call: string,
  span: Span,
  macros: ReadonlyMap<string, MacroMapping>,
  events: MacroEvent[],
  stack: string[],
  depth: number,
  budget: Budget,
): string | undefined {
  const m = /^\s*([A-Za-z0-9_.:-]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(call);
  if (!m) return undefined;
  const name = m[1] as string;
  const args = m[2] === undefined ? [] : splitArgs(m[2]);
  const key = args.length > 0 ? `${name}(${args.length})` : name;
  const def = macros.get(key);
  if (!def) {
    if (depth === 0) events.push({ code: 'SPL4004', span, detail: `Macro \`${key}\` has no definition in the mapping file.`, subject: key });
    else events.push({ code: 'SPL1005', span, detail: `Macro \`${key}\`, used inside another macro, has no definition.`, subject: key });
    return depth === 0 ? undefined : '';
  }
  if (stack.includes(key) || depth >= MAX_DEPTH) {
    events.push({ code: 'SPL1005', span, detail: `Macro \`${key}\` expands into itself or is nested more than ${MAX_DEPTH} deep.`, subject: key });
    return '';
  }
  let body = def.definition;
  if (body.length > budget.left) throw new Overflow();
  for (let idx = 0; idx < def.args.length; idx++) {
    const placeholder = `$${def.args[idx]}$`;
    const value = args[idx] ?? '';
    const pieces = body.split(placeholder);
    // The length is known before the text is built: a long argument used many times must not
    // build a huge string first and be refused afterwards (ADR-029).
    const length = body.length + (pieces.length - 1) * (value.length - placeholder.length);
    if (length > budget.left) throw new Overflow();
    body = pieces.join(value);
  }
  budget.left -= body.length;
  if (budget.left < 0) throw new Overflow();
  if (depth === 0) events.push({ code: 'SPL5005', span, detail: `Macro \`${key}\` was expanded.`, subject: key });
  // Expand macros used inside the definition.
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"') {
      const q = findQuoteEnd(body, i);
      const end = q === -1 ? body.length : q + 1;
      out += body.slice(i, end);
      i = end;
      continue;
    }
    if (c === '`' && !body.startsWith('```', i)) {
      const close = body.indexOf('`', i + 1);
      if (close !== -1) {
        const inner = expandCall(body.slice(i + 1, close), span, macros, events, [...stack, key], depth + 1, budget);
        out += inner ?? body.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Splits macro arguments at top-level commas, keeping quoted strings intact. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === '"') {
      const q = findQuoteEnd(s, i);
      const end = q === -1 ? s.length : q + 1;
      cur += s.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}
