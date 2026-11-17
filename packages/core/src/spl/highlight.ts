import { splitStages } from './split.ts';

export type SplTokenType = 'command' | 'keyword' | 'string' | 'number' | 'operator' | 'pipe' | 'function' | 'option' | 'comment' | 'macro' | 'bracket';

export interface SplToken {
  from: number;
  to: number;
  type: SplTokenType;
}

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'XOR', 'AS', 'BY', 'OVER', 'IN', 'WITH', 'OUTPUT', 'OUTPUTNEW', 'WHERE', 'LIKE']);

/**
 * Tokens for syntax highlighting in the editor. It uses the same stage splitter as the translator, so
 * command names are coloured exactly where the translator sees them. Linear time; never throws.
 */
export function highlightSpl(text: string): SplToken[] {
  const out: SplToken[] = [];
  const { stages } = splitStages(text);
  stages.forEach((stage, i) => {
    const s = stage.span.start;
    if (s > 0) {
      const pipe = text.lastIndexOf('|', s);
      if (pipe !== -1 && pipe < s) out.push({ from: pipe, to: pipe + 1, type: 'pipe' });
    }
    const implicit = i === 0 && !stage.leadingPipe;
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(s, Math.min(stage.span.end, s + 64)));
    let pos = s;
    if (m && (!implicit || m[0].toLowerCase() === 'search')) {
      out.push({ from: s, to: s + m[0].length, type: 'command' });
      pos = s + m[0].length;
    }
    scanArgs(text, pos, stage.span.end, out);
  });
  return out;
}

function scanArgs(text: string, start: number, end: number, out: SplToken[]): void {
  let i = start;
  while (i < end) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '`' && text.startsWith('```', i)) {
      const close = text.indexOf('```', i + 3);
      const e = close === -1 || close + 3 > end ? end : close + 3;
      out.push({ from: i, to: e, type: 'comment' });
      i = e;
      continue;
    }
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      const e = close === -1 || close >= end ? end : close + 1;
      out.push({ from: i, to: e, type: 'macro' });
      i = e;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < end && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const e = Math.min(end, j + 1);
      out.push({ from: i, to: e, type: 'string' });
      i = e;
      continue;
    }
    if (c === '[' || c === ']') {
      out.push({ from: i, to: i + 1, type: 'bracket' });
      i++;
      continue;
    }
    if (c === '|') {
      out.push({ from: i, to: i + 1, type: 'pipe' });
      i++;
      continue;
    }
    if (/[0-9]/.test(c) && !/[A-Za-z0-9_]/.test(text[i - 1] ?? '')) {
      const m = /^\d+(\.\d+)?[a-z]*/i.exec(text.slice(i, Math.min(end, i + 32)));
      const len = m ? m[0].length : 1;
      out.push({ from: i, to: i + len, type: 'number' });
      i += len;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text.slice(i, Math.min(end, i + 256)));
      const word = m ? m[0] : c;
      const after = text[i + word.length];
      if (KEYWORDS.has(word.toUpperCase()) && (word === word.toUpperCase() || ['as', 'by', 'over', 'with', 'output', 'where'].includes(word))) {
        out.push({ from: i, to: i + word.length, type: 'keyword' });
      } else if (after === '(') {
        out.push({ from: i, to: i + word.length, type: 'function' });
      } else if (after === '=' && text[i + word.length + 1] !== '=') {
        out.push({ from: i, to: i + word.length, type: 'option' });
      }
      i += word.length;
      continue;
    }
    if (/[=!<>+\-*/%.]/.test(c)) {
      out.push({ from: i, to: i + 1, type: 'operator' });
      i++;
      continue;
    }
    i++;
  }
}
