<?php
/**
 * Published posts as an Hunch catalog: their model input, the vectors the editors' browsers
 * sent, and the manifest and shards in `uploads/hunch/` (ADR 0007).
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || exit;

/**
 * The catalog.
 */
final class Hunch_Catalog {

	const META_VECTOR = '_hunch_vector';
	const META_HASH   = '_hunch_hash';
	const META_MODEL  = '_hunch_model';
	const HOOK        = 'hunch_regenerate';
	const STATE       = 'hunch_state';
	const LOCK        = 'hunch_regenerating';
	const RETRIES     = 'hunch_retries';

	/**
	 * Seconds after which a lock left by a run that died (a fatal error, a timeout) is taken over.
	 */
	const LOCK_TTL = 600;

	/**
	 * Failed scheduled runs are retried this often, 2, 4 and 8 minutes apart.
	 */
	const MAX_RETRIES = 3;

	/**
	 * Hooks.
	 */
	public static function init() {
		add_action( self::HOOK, array( __CLASS__, 'scheduled_regenerate' ) );
		add_action( 'transition_post_status', array( __CLASS__, 'on_transition' ), 10, 3 );
		add_action( 'wp_update_comment_count', array( __CLASS__, 'on_comment_count' ) );
		add_action( 'update_option_' . Hunch_Settings::OPTION, array( __CLASS__, 'schedule' ) );
	}

	/**
	 * Deactivation: no regeneration left scheduled.
	 */
	public static function deactivate() {
		wp_clear_scheduled_hook( self::HOOK );
	}

	/**
	 * The model the vectors come from: EmbeddingGemma, pinned as the CLI pins it, with the
	 * weights variant of the settings (q8, or the experimental q4: the CLI's `--dtype q4`).
	 * The variant is part of the embedding space: changing it makes every vector stale.
	 *
	 * @return array
	 */
	public static function model() {
		$model          = Hunch_Format::embedding_gemma();
		$model['dtype'] = Hunch_Settings::get( 'weights' );
		if ( 'q4' === $model['dtype'] ) {
			// The q4 file browsers can run, as the CLI picks it (`EMBEDDING_GEMMA.files`). Right
			// after `dtype`, where the CLI writes it: the manifests are compared byte for byte.
			$model = array_slice( $model, 0, 3, true ) + array( 'file' => 'model_no_gather' ) + array_slice( $model, 3, null, true );
		}
		return $model;
	}

	/**
	 * The model's key in post meta: vectors from another model or revision are not used.
	 *
	 * @return string
	 */
	public static function model_key() {
		$model = self::model();
		$file  = empty( $model['file'] ) ? '' : '/' . $model['file'];
		return $model['id'] . '@' . $model['revision'] . '|' . $model['dtype'] . $file . '|' . $model['nativeDims'];
	}

	/**
	 * Whether a post belongs in the catalog: published, public, of an indexed type, no password.
	 *
	 * @param WP_Post|int|null $post The post.
	 * @return bool
	 */
	public static function is_indexed( $post ) {
		$post = get_post( $post );
		return $post instanceof WP_Post
			&& 'publish' === $post->post_status
			&& '' === $post->post_password
			&& in_array( $post->post_type, (array) Hunch_Settings::get( 'post_types' ), true );
	}

	/**
	 * The model input for a post (title and plain text in the document prompt) and its hash.
	 *
	 * @param WP_Post $post The post.
	 * @return array{input: string, hash: string}
	 */
	public static function input( WP_Post $post ) {
		$model = self::model();
		$title = Hunch_Format::html_to_text( $post->post_title );
		/**
		 * Filters the plain text a post is embedded from. It stays on the site: only the
		 * editor's browser sees it.
		 *
		 * @param string  $text The text.
		 * @param WP_Post $post The post.
		 */
		$text  = (string) apply_filters( 'hunch_post_text', Hunch_Format::html_to_text( strip_shortcodes( $post->post_content ) ), $post );
		$input = Hunch_Format::document_input( $model['documentPrompt'], $title, $text );
		return array(
			'input' => $input,
			'hash'  => Hunch_Format::input_hash( $model, $input ),
		);
	}

	/**
	 * Whether the post's stored vector is for its current input and model.
	 *
	 * @param WP_Post $post The post.
	 * @param string  $hash The current input hash.
	 * @return bool
	 */
	public static function is_current( WP_Post $post, $hash ) {
		return get_post_meta( $post->ID, self::META_HASH, true ) === $hash
			&& get_post_meta( $post->ID, self::META_MODEL, true ) === self::model_key()
			&& '' !== get_post_meta( $post->ID, self::META_VECTOR, true );
	}

	/**
	 * Checks a vector sent by a browser: base64 of the model's `nativeDims` little-endian
	 * float32 components, all finite, not all zero.
	 *
	 * @param mixed $base64 The encoded vector.
	 * @return string|WP_Error The decoded bytes.
	 */
	public static function check_vector( $base64 ) {
		$dims  = self::model()['nativeDims'];
		$bytes = is_string( $base64 ) ? base64_decode( $base64, true ) : false; // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- binary vector data.
		if ( false === $bytes || strlen( $bytes ) !== $dims * 4 ) {
			return new WP_Error( 'hunch_bad_vector', sprintf( 'The vector must be %d float32 values, base64-encoded.', $dims ), array( 'status' => 400 ) );
		}
		$sum = 0.0;
		foreach ( unpack( 'g*', $bytes ) as $x ) {
			if ( ! is_finite( $x ) ) {
				return new WP_Error( 'hunch_bad_vector', 'The vector has a non-finite component.', array( 'status' => 400 ) );
			}
			$sum += $x * $x;
		}
		if ( ! ( $sum > 0 ) || ! is_finite( $sum ) ) {
			return new WP_Error( 'hunch_bad_vector', 'The vector is zero.', array( 'status' => 400 ) );
		}
		return $bytes;
	}

	/**
	 * Stores a post's vector with the hash of the input it was made from, and schedules a
	 * regeneration.
	 *
	 * @param WP_Post $post  The post.
	 * @param string  $hash  The input hash.
	 * @param string  $bytes The vector, from `check_vector()`.
	 */
	public static function store( WP_Post $post, $hash, $bytes ) {
		update_post_meta( $post->ID, self::META_VECTOR, base64_encode( $bytes ) ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- binary vector data.
		update_post_meta( $post->ID, self::META_HASH, $hash );
		update_post_meta( $post->ID, self::META_MODEL, self::model_key() );
		self::schedule();
	}

	/**
	 * Posts that need a vector, for the "Build index" screen: scans up to `$scan` indexed posts
	 * after `$after` (by ID) and returns those whose vector is missing or stale.
	 *
	 * @param int $after Last post ID already scanned.
	 * @param int $limit Most posts to return.
	 * @param int $scan  Most posts to scan.
	 * @return array{posts: array[], cursor: int, done: bool, scanned: int}
	 */
	public static function pending( $after, $limit, $scan = 200 ) {
		global $wpdb;
		$types        = (array) Hunch_Settings::get( 'post_types' );
		$placeholders = implode( ', ', array_fill( 0, count( $types ), '%s' ) );
		// Ordered by ID so the scan can resume from a cursor; WP_Query has no "ID greater than".
		$ids     = $wpdb->get_col( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->prepare( // phpcs:ignore WordPress.DB.PreparedSQLPlaceholders.ReplacementsWrongNumber -- one %s per post type.
				"SELECT ID FROM {$wpdb->posts} WHERE ID > %d AND post_status = 'publish' AND post_password = '' AND post_type IN ($placeholders) ORDER BY ID ASC LIMIT %d", // phpcs:ignore WordPress.DB.PreparedSQLPlaceholders.UnfinishedPrepare, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- the placeholders are built above.
				array_merge( array( (int) $after ), $types, array( (int) $scan ) )
			)
		);
		$ids     = array_map( 'intval', $ids );
		$posts   = array();
		$cursor  = (int) $after;
		$scanned = 0;
		_prime_post_caches( $ids, false, true );
		foreach ( $ids as $id ) {
			if ( count( $posts ) >= $limit ) {
				break;
			}
			$post   = get_post( $id );
			$cursor = $id;
			++$scanned;
			if ( ! $post ) {
				continue;
			}
			$input = self::input( $post );
			if ( ! self::is_current( $post, $input['hash'] ) ) {
				$posts[] = array(
					'id'    => $post->ID,
					'title' => get_the_title( $post ),
					'input' => $input['input'],
					'hash'  => $input['hash'],
				);
			}
		}
		return array(
			'posts'   => $posts,
			'cursor'  => $cursor,
			'done'    => count( $ids ) === $scanned && count( $ids ) < $scan,
			'scanned' => $scanned,
		);
	}

	/**
	 * Counts for the "Build index" screen.
	 *
	 * @return array{total: int, embedded: int, state: array}
	 */
	public static function status() {
		$common   = array(
			'post_type'      => (array) Hunch_Settings::get( 'post_types' ),
			'post_status'    => 'publish',
			'has_password'   => false,
			'fields'         => 'ids',
			'posts_per_page' => 1,
			'no_found_rows'  => false,
		);
		$total    = new WP_Query( $common );
		$embedded = new WP_Query(
			$common + array(
				'meta_query' => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
					array(
						'key'   => self::META_MODEL,
						'value' => self::model_key(),
					),
				),
			)
		);
		$state    = get_option( self::STATE, array() );
		return array(
			'total'    => (int) $total->found_posts,
			'embedded' => (int) $embedded->found_posts,
			'state'    => is_array( $state ) ? $state : array(),
		);
	}

	/**
	 * Schedules a regeneration in 30 seconds, once: many changes in a row write once.
	 */
	public static function schedule() {
		$next = wp_next_scheduled( self::HOOK );
		// A retry or the empty catalog's clean-up may be pending further out: don't wait for it.
		if ( ! $next || $next > time() + 60 ) {
			wp_schedule_single_event( time() + 30, self::HOOK );
		}
	}

	/**
	 * A post entered or left the published state, or changed while published.
	 *
	 * @param string  $new_status New status.
	 * @param string  $old_status Old status.
	 * @param WP_Post $post       The post.
	 */
	public static function on_transition( $new_status, $old_status, $post ) {
		if ( ( 'publish' === $new_status || 'publish' === $old_status )
			&& in_array( $post->post_type, (array) Hunch_Settings::get( 'post_types' ), true ) ) {
			self::schedule();
		}
	}

	/**
	 * Comment counts set the priors when the site chose so.
	 */
	public static function on_comment_count() {
		if ( 'comments' === Hunch_Settings::get( 'priors' ) ) {
			self::schedule();
		}
	}

	/**
	 * The directory and URL of the published files.
	 *
	 * @return array{dir: string, url: string}
	 */
	public static function location() {
		$uploads = wp_upload_dir( null, false );
		return array(
			'dir' => $uploads['basedir'] . '/hunch',
			'url' => set_url_scheme( $uploads['baseurl'] . '/hunch' ),
		);
	}

	/**
	 * The manifest's URL with its version (so caches in front of it see a new URL after a
	 * rebuild), or null before the first build.
	 *
	 * @return string|null
	 */
	public static function manifest_url() {
		$state = get_option( self::STATE, array() );
		if ( empty( $state['version'] ) ) {
			return null;
		}
		return self::location()['url'] . '/manifest.json?v=' . rawurlencode( $state['version'] );
	}

	/**
	 * A post as a catalog item.
	 *
	 * @param WP_Post $post The post.
	 * @return array
	 */
	public static function item( WP_Post $post ) {
		$tags  = array();
		$terms = get_the_terms( $post, 'post_tag' );
		if ( is_array( $terms ) ) {
			foreach ( $terms as $term ) {
				$tags[] = html_entity_decode( $term->name, ENT_QUOTES, 'UTF-8' );
			}
		}
		$image = get_the_post_thumbnail_url( $post, 'medium' );
		$item  = array(
			'id'      => self::item_id( $post ),
			'url'     => (string) get_permalink( $post ),
			'title'   => Hunch_Format::html_to_text( get_the_title( $post ) ),
			'section' => self::section( $post ),
			'tags'    => $tags,
			'date'    => Hunch_Format::iso_time( (int) get_post_time( 'U', true, $post ) ),
			'image'   => $image ? $image : null,
		);
		if ( 'comments' === Hunch_Settings::get( 'priors' ) ) {
			$item['popularity'] = (int) $post->comment_count;
		}
		/**
		 * Filters a post's published item: `id`, `url`, `title`, `section`, `tags`, `date`,
		 * `image`, and `popularity` (sets the cold-start order). Its text is never published.
		 *
		 * @param array   $item The item.
		 * @param WP_Post $post The post.
		 */
		return apply_filters( 'hunch_item', $item, $post );
	}

	/**
	 * A post's stable item id: its GUID, as in the site's RSS feed, so a catalog built by the
	 * CLI from the feed has the same ids (and visitors' signals carry over).
	 *
	 * @param WP_Post $post The post.
	 * @return string
	 */
	public static function item_id( WP_Post $post ) {
		$guid = html_entity_decode( (string) $post->guid, ENT_QUOTES, 'UTF-8' );
		return '' === $guid ? (string) $post->ID : $guid;
	}

	/**
	 * A post's section: its primary category (Yoast SEO's, where set, else the first), unless
	 * sections are off.
	 *
	 * @param WP_Post $post The post.
	 * @return string|null
	 */
	public static function section( WP_Post $post ) {
		$section = null;
		if ( 'category' === Hunch_Settings::get( 'sections' ) ) {
			$term       = null;
			$primary    = (int) get_post_meta( $post->ID, '_yoast_wpseo_primary_category', true );
			$categories = get_the_category( $post->ID );
			foreach ( $categories as $category ) {
				if ( $category->term_id === $primary ) {
					$term = $category;
				}
			}
			if ( ! $term && $categories ) {
				$term = $categories[0];
			}
			$section = $term ? html_entity_decode( $term->name, ENT_QUOTES, 'UTF-8' ) : null;
		}
		/**
		 * Filters a post's section (one shard per section). Null for none.
		 *
		 * @param string|null $section The section.
		 * @param WP_Post     $post    The post.
		 */
		return apply_filters( 'hunch_post_section', $section, $post );
	}

	/**
	 * The scheduled run: a failed write is retried a few times, further apart each time.
	 */
	public static function scheduled_regenerate() {
		$result = self::regenerate();
		if ( ! is_wp_error( $result ) ) {
			delete_option( self::RETRIES );
			return;
		}
		if ( 'hunch_write_failed' !== $result->get_error_code() ) {
			return;
			// Busy: regenerate() has scheduled the next run.
		}
		$retries = (int) get_option( self::RETRIES, 0 ) + 1;
		if ( $retries <= self::MAX_RETRIES ) {
			update_option( self::RETRIES, $retries, false );
			wp_schedule_single_event( time() + 60 * ( 2 ** $retries ), self::HOOK );
		} else {
			// Given up: the next change or "Build index" starts again.
			delete_option( self::RETRIES );
		}
	}

	/**
	 * Writes the manifest and shards from every published post with a vector, one run at a time.
	 *
	 * @return array|WP_Error The new state: `version`, `count`, `pending`, `generatedAt`.
	 */
	public static function regenerate() {
		$token = self::lock();
		if ( null === $token ) {
			self::schedule();
			return new WP_Error( 'hunch_busy', 'A regeneration is running.', array( 'status' => 409 ) );
		}
		try {
			$state = self::write();
		} catch ( Exception $e ) {
			$state = new WP_Error( 'hunch_write_failed', $e->getMessage(), array( 'status' => 500 ) );
			$saved = get_option( self::STATE, array() );
			update_option( self::STATE, array_merge( is_array( $saved ) ? $saved : array(), array( 'error' => $e->getMessage() ) ), false );
		} finally {
			self::unlock( $token );
		}
		return $state;
	}

	/**
	 * Takes the regeneration lock: a row in the options table inserted atomically (INSERT
	 * IGNORE, as WordPress's own upgrader lock), holding a random token and its expiry. A lock
	 * past its expiry is taken over with a compare-and-swap on its old value.
	 *
	 * @return string|null The lock's value, to release it with; null when another run holds it.
	 */
	private static function lock() {
		global $wpdb;
		$value = wp_generate_password( 20, false ) . ':' . ( time() + self::LOCK_TTL );
		// phpcs:disable WordPress.DB.DirectDatabaseQuery -- the lock must bypass the options cache.
		$inserted = $wpdb->query( $wpdb->prepare( "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')", self::LOCK, $value ) );
		if ( ! $inserted ) {
			$held    = (string) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::LOCK ) );
			$expires = (int) substr( (string) strrchr( $held, ':' ), 1 );
			$taken   = '' !== $held && $expires < time()
				&& $wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND option_value = %s", $value, self::LOCK, $held ) );
			if ( ! $taken ) {
				return null;
			}
		}
		// phpcs:enable WordPress.DB.DirectDatabaseQuery
		wp_cache_delete( self::LOCK, 'options' );
		return $value;
	}

	/**
	 * Releases the lock, unless another run has taken it over meanwhile.
	 *
	 * @param string $value The value `lock()` returned.
	 */
	private static function unlock( $value ) {
		global $wpdb;
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name = %s AND option_value = %s", self::LOCK, $value ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		wp_cache_delete( self::LOCK, 'options' );
	}

	/**
	 * The regeneration itself.
	 *
	 * @return array
	 */
	private static function write() {
		$settings  = Hunch_Settings::get();
		$model_key = self::model_key();
		$items     = array();
		$rows      = array();
		$pending   = 0;
		// Newest first: the catalog order, and so the cold-start order unless comments decide.
		for ( $page = 1; ; $page++ ) {
			$query = new WP_Query(
				array(
					'post_type'              => $settings['post_types'],
					'post_status'            => 'publish',
					'has_password'           => false,
					'orderby'                => array(
						'date' => 'DESC',
						'ID'   => 'DESC',
					),
					'posts_per_page'         => 200, // phpcs:ignore WordPress.WP.PostsPerPage.posts_per_page_posts_per_page -- ids and meta, in pages.
					'paged'                  => $page,
					'no_found_rows'          => true,
					'ignore_sticky_posts'    => true,
					'suppress_filters'       => true,
					'update_post_meta_cache' => true,
					'update_post_term_cache' => true,
				)
			);
			if ( ! $query->posts ) {
				break;
			}
			foreach ( $query->posts as $post ) {
				$vector = get_post_meta( $post->ID, self::META_VECTOR, true );
				if ( '' === $vector || get_post_meta( $post->ID, self::META_MODEL, true ) !== $model_key ) {
					++$pending;
					continue;
				}
				$bytes = self::check_vector( $vector );
				if ( is_wp_error( $bytes ) ) {
					++$pending;
					continue;
				}
				$items[] = self::item( $post );
				$rows[]  = Hunch_Shard::row( array_values( unpack( 'g*', $bytes ) ), (int) $settings['dims'], $settings['quantization'] );
			}
			wp_cache_flush_runtime();
		}//end for

		$location = self::location();
		$state    = array(
			'version'     => null,
			'count'       => 0,
			'pending'     => $pending,
			'generatedAt' => Hunch_Format::iso_time( time() ),
		);
		if ( $items ) {
			self::prepare_dir( $location['dir'] );
			$result               = Hunch_Writer::write(
				array(
					'items'        => $items,
					'rows'         => $rows,
					'dir'          => $location['dir'],
					'model'        => self::model(),
					'dims'         => (int) $settings['dims'],
					'quantization' => $settings['quantization'],
					'shard_by'     => 'none' === $settings['sections'] ? 'none' : 'section',
				)
			);
			$state['version']     = $result['manifest']['version'];
			$state['count']       = $result['manifest']['count'];
			$state['generatedAt'] = $result['manifest']['generatedAt'];
		} elseif ( is_file( $location['dir'] . '/manifest.json' ) ) {
			// No catalog: pages stop pointing at the manifest. Its shards stay one more run for
			// clients and cached pages holding it, as after any rebuild (ADR 0007), and that run
			// is scheduled now so they don't stay indefinitely.
			wp_delete_file( $location['dir'] . '/manifest.json' );
			wp_schedule_single_event( time() + HOUR_IN_SECONDS, self::HOOK );
		} else {
			// Still no catalog an hour later: no manifest names the remaining shards.
			foreach ( (array) glob( $location['dir'] . '/shards/*.hunch' ) as $file ) {
				if ( is_string( $file ) ) {
					wp_delete_file( $file );
				}
			}
		}//end if
		update_option( self::STATE, $state, false );
		return $state;
	}

	/**
	 * Creates the directory, with cache headers for Apache: the manifest briefly, the
	 * content-hashed shards for a year. Other servers need the same rules in their own config.
	 *
	 * @param string $dir The directory.
	 */
	private static function prepare_dir( $dir ) {
		wp_mkdir_p( $dir . '/shards' );
		$htaccess = $dir . '/.htaccess';
		if ( ! is_file( $htaccess ) ) {
			$rules = "# Written by Hunch.\n"
				. "<IfModule mod_mime.c>\n\tAddType application/octet-stream .hunch\n</IfModule>\n"
				. "<IfModule mod_headers.c>\n"
				. "\t<Files \"manifest.json\">\n\t\tHeader set Cache-Control \"public, max-age=300\"\n\t</Files>\n"
				. "\t<FilesMatch \"\\.hunch$\">\n\t\tHeader set Cache-Control \"public, max-age=31536000, immutable\"\n\t</FilesMatch>\n"
				. "</IfModule>\n";
			file_put_contents( $htaccess, $rules ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- uploads is writable; WP_Filesystem may need credentials.
		}
	}
}
