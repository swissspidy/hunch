/**
 * The script-tag build (`inkling.global.js`): registers the web components and exposes the
 * client class as `window.Inkling` (`Inkling.configure({ consent })`, `await
 * Inkling.shared(manifest)`, `await Inkling.load({ manifest })`).
 *
 * Options in `window.InklingConfig`, set by an inline script before this one, are applied
 * before any component starts: the place for the site's consent hook, and for a default
 * `manifest` (see `config.ts`).
 */

import { Inkling } from '../client/index.ts';
import { defineElements } from './define.ts';

(globalThis as { Inkling?: typeof Inkling }).Inkling = Inkling;
defineElements();
