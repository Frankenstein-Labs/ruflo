import { AutocannonAdapter, type AutocannonAdapterOptions } from './autocannonAdapter';
import { CycloneDxAdapter, type CycloneDxAdapterOptions } from './cyclonedxAdapter';
import { DrizzleAdapter, type DrizzleAdapterOptions } from './drizzleAdapter';
import { FastifyAdapter, type FastifyAdapterOptions } from './fastifyAdapter';
import { LangGraphAdapter, type LangGraphAdapterOptions } from './langgraphAdapter';
import { OctokitAdapter, type OctokitAdapterOptions } from './octokitAdapter';
import { OpenHandsAdapter, type OpenHandsAdapterOptions } from './openhandsAdapter';
import { TypeDocAdapter, type TypeDocAdapterOptions } from './typedocAdapter';
import { ViteAdapter, type ViteAdapterOptions } from './viteAdapter';
import { VitestAdapter, type VitestAdapterOptions } from './vitestAdapter';
import { CortexSdkRegistry } from '../runtime/registry';

export interface CortexAdapterOptions {
  openhands?: OpenHandsAdapterOptions;
  langgraph?: LangGraphAdapterOptions;
  vite?: ViteAdapterOptions;
  fastify?: FastifyAdapterOptions;
  drizzle?: DrizzleAdapterOptions;
  vitest?: VitestAdapterOptions;
  cyclonedx?: CycloneDxAdapterOptions;
  typedoc?: TypeDocAdapterOptions;
  autocannon?: AutocannonAdapterOptions;
  octokit?: OctokitAdapterOptions;
}

/**
 * Build the registry with all ten SDK integrations. Each adapter defers its
 * package import until `isAvailable()`/`run()`, so a workspace missing one SDK
 * still registers the other nine and reports the gap honestly.
 */
export function createDefaultRegistry(options: CortexAdapterOptions = {}): CortexSdkRegistry {
  const registry = new CortexSdkRegistry();
  registry.register(new OpenHandsAdapter(options.openhands));
  registry.register(new LangGraphAdapter(options.langgraph));
  registry.register(new ViteAdapter(options.vite));
  registry.register(new FastifyAdapter(options.fastify));
  registry.register(new DrizzleAdapter(options.drizzle));
  registry.register(new VitestAdapter(options.vitest));
  registry.register(new CycloneDxAdapter(options.cyclonedx));
  registry.register(new TypeDocAdapter(options.typedoc));
  registry.register(new AutocannonAdapter(options.autocannon));
  registry.register(new OctokitAdapter(options.octokit));
  return registry;
}
