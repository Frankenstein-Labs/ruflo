import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  OpenHandsResultVerifier,
  OpenHandsTaskVerification,
} from './OpenHandsSwarm';

const execFile = promisify(nodeExecFile);

export interface GitResultVerifierOptions {
  /** Commands run as argv arrays; do not use shell strings from agent output. */
  checks: Array<{ name: string; command: string; args: string[] }>;
  timeoutMs?: number;
  runCommand?: (command: string, args: string[], cwd: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
}

export class OpenHandsGitResultVerifier implements OpenHandsResultVerifier {
  private readonly timeoutMs: number;
  private readonly runCommand: NonNullable<GitResultVerifierOptions['runCommand']>;

  constructor(private readonly options: GitResultVerifierOptions) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30 * 60_000) {
      throw new Error('Verifier timeout must be between 1000 and 1800000 milliseconds.');
    }
    if (!Array.isArray(options.checks) || options.checks.length === 0) {
      throw new Error('At least one explicit acceptance-check command is required.');
    }
    for (const check of options.checks) {
      if (!check.name.trim() || !check.command.trim() || !Array.isArray(check.args) ||
          check.args.some((arg) => typeof arg !== 'string')) {
        throw new Error('Every verification check requires a name, command, and argv array.');
      }
    }
    this.runCommand = options.runCommand ?? (async (command, args, cwd, timeoutMs) => {
      const result = await execFile(command, args, {
        cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    });
  }

  async verify(input: Parameters<OpenHandsResultVerifier['verify']>[0]): Promise<OpenHandsTaskVerification> {
    const state = String(input.conversation.execution_status ?? input.conversation.status ?? '').toLowerCase();
    if (state !== 'finished') {
      return { passed: false, summary: 'OpenHands execution did not finish successfully.', checks: [
        { name: 'agent-execution-finished', passed: false, details: 'Terminal state: ' + (state || 'unknown') },
      ] };
    }

    const checks: OpenHandsTaskVerification['checks'] = [];
    const run = async (name: string, command: string, args: string[]) => {
      try {
        await this.runCommand(command, args, input.task.workingDirectory, this.timeoutMs);
        checks.push({ name, passed: true });
      } catch (error) {
        // Do not echo stdout/stderr because commands may print environment secrets.
        checks.push({ name, passed: false, details: error instanceof Error ? error.message.slice(0, 300) : 'Command failed.' });
      }
    };

    await run('git-diff-check', 'git', ['diff', '--check']);
    try {
      const status = await this.runCommand('git', ['status', '--porcelain', '--untracked-files=all'], input.task.workingDirectory, this.timeoutMs);
      const hasChanges = status.stdout.trim().length > 0;
      checks.push({
        name: 'git-worktree-has-changes',
        passed: hasChanges,
        details: hasChanges ? undefined : 'No tracked or untracked changes were produced.',
      });
    } catch (error) {
      checks.push({
        name: 'git-worktree-has-changes',
        passed: false,
        details: error instanceof Error ? error.message.slice(0, 300) : 'Could not inspect Git worktree status.',
      });
    }
    for (const check of this.options.checks) await run(check.name, check.command, check.args);

    const passed = checks.length > 0 && checks.every((check) => check.passed);
    return {
      passed,
      summary: passed
        ? 'Configured repository checks passed. A human or policy gate must still review the diff before merge.'
        : 'One or more repository checks failed; this task must not be promoted or merged.',
      checks,
    };
  }
}
