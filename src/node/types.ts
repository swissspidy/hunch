/** An item of the site's catalog, as a source loads it. */
export interface CatalogItem {
  /** Stable id: signals refer to items by it, across rebuilds and model changes. */
  id: string;
  /** The item's URL. */
  url: string;
  /** The item's title. */
  title: string;
  /** Plain text the item is embedded from (not published). */
  text: string;
  /** The item's section: one shard per section. */
  section?: string;
  /** The item's tags. */
  tags?: string[];
  /** ISO 8601 publication date. */
  date?: string;
  /** URL of the item's image. */
  image?: string;
  /** Any number, higher is more popular; sets the cold-start prior. */
  popularity?: number;
}
