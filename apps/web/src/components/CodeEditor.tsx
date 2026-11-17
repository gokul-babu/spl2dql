import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, placeholder as placeholderExt } from '@codemirror/view';
import { type RefObject, useEffect, useRef } from 'react';
import { baseTheme, dqlHighlight, type LineMarker, rangeField, setMarkers, setRanges, splHighlight, stageGutter } from '../editor/extensions.ts';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  onCursor?: (offset: number) => void;
  readOnly?: boolean;
  language: 'spl' | 'dql' | 'plain';
  placeholder?: string;
  label: string;
  markers?: LineMarker[];
  ranges?: { from: number; to: number; cls: string; line?: boolean }[];
  viewRef?: RefObject<EditorView | null>;
  onGeometry?: () => void;
  wrap?: boolean;
}

/** CodeMirror 6 used directly (no wrapper package). */
export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const readOnlyC = useRef(new Compartment());

  // biome-ignore lint/correctness/useExhaustiveDependencies: the editor is created once; later props arrive through the effects below.
  useEffect(() => {
    if (!host.current) return;
    const lang: Extension = props.language === 'spl' ? splHighlight : props.language === 'dql' ? dqlHighlight : [];
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          stageGutter,
          rangeField,
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          lang,
          baseTheme,
          props.wrap ? EditorView.lineWrapping : [],
          readOnlyC.current.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
          props.placeholder ? placeholderExt(props.placeholder) : [],
          EditorView.contentAttributes.of({
            'aria-label': props.label,
            'aria-multiline': 'true',
            spellcheck: 'false',
            autocapitalize: 'off',
            autocorrect: 'off',
            // Always a tab stop of its own: read-only content must stay reachable to scroll and select,
            // and a long editable document scrolls, which needs keyboard access as well.
            tabindex: '0',
            ...(props.readOnly ? { 'aria-readonly': 'true' } : {}),
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange?.(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) latest.current.onCursor?.(u.state.selection.main.head);
            if (u.geometryChanged || u.viewportChanged) latest.current.onGeometry?.();
          }),
          EditorView.domEventHandlers({ scroll: () => latest.current.onGeometry?.() }),
        ],
      }),
    });
    view.current = v;
    if (props.viewRef) props.viewRef.current = v;
    return () => {
      v.destroy();
      view.current = null;
      if (props.viewRef) props.viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== props.value) v.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarkers.of(props.markers ?? []) });
  }, [props.markers]);

  useEffect(() => {
    view.current?.dispatch({ effects: setRanges.of(props.ranges ?? []) });
  }, [props.ranges]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
