/**
 * A small XML reader for Splunk dashboard files. No DOM, no dependencies. It reads elements,
 * attributes, text and CDATA; it never resolves a DTD or an external entity, so a crafted file
 * cannot make it read anything else or expand without bound.
 */

export interface XmlNode {
  name: string;
  attrs: ReadonlyMap<string, string>;
  children: XmlNode[];
  /** The element's own text (its direct text and CDATA, without child elements), trimmed. */
  text: string;
  /** Text and child elements in document order, for mixed content such as HTML. */
  content: (string | XmlNode)[];
}

export class XmlError extends Error {}

const MAX_DEPTH = 100;
const MAX_NODES = 200_000;
const NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/y;
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** Parses a document and returns its root element. Throws XmlError with a plain message. */
export function parseXml(text: string): XmlNode {
  let i = 0;
  let nodes = 0;
  const n = text.length;
  const fail = (message: string): never => {
    throw new XmlError(`${message} (line ${lineOf(text, i)}).`);
  };

  const skipMisc = (): void => {
    for (;;) {
      while (i < n && /\s/.test(text[i] as string)) i++;
      if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i);
        if (end === -1) fail('A processing instruction is not closed');
        i = end + 2;
      } else if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i);
        if (end === -1) fail('A comment is not closed');
        i = end + 3;
      } else if (text.startsWith('<!DOCTYPE', i)) {
        // The declaration is skipped as a whole; nothing in it is used.
        let depth = 0;
        for (; i < n; i++) {
          if (text[i] === '[') depth++;
          else if (text[i] === ']') depth--;
          else if (text[i] === '>' && depth <= 0) break;
        }
        if (i >= n) fail('The DOCTYPE is not closed');
        i++;
      } else {
        return;
      }
    }
  };

  const readName = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(text);
    if (!m) return fail('Expected a name');
    i += m[0].length;
    return m[0];
  };

  const element = (depth: number): XmlNode => {
    if (depth > MAX_DEPTH) fail('The document is nested too deeply');
    if (++nodes > MAX_NODES) fail('The document has too many elements');
    i++; // "<"
    const name = readName();
    const attrs = new Map<string, string>();
    for (;;) {
      while (i < n && /\s/.test(text[i] as string)) i++;
      const c = text[i];
      if (c === '/' && text[i + 1] === '>') {
        i += 2;
        return { name, attrs, children: [], text: '', content: [] };
      }
      if (c === '>') {
        i++;
        break;
      }
      if (c === undefined) fail(`<${name}> is not closed`);
      const key = readName();
      while (i < n && /\s/.test(text[i] as string)) i++;
      if (text[i] !== '=') fail(`Attribute ${key} has no value`);
      i++;
      while (i < n && /\s/.test(text[i] as string)) i++;
      const q = text[i];
      if (q !== '"' && q !== "'") fail(`The value of ${key} must be quoted`);
      const end = text.indexOf(q as string, i + 1);
      if (end === -1) fail(`The value of ${key} is not closed`);
      attrs.set(key, decode(text.slice(i + 1, end)));
      i = end + 1;
    }
    const children: XmlNode[] = [];
    const content: (string | XmlNode)[] = [];
    let own = '';
    const addText = (piece: string): void => {
      own += piece;
      if (piece.trim() !== '') content.push(piece);
    };
    for (;;) {
      if (i >= n) fail(`<${name}> is not closed`);
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i);
        if (end === -1) fail('A CDATA section is not closed');
        addText(text.slice(i + 9, end));
        i = end + 3;
      } else if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i);
        if (end === -1) fail('A comment is not closed');
        i = end + 3;
      } else if (text.startsWith('</', i)) {
        i += 2;
        const close = readName();
        if (close !== name) fail(`</${close}> does not match <${name}>`);
        while (i < n && /\s/.test(text[i] as string)) i++;
        if (text[i] !== '>') fail(`</${name}> is not closed`);
        i++;
        return { name, attrs, children, text: own.trim(), content };
      } else if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i);
        if (end === -1) fail('A processing instruction is not closed');
        i = end + 2;
      } else if (text[i] === '<') {
        const el = element(depth + 1);
        children.push(el);
        content.push(el);
      } else {
        const next = text.indexOf('<', i);
        const stop = next === -1 ? n : next;
        addText(decode(text.slice(i, stop)));
        i = stop;
      }
    }
  };

  skipMisc();
  if (text[i] !== '<') fail('This is not an XML document');
  const root = element(0);
  skipMisc();
  if (i < n) fail('Unexpected text after the root element');
  return root;
}

/** The five predefined entities and numeric character references; anything else stays as written. */
function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES.get(body) ?? whole;
  });
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The first child with this name. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** The text of the first child with this name, or undefined when it is missing or empty. */
export function childText(node: XmlNode, name: string): string | undefined {
  const t = child(node, name)?.text;
  return t === undefined || t === '' ? undefined : t;
}

/** All text below a node, in document order (for `<html>` panels). */
export function deepText(node: XmlNode): string {
  return [node.text, ...node.children.map(deepText)].filter((t) => t !== '').join(' ');
}
