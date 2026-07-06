# Phase 9: Multi-Agent (Sub-Agent)

> Series: Mini-Claude-Code Learning Plan — see [`../phase-breakdown.md`](../phase-breakdown.md) for full context.
> **Prerequisites:** [`phase-02-tool-system.md`](phase-02-tool-system.md) (the `ToolDefinition` contract and `executeTool` dispatch this phase's new tool must fit into), [`phase-06-permissions.md`](phase-06-permissions.md) (the 5 `PermissionMode` values, `checkPermission()`, and the session-level confirmation whitelist this phase's dispatch gate reuses), and — **critically** — [`phase-08-memory.md`](phase-08-memory.md), read in full, not skimmed. The phase breakdown's own dependency list for this phase says "Depends on: Phase 1, Phase 2, Phase 6" — that's the *conceptual* dependency (the loop to fork, the tool contract to fit into, the permission-inheritance model to reuse). But every phase in this series builds in strict order, and by the time this phase starts, the learner's actual `src/agent.ts`, `src/tools.ts`, `src/permissions.ts`, `src/compact.ts`, `src/memory.ts`, and `src/prompt.ts` already contain everything from Phases 1–8: streaming (`streamOneTurn`, `earlyExecutions`), permissions (`PermissionState`, `checkPermission`-gated `executeTool`), Tier 0–4 context compaction (`checkAndCompact`, `runCompressionPipeline`), and memory (semantic recall injection, `save_memory`/`forget_memory`). This tutorial is written as a diff against **that** code — Phase 8's own final `agent.ts` (its Step 5) and `tools.ts` (its Step 2) — not against some earlier, simpler hypothetical state. (This series has one recorded instance of skipping this discipline and paying for it: Phase 6 was originally drafted against Phase 4's `agent.ts` instead of Phase 5's, silently reverting Phase 5's streaming work; it had to be fixed after the fact. Phase 8 explicitly avoided repeating that mistake, and this phase does the same.) Phase 8's own "What's next" section anticipates this phase directly and is quoted in Concept 5 below — read it before writing any code.

## Goal

By the end of this phase your agent can delegate an independent subtask to a **sub-agent** — a second, fully isolated instance of the same agent loop — wait for it to finish, and fold its final answer back into the parent conversation as an ordinary tool result. This is the fork-return pattern: the simplest of the three multi-agent architectures real Claude Code supports (sub-agent, coordinator, swarm — see `how-claude-code-works/docs/07-multi-agent.md`, §8.1), and the one every more complex pattern is built on top of.

Concretely, you will build:

- **`src/subagent.ts`** — a new, dependency-light module that resolves a sub-agent *type* (`explore` or `general`) to a system prompt and a scoped subset of the tool registry. It never touches the Anthropic client.
- **A `dispatch_agent` tool**, added to `tools.ts`'s registry, whose schema (`description`, `prompt`, `type`) is exactly what the model sees and fills in — but whose actual execution is intercepted in `agent.ts`, not run through the registry's normal `execute()` path, because it needs things (a live client, the caller's own model string, the parent's permission mode) that no other tool in this registry needs.
- **A recursive call to `runAgentLoop` itself**, inside `agent.ts` — the sub-agent *is* another invocation of the exact same loop this whole series has been building since Phase 1, constructed with a fresh, empty `messages` array, its own scoped tool list, and its own permission mode.
- **A permission-inheritance rule**, added to `checkPermission()`, that decides when a human needs to approve a dispatch at all, and what mode the sub-agent itself runs under once dispatched — including the exact security nuance the phase breakdown flags for later (Phase 11, Plan Mode).

## Why this is interview material

Multi-agent orchestration is one of the highest-signal topics in an agent-engineering interview right now, and it rewards precision over hand-waving in three specific ways this phase makes you build, not just describe:

1. **"Isolation" is a mechanism, not a vibe.** It's easy to say "the sub-agent has its own context" — it's a different, checkable claim to say *exactly* what crosses the boundary (one string, in, one string, out) and what never does (the sub-agent's own turn-by-turn `messages` array, however many iterations it takes internally). This phase proves the second claim with a real, executed test, not an assertion.
2. **Permission inheritance is a genuine, still-open security question in this exact codebase**, not a solved problem you can wave away. The phase breakdown itself flags it: a sub-agent that runs unattended (no human sees a confirmation prompt for what it does) is a reasonable default *and* a real risk, depending on what tools it's carrying. Being able to say precisely where the human's one moment of approval sits, and what runs without one after that, is exactly the kind of nuance an interviewer probing AI-safety-adjacent questions is listening for.
3. **Recursion prevention is usually answered vaguely ("we don't allow that") — this phase shows the actual mechanism**, grounded in both the reference implementation and the real Claude Code source: it's not a runtime check that catches an attempted recursive call, it's that the sub-agent's own API request simply never lists `dispatch_agent` as an available tool, so the model has no way to ask for it. That's a sharper, more defensible answer than "we added a guard."

---

## Files

This phase creates one new file and modifies two files Phase 8 left behind (`tools.ts`, `agent.ts`) plus one file Phase 6 left behind (`permissions.ts`). `src/prompt.ts`, `src/cli.ts`, `src/compact.ts`, `src/memory.ts`, and `src/session.ts` are **not modified at all** — Concept 5 explains exactly why each one already covers this phase's needs without changes.

- `src/subagent.ts` **(new)** — `SubAgentType`, the `explore`/`general` system prompts, and `getSubAgentConfig()`, which derives each type's tool subset directly from `toolRegistry`'s own `readOnly` flag (Phase 2, Concept 6) rather than hand-maintaining a second list. Imports only from `tools.ts` — no dependency on `@anthropic-ai/sdk` or a live client, the same self-contained-leaf-module property Phase 2's `tools.ts` and Phase 8's `memory.ts` both established for the same reason.
- `src/tools.ts` **(modified)** — adds a `dispatch_agent` entry to Phase 8's six-tool registry (so its schema is picked up automatically by `getToolSchemas()`/`buildToolsSection()`), and extracts the gate-then-confirm logic that already lived inside `executeTool()` into its own exported `resolvePermission()` function — a pure refactor, not a behavior change, done so `agent.ts`'s dispatch interception can share the exact same permission handling every other tool call already goes through.
- `src/permissions.ts` **(modified)** — adds one new branch to `checkPermission()` for `dispatch_agent`, using the sub-agent's `type` (from the tool call's own `input`) to decide the verdict: an `explore`-type dispatch is treated like any other read-only action (always allowed, even in `plan` mode); a `general`-type dispatch is treated like a dangerous `run_shell` command (denied in `plan`, denied in `dontAsk`, and requiring human confirmation in both `default` and `acceptEdits`).
- `src/agent.ts` **(modified — diffed against Phase 8's final version, Step 5)** — adds a `dispatchSubAgent()` function that constructs a fresh, isolated conversation and recursively calls `runAgentLoop` on it, and one new branch inside the existing tool-processing loop that intercepts `dispatch_agent` calls before they reach `executeTool()`. Phase 8's `streamOneTurn`, `earlyExecutions`, the memory-prefetch poll-and-inject block, and the `checkAndCompact`/`runCompressionPipeline` calls are all byte-for-byte unchanged.

---

## Concept 1: Why `dispatch_agent` can't be "just another tool" in this registry

Phase 2 established a single, uniform contract every tool in this registry implements (Phase 2, Concept 1):

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool["input_schema"];
  readOnly: boolean;
  execute(input: Record<string, unknown>, state: ReadFileState): string | Promise<string>;
}
```

Every tool built so far — `read_file`, `edit_file`, `list_files`, `run_shell`, and Phase 8's `save_memory`/`forget_memory` — fits this shape because all six only ever need two things to do their job: the model's `input` object, and the per-conversation `ReadFileState` mtime-guard map. A sub-agent dispatch needs three things this signature has no way to supply: a live `Anthropic` client (to actually call the model for the sub-agent's own turns), the caller's own `model` string, and the **parent's own current permission mode** (to decide what mode the child inherits — Concept 3 below). None of those are things `tools.ts`'s registry has ever needed to know about; they live entirely inside `agent.ts`'s `runAgentLoop`, as local variables destructured from `options` at the top of the function.

This is not a new problem in this series — Phase 8 hit the identical shape of problem for `selectRelevantMemories()`'s side query, which also needs a live client and a model string that `memory.ts` deliberately doesn't have access to. Phase 8's answer was to keep `memory.ts` client-agnostic and build the one closure that *does* need a client (`buildSideQuery(client, model)`) inside `agent.ts`, where those two values are already in scope. This phase makes the identical choice for the identical reason: `subagent.ts` (Concept 2) stays as dependency-light as `memory.ts` — no Anthropic import, no execution logic, just configuration — and the actual recursive call lives in `agent.ts`.

The reference implementation hits this exact same wall and solves it the same way, worth reading directly because it names the problem in almost these exact terms (`claude-code-from-scratch/docs/11-multi-agent.md`, quoted and translated): *"the `agent` tool needs special dispatch, because it needs access to the current Agent instance's state (model, permissionMode, token counters) — it can't go through the stateless generic dispatch function."* Their `Agent` class is object-oriented, so "the current instance's state" means `this.model`/`this.permissionMode`; this project's `runAgentLoop` is a plain function, so the equivalent state is just the local variables already sitting in scope inside it — arguably an easier fit than the reference's own class-based version, not a harder one.

**So what does `dispatch_agent` look like in the registry, if its `execute()` can never actually be the thing that runs it?** It's registered with a real schema (so `getToolSchemas()` sends it to the API, and `buildToolsSection()` — Phase 3, Concept 4's "generate from the registry, don't hand-maintain a second list" — describes it to the model automatically, with zero changes to either function), but its `execute` field is a placeholder that throws if it's ever actually reached:

```typescript
execute: () => {
  throw new Error(
    "dispatch_agent must be intercepted in agent.ts's tool-processing loop before reaching this placeholder"
  );
},
```

Because `executeTool()`'s existing `try`/`catch` (Phase 2, Concept 2: "errors are data, not exceptions") already wraps every `tool.execute()` call, this placeholder degrades safely to an ordinary error string if `agent.ts`'s interception logic ever has a bug and this code path is somehow reached — not a crash. This is a deliberate defensive choice, not an oversight: the same philosophy that makes a missing tool name return a string instead of throwing all the way up the stack also makes a mis-wired interception fail as data the model can see, rather than as an unhandled exception that takes down the whole process.

---

## Implement 1: Add `dispatch_agent` to the registry, and extract `resolvePermission`

- [ ] Modify `src/tools.ts` — add the `dispatch_agent` entry to `toolRegistry`, and extract the permission gate-then-confirm logic that already lives inside `executeTool()` (Phase 6, Step 5; Phase 8, Step 2) into its own exported `resolvePermission()` function. This is the complete file as of this step (everything before `toolRegistry` — `readFile`/`editFile`/`listFiles`/`runShell`/`saveMemoryTool`/`forgetMemoryTool` — is byte-for-byte Phase 8's version):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
  import { execSync } from "node:child_process";
  import { resolve } from "node:path";
  import { checkPermission, type PermissionMode } from "./permissions.js";
  import { saveMemory, deleteMemory, type MemoryType } from "./memory.js";

  export type ReadFileState = Map<string, number>;

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
    execute(input: Record<string, unknown>, state: ReadFileState): string | Promise<string>;
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
    if (!existsSync(absPath)) return `Error: file not found: ${input.file_path}`;
    if (!state.has(absPath)) return `Error: you must read_file("${input.file_path}") before editing it.`;
    const lastKnownMtime = state.get(absPath)!;
    const currentMtime = statSync(absPath).mtimeMs;
    if (currentMtime !== lastKnownMtime) {
      return `Error: ${input.file_path} was modified on disk since you last read it. Call read_file again before editing.`;
    }
    const content = readFileSync(absPath, "utf-8");
    const count = content.split(input.old_string).length - 1;
    if (count === 0) return `Error: old_string not found in ${input.file_path}`;
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
      if (entries.length === 0) return `(empty directory: ${dirPath})`;
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

  const VALID_MEMORY_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

  function saveMemoryTool(input: {
    name: string;
    description: string;
    type: string;
    content: string;
  }): string {
    if (!VALID_MEMORY_TYPES.has(input.type as MemoryType)) {
      return `Error: invalid memory type "${input.type}". Must be one of: user, feedback, project, reference.`;
    }
    const filename = saveMemory({
      name: input.name,
      description: input.description,
      type: input.type as MemoryType,
      content: input.content,
    });
    return `Saved memory to ${filename}. The memory index has been updated.`;
  }

  function forgetMemoryTool(input: { filename: string }): string {
    const ok = deleteMemory(input.filename);
    return ok
      ? `Deleted memory ${input.filename}.`
      : `Error: no memory file named "${input.filename}" (check the index for exact filenames).`;
  }

  // ─── dispatch_agent ───────────────────────────────────────────────────
  //
  // New in Phase 9. Registered here ONLY so its schema is picked up
  // automatically by getToolSchemas()/buildToolsSection() (Phase 3's
  // "generate from the registry, don't hand-maintain a second list"
  // precedent, reaffirmed in Phase 8 Step 6 for save_memory/forget_memory).
  // The execute() below is a placeholder that should never actually run --
  // dispatch_agent needs a live Anthropic client, the caller's own model
  // string, and the PARENT's permission mode, none of which fit this
  // registry's stateless (input, state) => string signature (the same
  // reason Phase 8's buildSideQuery lives in agent.ts, not memory.ts).
  // agent.ts's tool-processing loop intercepts calls to this tool BEFORE
  // they ever reach executeTool()/findTool() -- see this phase's tutorial,
  // Concept 1 and Concept 4.

  export const toolRegistry: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read the contents of a file. Returns the file content with line numbers.",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string", description: "The path to the file to read" } },
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
        editFile(input as { file_path: string; old_string: string; new_string: string }, state),
    },
    {
      name: "list_files",
      description:
        "List the contents of a directory (non-recursive). Returns one entry per line, prefixed with 'd' for directories and 'f' for files.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The directory to list. Defaults to the current working directory." },
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
    {
      name: "save_memory",
      description:
        "Save a fact to persistent, cross-session memory. type must be one of: user, feedback, project, reference. Only save information that is NOT derivable by reading the current code, git history, or CLAUDE.md.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short, human-readable memory name" },
          description: { type: "string", description: "One-line description used later to judge relevance — be specific" },
          type: { type: "string", description: "One of: user, feedback, project, reference" },
          content: { type: "string", description: "The memory content. For feedback/project types, include a Why: and How to apply: line." },
        },
        required: ["name", "description", "type", "content"],
      },
      readOnly: false,
      execute: (input) =>
        saveMemoryTool(input as { name: string; description: string; type: string; content: string }),
    },
    {
      name: "forget_memory",
      description: "Delete a saved memory by its filename (as shown in the memory index).",
      input_schema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "The memory file's filename, e.g. feedback_no_summary.md" },
        },
        required: ["filename"],
      },
      readOnly: false,
      execute: (input) => forgetMemoryTool(input as { filename: string }),
    },
    {
      name: "dispatch_agent",
      description:
        "Dispatch an isolated sub-agent to handle an independent subtask and return its final result. " +
        "The sub-agent has NO visibility into this conversation — the prompt must be completely " +
        "self-contained. Types: 'explore' (read-only: read_file/list_files only, fast), 'general' " +
        "(every tool except dispatching further sub-agents). Default: general.",
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short (3-5 word) description of the sub-agent's task" },
          prompt: { type: "string", description: "Complete, self-contained task instructions" },
          type: { type: "string", enum: ["explore", "general"], description: "Sub-agent type. Default: general" },
        },
        required: ["description", "prompt"],
      },
      readOnly: false,
      execute: () => {
        throw new Error(
          "dispatch_agent must be intercepted in agent.ts's tool-processing loop before reaching this placeholder"
        );
      },
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
   * The gate-then-confirm logic executeTool() runs before dispatching to a
   * tool's own execute(). Extracted as its own exported function in Phase 9
   * (a pure refactor — behavior is byte-for-byte identical to Phase 6/8's
   * inline version) so agent.ts's dispatch_agent interception can share the
   * exact same permission handling (deny/confirm/whitelist) that every
   * other tool call already goes through, without duplicating it.
   */
  export type PermissionOutcome = { proceed: true } | { proceed: false; result: string };

  export async function resolvePermission(
    name: string,
    input: Record<string, unknown>,
    readOnly: boolean,
    permission: PermissionState
  ): Promise<PermissionOutcome> {
    const decision = checkPermission(name, input, readOnly, permission.mode);

    if (decision.action === "deny") {
      return { proceed: false, result: `Action denied: ${decision.message ?? name}` };
    }

    if (decision.action === "confirm") {
      const key = decision.message ?? name;
      if (!permission.confirmedActions.has(key)) {
        if (!permission.confirmTool) {
          return {
            proceed: false,
            result: `Action denied: confirmation required but no interactive confirmation handler is available (non-interactive mode): ${key}`,
          };
        }
        const approved = await permission.confirmTool(key);
        if (!approved) return { proceed: false, result: "User denied this action." };
        permission.confirmedActions.add(key);
      }
    }

    return { proceed: true };
  }

  /**
   * Look up a tool by name and run it — but first, gate it through
   * resolvePermission(). Unchanged in BEHAVIOR from Phase 6/8: this is the
   * same deny/confirm/whitelist logic, just moved into its own function so
   * it has exactly one implementation instead of two (Concept 1).
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

    const outcome = await resolvePermission(name, input, tool.readOnly, permission);
    if (!outcome.proceed) return outcome.result;

    try {
      return await tool.execute(input, state);
    } catch (e) {
      return `Error executing ${name}: ${(e as Error).message}`;
    }
  }
  ```

- [ ] Confirm the refactor changed nothing observable about `executeTool()` — run the exact same checks Phase 6/8 already ran against it:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/tools.js').then(async (m) => {
    const state = new Map();
    const perm = { mode: 'default', confirmedActions: new Set() };
    console.log('unknown tool:', await m.executeTool('nope', {}, state, perm));
    console.log('list_files (readOnly, always allow):', (await m.executeTool('list_files', { path: '.' }, state, perm)).slice(0, 30));
    const perm2 = { mode: 'default', confirmedActions: new Set(), confirmTool: async () => false };
    console.log('dangerous run_shell denied by human:', await m.executeTool('run_shell', { command: 'rm -rf /tmp/zz' }, state, perm2));
  });
  "
  ```

  Real captured output from this exact scenario, run in this tutorial's isolated verification directory:

  ```
  unknown tool: Unknown tool: nope
  list_files (readOnly, always allow): d  node_modules
  d  src
  f  pack
  dangerous run_shell denied by human: User denied this action.
  ```

  Identical to what Phase 6/8's own equivalent checks produced — confirming `resolvePermission`'s extraction is a pure refactor, not a behavior change.

---

## Concept 2: `subagent.ts` — tool scoping and recursion prevention, for free

`subagent.ts` resolves a `SubAgentType` (`"explore"` or `"general"`) to a `{ systemPrompt, tools }` pair. It is a **leaf module**: it imports only from `tools.ts`, exactly like the reference project's own `subagent.ts`, which the phase breakdown's own dependency-verification note relies on directly (`phase-breakdown.md`, Phase 9 entry: *"No build dependency on Skills/Plan Mode (verified: `subagent.ts` only imports `tools.ts`/`frontmatter.ts`)"*). This project's version doesn't even need `frontmatter.ts` (it has no custom-agent-from-Markdown-file feature — see this phase's Grounding notes for why that's a deliberate, flagged scope cut, not an oversight), so it's an even smaller dependency footprint than the reference's own version.

**Tool scoping, derived from data this project already has.** `read_file` and `list_files` are the only two tools in this registry marked `readOnly: true` — a classification Phase 2, Concept 6 set on every `ToolDefinition` specifically so future phases could branch on it without a registry redesign. This phase is the second thing (after Phase 5's parallel-execution check and Phase 6's permission gate) to actually consume that flag:

```typescript
export function getSubAgentConfig(type: SubAgentType): SubAgentConfig {
  if (type === "explore") {
    return { systemPrompt: EXPLORE_PROMPT, tools: toolRegistry.filter((t) => t.readOnly) };
  }
  return { systemPrompt: GENERAL_PROMPT, tools: toolRegistry.filter((t) => t.name !== "dispatch_agent") };
}
```

This is a deliberate departure from the reference implementation, worth naming precisely rather than silently copying: the reference project's own `subagent.ts` hand-maintains a separate `READ_ONLY_TOOLS` `Set` for this exact purpose (`claude-code-from-scratch/src/subagent.ts`, line 30: `const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep_search"])`) rather than reading the registry's own `readOnly` field — even though their own `tools.ts` has that same field available. Worse, their own tutorial chapter's prose (`claude-code-from-scratch/docs/11-multi-agent.md`, lines 99-101) shows a *different*, four-entry version of that same `Set` that also includes `run_shell`, directly contradicting their own shipped `subagent.ts` source — a real inconsistency between the reference project's documentation and its code, confirmed by reading both directly rather than assuming one summarizes the other correctly. This project sidesteps the whole question by deriving the subset from the one, single source of truth (`toolRegistry`'s own `readOnly` flag) that Phase 2 already established — the same "generate from the registry, don't hand-maintain a second list" principle Phase 3 and Phase 8 both already applied to `buildToolsSection()`.

One real, flagged capability limitation follows directly from this choice: this project's registry has no dedicated text-search tool (no `grep_search` equivalent — Phase 2 never built one), and `run_shell` is `readOnly: false` (Phase 2, Concept 6's own classification, unchanged since), so it is *not* included in `explore`'s tool set. An `explore`-type sub-agent in this project can only read specific files it already knows the path to and list directories — it cannot search file *contents* by pattern the way the reference project's (or real Claude Code's) Explore agent can via `grep`/`run_shell`. This is a real, named scope cut, not a bug: including `run_shell` in a supposedly "read-only" tool set would mean an `explore`-type dispatch is no longer actually code-enforced read-only (a model could still ask it to run a destructive command; only a system-prompt sentence, not a code-level guarantee, would stand in the way) — exactly the "code enforces the invariant a prompt can only request" principle Phase 2, Concept 4 and Phase 6, Concept 1 both already established for this project. Keeping `explore`'s tool set to a pure `readOnly`-flag filter, with zero exceptions, keeps that guarantee intact at the cost of some capability — a trade this project makes deliberately, in the safer direction.

**Recursion prevention is what `general`'s tool list *doesn't* include, and nothing else.** `toolRegistry.filter((t) => t.name !== "dispatch_agent")` is the entire mechanism. There is no runtime check anywhere that detects and blocks an attempted recursive dispatch — there doesn't need to be one, because of a hard constraint in the Anthropic Messages API itself, already established all the way back in Phase 1: **the model can only ever request a `tool_use` for a tool name present in that exact request's `tools` array** (Phase 1, Concept 1). If `dispatch_agent`'s schema is never included in the sub-agent's own `tools:` option, the sub-agent's underlying model has no way to emit a `tool_use` block naming it — not because something intercepts and refuses the attempt, but because the API's own tool-use protocol makes the request impossible to construct in the first place. This is a stronger, more precise answer than "we added a guard against recursion," and it's exactly what both the reference project and real Claude Code actually rely on:

- **The reference project** does this unconditionally, for every sub-agent type, with no exceptions: `claude-code-from-scratch/src/subagent.ts`'s `getSubAgentConfig()` filters `toolDefinitions.filter((t) => t.name !== "agent")` for every branch (explore, plan, general, and even user-defined custom agents when no explicit `allowedTools` list is given) — read directly, lines 149 and 163.
- **Real Claude Code** does the identical thing, but *conditionally* — and the condition is the more interesting, citable detail. `claude-code/src/constants/tools.ts`, lines 36-46 (quoted directly):

  ```typescript
  export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
    TASK_OUTPUT_TOOL_NAME,
    EXIT_PLAN_MODE_V2_TOOL_NAME,
    ENTER_PLAN_MODE_TOOL_NAME,
    // Allow Agent tool for agents when user is ant (enables nested agents)
    ...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),
    ASK_USER_QUESTION_TOOL_NAME,
    TASK_STOP_TOOL_NAME,
    ...
  ])
  ```

  `ALL_AGENT_DISALLOWED_TOOLS` is a **global, layer-one filter applied to every sub-agent regardless of type** (`how-claude-code-works/docs/07-multi-agent.md`, §8.2, "工具过滤流水线" — the first and most universal of four filtering layers, confirmed by reading `agentToolUtils.ts`'s `filterToolsForAgent()` directly). For external users (`USER_TYPE !== 'ant'`), the Agent tool itself is unconditionally in that disallowed set — meaning even `general-purpose` agent, whose own definition says `tools: ['*']` (`claude-code/src/tools/AgentTool/built-in/generalPurposeAgent.ts`, line 29, read directly), never actually receives the Agent tool once this global filter runs. Only Anthropic-internal users get the exception commented above, which enables genuinely nested agent dispatch for that population specifically — external users get exactly the same "recursion is impossible because the tool isn't offered" guarantee this project and the reference project both build unconditionally.

This project makes the reference project's unconditional choice (no `ant`-style exception, no configuration to relax it) — the simplest possible answer, confirmed by direct reading to be genuinely what both the teaching reference and (for the population most engineers will ever interact with) the real production system actually do.

---

## Implement 2: Create `src/subagent.ts`

- [ ] Create `src/subagent.ts` with this content (complete file):

  ```typescript
  // Sub-agent configuration -- fork-return pattern (Phase 9). A leaf
  // module: it only imports from tools.ts, exactly like the reference
  // project's own subagent.ts (claude-code-from-scratch/src/subagent.ts
  // imports only tools.js and frontmatter.js, never agent.ts -- confirmed
  // by direct reading). This project needs even less than that: no
  // frontmatter.ts, since this phase does not build the reference's
  // .claude/agents/*.md custom-agent-discovery feature (see this phase's
  // Grounding notes). Keeping this module free of any Anthropic client
  // dependency means the one piece of this system that DOES need a live
  // client -- the actual recursive runAgentLoop() call -- lives in
  // agent.ts instead, the same split Phase 8 already established for
  // buildSideQuery (memory.ts has no client; agent.ts builds the one
  // closure that needs one).

  import { toolRegistry, type ToolDefinition } from "./tools.js";

  export type SubAgentType = "explore" | "general";

  export interface SubAgentConfig {
    systemPrompt: string;
    tools: ToolDefinition[];
  }

  const EXPLORE_PROMPT = `You are an Explore sub-agent -- a fast, read-only sub-agent dispatched to search and report back on this codebase.

  IMPORTANT CONSTRAINTS:
  - You are READ-ONLY. You only have access to read_file and list_files.
  - Do NOT attempt to modify any files -- you have no tool that can.

  Be thorough: check multiple locations, consider different naming conventions, look for related files.
  When you are done, respond with a concise summary of what you found -- the caller cannot see your intermediate tool calls, only your final answer.`;

  const GENERAL_PROMPT = `You are a sub-agent dispatched to handle one independent task. Complete the task fully -- don't leave it half-done -- then respond with a concise report of what was done and any key findings. The caller cannot see your intermediate tool calls or this conversation -- only your final answer, so make sure it stands on its own.

  You have access to every tool the main agent has, except dispatching further sub-agents -- you cannot delegate this task onward.`;

  /**
   * Resolve a sub-agent type to its system prompt and tool subset. Tool
   * scoping is derived directly from toolRegistry's own readOnly flag
   * (Phase 2, Concept 6) rather than hand-maintained in a second list --
   * read_file and list_files are the only two tools in this registry
   * marked readOnly: true, so that's exactly what "explore" gets.
   * "general" gets every tool except dispatch_agent itself -- omitting it
   * here, not a runtime check, is what actually prevents a sub-agent from
   * dispatching a sub-agent of its own (Concept 2).
   */
  export function getSubAgentConfig(type: SubAgentType): SubAgentConfig {
    if (type === "explore") {
      return {
        systemPrompt: EXPLORE_PROMPT,
        tools: toolRegistry.filter((t) => t.readOnly),
      };
    }
    return {
      systemPrompt: GENERAL_PROMPT,
      tools: toolRegistry.filter((t) => t.name !== "dispatch_agent"),
    };
  }
  ```

- [ ] Confirm the tool scoping directly:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/subagent.js').then((m) => {
    const explore = m.getSubAgentConfig('explore');
    const general = m.getSubAgentConfig('general');
    console.log('explore tools:', explore.tools.map(t => t.name));
    console.log('general tools:', general.tools.map(t => t.name));
    console.log('general excludes dispatch_agent:', !general.tools.some(t => t.name === 'dispatch_agent'));
  });
  "
  ```

  Real captured output from this exact code, in this tutorial's isolated verification directory:

  ```
  explore tools: [ 'read_file', 'list_files' ]
  general tools: [
    'read_file',
    'edit_file',
    'list_files',
    'run_shell',
    'save_memory',
    'forget_memory'
  ]
  general excludes dispatch_agent: true
  ```

---

## Concept 3: Permission inheritance — the real security nuance

The phase breakdown flags this precisely: *"permission inheritance into sub-agents (default `bypassPermissions`, but Plan Mode's read-only restriction must still propagate) will be revisited when Phase 11 (Plan Mode) is built — a real security nuance in the source."* This phase doesn't build Plan Mode's approval workflow (that's Phase 11), but it has to make a real, considered, forward-compatible decision right now about what mode a sub-agent runs under, grounded in this project's actual `PermissionMode` type (Phase 6, Concept 2) — not a placeholder.

**The default: `bypassPermissions`, unless the parent is in `plan` mode.**

```typescript
const childPermissionMode: PermissionMode =
  deps.parentPermissionMode === "plan" ? "plan" : "bypassPermissions";
```

This is exactly the reference project's own rule, read directly (`claude-code-from-scratch/src/subagent.ts`'s companion `agent.ts` excerpt, quoted in `docs/11-multi-agent.md`): `permissionMode: this.permissionMode === "plan" ? "plan" : "bypassPermissions"`, with the reasoning stated directly and translated: *"permission inheritance: the sub-agent defaults to bypassPermissions (the main agent has already authorized it, the sub-agent doesn't need to ask the user again), but Plan Mode must be inherited — otherwise the sub-agent could bypass the read-only restriction, which would be a security hole."*

**Why `bypassPermissions` is a defensible default *for this specific system*, not just "the reference project does it":** by the time a `general`-type dispatch actually starts running (Concept 4 below), a human has already had exactly one chance to say no to it — the `confirm`-tier gate this phase adds to `checkPermission()` for exactly this tool (Implement 3). Once that single approval has happened, re-confirming every individual tool call the sub-agent makes internally would be redundant *and* would defeat the entire economic point of delegating a task in the first place — the sub-agent is supposed to run a multi-step subtask to completion without needing a human in the loop for every step, the same way approving `edit_file` isn't asked again for a second call on a different file. This mirrors the exact reasoning Phase 6, Concept 5 already established for the session-level `confirmedActions` whitelist: ask once, then trust the whitelist, rather than re-asking for something already approved in spirit.

**Why the real Claude Code source does something more conservative here, and why it's worth naming the gap precisely rather than glossing over it:** the phase breakdown's phrasing ("default `bypassPermissions`") describes the reference project's own simplified teaching implementation, which this project follows — but reading the real source directly shows a *more conservative* actual production default. `claude-code/src/tools/AgentTool/AgentTool.tsx`, lines 573-577 (quoted directly):

```typescript
const workerPermissionContext = {
  ...appState.toolPermissionContext,
  mode: selectedAgent.permissionMode ?? 'acceptEdits'
};
const workerTools = assembleToolPool(workerPermissionContext, appState.mcp.tools);
```

Production's real default, when an agent definition doesn't specify its own `permissionMode`, is `acceptEdits` — not `bypassPermissions`. Under this project's own `checkPermission()` (Phase 6, Step 4), the practical difference is exactly the one Concept 2 of Phase 6 already documented: `acceptEdits` auto-approves `edit_file` but *still* requires confirmation for a dangerous `run_shell` command, whereas `bypassPermissions` allows everything unconditionally, including dangerous shell commands, from its very first line. This is a real, meaningful gap between what this project (following the reference project) builds and what real Claude Code actually defaults to, worth being able to name precisely in an interview: **production is more conservative about what an unattended sub-agent can do than the teaching version this series builds.**

**The sharpest, most concrete form of the nuance — verified, not asserted.** This project's `checkPermission()` short-circuits to `allow` for `bypassPermissions` mode on its very first line (Phase 6, Step 4) — *before* even the declarative deny-rule layer (Phase 6, Concept 4) runs. That means a `general`-type sub-agent, once dispatched, doesn't just skip human confirmation for dangerous-looking commands — it skips a project's own explicit, hand-written `.claude/settings.json` deny rules too. This was verified directly, not just reasoned about:

```bash
cd /Users/grexrr/Documents/NAC
mkdir -p .claude
cat > .claude/settings.json <<'EOF'
{ "permissions": { "deny": ["run_shell(rm*)"] } }
EOF
npx tsx -e "
import('./src/permissions.js').then((m) => {
  console.log('default + deny-ruled rm:', m.checkPermission('run_shell', { command: 'rm -rf /tmp/x' }, false, 'default'));
  console.log('bypassPermissions + SAME deny-ruled rm:', m.checkPermission('run_shell', { command: 'rm -rf /tmp/x' }, false, 'bypassPermissions'));
});
"
rm -rf .claude
```

Real captured output:

```
default + deny-ruled rm: { action: 'deny', message: 'Denied by permission rule for run_shell' }
bypassPermissions + SAME deny-ruled rm: { action: 'allow' }
```

The identical command, gated by the identical project-level deny rule, produces opposite verdicts depending only on mode. This is the concrete, checkable shape of "a human approves the dispatch once, then the sub-agent runs with fewer safety nets than the parent normally has" — not a hand-wavy risk, a specific, demonstrated one.

**A precise, code-level answer to what happens when a `general`-type dispatch is actually requested — the one moment of human control.** Rather than leaving the parent's own dispatch call ungated (which Phase 6, Concept 5 already flagged as a real risk of this project's fail-open design: *"if a fifth tool were added to this registry without updating `checkPermission()` to have an opinion about it, this design would silently allow it"*), this phase gives `checkPermission()` an explicit, considered opinion about `dispatch_agent` specifically:

- An `explore`-type dispatch is treated exactly like any other read-only action: always allowed, in every mode, including `plan` — because its own tool set is itself derived from `readOnly`-flagged tools only (Concept 2), so there is nothing it can do that a bare `read_file`/`list_files` call couldn't already do.
- A `general`-type dispatch — which can write files, run shell commands, and save/forget memories — is treated with the same posture this project already gives a dangerous `run_shell` command: denied outright in `plan` mode (propagating plan's read-only restriction, per the breakdown's own flagged requirement — see below), auto-denied in `dontAsk` mode (nobody can answer, so the safer direction is refusal, per Phase 6, Concept 2's own reasoning), and requiring a human's explicit confirmation in **both** `default` and `acceptEdits` modes. Requiring confirmation even in `acceptEdits` is a deliberate, more conservative choice than how that mode treats `edit_file` (auto-approved) — a single, bounded file edit is not the same order of consequence as delegating an entire autonomous, multi-step task to a sub-agent that will run unattended once approved.

**Plan Mode's restriction already propagates correctly — today, without Phase 11 existing yet.** `plan` has been one of this project's 5 trust modes since Phase 6 (reachable today via the CLI's `--plan` flag), even though the dedicated `EnterPlanMode`/`ExitPlanMode` tools and the plan-file workflow don't exist until Phase 11. Because this phase's `checkPermission()` branch explicitly denies `general`-type dispatch in `plan` mode, and because `dispatchSubAgent()`'s own `childPermissionMode` computation explicitly propagates `plan` into the child whenever the parent is in `plan` (rather than defaulting to `bypassPermissions` unconditionally), **the moment Phase 11 adds real entry/exit tools for Plan Mode, sub-agent dispatch will already respect it correctly, with zero further changes to `subagent.ts`, `permissions.ts`, or the dispatch logic in `agent.ts`.** This is the concrete meaning of the breakdown's instruction to design permission inheritance "in a way that doesn't foreclose that later requirement" — it's not a promise to revisit later, it's already-correct behavior that Phase 11 only has to *exercise*, not build.

---

## Implement 3: Wire `dispatch_agent` into `checkPermission()`

- [ ] Modify `src/permissions.ts` — add one new branch to `checkPermission()`, positioned after the declarative-rule layer and the `readOnly` early-return, but **before** the blanket `plan`-mode deny (so an `explore`-type dispatch, being read-only by construction, is treated like any other read-only tool and bypasses that blanket deny the same way `read_file` already does). This is the complete file as of this step (everything above `checkPermission()` — the 5 modes, `DANGEROUS_PATTERNS`/`isDangerous`, and the declarative-rule loading/matching from Phase 6, Step 4 — is byte-for-byte unchanged):

  ```typescript
  import { existsSync, readFileSync } from "node:fs";
  import { join } from "node:path";
  import { homedir } from "node:os";

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

  interface ParsedRule {
    tool: string;
    pattern: string | null;
  }

  interface PermissionRules {
    allow: ParsedRule[];
    deny: ParsedRule[];
  }

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

    for (const rule of rules.deny) {
      if (matchesRule(rule, toolName, input)) return "deny";
    }
    for (const rule of rules.allow) {
      if (matchesRule(rule, toolName, input)) return "allow";
    }
    return null;
  }

  /**
   * The unified permission check. New in Phase 9: a dedicated branch for
   * dispatch_agent, checked after the declarative-rule layer and the
   * readOnly early-return, but BEFORE the blanket plan-mode deny -- so an
   * explore-type dispatch (whose own tool set is itself derived from
   * readOnly-flagged tools only, Concept 2) is treated exactly like any
   * other read-only action: always allowed, even in plan mode. A
   * general-type dispatch is treated with the same posture as a dangerous
   * run_shell command -- acceptEdits auto-approves a single, bounded file
   * edit, but does not blanket-approve delegating an entire autonomous,
   * multi-step task to an unattended sub-agent (Concept 3).
   *
   * Note that this branch is reached AFTER the checkPermissionRules() /
   * readOnly checks above it, but the very first line of this function
   * (bypassPermissions -> unconditional allow) still runs before ANY of
   * this -- including the declarative deny-rule layer. That ordering, not
   * this new branch, is what makes bypassPermissions the sharpest form of
   * this phase's security nuance (Concept 3).
   */
  export function checkPermission(
    toolName: string,
    input: Record<string, unknown>,
    readOnly: boolean,
    mode: PermissionMode = "default"
  ): PermissionDecision {
    if (mode === "bypassPermissions") return { action: "allow" };

    const ruleResult = checkPermissionRules(toolName, input);
    if (ruleResult === "deny") {
      return { action: "deny", message: `Denied by permission rule for ${toolName}` };
    }
    if (ruleResult === "allow") {
      return { action: "allow" };
    }

    if (readOnly) return { action: "allow" };

    if (toolName === "dispatch_agent") {
      const subType = typeof input.type === "string" ? input.type : "general";
      if (subType === "explore") {
        return { action: "allow" };
      }
      const label = `dispatch_agent(general): ${String(input.description ?? "")}`;
      if (mode === "plan") {
        return { action: "deny", message: "Blocked in plan mode: dispatch_agent" };
      }
      if (mode === "dontAsk") {
        return { action: "deny", message: `Auto-denied (dontAsk mode): ${label}` };
      }
      // default and acceptEdits both require confirmation for a general
      // dispatch -- acceptEdits's edit_file auto-approval does not extend
      // to delegating an open-ended, multi-step task.
      return { action: "confirm", message: label };
    }

    if (mode === "plan") {
      return { action: "deny", message: `Blocked in plan mode: ${toolName}` };
    }

    if (mode === "acceptEdits" && toolName === "edit_file") {
      return { action: "allow" };
    }

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

- [ ] Confirm every mode/type combination directly:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/permissions.js').then((m) => {
    const cases = [
      ['default','explore'], ['plan','explore'], ['bypassPermissions','explore'], ['dontAsk','explore'],
      ['default','general'], ['plan','general'], ['acceptEdits','general'], ['dontAsk','general'], ['bypassPermissions','general'],
    ];
    for (const [mode, type] of cases) {
      const d = m.checkPermission('dispatch_agent', { description: 'check tests', prompt: 'x', type }, false, mode);
      console.log(mode.padEnd(18), type.padEnd(8), JSON.stringify(d));
    }
  });
  "
  ```

  Real captured output from this exact code, in this tutorial's isolated verification directory:

  ```
  default            explore  {"action":"allow"}
  plan               explore  {"action":"allow"}
  bypassPermissions  explore  {"action":"allow"}
  dontAsk            explore  {"action":"allow"}
  default            general  {"action":"confirm","message":"dispatch_agent(general): check tests"}
  plan               general  {"action":"deny","message":"Blocked in plan mode: dispatch_agent"}
  acceptEdits        general  {"action":"confirm","message":"dispatch_agent(general): check tests"}
  dontAsk            general  {"action":"deny","message":"Auto-denied (dontAsk mode): dispatch_agent(general): check tests"}
  bypassPermissions  general  {"action":"allow"}
  ```

  This is the direct, concrete proof of Concept 3's design table: an `explore`-type dispatch is unconditionally allowed regardless of mode; a `general`-type dispatch's verdict depends entirely on mode, exactly matching the reasoning laid out above.

---

## Concept 4: Isolation, precisely — fork, return, and what never crosses back

Here is the mechanism, stated exactly, not just asserted: `dispatchSubAgent()` builds a **brand-new `messages` array** containing exactly one entry — `{ role: "user", content: input.prompt }` — and recursively calls `runAgentLoop` on it, with its own tool subset (Concept 2) and its own permission mode (Concept 3). That recursive call can iterate its own `while (true)` loop as many times as the sub-agent's own tool-calling behavior requires — one iteration, five iterations, however many — completely independently of the parent's loop. When it finally resolves (the sub-agent's own model produces a turn with no `tool_use` blocks, Phase 1's original stopping condition, unchanged since Phase 1), `dispatchSubAgent()` reads the **last assistant message's text** out of that private array and returns it as a plain string. That string — and only that string — becomes the content of the single `tool_result` block the *parent's* tool-processing loop pushes onto the *parent's* `messages` array.

**Nothing about the sub-agent's own turn-by-turn conversation — its intermediate tool calls, their results, how many turns it took — is ever merged into the parent's `messages`.** This is the precise, checkable meaning of "sub-agents don't bloat the parent's context": it's not that the sub-agent's work is somehow compressed or summarized before crossing back, it's that the vast majority of it — every `tool_use`/`tool_result` pair from the child's own internal loop — never crosses back *at all*. Only the one final string does, exactly like any other tool's single-string result (Phase 2, Concept 1: "one execute signature, not one per tool" — a sub-agent dispatch is just another tool call that happens to have a very expensive `execute()`).

**Output isolation is free, for a reason specific to this project's function-based design.** The reference project needs a small, explicit mechanism to stop a sub-agent's streamed text from printing directly to the terminal alongside the parent's: a three-state `outputBuffer` (`null` = print directly, `[]` = collecting, `[...]` = accumulated) that every text callback has to check (`claude-code-from-scratch/docs/11-multi-agent.md`, "输出捕获" section). This project doesn't need an equivalent, because Phase 5 already made `onText` a **per-call, optional** parameter on `RunAgentLoopOptions` rather than something a long-lived object always has configured. `dispatchSubAgent()` simply doesn't pass `onText` when it calls `runAgentLoop` for the child — and `streamOneTurn`'s existing `if (onText) stream.on("text", (textDelta) => onText(textDelta));` (Phase 5, Step 3, unchanged through every phase since) means the child's text deltas are never subscribed to at all. No buffer, no accumulation, no three-state check — the exact same isolation the reference project builds a dedicated mechanism for falls out for free from a design choice Phase 5 made for entirely different reasons.

**Waiting for the result: synchronous, exactly like every other tool call — with one real, limited exception already built by Phase 5.** `dispatchSubAgent()` is `await`-ed inside the parent's `for (const toolUse of toolUses)` loop, blocking that loop's progress until the entire child conversation finishes, however long that takes. There is no mechanism anywhere in this project that lets the parent "check back later" on a dispatch — `dispatch_agent` is `readOnly: false`, so Phase 5's early-execution trick (which only pre-starts `readOnly: true` tools the instant their `tool_use` block finishes streaming, Phase 5, Concept 4) never applies to it. The phase breakdown's own verification framing — delegating a subtask "while continuing other work" — is real, but it comes from a mechanism Phase 5 already built for an unrelated reason, not from `dispatch_agent` itself being non-blocking: if the model requests `dispatch_agent` **and** one or more `readOnly: true` tools in the *same* turn, Phase 5's mechanism starts those read-only calls the instant their own `tool_use` blocks finish streaming — running concurrently with the rest of that turn's content, including the `dispatch_agent` block still being parsed. By the time the parent's tool-processing loop actually reaches the dispatch, those early-started reads may already be done. This is a real, verifiable form of "continuing other work" — but it's Phase 5's parallel-read-only mechanism doing that work, not any asynchrony inside dispatch itself. If the model instead pairs `dispatch_agent` with another *write*-classified tool call in the same turn (say, `edit_file`), neither gets early-started, and they simply run one after another in the loop's existing order — exactly the same sequential behavior every tool call in this registry has had since Phase 1.

**Verified end to end, not just reasoned about.** This exact isolation and blocking behavior was tested against the real, compiled code using a fake client that mimics `MessageStream`'s `.on()`/`.finalMessage()` shape — the same technique every prior phase in this series has used for its own hard-to-observe timing/ordering claims. The scenario: a parent conversation whose model dispatches one `general`-type sub-agent; the sub-agent's own scripted response takes **two** of its own internal turns (a `list_files` call, then a final answer) before returning.

```
callLog: [ 'parent-stream#0', 'child-stream#0', 'child-stream#1', 'parent-stream#1' ]
parent messages array length (expect 4): 4
parent onText chunks (expect ONLY the parent's own final line, never the child's): [ 'The sub-agent reports: README summary done.' ]
child's internal text never reached parent onText: true
child request tool schemas omit dispatch_agent: true
child request tool schemas: [ 'read_file', 'edit_file', 'list_files', 'run_shell', 'save_memory', 'forget_memory' ]
final parent tool_result content (the child's RETURNED STRING, not its transcript): "Child's own internal final answer -- this text must never reach the parent's onText."
child ran 2 of its OWN internal turns, invisible to parent.messages: true
parent.messages never contains the child's internal tool_use 'list_files' call: true
```

Every claim above is directly confirmed by this run: the parent's `messages` array ends at exactly 4 entries (1 initial user message + 2 for the dispatch turn's `tool_use`/`tool_result` pair + 1 for the parent's own final answer) regardless of the child having taken 2 of its *own* internal turns; the parent's `onText` handler only ever received the parent's own text, never a fragment of the child's; the child's own request never listed `dispatch_agent` among its tools (Concept 2's recursion-prevention claim, confirmed at the wire level, not just by inspecting `getSubAgentConfig`'s return value in isolation); and the child's internal `tool_use` id (`"c1"`, for its `list_files` call) is nowhere in the parent's final `messages` array at all.

The confirmation gate from Concept 3 was verified the same way, across four scenarios in one run:

```
--- no confirmTool handler (non-interactive) -> fail closed ---
confirmTool invocation count: 0 []
final tool_result(s): [ 'Action denied: confirmation required but no interactive confirmation handler is available (non-interactive mode): dispatch_agent(general): check tests' ]

--- confirmTool answers yes -> dispatch proceeds ---
confirmTool invocation count: 1 [ 'dispatch_agent(general): check tests' ]
final tool_result(s): [ 'Tests pass.' ]

--- confirmTool answers no -> denied ---
confirmTool invocation count: 1 [ 'dispatch_agent(general): check tests' ]
final tool_result(s): [ 'User denied this action.' ]

--- same dispatch repeated -> confirmed only once ---
confirmTool invocation count: 1 [ 'dispatch_agent(general): check tests' ]
final tool_result(s): [ 'Tests pass.', 'Tests pass.' ]
```

The last scenario is the concrete proof that Phase 6, Concept 5's session-level `confirmedActions` whitelist extends to `dispatch_agent` for free: the *same* dispatch (identical `description`) requested twice in one conversation only triggers `confirmTool` once — because `resolvePermission()`'s whitelist logic (Implement 1) is the exact same code path every other confirm-tier tool call already goes through, keyed on the same `decision.message` string. The first scenario is the concrete proof that a denied or unconfirmable dispatch **never actually calls `dispatchSubAgent()` at all** — zero child API calls happen, confirmed by the `confirmTool invocation count: 0` alongside no corresponding child-stream call in that scenario's log (not shown above, but confirmed in the same run).

And Concept 3's Plan Mode propagation claim was verified directly as well:

```
plan mode + general dispatch: childStreamCalls=0, tool_result="Action denied: Blocked in plan mode: dispatch_agent"
plan mode + explore dispatch: childStreamCalls=1, tool_result="child done"
```

A `general`-type dispatch under a parent in `plan` mode is denied before the child ever makes a single API call (`childStreamCalls=0`); an `explore`-type dispatch under the identical parent mode still runs to completion — exactly the asymmetry Concept 3 designed.

---

## Implement 4: Wire `dispatchSubAgent` into `agent.ts`

- [ ] Replace `src/agent.ts` with this (complete file — this is the final state of `agent.ts` for this phase; every change from Phase 8's Step 5 is called out in the doc comments below):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { executeTool, findTool, resolvePermission, type ReadFileState, type PermissionState } from "./tools.js";
  import type { PermissionMode } from "./permissions.js";
  import {
    persistLargeResult,
    runCompressionPipeline,
    checkAndCompact,
    createCompactionState,
    type CompactionState,
  } from "./compact.js";
  import {
    startMemoryPrefetch,
    formatMemoriesForInjection,
    type MemoryRecallState,
    type MemoryPrefetch,
    type SideQueryFn,
  } from "./memory.js";
  import { getSubAgentConfig, type SubAgentType } from "./subagent.js";

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
    compaction?: CompactionState;
    memoryRecall?: MemoryRecallState;
  }

  interface TrackedToolBlock {
    id: string;
    name: string;
    caller: Anthropic.ToolUseBlock["caller"];
    inputJson: string;
  }

  function buildSideQuery(client: Anthropic, model: string): SideQueryFn {
    return async (system, userMessage, signal) => {
      const resp = await client.messages.create(
        { model, max_tokens: 256, system, messages: [{ role: "user", content: userMessage }] },
        { signal }
      );
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    };
  }

  function extractLastUserText(messages: AgentMessage[]): string {
    const last = messages[messages.length - 1];
    if (!last || typeof last.content !== "string") return "";
    return last.content;
  }

  /**
   * The plain-text content of the last ASSISTANT message. Used to turn a
   * finished sub-agent conversation into the single string dispatchSubAgent
   * returns (Concept 4) -- deliberately a small, private helper here
   * rather than importing cli.ts's own equivalent (which would create a
   * circular import: cli.ts already imports agent.ts). A few duplicated
   * lines is the cheaper cost, the same trade extractLastUserText already
   * made in Phase 8 rather than sharing a helper across files for a
   * one-purpose extraction.
   */
  function extractFinalText(messages: AgentMessage[]): string {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return "";
    return last.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  export interface DispatchAgentInput {
    description: string;
    prompt: string;
    type?: SubAgentType;
  }

  interface DispatchAgentDeps {
    client: Anthropic;
    model: string;
    maxTokens: number;
    signal?: AbortSignal;
    parentPermissionMode: PermissionMode;
  }

  /**
   * Fork-return sub-agent dispatch (Phase 9). Builds a brand-new, isolated
   * conversation -- a single user message, the child's own fresh
   * ReadFileState/PermissionState/CompactionState -- and recursively calls
   * runAgentLoop on it. The child's own turn-by-turn messages array is
   * NEVER merged into the parent's `messages`; only this function's
   * RETURNED STRING crosses back, as the parent's tool_result content for
   * this one dispatch_agent call. This -- not a vague notion of
   * "isolation" -- is the actual mechanism that keeps a sub-agent's
   * exploration from bloating the parent's context (Concept 4).
   */
  async function dispatchSubAgent(input: DispatchAgentInput, deps: DispatchAgentDeps): Promise<string> {
    const type: SubAgentType = input.type === "explore" ? "explore" : "general";
    const config = getSubAgentConfig(type);

    // Permission inheritance (Concept 3): bypassPermissions by default --
    // the human already approved THIS dispatch one level up (via the
    // confirm gate for general-type dispatches, Implement 3) -- UNLESS the
    // parent itself is in plan mode, in which case plan's blanket
    // read-only restriction must still propagate, or a sub-agent becomes
    // a loophole around it.
    const childPermissionMode: PermissionMode =
      deps.parentPermissionMode === "plan" ? "plan" : "bypassPermissions";

    const childMessages: AgentMessage[] = [{ role: "user", content: input.prompt }];

    try {
      await runAgentLoop(childMessages, {
        client: deps.client,
        model: deps.model,
        systemPrompt: config.systemPrompt,
        tools: config.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
        maxTokens: deps.maxTokens,
        signal: deps.signal,
        permissionMode: childPermissionMode,
        // No confirmTool: the child runs unattended, start to finish
        // (Concept 3). No memoryRecall: see Concept 5 -- Phase 8's own
        // "What's next" already flagged this exact decision. A fresh,
        // independent CompactionState -- not the parent's, not omitted --
        // see Concept 5.
        compaction: createCompactionState(),
      });
      const text = extractFinalText(childMessages);
      return text || "(Sub-agent produced no output)";
    } catch (e) {
      return `Sub-agent error: ${(e as Error).message}`;
    }
  }

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
    const { client, model, systemPrompt, tools, maxTokens, signal, onText, onToolBlockComplete } = options;

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
            // Degrade to an empty input rather than throwing inside a
            // stream event handler (Phase 2's "errors are data" instinct).
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
   * repeat. Unchanged from Phase 8: compaction (Tier 4 before the loop,
   * Tiers 1-3 inside it), memory prefetch/injection, and the
   * checkPermission-gated executeTool() at both call sites.
   *
   * New in this phase: one new branch inside the tool-processing loop.
   * When the model requests dispatch_agent, this loop does NOT call
   * executeTool() (dispatch_agent's own execute() is a placeholder that
   * would throw, Concept 1) -- it calls resolvePermission() directly
   * (the same gate every other tool call goes through, Implement 1), and if
   * that gate proceeds, calls dispatchSubAgent() -- a recursive call to
   * THIS SAME FUNCTION, one level deeper, with its own isolated messages
   * array (Concept 4). Every other tool's call site, and both of
   * executeTool()'s existing call sites (the early-execution one inside
   * onToolBlockComplete, and the normal one here), are untouched --
   * dispatch_agent is never early-started (its readOnly flag is false,
   * so Phase 5's early-execution check already skips it with no changes
   * needed).
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
      compaction,
      memoryRecall,
    } = options;

    const readFileState: ReadFileState = new Map();
    const permission: PermissionState = {
      mode: permissionMode,
      confirmedActions: new Set(),
      confirmTool,
    };

    if (compaction) {
      await checkAndCompact(messages, compaction, client, model);
    }

    let memoryPrefetch: MemoryPrefetch | null = null;
    if (memoryRecall) {
      const query = extractLastUserText(messages);
      const sideQuery = buildSideQuery(client, model);
      memoryPrefetch = startMemoryPrefetch(
        query,
        sideQuery,
        memoryRecall.alreadySurfaced,
        memoryRecall.sessionMemoryBytes,
        signal
      );
    }

    while (true) {
      if (compaction) {
        runCompressionPipeline(messages, compaction);
      }

      if (memoryPrefetch && memoryPrefetch.settled && !memoryPrefetch.consumed) {
        memoryPrefetch.consumed = true;
        const memories = await memoryPrefetch.promise;
        if (memories.length > 0) {
          const injectionText = formatMemoriesForInjection(memories);
          const last = messages[messages.length - 1];
          if (last && last.role === "user") {
            if (typeof last.content === "string") {
              last.content = last.content + "\n\n" + injectionText;
            } else if (Array.isArray(last.content)) {
              last.content.push({ type: "text", text: injectionText });
            }
          } else {
            messages.push({ role: "user", content: injectionText });
          }
          for (const m of memories) {
            memoryRecall!.alreadySurfaced.add(m.path);
            memoryRecall!.sessionMemoryBytes += Buffer.byteLength(m.content);
          }
        }
      }

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
          if (tool?.readOnly) {
            const input = block.input as Record<string, unknown>;
            earlyExecutions.set(block.id, executeTool(block.name, input, readFileState, permission));
          }
        },
      });

      if (compaction) {
        compaction.lastInputTokens = response.usage.input_tokens;
        compaction.lastApiCallTime = Date.now();
      }

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUses.length === 0) {
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const earlyPromise = earlyExecutions.get(toolUse.id);
        let raw: string;

        if (toolUse.name === "dispatch_agent") {
          // Special dispatch (Concept 1, Concept 4): dispatch_agent needs
          // client/model/the parent's own permission mode, which
          // tools.ts's stateless executeTool(name, input, state,
          // permission) has no way to receive. resolvePermission() is the
          // exact gate-then-confirm logic executeTool() already runs
          // internally (Implement 1), shared here rather than duplicated.
          const outcome = await resolvePermission(
            "dispatch_agent",
            toolUse.input as Record<string, unknown>,
            false,
            permission
          );
          raw = outcome.proceed
            ? await dispatchSubAgent(toolUse.input as DispatchAgentInput, {
                client,
                model,
                maxTokens,
                signal,
                parentPermissionMode: permission.mode,
              })
            : outcome.result;
        } else {
          raw =
            earlyPromise !== undefined
              ? await earlyPromise
              : await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, readFileState, permission);
        }

        const result = persistLargeResult(toolUse.name, raw);

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

- [ ] Type-check:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

  This exact file was type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` and Phase 8's actual `compact.ts`/`memory.ts` (trimmed to the pieces this phase's tests exercise, but API-identical to Phase 8's real versions), in an isolated scratch directory, as part of writing this tutorial. Every runtime claim in Concept 4 above — the exact `callLog` ordering, the parent's messages-array length, the `onText` isolation, the child's tool-schema list, the confirmation-gate scenarios, and the plan-mode propagation — was independently executed against this exact compiled file using a fake client mimicking `MessageStream`'s shape, not merely reasoned about. See this phase's Grounding notes for the full list of what was run.

---

## Concept 5: Composition with Phase 7's compaction and Phase 8's memory

Three independent questions, each answered plainly and grounded in what this project's own architecture actually makes sensible — not by assuming the reference project already solved them (it doesn't build this interaction at all; neither `claude-code-from-scratch/docs/07-context.md` nor `docs/08-memory.md` nor `docs/11-multi-agent.md` discusses compaction or memory inside a sub-agent's own loop).

**Does the sub-agent get its own `CompactionState`, share the parent's, or skip compaction entirely?** `dispatchSubAgent()` gives the child a **fresh, independent** `CompactionState` via `createCompactionState()` — not the parent's own state object, and not `undefined`. Sharing the parent's would be actively wrong: the parent's `lastInputTokens` describes the size of the *parent's* conversation, which has nothing to do with the child's brand-new, one-message-long `messages` array — reusing it could make `checkAndCompact` misfire a full LLM summarization on the child's very first turn, against a conversation that's barely begun. Omitting compaction entirely is tempting (most sub-agent tasks are short — a handful of tool calls to answer one delegated question), but not safe in general: nothing stops a `general`-type dispatch from being given an open-ended, multi-file task that runs long enough to approach its own context limit, and `createCompactionState()` costs nothing to call regardless (it takes no required arguments). Giving the child its own independent state is free, correct, and exactly analogous to how Phase 2's `ReadFileState` and Phase 6's `PermissionState` are already created fresh per call to `runAgentLoop` — the sub-agent's recursive call is just another call to that same function, and it gets the same "fresh state per invocation" treatment every other call already gets.

**Does the sub-agent get `memoryRecall` — read access to the same persisted memory store as the main agent?** No — `dispatchSubAgent()` simply never includes a `memoryRecall` key in the options object it passes to the child's `runAgentLoop` call, leaving it `undefined`. This isn't a new decision this phase has to reason out from scratch: Phase 8's own "What's next" section already answered it, grounded directly in the reference project's source, and this phase carries that answer forward exactly as written:

> *"The reference project's answer is a clean, explicit gate — `chatAnthropic`'s prefetch-start block is wrapped in `if (!this.isSubAgent) { ... }` (`claude-code-from-scratch/src/agent.ts`, line 985) — sub-agents never get a memory prefetch started for them at all. The reasoning generalizes past this specific codebase: a sub-agent is dispatched to do one narrow, delegated task and hand back a result; injecting the parent session's accumulated cross-session facts into a child agent's own isolated context is more likely to be noise or a distraction from its one job than a genuine help, and it's an extra API call (the side query) spent on a context that's about to be discarded once the sub-agent returns anyway."* — `phase-08-memory.md`, "What's next"

Worth being precise about what this decision does and doesn't cover: it's about the *recall* mechanism (the async side-query prefetch and its injection into `messages`) — not about whether the sub-agent's *tool set* includes `save_memory`/`forget_memory`. A `general`-type dispatch's tool list (Concept 2) does still include both memory-writing tools, unchanged, since they pass through the exact same permission gate every other write tool does (Phase 8, Concept 2 already proved this requires zero changes to `checkPermission()`) — a sub-agent delegated a task like "figure out and record our deployment process" can still call `save_memory` if its own judgment calls for it. What it can't do is have the parent's own accumulated memories silently injected into its private context, which is the specific thing Phase 8's design deliberately withholds.

**Does the sub-agent's `ReadFileState` need any special handling?** No — and this is worth noting because it's a case of a Phase 2 design decision already solving a Phase 9 problem for free, three phases before either existed together. Phase 2, Concept 4 established that `ReadFileState` is created fresh, as an empty `Map`, once per call to `runAgentLoop`, specifically so unrelated conversations never share mtime-guard state. A sub-agent dispatch is just another call to `runAgentLoop` — its own `const readFileState: ReadFileState = new Map();` line runs exactly the same way it would for a brand-new top-level session, giving the child a private read-state cache automatically, with no code in this phase needing to think about it at all.

---

## Verify

- [ ] **Type-check the whole project:**

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

  Expect zero errors.

- [ ] **Confirm `dispatch_agent` appears in the system prompt automatically.** With no code changes to `prompt.ts` (Phase 3's `buildToolsSection()` iterates `toolRegistry` directly), print the composed prompt and confirm all seven tools are listed:

  ```bash
  npx tsx -e "import('./src/prompt.js').then((m) => console.log(m.buildSystemPrompt()))"
  ```

  Expect `# Using your tools` (or your Phase 3 section's equivalent heading) to list `read_file`, `edit_file`, `list_files`, `run_shell`, `save_memory`, `forget_memory`, and `dispatch_agent` — the seventh entry with zero changes to `prompt.ts` itself.

- [ ] **Re-run every scratch check from Implement 1, 2, and 3** (the `resolvePermission`-preserves-behavior check, the `getSubAgentConfig` tool-scoping check, and the full mode/type `checkPermission` matrix) and confirm they reproduce the exact output quoted in this tutorial.

- [ ] **The phase's own stated verification method, live: delegate an independent subtask and incorporate its result.** With `ANTHROPIC_API_KEY` exported:

  ```
  $ npm start
  > Check if this project's tests pass, by dispatching a general sub-agent to run the test suite and report back, while you keep talking to me about something else.
  ```

  Confirm: a confirmation prompt appears for the `dispatch_agent` call (default mode), matching Concept 3's `confirm`-tier verdict for a `general`-type dispatch; after approving, the sub-agent's own tool calls (e.g. `run_shell` running your test command) do **not** print to the terminal the way the main agent's own tool calls do — only its final report appears, folded into the main agent's own response.

- [ ] **Confirm isolation directly, not just by trusting the fake-client proof.** Temporarily add a `console.error("messages.length:", messages.length)` right after the `runAgentLoop` call in `cli.ts`, right before `saveSession`. Have a conversation that dispatches a sub-agent whose own task requires several of its own tool calls (e.g., "explore the src directory and summarize what each file does" as an `explore`-type dispatch). Confirm the printed length only reflects the *parent's* own turns (initial message, plus 2 per parent tool-calling turn, plus 1 for the final answer) — never inflated by however many internal tool calls the sub-agent made.

- [ ] **Confirm recursion prevention live.** Dispatch a `general`-type sub-agent with a prompt that explicitly asks it to delegate part of its own work to another sub-agent (e.g., "Your task: refactor X. If this task is complex, dispatch a sub-agent to handle part of it."). Confirm the sub-agent cannot do this — it has no `dispatch_agent` tool in its own request (confirm by temporarily logging `req.tools.map(t => t.name)` inside a wrapped `client.messages.stream` call, or simply observe that the model does the work itself rather than delegating, since it structurally has no tool to delegate with).

- [ ] **Confirm Plan Mode propagation, using the `--plan` flag that already exists since Phase 6** (even though Phase 11's actual Plan Mode workflow doesn't exist yet):

  ```bash
  npm start -- --plan
  ```

  Ask it to dispatch a `general`-type sub-agent to make a code change. Confirm the request is denied immediately with a message referencing `"Blocked in plan mode: dispatch_agent"`, and that no confirmation prompt ever appears (the deny happens before reaching the confirm-tier logic). Then ask it to dispatch an `explore`-type sub-agent to investigate something read-only. Confirm this one *does* run to completion, unlike the general-type dispatch — the exact asymmetry Concept 3 designed and Concept 4 verified against a fake client.

- [ ] **Confirm the session-level whitelist extends to repeated dispatches.** In one conversation (`default` mode), ask the agent to dispatch two `general`-type sub-agents with the exact same `description` text in a row (contrived, but directly checkable). Confirm the second dispatch does not re-trigger a confirmation prompt — matching the `confirmedActions` whitelist behavior verified in Concept 4's fake-client scenario 4.

---

## What's next

This is the **last phase of the MVP milestone**. Per the phase breakdown: *"MVP complete: interview-ready demo covering agent loop, tool orchestration, streaming, permissions/safety, context engineering, memory, and multi-agent delegation."* At this point the agent can: hold a multi-turn conversation with real tool use (Phase 1–2); explain itself via a composed, project-aware system prompt (Phase 3); run interactively with session persistence (Phase 4); stream its output token-by-token with parallel read-only tool execution (Phase 5); refuse or confirm dangerous actions under 5 configurable trust modes (Phase 6); survive arbitrarily long conversations via tiered compaction (Phase 7); remember facts across sessions via a 4-type file-based memory store with semantic recall (Phase 8); and now delegate independent subtasks to isolated sub-agents and incorporate their results (Phase 9). That's the complete, demo-able system the phase breakdown scoped from the start.

Phase 10 and beyond (Skills, Plan Mode, MCP Integration, Testing, and the capstone real-source comparison) are the **deep-dive track** — explicitly "no rush, pursued after MVP" per the breakdown, not required to consider this build complete. Two of them connect directly back to design decisions made in this phase, worth remembering when you get there:

- **Phase 11 (Plan Mode)** will build the actual `EnterPlanMode`/`ExitPlanMode` tools and the plan-file workflow this phase's `plan`-mode propagation logic was already written to support (Concept 3). No changes to `subagent.ts`, this phase's `checkPermission()` branch, or `dispatchSubAgent()`'s permission-inheritance computation should be needed when that phase arrives — only new tools that *enter* and *exit* the `plan` mode this project has had since Phase 6.
- **Phase 10 (Skills)** and **Phase 12 (MCP)** both add to the tool registry the same way this phase did — a new `ToolDefinition` entry, picked up automatically by `getToolSchemas()`/`buildToolsSection()`. If either introduces its own tool whose execution needs something `tools.ts`'s stateless `execute(input, state)` signature can't provide (a live client, a network connection, whatever), this phase's `dispatch_agent` is a second worked example — alongside Phase 8's `buildSideQuery` — of the pattern: register a real schema in the registry for discoverability, but intercept the actual call in `agent.ts`, where the state that's actually needed already lives.

---

## Grounding notes

Every non-trivial claim above is grounded in one of these sources, or flagged where it isn't:

- **The reference project's own `dispatch_agent`/`agent`-tool design (special dispatch bypassing the generic executor, `permissionMode: this.permissionMode === "plan" ? "plan" : "bypassPermissions"`, the buffer-based output isolation, and the stated "needs access to current Agent instance state" rationale)** — read directly from `claude-code-from-scratch/docs/11-multi-agent.md` (quoted sections throughout) and `claude-code-from-scratch/src/subagent.ts` (199 lines, read in full).
- **`READ_ONLY_TOOLS`'s inconsistency between the reference project's own documentation (four tools, including `run_shell`) and its actual shipped `subagent.ts` source (three tools, excluding `run_shell`)** — confirmed by reading both directly: `claude-code-from-scratch/docs/11-multi-agent.md`, lines 99-101 versus `claude-code-from-scratch/src/subagent.ts`, line 30. This project's own choice (deriving the subset from `toolRegistry`'s `readOnly` flag, with zero hand-maintained exceptions) is this tutorial's own design decision, explicitly flagged as a deliberate departure rather than a claim about what the reference project does.
- **Real Claude Code's `ALL_AGENT_DISALLOWED_TOOLS`, the conditional `AGENT_TOOL_NAME` exclusion keyed on `process.env.USER_TYPE === 'ant'`, and its status as a global (layer-one) filter applied before any per-type filtering** — read directly from `claude-code/src/constants/tools.ts`, lines 36-46, cross-checked against `how-claude-code-works/docs/07-multi-agent.md`, §8.2's "工具过滤流水线" section (which independently confirms this is the first of four filtering layers, all four read directly in that chapter).
- **`GENERAL_PURPOSE_AGENT`'s `tools: ['*']` definition** — read directly from `claude-code/src/tools/AgentTool/built-in/generalPurposeAgent.ts`, lines 25-34.
- **Real Claude Code's actual worker permission-mode default (`selectedAgent.permissionMode ?? 'acceptEdits'`), and its independence from what agent type is being dispatched** — read directly from `claude-code/src/tools/AgentTool/AgentTool.tsx`, lines 573-577, cross-checked against `how-claude-code-works/docs/07-multi-agent.md`, §8.2 ("阶段 2：工具池组装"), which quotes and explains the identical line.
- **The three multi-agent modes (sub-agent/coordinator/swarm), the `AgentTool` parameter shape, the 5-stage dispatch pipeline, the 4-layer tool-filtering pipeline, and the `createSubagentContext()` isolation model (`readFileState` clone, `abortController` one-way propagation, `queryTracking` depth counter)** — read directly from `how-claude-code-works/docs/07-multi-agent.md` in full (all of §8.1–§8.7), used here only for "why" framing and real-source cross-checks; this phase does not build the coordinator or swarm modes, the async/background execution path, Git-worktree isolation, or Fork sub-agents (the cache-sharing variant) — all explicitly out of this phase's scope, matching the phase breakdown's own "Fork-return sub-agent pattern" framing (the simplest of the documented modes).
- **Phase 8's own "What's next" section, quoted verbatim, on why a sub-agent should not receive `memoryRecall`** — read directly from `phase-08-memory.md`, "What's next" section, in this repository.
- **The `ToolDefinition` contract, `executeTool`'s "errors are data, not exceptions" philosophy, and the mtime-guard `ReadFileState`'s per-call-fresh scoping** — Phase 2's own established design, re-cited here as the basis for Concept 1's "why `dispatch_agent` can't fit the existing signature" argument and Concept 5's "why the child's `ReadFileState` needs no special handling" argument.
- **Phase 6's 5 trust modes, `checkPermission()`'s exact structure (including the `bypassPermissions` short-circuit preceding even the declarative deny-rule layer), and the session-level `confirmedActions` whitelist** — Phase 6's own established design (Steps 2–6), re-cited here as the literal base this phase diffs `permissions.ts`/`tools.ts` against.
- **All TypeScript in Implement 1, 2, 3, and 4 (`tools.ts`, `subagent.ts`, `permissions.ts`, `agent.ts`)** — actually type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` and API-compatible reconstructions of Phase 7/8's `compact.ts`/`memory.ts`, in an isolated scratch directory (`/private/tmp/.../scratchpad/verify-phase9`), as part of writing this tutorial.
- **The `resolvePermission` pure-refactor claim (Implement 1), the `getSubAgentConfig` tool-scoping output (Implement 2), the full 9-case `checkPermission` mode/type matrix (Implement 3), the `bypassPermissions`-bypasses-declarative-deny-rules proof (Concept 3), the end-to-end isolation proof including the exact `callLog` ordering and the child's tool-schema list (Concept 4), the four-scenario confirmation-gate proof including the whitelist behavior (Concept 4), and the plan-mode propagation proof (Concept 4)** — every one of these was actually executed against the real, compiled code shown in this tutorial, using `npx tsx`, with real captured stdout quoted directly at each point above — not predicted or hypothetical transcripts. The end-to-end tests used a fake client mimicking `MessageStream`'s `.on()`/`.finalMessage()` shape, the identical technique Phases 4 through 8 each used for their own hard-to-observe timing/ordering/isolation claims.
- **Unverified / flagged explicitly:** no live Anthropic API call was made while writing this tutorial — no API key was available in this authoring environment, consistent with every prior phase's own flagged limitation. This means the Verify section's live-model steps (the exact wording the model uses when asked to dispatch a sub-agent, whether it chooses `explore` or `general` for a given task, and the precise tool-call sequence either the parent or the sub-agent's own model produces) are predicted from the verified mechanism, not observed directly. What *is* independently verified, not merely predicted, is every claim about mechanism: the tool registry's shape, the permission gate's exact verdicts across every mode/type combination, and — most importantly for this phase's central claims — the exact isolation, blocking, and recursion-prevention behavior of `dispatchSubAgent()` and its integration into `runAgentLoop`'s tool-processing loop, verified by actually running the real, compiled code against a scripted fake client, not by reasoning about it in the abstract.
- **This phase does not build:** the reference project's/real Claude Code's `.claude/agents/*.md` custom-agent-discovery mechanism (a real, cited, deliberately out-of-scope feature — this phase's two fixed types, `explore` and `general`, cover the phase breakdown's stated verification method without it); a `plan`-type sub-agent distinct from `explore` (the reference project's own `PLAN_AGENT` is tool-set-identical to its `EXPLORE_AGENT`, differing only in prompt wording — folding that distinction into a single `explore` type with one prompt is a deliberate, minor scope cut); the real source's Fork sub-agent variant (prompt-cache-sharing via byte-identical request prefixes — a real, cited optimization this project's per-dispatch fresh `messages` array does not attempt); and the real source's async/background dispatch mode (`run_in_background`, `<task-notification>` delivery) — this phase's dispatch is exclusively synchronous, matching the phase breakdown's own framing of "continuing other work" as Phase 5's parallel-read-only mechanism, not true background execution (Concept 4).
