import { dict } from '../util/dict.ts';
/**
 * SPL time modifiers (earliest=, latest=, relative_time) → DQL time literals.
 * docs/spec/spl-dql-mapping.md §3.2.
 */

export type TimeValue =
  /** `dql` is valid after `from:`/`to:`. exact=false → SPL3015. */
  | { kind: 'relative'; dql: string; exact: boolean }
  | { kind: 'now' }
  | { kind: 'all' }
  /** ISO-8601 UTC string; fromText=true when converted from a calendar date (SPL3010). */
  | { kind: 'absolute'; iso: string; fromText: boolean }
  | { kind: 'realtime' }
  | { kind: 'invalid'; detail: string };

const UNIT: Readonly<Record<string, string>> = dict({
  s: 's',
  sec: 's',
  secs: 's',
  second: 's',
  seconds: 's',
  m: 'm',
  min: 'm',
  mins: 'm',
  minute: 'm',
  minutes: 'm',
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
  w: 'w',
  week: 'w',
  weeks: 'w',
  mon: 'M',
  month: 'M',
  months: 'M',
  q: 'q',
  qtr: 'q',
  qtrs: 'q',
  quarter: 'q',
  quarters: 'q',
  y: 'y',
  yr: 'y',
  yrs: 'y',
  year: 'y',
  years: 'y',
});

const SECONDS: Readonly<Record<string, number>> = dict({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 });

/** Converts a Splunk time unit name to its DQL letter, or undefined. */
export function dqlUnit(unit: string): string | undefined {
  return UNIT[unit.toLowerCase()] ?? (unit === 'M' ? 'M' : undefined);
}

function snapUnit(raw: string): string | undefined {
  const m = /^([A-Za-z]+)(\d?)$/.exec(raw);
  if (!m) return undefined;
  const base = (m[1] ?? '').toLowerCase();
  const digit = m[2] ?? '';
  if (base === 'w') {
    if (digit === '' || digit === '0' || digit === '7') return 'w0';
    return `w${digit}`;
  }
  if (digit !== '') return undefined;
  return UNIT[base];
}

/** Parses an SPL time modifier value. `timezone` converts calendar dates (UTC, ±hh:mm or IANA). */
export function parseTimeModifier(raw: string, timezone: string): TimeValue {
  const v = raw.trim().replace(/^"(.*)"$/s, '$1');
  if (v === '') return { kind: 'invalid', detail: 'The time modifier is empty.' };
  // Real modifiers are short; the cap also keeps every pattern below linear.
  if (v.length > 64) return { kind: 'invalid', detail: 'The time modifier is too long.' };
  if (/^now(\(\))?$/i.test(v)) return { kind: 'now' };
  if (v === '0') return { kind: 'all' };
  if (/^rt/i.test(v)) return { kind: 'realtime' };
  if (/^\d{1,11}(\.\d+)?$/.test(v)) {
    const secs = Math.floor(Number(v));
    return { kind: 'absolute', iso: isoSeconds(secs * 1000), fromText: false };
  }
  const cal = /^(\d{1,2})\/(\d{1,2})\/(\d{4}):(\d{1,2}):(\d{2}):(\d{2})$/.exec(v);
  if (cal) {
    const [, mo, d, y, h, mi, s] = cal.map(Number) as number[];
    const local = Date.UTC(y as number, (mo as number) - 1, d as number, h as number, mi as number, s as number);
    const check = new Date(local);
    if (check.getUTCMonth() !== (mo as number) - 1 || check.getUTCDate() !== d || (h as number) > 23 || (mi as number) > 59 || (s as number) > 59) {
      return { kind: 'invalid', detail: `"${v}" is not a valid date.` };
    }
    const offset = zoneOffsetMinutes(timezone, local);
    if (offset === undefined) return { kind: 'invalid', detail: `Unknown time zone "${timezone}".` };
    return { kind: 'absolute', iso: isoSeconds(local - offset * 60000), fromText: true };
  }
  return parseRelative(v);
}

function parseRelative(v: string): TimeValue {
  const m = /^((?:[+-]\d+[A-Za-z]*)*)(?:@([A-Za-z]+\d?))?((?:[+-]\d+[A-Za-z]*)*)$/.exec(v);
  if (!m) return { kind: 'invalid', detail: `"${v}" is not a time modifier the translator understands.` };
  const before = parseOffsets(m[1] ?? '');
  const after = parseOffsets(m[3] ?? '');
  if (!before || !after) return { kind: 'invalid', detail: `"${v}" uses an unknown time unit.` };
  let snap = '';
  if (m[2] !== undefined) {
    const s = snapUnit(m[2]);
    if (!s) return { kind: 'invalid', detail: `"@${m[2]}" is not a known snap unit.` };
    snap = `@${s}`;
  }
  const head = combine(before);
  if (head === undefined) return { kind: 'invalid', detail: `"${v}" mixes calendar and clock units.` };
  if (after.length > 0) {
    const tail = combine(after);
    if (tail === undefined) return { kind: 'invalid', detail: `"${v}" mixes calendar and clock units.` };
    const base = head === '' ? `now()${snap}` : `now()${head}${snap}`;
    return { kind: 'relative', dql: `${base}${tail}`, exact: false };
  }
  if (head === '' && snap === '') return { kind: 'invalid', detail: `"${v}" is not a time modifier.` };
  return { kind: 'relative', dql: `${head}${snap}`, exact: true };
}

interface Offset {
  sign: 1 | -1;
  n: number;
  unit: string;
}

function parseOffsets(s: string): Offset[] | undefined {
  const out: Offset[] = [];
  for (const part of s.matchAll(/([+-])(\d+)([A-Za-z]*)/g)) {
    const unit = part[3] === '' ? 's' : dqlUnit(part[3] ?? '');
    if (!unit) return undefined;
    out.push({ sign: part[1] === '-' ? -1 : 1, n: Number(part[2]), unit });
  }
  return out;
}

/** One offset stays as written; several fixed-length offsets are summed in seconds. */
function combine(offsets: Offset[]): string | undefined {
  if (offsets.length === 0) return '';
  if (offsets.length === 1) {
    const o = offsets[0] as Offset;
    return `${o.sign < 0 ? '-' : '+'}${o.n}${o.unit}`;
  }
  let total = 0;
  for (const o of offsets) {
    const secs = SECONDS[o.unit];
    if (secs === undefined) return undefined;
    total += o.sign * o.n * secs;
  }
  for (const [unit, secs] of [
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ] as const) {
    if (total % secs === 0) return `${total < 0 ? '-' : '+'}${Math.abs(total / secs)}${unit}`;
  }
  return `${total < 0 ? '-' : '+'}${Math.abs(total)}s`;
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

/** Offset of `zone` from UTC in minutes at the given UTC-ish instant, or undefined if unknown. */
export function zoneOffsetMinutes(zone: string, utcMs: number): number | undefined {
  if (zone === 'UTC' || zone === 'Z') return 0;
  const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (fixed) return (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3]));
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    // Two passes handle instants near a DST change.
    let guess = utcMs;
    for (let i = 0; i < 2; i++) {
      const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
      const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
      const offset = Math.round((asUtc - guess) / 60000);
      guess = utcMs - offset * 60000;
      if (i === 1) return offset;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
