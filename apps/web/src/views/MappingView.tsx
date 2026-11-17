import type { EditorView } from '@codemirror/view';
import { collectMappingNeeds, parseMappingConfig } from '@spl2dql/core';
import { Download, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { parse as parseYaml } from 'yaml';
import { cap, LIMIT, MoreLine } from '../components/Capped.tsx';
import { CodeEditor } from '../components/CodeEditor.tsx';
import { DropZone, IngestSummary } from '../components/DropZone.tsx';
import { exampleMappingText } from '../lib/example-mapping.ts';
import { addEntries, datamodelSkeleton, type Entry, findEntry, skeleton } from '../lib/mapping-text.ts';
import { useApp } from '../lib/store.ts';

type Section = 'indexes' | 'sourcetypes' | 'fields' | 'macros' | 'lookups' | 'eventtypes' | 'metrics';

const LABEL: Record<Section, string> = {
  indexes: 'Indexes',
  sourcetypes: 'Sourcetypes',
  fields: 'Fields',
  macros: 'Macros',
  lookups: 'Lookups',
  eventtypes: 'Eventtypes and tags',
  metrics: 'Metrics',
};

/** Edit the mapping file; names the current search could not resolve are listed with "Add". */
export function MappingView() {
  const text = useApp((s) => s.mappingText);
  const setText = useApp((s) => s.setMappingText);
  const result = useApp((s) => s.result);
  const mappingUse = useApp((s) => s.mappingUse);
  const focus = useApp((s) => s.mappingFocus);
  const setFocus = useApp((s) => s.setMappingFocus);
  const forget = useApp((s) => s.forgetMapping);
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<EditorView | null>(null);

  // Parsed here, in this view's own code: the YAML library is not part of the first paint.
  const issues = useMemo(() => {
    if (text.trim() === '') return [];
    let data: unknown;
    try {
      data = parseYaml(text, { schema: 'core', maxAliasCount: 100, uniqueKeys: true, merge: false });
    } catch (e) {
      return [{ path: '', message: (e as Error).message.split('\n')[0] ?? 'The mapping is not valid YAML.' }];
    }
    if (data === null || data === undefined) return [];
    const r = parseMappingConfig(data);
    return r.ok ? [] : r.issues;
  }, [text]);

  // Opened from "Add mapping": put the caret on the entry that was just added.
  useEffect(() => {
    if (!focus) return;
    const v = editor.current;
    const at = findEntry(text, focus.section, focus.name);
    setFocus(undefined);
    if (!v || at === undefined) return;
    v.dispatch({ selection: { anchor: Math.min(at, v.state.doc.length) }, scrollIntoView: true });
    v.focus();
  }, [focus, text, setFocus]);

  // While the example mapping is in use, the current search needs nothing from this one.
  const needs = useMemo(() => collectMappingNeeds(mappingUse === 'example' ? [] : (result?.diagnostics ?? [])), [result, mappingUse]);
  const sections = (Object.keys(LABEL) as Section[]).filter((k) => needs[k].length > 0);

  const addEntry = (entry: Entry) => {
    const changed = addEntries(text, [entry]);
    if (changed && changed.added > 0) setText(changed.text);
  };
  const add = (section: Section, name: string) => addEntry(skeleton(section, name));

  const importFile = async (f: File) => {
    if (f.size > 5 * 1024 * 1024) return;
    setText(await f.text());
  };

  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
    a.download = 'spl2dql.mapping.yaml';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(300px,1fr)_auto] min-[900px]:grid-cols-[minmax(0,3fr)_minmax(280px,2fr)] min-[900px]:grid-rows-1">
      <div className="flex min-h-0 flex-col border-line min-[900px]:border-r">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
          <h2 className="text-sm font-semibold">Mapping file</h2>
          <div className="ml-auto flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".yaml,.yml,.json"
              className="sr-only"
              aria-label="Import a mapping file"
              onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])}
            />
            <button type="button" className="control" onClick={() => fileInput.current?.click()}>
              <Upload size={16} aria-hidden />
              Import
            </button>
            <button type="button" className="control" onClick={download}>
              <Download size={16} aria-hidden />
              Download mapping
            </button>
            <button type="button" className="control quiet" onClick={forget}>
              Forget mapping
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor value={text} onChange={setText} language="plain" label="Mapping file (YAML)" viewRef={editor} wrap />
        </div>
      </div>
      <aside className="min-h-0 overflow-auto bg-canvas px-4 py-4" aria-label="Mapping status">
        {mappingUse === 'example' && (
          <div className="mb-6" data-testid="example-mapping">
            <h2 className="text-sm font-semibold">Example mapping in use</h2>
            <p className="mt-1 text-sm">
              The search on the Translate page is a built-in example, and this mapping is empty, so the example mapping is used. Every name in it is made up.
              Your own searches need your own mapping.
            </p>
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer">Show the example mapping</summary>
              <pre className="code-block">{exampleMappingText()}</pre>
              <p className="mt-1 text-xs text-muted">Plus the macros, extractions, eventtypes and tags of the sample app's .conf files.</p>
            </details>
          </div>
        )}
        <h2 className="text-sm font-semibold">Problems</h2>
        {issues.length === 0 ? (
          <p className="mt-1 text-sm">
            <span className="mark-exact" aria-hidden="true">
              ●{' '}
            </span>
            The mapping file is valid.
          </p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm" data-testid="mapping-issues">
            {cap(issues, LIMIT.list).map((i) => (
              <li key={`${i.path}-${i.message}`}>
                <span className="mark-error" aria-hidden="true">
                  ■{' '}
                </span>
                <span className="font-code text-xs">{i.path || '/'}</span> {i.message}
              </li>
            ))}
          </ul>
        )}
        <MoreLine total={issues.length} limit={LIMIT.list} noun="problems" className="mt-1" />

        <h2 className="mt-6 text-sm font-semibold">Names the current search needs</h2>
        {sections.length === 0 && needs.datamodels.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Nothing is missing for the search on the Translate page.</p>
        ) : (
          sections.map((s) => (
            <div key={s} className="mt-3">
              <h3 className="text-xs font-semibold text-muted">{LABEL[s]}</h3>
              <ul className="mt-1 space-y-1">
                {cap(needs[s], LIMIT.list).map((n) => (
                  <li key={n} className="flex items-center gap-2 text-sm">
                    <span className="font-code">{n}</span>
                    <button type="button" className="control ml-auto" onClick={() => add(s, n)} aria-label={`Add ${n} to ${LABEL[s]}`}>
                      Add
                    </button>
                  </li>
                ))}
              </ul>
              <MoreLine total={needs[s].length} limit={LIMIT.list} noun="names" className="mt-1" />
            </div>
          ))
        )}
        {needs.datamodels.length > 0 && (
          <div className="mt-3">
            <h3 className="text-xs font-semibold text-muted">Data models</h3>
            <ul className="mt-1 space-y-1">
              {cap(needs.datamodels, LIMIT.list).map((m) => (
                <li key={m.name} className="flex items-center gap-2 text-sm">
                  <span className="font-code">{m.name}</span>
                  <span className="text-xs text-muted">
                    {m.fields.length} field{m.fields.length === 1 ? '' : 's'}
                  </span>
                  <button
                    type="button"
                    className="control ml-auto"
                    onClick={() => addEntry(datamodelSkeleton(m.name, m.fields))}
                    aria-label={`Add ${m.name} to Data models`}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
            <MoreLine total={needs.datamodels.length} limit={LIMIT.list} noun="data models" className="mt-1" />
          </div>
        )}

        <h2 className="mt-6 text-sm font-semibold">From Splunk configuration files</h2>
        <div className="mt-2">
          <DropZone title="Drop macros.conf, props.conf …" compact>
            <p>
              Macros, field extractions (EXTRACT and REPORT), eventtypes and tags are read from macros.conf, props.conf, transforms.conf, eventtypes.conf and
              tags.conf and added to the mapping. An entry the mapping already has is kept.
            </p>
          </DropZone>
          <IngestSummary here="mapping" />
        </div>
      </aside>
    </div>
  );
}
