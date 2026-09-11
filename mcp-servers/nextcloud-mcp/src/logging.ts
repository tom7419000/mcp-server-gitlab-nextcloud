type LogFields = Record<string, unknown>;

const SECRET_KEY_PATTERN = /token|password|secret|authorization|cookie/i;

function redact(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(val);
    }
    return out;
  }
  return value;
}

function emit(level: "info" | "warn" | "error", message: string, fields: LogFields): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(redact(fields) as Record<string, unknown>),
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info(message: string, fields: LogFields = {}): void {
    emit("info", message, fields);
  },
  warn(message: string, fields: LogFields = {}): void {
    emit("warn", message, fields);
  },
  error(message: string, fields: LogFields = {}): void {
    emit("error", message, fields);
  },
};

export function logToolCall(fields: {
  tool: string;
  params: Record<string, unknown>;
  durationMs: number;
  outcome: "success" | "denied" | "error";
  resultBytes?: number;
  errorMessage?: string;
}): void {
  logger.info("tool_call", fields);
}
