<?php
/**
 * The WordPress Playground demo's content (scripts/playground.ts): the demo's articles as posts
 * with their EmbeddingGemma vectors, a "For you" front page, and the plugin's files written at
 * once, so the site ranks without downloading the model. Runs after wp-load.php, with the plugin
 * active, from a blueprint's runPHP step; reads /tmp/hunch-demo.json.
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || exit;

$hunch_demo = json_decode( (string) file_get_contents( '/tmp/hunch-demo.json' ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local file.
if ( ! is_array( $hunch_demo ) || ! class_exists( 'Hunch_Catalog' ) ) {
	throw new RuntimeException( 'Hunch demo: the plugin is not active, or demo.json is missing' );
}

// WordPress's sample content would be the only posts without a vector.
foreach ( get_posts(
	array(
		'post_type'   => array( 'post', 'page' ),
		'post_status' => 'any',
		'numberposts' => -1,
	)
) as $hunch_post ) {
	wp_delete_post( $hunch_post->ID, true );
}

foreach ( $hunch_demo['posts'] as $hunch_item ) {
	$hunch_term = term_exists( $hunch_item['section'], 'category' );
	if ( ! $hunch_term ) {
		$hunch_term = wp_insert_term( $hunch_item['section'], 'category' );
	}
	$hunch_date = gmdate( 'Y-m-d H:i:s', (int) strtotime( $hunch_item['date'] ) );
	$hunch_id   = wp_insert_post(
		array(
			'post_title'    => $hunch_item['title'],
			'post_content'  => $hunch_item['content'],
			'post_status'   => 'publish',
			'post_date'     => $hunch_date,
			'post_date_gmt' => $hunch_date,
			'post_category' => array( (int) $hunch_term['term_id'] ),
			'tags_input'    => $hunch_item['tags'],
		),
		true
	);
	if ( is_wp_error( $hunch_id ) ) {
		throw new RuntimeException( 'Hunch demo: ' . esc_html( $hunch_id->get_error_message() ) );
	}
	$hunch_post   = get_post( $hunch_id );
	$hunch_vector = Hunch_Catalog::check_vector( $hunch_item['vector'] );
	if ( is_wp_error( $hunch_vector ) ) {
		throw new RuntimeException( 'Hunch demo: ' . esc_html( $hunch_vector->get_error_message() ) );
	}
	Hunch_Catalog::store( $hunch_post, Hunch_Catalog::input( $hunch_post )['hash'], $hunch_vector );
}//end foreach

// The front page: "For you", and the controls that turn personalization on.
$hunch_home = wp_insert_post(
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
	)
);
update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $hunch_home );
update_option( 'permalink_structure', '/%postname%/' );
flush_rewrite_rules();

// Now, not on WP-Cron, which Playground doesn't run by itself.
$hunch_state = Hunch_Catalog::regenerate();
if ( is_wp_error( $hunch_state ) ) {
	throw new RuntimeException( 'Hunch demo: ' . esc_html( $hunch_state->get_error_message() ) );
}
