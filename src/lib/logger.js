// Structured logging and metrics.
//
// One JSON object per line so Logs Insights can query fields instead of
// regexing prose. Metrics ride in the same line using CloudWatch's Embedded
// Metric Format: no PutMetricData call, no latency on the request path, and no
// per-metric API cost.
//
// This is a near-copy of the same module in ffx-bball-bot. Two consumers is
// below the threshold where extracting a shared package pays for itself, and
// AWS Lambda Powertools already occupies that niche if the duplication ever
// starts to hurt.

import { AsyncLocalStorage } from "node:async_hooks";

export const METRIC_NAMESPACE = "FhCommunityBot";

const correlationStore = new AsyncLocalStorage();

/**
 * Run `fn` with every log line and metric tagged by `id`.
 *
 * AsyncLocalStorage rather than a module-level variable: the worker processes
 * SQS records in a warm container, and a shared variable would let concurrent
 * async work cross-tag each other's lines.
 */
export function withCorrelationId(id, fn) {
  return correlationStore.run(id, fn);
}

export function getCorrelationId() {
  return correlationStore.getStore();
}

function serializeError(err) {
  return { name: err.name, message: err.message, stack: err.stack };
}

function replacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (value instanceof Error) return serializeError(value);
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    if (typeof value === "bigint") return value.toString();
    return value;
  };
}

function write(stream, payload) {
  let line;
  try {
    line = JSON.stringify(payload, replacer());
  } catch {
    line = JSON.stringify({
      level: "error",
      message: "logger: payload could not be serialized",
      ts: new Date().toISOString(),
    });
  }
  stream(line);
}

function emit(level, message, fields = {}) {
  const correlationId = getCorrelationId();
  write(level === "error" ? console.error : console.log, {
    level,
    message,
    ts: new Date().toISOString(),
    ...(correlationId ? { correlationId } : {}),
    ...fields,
  });
}

export const log = {
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),
};

/**
 * Emit a CloudWatch metric embedded in a log line.
 *
 * Keep dimension cardinality low — CloudWatch bills per unique dimension
 * combination, so channel and user IDs belong in fields, never dimensions.
 */
export function metric(name, value = 1, { unit = "Count", dimensions = {}, fields = {} } = {}) {
  const correlationId = getCorrelationId();
  const dimensionNames = Object.keys(dimensions);

  write(console.log, {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [dimensionNames],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    ...(correlationId ? { correlationId } : {}),
    ...dimensions,
    ...fields,
    [name]: value,
  });
}
