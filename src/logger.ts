import { appendFileSync } from "node:fs";

type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(
  path: string,
  secrets: readonly string[] = [],
): Logger {
  const sensitive = [...new Set(secrets.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  let fileFailed = false;

  function redact(value: string): string {
    for (const secret of sensitive)
      value = value.replaceAll(secret, "[REDACTED]");
    return value;
  }

  function format(
    level: keyof Logger,
    message: string,
    fields?: LogFields,
  ): string {
    const entry = { time: new Date().toISOString(), level, message, fields };
    try {
      return JSON.stringify(entry, (_key, value: unknown) => {
        if (typeof value === "string") return redact(value);
        if (typeof value === "bigint") return value.toString();
        if (value instanceof Error)
          return { name: value.name, message: value.message };
        return value;
      });
    } catch {
      return JSON.stringify({
        ...entry,
        message: redact(message),
        fields: { serializationFailed: true },
      });
    }
  }

  function write(
    level: keyof Logger,
    message: string,
    fields?: LogFields,
  ): void {
    const line = format(level, message, fields);
    console[level](line);
    try {
      appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
      if (fileFailed) {
        fileFailed = false;
        console.info(format("info", "File logging resumed"));
      }
    } catch (error) {
      if (fileFailed) return;
      fileFailed = true;
      console.error(
        format("error", "Could not write to the log file", { error }),
      );
    }
  }

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
