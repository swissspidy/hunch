<?php
/**
 * The format helpers, against values the Node build produces.
 *
 * @package Hunch
 */

use PHPUnit\Framework\TestCase;

final class FormatTest extends TestCase {

	public function test_space_key_matches_the_cli() {
		$this->assertSame(
			'onnx-community/embeddinggemma-300m-ONNX@5090578d9565bb06545b4552f76e6bc2c93e4a66|dtype=q8|native=768|dims=256|prompt=03e0cd9b',
			Hunch_Format::space_key( Hunch_Format::embedding_gemma(), 256 )
		);
	}

	public function test_fnv1a_hashes_utf16_code_units() {
		$this->assertSame( '811c9dc5', Hunch_Format::fnv1a( '' ) );
		$this->assertSame( '89e65ea6', Hunch_Format::fnv1a( "é\u{1f950}x" ) );
	}

	public function test_document_input_fills_the_prompt_and_cuts_the_text() {
		$prompt = 'title: {title} | text: {text}';
		$this->assertSame( 'title: none | text: body', Hunch_Format::document_input( $prompt, '', 'body' ) );
		$this->assertSame( 'title: T | text: ab', Hunch_Format::document_input( $prompt, 'T', 'abc', 2 ) );
		// A character outside the BMP is two code units; cut in half, it is U+FFFD.
		$this->assertSame( "title: T | text: a\u{fffd}", Hunch_Format::document_input( $prompt, 'T', "a\u{1f950}b", 2 ) );
		$this->assertSame( "title: T | text: a\u{1f950}", Hunch_Format::document_input( $prompt, 'T', "a\u{1f950}b", 3 ) );
	}

	public function test_input_hash_is_the_cli_cache_key() {
		$model = Hunch_Format::embedding_gemma();
		$this->assertSame(
			hash( 'sha256', "onnx-community/embeddinggemma-300m-ONNX\x005090578d9565bb06545b4552f76e6bc2c93e4a66\x00q8\x00input" ),
			Hunch_Format::input_hash( $model, 'input' )
		);
	}

	public function test_html_to_text() {
		$this->assertSame(
			"Rye & spelt bread\u{2026}\nnext",
			Hunch_Format::html_to_text( '<!-- wp:paragraph --><p>Rye &amp; spelt&nbsp;bread&hellip;</p><!-- /wp:paragraph --><p>next</p><script>x</script>' )
		);
		// Unicode spaces are trimmed at the ends but, as in JavaScript, not collapsed inside lines.
		$this->assertSame( "A\u{3000}&bogus; &#0;", Hunch_Format::html_to_text( "&#65;\u{3000}&bogus; &#0;\u{a0}" ) );
	}

	public function test_json_writes_what_javascript_writes() {
		$this->assertSame(
			'{"a":"/x/ é \u0001 ' . "\u{2028}" . '","b":1,"c":0.5,"d":0.3333333333333333,"e":[]}',
			Hunch_Format::json(
				array(
					'a' => "/x/ é \x01 \u{2028}",
					'b' => 1,
					'c' => 0.5,
					'd' => 1 / 3,
					'e' => array(),
				)
			)
		);
		$this->assertSame( "{\n  \"a\": [\n    1\n  ]\n}", Hunch_Format::json( array( 'a' => array( 1 ) ), true ) );
	}

	public function test_slug() {
		$this->assertSame( 'section', Hunch_Format::slug( '!!!' ) );
		$this->assertSame( 'night-trains', Hunch_Format::slug( ' Night  Trains! ' ) );
	}

	public function test_slug_transliterates_accents_with_intl() {
		if ( ! class_exists( 'Normalizer' ) ) {
			$this->markTestSkipped( 'NFKD needs the intl extension.' );
		}
		$this->assertSame( 'cafe-culture', Hunch_Format::slug( 'Café Culture' ) );
	}

	public function test_invalid_utf8_becomes_u_fffd_without_mbstring() {
		foreach ( array( "ok \xff x", "a\xc3", "\xe2\x82 b", "\xed\xa0\x80", "caf\xc3\xa9 \xf0\x9f\xa5\x90" ) as $text ) {
			$this->assertSame( 1, preg_match( '//u', Hunch_Format::replace_invalid_utf8( $text ) ) );
		}
		$this->assertSame( "ok \u{fffd} x", Hunch_Format::replace_invalid_utf8( "ok \xff x" ) );
		$this->assertSame( "caf\u{e9} \u{1f950}", Hunch_Format::replace_invalid_utf8( "caf\xc3\xa9 \xf0\x9f\xa5\x90" ) );
		$this->assertSame( "\u{fffd}\u{fffd}\u{fffd}", Hunch_Format::replace_invalid_utf8( "\xed\xa0\x80" ) );
	}

	public function test_iso_time() {
		$this->assertSame( '2026-11-05T10:00:00.000Z', Hunch_Format::iso_time( 1793872800 ) );
	}
}
