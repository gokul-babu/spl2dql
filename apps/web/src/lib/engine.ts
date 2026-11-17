import {
  type ConfigFile,
  type ConfigImport,
  type DashboardSearch,
  type DashboardSource,
  InputError,
  type SyntaxCheckResult,
  type TranslateResult,
} from '@spl2dql/core';
import type { InputFile } from './input-files.ts';
import type { SplunkFiles } from './read-files.ts';
import type { KeptResult } from './retained.ts';
import type { DashboardOutcome, WorkerRequest, WorkerResponse, WorkItem } from './translate.worker.ts';
import { appScript, WORKER_SCRIPT } from './trusted.ts';
import type { MappingRef, MappingUse } from './worker-mapping.ts';

export type { DashboardOutcome, MappingRef, MappingUse, WorkItem };

/** Fixed limits (ADR-029): one dashboard, and any other request. */
export const DASHBOARD_LIMIT_MS = 20_000;
export const REQUEST_LIMIT_MS = 120_000;

/** Why a request ended without a result. */
export class WorkerStopped extends Error {
  readonly reason: 'timeout' | 'crash';
  constructor(reason: 'timeout' | 'crash') {
    super(reason === 'timeout' ? 'The work took too long and was stopped.' : 'The translator stopped unexpectedly.');
    this.reason = reason;
  }
}

type Body = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/**
 * One Web Worker and the requests waiting on it. A request that runs over its limit stops the
 * worker; so does an error the worker cannot answer. Either way every waiting request is rejected
 * at once, and the next request starts a fresh worker.
 */
class Host {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  private readonly name: string;
  constructor(name: string) {
    this.name = name;
  }

  private stop(reason: 'timeout' | 'crash'): void {
    this.worker?.terminate();
    this.worker = undefined;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(new WorkerStopped(reason));
  }

  private get(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(appScript(WORKER_SCRIPT), { type: 'module', name: this.name });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const done = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      done?.resolve(e.data);
    };
    w.onerror = (e) => {
      e.preventDefault();
      if (this.worker === w) this.stop('crash');
    };
    w.onmessageerror = () => {
      if (this.worker === w) this.stop('crash');
    };
    this.worker = w;
    return w;
  }

  call(body: Body, limitMs: number): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.stop('timeout'), limitMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          if (r.kind === 'error') reject(r.input ? new InputError(r.message) : new Error(r.message));
          else resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.get().postMessage({ id, ...body } as WorkerRequest);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

/** The Translate view's worker: typing never waits behind a large drop of files. */
const interactive = new Host('spl2dql-translate');
/** Dropped and chosen files: reading, configuration import, batch translation, dashboards. */
const files = new Host('spl2dql-files');

export interface Translated {
  result: TranslateResult | undefined;
  syntax: SyntaxCheckResult | undefined;
  mappingUse: MappingUse;
}

/** The search on the Translate view, with its syntax check. */
export async function translateOne(item: WorkItem, opts: { mapping: MappingRef; timeRange?: { earliest?: string } }): Promise<Translated> {
  const r = await interactive.call({ kind: 'translate', items: [item], check: true, ...opts }, REQUEST_LIMIT_MS);
  if (r.kind !== 'translate') return { result: undefined, syntax: undefined, mappingUse: 'none' };
  return { result: r.results[0], syntax: r.syntax[0], mappingUse: r.mappingUse };
}

/**
 * Searches from dropped files, trimmed to what the Batch view keeps. Stops before the result that
 * would take the drop over its budget; `kept` then has fewer entries than `items`.
 */
export async function translateBatchInWorker(
  items: WorkItem[],
  opts: { mapping: MappingRef; timeRange?: { earliest?: string; latest?: string }; budget: number },
): Promise<{ kept: KeptResult[]; spent: number }> {
  const r = await files.call({ kind: 'batch', items, ...opts }, REQUEST_LIMIT_MS);
  return r.kind === 'batch' ? { kept: r.kept, spent: r.spent } : { kept: [], spent: 0 };
}

export async function readFilesInWorker(list: readonly InputFile[]): Promise<SplunkFiles> {
  const r = await files.call({ kind: 'read', files: [...list] }, REQUEST_LIMIT_MS);
  if (r.kind !== 'read') throw new Error('Unexpected answer from the worker.');
  return r.found;
}

/** One dashboard per request, so one that runs too long is stopped alone after 20 s. */
export async function convertDashboardInWorker(
  source: DashboardSource,
  opts: { mapping: MappingRef; savedSearches?: [string, DashboardSearch][]; budget: number },
): Promise<DashboardOutcome> {
  try {
    const r = await files.call({ kind: 'dashboard', source, ...opts }, DASHBOARD_LIMIT_MS);
    if (r.kind === 'dashboard') return r.outcome;
  } catch (e) {
    if (e instanceof WorkerStopped && e.reason === 'timeout') {
      return { ok: false, name: source.name, error: `${source.name} took too long to convert and was stopped.` };
    }
    if (e instanceof WorkerStopped) return { ok: false, name: source.name, error: `${source.name} stopped the translator and was not converted.` };
    throw e;
  }
  return { ok: false, name: source.name, error: 'This file could not be read as a dashboard.' };
}

export async function importConfigInWorker(list: ConfigFile[], mapping: MappingRef): Promise<ConfigImport | undefined> {
  const r = await files.call({ kind: 'import', files: list, mapping }, REQUEST_LIMIT_MS);
  return r.kind === 'import' ? r.imported : undefined;
}
