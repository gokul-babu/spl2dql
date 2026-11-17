import { assign, block, call, cmd, type DqlArg, field, ident, named, str, sub } from '../dql/ast.ts';
import { type Stage, Untranslatable } from '../lower/context.ts';
import { lowerLaterSearch } from '../lower/search.ts';
import { parseSearch, SearchError } from '../spl/search.ts';
import type { Span } from '../types.ts';
import type { CommandDef } from './types.ts';

function lookupPath(st: Stage, name: string, span: Span): { path: string; columns?: readonly string[]; key?: string } {
  const m = st.mapping.lookups.get(name);
  if (m) return m;
  st.report('SPL4005', span, {
    subject: name,
    detail: `Lookup "${name}" has no entry in the mapping file; a placeholder path /lookups/${safeName(name)} is used.`,
  });
  return { path: `/lookups/${safeName(name)}` };
}

function safeName(name: string): string {
  return name.replace(/\.csv$/i, '').replace(/[^A-Za-z0-9_.-]/g, '_') || 'lookup';
}

const load = (path: string) => cmd('load', str(path));

export const lookup: CommandDef = {
  name: 'lookup',
  tier: 'T2',
  summary: 'lookup [load "<path>"], sourceField:, lookupField:, fields:{…}.',
  lower(st) {
    const scan = st.scanner();
    while (scan.option()) {
      // local=, update=, event_time_field= have no effect on the translation
    }
    const table = scan.word();
    if (!table) throw new Untranslatable('SPL1003', st.span, 'lookup needs a table name.');
    const keys: { lookupField: string; local: string; span: Span }[] = [];
    while (!scan.atEnd() && !scan.peekKeyword('output') && !scan.peekKeyword('outputnew')) {
      if (scan.eat(',')) continue;
      const f = scan.fieldName();
      if (!f) throw new Untranslatable('SPL1003', scan.here(), 'Expected a lookup field.');
      let local = f.value;
      if (scan.keyword('as')) local = scan.fieldName()?.value ?? local;
      keys.push({ lookupField: f.value, local, span: f.span });
    }
    if (keys.length === 0) throw new Untranslatable('SPL1003', st.span, 'lookup needs a field to match on.');
    const outputs: { col: string; as: string }[] = [];
    const outputNew = scan.keyword('outputnew');
    if (outputNew || scan.keyword('output')) {
      while (!scan.atEnd()) {
        if (scan.eat(',')) continue;
        const c = scan.fieldName();
        if (!c) throw new Untranslatable('SPL1003', scan.here(), 'Expected an output field.');
        let as = c.value;
        if (scan.keyword('as')) as = scan.fieldName()?.value ?? as;
        outputs.push({ col: c.value, as });
      }
    }
    const t = lookupPath(st, table.value, table.span);
    st.report('SPL3013', st.span, { detail: 'If several rows match, Splunk returns all values; DQL takes one row.' });
    if (keys.length > 1) {
      // Several keys: a left-outer join on all of them.
      const on = keys.map((k) => (k.local === k.lookupField ? field(st.field(k.local, k.span)) : field(st.field(k.local, k.span))));
      const fieldsArg = outputs.length > 0 ? [named('fields', block(outputs.map((o) => (o.as === o.col ? field(o.col) : assign(o.as, field(o.col))))))] : [];
      st.emit(cmd('join', sub([{ ...load(t.path), origin: [st.index] }]), named('on', block(on)), named('kind', ident('leftOuter')), ...fieldsArg));
      if (outputs.length === 0) st.report('SPL3016', st.span, { detail: 'Lookup columns arrive with the prefix "right.".' });
      for (const o of outputs) st.field(o.as, st.span, true);
      return;
    }
    const key = keys[0] as { lookupField: string; local: string; span: Span };
    const args: DqlArg[] = [named('sourceField', field(st.field(key.local, key.span))), named('lookupField', field(t.key ?? key.lookupField))];
    let cols = outputs;
    if (cols.length === 0) {
      if (t.columns) cols = t.columns.filter((c) => c !== (t.key ?? key.lookupField)).map((c) => ({ col: c, as: c }));
      else
        st.report('SPL3016', st.span, {
          detail: 'Without OUTPUT, lookup columns arrive as lookup.<column>; list the columns in the mapping file to keep their names.',
        });
    }
    const tmp = (c: string): string => `_new_${c.replace(/[^A-Za-z0-9_]/g, '_')}`;
    if (cols.length > 0) {
      args.push(
        named('fields', block(cols.map((o) => (outputNew ? assign(tmp(o.as), field(o.col)) : o.as === o.col ? field(o.col) : assign(o.as, field(o.col)))))),
      );
    }
    st.emit({ name: 'lookup', args: [{ kind: 'pos', value: sub([{ ...load(t.path), origin: [st.index] }]) }, ...args] });
    if (outputNew && cols.length > 0) {
      st.emit(cmd('fieldsAdd', ...cols.map((o) => assign(o.as, call('coalesce', field(o.as), field(tmp(o.as)))))));
      st.emit(cmd('fieldsRemove', ...cols.map((o) => field(tmp(o.as)))));
    }
    for (const o of cols) st.field(o.as, st.span, true);
    st.addFields(cols.map((c) => c.as));
  },
};

export const inputlookup: CommandDef = {
  name: 'inputlookup',
  tier: 'T2',
  summary: 'load "<path>" then filter.',
  generating: true,
  lower(st) {
    const scan = st.scanner();
    let append = false;
    for (let o = scan.option(); o; o = scan.option()) {
      if (o.name.toLowerCase() === 'append' && /^(t|true|1)$/i.test(o.value)) append = true;
      else if (o.name.toLowerCase() !== 'append') throw new Untranslatable('SPL2003', o.span, `inputlookup ${o.name}= cannot be translated.`);
    }
    const table = scan.word();
    if (!table) throw new Untranslatable('SPL1003', st.span, 'inputlookup needs a table name.');
    const t = lookupPath(st, table.value, table.span);
    let where: ReturnType<typeof parseSearch>;
    if (scan.keyword('where')) {
      const rest = scan.rest();
      try {
        where = parseSearch(st.tc.text, rest.start, rest.end);
      } catch (e) {
        if (e instanceof SearchError) throw new Untranslatable('SPL1001', e.span, e.message);
        throw e;
      }
    } else if (!scan.atEnd()) {
      throw new Untranslatable('SPL1003', scan.here(), 'Unexpected text in inputlookup.');
    }
    if (append) {
      if (where) throw new Untranslatable('SPL2003', st.span, 'inputlookup append=t with where cannot be translated.');
      st.emit(cmd('append', sub([{ ...load(t.path), origin: [st.index] }])));
      return;
    }
    st.emit(load(t.path));
    st.setTable(t.columns ? [...t.columns] : []);
    st.state.schema = { kind: 'table', fields: t.columns ? [...t.columns] : [] };
    if (where) lowerLaterSearch(st, where);
  },
};

function subsearch(st: Stage, open: { inner: Span; span: Span }) {
  const result = st.tc.lowerSub(open.inner, st);
  if (result.incomplete) throw new Untranslatable('SPL2007', open.span, 'The subsearch contains a step that could not be translated.');
  return result;
}

export const join: CommandDef = {
  name: 'join',
  tier: 'T2',
  summary: 'join [sub], on:{keys}, kind:inner|leftOuter, fields:{…}.',
  lower(st) {
    const scan = st.scanner();
    let kind = 'inner';
    const keys: { name: string; span: Span }[] = [];
    while (scan.peek() !== '[' && !scan.atEnd()) {
      const o = scan.option();
      if (o) {
        const key = o.name.toLowerCase();
        if (key === 'type') {
          const v = o.value.toLowerCase();
          if (v === 'inner') kind = 'inner';
          else if (v === 'left' || v === 'outer') kind = 'leftOuter';
          else throw new Untranslatable('SPL2003', o.span, `join type=${o.value} cannot be translated.`);
        } else if (key === 'max' && o.value === '0') {
          continue;
        } else if (key === 'left' || key === 'right' || key === 'where') {
          throw new Untranslatable('SPL2003', o.span, 'join with left=/right= aliases cannot be translated.');
        } else {
          st.report('SPL2003', o.span, { detail: `join ${o.name}= has no DQL equivalent and was ignored.` });
        }
        continue;
      }
      if (scan.eat(',')) continue;
      const f = scan.fieldName();
      if (!f) throw new Untranslatable('SPL1003', scan.here(), 'Expected join fields.');
      keys.push({ name: f.value, span: f.span });
    }
    const open = scan.balanced('[', ']');
    if (!open) throw new Untranslatable('SPL1003', st.span, 'join needs a subsearch in [ … ].');
    if (keys.length === 0) throw new Untranslatable('SPL2003', st.span, 'join without fields cannot be translated.');
    const names = keys.map((k) => st.field(k.name, k.span));
    const result = subsearch(st, open);
    st.report('SPL3009', st.span, { detail: 'Splunk join keeps one matching row by default (max=1); DQL keeps every match.' });
    const args: DqlArg[] = [{ kind: 'pos', value: sub(result.commands) }, named('on', block(names.map(field))), named('kind', ident(kind))];
    const outputs = result.outputFields?.filter((f) => !names.includes(f));
    if (outputs && outputs.length > 0) {
      args.push(named('fields', block(outputs.map(field))));
      for (const o of outputs) st.field(o, st.span, true);
      st.addFields(outputs);
    } else {
      st.report('SPL3016', st.span, { detail: 'The subsearch fields are not known here, so they arrive with the prefix "right.".' });
    }
    st.emit({ name: 'join', args });
  },
};

export const append: CommandDef = {
  name: 'append',
  tier: 'T1',
  summary: 'append [sub].',
  lower(st) {
    const scan = st.scanner();
    while (scan.option()) {
      // extendtimerange, maxtime, maxout: not reproduced
    }
    const open = scan.balanced('[', ']');
    if (!open) throw new Untranslatable('SPL1003', st.span, 'append needs a subsearch in [ … ].');
    const result = subsearch(st, open);
    st.emit(cmd('append', sub(result.commands)));
    if (result.outputFields) st.addFields(result.outputFields);
  },
};

function unionLike(name: string): CommandDef {
  return {
    name,
    tier: 'T2',
    summary: 'First subsearch, then append [the others].',
    generating: true,
    lower(st) {
      const scan = st.scanner();
      while (scan.option()) {
        // options are not reproduced
      }
      const subs: { inner: Span; span: Span }[] = [];
      for (let b = scan.balanced('[', ']'); b; b = scan.balanced('[', ']')) subs.push(b);
      if (subs.length === 0 || !scan.atEnd()) throw new Untranslatable('SPL1003', st.span, `${name} needs subsearches in [ … ].`);
      st.report('SPL3004', st.span, { detail: 'Results are appended one after the other, not interleaved by time.' });
      const parts = subs.map((s) => subsearch(st, s).commands);
      const startsPipeline = st.first && st.upstream.length === 0;
      const rest = startsPipeline ? parts.slice(1) : parts;
      if (startsPipeline) for (const c of parts[0] ?? []) st.out.push({ ...c, origin: [st.index] });
      for (const p of rest) st.emit(cmd('append', sub(p)));
    },
  };
}

export const union = unionLike('union');
export const multisearch = unionLike('multisearch');

export const combineCommands: CommandDef[] = [lookup, inputlookup, join, append, union, multisearch];
