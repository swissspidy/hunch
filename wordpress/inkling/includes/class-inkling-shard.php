<?php
/**
 * The INKV vector shard of ADR 0001, written byte for byte as `encodeShard()` in
 * src/format/shard.ts writes it. No WordPress needed.
 *
 * Layout, little-endian: magic "INKV", u8 format version (1), u8 quantization (1 = int8,
 * 2 = float32), u16 reserved, u32 dims, u32 count, u32 header length H, H bytes of UTF-8 JSON
 * `{ "space", "items" }`, zero padding to a multiple of 4, then the rows.
 *
 * @package Inkling
 */

defined( 'ABSPATH' ) || defined( 'INKLING_STANDALONE' ) || exit;

/**
 * Shard encoding.
 */
final class Inkling_Shard {

	const FORMAT_VERSION = 1;
	const FIXED_HEADER   = 20;

	/**
	 * One stored row: the model's vector truncated to `$dims` components (Matryoshka),
	 * renormalized and rounded to float32 as the Node build does, then quantized.
	 *
	 * @param float[] $vector       The model's output (at least `$dims` long, finite).
	 * @param int     $dims         Published dimensions.
	 * @param string  $quantization `int8` or `float32`.
	 * @return string `$dims` bytes (int8) or `4 * $dims` bytes (float32).
	 * @throws LengthException          When the vector is shorter than `$dims`.
	 * @throws InvalidArgumentException When the quantization is unknown.
	 */
	public static function row( array $vector, $dims, $quantization ) {
		$vector = array_values( $vector );
		if ( count( $vector ) < $dims ) {
			throw new LengthException( sprintf( 'Inkling: cannot truncate %d dims to %d', count( $vector ), $dims ) );
		}
		// The Node build keeps the model's output as float32 before truncating it.
		$unit = self::unit( array_values( (array) unpack( 'g*', pack( 'g*', ...array_slice( $vector, 0, $dims ) ) ) ) );
		if ( 'float32' === $quantization ) {
			return pack( 'g*', ...$unit );
		}
		if ( 'int8' !== $quantization ) {
			throw new InvalidArgumentException( 'Inkling: unknown quantization ' . $quantization );
		}
		// round( v / max|v| * 127 ), with JavaScript's Math.round (halves round up).
		$max = 0.0;
		foreach ( $unit as $x ) {
			$max = max( $max, abs( $x ) );
		}
		$scale = $max > 0 ? 127 / $max : 0.0;
		$bytes = array();
		foreach ( $unit as $x ) {
			$y       = $x * $scale;
			$r       = floor( $y );
			$r      += ( $y - $r >= 0.5 ) ? 1 : 0;
			$bytes[] = ( (int) $r ) & 0xff;
		}
		return pack( 'C*', ...$bytes );
	}

	/**
	 * Encodes a shard.
	 *
	 * @param string   $space        The embedding space.
	 * @param array[]  $items        Published items (`id`, `url`, `title`, optional `section`,
	 *                               `tags`, `date`, `image`, then `prior`), in this key order.
	 * @param string[] $rows         One row per item, from `row()`.
	 * @param int      $dims         Published dimensions.
	 * @param string   $quantization `int8` or `float32`.
	 * @return string The shard file's bytes.
	 * @throws LengthException When the rows don't match the items or the dimensions.
	 */
	public static function encode( $space, array $items, array $rows, $dims, $quantization ) {
		if ( count( $items ) !== count( $rows ) ) {
			throw new LengthException( sprintf( 'Inkling: %d items but %d vectors', count( $items ), count( $rows ) ) );
		}
		$width = 'int8' === $quantization ? 1 : 4;
		foreach ( $rows as $i => $row ) {
			if ( strlen( $row ) !== $dims * $width ) {
				throw new LengthException( sprintf( 'Inkling: row %d has %d bytes, not %d', $i, strlen( $row ), $dims * $width ) );
			}
		}
		$json    = Inkling_Format::json(
			array(
				'space' => $space,
				'items' => array_values( $items ),
			)
		);
		$length  = strlen( $json );
		$padding = self::align4( self::FIXED_HEADER + $length ) - self::FIXED_HEADER - $length;
		return 'INKV'
			. pack( 'CCvVVV', self::FORMAT_VERSION, 'int8' === $quantization ? 1 : 2, 0, $dims, count( $rows ), $length )
			. $json
			. str_repeat( "\0", $padding )
			. implode( '', $rows );
	}

	/**
	 * A unit vector, each component rounded to float32 (`normalize()` into a Float32Array).
	 *
	 * @param float[] $v Components (float32 values).
	 * @return float[]
	 */
	private static function unit( array $v ) {
		$sum = 0.0;
		foreach ( $v as $x ) {
			$sum += $x * $x;
		}
		if ( 0.0 === $sum ) {
			return array_fill( 0, count( $v ), 0.0 );
		}
		$inv = 1 / sqrt( $sum );
		$out = array();
		foreach ( $v as $x ) {
			$out[] = $x * $inv;
		}
		return array_values( (array) unpack( 'g*', pack( 'g*', ...$out ) ) );
	}

	/**
	 * Rounds up to a multiple of 4.
	 *
	 * @param int $n Bytes.
	 * @return int
	 */
	private static function align4( $n ) {
		return ( $n + 3 ) & ~3;
	}
}
