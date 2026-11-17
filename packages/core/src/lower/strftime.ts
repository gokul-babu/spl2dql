import { dict } from '../util/dict.ts';

/** Splunk strftime directives → DQL/Java format letters (docs/spec/spl-dql-mapping.md §6.4). */
const MAP: Readonly<Record<string, string>> = dict({
  Y: 'yyyy',
  y: 'yy',
  m: 'MM',
  d: 'dd',
  e: 'd',
  H: 'HH',
  I: 'hh',
  M: 'mm',
  S: 'ss',
  p: 'a',
  b: 'MMM',
  B: 'MMMM',
  a: 'EEE',
  A: 'EEEE',
  j: 'DDD',
  F: 'yyyy-MM-dd',
  T: 'HH:mm:ss',
  z: 'Z',
  Z: 'z',
  Q: 'SSS',
});

export type FormatConversion = { ok: true; format: string } | { ok: false; directive: string };

export function strftimeToDql(fmt: string): FormatConversion {
  let out = '';
  let literal = '';
  const flush = (): void => {
    if (literal === '') return;
    // Letters must be quoted in Java patterns; quote any run that contains one.
    out += /[A-Za-z']/.test(literal) ? `'${literal.replace(/'/g, "''")}'` : literal;
    literal = '';
  };
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i] as string;
    if (c !== '%') {
      literal += c;
      continue;
    }
    const next = fmt[i + 1];
    if (next === '%') {
      literal += '%';
      i++;
      continue;
    }
    if (next === '3' && fmt[i + 2] === 'N') {
      flush();
      out += 'SSS';
      i += 2;
      continue;
    }
    const mapped = next === undefined ? undefined : MAP[next];
    if (!mapped) return { ok: false, directive: `%${next ?? ''}` };
    flush();
    out += mapped;
    i++;
  }
  flush();
  return { ok: true, format: out };
}
