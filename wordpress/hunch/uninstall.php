<?php
/**
 * Deleting the plugin removes its settings, the stored vectors and the published files, on
 * every site of a network. Visitors' signals live in their own browsers; the personalization
 * controls' "Forget" deletes them.
 *
 * @package Hunch
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/**
 * Removes Hunch's data from the current site.
 */
function hunch_uninstall_site() {
	foreach ( array( 'hunch_settings', 'hunch_state', 'hunch_retries', 'hunch_regenerating' ) as $option ) {
		delete_option( $option );
	}
	wp_clear_scheduled_hook( 'hunch_regenerate' );
	foreach ( array( '_hunch_vector', '_hunch_hash', '_hunch_model' ) as $key ) {
		delete_post_meta_by_key( $key );
	}

	$uploads = wp_upload_dir( null, false );
	$dir     = $uploads['basedir'] . '/hunch';
	if ( ! is_dir( $dir ) ) {
		return;
	}
	$files = array_merge(
		(array) glob( $dir . '/shards/*.hunch' ),
		(array) glob( $dir . '/shards/*.tmp' ),
		array( $dir . '/manifest.json', $dir . '/manifest.json.tmp', $dir . '/.htaccess' )
	);
	foreach ( $files as $file ) {
		if ( is_string( $file ) && is_file( $file ) ) {
			wp_delete_file( $file );
		}
	}
	@rmdir( $dir . '/shards' ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- best effort.
	@rmdir( $dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- best effort.
}

if ( is_multisite() ) {
	foreach ( get_sites(
		array(
			'fields' => 'ids',
			'number' => 0,
		)
	) as $hunch_site ) {
		switch_to_blog( $hunch_site );
		hunch_uninstall_site();
		restore_current_blog();
	}
} else {
	hunch_uninstall_site();
}
