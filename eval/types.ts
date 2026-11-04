import type { CatalogItem } from '../src/node/types.ts';

/** One shown list: what the user had read before, what was shown, and what they clicked. */
export interface Impression {
  id: string;
  user: string;
  /** Epoch milliseconds. */
  at: number;
  /** Item ids the user read before, oldest first. */
  history: string[];
  /** Item ids shown, in the order shown. */
  candidates: string[];
  clicked: ReadonlySet<string>;
}

export interface Dataset {
  name: string;
  items: CatalogItem[];
  impressions: Impression[];
}
