import { Command } from "commander";
import { configFile } from "../../shared/paths.js";
import { writeCliError } from "../error-output.js";
import { editConfig } from "../config-file.js";

export function buildConfigCommand(): Command {
  const config = new Command("config").description("Manage envd CLI config");

  config
    .command("edit")
    .description("Open the machine-local envd TOML config in your editor")
    .action(() => {
      try {
        editConfig(configFile());
      } catch (err: unknown) {
        writeCliError(err);
      }
    });

  return config;
}
