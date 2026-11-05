<?php
/**
 * Plugin Name:       Inkling
 * Plugin URI:        https://github.com/swissspidy/inkling
 * Description:       Related posts and "for you" lists ranked in the visitor's browser. The visitor's interests stay on their device.
 * Version:           0.1.0
 * Requires at least: 6.5
 * Requires PHP:      7.4
 * Author:            Pascal Birchler
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       inkling
 *
 * @package Inkling
 */

defined( 'ABSPATH' ) || exit;

define( 'INKLING_VERSION', '0.1.0' );
define( 'INKLING_FILE', __FILE__ );
define( 'INKLING_DIR', __DIR__ );

require_once __DIR__ . '/includes/class-inkling-format.php';
require_once __DIR__ . '/includes/class-inkling-shard.php';
require_once __DIR__ . '/includes/class-inkling-writer.php';
require_once __DIR__ . '/includes/class-inkling-settings.php';
require_once __DIR__ . '/includes/class-inkling-catalog.php';
require_once __DIR__ . '/includes/class-inkling-rest.php';
require_once __DIR__ . '/includes/class-inkling-admin.php';
require_once __DIR__ . '/includes/class-inkling-front.php';

Inkling_Catalog::init();
Inkling_Rest::init();
Inkling_Admin::init();
Inkling_Front::init();

register_deactivation_hook( __FILE__, array( 'Inkling_Catalog', 'deactivate' ) );
