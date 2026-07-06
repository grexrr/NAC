# Phase 4: CLI & Sessions

> Series: Mini-Claude-Code Learning Plan — see [`../phase-breakdown.md`](../phase-breakdown.md) for full context.
> **Prerequisites:** [`phase-01-agent-loop.md`](phase-01-agent-loop.md), [`phase-02-tool-system.md`](phase-02-tool-system.md), [`phase-03-system-prompt.md`](phase-03-system-prompt.md). This phase builds directly on top of the exact file state Phase 3 left behind — read all three first if you haven't. Phase 5 (Streaming) builds directly on top of what this phase produces.

## Goal

Every phase so far has been building the engine — the loop, the tools, the prompt — and running it exactly once per process invocation, through `index.ts`'s throwaway one-shot scaffolding. By the end of this phase, `index.ts` is no longer where the interesting code lives: a new `src/cli.ts` holds a real interactive REPL that reads from stdin in a loop, feeds each line into `runAgentLoop` while growing the *same* `messages` array turn after turn, and handles Ctrl+C without corrupting that array or leaving the terminal broken. A new `src/session.ts` persists that array to disk after every turn and can reload it via a `--resume` flag, so a conversation survives past the process that started it.

Two things make this phase different in character from Phases 1–3: it's the first phase that touches process-level concerns (signals, stdin, the filesystem outside the project tree) rather than pure request/response logic, and it's the first phase that requires a small, deliberate modification to `agent.ts` itself — not a rewrite, one new optional field — because clean interrupt handling is impossible without it (Concept 1 explains exactly why and exactly how small that change is).

## Why this is interview material

"How would you make an LLM agent interruptible without corrupting its state" is a question that separates people who've only called `chat.completions.create()` in a script from people who've built something that has to run for minutes at a time with a human watching. The honest answer has two load-bearing parts, both of which this phase makes you build and verify, not just assert: (1) an `AbortController`/`AbortSignal` wired all the way into the one HTTP call that can actually block for a long time, and (2) a data model where "interrupted mid-turn" and "completed successfully" are indistinguishable failure states for the thing that matters — the array never has a chance to end up half-written, because nothing is appended to it until the operation that produces the append has actually succeeded. That second part is not new machinery this phase invents; it's a direct, verifiable payoff of the append-only design Phase 1 built for an entirely different reason (statelessness — Phase 1, Concept 3).

Session persistence is worth being able to describe in exactly one sentence, because interviewers will probe whether you're overcomplicating it: it's serializing the same `messages: AgentMessage[]` array that's been the whole agent's memory since Phase 1, plus a few lines of metadata, to a JSON file — nothing more. There's no separate "session state" object anywhere in this design, because there was never anything to serialize other than the array that already existed.

---

## Files

This phase creates two new files and modifies two files Phase 3 left behind. `src/tools.ts` and `src/prompt.ts` are **not modified at all**.

- `src/agent.ts` **(modified)** — adds one new optional field, `signal?: AbortSignal`, to `RunAgentLoopOptions`, and threads it into `client.messages.create()`'s second argument. Nothing else changes: same loop shape, same stopping condition, same `messages.push` calls, same tool-dispatch call site.
- `src/session.ts` **(new)** — `SessionMetadata`/`SessionData` types, `saveSession`, `loadSession`, `listSessions`, `getLatestSessionId`. A small, pure I/O module with no dependency on `agent.ts`'s runtime behavior beyond the `AgentMessage` type.
- `src/cli.ts` **(new)** — `parseArgs`, the REPL (`runRepl`, with SIGINT handling and the one `runAgentLoop` call site), and `main()`, which dispatches to one-shot mode or REPL mode and handles `--resume`.
- `src/index.ts` **(modified)** — shrinks to a two-line shim that imports and calls `cli.ts`'s `main()`. `npm start` (`tsx src/index.ts`) keeps working unchanged.

---

## Concept 1: Ctrl+C has two jobs, and getting the first one wrong corrupts your data

### What actually needs to happen

An agent loop can be "busy" in exactly one way that takes real wall-clock time: waiting on `await client.messages.create(...)`, which can legitimately take many seconds for a long response. (Tool execution in this project, per Phase 2, is synchronous `fs` calls — `readFileSync`, `writeFileSync`, `statSync` — that complete in microseconds; there is no meaningful "interrupt mid tool-execution" to build yet, because nothing in this registry runs long enough to need it. Phase 5's parallel execution and any future shell-execution tool are where that would start to matter.) So the concrete engineering problem is: give the user a way to cancel that one `await` without leaving `messages` in a state the next API call would reject.

The mechanism is the standard one for cancelling any in-flight Promise-based operation in Node: an `AbortController`, whose `.signal` gets threaded through to the operation that can observe it. The Anthropic SDK supports this natively — verified directly against the installed package's own type declarations, not assumed from memory:

```typescript
// verified directly — @anthropic-ai/sdk's own .d.ts files
// resources/messages/messages.d.ts:
create(params: MessageCreateParamsNonStreaming, options?: RequestOptions): APIPromise<Message>;
// internal/request-options.d.ts:
export type RequestOptions = {
  // ...
  signal?: AbortSignal | undefined | null;
};
```

`client.messages.create()` takes the request body as its first argument and a second, optional `RequestOptions` argument — `signal` lives there, not in the request body. This phase's one necessary change to `agent.ts` is threading a `signal?: AbortSignal` from `RunAgentLoopOptions` into that second argument.

**What actually happens when you abort it, verified by actually calling it**, not assumed:

```typescript
// run directly in an isolated scratch project against the real, installed SDK
const client = new Anthropic({ apiKey: "sk-ant-fake-key-for-abort-test" });
const controller = new AbortController();
controller.abort();
try {
  await client.messages.create(
    { model: "claude-opus-4-8", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    { signal: controller.signal }
  );
} catch (e) {
  console.log(e instanceof Anthropic.APIUserAbortError); // → true
}
```

Real captured output: `caught error, name: Error message: Request was aborted.` and, checking more precisely, `instanceof APIUserAbortError: true`. That's the exact, real error class (`Anthropic.APIUserAbortError`, exported from `core/error.d.ts`) this phase's catch blocks check for — not a string comparison against `e.name === "AbortError"` (which is what Node's own DOM-style `AbortController` throws for *unrelated* fetch aborts, and is a fragile, easy-to-get-wrong check for this specific SDK's actual behavior). This is a meaningful, deliberate improvement over the reference project's own equivalent check (`e.name !== "AbortError" && !e.message?.includes("aborted")` — `claude-code-from-scratch/src/cli.ts`, line 267, a string-matching heuristic): the real SDK gives you a proper class to `instanceof`-check, so this tutorial uses it.

### Why the `messages` array can never end up half-written

This is the property worth being able to prove, not just assert, in an interview. Look at where `messages.push(...)` calls sit relative to `await` points inside `runAgentLoop` (unchanged since Phase 1): every push happens **after** the `await` that could throw, never before or during it. Concretely, there are exactly two places aborting can interrupt a turn:

1. **During the `await client.messages.create(...)` call itself.** If the signal fires here, the call rejects with `APIUserAbortError` before its result is available — so the `messages.push({ role: "assistant", ... })` on the next line never executes. `messages` is left exactly as it was before this turn started.
2. **During tool execution** (the `for` loop calling `executeTool` after a `tool_use` response comes back). Aborting here does *nothing* immediately — `executeTool` doesn't accept or check a signal, and Node can't preempt synchronous `fs` calls mid-syscall anyway. The `for` loop runs to completion, `messages.push({ role: "user", content: toolResults })` executes normally, completing that turn's assistant/tool-result pair — and *only then*, on the next iteration's `client.messages.create(...)` call, does the already-aborted signal cause an immediate rejection (verified above: a pre-aborted signal rejects before any network I/O happens).

In both cases, the array ends up in one of exactly two states: unchanged from before the turn started, or with a fully-formed, valid assistant/tool-result pair appended. There is no third, half-written state — not because of extra guard code this phase adds, but because `runAgentLoop`'s existing structure (from Phase 1) never had a code path that pushes half of a pair. This was verified directly, not just reasoned about: a scratch script that fakes a client returning a `tool_use` response, aborts the controller *during* the subsequent tool-execution loop, and lets the second `create()` call observe the already-aborted signal produced exactly this outcome — `messages.length === 3` (`user`, `assistant` with the `tool_use`, `user` with the matching `tool_result`), a fully valid, resumable array, with the abort only actually terminating the loop at the start of the *next* turn's API call.

### The two-tier UX: idle vs. mid-turn

A single Ctrl+C should never destroy an entire multi-turn conversation by accident, but it also shouldn't take two presses to escape a runaway tool loop. The reference implementation's convention (`claude-code-from-scratch/src/cli.ts`, lines 157–173, and its own explanatory text in `docs/04-cli-session.md`) resolves this with one flag and one counter:

```typescript
// claude-code-from-scratch/src/cli.ts — real source, quoted directly
let sigintCount = 0;
process.on("SIGINT", () => {
  if (agent.isProcessing) {
    agent.abort();
    console.log("\n  (interrupted)");
    sigintCount = 0;
    printUserPrompt();
  } else {
    sigintCount++;
    if (sigintCount >= 2) { console.log("\nBye!\n"); process.exit(0); }
    console.log("\n  Press Ctrl+C again to exit.");
    printUserPrompt();
  }
});
```

`agent.isProcessing` in the reference implementation is not a separate boolean — it's a getter over the same `AbortController` used for cancellation: `private abortController: AbortController | null = null`, set to a fresh controller at the start of `chat()`, reset to `null` in a `finally` block after (`claude-code-from-scratch/src/agent.ts`, lines 176, 289–294, 357, 365, read directly — `get isProcessing(): boolean { return this.abortController !== null; }`). One variable answers both "is there something to abort" and "is the REPL busy right now" — there's no second flag to keep in sync with the first. This phase's `cli.ts` (no `Agent` class exists in this project's design, so the variable lives directly in `runRepl`'s closure) uses the identical pattern: `currentController: AbortController | null`.

**First press while a turn is in flight → interrupt that turn, stay in the REPL.** **First press while idle → warning. Second press while still idle → exit.** This is deliberately *not* a symmetrical "any two presses within N seconds always exits" rule — the first press's meaning depends entirely on whether the agent is busy, which is exactly why `sigintCount` gets reset to `0` the moment a turn starts being interrupted (so a rapid interrupt-then-immediately-hit-Ctrl+C-again-out-of-habit doesn't accidentally count as the "second press to exit").

**Real Claude Code's actual convention is stricter, and worth citing precisely as the production refinement this tutorial doesn't build.** Its double-press logic lives in a small, focused hook, not inline in the entrypoint — read directly from `claude-code/src/hooks/useDoublePress.ts` and `claude-code/src/hooks/useExitOnCtrlCD.ts`:

```typescript
// abridged real-source excerpt — claude-code/src/hooks/useDoublePress.ts
export const DOUBLE_PRESS_TIMEOUT_MS = 800

export function useDoublePress(setPending, onDoublePress, onFirstPress?) {
  // ...
  const isDoublePress =
    timeSinceLastPress <= DOUBLE_PRESS_TIMEOUT_MS && timeoutRef.current !== undefined
  if (isDoublePress) { onDoublePress() } else { onFirstPress?.(); setPending(true) /* + a timer that clears pending after 800ms */ }
}
```

The doc comment on `useExitOnCtrlCD.ts` states the reasoning directly: *"We use time-based double-press rather than the chord system because we want the first ctrl+c to also trigger interrupt (handled elsewhere)."* Real Claude Code requires the second Ctrl+C within a strict 800ms window — an idle warning that's still on screen from ten seconds ago no longer counts, so an absent-minded second Ctrl+C much later doesn't silently exit a session you'd forgotten you left open. This phase's REPL (and the reference project it follows) instead treats "next SIGINT while idle, before any line is submitted" as the second press with **no timeout** — simpler to build, and the tradeoff it accepts is exactly the one the timeout exists to prevent. This is flagged here as a deliberate, cited scope simplification, not an oversight, in keeping with this series' established practice (Phase 2, Concept 5; Phase 3, Concept 5).

**One more honest, verified detail: the prompt reprints twice on interrupt, and that's expected, not a bug.** The SIGINT handler calls `printPrompt()` immediately and synchronously (for perceived responsiveness — the user sees *something* happen the instant they press Ctrl+C, before the aborted promise has even finished unwinding). Separately, once the aborted `runAgentLoop` promise actually rejects, the pending line-handler's `catch`/`finally` runs and calls `askQuestion()` again, which prints the prompt a second time. Both prints are real and both fire — this is a direct, traceable consequence of the reference implementation's own structure (not something this tutorial introduces), and it's harmless: a doubled `> ` on screen, not a functional bug.

---

## Implement 1: Give `runAgentLoop` an abort seam

This is the one necessary change to `agent.ts`. Everything else this phase builds is new files.

- [ ] Replace `src/agent.ts` with this (complete file, replacing Phase 3's version — the only differences from Phase 3 are the new `signal?: AbortSignal` field and the `{ signal }` second argument to `client.messages.create()`):

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
    signal?: AbortSignal;
  }

  /**
   * The agent loop. Unchanged in shape since Phase 1: call the model, check
   * whether it asked for any tools, execute them if so, append the
   * assistant message and the tool-result message, and repeat. Stops the
   * moment a response comes back with zero tool_use blocks.
   *
   * New in this phase: an optional AbortSignal, threaded into the one
   * operation in this loop that can actually block for a long time —
   * client.messages.create(). If the caller's controller aborts while this
   * call is in flight, it rejects with Anthropic.APIUserAbortError before
   * response.content is ever produced, so the messages.push() below it
   * never runs. If the caller aborts while tool execution is in progress
   * instead, nothing observes that until the *next* iteration's
   * messages.create() call, which rejects immediately because the signal
   * is already aborted — by which point the current turn's
   * assistant/tool-result pair has already been pushed in full. Either way,
   * messages is left in a fully valid state: unchanged, or one complete
   * pair longer. There is no path that pushes half of a pair (see Phase 4
   * tutorial, Concept 1, for the verified proof of this).
   *
   * Mutates and returns the same messages array that was passed in, so
   * the caller retains the full conversation history afterward.
   */
  export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions
  ): Promise<AgentMessage[]> {
    const { client, model, systemPrompt, tools, maxTokens = 1024, signal } = options;

    const readFileState: ReadFileState = new Map();

    while (true) {
      const response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          tools,
          messages,
        },
        { signal }
      );

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

- [ ] Confirm the diff against Phase 3's version is exactly what's described above — nothing else moved:

  ```bash
  cd /Users/grexrr/Documents/NAC
  git diff src/agent.ts
  ```

  Expect to see only: the new `signal?: AbortSignal;` line in `RunAgentLoopOptions`, `signal` added to the destructure, and the request body/`{ signal }` split in the `client.messages.create(...)` call. The `while (true)` shape, the `toolUses.length === 0` check, and both `messages.push` calls are byte-for-byte unchanged from Phase 3.

This was verified to type-check (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk` in an isolated scratch directory, alongside Phase 2's `tools.ts` and Phase 3's `prompt.ts` unmodified. It was also verified at runtime, twice, in the same scratch directory: once confirming a pre-aborted signal causes `client.messages.create` to reject with `Anthropic.APIUserAbortError` while `messages` stays at its original length (the "abort during the API call" case), and once with a fake client simulating a `tool_use` response — confirming that aborting *during* the subsequent tool-execution loop still lets that turn's assistant/tool-result pair finish pushing in full, with the abort only actually taking effect on the *next* iteration's `messages.create()` call. Both are the exact scenarios Concept 1 describes, not hypothetical ones.

---

## Concept 2: Session persistence is serializing the array you already have

### What actually needs to be saved

Resist the urge to design a rich "session" object. Walk backward from what `--resume` needs to reconstruct: a REPL that can pick up a prior conversation needs exactly the `messages: AgentMessage[]` array (Phase 1's memory, unchanged) and enough metadata to find and label that file later (an id, when it started, which model it used, how many messages it has). It does **not** need the composed system prompt saved alongside it. Phase 3's own closing note is explicit about why: *"`buildSystemPrompt()` is already called fresh on every `main()` invocation... that's exactly the shape Phase 4's REPL needs: call it once per new session... not once at process startup and never again."* Environment facts (cwd, date, git branch) and `CLAUDE.md` content are read fresh from disk every time `buildSystemPrompt()` runs (Phase 3, Concept 6) — freezing yesterday's git branch into a saved session and resurrecting it verbatim on resume would be actively wrong, not merely redundant. `--resume` restores the `messages` array only; the system prompt for the resumed conversation is a brand-new `buildSystemPrompt()` call reflecting *today's* environment, exactly like every other call to it in this series.

### The shape, adapted from the reference implementation

`claude-code-from-scratch/src/session.ts` (read directly, 64 lines total) stores `anthropicMessages?: any[]` and `openaiMessages?: any[]` side by side, because that project supports two API backends. This project is Anthropic-only (a fixed architecture decision from Phase 1 onward), so there's exactly one messages field, not two:

```typescript
// adapted from claude-code-from-scratch/src/session.ts
export interface SessionMetadata {
  id: string;
  model: string;
  cwd: string;
  startTime: string;
  messageCount: number;
}

export interface SessionData {
  metadata: SessionMetadata;
  messages: AgentMessage[];
}
```

Session files live at `~/.nac-mini-agent/sessions/<id>.json` (adapted from the reference's `~/.mini-claude/sessions/`), one whole-JSON file per session, overwritten on every save — `writeFileSync(path, JSON.stringify(data, null, 2))`, exactly mirroring `saveSession()` in the reference (`claude-code-from-scratch/src/session.ts`, lines 25–31). The session id itself is a short random string, `randomUUID().slice(0, 8)` — the exact expression used in the reference's `agent.ts` constructor (`claude-code-from-scratch/src/agent.ts`, line 224) — not a full UUID, since it only needs to be unique enough to not collide across sessions on one machine and short enough to read and type comfortably (e.g. when eyeballing `ls ~/.nac-mini-agent/sessions/`).

### Whole-file JSON vs. JSONL — a real tradeoff this phase deliberately keeps simple

Real Claude Code does **not** use whole-file overwrite for its own session storage — it appends one JSON object per line to a `.jsonl` file, verified directly in the real source:

```typescript
// abridged real-source excerpt — claude-code/src/utils/sessionStorage.ts, ~line 2570
function appendEntryToFile(fullPath: string, entry: Record<string, unknown>): void {
  const fs = getFsImplementation();
  const line = jsonStringify(entry) + '\n';
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 });
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 });
    fs.appendFileSync(fullPath, line, { mode: 0o600 });
  }
}
```

The reasoning, stated directly in the reference project's own chapter (`claude-code-from-scratch/docs/04-cli-session.md`): whole-file JSON has two real problems at production scale — a crash mid-write can corrupt the *entire* file (not just the latest entry), and every save re-serializes and re-writes the *whole* conversation, which gets slower as a conversation grows longer. Appending one line per turn is O(1) per save regardless of history length, and a crash mid-append can corrupt at most the last, incomplete line — trivial to detect and skip on load (any line that fails `JSON.parse` gets discarded rather than failing the whole read).

This phase deliberately keeps the reference project's own **simplified** choice — whole-file overwrite, not JSONL — for the same reason Phase 2 skipped deferred tool loading and Phase 3 skipped prompt-caching boundaries: the problem JSONL solves (large conversations, crash-safety at scale) isn't a problem a single-user tutorial project with conversations measured in tens of turns actually has yet, and building the appended-line format, tail-truncation-repair logic, and file-growth management to solve it now would be solving a problem you don't have. If you ever do hit that wall — very long-running sessions, or a real crash-safety requirement — `appendEntryToFile`'s shape above is exactly where to start.

### Saving after every turn, including interrupted ones — a deliberate, small improvement over the reference

The reference implementation's autosave only runs after a **successful** `chat()` call completes (`claude-code-from-scratch/src/agent.ts`, lines 367–370: `printDivider(); this.autoSave();` sit *after* the `try/finally` that resets `abortController`, meaning an aborted or thrown turn skips both lines entirely — the exception propagates straight out of `chat()` to the REPL's own `catch`). This phase's `cli.ts` makes a different, deliberate choice: call `saveSession(...)` from inside a `finally` block that wraps the `runAgentLoop` call, so it runs whether the turn completed, errored, or was interrupted. This is safe specifically *because* of the property proved in Concept 1 — `messages` is always left in a valid, resumable state after an aborted turn, never a half-written one — so there's no reason to withhold a save that would otherwise be perfectly safe to make. Skipping the save after an interrupted turn (the reference's behavior) isn't wrong, it just leaves slightly more work un-persisted than necessary if the user exits right after an interrupt; saving unconditionally captures strictly more of the conversation with no added risk.

---

## Implement 2: Session persistence — `src/session.ts`

A small, pure I/O module: no dependency on `agent.ts`'s runtime behavior, `client`, or the network — only on the `AgentMessage` type, so this is testable without an API key exactly the way Phase 2's `tools.ts` was.

- [ ] Create `src/session.ts` with this content (complete file):

  ```typescript
  import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
  import { join } from "node:path";
  import { homedir } from "node:os";
  import type { AgentMessage } from "./agent.js";

  const SESSION_DIR = join(homedir(), ".nac-mini-agent", "sessions");

  /**
   * Everything needed to find and label a saved session later, without
   * having to load and parse its full messages array. Deliberately does
   * NOT include the composed system prompt — buildSystemPrompt() is always
   * called fresh at REPL startup, resume or not (Phase 3's own closing
   * note: environment facts and CLAUDE.md content should reflect *today*,
   * not the day the session was first saved).
   */
  export interface SessionMetadata {
    id: string;
    model: string;
    cwd: string;
    startTime: string;
    messageCount: number;
  }

  /**
   * What actually gets written to disk. `messages` is the exact same
   * AgentMessage[] array that has been the agent's entire memory since
   * Phase 1, Concept 3 — this module adds no new state, only a place to
   * put the state that already existed.
   */
  export interface SessionData {
    metadata: SessionMetadata;
    messages: AgentMessage[];
  }

  function ensureDir(): void {
    if (!existsSync(SESSION_DIR)) {
      mkdirSync(SESSION_DIR, { recursive: true });
    }
  }

  /**
   * Whole-file overwrite, not an append-only log. Real Claude Code appends
   * one JSON object per line to a .jsonl file instead (crash-safe, O(1) per
   * save regardless of conversation length — see Phase 4 tutorial,
   * Concept 2) — a real, cited production refinement this phase
   * deliberately doesn't build, because a tutorial-scale conversation
   * doesn't have the problem JSONL exists to solve yet.
   */
  export function saveSession(id: string, data: SessionData): void {
    ensureDir();
    writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2));
  }

  export function loadSession(id: string): SessionData | null {
    const file = join(SESSION_DIR, `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as SessionData;
    } catch {
      return null;
    }
  }

  export function listSessions(): SessionMetadata[] {
    ensureDir();
    const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
    const metas: SessionMetadata[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSION_DIR, file), "utf-8")) as SessionData;
        metas.push(data.metadata);
      } catch {
        // Skip a corrupted or partially-written session file rather than
        // failing the whole listing — the same "errors are data, don't
        // crash the whole operation" instinct Phase 2 established for
        // tool execution (Phase 2, Concept 2), applied here to a listing
        // instead of a single tool call.
      }
    }
    return metas;
  }

  export function getLatestSessionId(): string | null {
    const sessions = listSessions();
    if (sessions.length === 0) return null;
    sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
    return sessions[0].id;
  }
  ```

- [ ] Verify the round trip directly, without needing `ANTHROPIC_API_KEY` or touching `cli.ts` at all — this module has no dependency on either:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/session.js').then(async (m) => {
    const id = 'smoketest';
    m.saveSession(id, {
      metadata: { id, model: 'claude-opus-4-8', cwd: process.cwd(), startTime: new Date().toISOString(), messageCount: 2 },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    console.log('loadSession:', JSON.stringify(m.loadSession(id)));
    console.log('getLatestSessionId:', m.getLatestSessionId());
    console.log('loadSession(missing):', m.loadSession('does-not-exist'));
  });
  "
  ```

  This exact round trip (save, load back, list, resolve the latest, and confirm a missing id returns `null` rather than throwing) was actually executed against this code in an isolated scratch directory while writing this tutorial — real output, not a predicted transcript:

  ```
  loadSession: {"metadata":{"id":"smoketest","model":"claude-opus-4-8","cwd":"/tmp/proj","startTime":"2026-07-04T03:07:33.982Z","messageCount":2},"messages":[{"role":"user","content":"hi"},{"role":"assistant","content":[{"type":"text","text":"hello"}]}]}
  getLatestSessionId: smoketest
  loadSession(missing): null
  ```

- [ ] Clean up the smoke-test session file once you've confirmed the output (it lives outside the project directory, so it won't show up in `git status`):

  ```bash
  rm -f ~/.nac-mini-agent/sessions/smoketest.json
  ```

---

## Concept 3: Multi-turn is "call `runAgentLoop` again," not a new mechanism

Here is the entire reason this phase is possible without inventing a "conversation" abstraction: `runAgentLoop` already takes a `messages: AgentMessage[]` array, mutates it in place, and returns it (Phase 1, Concept 3; unchanged through Phase 3). A REPL's job, reduced to its essence, is:

```
read one line from the user
push it onto messages as a user message
call runAgentLoop(messages, options)   // mutates messages further, returns it
print the assistant's final answer
go back to the first line, with the SAME messages array
```

There is no new data structure for "the conversation" — the array *is* the conversation, exactly as Phase 1 argued, and it was already fully general enough to grow across an unbounded number of turns before this phase started. Phases 1–3 only ever called `runAgentLoop` once per process because `index.ts` only ever ran once and exited; nothing about `runAgentLoop`'s own design assumed that. This phase's REPL is a `while`-style loop *outside* `runAgentLoop`, calling it repeatedly with the array it keeps growing — not a modification to the loop itself. `agent.ts`'s internal `while (true)` loop still means exactly what it meant in Phase 1: "keep going within a single turn until the model stops asking for tools." The REPL's loop is a different, outer loop: "keep going across turns until the human stops typing." These are two nested loops with two different stopping conditions, and conflating them is the most common way people over-design this — you do not need `runAgentLoop` to know anything about turns, prompts, or REPL state. It takes an array and options in, returns a (longer) array out. Every single call in this phase's REPL looks identical from `runAgentLoop`'s point of view to the one call Phase 1's `index.ts` made.

---

## Concept 4: What this phase intentionally does not build

Real Claude Code's actual entry point (`claude-code/src/entrypoints/cli.tsx`, 302 lines) and its actual interactive screen (`claude-code/src/screens/REPL.tsx`, ~5,000 lines) are built on React and Ink — a component-based rendering model for the terminal, supporting streaming Markdown, live-updating tool-call widgets, a Vim mode, multi-tab sessions, and fully rebindable keyboard chords (`claude-code/src/keybindings/`). This is a real, deliberate production investment: `claude-code-from-scratch/docs/04-cli-session.md` explains the "why terminal-native at all" choice (an agent embeds into a developer's existing terminal workflow the same way `git` or `grep` does, works over SSH, composes with pipes, and costs near-zero memory versus a browser tab) and separately explains what Ink specifically buys on top of that (`"React/Ink 的作用是弥补终端的交互限制——有了组件模型，流式输出、diff 视图这类复杂 UI 才变得可维护"` — "React/Ink's role is to compensate for the terminal's interaction limits — with a component model, complex UI like streaming output and diff views becomes maintainable").

This phase's `cli.ts` uses Node's built-in `readline` module and plain `console.log` — no Ink, no React, no component model, no live-updating widgets. This is not a simplified stand-in for Ink; it's a plain-TypeScript REPL that reads a line, prints a result, and repeats, which is a genuinely different (and genuinely simpler) way to build a terminal UI. The Ink-based rich-terminal-UI layer is a real, production-grade concern — streaming token-by-token render updates, live tool-call progress indicators, colorized diffs — that is explicitly out of scope for this build, consistent with this tutorial series' own scoping (Phase 5 introduces token-by-token *streaming* at the API layer, which is a prerequisite for that kind of UI, but does not itself build the UI). If you want colorized, formatted output later, the reference project's `ui.ts` module (using `chalk`) is the natural next step — it is not built in this phase.

---

## Concept 5: Two run modes, and where `cli.ts` sits relative to `index.ts`

The reference project's `cli.ts` (`claude-code-from-scratch/src/cli.ts`) is itself the executable — it has a `#!/usr/bin/env node` shebang and is the file `package.json`'s `"bin"` field points at. Its `main()` branches on whether a prompt was supplied as a positional CLI argument:

```typescript
// claude-code-from-scratch/src/cli.ts — real source (abridged), quoted directly
if (prompt) {
  await agent.chat(prompt);       // 单次模式：执行后退出 (one-shot: run once, exit)
} else {
  await runRepl(agent);           // REPL 模式：交互循环 (REPL: interactive loop)
}
```

This project's `package.json` has pointed `npm start` at `tsx src/index.ts` since Phase 1 — changing that script isn't the point of this phase, and there's no reason to force a rename just to match the reference file-for-file. So this phase keeps that seam intentionally thin instead: **`src/cli.ts` holds all the real logic** (`parseArgs`, `runRepl`, `main`), mirroring the reference project's actual module split, and **`src/index.ts` shrinks to a two-line shim** that imports and calls `cli.ts`'s `main()`. `npm start` keeps working unchanged; the REPL, the interrupt handling, and the session logic all live in the one file that's actually meaningful to read.

Both run modes stay, adapted directly from the reference's dispatch: **a positional prompt argument → one-shot mode** (push it onto `messages`, call `runAgentLoop` exactly once, print the answer, save, exit — this is almost exactly what `index.ts` already did in Phases 1–3, just now living in `cli.ts` and folded into `--resume`-aware session handling), **no prompt → REPL mode** (the interactive loop this phase's Concepts 1–3 describe). `--resume` composes with either: it reloads a prior `messages` array before either mode starts, so `--resume "one more thing"` (continue a saved conversation for exactly one more turn, non-interactively) and bare `--resume` (continue it interactively) are both meaningful, supported combinations.

---

## Implement 3: The REPL — `src/cli.ts`

This is where Concept 1 (Ctrl+C's two-tier UX), Concept 3 (multi-turn is just calling `runAgentLoop` again), and Concept 5 (the two run modes and the `cli.ts`/`index.ts` split) come together: `parseArgs` (one-shot vs. REPL dispatch, `--resume`), `runRepl` (the interactive loop, the SIGINT handler, and the **one call site** where `runAgentLoop` gets invoked per turn — marked explicitly in a comment, since Phase 5 (Streaming) replaces exactly that call site and nothing else), and `main` (wiring it all together, including loading a saved session when `--resume` is passed).

- [ ] Create `src/cli.ts` with this content (complete file):

  ```typescript
  import * as readline from "node:readline";
  import { randomUUID } from "node:crypto";
  import Anthropic from "@anthropic-ai/sdk";
  import { runAgentLoop, type AgentMessage } from "./agent.js";
  import { getToolSchemas } from "./tools.js";
  import { buildSystemPrompt } from "./prompt.js";
  import { saveSession, loadSession, getLatestSessionId, type SessionData } from "./session.js";

  interface ParsedArgs {
    resume: boolean;
    prompt?: string;
  }

  function parseArgs(): ParsedArgs {
    const args = process.argv.slice(2);
    let resume = false;
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--resume") {
        resume = true;
      } else if (args[i] === "--help" || args[i] === "-h") {
        console.log(
          [
            "Usage: nac-mini-agent [options] [prompt]",
            "",
            "Options:",
            "  --resume       Resume the most recently saved session",
            "  --help, -h     Show this help",
            "",
            'With a prompt argument, runs once and exits. Without one, starts an',
            'interactive REPL. Type "exit" or "quit", or press Ctrl+C twice, to leave.',
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
    };
  }

  function printFinalText(messages: AgentMessage[]): void {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) {
      return;
    }
    const text = last.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) console.log(text);
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
  }

  function printPrompt(): void {
    process.stdout.write("\n> ");
  }

  async function runRepl(messages: AgentMessage[], options: ReplOptions): Promise<void> {
    const { client, model, systemPrompt, tools, sessionId, startTime } = options;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // null while idle; set to the in-flight turn's controller while a call
    // to runAgentLoop is pending. This single variable IS "is the agent
    // busy" — no separate boolean needed, mirroring the reference
    // implementation's `get isProcessing() { return this.abortController
    // !== null }` (claude-code-from-scratch/src/agent.ts, lines 293-294).
    let currentController: AbortController | null = null;
    let sigintCount = 0;

    process.on("SIGINT", () => {
      if (currentController) {
        // Mid-turn: abort only this turn's in-flight API call. The pending
        // `await client.messages.create(...)` inside runAgentLoop rejects
        // with Anthropic.APIUserAbortError; the line handler below catches
        // it without printing an error. Nothing here touches `messages` —
        // it is left exactly as it was before this turn started, or with
        // one fully-formed assistant/tool-result pair appended (Concept 1).
        currentController.abort();
        console.log("\n  (interrupted)");
        sigintCount = 0;
        printPrompt();
      } else {
        // Idle: first press warns, second press (before any line is
        // submitted) exits. No timeout window — a deliberate simplification
        // of real Claude Code's stricter 800ms double-press (Concept 1).
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
      // rl.once, not rl.on: only one line handler is ever pending at a
      // time, so a second Enter press can't start a second runAgentLoop
      // call against the same messages array while the first is still in
      // flight (Concept 3 — this IS the "multi-turn is just call it again"
      // mechanism, made safe against overlapping calls).
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

        // ─── The one call site: every REPL turn goes through here ────────
        // Phase 5 (Streaming) replaces this call (and only this call) with
        // a streaming equivalent — nothing else in this function needs to
        // change for that.
        try {
          await runAgentLoop(messages, {
            client,
            model,
            systemPrompt,
            tools,
            signal: currentController.signal,
          });
          printFinalText(messages);
        } catch (e) {
          if (!(e instanceof Anthropic.APIUserAbortError)) {
            console.error(`Error: ${(e as Error).message}`);
          }
          // An aborted turn already got its "(interrupted)" message from
          // the SIGINT handler above — nothing more to print here.
        } finally {
          currentController = null;
          // Save after every turn, whether it completed, errored, or was
          // interrupted — messages is always left in a valid, resumable
          // state either way (Concept 1), so there's no reason to
          // withhold a save that would otherwise be safe to make (Concept 2).
          saveSession(sessionId, buildSessionData(sessionId, model, startTime, messages));
        }

        askQuestion();
      });
    };

    askQuestion();
  }

  export async function main(): Promise<void> {
    const { resume, prompt } = parseArgs();

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
      // One-shot mode: run exactly one turn, print the answer, save, exit.
      messages.push({ role: "user", content: prompt });
      try {
        await runAgentLoop(messages, { client, model, systemPrompt, tools });
        printFinalText(messages);
      } catch (e) {
        console.error(`Error: ${(e as Error).message}`);
        process.exitCode = 1;
      }
      saveSession(sessionId, buildSessionData(sessionId, model, startTime, messages));
    } else {
      // Interactive REPL mode.
      await runRepl(messages, { client, model, systemPrompt, tools, sessionId, startTime });
    }
  }
  ```

A few things worth pointing at explicitly, since they're easy to skim past:

- **There is exactly one place `runAgentLoop` is called per REPL turn** — inside `askQuestion`'s `rl.once("line", ...)` callback, marked with the `// ─── The one call site ───` comment. The one-shot branch in `main()` has its own, separate call, but that one only ever runs once per process, not once per turn — it's not part of the REPL's per-turn cycle.
- **`signal` is only passed in the REPL branch, not the one-shot branch.** A one-shot invocation has no REPL loop to return control to after an interrupt — Ctrl+C during a one-shot call falls back to Node's default `SIGINT` behavior (terminate the process immediately), which is the correct, expected behavior for a command that was only ever going to run once.
- **`messages.push({ role: "user", content: input })` happens before `currentController` is created**, not after. If the process were somehow interrupted between those two lines (it can't be, meaningfully — there's no `await` between them — but the ordering still matters conceptually), the user's own message is real input, not something that needs rolling back. Only the *response* to it is what abort protection covers.

- [ ] Confirm this type-checks cleanly:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

This exact file (verbatim) was type-checked (`npx tsc --noEmit`, zero errors) in an isolated scratch directory alongside this phase's `agent.ts`, Phase 2's unmodified `tools.ts`, and a `prompt.ts` stub exposing the same `buildSystemPrompt()` signature Phase 3 produces, as part of writing this tutorial.

---

## Implement 4: Shrink `index.ts` to a shim

`index.ts` has been throwaway scaffolding since Phase 1, called out explicitly at the end of every prior phase's tutorial as something Phase 4 would replace. It's not being deleted — `npm start` still runs it — but every line of logic it used to contain now lives in `cli.ts` (Implement 3).

- [ ] Replace `src/index.ts` with this (complete file):

  ```typescript
  import { main } from "./cli.js";

  main();
  ```

- [ ] Confirm `npm start` (still `tsx src/index.ts`, unchanged since Phase 1) launches the REPL:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npm start
  ```

  Expect the `nac-mini-agent — session <8-char-id>. Type "exit" or "quit" to leave.` banner followed by a `> ` prompt, with no prior one-shot text printed — this is the REPL branch of `main()`, since no positional prompt argument was given.

---

## Verify

- [ ] **Multi-turn memory, the direct payoff of Concept 3.** With `ANTHROPIC_API_KEY` exported, run `npm start`, and have a short back-and-forth:

  ```
  > What is 7 times 6?
  42.
  > What was the question I just asked?
  You asked what 7 times 6 is.
  ```

  The second answer only makes sense if `messages` from the first turn is still present when the second turn's `runAgentLoop` call runs — confirm this by temporarily uncommenting a `console.log(JSON.stringify(messages, null, 2))` right after `printFinalText(messages)` in `cli.ts` and observing the array has 4 entries after the second turn (2 per turn, exactly Phase 1 Concept 3's growth pattern, now spanning two separate `runAgentLoop` calls instead of one).

- [ ] **Interrupt mid-turn.** Ask something that will take the model a few seconds to answer (e.g. `"Write a 300-word explanation of how TCP handshakes work."`), and press Ctrl+C while it's still "thinking." Expect: `(interrupted)` printed immediately, a fresh `> ` prompt (printed twice in quick succession — see Concept 1's note on why that's expected), and the REPL still running — not exited. Follow up with a normal question in the same session and confirm it still has access to everything from before the interrupted turn (the interrupted turn itself contributed nothing to `messages`, per Concept 1's proof, so there's nothing missing to notice).

- [ ] **Double Ctrl+C to exit.** While idle at the `> ` prompt (not mid-turn), press Ctrl+C once — expect `Press Ctrl+C again to exit.`. Press it again — expect `Bye!` and the process actually exits. Confirm a single Ctrl+C while idle does *not* exit by itself.

- [ ] **`exit`/`quit` as a plain-text escape hatch.** Type `exit` or `quit` at the prompt (no Ctrl+C needed) and confirm the REPL exits with `Bye!`.

- [ ] **Session persistence and `--resume` across two separate process invocations.** Run `npm start`, have a short conversation, then use the `exit` command (not Ctrl+C — either works, since saving happens after every turn regardless, but `exit` is the more deliberate ending). Then run:

  ```bash
  ls -la ~/.nac-mini-agent/sessions/
  cat ~/.nac-mini-agent/sessions/*.json | head -40
  npm start -- --resume
  ```

  Expect: exactly one `.json` file per session you've run (named by its 8-character id), a valid JSON structure with `metadata` and `messages`, and — after `--resume` — a `Resumed session <id> (<N> messages).` banner followed by a REPL that, when asked "what did we just talk about," correctly recalls the prior conversation's content. This confirms `--resume` reloaded the actual `messages` array, not just metadata.

- [ ] **One-shot mode still works, unchanged in observable behavior from Phase 3.** Run:

  ```bash
  npm start -- "List the files in the current directory."
  ```

  Expect the same single-turn behavior Phase 3's Verify section confirmed — the process runs one turn and exits, no `> ` prompt ever appears. Then check `~/.nac-mini-agent/sessions/` again and confirm a new session file was created for this one-shot run too (one-shot mode saves its session exactly like REPL mode does, so a one-shot invocation is itself resumable with `--resume` afterward).

**Unverified / flagged explicitly:** every command above was written and reasoned through against the code verified in Implement steps 1–3 (type-checked and, for the abort mechanics and session round-trip, actually executed against real code in an isolated scratch directory — see each Implement step's own verification notes). The specific live-model conversational transcripts shown in this Verify section (e.g. the exact wording "You asked what 7 times 6 is.") were not captured from a live API call while writing this tutorial — no API key was available in this authoring environment, consistent with every prior phase's own flagged limitation. What *is* independently verified, not merely predicted, is every claim about mechanism: that `client.messages.create` rejects with `Anthropic.APIUserAbortError` when its signal is aborted (confirmed by direct execution against the real installed SDK), that `messages` is left in a valid state after an abort both during the API call and during tool execution (confirmed by direct execution against the real `runAgentLoop` code, including a fake-client test simulating the tool-execution-interrupt case), and that `session.ts`'s save/load/list/latest round trip behaves as described (confirmed by direct execution).

---
