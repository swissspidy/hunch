/** Inkling's build step as a library (`@swissspidy/inkling/build`). */

export { build, computePriors, type BuildOptions, type BuildResult } from './build.ts';
export { EmbeddingCache } from './cache.ts';
export { hashProvider } from './providers/hash.ts';
export {
  EMBEDDING_GEMMA,
  transformersProvider,
  type TransformersOptions,
} from './providers/transformers.ts';
export { documentInput, type EmbeddingProvider } from './providers/types.ts';
export { loadSource, type LoadOptions, type SourceKind } from './sources/index.ts';
export { parseFeed } from './sources/feed.ts';
export { parseJsonCatalog } from './sources/json.ts';
export { loadSitemap, parsePage } from './sources/sitemap.ts';
export type { CatalogItem } from './types.ts';
