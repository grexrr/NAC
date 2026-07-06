# Phase 2: Tool System

> Series: Mini-Claude-Code Learning Plan — see [`../phase-breakdown.md`](../phase-breakdown.md) for full context.
> **Prerequisite:** [`phase-01-agent-loop.md`](phase-01-agent-loop.md). This phase builds directly on top of the `src/agent.ts` and `src/index.ts` that Phase 1 left behind — read it first if you haven't. Phase 3 (System Prompt) will build directly on top of what this phase produces.

## Goal

Phase 1 ended with a working agent loop that could dispatch exactly one hardcoded tool (`get_current_time`), wired up through a temporary `executeTool()` function that lived inside `agent.ts` itself. Phase 1's own text called this out explicitly: that function exists only to prove the loop works, and Phase 2 replaces it with something real.

By the end of this phase you will have a dedicated `src/tools.ts` module containing a real **tool registry** — a shared interface every tool implements, a lookup-by-name mechanism, and three genuine, working tools the agent can call against your actual filesystem: `read_file`, `edit_file`, and `list_files`. `agent.ts`'s loop shape does not change at all — only what it calls to dispatch a tool use changes, from a hardcoded `if` chain to `tools.ts`'s registry.

You'll also implement the single most important safety mechanism in this phase: the **mtime guard**, which stops the agent from blindly overwriting a file that changed on disk after the agent last read it. This is the interview-ready answer to "how do you stop an LLM from clobbering files it doesn't actually have current information about."

## Why this is interview material

"Tool use" or "function calling" is the single most common way an interviewer will probe whether you understand agent architecture beyond the chat-completions basics. The Messages API's `tools` parameter and `tool_use`/`tool_result` blocks (Phase 1, Concept 1) are the wire protocol; this phase is about the **engineering** on your side of that protocol: how you decide what tools exist, how the model's requested `name` gets turned into an actual function call, and — critically — what invariants your code enforces that the model itself cannot be trusted to enforce through prompting alone (the read-before-edit and mtime checks below are exactly this: not "please read first" text in a description field, but a code-level `if` that refuses to run otherwise).

The three concrete tools you'll build here (`read_file`, `edit_file`, `list_files`) are also, not coincidentally, the three tools that make *any* coding agent minimally useful: it can see what's in a project, see what's in a specific file, and change a file's contents. Every other tool — search, shell execution, sub-agents, MCP — is an elaboration on top of this same registry/dispatch shape, not a different architecture.

---

## Files

This phase creates one new file and modifies two files Phase 1 left behind:

- `src/tools.ts` **(new)** — the tool registry: shared `ToolDefinition` interface, the `ReadFileState` mtime-tracking map type, three real tool implementations (`read_file`, `edit_file`, `list_files`), the mtime guard logic, `getToolSchemas()` (for the API's `tools` parameter), and `executeTool()` (the dispatcher `agent.ts` calls).
- `src/agent.ts` **(modified)** — same `runAgentLoop()` signature and loop shape as Phase 1; the only change is that the hardcoded `executeTool()` function is deleted and replaced with an import from `tools.ts`, and a `ReadFileState` map is created once per loop call and threaded through.
- `src/index.ts` **(modified)** — Phase 1's single hardcoded `TIME_TOOL` definition is replaced with `getToolSchemas()` from the new registry. Still throwaway scaffolding — Phase 4 replaces this file entirely with a real REPL.

With those three files in view, here's the concept-by-concept build: each concept below is followed immediately by the implementation that realizes it, in the order you'd actually build them.

---

## Concept 1: A tool is a contract, not just a function

The naive way to add a tool to an LLM agent is: write a JSON schema, write a function, and manually wire an `if (name === "...")` branch connecting them. That's exactly what Phase 1's `executeTool` did, and it's fine for one tool. It breaks down as soon as you have more than a handful, because the schema and the function are two independent things a developer has to remember to keep in sync by hand — nothing stops them from drifting apart.

The fix is to make "a tool" a single object that bundles everything the tool needs, so there's exactly one place to look and exactly one thing to add when you want a new tool. The real Claude Code source formalizes this as a generic `Tool<Input, Output, P>` type (`claude-code/src/Tool.ts`) with a much larger surface than we need — it also carries UI rendering methods, hook lifecycles, and permission-checking methods, because production Claude Code has 66+ tools, a permissions UI, and React-based rendering to keep in sync. Quoting the shape directly (abridged real-source excerpt, `claude-code/src/Tool.ts`):

```typescript
// abridged real-source excerpt — claude-code/src/Tool.ts
type Tool<Input, Output, P extends ToolProgressData> = {
  name: string
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  inputSchema: Input                 // Zod schema — runtime validation + type inference
  isConcurrencySafe(input): boolean  // takes input: same tool, different args, different safety
  isReadOnly(input): boolean
  checkPermissions(input, context): Promise<PermissionResult>
  renderToolUseMessage(input, options): React.ReactNode
  // ...UI rendering, aliases, maxResultSizeChars, etc.
}
```

Our registry keeps the same core idea — one object per tool, bundling its metadata with its behavior — but strips it down to exactly what a single-file, no-UI, no-permissions-yet mini-agent needs:

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool["input_schema"];
  readOnly: boolean;
  execute(input: Record<string, unknown>, state: ReadFileState): string | Promise<string>;
}
```

Four things to notice, all directly justified by the real source above:

- **`name`, `description`, `input_schema`** map onto exactly the three fields the Anthropic API's `tools` parameter expects (Phase 1, Concept 1) — nothing more, nothing less. `getToolSchemas()` (Implement 2 below) strips everything else off before handing the array to `client.messages.create()`.
- **`execute` lives on the same object as the schema.** There's no second file, no second array, no separate `switch` statement to remember to update — add one object to `toolRegistry` and the tool exists, fully wired, from schema to dispatch.
- **`readOnly` is metadata your loop doesn't consume yet.** In the real source this is `isReadOnly(input): boolean` — a *method*, not a static flag, because the real Claude Code's BashTool needs different answers for `ls` (read-only) versus `rm` (not) depending on the actual command string, not just the tool name. We don't have a tool whose read/write status depends on its arguments in this phase, so a plain `boolean` is enough — but the field exists on every entry now specifically so Phase 5 (parallel execution of read-only tools) and Phase 6 (permission gating on writes) can consume it later without a registry redesign. See Concept 6 below for what those two phases will actually do with it.
- **One `execute` signature, not one per tool.** Every tool receives `(input, state)` uniformly, even `list_files`, which ignores `state`. This uniformity is what makes the dispatcher (Concept 2) a single, generic function instead of a per-tool special case.

**Why a plain array instead of a class hierarchy?** Real Claude Code's 66+ tools genuinely benefit from a shared base class / factory pattern (`buildTool()`, discussed in Concept 6) because they need independent test suites, per-tool directories, and polymorphic dispatch across a large team's codebase. Three tools in one file don't have that problem — a flat array plus a `.find()` is the whole "registry," and reaching for more structure than that here would be solving a problem you don't have yet. This mirrors the explicit simplification the `claude-code-from-scratch` reference project makes for the same reason (`claude-code-from-scratch/docs/02-tools.md`, "我们的简化决策" table: "66+ 工具类，每个独立目录" → "1 个文件 + 6 个函数 ... 教程不需要工业级模块化").

---

## Concept 2: Dispatch — from a `tool_use.name` string to a running function

Phase 1's loop, after collecting `tool_use` blocks from the model's response, called a hardcoded `executeTool(name, input)`. That function is being deleted from `agent.ts` in this phase and replaced by an import from `tools.ts` — but the *shape* of the call site inside the loop does not change: it's still "give me a name and an input object, get back a string." That stability is deliberate; it's exactly what Phase 1's closing note promised ("this swap is a clean import change, not a rewrite of the loop itself").

Dispatch in this phase is a lookup, not a chain of `if`s:

```typescript
export function findTool(name: string): ToolDefinition | undefined {
  return toolRegistry.find((t) => t.name === name);
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

Two design points worth being able to explain out loud:

**A missing or failing tool returns a string, it does not throw.** This is a real, explicitly named design philosophy in production Claude Code, not a convenience for this tutorial: *"错误是数据，不是异常"* — "errors are data, not exceptions" (`how-claude-code-works/docs/04-tool-system.md`, §4.4, "错误处理与传播"). Concretely: if the model hallucinates a tool name that doesn't exist, or `edit_file` hits a file it can't find, the *model* needs to see that failure as a `tool_result` and get a chance to self-correct — retry with a different tool, fix a typo in a path, re-read a file — in the very next turn. If your dispatcher threw a real exception instead, it would either crash the whole loop or require you to catch it somewhere else anyway just to turn it back into a string for the model to see. Returning the error as the tool's own result *is* the correction mechanism. Phase 1's `executeTool` already did a version of this (`return \`Unknown tool: ${name}\``); this phase generalizes it and additionally wraps `tool.execute()` in a `try/catch` so a thrown exception inside any one tool's implementation (a permissions error from `fs`, for instance) degrades to an error string instead of taking down the entire agent process.

**Lookup is by exact name, nothing fuzzier.** Real Claude Code's Stage 1 ("工具查找") also matches on `aliases` for backward compatibility when a tool gets renamed (`how-claude-code-works/docs/04-tool-system.md`, §4.4) — we don't have that problem yet since nothing in this tutorial series has ever renamed a tool, so `toolRegistry.find()` by exact name is the whole lookup.

The code above lives in `tools.ts`; the other half of this concept — the call site inside `agent.ts`'s loop staying a clean, one-line swap — is what Implement 2 (further below) shows concretely.

---

## Concept 3: Defining a schema and keeping it honest against `execute`

Every tool's `input_schema` is a plain JSON Schema object — the exact same shape Phase 1, Concept 1 showed going over the wire in the `tools` parameter of the request body. There is no framework translating anything for you in this phase (real Claude Code uses Zod schemas and derives the JSON Schema from them automatically via `inputJSONSchema`/`zodToJsonSchema` — see `claude-code/src/Tool.ts`'s `inputSchema: Input` / `inputJSONSchema?: ToolInputJSONSchema` pair, and `how-claude-code-works/docs/04-tool-system.md` §4.4's mention of Zod `safeParse` doing "类型强制" (type coercion) as validation Phase 1 of a two-phase validation pipeline). We're deliberately not pulling in a schema-validation library for three tools — the risk of schema/implementation drift is what you should be alert to, not something a library is mandatory to solve at this scale.

Concretely, here's `edit_file`'s schema next to its `execute` function's actual parameter type — the thing that would drift if you weren't careful:

```typescript
// The schema — this is what the MODEL sees:
input_schema: {
  type: "object",
  properties: {
    file_path: { type: "string", description: "The path to the file to edit" },
    old_string: { type: "string", description: "The exact string to find and replace" },
    new_string: { type: "string", description: "The string to replace it with" },
  },
  required: ["file_path", "old_string", "new_string"],
}

// The execute function — this is what your CODE actually reads:
execute: (input, state) =>
  editFile(
    input as { file_path: string; old_string: string; new_string: string },
    state
  ),
```

The `as { file_path: string; ... }` cast is doing real work here, and it's worth being honest about its limits in an interview: TypeScript's type system enforces that *your code* treats `input` as having those three string fields, but it does **not** enforce that the JSON Schema you wrote above actually requires and types them that way — those are two independent, hand-maintained sources of truth, and only your own discipline (or, at larger scale, a Zod-schema-as-single-source-of-truth approach like real Claude Code's) keeps them in sync. If the model sends something that violates the schema, the API layer only validates structurally-obvious things; anything your `execute` function assumes but the schema doesn't actually declare `required` will surface as a runtime `undefined` inside your function, not a caught type error. This is exactly why every `execute` function in this phase's `tools.ts` still defensively checks things like `existsSync` before trusting a path is real, rather than assuming the schema's promises were kept.

**The description field is part of the contract too, not just documentation.** The model only knows what a tool does and how to use it correctly from its `description` string — there is no other channel. `edit_file`'s description explicitly says *"You must call read_file on this file earlier in the conversation before calling edit_file"* — that's not a courtesy note for a human reader, it's the model's only source of truth about a hard constraint your code enforces (Concept 4 next). Real Claude Code goes further and lets each tool inject its own dedicated usage guidance into the system prompt via a `prompt()` method, specifically so tool-specific rules like "match old_string exactly" live next to the tool that needs them instead of scattered through one giant global prompt file (`claude-code-from-scratch/docs/02-tools.md`: *"FileEditTool 注入'精确匹配'规则...工具行为指引和工具定义紧密关联，而非散落在全局 prompt 文件里"*). We fold that guidance into the `description` field directly in this phase rather than adding a second `prompt()` hook — Phase 3 (System Prompt) is where a real prompt-composition mechanism gets built, and it's the natural place to decide whether tool-specific guidance deserves its own injection point.

---

## Concept 4: The mtime guard — optimistic locking for a file the agent already read

Here is the race condition this defends against, made concrete with wall-clock time, because that's the part that's easy to hand-wave past: an agent loop is not instantaneous. Between the moment `read_file` returns a file's contents to the model and the moment the model later decides to call `edit_file` on that same file, multiple full round trips to the Anthropic API can happen — each one plausibly seconds of model "thinking" time plus network latency, and the model might interleave several *other* tool calls (reading other files, running a search) in between. That's a real window of wall-clock time, easily many seconds, sometimes longer, during which **nothing about your agent process controls the file** — a human can open it in their editor and save a change, a linter or formatter can rewrite it, a build step can regenerate it. If `edit_file` blindly does read-modify-write against whatever is on disk *at write time*, using a string replacement the model computed from content it saw *at read time*, one of two bad things happens: the edit silently lands on top of — and destroys — whatever changed in between, or (more insidiously) the replacement still "works" positionally but now corrupts a file whose surrounding content has shifted underneath the model's mental model of it.

**The analogy that makes this click:** this is optimistic locking / compare-and-swap, applied to a file instead of a database row. A CAS write says "update this row to value X, but only if it's still at the value Y I last read — otherwise abort and tell me." The mtime guard says exactly the same thing about a file: "write this new content, but only if the file's modification time still matches what it was when I read it — otherwise abort and tell the model to re-read." You're deliberately *not* holding a lock for the entire read-think-write window (which would mean locking a file for the several seconds or more that model inference takes — impractical and not how any real filesystem tool works); instead you let the model proceed optimistically and only check for a conflict at the last possible moment, right before the write actually lands.

Concretely, this is a two-sided mechanism living in a `ReadFileState` map (`Map<string, number>`, absolute path → `mtimeMs` at last read):

1. **`read_file` records a timestamp.** Every successful read stores `statSync(absPath).mtimeMs` in the map, keyed by the file's absolute path.
2. **`edit_file` checks two things before writing, in order:**
   - **Read-before-edit:** has this exact path ever been read in this conversation at all? If the map has no entry for it, refuse immediately — *"you must read_file(...) before editing it."* This is a hard code-level gate, not a prompt suggestion, precisely because a model cannot be reliably trusted to always follow a "please read first" instruction that lives only in a description string — Phase 1's whole thesis (the model decides everything, the code never second-guesses it) does not extend to *this* invariant, because getting it wrong means silently corrupting the user's files. Real Claude Code enforces the identical rule at the same layer: its `FileEditTool.ts` validation returns `behavior: 'ask', message: 'File has not been read yet. Read it first before writing to it.'` when `toolUseContext.readFileState.get(fullFilePath)` comes back empty (`claude-code/src/tools/FileEditTool/FileEditTool.ts`, around line 275-287) — a code-level check inside the tool's own validation step, not prompt text.
   - **Freshness:** if it *was* read, compare the file's current `mtimeMs` against what was recorded at read time. If they differ, someone touched the file in between — refuse and tell the model to re-read. Real Claude Code's equivalent check, in the same file, a few lines later: *"if (lastWriteTime > readTimestamp.timestamp) { ... return { result: false, behavior: 'ask', message: 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.' } }"* (`claude-code/src/tools/FileEditTool/FileEditTool.ts`, lines 289-310, abridged). The real implementation additionally falls back to a full content comparison when only the timestamp changed, to tolerate platforms (it calls out Windows specifically) where mtime can shift without the bytes actually changing — we skip that refinement in this phase's simplified version and treat any mtime mismatch as a hard stop, which is the safe direction to err in (a false-positive "please re-read" is annoying; a false-negative silent overwrite is not).
3. **`edit_file` updates the timestamp after a successful write.** This is easy to miss and important: without this, a *second* `edit_file` call later in the same conversation would see the mtime that its own *previous* write just produced, mistake it for an external modification, and reject a perfectly legitimate follow-up edit. Real Claude Code does the same thing (`FileStateCache` gets re-populated after every successful write, not just every read) for exactly this reason.

**Where does the map itself live?** In this phase's `agent.ts`, a fresh `ReadFileState` (empty `Map`) is created once per call to `runAgentLoop()`, before the `while (true)` loop starts, and threaded through every `executeTool()` call for the duration of that conversation. It deliberately does *not* live as a module-level global in `tools.ts` — a global would silently leak read-state across unrelated conversations (imagine two different users' sessions, or two test runs in the same process, sharing one map and each falsely believing the other's reads count as their own). Real Claude Code's equivalent, `readFileState: FileStateCache`, is a field on `ToolUseContext` — the per-query context object threaded through the whole tool-execution pipeline — for the identical reason (`claude-code/src/Tool.ts`, `ToolUseContext` type; concretely populated as `readFileState` at the tool-call site, e.g. `claude-code/src/tools/FileEditTool/FileEditTool.ts` line 390's destructured `{ readFileState, ... }`).

Concepts 1 through 4 above are all realized in one file — here it is, in full.

---

## Implement 1: Build the tool registry

- [ ] Create `src/tools.ts` with this content (complete file):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
  import { resolve } from "node:path";

  /**
   * Tracks, for each absolute file path the agent has read in this
   * conversation, the mtimeMs recorded at read time. edit_file consults
   * this before writing so a write can never silently clobber a file that
   * changed on disk after the agent last saw its contents (Concept 4 — the
   * mtime guard). This map is created fresh per runAgentLoop() call in
   * agent.ts and threaded through every executeTool() call — tools.ts
   * itself never instantiates or resets it, so unrelated conversations
   * never share read state.
   */
  export type ReadFileState = Map<string, number>;

  /**
   * The full contract every tool in this registry implements. name,
   * description, and input_schema map directly onto the Anthropic tools
   * API parameter (Phase 1, Concept 1) — getToolSchemas() below strips
   * everything else off before the array is handed to
   * client.messages.create().
   *
   * readOnly is metadata, not enforced by anything in this phase's loop.
   * It's set on every entry now so two later phases can consume it
   * without another registry redesign: Phase 5 (parallel tool execution)
   * will run every readOnly: true tool in a batch concurrently and
   * serialize the rest; Phase 6 (permissions) will skip the
   * write-confirmation prompt for readOnly: true tools and require it for
   * everything else. Neither behavior exists yet in this phase — see
   * Concept 6.
   */
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
      // Record the mtime at the moment we handed this content to the
      // model. edit_file compares against this before allowing a write.
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

    // Read-before-edit guard (Concept 4): refuse to touch a file the
    // agent never read in this conversation. This is a hard code-level
    // check, not a prompt-level suggestion — a model can't reliably be
    // trusted to always follow "please read first" instructions that
    // live only in a description string.
    if (!state.has(absPath)) {
      return `Error: you must read_file("${input.file_path}") before editing it.`;
    }

    // mtime guard (Concept 4): has the file changed on disk since we
    // last read it? Same idea as optimistic locking / compare-and-swap —
    // instead of holding a lock for the whole read-think-write window
    // (which could span several seconds of model "thinking" plus network
    // round trips), we let the write proceed optimistically and only
    // check for a conflict right before committing it.
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

    // Update the recorded mtime to the file's new state. Without this, a
    // second edit_file call later in this same conversation would see
    // the mtime our own write just produced, mistake it for an external
    // modification, and reject a perfectly legitimate follow-up edit.
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

  // ─── The registry ───────────────────────────────────────────────────────
  // One object per tool: schema + behavior in the same place (Concept 1).
  // Adding a new tool means adding one entry here — nothing else to update.

  export const toolRegistry: ToolDefinition[] = [
    {
      name: "read_file",
      description:
        "Read the contents of a file. Returns the file content with line numbers.",
      input_schema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The path to the file to read",
          },
        },
        required: ["file_path"],
      },
      readOnly: true,
      execute: (input, state) =>
        readFile(input as { file_path: string }, state),
    },
    {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact string match with new content. The old_string must match exactly, including whitespace and indentation, and must be unique within the file. You must call read_file on this file earlier in the conversation before calling edit_file.",
      input_schema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The path to the file to edit",
          },
          old_string: {
            type: "string",
            description: "The exact string to find and replace",
          },
          new_string: {
            type: "string",
            description: "The string to replace it with",
          },
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
            description:
              "The directory to list. Defaults to the current working directory.",
          },
        },
        required: [],
      },
      readOnly: true,
      execute: (input) => listFiles(input as { path?: string }),
    },
  ];

  // ─── Lookup + dispatch (Concept 2) ─────────────────────────────────────

  export function findTool(name: string): ToolDefinition | undefined {
    return toolRegistry.find((t) => t.name === name);
  }

  /**
   * The array to hand to the Anthropic API's `tools` parameter. Strips
   * the registry-only fields (readOnly, execute) down to exactly the
   * three fields the wire format expects (Phase 1, Concept 1).
   *
   * This is also the seam Phase 3 (System Prompt) will use to describe
   * the available tools by name and behavior — iterate toolRegistry
   * directly (not this stripped version) to get each tool's name,
   * description, and readOnly flag.
   */
  export function getToolSchemas(): Anthropic.Tool[] {
    return toolRegistry.map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    }));
  }

  /**
   * Look up a tool by name and run it. Returns a plain string result in
   * every case — including when the name doesn't match anything —
   * because a failed or unknown tool call is data for the model to react
   * to, not an exception for this code to propagate (Concept 2: "errors
   * are data, not exceptions").
   */
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

This is a self-contained module — it has no dependency on `agent.ts` at all, only on `@anthropic-ai/sdk` (for the `Anthropic.Tool` type) and Node's built-in `fs`/`path`. That independence is what makes it possible to unit-test in Implement 3 without touching the API.

---

## Implement 2: Replace `agent.ts`'s hardcoded dispatch with the registry

This step completes the other half of Concept 2's promise: `tools.ts` now owns dispatch, and the call site inside `agent.ts`'s loop stays a clean, one-line swap rather than a rewrite.

Recall Phase 1's `agent.ts` had a module-private `executeTool(name, input)` function containing a single `if (name === "get_current_time")` branch, called from inside the loop. That function is deleted entirely in this step — everything it did now lives in `tools.ts`.

- [ ] Replace `src/agent.ts` with this (complete file, replacing Phase 1's version):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { executeTool, type ReadFileState } from "./tools.js";

  export type AgentMessage = Anthropic.MessageParam;

  export interface RunAgentLoopOptions {
    client: Anthropic;
    model: string;
    systemPrompt?: string;
    tools?: Anthropic.Tool[];
    maxTokens?: number;
  }

  /**
   * The agent loop. Unchanged in shape from Phase 1: call the model, check
   * whether it asked for any tools, execute them if so, append the
   * assistant message and the tool-result message, and repeat. Stops the
   * moment a response comes back with zero tool_use blocks.
   *
   * The only change from Phase 1 is what happens inside the tool-execution
   * branch: instead of a hardcoded, single-tool executeTool() living in
   * this file, tool dispatch is delegated to tools.ts's registry-backed
   * executeTool(). The loop itself doesn't know or care how many tools
   * exist, what they're named, or what they do — exactly as before.
   *
   * Mutates and returns the same messages array that was passed in, so
   * the caller retains the full conversation history afterward.
   */
  export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions
  ): Promise<AgentMessage[]> {
    const { client, model, systemPrompt, tools, maxTokens = 1024 } = options;

    // Per-conversation mtime guard state (Concept 4). Lives here, scoped
    // to one call of runAgentLoop, rather than as a module-level global
    // in tools.ts — so unrelated conversations never share read state.
    const readFileState: ReadFileState = new Map();

    while (true) {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools,
        messages,
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
        const input = toolUse.input as Record<string, unknown>;
        const result = await executeTool(toolUse.name, input, readFileState);
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

Notice what did **not** change: `RunAgentLoopOptions`, the `while (true)` shape, the `messages.push` calls, the `toolUses.length === 0` stopping condition, and the two-entries-per-turn growth from Phase 1's Concept 3. The only different line inside the loop body is the call to `executeTool(toolUse.name, input, readFileState)` — same call site, new import, one extra argument (the mtime-guard state) threaded through.

---

## Implement 3: Verify the registry works, independent of the API

Because `tools.ts` has no dependency on the Anthropic client, you can exercise every tool and the mtime guard directly, without spending an API call or needing `ANTHROPIC_API_KEY` set. This step writes a small throwaway script — not part of the shipped project, just a way to see the guard actually trigger before you ever let a model drive it.

- [ ] Create a scratch directory and sample file to test against:

  ```bash
  cd /Users/grexrr/Documents/NAC
  mkdir -p tooltest
  printf 'line one\nline two\nline three\n' > tooltest/sample.txt
  ```

- [ ] Create a throwaway `src/smoketest.ts` (not part of the shipped agent — delete it once you've confirmed the output, or just leave it out of version control):

  ```typescript
  import { executeTool, getToolSchemas, type ReadFileState } from "./tools.js";
  import { writeFileSync, utimesSync } from "node:fs";

  async function main() {
    console.log("--- schemas ---");
    console.log(getToolSchemas().map((t) => t.name));

    console.log("--- list_files ---");
    const state1: ReadFileState = new Map();
    console.log(await executeTool("list_files", { path: "tooltest" }, state1));

    console.log("--- read_file ---");
    console.log(await executeTool("read_file", { file_path: "tooltest/sample.txt" }, state1));

    console.log("--- edit_file WITHOUT prior read (should error, read-before-edit guard) ---");
    const state2: ReadFileState = new Map();
    console.log(await executeTool("edit_file", { file_path: "tooltest/sample.txt", old_string: "line one", new_string: "LINE ONE" }, state2));

    console.log("--- edit_file AFTER read (should succeed) ---");
    console.log(await executeTool("edit_file", { file_path: "tooltest/sample.txt", old_string: "line one", new_string: "LINE ONE" }, state1));

    console.log("--- read back after edit (confirm content changed) ---");
    console.log(await executeTool("read_file", { file_path: "tooltest/sample.txt" }, state1));

    console.log("--- non-unique old_string (should error) ---");
    writeFileSync("tooltest/dup.txt", "foo\nfoo\n");
    const state3: ReadFileState = new Map();
    await executeTool("read_file", { file_path: "tooltest/dup.txt" }, state3);
    console.log(await executeTool("edit_file", { file_path: "tooltest/dup.txt", old_string: "foo", new_string: "bar" }, state3));

    console.log("--- mtime guard: external modification after read (should error) ---");
    await executeTool("read_file", { file_path: "tooltest/sample.txt" }, state1);
    const future = new Date(Date.now() + 5000);
    writeFileSync("tooltest/sample.txt", "LINE ONE\nline two\nexternally changed\n");
    utimesSync("tooltest/sample.txt", future, future);
    console.log(await executeTool("edit_file", { file_path: "tooltest/sample.txt", old_string: "LINE ONE", new_string: "changed again" }, state1));

    console.log("--- unknown tool (should return error string, not throw) ---");
    console.log(await executeTool("nonexistent_tool", {}, state1));
  }

  main();
  ```

- [ ] Run it: `npx tsx src/smoketest.ts`

  Expected output (verified in this tutorial's authoring environment against exactly this code, in an isolated scratch directory with a real `@anthropic-ai/sdk` install — no live API call was made or needed for this step):

  ```
  --- schemas ---
  [ 'read_file', 'edit_file', 'list_files' ]
  --- list_files ---
  f  sample.txt
  --- read_file ---
     1 | line one
     2 | line two
     3 | line three
     4 |
  --- edit_file WITHOUT prior read (should error, read-before-edit guard) ---
  Error: you must read_file("tooltest/sample.txt") before editing it.
  --- edit_file AFTER read (should succeed) ---
  Successfully edited tooltest/sample.txt
  --- read back after edit (confirm content changed) ---
     1 | LINE ONE
     2 | line two
     3 | line three
     4 |
  --- non-unique old_string (should error) ---
  Error: old_string found 2 times in tooltest/dup.txt. Must be unique — add more surrounding context to old_string.
  --- mtime guard: external modification after read (should error) ---
  Error: tooltest/sample.txt was modified on disk since you last read it. Call read_file again before editing.
  --- unknown tool (should return error string, not throw) ---
  Unknown tool: nonexistent_tool
  ```

  The line that matters most here is the mtime-guard line: `read_file` was called on `state1` for `tooltest/sample.txt` earlier in the script (during the successful edit), so by the time this last block runs, `state1` already has a recorded mtime for that path — then the script simulates an external modification (a different process writing to the file and bumping its mtime forward), and the subsequent `edit_file` call against the *same* `state1` correctly refuses instead of overwriting on top of the external change.

- [ ] Clean up the scratch file and directory once you've confirmed the output:

  ```bash
  rm /Users/grexrr/Documents/NAC/src/smoketest.ts
  rm -rf /Users/grexrr/Documents/NAC/tooltest
  ```

---

With the registry, dispatch, schema hygiene, and mtime guard all built and verified above, two more concepts round out this phase's design discussion. Both describe things this phase deliberately does **not** build — there's no implementation step attached to either, since the whole point of each is "here's why we're not writing this code yet."

## Concept 5: Deferred/lazy tool loading (why this phase doesn't need it, and what would trigger it)

**This phase does not implement deferred loading.** It's covered here because it's a real, load-bearing design decision in production Claude Code that you should be able to explain in an interview even though a 3-tool registry has no reason to use it yet.

The problem it solves: every tool's full JSON schema (name, description, and the entire `input_schema` object) gets sent to the API on **every single request** in the `tools` parameter — that's not optional, it's how the Messages API's tool-use protocol works (Phase 1, Concept 1). With 3 tools, that's a negligible number of tokens. With 66+ built-in tools plus however many an MCP server contributes, the cumulative schema text becomes a real, recurring token cost paid on every turn of every conversation, whether or not the model ever calls most of those tools.

Real Claude Code's actual trigger for turning this on is concrete and worth citing precisely rather than guessing: it's driven by a measured percentage of the context window, not a fixed tool count. `claude-code/src/utils/toolSearch.ts` defines `DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10` — when `ENABLE_TOOL_SEARCH` is set to `auto` (or `auto:N`), tool search auto-enables once tool schema token overhead (measured by `countToolDefinitionTokens`) crosses that percentage of the model's context window, and the doc comment at the top of that file is explicit about the mechanism: *"When enabled, deferred tools (MCP and shouldDefer tools) are sent with `defer_loading: true` and discovered via ToolSearchTool rather than being loaded upfront."* Individual built-in tools opt into this with a `shouldDefer?: boolean` field on the `Tool` type (`claude-code/src/Tool.ts` line 442) — grepping the actual tool implementations shows this flag set on tools like `EnterPlanModeTool`, `ExitPlanModeV2Tool`, and `TodoWriteTool`: tools that are real and useful, but not part of the small, high-frequency core (`read_file`/`edit_file`/`bash`-equivalents) that's worth paying token cost for on every single turn regardless of whether this specific conversation ever needs them.

The mechanism itself, at a level worth being able to describe even without implementing it: a tool marked deferred sends only its *name* upfront (or is omitted from the initial `tools` array entirely, depending on mode), not its full schema. A separate `tool_search`-style tool is always present and lets the model search for and "activate" a deferred tool by keyword; once activated, that tool's full schema is included in subsequent requests for the rest of the conversation. This is the same underlying idea as lazy module loading or a lazy-initialized singleton in ordinary software engineering — defer the cost of something until you have concrete evidence it's actually needed — applied to token budget instead of memory or CPU.

**Why we don't build this now:** three tools' worth of schema text is not a measurable cost, and adding a `tool_search` mechanism (a fourth tool, an activation-state `Set`, filtering logic in `getToolSchemas()`) to solve a problem this registry doesn't have would be exactly the kind of premature generality Concept 1 already argued against for the class-hierarchy question. The `readOnly` field from Concept 1 is a `boolean` sitting on every `ToolDefinition` specifically because two *concrete, already-planned* future phases will read it; deferred loading has no such near-term consumer in this series, so it stays a documented-but-unbuilt concept until (if ever) the registry actually grows large enough to need it.

## Concept 6: Read-only vs. write — two forward references, not built yet

Every `ToolDefinition` in this phase's registry carries a `readOnly: boolean` — you already saw it set on every entry in Implement 1's `toolRegistry` array above (`true` for `read_file`/`list_files`, `false` for `edit_file`). Nothing in this phase's `agent.ts` loop or `tools.ts` dispatcher actually branches on that field yet — it's set now, deliberately, so two later phases in this series can consume it without a registry redesign:

- **Phase 5 (parallel tool execution)** will use `readOnly` to decide which of a batch of simultaneous `tool_use` blocks can safely run concurrently. The real-source rule this mirrors is simple and stated plainly in `how-claude-code-works/docs/04-tool-system.md` §4.5: read-only tools (`FileReadTool`, `GrepTool`, `GlobTool`) can run in parallel because they only observe state and can't interfere with each other; anything that writes must run one-at-a-time, serialized, because two concurrent writes (or a write racing a read) can produce results that depend on unpredictable execution order. This phase's loop only ever sees one `tool_use` fully processed before moving to the next (a plain `for` loop, no `Promise.all`), so there's no concurrency to gate yet — but when Phase 5 introduces it, `readOnly` is exactly the flag it will branch on.
- **Phase 6 (permissions)** will use the identical flag for the opposite reason: to decide which tool calls need to pause and ask a human before running at all. `read_file` and `list_files` can't damage anything a re-read can't recover from; `edit_file` can. The reference project's simplified permission model draws this exact line (`claude-code-from-scratch/src/tools.ts`, `READ_TOOLS` vs. `EDIT_TOOLS` sets — read tools are always allowed in every permission mode, edit tools are the ones gated), and real Claude Code's `buildTool()` factory defaults every tool to `isReadOnly: () => false` specifically so that *forgetting* to mark a new tool read-only fails safe — closed, requiring a permission check — rather than accidentally shipping a write-capable tool that nobody remembered needed a guard (`how-claude-code-works/docs/04-tool-system.md` §4.1, the `TOOL_DEFAULTS` / fail-closed discussion).

Both of these are genuinely **not implemented in this phase** — there is no concurrency and no permission-prompt UI anywhere in `tools.ts` or `agent.ts` yet. The only thing this phase does is make sure the data those future phases need (a per-tool read/write classification) already exists on every registry entry, so adding either subsystem later is additive rather than a breaking change to every tool definition already written.

---

Last, the plumbing that actually lets `index.ts` use everything built above — a pure wiring step with no new concept of its own.

## Implement 4: Wire the registry into `index.ts`

Phase 1's `src/index.ts` hardcoded a single `TIME_TOOL: Anthropic.Tool` definition and passed `tools: [TIME_TOOL]` into `runAgentLoop`. That tool doesn't exist in this phase's registry (it was only ever Phase 1's throwaway proof that the loop worked) — replace it with `getToolSchemas()`.

- [ ] Replace `src/index.ts` with this (complete file):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { runAgentLoop, type AgentMessage } from "./agent.js";
  import { getToolSchemas } from "./tools.js";

  function extractFinalText(messages: AgentMessage[]): string {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) {
      return "";
    }
    return last.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  async function main() {
    const userMessage =
      process.argv.slice(2).join(" ") ||
      "List the files in the current directory.";
    const client = new Anthropic();

    const messages: AgentMessage[] = [{ role: "user", content: userMessage }];

    const finalMessages = await runAgentLoop(messages, {
      client,
      model: "claude-opus-4-8",
      systemPrompt: "You are a terse coding assistant.",
      tools: getToolSchemas(),
    });

    console.log(extractFinalText(finalMessages));
  }

  main();
  ```

- [ ] Run it with a prompt that should trigger a real, agent-driven file operation:

  ```bash
  npm start -- "List the files in the current directory, then read package.json and tell me the project name."
  ```

## Verify

- [ ] With `ANTHROPIC_API_KEY` exported, run the command above. Expect: the model calls `list_files`, then `read_file` on `package.json`, then answers with the project's `name` field from the actual file — confirming the registry, schemas, and dispatcher are wired correctly end to end through the real API, not just the Implement 3 smoke test.
- [ ] Try a prompt that exercises `edit_file` end to end, e.g. `npm start -- "Add a comment '// hello' to the top of src/index.ts, but only after reading the file first."` — confirm it either succeeds (and the file actually changes on disk — check with `git diff`) or, if the model tries to skip the read, that it receives the read-before-edit error and self-corrects by reading first (you can observe this by uncommenting a full `messages` dump the way Phase 1's Verify section describes).
- [ ] Manually reproduce the mtime guard against the live loop once, to see it in the real system rather than only the Implement 3 script: start a prompt that reads a file, and — while the model is "thinking" between tool calls, if you're fast enough, or by re-running with a deliberately slow model — edit that same file yourself in another terminal before the agent's `edit_file` call lands. Confirm the agent receives the "modified on disk" error rather than silently overwriting your change. (This is timing-dependent and not scripted here — the Implement 3 smoke test is the reliable, deterministic way to confirm this behavior; this is the "see it for real" sanity check.)
- [ ] Confirm `git diff` (or your own reading of the file) shows no unintended changes to files you didn't ask the agent to modify — the read-before-edit and mtime guards should mean every successful `edit_file` call was preceded by a `read_file` on the same path with no external modification in between.

---

## What's next

Phase 3 (System Prompt) builds directly on the `toolRegistry` this phase created. It replaces `agent.ts`'s hardcoded `systemPrompt` string (currently `"You are a terse coding assistant."` in `index.ts`) with a composed prompt built from a template plus environment/project context — and, specifically, iterates `toolRegistry` (not `getToolSchemas()`'s stripped-down version) to describe each available tool's name, description, and `readOnly` status to the model as part of that composed prompt. `runAgentLoop` already accepts `systemPrompt` as a plain string option (unchanged since Phase 1), so Phase 3 only has to change what *produces* that string, not the loop that consumes it — the same "clean seam" property Phase 1 called out for tools, now true for the system prompt too.

Phase 5 (parallel tool execution) and Phase 6 (permissions) are the two phases that will actually consume the `readOnly` field this phase set on every `ToolDefinition` but never branches on (Concept 6) — nothing about `tools.ts`'s shape needs to change when they arrive, only new logic gets added around it.

---

## Grounding notes

Every non-trivial claim above is grounded in one of these sources, or flagged where it isn't:

- **The full `Tool<Input, Output, P>` interface, `buildTool()` / `TOOL_DEFAULTS` fail-closed defaults, and the per-tool directory convention** — read directly from real `claude-code/src/Tool.ts` (abridged excerpt quoted in Concept 1) and `how-claude-code-works/docs/04-tool-system.md` §4.1 (which quotes the same interface and the `TOOL_DEFAULTS` object directly from the source).
- **"错误是数据，不是异常" (errors are data, not exceptions) as an explicit, named design philosophy**, and the 8-stage tool execution lifecycle it's drawn from — `how-claude-code-works/docs/04-tool-system.md` §4.4, read directly.
- **The mtime guard's exact two-check structure (read-before-edit, then freshness-since-read) and its real error message text** — read directly from real `claude-code/src/tools/FileEditTool/FileEditTool.ts`, lines 275-311 (quoted in Concept 4: the `readTimestamp` existence check with message *"File has not been read yet. Read it first before writing to it."*, and the `lastWriteTime > readTimestamp.timestamp` comparison with message *"File has been modified since read..."*). The Windows-specific full-content-comparison fallback mentioned as a real-source refinement we're skipping is from the same file, same excerpt (the `isFullRead && fileContent === readTimestamp.content` branch).
- **`readFileState` living on a per-query `ToolUseContext` rather than a module global** — `claude-code/src/Tool.ts`'s `ToolUseContext` type definition (`readFileState: FileStateCache` field, read directly), and its concrete use in `claude-code/src/tools/FileEditTool/FileEditTool.ts` line 390's destructured `{ readFileState, ... }`.
- **`FileReadTool.isReadOnly()` and `isConcurrencySafe()` both returning `true` unconditionally** — read directly from real `claude-code/src/tools/FileReadTool/FileReadTool.ts` (the `isReadOnly() { return true }` / `isConcurrencySafe() { return true }` methods, around line 373-379).
- **Deferred tool loading's actual trigger (10% of context window, `ENABLE_TOOL_SEARCH=auto:N`) and mechanism (`defer_loading: true`, `ToolSearchTool` discovery)** — read directly from real `claude-code/src/utils/toolSearch.ts` (`DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10`, the file's own doc comment quoted in Concept 5, and `parseAutoPercentage`/`isAutoToolSearchMode`).
- **`shouldDefer?: boolean` on the `Tool` type, and its concrete use on `EnterPlanModeTool`, `ExitPlanModeV2Tool`, and `TodoWriteTool`** — confirmed by direct grep of real `claude-code/src/Tool.ts` (line 442) and the three real tool files (`EnterPlanModeTool.ts` line 55, `ExitPlanModeV2Tool.ts` line 166, `TodoWriteTool.ts` line 51).
- **Read-only tools running in parallel while write tools serialize, and the concurrency-safety rule generally** — `how-claude-code-works/docs/04-tool-system.md` §4.5, read directly (including the `canExecuteTool()` excerpt and the `MAX_TOOL_USE_CONCURRENCY = 10` figure, cited here only as forward-reference context for Phase 5, not implemented in this phase).
- **`READ_TOOLS` / `EDIT_TOOLS` permission-mode distinction in the simplified reference implementation** — read directly from `claude-code-from-scratch/src/tools.ts` (`const READ_TOOLS = new Set([...])`, `const EDIT_TOOLS = new Set([...])`, and `checkPermission()`'s `if (READ_TOOLS.has(toolName)) return { action: "allow" }` branch), cited here only as forward-reference context for Phase 6, not implemented in this phase.
- **"66+ 工具类，每个独立目录" → "1 个文件 + 6 个函数" simplification table**, and the general "保留设计哲学，砍掉工程复杂度" (keep the design philosophy, cut the engineering complexity) framing — direct quote/table from `claude-code-from-scratch/docs/02-tools.md`, "我们的简化决策" section.
- **The quote-normalization and diff-generation logic present in the reference implementation's `edit_file`** — read directly from `claude-code-from-scratch/src/tools.ts` and `docs/02-tools.md`, but **deliberately not carried into this phase's `edit_file`**: it's a real, useful refinement (curly-quote tokenization mismatches are a genuine failure mode), but it's an orthogonal enhancement to the uniqueness/mtime logic this phase is teaching, not a concept this phase's learning goals call for. Flagged here so it isn't mistaken for an oversight — it's a deliberate scope cut, unlike the mtime guard and read-before-edit check, which are implemented in full.
- **All TypeScript in Implement 1, 2, and 4 (`tools.ts`, `agent.ts`, `index.ts`)** — actually type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk` in an isolated scratch directory (`/private/tmp/.../scratchpad/verify-tools-v2`) as part of writing this tutorial.
- **Implement 3's smoke test and its exact printed output** — actually executed (`npx tsx src/smoketest.ts`) against the exact code shown in Implement 1 and 3, in the same isolated scratch directory, including the mtime guard genuinely triggering against a real `utimesSync`-simulated external modification. This is not a predicted/hypothetical transcript — it's the real stdout from a real run, confirmed line-for-line before being pasted into this document.
- **Unverified / flagged explicitly:** Implement 4's live-API verification steps (the `npm start -- "..."` commands, and the exact tool-call sequence the model chooses) were not run against a live Anthropic API call while writing this tutorial — no API key was available in this authoring environment, consistent with Phase 1's tutorial's own flagged limitation. Only the code's shape and the Implement 3 smoke test's behavior are verified as actually executed; the live model's specific tool-call choices in Implement 4 will vary by run and were not observed directly.
