import type { Diagnostic } from './types.ts';

/** Environment names a set of translations could not resolve, grouped for a mapping skeleton. */
export interface MappingNeeds {
  indexes: string[];
  sourcetypes: string[];
  fields: string[];
  macros: string[];
  lookups: string[];
  eventtypes: string[];
  metrics: string[];
  /** Data model → the fields the searches read from it. */
  datamodels: { name: string; fields: string[] }[];
}

/**
 * Collects the SPL4xxx subjects from translation diagnostics. Used by `spl2dql mapping init` and the
 * Mapping view to list what still needs a mapping entry.
 */
export function collectMappingNeeds(diagnostics: Iterable<Diagnostic>): MappingNeeds {
  const sets = {
    indexes: new Set<string>(),
    sourcetypes: new Set<string>(),
    fields: new Set<string>(),
    macros: new Set<string>(),
    lookups: new Set<string>(),
    eventtypes: new Set<string>(),
    metrics: new Set<string>(),
  };
  const models = new Map<string, Set<string>>();
  const model = (name: string): Set<string> => {
    const existing = models.get(name);
    if (existing) return existing;
    const created = new Set<string>();
    models.set(name, created);
    return created;
  };
  for (const d of diagnostics) {
    const s = d.subject;
    if (s === undefined || s === '' || s === '(none)') continue;
    switch (d.code) {
      case 'SPL4001':
        sets.indexes.add(s);
        break;
      case 'SPL4002':
        if (s !== 'sourcetype') sets.sourcetypes.add(s.replace(/^sourcetype=/, ''));
        break;
      case 'SPL4003': {
        const dm = /^datamodel:([^:]+):(.+)$/.exec(s);
        if (dm) model(dm[1] as string).add(dm[2] as string);
        else sets.fields.add(s);
        break;
      }
      case 'SPL4004':
        sets.macros.add(s);
        break;
      case 'SPL4005':
        sets.lookups.add(s);
        break;
      case 'SPL4006':
        sets.eventtypes.add(s);
        break;
      case 'SPL4007':
        sets.metrics.add(s);
        break;
      case 'SPL4008':
        if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s)) model(s);
        break;
      default:
        break;
    }
  }
  const sorted = (x: Set<string>): string[] => [...x].sort();
  return {
    indexes: sorted(sets.indexes),
    sourcetypes: sorted(sets.sourcetypes),
    fields: sorted(sets.fields),
    macros: sorted(sets.macros),
    lookups: sorted(sets.lookups),
    eventtypes: sorted(sets.eventtypes),
    metrics: sorted(sets.metrics),
    datamodels: [...models.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, fields]) => ({ name, fields: sorted(fields) })),
  };
}
