/**
 * Line numbers of a text, computed once. Looking up the line of every stage by scanning the text
 * from the start each time is quadratic, and a long search or a long DQL result has thousands of
 * stages, so the panes use this index instead (ADR-029).
 */
export interface LineIndex {
  /** 1-based line of a character offset. */
  lineOf(offset: number): number;
  /** Offset at which a 1-based line starts; the end of the text past the last line. */
  startOf(line: number): number;
}

export function lineIndex(text: string): LineIndex {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return {
    lineOf(offset) {
      const at = Math.max(0, Math.min(offset, text.length));
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= at) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
    startOf(line) {
      if (line < 1) return 0;
      return starts[line - 1] ?? text.length;
    },
  };
}
