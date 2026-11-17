import { findToken } from '../dashboard/tokens.ts';
import { andAll, block, call, cmd, cmdOf, type DqlExpr, dir, field, named, num, variable } from '../dql/ast.ts';
import { type Stage, Untranslatable } from '../lower/context.ts';
import type { CommandDef } from './types.ts';

interface SortKey {
  expr: DqlExpr;
  desc: boolean;
  name?: string;
}

export const sort: CommandDef = {
  name: 'sort',
  tier: 'T1',
  summary: 'sort a asc, b desc; a count becomes a limit.',
  lower(st) {
    const scan = st.scanner();
    let count = scan.integer()?.value;
    const opt = scan.option();
    if (opt) {
      if (opt.name.toLowerCase() === 'limit' && /^\d+$/.test(opt.value)) count = Number(opt.value);
      else throw new Untranslatable('SPL2003', opt.span, `sort ${opt.name}= is not supported.`);
    }
    const keys: SortKey[] = [];
    let flipAll = false;
    for (;;) {
      if (scan.atEnd()) break;
      if (scan.eat(',')) continue;
      if (scan.keyword('desc') || scan.keyword('d')) {
        flipAll = true;
        continue;
      }
      let desc = false;
      if (scan.eat('-')) desc = true;
      else scan.eat('+');
      const fnMatch = /^(num|str|ip|auto)\s*\(/i.exec(st.tc.text.slice(scan.pos, scan.pos + 8));
      if (fnMatch) {
        const fn = (fnMatch[1] as string).toLowerCase();
        scan.pos += (fnMatch[0] as string).length - 1;
        const g = scan.balanced('(', ')');
        if (!g) throw new Untranslatable('SPL1003', scan.here(), `${fn}( is not closed.`);
        const name = st.slice(g.inner).trim();
        const F = field(st.field(name, g.inner));
        const expr = fn === 'num' ? call('toDouble', F) : fn === 'str' ? call('toString', F) : fn === 'ip' ? call('toIp', F) : F;
        keys.push({ expr, desc });
        continue;
      }
      const f = scan.fieldName();
      if (!f) throw new Untranslatable('SPL1003', scan.here(), 'Expected a field to sort by.');
      const F = st.field(f.value, f.span);
      if (st.fieldType(F) === undefined && st.state.schema.kind === 'events' && F !== 'timestamp') {
        st.report('SPL3006', f.span, {
          subject: `type:${F}`,
          detail: `"${f.value}" has no declared type; DQL sorts by the stored type, Splunk decides per value.`,
        });
      }
      keys.push({ expr: field(F), desc, name: F });
    }
    if (keys.length === 0) throw new Untranslatable('SPL1003', st.span, 'sort needs a field.');
    const exprs = keys.map((k) => dir(k.expr, k.desc !== flipAll ? 'desc' : 'asc'));
    st.emit(cmdOf('sort', exprs));
    if (count !== undefined && count > 0) st.emit(cmd('limit', num(count)));
    else if (count === undefined) st.report('SPL5006', st.span, { detail: 'Splunk sort returns at most 10,000 rows by default; DQL has no such limit here.' });
    st.state.sorted = true;
    st.state.lastSort = exprs;
    st.state.lastWasSort = true;
  },
};

/** The same sort keys in the opposite direction. */
function flip(keys: DqlExpr[]): DqlExpr[] {
  return keys.map((e) => (e.k === 'dir' ? dir(e.e, e.dir === 'asc' ? 'desc' : 'asc') : e));
}

function requireEventOrder(st: Stage): void {
  if (st.unorderedEvents) {
    st.emit(cmd('sort', dir(field('timestamp'), 'desc')));
    st.report('SPL5004', st.span);
    st.state.sorted = true;
  }
}

export const head: CommandDef = {
  name: 'head',
  tier: 'T1',
  summary: 'limit N (default 10); on raw events sorted newest first, as in Splunk.',
  lower(st) {
    // head $limit$ on a dashboard: the row count comes from a variable.
    const tok = /^\s*\$([A-Za-z_][A-Za-z0-9_.]*)\$\s*$/.exec(st.slice(st.argsSpan));
    const token = tok && st.tc.options.tokens ? findToken(st.tc.options.tokens, tok[1] as string) : undefined;
    if (token && token.kind !== 'time') {
      requireEventOrder(st);
      st.emit(cmd('limit', variable(token.variable, 'noquote')));
      return;
    }
    const scan = st.scanner();
    let n = scan.integer()?.value;
    const opt = scan.option();
    if (opt) {
      if (opt.name.toLowerCase() === 'limit' && /^\d+$/.test(opt.value)) n = Number(opt.value);
      else throw new Untranslatable('SPL2003', opt.span, `head ${opt.name}= cannot be translated.`);
    }
    if (!scan.atEnd()) throw new Untranslatable('SPL2003', st.span, 'head with an expression cannot be translated.');
    requireEventOrder(st);
    st.emit(cmd('limit', num(n ?? 10)));
  },
};

export const tail: CommandDef = {
  name: 'tail',
  tier: 'T2',
  summary: 'sort timestamp asc, limit N — on raw events only.',
  lower(st) {
    const n = st.scanner().integer()?.value ?? 10;
    if (st.prevWasSort && st.state.lastSort) {
      // The last N rows of a sorted result are the first N of the opposite sort, in Splunk's tail order.
      const flipped = flip(st.state.lastSort);
      st.emit(cmdOf('sort', flipped));
      st.emit(cmd('limit', num(n)));
      st.state.sorted = true;
      st.state.lastSort = flipped;
      st.state.lastWasSort = true;
      return;
    }
    if (st.state.schema.kind !== 'events') {
      throw new Untranslatable('SPL2010', st.span, 'tail after a transforming command depends on row order.');
    }
    st.report('SPL3004', st.span, { detail: 'tail returns the oldest events here; Splunk returns the last events of its own order.' });
    st.emit(cmd('sort', dir(field('timestamp'), 'asc')));
    st.emit(cmd('limit', num(n)));
    st.state.sorted = true;
  },
};

export const reverse: CommandDef = {
  name: 'reverse',
  tier: 'T2',
  summary: 'After sort: the opposite sort. On raw events: oldest first.',
  lower(st) {
    if (st.prevWasSort && st.state.lastSort) {
      const flipped = flip(st.state.lastSort);
      st.emit(cmdOf('sort', flipped));
      st.state.sorted = true;
      st.state.lastSort = flipped;
      st.state.lastWasSort = true;
      return;
    }
    if (st.state.schema.kind === 'events') {
      st.report('SPL3004', st.span, { detail: 'reverse is translated as "oldest first".' });
      const oldestFirst = [dir(field('timestamp'), 'asc')];
      st.emit(cmdOf('sort', oldestFirst));
      st.state.sorted = true;
      st.state.lastSort = oldestFirst;
      st.state.lastWasSort = true;
      return;
    }
    throw new Untranslatable('SPL2010', st.span, 'reverse here depends on row order.');
  },
};

export const dedup: CommandDef = {
  name: 'dedup',
  tier: 'T1',
  summary: 'dedup f, sort:{timestamp desc}; rows where f is empty are removed first, as in Splunk.',
  lower(st) {
    const scan = st.scanner();
    if (scan.integer()) throw new Untranslatable('SPL2003', st.span, 'dedup keeping more than one row per value cannot be translated.');
    let keepEmpty = false;
    const opts: { name: string; value: string; span: { start: number; end: number } }[] = [];
    const list: { name: string; span: { start: number; end: number } }[] = [];
    let sortBy: DqlExpr[] | undefined;
    while (!scan.atEnd()) {
      const o = scan.option();
      if (o) {
        opts.push(o);
        continue;
      }
      if (scan.keyword('sortby')) {
        sortBy = [];
        while (!scan.atEnd()) {
          if (scan.eat(',')) continue;
          let desc = false;
          if (scan.eat('-')) desc = true;
          else scan.eat('+');
          const f = scan.fieldName();
          if (!f) break;
          sortBy.push(dir(field(st.field(f.value, f.span)), desc ? 'desc' : 'asc'));
        }
        continue;
      }
      if (scan.eat(',')) continue;
      const f = scan.fieldName();
      if (!f) throw new Untranslatable('SPL1003', scan.here(), 'Expected a field.');
      list.push({ name: f.value, span: f.span });
    }
    for (const o of opts) {
      const key = o.name.toLowerCase();
      const on = /^(t|true|1)$/i.test(o.value);
      if (key === 'keepempty') keepEmpty = on;
      else if ((key === 'consecutive' || key === 'keepevents') && on) {
        throw new Untranslatable('SPL2003', o.span, `dedup ${key}=true cannot be translated.`);
      } else if (key !== 'consecutive' && key !== 'keepevents') {
        throw new Untranslatable('SPL2003', o.span, `dedup ${o.name}= cannot be translated.`);
      }
    }
    if (list.length === 0) throw new Untranslatable('SPL1003', st.span, 'dedup needs a field.');
    const names = list.map((f) => {
      if (f.name.includes('*')) throw new Untranslatable('SPL2009', f.span, 'dedup by a wildcard needs the list of fields.');
      return st.field(f.name, f.span);
    });
    if (keepEmpty) {
      st.report('SPL3002', st.span, { detail: 'With keepempty=true Splunk keeps every event with an empty field; DQL keeps one.' });
    } else {
      st.emit(cmd('filter', andAll(names.map((n) => call('isNotNull', field(n)))) as DqlExpr));
    }
    const args: (DqlExpr | ReturnType<typeof named>)[] = names.map(field);
    if (sortBy && sortBy.length > 0) args.push(named('sort', block(sortBy)));
    else if (st.state.schema.kind === 'events' && !st.state.sorted) args.push(named('sort', block([dir(field('timestamp'), 'desc')])));
    else if (st.state.schema.kind !== 'events')
      st.report('SPL3004', st.span, { detail: 'Which row is kept per value is not guaranteed after a transforming command.' });
    st.emit(cmdOf('dedup', args));
  },
};

export const uniq: CommandDef = {
  name: 'uniq',
  tier: 'T2',
  summary: 'dedup on all known fields.',
  lower(st) {
    if (st.state.schema.kind === 'events' || st.state.schema.fields.length === 0) {
      throw new Untranslatable('SPL2009', st.span, 'uniq needs to know all fields; use it after table or stats.');
    }
    st.emit(cmdOf('dedup', st.state.schema.fields.map(field)));
  },
};

export const orderCommands = [sort, head, tail, reverse, dedup, uniq];
