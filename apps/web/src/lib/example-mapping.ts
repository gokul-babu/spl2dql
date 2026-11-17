import { isMap, isScalar, parseDocument } from 'yaml';
import { SAMPLE_MAPPING_TEXT } from './sample.ts';

/**
 * What the five built-in examples need beyond the sample app's own mapping. The sample app's
 * props.conf already extracts `method`, `uri`, `status` and `bytes`; these entries cover the rest.
 * The lookup entry is the one in docs/spec/mapping-config.md; the field names are made up, like
 * everything else in the sample app.
 */
const ADDITIONS = `
fields:
  level: loglevel
  duration: duration
fieldTypes:
  duration: number
lookups:
  http_status:
    path: /lookups/http_status
    key: code
    columns: [code, description, class]
`;

let cached: string | undefined;

/**
 * The example mapping as YAML: the sample app's mapping file with the entries above added. Used for
 * the built-in examples and the sample app while the person has no mapping of their own (ADR-030).
 * The sample app's .conf files (macros, extractions, eventtypes, tags) are added to it in the worker.
 */
export function exampleMappingText(): string {
  if (cached !== undefined) return cached;
  const doc = parseDocument(SAMPLE_MAPPING_TEXT);
  const extra = parseDocument(ADDITIONS);
  if (isMap(extra.contents)) {
    for (const section of extra.contents.items) {
      const name = isScalar(section.key) ? String(section.key.value) : '';
      if (!isMap(section.value)) continue;
      if (!doc.has(name)) doc.set(name, doc.createNode({}));
      for (const entry of section.value.items) {
        const key = isScalar(entry.key) ? String(entry.key.value) : '';
        if (!doc.hasIn([name, key])) doc.setIn([name, key], entry.value);
      }
    }
  }
  doc.commentBefore =
    " The example mapping: the sample app's spl2dql.mapping.yaml, plus what the built-in examples\n need. Every name in it is made up. It is used only while your own mapping is empty.";
  cached = doc.toString({ lineWidth: 0 });
  return cached;
}
