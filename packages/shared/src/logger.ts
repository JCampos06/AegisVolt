import { hostname } from 'node:os';
import pino, { type Logger } from 'pino';
import {
  CreateLogStreamCommand,
  PutLogEventsCommand,
  type CloudWatchLogsClient,
} from '@aws-sdk/client-cloudwatch-logs';

/**
 * Logger JSON estructurado. Campos en cada línea:
 *   timestamp, level, env, service, version, correlation_id, saga_step, message, error
 * Escribe a stdout (kubectl logs) y, si está habilitado, envía a CloudWatch Logs
 * en lotes cada 2 s al log group /aegisvolt/<env>/<service>.
 */
export interface LoggerOptions {
  service: string;
  env: string;
  version: string;
  level?: string;
  cloudwatch?: CloudWatchSink;
  /** Destino alternativo (pruebas). Por defecto stdout. */
  destination?: pino.DestinationStream;
}

export function createLogger(opts: LoggerOptions): Logger {
  const streams: pino.StreamEntry[] = [{ stream: opts.destination ?? pino.destination(1) }];
  if (opts.cloudwatch) streams.push({ stream: opts.cloudwatch });

  return pino(
    {
      level: opts.level ?? 'info',
      base: { env: opts.env, service: opts.service, version: opts.version },
      messageKey: 'message',
      errorKey: 'error',
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
    },
    pino.multistream(streams),
  );
}

interface LogEvent {
  timestamp: number;
  message: string;
}

const MAX_BUFFER = 10_000;
const MAX_BATCH = 1_000;

/**
 * Stream de pino que acumula líneas y las envía con PutLogEvents.
 * Si CloudWatch no responde, descarta el lote y avisa por stderr (una sola vez):
 * el servicio nunca se cae por no poder loguear.
 */
export class CloudWatchSink {
  private buffer: LogEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private streamReady: Promise<void> | undefined;
  private warned = false;

  constructor(
    private readonly client: CloudWatchLogsClient,
    readonly logGroupName: string,
    flushIntervalMs = 2000,
    readonly logStreamName = `${hostname()}-${process.pid}-${Date.now()}`,
  ) {
    this.timer = setInterval(() => void this.flush(), flushIntervalMs);
    this.timer.unref();
  }

  write(line: string): void {
    if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
    this.buffer.push({ timestamp: Date.now(), message: line.trimEnd() });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, MAX_BATCH);
    try {
      await this.ensureStream();
      await this.client.send(
        new PutLogEventsCommand({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
          logEvents: batch,
        }),
      );
    } catch (err) {
      this.streamReady = undefined;
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(
          `[cloudwatch] no se pudieron enviar logs a ${this.logGroupName}: ${(err as Error).message}\n`,
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.buffer.length > 0) await this.flush();
  }

  private ensureStream(): Promise<void> {
    this.streamReady ??= this.client
      .send(new CreateLogStreamCommand({ logGroupName: this.logGroupName, logStreamName: this.logStreamName }))
      .then(
        () => undefined,
        (err: { name?: string }) => {
          if (err.name !== 'ResourceAlreadyExistsException') throw err;
        },
      );
    return this.streamReady;
  }
}
