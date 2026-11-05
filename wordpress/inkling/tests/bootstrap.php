<?php
/**
 * Loads the plugin's WordPress-free classes for PHPUnit and the cross-language test.
 *
 * @package Inkling
 */

define( 'INKLING_STANDALONE', true );
require_once dirname( __DIR__ ) . '/includes/class-inkling-format.php';
require_once dirname( __DIR__ ) . '/includes/class-inkling-shard.php';
require_once dirname( __DIR__ ) . '/includes/class-inkling-writer.php';
