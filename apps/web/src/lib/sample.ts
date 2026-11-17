import type { ConfigFile } from '@spl2dql/core';
import securityPosture from '../../../../examples/splunk-app/default/data/ui/views/security_posture.xml?raw';
import webOverview from '../../../../examples/splunk-app/default/data/ui/views/web_overview.xml?raw';
import eventtypes from '../../../../examples/splunk-app/default/eventtypes.conf?raw';
import macros from '../../../../examples/splunk-app/default/macros.conf?raw';
import props from '../../../../examples/splunk-app/default/props.conf?raw';
import savedsearches from '../../../../examples/splunk-app/default/savedsearches.conf?raw';
import tags from '../../../../examples/splunk-app/default/tags.conf?raw';
import transforms from '../../../../examples/splunk-app/default/transforms.conf?raw';
import mapping from '../../../../examples/splunk-app/spl2dql.mapping.yaml?raw';
import type { InputFile } from './input-files.ts';

const file = (path: string, text: string): InputFile => ({ path, size: text.length, text });

/** The filled-in mapping that comes with the sample app (where its data would live in Grail). */
export const SAMPLE_MAPPING_TEXT: string = mapping;

/** The sample app's Splunk configuration files: macros, extractions, eventtypes and tags. */
export const SAMPLE_CONFIG: readonly ConfigFile[] = [
  { name: 'macros.conf', text: macros },
  { name: 'props.conf', text: props },
  { name: 'transforms.conf', text: transforms },
  { name: 'eventtypes.conf', text: eventtypes },
  { name: 'tags.conf', text: tags },
];

/**
 * The made-up Splunk app from examples/splunk-app, bundled so the app can show a whole conversion
 * without anyone's real files: saved searches, two dashboards and the configuration they use.
 */
export const SAMPLE_APP: readonly InputFile[] = [
  file('sample-app/default/savedsearches.conf', savedsearches),
  file('sample-app/default/macros.conf', macros),
  file('sample-app/default/props.conf', props),
  file('sample-app/default/transforms.conf', transforms),
  file('sample-app/default/eventtypes.conf', eventtypes),
  file('sample-app/default/tags.conf', tags),
  file('sample-app/default/data/ui/views/web_overview.xml', webOverview),
  file('sample-app/default/data/ui/views/security_posture.xml', securityPosture),
];
