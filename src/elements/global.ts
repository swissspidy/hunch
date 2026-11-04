/**
 * The script-tag build (`inkling.global.js`): registers the web components and exposes the
 * client class as `window.Inkling` (`await Inkling.load({ manifest })`).
 */

import { Inkling } from '../client/index.ts';
import './index.ts';

(globalThis as { Inkling?: typeof Inkling }).Inkling = Inkling;
