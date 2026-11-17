/**
 * Markdown tiles (ADR-029, third round). The rules are properties of the output, checked here by a
 * plain scan of every tile the converter writes, through every sink that carries Splunk text:
 *
 *   1. outside an indented code block the converter wrote: no `<`, no backtick;
 *   2. the only raw `[ ] ( )` are those of a link `[label](target)` whose target passes the test;
 *      no `![`; no bare address (`://` without a backslash before it, `www.`) outside a target;
 *   3. no code spans (follows from 1); a code block always follows a line of the converter's own;
 *   4. a tile is cut at a line end, and is never longer than its limit.
 *
 * Inputs are the re-tests' (first re-test finding 1, second re-test findings A, B, C).
 */
import { convertDashboard, convertDashboardSource, type DashboardModel } from '@spl2dql/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { escapeText, isWebTarget, rebuildMarkdown, sealLine } from '../src/dashboard/markdown.ts';

/** Every way a tile's Markdown breaks the four properties; empty when it holds them all. */
function problems(md: string, limit = 12_000): string[] {
  const out: string[] = [];
  if (md.length > limit) out.push(`longer than ${limit}`);
  let previous = '';
  let inCode = false;
  for (const line of md.split('\n')) {
    // An indented code block starts after a blank line and goes on while lines are indented.
    inCode = line.startsWith('    ') && (inCode || previous === '');
    previous = line;
    if (inCode) continue;
    if (/^ {0,3}(~~~|```)/.test(line)) out.push(`opens a fence: ${line}`);
    const bad = (what: string): void => void out.push(`${what}: ${line.slice(0, 200)}`);
    // Property 1 is literal: not even an escaped "<" or backtick.
    if (line.includes('<')) bad('a "<"');
    if (line.includes('`')) bad('a backtick');
    let text = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string;
      if (c === '\\') {
        text += line.slice(i, i + 2);
        i++;
        continue;
      }
      if (c === '!' && line[i + 1] === '[') bad('an image');
      if (c === ']' || c === '(' || c === ')') bad(`a raw "${c}" outside a link`);
      if (c === '[') {
        // Only a link the converter wrote: [label](target), the label without raw brackets.
        const close = line.indexOf(']', i + 1);
        const end = close === -1 ? -1 : line.indexOf(')', close + 2);
        if (close === -1 || line[close + 1] !== '(' || end === -1 || line.slice(i + 1, close).includes('[') || !isWebTarget(line.slice(close + 2, end))) {
          bad('a raw "[" that is not a link with a valid target');
          continue;
        }
        text += line.slice(i + 1, close);
        i = end;
        continue;
      }
      text += c;
    }
    // Outside link targets, no address a renderer could link by itself.
    if (/(^|[^\\]):\/\//.test(text)) bad('a bare "://"');
    if (/www\./i.test(text)) bad('a bare "www."');
  }
  return out;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const studio = (body: Record<string, unknown>): string => JSON.stringify({ title: 'T', dataSources: {}, ...body });
const markdownViz = (markdown: string): string =>
  studio({
    visualizations: { m: { type: 'splunk.markdown', options: { markdown } } },
    layout: { structure: [{ item: 'm', type: 'block', position: { x: 0, y: 0, w: 100, h: 50 } }] },
  });

/** Every sink that carries Splunk text into a Markdown tile. */
const SINKS: Record<string, (s: string) => { name: string; text: string } | DashboardModel> = {
  'panel title': (s) => ({
    name: 'a.xml',
    text: `<dashboard><row><panel><title>${xml(s)}</title><table><search><query>index=a | zzz</query></search></table></panel></row></dashboard>`,
  }),
  'saved-search name': (s) => ({ name: 'a.xml', text: `<dashboard><row><panel><table><search ref="${xml(s)}"/></table></panel></row></dashboard>` }),
  'Simple XML description': (s) => ({
    name: 'a.xml',
    text: `<dashboard><description>${xml(s)}</description><row><panel><html>x</html></panel></row></dashboard>`,
  }),
  'Studio description': (s) => ({ name: 'a.json', text: studio({ description: s, visualizations: {} }) }),
  'Studio tab label': (s) => ({
    name: 'a.json',
    text: studio({
      visualizations: {},
      layout: {
        tabs: {
          items: [
            { layoutId: 'a', label: s },
            { layoutId: 'b', label: 'b' },
          ],
        },
        layoutDefinitions: { a: { structure: [] }, b: { structure: [] } },
      },
    }),
  }),
  '<html> text': (s) => ({ name: 'a.xml', text: `<dashboard><row><panel><html><p>${xml(s)}</p></html></panel></row></dashboard>` }),
  '<html> code': (s) => ({ name: 'a.xml', text: `<dashboard><row><panel><html><p>x<code>${xml(s)}</code></p></html></panel></row></dashboard>` }),
  '<html> heading, item, link': (s) => ({
    name: 'a.xml',
    text: `<dashboard><row><panel><html><h2>${xml(s)}</h2><ul><li>${xml(s)}</li></ul><p><a href="https://ok.example/">${xml(s)}</a><b>${xml(s)}</b></p></html></panel></row></dashboard>`,
  }),
  'text panel title only': (s) => ({ format: 'simple-xml', title: 'T', inputs: [], panels: [{ kind: 'text', title: s, dropped: [] }], dropped: [] }),
  'splunk.markdown': (s) => ({ name: 'a.json', text: markdownViz(s) }),
  'splunk.markdown heading, item, bold, fence': (s) => ({ name: 'a.json', text: markdownViz(`# ${s}\n- ${s}\n**${s}**\n\`\`\`\n${s}\n\`\`\``) }),
  'manual tile search': (s) => ({
    format: 'simple-xml',
    title: 'T',
    inputs: [],
    panels: [{ kind: 'table', title: s, dropped: [], search: { spl: `index=a | zzz ${s}` } }],
    dropped: [],
  }),
};

function tilesOf(source: { name: string; text: string } | DashboardModel): string[] {
  const c = 'format' in source ? convertDashboard(source) : convertDashboardSource(source);
  return Object.values(c.dashboard.content.tiles)
    .filter((t) => (t as { type: string }).type === 'markdown')
    .map((t) => (t as { content: string }).content);
}

function checkAllSinks(input: string): void {
  for (const [name, make] of Object.entries(SINKS)) {
    for (const md of tilesOf(make(input))) expect(problems(md), `${name}: ${md.slice(0, 300)}`).toEqual([]);
  }
}

const IMG = '<img src=x onerror=alert(1)>';
const JS = '[click](javascript:alert(1))';

/** The inputs of the re-tests, as written there. */
const FINDINGS: Record<string, string> = {
  'A: tag after an address': `https://ok.example/x<img src=x onerror="location='javascript:alert%281%29'" x=y>`,
  'A: javascript autolink after www': 'www.ok.example/x<javascript:alert%281%29//>',
  'A: data autolink after an address':
    'see http://ok.example/<svg onload="location=\'javascript:alert%281%29\'" x=y> and https://ok.example/<data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg//>',
  'A: escaped lt after an address': 'https://ok.example/x\\<img src=x onerror="location=\'javascript:alert%281%29\'" x=y>',
  'A: entity after an address': 'https://ok.example/x&lt;img src=x onerror=alert(1)&gt;',
  'A: email then tag': 'a@ok.example<img src=x onerror=alert(1) x=y>',
  'A: ftp, mailto, xmpp': 'ftp://ok.example/x<b> mailto:a@ok.example<b> xmpp:a@ok.example/x<b>',
  'B: code span after an address': `https://ok.example/x\`${IMG}\``,
  'B: code span with a javascript autolink': 'http://ok.example/`<javascript:alert(1)>`',
  'B: code span after www': `www.ok.example/x\`${IMG}\` and www.ok.example/y\`[c](javascript:alert(1))\``,
  'B: link, then code span': `[x](https://ok.example/)\`${IMG}\``,
  'B: empty-label link, then code span': `[](https://ok.example/x)\`${IMG}\``,
  'C: span cut at 8,000': `\`${IMG} ${'A'.repeat(8100)}\``,
  'C: span with link and image cut at 8,000': `\`${JS} ![i](https://evil.example/t.png) ${'A'.repeat(8100)}\``,
  'C: padding, then span': `${'B'.repeat(7900)} \`${IMG} ${'A'.repeat(300)}\``,
  'round one: fence with backtick info string': `\`\`\`x\` ${IMG}\n${JS}\n![i](https://evil.example/t.png)`,
  'round one: code span ending in backslash': `\`\\\`${IMG} ${JS}\``,
  'round one: double bang image': '!![i](https://evil.example/t.png)',
  'round one: tag in a kept link title': `[a](https://ok.example ${IMG})`,
  'cosmetic: link label that looks like a list number': '[1.](x) text',
  'entities already in the input': '&lt;b&gt; &amp;lt; &#96; &#91;x&#93;&#40;javascript:y&#41; &# &#',
  'backslash before characters now written as entities': '\\< \\` \\[a\\]\\(https://ok.example\\) \\& \\\\',
};

/** The first re-test's hand-written attacks on the Markdown, still checked. */
const ROUND_ONE: Record<string, string> = {
  'baseline html': IMG,
  'baseline js link': JS,
  'baseline image': '![i](https://evil.example/t.png)',
  'baseline autolink': '<javascript:alert(1)>',
  'baseline ref link': '[a][b]\n\n[b]: javascript:alert(1)',
  'fence inside a list item that ends': `- a\n  \`\`\`\n${IMG}\n\n${JS}`,
  'fence inside an ordered item': `1. a\n   ~~~\n${IMG}\n\n${JS}`,
  'code span paired across lines': `x \` y\n\` ${IMG} ${JS} \``,
  'link nested in a kept link': '[a](https://ok.example [b](javascript:alert(1)))',
  'image nested in a kept link': '[a](https://ok.example ![i](https://evil.example/t.png))',
  'bang, tag, bracket image': '!<x>[i](https://evil.example/t.png)',
  'double backtick parity': `\`\` \` \`\` ${IMG} \``,
  'bang dropped-link image': '![a](x)[i](https://evil.example/t.png)',
  'multi-line link': '[click](\njavascript:alert(1))',
  'multi-line tag': '<img\nsrc=x onerror=alert(1)>',
  'angle dest': '[a](<javascript:alert(1)>)',
  'entity scheme': '[a](&#106;avascript:alert(1))',
  'ref def in quote': '> [b]: javascript:alert(1)\n\n[b]',
  'escaped then tag': `\\\\${IMG}`,
  'html comment': `<!-- x --> <!--\n${IMG}\n-->`,
  cdata: `<![CDATA[${IMG}]]>`,
  'script block': '<script>\nalert(1)\n</script>',
  'setext + html': `${IMG}\n===`,
  'table cell': `| a |\n|---|\n| ${IMG} |`,
  footnote: `x[^1]\n\n[^1]: ${JS}`,
  'link in heading': `# ${JS}`,
  'lone CR': `a\r${IMG}`,
  'NUL inside tag name': '<i\u0000mg src=x onerror=alert(1)>',
  'control inside scheme': '[a](java\u0001script:alert(1))',
  'backslash before bracket': '[a\\](javascript:alert(1))',
  'kept link, quote breaks out': '[a](https://ok.example"onmouseover="alert(1))',
  'kept autolink with quote': '<https://ok.example/"onmouseover="alert(1)>',
};

describe('the four properties hold for every sink (re-test 2 findings A, B, C)', () => {
  it.each(Object.entries(FINDINGS))('%s', (_name, input) => checkAllSinks(input));
  it.each(Object.entries(ROUND_ONE))('round one: %s', (_name, input) => checkAllSinks(input));

  it('on random input made of addresses, entities, escapes, payloads and long padding', () => {
    const piece = fc.constantFrom(
      'https://ok.example/x',
      'http://ok.example/',
      'www.ok.example/x',
      'WwW.ok.example',
      'a@b.example',
      '://',
      'www.',
      '\\',
      '\\\\',
      '&',
      '&lt;',
      '&amp;',
      '&#96;',
      '&#',
      '`',
      '``',
      '```',
      '~~~',
      '[',
      ']',
      '(',
      ')',
      '<',
      '>',
      '!',
      '*',
      '_',
      '#',
      '- ',
      '1. ',
      '\n',
      ' ',
      IMG,
      JS,
      '<javascript:alert(1)>',
      '[x](https://ok.example/)',
      '![i](https://evil.example/t.png)',
      'A'.repeat(1000),
      'B'.repeat(3999),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 24 }), (parts) => checkAllSinks(parts.join(''))),
      { numRuns: 1000 },
    );
  });
});

describe('the check itself', () => {
  it('flags what the round-two converter wrote for findings A, B and C', () => {
    for (const md of [
      '### https://ok.example/x\\<img src=x onerror="location=\'javascript:alert%281%29\'" x=y\\>',
      'https://ok.example/x`<img src=x onerror=alert(1)>`',
      '`<img src=x onerror=alert(1)> AAAA…',
      'see www.ok.example/x',
      'see https://ok.example/x',
      '[a](javascript:x)',
      '\\![i](https://evil.example/t.png) ![i](https://evil.example/t.png)',
      'a\\]\\(x) ] ( )',
    ]) {
      expect(problems(md), md).not.toEqual([]);
    }
    expect(problems('Splunk search:\n\n    index=a <b> `c` [d](e)')).toEqual([]);
  });
});

describe('what the reader sees', () => {
  it('writes the characters that could start syntax as entities, and addresses unlinkable', () => {
    expect(escapeText('a<b>c `d` [e](f) & g')).toBe('a&lt;b&gt;c &#96;d&#96; &#91;e&#93;&#40;f&#41; &amp; g');
    expect(escapeText('see https://ok.example/x and www.ok.example and WWW.x')).toBe('see https\\://ok.example/x and www\\.ok.example and WWW\\.x');
    expect(escapeText('\\< &lt; &amp;lt;')).toBe('\\\\&lt; &amp;lt; &amp;amp;lt;');
    expect(escapeText('Error rate % by host_name, last 24 h. See #ops!')).toBe('Error rate % by host_name, last 24 h. See #ops\\!');
  });

  it('rebuilds the allowed constructs; code spans become text', () => {
    const md = [
      '## Authentication',
      'Failed sign-ins by **user** and _source_, see [the runbook](https://wiki.example.com/auth).',
      '',
      '- one `code` item',
      '1) two',
      '![chart](https://img.example.com/c.png) and ![local](c.png)',
      '```',
      'index=a | stats count',
      '```',
    ].join('\n');
    expect(rebuildMarkdown(md)).toBe(
      [
        '## Authentication',
        'Failed sign-ins by **user** and *source*, see [the runbook](https://wiki.example.com/auth).',
        '',
        '- one &#96;code&#96; item',
        '1. two',
        '[chart](https://img.example.com/c.png) and local',
        '',
        'index=a \\| stats count',
      ].join('\n'),
    );
    expect(rebuildMarkdown('[1.](x) text')).toBe('1\\. text');
  });

  it('cuts a text tile at a line end and says so', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(60)}`);
    const [tile] = tilesOf({ name: 'a.json', text: markdownViz(lines.join('\n')) });
    expect(tile?.length).toBeLessThanOrEqual(8000);
    const out = (tile ?? '').split('\n');
    expect(out[out.length - 1]).toBe('The rest of this text did not fit in the tile.');
    for (const l of out.slice(0, -2)) expect(lines).toContain(l);
    // A single line longer than the limit is dropped, not cut.
    const [long] = tilesOf({ name: 'a.json', text: markdownViz(`short\n${'y'.repeat(9000)}\nafter`) });
    expect(long).toBe('short\n\nThe rest of this text did not fit in the tile.');
  });

  it('is linear: 1 MB of awkward units at once', () => {
    for (const unit of ['[', '](', '`', '*_', '<a', '![', '\\`', '[a](', '(', 'www.', '://']) {
      const md = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const start = performance.now();
      const out = rebuildMarkdown(md);
      // Linear work takes about 0.2 s here and about 3 s with coverage on a shared CI machine;
      // quadratic work on 1 MB would take minutes. The limit only has to tell those apart.
      expect(performance.now() - start, unit).toBeLessThan(15_000);
      expect(problems(out, Number.POSITIVE_INFINITY)).toEqual([]);
    }
  });
});

describe('<a href> in an HTML panel (re-test finding 2)', () => {
  const content = (inner: string): string =>
    tilesOf({ name: 'a.xml', text: `<dashboard><row><panel><html><p>${inner}</p></html></panel></row></dashboard>` })[0] ?? '';

  it.each([
    ['autolink in href, trailing backslash', '<a href="https://ok.example/&lt;javascript:alert`1`&gt;\\">x</a> tail'],
    ['script in href, trailing backslash', '<a href="https://ok.example/&lt;script&gt;location=name&lt;/script&gt;\\">x</a>'],
    ['autolink in href, DEL', '<a href="https://ok.example/&#127;&lt;javascript:alert`1`&gt;">x</a> tail'],
    ['data autolink', '<a href="https://ok.example/&lt;data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==&gt;\\">x</a>'],
    ['javascript scheme', '<a href="javascript:alert(1)">x</a>'],
    ['parenthesis', '<a href="https://ok.example/a)b">x</a>'],
  ])('%s: the link becomes its text', (_name, inner) => {
    const md = content(inner);
    expect(md.startsWith('x')).toBe(true);
    expect(md).not.toContain('](');
    expect(problems(md)).toEqual([]);
  });

  it('keeps a link whose target passes', () => {
    expect(content('See <a href="https://wiki.example.com/web">the runbook</a>.')).toBe('See [the runbook](https://wiki.example.com/web).');
  });
});

describe('sealing an assembled line (third re-test, leftovers 1–3)', () => {
  it('leaves no address where two pieces meet', () => {
    // An empty link between the halves is dropped, so the halves touch.
    for (const input of [
      'https:[](x)//evil.example/x',
      'www[](x).evil.example/x',
      '[https:](x)//evil.example/x',
      'https:![](x)//evil.example/x',
      'ftp:[](x)//evil.example/x',
      'WwW[](x).evil.example',
    ]) {
      const out = rebuildMarkdown(input);
      expect(out, input).not.toMatch(/(?<!\\):\/\//);
      expect(out, input).not.toMatch(/www(?<!\\)\./i);
    }
    expect(rebuildMarkdown('//evil.example/x')).toBe('\\/\\/evil.example/x');
  });

  it('keeps the target of a link the converter wrote', () => {
    expect(rebuildMarkdown('see [the docs](https://www.example.com/a//b) at https://www.example.com')).toBe(
      'see [the docs](https://www.example.com/a//b) at https\\://www\\.example.com',
    );
  });

  it('starts no line with blanks or a list marker made by a join', () => {
    expect(rebuildMarkdown('[](x)\t<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert&#40;1&#41;&gt;');
    expect(rebuildMarkdown('- [](x)    indented')).toBe('- indented');
    expect(sealLine('1. item')).toBe('1\\. item');
  });

  it('changes nothing when applied twice, and is linear', () => {
    const lines = ['https://a.example www.b.example //c', 'a\\\\://b', '[t](https://ok.example/x) https://y', '12. x', '\\\\'.repeat(9)];
    for (const line of lines) expect(sealLine(sealLine(line)), line).toBe(sealLine(line));
    const started = performance.now();
    sealLine('\\'.repeat(1_000_000));
    sealLine('://www.'.repeat(150_000));
    expect(performance.now() - started).toBeLessThan(15_000); // see the note on the limit above
  });
});
