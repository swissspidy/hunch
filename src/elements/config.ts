import { Hunch, type HunchOptions } from '../client/index.ts';

/**
 * `window.HunchConfig`: options an inline script sets before the components load. They are
 * applied (`Hunch.configure()`) when the components are registered, and `manifest` is the
 * manifest of components that have no `manifest` attribute.
 */
export interface HunchConfig extends Omit<HunchOptions, 'manifest'> {
  /** URL of the manifest for components without a `manifest` attribute. */
  manifest?: string;
}

function pageConfig(): HunchConfig | undefined {
  return (globalThis as { HunchConfig?: HunchConfig }).HunchConfig;
}

/** Applies `window.HunchConfig`, if the page has one. */
export function applyPageConfig(): void {
  const config = pageConfig();
  if (!config) return;
  const { manifest: _, ...options } = config;
  Hunch.configure(options);
}

/** The element's `manifest` attribute, or else `window.HunchConfig.manifest`. */
export function manifestOf(element: Element): string | null {
  return element.getAttribute('manifest') ?? pageConfig()?.manifest ?? null;
}
