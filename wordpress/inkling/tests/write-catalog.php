<?php
/**
 * The cross-language test's driver (test/unit/wordpress.test.ts): reads a JSON job on stdin,
 * writes the catalog with the plugin's encoder, and prints the text helpers' results as JSON.
 *
 * Job: { dir, model, dims, quantization, shardBy?, maxShardItems?, now, items: [{ …, vector }],
 *        html: string[], inputs: [{ title, text }] }
 *
 * @package Inkling
 */

require __DIR__ . '/bootstrap.php';

$job   = json_decode( (string) stream_get_contents( STDIN ), true, 512, JSON_THROW_ON_ERROR );
$rows  = array();
$items = array();
foreach ( $job['items'] as $item ) {
	$rows[] = Inkling_Shard::row( $item['vector'], $job['dims'], $job['quantization'] );
	unset( $item['vector'] );
	$items[] = $item;
}
$result = Inkling_Writer::write(
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
	$text     = Inkling_Format::document_input( $job['model']['documentPrompt'], $input['title'], $input['text'] );
	$inputs[] = array(
		'input' => $text,
		'hash'  => Inkling_Format::input_hash( $job['model'], $text ),
	);
}
echo Inkling_Format::json( // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- a test driver writing JSON.
	array(
		'removed' => $result['removed'],
		'html'    => array_map( array( 'Inkling_Format', 'html_to_text' ), $job['html'] ),
		'inputs'  => $inputs,
		'fnv1a'   => Inkling_Format::fnv1a( $job['model']['documentPrompt'] ),
		'space'   => Inkling_Format::space_key( $job['model'], $job['dims'] ),
	)
);
