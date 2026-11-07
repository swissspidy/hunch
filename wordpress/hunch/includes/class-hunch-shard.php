<?php
/**
 * The HNCH vector shard, version 2 (ADR 0011), written byte for byte as `encodeShard()` in
 * src/format/shard.ts writes it. No WordPress needed.
 *
 * Layout, little-endian: magic "HNCH", u8 format version (2), u8 quantization (1 = int8,
 * 2 = float32), u16 reserved, u32 dims, u32 count n, u32 header length H, u32 metadata length
 * M, H bytes of UTF-8 JSON `{ "space", "sections", "ids" }`, zero padding to a multiple of 8;
 * the columns: n float64 priors, n float64 times (ms, NaN without a date), n u32 metadata
 * lengths, n u16 section indexes (0xffff: none); zero padding to a multiple of 4, the rows, and
 * M bytes of metadata: each item's other fields as JSON.
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || defined( 'HUNCH_STANDALONE' ) || exit;

/**
 * Shard encoding.
 */
final class Hunch_Shard {

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
			throw new LengthException( sprintf( 'Hunch: cannot truncate %d dims to %d', count( $vector ), $dims ) );
		}
		// The Node build keeps the model's output as float32 before truncating it.
		$unit = self::unit( array_values( (array) unpack( 'g*', pack( 'g*', ...array_slice( $vector, 0, $dims ) ) ) ) );
		if ( 'float32' === $quantization ) {
			return pack( 'g*', ...$unit );
		}
		if ( 'int8' !== $quantization ) {
			throw new InvalidArgumentException( 'Hunch: unknown quantization ' . $quantization );
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
			throw new LengthException( sprintf( 'Hunch: %d items but %d vectors', count( $items ), count( $rows ) ) );
		}
		$width = 'int8' === $quantization ? 1 : 4;
		foreach ( $rows as $i => $row ) {
			if ( strlen( $row ) !== $dims * $width ) {
				throw new LengthException( sprintf( 'Hunch: row %d has %d bytes, not %d', $i, strlen( $row ), $dims * $width ) );
			}
		}
		$n             = count( $items );
		$sections      = array();
		$section_index = array();
		$ids           = array();
		$priors        = '';
		$times         = '';
		$lengths       = '';
		$codes         = '';
		$metadata      = '';
		foreach ( $items as $i => $item ) {
			$ids[] = (string) $item['id'];
			$code  = self::NO_SECTION;
			if ( isset( $item['section'] ) ) {
				// Keyed with a prefix, so a numeric section name stays a string key.
				$key = 's:' . $item['section'];
				if ( ! isset( $section_index[ $key ] ) ) {
					// 0xffff means no section: at most 65,535 sections.
					if ( count( $sections ) >= self::NO_SECTION ) {
						throw new LengthException( 'Hunch: too many sections in one shard' );
					}
					$section_index[ $key ] = count( $sections );
					$sections[]            = (string) $item['section'];
				}
				$code = $section_index[ $key ];
			}
			$priors .= pack( 'e', (float) $item['prior'] );
			$times  .= self::time( isset( $item['date'] ) ? (string) $item['date'] : '' );
			$codes  .= pack( 'v', $code );
			unset( $item['id'], $item['section'], $item['prior'] );
			$meta      = Hunch_Format::json( $item );
			$lengths  .= pack( 'V', strlen( $meta ) );
			$metadata .= $meta;
		}//end foreach
		$json     = Hunch_Format::json(
			array(
				'space'    => $space,
				'sections' => $sections,
				'ids'      => $ids,
			)
		);
		$head     = 'HNCH'
			. pack( 'CCvVVVV', self::FORMAT_VERSION, 'int8' === $quantization ? 1 : 2, 0, $dims, $n, strlen( $json ), strlen( $metadata ) )
			. $json;
		$head    .= str_repeat( "\0", self::align( strlen( $head ), 8 ) - strlen( $head ) );
		$columns  = $priors . $times . $lengths . $codes;
		$columns .= str_repeat( "\0", self::align( strlen( $columns ), 4 ) - strlen( $columns ) );
		return $head . $columns . implode( '', $rows ) . $metadata;
	}

	/**
	 * A date's time in ms since the epoch as float64 bytes, as `Date.parse()` reads ISO 8601:
	 * `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (or a six-digit signed year), optionally followed by
	 * `THH:MM[:SS[.sss]]` and `Z` or an offset. A day past the month's end rolls over into the
	 * next month and `24:00` is the next midnight, as in JavaScript. Anything else is NaN, as is
	 * no date, and so is a time without an offset (JavaScript reads it in the local time zone).
	 *
	 * @param string $date The item's date.
	 * @return string 8 bytes.
	 */
	public static function time( $date ) {
		// The NaN JavaScript writes.
		$nan = "\0\0\0\0\0\0\xf8\x7f";
		if ( ! preg_match( '/^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2}))?$/', $date, $m ) || '-000000' === $m[1] ) {
			return $nan;
		}
		$m      = array_pad( $m, 9, '' );
		$year   = (int) $m[1];
		$month  = '' === $m[2] ? 1 : (int) $m[2];
		$day    = '' === $m[3] ? 1 : (int) $m[3];
		$hour   = (int) $m[4];
		$minute = (int) $m[5];
		$second = (int) $m[6];
		$ms     = '' === $m[7] ? 0 : (int) str_pad( substr( $m[7], 0, 3 ), 3, '0' );
		$offset = 0;
		if ( '' !== $m[8] && 'Z' !== $m[8] ) {
			$offset_hours   = (int) substr( $m[8], 1, 2 );
			$offset_minutes = (int) substr( $m[8], 4, 2 );
			if ( $offset_hours > 23 || $offset_minutes > 59 ) {
				return $nan;
			}
			$offset = ( '-' === $m[8][0] ? -1 : 1 ) * ( $offset_hours * 60 + $offset_minutes ) * 60000;
		}
		$midnight = 24 === $hour && 0 === $minute + $second + $ms;
		if ( $month < 1 || $month > 12 || $day < 1 || $day > 31 || ( $hour > 23 && ! $midnight ) || $minute > 59 || $second > 59 ) {
			return $nan;
		}
		$ms += ( ( $hour * 60 + $minute ) * 60 + $second ) * 1000;
		return pack( 'e', (float) ( self::days( $year, $month, $day ) * 86400000 + $ms - $offset ) );
	}

	/**
	 * Days from 1970-01-01 to a date in the proleptic Gregorian calendar (Howard Hinnant's
	 * `days_from_civil`), with no two-digit-year rules: a day past the month's end counts on.
	 *
	 * @param int $year  Year.
	 * @param int $month Month, 1 to 12.
	 * @param int $day   Day, 1 to 31.
	 * @return int
	 */
	private static function days( $year, $month, $day ) {
		$year -= $month <= 2 ? 1 : 0;
		$era   = intdiv( $year >= 0 ? $year : $year - 399, 400 );
		$yoe   = $year - $era * 400;
		$doy   = intdiv( 153 * ( $month > 2 ? $month - 3 : $month + 9 ) + 2, 5 ) + $day - 1;
		$doe   = $yoe * 365 + intdiv( $yoe, 4 ) - intdiv( $yoe, 100 ) + $doy;
		return $era * 146097 + $doe - 719468;
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
