/**
 * The blocks in the editor: server-side rendered previews and a few settings. No build step:
 * plain `wp.*` globals.
 */
(function () {
  'use strict';
  const { registerBlockType } = wp.blocks;
  const { createElement: el, Fragment } = wp.element;
  const { InspectorControls, useBlockProps } = wp.blockEditor;
  const { PanelBody, RangeControl, TextControl } = wp.components;
  const ServerSideRender = wp.serverSideRender;

  function edit(name, withCount) {
    return function Edit({ attributes, setAttributes, context }) {
      const controls = el(
        InspectorControls,
        null,
        el(
          PanelBody,
          { title: 'Settings' },
          el(TextControl, {
            label: 'Heading',
            value: attributes.heading || '',
            onChange: (heading) => setAttributes({ heading }),
          }),
          withCount &&
            el(RangeControl, {
              label: 'Number of posts',
              value: attributes.count || undefined,
              onChange: (count) => setAttributes({ count: count || 0 }),
              min: 1,
              max: 12,
              allowReset: true,
            }),
        ),
      );
      return el(
        Fragment,
        null,
        name === 'hunch/privacy-controls' ? null : controls,
        el(
          'div',
          useBlockProps(),
          el(ServerSideRender, {
            block: name,
            attributes,
            // The block renderer sets up this post, so related posts preview for it.
            urlQueryArgs: context && context.postId ? { post_id: context.postId } : {},
            EmptyResponsePlaceholder: () =>
              el(
                'p',
                null,
                name === 'hunch/related'
                  ? 'Related posts appear here on published posts.'
                  : 'Shown once the index is built (Settings → Hunch).',
              ),
          }),
        ),
      );
    };
  }

  const blocks = [
    [
      'hunch/related',
      'Related posts (Hunch)',
      'Posts similar to this one, ranked in the reader’s browser.',
      true,
    ],
    [
      'hunch/for-you',
      'For you (Hunch)',
      'Recent posts, re-ranked for the reader with their consent, in their browser.',
      true,
    ],
    [
      'hunch/privacy-controls',
      'Personalization controls (Hunch)',
      'Lets readers turn personalization on, pause it, export or forget it.',
      false,
    ],
  ];
  for (const [name, title, description, withCount] of blocks) {
    registerBlockType(name, {
      apiVersion: 3,
      title,
      description,
      category: 'widgets',
      icon: 'list-view',
      usesContext: ['postId'],
      attributes:
        name === 'hunch/privacy-controls'
          ? {}
          : {
              count: { type: 'number', default: name === 'hunch/for-you' ? 4 : 0 },
              heading: { type: 'string', default: '' },
            },
      edit: edit(name, withCount),
      save: () => null,
    });
  }
})();
