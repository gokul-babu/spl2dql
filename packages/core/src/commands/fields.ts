import { assign, bin, block, call, cmd, cmdOf, type DqlExpr, field, named, num, str } from '../dql/ast.ts';
import { MAX_FOREACH } from '../limits.ts';
import { type Stage, Untranslatable } from '../lower/context.ts';
import { lowerExpr } from '../lower/expr.ts';
import { wildcardMatch } from '../lower/search.ts';
import { strftimeToDql } from '../lower/strftime.ts';
import { ExprError, parseExpr, type SExpr } from '../spl/expr.ts';
import type { Scanner } from '../spl/scanner.ts';
import type { Span } from '../types.ts';
import { append } from '../util/array.ts';
import type { CommandDef } from './types.ts';

interface FieldRef {
  name: string;
  span: Span;
}

/** Reads a comma/space separated field list until the end or a stop keyword. */
export function readFieldList(scan: Scanner, stop: readonly string[] = []): FieldRef[] {
  const out: FieldRef[] = [];
  for (;;) {
    if (scan.atEnd()) break;
    if (stop.some((w) => scan.peekKeyword(w))) break;
    if (scan.eat(',')) continue;
    // A trailing option (span=1h, limit=5) ends the list.
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.test(scan.text.slice(scan.pos, Math.min(scan.end, scan.pos + 80)))) break;
    const f = scan.fieldName();
    if (!f) throw new Untranslatable('SPL1003', scan.here(), 'Expected a field name.');
    out.push({ name: f.value, span: f.span });
  }
  return out;
}

/** Field names in a known table schema matching a wildcard, or undefined when unknown. */
function expandWildcard(st: Stage, pattern: string): string[] | undefined {
  if (st.state.schema.kind === 'events') return undefined;
  return st.state.schema.fields.filter((f) => wildcardMatch(pattern, st.splName(f)));
}

export const table: CommandDef = {
  name: 'table',
  tier: 'T1',
  summary: 'fields a, b (wildcards → fieldsKeep "a*").',
  lower(st) {
    const list = readFieldList(st.scanner());
    if (list.length === 0) throw new Untranslatable('SPL1003', st.span, 'table needs at least one field.');
    const plain: string[] = [];
    let wildcard = false;
    for (const f of list) {
      if (f.name.includes('*')) {
        const expanded = expandWildcard(st, f.name);
        if (expanded) append(plain, expanded);
        else wildcard = true;
      } else {
        plain.push(st.field(f.name, f.span));
      }
    }
    if (wildcard) {
      st.report('SPL2009', st.span, { detail: 'Wildcards keep matching fields, but the column order of table is not reproduced.' });
      st.emit(
        cmdOf(
          'fieldsKeep',
          list.map((f) => (f.name.includes('*') ? str(f.name) : field(st.field(f.name, f.span)))),
        ),
      );
      st.setTable(plain);
      return;
    }
    st.emit(cmdOf('fields', plain.map(field)));
    st.setTable(plain);
  },
};

export const fields: CommandDef = {
  name: 'fields',
  tier: 'T1',
  summary: 'fieldsKeep / fieldsRemove; on raw events timestamp and content are kept, as Splunk keeps _time and _raw.',
  lower(st) {
    const scan = st.scanner();
    let remove = false;
    if (scan.eat('-')) remove = true;
    else scan.eat('+');
    const list = readFieldList(scan);
    if (list.length === 0) throw new Untranslatable('SPL1003', st.span, 'fields needs at least one field.');
    if (remove) {
      if (list.some((f) => f.name.startsWith('_') && f.name.includes('*'))) {
        st.report('SPL2009', st.span, { detail: 'Removing internal fields (_*) has no direct equivalent; they were kept.' });
      }
      const names = list.filter((f) => !(f.name.startsWith('_') && f.name.includes('*')));
      if (names.length === 0) return;
      st.emit(
        cmdOf(
          'fieldsRemove',
          names.map((f) => (f.name.includes('*') ? str(f.name) : field(st.field(f.name, f.span)))),
        ),
      );
      if (st.state.schema.kind !== 'events') {
        const gone = new Set(names.map((f) => st.field(f.name, f.span, true)));
        st.setTable(st.state.schema.fields.filter((f) => !gone.has(f) && !names.some((n) => n.name.includes('*') && wildcardMatch(n.name, st.splName(f)))));
      }
      return;
    }
    const keep: DqlExpr[] = [];
    const names: string[] = [];
    for (const f of list) {
      if (f.name.includes('*')) {
        keep.push(str(f.name));
        continue;
      }
      const F = st.field(f.name, f.span);
      keep.push(field(F));
      names.push(F);
    }
    if (st.state.schema.kind === 'events') {
      for (const internal of ['timestamp', 'content']) {
        if (!names.includes(internal)) keep.push(field(internal));
      }
    }
    st.emit(cmdOf('fieldsKeep', keep));
    if (list.every((f) => !f.name.includes('*'))) {
      st.setTable(st.state.schema.kind === 'events' ? [...names, 'timestamp', 'content'] : names);
    }
  },
};

export const rename: CommandDef = {
  name: 'rename',
  tier: 'T1',
  summary: 'fieldsRename new = old.',
  lower(st) {
    // `rename Authentication.* as *` after a data-model search: the dataset prefix is never carried
    // into DQL, so there is nothing left to rename.
    if (st.state.datamodel && /^\s*"?[A-Za-z_][A-Za-z0-9_.]*"?\.\*\s+as\s+\*\s*$/i.test(st.slice(st.argsSpan))) {
      st.report('SPL5007', st.span, { detail: 'The data-model prefix is not carried into DQL, so this rename has nothing to do.' });
      return;
    }
    const scan = st.scanner();
    const pairs: DqlExpr[] = [];
    const renames: [string, string][] = [];
    let same = 0;
    for (;;) {
      if (scan.atEnd()) break;
      if (scan.eat(',')) continue;
      const from = scan.fieldName();
      if (!from || !scan.keyword('as')) throw new Untranslatable('SPL1003', scan.here(), 'Expected "field AS newname".');
      const to = scan.fieldName();
      if (!to) throw new Untranslatable('SPL1003', scan.here(), 'Expected a new name after AS.');
      if (from.value.includes('*') || to.value.includes('*')) {
        throw new Untranslatable('SPL2009', from.span, 'Renaming with wildcards needs the list of fields.');
      }
      const F = st.field(from.value, from.span);
      const T = st.field(to.value, to.span, true);
      // The two names can be one field in Grail (a data-model prefix, or a mapping): nothing to do.
      if (F === T) {
        same++;
        continue;
      }
      pairs.push(assign(T, field(F)));
      renames.push([F, T]);
    }
    if (pairs.length === 0 && same > 0) return;
    if (pairs.length === 0) throw new Untranslatable('SPL1003', st.span, 'rename needs "field AS newname".');
    st.emit(cmdOf('fieldsRename', pairs));
    if (st.state.schema.kind !== 'events') {
      st.setTable(st.state.schema.fields.map((f) => renames.find(([a]) => a === f)?.[1] ?? f));
    }
  },
};

function literalValue(v: { value: string; quoted: boolean }): DqlExpr {
  return !v.quoted && /^-?\d+(\.\d+)?$/.test(v.value) ? num(v.value) : str(v.value);
}

export const fillnull: CommandDef = {
  name: 'fillnull',
  tier: 'T1',
  summary: 'fieldsAdd f = coalesce(f, value).',
  lower(st) {
    const scan = st.scanner();
    let value: DqlExpr = num(0);
    const opt = scan.option();
    if (opt) {
      if (opt.name.toLowerCase() !== 'value') throw new Untranslatable('SPL2003', opt.span, `Option ${opt.name} is not supported.`);
      value = literalValue(opt);
    }
    const list = readFieldList(scan);
    let names = list.map((f) => (f.name.includes('*') ? undefined : st.field(f.name, f.span)));
    if (list.length === 0 || names.includes(undefined)) {
      const known = st.state.schema.kind === 'events' ? undefined : st.state.schema.fields;
      if (!known) throw new Untranslatable('SPL2009', st.span, 'fillnull without a field list needs the list of fields.');
      names = list.length === 0 ? known : known.filter((k) => list.some((f) => wildcardMatch(f.name, st.splName(k))));
    }
    const out = (names as string[]).map((F) => assign(F, call('coalesce', field(F), value)));
    if (out.length > 0) st.emit(cmdOf('fieldsAdd', out));
  },
};

const MAX_REPLACE_PAIRS = 500;

export const replace: CommandDef = {
  name: 'replace',
  tier: 'T1',
  summary: 'fieldsAdd f = if(f == "x", "y", else: f).',
  lower(st) {
    const scan = st.scanner();
    const pairs: [{ value: string; quoted: boolean }, { value: string; quoted: boolean }][] = [];
    for (;;) {
      if (scan.peekKeyword('in')) break;
      if (scan.eat(',')) continue;
      const from = scan.value();
      if (!from || !scan.keyword('with')) throw new Untranslatable('SPL1003', scan.here(), 'Expected "value WITH replacement".');
      const to = scan.value();
      if (!to) throw new Untranslatable('SPL1003', scan.here(), 'Expected a replacement after WITH.');
      if (from.value.includes('*') || to.value.includes('*')) {
        throw new Untranslatable('SPL2009', from.span, 'Wildcard replacements are not supported.');
      }
      pairs.push([from, to]);
    }
    if (!scan.keyword('in')) throw new Untranslatable('SPL2003', st.span, 'replace without IN <fields> needs the list of fields.');
    // Each pair nests one if() inside the next; past this many the query is too deep to write.
    if (pairs.length > MAX_REPLACE_PAIRS) {
      throw new Untranslatable('SPL1006', st.span, `replace has more than ${MAX_REPLACE_PAIRS} value pairs; translate it in parts.`);
    }
    const list = readFieldList(scan);
    const out: DqlExpr[] = [];
    for (const f of list) {
      if (f.name.includes('*')) throw new Untranslatable('SPL2009', f.span, 'Wildcard field names need the list of fields.');
      const F = st.field(f.name, f.span);
      let e: DqlExpr = field(F);
      for (let i = pairs.length - 1; i >= 0; i--) {
        const [a, b] = pairs[i] as [{ value: string; quoted: boolean }, { value: string; quoted: boolean }];
        e = call('if', bin('==', field(F), str(a.value)), str(b.value), named('else', e));
      }
      out.push(assign(F, e));
    }
    st.emit(cmdOf('fieldsAdd', out));
  },
};

export const convert: CommandDef = {
  name: 'convert',
  tier: 'T2',
  summary: 'ctime() → formatTimestamp, num()/auto() → toDouble.',
  lower(st) {
    const scan = st.scanner();
    let format = 'MM/dd/yyyy HH:mm:ss';
    const out: DqlExpr[] = [];
    for (;;) {
      if (scan.atEnd()) break;
      if (scan.eat(',')) continue;
      const opt = scan.option();
      if (opt) {
        if (opt.name.toLowerCase() !== 'timeformat') throw new Untranslatable('SPL2003', opt.span, `Option ${opt.name} is not supported.`);
        const conv = strftimeToDql(opt.value);
        if (!conv.ok) throw new Untranslatable('SPL2003', opt.valueSpan, `The format directive ${conv.directive} has no DQL equivalent.`);
        format = conv.format;
        continue;
      }
      const fn = scan.word('(');
      const group = scan.balanced('(', ')');
      if (!fn || !group) throw new Untranslatable('SPL1003', scan.here(), 'Expected a conversion such as ctime(field).');
      const src = st.slice(group.inner).trim();
      let target = src;
      if (scan.keyword('as')) {
        const t = scan.fieldName();
        if (!t) throw new Untranslatable('SPL1003', scan.here(), 'Expected a name after AS.');
        target = t.value;
      }
      const srcName = st.field(src, group.inner);
      const F = field(srcName);
      const isTime = st.fieldType(srcName) === 'time';
      const T = st.field(target, group.inner, true);
      switch (fn.value.toLowerCase()) {
        case 'ctime':
          st.report('SPL3010', fn.span);
          out.push(assign(T, call('formatTimestamp', isTime ? F : call('timestampFromUnixSeconds', call('toLong', F)), named('format', str(format)))));
          st.setType(T, 'string');
          break;
        case 'num':
        case 'auto':
          out.push(assign(T, call('toDouble', F)));
          st.setType(T, 'number');
          break;
        case 'none':
          break;
        default:
          throw new Untranslatable('SPL2003', fn.span, `convert ${fn.value}() has no DQL equivalent.`);
      }
    }
    if (out.length > 0) st.emit(cmdOf('fieldsAdd', out));
  },
};

export const addtotals: CommandDef = {
  name: 'addtotals',
  tier: 'T2',
  summary: 'fieldsAdd Total = coalesce(a, 0) + coalesce(b, 0) for listed fields.',
  lower(st) {
    const scan = st.scanner();
    let name = 'Total';
    for (let opt = scan.option(); opt; opt = scan.option()) {
      const key = opt.name.toLowerCase();
      if (key === 'fieldname') name = opt.value;
      else if (key === 'row' && /^(t|true|1)$/i.test(opt.value)) continue;
      else if (key === 'col' && /^(f|false|0)$/i.test(opt.value)) continue;
      else throw new Untranslatable('SPL2003', opt.span, `addtotals ${opt.name}=${opt.value} has no DQL equivalent.`);
    }
    const list = readFieldList(scan);
    if (list.length === 0 || list.some((f) => f.name.includes('*'))) {
      throw new Untranslatable('SPL2009', st.span, 'addtotals needs an explicit list of fields to sum.');
    }
    const sum = list
      .map((f) => call('coalesce', field(st.field(f.name, f.span)), num(0)))
      .reduce<DqlExpr | undefined>((acc, e) => (acc ? bin('+', acc, e) : e), undefined) as DqlExpr;
    st.emit(cmd('fieldsAdd', assign(st.field(name, st.span, true), sum)));
    st.addFields([name]);
  },
};

export const foreach: CommandDef = {
  name: 'foreach',
  tier: 'T2',
  summary: 'Expands the template for each listed field into fieldsAdd.',
  lower(st) {
    const scan = st.scanner();
    while (scan.option()) {
      // fieldstr/matchstr options are not needed for plain templates.
    }
    const list: { name: string; span: Span }[] = [];
    while (scan.peek() !== '[' && !scan.atEnd()) {
      if (scan.eat(',')) continue;
      const f = scan.fieldName();
      if (!f) throw new Untranslatable('SPL1003', scan.here(), 'Expected field names before the [ … ] template.');
      list.push({ name: f.value, span: f.span });
    }
    const tpl = scan.balanced('[', ']');
    if (!tpl || list.length === 0) throw new Untranslatable('SPL1003', st.span, 'foreach needs fields and a [ eval … ] template.');
    const body = st.slice(tpl.inner).trim();
    const m = /^eval\s+(.+)$/is.exec(body);
    if (!m) throw new Untranslatable('SPL2003', tpl.span, 'Only an eval template can be translated.');
    const targets: { field: string; match: string }[] = [];
    for (const f of list) {
      if (!f.name.includes('*')) {
        targets.push({ field: f.name, match: f.name });
        continue;
      }
      const known = expandWildcard(st, f.name);
      if (!known) throw new Untranslatable('SPL2009', f.span, 'foreach with a wildcard needs the list of fields.');
      const [pre, post] = [f.name.split('*')[0] ?? '', f.name.split('*').slice(-1)[0] ?? ''];
      for (const k of known) {
        const name = st.splName(k);
        targets.push({ field: name, match: name.slice(pre.length, name.length - post.length) });
      }
    }
    const out: DqlExpr[] = [];
    const template = m[1] as string;
    // Every field gets its own copy of the template: refuse before building them all (ADR-029).
    if (targets.length * template.length > MAX_FOREACH) {
      throw new Untranslatable(
        'SPL1006',
        st.span,
        `foreach would write its template ${targets.length} times (${targets.length * template.length} characters); the limit is ${MAX_FOREACH}.`,
      );
    }
    for (const t of targets) {
      const text = template.split('<<FIELD>>').join(t.field).split('<<MATCHSTR>>').join(t.match);
      const eq = /^\s*([A-Za-z_][A-Za-z0-9_.]*|'[^']*')\s*=(?!=)([\s\S]+)$/.exec(text);
      if (!eq) throw new Untranslatable('SPL1003', tpl.span, 'The template must be "field = expression".');
      const target = (eq[1] as string).replace(/^'|'$/g, '');
      // Parse the substituted expression from its own string; spans then point at the template.
      let expr: SExpr;
      try {
        expr = parseExpr(text, text.length - (eq[2] as string).length, text.length);
      } catch (e) {
        if (e instanceof ExprError) throw new Untranslatable('SPL1004', tpl.span, e.message);
        throw e;
      }
      out.push(assign(st.field(target, tpl.span, true), lowerExpr(retarget(expr, tpl.span), st).e));
    }
    st.emit(cmdOf('fieldsAdd', out));
  },
};

/** Moves every span of an expression parsed from substituted text onto the template's span. */
function retarget<T>(node: T, span: Span): T {
  if (Array.isArray(node)) return node.map((n) => retarget(n, span)) as T;
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === 'span' || k === 'fnSpan' ? span : retarget(v, span);
    return out as T;
  }
  return node;
}

export const makemv: CommandDef = {
  name: 'makemv',
  tier: 'T1',
  summary: 'fieldsAdd f = splitString(f, delim).',
  lower(st) {
    const scan = st.scanner();
    let delim = ' ';
    for (let opt = scan.option(); opt; opt = scan.option()) {
      const key = opt.name.toLowerCase();
      if (key === 'delim') delim = opt.value;
      else if (key === 'allowempty' || key === 'setsv') continue;
      else throw new Untranslatable('SPL2003', opt.span, `makemv ${opt.name}= has no DQL equivalent.`);
    }
    const f = scan.fieldName();
    if (!f) throw new Untranslatable('SPL1003', st.span, 'makemv needs a field.');
    const F = st.field(f.value, f.span);
    st.emit(cmd('fieldsAdd', assign(F, call('splitString', field(F), str(delim)))));
  },
};

export const mvexpand: CommandDef = {
  name: 'mvexpand',
  tier: 'T1',
  summary: 'expand f.',
  lower(st) {
    const scan = st.scanner();
    const f = scan.fieldName();
    if (!f) throw new Untranslatable('SPL1003', st.span, 'mvexpand needs a field.');
    const opt = scan.option();
    const F = field(st.field(f.value, f.span));
    if (opt && opt.name.toLowerCase() === 'limit' && /^\d+$/.test(opt.value)) st.emit(cmd('expand', F, named('limit', num(opt.value))));
    else if (opt) throw new Untranslatable('SPL2003', opt.span, `mvexpand ${opt.name}= is not supported.`);
    else st.emit(cmd('expand', F));
  },
};

export const nomv: CommandDef = {
  name: 'nomv',
  tier: 'T1',
  summary: 'fieldsAdd f = arrayToString(f, delimiter: "\\n").',
  lower(st) {
    const f = st.scanner().fieldName();
    if (!f) throw new Untranslatable('SPL1003', st.span, 'nomv needs a field.');
    const F = st.field(f.value, f.span);
    st.emit(cmd('fieldsAdd', assign(F, call('arrayToString', field(F), named('delimiter', str('\n'))))));
  },
};

export const mvcombine: CommandDef = {
  name: 'mvcombine',
  tier: 'T2',
  summary: 'summarize f = collectArray(f), by:{other fields}.',
  lower(st) {
    const scan = st.scanner();
    const opt = scan.option();
    if (opt && opt.name.toLowerCase() !== 'delim') throw new Untranslatable('SPL2003', opt.span, `mvcombine ${opt.name}= is not supported.`);
    const f = scan.fieldName();
    if (!f) throw new Untranslatable('SPL1003', st.span, 'mvcombine needs a field.');
    if (st.state.schema.kind === 'events')
      throw new Untranslatable('SPL2009', st.span, 'mvcombine needs to know the other fields; use it after table or stats.');
    const F = st.field(f.value, f.span);
    const others = st.state.schema.fields.filter((x) => x !== F);
    st.report('SPL3004', st.span, { detail: 'The order of the combined values is not guaranteed.' });
    st.emit(cmd('summarize', assign(F, call('collectArray', field(F))), named('by', block(others.map(field)))));
    st.setTable([...others, F]);
  },
};

export const rangemap: CommandDef = {
  name: 'rangemap',
  tier: 'T2',
  summary: 'fieldsAdd range = if(...) for numeric ranges.',
  lower(st) {
    const scan = st.scanner();
    let src: string | undefined;
    let dflt: DqlExpr | undefined;
    const ranges: { name: string; lo: string; hi: string }[] = [];
    for (let opt = scan.option(); opt; opt = scan.option()) {
      if (opt.name === 'field') src = opt.value;
      else if (opt.name === 'default') dflt = str(opt.value);
      else {
        const m = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(opt.value);
        if (!m) throw new Untranslatable('SPL2003', opt.span, `Range "${opt.value}" is not a numeric range.`);
        ranges.push({ name: opt.name, lo: m[1] as string, hi: m[2] as string });
      }
    }
    if (!src || ranges.length === 0) throw new Untranslatable('SPL1003', st.span, 'rangemap needs field= and at least one range.');
    const F = field(st.field(src, st.span));
    let e: DqlExpr = dflt ?? str('None');
    for (let i = ranges.length - 1; i >= 0; i--) {
      const r = ranges[i] as { name: string; lo: string; hi: string };
      e = call('if', bin('and', bin('>=', F, num(r.lo)), bin('<=', F, num(r.hi))), str(r.name), named('else', e));
    }
    st.emit(cmd('fieldsAdd', assign(st.field('range', st.span, true), e)));
  },
};

export const fieldsCommands = [table, fields, rename, fillnull, replace, convert, addtotals, foreach, makemv, mvexpand, nomv, mvcombine, rangemap];
