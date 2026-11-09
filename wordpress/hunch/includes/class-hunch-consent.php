<?php
/**
 * The WP Consent API (https://wpconsentapi.org/): Hunch registers as a plugin that follows it,
 * describes what it stores so consent managers can list it, and tells the site owner when the
 * "WP Consent API" setting can't work as they'd expect.
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || exit;

/**
 * The WP Consent API integration.
 */
final class Hunch_Consent {

	/**
	 * The consent category Hunch asks for: a reading history that tailors the site to the
	 * visitor, kept on their device.
	 */
	const CATEGORY = 'preferences';

	/**
	 * Hooks.
	 */
	public static function init() {
		// Consent managers (and the API's Site Health check) list plugins that don't register.
		add_filter( 'wp_consent_api_registered_' . plugin_basename( HUNCH_FILE ), '__return_true' );
		add_action( 'init', array( __CLASS__, 'describe_storage' ) );
	}

	/**
	 * Whether the WP Consent API plugin is active.
	 *
	 * @return bool
	 */
	public static function available() {
		return function_exists( 'wp_has_consent' ) && function_exists( 'wp_add_cookie_info' );
	}

	/**
	 * Describes what Hunch stores in the visitor's browser, for the consent manager's cookie
	 * policy. Nothing is described when personalization is off.
	 */
	public static function describe_storage() {
		$consent = Hunch_Settings::get( 'consent' );
		if ( ! self::available() || 'off' === $consent ) {
			return;
		}
		wp_add_cookie_info(
			'hunch',
			'Hunch',
			self::CATEGORY,
			__( '180 days', 'hunch' ),
			__( 'Remembers which posts you read, followed or hid on this site, to rank the "for you" list in your browser. Kept in your browser\'s IndexedDB storage and never sent to this site or anyone else.', 'hunch' ),
			__( 'Reading history on this site, on this device only', 'hunch' ),
			false,
			false,
			// The API's types are HTTP, LOCALSTORAGE and API: the closest to IndexedDB, which the
			// description names.
			'LOCALSTORAGE'
		);
		if ( 'optin' === $consent ) {
			wp_add_cookie_info(
				'hunch-consent',
				'Hunch',
				'functional',
				__( 'Until you turn personalization off', 'hunch' ),
				__( 'Remembers that you turned on personalized recommendations in the privacy controls.', 'hunch' ),
				'',
				false,
				false,
				'LOCALSTORAGE'
			);
		}
	}

	/**
	 * What the site owner should know about the consent setting, for the settings screen.
	 *
	 * @param string $consent The consent setting.
	 * @return array{type: string, message: string}|null
	 */
	public static function status( $consent ) {
		if ( 'wp-consent-api' === $consent ) {
			if ( ! self::available() ) {
				return array(
					'type'    => 'error',
					'message' => __( 'The WP Consent API plugin is not active, so no visitor can consent and personalization stays off. Install and activate it, or choose another setting.', 'hunch' ),
				);
			}
			if ( function_exists( 'wp_get_consent_type' ) && ! wp_get_consent_type() ) {
				// The API's own rule: with no consent type, wp_has_consent() is true for everyone.
				// Hunch doesn't follow it (see Hunch_Front::consent_js()).
				return array(
					'type'    => 'warning',
					'message' => __( 'No consent manager on this site sets a consent type. The WP Consent API then reports consent for every visitor, so Hunch waits instead for each visitor to turn personalization on in the privacy controls block. Add that block to a page, or activate a consent manager that supports the WP Consent API.', 'hunch' ),
				);
			}
			return null;
		}
		if ( self::available() && 'off' !== $consent && 'always' !== $consent ) {
			return array(
				'type'    => 'info',
				'message' => __( 'The WP Consent API is active on this site. Choose "WP Consent API" so your consent manager decides, and the privacy controls block and the cookie banner stay in step.', 'hunch' ),
			);
		}
		return null;
	}
}
