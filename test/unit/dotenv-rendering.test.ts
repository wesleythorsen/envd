import { describe, expect, it } from "vitest";
import {
  parse,
  render,
  type DotenvOptions,
} from "../../src/core/rendering/dotenv.js";
import { DEnvError } from "../../src/shared/errors.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function text(bytesToDecode: Uint8Array): string {
  return decoder.decode(bytesToDecode);
}

function expectBadDotenv(fn: () => unknown): DEnvError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DEnvError);
    const denvError = err as DEnvError;
    expect(denvError.code).toBe("bad_dotenv");
    return denvError;
  }

  throw new Error("expected bad_dotenv DEnvError");
}

describe("dotenv rendering", () => {
  it("parses blank lines, comments, keys with dots, and all quote forms", () => {
    const doc = [
      "# full-line comment",
      "   # indented comment",
      "",
      "PLAIN=value",
      "SPACED = hello world   ",
      "EMPTY=",
      "DOTTED.KEY=dot",
      "UNICODE=naive-雪",
      "SINGLE='literal \\n \\\" # ${NOPE}'",
      String.raw`DOUBLE="line\ncarriage\rtab\tquote\"slash\\"`,
    ].join("\n");

    expect(parse(bytes(doc))).toEqual({
      PLAIN: "value",
      SPACED: "hello world",
      EMPTY: "",
      "DOTTED.KEY": "dot",
      UNICODE: "naive-雪",
      SINGLE: 'literal \\n \\" # ${NOPE}',
      DOUBLE: 'line\ncarriage\rtab\tquote"slash\\',
    });
  });

  it("handles CRLF line endings and escaped newlines in values", () => {
    expect(parse(bytes('A=1\r\nMULTILINE="first\\nsecond"\r\n'))).toEqual({
      A: "1",
      MULTILINE: "first\nsecond",
    });
  });

  it("renders alphabetically and quotes only when needed", () => {
    const map = {
      Z_LAST: "plain",
      "APP.DB.URL": "postgres://localhost/db",
      EMPTY: "",
      MULTILINE: "line\nnext",
      UNICODE: "snowman ☃",
      HASH: "abc#def",
      QUOTE: 'say "hi"',
      SINGLE: "it's ok",
      BACKSLASH: "C:\\tmp",
    };

    const rendered = text(
      render(map, { quote: "when-needed", sortKeys: "alphabetical" }),
    );

    expect(rendered).toBe(
      [
        "APP.DB.URL=postgres://localhost/db",
        'BACKSLASH="C:\\\\tmp"',
        "EMPTY=",
        'HASH="abc#def"',
        'MULTILINE="line\\nnext"',
        'QUOTE="say \\"hi\\""',
        'SINGLE="it\'s ok"',
        'UNICODE="snowman ☃"',
        "Z_LAST=plain",
      ].join("\n") + "\n",
    );
    expect(parse(bytes(rendered))).toEqual(map);
  });

  it("renders all values quoted in insertion order when requested", () => {
    const map: Record<string, string> = {};
    map["SECOND"] = "2";
    map["FIRST"] = "1";
    map["EMPTY"] = "";

    expect(text(render(map, { quote: "always", sortKeys: "insertion" }))).toBe(
      ['SECOND="2"', 'FIRST="1"', 'EMPTY=""'].join("\n") + "\n",
    );
  });

  it("round-trips valid secret maps with every render option combination", () => {
    const map = {
      SIMPLE: "value",
      EMPTY: "",
      "APP.DB.URL": "postgres://localhost/db",
      MULTILINE: "line\nnext",
      CARRIAGE: "line\rnext",
      TAB: "a\tb",
      UNICODE: "emoji 🧪 and snow 雪",
      QUOTES: `single ' and double "`,
      HASH: "abc#def",
      BACKSLASH: "C:\\tmp\\file",
    };
    const optionCases: DotenvOptions[] = [
      { quote: "when-needed", sortKeys: "alphabetical" },
      { quote: "when-needed", sortKeys: "insertion" },
      { quote: "always", sortKeys: "alphabetical" },
      { quote: "always", sortKeys: "insertion" },
    ];

    for (const opts of optionCases) {
      expect(parse(render(map, opts), opts)).toEqual(map);
    }
  });

  it("rejects duplicate keys with bad_dotenv", () => {
    const err = expectBadDotenv(() => {
      parse(bytes("A=1\nA=2\n"));
    });

    expect(err.details).toMatchObject({ key: "A", line: 2 });
  });

  it.each([
    ["missing equals", "NO_EQUALS"],
    ["empty key", "=value"],
    ["whitespace in key", "BAD KEY=value"],
    ["unterminated single quote", "A='unterminated"],
    ["unterminated double quote", 'A="unterminated'],
    ["unknown double-quote escape", String.raw`A="bad\q"`],
    ["trailing text after single quote", "A='x'y"],
    ["trailing text after double quote", 'A="x"y'],
  ])("rejects RFC-violating input: %s", (_name, input) => {
    expectBadDotenv(() => {
      parse(bytes(input));
    });
  });

  it("rejects invalid UTF-8 bytes", () => {
    expectBadDotenv(() => {
      parse(new Uint8Array([0xff]));
    });
  });

  it("rejects maps with invalid keys during render", () => {
    expectBadDotenv(() => {
      render({ "BAD KEY": "value" });
    });
  });
});
