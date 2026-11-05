<?php
/**
 * The shard encoder, against bytes `encodeShard()` wrote for the same input.
 *
 * @package Inkling
 */

use PHPUnit\Framework\TestCase;

final class ShardTest extends TestCase {

	/**
	 * From src/format/shard.ts: `encodeShard({ space: 's', items }, vectors, 5, …)` with the
	 * vectors truncated from 6 to 5 dims.
	 */
	const INT8    = '494e4b56010100000500000002000000bf0000007b227370616365223a2273222c226974656d73223a5b7b226964223a2261222c2275726c223a222f612f222c227469746c65223a22436166c3a920e2809c31e2809d222c2273656374696f6e223a22466f6f64222c2274616773223a5b2278225d2c2264617465223a22323032362d30312d30315430303a30303a30302e3030305a222c227072696f72223a317d2c7b226964223a2262222c2275726c223a222f622f222c227469746c65223a2242222c227072696f72223a302e357d5d7d005f8110203f1933b46681';
	const FLOAT32 = '494e4b56010200000500000002000000bf0000007b227370616365223a2273222c226974656d73223a5b7b226964223a2261222c2275726c223a222f612f222c227469746c65223a22436166c3a920e2809c31e2809d222c2273656374696f6e223a22466f6f64222c2274616773223a5b2278225d2c2264617465223a22323032362d30312d30315430303a30303a30302e3030305a222c227072696f72223a317d2c7b226964223a2262222c2275726c223a222f622f222c227469746c65223a2242222c227072696f72223a302e357d5d7d00e9a20b3f8c2e3abf8c2eba3d8c2e3a3e8c2eba3e7d130a3e7d138a3e3c1dcfbe7d130a3f5d982cbf';

	private function items() {
		return array(
			array(
				'id'      => 'a',
				'url'     => '/a/',
				'title'   => "Caf\u{e9} \u{201c}1\u{201d}",
				'section' => 'Food',
				'tags'    => array( 'x' ),
				'date'    => '2026-01-01T00:00:00.000Z',
				'prior'   => 1,
			),
			array(
				'id'    => 'b',
				'url'   => '/b/',
				'title' => 'B',
				'prior' => 0.5,
			),
		);
	}

	private function rows( $quantization ) {
		return array(
			Inkling_Shard::row( array( 3, -4, 0.5, 1, 2, 9 ), 5, $quantization ),
			Inkling_Shard::row( array( 0.1, 0.2, -0.3, 0.4, -0.5, 7 ), 5, $quantization ),
		);
	}

	public function test_int8_shard_matches_node() {
		$this->assertSame( self::INT8, bin2hex( Inkling_Shard::encode( 's', $this->items(), $this->rows( 'int8' ), 5, 'int8' ) ) );
	}

	public function test_float32_shard_matches_node() {
		$this->assertSame( self::FLOAT32, bin2hex( Inkling_Shard::encode( 's', $this->items(), $this->rows( 'float32' ), 5, 'float32' ) ) );
	}

	public function test_vectors_start_at_a_multiple_of_four() {
		foreach ( array( '', 'x', 'xy', 'xyz', "\u{e9}" ) as $title ) {
			$bytes  = Inkling_Shard::encode(
				's',
				array(
					array(
						'id'    => 'a',
						'url'   => '/',
						'title' => $title,
						'prior' => 1,
					),
				),
				array( Inkling_Shard::row( array( 1, 2, 3 ), 3, 'int8' ) ),
				3,
				'int8'
			);
			$header = unpack( 'V', substr( $bytes, 16, 4 ) )[1];
			$start  = strlen( $bytes ) - 3;
			$this->assertSame( 0, $start % 4 );
			$this->assertSame( str_repeat( "\0", $start - 20 - $header ), substr( $bytes, 20 + $header, $start - 20 - $header ) );
		}
	}

	public function test_int8_rows_round_halves_up_like_javascript() {
		// The largest component maps to 127, and ±2/4 to ±63.5 exactly: Math.round gives -63
		// and 64 (PHP's round() would give -64). Node's encodeShard() writes these bytes.
		$row = unpack( 'c*', Inkling_Shard::row( array( 4, -2, 2, 1 ), 4, 'int8' ) );
		$this->assertSame( array( 127, -63, 64, 32 ), array_values( $row ) );
	}

	public function test_zero_vectors_stay_zero() {
		$this->assertSame( "\0\0\0", Inkling_Shard::row( array( 0, 0, 0 ), 3, 'int8' ) );
	}

	public function test_bad_input_is_rejected() {
		$this->expectException( LengthException::class );
		Inkling_Shard::encode( 's', $this->items(), array( "\0" ), 5, 'int8' );
	}

	public function test_short_vectors_are_rejected() {
		$this->expectException( LengthException::class );
		Inkling_Shard::row( array( 1, 2 ), 3, 'int8' );
	}
}
