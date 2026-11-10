<?php
/**
 * The plugin's settings, in one option.
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || defined( 'HUNCH_STANDALONE' ) || exit;

/**
 * Settings: defaults, reading and sanitizing.
 */
final class Hunch_Settings {

	const OPTION = 'hunch_settings';

	/**
	 * Allowed values of the choice settings.
	 */
	const CHOICES = array(
		'sections'     => array( 'category', 'none' ),
		'priors'       => array( 'recency', 'comments' ),
		'dims'         => array( 128, 256, 512, 768 ),
		'quantization' => array( 'int8', 'float32' ),
		'weights'      => array( 'q8', 'q4' ),
		'consent'      => array( 'optin', 'always', 'cookie', 'function', 'wp-consent-api', 'off' ),
	);

	/**
	 * The settings the published files depend on: changing one rewrites them (and `weights`
	 * also makes every vector stale). The others only change what the pages and wp-admin do.
	 */
	const CATALOG = array( 'post_types', 'sections', 'priors', 'dims', 'quantization', 'weights' );

	/**
	 * The defaults.
	 *
	 * @return array
	 */
	public static function defaults() {
		return array(
			'post_types'       => array( 'post' ),
			'sections'         => 'category',
			'priors'           => 'recency',
			'dims'             => 256,
			'quantization'     => 'int8',
			'weights'          => 'q8',
			'consent'          => 'optin',
			'consent_cookie'   => 'hunch_consent=yes',
			'consent_function' => 'hunchConsent',
			'related_auto'     => true,
			'related_count'    => 4,
			'related_same'     => false,
			'transformers_url' => 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js',
		);
	}

	/**
	 * All settings, or one.
	 *
	 * @param string|null $key A setting's name.
	 * @return mixed
	 */
	public static function get( $key = null ) {
		$stored   = get_option( self::OPTION, array() );
		$settings = array_merge( self::defaults(), is_array( $stored ) ? $stored : array() );
		return null === $key ? $settings : $settings[ $key ];
	}

	/**
	 * Whether two stored values of the option differ in a setting the published files depend
	 * on (see `CATALOG`), with the defaults for what either leaves out.
	 *
	 * @param mixed $old Stored settings.
	 * @param mixed $now Stored settings.
	 * @return bool
	 */
	public static function catalog_changed( $old, $now ) {
		$old = array_merge( self::defaults(), is_array( $old ) ? $old : array() );
		$now = array_merge( self::defaults(), is_array( $now ) ? $now : array() );
		foreach ( self::CATALOG as $key ) {
			// Loosely: a hand-stored "256" is the form's 256.
			if ( $old[ $key ] != $now[ $key ] ) { // phpcs:ignore Universal.Operators.StrictComparisons.LooseNotEqual
				return true;
			}
		}
		return false;
	}

	/**
	 * Sanitizes the settings form.
	 *
	 * @param mixed $input Submitted values.
	 * @return array
	 */
	public static function sanitize( $input ) {
		$input    = is_array( $input ) ? $input : array();
		$defaults = self::defaults();
		$out      = array();
		foreach ( self::CHOICES as $key => $allowed ) {
			$value       = isset( $input[ $key ] ) ? $input[ $key ] : $defaults[ $key ];
			$value       = is_int( $allowed[0] ) ? (int) $value : (string) $value;
			$out[ $key ] = in_array( $value, $allowed, true ) ? $value : $defaults[ $key ];
		}
		$types = isset( $input['post_types'] ) ? (array) $input['post_types'] : array();
		// Only public types: their posts are published in the shards for anyone to read.
		$out['post_types'] = array_values(
			array_filter(
				array_map( 'sanitize_key', $types ),
				static function ( $type ) {
					return 'attachment' !== $type && post_type_exists( $type ) && is_post_type_viewable( $type );
				}
			)
		);
		if ( ! $out['post_types'] ) {
			$out['post_types'] = $defaults['post_types'];
		}
		$cookie                = isset( $input['consent_cookie'] ) ? trim( (string) $input['consent_cookie'] ) : '';
		$out['consent_cookie'] = preg_match( '/^[A-Za-z0-9_.-]+=[^;\s]*$/', $cookie ) ? $cookie : $defaults['consent_cookie'];
		$function              = isset( $input['consent_function'] ) ? trim( (string) $input['consent_function'] ) : '';
		// A dotted path of identifiers only: it is written into an inline script.
		$out['consent_function'] = preg_match( '/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/', $function ) ? $function : $defaults['consent_function'];
		$out['related_auto']     = ! empty( $input['related_auto'] );
		$out['related_same']     = ! empty( $input['related_same'] );
		$out['related_count']    = max( 1, min( 12, isset( $input['related_count'] ) ? (int) $input['related_count'] : 4 ) );
		$url                     = isset( $input['transformers_url'] ) ? esc_url_raw( trim( (string) $input['transformers_url'] ), array( 'https', 'http' ) ) : '';
		$out['transformers_url'] = '' === $url ? $defaults['transformers_url'] : $url;
		return $out;
	}
}
