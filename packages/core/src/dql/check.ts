import type { Span } from '../types.ts';
import { dict } from '../util/dict.ts';
import { DQL_COMMANDS, DQL_FUNCTIONS } from './catalog.generated.ts';
import { tokenizeDql } from './lexer.ts';
import { type ParseOutcome, parseDqlExpression, parseDqlQuery } from './parser.ts';

export interface SyntaxIssue {
  severity: 'error' | 'warning';
  message: string;
  /** Offsets into the checked DQL text. */
  span: Span;
}

export interface SyntaxCheckResult {
  ok: boolean;
  issues: SyntaxIssue[];
}

/**
 * Offline syntax check ("Syntax check (offline)" in the UI). It knows DQL's commands, functions
 * and their named parameters from the vendored reference. It cannot know whether fields or buckets
 * exist; only a tenant can say a query is valid.
 */
export function checkDqlSyntax(text: string): SyntaxCheckResult {
  return judge(parseDqlQuery(text));
}

/** Checks one DQL expression, e.g. a filter from the mapping file. Pipes are not allowed. */
export function checkDqlExpression(text: string): SyntaxCheckResult {
  const result = judge(parseDqlExpression(text));
  // A comment would swallow whatever is printed after the expression on the same line.
  const comment = tokenizeDql(text).find((t) => t.type === 'comment');
  if (!comment) return result;
  return { ok: false, issues: [...result.issues, { severity: 'error', message: 'Comments are not allowed here.', span: comment.span }] };
}

/**
 * Parameters Dynatrace documents that the vendored reference does not list. Every entry must cite
 * its source. Empty today: the reference covers everything the translator emits.
 */
const EXTRA_FUNCTION_PARAMS: Readonly<Record<string, readonly string[]>> = dict({});

function judge(outcome: ParseOutcome): SyntaxCheckResult {
  const issues: SyntaxIssue[] = [];
  if (outcome.error) {
    issues.push({ severity: 'error', message: outcome.error.message, span: outcome.error.span });
  }
  for (const command of outcome.commands) {
    const params = Object.hasOwn(DQL_COMMANDS, command.name) ? DQL_COMMANDS[command.name] : undefined;
    if (!params) {
      issues.push({ severity: 'error', message: `Unknown command "${command.name}".`, span: command.span });
      continue;
    }
    for (const n of command.named) {
      if (!params.includes(n.name)) {
        issues.push({
          severity: 'error',
          message: `"${command.name}" has no parameter "${n.name}".`,
          span: n.span,
        });
      }
    }
  }
  for (const call of outcome.calls) {
    if (!Object.hasOwn(DQL_FUNCTIONS, call.fn)) {
      issues.push({ severity: 'error', message: `Unknown function "${call.fn}".`, span: call.span });
      continue;
    }
    const params = [...(DQL_FUNCTIONS[call.fn] ?? []), ...(EXTRA_FUNCTION_PARAMS[call.fn] ?? [])];
    for (const n of call.named) {
      if (!params.includes(n.name)) {
        issues.push({ severity: 'error', message: `"${call.fn}" has no parameter "${n.name}".`, span: n.span });
      }
    }
  }
  issues.sort((a, b) => a.span.start - b.span.start);
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}
