import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { highlightSpl, tokenizeDql } from '@spl2dql/core';

type Tok = { from: number; to: number; cls: string };

/** Longer texts are shown without colours, so a huge result cannot make typing or scrolling slow. */
export const MAX_HIGHLIGHT = 300_000;

/** Syntax colouring from a tokenizer that returns sorted, non-overlapping ranges. */
function tokenHighlighter(tokenize: (text: string) => Tok[]) {
  const build = (view: EditorView): DecorationSet => {
    if (view.state.doc.length > MAX_HIGHLIGHT) return Decoration.none;
    const b = new RangeSetBuilder<Decoration>();
    let last = -1;
    for (const t of tokenize(view.state.doc.toString())) {
      if (t.from < last || t.to <= t.from) continue;
      b.add(t.from, t.to, Decoration.mark({ class: t.cls }));
      last = t.to;
    }
    return b.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** SPL colouring comes from the translator's own stage splitter, so it never disagrees with it. */
export const splHighlight = tokenHighlighter((text) => highlightSpl(text).map((t) => ({ from: t.from, to: t.to, cls: `tok-${t.type}` })));

export const dqlHighlight = tokenHighlighter((text) => {
  const toks = tokenizeDql(text);
  const out: Tok[] = [];
  toks.forEach((t, i) => {
    const prev = toks[i - 1];
    const next = toks[i + 1];
    let cls: string | undefined;
    if (t.type === 'string') cls = 'tok-string';
    else if (t.type === 'number') cls = 'tok-number';
    else if (t.type === 'duration' || t.type === 'align') cls = 'tok-duration';
    else if (t.type === 'comment') cls = 'tok-comment';
    else if (t.type === 'punct' && t.text === '|') cls = 'tok-pipe';
    else if (t.type === 'ident' && next?.type === 'punct' && next.text === '(') cls = 'tok-function';
    else if (t.type === 'ident' && (!prev || (prev.type === 'punct' && (prev.text === '|' || prev.text === '[')))) cls = 'tok-command';
    else if (t.type === 'ident' && ['and', 'or', 'not', 'xor', 'in', 'asc', 'desc', 'true', 'false', 'null'].includes(t.text)) cls = 'tok-keyword';
    if (cls) out.push({ from: t.span.start, to: t.span.end, cls });
  });
  return out;
});

// --- Decorations driven from React state (active stage, note underlines, gutter markers) ---

export interface LineMarker {
  line: number;
  mark: string;
  cls: string;
  label: string;
}

export const setMarkers = StateEffect.define<LineMarker[]>();
export const setRanges = StateEffect.define<{ from: number; to: number; cls: string; line?: boolean }[]>();

class Marker extends GutterMarker {
  readonly mark: string;
  readonly cls: string;
  readonly label: string;
  constructor(mark: string, cls: string, label: string) {
    super();
    this.mark = mark;
    this.cls = cls;
    this.label = label;
  }
  override eq(other: Marker): boolean {
    return other.mark === this.mark && other.cls === this.cls && other.label === this.label;
  }
  override toDOM(): Node {
    const span = document.createElement('span');
    span.className = `cm-stage-marker ${this.cls}`;
    span.textContent = this.mark;
    span.title = this.label;
    span.setAttribute('aria-label', this.label);
    return span;
  }
}

const markerField = StateField.define<LineMarker[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarkers)) return e.value;
    return tr.docChanged ? [] : value;
  },
});

export const stageGutter = [
  markerField,
  gutter({
    class: 'cm-stage-gutter',
    markers: (view) => {
      const b = new RangeSetBuilder<GutterMarker>();
      const doc = view.state.doc;
      const markers = [...view.state.field(markerField)].filter((m) => m.line >= 1 && m.line <= doc.lines).sort((a, b) => a.line - b.line);
      let lastLine = -1;
      for (const m of markers) {
        if (m.line === lastLine) continue;
        lastLine = m.line;
        const pos = doc.line(m.line).from;
        b.add(pos, pos, new Marker(m.mark, m.cls, m.label));
      }
      return b.finish();
    },
    initialSpacer: () => new Marker('●', '', ''),
  }),
];

export const rangeField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setRanges)) {
        const doc = tr.state.doc;
        const items = e.value
          .map((r) => {
            const from = Math.max(0, Math.min(r.from, doc.length));
            const to = Math.max(from, Math.min(r.to, doc.length));
            if (r.line) return Decoration.line({ class: r.cls }).range(doc.lineAt(from).from);
            return to > from ? Decoration.mark({ class: r.cls }).range(from, to) : undefined;
          })
          .filter((x) => x !== undefined)
          .sort((a, b) => a.from - b.from);
        return Decoration.set(items, true);
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const baseTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-content': { padding: '12px 0' },
  '.cm-line': { padding: '0 16px 0 12px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '28px' },
  '.cm-stage-gutter .cm-gutterElement': { padding: '0 4px' },
});
