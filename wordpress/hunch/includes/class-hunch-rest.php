<?php
/**
 * REST routes for the editor's browser (`hunch/v1`). Every route needs a logged-in user with
 * the right capability; the REST API's cookie authentication checks the `wp_rest` nonce.
 *
 * @package Hunch
 */

defined( 'ABSPATH' ) || exit;

/**
 * The REST controller.
 */
final class Hunch_Rest {

	const NAMESPACE_V1 = 'hunch/v1';

	/**
	 * Hooks.
	 */
	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
	}

	/**
	 * Registers the routes.
	 */
	public static function routes() {
		$id = array(
			'id' => array(
				'type'     => 'integer',
				'minimum'  => 1,
				'required' => true,
			),
		);
		register_rest_route(
			self::NAMESPACE_V1,
			'/posts/(?P<id>\d+)/input',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'get_input' ),
				'permission_callback' => array( __CLASS__, 'can_edit_post' ),
				'args'                => $id,
			)
		);
		register_rest_route(
			self::NAMESPACE_V1,
			'/posts/(?P<id>\d+)/vector',
			array(
				'methods'             => WP_REST_Server::EDITABLE,
				'callback'            => array( __CLASS__, 'put_vector' ),
				'permission_callback' => array( __CLASS__, 'can_edit_post' ),
				'args'                => $id + array(
					'hash'   => array(
						'type'     => 'string',
						'pattern'  => '^[0-9a-f]{64}$',
						'required' => true,
					),
					'vector' => array(
						'type'      => 'string',
						'required'  => true,
						'maxLength' => 65536,
					),
				),
			)
		);
		register_rest_route(
			self::NAMESPACE_V1,
			'/pending',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'get_pending' ),
				'permission_callback' => array( __CLASS__, 'can_manage' ),
				'args'                => array(
					'after' => array(
						'type'    => 'integer',
						'minimum' => 0,
						'default' => 0,
					),
					'limit' => array(
						'type'    => 'integer',
						'minimum' => 1,
						'maximum' => 50,
						'default' => 8,
					),
				),
			)
		);
		register_rest_route(
			self::NAMESPACE_V1,
			'/status',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'get_status' ),
				'permission_callback' => array( __CLASS__, 'can_manage' ),
			)
		);
		register_rest_route(
			self::NAMESPACE_V1,
			'/regenerate',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'post_regenerate' ),
				'permission_callback' => array( __CLASS__, 'can_manage' ),
			)
		);
	}

	/**
	 * The user may edit the post, and it is of an indexed type.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return bool
	 */
	public static function can_edit_post( WP_REST_Request $request ) {
		$post = get_post( (int) $request['id'] );
		return $post instanceof WP_Post
			&& current_user_can( 'edit_post', $post->ID )
			&& in_array( $post->post_type, (array) Hunch_Settings::get( 'post_types' ), true );
	}

	/**
	 * The user manages the site's settings.
	 *
	 * @return bool
	 */
	public static function can_manage() {
		return current_user_can( 'manage_options' );
	}

	/**
	 * The model input of a post, for the browser to embed.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response
	 */
	public static function get_input( WP_REST_Request $request ) {
		$post  = get_post( (int) $request['id'] );
		$input = Hunch_Catalog::input( $post );
		return rest_ensure_response(
			array(
				'id'      => $post->ID,
				'input'   => $input['input'],
				'hash'    => $input['hash'],
				'indexed' => Hunch_Catalog::is_indexed( $post ),
				'current' => Hunch_Catalog::is_current( $post, $input['hash'] ),
			)
		);
	}

	/**
	 * Stores a vector the browser made from the post's current input.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function put_vector( WP_REST_Request $request ) {
		$post  = get_post( (int) $request['id'] );
		$input = Hunch_Catalog::input( $post );
		if ( ! hash_equals( $input['hash'], (string) $request['hash'] ) ) {
			return new WP_Error( 'hunch_stale_input', 'The post changed while it was embedded.', array( 'status' => 409 ) );
		}
		$bytes = Hunch_Catalog::check_vector( $request['vector'] );
		if ( is_wp_error( $bytes ) ) {
			return $bytes;
		}
		Hunch_Catalog::store( $post, $input['hash'], $bytes );
		return rest_ensure_response(
			array(
				'id'     => $post->ID,
				'stored' => true,
			)
		);
	}

	/**
	 * Posts that need a vector.
	 *
	 * @param WP_REST_Request $request The request.
	 * @return WP_REST_Response
	 */
	public static function get_pending( WP_REST_Request $request ) {
		return rest_ensure_response( Hunch_Catalog::pending( (int) $request['after'], (int) $request['limit'] ) );
	}

	/**
	 * Counts and the last build.
	 *
	 * @return WP_REST_Response
	 */
	public static function get_status() {
		return rest_ensure_response( Hunch_Catalog::status() );
	}

	/**
	 * Writes the manifest and shards now.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public static function post_regenerate() {
		wp_clear_scheduled_hook( Hunch_Catalog::HOOK );
		$state = Hunch_Catalog::regenerate();
		return is_wp_error( $state ) ? $state : rest_ensure_response( $state );
	}
}
