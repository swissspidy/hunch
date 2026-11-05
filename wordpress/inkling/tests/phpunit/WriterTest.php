<?php
/**
 * The manifest and shard writer.
 *
 * @package Inkling
 */

use PHPUnit\Framework\TestCase;

final class WriterTest extends TestCase {

	private $dir;

	protected function setUp(): void {
		$this->dir = sys_get_temp_dir() . '/inkling-' . bin2hex( random_bytes( 6 ) );
	}

	protected function tearDown(): void {
		foreach ( (array) glob( $this->dir . '/shards/*' ) as $file ) {
			unlink( $file );
		}
		foreach ( (array) glob( $this->dir . '/*' ) as $file ) {
			if ( is_file( $file ) ) {
				unlink( $file );
			}
		}
		@rmdir( $this->dir . '/shards' );
		@rmdir( $this->dir );
	}

	private function items( $section_b = 'Travel' ) {
		return array(
			array(
				'id'      => '1',
				'url'     => '/1/',
				'title'   => 'One',
				'section' => 'Food',
			),
			array(
				'id'      => '2',
				'url'     => '/2/',
				'title'   => 'Two',
				'section' => $section_b,
				'tags'    => array(),
				'image'   => null,
			),
			array(
				'id'    => '3',
				'url'   => '/3/',
				'title' => 'Three',
			),
			array(
				'id'      => '4',
				'url'     => '/4/',
				'title'   => 'Four',
				'section' => 'Food',
			),
		);
	}

	private function write( array $items, array $extra = array() ) {
		$rows = array();
		foreach ( $items as $i => $item ) {
			$rows[] = Inkling_Shard::row( array( $i + 1, 1, -1, 0.5 ), 4, 'int8' );
		}
		return Inkling_Writer::write(
			$extra + array(
				'items' => $items,
				'rows'  => $rows,
				'dir'   => $this->dir,
				'model' => Inkling_Format::embedding_gemma(),
				'dims'  => 4,
				'now'   => '2026-11-05T10:00:00.000Z',
			)
		);
	}

	public function test_one_shard_per_section_in_catalog_order() {
		$manifest = $this->write( $this->items() )['manifest'];
		$this->assertSame( array( 'Food', 'Travel' ), $manifest['sections'] );
		$this->assertSame( array( 'Food', 'Travel', null ), array_column( $manifest['shards'], 'section' ) );
		$this->assertSame( array( 2, 1, 1 ), array_column( $manifest['shards'], 'count' ) );
		$this->assertMatchesRegularExpression( '#^shards/food\.[0-9a-f]{12}\.ink$#', $manifest['shards'][0]['url'] );
		$this->assertSame( 4, $manifest['count'] );
		foreach ( $manifest['shards'] as $shard ) {
			$bytes = file_get_contents( $this->dir . '/' . $shard['url'] );
			$this->assertSame( $shard['sha256'], hash( 'sha256', $bytes ) );
			$this->assertSame( $shard['bytes'], strlen( $bytes ) );
		}
		$this->assertSame( $manifest, json_decode( file_get_contents( $this->dir . '/manifest.json' ), true ) );
		// Files are written to .tmp and renamed into place: none is left behind.
		$this->assertSame( array(), array_merge( glob( $this->dir . '/*.tmp' ), glob( $this->dir . '/shards/*.tmp' ) ) );
	}

	public function test_empty_fields_are_left_out_and_priors_follow_catalog_order() {
		$manifest = $this->write( $this->items() )['manifest'];
		$bytes    = file_get_contents( $this->dir . '/' . $manifest['shards'][1]['url'] );
		$length   = unpack( 'V', substr( $bytes, 16, 4 ) )[1];
		$header   = json_decode( substr( $bytes, 20, $length ), true );
		$this->assertSame(
			array(
				'id'      => '2',
				'url'     => '/2/',
				'title'   => 'Two',
				'section' => 'Travel',
				'prior'   => 0.75,
			),
			$header['items'][0]
		);
	}

	public function test_priors_by_popularity_then_catalog_order() {
		$priors = Inkling_Writer::priors(
			array(
				array( 'popularity' => 1 ),
				array(),
				array( 'popularity' => 5 ),
				array(),
			)
		);
		$this->assertSame( array( 0.75, 0.5, 1, 0.25 ), array( $priors[0], $priors[1], $priors[2], $priors[3] ) );
	}

	public function test_an_unchanged_rebuild_keeps_the_time_and_old_shards_are_pruned() {
		$first  = $this->write( $this->items() )['manifest'];
		$second = $this->write( $this->items(), array( 'now' => '2027-01-01T00:00:00.000Z' ) );
		$this->assertSame( $first, $second['manifest'] );
		$this->assertSame( array(), $second['removed'] );

		// Moving item 2 changes shards; the first build's stay for clients holding its manifest.
		$third = $this->write( $this->items( 'Food' ), array( 'now' => '2027-01-01T00:00:00.000Z' ) );
		$this->assertSame( '2027-01-01T00:00:00.000Z', $third['manifest']['generatedAt'] );
		$this->assertSame( array(), $third['removed'] );
		// One build later, the first build's Travel shard is in neither manifest.
		$fourth = $this->write( $this->items( 'Other' ), array( 'now' => '2027-01-02T00:00:00.000Z' ) );
		$this->assertCount( 1, $fourth['removed'] );
		$this->assertStringStartsWith( 'travel.', $fourth['removed'][0] );
	}

	public function test_shard_by_none_and_splitting() {
		$manifest = $this->write( $this->items(), array( 'shard_by' => 'none' ) )['manifest'];
		$this->assertSame( array( null ), array_column( $manifest['shards'], 'section' ) );
		$this->assertSame( array( 'Food', 'Travel' ), $manifest['sections'] );

		$manifest = $this->write( $this->items(), array( 'max_shard_items' => 1 ) )['manifest'];
		$this->assertSame( 4, count( $manifest['shards'] ) );
		$this->assertMatchesRegularExpression( '#^shards/food-2\.#', $manifest['shards'][1]['url'] );
	}

	public function test_an_empty_catalog_is_an_error() {
		$this->expectException( LengthException::class );
		$this->write( array() );
	}
}
