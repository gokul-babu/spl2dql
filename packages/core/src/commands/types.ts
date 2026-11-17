import type { Stage } from '../lower/context.ts';

export type Tier = 'T1' | 'T2' | 'T3';

/** One SPL command. `lower` reads its arguments with `st.scanner()` and emits DQL commands. */
export interface CommandDef {
  name: string;
  aliases?: readonly string[];
  /** Best case, per docs/spec/spl-dql-mapping.md. */
  tier: Tier;
  /** One line for the Reference page and `spl2dql commands`. */
  summary: string;
  /** Can start a search after a leading pipe: `| inputlookup t`. */
  generating?: boolean;
  lower(st: Stage): void;
}

/** A command that is recognised but never translated. */
export function notTranslated(name: string, code: string, summary: string, aliases: readonly string[] = [], generating = false): CommandDef {
  return {
    name,
    aliases,
    tier: 'T3',
    summary,
    generating,
    lower(st) {
      st.giveUp(code, summary);
    },
  };
}
