import { redactValue } from '../security';
import type { CortexLogEvent } from '../types';

export interface CortexLoggerOptions {
  /** Sink for each already-redacted event. Defaults to process.stderr. */
  sink?: (line: string) => void;
  /** Minimum level to emit. */
  minLevel?: CortexLogEvent['level'];
  /** Cap on retained in-memory events (for the UI task log view). */
  maxRetained?: number;
  now?: () => Date;
}

const LEVEL_ORDER: Record<CortexLogEvent['level'], number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface CortexStructuredLogEntry {
  readonly timestamp: string;
  readonly level: CortexLogEvent['level'];
  readonly sdkId: string;
  readonly taskId?: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * Structured, redacting log sink. Every value is passed through the redactor
 * before it is written or retained, so a caller cannot leak a secret by
 * logging a raw environment dump.
 */
export class CortexLogger {
  private readonly entries: CortexStructuredLogEntry[] = [];
  private readonly sink: (line: string) => void;
  private readonly minLevel: CortexLogEvent['level'];
  private readonly maxRetained: number;
  private readonly now: () => Date;

  constructor(options: CortexLoggerOptions = {}) {
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
    this.minLevel = options.minLevel ?? 'info';
    this.maxRetained = options.maxRetained ?? 500;
    this.now = options.now ?? (() => new Date());
  }

  log(event: CortexLogEvent): void {
    if (LEVEL_ORDER[event.level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: CortexStructuredLogEntry = {
      timestamp: this.now().toISOString(),
      level: event.level,
      sdkId: event.sdkId,
      taskId: event.taskId,
      message: String(event.message).slice(0, 1000),
      data: event.data ? (redactValue(event.data) as Record<string, unknown>) : undefined,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxRetained) this.entries.shift();
    this.sink(JSON.stringify(entry));
  }

  history(): readonly CortexStructuredLogEntry[] {
    return [...this.entries];
  }

  forTask(taskId: string): readonly CortexStructuredLogEntry[] {
    return this.entries.filter((entry) => entry.taskId === taskId);
  }
}
