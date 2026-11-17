/**
 * A Splunk dashboard reduced to what a Dynatrace dashboard can express: inputs, panels with their
 * searches, and where each panel sits. Both readers (Simple XML and Dashboard Studio) produce this;
 * the converter works from it alone. See docs/spec/dashboards.md.
 */

export type InputKind = 'dropdown' | 'radio' | 'multiselect' | 'checkbox' | 'text' | 'time' | 'link';

export interface DashboardSearch {
  spl: string;
  /** Panel time range as written: a literal such as "-24h@h", or a token such as "$time.earliest$". */
  earliest?: string;
  latest?: string;
}

export interface DashboardInput {
  /** Token name without the dollar signs. */
  token: string;
  kind: InputKind;
  label?: string;
  /** Static choices. */
  choices: { label: string; value: string }[];
  /** Search that fills the choices, and the result field holding the value. */
  search?: DashboardSearch;
  valueField?: string;
  defaultValue?: string;
  /** Default range of a time input. */
  earliest?: string;
  latest?: string;
  /**
   * Set when the input wraps each value as `field="value"`, so the token is a complete condition on
   * one field instead of a bare value.
   */
  filterField?: string;
}

export type PanelKind = 'chart' | 'table' | 'single' | 'event' | 'map' | 'text' | 'custom';

export interface DashboardPanel {
  kind: PanelKind;
  title?: string;
  description?: string;
  /** Splunk chart type for `chart` panels: line, area, column, bar, pie, scatter, bubble, a gauge. */
  chartType?: string;
  search?: DashboardSearch;
  /** A saved search the panel refers to by name instead of carrying a search. */
  savedSearch?: string;
  /** Why the panel's search was not read: built from too many base searches, or too long once joined. */
  unreadable?: string;
  /** Text of an HTML or Markdown panel, already reduced to Markdown. */
  text?: string;
  /** Things the panel had that a Dynatrace tile cannot carry (drilldown, visibility rules …). */
  dropped: string[];
  /** Simple XML places panels in rows; `span` is how many panels share the row. */
  row?: { index: number; column: number; span: number; stack: number };
  /** Dashboard Studio places panels by pixels on a canvas. */
  box?: { x: number; y: number; w: number; h: number; canvas: number };
}

export interface DashboardModel {
  format: 'simple-xml' | 'dashboard-studio';
  title: string;
  description?: string;
  inputs: DashboardInput[];
  panels: DashboardPanel[];
  /** Dashboard-level features that were left out. */
  dropped: string[];
}

export class DashboardError extends Error {}
