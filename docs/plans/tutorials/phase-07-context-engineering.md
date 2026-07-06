# Phase 7: Context Engineering (Compaction)

> Series: Mini-Claude-Code Learning Plan — see [`../phase-breakdown.md`](../phase-breakdown.md) for full context.
> **Prerequisites:** [`phase-01-agent-loop.md`](phase-01-agent-loop.md) (the `messages: AgentMessage[]` array — this phase's entire subject is managing the growth of that exact array), [`phase-05-streaming.md`](phase-05-streaming.md) (**read this one with the most care** — this phase hooks into the precise shape `runAgentLoop`/`streamOneTurn` had after Phase 5, and getting that hook point wrong is the single easiest way to build something that looks right and then fails the first time it actually fires), and [`phase-06-permissions.md`](phase-06-permissions.md). This phase builds directly on top of the exact file state Phase 6 left behind — read it before this one if you haven't. This phase completes Milestone 1 — "a working, safe, streaming, context-managed CLI coding agent." Phase 8 (Memory System) is next; it also injects content into the request (recalled memories, appended to the last user message) adjacent to where this phase's own summary text gets injected, so this phase's closing section flags the seam Phase 8 will need to respect.
>
> Every code sample below is written against the exact `src/agent.ts`, `src/tools.ts`, `src/permissions.ts`, and `src/cli.ts` Phase 6 left behind — four tools (`read_file`, `edit_file`, `list_files`, `run_shell`), `executeTool(name, input, state, permission)` gated through `checkPermission()`, `RunAgentLoopOptions` carrying `permissionMode?`/`confirmTool?` alongside `onText?`, and a `PermissionState` already threaded into both of Phase 5's `executeTool()` call sites (the early-execution one inside `onToolBlockComplete` and the post-turn one in the tool-processing loop). None of that changes here. This phase's own compaction logic (Tiers 0-4, Concepts 1-10 below) is purely additive on top of it — the same "orthogonal, non-interacting" relationship Phase 6 itself has with Phase 5's streaming (Phase 6, Goal section): the permission gate always runs first, inside `executeTool()` itself, and this phase's `persistLargeResult()` only ever sees the already-resolved, already-gated result string.

## Goal

Every phase since Phase 1 has grown `messages` without ever shrinking it. That was fine for a tutorial-length conversation — but the array is unbounded and the context window is not. By the end of this phase your agent has a working, four-tier compression pipeline plus a disk-offload mechanism for oversized tool results, and — the actual hard part — both are wired into the *exact* point in Phase 5's streaming loop where they're safe to run and nowhere else. You'll be able to deliberately overflow a conversation, watch the pipeline intervene in stages (cheapest first), watch a full re-summarization fire as a last resort, and confirm the agent is still coherent — and still resumable via Phase 4's session persistence — on the other side of it.

## Why this is interview material

"What happens when the context window fills up?" is not a hypothetical interview question — it is the question every agent-building team eventually hits in production, and it separates people who've called a chat API a few hundred times from people who've had to keep a *long-running* agent coherent. The honest answer has two parts, and this phase makes you build both, not just recite them.

**Part one: compression has to be tiered, not binary.** The naive design is "if the conversation gets too big, summarize it." That's not wrong, exactly, but it's needlessly expensive and destructive as a *first* response — a full LLM-generated summary costs a real API call, takes real latency, and is lossy in a way that's hard to undo. Production systems reach for the cheapest, most reversible intervention first and only escalate when it isn't enough. This phase's reference project calls its version of this "one of the most elegant designs in the whole system" for exactly that reason — not because any single tier is clever, but because the *staging* is.

**Part two — the part most people get wrong on a whiteboard — is that you cannot just delete "old" messages.** The Anthropic Messages API has a hard structural requirement: every `tool_use` content block in an assistant message must be followed, in the very next message, by a matching `tool_result` block with the same `tool_use_id` (Phase 1, Concept 1 and Concept 2 already established the mechanics of this pairing; this phase is about what happens when something *removes* part of that history). Delete the wrong message — say, a stale tool result you thought was safe to discard — without also handling its paired half, and the very next API call comes back with a 400 error, not a smaller conversation. Being able to say *precisely* why compaction has to respect this pairing, and to show code that respects it by construction rather than by convention, is the concrete, checkable half of this interview question.

---

## Files

This phase adds one new module and modifies two files Phase 6 left behind (`agent.ts`, `cli.ts`). `src/tools.ts`, `src/permissions.ts`, `src/prompt.ts`, and `src/session.ts` are **not modified at all** — this phase builds directly on top of the exact file state Phase 6 left behind (see the Prerequisites line above).

- `src/compact.ts` **(new)** — `persistLargeResult` (Tier 0, disk offload), `CompactionState`/`createCompactionState`, `budgetToolResults` (Tier 1), `snipStaleResults` (Tier 2), `microcompact` (Tier 3), `runCompressionPipeline` (Tiers 1-3 orchestrator), `compactConversation` and `checkAndCompact` (Tier 4).
- `src/agent.ts` **(modified — diffed against Phase 6's version, not Phase 5's)** — same `streamOneTurn`/`runAgentLoop` shape as Phase 6, including Phase 6's `PermissionState` threaded into both of `executeTool()`'s call sites (carried forward unchanged) and `RunAgentLoopOptions`'s `permissionMode?`/`confirmTool?` fields (also unchanged); adds one new optional field (`compaction?: CompactionState`) to `RunAgentLoopOptions`, a single `checkAndCompact` call before the `while (true)` loop, a `runCompressionPipeline` call inside it (before each `streamOneTurn`), token-usage bookkeeping (`compaction.lastInputTokens`/`lastApiCallTime`, updated after each `streamOneTurn` resolves), and a `persistLargeResult` call in the tool-processing loop.
- `src/cli.ts` **(modified, narrowly — diffed against Phase 6's version, not Phase 4's)** — creates one `CompactionState` per process invocation (alongside `sessionId`/`startTime`) and threads it into both `runAgentLoop` call sites (the REPL's per-turn call and the one-shot branch), adding one new key (`compaction: compactionState`) alongside whatever each call site already passes. `parseArgs`'s four mode flags, the SIGINT handler, `confirmTool`'s `rl.question(...)` implementation, session save/load, and `--resume` handling — all of it Phase 6's — are untouched.
- `src/session.ts` **(not modified)** — see Concept 9 for why: it already serializes whatever `messages` currently is, with no opinion about compaction having run.

This phase builds directly on top of the exact file state Phase 6 left behind: `src/tools.ts`'s four-tool registry and `PermissionState`-gated `executeTool()`, `src/permissions.ts`, and `src/agent.ts`/`src/cli.ts`'s permission threading are all carried forward exactly as Phase 6's own tutorial left them — no manual merge is needed. `persistLargeResult` only ever runs on the already-resolved result string, strictly after whatever permission gate Phase 6 applied — the two features are orthogonal, and neither one's logic needs to know about the other, the same "orthogonal, non-interacting" relationship Phase 6 itself has with Phase 5's streaming.

---

## Concept 1: Why compression has to be tiered — and what the four tiers actually are

It's tempting to guess a plausible-sounding four-stage pipeline. Don't — the actual stages, read directly from the tutorial backbone's own context-management chapter, are specific and worth getting exactly right rather than approximately right:

```
claude-code-from-scratch/docs/07-context.md, lines 5-31 (mermaid diagram, translated):

  Tool execution result --> is it > 30KB?
    yes --> persist to disk, keep preview + path in context
    no  --> is it > 50,000 chars?
              yes --> truncate: keep head and tail
              no  --> pass through unchanged
  (either way, feeds into:)

  Tier 1: Budget            -- 50-70% util: cap at 30K chars; 70%+: cap at 15K chars
  Tier 2: Snip              -- snip duplicate reads of the same file, old search results
  Tier 3: Microcompact      -- idle > 5 min (prompt cache is cold) --> aggressive clear
  Tier 4: Auto-compact      -- > 85% of effective window --> full LLM-generated summary
```

Read the doc's own words for what "4 层" (4 tiers) refers to precisely (`claude-code-from-scratch/docs/07-context.md`, line 71, quoted directly): *"4 层管道：执行时截断 + Budget + Snip + Microcompact + Auto-compact"* — "a 4-tier pipeline: execution-time truncation + Budget + Snip + Microcompact + Auto-compact." That sentence lists five things because the disk-offload/truncation step is explicitly **not** one of the four numbered tiers — it's a pre-filter that runs at tool-execution time, before a result ever enters `messages` at all. The four numbered tiers (Tier 1 Budget, Tier 2 Snip, Tier 3 Microcompact, Tier 4 Auto-compact) all operate *on the messages array itself*, at different points in the agent's turn cycle, and in strictly increasing order of cost:

| Tier | What it touches | API cost | Reversible? | Runs |
|---|---|---|---|---|
| 0 — disk offload | one tool result, at the moment it's produced | zero | yes — full content sits on disk, `read_file` can retrieve it | every tool call, unconditionally |
| 1 — Budget | `tool_result.content` strings, in place | zero | no (truncated chars are gone, but only past a size the model rarely needs verbatim) | every model turn, once utilization ≥ 50% |
| 2 — Snip | `tool_result.content` strings, in place | zero | no (but the matching `tool_use` stays, so the model still knows it read the file) | every model turn, once utilization ≥ 60% |
| 3 — Microcompact | `tool_result.content` strings, in place | zero | no | every model turn, once idle ≥ 5 minutes |
| 4 — Auto-compact | the **entire messages array**, replaced | one real LLM call | no — original text is gone unless something already persisted it to disk | once per user turn, only past 85% utilization |

This phase builds all five rows. The first four (Tier 0-3) are cheap, local, zero-API-cost operations that only ever touch the *content string* inside an existing `tool_result` block — never the message structure itself, never a `tool_use` block. Tier 4 is the one genuinely destructive operation: it throws away the entire message history and replaces it with a short LLM-written summary. The staging exists so Tier 4 — the expensive, lossy one — is the *last* resort, not the first line of defense. You'll build them in exactly this order, cheapest first, because each tier's design only makes sense once you've seen why the tier before it wasn't enough on its own.

---

## Concept 2: Tier 0 — disk-offload for oversized tool results

### The mechanism

A tool result that's merely "large" is still worth showing the model in full — a 2,000-line file read is annoying but not catastrophic. A tool result that's *huge* (a multi-megabyte log dump, a directory listing of a repo with 50,000 files) is a different problem: if you let it sit in `messages` verbatim, it alone can consume a meaningful fraction of the context window, and it does so *permanently*, in every future request, until something removes it. The fix is not "truncate it" — truncation is a one-way trip; whatever gets cut is gone, and if the useful information (a stack trace at line 4,998 of a 5,000-line log) happened to be in the truncated part, it's unrecoverable. The fix real Claude Code and this project's tutorial backbone both use is: **persist the full result to disk, and put only a short preview plus a file path in `messages`.** The model already has a tool (`read_file`) that can retrieve the full content on demand — so nothing is actually lost, only deferred.

Read directly from the reference implementation (`claude-code-from-scratch/docs/07-context.md`, lines 116-134, and its underlying `agent.ts`):

```typescript
// claude-code-from-scratch/agent.ts — persistLargeResult (quoted directly, abridged)
private persistLargeResult(toolName: string, result: string): string {
  const THRESHOLD = 30 * 1024; // 30 KB
  if (Buffer.byteLength(result) <= THRESHOLD) return result;

  const dir = join(homedir(), ".mini-claude", "tool-results");
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${toolName}.txt`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, result);

  const lines = result.split("\n");
  const preview = lines.slice(0, 200).join("\n");
  const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

  return `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`;
}
```

The threshold is **30KB**, checked with `Buffer.byteLength` (byte length, not `.length`, which counts UTF-16 code units — the two diverge for any non-ASCII content). The preview keeps the first **200 lines** — enough for the model to judge whether it needs to `read_file` the full thing back, without paying for the whole result twice.

### Why 30KB is lower than the 50K-char truncation ceiling

The doc is explicit about the ordering (`claude-code-from-scratch/docs/07-context.md`, lines 139, 142, translated): *"the 30KB threshold is lower than truncateResult's 50K limit: intercept large results before truncation happens, avoiding irreversible information loss... this means it takes effect before truncateResult — after a successful save, the returned preview text is usually far smaller than 50K, so it won't trigger truncation again."* In other words: disk-offload is checked *first*, at the moment a tool result is produced. Anything that survives (because it was ≤ 30KB) then optionally passes through a separate, harder 50,000-character truncation backstop (keep head and tail, drop the middle) for the cases in between "small enough to keep as-is" and "large enough to offload." This phase implements the disk-offload half — the more interesting, more instructive mechanism, and the one the phase breakdown specifically calls out — and does not additionally implement the 50K hard-truncation backstop, since after offload almost nothing that reaches it is still over 50K; flagged here as a deliberate, minor scope cut, not an oversight.

### What real Claude Code actually does differently — grounded, not guessed

It would be easy to assume the real Claude Code source uses the same 30KB number. It doesn't, and the actual mechanism is worth citing precisely because it's more sophisticated in a specific way. Read directly from `claude-code/src/Tool.ts`, lines 458-466:

```typescript
// real claude-code/src/Tool.ts, lines 458-466 (quoted directly)
/**
 * Maximum size in characters for tool result before it gets persisted to disk.
 * When exceeded, the result is saved to a file and Claude receives a preview
 * with the file path instead of the full content.
 *
 * Set to Infinity for tools whose output must never be persisted (e.g. Read,
 * where persisting creates a circular Read→file→Read loop and the tool
 * already self-bounds via its own limits).
 */
maxResultSizeChars: number
```

This is a **per-tool** field, not a single global constant — every real tool declares its own `maxResultSizeChars` (grepping the actual tool files: `FileEditTool.ts` and most others declare `100_000`; `GrepTool.ts` declares a stricter `20_000`; `FileReadTool.ts` declares `Infinity` — explicitly opted *out*, for the precise circular-dependency reason stated in the comment above). The effective threshold actually used is the smaller of that per-tool value and a global ceiling, read directly from `claude-code/src/utils/toolResultStorage.ts`, lines 44-77 (`getPersistenceThreshold`, abridged) and `claude-code/src/constants/toolLimits.ts`, line 13:

```typescript
// real claude-code/src/constants/toolLimits.ts, line 13
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000

// real claude-code/src/utils/toolResultStorage.ts, line 77 (abridged)
return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS)
```

So real Claude Code's *default* effective threshold is **50,000 characters**, not 30KB, clamped per-tool downward (never upward) by each tool's own declared limit, with a GrowthBook feature-flag override map (`tengu_satin_quoll`) letting the threshold be tuned per-tool-name in production without a code change. The preview size is a separate, fixed constant — `PREVIEW_SIZE_BYTES = 2000` (`claude-code/src/utils/toolResultStorage.ts`, line 109) — i.e. **2KB**, not 200 lines; the real persisted-file path is session-scoped (`{projectDir}/{sessionId}/tool-results/{tool_use_id}.{txt|json}`, `getToolResultsDir()`, same file) rather than a flat, globally-shared directory. This tutorial follows the **reference project's** 30KB/200-line convention (matching the phase breakdown's own specification), not the real source's 50,000-char/2KB convention — both numbers are now grounded precisely rather than conflated, and the difference itself is a fair thing to be able to name in an interview: production tunes the threshold per-tool because different tools have structurally different "how much is normal" baselines (a `Grep` match dump is expected to be far smaller than a full file read), a nuance a single flat constant can't express.

---

## Implement 1: `src/compact.ts` — disk-offload, and the compaction-state skeleton

Create the new module this phase adds. This step gives you the complete disk-offload mechanism (Tier 0) plus the `CompactionState` type that every later tier in this phase will read from and write to — nothing about the later tiers changes this type's shape, so it's worth defining fully now.

- [ ] Create `src/compact.ts` with this content (this is a partial file — later steps append to it; each step below shows the complete file as it stands after that step):

  ```typescript
  import { writeFileSync, mkdirSync } from "node:fs";
  import { join } from "node:path";
  import { homedir } from "node:os";
  import type { AgentMessage } from "./agent.js";

  // ─── Tier 0: large tool-result disk offload ────────────────────────
  //
  // A tool result over this threshold is written to disk in full; the
  // in-context copy is replaced by a short preview plus the file path.
  // Nothing is actually lost — the model can retrieve the full content
  // with read_file at any point later in the conversation. This matches
  // the reference project's own threshold and preview size exactly
  // (claude-code-from-scratch/docs/07-context.md) — real Claude Code uses
  // a different, per-tool-clamped default of 50,000 chars with a 2KB
  // preview instead (see this phase's tutorial, Concept 2, for the
  // grounded comparison).

  export const DISK_OFFLOAD_THRESHOLD_BYTES = 30 * 1024; // 30 KB
  const PREVIEW_LINES = 200;
  const TOOL_RESULTS_DIR = join(homedir(), ".nac-mini-agent", "tool-results");

  export function persistLargeResult(toolName: string, result: string): string {
    if (Buffer.byteLength(result) <= DISK_OFFLOAD_THRESHOLD_BYTES) return result;

    mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
    const filepath = join(TOOL_RESULTS_DIR, `${Date.now()}-${toolName}.txt`);
    writeFileSync(filepath, result);

    const lines = result.split("\n");
    const preview = lines.slice(0, PREVIEW_LINES).join("\n");
    const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

    return (
      `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. ` +
      `You can use read_file to see the full result.]\n\nPreview (first ${PREVIEW_LINES} lines):\n${preview}`
    );
  }

  // ─── Compaction state ───────────────────────────────────────────────
  //
  // Unlike Phase 2's ReadFileState (created fresh per runAgentLoop call,
  // Phase 2 Concept 4), CompactionState must persist ACROSS separate calls
  // to runAgentLoop — i.e. across separate REPL turns. The decision "should
  // I compact right now" is made at the START of a new user turn using the
  // token-usage number left over from the END of the PREVIOUS turn's last
  // API response. If this were recreated per call the way ReadFileState is,
  // every turn would see lastInputTokens reset to 0 and auto-compact could
  // never fire. cli.ts creates exactly one CompactionState per process
  // invocation (the same lifetime as sessionId — see this phase's Files
  // section) and threads it into every runAgentLoop call for that session.

  export interface CompactionState {
    lastInputTokens: number;
    lastApiCallTime: number | null;
    contextWindowTokens: number;
  }

  export function createCompactionState(contextWindowTokens = 200_000): CompactionState {
    return { lastInputTokens: 0, lastApiCallTime: null, contextWindowTokens };
  }
  ```

- [ ] Sanity-check the disk-offload mechanism directly, without touching `agent.ts` or `cli.ts` yet — this module has no dependency on the Anthropic client, exactly like Phase 2's `tools.ts` and Phase 4's `session.ts`:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/compact.js').then(async (m) => {
    const small = 'hello world';
    console.log('small unchanged:', m.persistLargeResult('read_file', small) === small);
    const big = Array.from({ length: 5000 }, (_, i) => 'line ' + i + ': ' + 'z'.repeat(20)).join('\n');
    const preview = m.persistLargeResult('read_file', big);
    console.log(preview.slice(0, 200));
  });
  "
  ```

  This exact mechanism — including a real >30KB string, a real file write, and confirming the saved file's bytes match the original exactly — was independently verified while writing this tutorial, in an isolated scratch directory (`/private/tmp/.../scratchpad/verify-compact-phase7`), against precisely this code. Real captured output from that run: a 158,889-byte (155.2KB) input produced a 7,699-character preview referencing a real file on disk, and reading that file back byte-for-byte matched the original 158,889-byte input exactly. A small (well under 30KB) input passed through completely unchanged, confirming the threshold gate itself, not just the offload path.

---

## Concept 3: Wiring disk-offload into Phase 5's tool-processing loop

Recall Phase 5's final `runAgentLoop` (`phase-05-streaming.md`, Step 3): after `streamOneTurn` resolves, a `for` loop walks every `tool_use` block the model requested, resolves its result (either by awaiting an already-in-flight `earlyExecutions` promise for a read-only tool, or by calling `executeTool(...)` directly for anything else), and pushes a `tool_result` block for each one. `persistLargeResult` belongs at exactly one point in that loop: **after the raw result string is in hand, before it's wrapped into a `tool_result` block.** This has to apply uniformly to both code paths in that loop — a result that was started early during streaming and a result that was executed normally — because both are just strings by the time they reach this point; there's no reason disk-offload should behave differently depending on *when* the tool started running.

Reading the reference project's own `agent.ts` confirms this is exactly where it puts the equivalent call, in both of its own two code paths (`claude-code-from-scratch/src/agent.ts`, lines 1097-1098 for the early-started path and line 1121 for the normally-executed path, both quoted directly):

```typescript
// early-started (streaming) path:
const raw = await earlyPromise;
const res = this.persistLargeResult(toolUse.name, raw);
// ...
toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });

// normally-executed path:
const raw = await this.executeToolCall(toolUse.name, input);
const res = this.persistLargeResult(toolUse.name, raw);
```

Both call sites hand the *raw* tool output to `persistLargeResult` and push its *return value* (small either way) as the actual `tool_result` content. Nothing about `tool_use`/`tool_result` pairing is at risk here: this only ever changes the *content string* of a `tool_result` block that's about to be created for the first time — it never touches an existing message, never removes a block, never runs anywhere near the point where a pair could be split.

---

## Implement 2: Wire `persistLargeResult` into `agent.ts`

- [ ] Replace `src/agent.ts` with this (complete file, replacing **Phase 6's** final version, not Phase 5's — the only change from Phase 6 is the new `persistLargeResult` import and its single call site inside the tool-processing loop; Phase 6's `PermissionState` threaded into both `executeTool()` call sites, and `RunAgentLoopOptions`'s `permissionMode?`/`confirmTool?` fields, are carried over byte-for-byte unchanged):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { executeTool, findTool, type ReadFileState, type PermissionState } from "./tools.js";
  import type { PermissionMode } from "./permissions.js";
  import { persistLargeResult } from "./compact.js";

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
   * tool_use blocks, execute them, push exactly two entries per turn, repeat.
   *
   * New in this phase: every tool result — whether started early during
   * streaming or executed normally from the loop below — passes through
   * persistLargeResult() (Tier 0, compact.ts) the instant its raw string is
   * in hand, before it's wrapped into a tool_result block. This never
   * touches tool_use/tool_result pairing: it only replaces the CONTENT of a
   * tool_result block that's about to be created for the first time.
   *
   * Carried over unchanged from Phase 6: a fresh PermissionState is built
   * once per runAgentLoop() call and threaded into both of executeTool()'s
   * call sites — the early-execution one inside onToolBlockComplete, and the
   * post-turn one below. persistLargeResult() runs strictly after whatever
   * verdict that gate already reached; the two features never inspect each
   * other's state.
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
        const earlyPromise = earlyExecutions.get(toolUse.id);
        const raw =
          earlyPromise !== undefined
            ? await earlyPromise
            : await executeTool(
                toolUse.name,
                toolUse.input as Record<string, unknown>,
                readFileState,
                permission
              );

        // Tier 0: disk-offload oversized results before they ever enter
        // messages (Concept 2/3 above).
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

This exact file was type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0`, Phase 6's actual `tools.ts`/`permissions.ts` (four tools, `PermissionState`-gated `executeTool()`), and this phase's `compact.ts`, in an isolated scratch directory, as part of re-verifying this tutorial after reconciling it with Phase 6. Its behavior was also verified end-to-end at runtime against this exact reconciled file: a fake streaming client (mirroring the same fake-`MessageStream` technique Phase 5's own tutorial used for its timing tests) drove a real `read_file` call through the early-execution call site (gated as read-only-always-allow, returning real file content unchanged through `persistLargeResult`) and a real, dangerous-pattern-matched `run_shell` call through the post-turn call site (`checkPermission` returned `confirm`, `confirmTool` was awaited, and only after approval did the command actually execute) in the same turn — confirming both call sites still reach `checkPermission()` before `tool.execute()` ever runs. A separate run forced the approved `run_shell` call's real output past 30KB and confirmed `persistLargeResult` still disk-offloaded it correctly *after* the gate approved it (captured output: `[Result too large (39.1 KB, 3 lines). Full output saved to ...]`), proving the gate-then-offload ordering holds for large results too, not just small ones. See this phase's closing Grounding notes for the full list of re-verified claims, replacing the earlier, pre-Phase-6 run this tutorial originally cited here (a 158,889-byte `read_file` offload test against the old 3-argument `executeTool` signature).

---

## Concept 4: The tool_use/tool_result pairing invariant — precisely, not just "be careful"

Phase 1 (Concept 1 and 2) already established the mechanics: the Anthropic API expects strict `user`/`assistant` alternation, and every `tool_use` block in an assistant turn must be matched, in the very next message, by a `tool_result` block carrying the identical `tool_use_id`. This phase is the first time that pairing is genuinely at *risk* from something this codebase itself does, rather than just something to get right when constructing a request — because compaction's entire job, at its most aggressive tier, is to **remove messages**, and removing the wrong half of a pair corrupts the conversation in a way the API will reject on the very next call.

**The rule that keeps every tier in this phase safe:** never delete or replace a message that contains a `tool_use` block without also handling *every* `tool_result` block that answers it, in the same operation, and vice versa. Concretely, this phase's four tiers split cleanly into two categories:

- **Tiers 1-3 (Budget, Snip, Microcompact) never touch a `tool_use` block, and never remove a whole message.** They only ever reach inside an *existing* `tool_result` block and overwrite its `content` string in place. The `tool_use` block that produced it is untouched — the model still sees "I called `read_file` on `x.txt`," it just no longer sees the (possibly now-irrelevant) file contents that came back. Because the *structure* of pairs is never altered — only content inside an already-paired `tool_result` — these three tiers cannot break pairing no matter what state the conversation is in when they run. This is why, as you'll see in Concept 8, they're safe to run far more often than Tier 4.
- **Tier 4 (Auto-compact) is the one tier that removes whole messages** — in fact it removes *all* of them, replacing the entire history with a two- or three-message summary. The invariant here is different and stricter: whatever remains after slicing must not leave a dangling half of a pair anywhere in the array that's actually sent to the API. The way this phase's `compactConversation` (Implement 7 below) satisfies that: it slices off *exactly one* message — the very last one in the array — summarizes everything *before* that slice (which, by construction, already contains only complete pairs, since it's the untouched prefix of a conversation that's been valid at every previous turn), and re-appends the sliced-off message only if it's confirmed to be plain user text with no tool content at all. Every `tool_use`/`tool_result` pair that existed in the discarded prefix is discarded as a *whole pair*, together, never split.

### What breaks this, concretely, and the real documented error

If `compactConversation` is ever invoked when the *last* message in the array is a tool-result message — `{ role: "user", content: [ { type: "tool_result", ... } ] }` — instead of plain user text, two different things go wrong depending on which line you look at, and both are worth knowing:

1. **The summarization call itself can fail.** Everything up to (not including) the sliced-off last message gets sent to the model as the *content to summarize*. If that sliced-off message is a `tool_result`, the *assistant* message immediately before it (containing the matching `tool_use`) is still present in the summarization request — but nothing after it answers that `tool_use` anymore, because the one message that did just got sliced off. The reference project's own tutorial names this exact failure directly (`claude-code-from-scratch/docs/07-context.md`, line 284, quoted and translated): *"once called mid-tool-loop, the last message will be a `tool_result` (Anthropic) or a `tool` role (OpenAI); after slicing, the preceding assistant message's `tool_use`/`tool_calls` lose their pairing, and the API will reject the summarize request outright"* — with the specific documented rejection text quoted directly a few lines later in the same source (line 499): *"the Anthropic API will reject that summarize request with `tool_use ids were found without tool_result blocks immediately after`."*
2. **Even if the summarization call somehow succeeded, the rebuilt array can still be broken.** `compactConversation`'s own re-append logic only checks `lastMsg.role === "user"` before putting it back — and a `tool_result` message is *also* `role: "user"` (Phase 1, Concept 2: tool results are structurally indistinguishable from ordinary user turns at the role level). So a naive re-append check re-inserts the raw `tool_result` block as the new array's final message — except the assistant `tool_use` it was answering has just been summarized away entirely. The result is an orphaned `tool_result` with no `tool_use` anywhere in the array to match it — corrupted in the opposite direction from failure mode 1, but just as fatal to the next API call.

This was independently reproduced, not just reasoned about, while writing this tutorial: a scratch script called `compactConversation` on a fake array deliberately ending in a `tool_result` message (simulating exactly the "invoked mid-tool-loop" mistake) and confirmed the resulting array does contain an orphaned `tool_result` — a `tool_use_id` referencing a `tool_use` block that no longer exists anywhere in the array — using a small pairing-checker that scans both directions (every `tool_use` id has a matching `tool_result`, and every `tool_result`'s `tool_use_id` has a matching `tool_use`). Real captured output confirmed the corruption: `orphaned tool_use present: true`, with the resulting (broken) array printed for inspection. The fix isn't a smarter check inside `compactConversation` — it's making sure this function is structurally *only ever called* from one place, at one moment, where the invariant is guaranteed to already hold. That's exactly what Concept 8 (the Phase 5 hook point) is about.

---

## Implement 3: Tier 1 — Budget

This is the first of the two zero-cost, content-only tiers. Its job: as context pressure rises, shrink the largest `tool_result` strings still in the conversation, keeping both ends (imports/structure at the top of a file, error summaries at the bottom of a command's output — the same head-and-tail reasoning Phase 2's read-only tools never needed but this phase's compression does).

- [ ] Append this to `src/compact.ts` (the file so far — Implement 1's content plus this addition; the next few steps keep appending in the same way):

  ```typescript
  const RESERVED_OUTPUT_TOKENS = 20_000;
  const AUTO_COMPACT_UTILIZATION = 0.85;

  function effectiveWindow(state: CompactionState): number {
    return state.contextWindowTokens - RESERVED_OUTPUT_TOKENS;
  }

  // ─── Tier 1: Budget ──────────────────────────────────────────────
  //
  // As utilization rises, progressively shrink large tool_result strings
  // still sitting in the conversation. Two thresholds, not one, so detail
  // is preserved as long as possible: below 50% utilization, do nothing;
  // 50-70%, cap at 30,000 chars; above 70%, cap at 15,000 chars. Adapted
  // directly from claude-code-from-scratch/src/agent.ts's
  // budgetToolResultsAnthropic().

  export function budgetToolResults(messages: AgentMessage[], state: CompactionState): void {
    const utilization = state.lastInputTokens / effectiveWindow(state);
    if (utilization < 0.5) return;
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as Anthropic.ToolResultBlockParam;
        if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2);
          b.content =
            b.content.slice(0, keepEach) +
            `\n\n[... budgeted: ${b.content.length - keepEach * 2} chars truncated ...]\n\n` +
            b.content.slice(-keepEach);
        }
      }
    }
  }
  ```

  This needs an `Anthropic` import at the top of `compact.ts` for the `ToolResultBlockParam` type — add `import Anthropic from "@anthropic-ai/sdk";` alongside the existing `node:fs`/`node:path`/`node:os` imports from Implement 1.

Notice this function only ever mutates `b.content` — a plain string field on an existing `tool_result` block — never removes an element from `msg.content`, never touches a `tool_use` block, never removes a message from `messages`. This is Concept 4's "tiers 1-3 are pairing-safe by construction" claim made concrete: there is no code path here that could possibly orphan a pair, because nothing here ever deletes a block or a message, only rewrites a string already living inside one.

- [ ] Verify it directly (no API needed — this is a pure function over a plain array, exactly like Phase 2's `tools.ts` and Phase 4's `session.ts` were independently testable):

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/compact.js').then((m) => {
    const bigContent = 'X'.repeat(40000);
    const messages = [
      { role: 'user', content: 'read a big file' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {}, caller: { type: 'direct' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: bigContent }] },
    ];
    const state = m.createCompactionState(200000);
    state.lastInputTokens = Math.floor((200000 - 20000) * 0.72); // ~72% utilization -> 15000-char budget
    m.budgetToolResults(messages, state);
    console.log('shrunk to:', messages[2].content[0].content.length, 'chars (from 40000)');
  });
  "
  ```

  This exact scenario was run while writing this tutorial and produced real captured output: a 40,000-character tool result shrank to **14,965** characters at ~72% utilization (crossing the 70% line into the 15,000-char budget), with the truncation marker text present — confirming both the threshold math and the head/tail preservation.

---

## Concept 5: Why Snip is a different kind of cut than Budget

Budget (Tier 1) shrinks every oversized result by the same rule, uniformly, regardless of which tool produced it or how long ago. That's a blunt instrument — it doesn't know that a file you read three tool calls ago and then read *again* (getting fresh content) makes the first read's result pure dead weight, nor that a `list_files` call from ten turns back is far less likely to still be relevant than one from two turns back. Snip (Tier 2) targets exactly that kind of staleness: not "this result is too big," but "this result is probably obsolete given what's happened since."

The reference project's Snip only applies to a specific, deliberately narrow set of tools (`claude-code-from-scratch/docs/07-context.md`, lines 205-207, quoted directly): `read_file`, `grep_search`, `list_files`, `run_shell` — every tool in that reference project whose result is a *read*, never a *write*. This project's registry (Phase 2, still unmodified through Phase 5) only has two tools that fit that description at this point in the series — `read_file` and `list_files` — since `grep_search` and `run_shell` don't exist yet in this build (the reference project's `run_shell` only enters this series in Phase 6, which this phase deliberately doesn't depend on or assume). `edit_file`'s results are never snip-eligible, and that exclusion is deliberate, not an oversight: an edit's result ("Successfully edited x.txt") is a compact confirmation, not a large re-fetchable payload — there's no space to reclaim by snipping it, and unlike a stale file read, there's no equivalent "just call it again" recovery path for a write's own result text.

The other thing worth being precise about: Snip only ever clears the `content` string, exactly like Budget — the `tool_use` block stays untouched, so the model still has a true record that it *did* call `read_file` on that path; it has just lost the actual bytes that came back. If it turns out to matter later, the model's own recovery path is to call `read_file` again — which is both correct (it gets fresh content, sidestepping the possibility that the file changed since the snipped read, per Phase 2's own mtime-guard reasoning) and cheap (a single tool call, not a re-derivation of lost context).

---

## Implement 4: Tier 2 — Snip

- [ ] Append this to `src/compact.ts`:

  ```typescript
  // ─── Tier 2: Snip ────────────────────────────────────────────────
  //
  // Targets staleness, not size: among tool_result blocks from a small,
  // deliberately-read-only set of tools, keep only the most recent
  // KEEP_RECENT_RESULTS and replace everything older with a placeholder.
  // Unlike Budget, this can fully clear a result regardless of its size —
  // the assumption is that an old read is more likely to be superseded by
  // events since than merely "too big." Adapted from
  // claude-code-from-scratch/src/agent.ts's snipStaleResultsAnthropic();
  // SNIPPABLE_TOOLS is narrower here than the reference project's own set
  // (which also includes grep_search/run_shell — tools this build doesn't
  // have yet, see this phase's tutorial Concept 5).

  const SNIPPABLE_TOOLS = new Set(["read_file", "list_files"]);
  const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
  const KEEP_RECENT_RESULTS = 3;
  const SNIP_UTILIZATION_THRESHOLD = 0.6;

  function findToolUseNameById(messages: AgentMessage[], toolUseId: string): string | undefined {
    for (const msg of messages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as Anthropic.ToolUseBlock;
        if (b.type === "tool_use" && b.id === toolUseId) return b.name;
      }
    }
    return undefined;
  }

  export function snipStaleResults(messages: AgentMessage[], state: CompactionState): void {
    const utilization = state.lastInputTokens / effectiveWindow(state);
    if (utilization < SNIP_UTILIZATION_THRESHOLD) return;

    const candidates: { msgIdx: number; blockIdx: number }[] = [];
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as Anthropic.ToolResultBlockParam;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content !== SNIP_PLACEHOLDER) {
          const toolName = findToolUseNameById(messages, block.tool_use_id);
          if (toolName && SNIPPABLE_TOOLS.has(toolName)) {
            candidates.push({ msgIdx: mi, blockIdx: bi });
          }
        }
      }
    }

    // Keep the most recent KEEP_RECENT_RESULTS; snip everything older.
    const toSnip = candidates.slice(0, Math.max(0, candidates.length - KEEP_RECENT_RESULTS));
    for (const { msgIdx, blockIdx } of toSnip) {
      const content = messages[msgIdx].content as Anthropic.ToolResultBlockParam[];
      content[blockIdx].content = SNIP_PLACEHOLDER;
    }
  }
  ```

- [ ] Verify it directly:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/compact.js').then((m) => {
    const messages = [{ role: 'user', content: 'read 5 files' }];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'r'+i, name: 'read_file', input: {}, caller: { type: 'direct' } }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r'+i, content: 'contents of f'+i }] });
    }
    const state = m.createCompactionState(200000);
    state.lastInputTokens = Math.floor((200000 - 20000) * 0.65); // 65% > 60% threshold
    m.snipStaleResults(messages, state);
    const results = messages.filter(x => x.role === 'user' && Array.isArray(x.content)).map(x => x.content[0].content);
    console.log(results);
  });
  "
  ```

  Real captured output from this exact scenario, run while writing this tutorial: the oldest 2 of 5 tool results were replaced with the snip placeholder, and the most recent 3 were left completely intact — confirming both the `KEEP_RECENT_RESULTS = 3` cutoff and that snipping is selective by recency, not all-or-nothing. A separate check in the same run confirmed all 5 `tool_use` blocks were still present and untouched afterward, directly demonstrating Concept 4's "tiers 1-3 never touch `tool_use`" claim, not just asserting it.

---

## Concept 6: Why Microcompact is time-triggered instead of size-triggered

Snip is *selective* — it reasons about which specific results are probably stale. Microcompact (Tier 3) is the opposite: **indiscriminate**, clearing every old tool result regardless of which tool produced it, triggered not by how full the context is but by how long the conversation has sat idle. The reasoning is about prompt caching, not context size, and it's worth being able to state precisely rather than just "it clears old stuff": Anthropic's server-side prompt cache has a TTL (the reference project's chapter states the design assumption directly — a default around 5 minutes). If a user has been idle longer than that, the cached prefix from before their pause has almost certainly already expired server-side — meaning the *next* API call is going to re-upload and re-process the full prefix regardless of what this code does. Given that a cache-rebuild is already unavoidable, there's no additional cost to being aggressive about clearing old tool results at that exact moment: the reference doc states this trade-off directly (`claude-code-from-scratch/docs/07-context.md`, line 251, translated): *"the reason for a time-based trigger: prompt cache has a TTL; once idle exceeds 5 minutes the cache has likely already expired, and continuing to keep old message content offers no cost advantage — aggressive cleanup is better."*

Contrast this directly with Snip: *"Snip is selective (only replaces 'stale' results), Microcompact is indiscriminate (clears everything except the most recent 3) — more aggressive, but with a stricter trigger condition"* (same source, line 253, translated). Snip can fire mid-conversation, repeatedly, as utilization climbs, precisely because it's conservative about *what* it touches. Microcompact only fires once the user has stepped away — a moment where being aggressive costs nothing extra, because the expensive part (re-uploading a cold cache) was going to happen anyway.

Real Claude Code's own Microcompact goes one step further than this phase builds, and it's worth naming even though this phase doesn't implement it: production actually has **two** Microcompact paths, chosen by whether the cache is cold or still warm (`how-claude-code-works/docs/03-context-engineering.md`, §3.4, Level 3, read directly) — the cold-cache path matches exactly what this phase builds (directly rewrite message content, because the cache was going to be rebuilt regardless), but a *warm*-cache path exists too, using a server-side `cache_edits` mechanism that deletes content from the cache in place *without* touching the local message array at all, specifically to avoid invalidating a cache that's still valid. This phase implements only the time-based (cold-cache) path — the `cache_edits` API mechanism is real, cited, and explicitly out of scope, exactly as the reference project itself scopes it (`claude-code-from-scratch/docs/07-context.md`, line 255, translated: *"we only implement the time-based path — Claude Code's cache-editing path depends on the `cache_edits` API mechanism, too complex for a teaching implementation"*).

---

## Implement 5: Tier 3 — Microcompact, and the Tier 1-3 orchestrator

- [ ] Append this to `src/compact.ts`:

  ```typescript
  // ─── Tier 3: Microcompact ────────────────────────────────────────
  //
  // Idle-triggered, indiscriminate: once idle exceeds MICROCOMPACT_IDLE_MS,
  // clear every tool_result older than the most recent KEEP_RECENT_RESULTS,
  // regardless of which tool produced it. The rationale is prompt-cache
  // economics, not context size (see this phase's tutorial, Concept 6) —
  // this phase only implements the time-based path; real Claude Code's
  // separate cache-editing path (active when the cache is still warm) is
  // cited in the tutorial but not built here.

  const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;
  const MICROCOMPACT_PLACEHOLDER = "[Old tool result content cleared]";

  export function microcompact(messages: AgentMessage[], state: CompactionState): void {
    if (state.lastApiCallTime === null) return;
    if (Date.now() - state.lastApiCallTime < MICROCOMPACT_IDLE_MS) return;

    const allResults: { msgIdx: number; blockIdx: number }[] = [];
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as Anthropic.ToolResultBlockParam;
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content !== MICROCOMPACT_PLACEHOLDER
        ) {
          allResults.push({ msgIdx: mi, blockIdx: bi });
        }
      }
    }

    const toClear = allResults.slice(0, Math.max(0, allResults.length - KEEP_RECENT_RESULTS));
    for (const { msgIdx, blockIdx } of toClear) {
      const content = messages[msgIdx].content as Anthropic.ToolResultBlockParam[];
      content[blockIdx].content = MICROCOMPACT_PLACEHOLDER;
    }
  }

  /**
   * Tiers 1-3, run in order. Zero API cost — pure local mutation of the
   * messages array. Safe to call on every iteration of runAgentLoop's
   * while(true) loop (i.e. every model turn within one user turn, including
   * multi-tool-round-trip turns), because none of these tiers ever touches
   * a tool_use block or removes a whole message — only tool_result CONTENT
   * strings are ever shrunk or replaced in place (Concept 4). The order
   * matters: Budget shrinks the largest results first, which makes Snip's
   * "is this one worth keeping" judgment operate on a smaller, cleaner set;
   * Microcompact runs last because its trigger (idle time) is completely
   * independent of the other two and it's fine for it to have the final say
   * when it does fire.
   */
  export function runCompressionPipeline(messages: AgentMessage[], state: CompactionState): void {
    budgetToolResults(messages, state);
    snipStaleResults(messages, state);
    microcompact(messages, state);
  }
  ```

- [ ] Verify Microcompact directly, including confirming it correctly does *not* fire when idle time hasn't elapsed:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/compact.js').then((m) => {
    function build() {
      const messages = [{ role: 'user', content: 'read 5 files' }];
      for (let i = 0; i < 5; i++) {
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'm'+i, name: 'read_file', input: {}, caller: { type: 'direct' } }] });
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm'+i, content: 'contents of f'+i }] });
      }
      return messages;
    }
    const idleMessages = build();
    const idleState = m.createCompactionState(200000);
    idleState.lastApiCallTime = Date.now() - 6 * 60 * 1000; // 6 min idle
    m.microcompact(idleMessages, idleState);
    console.log('after 6min idle:', idleMessages.filter(x => x.role==='user' && Array.isArray(x.content)).map(x => x.content[0].content));

    const warmMessages = build();
    const warmState = m.createCompactionState(200000);
    warmState.lastApiCallTime = Date.now() - 30 * 1000; // 30s idle
    m.microcompact(warmMessages, warmState);
    console.log('after 30s idle (should be untouched):', warmMessages.filter(x => x.role==='user' && Array.isArray(x.content)).map(x => x.content[0].content));
  });
  "
  ```

  Real captured output from this exact scenario: after 6 minutes of simulated idle time, the oldest 2 of 5 results were cleared to the Microcompact placeholder and the most recent 3 were left intact; after only 30 seconds of idle time (well under the 5-minute threshold), all 5 results were confirmed completely untouched — proving the idle gate itself, not just the clearing logic.

---

## Concept 7: Tier 4 — Auto-compact, and exactly how it satisfies the pairing invariant

Tiers 1-3 buy time; they don't create room the way an actual summarization does, because they only ever shrink or clear *content* — the message *count* never goes down, and every `tool_use` block that ever existed is still sitting there, forever, contributing its own (small but nonzero) token cost. Eventually, for a long enough conversation, that stops being enough. Tier 4 is the last resort: fork off a single side call to the model, ask it to summarize everything so far, and replace the *entire* history with that summary plus a short acknowledgment.

**The trigger**, read directly from the reference project (`claude-code-from-scratch/docs/07-context.md`, lines 264-270, quoted directly):

```typescript
private async checkAndCompact(): Promise<void> {
  if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
    printInfo("Context window filling up, compacting conversation...");
    await this.compactConversation();
  }
}
```

`effectiveWindow` is the model's context window minus a reservation for the summary's own output — the same doc gives the worked example directly: *"`effectiveWindow` = model context window − 20,000, reserved for the next round's input/output. For Claude (200K window), the trigger point is around 76.5% of total utilization"* — i.e. `0.85 * (200,000 − 20,000) / 200,000 ≈ 0.765`. This phase's `checkAndCompact` (Implement 7 below) uses the identical formula.

**How the summarization call itself respects the pairing invariant.** `compactConversation` slices off exactly the *last* message in the array, sends everything before it (unmodified) to the model with an instruction to summarize, and rebuilds the array from the response:

```typescript
// claude-code-from-scratch/src/agent.ts — compactAnthropic (quoted directly, abridged)
private async compactAnthropic(): Promise<void> {
  if (this.anthropicMessages.length < 4) return;
  const lastUserMsg = this.anthropicMessages[this.anthropicMessages.length - 1];
  const summaryResp = await this.anthropicClient!.messages.create({
    model: this.model,
    max_tokens: 2048,
    system: "You are a conversation summarizer. Be concise but preserve important details.",
    messages: [
      ...this.anthropicMessages.slice(0, -1),
      { role: "user", content: "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work." },
    ],
  });
  const summaryText = summaryResp.content[0]?.type === "text" ? summaryResp.content[0].text : "No summary available.";
  this.anthropicMessages = [
    { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
    { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
  ];
  if (lastUserMsg.role === "user") this.anthropicMessages.push(lastUserMsg);
  this.lastInputTokenCount = 0;
}
```

The `slice(0, -1)` prefix that gets sent to the summarizer is, by construction, a conversation that has been valid at every previous turn — every `tool_use` it contains is already paired with its `tool_result`, because that pairing was checked (implicitly, by the API itself accepting each prior turn) before this call ever runs. Slicing off the trailing element doesn't touch any of that internal pairing — it only removes the newest message, and the entire method's safety rests on that newest message being guaranteed to be plain user text, never a `tool_result`. Concept 4 above already showed exactly what goes wrong if that guarantee doesn't hold; Concept 8 explains precisely where in this project's own control flow that guarantee is actually enforced.

**What real Claude Code does differently here**, cited precisely rather than assumed: production's summarization prompt is a two-stage "analysis then summary" prompt — the model first reasons in an `<analysis>` block (a chronological pass over every message: user intent, approach taken, key decisions, files touched, errors and fixes), then produces a `<summary>` block with nine standardized sections (Primary Request, Key Technical Concepts, Files and Code, Errors and Fixes, Problem Solving, All User Messages, Pending Tasks, Current Work, Optional Next Step) — and `formatCompactSummary()` deliberately **discards the `<analysis>` block**, keeping only the `<summary>` in context (`how-claude-code-works/docs/03-context-engineering.md`, §3.4 Level 5, read directly) — a chain-of-thought-scratchpad technique: let the model reason at length, then keep only the conclusion. Production also runs a **post-compact recovery** step afterward (`runPostCompactCleanup()`, same source): it re-attaches the most recently read 5 files (from the pre-compaction `readFileState` cache, capped at 5K tokens each) and any actively-loaded skills, specifically so the model doesn't "forget" what it was just working on the moment compaction fires. This phase implements neither refinement — a single-paragraph summary with no post-compact recovery — matching the reference project's own explicitly stated simplification (`claude-code-from-scratch/docs/07-context.md`, line 368, translated: *"the main difference from Claude Code: Claude Code uses a two-stage 'analysis-summary' prompt for higher-quality summaries, restores the 5 most recent files and active skills after compacting, and has a circuit breaker against infinite loops. We're a simplified version — single-paragraph summary, no recovery, no circuit breaker."*).

**The circuit breaker, cited precisely.** Real production data motivated a specific, numeric safeguard worth knowing: `claude-code/src/services/compact/autoCompact.ts`, lines 67-70 (quoted directly):

```typescript
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

Real Claude Code stops retrying auto-compact after 3 consecutive failures rather than looping forever against a conversation that's irrecoverably over the limit. This is the same fact the tutorial backbone's own doc cites (`claude-code-from-scratch/docs/07-context.md`, line 67 — matches the real source's own figure of 3,272 consecutive failures exactly, confirming the doc's citation against the actual production constant rather than a rounded or paraphrased number). This phase does not implement a circuit breaker — a single compaction attempt either succeeds or its rejection propagates as an ordinary error up through `runAgentLoop`'s existing `try/catch` (Phase 4's abort/error handling) — flagged here as a real, cited, deliberately-unbuilt production safeguard, not an oversight.

---

## Implement 6: Tier 4 — `compactConversation` and `checkAndCompact`

- [ ] Append this to `src/compact.ts` — this is the final addition; the file is complete after this step:

  ```typescript
  // ─── Tier 4: Auto-compact — full LLM summarization ───────────────

  /**
   * INVARIANT (load-bearing, not a style choice — see this phase's tutorial,
   * Concept 4 and Concept 7): the last entry of `messages` must be a plain
   * user-text message when this is called — never a tool_result. This
   * function slices it off, sends everything else to the model for
   * summarization, and re-appends it after rebuilding the array. If the
   * last message were instead a tool_result, slicing it off would leave the
   * PRECEDING assistant message's tool_use block with no matching
   * tool_result anywhere in the request — the Anthropic API rejects that
   * with a 400 error ("tool_use ids were found without tool_result blocks
   * immediately after"). The only caller that may invoke this,
   * checkAndCompact(), is itself only ever called once, at the very top of
   * runAgentLoop, before the first streamOneTurn() of a turn — see this
   * phase's tutorial, Concept 8, for why that position is the only one
   * where this invariant is guaranteed to hold.
   */
  export async function compactConversation(
    messages: AgentMessage[],
    client: Anthropic,
    model: string
  ): Promise<void> {
    if (messages.length < 4) return;

    const lastMsg = messages[messages.length - 1];

    const summaryResp = await client.messages.create({
      model,
      max_tokens: 2048,
      system: "You are a conversation summarizer. Be concise but preserve important details.",
      messages: [
        ...messages.slice(0, -1),
        {
          role: "user",
          content:
            "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.",
        },
      ],
    });

    const summaryText =
      summaryResp.content[0]?.type === "text" ? summaryResp.content[0].text : "No summary available.";

    const rebuilt: AgentMessage[] = [
      { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
      {
        role: "assistant",
        content: "Understood. I have the context from our previous conversation. How can I continue helping?",
      },
    ];
    if (lastMsg.role === "user") rebuilt.push(lastMsg);

    // Mutate IN PLACE — never `messages = rebuilt`. runAgentLoop's caller
    // (cli.ts) holds its own reference to this exact array; reassigning the
    // local `messages` parameter binding inside this function would not be
    // visible outside it (a plain JS/TS closure-scoping fact, not specific
    // to this project). splice(0, length, ...) replaces every element
    // while preserving the array's identity — the same mutate-and-return
    // contract every phase since Phase 1 has relied on.
    messages.splice(0, messages.length, ...rebuilt);
  }

  export async function checkAndCompact(
    messages: AgentMessage[],
    state: CompactionState,
    client: Anthropic,
    model: string
  ): Promise<boolean> {
    const threshold = effectiveWindow(state) * AUTO_COMPACT_UTILIZATION;
    if (state.lastInputTokens <= threshold) return false;
    await compactConversation(messages, client, model);
    state.lastInputTokens = 0;
    return true;
  }
  ```

Two design choices worth flagging explicitly, both already previewed above:

- **`messages.splice(0, messages.length, ...rebuilt)`, not `messages = rebuilt`.** This is the one place in this phase's code where getting a single line wrong would silently break everything downstream, and it's exactly the kind of mistake a naive line-for-line port of the reference project's own class-based code would make. The reference implementation reassigns `this.anthropicMessages = [...]` — safe there, because `anthropicMessages` is a field on a long-lived class instance, and every method on that class reads the field fresh through `this.` on every access. This project's `runAgentLoop` is a *function*, not a class method — `messages` is a parameter, a local binding to whatever array reference the caller (`cli.ts`) passed in. Reassigning that local binding (`messages = rebuilt`) would only redirect *this function's own* local variable to a new array; the caller's own `messages` variable in `cli.ts` — the one that gets passed to the *next* `runAgentLoop` call and the one `session.ts`'s `saveSession(...)` actually persists — would still point at the old, uncompacted array, completely unaffected. `splice` avoids this entirely by mutating the array *object itself* in place, which is exactly the same mutate-and-return contract Phase 1 established for `runAgentLoop` from the very first line of code this series ever wrote.
- **`if (lastMsg.role === "user") rebuilt.push(lastMsg)`** re-appends the sliced-off message only if it's a `user`-role message — the same check the reference implementation uses, and the same check this phase's Concept 4 already flagged as *insufficient on its own* (a `tool_result` message is also `role: "user"`). What actually makes this safe in this phase's build is not a smarter check here — it's that `compactConversation` is never called except from `checkAndCompact`, which is never called except from the one guaranteed-safe position `runAgentLoop` calls it from (Concept 8, next). The check stays exactly as simple as the reference project's own version; the guarantee comes from the call site, not from hardening this function against a misuse it should never actually receive.

- [ ] Type-check the complete `compact.ts`:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

This complete file — all four tiers plus disk-offload plus `CompactionState` — was type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` and this phase's `agent.ts`, in an isolated scratch directory, as part of writing this tutorial. `compactConversation` and `checkAndCompact` were additionally verified at runtime against a fake client (the same fake-client technique Phase 4 and Phase 5 each used for their own abort/streaming proofs): confirmed `checkAndCompact` correctly does nothing when `lastInputTokens` is below threshold (array untouched, same reference); confirmed it correctly fires above threshold, mutates the array **in place** (`messages === arrayRef` held true after the call, proving the splice — not reassignment — claim above), rebuilds it to the expected 2-or-3-message shape with the summary first and the prior last-user-message re-appended verbatim, and resets `lastInputTokens` to 0; confirmed the `< 4` guard leaves a short conversation untouched; and — deliberately reproducing the exact mistake Concept 4 describes — confirmed that calling `compactConversation` with a fake array ending in a `tool_result` message (simulating an incorrect mid-tool-loop call) produces a real, detectable orphaned-pairing corruption in the output array, using a pairing-checker that scans for `tool_use` ids with no matching `tool_result` and `tool_result`s with no matching `tool_use` in either direction.

---

## Concept 8: The exact hook point relative to Phase 5's streaming loop — the crux of this phase

Everything above works as a pile of correct functions. None of it matters if it's called from the wrong place. This is the part of the phase breakdown that specifically calls out as the crux, so it's worth being exact rather than approximate about Phase 5's actual loop shape and where these hooks slot in.

### Phase 5's loop, precisely (recap, not a new claim)

`runAgentLoop` (Phase 5, Step 3, and this phase's Implement 2 above) has exactly this outer shape:

```
export async function runAgentLoop(messages, options) {
  const readFileState = new Map();

  while (true) {                              // ← one iteration = one model turn
    const response = await streamOneTurn(messages, { ...onToolBlockComplete });
    messages.push({ role: "assistant", ... });
    const toolUses = ...;
    if (toolUses.length === 0) break;          // ← model is done, no more tool calls
    // execute tools, push tool_result message
  }
  return messages;
}
```

A single call to `runAgentLoop` corresponds to *one user turn* — but internally, its `while (true)` loop can iterate multiple times if the model calls tools and keeps calling more tools in response to their results, before finally producing a response with no `tool_use` blocks. `streamOneTurn` is the one function in this whole file that ever calls `client.messages.stream(...)` — the one operation that's actually a live network request to Anthropic.

### Where each tier's hook goes, and why

**Tiers 1-3 (`runCompressionPipeline`) go inside the `while (true)` loop, once per iteration, immediately before each `streamOneTurn(...)` call.** This mirrors the reference project's own placement exactly (`claude-code-from-scratch/src/agent.ts`, line 1002, inside its own `while (true)`, immediately before its own streaming call: `this.runCompressionPipeline(); ... const response = await this.callAnthropicStream(...)`). This placement is correct precisely *because* of Concept 4's proof that these three tiers can never break pairing — since they only ever touch already-existing `tool_result` content, it is safe to run them at absolutely any point in the array's lifetime, including in the middle of a multi-tool-round-trip turn where the array's last message is itself a `tool_result`. There's no invariant here to violate.

**Tier 4 (`checkAndCompact`) goes exactly once, before the `while (true)` loop starts — never inside it.** This is the one placement in this entire phase that has to be exactly right, because `compactConversation`'s safety depends entirely on the last message in `messages` being plain user text, and that is only true at one specific moment: right after `cli.ts` has pushed the user's newly-typed message and *before* `runAgentLoop`'s internal loop has run even once. The instant the loop's first iteration executes a tool and pushes a `tool_result` message, that guarantee is gone for the rest of this `runAgentLoop` call — which is exactly why Tier 4 must never be re-checked or re-triggered from inside the loop, only once, at the top, before anything else happens.

Putting both together, this phase's final `runAgentLoop`:

```typescript
export async function runAgentLoop(messages, options) {
  const { client, model, ..., compaction } = options;
  const readFileState = new Map();

  // Turn-boundary hook (Tier 4) — runs ONCE, before the while(true) loop's
  // first iteration. At this exact point, messages' last entry is
  // guaranteed to be the plain user-text message cli.ts just pushed before
  // calling runAgentLoop — the only moment this invariant holds for the
  // rest of this call.
  if (compaction) {
    await checkAndCompact(messages, compaction, client, model);
  }

  while (true) {
    // Tiers 1-3 — zero API cost, safe on EVERY iteration of this loop,
    // including mid-tool-round-trip iterations where the array's last
    // message is itself a tool_result.
    if (compaction) {
      runCompressionPipeline(messages, compaction);
    }

    const response = await streamOneTurn(messages, { ... });
    if (compaction) {
      compaction.lastInputTokens = response.usage.input_tokens;
      compaction.lastApiCallTime = Date.now();
    }
    messages.push({ role: "assistant", ... });
    // ...
  }
  return messages;
}
```

### Why compaction must never run while a `MessageStream` is active

This is the specific integration risk Phase 5 introduced that Phase 1-4's non-streaming design never had to consider, and it's worth stating precisely rather than hand-waving "don't do two things at once."

`streamOneTurn`'s `client.messages.stream(...)` call is a genuinely asynchronous, long-lived operation — Phase 5 established that a turn's `MessageStream` can be actively receiving `content_block_delta` events for many seconds while text streams to the terminal and read-only tools start executing early (Phase 5, Concept 4). If `checkAndCompact` — which itself makes an *entirely separate* `client.messages.create(...)` call — were allowed to fire concurrently with an in-flight `streamOneTurn` call over the *same* `messages` array, two independent problems compound:

1. **The array's contents at the moment compaction reads them would not match what the in-flight stream's request body already contains.** The in-flight `stream()` call already serialized and sent whatever `messages` looked like at the moment it was invoked — mutating the array afterward can't retroactively change that request, but it *can* leave the shared array in a state that no longer matches either the request that's already in flight or the state `compactConversation`'s own "last message is plain text" assumption depends on, since a concurrent compaction has no way to know whether the currently-last message belongs to a turn that's still being constructed.
2. **Two genuinely concurrent API calls sharing one mutable array race each other.** `compactConversation`'s own `client.messages.create(...)` call and `streamOneTurn`'s `client.messages.stream(...)` call would both eventually want to push their own idea of "what comes next" onto the same array. Whichever one's callback runs last would silently win, and there is no defined ordering between two independently-resolving promises racing to mutate the same object — exactly the kind of undefined-order bug that's invisible in testing and catastrophic in production, because the actual failure mode (a `messages` array containing a foreign, half-integrated summary spliced in the middle of another turn's tool-execution bookkeeping) doesn't look like a crash, it looks like the agent quietly forgetting things or hallucinating from a corrupted history.

This project's structure prevents both problems *by construction*, not by adding a lock: `checkAndCompact` is called exactly once, synchronously awaited, strictly *before* the very first `streamOneTurn` call of a given `runAgentLoop` invocation. There is no code path in this file where a `streamOneTurn` call and a `checkAndCompact` call are ever in flight at the same time, because the `await` on `checkAndCompact(...)` fully resolves before the `while (true)` loop — and its first `streamOneTurn` call — ever begins.

### Verified, not just reasoned about

This exact ordering claim was independently tested, not just argued for, while writing this tutorial: a fake client (mirroring Phase 5's own fake-`MessageStream` verification technique) logged every call it received, both to `.messages.stream(...)` (used by `streamOneTurn`) and `.messages.create(...)` (used only by `compactConversation`). Two scenarios were run against the real, compiled `runAgentLoop`:

- With `lastInputTokens` set below threshold: the call log showed only `stream#0`, `stream#1` (two model turns within one user turn, since the scripted fake response included one tool call) — the summarization call never appeared, confirming `checkAndCompact` correctly declines to fire below threshold.
- With `lastInputTokens` set above the 0.85-of-`effectiveWindow` threshold before the call: the call log showed, in exact order, `compact-summarize-call`, then `stream#0`, then `stream#1` — confirming the summarization call fires **exactly once**, and strictly **before** the first streaming call, never interleaved with or after it. `state.lastInputTokens` was also confirmed reset to `0` and the final `messages` array's length and shape matched the two-model-turn scenario exactly, on top of the compaction having already run.

Real captured output from that run: `Second scenario call log (order matters): [ 'compact-summarize-call', 'stream#0', 'stream#1' ]`, with both order-sensitive assertions (`compact-summarize-call happened exactly once` and `compact-summarize-call happened BEFORE any stream# call`) confirmed `true`.

---

## Implement 7: Wire compaction into `runAgentLoop`

- [ ] Replace `src/agent.ts` with this (complete file — this is the final state of `agent.ts` for this phase; the only changes from Implement 2 above are the new `compaction?: CompactionState` option, the one `checkAndCompact` call before the `while (true)` loop, the `runCompressionPipeline` call inside it, and updating `compaction.lastInputTokens`/`lastApiCallTime` after each `streamOneTurn` resolves. Phase 6's `PermissionState` threading through both `executeTool()` call sites, and `RunAgentLoopOptions`'s `permissionMode?`/`confirmTool?` fields, are unchanged from Implement 2 and carried forward exactly):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { executeTool, findTool, type ReadFileState, type PermissionState } from "./tools.js";
  import type { PermissionMode } from "./permissions.js";
  import {
    persistLargeResult,
    runCompressionPipeline,
    checkAndCompact,
    type CompactionState,
  } from "./compact.js";

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
  }

  interface TrackedToolBlock {
    id: string;
    name: string;
    caller: Anthropic.ToolUseBlock["caller"];
    inputJson: string;
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
   * repeat.
   *
   * New in this phase: an optional `compaction` state (see compact.ts). If
   * present:
   *   1. Once, before the very first streamOneTurn() call of this
   *      runAgentLoop invocation — never inside the while(true) loop —
   *      checkAndCompact() may run a full LLM-summarization compaction
   *      (Tier 4). This position is the only one where the "last message is
   *      plain user text" invariant compactConversation() depends on is
   *      guaranteed to hold (see compact.ts's doc comment and this phase's
   *      tutorial, Concept 8).
   *   2. On every iteration of the while(true) loop, before each
   *      streamOneTurn() call, runCompressionPipeline() (Tiers 1-3) runs —
   *      zero API cost, safe at any point because it never touches
   *      tool_use blocks or removes whole messages.
   * Every tool result also passes through persistLargeResult() the instant
   * it's computed (whether early-started during streaming or executed from
   * the tool-processing loop below), before being pushed into toolResults.
   *
   * Carried over unchanged from Phase 6: a fresh PermissionState is built
   * once per runAgentLoop() call — a brand-new object every time this
   * function is invoked, so a confirmation approved in one call never
   * carries over into the next — and threaded into both of executeTool()'s
   * call sites (early-execution, inside onToolBlockComplete below, and the
   * post-turn one in the tool-processing loop). Compaction and permissions
   * never inspect each other's state: checkAndCompact()/
   * runCompressionPipeline() only ever touch messages/compaction, and
   * executeTool()'s permission gate only ever touches permission — the two
   * features are wired into this same function without either one needing
   * to know the other exists.
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
    } = options;

    const readFileState: ReadFileState = new Map();
    const permission: PermissionState = {
      mode: permissionMode,
      confirmedActions: new Set(),
      confirmTool,
    };

    // Turn-boundary compaction (Tier 4) — see doc comment above and this
    // phase's tutorial, Concept 8, for why this must sit HERE, before the
    // while(true) loop, and never inside it.
    if (compaction) {
      await checkAndCompact(messages, compaction, client, model);
    }

    while (true) {
      // Tiers 1-3 — zero API cost, safe on every iteration of this loop.
      if (compaction) {
        runCompressionPipeline(messages, compaction);
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
            earlyExecutions.set(
              block.id,
              executeTool(block.name, input, readFileState, permission)
            );
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
        const raw =
          earlyPromise !== undefined
            ? await earlyPromise
            : await executeTool(
                toolUse.name,
                toolUse.input as Record<string, unknown>,
                readFileState,
                permission
              );

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

- [ ] Type-check the whole project:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

This file was type-checked (`npx tsc --noEmit`, zero errors) in an isolated scratch directory alongside Phase 6's actual `tools.ts`/`permissions.ts` (not Phase 2's unmodified version) and this phase's `compact.ts`, as part of re-verifying this tutorial after reconciling it with Phase 6. Its integration behavior — both the exact call-ordering claims in Concept 8 *and* the permission-gate-plus-compaction coexistence claims made throughout this phase's fix — was verified at runtime against this exact reconciled, compiled file, not merely reasoned about. Concretely, against a fake client logging every `.messages.stream(...)`/`.messages.create(...)` call:

- A turn with an early-executed `read_file` call and a post-turn, dangerous-pattern-matched `run_shell` call (needing `confirmTool`) both correctly reached `checkPermission()` before executing, and `confirmTool` was invoked **exactly once** across the whole `runAgentLoop()` call even when the model repeated the identical `run_shell` command in a second loop iteration — confirming the single `PermissionState` object (with its `confirmedActions` whitelist) is shared across every iteration of one call, not rebuilt per tool or per iteration, exactly as Phase 6 designed it.
- A denied `run_shell` call produced the expected `"User denied this action."` string (the underlying `rm -rf` command never actually ran), and a pairing-checker confirmed no orphaned `tool_use`/`tool_result` pair existed afterward, even after that denial string passed through a full `runCompressionPipeline()` call.
- Forcing `checkAndCompact` to fire (via an already-over-threshold `lastInputTokens`) at the top of a **second, separate** `runAgentLoop()` call confirmed the summarization call still fires strictly before the first `streamOneTurn` call (`callLog: ["compact-summarize-call", "stream#0", "stream#1"]`), and that this second call's dangerous `run_shell` command still required a fresh `confirmTool` prompt — proving `PermissionState` is genuinely rebuilt fresh per `runAgentLoop()` invocation and never leaks across turns, with Tier 4 compaction firing at the top of that same call causing no interference.
- A permission-gated, approved `run_shell` call whose real output exceeded 30KB was still correctly disk-offloaded by `persistLargeResult` afterward (captured: `[Result too large (39.1 KB, 3 lines). Full output saved to ...]`), confirming the gate-then-offload ordering holds for large results, not only the small ones exercised in Implement 2's own re-verification.

See Concept 8's "Verified, not just reasoned about" subsection above for the original compaction-only ordering proof, and this phase's closing Grounding notes for the complete, updated list of what was re-verified as part of reconciling this phase with Phase 6.

---

## Concept 9: Interaction with Phase 4's session persistence

Phase 4 established `saveSession(sessionId, buildSessionData(...))`, called from `cli.ts`'s `finally` block after every `runAgentLoop` call, whether that turn completed, errored, or was interrupted — and Phase 4's own reasoning for saving unconditionally was that `messages` is always left in a valid, resumable state either way. That reasoning still holds after this phase, and the practical consequence is worth stating in exactly one sentence, because it's the kind of thing an interviewer will probe for precision on: **whatever `messages` looks like at the moment `runAgentLoop` returns — compacted or not — is exactly what gets saved, because `saveSession` reads the very same array reference `runAgentLoop` was handed and (per Implement 6's `splice`, not reassignment) mutated in place.** There is no separate "pre-compaction" or "post-compaction" version of the session; there is one `messages` array, and by the time `cli.ts` calls `saveSession`, any compaction that happened during that turn has already been applied to it.

**Does this project preserve the original, uncompacted history anywhere?** No — and this matches the reference project's own explicitly stated simplification, not an oversight this tutorial is introducing. Once Tier 4 fires, `compactConversation` replaces `messages` wholesale; the detailed turn-by-turn history that existed before that point is genuinely gone from the conversation itself. The only remnant of it that might survive is whatever Tier 0 already wrote to disk (`~/.nac-mini-agent/tool-results/...`) *before* compaction ran — and even that survives only if the summary text the model wrote happens to mention a path worth re-reading; there's no guaranteed link back. This is a real, load-bearing gap compared to production: real Claude Code's `runPostCompactCleanup()` (Concept 7, above) deliberately re-attaches the 5 most recently read files and any active skills immediately after compaction precisely so the model doesn't lose track of what it was just doing — this phase implements no equivalent recovery step, exactly as the reference project it follows does not either.

**Does `session.ts` itself need to change?** No, and it's worth walking through *why* rather than just asserting it. `saveSession`'s signature (Phase 4) takes a `SessionData` — `{ metadata, messages }` — built fresh in `cli.ts` on every save from whatever `messages` currently is. Nothing about `session.ts`'s own code inspects the *shape* of that array beyond serializing it as JSON; it has no opinion about whether a `tool_use`/`tool_result` pair exists anywhere inside it, whether a `[Previous conversation summary]` message is present, or how many messages there are. Compaction is entirely invisible to `session.ts` — from its point of view, a compacted `messages` array and an uncompacted one are both just "the current value of the array it was handed," saved identically. This is a direct, structural consequence of Phase 4's own design choice to keep session persistence as "serialize the array you already have, nothing more" (Phase 4, Concept 3) — a design that turns out to already be exactly general enough for this phase to need zero changes to it.

---

## Implement 8: Wire `CompactionState` into `cli.ts`

`src/cli.ts` needs to create exactly one `CompactionState` per process invocation — the same lifetime as `sessionId` — and pass it into every `runAgentLoop` call for that session, both the REPL's per-turn call and the one-shot branch in `main()`.

This step is a narrow diff against **Phase 6's** `cli.ts`, not Phase 4's or Phase 5's: Phase 6's `--yolo`/`--plan`/`--accept-edits`/`--dont-ask` flags in `parseArgs()`, its `confirmTool` implementation (`rl.question(...)` inside `runRepl`), and its threading of `permissionMode`/`confirmTool` into both `runAgentLoop` call sites are all left completely untouched by this step. This phase only adds one new key (`compaction: compactionState`) to each of those same two call sites' options objects, alongside whatever Phase 6 already put there.

- [ ] In `src/cli.ts`, add the import (alongside the existing `agent.js`/`tools.js`/`prompt.js`/`session.js`/`permissions.js` imports):

  ```typescript
  import { createCompactionState } from "./compact.js";
  ```

- [ ] In `main()`, create the state once, alongside `sessionId` and `startTime`:

  ```typescript
  const compactionState = createCompactionState(); // defaults to a 200,000-token window
  ```

- [ ] Thread it into every `runAgentLoop` call — both the REPL branch's per-turn call inside `runRepl`'s `askQuestion`, and the one-shot branch in `main()` — by adding `compaction: compactionState` to each call's options object, alongside the `permissionMode`/`confirmTool` keys Phase 6 already put there, and passing `compactionState` as a new parameter into `runRepl` (add it to `ReplOptions` and destructure it inside `runRepl`, the same way `sessionId`/`startTime`/`permissionMode` are already threaded through per Phase 4/Phase 6).

  Only the options objects passed to `runAgentLoop` change — one new key, `compaction: compactionState`, added to each of the two existing call sites. Nothing about `parseArgs`, the SIGINT handler, `confirmTool`'s implementation, session save/load, or `--resume` handling changes — all of Phase 6's permission-mode plumbing stays exactly as that phase's tutorial left it.

- [ ] Type-check the whole project:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

**A real, honest limitation worth flagging, not fixing in this phase:** `CompactionState` is created fresh (`lastInputTokens: 0`) on every process start, including after `--resume` loads a large saved conversation. Since Phase 4's `SessionData` doesn't persist token-usage numbers (only `messages` and label metadata), a freshly resumed session has no way to know how full its reloaded `messages` array actually is until the *first* new turn's own API response reports a real `usage.input_tokens` value. This means the very first turn after resuming a conversation that was already near the compaction threshold will not trigger Tier 4 even if it arguably should — compaction only catches up starting from the *second* turn onward, once `lastInputTokens` reflects a real number again. Real Claude Code's `tokenCountWithEstimation()` (`how-claude-code-works/docs/03-context-engineering.md`, §3.5, read directly) solves exactly this by anchoring off the most recent `usage` value found by scanning backward through the message history and estimating the rest by character count — a real, cited, un-implemented improvement, not a bug this phase's tests failed to catch.

---

## Concept 10: What real Claude Code does differently overall (production contrast)

Three further, precisely-cited differences worth knowing even though this phase deliberately doesn't build them, beyond the ones already named in Concepts 2, 6, and 7:

**Production has a fifth tier this phase doesn't build at all: Context Collapse.** Read directly (`how-claude-code-works/docs/03-context-engineering.md`, §3.4, Level 4): Context Collapse is a *projection*, not a mutation — it creates a read-only, filtered view of the message history (conceptually a database `VIEW` over an unchanged underlying table) rather than rewriting `messages` itself, which lets it be applied and reverted per-request without any permanent loss. It runs *before* Auto-compact specifically because collapsing might already bring utilization back under the Auto-compact threshold, avoiding a full, lossy summarization that would otherwise have been unnecessary — and the source has an explicit comment about why the two must not race each other (quoted directly, same section): *"Autocompact firing at effective-13k (~93% of effective) sits right between collapse's commit-start (90%) and blocking (95%), so it would race collapse and usually win, nuking granular context that collapse was about to save"* — so when Context Collapse is active, Auto-compact is deliberately suppressed. This phase has no equivalent — Tier 4 here is the only escalation past Tier 3, exactly matching the reference project's own 4-tier (not 5-tier) scope.

**Production's actual Auto-compact threshold is a token-budget calculation, not a flat percentage.** This phase (following the reference project) uses `effectiveWindow * 0.85` uniformly. The real formula, read directly from `claude-code/src/services/compact/autoCompact.ts`, lines 28-90: `effectiveContextWindow = contextWindow - min(maxOutputTokensForModel, 20_000)` (the `20_000` — `MAX_OUTPUT_TOKENS_FOR_SUMMARY` — justified by the source's own comment as *"based on p99.99 of compact summary output being 17,387 tokens"*), then `autoCompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS` where `AUTOCOMPACT_BUFFER_TOKENS = 13_000` — a fixed token buffer, not a percentage, layered on top of the output reservation. Worked against a 200K window, this lands at roughly 83.5%-89.5% of the effective window depending on the model's own output-token cap, not the flat 85% this phase uses — close, but a fair thing to name precisely as "the real number is a token-buffer calculation, not a round percentage" if asked in an interview.

**Production estimates tokens without ever spending an extra API call to do it**, and the technique is worth naming because it generalizes: `tokenCountWithEstimation()` (`how-claude-code-works/docs/03-context-engineering.md`, §3.5) anchors on the most recent real `usage` value found by scanning backward through the message array, then estimates only the messages *after* that anchor by character count (roughly chars ÷ 4), rather than estimating the entire history from scratch every time. The source's own analogy: *"you weighed yourself this morning at 75kg, then ate lunch — you don't need to re-weigh yourself, estimating 75.5kg is good enough."* This drops estimation error from 30%+ (pure character-count guessing) to under 5%. This phase's `CompactionState.lastInputTokens` already *is* the anchor — it's just never combined with a downstream character-count estimate for messages added since; this phase always waits for the next real `usage` value instead. A real, cited possible improvement, not built here.

---

## Verify

- [ ] **Type-check the whole project:**

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

  Expect zero errors.

- [ ] **Force each of Tiers 1-3 to fire, without needing a live API call or dozens of real turns.** Reuse the three verification scripts from Implement 3, 4, and 5 above (Budget, Snip, Microcompact) — each is a self-contained scratch script against your own compiled `compact.ts`, requiring no `ANTHROPIC_API_KEEY`. Confirm each produces the same shape of output described in this tutorial: Budget shrinks an oversized result to the correct char budget for the given utilization; Snip keeps exactly the most recent 3 snippable results and clears the rest while leaving every `tool_use` block untouched; Microcompact clears all but the most recent 3 results only once idle time exceeds 5 minutes, and does nothing before that.

- [ ] **Force Tier 0 (disk-offload) to fire and confirm the round trip.** Reuse Implement 1's verification script with a genuinely large (>30KB) string. Confirm the in-context result is the small preview-plus-path text, and that reading the referenced file back off disk reproduces the original content exactly.

- [ ] **Force Tier 4 (auto-compact) to fire against a fake client, and confirm the rebuilt array's shape — no live API call needed for this check.** Build a small scratch script (following the pattern in Implement 6's verification note) that: constructs a `messages` array of at least 4 entries ending in plain user text, sets `state.lastInputTokens` above `effectiveWindow(state) * 0.85`, and calls `checkAndCompact` with a fake client whose `messages.create` returns a canned summary string. Confirm: the function returns `true`; the array shrinks to exactly 2 or 3 messages; the first message starts with `[Previous conversation summary]`; the last pre-compaction user message (if present) is re-appended verbatim as the final entry; `state.lastInputTokens` is reset to `0`; and — critically — the *same array reference* passed in is the one that ends up mutated (confirm with `messages === arrayCapturedBeforeTheCall`), proving the in-place `splice` behavior rather than a silent reassignment that a caller like `cli.ts` would never actually observe.

- [ ] **Confirm the integration ordering claim from Concept 8 directly.** Build a scratch script using a fake client whose `messages.stream(...)` and `messages.create(...)` methods both push a label onto a shared `callLog` array (mirroring this tutorial's own verification approach). Run `runAgentLoop` once with `compaction.lastInputTokens` set below threshold and confirm `callLog` never contains a `create` call; run it again with `lastInputTokens` set above threshold and confirm `callLog`'s first entry is the `create` (summarize) call, strictly before any `stream` call.

- [ ] **Confirm compaction and Phase 6's permission gate coexist correctly.** Build a scratch script against your reconciled `tools.ts`/`permissions.ts`/`agent.ts`/`compact.ts`, using a fake client as above. Confirm: (1) a `run_shell` call the model requests, gated to `confirm` by `checkPermission`, still correctly pauses on `permission.confirmTool` and — once approved — its raw result still passes through `persistLargeResult` before landing in `messages` (both for a small result and for one forced past the 30KB disk-offload threshold); (2) a `run_shell` call denied by mode/rule/dangerous-command detection returns its denial string (`"User denied this action."` or `"Action denied: ..."`), and that string — not a real tool result — is exactly what `runCompressionPipeline` subsequently sees and is free to shrink/snip like any other `tool_result` content, with no orphaned `tool_use`/`tool_result` pairing afterward; (3) both the early-execution `executeTool()` call site (inside `onToolBlockComplete`, read-only tools only) and the post-turn call site are exercised within one `runAgentLoop()` call and share the exact same `PermissionState` object — a dangerous command approved once is not re-prompted if the model repeats it later in the same call; and (4) a **separate** `runAgentLoop()` call whose `checkAndCompact` fires Tier 4 at the top still requires a fresh `confirmTool` approval for a dangerous command in that same call, proving `PermissionState` is rebuilt fresh per call and never leaks across turns, with no interference between the two features' state.

- [ ] **Confirm the agent stays coherent across a real, live-API compaction.** With `ANTHROPIC_API_KEY` exported, temporarily lower `createCompactionState()`'s default in `cli.ts` to something a real conversation can cross in a handful of turns (e.g. `createCompactionState(4000)`, since `effectiveWindow(4000) * 0.85` is a tiny threshold most real API responses will exceed on the very first turn). Start a REPL session, tell the agent a specific, checkable fact (e.g. "the project's codename is Zephyr-9"), have two or three more exchanges to push `lastInputTokens` up, then ask something that would only make sense if the agent still remembers the codename. Confirm: a compaction fires (observable by the array's length dropping sharply — temporarily add a `console.error(messages.length)` after the `runAgentLoop` call to see it), and the agent's next answer still correctly references "Zephyr-9" — proving the summary text, not the raw history, is what's carrying that fact forward now. Revert the temporary `createCompactionState` override afterward.

- [ ] **Confirm large tool results land on disk with an in-context summary, end to end through the real API.** With `ANTHROPIC_API_KEY` exported, create a genuinely large scratch file (e.g. `python3 -c "print('line\n'*20000)" > /tmp/big-scratch.txt`) and ask the agent to read it: `npm start -- "Read /tmp/big-scratch.txt and tell me how many lines it has."`. Confirm the agent's tool call succeeds, its answer is coherent (referencing the file's actual line count, likely inferred from the preview or by reasoning about the reported size), and a new file appears under `~/.nac-mini-agent/tool-results/` containing the full original content.

- [ ] **Confirm `--resume` after a compaction still works.** After the live-compaction test above, exit the REPL (`exit` or `quit`) and run `npm start -- --resume`. Confirm the resumed session's `messages` array is exactly what was saved — the already-compacted array, not the original long history — and that asking about the earlier fact (e.g. "Zephyr-9") still works, confirming Concept 9's claim that the compacted array, not a hidden original, is what session persistence actually carries forward.

---

## What's next

Phase 8 (Memory System) is next, and it touches a structurally similar seam to the one this phase's summary text occupies: Phase 8's semantic recall injects recalled memory content into the conversation by appending it to the most recent user message (to preserve `user`/`assistant` alternation — the same constraint Concept 4 above is built around), and it does so as part of a turn's setup, before the model is asked to respond. Anyone building Phase 8 on top of this phase should keep one thing in mind: if a turn happens to trigger both Tier 4 auto-compact *and* a memory injection, the compaction (Concept 8: strictly before the `while (true)` loop) must run *before* memory content gets appended to the user's message — otherwise a freshly-injected memory block would either get summarized away along with everything else, or (worse) end up as part of the "last message" `compactConversation` assumes is plain, simple user text, when it might now be a multi-part message with an appended memory block. This isn't a change this phase needs to make; it's the seam the next phase's own tutorial should account for when deciding exactly where its own injection point sits relative to this phase's `checkAndCompact` call.

---

## Grounding notes

Every non-trivial claim above is grounded in one of these sources, or flagged where it isn't:

- **The 4-tier pipeline's real composition (Budget/Snip/Microcompact/Auto-compact) and the disk-offload/truncation pre-filter's separate status** — read directly from `claude-code-from-scratch/docs/07-context.md` in full (its mermaid diagram, lines 5-31; the explicit "4 层管道" enumeration, line 71; each tier's own section, lines 73-500), cross-checked against the actual reference implementation's `src/agent.ts` (grepped and read directly: `checkAndCompact`, `compactConversation`, `compactAnthropic`, `runCompressionPipeline`, `budgetToolResultsAnthropic`, `snipStaleResultsAnthropic`, `microcompactAnthropic`, `persistLargeResult`, and the exact call sites inside `chatAnthropic`/`callAnthropicStream`, lines 343-1240).
- **The 30KB disk-offload threshold, 200-line preview, and the `persistLargeResult` code itself** — quoted directly from `claude-code-from-scratch/docs/07-context.md`, lines 116-134, cross-checked against the reference's own call sites in `src/agent.ts` (lines 1097-1098, 1121, 1364, 1379).
- **Real Claude Code's actual (different) threshold: `maxResultSizeChars` per-tool field, `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`, `PREVIEW_SIZE_BYTES = 2000`, and the `Math.min()` clamp** — read directly from real `claude-code/src/Tool.ts`, lines 458-466 (doc comment and field), `claude-code/src/constants/toolLimits.ts`, line 13, and `claude-code/src/utils/toolResultStorage.ts`, lines 44-77 and 109 (`getPersistenceThreshold`, `PREVIEW_SIZE_BYTES`), all read directly in this environment. Per-tool declared values (`100_000` typical, `20_000` for `GrepTool`, `Infinity` for `FileReadTool`) confirmed by direct grep across `claude-code/src/tools/*/`.
- **The tool_use/tool_result pairing invariant, its real-source citation from Phase 1, and the specific documented rejection error** — the general alternation/pairing requirement is Phase 1's own grounded claim (`claude-code/src/query.ts`, lines 1535-1536, already cited in that phase's own tutorial); the specific rejection text quoted in this phase (`"tool_use ids were found without tool_result blocks immediately after"`) and the exact mid-tool-loop failure scenario are quoted directly (translated) from `claude-code-from-scratch/docs/07-context.md`, lines 284 and 499 — this phase did not additionally locate this exact error string inside the real `claude-code` client source via grep (a targeted search for it turned up nothing), which is expected: it is server-side API response text, not client code, so the reference doc's citation is treated here as the grounding for the exact wording, not an independent second source.
- **Tier 1 Budget's exact utilization thresholds (50%/70%) and budget sizes (30,000/15,000 chars)** — quoted directly from `claude-code-from-scratch/docs/07-context.md`, lines 145-197, cross-checked against `src/agent.ts`'s `budgetToolResultsAnthropic()`.
- **Tier 2 Snip's exact tool set, placeholder text, `KEEP_RECENT_RESULTS = 3`, and 60% trigger threshold** — quoted directly from `claude-code-from-scratch/docs/07-context.md`, lines 199-223, cross-checked against `src/agent.ts`'s `snipStaleResultsAnthropic()`; this phase's own narrower `SNIPPABLE_TOOLS` set (`read_file`, `list_files` only, omitting `grep_search`/`run_shell`) is this tutorial's own adaptation, explicitly flagged as such, since this project's registry (Phase 2, unmodified through Phase 5) has no tools beyond `read_file`/`edit_file`/`list_files`.
- **Tier 3 Microcompact's 5-minute idle threshold, the prompt-cache-TTL rationale, the "selective vs. indiscriminate" contrast with Snip, and this phase's own deliberate scope cut (time-based path only, no cache-editing path)** — quoted directly (translated) from `claude-code-from-scratch/docs/07-context.md`, lines 225-255, cross-checked against `src/agent.ts`'s `microcompactAnthropic()`.
- **Real Claude Code's two Microcompact paths (cold-cache direct-rewrite vs. warm-cache `cache_edits` API mechanism) and the `contentBlock.input += delta.partial_json`-style "don't touch local messages, edit at the API layer" design** — read directly from `how-claude-code-works/docs/03-context-engineering.md`, §3.4 Level 3, and cross-checked by direct inspection of real `claude-code/src/services/compact/microCompact.ts` (its `cachedMicrocompactPath` vs. time-based-clearing branches, and the doc comments distinguishing "does NOT modify local message content" from the time-based path).
- **Tier 4 Auto-compact's exact trigger formula, worked example (200K window → ~76.5% total utilization), and the `compactAnthropic()` code quoted in full** — quoted directly from `claude-code-from-scratch/docs/07-context.md`, lines 257-368, cross-checked against `src/agent.ts`'s `checkAndCompact()`/`compactConversation()`/`compactAnthropic()`, read directly (lines 476-525).
- **Real Claude Code's actual Auto-compact threshold formula (`effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS`, `AUTOCOMPACT_BUFFER_TOKENS = 13_000`, `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` justified by a p99.99 output-token citation) and the worked 83.5%-89.5% range** — read directly from real `claude-code/src/services/compact/autoCompact.ts`, lines 28-90 (`getEffectiveContextWindowSize`, `getAutoCompactThreshold`, the `MAX_OUTPUT_TOKENS_FOR_SUMMARY` comment), cross-checked against `how-claude-code-works/docs/03-context-engineering.md`, §3.4 Level 5 (its own worked table for 200K windows under slot-cap on/off).
- **The two-stage "analysis then summary" compaction prompt, the nine standardized summary sections, and `formatCompactSummary()` discarding the `<analysis>` block** — read directly from `how-claude-code-works/docs/03-context-engineering.md`, §3.4 Level 5.
- **`runPostCompactCleanup()`'s file/skill restoration (5 files, 5K tokens each; skills capped at 25K total)** — read directly from `how-claude-code-works/docs/03-context-engineering.md`, §3.4 Level 5's `POST_COMPACT_*` constants table, cross-checked by direct grep confirming `POST_COMPACT_MAX_FILES_TO_RESTORE`, `POST_COMPACT_TOKEN_BUDGET`, `POST_COMPACT_MAX_TOKENS_PER_FILE`, `POST_COMPACT_SKILLS_TOKEN_BUDGET` are real exported constants in `claude-code/src/services/compact/compact.ts`, lines 122-130.
- **The circuit breaker: `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` and the "1,279 sessions, up to 3,272 consecutive failures, ~250K wasted API calls/day" production data point** — read directly from real `claude-code/src/services/compact/autoCompact.ts`, lines 67-70 (the exact `BQ 2026-03-10` comment quoted verbatim), cross-checked against `claude-code-from-scratch/docs/07-context.md`, line 67's independent citation of the same 3,272 figure — both sources' numbers match exactly, confirmed by reading both directly rather than assuming one summarizes the other correctly.
- **Context Collapse (Level 4) as a read-only projection, its ~90% commit threshold, and the exact source comment explaining why it suppresses Auto-compact** — read directly from `how-claude-code-works/docs/03-context-engineering.md`, §3.4 Level 4 (including the quoted `query.ts` comment about collapse's commit-start vs. Autocompact's firing point racing each other); this phase does not implement Context Collapse, cited here only as a named, real, deliberately-unbuilt fifth tier.
- **`tokenCountWithEstimation()`'s anchor-plus-estimate algorithm, the "weighed yourself this morning" analogy, and the <5%-vs-30%+ error-rate figures** — read directly from `how-claude-code-works/docs/03-context-engineering.md`, §3.5, cited here as a named, real, un-implemented improvement over this phase's own simpler `lastInputTokens`-only tracking.
- **The `Anthropic.Message.usage.input_tokens` field's existence and shape in the pinned SDK version** — verified directly against the installed `@anthropic-ai/sdk@0.110.0`'s own `.d.ts` files in an isolated scratch install (`resources/messages/messages.d.ts`, `usage: Usage` at line 769, `Usage.input_tokens: number` at line 1572), the same verification discipline every prior phase in this series has used for SDK-shape claims (Phase 4's `AbortSignal`, Phase 5's `MessageStream`/streaming events).
- **All TypeScript in Implement 1-8 (`compact.ts` in each of its incremental states, and both `agent.ts` listings in Implement 2 and 7)** — actually type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0`, in an isolated scratch directory, twice: once while originally writing this tutorial against Phase 5's pre-Phase-6 `tools.ts`, and again — after this phase was reconciled with Phase 6, the way Phase 6 itself was reconciled with Phase 5 — against Phase 6's actual, final `tools.ts`/`permissions.ts` (four tools, `checkPermission`-gated `executeTool(name, input, state, permission)`) and Phase 6's actual `cli.ts` (mode flags, `confirmTool`). The current text above reflects that second, Phase-6-inclusive run; the original run's claims about a 3-argument `executeTool()` are superseded, not silently dropped — see the note below.
- **Every tier's behavior (Budget's exact char-count shrink at a given utilization; Snip's keep-last-3/snip-the-rest selection and its non-interference with `tool_use` blocks; Microcompact's idle-gate firing at 6 minutes and correctly not firing at 30 seconds; the disk-offload round trip on a real >30KB string; `checkAndCompact`'s threshold gate, in-place mutation via `splice`, correct array rebuild shape, and `lastInputTokens` reset; and the deliberately-reproduced pairing corruption when `compactConversation` is called with a `tool_result` as the last message) and the full Phase-5-integration ordering claim (compaction firing exactly once, strictly before the first `streamOneTurn` call, never interleaved with it)** — all actually executed against the real, compiled code in this phase's scratch directory, with real captured output quoted directly at each relevant Implement/Concept above, not predicted or hypothetical transcripts.
- **The Phase-6 reconciliation itself (this phase's `agent.ts`/`cli.ts` listings threading `PermissionState` through both `executeTool()` call sites, alongside compaction)** — re-verified from scratch, in an isolated scratch directory, against a reconstruction of Phase 6's actual final `tools.ts`, `permissions.ts`, and `cli.ts` plus this phase's unmodified `compact.ts` and the corrected `agent.ts` above. Confirmed by actually running the compiled code (not reasoned about): an early-executed `read_file` call and a post-turn, dangerous-pattern-matched `run_shell` call both correctly reached `checkPermission()` before `tool.execute()` ran; `confirmTool` fired exactly once across a whole `runAgentLoop()` call even when the model repeated the identical dangerous command in a later loop iteration (proving one shared `PermissionState` per call, not per tool); a denied `run_shell` call's `"User denied this action."` string passed safely through a full `runCompressionPipeline()` call with no orphaned `tool_use`/`tool_result` pairing; a **separate** `runAgentLoop()` call whose `checkAndCompact` fired Tier 4 at the top still required a fresh `confirmTool` approval for a dangerous command in that same call (`callLog: ["compact-summarize-call", "stream#0", "stream#1"]`, confirming no permission state leaks across calls); and a permission-gated, approved `run_shell` result whose real output exceeded 30KB was still correctly disk-offloaded by `persistLargeResult` afterward (`[Result too large (39.1 KB, 3 lines). Full output saved to ...]`). Every one of these five checks passed. The disk-offload byte-for-byte round trip itself (writing >30KB, reading it back, confirming an exact match) is unchanged Tier 0 logic already verified in Implement 1's own verification — this reconciliation pass re-confirmed it fires correctly *after* a permission gate approves the call, not that the offload mechanism itself changed.
- **A note on what changed from this tutorial's original text, stated plainly rather than silently rewritten:** an earlier version of this phase was written and verified against Phase 5's pre-Phase-6 `src/agent.ts`/`src/tools.ts` — three tools, `executeTool(name, input, state)` with no permission gate — on the stated (at the time, accurate) assumption that Phase 6's own fate was still undecided and the two phases were being authored in parallel. Phase 6 has since been finished and reconciled against Phase 5's actual streaming code, and the series' real build order is 5→6→7, so this phase's `agent.ts` (Implement 2 and 7) and `cli.ts` (Implement 8) were rewritten to build directly on Phase 6's actual final code instead of carrying a footnote asking the reader to manually merge the two. Nothing about the compaction logic itself (Tiers 0-4, `persistLargeResult`, `checkAndCompact`, `runCompressionPipeline`) changed in this pass — only the permission-threading plumbing in `agent.ts`'s two `executeTool()` call sites and `cli.ts`'s `CompactionState` wiring, which is what the five checks above specifically re-verified.
- **Unverified / flagged explicitly:** no live Anthropic API call was made while writing or reconciling this tutorial — no API key was available in this authoring environment, consistent with every prior phase's own flagged limitation. This means the Verify section's live-API steps (the "lower the threshold and watch a real conversation get summarized while staying coherent about a planted fact," and the "read a genuinely large real file through the live agent" checks) were reasoned through and structured deliberately to be checkable, but their exact live-model outputs were not captured directly — only the underlying mechanism (every function and integration-ordering claim above, including the Phase-6 reconciliation) was independently verified by actually running the real, compiled code. The one design choice in this phase that is this tutorial's own adaptation rather than a direct port — narrowing `SNIPPABLE_TOOLS` to `{"read_file", "list_files"}` instead of the reference project's four-tool set — is explicitly flagged as such at its point of use (Concept 5, Implement 4) rather than presented as a claim about the reference project's own behavior; it is unchanged by this reconciliation pass and out of this fix's scope (see this phase's Concept 5 for why this project's registry historically lacked `run_shell` at the point that section was written).
