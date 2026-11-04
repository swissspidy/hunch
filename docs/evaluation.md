# Evaluation

How well does Inkling rank what people actually click, and does a model switch cost anything?
[`eval/`](../eval/README.md) replays click logs through the real client: the build writes
shards, each user's history becomes signals, and `Inkling.rank()` orders each impression's shown
items. The protocol and datasets are described in the [eval README](../eval/README.md). The raw
numbers are in [`eval/results/`](../eval/results).

## Synthetic (CI)

3,000 items in 16 latent topics, 1,230 impressions of 20 items each. Two embedding "models" are
different noisy random projections of the latent space (128 and 96 dimensions).
`test/unit/eval.test.ts` runs this in CI and fails if Inkling's nDCG@10 drops to within 0.2 of
popularity's, or if any ranking differs after a model switch.

| Ranker                                    | AUC       | MRR       | nDCG@5    | nDCG@10   | Recall@10 |
| ----------------------------------------- | --------- | --------- | --------- | --------- | --------- |
| Random                                    | 0.498     | 0.178     | 0.186     | 0.284     | 0.499     |
| Popularity                                | 0.553     | 0.219     | 0.246     | 0.340     | 0.559     |
| Inkling, model A: profile only            | 0.844     | 0.499     | 0.655     | 0.717     | 0.877     |
| **Inkling, model A: default weights**     | **0.847** | **0.500** | **0.658** | **0.721** | **0.887** |
| Inkling, model A: default + diversity 0.2 | 0.846     | 0.498     | 0.655     | 0.719     | 0.890     |
| Inkling, model B: profile only            | 0.825     | 0.471     | 0.621     | 0.684     | 0.863     |
| **Inkling, model B: default weights**     | **0.829** | **0.479** | **0.630** | **0.693** | **0.868** |
| Inkling, model B: default + diversity 0.2 | 0.822     | 0.473     | 0.617     | 0.684     | 0.861     |

**Model switch:** signals recorded on model A's catalog and then ranked on model B's gave the same
ranking as a fresh profile on model B in **1,230 of 1,230** impressions. The device stores only
signals (item id, kind, weight and time), never vectors or a profile, so there is nothing to
migrate. After a switch, quality is the new model's own (B is
the noisier model here), not a degraded version of it.

## MIND small

2,000 impressions sampled evenly from the dev set (one day of MSN News, Nov 15, 2019), with an
average of 37 shown items each. The catalog is the 13,965 articles they show or have in their
histories, embedded from title and abstract. Popularity counts the clicks of the days before
(the training impressions). Most of the day's articles are new, so popularity knows little
about them. Raw numbers:
[`eval/results/mind-hash-256-embeddinggemma-300m-ONNX-256.json`](../eval/results/mind-hash-256-embeddinggemma-300m-ONNX-256.json).

| Ranker                                           | AUC       | MRR       | nDCG@5    | nDCG@10   | Recall@10 |
| ------------------------------------------------ | --------- | --------- | --------- | --------- | --------- |
| Random                                           | 0.504     | 0.217     | 0.219     | 0.285     | 0.523     |
| Popularity                                       | 0.534     | 0.236     | 0.244     | 0.308     | 0.547     |
| Inkling, `hash` (lexical): profile only          | 0.544     | 0.251     | 0.257     | 0.321     | 0.548     |
| Inkling, `hash` (lexical): default weights       | 0.553     | 0.251     | 0.259     | 0.324     | 0.559     |
| Inkling, EmbeddingGemma: profile only            | 0.630     | 0.304     | 0.331     | 0.387     | 0.618     |
| **Inkling, EmbeddingGemma: default weights**     | **0.634** | **0.307** | **0.335** | **0.390** | **0.620** |
| Inkling, EmbeddingGemma: default + diversity 0.2 | 0.634     | 0.305     | 0.333     | 0.388     | 0.618     |

- **Inkling beats popularity on nDCG@10 by 0.08 (0.390 vs 0.308)** with EmbeddingGemma at 256
  int8 dimensions, the defaults the demo ships. That meets milestone 4. No model was trained,
  and nothing about the user left the "device".
- **The model matters.** Lexical hashing barely beats popularity on short news headlines. A
  semantic embedding does much better from the same signals and the same ranking function.
- **Popularity helps a little.** The default blend is slightly better than the profile alone. At
  100 or more signals, confidence is close to 1, so the profile dominates.
- **Diversity costs almost nothing.** A diversity of 0.2 loses 0.002 nDCG@10, the price of
  varied lists in `recommend()`.
- **Model switch:** histories recorded through the client on the `hash` catalog and then ranked on
  EmbeddingGemma's matched a fresh EmbeddingGemma profile in **2,000 of 2,000** impressions. So a
  site that upgrades from a weak model to a strong one gets the strong model's quality on the
  visitor's next page, with no migration.
- **Cost:** embedding the 13,965 articles took 24 minutes on this machine's CPU (q8 weights, no
  GPU), once. Rebuilds embed only new or changed items.

These results are for one day of one publication, and impressions were sampled, not complete.
They aren't a leaderboard comparison: the protocol replays histories as views and ranks with
fixed weights. They do show that the client, as shipped, ranks clicked news well above
popularity.
