import { readFile } from 'node:fs/promises';
import { Hunch } from '@swissspidy/hunch';

const hunch = await Hunch.load({
  manifest: 'http://site/hunch/manifest.json',
  fetch: async (url) => new Response(await readFile(`public${new URL(url).pathname}`)),
});
const [first] = await hunch.related('banana-muffins', { n: 1 });
console.log(first.id);
