import { readFile } from 'node:fs/promises';
import { Inkling } from '@swissspidy/inkling';

const ink = await Inkling.load({
  manifest: 'http://site/inkling/manifest.json',
  fetch: async (url) => new Response(await readFile(`public${new URL(url).pathname}`)),
});
const [first] = await ink.related('banana-muffins', { n: 1 });
console.log(first.id);
