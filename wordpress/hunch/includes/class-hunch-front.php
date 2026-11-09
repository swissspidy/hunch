<?php
/**
 * The front end: server-rendered lists of the site's own posts, which Hunch's web components
 * re-rank in the visitor's browser with no layout shift, and the visitor's privacy controls.
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || exit;

/**
 * Blocks, the `the_content` option and the scripts.
 */
final class Hunch_Front {

	/**
	 * Hooks.
	 */
	public static function init() {
		add_action( 'init', array( __CLASS__, 'register' ) );
		add_filter( 'the_content', array( __CLASS__, 'append_related' ), 20 );
		add_action( 'wp_footer', array( __CLASS__, 'page_element' ), 5 );
		add_action( 'wp_footer', array( __CLASS__, 'consent_cleanup' ) );
	}

	/**
	 * Scripts, styles and blocks.
	 */
	public static function register() {
		$client = HUNCH_DIR . '/assets/hunch.global.js';
		wp_register_script(
			'hunch',
			plugins_url( 'assets/hunch.global.js', HUNCH_FILE ),
			array(),
			is_file( $client ) ? (string) filemtime( $client ) : HUNCH_VERSION,
			array(
				'in_footer' => true,
				'strategy'  => 'defer',
			)
		);
		wp_add_inline_script( 'hunch', 'window.HunchConfig = { consent: ' . self::consent_js() . ' };', 'before' );
		wp_register_script(
			'hunch-controls',
			plugins_url( 'assets/controls.js', HUNCH_FILE ),
			array( 'hunch' ),
			HUNCH_VERSION,
			array(
				'in_footer' => true,
				'strategy'  => 'defer',
			)
		);
		wp_register_style( 'hunch', plugins_url( 'assets/hunch.css', HUNCH_FILE ), array(), HUNCH_VERSION );
		wp_register_script( 'hunch-blocks', plugins_url( 'assets/blocks.js', HUNCH_FILE ), array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-server-side-render' ), HUNCH_VERSION, true );

		$common = array(
			'api_version'           => 3,
			'editor_script_handles' => array( 'hunch-blocks' ),
			'style_handles'         => array( 'hunch' ),
			'category'              => 'widgets',
		);
		register_block_type(
			'hunch/related',
			$common + array(
				'title'           => __( 'Related posts (Hunch)', 'hunch' ),
				'attributes'      => array(
					'count'   => array(
						'type'    => 'number',
						'default' => 0,
					),
					'heading' => array(
						'type'    => 'string',
						'default' => '',
					),
				),
				'uses_context'    => array( 'postId' ),
				'render_callback' => array( __CLASS__, 'render_related_block' ),
			)
		);
		register_block_type(
			'hunch/for-you',
			$common + array(
				'title'           => __( 'For you (Hunch)', 'hunch' ),
				'attributes'      => array(
					'count'   => array(
						'type'    => 'number',
						'default' => 4,
					),
					'heading' => array(
						'type'    => 'string',
						'default' => '',
					),
				),
				'render_callback' => array( __CLASS__, 'render_for_you_block' ),
			)
		);
		register_block_type(
			'hunch/privacy-controls',
			$common + array(
				'title'           => __( 'Personalization controls (Hunch)', 'hunch' ),
				'render_callback' => array( __CLASS__, 'render_controls_block' ),
			)
		);
	}

	/**
	 * The consent hook of `window.HunchConfig`, as JavaScript, for the chosen setting.
	 *
	 * @return string
	 */
	public static function consent_js() {
		$s = Hunch_Settings::get();
		switch ( $s['consent'] ) {
			case 'always':
				return 'true';
			case 'off':
				return 'false';
			case 'cookie':
				return '() => document.cookie.split(/;\s*/).includes(' . wp_json_encode( $s['consent_cookie'] ) . ')';
			case 'function':
				// The setting is a dotted path of identifiers (see Hunch_Settings::sanitize()).
				// Called on its owner, so a method such as `cmp.allows` keeps its `this`.
				$path = explode( '.', $s['consent_function'] );
				$name = wp_json_encode( array_pop( $path ) );
				return '() => { const o = ' . wp_json_encode( $path ) . '.reduce((o, k) => o?.[k], window); const f = o?.[' . $name . ']; return typeof f === "function" ? f.call(o) : false; }';
			case 'wp-consent-api':
				return '() => typeof window.wp_has_consent === "function" && window.wp_has_consent("preferences")';
			default:
				// The visitor's own switch in the privacy controls block, kept in this browser.
				return '() => { try { return localStorage.getItem("hunch-consent") === "yes"; } catch { return false; } }';
		}
	}

	/**
	 * Related posts after a post's content, when that option is on.
	 *
	 * @param string $content The content.
	 * @return string
	 */
	public static function append_related( $content ) {
		if ( ! Hunch_Settings::get( 'related_auto' ) || ! is_singular() || ! in_the_loop() || ! is_main_query() ) {
			return $content;
		}
		$post = get_post();
		// A related list already in the content (the block, also inside a synced pattern or a
		// template part) is not repeated.
		if ( ! $post || ! Hunch_Catalog::is_indexed( $post ) || preg_match( '/class="[^"]*\bhunch-related\b/', $content ) ) {
			return $content;
		}
		return $content . self::related( $post, (int) Hunch_Settings::get( 'related_count' ), '', false );
	}

	/**
	 * The related posts block.
	 *
	 * @param array    $attributes Attributes.
	 * @param string   $content    Inner content (none).
	 * @param WP_Block $block      The block.
	 * @return string
	 */
	public static function render_related_block( $attributes, $content = '', $block = null ) {
		$id   = ( $block instanceof WP_Block && isset( $block->context['postId'] ) ) ? (int) $block->context['postId'] : get_the_ID();
		$post = $id ? get_post( $id ) : null;
		if ( ! $post || ! Hunch_Catalog::is_indexed( $post ) ) {
			return '';
		}
		$count = empty( $attributes['count'] ) ? (int) Hunch_Settings::get( 'related_count' ) : (int) $attributes['count'];
		return self::related( $post, $count, isset( $attributes['heading'] ) ? (string) $attributes['heading'] : '', true );
	}

	/**
	 * The "for you" block: the newest posts, re-ranked for the visitor with their consent.
	 *
	 * @param array $attributes Attributes.
	 * @return string
	 */
	public static function render_for_you_block( $attributes ) {
		$count    = max( 1, min( 12, empty( $attributes['count'] ) ? 4 : (int) $attributes['count'] ) );
		$heading  = empty( $attributes['heading'] ) ? __( 'For you', 'hunch' ) : (string) $attributes['heading'];
		$fallback = get_posts(
			array(
				'post_type'           => (array) Hunch_Settings::get( 'post_types' ),
				'post_status'         => 'publish',
				'has_password'        => false,
				'posts_per_page'      => $count,
				'ignore_sticky_posts' => true,
			)
		);
		$manifest = 'off' === Hunch_Settings::get( 'consent' ) ? null : Hunch_Catalog::manifest_url();
		return self::list_markup( 'hunch-for-you', $manifest ? array( 'manifest' => $manifest ) : null, $heading, $fallback, true );
	}

	/**
	 * The visitor's controls: consent (when the visitor gives it here), pause, export, forget.
	 * Forget is there even when personalization is off or there is no index yet: something may
	 * have been stored earlier.
	 *
	 * @return string
	 */
	public static function render_controls_block() {
		$consent  = Hunch_Settings::get( 'consent' );
		$manifest = 'off' === $consent ? null : Hunch_Catalog::manifest_url();
		wp_enqueue_script( 'hunch-controls' );
		wp_enqueue_style( 'hunch' );
		ob_start();
		?>
		<div <?php echo get_block_wrapper_attributes( array( 'class' => 'hunch-controls' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped by core. ?> data-hunch-controls data-manifest="<?php echo esc_url( (string) $manifest ); ?>" data-consent="<?php echo esc_attr( $consent ); ?>">
			<p class="hunch-controls__intro"><?php esc_html_e( 'Recommendations on this site are ranked in your browser. With your consent, it keeps a list of what you read here, on this device only.', 'hunch' ); ?></p>
			<?php if ( $manifest && ( 'optin' === $consent || ( 'wp-consent-api' === $consent && function_exists( 'wp_set_consent' ) ) ) ) : ?>
				<p><label><input type="checkbox" data-hunch-consent disabled> <?php esc_html_e( 'Personalize recommendations', 'hunch' ); ?></label></p>
			<?php endif; ?>
			<p class="hunch-controls__buttons">
				<?php if ( $manifest ) : ?>
					<button type="button" data-hunch-pause disabled><?php esc_html_e( 'Pause', 'hunch' ); ?></button>
					<button type="button" data-hunch-export disabled><?php esc_html_e( 'Export', 'hunch' ); ?></button>
				<?php endif; ?>
				<button type="button" data-hunch-forget disabled><?php esc_html_e( 'Forget', 'hunch' ); ?></button>
			</p>
			<p><output data-hunch-status aria-live="polite"></output></p>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	/**
	 * With the WP Consent API, withdrawing the "preferences" category deletes what Hunch
	 * stored, on every page (not only where a list or the controls are).
	 */
	public static function consent_cleanup() {
		if ( 'wp-consent-api' !== Hunch_Settings::get( 'consent' ) ) {
			return;
		}
		wp_print_inline_script_tag(
			'document.addEventListener("wp_listen_for_consent_change", (e) => { if (e.detail?.preferences !== "deny") return; try { indexedDB.deleteDatabase("hunch").onsuccess = () => document.dispatchEvent(new Event("hunch:forgotten")); } catch {} });'
		);
	}

	/**
	 * Records the visitor's view of an indexed post (with consent), in the footer.
	 */
	public static function page_element() {
		if ( ! is_singular() || 'off' === Hunch_Settings::get( 'consent' ) ) {
			return;
		}
		$post     = get_queried_object();
		$manifest = Hunch_Catalog::manifest_url();
		if ( ! $post instanceof WP_Post || ! $manifest || ! Hunch_Catalog::is_indexed( $post ) ) {
			return;
		}
		wp_enqueue_script( 'hunch' );
		printf( '<hunch-page manifest="%s" item="%s"></hunch-page>', esc_url( $manifest ), esc_attr( Hunch_Catalog::item_id( $post ) ) );
	}

	/**
	 * Related posts: the newest posts of the same section as the fallback, re-ranked by
	 * similarity in the browser.
	 *
	 * @param WP_Post $post    The post.
	 * @param int     $count   Slots.
	 * @param string  $heading Heading.
	 * @param bool    $block   Rendered as a block (with the block's wrapper attributes).
	 * @return string
	 */
	private static function related( WP_Post $post, $count, $heading, $block ) {
		$count    = max( 1, min( 12, $count ) );
		$types    = (array) Hunch_Settings::get( 'post_types' );
		$query    = array(
			'post_type'           => $types,
			'post_status'         => 'publish',
			'has_password'        => false,
			'posts_per_page'      => $count,
			'post__not_in'        => array( $post->ID ),
			'ignore_sticky_posts' => true,
		);
		$section  = Hunch_Catalog::section( $post );
		$category = 'category' === Hunch_Settings::get( 'sections' ) && $section ? get_cat_ID( $section ) : 0;
		$fallback = $category ? get_posts( $query + array( 'cat' => $category ) ) : array();
		// With "same section only", the browser shows nothing from other sections, so neither does
		// the fallback.
		$same = (bool) Hunch_Settings::get( 'related_same' );
		if ( count( $fallback ) < $count && ! ( $same && $category ) ) {
			$query['post__not_in']   = array_merge( array( $post->ID ), wp_list_pluck( $fallback, 'ID' ) );
			$query['posts_per_page'] = $count - count( $fallback );
			$fallback                = array_merge( $fallback, get_posts( $query ) );
		}
		$manifest   = Hunch_Catalog::manifest_url();
		$attributes = null;
		if ( $manifest ) {
			$attributes = array(
				'manifest' => $manifest,
				'item'     => Hunch_Catalog::item_id( $post ),
			);
			if ( $section ) {
				$attributes['section'] = $section;
			}
			if ( $same ) {
				$attributes['sections'] = 'same';
			}
		}
		return self::list_markup( 'hunch-related', $attributes, '' === $heading ? __( 'Related', 'hunch' ) : $heading, $fallback, $block );
	}

	/**
	 * A list of posts in slots, wrapped in an Hunch component when there is a manifest.
	 *
	 * @param string     $element    `hunch-related` or `hunch-for-you`.
	 * @param array|null $attributes The component's attributes, or null for the list alone.
	 * @param string     $heading    Heading.
	 * @param WP_Post[]  $posts      The fallback posts.
	 * @param bool       $block      Rendered as a block: the block's wrapper attributes apply.
	 * @return string
	 */
	private static function list_markup( $element, $attributes, $heading, array $posts, $block ) {
		if ( ! $posts ) {
			return '';
		}
		wp_enqueue_style( 'hunch' );
		$open  = '';
		$close = '';
		if ( null !== $attributes ) {
			wp_enqueue_script( 'hunch' );
			$open = '<' . $element;
			foreach ( $attributes as $name => $value ) {
				$open .= ' ' . $name . '="' . ( 'manifest' === $name ? esc_url( $value ) : esc_attr( $value ) ) . '"';
			}
			$open .= '>';
			$close = '</' . $element . '>';
		}
		$slots = '';
		foreach ( $posts as $post ) {
			$section = Hunch_Catalog::section( $post );
			$slots  .= sprintf(
				'<li class="hunch-slot" data-hunch-slot data-hunch-id="%1$s"><a class="hunch-slot__link" href="%2$s"><span class="hunch-slot__title" data-hunch-title>%3$s</span></a><span class="hunch-slot__meta"><span data-hunch-section>%4$s</span> <time data-hunch-date datetime="%5$s">%6$s</time></span></li>',
				esc_attr( Hunch_Catalog::item_id( $post ) ),
				esc_url( get_permalink( $post ) ),
				esc_html( Hunch_Format::html_to_text( get_the_title( $post ) ) ),
				esc_html( (string) $section ),
				esc_attr( Hunch_Format::iso_time( (int) get_post_time( 'U', true, $post ) ) ),
				esc_html( get_the_date( '', $post ) )
			);
		}
		$class   = 'hunch-list ' . ( 'hunch-related' === $element ? 'hunch-related' : 'hunch-for-you' );
		$wrapper = $block && WP_Block_Supports::$block_to_render ? get_block_wrapper_attributes( array( 'class' => $class ) ) : 'class="' . esc_attr( $class ) . '"';
		return sprintf(
			'<section %1$s><h2 class="hunch-list__heading">%2$s</h2>%3$s<ol class="hunch-list__items">%4$s</ol>%5$s</section>',
			$wrapper,
			esc_html( $heading ),
			$open,
			$slots,
			$close
		);
	}
}
