import { InputError } from '@spl2dql/core';

/** At most this many files in one drop. */
export const MAX_FILES = 2_000;
/** At most this large, one file. */
export const MAX_FILE = 10 * 1024 * 1024;
/** At most this much in one drop, all files together (ADR-029). */
export const MAX_TOTAL = 100 * 1024 * 1024;

/**
 * A file to read: one the person chose (read in the worker, never on the page), or one of the
 * bundled sample files, which is already text.
 */
export interface InputFile {
  /** Path inside a dropped folder when the browser gives one, else the file name. */
  path: string;
  size: number;
  blob?: Blob;
  text?: string;
}

export function fromBrowserFile(f: File): InputFile {
  return { path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, size: f.size, blob: f };
}

/** Refuses a drop that is over the budgets before anything is read. */
export function checkBudget(files: readonly InputFile[]): void {
  if (files.length > MAX_FILES) throw new InputError(`Choose at most ${MAX_FILES} files at once.`);
  let total = 0;
  for (const f of files) total += f.size;
  if (total > MAX_TOTAL) throw new InputError('These files add up to more than 100 MB. Choose fewer files at once.');
}
