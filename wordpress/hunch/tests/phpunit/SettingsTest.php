<?php
/**
 * The settings: which changes rewrite the published files.
 *
 * @package Hunch
 */

use PHPUnit\Framework\TestCase;

final class SettingsTest extends TestCase {

	public function test_only_catalog_settings_rewrite_the_files() {
		$saved = Hunch_Settings::defaults();
		// Nothing stored yet, or the defaults stored: the same catalog.
		$this->assertFalse( Hunch_Settings::catalog_changed( array(), $saved ) );
		$this->assertFalse( Hunch_Settings::catalog_changed( false, array() ) );
		// What only the pages and wp-admin read.
		$front = array(
			'consent'          => 'cookie',
			'consent_cookie'   => 'ok=1',
			'consent_function' => 'cmp.allows',
			'related_auto'     => false,
			'related_count'    => 6,
			'related_same'     => true,
			'transformers_url' => 'https://example.com/transformers.js',
		);
		$this->assertFalse( Hunch_Settings::catalog_changed( $saved, array_merge( $saved, $front ) ) );
		$this->assertSame( array(), array_intersect( Hunch_Settings::CATALOG, array_keys( $front ) ) );
		$this->assertSame( array(), array_diff( array_keys( $saved ), Hunch_Settings::CATALOG, array_keys( $front ) ) );

		$changes = array(
			'post_types'   => array( 'post', 'page' ),
			'sections'     => 'none',
			'priors'       => 'comments',
			'dims'         => 128,
			'quantization' => 'float32',
			'weights'      => 'q4',
		);
		foreach ( $changes as $key => $value ) {
			$this->assertTrue( Hunch_Settings::catalog_changed( $saved, array_merge( $saved, array( $key => $value ) ) ), $key );
			$this->assertTrue( Hunch_Settings::catalog_changed( array(), array( $key => $value ) ), $key );
		}
		$this->assertFalse( Hunch_Settings::catalog_changed( $saved, array_merge( $saved, array( 'dims' => '256' ) ) ) );
	}
}
