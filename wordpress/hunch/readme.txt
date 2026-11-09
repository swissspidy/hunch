=== Hunch ===
Contributors: swissspidy
Tags: related posts, recommendations, personalization, privacy, embeddings
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.0
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

Related posts and "for you" lists ranked in the visitor's browser. The visitor's interests never leave their device.

== Description ==

Hunch ranks your posts in the visitor's browser. Related posts are ranked by meaning, not by shared tags. With the visitor's consent, a "for you" list follows what they read on your site. That reading history stays in their browser: nothing about the visitor is sent to your server or anyone else.

How it works:

1. **Embedding happens in your browser, in wp-admin.** When you publish or update a post in the block editor, your browser turns it into a vector with EmbeddingGemma, an open embedding model. Your server runs no model and needs no Node.js. The post's text goes from your site to your browser and nowhere else. The vector (about 3 KB) is stored with the post.
2. **Your site publishes the vectors as static files** in `wp-content/uploads/hunch/`: a small `manifest.json` and one shard per category. They are rewritten shortly after a post is published, updated or trashed.
3. **On your pages**, the plugin renders normal lists of your own posts: the newest posts in the same category after each post, and the newest posts in the "For you" block. In the visitor's browser, Hunch's script (12 KB, gzipped) re-ranks them in idle time, slot for slot. Nothing moves on the page.

The vectors are the same as those the Hunch command-line tool (`npx @swissspidy/hunch build`) makes from your RSS feed with the same model, so you can switch between the two.

= Blocks =

* **Related posts (Hunch)**: posts similar to the current one. Also added after every post's content automatically, unless you turn that off.
* **For you (Hunch)**: the newest posts, re-ranked for the visitor once they agreed and read a few posts.
* **Personalization controls (Hunch)**: lets visitors turn personalization on (when you leave consent to them or to the WP Consent API), pause it, export what is stored, or forget it all. Put it on your privacy page.

= Consent =

Storing a reading history on the visitor's device may need their consent (in the EU, under the ePrivacy Directive), even though it never leaves the device. Under Settings → Hunch, choose how the plugin learns whether the visitor agreed:

* **The visitor turns it on** in the personalization controls block (the default).
* **A cookie** your consent manager sets, such as `hunch_consent=yes`.
* **A JavaScript function** your consent manager provides, returning true or a promise of true.
* **WP Consent API** (recommended when a consent manager supports it): the "preferences" category. The privacy controls block then sets that category in your consent manager, so the block and the cookie banner agree, and withdrawing it deletes what was stored. Hunch registers with the API and describes what it stores, so your consent manager can list it in its cookie policy. Without a consent manager that sets a consent type, the API reports consent for every visitor; the settings screen warns about that.
* **Always on**, where no consent is needed, or **off** (related posts only).

The plugin asks before every read or write. Related posts use no visitor data and work without consent.

== Installation ==

1. Upload the plugin and activate it.
2. Go to Settings → Hunch and click **Build index**. Keep the tab open: your browser downloads the model once (about 300 MB, or 200 MB with the experimental q4 weights; then cached) and embeds every published post. You can stop and continue later.
3. From then on, publishing in the block editor embeds the post in your browser. Posts published another way (the classic editor, the REST API, an import) are embedded the next time you click **Build index**.

The manifest should be served with a short cache lifetime and the shards with a long one. On Apache, the plugin writes an `.htaccess` file for this. On nginx:

    location /wp-content/uploads/hunch/ {
        location ~ manifest\.json$ { add_header Cache-Control "public, max-age=300"; }
        location ~ \.hunch$ { add_header Cache-Control "public, max-age=31536000, immutable"; }
    }

== Frequently Asked Questions ==

= Does my server send anything anywhere? =

No. The plugin makes no external requests from PHP. In wp-admin, your browser loads Transformers.js (from jsDelivr by default; you can host it yourself and change the URL in the settings) and the model's weights from the Hugging Face Hub. Those requests carry no post text.

= What does the visitor's browser download? =

Hunch's script, `manifest.json` and the shards it needs, all from your site. About 260 KB per 1,000 posts, gzipped, at the default 256 dimensions.

= What happens if I change the model, dimensions or categories? =

Changing the dimensions, quantization or sections rewrites the files from the stored vectors, with no new embedding. A new plugin version with another model, or switching **Model weights** between q8 and q4, needs a new **Build index**: until it finishes, the lists show your newest posts. Visitors' histories survive both: they are kept as post ids, and the profile is recomputed from the new vectors.

= What is stored on the visitor's device? =

A list of signals: the post's id, the kind (view, click, dwell, follow, hide), a weight and a time, in the site's IndexedDB database `hunch`. At most 2,000 signals, none older than 180 days.

= What does deleting the plugin remove? =

Its settings, the stored vectors and the files in `wp-content/uploads/hunch/`, on every site of a network. Visitors' reading histories are in their own browsers: the personalization controls' "Forget" deletes them.

== Hooks ==

* `hunch_post_text` (filter): the plain text a post is embedded from.
* `hunch_post_section` (filter): a post's section; the default is its primary category.
* `hunch_item` (filter): a post as published in the shards (`id`, `url`, `title`, `section`, `tags`, `date`, `image`, `popularity`).
* `hunch_transformers_url` (filter): where wp-admin loads Transformers.js from.

== Changelog ==

= 0.1.0 =

* First version: embedding in the editor's browser, related posts, "for you", personalization controls.
