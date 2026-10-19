import { assertLive, authorize, safeErrorMessage } from '../security';
import type {
  CortexAdapterContext,
  CortexSdkAdapter,
  CortexSdkDescriptor,
  CortexSdkTask,
  CortexTaskResult,
} from '../types';
import { canImport, failureResult, loadSdk, safeSnippet, successResult, taskWorkspaceRoot } from './shared';

export const CYCLONEDX_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'cyclonedx',
  capability: 'security',
  name: 'CycloneDX JavaScript Library',
  packageName: '@cyclonedx/cyclonedx-library',
  version: '10.3.0',
  license: 'Apache-2.0',
  source: 'https://github.com/CycloneDX/cyclonedx-javascript-library',
  registry: 'npm',
  dependencyType: 'optionalDependency',
  capabilities: [
    'build a CycloneDX 1.6 software bill of materials',
    'record each dependency component with its version and licence',
    'serialize the BOM to validated JSON for downstream scanners',
  ],
  status: 'live-tested',
  limitations: [
    'Produces an SBOM; it does not itself decide whether a CVE is exploitable.',
    'Vulnerability enrichment requires an external feed, which is not configured here.',
  ],
};

interface CycloneDxComponent {
  version?: string;
  licenses: { add: (license: unknown) => void };
  bomRef: unknown;
  dependencies?: { add: (ref: unknown) => void };
}

interface CycloneDxModule {
  Models: {
    Bom: new () => {
      metadata: { component?: CycloneDxComponent; timestamp?: Date };
      components: { add: (component: CycloneDxComponent) => void };
    };
    Component: new (type: string, name: string, version?: string) => CycloneDxComponent;
    NamedLicense: new (name: string, options?: Record<string, unknown>) => unknown;
  };
  Enums: { ComponentType: Record<string, string> };
  Spec: { Spec1dot6: unknown };
  Serialize: {
    JSON: { Normalize: { Factory: new (spec: unknown) => unknown } };
    JsonSerializer: new (factory: unknown) => {
      /** Returns a JSON string, not a plain object. */
      serialize: (bom: unknown, options?: Record<string, unknown>) => string;
    };
  };
}

export interface DependencyComponent {
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly type?: 'library' | 'application' | 'framework';
}

export interface CycloneDxAdapterOptions {
  /** Components to describe; typically the workspace manifest's dependencies. */
  components?: readonly DependencyComponent[];
  /** Product name recorded in the BOM metadata. */
  productName?: string;
  productVersion?: string;
  loadModule?: () => Promise<CycloneDxModule>;
}

/** CORTEX security SDK: real CycloneDX SBOM generation. */
export class CycloneDxAdapter implements CortexSdkAdapter {
  readonly descriptor = CYCLONEDX_DESCRIPTOR;
  private readonly components: readonly DependencyComponent[];
  private readonly productName: string;
  private readonly productVersion: string;
  private readonly loader: () => Promise<CycloneDxModule>;

  constructor(options: CycloneDxAdapterOptions = {}) {
    this.components = options.components ?? [];
    this.productName = options.productName ?? 'cortex-workspace';
    this.productVersion = options.productVersion ?? '0.0.0';
    this.loader = options.loadModule ?? (() => loadSdk<CycloneDxModule>('@cyclonedx/cyclonedx-library', this.descriptor.id));
  }

  async isAvailable(): Promise<boolean> {
    return canImport('@cyclonedx/cyclonedx-library');
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'cyclonedx task');
    taskWorkspaceRoot(task);
    authorize(ctx, this.descriptor.id, 'spawn-process', 'load the CycloneDX models in-process');

    let module: CycloneDxModule;
    try {
      module = await this.loader();
    } catch (error) {
      throw new Error(safeErrorMessage(error, 200));
    }

    const components = this.resolveComponents(task);
    if (components.length === 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'No dependency components were supplied for the SBOM.',
      });
    }

    const { Models, Enums, Spec, Serialize } = module;
    const bom = new Models.Bom();

    // The library's Component constructor is positional
    // (type, name, version) and `version` is not a constructor option, so it
    // must be assigned afterwards. Licenses are a repository, not a constructor
    // option, and the JSON serializer returns a string, not an object.
    const application = new Models.Component(
      Enums.ComponentType.Application,
      this.productName,
      this.productVersion,
    );
    bom.metadata.component = application;
    bom.metadata.timestamp = new Date();

    for (const component of components) {
      assertLive(ctx, 'cyclonedx component build');
      const type = component.type === 'application'
        ? Enums.ComponentType.Application
        : component.type === 'framework'
          ? Enums.ComponentType.Framework
          : Enums.ComponentType.Library;
      const built = new Models.Component(type, component.name, component.version);
      if (component.license) {
        built.licenses.add(new Models.NamedLicense(component.license, { bomRef: `license-${component.license}` }));
      }
      bom.components.add(built);
      application.dependencies?.add(built.bomRef);
    }

    const factory = new Serialize.JSON.Normalize.Factory(Spec.Spec1dot6);
    const serializer = new Serialize.JsonSerializer(factory);
    const raw = serializer.serialize(bom, { sortLists: true });

    let serialized: {
      specVersion?: string;
      bomFormat?: string;
      components?: Array<{ name?: string; version?: string; licenses?: unknown }>;
    };
    try {
      serialized = JSON.parse(raw) as typeof serialized;
    } catch {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'The CycloneDX serializer returned output that is not valid JSON.',
      });
    }
    if (!serialized.components || serialized.components.length === 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'The CycloneDX serializer produced a BOM with no components.',
      });
    }

    return successResult({
      task,
      sdkId: this.descriptor.id,
      startedAt,
      artifacts: [{ name: 'sbom', kind: 'report', summary: `${serialized.components.length} components` }],
      evidence: {
        bomFormat: serialized.bomFormat ?? 'CycloneDX',
        specVersion: serialized.specVersion ?? '1.6',
        components: serialized.components.slice(0, 25).map((component) => ({
          name: safeSnippet(String(component.name ?? ''), 120),
          version: safeSnippet(String(component.version ?? ''), 60),
          hasLicense: Array.isArray(component.licenses) && component.licenses.length > 0,
        })),
      },
    });
  }

  private resolveComponents(task: CortexSdkTask): DependencyComponent[] {
    const fromOptions = task.options?.components;
    if (Array.isArray(fromOptions)) {
      return fromOptions.filter(isComponent).slice(0, 500);
    }
    return [...this.components];
  }
}

function isComponent(value: unknown): value is DependencyComponent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { name?: unknown; version?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.version === 'string';
}
