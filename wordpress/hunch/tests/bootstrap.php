<?php
/**
 * Loads the plugin's WordPress-free classes for PHPUnit and the cross-language test.
 *
 * @package Hunch
 */

define( 'HUNCH_STANDALONE', true );
require_once dirname( __DIR__ ) . '/includes/class-hunch-format.php';
require_once dirname( __DIR__ ) . '/includes/class-hunch-shard.php';
require_once dirname( __DIR__ ) . '/includes/class-hunch-writer.php';
require_once dirname( __DIR__ ) . '/includes/class-hunch-settings.php';
