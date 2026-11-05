/**
 * `window.InklingConfig`: options an inline script sets before the components load. They are
 * applied (`Inkling.configure()`) when the components are registered, and `manifest` is the
 * manifest of components that have no `manifest` attribute.
 */

import { Inkling, type InklingOptions } from '../client/index.ts';

export interface InklingConfig extends Omit<InklingOptions, 'manifest'> {
  /** URL of the manifest for components without a `manifest` attribute. */
  manifest?: string;
}

function pageConfig(): InklingConfig | undefined {
  return (globalThis as { InklingConfig?: InklingConfig }).InklingConfig;
}

/** Applies `window.InklingConfig`, if the page has one. */
export function applyPageConfig(): void {
  const config = pageConfig();
  if (!config) return;
  const { manifest: _, ...options } = config;
  Inkling.configure(options);
}

/** The element's `manifest` attribute, or else `window.InklingConfig.manifest`. */
export function manifestOf(element: Element): string | null {
  return element.getAttribute('manifest') ?? pageConfig()?.manifest ?? null;
}
