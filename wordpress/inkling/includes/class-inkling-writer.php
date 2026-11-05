<?php
/**
 * Writes `manifest.json` and the shards from items and their rows, as `build()` in
 * src/node/build.ts does after embedding: the same grouping, priors, file names, version and
 * clean-up, so the same input gives the same bytes. No WordPress needed.
 *
 * @package Inkling
 */

defined( 'ABSPATH' ) || defined( 'INKLING_STANDALONE' ) || exit;

/**
 * The manifest and shard writer.
 */
final class Inkling_Writer {

	/**
	 * Writes the catalog into `$args['dir']` and returns the manifest.
	 *
	 * @param array $args {
	 *     The catalog and how to write it.
	 *     @type array[]  $items           Items in catalog order: `id`, `url`, `title`, optional
	 *                                     `section`, `tags`, `date`, `image`, `popularity`.
	 *     @type string[] $rows            One row per item, from `Inkling_Shard::row()`.
	 *     @type string   $dir             Directory for `manifest.json` and `shards/`.
	 *     @type array    $model           The model info, published as is.
	 *     @type int      $dims            Published dimensions.
	 *     @type string   $quantization    `int8` (default) or `float32`.
	 *     @type string   $shard_by        `section` (default) or `none`.
	 *     @type int      $max_shard_items Split shards larger than this (default 2000).
	 *     @type string   $now             ISO 8601 build time, kept when nothing changed.
	 * }
	 * @return array{manifest: array, removed: string[]}
	 * @throws LengthException          When the catalog is empty.
	 * @throws InvalidArgumentException When `max_shard_items` is not positive.
	 * @throws RuntimeException         When a file cannot be written.
	 */
	public static function write( array $args ) {
		$items        = array_values( $args['items'] );
		$rows         = array_values( $args['rows'] );
		$dir          = rtrim( $args['dir'], '/\\' );
		$model        = $args['model'];
		$dims         = (int) $args['dims'];
		$quantization = isset( $args['quantization'] ) ? $args['quantization'] : 'int8';
		$by_section   = ! isset( $args['shard_by'] ) || 'none' !== $args['shard_by'];
		$max_items    = isset( $args['max_shard_items'] ) ? (int) $args['max_shard_items'] : 2000;
		$now          = isset( $args['now'] ) ? $args['now'] : Inkling_Format::iso_time( time() );
		if ( count( $items ) === 0 ) {
			throw new LengthException( 'Inkling: the catalog is empty' );
		}
		if ( $max_items < 1 ) {
			throw new InvalidArgumentException( 'Inkling: max_shard_items must be positive' );
		}
		$space  = Inkling_Format::space_key( $model, $dims );
		$priors = self::priors( $items );

		// Group by section in catalog order; items without a section go to `all`.
		$groups = array();
		foreach ( $items as $i => $item ) {
			$section = ( $by_section && isset( $item['section'] ) && '' !== $item['section'] ) ? (string) $item['section'] : null;
			$key     = null === $section ? "\0" : 's:' . $section;
			if ( ! isset( $groups[ $key ] ) ) {
				$groups[ $key ] = array(
					'section' => $section,
					'members' => array(),
				);
			}
			$groups[ $key ]['members'][] = $i;
		}

		$shard_dir = $dir . '/shards';
		if ( ! is_dir( $shard_dir ) && ! mkdir( $shard_dir, 0755, true ) && // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_mkdir -- also runs without WordPress.
			! is_dir( $shard_dir ) ) {
			throw new RuntimeException( 'Inkling: cannot create ' . $shard_dir );
		}
		$shards = array();
		$names  = array();
		foreach ( $groups as $group ) {
			$members = $group['members'];
			$section = $group['section'];
			$total   = count( $members );
			for ( $start = 0, $part = 1; $start < $total; $start += $max_items, $part++ ) {
				$chunk       = array_slice( $members, $start, $max_items );
				$shard_items = array();
				$shard_rows  = array();
				foreach ( $chunk as $i ) {
					$shard_items[] = self::published( $items[ $i ], $priors[ $i ] );
					$shard_rows[]  = $rows[ $i ];
				}
				$bytes  = Inkling_Shard::encode( $space, $shard_items, $shard_rows, $dims, $quantization );
				$sha256 = hash( 'sha256', $bytes );
				$base   = null === $section ? 'all' : Inkling_Format::slug( $section );
				if ( $total > $max_items ) {
					$base .= '-' . $part;
				}
				while ( isset( $names[ $base ] ) ) {
					$base .= '_';
				}
				$names[ $base ] = true;
				$file           = $base . '.' . substr( $sha256, 0, 12 ) . '.ink';
				self::put( $shard_dir . '/' . $file, $bytes );
				$shards[] = array(
					'url'     => 'shards/' . $file,
					'section' => $section,
					'count'   => count( $chunk ),
					'bytes'   => strlen( $bytes ),
					'sha256'  => $sha256,
				);
			}//end for
		}//end foreach

		$manifest_path = $dir . '/manifest.json';
		$previous      = self::read_manifest( $manifest_path );
		$version       = substr(
			hash(
				'sha256',
				Inkling_Format::json(
					array(
						'space'        => $space,
						'quantization' => $quantization,
						'shards'       => array_column( $shards, 'sha256' ),
					)
				)
			),
			0,
			16
		);
		$sections      = array();
		if ( $by_section ) {
			foreach ( $groups as $group ) {
				if ( null !== $group['section'] ) {
					$sections[] = $group['section'];
				}
			}
		} else {
			foreach ( $items as $item ) {
				if ( isset( $item['section'] ) && '' !== $item['section'] && ! in_array( (string) $item['section'], $sections, true ) ) {
					$sections[] = (string) $item['section'];
				}
			}
		}
		$manifest = array(
			'format'        => 'inkling/manifest',
			'formatVersion' => 1,
			'version'       => $version,
			'generatedAt'   => ( $previous && isset( $previous['version'], $previous['generatedAt'] ) && $previous['version'] === $version ) ? $previous['generatedAt'] : $now,
			'space'         => $space,
			'model'         => $model,
			'dims'          => $dims,
			'quantization'  => $quantization,
			'count'         => count( $items ),
			'sections'      => $sections,
			'shards'        => $shards,
		);
		self::put( $manifest_path, Inkling_Format::json( $manifest, true ) . "\n" );

		// Remove shards neither manifest names: clients holding the previous one can still load it.
		$keep = array();
		foreach ( array_merge( $shards, ( $previous && isset( $previous['shards'] ) && is_array( $previous['shards'] ) ) ? $previous['shards'] : array() ) as $shard ) {
			if ( is_array( $shard ) && isset( $shard['url'] ) && is_string( $shard['url'] ) ) {
				$keep[ (string) preg_replace( '/^shards\//', '', $shard['url'] ) ] = true;
			}
		}
		$removed = array();
		foreach ( (array) scandir( $shard_dir ) as $file ) {
			if ( is_string( $file ) && '.ink' === substr( $file, -4 ) && ! isset( $keep[ $file ] ) ) {
				self::delete( $shard_dir . '/' . $file );
				$removed[] = $file;
			}
		}
		return array(
			'manifest' => $manifest,
			'removed'  => $removed,
		);
	}

	/**
	 * Cold-start priors in (0, 1] (`computePriors()`): by `popularity` (highest first) where
	 * items have one, then in catalog order. The first item gets 1, the last 1/n.
	 *
	 * @param array[] $items Items in catalog order.
	 * @return float[]
	 */
	public static function priors( array $items ) {
		$items = array_values( $items );
		$order = array_keys( $items );
		usort(
			$order,
			static function ( $a, $b ) use ( $items ) {
				$pa = isset( $items[ $a ]['popularity'] ) ? $items[ $a ]['popularity'] : null;
				$pb = isset( $items[ $b ]['popularity'] ) ? $items[ $b ]['popularity'] : null;
				if ( null !== $pa && null !== $pb && $pa != $pb ) { // phpcs:ignore Universal.Operators.StrictComparisons.LooseNotEqual -- numbers of either type.
					return $pb > $pa ? 1 : -1;
				}
				if ( null !== $pa && null === $pb ) {
					return -1;
				}
				if ( null === $pa && null !== $pb ) {
					return 1;
				}
				return $a - $b;
			}
		);
		$n      = count( $items );
		$priors = array();
		foreach ( $order as $rank => $index ) {
			$priors[ $index ] = ( $n - $rank ) / $n;
		}
		return $priors;
	}

	/**
	 * An item as published in a shard, keys in the Node build's order, empty fields left out.
	 *
	 * @param array     $item  The item.
	 * @param float|int $prior Its prior.
	 * @return array
	 */
	private static function published( array $item, $prior ) {
		$out = array(
			'id'    => (string) $item['id'],
			'url'   => (string) $item['url'],
			'title' => (string) $item['title'],
		);
		if ( isset( $item['section'] ) && '' !== $item['section'] ) {
			$out['section'] = (string) $item['section'];
		}
		if ( ! empty( $item['tags'] ) ) {
			$out['tags'] = array_values( array_map( 'strval', $item['tags'] ) );
		}
		foreach ( array( 'date', 'image' ) as $key ) {
			if ( isset( $item[ $key ] ) && '' !== $item[ $key ] ) {
				$out[ $key ] = (string) $item[ $key ];
			}
		}
		// JSON.stringify writes 1, not 1.0.
		$out['prior'] = ( floor( $prior ) === (float) $prior ) ? (int) $prior : $prior;
		return $out;
	}

	/**
	 * Reads the previous manifest, if any.
	 *
	 * @param string $path Path.
	 * @return array|null
	 */
	private static function read_manifest( $path ) {
		if ( ! is_file( $path ) ) {
			return null;
		}
		$data = json_decode( (string) file_get_contents( $path ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local file.
		return is_array( $data ) ? $data : null;
	}

	/**
	 * Writes a file atomically.
	 *
	 * @param string $path  Path.
	 * @param string $bytes Contents.
	 * @throws RuntimeException When the file cannot be written.
	 */
	private static function put( $path, $bytes ) {
		// Written next to it, then renamed over it: a reader never sees a half-written file.
		if ( file_put_contents( $path . '.tmp', $bytes ) !== strlen( $bytes ) // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- WP_Filesystem may need credentials; uploads is writable.
			|| ! rename( $path . '.tmp', $path ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename -- an atomic replace.
			throw new RuntimeException( 'Inkling: cannot write ' . $path );
		}
	}

	/**
	 * Deletes a file: `wp_delete_file()` where WordPress is loaded, `unlink()` in the tests.
	 *
	 * @param string $path Path.
	 */
	private static function delete( $path ) {
		if ( function_exists( 'wp_delete_file' ) ) {
			wp_delete_file( $path );
		} else {
			unlink( $path ); // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- without WordPress.
		}
	}
}
