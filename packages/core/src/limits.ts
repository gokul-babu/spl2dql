/**
 * Work and output budgets (ADR-029). Going over one is a diagnostic, a stage that is not
 * translated or a manual tile; it is never an exception that reaches the caller.
 */

/** Characters of SPL in one translation, after macro expansion. */
export const MAX_INPUT = 1_000_000;
/** Characters of printed DQL of one translation. */
export const MAX_OUTPUT = 1_000_000;
/** `foreach`: listed fields × template length, in characters. */
export const MAX_FOREACH = 200_000;
/** Diagnostics kept for one translation; one closing note says when more were left out. */
export const MAX_DIAGNOSTICS = 10_000;
/** Characters of SPL translated for one dashboard, panels and inputs together. */
export const MAX_DASHBOARD_SPL = 5_000_000;
/** Characters of DQL kept for one dashboard, panels and inputs together. */
export const MAX_DASHBOARD_DQL = 5_000_000;
/** Inputs read from one dashboard. */
export const MAX_DASHBOARD_INPUTS = 500;
/** Base searches (Simple XML) or chained data sources (Dashboard Studio) followed for one search. */
export const MAX_BASE_CHAIN = 20;
