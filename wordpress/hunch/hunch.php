<?php
/**
 * Plugin Name:       Hunch
 * Plugin URI:        https://github.com/swissspidy/hunch
 * Description:       Related posts and "for you" lists ranked in the visitor's browser. The visitor's interests stay on their device.
 * Version:           0.1.0
 * Requires at least: 6.5
 * Requires PHP:      7.4
 * Author:            Pascal Birchler
 * License:           Apache-2.0
 * License URI:       https://www.apache.org/licenses/LICENSE-2.0
 * Text Domain:       hunch
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || exit;

define( 'HUNCH_VERSION', '0.1.0' );
define( 'HUNCH_FILE', __FILE__ );
define( 'HUNCH_DIR', __DIR__ );

require_once __DIR__ . '/includes/class-hunch-format.php';
require_once __DIR__ . '/includes/class-hunch-shard.php';
require_once __DIR__ . '/includes/class-hunch-writer.php';
require_once __DIR__ . '/includes/class-hunch-settings.php';
require_once __DIR__ . '/includes/class-hunch-consent.php';
require_once __DIR__ . '/includes/class-hunch-catalog.php';
require_once __DIR__ . '/includes/class-hunch-rest.php';
require_once __DIR__ . '/includes/class-hunch-admin.php';
require_once __DIR__ . '/includes/class-hunch-front.php';

Hunch_Catalog::init();
Hunch_Consent::init();
Hunch_Rest::init();
Hunch_Admin::init();
Hunch_Front::init();

register_deactivation_hook( __FILE__, array( 'Hunch_Catalog', 'deactivate' ) );
