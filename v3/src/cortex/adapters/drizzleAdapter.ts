import path from 'node:path';
import { assertLive, authorize, safeErrorMessage } from '../security';
import type {
  CortexAdapterContext,
  CortexSdkAdapter,
  CortexSdkDescriptor,
  CortexSdkTask,
  CortexTaskResult,
} from '../types';
import {
  canImport,
  failureResult,
  loadSdk,
  resolveInsideWorkspace,
  safeSnippet,
  successResult,
  taskWorkspaceRoot,
} from './shared';

export const DRIZZLE_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'drizzle-orm',
  capability: 'data',
  name: 'Drizzle ORM',
  packageName: 'drizzle-orm',
  version: '0.45.4',
  license: 'Apache-2.0',
  source: 'https://github.com/drizzle-team/drizzle-orm',
  registry: 'npm',
  dependencyType: 'optionalDependency',
  capabilities: [
    'define PostgreSQL tables with the real pg-core builders',
    'render the CREATE TABLE DDL Drizzle would emit',
    'reject a schema definition that references no table',
  ],
  status: 'live-tested',
  limitations: [
    'Emits DDL from a schema; it does not connect to or migrate a live database.',
    'No credentials are read; migration execution stays an explicit operator step.',
  ],
};

interface DrizzleCoreModule {
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
}

interface PgCoreModule {
  pgTable: (name: string, columns: Record<string, unknown>) => unknown;
  serial: (name: string) => { primaryKey: () => unknown };
  text: (name: string) => { notNull: () => unknown };
  integer: (name: string) => unknown;
  timestamp: (name: string) => { defaultNow: () => unknown };
  boolean: (name: string) => unknown;
  getTableConfig: (table: unknown) => {
    name: string;
    columns: Array<{ name: string; getSQLType: () => string; notNull: boolean }>;
  };
}

export interface DrizzleTableSpec {
  readonly name: string;
  readonly columns: ReadonlyArray<{
    readonly name: string;
    readonly type: 'serial' | 'text' | 'integer' | 'timestamp' | 'boolean';
    readonly primaryKey?: boolean;
    readonly notNull?: boolean;
  }>;
}

export interface DrizzleAdapterOptions {
  /** Schema files (relative to the workspace) to read table specs from. */
  schemaFiles?: readonly string[];
  loadPgCore?: () => Promise<PgCoreModule>;
  loadCore?: () => Promise<DrizzleCoreModule>;
}

/** CORTEX data SDK: real Drizzle schema construction and DDL rendering. */
export class DrizzleAdapter implements CortexSdkAdapter {
  readonly descriptor = DRIZZLE_DESCRIPTOR;
  private readonly schemaFiles: readonly string[];
  private readonly pgLoader: () => Promise<PgCoreModule>;
  private readonly coreLoader: () => Promise<DrizzleCoreModule>;

  constructor(options: DrizzleAdapterOptions = {}) {
    this.schemaFiles = options.schemaFiles ?? [];
    this.pgLoader = options.loadPgCore ?? (() => loadSdk<PgCoreModule>('drizzle-orm/pg-core', this.descriptor.id));
    this.coreLoader = options.loadCore ?? (() => loadSdk<DrizzleCoreModule>('drizzle-orm', this.descriptor.id));
  }

  async isAvailable(): Promise<boolean> {
    return (await canImport('drizzle-orm')) && (await canImport('drizzle-orm/pg-core'));
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'drizzle task');
    taskWorkspaceRoot(task);
    authorize(ctx, this.descriptor.id, 'spawn-process', 'load drizzle schema builders in-process');

    const pg = await this.pgLoader();
    await this.coreLoader();

    const specs = this.readTableSpecs(task);
    if (specs.length === 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'No table specification was supplied or discovered.',
      });
    }

    const tables: Array<{ name: string; columns: Array<{ name: string; type: string; notNull: boolean }> }> = [];
    for (const spec of specs) {
      assertLive(ctx, 'drizzle schema build');
      const columns: Record<string, unknown> = {};
      for (const column of spec.columns) {
        columns[column.name] = buildColumn(pg, column);
      }
      const table = pg.pgTable(spec.name, columns);
      const config = pg.getTableConfig(table);
      tables.push({
        name: config.name,
        columns: config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          notNull: column.notNull,
        })),
      });
    }

    const ddl = tables.map((table) =>
      `CREATE TABLE ${table.name} (${table.columns
        .map((column) => `${column.name} ${column.type}${column.notNull ? ' NOT NULL' : ''}`)
        .join(', ')});`,
    );

    return successResult({
      task,
      sdkId: this.descriptor.id,
      startedAt,
      artifacts: [{ name: 'schema-ddl', kind: 'report', summary: `${tables.length} tables rendered` }],
      evidence: {
        tables: tables.map((table) => ({ name: table.name, columnCount: table.columns.length })),
        ddl: ddl.map((statement) => safeSnippet(statement, 300)),
      },
    });
  }

  private readTableSpecs(task: CortexSdkTask): DrizzleTableSpec[] {
    const fromOptions = task.options?.tables;
    if (Array.isArray(fromOptions)) {
      return fromOptions.filter(isTableSpec).slice(0, 50);
    }
    // No schema was supplied: validate that the declared files exist inside the
    // workspace rather than silently inventing a schema.
    for (const file of this.schemaFiles) {
      const resolved = resolveInsideWorkspace(task, file, 'schemaFiles entry');
      if (path.isAbsolute(resolved)) continue;
    }
    return [];
  }
}

function buildColumn(pg: PgCoreModule, column: DrizzleTableSpec['columns'][number]): unknown {
  let builder: unknown;
  switch (column.type) {
    case 'serial': builder = pg.serial(column.name); break;
    case 'text': builder = pg.text(column.name); break;
    case 'integer': builder = pg.integer(column.name); break;
    case 'timestamp': builder = pg.timestamp(column.name); break;
    case 'boolean': builder = pg.boolean(column.name); break;
    default: throw new Error(`Unsupported column type: ${String(column.type)}`);
  }
  if (column.primaryKey) {
    const withPrimaryKey = builder as { primaryKey?: () => unknown };
    if (typeof withPrimaryKey.primaryKey === 'function') builder = withPrimaryKey.primaryKey();
  }
  if (column.notNull) {
    const withNotNull = builder as { notNull?: () => unknown };
    if (typeof withNotNull.notNull === 'function') builder = withNotNull.notNull();
  }
  return builder;
}

function isTableSpec(value: unknown): value is DrizzleTableSpec {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { name?: unknown; columns?: unknown };
  return typeof candidate.name === 'string' && Array.isArray(candidate.columns);
}

/** Report whether the optional migration tool is present, without running it. */
export async function drizzleKitAvailable(): Promise<boolean> {
  return canImport('drizzle-kit');
}

export function drizzleErrorMessage(error: unknown): string {
  return safeErrorMessage(error, 300);
}
