<?php
/**
 * The admin screens: the settings and "Build index" screen, and embedding on publish in the block
 * editor. The model runs in the editor's browser (ADR 0007).
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || exit;

/**
 * The admin screens.
 */
final class Hunch_Admin {

	const PAGE = 'hunch';

	/**
	 * Hooks.
	 */
	public static function init() {
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'admin_init', array( __CLASS__, 'privacy_policy' ) );
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		// wp-admin only: the block editor and the settings screen are the scripts' only users.
		add_action( 'admin_init', array( __CLASS__, 'register_scripts' ) );
		add_action( 'enqueue_block_editor_assets', array( __CLASS__, 'editor_assets' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( HUNCH_FILE ), array( __CLASS__, 'action_links' ) );
	}

	/**
	 * The settings.
	 */
	public static function register_settings() {
		register_setting(
			'hunch',
			Hunch_Settings::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( 'Hunch_Settings', 'sanitize' ),
				'default'           => Hunch_Settings::defaults(),
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
			'Hunch',
			'<p>' . esc_html__( 'Related posts and "for you" lists are ranked in your browser. With your consent, this site keeps a list of the posts you read, followed or hid in your browser\'s storage (IndexedDB) to rank the "for you" list. It is never sent to this site or anyone else. You can pause it, export it or delete it at any time with the privacy controls on this site.', 'hunch' ) . '</p>'
		);
	}

	/**
	 * Settings → Hunch.
	 */
	public static function menu() {
		add_options_page( __( 'Hunch', 'hunch' ), __( 'Hunch', 'hunch' ), 'manage_options', self::PAGE, array( __CLASS__, 'render_page' ) );
	}

	/**
	 * A "Settings" link on the Plugins screen.
	 *
	 * @param string[] $links Links.
	 * @return string[]
	 */
	public static function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ) . '">' . esc_html__( 'Settings', 'hunch' ) . '</a>' );
		return $links;
	}

	/**
	 * The embedding script shared by the editor and the "Build index" screen.
	 */
	public static function register_scripts() {
		$model = Hunch_Catalog::model();
		wp_register_script( 'hunch-embed', plugins_url( 'assets/embed.js', HUNCH_FILE ), array( 'wp-api-fetch', 'wp-i18n' ), HUNCH_VERSION, true );
		wp_set_script_translations( 'hunch-embed', 'hunch' );
		wp_add_inline_script(
			'hunch-embed',
			'window.hunchEmbedConfig = ' . wp_json_encode(
				array(
					'model'           => array(
						'id'         => $model['id'],
						'revision'   => $model['revision'],
						'dtype'      => $model['dtype'],
						'file'       => isset( $model['file'] ) ? $model['file'] : null,
						'nativeDims' => $model['nativeDims'],
					),
					/**
					 * Filters where the editor's browser loads Transformers.js from. Host it on
					 * the site to avoid the CDN.
					 *
					 * @param string $url The module's URL.
					 */
					'transformersUrl' => apply_filters( 'hunch_transformers_url', Hunch_Settings::get( 'transformers_url' ) ),
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
		if ( ! $screen || ! in_array( $screen->post_type, (array) Hunch_Settings::get( 'post_types' ), true ) ) {
			return;
		}
		wp_enqueue_script( 'hunch-editor', plugins_url( 'assets/editor.js', HUNCH_FILE ), array( 'hunch-embed', 'wp-data', 'wp-i18n', 'wp-notices' ), HUNCH_VERSION, true );
		wp_set_script_translations( 'hunch-editor', 'hunch' );
	}

	/**
	 * The line above "Build index": how many posts have a vector, the published index and
	 * what was left out of it. Also sent by the status route, for the screen to show after a
	 * build.
	 *
	 * @param array $status From `Hunch_Catalog::status()`.
	 * @return string Plain text.
	 */
	public static function summary( array $status ) {
		$state = $status['state'];
		$parts = array(
			sprintf(
				/* translators: 1: posts with a vector, 2: published posts */
				__( '%1$d of %2$d published posts have a vector. A post edited since it was embedded keeps its vector until the next Build index.', 'hunch' ),
				(int) $status['embedded'],
				(int) $status['total']
			),
		);
		if ( ! empty( $state['version'] ) ) {
			$parts[] = sprintf(
				/* translators: 1: number of posts, 2: build time */
				__( 'The published index has %1$d posts (built %2$s).', 'hunch' ),
				(int) $state['count'],
				(string) $state['generatedAt']
			);
		}
		if ( ! empty( $state['duplicates'] ) ) {
			$parts[] = sprintf(
				/* translators: %d: number of posts */
				_n(
					'%d post is left out: it has the same ID (its GUID) as a newer post.',
					'%d posts are left out: each has the same ID (its GUID) as a newer post.',
					(int) $state['duplicates'],
					'hunch'
				),
				(int) $state['duplicates']
			);
		}
		return implode( ' ', $parts );
	}

	/**
	 * The settings and "Build index" screen.
	 */
	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		wp_enqueue_script( 'hunch-index', plugins_url( 'assets/index.js', HUNCH_FILE ), array( 'hunch-embed', 'wp-i18n' ), HUNCH_VERSION, true );
		wp_set_script_translations( 'hunch-index', 'hunch' );
		$s      = Hunch_Settings::get();
		$name   = Hunch_Settings::OPTION;
		$status = Hunch_Catalog::status();
		$types  = get_post_types( array( 'public' => true ), 'objects' );
		unset( $types['attachment'] );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Hunch', 'hunch' ); ?></h1>

			<h2><?php esc_html_e( 'Index', 'hunch' ); ?></h2>
			<p><?php esc_html_e( 'Each post is embedded with EmbeddingGemma in your browser, on this screen or when you publish in the block editor. Only the resulting vector is stored on the site; the post\'s text is not sent anywhere else. The first time, the browser downloads the model (about 300 MB with q8 weights, 200 MB with q4) and keeps it in its cache.', 'hunch' ); ?></p>
			<div id="hunch-index" data-total="<?php echo esc_attr( (string) $status['total'] ); ?>">
				<p data-hunch-summary><?php echo esc_html( self::summary( $status ) ); ?></p>
				<?php if ( ! empty( $status['state']['error'] ) ) : ?>
					<div class="notice notice-error inline" data-hunch-error><p>
						<?php
						/* translators: %s: error message */
						printf( esc_html__( 'The last build failed: %s', 'hunch' ), esc_html( (string) $status['state']['error'] ) );
						?>
					</p></div>
				<?php endif; ?>
				<p>
					<button type="button" class="button button-primary" data-hunch-build><?php esc_html_e( 'Build index', 'hunch' ); ?></button>
					<button type="button" class="button" data-hunch-stop hidden><?php esc_html_e( 'Stop', 'hunch' ); ?></button>
				</p>
				<progress data-hunch-progress max="1" value="0" hidden></progress>
				<p><output data-hunch-status aria-live="polite"></output></p>
			</div>

			<form method="post" action="options.php">
				<?php settings_fields( 'hunch' ); ?>
				<h2><?php esc_html_e( 'Catalog', 'hunch' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Post types', 'hunch' ); ?></th>
						<td>
							<?php foreach ( $types as $type ) : ?>
								<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[post_types][]" value="<?php echo esc_attr( $type->name ); ?>" <?php checked( in_array( $type->name, $s['post_types'], true ) ); ?>> <?php echo esc_html( $type->labels->name ); ?></label><br>
							<?php endforeach; ?>
						</td>
					</tr>
					<?php
					self::select(
						'sections',
						__( 'Sections', 'hunch' ),
						array(
							'category' => __( 'Primary category (one shard per category)', 'hunch' ),
							'none'     => __( 'None (one shard)', 'hunch' ),
						),
						$s
					);
					self::select(
						'priors',
						__( 'Cold-start order', 'hunch' ),
						array(
							'recency'  => __( 'Newest first', 'hunch' ),
							'comments' => __( 'Most comments first', 'hunch' ),
						),
						$s
					);
					self::select(
						'dims',
						__( 'Dimensions', 'hunch' ),
						array(
							'128' => __( '128 (smaller files)', 'hunch' ),
							'256' => __( '256 (default)', 'hunch' ),
							'512' => '512',
							'768' => '768',
						),
						$s
					);
					self::select(
						'quantization',
						__( 'Quantization', 'hunch' ),
						array(
							'int8'    => __( 'int8 (default)', 'hunch' ),
							'float32' => 'float32',
						),
						$s
					);
					self::select(
						'weights',
						__( 'Model weights', 'hunch' ),
						array(
							'q8' => __( 'q8 (default, about 300 MB)', 'hunch' ),
							'q4' => __( 'q4 (experimental, about 200 MB)', 'hunch' ),
						),
						$s,
						__( 'The model the browser downloads to embed posts. Changing it makes every vector stale: click Build index right after saving. Until it finishes, the lists show your newest posts.', 'hunch' )
					);
					?>
					<tr>
						<th scope="row"><label for="hunch-transformers"><?php esc_html_e( 'Transformers.js URL', 'hunch' ); ?></label></th>
						<td><input type="url" class="large-text code" id="hunch-transformers" name="<?php echo esc_attr( $name ); ?>[transformers_url]" value="<?php echo esc_attr( $s['transformers_url'] ); ?>">
						<p class="description"><?php esc_html_e( 'Loaded in wp-admin only, to embed posts.', 'hunch' ); ?></p></td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'Personalization', 'hunch' ); ?></h2>
				<?php $consent_status = Hunch_Consent::status( $s['consent'] ); ?>
				<?php if ( $consent_status ) : ?>
					<div class="notice notice-<?php echo esc_attr( $consent_status['type'] ); ?> inline"><p><?php echo esc_html( $consent_status['message'] ); ?></p></div>
				<?php endif; ?>
				<table class="form-table" role="presentation">
					<?php
					self::select(
						'consent',
						__( 'Consent', 'hunch' ),
						array(
							'optin'          => __( 'The visitor turns it on in the privacy controls block', 'hunch' ),
							'cookie'         => __( 'A cookie set by the consent manager', 'hunch' ),
							'function'       => __( 'A JavaScript function of the consent manager', 'hunch' ),
							'wp-consent-api' => __( 'WP Consent API ("preferences" category)', 'hunch' ),
							'always'         => __( 'Always on (no consent needed on this site)', 'hunch' ),
							'off'            => __( 'Off (related posts only)', 'hunch' ),
						),
						$s
					);
					?>
					<tr>
						<th scope="row"><label for="hunch-cookie"><?php esc_html_e( 'Consent cookie', 'hunch' ); ?></label></th>
						<td><input type="text" class="regular-text code" id="hunch-cookie" name="<?php echo esc_attr( $name ); ?>[consent_cookie]" value="<?php echo esc_attr( $s['consent_cookie'] ); ?>">
						<p class="description"><?php esc_html_e( 'name=value: personalization is on while this cookie has this value.', 'hunch' ); ?></p></td>
					</tr>
					<tr>
						<th scope="row"><label for="hunch-function"><?php esc_html_e( 'Consent function', 'hunch' ); ?></label></th>
						<td><input type="text" class="regular-text code" id="hunch-function" name="<?php echo esc_attr( $name ); ?>[consent_function]" value="<?php echo esc_attr( $s['consent_function'] ); ?>">
						<p class="description"><?php esc_html_e( 'A global function returning true (or a promise of true) when the visitor agreed. It is asked before every read or write.', 'hunch' ); ?></p></td>
					</tr>
				</table>

				<h2><?php esc_html_e( 'Related posts', 'hunch' ); ?></h2>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'After the content', 'hunch' ); ?></th>
						<td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[related_auto]" value="1" <?php checked( $s['related_auto'] ); ?>> <?php esc_html_e( 'Show related posts after each post (or place the Related posts block yourself)', 'hunch' ); ?></label>
						<p class="description"><?php esc_html_e( 'Not added to a post whose content already holds the Related posts block, nor where the theme\'s template does.', 'hunch' ); ?></p></td>
					</tr>
					<tr>
						<th scope="row"><label for="hunch-count"><?php esc_html_e( 'Number of posts', 'hunch' ); ?></label></th>
						<td><input type="number" min="1" max="12" id="hunch-count" name="<?php echo esc_attr( $name ); ?>[related_count]" value="<?php echo esc_attr( (string) $s['related_count'] ); ?>"></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Sections', 'hunch' ); ?></th>
						<td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[related_same]" value="1" <?php checked( $s['related_same'] ); ?>> <?php esc_html_e( 'Only from the post\'s own section', 'hunch' ); ?></label></td>
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
	 * @param string $key         Setting.
	 * @param string $label       Label.
	 * @param array  $options     Value => label.
	 * @param array  $settings    Current settings.
	 * @param string $description Help text under the field (none when empty).
	 */
	private static function select( $key, $label, array $options, array $settings, $description = '' ) {
		$id = 'hunch-' . $key;
		?>
		<tr>
			<th scope="row"><label for="<?php echo esc_attr( $id ); ?>"><?php echo esc_html( $label ); ?></label></th>
			<td><select id="<?php echo esc_attr( $id ); ?>" name="<?php echo esc_attr( Hunch_Settings::OPTION . '[' . $key . ']' ); ?>">
				<?php foreach ( $options as $value => $text ) : ?>
					<option value="<?php echo esc_attr( (string) $value ); ?>" <?php selected( (string) $settings[ $key ], (string) $value ); ?>><?php echo esc_html( $text ); ?></option>
				<?php endforeach; ?>
			</select>
			<?php if ( '' !== $description ) : ?>
				<p class="description"><?php echo esc_html( $description ); ?></p>
			<?php endif; ?></td>
		</tr>
		<?php
	}
}
