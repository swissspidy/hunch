/** An item of the site's catalog, as a source loads it. */
export interface CatalogItem {
  /** Stable id: signals refer to items by it, across rebuilds and model changes. */
  id: string;
  url: string;
  title: string;
  /** Plain text the item is embedded from (not published). */
  text: string;
  section?: string;
  tags?: string[];
  /** ISO 8601 publication date. */
  date?: string;
  image?: string;
  /** Any number, higher is more popular; sets the cold-start prior. */
  popularity?: number;
}
