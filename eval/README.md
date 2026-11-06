# Offline evaluation

`eval/run.ts` measures how well Inkling ranks items a user actually clicked, through the real
client: the build writes shards, the user's history becomes signals, and `Inkling.rank()`
orders each impression's shown items with the profile and ranking function of
[ADR 0001](../docs/adr/0001-format-signals-ranking.md). The results and what they mean are in
[docs/evaluation.md](../docs/evaluation.md).

```sh
npm run eval                                   # synthetic dataset, a few seconds, no download
node eval/download-mind.ts --accept-license    # MIND small, ~180 MB, into eval/.data/mind
npm install --no-save @huggingface/transformers
node eval/run.ts --dataset mind --mind-dir eval/.data/mind --models hash,gemma --impressions 2000
```

Results go to `eval/results/<name>.json` (`--name` overrides the name). Builds go to
`eval/.work/`, and embeddings are cached in `eval/.cache/` (one directory per weights variant,
such as `q8`; `--cache` sets another root), so a second run doesn't embed again. The default
name includes the weights variant and any float32 quantization, so runs that differ only in those
don't overwrite each other.

### Ablation: dimensions, quantization, weights

```sh
node eval/run.ts --dataset mind --mind-dir eval/.data/mind --impressions 10000 \
  --models hash@256,gemma,gemma-q4@256/int8 --dims 128,256,512,768 \
  --quantization int8,float32 --variants profile,default --batch-size 2 --name mind-ablation-10k
```

- `--dims` and `--quantization` take comma-separated lists. Each model gets one catalog per
  combination. The embedding cache keeps full-size vectors, and truncation and quantization
  happen at build, so a model is embedded once however many catalogs it gets.
- `name@dims` or `name@dims/quantization` in `--models` gives that model one catalog only.
  Models: `hash`, `gemma` (q8 weights, the CLI's default), `gemma-q4`, `gemma-fp32`.
- `--variants` picks the rankings run per catalog: `profile`, `default`, `diversity`.
- `--batch-size` (default 16) sets the inputs per forward pass. `gemma-q4` needs 2 on a 16 GB
  machine: its token embeddings are unquantized, and 16 long inputs took the process past 14 GB.
- The results file then also lists each catalog's size (shard bytes per item, manifest bytes),
  the mean `rank()` time per impression, and paired comparisons of neighbouring catalogs of a
  model (adjacent sizes, int8 vs float32, weights variants): the mean nDCG@10 difference over
  the same impressions, its standard error, and a bootstrap 95% interval (2,000 resamples of
  impressions). They use the default weights when those are run.

## Protocol

- **Impressions.** For each impression (a list shown to a user, with the clicks on it), the
  user's earlier reads are recorded as one `view` signal each, at the impression's time. Then
  the shown items are ranked. Impressions without a history, or where everything or nothing was
  clicked, are skipped.
- **Metrics** follow MIND's: AUC, MRR, nDCG@5 and nDCG@10 per impression, averaged, plus
  recall@10.
- **Baselines.** Random order, and popularity: the catalog's popularity, which is also the
  prior Inkling falls back on.
- **Inkling variants.** The profile alone (prior and recency weights 0), the default weights
  (the profile blended with popularity by confidence), and the default weights with diversity
  0.2, as `recommend()` uses by default.
- **Model switch.** With two models, the history is recorded through the client on the first
  model's catalog, and the same store is then ranked on the second model's catalog. Every
  ranking must equal one from a fresh profile on the second model. That shows the device keeps
  no model-dependent state (milestone 3). Quality on the new model is that model's own, shown
  in its rows.

## Datasets

- **Synthetic** ([`datasets/synthetic.ts`](datasets/synthetic.ts)): 3,000 items in 16 latent
  topics, users who like one to three topics, and clicks that depend on affinity and popularity.
  Two embedding "models" see the latent space through different random projections, with noise
  (128 and 96 dimensions). It is deterministic and needs no download. `test/unit/eval.test.ts`
  runs it in CI.
- **MIND small** ([`datasets/mind.ts`](datasets/mind.ts)): the Microsoft News Dataset's
  dev-set impressions (one day of MSN News, Nov 15, 2019), sampled evenly. Items are the
  articles those impressions show or have in their histories. Their title and abstract are
  embedded, and the category is the section. Popularity is the click count in the training
  impressions (the days before), so it uses nothing from the day being ranked. MIND is
  licensed under the
  [Microsoft Research License Terms](https://github.com/msnews/MIND/blob/master/MSR%20License_Data.pdf)
  (non-commercial research use). Its original download no longer allows public access, so the
  script fetches the unmodified files from a Hugging Face mirror and checks their SHA-256. They
  are never committed.
