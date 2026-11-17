/**
 * @spl2dql/core — offline translator from Splunk SPL searches to Dynatrace DQL queries.
 * No runtime dependencies, no I/O, no network. Runs in browsers, workers and Node.
 */

export { type CommandSupport, listCommands } from './commands/registry.ts';
export {
  type ConvertOptions,
  convertDashboard,
  convertDashboardSource,
  type DashboardConversion,
  type DashboardSource,
  type DynatraceDashboard,
  readDashboard,
  type TileOutcome,
  type TileReport,
  type VariableReport,
} from './dashboard/convert.ts';
export { DashboardError, type DashboardInput, type DashboardModel, type DashboardPanel, type DashboardSearch } from './dashboard/model.ts';
export { allDiagnosticDocs, type DiagnosticDoc, explainDiagnostic } from './diagnostics/registry.ts';
export { DQL_COMMANDS, DQL_FUNCTIONS } from './dql/catalog.generated.ts';
export { checkDqlExpression, checkDqlSyntax, type SyntaxCheckResult, type SyntaxIssue } from './dql/check.ts';
export { type DqlToken, type DqlTokenType, tokenizeDql } from './dql/lexer.ts';
export { type ConfStanza, parseConf } from './io/conf.ts';
export { InputError, parseCsv, parseCsvSearches, parseSavedSearches, type SearchInput, safeFileName } from './io/inputs.ts';
export {
  type ConfigFile,
  type ConfigImport,
  type ConfigKind,
  configKind,
  type ImportNote,
  importSplunkConfig,
  type MappingSections,
  mergeMappingSections,
} from './io/splunk-config.ts';
export { MAX_INPUT, MAX_OUTPUT } from './limits.ts';
export { regexToDpl } from './lower/regex.ts';
export { emptyMapping, parseMappingConfig } from './mapping/config.ts';
export { collectMappingNeeds, type MappingNeeds } from './needs.ts';
export { highlightSpl, type SplToken, type SplTokenType } from './spl/highlight.ts';
export { expandedLength, translate, translateCondition } from './translate.ts';
export type {
  Confidence,
  DashboardToken,
  DatamodelMapping,
  Diagnostic,
  FieldType,
  MappingConfig,
  MappingIssue,
  Result,
  ResultShape,
  Severity,
  Span,
  StageResult,
  StageStatus,
  TimeRange,
  TranslateOptions,
  TranslateResult,
} from './types.ts';

/** The release version. A test keeps it equal to the version in package.json. */
export const VERSION = '0.1.2';
