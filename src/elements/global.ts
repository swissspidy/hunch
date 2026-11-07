/**
 * The script-tag build (`hunch.global.js`): registers the web components and exposes the
 * client class as `window.Hunch` (`Hunch.configure({ consent })`, `await
 * Hunch.shared(manifest)`, `await Hunch.load({ manifest })`).
 *
 * Options in `window.HunchConfig`, set by an inline script before this one, are applied
 * before any component starts: the place for the site's consent hook, and for a default
 * `manifest` (see `config.ts`).
 */

import { Hunch } from '../client/index.ts';
import { defineElements } from './define.ts';

(globalThis as { Hunch?: typeof Hunch }).Hunch = Hunch;
defineElements();
