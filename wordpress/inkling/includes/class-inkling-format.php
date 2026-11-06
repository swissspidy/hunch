<?php
/**
 * Text and hashing helpers that must give exactly what the Node build step gives
 * (src/format/manifest.ts, src/node/text.ts, src/node/cache.ts). No WordPress needed.
 *
 * @package Inkling
 */

defined( 'ABSPATH' ) || defined( 'INKLING_STANDALONE' ) || exit;

/**
 * Format helpers shared by the shard writer and the plugin.
 */
final class Inkling_Format {

	/**
	 * What JavaScript's `\s` and `trim()` match, as a PCRE character class body.
	 */
	const JS_SPACE = '\t\n\x0b\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}';

	/**
	 * EmbeddingGemma, as `src/node/providers/transformers.ts` pins it, with q8 weights.
	 *
	 * @return array{id: string, revision: string, dtype: string, nativeDims: int, documentPrompt: string, queryPrompt: string}
	 */
	public static function embedding_gemma() {
		return array(
			'id'             => 'onnx-community/embeddinggemma-300m-ONNX',
			'revision'       => '5090578d9565bb06545b4552f76e6bc2c93e4a66',
			'dtype'          => 'q8',
			'nativeDims'     => 768,
			'documentPrompt' => 'title: {title} | text: {text}',
			'queryPrompt'    => 'task: search result | query: {query}',
		);
	}

	/**
	 * The `space` string of ADR 0001: vectors from different spaces are never compared.
	 *
	 * @param array $model The model info (`id`, `revision`, `dtype`, `nativeDims`, `documentPrompt`).
	 * @param int   $dims  Published dimensions.
	 * @return string
	 */
	public static function space_key( array $model, $dims ) {
		$dtype = empty( $model['dtype'] ) ? '' : '|dtype=' . $model['dtype'];
		$file  = empty( $model['file'] ) ? '' : '|file=' . $model['file'];
		return $model['id'] . '@' . $model['revision'] . $dtype . $file . '|native=' . $model['nativeDims']
			. '|dims=' . $dims . '|prompt=' . self::fnv1a( $model['documentPrompt'] );
	}

	/**
	 * 32-bit FNV-1a over UTF-16 code units, as 8 hex digits (JavaScript's `charCodeAt`).
	 *
	 * @param string $text UTF-8 text.
	 * @return string
	 */
	public static function fnv1a( $text ) {
		$h = 0x811c9dc5;
		foreach ( self::utf16_units( $text ) as $unit ) {
			$h ^= $unit;
			// Math.imul( h, 0x01000193 ): h < 2^32, so both terms fit in a 64-bit integer.
			$h = ( $h * 0x193 + ( $h << 24 ) ) & 0xffffffff;
		}
		return str_pad( dechex( $h ), 8, '0', STR_PAD_LEFT );
	}

	/**
	 * The model input for a post: the document prompt filled with its title and text, the text
	 * cut to `$max_chars` UTF-16 code units (`documentInput()` and `build()` in the Node build).
	 *
	 * @param string $prompt    The model's document prompt.
	 * @param string $title     Plain-text title.
	 * @param string $text      Plain-text body.
	 * @param int    $max_chars UTF-16 code units of text embedded (default 4000).
	 * @return string
	 */
	public static function document_input( $prompt, $title, $text, $max_chars = 4000 ) {
		$text = self::utf16_slice( $text, $max_chars );
		return str_replace( array( '{title}', '{text}' ), array( '' === $title ? 'none' : $title, $text ), $prompt );
	}

	/**
	 * The hash of a model input: the Node build's embedding cache key, so a vector made for the
	 * same input by the same model is recognized.
	 *
	 * @param array  $model The model info.
	 * @param string $input The model input.
	 * @return string 64 hex digits.
	 */
	public static function input_hash( array $model, $input ) {
		$dtype = isset( $model['dtype'] ) ? $model['dtype'] : '';
		$file  = empty( $model['file'] ) ? '' : '/' . $model['file'];
		return hash( 'sha256', $model['id'] . "\0" . $model['revision'] . "\0" . $dtype . $file . "\0" . $input );
	}

	/**
	 * HTML to plain text for embedding: comments, scripts and tags dropped, entities decoded,
	 * whitespace collapsed (`htmlToText()` in src/node/text.ts).
	 *
	 * @param string $html HTML.
	 * @return string
	 */
	public static function html_to_text( $html ) {
		$html = self::valid_utf8( $html );
		$html = (string) preg_replace( '/<!--[\s\S]*?-->/', ' ', $html );
		$html = (string) preg_replace( '/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/i', ' ', $html );
		$html = (string) preg_replace( '/<\/?(p|div|br|li|h[1-6]|section|article|blockquote|tr)\b[^>]*>/i', "\n", $html );
		$html = (string) preg_replace( '/<[^>]+>/', ' ', $html );
		$text = self::decode_entities( $html );
		// JavaScript's \v is a vertical tab, and its \s and trim() include Unicode spaces.
		$text = (string) preg_replace( '/[ \t\f\x0b\r]+/u', ' ', $text );
		$text = (string) preg_replace( '/[' . self::JS_SPACE . ']*\n[' . self::JS_SPACE . ']*/u', "\n", $text );
		return (string) preg_replace( '/^[' . self::JS_SPACE . ']+|[' . self::JS_SPACE . ']+$/u', '', $text );
	}

	/**
	 * Replaces invalid UTF-8 sequences with U+FFFD, as Node decodes them.
	 *
	 * @param string $text Text.
	 * @return string
	 */
	public static function valid_utf8( $text ) {
		$text = (string) $text;
		if ( preg_match( '//u', $text ) ) {
			return $text;
		}
		if ( ! function_exists( 'mb_convert_encoding' ) ) {
			return self::replace_invalid_utf8( $text );
		}
		$previous = mb_substitute_character();
		mb_substitute_character( 0xfffd );
		$text = (string) mb_convert_encoding( $text, 'UTF-8', 'UTF-8' );
		mb_substitute_character( $previous );
		return $text;
	}

	/**
	 * Decodes numeric entities and the few named ones the Node build knows.
	 *
	 * @param string $text Text with entities.
	 * @return string
	 */
	public static function decode_entities( $text ) {
		static $named = array(
			'amp'    => '&',
			'lt'     => '<',
			'gt'     => '>',
			'quot'   => '"',
			'apos'   => "'",
			'nbsp'   => ' ',
			'ndash'  => "\u{2013}",
			'mdash'  => "\u{2014}",
			'hellip' => "\u{2026}",
			'lsquo'  => "\u{2018}",
			'rsquo'  => "\u{2019}",
			'ldquo'  => "\u{201c}",
			'rdquo'  => "\u{201d}",
		);
		return (string) preg_replace_callback(
			'/&(#x[0-9a-f]+|#\d+|[a-z]+);/i',
			static function ( $m ) use ( $named ) {
				$code = $m[1];
				if ( '#' === $code[0] ) {
					$n = ( 'x' === $code[1] || 'X' === $code[1] ) ? hexdec( substr( $code, 2 ) ) : (float) substr( $code, 1 );
					if ( $n > 0 && $n <= 0x10ffff ) {
						return self::chr( (int) $n );
					}
					return $m[0];
				}
				$key = strtolower( $code );
				return isset( $named[ $key ] ) ? $named[ $key ] : $m[0];
			},
			$text
		);
	}

	/**
	 * Replaces each byte that is not part of a valid UTF-8 sequence with U+FFFD, in plain PHP
	 * (the fallback of `valid_utf8()` without mbstring).
	 *
	 * @param string $text Text.
	 * @return string
	 */
	public static function replace_invalid_utf8( $text ) {
		return (string) preg_replace_callback(
			'/[\x00-\x7f]|[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2}|(.)/s',
			static function ( $m ) {
				return isset( $m[1] ) ? "\u{fffd}" : $m[0];
			},
			(string) $text
		);
	}

	/**
	 * JSON as JavaScript's `JSON.stringify` writes it (no escaped slashes or non-ASCII).
	 *
	 * @param mixed $value The value.
	 * @param bool  $pretty Two-space indentation, as `JSON.stringify(value, null, 2)`.
	 * @return string
	 * @throws InvalidArgumentException When the value can't be encoded.
	 */
	public static function json( $value, $pretty = false ) {
		$flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS | JSON_INVALID_UTF8_SUBSTITUTE;
		if ( $pretty ) {
			$flags |= JSON_PRETTY_PRINT;
		}
		// Shortest round-trip floats, as JavaScript writes them (PHP's default since 7.1).
		$precision = ini_get( 'serialize_precision' );
		ini_set( 'serialize_precision', '-1' ); // phpcs:ignore WordPress.PHP.IniSet.Risky -- restored below.
		$json = json_encode( $value, $flags ); // phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode -- the exact bytes matter.
		ini_set( 'serialize_precision', (string) $precision ); // phpcs:ignore WordPress.PHP.IniSet.Risky
		if ( false === $json ) {
			throw new InvalidArgumentException( 'Inkling: the value cannot be encoded as JSON' );
		}
		if ( $pretty ) {
			// PHP indents by four spaces. Strings hold no raw newlines, so line starts are indentation.
			$json = (string) preg_replace_callback(
				'/^(?: {4})+/m',
				static function ( $m ) {
					return substr( $m[0], 0, (int) ( strlen( $m[0] ) / 2 ) );
				},
				$json
			);
		}
		return $json;
	}

	/**
	 * A file-name slug as the Node build makes it (`slug()` in src/node/build.ts).
	 *
	 * @param string $text Section name.
	 * @return string
	 */
	public static function slug( $text ) {
		$text = function_exists( 'mb_strtolower' ) ? mb_strtolower( $text, 'UTF-8' ) : strtolower( $text );
		if ( class_exists( 'Normalizer' ) ) {
			$normalized = Normalizer::normalize( $text, Normalizer::FORM_KD );
			if ( false !== $normalized ) {
				$text = $normalized;
			}
		}
		$text = (string) preg_replace( '/[^a-z0-9]+/', '-', $text );
		$text = (string) preg_replace( '/^-|-$/', '', $text );
		return '' === $text ? 'section' : $text;
	}

	/**
	 * An ISO 8601 UTC time with milliseconds, as `Date.prototype.toISOString()` writes it.
	 *
	 * @param int $timestamp Unix time.
	 * @return string
	 */
	public static function iso_time( $timestamp ) {
		return gmdate( 'Y-m-d\TH:i:s', (int) $timestamp ) . '.000Z';
	}

	/**
	 * The first `$length` UTF-16 code units of a UTF-8 string, as JavaScript's `slice()`. A
	 * surrogate pair cut in half becomes U+FFFD, as Node encodes the lone surrogate.
	 *
	 * @param string $text   UTF-8 text.
	 * @param int    $length Code units.
	 * @return string
	 */
	public static function utf16_slice( $text, $length ) {
		if ( strlen( $text ) <= $length ) {
			return $text;
			// Every code unit takes at least one byte.
		}
		$out   = '';
		$units = 0;
		preg_match_all( '/./us', self::valid_utf8( $text ), $chars );
		foreach ( $chars[0] as $char ) {
			$width = strlen( $char ) === 4 ? 2 : 1;
			if ( $units + $width > $length ) {
				if ( $units < $length ) {
					$out .= "\u{fffd}";
				}
				break;
			}
			$out   .= $char;
			$units += $width;
		}
		return $out;
	}

	/**
	 * UTF-16 code units of a UTF-8 string.
	 *
	 * @param string $text UTF-8 text.
	 * @return int[]
	 */
	private static function utf16_units( $text ) {
		$units = array();
		preg_match_all( '/./us', self::valid_utf8( $text ), $chars );
		foreach ( $chars[0] as $char ) {
			$cp = self::ord( $char );
			if ( $cp >= 0x10000 ) {
				$cp     -= 0x10000;
				$units[] = 0xd800 | ( $cp >> 10 );
				$units[] = 0xdc00 | ( $cp & 0x3ff );
			} else {
				$units[] = $cp;
			}
		}
		return $units;
	}

	/**
	 * The code point of one UTF-8 character (no mbstring needed).
	 *
	 * @param string $char One valid UTF-8 character.
	 * @return int
	 */
	private static function ord( $char ) {
		$bytes = array_values( (array) unpack( 'C*', $char ) );
		switch ( count( $bytes ) ) {
			case 1:
				return $bytes[0];
			case 2:
				return ( ( $bytes[0] & 0x1f ) << 6 ) | ( $bytes[1] & 0x3f );
			case 3:
				return ( ( $bytes[0] & 0x0f ) << 12 ) | ( ( $bytes[1] & 0x3f ) << 6 ) | ( $bytes[2] & 0x3f );
			default:
				return ( ( $bytes[0] & 0x07 ) << 18 ) | ( ( $bytes[1] & 0x3f ) << 12 ) | ( ( $bytes[2] & 0x3f ) << 6 ) | ( $bytes[3] & 0x3f );
		}
	}

	/**
	 * UTF-8 for a code point (`String.fromCodePoint`); surrogates become U+FFFD.
	 *
	 * @param int $cp Code point.
	 * @return string
	 */
	private static function chr( $cp ) {
		if ( $cp >= 0xd800 && $cp <= 0xdfff ) {
			return "\u{fffd}";
		}
		if ( $cp < 0x80 ) {
			return chr( $cp );
		}
		if ( $cp < 0x800 ) {
			return chr( 0xc0 | ( $cp >> 6 ) ) . chr( 0x80 | ( $cp & 0x3f ) );
		}
		if ( $cp < 0x10000 ) {
			return chr( 0xe0 | ( $cp >> 12 ) ) . chr( 0x80 | ( ( $cp >> 6 ) & 0x3f ) ) . chr( 0x80 | ( $cp & 0x3f ) );
		}
		return chr( 0xf0 | ( $cp >> 18 ) ) . chr( 0x80 | ( ( $cp >> 12 ) & 0x3f ) ) . chr( 0x80 | ( ( $cp >> 6 ) & 0x3f ) ) . chr( 0x80 | ( $cp & 0x3f ) );
	}
}
