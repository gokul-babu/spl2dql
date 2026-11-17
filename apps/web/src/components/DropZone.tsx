import { InputError } from '@spl2dql/core';
import { FolderOpen, Upload } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { ingestFiles } from '../lib/ingest.ts';
import { fromBrowserFile, type InputFile, MAX_FILES } from '../lib/input-files.ts';
import { SAMPLE_APP } from '../lib/sample.ts';
import { type IngestNote, useApp, type View } from '../lib/store.ts';
import { cap, LIMIT, MoreLine } from './Capped.tsx';

/** One more than allowed, so a larger folder is refused with the message instead of cut short. */
const MAX_DROPPED = MAX_FILES + 1;

/** Files of a drop, walking into dropped folders (a Splunk app directory) where the browser allows it. */
async function filesFromDrop(data: DataTransfer): Promise<File[]> {
  type Entry = { isFile: boolean; isDirectory: boolean; file?: (ok: (f: File) => void, err: () => void) => void; createReader?: () => Reader };
  type Reader = { readEntries: (ok: (e: Entry[]) => void, err: () => void) => void };
  const roots: Entry[] = [];
  for (const item of [...data.items]) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (roots.length === 0 || roots.every((r) => r.isFile)) return [...data.files];
  const out: File[] = [];
  const walk = async (entry: Entry): Promise<void> => {
    if (out.length >= MAX_DROPPED) return;
    if (entry.isFile && entry.file) {
      const file = await new Promise<File | undefined>((resolve) => entry.file?.(resolve, () => resolve(undefined)));
      if (file) out.push(file);
      return;
    }
    const reader = entry.createReader?.();
    if (!reader) return;
    // readEntries returns the directory in batches; an empty batch ends it.
    for (;;) {
      const batch = await new Promise<Entry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const root of roots) await walk(root);
  return out;
}

/**
 * Where files come in. The same on every view: searches are translated, dashboards converted and
 * Splunk configuration files read into the mapping, whatever mix is given.
 */
export function DropZone(props: { title: string; children: ReactNode; compact?: boolean; sample?: boolean }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const load = async (files: readonly InputFile[], sample = false) => {
    if (files.length === 0) return;
    setError(undefined);
    setBusy(true);
    try {
      await ingestFiles(files, { sample });
    } catch (e) {
      setError(e instanceof InputError ? e.message : 'These files could not be read.');
    } finally {
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag and drop is an enhancement; the buttons are the accessible path.
    <div
      className={`flex flex-col items-start gap-3 border-2 border-dashed ${props.compact ? 'p-4' : 'p-6'} ${over ? 'border-exact bg-surface' : 'border-line'}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void filesFromDrop(e.dataTransfer).then((files) => load(files.map(fromBrowserFile)));
      }}
      data-testid="dropzone"
    >
      <p className="font-semibold">{props.title}</p>
      <div className="max-w-[70ch] text-sm text-muted">{props.children}</div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".spl,.txt,.csv,.conf,.xml,.json"
        className="sr-only"
        onChange={(e) => {
          if (e.target.files) void load([...e.target.files].map(fromBrowserFile));
          e.target.value = '';
        }}
        aria-label="Choose files"
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        className="sr-only"
        onChange={(e) => {
          if (e.target.files) void load([...e.target.files].map(fromBrowserFile));
          e.target.value = '';
        }}
        aria-label="Choose a folder"
        {...{ webkitdirectory: '' }}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="control" onClick={() => fileInput.current?.click()} disabled={busy}>
          <Upload size={16} aria-hidden />
          {busy ? 'Working…' : 'Choose files'}
        </button>
        <button type="button" className="control" onClick={() => folderInput.current?.click()} disabled={busy}>
          <FolderOpen size={16} aria-hidden />
          Choose a folder
        </button>
        {props.sample && (
          <button type="button" className="control quiet" onClick={() => void load(SAMPLE_APP, true)} disabled={busy}>
            Load the sample app
          </button>
        )}
      </div>
      {error && (
        <p className="text-sm" role="alert">
          <span className="mark-error" aria-hidden="true">
            ■{' '}
          </span>
          {error}
        </p>
      )}
    </div>
  );
}

/** What the last files contained, with a way to the views that show the rest of it. */
export function IngestSummary(props: { here: View }) {
  const note = useApp((s) => s.ingestNote);
  const setView = useApp((s) => s.setView);
  if (!note) return null;
  const elsewhere: { view: View; label: string }[] = [];
  if (note.searches > 0 && props.here !== 'batch')
    elsewhere.push({ view: 'batch', label: `${note.searches} search${note.searches === 1 ? '' : 'es'} translated` });
  if (note.dashboards > 0 && props.here !== 'dashboards') {
    elsewhere.push({ view: 'dashboards', label: `${note.dashboards} dashboard${note.dashboards === 1 ? '' : 's'} converted` });
  }
  if (note.added > 0 && props.here !== 'mapping')
    elsewhere.push({ view: 'mapping', label: `${note.added} definition${note.added === 1 ? '' : 's'} added to the mapping` });
  if (
    elsewhere.length === 0 &&
    note.skipped.length === 0 &&
    note.problems.length === 0 &&
    !note.example &&
    !note.overBudget &&
    !(props.here === 'mapping' && note.added > 0)
  )
    return null;
  return (
    <div className="mt-3 space-y-2 text-sm" data-testid="ingest-summary">
      <NotTranslatedList note={note} />
      {note.example && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            <span className="mark-info" aria-hidden="true">
              ●{' '}
            </span>
            Converted with the example mapping. Your own files need yours.
          </span>
          {props.here !== 'mapping' && (
            <button type="button" className="control" onClick={() => setView('mapping')}>
              Open Mapping
            </button>
          )}
        </p>
      )}
      {props.here === 'mapping' && note.added > 0 && (
        <p>
          <span className="mark-exact" aria-hidden="true">
            ●{' '}
          </span>
          {note.added} definition{note.added === 1 ? '' : 's'} added from the Splunk configuration files.
        </p>
      )}
      {elsewhere.length > 0 && (
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Also in these files:</span>
          {elsewhere.map((e) => (
            <button key={e.view} type="button" className="control" onClick={() => setView(e.view)}>
              {e.label}
            </button>
          ))}
        </p>
      )}
      {cap(note.problems, LIMIT.list).map((p) => (
        <p key={p}>
          <span className="mark-check" aria-hidden="true">
            ▲{' '}
          </span>
          {p}
        </p>
      ))}
      <MoreLine total={note.problems.length} limit={LIMIT.list} noun="problems" />
      <SkippedList note={note} />
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Over the drop's budget for kept results: one plain line, and what was not translated by name. */
function NotTranslatedList(props: { note: IngestNote }) {
  const over = props.note.overBudget;
  if (!over) return null;
  const parts = [
    ...(over.searches.length > 0 ? [plural(over.searches.length, 'search', 'searches')] : []),
    ...(over.dashboards.length > 0 ? [plural(over.dashboards.length, 'dashboard', 'dashboards')] : []),
  ];
  const total = over.searches.length + over.dashboards.length;
  const shownDashboards = cap(over.dashboards, LIMIT.list);
  const shownSearches = cap(over.searches, LIMIT.list - shownDashboards.length);
  return (
    <div data-testid="over-budget">
      <p className="font-semibold">
        <span className="mark-untranslated" aria-hidden="true">
          ■{' '}
        </span>
        These files produce more than 50 MB of DQL. The rest was not translated; choose fewer files at once.
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer" data-testid="not-translated-count">
          {parts.join(' and ')} {total === 1 ? 'was' : 'were'} not translated
        </summary>
        <ul className="mt-2 max-h-64 space-y-1 overflow-auto border-l-2 border-line pl-3">
          {/* Dashboards first: there are few, and the list is shortened after LIMIT.list names. */}
          {shownDashboards.map((name, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; the list never reorders.
            <li key={`d-${i}`}>
              <span className="[overflow-wrap:anywhere]">{name}</span> <span className="text-muted">(dashboard)</span>
            </li>
          ))}
          {shownSearches.map((name, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; the list never reorders.
            <li key={`s-${i}`}>
              <span className="[overflow-wrap:anywhere]">{name}</span>
            </li>
          ))}
        </ul>
        <MoreLine total={total} limit={LIMIT.list} noun="names" className="mt-1" />
      </details>
    </div>
  );
}

function SkippedList(props: { note: IngestNote }) {
  const { skipped } = props.note;
  if (skipped.length === 0) return null;
  return (
    <details>
      <summary className="cursor-pointer">
        <span className="mark-check" aria-hidden="true">
          ▲{' '}
        </span>
        {skipped.length} definition{skipped.length === 1 ? '' : 's'} could not be carried over
      </summary>
      <ul className="mt-2 max-h-64 space-y-1 overflow-auto border-l-2 border-line pl-3">
        {cap(skipped, LIMIT.list).map((s) => (
          <li key={`${s.name}-${s.reason}`}>
            <span className="font-code text-xs">{s.name}</span> <span className="text-muted">{s.reason}</span>
          </li>
        ))}
      </ul>
      <MoreLine total={skipped.length} limit={LIMIT.list} noun="definitions" className="mt-1" />
    </details>
  );
}
