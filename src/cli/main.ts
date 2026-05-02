#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { buildDaemonCommand } from "./commands/daemon.js";

// createRequire is the stable way to load JSON in ESM without import assertions
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require("../../package.json");
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const version = pkg.version as string;

const program = new Command();

program.name("d-env").description("CLI for the d-env daemon").version(version);

program
  .command("version")
  .description("Print the CLI version as JSON")
  .action(() => {
    process.stdout.write(JSON.stringify({ cli: version }) + "\n");
  });

program.addCommand(buildDaemonCommand());

program.parse();
