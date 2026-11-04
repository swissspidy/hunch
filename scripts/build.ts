/** The last step of `npm run build` (after tsc): the script-tag build, dist/inkling.global.js. */

import { bundleGlobal } from './bundle.ts';

await bundleGlobal('dist/inkling.global.js');
