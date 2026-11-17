import { MAX_DIAGNOSTICS } from '../limits.ts';
import type { Diagnostic, Span } from '../types.ts';
import { getDiagnosticDoc } from './registry.ts';

export interface ReportOptions {
  /** Adds to the catalogue title; becomes the occurrence's message. */
  detail?: string;
  /** Environment name the note is about. Notes with the same code and subject are reported once. */
  subject?: string;
}

/**
 * Collects diagnostics for one translation. Commands never throw for user input; they report here.
 */
export class DiagnosticCollector {
  readonly items: Diagnostic[] = [];
  private readonly seen = new Set<string>();
  private readonly strict: boolean;
  private capped = false;

  /** Maps spans of the expanded text back to the original input (macro expansion). */
  mapSpan: (span: Span) => Span = (span) => span;

  constructor(strict: boolean) {
    this.strict = strict;
  }

  report(code: string, span: Span, stageIndex: number, options: ReportOptions = {}): void {
    const doc = getDiagnosticDoc(code);
    const key = options.subject !== undefined ? `${code}\u0000${options.subject}` : undefined;
    if (key !== undefined) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const severity = this.strict && code.startsWith('SPL4') ? 'error' : doc.severity;
    const diagnostic: Diagnostic = {
      code,
      severity,
      message: options.detail ? `${options.detail}` : doc.title,
      hint: doc.hint,
      span: this.mapSpan(span),
      stageIndex,
    };
    if (options.subject !== undefined) diagnostic.subject = options.subject;
    this.add(diagnostic);
  }

  /**
   * Keeps a finished diagnostic. Past MAX_DIAGNOSTICS the rest are dropped and one closing note
   * (SPL1006, an error, so the result never looks better than the notes it lost) says so.
   */
  add(diagnostic: Diagnostic): void {
    if (this.items.length < MAX_DIAGNOSTICS) {
      this.items.push(diagnostic);
      return;
    }
    if (this.capped) return;
    this.capped = true;
    const doc = getDiagnosticDoc('SPL1006');
    this.items.push({
      code: 'SPL1006',
      severity: doc.severity,
      message: `The search produced more than ${MAX_DIAGNOSTICS} notes; the rest were left out.`,
      hint: doc.hint,
      span: diagnostic.span,
      stageIndex: diagnostic.stageIndex,
    });
  }

  /** Reports a code once per query regardless of subject. */
  reportOnce(code: string, span: Span, stageIndex: number, detail?: string): void {
    this.report(code, span, stageIndex, detail === undefined ? { subject: '' } : { subject: '', detail });
  }
}
