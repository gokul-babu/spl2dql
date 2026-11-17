import { type ReactNode, useEffect, useId, useRef } from 'react';
import { type Theme, useApp } from '../lib/store.ts';
import { TAGLINE } from './Header.tsx';

/** A native modal <dialog>: focus handling, Escape and inert background come from the browser. */
function Modal(props: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="m-auto max-h-[calc(100dvh-32px)] w-[min(32rem,calc(100vw-32px))] overflow-auto rounded-[6px] border border-line bg-surface p-6 text-ink shadow-xl backdrop:bg-black/40"
      onClose={props.onClose}
    >
      <h2 id={titleId} className="text-lg font-semibold">
        {props.title}
      </h2>
      <div className="mt-4">{props.children}</div>
    </dialog>
  );
}

export function SettingsDialog() {
  const open = useApp((s) => s.dialog === 'settings');
  const setDialog = useApp((s) => s.setDialog);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const fontSize = useApp((s) => s.fontSize);
  const setFontSize = useApp((s) => s.setFontSize);
  return (
    <Modal open={open} title="Settings" onClose={() => useApp.getState().dialog === 'settings' && setDialog(undefined)}>
      <fieldset>
        <legend className="text-sm font-semibold">Theme</legend>
        <div className="mt-2 flex gap-4">
          {(['system', 'light', 'dark'] as Theme[]).map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} />
              {t === 'system' ? 'Follow the system' : t === 'light' ? 'Light' : 'Dark'}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-6 flex items-center gap-3 text-sm">
        <span className="font-semibold">Code size</span>
        <select className="field" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}>
          {[12, 13, 14, 15, 16, 18].map((n) => (
            <option key={n} value={n}>
              {n} px
            </option>
          ))}
        </select>
      </label>
      <p className="mt-6 text-sm">Everything runs in this browser. Searches, mappings and results never leave this device.</p>
      <div className="mt-6 flex justify-between">
        <button type="button" className="control quiet" onClick={() => setDialog('shortcuts')}>
          Keyboard shortcuts
        </button>
        <button type="button" className="control primary" onClick={() => setDialog(undefined)}>
          Done
        </button>
      </div>
    </Modal>
  );
}

export function ShortcutsDialog() {
  const open = useApp((s) => s.dialog === 'shortcuts');
  const setDialog = useApp((s) => s.setDialog);
  const rows: [string, string][] = [
    ['Ctrl/⌘ + Shift + C', 'Copy DQL'],
    ['F8 / Shift + F8', 'Next / previous note'],
    ['Alt + ↑ / ↓', 'Previous / next stage'],
    ['Ctrl/⌘ + K', 'Examples'],
    ['?', 'This list'],
  ];
  return (
    <Modal open={open} title="Keyboard shortcuts" onClose={() => useApp.getState().dialog === 'shortcuts' && setDialog(undefined)}>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="py-1 pr-4 font-code">{k}</td>
              <td className="py-1">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-6 text-right">
        <button type="button" className="control primary" onClick={() => setDialog(undefined)}>
          Done
        </button>
      </div>
    </Modal>
  );
}

const REPOSITORY = 'https://github.com/gokul-babu/spl2dql';
const PACKAGE = 'https://www.npmjs.com/package/spl2dql';

/** What this is, who made it, what it is not, and what happens to your data (ADR-030, ADR-031). */
export function AboutDialog() {
  const open = useApp((s) => s.dialog === 'about');
  const setDialog = useApp((s) => s.setDialog);
  return (
    <Modal open={open} title="About spl2dql" onClose={() => useApp.getState().dialog === 'about' && setDialog(undefined)}>
      <p className="text-sm">{TAGLINE}</p>
      <p className="mt-1 text-sm text-muted" data-testid="version">
        Version {__APP_VERSION__}
      </p>
      <ul className="mt-4 space-y-1 text-sm">
        <li>
          <a className="link" href={REPOSITORY} target="_blank" rel="noopener noreferrer">
            Source code on GitHub
          </a>
        </li>
        <li>
          <a className="link" href={PACKAGE} target="_blank" rel="noopener noreferrer">
            The command-line tool on npm
          </a>
        </li>
        <li>
          <a className="link" href="./THIRD-PARTY-NOTICES.txt" target="_blank" rel="noopener noreferrer">
            Third-party notices
          </a>
        </li>
        <li>Licensed under Apache-2.0</li>
      </ul>
      <h3 className="mt-5 text-sm font-semibold">Privacy</h3>
      <p className="mt-1 text-sm">
        No account, no analytics, no cookies. Your searches, files and mapping stay in this browser; settings are kept in its local storage. The company that
        hosts this page sees the usual request logs when the page loads, and your browser may tell it when a connection to the page fails. Nothing you type or
        drop here is ever sent.
      </p>
      <h3 className="mt-5 text-sm font-semibold">Disclaimer</h3>
      <p className="mt-1 text-sm text-muted">
        spl2dql is an independent open-source project. It is not affiliated with, endorsed by or supported by Splunk Inc., Cisco or Dynatrace. Splunk, SPL,
        Dynatrace and DQL are trademarks of their respective owners and are used only to describe what this tool works with. Provided without warranty; check
        every translated query before relying on it.
      </p>
      <div className="mt-6 text-right">
        <button type="button" className="control primary" onClick={() => setDialog(undefined)}>
          Done
        </button>
      </div>
    </Modal>
  );
}
