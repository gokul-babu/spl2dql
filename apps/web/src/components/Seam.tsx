import type { EditorView } from '@codemirror/view';
import type { StageResult } from '@spl2dql/core';
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STATUS_MARK } from '../lib/store.ts';

interface Ribbon {
  index: number;
  status: StageResult['status'];
  l1: number;
  l2: number;
  r1?: number;
  r2?: number;
}

/**
 * The seam: one ribbon per SPL stage joining its lines on the left to the DQL it produced on the
 * right. Presentational only (aria-hidden) — the same information is in the gutters and notes.
 */
export function Seam(props: {
  stages: readonly StageResult[];
  left: RefObject<EditorView | null>;
  right: RefObject<EditorView | null>;
  active: number | undefined;
  onActivate: (i: number | undefined) => void;
  tick: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [ribbons, setRibbons] = useState<Ribbon[]>([]);
  const [height, setHeight] = useState(0);
  const frame = useRef<number | undefined>(undefined);

  const measure = useCallback(() => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const el = box.current;
      const left = props.left.current;
      const right = props.right.current;
      if (!el || !left || !right) return;
      const top = el.getBoundingClientRect().top;
      setHeight(el.clientHeight);
      const span = (view: EditorView, from: number, to: number): [number, number] => {
        const doc = view.state.doc;
        const a = view.lineBlockAt(Math.min(from, doc.length));
        const b = view.lineBlockAt(Math.min(Math.max(from, to - 1), doc.length));
        return [view.documentTop + a.top - top, view.documentTop + b.bottom - top];
      };
      const out: Ribbon[] = [];
      for (const s of props.stages) {
        if (s.spl.end <= s.spl.start && s.spl.start === 0 && props.stages.length > 1) continue;
        const [l1, l2] = span(left, s.spl.start, s.spl.end);
        const first = s.dql[0];
        const last = s.dql[s.dql.length - 1];
        if (first && last) {
          const [r1] = span(right, first.start, first.end);
          const [, r2] = span(right, last.start, last.end);
          out.push({ index: s.index, status: s.status, l1, l2, r1, r2 });
        } else {
          out.push({ index: s.index, status: s.status, l1, l2 });
        }
      }
      setRibbons(out);
    });
  }, [props.left, props.right, props.stages]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the signal to re-measure after scrolling or a new result.
  useLayoutEffect(() => {
    measure();
  }, [measure, props.tick]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const W = 56;
  const colour = (s: StageResult['status']): string => (s === 'exact' ? 'var(--exact)' : s === 'check' ? 'var(--check)' : 'var(--blocked)');

  return (
    <div ref={box} className="relative h-full w-14 shrink-0 bg-canvas" aria-hidden="true" data-testid="seam">
      <svg width={W} height={height} className="absolute inset-0 block overflow-hidden" role="presentation">
        <title>Stage links</title>
        {ribbons.map((r) => {
          const on = props.active === r.index;
          const mid = (r.l1 + r.l2) / 2;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: the seam is aria-hidden; hover is a pointer enhancement, keyboard users have the gutter markers and notes.
            <g
              key={r.index}
              onMouseEnter={() => props.onActivate(r.index)}
              onMouseLeave={() => props.onActivate(undefined)}
              className="ribbon"
              data-stage={r.index}
              data-status={r.status}
            >
              {r.r1 !== undefined && r.r2 !== undefined ? (
                <path
                  d={`M0 ${r.l1} C ${W / 2} ${r.l1}, ${W / 2} ${r.r1}, ${W} ${r.r1} L ${W} ${r.r2} C ${W / 2} ${r.r2}, ${W / 2} ${r.l2}, 0 ${r.l2} Z`}
                  fill={colour(r.status)}
                  fillOpacity={on ? 0.32 : 0.14}
                  stroke={colour(r.status)}
                  strokeOpacity={on ? 0.9 : 0.35}
                  strokeWidth={1}
                  style={{ transition: 'fill-opacity 120ms, stroke-opacity 120ms' }}
                />
              ) : null}
              <text x={10} y={mid + 4} fontSize={12} fill={colour(r.status)} textAnchor="middle">
                {STATUS_MARK[r.status]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
