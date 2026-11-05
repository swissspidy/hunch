<?php
/**
 * The front end: server-rendered lists of the site's own posts, which Inkling's web components
 * re-rank in the visitor's browser with no layout shift, and the visitor's privacy controls.
 *
 * @package Inkling
 */

defined( 'ABSPATH' ) || exit;

/**
 * Blocks, the `the_content` option and the scripts.
 */
final class Inkling_Front {

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
		$client = INKLING_DIR . '/assets/inkling.global.js';
		wp_register_script(
			'inkling',
			plugins_url( 'assets/inkling.global.js', INKLING_FILE ),
			array(),
			is_file( $client ) ? (string) filemtime( $client ) : INKLING_VERSION,
			array(
				'in_footer' => true,
				'strategy'  => 'defer',
			)
		);
		wp_add_inline_script( 'inkling', 'window.InklingConfig = { consent: ' . self::consent_js() . ' };', 'before' );
		wp_register_script(
			'inkling-controls',
			plugins_url( 'assets/controls.js', INKLING_FILE ),
			array( 'inkling' ),
			INKLING_VERSION,
			array(
				'in_footer' => true,
				'strategy'  => 'defer',
			)
		);
		wp_register_style( 'inkling', plugins_url( 'assets/inkling.css', INKLING_FILE ), array(), INKLING_VERSION );
		wp_register_script( 'inkling-blocks', plugins_url( 'assets/blocks.js', INKLING_FILE ), array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-server-side-render' ), INKLING_VERSION, true );

		$common = array(
			'api_version'           => 3,
			'editor_script_handles' => array( 'inkling-blocks' ),
			'style_handles'         => array( 'inkling' ),
			'category'              => 'widgets',
		);
		register_block_type(
			'inkling/related',
			$common + array(
				'title'           => __( 'Related posts (Inkling)', 'inkling' ),
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
			'inkling/for-you',
			$common + array(
				'title'           => __( 'For you (Inkling)', 'inkling' ),
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
			'inkling/privacy-controls',
			$common + array(
				'title'           => __( 'Personalization controls (Inkling)', 'inkling' ),
				'render_callback' => array( __CLASS__, 'render_controls_block' ),
			)
		);
	}

	/**
	 * The consent hook of `window.InklingConfig`, as JavaScript, for the chosen setting.
	 *
	 * @return string
	 */
	public static function consent_js() {
		$s = Inkling_Settings::get();
		switch ( $s['consent'] ) {
			case 'always':
				return 'true';
			case 'off':
				return 'false';
			case 'cookie':
				return '() => document.cookie.split(/;\s*/).includes(' . wp_json_encode( $s['consent_cookie'] ) . ')';
			case 'function':
				// The setting is a dotted path of identifiers (see Inkling_Settings::sanitize()).
				// Called on its owner, so a method such as `cmp.allows` keeps its `this`.
				$path = explode( '.', $s['consent_function'] );
				$name = wp_json_encode( array_pop( $path ) );
				return '() => { const o = ' . wp_json_encode( $path ) . '.reduce((o, k) => o?.[k], window); const f = o?.[' . $name . ']; return typeof f === "function" ? f.call(o) : false; }';
			case 'wp-consent-api':
				return '() => typeof window.wp_has_consent === "function" && window.wp_has_consent("preferences")';
			default:
				// The visitor's own switch in the privacy controls block, kept in this browser.
				return '() => { try { return localStorage.getItem("inkling-consent") === "yes"; } catch { return false; } }';
		}
	}

	/**
	 * Related posts after a post's content, when that option is on.
	 *
	 * @param string $content The content.
	 * @return string
	 */
	public static function append_related( $content ) {
		if ( ! Inkling_Settings::get( 'related_auto' ) || ! is_singular() || ! in_the_loop() || ! is_main_query() ) {
			return $content;
		}
		$post = get_post();
		// A related list already in the content (the block, also inside a synced pattern or a
		// template part) is not repeated.
		if ( ! $post || ! Inkling_Catalog::is_indexed( $post ) || preg_match( '/class="[^"]*\binkling-related\b/', $content ) ) {
			return $content;
		}
		return $content . self::related( $post, (int) Inkling_Settings::get( 'related_count' ), '', false );
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
		if ( ! $post || ! Inkling_Catalog::is_indexed( $post ) ) {
			return '';
		}
		$count = empty( $attributes['count'] ) ? (int) Inkling_Settings::get( 'related_count' ) : (int) $attributes['count'];
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
		$heading  = empty( $attributes['heading'] ) ? __( 'For you', 'inkling' ) : (string) $attributes['heading'];
		$fallback = get_posts(
			array(
				'post_type'           => (array) Inkling_Settings::get( 'post_types' ),
				'post_status'         => 'publish',
				'has_password'        => false,
				'posts_per_page'      => $count,
				'ignore_sticky_posts' => true,
			)
		);
		$manifest = 'off' === Inkling_Settings::get( 'consent' ) ? null : Inkling_Catalog::manifest_url();
		return self::list_markup( 'inkling-for-you', $manifest ? array( 'manifest' => $manifest ) : null, $heading, $fallback, true );
	}

	/**
	 * The visitor's controls: consent (when the visitor gives it here), pause, export, forget.
	 * Forget is there even when personalization is off or there is no index yet: something may
	 * have been stored earlier.
	 *
	 * @return string
	 */
	public static function render_controls_block() {
		$consent  = Inkling_Settings::get( 'consent' );
		$manifest = 'off' === $consent ? null : Inkling_Catalog::manifest_url();
		wp_enqueue_script( 'inkling-controls' );
		wp_enqueue_style( 'inkling' );
		ob_start();
		?>
		<div <?php echo get_block_wrapper_attributes( array( 'class' => 'inkling-controls' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped by core. ?> data-inkling-controls data-manifest="<?php echo esc_url( (string) $manifest ); ?>" data-consent="<?php echo esc_attr( $consent ); ?>">
			<p class="inkling-controls__intro"><?php esc_html_e( 'Recommendations on this site are ranked in your browser. With your consent, it keeps a list of what you read here, on this device only.', 'inkling' ); ?></p>
			<?php if ( 'optin' === $consent && $manifest ) : ?>
				<p><label><input type="checkbox" data-inkling-consent disabled> <?php esc_html_e( 'Personalize recommendations', 'inkling' ); ?></label></p>
			<?php endif; ?>
			<p class="inkling-controls__buttons">
				<?php if ( $manifest ) : ?>
					<button type="button" data-inkling-pause disabled><?php esc_html_e( 'Pause', 'inkling' ); ?></button>
					<button type="button" data-inkling-export disabled><?php esc_html_e( 'Export', 'inkling' ); ?></button>
				<?php endif; ?>
				<button type="button" data-inkling-forget disabled><?php esc_html_e( 'Forget', 'inkling' ); ?></button>
			</p>
			<p><output data-inkling-status aria-live="polite"></output></p>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	/**
	 * With the WP Consent API, withdrawing the "preferences" category deletes what Inkling
	 * stored, on every page (not only where a list or the controls are).
	 */
	public static function consent_cleanup() {
		if ( 'wp-consent-api' !== Inkling_Settings::get( 'consent' ) ) {
			return;
		}
		wp_print_inline_script_tag(
			'document.addEventListener("wp_listen_for_consent_change", (e) => { if (e.detail?.preferences !== "deny") return; try { indexedDB.deleteDatabase("inkling").onsuccess = () => document.dispatchEvent(new Event("inkling:forgotten")); } catch {} });'
		);
	}

	/**
	 * Records the visitor's view of an indexed post (with consent), in the footer.
	 */
	public static function page_element() {
		if ( ! is_singular() || 'off' === Inkling_Settings::get( 'consent' ) ) {
			return;
		}
		$post     = get_queried_object();
		$manifest = Inkling_Catalog::manifest_url();
		if ( ! $post instanceof WP_Post || ! $manifest || ! Inkling_Catalog::is_indexed( $post ) ) {
			return;
		}
		wp_enqueue_script( 'inkling' );
		printf( '<inkling-page manifest="%s" item="%s"></inkling-page>', esc_url( $manifest ), esc_attr( Inkling_Catalog::item_id( $post ) ) );
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
		$types    = (array) Inkling_Settings::get( 'post_types' );
		$query    = array(
			'post_type'           => $types,
			'post_status'         => 'publish',
			'has_password'        => false,
			'posts_per_page'      => $count,
			'post__not_in'        => array( $post->ID ),
			'ignore_sticky_posts' => true,
		);
		$section  = Inkling_Catalog::section( $post );
		$category = 'category' === Inkling_Settings::get( 'sections' ) && $section ? get_cat_ID( $section ) : 0;
		$fallback = $category ? get_posts( $query + array( 'cat' => $category ) ) : array();
		// With "same section only", the browser shows nothing from other sections, so neither does
		// the fallback.
		$same = (bool) Inkling_Settings::get( 'related_same' );
		if ( count( $fallback ) < $count && ! ( $same && $category ) ) {
			$query['post__not_in']   = array_merge( array( $post->ID ), wp_list_pluck( $fallback, 'ID' ) );
			$query['posts_per_page'] = $count - count( $fallback );
			$fallback                = array_merge( $fallback, get_posts( $query ) );
		}
		$manifest   = Inkling_Catalog::manifest_url();
		$attributes = null;
		if ( $manifest ) {
			$attributes = array(
				'manifest' => $manifest,
				'item'     => Inkling_Catalog::item_id( $post ),
			);
			if ( $section ) {
				$attributes['section'] = $section;
			}
			if ( $same ) {
				$attributes['sections'] = 'same';
			}
		}
		return self::list_markup( 'inkling-related', $attributes, '' === $heading ? __( 'Related', 'inkling' ) : $heading, $fallback, $block );
	}

	/**
	 * A list of posts in slots, wrapped in an Inkling component when there is a manifest.
	 *
	 * @param string     $element    `inkling-related` or `inkling-for-you`.
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
		wp_enqueue_style( 'inkling' );
		$open  = '';
		$close = '';
		if ( null !== $attributes ) {
			wp_enqueue_script( 'inkling' );
			$open = '<' . $element;
			foreach ( $attributes as $name => $value ) {
				$open .= ' ' . $name . '="' . ( 'manifest' === $name ? esc_url( $value ) : esc_attr( $value ) ) . '"';
			}
			$open .= '>';
			$close = '</' . $element . '>';
		}
		$slots = '';
		foreach ( $posts as $post ) {
			$section = Inkling_Catalog::section( $post );
			$slots  .= sprintf(
				'<li class="inkling-slot" data-inkling-slot data-inkling-id="%1$s"><a class="inkling-slot__link" href="%2$s"><span class="inkling-slot__title" data-inkling-title>%3$s</span></a><span class="inkling-slot__meta"><span data-inkling-section>%4$s</span> <time data-inkling-date datetime="%5$s">%6$s</time></span></li>',
				esc_attr( Inkling_Catalog::item_id( $post ) ),
				esc_url( get_permalink( $post ) ),
				esc_html( Inkling_Format::html_to_text( get_the_title( $post ) ) ),
				esc_html( (string) $section ),
				esc_attr( Inkling_Format::iso_time( (int) get_post_time( 'U', true, $post ) ) ),
				esc_html( get_the_date( '', $post ) )
			);
		}
		$class   = 'inkling-list ' . ( 'inkling-related' === $element ? 'inkling-related' : 'inkling-for-you' );
		$wrapper = $block && WP_Block_Supports::$block_to_render ? get_block_wrapper_attributes( array( 'class' => $class ) ) : 'class="' . esc_attr( $class ) . '"';
		return sprintf(
			'<section %1$s><h2 class="inkling-list__heading">%2$s</h2>%3$s<ol class="inkling-list__items">%4$s</ol>%5$s</section>',
			$wrapper,
			esc_html( $heading ),
			$open,
			$slots,
			$close
		);
	}
}
