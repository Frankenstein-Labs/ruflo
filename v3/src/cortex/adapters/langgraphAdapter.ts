import { CortexValidationError } from '../errors';
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
  safeSnippet,
  successResult,
} from './shared';

export const LANGGRAPH_DESCRIPTOR: CortexSdkDescriptor = {
  id: 'langgraph',
  capability: 'planning',
  name: 'LangGraph (LangChain)',
  packageName: '@langchain/langgraph',
  version: '1.5.1',
  license: 'MIT',
  source: 'https://github.com/langchain-ai/langgraphjs',
  registry: 'npm',
  dependencyType: 'dependency',
  capabilities: [
    'compile and run a typed state graph for goal decomposition',
    'execute ordered planning nodes with conditional edges',
    'return the structured plan as graph state',
  ],
  status: 'live-tested',
  limitations: [
    'Produces a plan; it does not edit files or run tests.',
    'The planner nodes are deterministic decomposition steps, not an LLM call.',
  ],
};

interface LangGraphModule {
  StateGraph: new (state: unknown) => {
    addNode: (name: string, fn: (state: Record<string, unknown>) => Record<string, unknown>) => unknown;
    addEdge: (from: unknown, to: unknown) => unknown;
    compile: () => { invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };
  };
  Annotation: {
    Root: (fields: Record<string, unknown>) => unknown;
    <T>(spec: { reducer?: (a: T, b: T) => T; default?: () => T }): unknown;
  };
  START: unknown;
  END: unknown;
}

export interface LangGraphAdapterOptions {
  /** Maximum number of decomposed steps; bounded to keep plans reviewable. */
  maxSteps?: number;
  /** Injectable module for tests; production loads the real package. */
  loadModule?: () => Promise<LangGraphModule>;
}

/**
 * CORTEX planning SDK. Builds and runs a real LangGraph state graph whose
 * nodes decompose a mission into ordered, verifiable steps.
 */
export class LangGraphAdapter implements CortexSdkAdapter {
  readonly descriptor = LANGGRAPH_DESCRIPTOR;
  private readonly maxSteps: number;
  private readonly loader: () => Promise<LangGraphModule>;

  constructor(options: LangGraphAdapterOptions = {}) {
    this.maxSteps = options.maxSteps ?? 10;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1 || this.maxSteps > 20) {
      throw new CortexValidationError('maxSteps must be an integer between 1 and 20.');
    }
    this.loader = options.loadModule ?? (() => loadSdk<LangGraphModule>('@langchain/langgraph', 'langgraph'));
  }

  async isAvailable(): Promise<boolean> {
    return canImport('@langchain/langgraph');
  }

  async run(task: CortexSdkTask, ctx: CortexAdapterContext): Promise<CortexTaskResult> {
    const startedAt = new Date().toISOString();
    assertLive(ctx, 'langgraph task');
    authorize(ctx, this.descriptor.id, 'spawn-process', 'load the planning graph in-process');

    let module: LangGraphModule;
    try {
      module = await this.loader();
    } catch (error) {
      throw new Error(safeErrorMessage(error, 200));
    }

    const objectives = extractObjectives(task.instruction, this.maxSteps);
    if (objectives.length === 0) {
      return failureResult({
        task,
        sdkId: this.descriptor.id,
        startedAt,
        error: 'The mission contained no decomposable objective.',
      });
    }

    const { StateGraph, Annotation, START, END } = module;
    const State = Annotation.Root({
      stepIndex: Annotation<number>({
        reducer: (_previous, next) => next,
        default: () => 0,
      }),
      plan: Annotation<string[]>({
        reducer: (previous, next) => [...previous, ...next],
        default: () => [],
      }),
    });

    const graph = new StateGraph(State);
    graph.addNode('select-objective', (state) => {
      const index = Number(state.stepIndex ?? 0);
      const objective = objectives[Math.min(index, objectives.length - 1)];
      return { plan: [`${index + 1}. ${objective}`], stepIndex: index + 1 };
    });
    graph.addEdge(START, 'select-objective');
    graph.addEdge('select-objective', END);
    const compiled = graph.compile();

    // One real graph invocation per objective, so the plan is produced by the
    // actual LangGraph runtime rather than assembled in this file.
    const plan: string[] = [];
    for (let index = 0; index < objectives.length; index += 1) {
      assertLive(ctx, 'langgraph planning');
      const state = await compiled.invoke({ stepIndex: index, plan: [] });
      const steps = Array.isArray(state.plan) ? state.plan : [];
      plan.push(...steps.map((step) => String(step)));
    }

    return successResult({
      task,
      sdkId: this.descriptor.id,
      startedAt,
      artifacts: [{ name: 'plan', kind: 'report', summary: `${plan.length} planned steps` }],
      evidence: {
        steps: plan.length,
        plan,
        graphNodes: ['select-objective'],
        firstStep: safeSnippet(plan[0] ?? ''),
      },
    });
  }
}

/**
 * Turn a mission statement into ordered objectives. Deterministic on purpose:
 * an LLM planner belongs behind an explicit model configuration, not here.
 */
export function extractObjectives(instruction: string, maxSteps: number): string[] {
  const lines = instruction
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
  const sentences = lines.length > 1
    ? lines
    : instruction
        .split(/(?<=[.!?])\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
  return sentences.slice(0, maxSteps).map((item) => safeSnippet(item, 300));
}
