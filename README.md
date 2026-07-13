# NAC

NAC is an CLI coding agent prototype to study tool routing, file-system permission control, centeralized state management, context management and the async work-flow design commonly used by modern agent.

## What It Does (so far)

The agent runs either one-shot (a prompt argument → one turn → exit) or as an interactive REPL. The agent loop calls the model, executes any tools it requests against the local filesystem, feeds results back, and repeats until the model answers with no more tool calls. Conversations persist to disk after every turn and can be reloaded with `--resume`.

Built so far (Phases 1–4):

- **Agent loop** (`src/agent.ts`) — the core call → execute-tools → feed-back `while` loop; the model alone decides when the task is done.
- **Tool registry** (`src/tools.ts`) — `read_file`, `edit_file`, `list_files`, dispatched by name; failed calls return error strings the model can react to instead of throwing. `edit_file` is protected by a read-before-edit + mtime guard, so it can never overwrite a file that changed on disk after the agent last read it.
- **Composed system prompt** (`src/prompt.ts`) — identity/behavior rules, a tools section generated from the registry, runtime environment info, and project instructions loaded from `CLAUDE.md` (upward directory walk) and `.claude/rules/*.md`, with recursive `@include` support.
- **CLI & sessions** (`src/cli.ts`, `src/session.ts`) — `parseArgs` (`--resume`, `--help`, positional prompt), a `readline`-based interactive REPL with two-tier Ctrl+C handling (abort the in-flight turn while busy; double-press to exit while idle), and whole-file JSON session persistence (`~/.nac-mini-agent/sessions/<id>.json`) saved after every turn. `agent.ts` gained one field — `signal?: AbortSignal`, threaded into `client.messages.create()` — so a turn can be cancelled without leaving `messages` half-written. `index.ts` is now a two-line shim over `cli.ts`'s `main()`.

Not yet built: streaming (Phase 5), permissions (Phase 6), context compaction (Phase 7), memory (Phase 8), sub-agents (Phase 9).

## Quick Start

Requires Node 20+ and an Anthropic API key.

```bash
#!/usr/bin/env bash
set -euo pipefail

npm install

# API key goes in .env (gitignored); the start script loads it via --env-file
if [ ! -f .env ]; then
  read -r -p "Anthropic API key (sk-ant-...): " KEY
  printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" > .env
  echo "wrote .env"
fi

# smoke test: one agent-driven read of the project
npm start -- "List the files in the current directory, then read package.json and tell me the project name."
```

## Usage

```bash
# run a task (one-shot; the whole argument list becomes the prompt)
npm start -- "Read src/tools.ts and summarize what each tool does."

# no argument -> interactive REPL (multi-turn; "exit"/"quit" or double Ctrl+C to leave)
npm start

# resume the most recently saved session (works with both modes)
npm start -- --resume
npm start -- --resume "one more follow-up question"

# print the composed system prompt without spending an API call
npx tsx -e "import('./src/prompt.js').then(m => console.log(m.buildSystemPrompt()))"
```

---
## Dev Log

### Jul 6. 2026 - Phase 1 Core Agent Loop Initialization

Initialized the core agent loop: a while loop repeatedly calls the API, execute any requested tools (instructed from the *assistant* side), execute locally and feed results back to the `messages` array until the remote deside to stop the requesting tools.

**Core Observation**
- `tool_result` blocks must go back under `role: "user"` — API only has
  two roles, and results count as "not the model."
- Loop's only exit condition is when `tool_use` array has a `length == 0` being satisfied. It actually tells two things. 1. The workflow is always inited with a tool called. 2. It's always up to the `assistant` to determine no more tool needs to be called by assessing the `messages` array (as a log). 

**Next:**
- Phase 2: replace hardcoded `executeTool`/`TIME_TOOL` with a real
  tool registry in `tools.ts`.

### Jul 7. 2026 - Async Generator Experiment (`test.ts`)

Wrote a standalone `async function*` (`stream_data`) that yields three values with a delay between each, then `return`s a final value — to see how async generators behave before Phase 5 (streaming) needs them.

**Understood / clarified:**
- `for await (const item of gen)` consumes yielded values only — it stops once the generator's `done` flag is `true` and never surfaces the generator's `return` value. Calling `gen.next()` again afterward returns `{ value: "done", done: true }` directly.
- Manually driving the generator with `while (!result.done) { ...; result = await gen.next(); }` is the only way to see the `return` value inline, since the final `result.value` (when `done` is `true`) *is* that return value.
- This is the same mechanism production coding-agent CLIs rely on: the main agent loop is an `async function*` specifically so it can `yield` intermediate events (assistant messages, tool results) while still `return`-ing a final state — matches what I just observed by hand here.

**Next:**
- Keep `test.ts` as scratch space for this kind of isolated syntax experiment, separate from `src/agent.ts`.


### Jul 7. 2026 - Phase 2 Tool System

Now the core while loop has already been built but the `execute_tool()` is yet a hard coded to inserted directly the mock tool return into `messages`. Questins emerged: how to decide what tools exist? how does the tool `name` requests turn into the actual function call? and most improtantly, what invariants the code enforces that the model itself cannot be trusted to enforce, through prompting along (read-before-edit mtime checks)? 

The three concrete tools built here (read_file, edit_file, list_files) are also, not coincidentally, the three tools that make any coding agent minimally useful: it can see what's in a project, see what's in a specific file, and change a file's contents. Every other tool: search, shell execution, sub-agents, MCP, is an elaboration on top of this same registry/dispatch shape, not a different architecture.

**Understood**

- `Tool` is just an interface with basic fields of `name`, `description`, `input_schema`, `isReadOnly` (for safely parallel execution) and an `execution()` method taking input `Record<string, unknown>` (dictionary) and read-file state as its 2 arguments. `execute()` is invoked from inside `executeTool()` which is responsible for tools look-up and input injection. It is periodically called once per `tool_use` in the core agentic while loop.
- The dispatcher is the `executeTool()` itself. Dispatcher returns error as a string, allowing the "assistant" to react to the failure and make its own decision (retry, apologize, try something else) instead of throwing an Error and breaking the agentic loop.
- The **Mtime guard** is implemented via `ReadFileState`. `read_file` records a file's mtime when it hands the content to the model, and `edit_file` checks that recorded mtime against the file's current mtime before writing, refusing the edit if they don't match — i.e., if the file changed on disk since it was last read.


### Jul 7. 2026 - Phase 3 System Prompt

An important observation of the main stream agentic tool: instead of treating the system prompt as the function for model calling, it is used as a parameter. A system prompt **is not just** a long instruction string, it is an ordered context structure that shapes how the model behaves.

```bash
npx tsx -e "import('./src/prompt.js').then(m => console.log(m.buildSystemPrompt()))"
```
Execute to see the full system prompt. 

**System-prompt decoupling and Interpretive Frame**
The important upgradet is this:: for an agent, prompt design is not only about wording, but it is about **context engineering**: deciding what information appears, how it is grouped, and where it appears in the context window. Throwing the behavior restrictions in a massive instruction for the llm is inefficiency in many way due to various of reasons(context window, accuracy, efficiency, maintainance..), so the deeper point is that **ordering is important**. For LLMs, early high-level instructions frames the following behaviors and set the foundation for what laters are grounded. 

```
Don't add unnecessary error handling.
You are an interactive coding agent.
```

The example sequence is for appearance reason less effective than reversing the two sentences. This is called **interpretive frame** which refers to the mental context through which later instructions are understood. 


**Recency Effect**

It means content closer to the end of the prompt often has stronger immediate influence on the model's next response than smaller content placed much earlier. It does not mean the model literally ignores earlier text, and it is not a hard rule in a execution order. It means that in practice, later context is often easier for the model to use right before generation the next tokens. 

Thats' why a dynamic, per-run information goes near the end: memory, skills, agents, `cwd`, date, git status, `CLAUDE.md` and project rules. So the structure becomes
1. Stable identity and behavior rules first
2. Specific current runtime/project context last

**Template Variables**

Placeholders like `{{cwd}}` and `{{date}}` are filled in at call time inside `buildSystemPrompt()`, not baked in as string literals at author time.

> [!NOTE]
> **Why `.split(key).join(value)` instead of `.replace(key, value)`?**  
> This is not a stylistic choice: `String.prototype.replace` treats sequences like `$&`, `$$`, and `$1` in the *replacement* argument as special tokens, not literal text — even when the search argument is a plain string, not a regex.  
>  
> ```js
> const val = "line one $& more $1 stuff";
> tmpl.replace("{{x}}", val);      // $& becomes the matched "{{x}}" — corrupted
> tmpl.split("{{x}}").join(val);   // val inserted byte-for-byte — correct
> ```  
>  
> That matters here: `getGitContext()` output can contain literal `$` in paths or commit messages. Use `split`/`join` for verbatim substitution; `replace` is subtly wrong.

**Anti-pattern Inoculation**

A positive instruction like "be concise" leaves an interpretation gap the model can fill in its own favor — it can convince itself that adding a docstring to every function *is* what high-quality concise code looks like. Stating the negative explicitly ("don't add error handling for scenarios that can't happen", "don't create helpers for one-time operations") removes that self-justifying gap. This is why `DOING_TASKS_SECTION` is mostly a list of don'ts rather than a description of good code.

**Blast-radius Framework**

The naive way to make an agent safe is a blacklist of forbidden actions — which is always incomplete, and the first novel situation not on the list leaves the model with zero guidance. `ACTIONS_SECTION` instead teaches a two-dimensional *reasoning framework*: **reversibility × scope of impact**. High risk = hard to undo AND visible beyond the local sandbox (force push, dropping data); low risk = reversible and local (editing a file the user asked about). A model with the framework can reason about a brand-new action nobody enumerated. One rule rides along that a blacklist can't express at all: *authorization doesn't generalize* — approving one push doesn't pre-approve every future push.

**Tools**

Two details worth remembering:
- It iterates `toolRegistry` directly, **not** `getToolSchemas()` which is the stripped version deliberately throws away `isReadOnly` (the wire format has no slot for it), and this section wants that flag to mark tools `(read-only)` in prose — a small preview of the blast-radius framing.
- The model *already* knows each tool's name/description/schema from the API's `tools` parameter — the prompt section isn't re-teaching that. In production agent CLIs the equivalent section is mostly *preferences between overlapping tools* ("use the dedicated file-read tool instead of `cat`"), steering the model away from a generic shell tool. This registry has no shell tool yet, so there's nothing to steer away from — the section just describes what exists, from the one source of truth.

**`@include`, `CLAUDE.md`, and `.claude/rules/`**

The channel for *per-project* instructions the agent's own source never hardcodes. `loadClaudeMd()` walks **upward** from cwd to the filesystem root, collecting every `CLAUDE.md`, and `unshift`s files closer to root — so the final order is root-to-leaf, with the cwd's own file *last*. That's the recency effect again: most-specific instructions closest to the end. `.claude/rules/*.md` are auto-loaded alongside, sorted by filename.

`resolveIncludes()` expands `@./relative`, `@~/home`, and `@/absolute` lines recursively, with two guards: a `visited` set (file A includes B includes A → `<!-- circular: ... -->`) and `MAX_INCLUDE_DEPTH = 5`. Both failure modes degrade to an HTML comment in the output instead of throwing — Phase 2's "errors are data, not exceptions" philosophy, applied to prompt composition. (Full-scale agent CLIs discover instruction files from more locations — a managed policy dir, the home dir, a `.local` override, an explicit CLI flag; the upward walk + rules dir covers the common cases.)

**Separation of Concerns, Proved**

Two halves. Code-level: `grep -n systemPrompt src/agent.ts` shows exactly two hits — the options destructure and `system: systemPrompt` in the API call. No `if`, no `.includes()` — whatever the prompt says, the loop runs identically. Behavior-level: swapping only `TONE_SECTION` (terse/tool-preferring vs. verbose/explain-first) observably changes agent behavior with zero edits to `agent.ts`, `tools.ts`, or the call site. The system prompt is a real seam, not a formality. (My `prompt.ts` currently carries the verbose experiment variant of `TONE_SECTION` — note it partly contradicts `OUTPUT_EFFICIENCY_SECTION`, so revert before Phase 4 or the two sections fight each other.)

Not built, deliberately: a static/dynamic prompt-caching boundary — production agents split the ~70% of the prompt that's identical across every user and run from the per-conversation ~30% with a marker, so the static prefix can hit a shared prompt cache. A study prototype doesn't need to optimize API cost yet.

**Next:**
- Wire `getGitContext()` into `buildEnvironmentSection()` — it's written and exported but currently never called, and the environment section only injects `Date` (no cwd/platform/shell yet, despite the notes above describing them).
- Revert `TONE_SECTION` to the terse variant after the behavior-comparison experiment.
- Phase 4: replace `index.ts`'s one-shot scaffolding with a real REPL (`cli.ts`) + session persistence (`session.ts`) — `buildSystemPrompt()` is already called fresh per run, which is exactly the shape the REPL needs.


### Jul 8. 2026 - Phase 4 CLI Sessions

**Controller.abort() and Dataflow integrity**
To cancel the inflight `Promise` there are two main things to consider:

First, `await client.messages.create(...)` is a Promise-based operation. In Node.js, the standard way to cancel this kind of in-flight asynchronous operation is to use an `AbortController`. You create a controller, pass its `signal` into the request, and when you call `controller.abort()`, the request receives the abort signal.

The signature of `Anthropic.Messages.create()` is:

```typescript
(method) Messages.create(
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  options?: RequestOptions
): APIPromise<Anthropic.Messages.Message>
```

...where `RequestOptions` includes the field:

```typescript
signal?: AbortSignal | undefined | null;
```

...which means Anthropic requests can be controlled through an `AbortController`. Similar pattern can be found in the api design for other mainstream model providers. 

Second, cancellation must not leave `messages` in a state that the next API call would reject. This matters because, in an agent loop, `messages` has strict structural requirements when tool use is involved. When the assistant returns a `tool_use`, the next user message must include the corresponding `tool_result`. If the matching `tool_result` is not fully appended, the next API call may be rejected.

Therefore, the safe design is to treat message updates as a small transaction: do not mutate `messages` while the API request is still in flight, and only commit the assistant response after the request has completed successfully. If the request is aborted, no partial assistant message should be appended, so `messages` remains in its previous stable state.


### Jul 9. 2026 - Phase 4 CLI & Sessions: Implementation & Debugging

`session.ts` and `cli.ts` written; `index.ts` demoted to a two-line shim over `cli.ts`'s `main()`. `agent.ts` changed by exactly one field (`signal?: AbortSignal` threaded into `client.messages.create()`'s second argument) — the loop shape itself is untouched.

**Understood**

- **Session persistence is serializing the array I already have.** There is no separate "session state" object — `SessionData` is `{ metadata, messages }` where `messages` is the exact same array the loop has grown since Phase 1, plus label info (`id`, `model`, `cwd`, `startTime`, `messageCount`) so a session can be found later without parsing its full contents. Whole-file JSON overwrite per save (`~/.nac-mini-agent/sessions/<id>.json`), saved from a `finally` after every turn — completed, errored, or interrupted — which is safe precisely because of the abort-integrity property above.
- **`--resume` restores `messages` only, never the system prompt.** `buildSystemPrompt()` runs fresh at startup either way — environment facts and `CLAUDE.md` content must reflect *today*, not the day the session was first saved.
- **Two nested loops, two stopping conditions.** The REPL loop ("keep going across turns until the human stops typing") wraps the agent loop ("keep going within one turn until the model stops calling tools"). Multi-turn is just calling `runAgentLoop` again with the same array — no new mechanism.
- **`rl.once`, not `rl.on`.** Only one line-handler is ever pending, so a second Enter can't start a second `runAgentLoop` against the same `messages` array mid-flight. `currentController !== null` doubles as the "is the agent busy" flag — no separate boolean to keep in sync.
- **Two-tier Ctrl+C.** Mid-turn: abort only the in-flight turn, stay in the REPL. Idle: warn on first press, exit on second. `sigintCount` resets whenever a turn is interrupted or a line is submitted, so a habitual second press right after interrupting doesn't accidentally quit.

**Debugging notes**

- `listSessions()` silently returned `[]` because `readFileSync(file)` used the bare filename from `readdirSync` (resolves against cwd → ENOENT) instead of `join(SESSION_DIR, file)`. The intentional empty `catch` for corrupted files swallowed the error, and the symptom surfaced two functions away as `getLatestSessionId() === null`. Lesson: an empty catch can't tell "expected bad file" from "my own path bug" — during development, a `console.error` inside such catches is cheap insurance.
- `Property 'abort' does not exist on type 'never'`: while `runRepl` was half-written, `currentController` had a correct type annotation but zero reassignments anywhere in the function — TS treats a never-reassigned `let` as effectively-const, keeps the `null` narrowing from the initializer even inside the SIGINT closure, and `if (currentController)` narrows `null` down to `never`. The error self-resolved once `askQuestion()` added the `currentController = new AbortController()` assignment.
- `MaxListenersExceededWarning: 11 abort listeners added to [AbortSignal]`: one controller is created per REPL turn, and its single `signal` is handed to *every* `messages.create()` call inside that turn's tool loop. Each request attaches an abort listener; Node cleans them lazily and warns past 10 — so this fires on any turn with 11+ API round-trips. A warning, not a leak (the controller is nulled and GC'd at turn end); `setMaxListeners(50, currentController.signal)` from `node:events` silences it.
- Multi-line `npx tsx -e "..."` pastes kept getting mangled by interactive zsh (fragment executes, then `parse error near '}'`). New habit: smoke tests go in a scratch `.ts` file, run with `npx tsx <file>` — no shell quoting involved.
- **REPL went silent after the first completed turn (fixed).** The line handler ended right after its `finally` block without re-arming — and `rl.once` fires exactly once, so after one successful turn there was no pending listener and no `> ` prompt; typed input went nowhere. The empty-input and `exit` branches re-armed correctly, which made it easy to miss that the *main* path didn't. Fix: `askQuestion()` as the last statement inside the handler, after the `finally` — every turn ends by re-arming the next one, completing the REPL cycle.

**Next:**
- Run the Phase 4 Verify checklist end to end: multi-turn memory (4 entries after 2 turns), mid-turn Ctrl+C, idle double Ctrl+C, `exit`/`quit`, `--resume` across two processes, one-shot mode still saving a resumable session.
- Phase 5: replace `client.messages.create()` with `.stream()` — token-by-token output plus early execution of read-only tools; the REPL's one `runAgentLoop` call site is the only thing that changes in `cli.ts`.


### Jul 9. 2026 - Phase 5 Streaming

Mainstream production agents stream for the obvious reason first: psychologically, staring at a silent terminal is a painful, confidence-eroding experience — the same ten-second wait feels fine when you can watch the answer write itself. But the engineering benefit matters more. In the streaming model, the response doesn't arrive as one blob; it arrives as a sequence of segments (content blocks), and the end of a segment can be exactly the moment a tool call becomes fully specified — everything needed to run it is already on the wire, even though the model is still generating the rest of its turn. Compared to the vanilla call model — where nothing is actionable until the *entire* response has landed — this lets tool execution start early and overlap with the remaining stream, instead of queuing up behind a final result that hasn't finished arriving yet.

`agent.ts` rewritten around `client.messages.stream()`; `cli.ts` changed at its two call sites (`onText` streams tokens to stdout, dead `printFinalText` removed) plus one fix the tutorial didn't anticipate (SIGINT registration, below). Loop shape unchanged: one turn, check `tool_use`, push exactly two entries, repeat.

**Understood**

- **A `Message` is rebuilt block-by-block on the wire.** `content_block_start` announces a block's `index` and type, `content_block_delta` carries fragments, `content_block_stop` says that index is done. Text deltas are usable strings; tool-input deltas (`input_json_delta.partial_json`) are fragments of a JSON *string* — accumulate per index, `JSON.parse` exactly once at `content_block_stop`, never earlier.
- **`content_block_stop` is the whole point of streaming for agents.** The instant a read-only tool's block completes, `streamOneTurn` fires `onToolBlockComplete` and the loop starts `executeTool()` without awaiting it (`earlyExecutions` map, keyed by `tool_use` id) — execution overlaps the rest of the stream. Write tools never early-start (`isReadOnly` gate from Phase 2); `tool_result`s are still only sent after `finalMessage()` resolves, so the "never reply to half a turn" invariant holds.
- **`finalMessage()` resolves to the same `Message` shape `create()` returned**, and is still the single awaited rejection point — Phase 4's abort guarantee (both `messages.push` calls sit after it) composes with streaming unchanged.

**Debugging notes**

- `Property 'caller' is missing in type ... ToolUseBlock` (TS2345): earlier phases only ever *read* `tool_use` blocks the API produced; reconstructing one by hand from accumulated fragments demands the full shape, so `caller` must be captured at `content_block_start` and carried through.
- `Type 'String' is not assignable ...`: wrote `Map<string, Promise<String>>` — capital-`S` `String` is the boxed object type, not the primitive. Never use `String`/`Number`/`Boolean` in type positions.
- **Ctrl+C mid-stream killed the whole REPL — the tutorial's `process.on("SIGINT")` design was the bug, not my transcription.** With a TTY, readline holds stdin in raw mode: Ctrl+C never becomes an OS signal; readline intercepts the `\x03` byte, emits `"SIGINT"` on the *Interface*, and with no listener there silently closes itself. Observed live: first press "does nothing" (dead REPL, stream keeps printing), second press — terminal now cooked — sends a real SIGINT to the whole npm/tsx/node process group and the supervisors tear everything down. Fix: shared `handleSigint` registered on **both** `rl.on("SIGINT")` (raw-mode TTY path) and `process.on("SIGINT")` (piped-stdin / external-signal path); exactly one fires per press. Verified by pseudo-TTY experiment and live. Also: Ctrl+C in *one-shot* mode terminating immediately is by design (no readline, no handler) — cost me a false alarm.

**Next:**
- Finish the Phase 5 Verify checklist: `[early-start]` timing logs for two reads in one turn, confirm write tools never early-start, `--resume` after an interrupted-then-continued session.
- Phase 6: Permissions & Safety — the other consumer of `isReadOnly`, gating write tools behind human approval the same way this phase gated early execution.

