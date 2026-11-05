<?php
/**
 * Deleting the plugin removes its settings, the stored vectors and the published files.
 * Visitors' signals live in their own browsers; the privacy controls' "Forget" deletes them.
 *
 * @package Inkling
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'inkling_settings' );
delete_option( 'inkling_state' );
delete_transient( 'inkling_regenerating' );
wp_clear_scheduled_hook( 'inkling_regenerate' );
foreach ( array( '_inkling_vector', '_inkling_hash', '_inkling_model' ) as $inkling_key ) {
	delete_post_meta_by_key( $inkling_key );
}

$inkling_uploads = wp_upload_dir( null, false );
$inkling_dir     = $inkling_uploads['basedir'] . '/inkling';
if ( is_dir( $inkling_dir ) ) {
	foreach ( array_merge( (array) glob( $inkling_dir . '/shards/*.ink' ), array( $inkling_dir . '/manifest.json', $inkling_dir . '/.htaccess' ) ) as $inkling_file ) {
		if ( is_string( $inkling_file ) && is_file( $inkling_file ) ) {
			wp_delete_file( $inkling_file );
		}
	}
	@rmdir( $inkling_dir . '/shards' ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- best effort.
	@rmdir( $inkling_dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- best effort.
}
