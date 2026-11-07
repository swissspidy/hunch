/** The last step of `npm run build` (after tsc): the script-tag build, dist/hunch.global.js. */

import { bundleGlobal } from './bundle.ts';

await bundleGlobal('dist/hunch.global.js');
