import type { IncomingMessage } from "node:http";
import { EnvdError } from "../../shared/errors.js";

const MAX_JSON_BODY_BYTES = 64 * 1024;

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"];
    if (
      typeof contentType === "string" &&
      contentType !== "" &&
      !contentType.includes("application/json")
    ) {
      reject(
        new EnvdError("request body must be JSON", { code: "usage_error" }),
      );
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        req.destroy(
          new EnvdError("request body is too large", { code: "usage_error" }),
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on("error", reject);

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw === "" ? {} : JSON.parse(raw));
      } catch (err: unknown) {
        reject(
          new EnvdError("request body is not valid JSON", {
            code: "usage_error",
            cause: err,
          }),
        );
      }
    });
  });
}
