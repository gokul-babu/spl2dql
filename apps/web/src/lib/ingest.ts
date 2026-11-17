import { type DashboardSearch, InputError } from '@spl2dql/core';
import { convertDashboardInWorker, importConfigInWorker, type MappingRef, readFilesInWorker, translateBatchInWorker, WorkerStopped } from './engine.ts';
import { checkBudget, type InputFile } from './input-files.ts';
import { isEmptyMappingText } from './mapping-empty.ts';
import { addToMappingText } from './mapping-text.ts';
import { keepLimit } from './retained.ts';
import { type BatchRow, type DashboardRow, type IngestNote, useApp } from './store.ts';

/**
 * Reads dropped or chosen files and does everything they allow: definitions from Splunk
 * configuration files go into the mapping, searches are translated, dashboards converted. Used by
 * the Batch, Dashboards and Mapping views, so a whole Splunk app folder can be dropped on any of them.
 * Reading and parsing happen in the worker; this only checks the size budget and passes results on.
 *
 * The sample app, loaded while the person's mapping is empty, is converted with the example mapping
 * and leaves their mapping as it is (ADR-030).
 */
export async function ingestFiles(files: readonly InputFile[], opts: { sample?: boolean } = {}): Promise<IngestNote> {
  checkBudget(files);
  let found: Awaited<ReturnType<typeof readFilesInWorker>>;
  try {
    found = await readFilesInWorker(files);
  } catch (e) {
    if (e instanceof WorkerStopped) throw new InputError('These files took too long to read and were stopped. Choose fewer files at once.');
    throw e;
  }
  const note: IngestNote = { searches: found.searches.length, dashboards: 0, added: 0, skipped: [], problems: [] };
  if (found.searches.length === 0 && found.dashboards.length === 0 && found.configs.length === 0) {
    throw new InputError('None of these files is a search, a Splunk dashboard or a Splunk configuration file.');
  }

  const example = opts.sample === true && isEmptyMappingText(useApp.getState().mappingText);
  note.example = example;

  if (found.configs.length > 0 && !example) {
    const state = useApp.getState();
    const imported = await importConfigInWorker(found.configs, { own: state.mappingText });
    if (imported) {
      note.skipped = imported.skipped.map((s) => ({ name: `${s.section}: ${s.name}`, reason: s.reason }));
      const merged = addToMappingText(state.mappingText, imported.sections);
      if (merged) {
        note.added = merged.added;
        if (merged.added > 0) state.setMappingText(merged.text);
      } else {
        note.problems.push('The mapping file has a YAML problem, so nothing was added to it. Fix it on the Mapping page and choose the files again.');
      }
    }
  }

  // Translate with the mapping as it is now, including what was just added.
  const { mappingText, earliest } = useApp.getState();
  const mapping: MappingRef = example ? { example: true } : { own: mappingText };
  const options = { mapping, timeRange: earliest ? { earliest } : {} };

  // One drop keeps at most this many characters of results; what does not fit is not translated.
  let left = keepLimit();
  let over = false;
  const notTranslated = { searches: [] as string[], dashboards: [] as string[] };

  if (found.searches.length > 0) {
    try {
      const { kept, spent } = await translateBatchInWorker(
        found.searches.map((s) => ({
          spl: s.spl,
          ...(s.earliest !== undefined ? { earliest: s.earliest } : {}),
          ...(s.latest !== undefined ? { latest: s.latest } : {}),
        })),
        { ...options, budget: left },
      );
      left -= spent;
      const rows: BatchRow[] = kept.map((result, i) => ({ ...(found.searches[i] as (typeof found.searches)[number]), result }));
      for (const s of found.searches.slice(kept.length)) notTranslated.searches.push(s.name);
      if (kept.length < found.searches.length) over = true;
      note.searches = rows.length;
      useApp.getState().setBatch(rows);
    } catch (e) {
      if (!(e instanceof WorkerStopped)) throw e;
      note.searches = 0;
      note.problems.push('The searches took too long to translate and were stopped. Choose fewer files at once.');
    }
  }

  if (found.dashboards.length > 0) {
    // A panel may run a saved search by name; those come from the files given now or earlier.
    const saved = new Map<string, DashboardSearch>();
    for (const s of [...useApp.getState().batch, ...found.searches]) {
      saved.set(s.name, { spl: s.spl, ...(s.earliest !== undefined ? { earliest: s.earliest } : {}), ...(s.latest !== undefined ? { latest: s.latest } : {}) });
    }
    const rows: DashboardRow[] = [];
    for (const source of found.dashboards) {
      // Once the budget is used up, the rest of the drop is not converted.
      if (over) {
        notTranslated.dashboards.push(source.name);
        continue;
      }
      const o = await convertDashboardInWorker(source, { mapping, savedSearches: [...saved], budget: left });
      if (o.ok) {
        rows.push({ origin: o.name, conversion: o.conversion });
        left -= o.cost;
      } else if (o.overBudget) {
        notTranslated.dashboards.push(source.name);
        over = true;
      } else note.problems.push(o.error);
    }
    note.dashboards = rows.length;
    if (rows.length > 0) useApp.getState().setDashboards(rows);
  }

  if (notTranslated.searches.length > 0 || notTranslated.dashboards.length > 0) note.overBudget = notTranslated;

  if (opts.sample) {
    // The sample app's searches count as built-in examples when they are opened in Translate.
    const spls = found.searches.map((s) => s.spl);
    for (const d of useApp.getState().dashboards) for (const t of d.conversion.tiles) if (t.spl) spls.push(t.spl);
    useApp.getState().addExamples(spls);
  }

  if (found.ignored.length > 0) {
    note.problems.push(`${found.ignored.length} file(s) were not read: ${found.ignored.slice(0, 3).join(', ')}${found.ignored.length > 3 ? ' …' : ''}`);
  }
  useApp.getState().setIngestNote(note);
  return note;
}
