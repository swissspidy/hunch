# ADR 0007: A WordPress plugin, with embedding in the editor's browser

- Status: Accepted
- Date: 2026-11-05

## Context

Hunch's build step is a Node CLI that embeds a site's items with a pinned model and writes the
manifest and shards ([ADR 0001](0001-format-signals-ranking.md)). Most WordPress sites have no
Node on the server, no CI and no build step: the site is the PHP application, and its owner
installs plugins. For them, "adoptable in an afternoon" means installing a plugin and clicking a
button.

PHP can't run EmbeddingGemma in practice: there is no maintained ONNX runtime for PHP, shared
hosts don't allow native extensions, and a 300 MB model in a PHP request would exceed every
memory and time limit. The other parts of the build are plain arithmetic and file writing,
which PHP does well.

## Decision

The plugin lives in [`wordpress/hunch/`](../../wordpress/hunch/readme.txt): plain PHP, a
little plain JavaScript for wp-admin (`wp.*` globals, no build step), and the client's
script-tag bundle, which `npm run wordpress:build` copies in before zipping the plugin.

### 1. Embedding happens in the editor's browser

wp-admin loads Transformers.js and EmbeddingGemma with the same model id, pinned revision,
`q8` weights and document prompt as the CLI's
[`transformers.ts`](../../src/node/providers/transformers.ts). The manifest's `space` is the one
the CLI would write, and a catalog built by either can replace the other.

- **On publish:** in the block editor, after a published post is saved, a small script asks the
  site for the post's model input, embeds it and stores the vector. A snackbar says when it's done
  or failed.
- **"Build index"** (Settings → Hunch) backfills: it asks for posts without a current vector,
  8 at a time, embeds them one by one with a progress bar, then has the site write the files. It
  is resumable without stored state: posts with a current vector are skipped, so stopping, closing
  the tab or a failure loses only the post in flight. It also catches posts published outside
  the block editor (classic editor, REST API, imports, scheduled posts).
- **PHP computes the model input, not the browser.** The input is the document prompt filled
  with the post's title and text (tags, comments, scripts and shortcodes removed; the first
  4,000 UTF-16 code units, as in the CLI). PHP hashes it with the CLI's embedding-cache key
  (SHA-256 of model id, revision, dtype and input). The browser sends the hash back with the
  vector, and the site refuses a vector whose hash isn't the post's current one (409). So a post
  edited mid-embedding is not stored stale, and **unchanged posts are never embedded again**:
  the stored hash matches.
- **An edited post keeps its old vector until it is embedded again.** Its title, link and section
  are published from the post as it is now, but the vector stays the last one embedded. Dropping
  the post until someone runs "Build index" (posts edited outside the block editor) would take it
  out of every list for a typo fix; the old vector is still close to the post's meaning. "Build
  index" lists such posts as pending and embeds them.
- **The browser sends the model's full output: 768 float32 values, little-endian, base64**
  (4 KB), stored as post meta with the hash and the model key. The site truncates
  (Matryoshka), renormalizes and quantizes when it writes the shards. Like the CLI's cache, this
  makes the dimensions and quantization site settings that apply without re-embedding. The
  REST route checks the length, that every value is finite and that the vector isn't zero.
- **The weights variant is a setting, q8 by default.** q4 (about 200 MB instead of 300 MB) is an
  experimental choice, as `--dtype q4` is in the CLI: both load `model_no_gather_q4`, the q4
  file browsers can run ([ADR 0005](0005-query-embedding.md)), and give the same manifest. The
  editor's browser and Node agree to cosine 0.9998 on q4 vectors (q8: 1.0000), from slightly
  different 4-bit kernels. It scored no worse on MIND
  ([evaluation](../evaluation.md)), but on one dataset only. The variant is part of the model
  key and the space, so switching makes every stored vector stale: the files publish only
  vectors of the current variant, and **Build index** re-embeds. Mixing variants in one catalog
  is never allowed.
- **The post's text never leaves the site.** It goes from the site to the editor's own browser
  over the REST API. The model's weights come from the Hugging Face Hub and Transformers.js from
  jsDelivr. Neither request carries post text. Both URLs can be self-hosted (a setting and a
  filter for Transformers.js).

### 2. PHP writes the files, byte for byte as the CLI does

[`class-hunch-shard.php`](../../wordpress/hunch/includes/class-hunch-shard.php) and
[`class-hunch-writer.php`](../../wordpress/hunch/includes/class-hunch-writer.php) port
`encodeShard()` and the file-writing half of `build()`: the HNCH layout (the columns of
[ADR 0011](0011-shard-columns.md), with dates read as `Date.parse` reads ISO 8601), float32
rounding of the renormalized vector, int8 quantization with JavaScript's `Math.round`, the JSON as
`JSON.stringify` writes it (no escaped slashes or Unicode, `1` not `1.0`), one shard per section
in catalog order split at 2,000 items, content-hashed file names, the manifest's `version`,
keeping `generatedAt` when nothing changed, and deleting shards neither the new nor the previous
manifest names. These classes don't need WordPress.

- **Shard file names** use the same slug as the CLI's. Without PHP's `intl` extension, accents
  in a section name are dropped instead of transliterated, so such a shard gets another (still
  content-hashed and valid) name.
- **Sections** are the post's primary category (Yoast SEO's primary category where set, else
  the first), or none (one shard). A filter can change it.
- **Priors** come from the catalog order, newest first, or from the comment count
  ("most comments first", as the CLI's `popularity`). Both are `computePriors()`. Page views
  would need a stats plugin, so they are left to the `hunch_item` filter.
- **Item ids are post GUIDs**, the RSS feed's `guid`. A site that built its catalog with the CLI
  from its feed keeps its visitors' signals when it switches to the plugin, and the other way
  round.
- **Regeneration is debounced:** publishing, updating, trashing or unpublishing a post, storing a
  vector, changing the settings and (with comment priors) a comment count all schedule one
  WP-Cron event 30 seconds later, unless one is due within a minute. "Build index" writes
  immediately.
- **One run at a time.** The lock is a row in the options table, inserted atomically with
  `INSERT IGNORE` (as WordPress's own upgrader lock) and holding a random token and an expiry.
  A run that died (a fatal error, a timeout) leaves a lock that the next run takes over after 10
  minutes, with a compare-and-swap on its old value, and a run releases only its own lock. A run
  that finds the lock taken schedules itself again. A scheduled run whose write fails is retried
  three times, 2, 4 and 8 minutes apart; the error is kept in the state for the settings screen.
- **Files are replaced atomically:** every shard and the manifest are written to a `.tmp` file
  and renamed into place, so a web server never serves a half-written file.
- **An empty catalog** (every post unpublished) deletes the manifest at once, so pages stop
  pointing at it, and keeps its shards for one more run, as after any rebuild, for clients and
  cached pages holding it. That run is scheduled an hour later (or is the next run, if one
  comes sooner); if the catalog is still empty, it deletes the remaining shards. Otherwise the next manifest's write prunes them. The files go to `wp-content/uploads/hunch/`. The
  manifest's URL carries its version (`manifest.json?v=…`), so caches in front of the site see a
  new URL after each rebuild even when they ignore the `.htaccess` cache headers the plugin
  writes for Apache.

### 3. The front end

- The script-tag build (`hunch.global.js`) is enqueued with `defer`, only on pages that
  render a list. `window.HunchConfig.consent` is set inline before it from the consent
  setting: the visitor's own switch in the controls block (`localStorage`, as the demo does;
  the default), a cookie (`name=value`), a global JavaScript function (a dotted path, validated
  so it can't inject script), the WP Consent API's "preferences" category, always, or off.
- **Related posts** are added after the content of every indexed post (an option) or placed as a
  block. The server renders the newest posts of the same category, filled up with the newest
  posts, inside `<hunch-related>`. **"For you"** is a block that renders the newest posts
  inside `<hunch-for-you>`. Indexed posts get an `<hunch-page>` in the footer to record the
  view. Each slot has a fixed height and the title is clamped to two lines, so re-ranking moves
  nothing. Before the first build, the lists render without the component and stay as they are.
- **The personalization controls block** mirrors the demo's "Your data": the consent checkbox
  (when the visitor decides), pause/resume, export (a JSON download) and forget. Unchecking
  consent forgets. Forget is shown even when personalization is off or there is no index yet,
  and then deletes the IndexedDB database directly, since something may have been stored
  earlier. With the WP Consent API, every front-end page listens for the "preferences" category
  being withdrawn and deletes the database.

### 4. Security

Only public post types can be indexed, since their posts are published in the shards. Every
REST route has a permission callback: `edit_post` for a post's input and vector (and the
post must be of an indexed type), `manage_options` for the pending list, the status and
regeneration. The REST API's cookie authentication requires the `wp_rest` nonce, which
`wp.apiFetch` sends. The settings form uses the Settings API's nonce. Settings are sanitized
to their allowed values, and all output is escaped. PHP makes no external requests.

### 5. Correctness across the two languages

PHPUnit tests (via the plugin's own `composer.json`, no WordPress needed) check the PHP classes,
including a shard compared with bytes `encodeShard()` wrote. A Node test
([`wordpress.test.ts`](../../test/unit/wordpress.test.ts)) runs the PHP writer through the
`php` CLI and the Node `build()` (with a provider returning the same fixed vectors) on the same
catalog: the manifests and every shard must be byte-identical, and the PHP shards must decode
with `decodeShard()` to the same items, vectors and `invNorms`, with matching SHA-256 and
4-byte alignment. It covers int8 and float32, 128 to 768 dims, sections and none, split shards,
four rebuilds in a row (`generatedAt` and pruning), Unicode and control characters in titles,
and the text extraction, prompt and input hash. It is skipped where `php` is not installed. CI
runs it in a `wordpress` job with PHP 7.4 and 8.4 next to PHPUnit and PHPCS (WordPress coding
standards, PHP 7.4 compatibility).

## Alternatives considered

- **Embedding on the server in PHP** (an ONNX extension, or a pure-PHP transformer): not
  installable on shared hosting, and far too slow and memory-hungry for a request.
- **An embedding API** (a hosted model the server calls): sends every post to a third party,
  adds an account, a key and a cost, and pins the site to that provider's model. The project's
  premise is a pinned open model and no third party.
- **The CLI in CI, committing the files:** most WordPress sites have no repository or CI, and
  content changes in the database, not in git. The CLI remains the option for sites that have
  them, and produces the same files.
- **Embedding on the visitor's side:** every visitor would download 300 MB and embed the whole
  catalog. Embedding once, by the editor, is the same work done once per post.
- **A browser sending truncated, quantized vectors:** smaller post meta (256 bytes instead of
  4 KB), but changing the dimensions would mean embedding every post again.
- **Storing the vectors in a custom table:** faster to read for very large sites, but needs
  schema management. Post meta is enough for thousands of posts (regeneration reads them in
  pages of 200) and is removed with its post.
- **Serving the manifest from a REST route:** a PHP request per page view, and the shards'
  relative URLs would resolve against the REST path. Static files in uploads are served by the
  web server or CDN like any image.
- **A React build for the editor integration:** the plugin needs one subscription to the editor's
  store and three server-rendered blocks. Plain scripts on the `wp.*` globals avoid a build
  step and a `node_modules` in the plugin.

## Consequences

- A WordPress site gets related posts and "for you" with no Node, no CI and no model on its
  server. The cost is that someone with an editor's account has to open wp-admin in a browser
  that can download the model once (about 300 MB) and run it (a few hundred milliseconds per
  post on a laptop). Posts published by other means wait until the next "Build index".
- Vectors from the editor's browser (WASM) and from the CLI (Node, CPU) are not bit-identical,
  but they are the same model in the same space: the differences are floating-point noise, and
  the site may mix them.
- The PHP writer must follow any change to the shard or manifest format. The cross-language
  test fails when they drift.
- Embedding a post sends its model input to the user's browser: a user who can edit a post can
  read its text anyway, so the input route asks for `edit_post`.
- The npm package does not include the plugin (`files` lists only `bin` and `dist`), and the
  plugin zip does not include its tests or development tools.
- Not covered by automated tests: the plugin inside a running WordPress. It was checked by hand
  in WordPress 7.1 (SQLite, PHP's built-in server): the REST routes with stub vectors (and their
  refusals: no credentials, a stale hash, a bad vector), the written files decoded by the
  client's code, and in Chromium the related list re-ranked with no layout shift, the controls,
  "for you" after reading, embedding on publish in the block editor and "Build index", with
  Transformers.js replaced by a fake module. The real model in wp-admin was not run.
