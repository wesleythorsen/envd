interface ColorStream {
  readonly isTTY?: boolean;
}

type Color = "green" | "red" | "yellow";

const codes: Record<Color, string> = {
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
};

export function colorize(
  text: string,
  color: Color,
  stream: ColorStream,
): string {
  if (stream.isTTY !== true || process.env["NO_COLOR"] !== undefined) {
    return text;
  }
  return `${codes[color]}${text}\u001b[0m`;
}
