import { assign, call, cmd, dpl, field, named, num, str } from '../dql/ast.ts';
import { Untranslatable } from '../lower/context.ts';
import { splunkPathToJsonPath } from '../lower/expr.ts';
import { regexLiteral, regexToDpl } from '../lower/regex.ts';
import type { CommandDef } from './types.ts';

export const rex: CommandDef = {
  name: 'rex',
  tier: 'T2',
  summary: 'parse field, "<pattern>" for the convertible regex subset; mode=sed → replaceString/replacePattern.',
  lower(st) {
    const scan = st.scanner();
    let fieldName = '_raw';
    let fieldSpan = st.span;
    let sed = false;
    let maxMatch = 1;
    let regex: { value: string; span: { start: number; end: number } } | undefined;
    while (!scan.atEnd()) {
      const o = scan.option();
      if (o) {
        const key = o.name.toLowerCase();
        if (key === 'field') {
          fieldName = o.value;
          fieldSpan = o.valueSpan;
        } else if (key === 'mode' && o.value.toLowerCase() === 'sed') {
          sed = true;
        } else if (key === 'max_match' && /^\d{1,6}$/.test(o.value)) {
          maxMatch = Number(o.value);
        } else {
          throw new Untranslatable('SPL2003', o.span, `rex ${o.name}=${o.value} cannot be translated.`);
        }
        continue;
      }
      const q = scan.quoted();
      if (!q || regex) throw new Untranslatable('SPL1003', scan.here(), 'rex needs one quoted regular expression.');
      regex = q;
    }
    if (!regex) throw new Untranslatable('SPL1003', st.span, 'rex needs a quoted regular expression.');
    const F = st.field(fieldName, fieldSpan);

    if (sed) {
      const m = /^s\/((?:\\.|[^/\\])*)\/((?:\\.|[^/\\])*)\/([gi0-9]*)$/.exec(regex.value);
      if (!m) throw new Untranslatable('SPL2003', regex.span, 'Only s/regex/replacement/ sed expressions can be translated.');
      const [, pattern, replacement, flags] = m as unknown as [string, string, string, string];
      if (/\\\d/.test(replacement)) throw new Untranslatable('SPL2006', regex.span, 'Back-references in the replacement have no DQL equivalent.');
      if (!flags.includes('g')) st.report('SPL3008', regex.span, { detail: 'Without the g flag sed replaces the first match only; DQL replaces every match.' });
      const rep = replacement.replace(/\\\//g, '/');
      const lit = regexLiteral(pattern.replace(/\\\//g, '/'));
      if (lit !== undefined) {
        st.emit(cmd('fieldsAdd', assign(F, call('replaceString', field(F), str(lit), str(rep)))));
        return;
      }
      const conv = regexToDpl(pattern.replace(/\\\//g, '/'), {});
      if (!conv.ok) throw new Untranslatable('SPL2006', regex.span, conv.reason);
      st.report('SPL3008', regex.span);
      const body = conv.dpl.startsWith('DATA? ') ? conv.dpl.slice(6) : conv.dpl;
      st.emit(cmd('fieldsAdd', assign(F, call('replacePattern', field(F), dpl(body), str(rep)))));
      return;
    }

    const conv = regexToDpl(regex.value, maxMatch === 1 ? { captures: true } : { captures: true, everyMatch: true });
    if (!conv.ok) {
      // Fields this rex would create are unknown from here on (spl-dql-mapping.md §7.3).
      for (const m of regex.value.matchAll(/\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/g)) st.state.unresolved.add(m[1] as string);
      throw new Untranslatable('SPL2006', regex.span, conv.reason);
    }
    if (conv.captures.length === 0) throw new Untranslatable('SPL2003', regex.span, 'rex without named groups (?<name>…) extracts nothing.');
    if (maxMatch !== 1) {
      // Every match (max_match=0) or the first N: parseAll returns them as an array.
      const only = conv.captures[0];
      if (conv.captures.length !== 1 || !only || conv.anchoredStart) {
        for (const c of conv.captures) st.state.unresolved.add(c.name);
        throw new Untranslatable('SPL2003', regex.span, 'rex max_match is only translated for one named group and a pattern without "^".');
      }
      st.report('SPL3008', regex.span);
      st.report('SPL3013', st.span, { detail: 'The matches are returned as an array, not as a Splunk multivalue field.' });
      const all = call('parseAll', field(F), dpl(conv.dpl));
      const T = st.field(only.name, regex.span, true);
      st.emit(cmd('fieldsAdd', assign(T, maxMatch === 0 ? all : call('arraySlice', all, named('from', num(0)), named('to', num(maxMatch))))));
      st.setType(T, undefined);
      st.addFields([only.name]);
      return;
    }
    st.report('SPL3008', regex.span);
    st.emit(cmd('parse', field(F), dpl(conv.dpl)));
    for (const c of conv.captures) st.setType(st.field(c.name, regex.span, true), c.type === 'number' ? 'number' : 'string');
    st.addFields(conv.captures.map((c) => c.name));
  },
};

export const spath: CommandDef = {
  name: 'spath',
  tier: 'T2',
  summary: 'jsonPath() for one path; without a path, parse content as JSON and flatten.',
  lower(st) {
    const scan = st.scanner();
    let input = '_raw';
    let path: string | undefined;
    let output: string | undefined;
    while (!scan.atEnd()) {
      const o = scan.option();
      if (o) {
        const key = o.name.toLowerCase();
        if (key === 'input') input = o.value;
        else if (key === 'path') path = o.value;
        else if (key === 'output') output = o.value;
        else throw new Untranslatable('SPL2003', o.span, `spath ${o.name}= cannot be translated.`);
        continue;
      }
      const w = scan.value();
      if (!w || path !== undefined) throw new Untranslatable('SPL1003', scan.here(), 'Unexpected text in spath.');
      path = w.value;
    }
    const F = field(st.field(input, st.span));
    if (path === undefined) {
      st.report('SPL3016', st.span, { detail: 'JSON fields get Grail names (json.a.b) instead of Splunk names (a.b{}.c).' });
      st.emit(cmd('parse', F, dpl('JSON:json')));
      st.emit(cmd('fieldsFlatten', field('json')));
      return;
    }
    if (path.includes('{}')) st.report('SPL3013', st.span, { detail: 'An array path returns an array in DQL.' });
    const target = st.field(output ?? path, st.span, true);
    st.emit(cmd('fieldsAdd', assign(target, call('jsonPath', F, str(splunkPathToJsonPath(path))))));
    st.addFields([target]);
  },
};

export const extractCommands = [rex, spath];
