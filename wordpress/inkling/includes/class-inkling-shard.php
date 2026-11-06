<?php
/**
 * The INKV vector shard, version 2 (ADR 0011), written byte for byte as `encodeShard()` in
 * src/format/shard.ts writes it. No WordPress needed.
 *
 * Layout, little-endian: magic "INKV", u8 format version (2), u8 quantization (1 = int8,
 * 2 = float32), u16 reserved, u32 dims, u32 count n, u32 header length H, u32 metadata length
 * M, H bytes of UTF-8 JSON `{ "space", "sections", "ids" }`, zero padding to a multiple of 8;
 * the columns: n float64 priors, n float64 times (ms, NaN without a date), n u32 metadata
 * lengths, n u16 section indexes (0xffff: none); zero padding to a multiple of 4, the rows, and
 * M bytes of metadata: each item's other fields as JSON.
 *
 * @package Inkling
 */

defined( 'ABSPATH' ) || defined( 'INKLING_STANDALONE' ) || exit;

/**
 * Shard encoding.
 */
final class Inkling_Shard {

	const FORMAT_VERSION = 2;
	const FIXED_HEADER   = 24;
	const NO_SECTION     = 0xffff;

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
		$items = array_values( $items );
		$rows  = array_values( $rows );
		if ( count( $items ) !== count( $rows ) ) {
			throw new LengthException( sprintf( 'Inkling: %d items but %d vectors', count( $items ), count( $rows ) ) );
		}
		$width = 'int8' === $quantization ? 1 : 4;
		foreach ( $rows as $i => $row ) {
			if ( strlen( $row ) !== $dims * $width ) {
				throw new LengthException( sprintf( 'Inkling: row %d has %d bytes, not %d', $i, strlen( $row ), $dims * $width ) );
			}
		}
		$n        = count( $items );
		$sections = array();
		$ids      = array();
		$priors   = '';
		$times    = '';
		$lengths  = '';
		$codes    = '';
		$metadata = '';
		foreach ( $items as $i => $item ) {
			$ids[] = (string) $item['id'];
			$code  = self::NO_SECTION;
			if ( isset( $item['section'] ) ) {
				$code = array_search( (string) $item['section'], $sections, true );
				if ( false === $code ) {
					$code       = count( $sections );
					$sections[] = (string) $item['section'];
				}
			}
			$priors .= pack( 'e', (float) $item['prior'] );
			$times  .= self::time( isset( $item['date'] ) ? (string) $item['date'] : '' );
			$codes  .= pack( 'v', $code );
			unset( $item['id'], $item['section'], $item['prior'] );
			$meta      = Inkling_Format::json( $item );
			$lengths  .= pack( 'V', strlen( $meta ) );
			$metadata .= $meta;
		}
		$json     = Inkling_Format::json(
			array(
				'space'    => $space,
				'sections' => $sections,
				'ids'      => $ids,
			)
		);
		$head     = 'INKV'
			. pack( 'CCvVVVV', self::FORMAT_VERSION, 'int8' === $quantization ? 1 : 2, 0, $dims, $n, strlen( $json ), strlen( $metadata ) )
			. $json;
		$head    .= str_repeat( "\0", self::align( strlen( $head ), 8 ) - strlen( $head ) );
		$columns  = $priors . $times . $lengths . $codes;
		$columns .= str_repeat( "\0", self::align( strlen( $columns ), 4 ) - strlen( $columns ) );
		return $head . $columns . implode( '', $rows ) . $metadata;
	}

	/**
	 * A date's time in ms since the epoch as float64 bytes, as `Date.parse()` reads ISO 8601
	 * (`YYYY-MM-DD`, or with `THH:MM[:SS[.sss]]` and `Z` or an offset). Anything else is NaN,
	 * as is no date.
	 *
	 * @param string $date The item's date.
	 * @return string 8 bytes.
	 */
	public static function time( $date ) {
		// The NaN JavaScript writes.
		$nan = "\0\0\0\0\0\0\xf8\x7f";
		if ( preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', $date, $m ) ) {
			return pack( 'e', (float) gmmktime( 0, 0, 0, (int) $m[2], (int) $m[3], (int) $m[1] ) * 1000 );
		}
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/', $date, $m ) ) {
			return $nan;
		}
		if ( (int) $m[2] < 1 || (int) $m[2] > 12 || (int) $m[3] < 1 || (int) $m[3] > 31 || (int) $m[4] > 23 || (int) $m[5] > 59 || (int) $m[6] > 59 ) {
			return $nan;
		}
		$seconds = gmmktime( (int) $m[4], (int) $m[5], (int) $m[6], (int) $m[2], (int) $m[3], (int) $m[1] );
		$ms      = '' === $m[7] ? 0 : (int) str_pad( substr( $m[7], 0, 3 ), 3, '0' );
		$offset  = 'Z' === $m[8] ? 0 : ( '-' === $m[8][0] ? -1 : 1 ) * ( (int) substr( $m[8], 1, 2 ) * 3600 + (int) substr( $m[8], 4, 2 ) * 60 );
		return pack( 'e', (float) ( ( $seconds - $offset ) * 1000 + $ms ) );
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
	 * Rounds up to a multiple of `$to`.
	 *
	 * @param int $n  Bytes.
	 * @param int $to A power of two.
	 * @return int
	 */
	private static function align( $n, $to ) {
		return ( $n + $to - 1 ) & ~( $to - 1 );
	}
}
