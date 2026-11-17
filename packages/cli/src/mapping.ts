import { resolve } from 'node:path';
import { type MappingConfig, type MappingIssue, parseMappingConfig } from '@spl2dql/core';
import { parse as parseYaml } from 'yaml';
import { FileRefused, readRegularFile } from './safe-fs.ts';

export class MappingError extends Error {
  readonly issues: MappingIssue[];
  constructor(message: string, issues: MappingIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

const DEFAULT_FILE = 'spl2dql.mapping.yaml';
const MAX_MAPPING = 5 * 1024 * 1024;

/** Reads mapping text (YAML or JSON) safely: no custom tags, limited aliases, unique keys. */
function readMappingText(text: string, name: string): unknown {
  try {
    return parseYaml(text, { schema: 'core', maxAliasCount: 100, uniqueKeys: true, merge: false, prettyErrors: true });
  } catch (e) {
    throw new MappingError(`${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Validates already-parsed mapping data. */
export function validateMapping(data: unknown, name: string): MappingConfig {
  const result = parseMappingConfig(data);
  if (!result.ok) throw new MappingError(`${name} has ${result.issues.length} problem(s).`, result.issues);
  return result.value;
}

/** Parses mapping text (YAML or JSON) and validates it. */
export function parseMappingText(text: string, name: string): MappingConfig {
  return validateMapping(readMappingText(text, name), name);
}

export interface LoadedMapping {
  file: string;
  /** The file's content as plain data, for merging with sections imported from Splunk files. */
  data: Record<string, unknown>;
  mapping: MappingConfig;
}

/** Loads --mapping, or spl2dql.mapping.yaml from the working directory when present. */
export function loadMappingFile(path: string | undefined, cwd: string): LoadedMapping | undefined {
  const file = path ? resolve(cwd, path) : resolve(cwd, DEFAULT_FILE);
  let text: string;
  try {
    text = readRegularFile(file, MAX_MAPPING).toString('utf8');
  } catch (e) {
    // The default file is optional; one that was named has to be there.
    if (!path && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (e instanceof FileRefused) throw new MappingError(e.reason === 'too large' ? `${file} is larger than 5 MB.` : `${file} is not a regular file.`);
    // A symbolic link is not followed: ELOOP on Linux and macOS.
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') throw new MappingError(`${file} is not a regular file.`);
    throw new MappingError(`Cannot read the mapping file ${file}.`);
  }
  const data = readMappingText(text, file);
  const mapping = validateMapping(data, file);
  return { file, data: data as Record<string, unknown>, mapping };
}

export function loadMapping(path: string | undefined, cwd: string): MappingConfig | undefined {
  return loadMappingFile(path, cwd)?.mapping;
}
