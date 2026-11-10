# Evaluation

How well does Hunch rank what people actually click, and does a model switch cost anything?
[`eval/`](../eval/README.md) replays click logs through the real client: the build writes
shards, each user's history becomes signals, and `Hunch.rank()` orders each impression's shown
items. The protocol and datasets are described in the [eval README](../eval/README.md). The raw
numbers are in [`eval/results/`](../eval/results).

## Synthetic (CI)

3,000 items in 16 latent topics, 1,230 impressions of 20 items each. Two embedding "models" are
different noisy random projections of the latent space (128 and 96 dimensions).
`test/unit/eval.test.ts` runs this in CI and fails if Hunch's nDCG@10 drops to within 0.2 of
popularity's, or if any ranking differs after a model switch.

| Ranker                                  | AUC       | MRR       | nDCG@5    | nDCG@10   | Recall@10 |
| --------------------------------------- | --------- | --------- | --------- | --------- | --------- |
| Random                                  | 0.498     | 0.178     | 0.186     | 0.283     | 0.499     |
| Popularity                              | 0.553     | 0.219     | 0.246     | 0.340     | 0.559     |
| Hunch, model A: profile only            | 0.843     | 0.497     | 0.655     | 0.719     | 0.888     |
| **Hunch, model A: default weights**     | **0.846** | **0.502** | **0.661** | **0.724** | **0.893** |
| Hunch, model A: default + diversity 0.2 | 0.841     | 0.498     | 0.654     | 0.716     | 0.883     |
| Hunch, model B: profile only            | 0.826     | 0.476     | 0.629     | 0.690     | 0.866     |
| **Hunch, model B: default weights**     | **0.828** | **0.477** | **0.631** | **0.691** | **0.868** |
| Hunch, model B: default + diversity 0.2 | 0.824     | 0.473     | 0.622     | 0.686     | 0.867     |

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
[`eval/results/mind-hash-256-embeddinggemma-300m-ONNX-q8-256.json`](../eval/results/mind-hash-256-embeddinggemma-300m-ONNX-q8-256.json).

| Ranker                                         | AUC       | MRR       | nDCG@5    | nDCG@10   | Recall@10 |
| ---------------------------------------------- | --------- | --------- | --------- | --------- | --------- |
| Random                                         | 0.504     | 0.217     | 0.219     | 0.285     | 0.523     |
| Popularity                                     | 0.534     | 0.236     | 0.244     | 0.308     | 0.547     |
| Hunch, `hash` (lexical): profile only          | 0.544     | 0.251     | 0.257     | 0.321     | 0.548     |
| Hunch, `hash` (lexical): default weights       | 0.552     | 0.250     | 0.257     | 0.323     | 0.558     |
| Hunch, EmbeddingGemma: profile only            | 0.630     | 0.304     | 0.331     | 0.387     | 0.617     |
| **Hunch, EmbeddingGemma: default weights**     | **0.634** | **0.306** | **0.335** | **0.390** | **0.621** |
| Hunch, EmbeddingGemma: default + diversity 0.2 | 0.633     | 0.305     | 0.332     | 0.389     | 0.620     |

- **Hunch beats popularity on nDCG@10 by 0.08 (0.390 vs 0.308)** with EmbeddingGemma at 256
  int8 dimensions, the defaults the demo ships. That meets milestone 4. No model was trained,
  and nothing about the user left the "device".
- **The model matters.** Lexical hashing barely beats popularity on short news headlines. A
  semantic embedding does much better from the same signals and the same ranking function.
- **Popularity helps a little.** The default blend is slightly better than the profile alone. At
  100 or more signals, confidence is close to 1, so the profile dominates.
- **Diversity costs almost nothing.** A diversity of 0.2 loses 0.001 nDCG@10, the price of
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

## MIND small: dimensions and quantization

The build publishes 256 Matryoshka dimensions as int8 by default. Is that a good trade-off? This
run ranks 10,000 dev impressions (sampled evenly from the 70,938 eligible ones; 24,784
articles) with EmbeddingGemma at 128, 256, 512 and 768 dimensions, each as int8 and float32. The
articles were embedded once; the eight catalogs only truncate and quantize the cached vectors,
so each build took one or two seconds. Raw numbers:
[`eval/results/mind-ablation-10k.json`](../eval/results/mind-ablation-10k.json). The command is
in the [eval README](../eval/README.md#ablation-dimensions-quantization-weights).

Default weights (profile blended with popularity). Bytes are the uncompressed shards; each item
also carries about 216 bytes of metadata (id, URL, title, section, tags, prior). Ranking time is
the mean `rank()` call per impression (about 37 shown items, about 33 history signals), in Node
on a shared 4-CPU machine, so read it as relative.

| EmbeddingGemma catalog  | nDCG@10    | AUC       | MRR       | Recall@10 | Shard bytes per item | Catalog (shards + manifest) | `rank()` per impression |
| ----------------------- | ---------- | --------- | --------- | --------- | -------------------- | --------------------------- | ----------------------- |
| 128, int8               | 0.3841     | 0.626     | 0.298     | 0.630     | 344                  | 8.5 MB                      | 0.9 ms                  |
| 128, float32            | 0.3845     | 0.627     | 0.298     | 0.631     | 728                  | 18.0 MB                     | 0.9 ms                  |
| **256, int8 (default)** | **0.3856** | **0.627** | **0.299** | **0.631** | **472**              | **11.7 MB**                 | **1.6 ms**              |
| 256, float32            | 0.3858     | 0.627     | 0.299     | 0.631     | 1,240                | 30.7 MB                     | 1.6 ms                  |
| 512, int8               | 0.3776     | 0.624     | 0.294     | 0.621     | 728                  | 18.0 MB                     | 3.0 ms                  |
| 512, float32            | 0.3775     | 0.624     | 0.294     | 0.621     | 2,264                | 56.1 MB                     | 2.5 ms                  |
| 768, int8               | 0.3872     | 0.634     | 0.301     | 0.632     | 984                  | 24.4 MB                     | 3.8 ms                  |
| 768, float32            | 0.3872     | 0.634     | 0.301     | 0.632     | 3,288                | 81.5 MB                     | 3.6 ms                  |
| q4 weights: 256, int8   | 0.3910     | 0.629     | 0.304     | 0.634     | 472                  | 11.7 MB                     | 1.6 ms                  |

Random scores 0.288 nDCG@10 on these impressions, popularity 0.310, and `hash` (256, int8)
0.321.

The differences that matter are paired: both catalogs ranked the same impressions, so the
table below gives the mean per-impression difference in nDCG@10, its standard error, and a
bootstrap 95% interval (2,000 resamples of impressions).

| Comparison (b − a)          | nDCG@10 difference | Standard error | 95% interval       |
| --------------------------- | ------------------ | -------------- | ------------------ |
| 256 − 128 (int8)            | +0.0015            | 0.0014         | −0.0011 to +0.0042 |
| 256 − 128 (float32)         | +0.0013            | 0.0014         | −0.0013 to +0.0041 |
| 512 − 256 (int8)            | −0.0080            | 0.0016         | −0.0112 to −0.0048 |
| 512 − 256 (float32)         | −0.0083            | 0.0016         | −0.0115 to −0.0051 |
| 768 − 512 (int8)            | +0.0095            | 0.0011         | +0.0074 to +0.0116 |
| 768 − 512 (float32)         | +0.0097            | 0.0011         | +0.0076 to +0.0118 |
| 768 − 256 (int8)            | +0.0015            | 0.0016         | −0.0015 to +0.0045 |
| float32 − int8 at 128       | +0.0003            | 0.0002         | −0.0001 to +0.0008 |
| float32 − int8 at 256       | +0.0002            | 0.0002         | −0.0002 to +0.0006 |
| float32 − int8 at 512       | −0.0001            | 0.0002         | −0.0005 to +0.0002 |
| float32 − int8 at 768       | +0.0000            | 0.0002         | −0.0003 to +0.0003 |
| q4 − q8 weights (256, int8) | +0.0054            | 0.0010         | +0.0034 to +0.0074 |

- **256/int8 holds up.** It is 0.0015 nDCG@10 below 768/int8, the best q8 catalog, and that
  gap is about one standard error (the interval includes 0). 768/int8 costs twice the bytes
  and about 2.4 times the ranking time for it. The data gives no reason to change the default.
- **128 costs little.** 128/int8 is 0.0015 below 256/int8 (standard error 0.0014, the interval
  includes 0). It saves 128 bytes per item, about 27% of the shards, and ranks fastest. A site
  with a large catalog, or one that cares most about bytes, loses almost nothing with
  `--dims 128`.
- **float32 buys nothing.** At every size, float32 is within 0.0003 of int8, with intervals
  around 0, and its shards are 2 to 3.3 times larger. int8 quantization costs nothing
  measurable here.
- **More dimensions are not monotonically better.** 512 is clearly worse than both 256 and 768
  (−0.008 and −0.0095, about 5 and 9 standard errors). A separate check outside the client
  (cosine to the mean of the history vectors, straight from the embedding cache) gives the
  same curve: 0.374 at 64, 0.381 at 128, 0.383 at 256, 0.374 at 512, 0.385 at 768. So this is
  the model's Matryoshka prefixes on this task, not the client.
- **Sizes are small next to the model's own differences.** All four sizes are within 0.01
  nDCG@10 of each other. Moving from `hash` to EmbeddingGemma gains 0.065.
- **q4 weights did better, not worse.** Embedding the catalog with EmbeddingGemma's q4 weights
  instead of q8 (the CLI's default) gained 0.0054 nDCG@10 at 256/int8, about 5 standard
  errors, with identical shard sizes. The 4-bit weights are not a better model, so read this
  as "q4 costs nothing here" rather than as a reason to expect gains elsewhere. It needs its
  own embedding pass (24,647 inputs took 52 minutes on 4 busy CPUs), and the dtype is part of
  the embedding space, so switching is a model switch: signals carry over, vectors are
  re-embedded. Every document vector in a catalog must come from the same weights; a query
  embedder may use a smaller variant ([ADR 0005](adr/0005-query-embedding.md): q4 and q8 query
  vectors have cosine 0.98). The CLI (`--dtype q4`) and the WordPress plugin (Model weights) offer
  q4 as an option; q8 stays the default until more than one dataset says otherwise.
- **The q4 row measured `model_q4`, which browsers can't run.** q4 now means
  `model_no_gather_q4` ([ADR 0005](adr/0005-query-embedding.md)), whose vectors are within cosine
  0.998 of `model_q4`'s. On the same 10,000 impressions it scores 0.3904 nDCG@10 at 256/int8
  (default weights; profile only: 0.3881), against 0.3856 for q8: **+0.0048** (standard error
  0.0010, 95% interval +0.0029 to +0.0068), about the gain `model_q4` showed (+0.0054). So the
  browser file costs nothing either. Its embedding needed `--batch-size 2`: with 16 long
  inputs per pass, its unquantized token embeddings took the process past 14 GB. Results:
  [`mind-q4-browser-10k.json`](../eval/results/mind-q4-browser-10k.json).
- **Model switch:** histories recorded on the `hash` catalog and ranked on EmbeddingGemma's
  matched a fresh profile in **10,000 of 10,000** impressions.

Same caveats as above: one day of one publication, and fixed weights. The intervals cover
sampling of impressions, not of days or sites.
