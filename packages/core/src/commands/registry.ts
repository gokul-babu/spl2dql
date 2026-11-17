import { combineCommands } from './combine.ts';
import { extractCommands } from './extract.ts';
import { fieldsCommands } from './fields.ts';
import { abstractCmd, evalCmd, fieldformat, highlight, iconify, regex, returnCmd, search, where } from './filter.ts';
import { generatingCommands, notTranslatedCommands } from './generating.ts';
import { orderCommands } from './order.ts';
import { statsCommands } from './stats.ts';
import type { CommandDef, Tier } from './types.ts';

const ALL: readonly CommandDef[] = [
  search,
  where,
  evalCmd,
  regex,
  fieldformat,
  highlight,
  iconify,
  abstractCmd,
  returnCmd,
  ...fieldsCommands,
  ...statsCommands,
  ...orderCommands,
  ...extractCommands,
  ...combineCommands,
  ...generatingCommands,
  ...notTranslatedCommands,
];

const BY_NAME: ReadonlyMap<string, CommandDef> = (() => {
  const map = new Map<string, CommandDef>();
  for (const def of ALL) {
    for (const name of [def.name, ...(def.aliases ?? [])]) {
      if (map.has(name)) throw new Error(`Duplicate command ${name}`);
      map.set(name, def);
    }
  }
  return map;
})();

export function getCommand(name: string): CommandDef | undefined {
  return BY_NAME.get(name.toLowerCase());
}

export interface CommandSupport {
  name: string;
  aliases: readonly string[];
  tier: Tier;
  summary: string;
}

/** The support matrix, alphabetical. Drives the Reference page and `spl2dql commands`. */
export function listCommands(): CommandSupport[] {
  return ALL.map((d) => ({ name: d.name, aliases: d.aliases ?? [], tier: d.tier, summary: d.summary })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
