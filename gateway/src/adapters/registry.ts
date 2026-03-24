/**
 * Adapter registry — a central map from ProviderName → ProviderAdapter instance.
 *
 * Usage:
 *   import { adapterRegistry } from './registry.js';
 *   adapterRegistry.register(new ClaudeAdapter());
 *   const adapter = adapterRegistry.get('claude');
 */

import type { ProviderAdapter } from './types.js';
import type { ProviderName } from '../domain/types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<ProviderName, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: ProviderName): ProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  getOrThrow(provider: ProviderName): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No adapter registered for provider: ${provider}`);
    }
    return adapter;
  }

  list(): ProviderName[] {
    return Array.from(this.adapters.keys());
  }

  has(provider: ProviderName): boolean {
    return this.adapters.has(provider);
  }
}

export const adapterRegistry = new AdapterRegistry();
