/**
 * The script-tag build (`inkling.global.js`): registers the web components and exposes the
 * client class as `window.Inkling` (`Inkling.configure({ consent })`, `await
 * Inkling.shared(manifest)`, `await Inkling.load({ manifest })`).
 *
 * Options in `window.InklingConfig`, set by an inline script before this one, are applied
 * before any component starts: the place for the site's consent hook.
 */

import { Inkling, type InklingOptions } from '../client/index.ts';
import { defineElements } from './define.ts';

const scope = globalThis as {
  Inkling?: typeof Inkling;
  InklingConfig?: Omit<InklingOptions, 'manifest'>;
};
if (scope.InklingConfig) Inkling.configure(scope.InklingConfig);
scope.Inkling = Inkling;

// After configure(): registering upgrades the components already in the page.
defineElements();
