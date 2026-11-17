/**
 * Reader for Splunk `.conf` files (savedsearches.conf, macros.conf, props.conf …). Pure text in,
 * stanzas out; no I/O. Linear in the size of the input.
 */

export interface ConfStanza {
  name: string;
  /** Keys in file order. A key written twice keeps its last value, as in Splunk. */
  values: Map<string, string>;
}

const MAX_STANZAS = 200_000;
const HEADER = /^\s*\[(.+)\]\s*$/;

/**
 * `key = value`: the key runs to the first `=` and is trimmed; one blank after the `=` is dropped and
 * the rest is the value as written. A key cannot start with `[` or `#`. A value holding a line
 * separator other than the one the text was split on (a lone CR, U+2028, U+2029) makes the line
 * unreadable, as before. Linear in the line length: no regular expression with adjacent blank runs.
 */
function readEntry(line: string): [key: string, value: string] | undefined {
  const body = line.trimStart();
  const eq = body.indexOf('=');
  if (eq <= 0 || body[0] === '[' || body[0] === '#') return undefined;
  let value = body.slice(eq + 1);
  if (/^\s/.test(value)) value = value.slice(1);
  if (/[\n\r\u2028\u2029]/.test(value)) return undefined;
  return [body.slice(0, eq).trim(), value];
}

/**
 * Parses `[stanza]` sections with `key = value` lines. A value ending in a backslash continues on
 * the next line (the backslash is dropped, the line break kept). Lines starting with `#` are
 * comments. Keys before the first header belong to `default`. Two stanzas with one name are merged.
 */
export function parseConf(text: string): ConfStanza[] {
  const out: ConfStanza[] = [];
  const byName = new Map<string, ConfStanza>();
  const open = (name: string): ConfStanza | undefined => {
    const existing = byName.get(name);
    if (existing) return existing;
    if (out.length >= MAX_STANZAS) return undefined;
    const stanza: ConfStanza = { name, values: new Map() };
    byName.set(name, stanza);
    out.push(stanza);
    return stanza;
  };
  let current: ConfStanza | undefined;
  let ignoring = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*#/.test(line)) continue;
    const head = HEADER.exec(line);
    if (head) {
      current = open((head[1] as string).trim());
      ignoring = current === undefined;
      continue;
    }
    const m = readEntry(line);
    if (!m) continue;
    const parts = [m[1]];
    while ((parts[parts.length - 1] as string).endsWith('\\') && i + 1 < lines.length) {
      parts[parts.length - 1] = (parts[parts.length - 1] as string).slice(0, -1);
      parts.push(lines[++i] as string);
    }
    if (ignoring) continue;
    current ??= open('default');
    current?.values.set(m[0], parts.join('\n').trim());
  }
  return out;
}

/** True for the values Splunk reads as "on": 1, true, t, yes, y (any case). */
export function confTrue(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|t|yes|y)$/i.test(value.trim());
}
