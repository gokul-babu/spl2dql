import { assign, call, cmd, cmdOf, type DqlExpr, dpl, field, not, num } from '../dql/ast.ts';
import { type Stage, Untranslatable } from '../lower/context.ts';
import { lowerExpr } from '../lower/expr.ts';
import { regexToDpl } from '../lower/regex.ts';
import { lowerLaterSearch, lowerLeadingSearch } from '../lower/search.ts';
import { ExprError, parseExpr, type SExpr } from '../spl/expr.ts';
import { parseSearch, SearchError } from '../spl/search.ts';
import type { CommandDef } from './types.ts';

function parseSearchArgs(st: Stage) {
  try {
    return parseSearch(st.tc.text, st.argsSpan.start, st.argsSpan.end);
  } catch (e) {
    if (e instanceof SearchError) throw new Untranslatable('SPL1001', e.span, e.message);
    throw e;
  }
}

export function parseExprIn(st: Stage, start: number, end: number): SExpr {
  try {
    return parseExpr(st.tc.text, start, end);
  } catch (e) {
    if (e instanceof ExprError) throw new Untranslatable('SPL1004', e.span, e.message);
    throw e;
  }
}

export const search: CommandDef = {
  name: 'search',
  tier: 'T1',
  summary: 'Leading search → fetch with time range and filters; later searches → filter.',
  generating: true,
  lower(st) {
    const root = parseSearchArgs(st);
    if (st.first && st.depth >= 0 && st.state.schema.kind === 'events' && st.upstream.length === 0) {
      lowerLeadingSearch(st, root);
    } else {
      lowerLaterSearch(st, root);
    }
  },
};

export const where: CommandDef = {
  name: 'where',
  tier: 'T1',
  summary: 'filter with eval semantics (case-sensitive comparisons).',
  lower(st) {
    if (st.argsSpan.start >= st.argsSpan.end || st.slice(st.argsSpan).trim() === '') {
      throw new Untranslatable('SPL1003', st.span, 'where needs a condition.');
    }
    const e = parseExprIn(st, st.argsSpan.start, st.argsSpan.end);
    st.emit(cmd('filter', lowerExpr(e, st).e));
  },
};

export const evalCmd: CommandDef = {
  name: 'eval',
  tier: 'T1',
  summary: 'fieldsAdd; split into several when an assignment uses a field set earlier in the same eval.',
  lower(st) {
    const assignments = splitAssignments(st);
    if (assignments.length === 0) throw new Untranslatable('SPL1003', st.span, 'eval needs at least one "field = expression".');
    let batch: DqlExpr[] = [];
    let defined = new Set<string>();
    const flush = (): void => {
      if (batch.length > 0) st.emit(cmdOf('fieldsAdd', batch));
      batch = [];
      defined = new Set();
    };
    let failed = 0;
    for (const a of assignments) {
      const expr = parseExprIn(st, a.exprStart, a.exprEnd);
      const uses = fieldNames(expr);
      if ([...uses].some((u) => defined.has(u))) flush();
      try {
        const lowered = lowerExpr(expr, st);
        const target = st.field(a.name, a.nameSpan, true);
        batch.push(assign(target, lowered.e));
        st.setType(target, lowered.type === 'bool' ? 'boolean' : lowered.type === 'array' || lowered.type === 'unknown' ? undefined : lowered.type);
        defined.add(a.name);
      } catch (e) {
        if (!(e instanceof Untranslatable)) throw e;
        failed++;
        st.report(e.code, e.span, { detail: `${e.message} The assignment to "${a.name}" was left out.` });
        st.state.unresolved.add(a.name);
      }
    }
    flush();
    if (failed === assignments.length) {
      st.untranslated = true;
      st.out.length = 0;
      st.out.push({ name: '//', args: [], origin: [st.index], comment: `not translated: ${st.slice(st.span)}` });
    }
  },
};

interface Assignment {
  name: string;
  nameSpan: { start: number; end: number };
  exprStart: number;
  exprEnd: number;
}

/** Splits `a = x, b = y` at top-level commas. */
function splitAssignments(st: Stage): Assignment[] {
  const text = st.tc.text;
  const out: Assignment[] = [];
  let i = st.argsSpan.start;
  const end = st.argsSpan.end;
  while (i < end) {
    while (i < end && /[\s,]/.test(text[i] as string)) i++;
    if (i >= end) break;
    const nameMatch = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z_][A-Za-z0-9_.:{}@-]*)\s*=(?!=)/.exec(text.slice(i, Math.min(end, i + 300)));
    if (!nameMatch) throw new Untranslatable('SPL1003', { start: i, end: Math.min(end, i + 1) }, 'Expected "field = expression".');
    const rawName = nameMatch[1] as string;
    const name = /^["']/.test(rawName) ? rawName.slice(1, -1) : rawName;
    const nameSpan = { start: i, end: i + rawName.length };
    const exprStart = i + nameMatch[0].length;
    const exprEnd = topLevelComma(text, exprStart, end);
    out.push({ name, nameSpan, exprStart, exprEnd });
    i = exprEnd + 1;
  }
  return out;
}

function topLevelComma(text: string, start: number, end: number): number {
  let depth = 0;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1);
      i = close === -1 ? end : close;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return i;
  }
  return end;
}

function fieldNames(e: SExpr, out = new Set<string>()): Set<string> {
  if (e.t === 'field') out.add(e.name);
  else if (e.t === 'call') for (const a of e.args) fieldNames(a, out);
  else if (e.t === 'un') fieldNames(e.e, out);
  else if (e.t === 'bin') {
    fieldNames(e.l, out);
    fieldNames(e.r, out);
  } else if (e.t === 'in') {
    fieldNames(e.e, out);
    for (const a of e.list) fieldNames(a, out);
  }
  return out;
}

export const regex: CommandDef = {
  name: 'regex',
  tier: 'T2',
  summary: 'filter matchesPattern(field, "<pattern>") for the convertible regex subset.',
  lower(st) {
    const scan = st.scanner();
    let fieldName = '_raw';
    let negate = false;
    let fieldSpan = st.span;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(!=|=)\s*/.exec(st.slice(st.argsSpan));
    if (m) {
      fieldName = m[1] as string;
      negate = m[2] === '!=';
      fieldSpan = { start: st.argsSpan.start + m[0].indexOf(fieldName), end: st.argsSpan.start + m[0].indexOf(fieldName) + fieldName.length };
      scan.pos = st.argsSpan.start + m[0].length;
    }
    const q = scan.quoted() ?? scan.word();
    if (!q) throw new Untranslatable('SPL1003', st.span, 'regex needs a regular expression.');
    const conv = regexToDpl(q.value, { forMatch: true });
    if (!conv.ok) throw new Untranslatable('SPL2006', q.span, conv.reason);
    st.report('SPL3008', q.span);
    const test = call('matchesPattern', field(st.field(fieldName, fieldSpan)), dpl(conv.dpl));
    st.emit(cmd('filter', negate ? not(test) : test));
  },
};

/** Display-only commands: no effect on the data (SPL5007). */
function displayOnly(name: string): CommandDef {
  return {
    name,
    tier: 'T1',
    summary: 'Dropped: display only.',
    lower(st) {
      st.report('SPL5007', st.span, { detail: `${name} only changes how results are shown; it was dropped.` });
    },
  };
}

export const fieldformat = displayOnly('fieldformat');
export const highlight = displayOnly('highlight');
export const iconify = displayOnly('iconify');
export const abstractCmd = displayOnly('abstract');

/** `return f` / `return N f` (inside subsearches). */
export const returnCmd: CommandDef = {
  name: 'return',
  tier: 'T2',
  summary: 'fields f then limit N — only meaningful inside a subsearch.',
  lower(st) {
    const scan = st.scanner();
    const count = scan.integer()?.value ?? 1;
    const f = scan.fieldName();
    if (!f || f.value.startsWith('$') || !scan.atEnd()) {
      throw new Untranslatable('SPL2007', st.span, 'Only "return f" or "return N f" with one field can be translated.');
    }
    const F = st.field(f.value, f.span);
    st.emit(cmd('fields', field(F)));
    st.emit(cmd('limit', num(count)));
    st.setTable([F]);
  },
};
