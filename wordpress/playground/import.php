<?php
/**
 * The WordPress Playground demo's content (scripts/playground.ts): the demo's articles as posts
 * with their EmbeddingGemma vectors, a "For you" front page, and the plugin's files written at
 * once, so the site ranks without downloading the model. Runs after wp-load.php, with the plugin
 * active, from a blueprint's runPHP step; reads /tmp/hunch-demo.json.
 *
 * The site's own posts and pages (on a fresh Playground, WordPress's samples, which would be the
 * only posts without a vector) are deleted only once the demo is in; if anything fails, what the
 * import created is deleted again and the site is left as it was.
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || exit;

$hunch_demo = json_decode( (string) file_get_contents( '/tmp/hunch-demo.json' ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local file.
if ( ! class_exists( 'Hunch_Catalog' ) ) {
	throw new RuntimeException( 'Hunch demo: the plugin is not active' );
}
if ( ! is_array( $hunch_demo ) || empty( $hunch_demo['posts'] ) || ! is_array( $hunch_demo['posts'] ) ) {
	throw new RuntimeException( 'Hunch demo: demo.json is missing or has no posts' );
}

$hunch_existing = get_posts(
	array(
		'post_type'   => array( 'post', 'page' ),
		'post_status' => 'any',
		'numberposts' => -1,
		'fields'      => 'ids',
	)
);
$hunch_created  = array();

/**
 * Throws if a WordPress call failed.
 *
 * @param mixed $result A post or term id, a term array, or a WP_Error.
 * @return mixed The result.
 * @throws RuntimeException On a WP_Error or a zero id.
 */
function hunch_demo_check( $result ) {
	if ( is_wp_error( $result ) ) {
		throw new RuntimeException( 'Hunch demo: ' . esc_html( $result->get_error_message() ) );
	}
	if ( empty( $result ) ) {
		throw new RuntimeException( 'Hunch demo: WordPress could not save the content' );
	}
	return $result;
}

try {
	foreach ( $hunch_demo['posts'] as $hunch_item ) {
		$hunch_term = term_exists( $hunch_item['section'], 'category' );
		if ( ! $hunch_term ) {
			$hunch_term = hunch_demo_check( wp_insert_term( $hunch_item['section'], 'category' ) );
		}
		$hunch_date      = gmdate( 'Y-m-d H:i:s', (int) strtotime( $hunch_item['date'] ) );
		$hunch_id        = hunch_demo_check(
			wp_insert_post(
				array(
					'post_title'    => $hunch_item['title'],
					'post_content'  => $hunch_item['content'],
					'post_status'   => 'publish',
					'post_date'     => get_date_from_gmt( $hunch_date ),
					'post_date_gmt' => $hunch_date,
					'post_category' => array( (int) $hunch_term['term_id'] ),
					'tags_input'    => $hunch_item['tags'],
				),
				true
			)
		);
		$hunch_created[] = $hunch_id;
		$hunch_post      = get_post( $hunch_id );
		$hunch_vector    = hunch_demo_check( Hunch_Catalog::check_vector( $hunch_item['vector'] ) );
		Hunch_Catalog::store( $hunch_post, Hunch_Catalog::input( $hunch_post )['hash'], $hunch_vector );
	}//end foreach

	// The front page: "For you", and the controls that turn personalization on.
	$hunch_home      = hunch_demo_check(
		wp_insert_post(
			array(
				'post_type'    => 'page',
				'post_title'   => 'Field Notes',
				'post_status'  => 'publish',
				'post_content' => implode(
					"\n\n",
					array(
						'<!-- wp:paragraph --><p>A demo of Hunch. Open any article: its related posts are ranked in your browser. Turn on personalization below, read a few articles, and come back: “For you” follows what you read. Nothing about you leaves your browser.</p><!-- /wp:paragraph -->',
						'<!-- wp:heading --><h2 class="wp-block-heading">For you</h2><!-- /wp:heading -->',
						'<!-- wp:hunch/for-you /-->',
						'<!-- wp:heading --><h2 class="wp-block-heading">Your data</h2><!-- /wp:heading -->',
						'<!-- wp:hunch/privacy-controls /-->',
					)
				),
			),
			true
		)
	);
	$hunch_created[] = $hunch_home;
} catch ( Exception $e ) {
	foreach ( $hunch_created as $hunch_id ) {
		wp_delete_post( $hunch_id, true );
	}
	throw $e;
}//end try

foreach ( $hunch_existing as $hunch_id ) {
	wp_delete_post( $hunch_id, true );
}
update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $hunch_home );
update_option( 'permalink_structure', '/%postname%/' );
flush_rewrite_rules();

// Now, not on WP-Cron, which Playground doesn't run by itself.
hunch_demo_check( Hunch_Catalog::regenerate() );
