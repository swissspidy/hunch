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
item ids, so there is nothing to migrate. After a switch, quality is the new model's own (B is
the noisier model here), not a degraded version of it.

## MIND small

2,000 impressions sampled evenly from the dev set (one day of MSN News), with 13,965 articles.
The results with the lexical `hash` model are in
[`eval/results/mind-hash.json`](../eval/results/mind-hash.json). EmbeddingGemma's are still
running, and this section will compare the two.
