import type { Span } from '../types.ts';

export interface RawStage {
  /** Span of the stage text, trimmed, excluding the separating pipe. */
  span: Span;
  /** True when the stage starts the query with an explicit leading pipe (generating command). */
  leadingPipe: boolean;
}

export interface SplitResult {
  stages: RawStage[];
  /** First problem found (unterminated quote, unbalanced bracket), if any. */
  problem?: { span: Span; detail: string };
}

const WS = /\s/;

/**
 * Splits SPL text into pipeline stages at top-level `|` characters. Quotes, `[…]` subsearches,
 * `(…)` groups, backtick macros and triple-backtick comments are respected. Runs in linear time.
 */
export function splitStages(text: string, from = 0, to = text.length): SplitResult {
  const stages: RawStage[] = [];
  let problem: SplitResult['problem'];
  const stack: { ch: string; pos: number }[] = [];
  let stageStart = from;
  let leadingPipe = false;
  let i = from;

  // A query may start with a pipe: "| inputlookup x".
  let j = from;
  while (j < to && WS.test(text[j] ?? '')) j++;
  if (text[j] === '|') {
    leadingPipe = true;
    stageStart = j + 1;
    i = j + 1;
  }

  const push = (end: number): void => {
    const span = trim(text, stageStart, end);
    stages.push({ span, leadingPipe: stages.length === 0 && leadingPipe });
  };

  while (i < to) {
    const ch = text[i];
    if (ch === '`' && text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3);
      if (close === -1 || close >= to) {
        problem ??= { span: { start: i, end: to }, detail: 'A comment opened with ``` is not closed.' };
        i = to;
        break;
      }
      i = close + 3;
      continue;
    }
    if (ch === '"') {
      const close = findQuoteEnd(text, i, to);
      if (close === -1) {
        problem ??= { span: { start: i, end: to }, detail: 'A quoted string is not closed.' };
        i = to;
        break;
      }
      i = close + 1;
      continue;
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1 || close >= to) {
        problem ??= { span: { start: i, end: to }, detail: 'A macro call opened with ` is not closed.' };
        i = to;
        break;
      }
      i = close + 1;
      continue;
    }
    if (ch === '[' || ch === '(') {
      stack.push({ ch, pos: i });
    } else if (ch === ']' || ch === ')') {
      const want = ch === ']' ? '[' : '(';
      const top = stack[stack.length - 1];
      if (top?.ch === want) {
        stack.pop();
      } else {
        problem ??= { span: { start: i, end: i + 1 }, detail: `Unexpected "${ch}".` };
      }
    } else if (ch === '|' && stack.length === 0) {
      push(i);
      stageStart = i + 1;
    }
    i++;
  }
  const open = stack[stack.length - 1];
  if (open && !problem) {
    problem = { span: { start: open.pos, end: to }, detail: `"${open.ch}" is not closed.` };
  }
  push(to);
  return problem ? { stages, problem } : { stages };
}

/** Index of the closing double quote for the quote at `start`, or -1. Backslash escapes the next char. */
export function findQuoteEnd(text: string, start: number, to = text.length): number {
  for (let i = start + 1; i < to; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"') return i;
  }
  return -1;
}

export function trim(text: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s < e && WS.test(text[s] ?? '')) s++;
  while (e > s && WS.test(text[e - 1] ?? '')) e--;
  // Skip leading SPL comments inside a stage.
  while (text.startsWith('```', s)) {
    const close = text.indexOf('```', s + 3);
    if (close === -1 || close + 3 > e) break;
    s = close + 3;
    while (s < e && WS.test(text[s] ?? '')) s++;
  }
  return { start: s, end: e };
}
