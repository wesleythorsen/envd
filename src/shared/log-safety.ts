import { EnvdError } from "./errors.js";
import type { LogData } from "./logger.js";

export function safeErrorLogData(err: unknown): LogData {
  if (err instanceof EnvdError) {
    return {
      errorType: "EnvdError",
      errorCode: err.code,
    };
  }

  if (err instanceof Error) {
    const data: LogData = {
      errorType: err.name === "" ? "Error" : err.name,
    };
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code !== "") {
      data.errorCode = code;
    }
    return data;
  }

  return {
    errorType:
      err === null ? "null" : typeof err === "object" ? "object" : typeof err,
  };
}
