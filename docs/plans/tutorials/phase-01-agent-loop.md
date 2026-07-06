# Phase 1: Agent Loop

> Series: Mini-Claude-Code Learning Plan — see [`../phase-breakdown.md`](../phase-breakdown.md) for full context.
> This phase has no dependency on any earlier phase. Phase 2 (Tool System) and Phase 3 (System Prompt) build directly on the files created here.

## Goal

Build the single most important piece of a coding agent: the loop that turns Claude from a chatbot into an agent. By the end of this phase you will have a working, minimal, non-streaming agent loop in TypeScript that can call the Anthropic Messages API, detect when the model wants to use a tool, execute it, feed the result back, and repeat until the model produces a final answer with no more tool calls.

This is deliberately the *simplest possible version* of the loop. No streaming (Phase 5), no tool registry (Phase 2), no system prompt composition (Phase 3), no permissions (Phase 6), no context compression (Phase 7). Every one of those is a real subsystem in production Claude Code, layered on top of exactly the loop you're about to build. Once you understand this phase, you understand the spine that everything else attaches to.

## Why this is "the" interview topic

If an interviewer asks "how does an agent like Claude Code actually work," the honest answer is: **it's a `while` loop around one API call**. The intelligence is entirely inside the model; the code's only job is to notice when the model asked for a tool, run it, and hand the result back. Nothing about "agentic behavior" requires special infrastructure beyond this — the model itself decides when the task is done (by not calling any more tools), not the code. That inversion — code no longer encodes the decision tree, the model does — is the core mental shift from "traditional programming" to "agent engineering," and it's worth being able to say out loud in those words.

---

## Files

This phase creates:

- `package.json` — project manifest and dependency on `@anthropic-ai/sdk`
- `tsconfig.json` — TypeScript compiler configuration
- `.env` — your Anthropic API key, kept out of source control
- `.gitignore` — excludes `.env` (and `node_modules/`, `dist/`) from git
- `src/agent.ts` — the agent loop itself: `runAgentLoop()`
- `src/index.ts` — a minimal, throwaway entry point so you can run and observe the loop (Phase 4 replaces this with a real REPL)

---

## Setup: Project setup

Before any of the concepts below, get the project scaffolding in place. This step has no corresponding concept — it's just environment setup — so it stands on its own ahead of the interleaved concept/implementation sequence that follows.

- [ ] Initialize the project and install dependencies.

  ```bash
  cd /Users/grexrr/Documents/NAC
  npm init -y
  npm install @anthropic-ai/sdk
  npm install -D typescript tsx @types/node
  ```

  (Exact installed version numbers will differ from whatever was current when this was written — that's expected and fine. This tutorial's code was verified to compile cleanly against `@anthropic-ai/sdk@0.110.0`; any reasonably current version exposes the same `Anthropic.MessageParam` / `Anthropic.Tool` / `Anthropic.ToolUseBlock` / `Anthropic.ToolResultBlockParam` types used below.)

- [ ] Replace the generated `package.json` with this (adjust the dependency version ranges to whatever `npm install` actually wrote — don't hand-edit those numbers):

  ```json
  {
    "name": "nac-mini-agent",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "start": "tsx --env-file=.env src/index.ts"
    },
    "dependencies": {
      "@anthropic-ai/sdk": "^0.110.0"
    },
    "devDependencies": {
      "@types/node": "^22.10.0",
      "tsx": "^4.19.0",
      "typescript": "^5.7.0"
    }
  }
  ```

- [ ] Create `tsconfig.json`:

  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "strict": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "outDir": "dist",
      "types": ["node"]
    },
    "include": ["src/**/*.ts"]
  }
  ```

- [ ] Get an Anthropic API key and put it in a `.env` file in the project root — never commit this file or paste the key into any tutorial output:

  ```
  ANTHROPIC_API_KEY=sk-ant-...
  ```

  The `"start"` script above already passes `--env-file=.env` to `tsx`/Node (this flag is a stable, built-in Node feature — no `dotenv` package needed), which loads `.env` into `process.env` before your code runs. The SDK's zero-argument `new Anthropic()` then reads `ANTHROPIC_API_KEY` from `process.env` automatically, exactly as it would if you'd `export`ed it in your shell — `.env` is just a more durable place to keep it than a shell session.

- [ ] Create a `.gitignore` so the key never accidentally gets committed:

  ```
  node_modules/
  dist/
  .env
  ```

---

## Concept 1: The Messages API wire shape

Every call to Claude goes through one endpoint: `POST /v1/messages`. A request looks like this:

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "You are a terse assistant.",
  "tools": [
    {
      "name": "get_current_time",
      "description": "Get the current date and time in ISO 8601 format.",
      "input_schema": { "type": "object", "properties": {} }
    }
  ],
  "messages": [
    { "role": "user", "content": "What time is it?" }
  ]
}
```

The response's `content` field is an **array of content blocks**, not a single string. When the model decides to call a tool, you get back something like this real, complete shape (this is the Anthropic Messages API's actual tool-use round-trip, not a paraphrase):

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me check the current time." },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "get_current_time",
      "input": {}
    }
  ]
}
```

Two content-block types matter for this phase:

- **`text`** — `{ type: "text", text: string }`. Ordinary model output.
- **`tool_use`** — `{ type: "tool_use", id: string, name: string, input: object }`. The model is asking you (the code) to run something and give it the result. `id` is a unique identifier for *this specific call* — you'll need it to correlate the result back.

After you run the tool, you send the result back in a new request as a **`tool_result`** content block:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "2026-07-03T22:14:01.000Z"
    }
  ]
}
```

`tool_use_id` must exactly match the `id` from the `tool_use` block it's answering — this is how the API knows which call this result belongs to (this matters more once a single turn has multiple parallel tool calls, which Phase 5 covers). Note also that `tool_result.content` can be a plain string — no need to wrap it in another content-block array for simple text results.

**Full round trip, all four messages in sequence** (verified against the Anthropic Messages API tool-use reference — this exact shape is what `curl`, every official SDK, and the real Claude Code source all produce):

```json
"messages": [
  { "role": "user", "content": "What is the weather in Paris?" },
  { "role": "assistant", "content": [
      { "type": "text", "text": "Let me check the weather." },
      { "type": "tool_use", "id": "toolu_abc123", "name": "get_weather", "input": { "location": "Paris" } }
  ]},
  { "role": "user", "content": [
      { "type": "tool_result", "tool_use_id": "toolu_abc123", "content": "72°F and sunny" }
  ]}
]
```

Notice there are only ever two roles in this array: `user` and `assistant`. That's the whole protocol. Concept 2 explains why the tool result — something your code produced, not something a human typed — goes in under the `user` role.

---

## Implement 1: One API call — see the wire shape directly

Before building the loop, write the smallest possible thing that makes a real request and shows you the raw response shape from Concept 1. This version makes exactly **one** call — no loop yet, no tool execution yet.

- [ ] Create `src/agent.ts` with this content (this is the complete file as it stands after this step):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";

  export type AgentMessage = Anthropic.MessageParam;

  export interface CallClaudeOptions {
    client: Anthropic;
    model: string;
    systemPrompt?: string;
    tools?: Anthropic.Tool[];
    maxTokens?: number;
  }

  /**
   * A single, non-looping call to the Messages API. Returns the raw
   * response so you can inspect response.content directly and see the
   * content-block shape from Concept 1 with your own eyes.
   */
  export async function callClaude(
    messages: AgentMessage[],
    options: CallClaudeOptions
  ): Promise<Anthropic.Message> {
    const { client, model, systemPrompt, tools, maxTokens = 1024 } = options;

    return client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools,
      messages,
    });
  }
  ```

- [ ] Create a throwaway `src/index.ts` just to try it (you'll overwrite this in Implement 3):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { callClaude, type AgentMessage } from "./agent.js";

  async function main() {
    const client = new Anthropic();
    const messages: AgentMessage[] = [
      { role: "user", content: "Say hello in exactly five words." },
    ];

    const response = await callClaude(messages, {
      client,
      model: "claude-opus-4-8",
    });

    // Print the raw content array — this is the shape from Concept 1.
    console.log(JSON.stringify(response.content, null, 2));
    console.log("stop_reason:", response.stop_reason);
  }

  main();
  ```

- [ ] Run it: `npm start`. You should see a JSON array with one `{ "type": "text", "text": "..." }` block, and `stop_reason: end_turn`. (`end_turn` is the value the API uses to say "the model finished naturally, no tool call" — this is exactly the signal Implement 2's loop checks for. This tutorial's TypeScript was verified to type-check successfully against the real SDK in an isolated scratch environment; the exact response text is left unverified here since it depends on a live API call this document doesn't make — the *shape* is what's guaranteed, not the wording.)

This step has no loop and no tools yet — its only purpose is to make the abstract JSON from Concept 1 into something you've actually seen come back from the real API once, before adding control flow around it.

---

## Concept 2: Why tool results come back as `role: "user"`

This is the part that trips people up the first time, because it's counterintuitive: **your code executed the tool, not "the user" — so why does the result get labeled `user`?**

The mental model that resolves this: the Messages API doesn't actually have a "human" role and a "model" role. It has exactly two roles — `assistant` (the model) and `user` (*everything that is not the model*). "User" is better read as "the other side of the conversation" than literally "the human typing at a keyboard." A tool result is external information arriving from outside the model, exactly like a human's next message would be — so structurally, it belongs in the same slot.

There's also a hard, protocol-level reason, not just a naming convention. The API strictly expects the conversation to alternate `user` → `assistant` → `user` → `assistant`... A `tool_use` block from the model is *always* followed by its `tool_result`, and that `tool_result` has to occupy a `user`-role turn — there's no third role for it to go in. Get this wrong (e.g. try to interleave a `tool_result` inside an `assistant` message, or split parallel tool results across multiple separate `user` messages) and the API rejects the request outright. The real Claude Code source has a comment on exactly this point, guarding the moment tool results are appended to history:

> *"Be careful to do this after tool calls are done, because the API will error if we interleave tool_result messages with regular user messages."* — real `claude-code/src/query.ts`, line 1535-1536

And a concrete, documented 400 error for getting the alternation wrong: `"messages: roles must alternate between \"user\" and \"assistant\""`.

One more rule that follows directly from this: if the model makes *multiple* tool calls in a single turn (you'll build this properly in Phase 5), all of their results must go back in **one single `user` message** containing multiple `tool_result` blocks — never split across several separate `user` messages. This phase's tutorial code only ever has at most one tool call per turn, so you won't hit this yet, but it's worth knowing now: splitting them silently teaches the model bad habits about making parallel calls, because the API's turn-taking model doesn't have anywhere else to put a second `user` message before the model's next turn.

---

## Concept 3: The messages array *is* the agent's memory

Here's the detail that matters most for understanding "memory" in an agent, and it's simpler than it sounds: **the Anthropic API is completely stateless.** There is no session, no server-side conversation object, no "continue where we left off" flag. Every single request sends the *entire* conversation history from the beginning, every time. If you don't include something in the `messages` array, the model has no way of knowing it happened.

That means "the agent remembers the file it read three tool calls ago" isn't implemented by any special memory subsystem in this phase — it's implemented by the fact that the array holding everything so far never gets thrown away, and gets sent whole, every time. This is worth being able to state plainly in an interview: **the append-only messages array *is* the agent's working memory.** Later phases (Memory, Phase 8; Context Engineering, Phase 7) build real subsystems on top of this, but they're refinements of this same array, not a replacement for it.

Trace one real iteration of the loop to see the growth pattern:

```
Turn 1 (start):
  messages = [
    { role: "user", content: "What time is it?" }
  ]

  → call the API. Model responds with a tool_use block.

Turn 1 (after the API call + tool execution):
  messages = [
    { role: "user",      content: "What time is it?" },
    { role: "assistant", content: [ tool_use(get_current_time) ] },   // +1
    { role: "user",      content: [ tool_result("2026-07-03T22:14:01Z") ] }  // +1
  ]

  → call the API again with this longer array. Model responds with
    plain text and no tool_use — the loop stops here.

Turn 2 (final):
  messages = [
    ...previous 3,
    { role: "assistant", content: [ text("It's 22:14 UTC.") ] }   // no tool_use → stop
  ]
```

Every time the loop goes around once (model asks for a tool, code executes it), the array grows by **exactly two entries**: one `assistant` message (containing the `tool_use`) and one `user` message (containing the matching `tool_result`). This is confirmed directly in the real source — the query loop's recursive step literally concatenates the prior messages with exactly one new assistant-message batch and one new tool-result batch before continuing:

```typescript
// real claude-code/src/query.ts, lines 1715-1727 (abridged)
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  // ...
  transition: { reason: 'next_turn' },
}
state = next
```

This two-entries-per-turn growth is also exactly what you'll implement by hand in Implement 2 below. Keep this pattern in your head — it's the mechanism, not an implementation detail. (Foreshadowing Phase 7: because this array only ever grows and the context window is finite, eventually something has to compress or summarize it. That's a real, separate subsystem — but notice it only exists to manage the growth of *this* array, not to replace the append-only design.)

---

## Concept 4: The loop itself, and what we're deliberately simplifying

The core loop, stripped to its essence, is a three-line idea:

```
while (true) {
  response = call the model with the full messages array so far
  if (response has no tool_use blocks) → done, break
  else → execute every tool_use block, append results, continue
}
```

**Only the model decides when to stop** — by producing a response with zero `tool_use` blocks. The code never has an `if/else` that says "the task looks done now." That decision is entirely the model's, every single iteration. This is *the* defining trait of an "agentic" system versus a scripted one.

A note on what production Claude Code does that we are not doing here: the real `query()` function (`claude-code/src/query.ts`, ~1,729 lines) is an `async function*` — an async generator — and its loop has **seven** distinct reasons to continue iterating (a tool was called; a prompt-too-long error triggered a context-collapse retry; output got truncated and needs a retry at a higher token limit; a Stop Hook blocked termination; and so on — see `how-claude-code-works/docs/02-agent-loop.md`, section 2.7, for the full table). Real Claude Code also uses async generators specifically for **backpressure** (the consumer controls how fast the producer runs, so events can't pile up) and because it makes each of those seven continue-branches a plain `state = {...}; continue` instead of a hand-rolled state machine.

Our loop in this phase handles exactly **one** of those seven reasons: *a tool was called, so continue.* Every other reason — retryable errors, budget limits, hook interactions — is out of scope for Phase 1. This isn't a cut corner unique to this tutorial; it's the same simplification the companion reference project (`claude-code-from-scratch`) makes deliberately, and says so explicitly: *"我们的简化实现只处理第 1 种：有 tool_use 就继续，否则停"* ("our simplified implementation only handles the first reason: continue if there's a tool_use, otherwise stop") — `claude-code-from-scratch/docs/01-agent-loop.md`, line 54. We're also skipping streaming (Phase 5) — this phase's loop makes one blocking, non-streaming API call per turn via `client.messages.create()`, not `client.messages.stream()`.

---

## Implement 2: Build the loop

Now expand `agent.ts` into the real thing: detect `tool_use` blocks, execute them, push the assistant message and the tool-result message (Concept 2 and Concept 3's two-entries-per-turn growth), and keep going until the model stops asking for tools — the single stopping condition from Concept 4.

For this phase, tools are intentionally close to nothing — one trivial, hardcoded tool (`get_current_time`) exists purely so you can watch a real `tool_use` → `tool_result` round trip happen. Phase 2 replaces this hardcoded function with a proper tool registry in its own `tools.ts` module; don't build that generality here.

- [ ] Replace `src/agent.ts` with this (complete file, replacing Implement 1's version):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";

  export type AgentMessage = Anthropic.MessageParam;

  export interface RunAgentLoopOptions {
    client: Anthropic;
    model: string;
    systemPrompt?: string;
    tools?: Anthropic.Tool[];
    maxTokens?: number;
  }

  // Temporary, hardcoded tool dispatch. Phase 2 moves this (and the tool
  // definitions themselves) into a dedicated tools.ts module with a real
  // registry — this function is deliberately not exported or generalized
  // any further than "phase 1 needs one tool to prove the loop works."
  async function executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    if (name === "get_current_time") {
      return new Date().toISOString();
    }
    return `Unknown tool: ${name}`;
  }

  /**
   * The agent loop. Calls the model, checks whether it asked for any
   * tools, executes them if so, appends the assistant message and the
   * tool-result message (see Concept 3 — this is where the messages
   * array grows by exactly two entries per turn), and repeats. Stops
   * the moment a response comes back with zero tool_use blocks — the
   * model itself decides when the task is done, not this code.
   *
   * Mutates and returns the same messages array that was passed in, so
   * the caller retains the full conversation history afterward.
   */
  export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions
  ): Promise<AgentMessage[]> {
    const { client, model, systemPrompt, tools, maxTokens = 1024 } = options;

    while (true) {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools,
        messages,
      });

      // The assistant's response (text and/or tool_use blocks) becomes
      // the next entry in the array. We push response.content directly
      // rather than re-building it — it's already in the shape the API
      // expects to see echoed back.
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      // No tool calls in this response → the model considers the task
      // done. This is the ONLY stopping condition in this phase (see
      // Concept 4 — production handles six more reasons to continue,
      // which we're not implementing here).
      if (toolUses.length === 0) {
        break;
      }

      // Execute every requested tool and collect one tool_result per
      // tool_use, correlated by tool_use_id (see Concept 1).
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const input = toolUse.input as Record<string, unknown>;
        const result = await executeTool(toolUse.name, input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        });
      }

      // All tool_result blocks from this turn go into ONE user message
      // (see Concept 2 — never split them across multiple messages).
      // This is the second of the two entries added per turn.
      messages.push({ role: "user", content: toolResults });

      // Loop back around: the model sees the tool result and decides
      // what to do next — answer, or call another tool.
    }

    return messages;
  }
  ```

Notice the shape of the loop is exactly the three-line idea from Concept 4, with the mechanics from Concepts 1–3 filled in around it: call → check for `tool_use` → (execute + append two messages) or (stop).

---

## Implement 3: A minimal entry point to run and observe it

Phase 4 (CLI & Sessions) is where a real interactive REPL gets built. For now, write just enough to invoke `runAgentLoop` once with a real prompt and print the final answer — this is throwaway scaffolding, not a subsystem this tutorial series designs around.

- [ ] Replace `src/index.ts` with this (complete file):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { runAgentLoop, type AgentMessage } from "./agent.js";

  // The one trivial tool this phase uses to exercise the loop end to end.
  // Its schema has no parameters — the simplest possible tool_use shape.
  const TIME_TOOL: Anthropic.Tool = {
    name: "get_current_time",
    description: "Get the current date and time in ISO 8601 format.",
    input_schema: { type: "object", properties: {} },
  };

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
      process.argv.slice(2).join(" ") || "What time is it right now?";
    const client = new Anthropic();

    const messages: AgentMessage[] = [{ role: "user", content: userMessage }];

    const finalMessages = await runAgentLoop(messages, {
      client,
      model: "claude-opus-4-8",
      systemPrompt: "You are a terse assistant.",
      tools: [TIME_TOOL],
    });

    console.log(extractFinalText(finalMessages));

    // Uncomment to see the full array and watch it grow by two entries
    // per tool-calling turn, exactly as described in Concept 3:
    // console.log(JSON.stringify(finalMessages, null, 2));
  }

  main();
  ```

- [ ] Run it:

  ```bash
  npm start -- "What time is it right now?"
  ```

## Verify

- [ ] With `ANTHROPIC_API_KEY` set in `.env`, run `npm start -- "What time is it right now?"`. Expect: the model calls `get_current_time`, gets back an ISO timestamp string, and responds with a short natural-language sentence referencing that time. You should NOT see any tool-call JSON printed to your terminal by default — only the final text — because `extractFinalText` only reads the last message.
- [ ] Uncomment the `console.log(JSON.stringify(finalMessages, ...))` line in `index.ts` and run again. Confirm the array has exactly 4 entries: `user` (your question) → `assistant` (with a `tool_use` block) → `user` (with the matching `tool_result`) → `assistant` (final text, no `tool_use`). This is Concept 3's two-per-turn growth, made concrete.
- [ ] Try a prompt that doesn't need the tool at all, e.g. `npm start -- "What is 2 + 2?"`. Confirm the array only has 2 entries this time (`user`, then `assistant` with just a text block) — the loop exits on the very first iteration because there was no `tool_use` to react to. This demonstrates that the loop's length is entirely determined by the model's own decisions, not by anything the code chose.

---

## What's next

Phase 2 (Tool System) takes the hardcoded `executeTool` function and the single `TIME_TOOL` definition out of `agent.ts`/`index.ts` and turns them into a real module — `src/tools.ts` — exporting a tool registry, shared tool-definition interface, and the dispatch logic, which `agent.ts`'s loop will import instead of hardcoding. `runAgentLoop`'s `tools` and tool-execution seam were deliberately kept generic (a plain `Anthropic.Tool[]` in, a plain `executeTool(name, input)` call inside the loop) specifically so that swap is a clean import change, not a rewrite of the loop itself.

Phase 3 (System Prompt) will replace the hardcoded `systemPrompt` string with a composed prompt built from a template plus environment/project context — again, `runAgentLoop` already accepts `systemPrompt` as a plain string option, so that phase only has to change what produces the string, not the loop that consumes it.

---

## Grounding notes

Every non-trivial claim above is grounded in one of these sources, or flagged where it isn't:

- **Content-block shapes (`text`, `tool_use`, `tool_result`) and the full round-trip JSON** — verified via the `claude-api` skill's Anthropic Messages API tool-use reference (matches `curl/examples.md`'s Tool Use section, which is Anthropic's own documented wire format).
- **`role: "user"` requirement for tool results, and the "don't interleave" constraint** — direct quote from real `claude-code/src/query.ts`, lines 1535-1536, read directly from the source in this environment. The `roles must alternate` 400-error message is from the `claude-api` skill's error-codes reference.
- **"All tool_result blocks from one turn go in a single user message"** — from the `claude-api` skill's tool-use pitfalls reference ("Parallel tool results go in ONE user message").
- **Messages array growing by exactly two entries per tool-calling turn** — both from `claude-code-from-scratch/docs/01-agent-loop.md` (lines 216-242, the worked 3-turn example) and directly from real `claude-code/src/query.ts` (lines 1714-1727, the `next: State = { messages: [...messagesForQuery, ...assistantMessages, ...toolResults], ... }` recursive step), both read directly in this environment.
- **The API being stateless / full history resent every request** — this is a well-established property of the Messages API (no session endpoint exists in the API surface documented anywhere in the `claude-api` skill's reference materials); presented here as established fact rather than needing a specific citation beyond "no session/conversation-state endpoint exists."
- **The 7 continue-reasons in real `query()`, and the async-generator/backpressure rationale** — from `how-claude-code-works/docs/02-agent-loop.md`, sections 2.7 and the "为什么用异步生成器而不是回调/事件" design-decision callout.
- **"Our simplified implementation only handles reason 1"** — direct quote (translated) from `claude-code-from-scratch/docs/01-agent-loop.md`, line 54.
- **The TypeScript code in Implement 1-3** — actually compiled (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` in an isolated scratch directory (`/private/tmp/.../scratchpad/verify-agent-loop`) as part of writing this tutorial. This confirms the type names and shapes (`Anthropic.MessageParam`, `Anthropic.Tool`, `Anthropic.ToolUseBlock`, `Anthropic.ToolResultBlockParam`, `Anthropic.TextBlock`, pushing `response.content` directly into a `MessageParam`, and `tool_result.content` accepting a plain string) are correct against the real SDK — not merely "looks right."
- **Unverified / flagged explicitly:** the *exact wording* the model returns when you actually run Implement 1 or Implement 3 was not verified — no live Anthropic API call was made while writing this tutorial (no API key was available in this authoring environment). Only the request/response *shape* is guaranteed by the SDK's types and the cited documentation; the specific text Claude generates will vary by run. Nothing else in this tutorial is left unverified.
