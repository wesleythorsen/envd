# `aii` / “AI Interpret” session summary

## Purpose

This session explored whether there are CLI tools that let a user type a natural-language request and have an LLM interpret it into a concrete terminal action without the user needing to know the exact underlying Unix tools ahead of time.

The conversation then evolved into designing a custom CLI tool for that purpose. The tool was initially discussed as `ai-tool`, then renamed to `aii` (“AI Interpret”).

---

## Original motivation

The concrete motivating example was a task like:

> Output all files from the current directory recursively that contain the text `tetra` anywhere in the filepath or file name, one per line.

The broader goal was a CLI utility that feels composable and Unix-friendly, such as:

```bash
aii "output all files in this dir and all child dirs recursively that contain the text 'tetra' anywhere in the filepath or file name, one per line" | grep -i 'wesley'
````

The key idea was that the user should not need to manually decide whether the correct implementation is `find`, `fd`, `rg`, `grep`, `awk`, etc.

---

## Early findings

We discussed the current state of “AI CLI agent” / “natural language shell” tools. The conclusion was that this category already exists, but most tools are either:

* interactive chat agents,
* terminal-native assistants,
* or one-shot command generators,

rather than fully deterministic, pipe-friendly Unix tools.

We also noted that for the motivating example, the plain Unix solution is simple:

```bash
rg --files | rg -i tetra
```

or

```bash
find . -iname '*tetra*'
```

But the project goal was not just to solve that one example; it was to build a reusable natural-language CLI wrapper.

---

## Initial implementation direction

An early version was proposed that used Claude Code as the planner. The model would interpret the user’s request into a strict JSON “plan,” and then the wrapper would:

1. validate the plan,
2. try to use an installed local command,
3. fall back to internal Node.js logic only if necessary,
4. keep stdout clean and pipe-friendly.

You then requested several important changes:

* no heuristic fallback,
* hard failure on planning errors,
* support for stdin piping,
* a “real tool call” / actual local command preference,
* and later, moving away from Claude Code entirely in favor of a provider-agnostic LLM interface.

---

## Key design changes made during the session

### 1. Claude Code was replaced with a provider-agnostic LLM interface

You specifically wanted the implementation to stop depending on Claude Code and instead use a popular abstraction layer so that different LLM providers could be swapped in under the hood.

The recommended framework was:

* **Vercel AI SDK**

This was chosen because it provides:

* a provider-agnostic TypeScript/Node interface,
* structured-output support,
* support for multiple providers,
* and compatibility with OpenAI-compatible gateways/proxies.

The design shifted from:

* “Claude Code as the planner”

to:

* “Vercel AI SDK as the planner abstraction”
* “local execution remains deterministic and constrained”

### 2. A config file was introduced

The design added a config file stored in the user’s dotfile/config area, specifically:

```text
~/.config/aii/config.json
```

The config file was intended to contain:

* provider settings,
* model selection,
* API credentials,
* planner defaults,
* runtime allowlists.

The config-loading library selected was:

* **`cosmiconfig`**

This was chosen because it is a popular and standard Node.js library for config discovery/loading.

### 3. Provider credentials were moved into config

The config schema was designed to reflect how the abstraction library expects credentials, including support for:

* `openai`
* `anthropic`
* `google`
* `openai-compatible`

This allowed use of direct providers or provider-agnostic gateways such as OpenRouter or other OpenAI-compatible endpoints.

### 4. A plan/debug mode was added

You requested a CLI option that would show the planned command/code rather than executing it, for testing/debugging.

That requirement was incorporated as:

```bash
aii --plan "find files whose path contains tetra"
```

The planned behavior was for this mode to emit a structured representation of the chosen plan, such as:

* selected executable,
* argv array,
* shell preview,
* stdin usage,
* output format,
* or the Node fallback operation details.

### 5. Config auto-bootstrap was added

Initially, config creation required explicit invocation via `--init-config`.

You then requested that the tool automatically initialize config if no config exists yet. The design was updated so that on first run, if config is missing, `aii` automatically creates:

```text
~/.config/aii/config.json
```

The tool still intentionally fails afterward until the placeholder API key is replaced with a real one.

---

## Your explicit requirements

These were the requirements you asked to be called out specifically.

### Requirement 1

> it supports input and output piping and input/output redirection

This requirement was incorporated into the design by keeping:

* primary results on `stdout`
* errors/logging on `stderr`

That means normal shell composition should work:

```bash
printf '%s\n' "prefer hidden files excluded" | aii "find files with tetra in the path"
aii "find files with tetra in the path" | grep -i wesley
aii "find files with tetra in the path" > results.txt
aii "transform stdin somehow" < input.txt
```

The implementation approach was explicitly designed to preserve Unix pipeline behavior.

### Requirement 2

> it should create and use a config file in the user's "dotfile" directory, and use a popular library for interfacing with this config file (config file contains settings and secrets like LLM api key)

This was incorporated by choosing:

* config location: `~/.config/aii/config.json`
* config library: `cosmiconfig`

The design also evolved so that config is automatically created on first run if it does not already exist.

### Requirement 3

> it should not use claude code, and instead use thatpopular framework that abstracts the LLM providers away so that any LLM provider can be used under the hood. The settings in the config file should reflect however this library accepts credentials

This requirement was incorporated by replacing Claude Code with:

* **Vercel AI SDK**

The config format was designed around that abstraction, including support for multiple provider types and compatible credential settings.

### Requirement 4

> it should have a cli option that outputs the planned command/code instead of actually execution the plan. This is for testing/debugging, so users can see what would actually be used

This requirement was incorporated via:

* `--plan`

The intent was for `--plan` to emit the chosen execution plan rather than running it.

### Requirement 5

> if possible, the script internally should/can look at the full command that's being run (the commands before and after the pipe or input redirection), and give this to the LLM for additional context. This *should* help the LLM craft a command that will work better and better suite the user's needs

This was discussed carefully.

The conclusion was:

* a standalone child process generally **cannot reliably introspect the full parent shell pipeline/redirection context on its own**, because the surrounding shell parses and owns that pipeline/redirection state.

So the design could not fully satisfy this automatically from inside the executable alone.

The practical workaround proposed was:

* allow explicit shell context to be passed in via a flag such as `--shell-context`
* or via an environment variable such as `AII_SHELL_CONTEXT`

Example:

```bash
aii --shell-context 'aii "find files with tetra in the path" | grep -i wesley' \
  "find files with tetra in the path"
```

So this requirement was only partially satisfiable in a robust way. The limitation was identified as an operational constraint of normal shell process execution, not a limitation of the LLM itself.

---

## Operational requirements and constraints that shaped the design

Several operational requirements emerged during the session and strongly influenced the design.

### 1. Deterministic, pipe-safe stdout

A major constraint was that the tool should behave like a real Unix command. That meant:

* `stdout` must contain only the primary output
* `stderr` must contain diagnostics and errors
* no extra conversational text should leak into pipelines

This influenced almost every design decision.

### 2. No heuristic parsing fallback

You explicitly rejected “heuristic fallback” behavior. The final direction was:

* if planning fails, the whole thing should fail
* if JSON is invalid, fail
* if execution fails, fail
* if config is invalid, fail

This made the tool stricter and more predictable.

### 3. Prefer installed local tools first

Another strong operational requirement was:

* use actual locally installed tools if possible
* fall back to internal Node.js logic only when necessary

This led to the planner design where the model chooses between:

* a concrete allowed local command
* or a constrained Node fallback operation

### 4. Do not let the model emit arbitrary shell pipelines

To keep the wrapper safe and predictable, the design specifically constrained the planner to return:

* one executable
* one argv array

rather than a free-form shell pipeline string.

This was important both for validation and for keeping the tool composable.

### 5. Model only plans; wrapper executes

A key operational design principle became:

* the LLM should plan
* the wrapper should validate
* the wrapper should execute locally

This keeps the model from becoming the direct executor of shell behavior and preserves a deterministic runtime boundary.

### 6. First-run usability

You wanted the tool not to require a separate manual bootstrap just to get started. That led to the config auto-creation behavior.

### 7. Provider flexibility

You wanted the project not to be tied to one vendor or one login state. This led to the choice of Vercel AI SDK and config-based credentials.

---

## Final architecture direction reached in the session

By the end of the session, the intended design for `aii` looked like this:

1. user runs `aii "<natural language request>"`
2. tool reads stdin if piped
3. tool loads config from `~/.config/aii/config.json`
4. if config does not exist, tool auto-creates it
5. tool collects runtime information:

   * cwd
   * platform
   * shell
   * installed allowed commands
   * optional shell context
   * stdin preview
6. tool calls an LLM through Vercel AI SDK
7. model returns a validated plan:

   * either `exec`
   * or `node-fallback`
8. wrapper validates the plan
9. if `--plan` is set, print the plan and exit
10. otherwise:

    * execute the chosen allowed command locally, or
    * execute the built-in Node fallback
11. write only primary result data to stdout

---

## Example config shape discussed

The config structure discussed included sections like:

```json
{
  "provider": {
    "type": "openai-compatible",
    "baseURL": "https://openrouter.ai/api/v1",
    "apiKey": "REPLACE_ME",
    "model": "openai/gpt-5-mini"
  },
  "planner": {
    "includeHiddenByDefault": false,
    "defaultExcludeDirs": [".git", "node_modules", ".direnv", "dist", "build", "coverage"],
    "stdinPreviewBytes": 8000
  },
  "runtime": {
    "allowedCommands": ["fd", "fdfind", "rg", "find", "grep", "jq", "sed", "awk", "sort", "uniq", "head", "tail", "wc", "cat", "python3", "node"]
  }
}
```

---

## Example usage patterns discussed

### Normal usage

```bash
aii "output all files recursively that contain tetra in the path"
```

### Plan/debug only

```bash
aii --plan "find files whose path contains tetra"
```

### Piped stdin

```bash
printf '%s\n' "prefer ripgrep if available" | aii "find files with tetra in the path"
```

### Piped stdout

```bash
aii "find files with tetra in the path" | grep -i wesley
```

### Explicit shell context

```bash
aii --shell-context 'aii "find files with tetra in the path" | grep -i wesley' \
  "find files with tetra in the path"
```

---

## Remaining gaps / caveats

### 1. Automatic pipeline introspection is not really available

As noted above, the CLI itself cannot generally see the entire parent shell command automatically. That would require a wrapper or shell integration layer.

### 2. Secrets-in-config is workable but may not be ideal

The design supports API keys in config because that was part of your request, but in practice, a future improvement would be to also support environment variables or OS keychain integration.

### 3. The planner schema is intentionally narrow

The design discussed here is best suited for a constrained command-planning tool, not a fully general autonomous shell agent.

---

## Suggested next steps for the Claude Code handoff

Since you are moving this project into Claude Code, the next useful steps for the receiving agent/code session are:

1. create a small Node/TypeScript project for `aii`
2. implement the config bootstrap/load path
3. implement provider/model initialization via Vercel AI SDK
4. implement strict structured plan generation
5. implement local command allowlist validation
6. implement built-in Node fallback operations
7. implement `--plan`
8. optionally add:

   * `config init`
   * `config edit`
   * `doctor`
   * shell wrappers for passing `--shell-context` automatically

---

## Short handoff summary

This session designed a Unix-friendly AI CLI named `aii` (“AI Interpret”) that uses an LLM only for planning, not direct shell execution. The design prioritizes deterministic stdout/stderr behavior, pipeline compatibility, strict failure on planning errors, local-tool preference, config-based provider abstraction via Vercel AI SDK, auto-created config in `~/.config/aii/config.json`, and a `--plan` mode for debugging. Automatic full-pipeline introspection was identified as not reliably possible from a normal standalone CLI process, so explicit shell-context passing was proposed instead.

