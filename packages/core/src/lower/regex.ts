import { dict } from '../util/dict.ts';
/**
 * Regular expression → Dynatrace Pattern Language, for the deterministic subset in
 * docs/spec/spl-dql-mapping.md §7.1. Anything outside it is refused with a reason (SPL2006).
 */

export interface Capture {
  name: string;
  type: 'number' | 'string';
}

export type DplConversion = { ok: true; dpl: string; captures: Capture[]; anchoredStart: boolean } | { ok: false; reason: string };

export interface DplOptions {
  /** Pattern is used to test a whole value (regex command, match()): also pad the end. */
  forMatch?: boolean;
  /** Captures allowed (rex). Otherwise named groups are treated as plain groups. */
  captures?: boolean;
  /** The pattern is applied repeatedly with parseAll(), which finds matches anywhere: no leading DATA?. */
  everyMatch?: boolean;
}

type Item =
  | { k: 'lit'; text: string }
  /** A character group or class matcher. `word`: true when it only matches word characters, false when none. */
  | { k: 'class'; text: string; quant: string; word?: boolean }
  | { k: 'any'; plus: boolean }
  | { k: 'alts'; options: Item[][]; quant: string }
  | { k: 'group'; items: Item[]; quant: string }
  | { k: 'capture'; name: string; inner: string; items: Item[]; optional: boolean }
  | { k: 'look'; ahead: boolean; negative: boolean; items: Item[] }
  | { k: 'boundary' }
  | { k: 'eos' };

interface Ctx {
  captures: boolean;
  /** (?i): letters match in both cases. */
  ci: boolean;
  /** (?s): "." also matches a line break. */
  dotAll: boolean;
  /** Characters of DPL still allowed; shared by every copy of the context. */
  budget: { left: number };
}

/** Longest DPL written for one regex: the mapping file's own limit for an extraction (ADR-029). */
export const MAX_DPL = 10_000;
const TOO_LONG = `The regular expression would give a Dynatrace pattern longer than ${MAX_DPL} characters.`;

/** Counts characters as the pattern is written, so a long one is refused before it is built. */
function spend(ctx: Ctx, n: number): void {
  ctx.budget.left -= n;
  if (ctx.budget.left < 0) throw new Refuse(TOO_LONG);
}

class Refuse extends Error {}

const UNSUPPORTED_ESCAPES: Readonly<Record<string, string>> = dict({
  B: 'A non-boundary (\\B) has no Dynatrace pattern equivalent.',
  A: 'Anchors \\A, \\z, \\G and \\K are not supported.',
  z: 'Anchors \\A, \\z, \\G and \\K are not supported.',
  Z: 'Anchors \\A, \\z, \\G and \\K are not supported.',
  G: 'Anchors \\A, \\z, \\G and \\K are not supported.',
  K: 'Anchors \\A, \\z, \\G and \\K are not supported.',
  p: 'Unicode classes (\\p{…}) are not supported.',
  P: 'Unicode classes (\\P{…}) are not supported.',
  k: 'Back-references have no Dynatrace pattern equivalent.',
});

const CLASS_ESCAPES: Readonly<Record<string, { text: string; word?: boolean }>> = dict({
  d: { text: '[0-9]', word: true },
  w: { text: '[a-zA-Z0-9_]', word: true },
  s: { text: '[ \\t\\r\\n]', word: false },
  D: { text: '[^0-9]' },
  W: { text: '[^a-zA-Z0-9_]', word: false },
  S: { text: '[^ \\t\\r\\n]' },
  t: { text: '[\\t]', word: false },
  n: { text: '[\\n]', word: false },
  r: { text: '[\\r]', word: false },
});

/** Shorthands written inside a character group: `[\d.]` → `[0-9.]`. */
const IN_CLASS: Readonly<Record<string, string>> = dict({ d: '0-9', w: 'a-zA-Z0-9_', s: ' \\t\\r\\n', t: '\\t', n: '\\n', r: '\\r' });

const WORD_CLASS = '[a-zA-Z0-9_]';
const MAX_REGEX = 4000;
const MAX_UNROLL = 8;
/** Pattern items after `(…){n}` is written out (ADR-029); a larger pattern is refused. */
export const MAX_PATTERN_ITEMS = 2000;
const TOO_MANY_ITEMS = 'The regular expression is too large once its repeated groups are written out.';

export function regexToDpl(re: string, options: DplOptions = {}): DplConversion {
  if (re.length > MAX_REGEX) return { ok: false, reason: 'The regular expression is too long.' };
  try {
    let src = re;
    const ctx: Ctx = { captures: options.captures ?? false, ci: false, dotAll: false, budget: { left: MAX_DPL } };
    const flags = /^\(\?([a-zA-Z]+)\)/.exec(src);
    if (flags) {
      for (const f of flags[1] as string) {
        if (f === 'i') ctx.ci = true;
        else if (f === 's') ctx.dotAll = true;
        else throw new Refuse(`The inline flag (?${f}) is not supported; only (?i) and (?s) are.`);
      }
      src = src.slice(flags[0].length);
    }
    let anchoredStart = false;
    let anchoredEnd = false;
    if (src.startsWith('^')) {
      anchoredStart = true;
      src = src.slice(1);
    }
    if (src.endsWith('$') && !endsWithEscape(src)) {
      anchoredEnd = true;
      src = src.slice(0, -1);
    }
    const alternatives = splitTop(src);
    let items: Item[];
    if (alternatives.length > 1) {
      // a|b is the same as (?:a|b); an anchor would bind to one side only.
      if (anchoredStart || anchoredEnd) throw new Refuse('"^" or "$" together with alternatives (a|b) is not supported.');
      items = [{ k: 'alts', options: alternatives.map((a) => parseSeq(a, ctx, 1)), quant: '' }];
    } else {
      items = parseSeq(src, ctx, 0);
    }
    if (anchoredEnd) items.push({ k: 'eos' });
    if (weigh(items) > MAX_PATTERN_ITEMS) throw new Refuse(TOO_MANY_ITEMS);
    const captures: Capture[] = [];
    const parts = render(items, captures, ctx, { fixed: false, end: true });
    if (parts.length === 0) return { ok: false, reason: 'The pattern is empty.' };
    let dpl = parts.join(' ');
    if (!anchoredStart && !options.everyMatch) dpl = `DATA? ${dpl}`;
    if (options.forMatch && !anchoredEnd) dpl = `${dpl} DATA?`;
    if (dpl.length > MAX_DPL) throw new Refuse(TOO_LONG);
    return { ok: true, dpl, captures, anchoredStart };
  } catch (e) {
    // Anything else (a stack overflow on a pathological pattern included) is a refusal too:
    // one regex must never end a translation or an import (ADR-029).
    if (e instanceof Refuse) return { ok: false, reason: e.message };
    return { ok: false, reason: 'The regular expression could not be converted.' };
  }
}

/**
 * Number of pattern items, nested ones included, counting a written-out repeat once per copy.
 * Stops counting past the budget, so one call never walks more than MAX_PATTERN_ITEMS + 1 items.
 */
function weigh(items: readonly Item[]): number {
  let total = 0;
  const stack: (readonly Item[])[] = [items];
  while (stack.length > 0) {
    const list = stack.pop() as readonly Item[];
    for (const item of list) {
      total++;
      if (total > MAX_PATTERN_ITEMS) return total;
      if (item.k === 'group' || item.k === 'capture' || item.k === 'look') stack.push(item.items);
      else if (item.k === 'alts') for (const o of item.options) stack.push(o);
    }
  }
  return total;
}

/** True when the regex has no metacharacters, so it can be used as a literal string. */
export function regexLiteral(re: string): string | undefined {
  if (/[\\^$.|?*+()[\]{}]/.test(re.replace(/\\[./\-:=@#,"' ]/g, ''))) return undefined;
  return re.replace(/\\([./\-:=@#,"' ])/g, '$1');
}

function endsWithEscape(src: string): boolean {
  let slashes = 0;
  for (let i = src.length - 2; i >= 0 && src[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function parseSeq(src: string, ctx: Ctx, depth: number): Item[] {
  if (depth > 20) throw new Refuse('The regular expression is nested too deeply.');
  const items: Item[] = [];
  let lit = '';
  const flush = (): void => {
    if (lit !== '') items.push({ k: 'lit', text: lit });
    lit = '';
  };
  /** One literal character: under (?i) a letter becomes a two-letter group. */
  const char = (c: string, quant: string): void => {
    const folded = ctx.ci && /[A-Za-z]/.test(c);
    if (!folded && quant === '') {
      lit += c;
      return;
    }
    flush();
    checkQuant(quant);
    const text = folded ? `[${c.toLowerCase()}${c.toUpperCase()}]` : `[${classEscape(c)}]`;
    items.push({ k: 'class', text, quant, word: /[A-Za-z0-9_]/.test(c) });
  };
  const to = src.length;
  let i = 0;
  while (i < to) {
    const c = src[i] as string;
    if (c === '\\') {
      const e = src[i + 1];
      if (e === undefined) throw new Refuse('The regular expression ends with a backslash.');
      if (/[1-9]/.test(e)) throw new Refuse('Back-references have no Dynatrace pattern equivalent.');
      if (e === 'b') {
        flush();
        items.push({ k: 'boundary' });
        i += 2;
        continue;
      }
      const unsupported = UNSUPPORTED_ESCAPES[e];
      if (unsupported) throw new Refuse(unsupported);
      const q = readQuant(src, i + 2, to);
      const cls = CLASS_ESCAPES[e];
      if (cls) {
        flush();
        checkQuant(q);
        const item: Item = { k: 'class', text: cls.text, quant: q };
        if (cls.word !== undefined) item.word = cls.word;
        items.push(item);
      } else if (/[A-Za-z0-9]/.test(e)) {
        throw new Refuse(`The escape \\${e} is not supported.`);
      } else {
        char(e, q);
      }
      i += 2 + q.length;
      continue;
    }
    if (c === '[') {
      const end = classEnd(src, i, to);
      const q = readQuant(src, end + 1, to);
      flush();
      checkQuant(q);
      items.push({ k: 'class', text: normaliseClass(src.slice(i, end + 1), ctx.ci), quant: q });
      i = end + 1 + q.length;
      continue;
    }
    if (c === '.') {
      const q = readQuant(src, i + 1, to);
      flush();
      if (q === '*' || q === '*?') items.push({ k: 'any', plus: false });
      else if (q === '+' || q === '+?') items.push({ k: 'any', plus: true });
      else throw new Refuse('A single "." (any character) is only supported as ".*" or ".+".');
      i += 1 + q.length;
      continue;
    }
    if (c === '(') {
      flush();
      const end = groupEnd(src, i, to);
      const q = readQuant(src, end + 1, to);
      for (const item of parseGroup(src.slice(i + 1, end), q, ctx, depth)) items.push(item);
      i = end + 1 + q.length;
      continue;
    }
    if (c === '|') throw new Refuse('Alternatives must stand alone in the pattern or inside a group.');
    if (c === '^' || c === '$') throw new Refuse(`"${c}" is only supported at the start or end of the pattern.`);
    if ('*+?{'.includes(c)) {
      if (c === '{' && !/^\{\d+(,\d*)?\}/.test(src.slice(i, to))) {
        lit += c;
        i++;
        continue;
      }
      throw new Refuse('A quantifier must follow something to repeat.');
    }
    if (c === ')' || c === ']') throw new Refuse(`Unbalanced "${c}".`);
    const q = readQuant(src, i + 1, to);
    char(c, q);
    i += 1 + q.length;
  }
  flush();
  return items;
}

/** The body of a group: a sequence, or alternatives of sequences. */
function parseBody(body: string, ctx: Ctx, depth: number): Item[] {
  const options = splitTop(body);
  if (options.length === 1) return parseSeq(body, ctx, depth + 1);
  return [{ k: 'alts', options: options.map((o) => parseSeq(o, ctx, depth + 1)), quant: '' }];
}

function parseGroup(inner: string, quant: string, ctx: Ctx, depth: number): Item[] {
  let body = inner;
  let name: string | undefined;
  if (inner.startsWith('?')) {
    const named = /^\?(?:P?<([A-Za-z_][A-Za-z0-9_]*)>|'([A-Za-z_][A-Za-z0-9_]*)')/.exec(inner);
    const look = /^\?(<?)([=!])/.exec(inner);
    if (named) {
      name = named[1] ?? named[2];
      body = inner.slice(named[0].length);
    } else if (inner.startsWith('?:')) {
      body = inner.slice(2);
    } else if (look) {
      if (quant !== '') throw new Refuse('A look-around cannot be repeated.');
      const items = parseBody(inner.slice(look[0].length), { ...ctx, captures: false }, depth);
      return [{ k: 'look', ahead: look[1] === '', negative: look[2] === '!', items }];
    } else if (/^\?[a-zA-Z-]+[:)]/.test(inner)) {
      throw new Refuse('Inline flags are only supported as (?i) or (?s) at the start of the pattern.');
    } else {
      throw new Refuse('This group type is not supported.');
    }
  }
  if (name !== undefined && ctx.captures) {
    if (quant !== '' && quant !== '?') throw new Refuse('A repeated capture group is not supported.');
    if (/\(\?(?:P?<[A-Za-z_]|')/.test(body)) throw new Refuse('Nested capture groups are not supported.');
    return [{ k: 'capture', name, inner: body, items: parseBody(body, ctx, depth), optional: quant === '?' }];
  }
  const items = parseBody(body, ctx, depth);
  const single = items.length === 1 ? items[0] : undefined;
  if (quant === '' || quant === '?') {
    return single?.k === 'alts' ? [{ ...single, quant }] : [{ k: 'group', items, quant }];
  }
  // DPL groups take no quantifier; a fixed count is written out.
  const fixed = /^\{(\d+)\}$/.exec(quant);
  const count = fixed ? Number(fixed[1]) : 0;
  if (!fixed || count < 1 || count > MAX_UNROLL) throw new Refuse('A repeated group cannot be converted, except for a fixed count such as (…){3}.');
  if (weigh(items) * count > MAX_PATTERN_ITEMS) throw new Refuse(TOO_MANY_ITEMS);
  const out: Item[] = [];
  for (let n = 0; n < count; n++) for (const item of items) out.push(item);
  return out;
}

/** What comes after the items being rendered: something fixed to stop at, or the end of the pattern. */
interface After {
  fixed: boolean;
  end: boolean;
}

function render(items: Item[], captures: Capture[], ctx: Ctx, after: After): string[] {
  const parts: string[] = [];
  items.forEach((item, idx) => {
    const last = idx === items.length - 1;
    const next = items[idx + 1];
    const here: After = last ? after : { fixed: isFixed(next), end: false };
    // What this item writes itself; nested items count their own when they are rendered.
    spend(ctx, 1 + ownLength(item));
    switch (item.k) {
      case 'lit':
        parts.push(dplLiteral(item.text));
        break;
      case 'class':
        parts.push(`${item.text}${item.quant}`);
        break;
      case 'any':
        if (here.end) {
          // Trailing .* needs nothing: parse does not have to consume the whole input.
          if (item.plus) parts.push('DATA');
          break;
        }
        if (!here.fixed) throw new Refuse('".*" must be followed by fixed text to be converted.');
        parts.push(ctx.dotAll ? 'DATA' : 'LD');
        break;
      case 'alts':
        parts.push(`${renderAlts(item.options, captures, ctx)}${item.quant}`);
        break;
      case 'group':
        parts.push(`(${renderInner(item.items, captures, ctx, item.quant === '' ? here : { fixed: false, end: false })})${item.quant}`);
        break;
      case 'capture':
        parts.push(renderCapture(item, captures, ctx, here));
        break;
      case 'look': {
        const inner = render(item.items, captures, ctx, { fixed: false, end: false });
        if (inner.length === 0) throw new Refuse('An empty look-around cannot be converted.');
        const body = inner.length === 1 && item.items[0]?.k !== 'alts' ? (inner[0] as string) : `(${inner.join(' ')})`;
        parts.push(`${item.negative ? '!' : ''}${item.ahead ? '>>' : '<<'}${body}`);
        break;
      }
      case 'boundary':
        parts.push(renderBoundary(items[idx - 1], next));
        break;
      case 'eos':
        parts.push('EOS');
        break;
    }
  });
  return parts;
}

/** Characters an item writes besides what its nested items write (an upper bound for wrappers). */
function ownLength(item: Item): number {
  switch (item.k) {
    case 'lit': {
      // Quoted, with a backslash before every backslash and quote (dplLiteral).
      let n = item.text.length + 2;
      for (const c of item.text) if (c === '\\' || c === "'") n++;
      return n;
    }
    case 'class':
      return item.text.length + item.quant.length;
    case 'alts':
      return 2 + item.quant.length + 5 * item.options.length;
    case 'group':
      return 2 + item.quant.length;
    case 'capture':
      return 12 + item.name.length;
    case 'look':
      return 5;
    case 'boundary':
      return 16;
    default:
      return 4;
  }
}

function renderInner(items: Item[], captures: Capture[], ctx: Ctx, after: After): string {
  const parts = render(items, captures, ctx, after);
  if (parts.length === 0) throw new Refuse('An empty group cannot be converted.');
  return parts.join(' ');
}

function renderAlts(options: Item[][], captures: Capture[], ctx: Ctx): string {
  const rendered = options.map((o) => {
    const parts = render(o, captures, ctx, { fixed: false, end: false });
    if (parts.length === 0) throw new Refuse('An empty alternative (a|) cannot be converted.');
    return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' ')})`;
  });
  return `(${rendered.join(' | ')})`;
}

/**
 * \b before a word needs "no word character behind"; after a word, "no word character ahead". Both
 * are look-arounds in DPL. Anything else (a boundary next to a class of unknown content) is refused.
 */
function renderBoundary(prev: Item | undefined, next: Item | undefined): string {
  const startsWord = wordEdge(next, true);
  const endsWord = wordEdge(prev, false);
  if (startsWord === true && endsWord !== true) return `!<<${WORD_CLASS}`;
  if (endsWord === true && startsWord !== true) return `!>>${WORD_CLASS}`;
  throw new Refuse('A word boundary (\\b) is only supported directly before or after a word.');
}

/** Whether an item starts (or ends) with a word character; undefined when it is not known. */
function wordEdge(item: Item | undefined, start: boolean): boolean | undefined {
  if (!item || item.k === 'eos') return false;
  if (item.k === 'lit') return /[A-Za-z0-9_]/.test(start ? (item.text[0] as string) : (item.text[item.text.length - 1] as string));
  if (item.k === 'class') return item.word;
  return undefined;
}

function renderCapture(item: Extract<Item, { k: 'capture' }>, captures: Capture[], ctx: Ctx, after: After): string {
  const name = exportName(item.name);
  const inner = item.inner;
  const opt = item.optional ? '?' : '';
  const add = (type: Capture['type']): void => {
    captures.push({ name: item.name, type });
  };
  if (inner === '\\d+') {
    add('number');
    return `LONG${opt}:${name}`;
  }
  if (/^-\?\\d\+\\\.\\d\+$/.test(inner) || inner === '\\d+\\.\\d+') {
    add('number');
    return `DOUBLE${opt}:${name}`;
  }
  if (inner === '\\S+') {
    add('string');
    return `NSPACE${opt}:${name}`;
  }
  if (/^\.[*+]\??$/.test(inner)) {
    add('string');
    if (after.end) return `DATA${opt}:${name}`;
    if (!after.fixed) throw new Refuse(`The capture "${item.name}" (.*) must be followed by fixed text.`);
    return `${ctx.dotAll ? 'DATA' : 'LD'}${opt}:${name}`;
  }
  add('string');
  const only = item.items.length === 1 ? item.items[0] : undefined;
  // One character group with a quantifier, e.g. [^,]+ or \w+ : export it directly.
  if (only?.k === 'class') return `${only.text}${only.quant}${opt}:${name}`;
  if (only?.k === 'alts' && only.quant === '') return `${renderAlts(only.options, captures, ctx)}${opt}:${name}`;
  // Anything longer is a sequence group; DPL exports the text it matched as a string.
  if (item.items.some((i) => i.k === 'any') && item.items[item.items.length - 1]?.k !== 'any') {
    throw new Refuse(`The capture "${item.name}" has ".*" in the middle, which cannot be converted.`);
  }
  return `(${renderInner(item.items, captures, ctx, item.optional ? { fixed: false, end: false } : after)})${opt}:${name}`;
}

function isFixed(item: Item | undefined): boolean {
  if (!item) return false;
  if (item.k === 'lit') return true;
  if (item.k === 'class') return item.quant === '' || item.quant === '+' || /^\{[1-9]/.test(item.quant);
  if (item.k === 'alts') return item.quant === '';
  if (item.k === 'group') return item.quant === '' && isFixed(item.items[0]);
  if (item.k === 'capture') return !item.optional && !/^\.[*]/.test(item.inner) && (item.items.length === 0 || isFixed(item.items[0]));
  if (item.k === 'look') return item.ahead && !item.negative;
  return item.k === 'eos';
}

function exportName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? name : `'${name}'`;
}

/** A DPL literal: quoted, with a backslash before every backslash and quote. */
export function dplLiteral(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function classEscape(c: string): string {
  return /[\]\\^-]/.test(c) ? `\\${c}` : c;
}

/**
 * Rewrites a regex character class for DPL: shorthands are spelled out (`\d` → `0-9`), needless
 * escapes dropped, and under (?i) every letter and letter range gets its other case.
 */
function normaliseClass(cls: string, ci: boolean): string {
  let i = 1;
  let out = '[';
  if (cls[i] === '^') {
    out += '^';
    i++;
  }
  const end = cls.length - 1;
  let extra = '';
  while (i < end) {
    let ch = cls[i] as string;
    let piece: string;
    if (ch === '\\') {
      const e = cls[i + 1] ?? '';
      i += 2;
      const short = IN_CLASS[e];
      if (short !== undefined) {
        out += short;
        continue;
      }
      if (/[A-Za-z0-9]/.test(e)) throw new Refuse(`The escape \\${e} inside a character class is not supported.`);
      ch = e;
      piece = /[\]\\^[-]/.test(e) ? `\\${e}` : e;
    } else {
      i++;
      piece = ch;
    }
    // A range such as a-z: keep it, and add A-Z under (?i).
    const hi = cls[i + 1];
    if (cls[i] === '-' && i + 1 < end && hi !== undefined && hi !== '\\') {
      out += `${piece}-${hi}`;
      if (ci && /[a-z]/.test(ch) && /[a-z]/.test(hi)) extra += `${ch.toUpperCase()}-${hi.toUpperCase()}`;
      else if (ci && /[A-Z]/.test(ch) && /[A-Z]/.test(hi)) extra += `${ch.toLowerCase()}-${hi.toLowerCase()}`;
      i += 2;
      continue;
    }
    out += piece;
    if (ci && /[A-Za-z]/.test(ch)) extra += ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
  }
  return `${out}${extra}]`;
}

function readQuant(src: string, i: number, to: number): string {
  const rest = src.slice(i, Math.min(to, i + 16));
  const m = /^([*+?]|\{\d+(?:,\d*)?\})(\?|\+)?/.exec(rest);
  if (!m) return '';
  if (m[2] === '+') throw new Refuse('Possessive quantifiers are not supported.');
  return m[0];
}

function checkQuant(q: string): void {
  if (q.endsWith('?') && q.length > 1) throw new Refuse('Lazy quantifiers are only supported on ".".');
}

function classEnd(src: string, start: number, to: number): number {
  let i = start + 1;
  if (src[i] === '^') i++;
  if (src[i] === ']') i++;
  for (; i < to; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '[') {
      if (src[i + 1] === ':') throw new Refuse('POSIX character classes ([:alpha:]) are not supported.');
      throw new Refuse('Nested character classes are not supported.');
    }
    if (src[i] === ']') return i;
  }
  throw new Refuse('A character class "[" is not closed.');
}

function groupEnd(src: string, start: number, to: number): number {
  let depth = 0;
  for (let i = start; i < to; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      i = classEnd(src, i, to);
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Refuse('A group "(" is not closed.');
}

/** Splits at "|" outside groups and character classes. */
function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c === '\\') {
      cur += c + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '[') {
      // A "|" inside a character class is a plain character.
      let end = i + 1;
      if (body[end] === '^') end++;
      if (body[end] === ']') end++;
      while (end < body.length && body[end] !== ']') end += body[end] === '\\' ? 2 : 1;
      cur += body.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '|' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}
