// typedoc.json, with the navigation links to the front page and the demo taken from the site's
// base path when HUNCH_SITE_BASE is set (the Pages workflow sets it to "/<repository>/"), so a
// deployment from a fork links to itself. Absolute paths work from every nested API page.
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./typedoc.json', import.meta.url), 'utf8'));
const base = process.env.HUNCH_SITE_BASE;
if (base) {
  const root = base.endsWith('/') ? base : `${base}/`;
  config.navigationLinks = { ...config.navigationLinks, Hunch: root, Demo: `${root}demo/` };
}
export default config;
