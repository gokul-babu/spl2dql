import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Why `readRegularFile` refused a file that could be opened. */
export class FileRefused extends Error {
  readonly reason: 'not a regular file' | 'too large';
  constructor(reason: 'not a regular file' | 'too large') {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Reads a file through one open handle: the file that is checked (a regular file of at most
 * `maxBytes`) is the file that is read, whatever happens to the name in the meantime. A symbolic
 * link at `path` is not followed. Throws `FileRefused`, or the system's error when it cannot open.
 */
export function readRegularFile(path: string, maxBytes: number): Buffer {
  // O_NONBLOCK: opening a pipe that somebody put at this name must not wait for a writer.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new FileRefused('not a regular file');
    if (st.size > maxBytes) throw new FileRefused('too large');
    const data = readFileSync(fd);
    // The file can grow between the size check and the end of the read.
    if (data.length > maxBytes) throw new FileRefused('too large');
    return data;
  } finally {
    closeSync(fd);
  }
}

/** Creates the output directory (and parents) and returns its real path. */
export function prepareOutDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/**
 * Writes `name` inside `dir` only: refuses paths that leave the directory and refuses to write
 * through an existing symbolic link (which could point anywhere).
 */
export function writeInside(dir: string, name: string, content: string, afterOpen?: () => void): string {
  const target = resolve(dir, name);
  const rel = relative(dir, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Refusing to write outside ${dir}: ${name}`);
  if (dirname(target) !== dir) {
    // A folder on the way may be a symbolic link that leads out of the output folder: check the
    // deepest folder that exists before creating anything, and the real parent afterwards.
    let existing = dirname(target);
    while (!existsSync(existing) && existing !== dir) existing = dirname(existing);
    insideOrRefuse(dir, existing, name);
    mkdirSync(dirname(target), { recursive: true });
    insideOrRefuse(dir, dirname(target), name);
  }
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) throw new Error(`Refusing to write through the symbolic link ${target}`);
    if (!st.isFile()) throw new Error(`Refusing to replace ${target}: it is not a regular file`);
    // Remove the old entry (this also detaches hard links) and create a fresh file below.
    unlinkSync(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  // O_EXCL fails if anything reappeared at this path in the meantime; O_NOFOLLOW never follows a link.
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    // `afterOpen` lets a test change the folders between opening and checking.
    afterOpen?.();
    // Before any content is written: the file that was opened must be the one at the real path
    // inside the output folder. A program that swapped a folder in the meantime gets an empty file
    // at most, never the content (ADR-029).
    if (!sameFileInside(dir, target, fd)) {
      throw new Error(`Refusing to write ${name}: a folder on its way changed while the file was being created; nothing was written.`);
    }
    writeSync(fd, content, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return target;
}

/** `folder`'s real path must be the output folder's real path or below it. */
function insideOrRefuse(dir: string, folder: string, name: string): void {
  const real = realpathSync(folder);
  const rel = relative(realpathSync(dir), real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write ${name}: a folder on its way is a symbolic link that leads outside the output folder ${dir}.`);
  }
}

/** The open file `fd` is the regular file at `target`'s real location inside `dir`. */
function sameFileInside(dir: string, target: string, fd: number): boolean {
  try {
    const parent = realpathSync(dirname(target));
    const rel = relative(realpathSync(dir), parent);
    if (rel.startsWith('..') || isAbsolute(rel)) return false;
    const opened = fstatSync(fd);
    const there = lstatSync(join(parent, basename(target)));
    return there.isFile() && opened.isFile() && there.dev === opened.dev && there.ino === opened.ino;
  } catch {
    return false;
  }
}
