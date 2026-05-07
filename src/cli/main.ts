#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { buildCommitCommand } from "./commands/commit.js";
import { buildConfigCommand } from "./commands/config.js";
import { buildDaemonCommand } from "./commands/daemon.js";
import { buildDiffCommand } from "./commands/diff.js";
import { buildInitCommand } from "./commands/init.js";
import { buildLinkCommand } from "./commands/link.js";
import { buildProviderCommand } from "./commands/provider.js";
import { buildProjectCommand } from "./commands/project.js";
import { buildPullCommand } from "./commands/pull.js";
import { buildStatusCommand } from "./commands/status.js";
import { buildUnlinkCommand } from "./commands/unlink.js";
import { buildUseCommand } from "./commands/use.js";

// createRequire is the stable way to load JSON in ESM without import assertions
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require("../../package.json");
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const version = pkg.version as string;

const program = new Command();

program.name("envd").description("CLI for the envdd daemon").version(version);

program
  .command("version")
  .description("Print the CLI version as JSON")
  .action(() => {
    process.stdout.write(JSON.stringify({ cli: version }) + "\n");
  });

program.addCommand(buildCommitCommand());
program.addCommand(buildConfigCommand());
program.addCommand(buildDaemonCommand());
program.addCommand(buildDiffCommand());
program.addCommand(buildInitCommand());
program.addCommand(buildLinkCommand());
program.addCommand(buildProviderCommand());
program.addCommand(buildProjectCommand());
program.addCommand(buildPullCommand());
program.addCommand(buildStatusCommand());
program.addCommand(buildUnlinkCommand());
program.addCommand(buildUseCommand());

program.parse();
