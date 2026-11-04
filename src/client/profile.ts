/**
 * The visitor's profile, derived from signals and the current catalog's vectors (ADR 0001).
 * Never stored, so a new model needs no migration: the same signals meet the new vectors.
 *
 *   P+ = normalize( Σ_{s_i > 0} s_i · v_i )     P- = normalize( Σ_{s_i < 0} |s_i| · v_i )
 *   m  = Σ_{s_i > 0} s_i                         conf = m / (m + k), k = 3
 *   sim(c) = cos(c, P+) − 0.5 · max(0, cos(c, P-))
 */

import { normalize } from '../rank/vector.ts';
import type { Aggregate } from './signals.ts';

interface Contributor {
  itemId: string;
  /** Decayed signal score (positive). */
  score: number;
  vector: Float32Array;
}

export interface Profile {
  positive: Float32Array | null;
  negative: Float32Array | null;
  /** Total positive signal score. */
  mass: number;
  /** m / (m + k): how far the profile outweighs the site's own order. */
  confidence: number;
  /** Positive items, highest score first. */
  contributors: Contributor[];
  /** Items with signals that the current catalog does not have (removed, or another model's). */
  missing: string[];
}

const CONFIDENCE_K = 3;
const NEGATIVE_WEIGHT = 0.5;

export function buildProfile(
  aggregates: ReadonlyMap<string, Aggregate>,
  vectorOf: (itemId: string) => Float32Array | undefined,
  dims: number,
): Profile {
  const pos = new Float64Array(dims);
  const neg = new Float64Array(dims);
  let mass = 0;
  let negMass = 0;
  const contributors: Contributor[] = [];
  const missing: string[] = [];
  for (const [itemId, { score }] of aggregates) {
    if (score === 0) continue;
    const v = vectorOf(itemId);
    if (!v) {
      missing.push(itemId);
      continue;
    }
    const target = score > 0 ? pos : neg;
    const w = Math.abs(score);
    for (let d = 0; d < dims; d++) target[d]! += w * v[d]!;
    if (score > 0) {
      mass += score;
      contributors.push({ itemId, score, vector: v });
    } else {
      negMass += w;
    }
  }
  contributors.sort((a, b) => b.score - a.score || (a.itemId < b.itemId ? -1 : 1));
  return {
    positive: mass > 0 ? normalize(pos) : null,
    negative: negMass > 0 ? normalize(neg) : null,
    mass,
    confidence: mass / (mass + CONFIDENCE_K),
    contributors,
    missing,
  };
}

/** sim(c) for a unit candidate vector, given its cosines to P+ and P-. */
export function profileSimilarity(cosPositive: number, cosNegative: number): number {
  return cosPositive - NEGATIVE_WEIGHT * Math.max(0, cosNegative);
}
