import { allDiagnosticDocs, listCommands } from '@spl2dql/core';
import { useMemo, useState } from 'react';

const TIER = {
  T1: { word: 'Exact', mark: '●', cls: 'mark-exact' },
  T2: { word: 'Check', mark: '▲', cls: 'mark-check' },
  T3: { word: 'Not translated', mark: '■', cls: 'mark-untranslated' },
} as const;

/** What is supported, generated from the engine itself so it can never be out of date. */
export function ReferenceView() {
  const [q, setQ] = useState('');
  const commands = useMemo(() => listCommands(), []);
  const codes = useMemo(() => allDiagnosticDocs(), []);
  const needle = q.trim().toLowerCase();
  const cmdRows = commands.filter(
    (c) => !needle || c.name.includes(needle) || c.summary.toLowerCase().includes(needle) || c.aliases.some((a) => a.includes(needle)),
  );
  const codeRows = codes.filter((d) => !needle || d.code.toLowerCase().includes(needle) || d.title.toLowerCase().includes(needle));

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <label className="flex max-w-md flex-col gap-1 text-sm">
          <span className="font-semibold">Find a command or note code</span>
          <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="stats, SPL3001, lookup…" />
        </label>

        <h2 className="mt-8 text-lg font-semibold">Commands</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">
          Exact: translated with the same meaning. Check: translated, with a known difference the notes explain. Not translated: left as a comment line; the
          rest of the search is still translated.
        </p>
        <table className="mt-3 w-full border-collapse bg-surface text-sm">
          <thead>
            <tr className="text-left">
              <th className="border-b border-line px-3 py-2">Command</th>
              <th className="border-b border-line px-3 py-2">Best case</th>
              <th className="border-b border-line px-3 py-2">How it translates</th>
            </tr>
          </thead>
          <tbody>
            {cmdRows.map((c) => (
              <tr key={c.name}>
                <td className="border-b border-line px-3 py-2 align-top font-code">
                  {c.name}
                  {c.aliases.length > 0 && <span className="block text-xs text-muted">also {c.aliases.join(', ')}</span>}
                </td>
                <td className="whitespace-nowrap border-b border-line px-3 py-2 align-top">
                  <span className={TIER[c.tier].cls} aria-hidden="true">
                    {TIER[c.tier].mark}{' '}
                  </span>
                  {TIER[c.tier].word}
                </td>
                <td className="border-b border-line px-3 py-2 align-top">{c.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="mt-10 text-lg font-semibold">Note codes</h2>
        <table className="mt-3 w-full border-collapse bg-surface text-sm">
          <thead>
            <tr className="text-left">
              <th className="border-b border-line px-3 py-2">Code</th>
              <th className="border-b border-line px-3 py-2">Meaning</th>
              <th className="border-b border-line px-3 py-2">What to do</th>
            </tr>
          </thead>
          <tbody>
            {codeRows.map((d) => (
              <tr key={d.code} id={d.code}>
                <td className="whitespace-nowrap border-b border-line px-3 py-2 align-top font-code">
                  <span className={d.severity === 'error' ? 'mark-error' : d.severity === 'warning' ? 'mark-check' : 'mark-info'} aria-hidden="true">
                    {d.severity === 'error' ? '■' : d.severity === 'warning' ? '▲' : '●'}{' '}
                  </span>
                  {d.code}
                </td>
                <td className="border-b border-line px-3 py-2 align-top">{d.title}</td>
                <td className="border-b border-line px-3 py-2 align-top text-muted">{d.hint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
