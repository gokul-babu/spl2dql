import type { Severity } from '../types.ts';

export interface DiagnosticDoc {
  code: string;
  severity: Severity;
  /** One-line meaning, used as the message when an occurrence adds no detail. */
  title: string;
  /** What the person migrating should do. */
  hint: string;
}

const E: Severity = 'error';
const W: Severity = 'warning';
const I: Severity = 'info';

function d(code: string, severity: Severity, title: string, hint: string): DiagnosticDoc {
  return { code, severity, title, hint };
}

/** The diagnostic catalogue. Codes and severities follow docs/spec/spl-dql-mapping.md §2. */
const DOCS: readonly DiagnosticDoc[] = [
  d('SPL1001', E, 'This part of the search could not be read.', 'Check for an unterminated string or an unbalanced bracket.'),
  d('SPL1002', E, 'The search or one of its stages is empty.', 'Remove the empty stage or the extra pipe.'),
  d('SPL1003', E, "The command's arguments could not be read.", "Compare the stage with Splunk's Search Reference for this command."),
  d('SPL1004', E, 'An expression could not be read.', 'Check operators, parentheses and quotes in the expression.'),
  d('SPL1005', E, 'A macro could not be expanded.', 'Check the macro definition in the mapping file for cycles and the number of arguments.'),
  d('SPL1006', E, 'The search is too large or too deeply nested to translate.', 'Split the search, or reduce nesting of subsearches and parentheses.'),
  d('SPL1007', E, 'The search has no data source DQL can start from.', 'Start the search with an index, a lookup or another generating command.'),
  d('SPL1008', E, 'The translator hit an internal problem with this search.', 'Please report the search (with sensitive values removed) so it can be fixed.'),
  d('SPL2001', W, 'This command is not known to the translator.', 'If it is a custom command, rewrite this stage by hand.'),
  d('SPL2002', W, 'This command has no DQL equivalent.', 'Rewrite this stage by hand; the rest of the query is still translated.'),
  d('SPL2003', W, 'An argument or option is not supported.', 'Check whether the option matters for your result.'),
  d('SPL2004', W, 'This eval function has no DQL equivalent.', 'Rewrite the expression by hand.'),
  d('SPL2005', W, 'This aggregation function has no DQL equivalent.', 'Rewrite the aggregation by hand or remove it.'),
  d('SPL2006', W, 'This regular expression cannot be converted to a Dynatrace pattern.', 'Write the parse pattern by hand.'),
  d('SPL2007', W, 'This subsearch form cannot be translated.', 'Rewrite the subsearch as a join or a filter by hand.'),
  d(
    'SPL2008',
    W,
    'This command writes data or sends something; it was dropped.',
    'Recreate the side effect in Dynatrace (workflow, lookup upload) if you still need it.',
  ),
  d('SPL2009', W, 'A wildcard field list needs the list of fields, which is not known here.', 'List the fields explicitly.'),
  d('SPL2010', W, 'This command depends on the order of result rows, which DQL does not provide.', 'Rewrite this stage by hand.'),
  d('SPL2011', W, 'Real-time and index-time modifiers have no DQL equivalent.', 'Use a normal time range.'),
  d(
    'SPL2012',
    W,
    'A field name contains a backtick or a line break, which DQL cannot hold.',
    'Rename the field in Splunk to a name without backticks or line breaks, or rewrite this stage by hand.',
  ),
  d('SPL3001', W, 'Case sensitivity differs from Splunk here.', 'Values that differ only in case will not match.'),
  d('SPL3002', W, 'Missing or empty fields are handled differently.', 'Check rows where the field is missing.'),
  d('SPL3003', W, 'The result has a different shape than in Splunk.', 'Check how the result is charted or used afterwards.'),
  d('SPL3004', W, 'The result depends on record order, which DQL does not guarantee here.', 'Add an explicit sort if order matters.'),
  d('SPL3005', W, 'This aggregation may be computed differently (exact or approximate).', 'Expect small numeric differences.'),
  d('SPL3006', W, 'Values may be compared as a different type than in Splunk.', 'Declare the field type in the mapping file (fieldTypes).'),
  d('SPL3007', W, 'An index position was adjusted from 1-based to 0-based.', 'Check the result for an off-by-one difference.'),
  d('SPL3008', W, 'A regular expression was converted to a Dynatrace pattern.', 'Check the extracted values on real data.'),
  d('SPL3009', W, 'Splunk applies a default limit here that DQL does not.', 'Add an explicit limit if you relied on it.'),
  d('SPL3010', W, 'Time zone or time format handling may differ.', 'Check timestamps in the result.'),
  d('SPL3011', W, 'Wildcard or token matching differs from Splunk.', 'Check matches on real data.'),
  d('SPL3012', W, 'Part of the query runs twice inside a sub-query.', 'Expect higher query cost; both runs may see slightly different data.'),
  d('SPL3013', W, 'Multivalue fields behave differently.', 'Check rows where a field has several values.'),
  d('SPL3014', W, 'This command was approximated with a different construct.', 'Check the result carefully.'),
  d('SPL3015', W, 'The time range could not be reproduced exactly.', 'Set the time range in Dynatrace.'),
  d('SPL3016', W, 'Output field names differ from Splunk.', 'Rename fields if later steps rely on the Splunk names.'),
  d('SPL3017', W, 'The generated DQL did not pass the offline syntax check.', 'Check the highlighted line; this may need a manual fix.'),
  d('SPL4001', W, 'This index has no entry in the mapping file.', 'Add the index under "indexes" in the mapping file.'),
  d('SPL4002', W, 'This sourcetype has no entry in the mapping file.', 'Add the sourcetype under "sourcetypes" in the mapping file.'),
  d(
    'SPL4003',
    W,
    'This field probably comes from Splunk search-time extraction and does not exist in Grail.',
    'Map it under "fields" or "extractions" in the mapping file.',
  ),
  d('SPL4004', W, 'This macro has no definition in the mapping file.', 'Copy its definition from macros.conf into "macros".'),
  d('SPL4005', W, 'This lookup has no entry in the mapping file.', 'Upload the table to Grail and add it under "lookups".'),
  d('SPL4006', W, 'This eventtype, tag or saved search cannot be resolved.', 'Add it under "eventtypes" or "tags" in the mapping file.'),
  d('SPL4007', W, 'This metric has no entry in the mapping file.', 'Add it under "metrics" in the mapping file.'),
  d(
    'SPL4008',
    W,
    'This data model has no entry in the mapping file.',
    'Add it under "datamodels" in the mapping file: where its data is in Grail and what its fields are called there.',
  ),
  d(
    'SPL4009',
    W,
    'The search contains a dashboard token, which was kept as plain text.',
    'Replace the token with a Dynatrace dashboard variable, or with a real value.',
  ),
  d('SPL5001', I, 'The search has no time range; DQL uses the time range chosen in Dynatrace.', 'Add from: to the fetch if the time range matters.'),
  d('SPL5002', I, 'Splunk default fields were renamed to their Grail names.', 'No action needed.'),
  d('SPL5003', I, 'Rows with an empty group-by field are removed first, as Splunk does.', 'No action needed.'),
  d('SPL5004', I, 'A sort by time was added to reproduce Splunk event order.', 'No action needed.'),
  d('SPL5005', I, 'A macro was expanded.', 'No action needed.'),
  d('SPL5006', I, "Splunk's default result limit is not reproduced; DQL returns at most 1000 records by default.", 'Add a limit if needed.'),
  d('SPL5007', I, 'A display-only command was dropped; it does not change the data.', 'No action needed.'),
  d('SPL5008', I, 'This is accurate but can be expensive on large data.', 'Consider an approximate function if exactness does not matter.'),
];

const BY_CODE: ReadonlyMap<string, DiagnosticDoc> = new Map(DOCS.map((doc) => [doc.code, doc]));

export function getDiagnosticDoc(code: string): DiagnosticDoc {
  const doc = BY_CODE.get(code);
  if (!doc) throw new Error(`Unregistered diagnostic code ${code}`);
  return doc;
}

export function isRegisteredCode(code: string): boolean {
  return BY_CODE.has(code);
}

export function allDiagnosticDocs(): readonly DiagnosticDoc[] {
  return DOCS;
}

/** Explains a code for `spl2dql explain` and the Reference page. Returns undefined for unknown codes. */
export function explainDiagnostic(code: string): DiagnosticDoc | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}
