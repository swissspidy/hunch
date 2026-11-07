/** The integration's helpers for built pages: path filters, page files, ids and images. */

import { readFile } from 'node:fs/promises';
import type { AstroConfig } from 'astro';

/**
 * Paths to match, without the site's `base`: `/blog/*` matches one segment, `/blog/**` the
 * path and any below it. Trailing slashes are ignored. Or a regular expression, or a function.
 */
export type PathFilter =
  | string
  | RegExp
  | ((path: string) => boolean)
  | readonly (string | RegExp)[];

/** A matcher for a path filter; trailing slashes are ignored on both sides. */
export function matcher(filter: PathFilter): (path: string) => boolean {
  if (typeof filter === 'function') return filter;
  const patterns = (Array.isArray(filter) ? filter : [filter]) as (string | RegExp)[];
  const res = patterns.map((p) => (typeof p === 'string' ? glob(p) : p));
  return (path) => {
    const bare = path.length > 1 ? path.replace(/\/$/, '') : path;
    return res.some((re) => fromStart(re, path) || fromStart(re, bare));
  };
}

/** Tests from the start: a global or sticky RegExp keeps `lastIndex` between calls. */
function fromStart(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

function glob(pattern: string): RegExp {
  const bare = pattern.length > 1 ? pattern.replace(/\/$/, '') : pattern;
  const parts = bare.split(/(\/\*\*$|\*\*\/?|\*)/);
  const source = parts
    .map((part, i) => {
      // A trailing `/**`: the path itself, or anything below it.
      if (part === '/**') return '(?:/.*)?';
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') {
        // A whole segment needs a character; `alpine-*` matches `alpine-`.
        const whole = (parts[i - 1] ?? '').endsWith('/') && /^(\/|$)/.test(parts[i + 1] ?? '');
        return whole ? '[^/]+' : '[^/]*';
      }
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`);
}

export interface PageFile {
  html: string;
  /** Emitted as `name.html` rather than `name/index.html`. */
  flat: boolean;
}

/** The HTML file Astro emitted for a page, whatever the `build.format`. */
export async function readPage(
  dir: URL,
  path: string,
  format: AstroConfig['build']['format'],
): Promise<PageFile | undefined> {
  const name = path.slice(1).replace(/\/$/, '');
  if (!name) return read(new URL('index.html', dir), false);
  const index = (): Promise<PageFile | undefined> =>
    read(new URL(`${name}/index.html`, dir), false);
  const flat = (): Promise<PageFile | undefined> => read(new URL(`${name}.html`, dir), true);
  // With `file`, a page is `name.html`; a `name/index.html` would be a public file.
  return format === 'file' ? ((await flat()) ?? index()) : ((await index()) ?? flat());
}

async function read(file: URL, flat: boolean): Promise<PageFile | undefined> {
  try {
    return { html: await readFile(file, 'utf8'), flat };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * The page's URL path with `base`, as `Astro.url.pathname` gives it while the page is built. A
 * page emitted as `name.html` (with `build.format` `file`, or `preserve` for a page that is not
 * an index) ends in `.html`. Otherwise the path ends in a slash unless `trailingSlash` is
 * `never`: Astro's hook pathnames for `preserve` index pages have none even then.
 */
export function pagePath(
  base: string,
  path: string,
  flat: boolean,
  trailingSlash: AstroConfig['trailingSlash'],
): string {
  const bare = `${base}${path.slice(1)}`.replace(/\/$/, '');
  if (!bare) return '/';
  if (flat) return `${bare}.html`;
  return trailingSlash === 'never' ? bare : `${bare}/`;
}

/** A page-relative image URL, resolved against the page's path; others as they are. */
export function resolveImage(image: string, page: string): string {
  if (/^([a-z][a-z\d+.-]*:|\/)/i.test(image)) return image;
  const url = new URL(image, new URL(page, 'http://localhost'));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `out` as a relative directory path, or an error: it must stay inside the build output. */
export function checkOut(out: string | undefined): string {
  const path = (out ?? 'hunch').replace(/^\/+|\/+$/g, '');
  const segments = path.split('/');
  if (!path || segments.some((s) => !/^[\w.-]+$/.test(s) || s === '.' || s === '..')) {
    throw new Error(`hunch: out must be a directory inside the build output, not ${out}`);
  }
  return path;
}

/** The directory `out` names in `dir`, checked to be inside it. */
export function outDir(dir: URL, out: string): URL {
  const root = dir.href.endsWith('/') ? dir.href : `${dir.href}/`;
  const url = new URL(`${out}/`, root);
  if (!url.href.startsWith(root) || url.href === root) {
    throw new Error(`hunch: ${out} is not inside the build output`);
  }
  return url;
}
