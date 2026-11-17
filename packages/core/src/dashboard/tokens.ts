/**
 * Dashboard tokens → Dynatrace dashboard variables, as a pass over the DQL AST
 * (docs/spec/dashboards.md §5). The lowering keeps `$tok$` as ordinary text; this pass replaces each
 * place where a token stands for a whole value with a variable reference. A token that is only part
 * of a value stays as text and is reported by the caller (SPL4009).
 */
import { bin, bool as boolLit, call, type DqlCommand, type DqlExpr, named, variable } from '../dql/ast.ts';
import type { DashboardToken, FieldType } from '../types.ts';

export interface TokenPass {
  /** Variable keys the query now refers to. */
  used: Set<string>;
  /** Variables that choose a field name; their values must be Grail field names. */
  fieldChoosers: Set<string>;
}

const WHOLE = /^\$([A-Za-z_][A-Za-z0-9_.]*)\$$/;
const WILD = /^(\*?)\$([A-Za-z_][A-Za-z0-9_.]*)\$(\*?)$/;
const ORDER = new Set(['<', '<=', '>', '>=']);

/** Looks a token up by name; `form.x` is the same token as `x`. */
export function findToken(tokens: ReadonlyMap<string, DashboardToken>, name: string): DashboardToken | undefined {
  return tokens.get(name) ?? (name.startsWith('form.') ? tokens.get(name.slice(5)) : undefined);
}

export function applyTokens(
  commands: DqlCommand[],
  tokens: ReadonlyMap<string, DashboardToken>,
  fieldType: (dqlName: string) => FieldType | undefined,
): TokenPass {
  const pass: TokenPass = { used: new Set(), fieldChoosers: new Set() };

  const whole = (e: DqlExpr | undefined): DashboardToken | undefined => {
    if (e?.k !== 'str') return undefined;
    const m = WHOLE.exec(e.v);
    const t = m ? findToken(tokens, m[1] as string) : undefined;
    return t && t.kind !== 'time' ? t : undefined;
  };
  const use = (t: DashboardToken, mod?: 'noquote' | 'backtick' | 'triplequote'): DqlExpr => {
    pass.used.add(t.variable);
    return variable(t.variable, mod);
  };
  const isNumber = (e: DqlExpr): boolean => e.k === 'field' && fieldType(e.name) === 'number';

  const expr = (e: DqlExpr): DqlExpr => {
    switch (e.k) {
      case 'str': {
        const t = whole(e);
        return t ? use(t) : e;
      }
      case 'field': {
        const m = WHOLE.exec(e.name);
        const t = m ? findToken(tokens, m[1] as string) : undefined;
        if (!t || t.kind === 'time') return e;
        pass.fieldChoosers.add(t.variable);
        return use(t, 'backtick');
      }
      case 'call': {
        const [a, b] = e.args;
        if (e.args.length === 2 && a?.kind === 'pos' && b?.kind === 'pos' && b.value.k === 'str') {
          const target = expr(a.value);
          const t = whole(b.value);
          if (e.fn === 'matchesValue' && t) {
            if (t.kind === 'multiple') return call('in', target, call('array', use(t)));
            // A number field cannot be matched as text; compare it with the bare value.
            return isNumber(target) ? bin('==', target, use(t, 'noquote')) : call('matchesValue', target, use(t));
          }
          if (e.fn === 'matchesPhrase' && t) return call('matchesPhrase', target, use(t, 'triplequote'));
          const wild = e.fn === 'matchesValue' ? WILD.exec(b.value.v) : null;
          const wt = wild ? findToken(tokens, wild[2] as string) : undefined;
          if (wild && wt && wt.kind !== 'time' && wt.kind !== 'multiple' && (wild[1] !== '' || wild[3] !== '')) {
            const fn = wild[1] !== '' && wild[3] !== '' ? 'contains' : wild[1] !== '' ? 'endsWith' : 'startsWith';
            return call(fn, target, use(wt), named('caseSensitive', boolLit(false)));
          }
        }
        return { ...e, args: e.args.map((arg) => ({ ...arg, value: expr(arg.value) })) };
      }
      case 'bin': {
        const lt = whole(e.l);
        const rt = whole(e.r);
        if (rt && !lt) {
          const l = expr(e.l);
          return bin(e.op, l, use(rt, ORDER.has(e.op) || isNumber(l) ? 'noquote' : undefined));
        }
        if (lt && !rt) {
          const r = expr(e.r);
          return bin(e.op, use(lt, ORDER.has(e.op) || isNumber(r) ? 'noquote' : undefined), r);
        }
        return { ...e, l: expr(e.l), r: expr(e.r) };
      }
      case 'un':
        return { ...e, e: expr(e.e) };
      case 'block':
        return { ...e, items: e.items.map(expr) };
      case 'assign':
      case 'dir':
      case 'index':
      case 'align':
        return { ...e, e: expr(e.e) };
      case 'sub':
        return { ...e, q: { commands: e.q.commands.map(command) } };
      case 'var':
        pass.used.add(e.name);
        return e;
      default:
        return e;
    }
  };
  const command = (c: DqlCommand): DqlCommand => (c.name === '//' ? c : { ...c, args: c.args.map((arg) => ({ ...arg, value: expr(arg.value) })) });

  for (let i = 0; i < commands.length; i++) commands[i] = command(commands[i] as DqlCommand);
  return pass;
}

/** Tokens still written as `$name$` in a piece of text (DQL or SPL). */
export function leftoverTokens(text: string): string[] {
  return [...new Set([...text.matchAll(/\$[A-Za-z_][A-Za-z0-9_.]*(?:\|[A-Za-z]+)?\$/g)].map((m) => m[0]))];
}
