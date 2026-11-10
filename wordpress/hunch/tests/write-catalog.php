<?php
/**
 * The cross-language test's driver (test/unit/wordpress.test.ts): reads a JSON job on stdin,
 * writes the catalog with the plugin's encoder, and prints the text helpers' results as JSON.
 *
 * Job: { dir, model, dims, quantization, shardBy?, maxShardItems?, now, items: [{ …, vector }],
 *        html: string[], inputs: [{ title, text }], numbers?: string[], weights? }
 *
 * With `weights`, also prints the model Hunch_Catalog::model() picks for that setting.
 *
 * @package Hunch
 */

require __DIR__ . '/bootstrap.php';

$job = json_decode( (string) stream_get_contents( STDIN ), true, 512, JSON_THROW_ON_ERROR );

if ( isset( $job['weights'] ) ) {
	// Just enough WordPress for the settings and catalog classes: the stored settings.
	define( 'ABSPATH', __DIR__ . '/' );
	/**
	 * The stored settings: only the weights variant.
	 *
	 * @return array
	 */
	function get_option() {
		global $job;
		return array( 'weights' => $job['weights'] );
	}
	require_once dirname( __DIR__ ) . '/includes/class-hunch-settings.php';
	require_once dirname( __DIR__ ) . '/includes/class-hunch-catalog.php';
}
$rows  = array();
$items = array();
foreach ( $job['items'] as $item ) {
	$rows[] = Hunch_Shard::row( $item['vector'], $job['dims'], $job['quantization'] );
	unset( $item['vector'] );
	$items[] = $item;
}
$result = Hunch_Writer::write(
	array(
		'items'           => $items,
		'rows'            => $rows,
		'dir'             => $job['dir'],
		'model'           => $job['model'],
		'dims'            => $job['dims'],
		'quantization'    => $job['quantization'],
		'shard_by'        => isset( $job['shardBy'] ) ? $job['shardBy'] : 'section',
		'max_shard_items' => isset( $job['maxShardItems'] ) ? $job['maxShardItems'] : 2000,
		'now'             => $job['now'],
	)
);
$inputs = array();
foreach ( $job['inputs'] as $input ) {
	$text     = Hunch_Format::document_input( $job['model']['documentPrompt'], $input['title'], $input['text'] );
	$inputs[] = array(
		'input' => $text,
		'hash'  => Hunch_Format::input_hash( $job['model'], $text ),
	);
}
echo Hunch_Format::json( // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- a test driver writing JSON.
	array(
		'removed' => $result['removed'],
		'html'    => array_map( array( 'Hunch_Format', 'html_to_text' ), $job['html'] ),
		'inputs'  => $inputs,
		'fnv1a'   => Hunch_Format::fnv1a( $job['model']['documentPrompt'] ),
		'space'   => Hunch_Format::space_key( $job['model'], $job['dims'] ),
		'model'   => isset( $job['weights'] ) ? Hunch_Catalog::model() : null,
		'numbers' => array_map(
			static function ( $number ) {
				// As a float, however it is written: 1e21 and 1 alike.
				return Hunch_Format::json( (float) $number );
			},
			isset( $job['numbers'] ) ? $job['numbers'] : array()
		),
	)
);
