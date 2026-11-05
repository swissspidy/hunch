<?php
/**
 * The admin screens: the settings and "Build index" screen, and embedding on publish in the block
 * editor. The model runs in the editor's browser (ADR 0007).
 *
 * @package Inkling
 */

defined( 'ABSPATH' ) || exit;

/**
 * The admin screens.
 */
final class Inkling_Admin {

	const PAGE = 'inkling';

	/**
	 * Hooks.
	 */
	public static function init() {
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'admin_init', array( __CLASS__, 'privacy_policy' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'init', array( __CLASS__, 'register_scripts' ) );
		add_action( 'enqueue_block_editor_assets', array( __CLASS__, 'editor_assets' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( INKLING_FILE ), array( __CLASS__, 'action_links' ) );
	}

	/**
	 * The settings.
	 */
	public static function register_settings() {
		register_setting(
			'inkling',
			Inkling_Settings::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( 'Inkling_Settings', 'sanitize' ),
				'default'           => Inkling_Settings::defaults(),
			)
		);
	}

	/**
	 * Suggested text for the site's privacy policy.
	 */
	public static function privacy_policy() {
		if ( ! function_exists( 'wp_add_privacy_policy_content' ) ) {
			return;
		}
		wp_add_privacy_policy_content(
			'Inkling',
			'<p>' . esc_html__( 'Related posts and "for you" lists are ranked in your browser. With your consent, this site keeps a list of the posts you read, followed or hid in your browser\'s storage (IndexedDB) to rank the "for you" list. It is never sent to this site or anyone else. You can pause it, export it or delete it at any time with the privacy controls on this site.', 'inkling' ) . '</p>'
		);
	}

	/**
	 * Settings → Inkling.
	 */
	public static function menu() {
		add_options_page( __( 'Inkling', 'inkling' ), __( 'Inkling', 'inkling' ), 'manage_options', self::PAGE, array( __CLASS__, 'render_page' ) );
	}

	/**
	 * A "Settings" link on the Plugins screen.
	 *
	 * @param string[] $links Links.
	 * @return string[]
	 */
	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ) . '">' . esc_html__( 'Settings', 'inkling' ) . '</a>' );
		return $links;
	}

	/**
	 * The embedding script shared by the editor and the "Build index" screen.
	 */
	public static function register_scripts() {
		$model = Inkling_Catalog::model();
		wp_register_script( 'inkling-embed', plugins_url( 'assets/embed.js', INKLING_FILE ), array( 'wp-api-fetch' ), INKLING_VERSION, true );
		wp_add_inline_script(
			'inkling-embed',
			'window.inklingEmbedConfig = ' . wp_json_encode(
				array(
					'model'           => array(
						'id'         => $model['id'],
						'revision'   => $model['revision'],
						'dtype'      => $model['dtype'],
						'nativeDims' => $model['nativeDims'],
					),
					/**
					 * Filters where the editor's browser loads Transformers.js from. Host it on
					 * the site to avoid the CDN.
					 *
					 * @param string $url The module's URL.
					 */
					'transformersUrl' => apply_filters( 'inkling_transformers_url', Inkling_Settings::get( 'transformers_url' ) ),
				)
			) . ';',
			'before'
		);
	}

	/**
	 * Embedding on publish, in the block editor.
	 */
	public static function editor_assets() {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen || ! in_array( $screen->post_type, (array) Inkling_Settings::get( 'post_types' ), true ) ) {
			return;
		}
		wp_enqueue_script( 'inkling-editor', plugins_url( 'assets/editor.js', INKLING_FILE ), array( 'inkling-embed', 'wp-data', 'wp-notices' ), INKLING_VERSION, true );
	}

	/**
	 * The settings and "Build index" screen.
	 */
	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		wp_enqueue_script( 'inkling-index', plugins_url( 'assets/index.js', INKLING_FILE ), array( 'inkling-embed' ), INKLING_VERSION, true );
		$s      = Inkling_Settings::get();
		$name   = Inkling_Settings::OPTION;
		$status = Inkling_Catalog::status();
		$types  = get_post_types( array( 'public' => true ), 'objects' );
		unset( $types['attachment'] );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Inkling', 'inkling' ); ?></h1>

			<h2><?php esc_html_e( 'Index', 'inkling' ); ?></h2>
			<p><?php esc_html_e( 'Each post is embedded with EmbeddingGemma in your browser, on this screen or when you publish in the block editor. Only the resulting vector is stored on the site; the post\'s text is not sent anywhere else. The first time, the browser downloads the model (about 300 MB) and keeps it in its cache.', 'inkling' ); ?></p>
			<div id="inkling-index" data-total="<?php echo esc_attr( (string) $status['total'] ); ?>">
				<p>
					<?php
					printf(
						/* translators: 1: posts with a vector, 2: published posts */
						esc_html__( '%1$d of %2$d published posts have a vector.', 'inkling' ),
						(int) $status['embedded'],
						(int) $status['total']
					);
					if ( ! empty( $status['state']['version'] ) ) {
						echo ' ';
						printf(
							/* translators: 1: number of posts, 2: build time */
							esc_html__( 'The published index has %1$d posts (built %2$s).', 'inkling' ),
							(int) $status['state']['count'],
							esc_html( (string) $status['state']['generatedAt'] )
						);
					}
					?>
				</p>
				<p>
					<button type="button" class="button button-primary" data-inkling-build><?php esc_html_e( 'Build index', 'inkling' ); ?></button>
					<button type="button" class="button" data-inkling-stop hidden><?php esc_html_e( 'Stop', 'inkling' ); ?></button>
				</p>
				<progress data-inkling-progress max="1" value="0" hidden></progress>
				<p><output data-inkling-status aria-live="polite"></output></p>
			</div>

			<form method="post" action="options.php">
				<?php settings_fields( 'inkling' ); ?>
				<h2><?php esc_html_e( 'Catalog', 'inkling' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Post types', 'inkling' ); ?></th>
						<td>
							<?php foreach ( $types as $type ) : ?>
								<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[post_types][]" value="<?php echo esc_attr( $type->name ); ?>" <?php checked( in_array( $type->name, $s['post_types'], true ) ); ?>> <?php echo esc_html( $type->labels->name ); ?></label><br>
							<?php endforeach; ?>
						</td>
					</tr>
					<?php
					self::select(
						'sections',
						__( 'Sections', 'inkling' ),
						array(
							'category' => __( 'Primary category (one shard per category)', 'inkling' ),
							'none'     => __( 'None (one shard)', 'inkling' ),
						),
						$s
					);
					self::select(
						'priors',
						__( 'Cold-start order', 'inkling' ),
						array(
							'recency'  => __( 'Newest first', 'inkling' ),
							'comments' => __( 'Most comments first', 'inkling' ),
						),
						$s
					);
					self::select(
						'dims',
						__( 'Dimensions', 'inkling' ),
						array(
							'128' => __( '128 (smaller files)', 'inkling' ),
							'256' => __( '256 (default)', 'inkling' ),
							'512' => '512',
							'768' => '768',
						),
						$s
					);
					self::select(
						'quantization',
						__( 'Quantization', 'inkling' ),
						array(
							'int8'    => __( 'int8 (default)', 'inkling' ),
							'float32' => 'float32',
						),
						$s
					);
					?>
					<tr>
						<th scope="row"><label for="inkling-transformers"><?php esc_html_e( 'Transformers.js URL', 'inkling' ); ?></label></th>
						<td><input type="url" class="large-text code" id="inkling-transformers" name="<?php echo esc_attr( $name ); ?>[transformers_url]" value="<?php echo esc_attr( $s['transformers_url'] ); ?>">
						<p class="description"><?php esc_html_e( 'Loaded in wp-admin only, to embed posts.', 'inkling' ); ?></p></td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'Personalization', 'inkling' ); ?></h2>
				<table class="form-table" role="presentation">
					<?php
					self::select(
						'consent',
						__( 'Consent', 'inkling' ),
						array(
							'optin'          => __( 'The visitor turns it on in the privacy controls block', 'inkling' ),
							'cookie'         => __( 'A cookie set by the consent manager', 'inkling' ),
							'function'       => __( 'A JavaScript function of the consent manager', 'inkling' ),
							'wp-consent-api' => __( 'WP Consent API ("preferences" category)', 'inkling' ),
							'always'         => __( 'Always on (no consent needed on this site)', 'inkling' ),
							'off'            => __( 'Off (related posts only)', 'inkling' ),
						),
						$s
					);
					?>
					<tr>
						<th scope="row"><label for="inkling-cookie"><?php esc_html_e( 'Consent cookie', 'inkling' ); ?></label></th>
						<td><input type="text" class="regular-text code" id="inkling-cookie" name="<?php echo esc_attr( $name ); ?>[consent_cookie]" value="<?php echo esc_attr( $s['consent_cookie'] ); ?>">
						<p class="description"><?php esc_html_e( 'name=value: personalization is on while this cookie has this value.', 'inkling' ); ?></p></td>
					</tr>
					<tr>
						<th scope="row"><label for="inkling-function"><?php esc_html_e( 'Consent function', 'inkling' ); ?></label></th>
						<td><input type="text" class="regular-text code" id="inkling-function" name="<?php echo esc_attr( $name ); ?>[consent_function]" value="<?php echo esc_attr( $s['consent_function'] ); ?>">
						<p class="description"><?php esc_html_e( 'A global function returning true (or a promise of true) when the visitor agreed. It is asked before every read or write.', 'inkling' ); ?></p></td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'Related posts', 'inkling' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'After the content', 'inkling' ); ?></th>
						<td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[related_auto]" value="1" <?php checked( $s['related_auto'] ); ?>> <?php esc_html_e( 'Show related posts after each post (or place the Related posts block yourself)', 'inkling' ); ?></label></td>
					</tr>
					<tr>
						<th scope="row"><label for="inkling-count"><?php esc_html_e( 'Number of posts', 'inkling' ); ?></label></th>
						<td><input type="number" min="1" max="12" id="inkling-count" name="<?php echo esc_attr( $name ); ?>[related_count]" value="<?php echo esc_attr( (string) $s['related_count'] ); ?>"></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Sections', 'inkling' ); ?></th>
						<td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[related_same]" value="1" <?php checked( $s['related_same'] ); ?>> <?php esc_html_e( 'Only from the post\'s own section', 'inkling' ); ?></label></td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}

	/**
	 * A select row.
	 *
	 * @param string $key      Setting.
	 * @param string $label    Label.
	 * @param array  $options  Value => label.
	 * @param array  $settings Current settings.
	 */
	private static function select( $key, $label, array $options, array $settings ) {
		$id = 'inkling-' . $key;
		?>
		<tr>
			<th scope="row"><label for="<?php echo esc_attr( $id ); ?>"><?php echo esc_html( $label ); ?></label></th>
			<td><select id="<?php echo esc_attr( $id ); ?>" name="<?php echo esc_attr( Inkling_Settings::OPTION . '[' . $key . ']' ); ?>">
				<?php foreach ( $options as $value => $text ) : ?>
					<option value="<?php echo esc_attr( (string) $value ); ?>" <?php selected( (string) $settings[ $key ], (string) $value ); ?>><?php echo esc_html( $text ); ?></option>
				<?php endforeach; ?>
			</select></td>
		</tr>
		<?php
	}
}
