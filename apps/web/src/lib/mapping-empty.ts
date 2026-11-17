/** The mapping text a new visitor starts with. */
export const DEFAULT_MAPPING = `# Mapping file: tells the translator where Splunk data lives in Grail.
# See docs/spec/mapping-config.md. This text stays in this browser.
version: 1
indexes: {}
fields: {}
`;

/**
 * Whether the person's mapping file says nothing yet: only comments, `version` and empty sections,
 * as in the text a new visitor starts with. Read line by line without a YAML parser, so the first
 * paint does not need one. Anything this does not recognise counts as a mapping of their own — the
 * example mapping is then never used in its place (ADR-030).
 */
const VERSION = /^version:\s*\d+\s*(#.*)?$/;
const EMPTY_SECTION = /^[A-Za-z_][A-Za-z0-9_]*:\s*(\{\s*\}|\[\s*\]|null|~)?\s*(#.*)?$/;

export function isEmptyMappingText(text: string): boolean {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---') continue;
    if (line !== line.trimStart()) return false;
    if (VERSION.test(line) || EMPTY_SECTION.test(line)) continue;
    return false;
  }
  return true;
}
