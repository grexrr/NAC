# Phase 5: Streaming & Parallel Tool Execution

> Series: Mini-Claude-Code Learning Plan — see [`../phase-breakdown.md`](../phase-breakdown.md) for full context.
> **Prerequisites:** [`phase-01-agent-loop.md`](phase-01-agent-loop.md), [`phase-02-tool-system.md`](phase-02-tool-system.md), [`phase-04-cli-sessions.md`](phase-04-cli-sessions.md). This phase builds directly on the exact `src/agent.ts` and `src/cli.ts` Phase 4 left behind, and specifically on the `readOnly` classification Phase 2 put on every `ToolDefinition` and the `AbortSignal` seam Phase 4 threaded into `RunAgentLoopOptions` — read both before this one if you haven't. Phase 7 (Context Engineering) builds directly on top of what this phase produces (compaction has to not break streaming).

## Goal

Every phase since Phase 1 has made exactly one blocking call per turn: `await client.messages.create(...)`, which sits silently for however many seconds the model takes to generate a full response, then hands back the whole thing at once. By the end of this phase, that single call is replaced with `client.messages.stream(...)`, and two things change in `agent.ts` as a direct result:

1. **Text appears token-by-token** as the model generates it, instead of all at once when the full response finally arrives.
2. **Read-only tool calls start executing the instant the model finishes specifying them** — while the model may still be streaming more text or another tool call — instead of waiting for the entire assistant turn to finish arriving over the network.

Neither of these changes anything about *what* the agent does. The loop still calls the model, checks for `tool_use` blocks, executes them, and pushes exactly the same two entries per turn onto `messages` that Phase 1 established. Streaming is purely about *when* things become visible and *when* tool execution can safely begin — not a new capability, a new latency profile on an unchanged mechanism.

## Why this is interview material

"Why does streaming matter, and isn't it just a UI nicety?" is a question worth being able to answer precisely, because the honest answer has two parts and most people only know the first one. The first part — **perceived latency**: seeing the first token in a few hundred milliseconds instead of staring at a blank terminal for 10-30 seconds — is the UI-nicety half, and it's real, but it's not the interesting engineering. The second part is the one worth having ready for an interview: **streaming exposes a structural signal — `content_block_stop` on a completed `tool_use` block — that a request/response call structurally cannot give you.** A blocking call gives you nothing until the entire response is done; a stream gives you a fine-grained event the instant a single tool call is *fully specified*, even though the model might keep generating for many more seconds. That signal is what makes it possible to start a read-only tool running *before* the model's turn is even finished — genuinely overlapping tool latency with generation latency, not merely making the wait feel shorter. This is the concrete answer to "how would you make a multi-tool-calling agent feel faster without changing what it does": you don't optimize the tools or the model, you exploit the fact that the transport already tells you more than you were listening for.

---

## Files

This phase modifies two files Phase 4 left behind. `src/tools.ts`, `src/prompt.ts`, and `src/session.ts` are **not modified at all** — this phase consumes the `readOnly` field Phase 2 already put on every `ToolDefinition` (Phase 2, Concept 6's forward reference) and the `signal?: AbortSignal` field Phase 4 already added to `RunAgentLoopOptions`; neither needs to change shape for streaming to slot in.

- `src/agent.ts` **(modified)** — the entire streaming portion: `client.messages.create()` is replaced with `client.messages.stream()`, a new `onText?: (textDelta: string) => void` option is added to `RunAgentLoopOptions` (the same "one new optional field" pattern Phase 4 used for `signal`), and the loop gains a tool-block-accumulation-and-early-execution mechanism. The loop's overall shape — one turn, check for `tool_use`, push exactly two entries, repeat — is unchanged.
- `src/cli.ts` **(modified, narrowly, with a specific reason)** — the one call site Phase 4's own comment marked (*"Phase 5 (Streaming) replaces this call (and only this call) with a streaming equivalent"*) now passes an `onText` callback that writes tokens to stdout as they arrive. This has one unavoidable knock-on effect: the old `printFinalText(messages)` call *after* `runAgentLoop` returns would now double-print text that has already streamed to the terminal token-by-token, so it's replaced with a single trailing newline, and the now-dead `printFinalText` function is removed. This is the only change to `cli.ts` — `parseArgs`, `runRepl`'s SIGINT handling, session save/load, and `--resume` are untouched.

---

## Concept 1: Perceived latency vs. raw latency — why stream at all

Two numbers frame why streaming exists as a real engineering concern rather than a cosmetic one. Model token generation runs at roughly 30-80 tokens per second; a moderately long answer takes 10-30 seconds to fully generate. A human's tolerance for staring at a blank terminal, before it starts to feel broken, is roughly 2-3 seconds — quoted directly from the tutorial backbone's own framing: *"模型生成速度大约每秒 30-80 个 token，稍长的回答需要 10-30 秒。用户面对空白等待的容忍极限约 2-3 秒"* — "model generation runs at roughly 30-80 tokens/second, a moderately long answer takes 10-30 seconds. A user's tolerance for staring at blank output tops out around 2-3 seconds" (`claude-code-from-scratch/docs/05-streaming.md`, lines 30-32). Streaming doesn't make the model faster — the 10-30 second generation time is unchanged — it changes *what the user experiences during that time*: the first token can appear in a few hundred milliseconds, turning "wait 30 seconds" into "watch it write itself," which the same source describes precisely: *"主观等待感接近零，并且用户能在方向错误时提前中断"* — "the subjective wait approaches zero, and the user can interrupt early if the direction looks wrong" (same file, line 32).

The transport underneath this is Server-Sent Events (SSE) — one long-lived HTTP connection over which the server keeps pushing `data:` lines, one `content_block_delta` event every few tokens, rather than the client polling or a bidirectional protocol like WebSocket. Simpler than WebSocket, and sufficient here because the traffic is one-directional: the server pushes, the client only ever reads (`claude-code-from-scratch/docs/05-streaming.md`, line 34).

The second, less obvious payoff — the one Concept 4 below builds on — is that in a genuinely multi-tool-call turn, real Claude Code's own numbers make the case concretely: a model's streamed response typically takes 5-30 seconds end to end, while a single tool execution (a file read, a search) typically takes under a second: *"典型场景下，工具执行延迟约 1 秒，而模型流式输出持续 5-30 秒。这意味着大部分工具执行可以完全隐藏在流式窗口内"* — "in a typical scenario, tool execution latency is about 1 second, while the model's streamed output continues for 5-30 seconds. This means most tool execution can be fully hidden inside the streaming window" (`how-claude-code-works/docs/04-tool-system.md`, §4.5, line 457). A blocking, non-streaming call has no way to exploit that gap — it only learns a tool call exists once the *entire* response has already arrived. A streaming call learns about it the moment that one block finishes, while the model may still be generating everything after it.

This phase is scoped to exactly the Anthropic streaming event model — no rich terminal UI (that's explicitly out of scope per Phase 4, Concept 4: no Ink, no `StreamingMarkdown`-style incremental Markdown re-rendering, no spinner state machine). What follows is the API-level event stream and what you can correctly do with it, not a terminal rendering pipeline.

---

## Concept 2: The Anthropic SDK's streaming event shapes, verified against the installed SDK

Rather than assume the shape of the streaming API from memory, this section is grounded directly against `@anthropic-ai/sdk@0.110.0`'s own `.d.ts` files — the same verification discipline Phase 4's Concept 2 used for `AbortSignal` support, applied here to the streaming surface.

**`stream()` is a distinct method from `create()`, not a flag.** It's tempting to guess that streaming means `client.messages.create({ ..., stream: true })`. That's not what this SDK version exposes as its ergonomic entry point. `create()` does have a streaming overload (`create(params: MessageCreateParamsStreaming, ...): APIPromise<Stream<RawMessageStreamEvent>>` — `resources/messages/messages.d.ts`, line 32) that real Claude Code's own source actually uses (see Concept 6 below for why), but the SDK's own documented, higher-level convenience method is `messages.stream()`, and its signature returns the stream object *directly*, not wrapped in a `Promise`:

```typescript
// verified directly — node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts, line 74
stream<Params extends MessageStreamParams>(
  body: Params,
  options?: RequestOptions
): MessageStream<ExtractParsedContentFromParams<Params>>;
```

The SDK's own JSDoc example on this method (same file, lines 59-72) confirms the call shape directly:

```typescript
const stream = client.messages.stream({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'What is 2+2?' }],
});
const message = await stream.finalMessage();
```

No `stream: true` field in the body — `.stream()` is the method that means "stream this," `.create()` is the method that means "don't." `MessageStream` (`lib/MessageStream.d.ts`) is an `AsyncIterable<MessageStreamEvent>` with an event-emitter-style `.on(event, listener)` API layered on top, plus a `.finalMessage(): Promise<Message>` convenience method that resolves with **exactly the same `Message` shape `create()` would have returned** — this is why swapping to streaming doesn't require touching anything downstream of the response (Phase 1's `messages.push({ role: "assistant", content: response.content })` doesn't change at all).

**The event types you actually need**, verified directly from `resources/messages/messages.d.ts`:

```typescript
// verified directly — messages.d.ts, lines 618-621 (InputJSONDelta) and 882-944 (the rest, abridged to the fields this phase uses)
export interface InputJSONDelta {
  partial_json: string;
  type: 'input_json_delta';
}
export type RawContentBlockDelta = TextDelta | InputJSONDelta | CitationsDelta | ThinkingDelta | SignatureDelta;
export interface RawContentBlockDeltaEvent {
  delta: RawContentBlockDelta;
  index: number;
  type: 'content_block_delta';
}
export interface RawContentBlockStartEvent {
  content_block: TextBlock | ThinkingBlock | ToolUseBlock | /* ...other block types... */;
  index: number;
  type: 'content_block_start';
}
export interface RawContentBlockStopEvent {
  index: number;
  type: 'content_block_stop';
}
export interface RawMessageStartEvent { message: Message; type: 'message_start'; }
export interface RawMessageStopEvent { type: 'message_stop'; }
export type RawMessageStreamEvent =
  | RawMessageStartEvent | RawMessageDeltaEvent | RawMessageStopEvent
  | RawContentBlockStartEvent | RawContentBlockDeltaEvent | RawContentBlockStopEvent;
```

Reading these bottom-up gives you the reconstruction rule directly from the types, without needing external documentation: a `Message`'s `content` array is built one block at a time. `content_block_start` announces a new block at a given `index` and tells you its `type` (`text` or `tool_use`, for this phase's purposes). Zero or more `content_block_delta` events follow, each carrying either a `text_delta` (for `text` blocks) or an `input_json_delta` (for `tool_use` blocks — see Concept 3 for why this one is a string fragment, not a value). `content_block_stop` announces that block's `index` is done — nothing more will arrive for it. `message_delta` carries the final `stop_reason` and usage once the whole message is essentially complete, and `message_stop` closes out the stream. Note this event model is *block-indexed*, not message-scoped: the API can (and, in multi-tool-call turns, does) have several blocks in flight, distinguished only by their `index`, which is exactly what Concept 3's accumulation logic below has to track correctly.

**The convenience API `MessageStream` exposes on top of these raw events** (`lib/MessageStream.d.ts`, lines 6-19, its `MessageStreamEvents` interface):

```typescript
// verified directly — MessageStream.d.ts
export interface MessageStreamEvents<ParsedT = null> {
  streamEvent: (event: MessageStreamEvent, snapshot: Message) => void; // every raw event, verbatim
  text: (textDelta: string, textSnapshot: string) => void;             // text_delta convenience
  contentBlock: (content: ContentBlock) => void;                       // fires once a block is complete
  finalMessage: (message: Message) => void;
  error: (error: AnthropicError) => void;
  abort: (error: APIUserAbortError) => void;
  // ...inputJson, thinking, signature, citation, message, connect, end
}
```

This phase uses exactly two of these: `.on("text", ...)` for the token-by-token console output (Implement 1), and `.on("streamEvent", ...)` for the raw event stream needed to track `tool_use` blocks by index (Implement 2) — `streamEvent` passes through every raw event verbatim, which is what lets this phase's code implement its own accumulation logic directly against the same event shapes real Claude Code's source uses (Concept 6 shows the real source's equivalent `switch (part.type)` over the identical event union).

---

## Implement 1: Replace `create()` with `stream()` — token-by-token text

This is deliberately the smallest possible change that gets text streaming to the terminal: swap the one API call, add one new optional field to thread a text callback through, and change nothing else about the loop's shape.

- [ ] Replace `src/agent.ts` with this (complete file, replacing Phase 4's version — this is an intermediate step; Implement 3 below adds tool-block tracking and early execution on top of this same structure):

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
    onText?: (textDelta: string) => void;
  }

  /**
   * The agent loop. Same overall shape as Phase 4: call the model, check for
   * tool_use blocks, execute them, push exactly two entries, repeat. The one
   * change in this step: the blocking client.messages.create() call is
   * replaced with client.messages.stream(), and text deltas are forwarded to
   * the caller via the new onText option as they arrive — instead of the
   * caller only ever seeing the finished response.content array once the
   * whole turn is done.
   */
  export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions
  ): Promise<AgentMessage[]> {
    const { client, model, systemPrompt, tools, maxTokens = 1024, signal, onText } =
      options;

    const readFileState: ReadFileState = new Map();

    while (true) {
      const stream = client.messages.stream(
        { model, max_tokens: maxTokens, system: systemPrompt, tools, messages },
        { signal }
      );

      if (onText) {
        stream.on("text", (textDelta) => onText(textDelta));
      }

      const response = await stream.finalMessage();

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

Notice what did **not** change from Phase 4: `RunAgentLoopOptions`'s existing fields, the `while (true)` shape, both `messages.push` calls, the `toolUses.length === 0` stopping condition, and the tool-execution `for` loop. `onText` is a plain optional callback — exactly the same "one new optional field threaded into the one API call" pattern Phase 4 used for `signal` (Phase 4, Step 1). `stream.finalMessage()` resolving to the identical `Anthropic.Message` shape `create()` used to return directly is what makes this swap this small — nothing downstream of `response` had to change.

- [ ] Type-check it:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

This was verified to type-check (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` in an isolated scratch directory, alongside Phase 2's unmodified `tools.ts`, as part of writing this tutorial. At this point, wiring `onText: (text) => process.stdout.write(text)` from `cli.ts` (done fully in Implement 4 below) is already enough to see token-by-token output — the remaining implementation steps add tool-block tracking and early execution, not anything further needed for text streaming itself.

---

## Concept 3: Tool inputs stream as partial JSON fragments — why you can't act on them until `content_block_stop`

Text deltas are simple: each `text_delta` is a usable string fragment, and concatenating them in arrival order reconstructs the final text — there's nothing to parse. Tool inputs are structurally different, and this is a common, subtle gotcha worth getting exactly right: **an `input_json_delta`'s `partial_json` field is a fragment of a JSON string, not a fragment of a JavaScript value.** `JSON.parse()` is not incremental — it either receives a complete, well-formed JSON document, or it throws. A `tool_use` block's `input` for something like `{"file_path": "a.txt"}` might arrive across three separate `input_json_delta` events, and none of the first two fragments is valid JSON on its own.

This is directly verifiable, not just asserted. A standalone script simulating exactly this event sequence (matching the real event shapes from Concept 2) shows the failure directly:

```javascript
// verified directly — run against the exact event shapes from Concept 2,
// no live API call needed since this tests JSON.parse's own behavior
const fragments = ['{"file_pat', 'h": "a.txt', '"}'];
let acc = "";
for (const f of fragments) {
  acc += f;
  try { JSON.parse(acc); console.log("parsed OK at:", JSON.stringify(acc)); }
  catch { console.log("NOT valid JSON yet:", JSON.stringify(acc)); }
}
```

Actual captured output from this exact script, run in an isolated scratch directory while writing this tutorial:

```
NOT valid JSON yet: "{\"file_pat"
NOT valid JSON yet: "{\"file_path\": \"a.txt"
parsed OK at: "{\"file_path\": \"a.txt\"}"
```

Only the *third* fragment, once concatenated with the first two, produces something `JSON.parse` accepts. This is why the correct pattern — used identically by real Claude Code's own source and by this phase's code — is: **accumulate the raw string fragments as they arrive, keyed by the block's `index`, and only call `JSON.parse` once, at `content_block_stop`, when the block is confirmed complete.** Real Claude Code's own stream reducer does exactly this accumulation, verified directly from source:

```typescript
// verified directly — real claude-code/src/services/api/claude.ts, lines 2087-2112 (abridged)
case 'input_json_delta':
  if (contentBlock.type !== 'tool_use' && contentBlock.type !== 'server_tool_use') {
    throw new Error('Content block is not a input_json block')
  }
  if (typeof contentBlock.input !== 'string') {
    throw new Error('Content block input is not a string')
  }
  contentBlock.input += delta.partial_json
  break
```

`contentBlock.input` is treated as a plain string accumulator here — `+=`, not a parse — for exactly the reason demonstrated above. The parse itself happens later, once `content_block_stop` fires for that block's `index` (`claude-code/src/services/api/claude.ts`, line 2171, discussed further in Concept 6). This phase's own `tools.ts` registry has no bearing on *this* mechanism — it's purely about how the wire protocol's JSON arrives, independent of which tools exist.

---

## Implement 2: Track tool_use blocks by index; parse once, at content_block_stop

- [ ] Replace `src/agent.ts` with this (complete file, replacing Implement 1's version). This step adds the accumulation machinery from Concept 3 and wires it to fire a callback the instant each block is confirmed complete — the callback itself is a no-op placeholder here (`onToolBlockComplete` isn't used for anything yet); Implement 3 wires it into early execution.

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
    onText?: (textDelta: string) => void;
  }

  /**
   * Accumulated state for one in-flight tool_use content block, keyed by its
   * stream index (NOT its tool_use id — the id is known from
   * content_block_start, but the index is what content_block_delta and
   * content_block_stop use to refer back to "this same block").
   */
  interface TrackedToolBlock {
    id: string;
    name: string;
    caller: Anthropic.ToolUseBlock["caller"];
    inputJson: string;
  }

  /**
   * Streams one turn of the Messages API. Forwards text deltas to onText as
   * they arrive (Step 1), and separately tracks every tool_use block's
   * partial JSON by index, firing onToolBlockComplete the instant a block's
   * JSON is fully accumulated (content_block_stop) and successfully parsed —
   * this can happen well before the rest of the turn (further text, or a
   * second tool_use block) has finished streaming (Concept 3).
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

    // Tool inputs stream as raw JSON string fragments (input_json_delta),
    // not values — accumulate by block index and only JSON.parse once
    // content_block_stop confirms the block is complete (Concept 3).
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
            // stream event handler — the same "errors are data, don't take
            // down the whole operation" instinct Phase 2 established for
            // tool dispatch (Phase 2, Concept 2), applied here to a
            // streaming callback instead of a tool call.
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

  export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions
  ): Promise<AgentMessage[]> {
    const { client, model, systemPrompt, tools, maxTokens = 1024, signal, onText } =
      options;

    const readFileState: ReadFileState = new Map();

    while (true) {
      const response = await streamOneTurn(messages, {
        client,
        model,
        systemPrompt,
        tools,
        maxTokens,
        signal,
        onText,
        onToolBlockComplete: () => {
          // Wired to early tool execution in Step 3 — a no-op for now.
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

One detail worth flagging precisely because it only shows up once you try to compile this against the real, current SDK rather than assume the shape from memory: **`Anthropic.ToolUseBlock` requires a `caller` field** in `@anthropic-ai/sdk@0.110.0` (`caller: DirectCaller | ServerToolCaller | ServerToolCaller20260120` — `resources/messages/messages.d.ts`, line 1525), which earlier phases never had to think about because they only ever *read* `tool_use` blocks the API had already produced (which always include `caller`), never *constructed* one by hand. This phase's `onToolBlockComplete` callback does construct one from scratch (from accumulated fragments), so it has to carry `caller` through from the original `content_block_start` event, or `tsc` rejects it — confirmed directly: omitting it and running `npx tsc --noEmit` produces `error TS2345: ... Property 'caller' is missing in type '{ type: "tool_use"; ... }' but required in type 'ToolUseBlock'.` This is exactly the kind of thing that's invisible if you copy older reference code without re-checking it against the SDK version actually installed — the `TrackedToolBlock.caller` field and its propagation into the reconstructed block above exist specifically to satisfy this.

- [ ] Type-check it:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

This was verified to type-check (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` in an isolated scratch directory as part of writing this tutorial — including hitting the exact `caller`-field compile error described above on the first attempt (constructing the object without `caller`) and confirming the fix resolves it. The accumulation logic itself (fragmenting a real JSON payload across three deltas, tracking by index, parsing once at `content_block_stop`) was additionally verified by directly simulating the event sequence from Concept 2 in a standalone script and confirming both of two concurrently-tracked blocks (indices 0 and 1) reconstruct their correct, distinct `input` objects — real captured output from that run:

```
Both tool inputs reconstructed correctly: true
```

---

## Concept 4: The streaming tool pre-execution trick — what triggers it, what it buys, what's still not safe

Here is the mechanism precisely, because "start tools early" is easy to state vaguely and easy to get subtly wrong: **the moment a single `tool_use` content block's `content_block_stop` event fires — and only for that one block's `index` — its JSON input is fully known and valid, even though the assistant's overall turn may still be streaming.** The model can, and often does, keep generating after a `tool_use` block completes: more explanatory text, or a second `tool_use` block for another tool call in the same turn. `content_block_stop` is a block-level signal, not a turn-level one (Concept 2's event model is block-indexed for exactly this reason). Real Claude Code's own deep-dive on this states the timing precisely: a typical tool execution (a file read, a search) costs about a second, while the model's own streamed output for that turn runs 5-30 seconds — *"这意味着大部分工具执行可以完全隐藏在流式窗口内"* — "this means most tool execution can be fully hidden inside the streaming window" (`how-claude-code-works/docs/04-tool-system.md`, §4.5, line 457, already quoted in Concept 1).

**What this buys, concretely:** if the tool starts executing at `content_block_stop` instead of waiting for the whole turn to finish, its execution time overlaps with whatever the model generates *after* that block — rather than being added on top, sequentially, once the full response has already arrived. The architecture deep-dive's own ASCII timeline makes the shape of the win visible directly (`how-claude-code-works/docs/04-tool-system.md`, §4.5, lines 446-454, translated):

```
Serial (wait for all tool_use blocks to finish first):
[==========API streaming==========][tool1][tool2][tool3]

Streaming parallel execution (StreamingToolExecutor):
[==========API streaming==========]
   [tool1]              ← starts the instant tool_use_1 completes
      [tool2]           ← overlaps with the 5-30s streaming window
         [tool3]
[======results are ready by the time API output finishes======]
```

**What's explicitly NOT safe to change, and why:** you still cannot send `tool_result` blocks back to the API until the *entire* assistant turn is known. Phase 1, Concept 1 established that the API needs a complete assistant turn (with every `tool_use` block it contains) before it will accept a matching `user` turn of `tool_result` blocks — you can't reply to "half a turn." Early execution only starts the *tool's own work* sooner; it changes nothing about when results get sent back. This phase's code reflects that directly: `onToolBlockComplete` only ever *starts* a `Promise`, stored in a `Map`; nothing pushes to `messages` until `stream.finalMessage()` has resolved and the full `toolUses` array is known, exactly as before.

**Why only read-only tools qualify.** This is where Phase 2's `readOnly` classification (Phase 2, Concept 6's forward reference, finally consumed here) does the real work: a read-only tool's result can't be invalidated by anything that happens later in the same turn, because it has no side effects to race against — reading a file doesn't care whether the model goes on to call a second tool afterward. A write tool is different in a way that matters even *within* a single turn: starting `edit_file` the instant its own block completes, while the model might still be about to stream a second `tool_use` block, would let a write proceed before the full shape of the turn — including any later tool call that might have changed the situation — is known. This is the same underlying justification Phase 2 gave for why write tools must serialize rather than run alongside other tools at all (Phase 2, Concept 6): "read-only tools can run in parallel because they only observe state and can't interfere with each other; anything that writes must run one-at-a-time." Early-starting a write tool would violate that same invariant one level earlier — before the turn is even fully known, not just before another concurrent tool finishes. So the gate is exactly `tool.readOnly`, reused as-is from Phase 2's registry, not a new classification.

**Parallel execution of read-only tools, and why this design needs no separate `Promise.all` step.** The phase breakdown asks specifically about "two independent read-only tool calls completing in parallel" — and the mechanism above already produces this, without an extra explicit batching step, for a structural reason worth being precise about: **starting a `Promise` and *not* awaiting it immediately is already concurrency.** Each read-only tool's `executeTool(...)` call is kicked off the instant its own `content_block_stop` fires and stored in a `Map`, not awaited there. If the model streams two read-only `tool_use` blocks in the same turn, both promises are in flight simultaneously well before the tool-processing loop ever reaches them — functionally the same outcome `Promise.all([p1, p2])` would give you, just triggered progressively as each block completes rather than batched all at once after the fact. Contrast this with the reference project's OpenAI-compatible backend, which has to reach for an *explicit* `Promise.all` over a batch (`claude-code-from-scratch/src/agent.ts`, its `oaiBatches`/`Promise.all` logic) for a concrete, structural reason: OpenAI's streaming protocol doesn't expose a per-block completion event the way Anthropic's `content_block_stop` does, so there's no signal to act on progressively — the only option left is to wait for the whole response, then batch. Anthropic's streaming model makes that explicit batching step unnecessary here; the reference project's own text states this plainly: *"对于 Anthropic 后端，流式工具执行天然处理了并行——每个工具 block 完整时就启动执行，多个工具自然重叠运行"* — "for the Anthropic backend, streaming tool execution handles parallelism naturally — each tool starts the moment its block completes, multiple tools' executions naturally overlap" (`claude-code-from-scratch/docs/05-streaming.md`, line 577).

**One honest caveat about what "overlap" means for *this specific registry's* tools, worth stating precisely rather than glossing over.** `read_file` and `list_files` are implemented with Node's *synchronous* `fs` calls (`readFileSync`, `readdirSync` — Phase 2's `tools.ts`), which block the single JS thread for the (very brief, microsecond-scale) duration of the syscall — Phase 4, Concept 2 already established this exact point when explaining why there's no meaningful "interrupt mid-tool-execution" to build yet. That means two early-started `read_file` calls do not truly run *simultaneously* with each other at the engine level the way two concurrent network requests would — but this doesn't undercut the real benefit, because the benefit that actually matters for *these* tools is overlap with the **model's own continued streaming**, not overlap between the tools themselves: both reads still complete, one after the other but both essentially instantly, well before the model finishes generating the rest of its turn — so by the time the loop reaches the tool-processing step, both results are already sitting ready, exactly matching the reference project's own framing of file reads being "almost entirely hidden" inside the 5-30 second streaming window. The genuine tool-vs-tool overlap benefit (two things actually running at once, each taking a non-trivial amount of wall-clock time) is real and does apply once a tool is backed by real asynchronous I/O — a network fetch, a subprocess — which is exactly why Implement 3's verification below uses an artificial `setTimeout`-based delay to make that specific benefit *measurable*, while being explicit that it's standing in for a hypothetical slower/asynchronous tool this registry doesn't have yet, not a claim about `read_file`/`list_files` racing each other today.

---

## Implement 3: Early-start read-only tools the instant their block completes

- [ ] Replace `src/agent.ts` with this (complete file, replacing Implement 2's version — this is the final state of `agent.ts` for this phase):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { executeTool, findTool, type ReadFileState } from "./tools.js";

  export type AgentMessage = Anthropic.MessageParam;

  export interface RunAgentLoopOptions {
    client: Anthropic;
    model: string;
    systemPrompt?: string;
    tools?: Anthropic.Tool[];
    maxTokens?: number;
    signal?: AbortSignal;
    onText?: (textDelta: string) => void;
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
   * (further text, or another tool_use block) is still streaming (Concept 4).
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
   * repeat. New in this phase: the API call streams (text arrives via
   * onText as it's generated), and every read-only tool_use block starts
   * executing the instant its own content_block_stop fires — via
   * earlyExecutions below — rather than waiting for the whole turn to
   * finish arriving (Concept 4). Write tools are never early-started; they
   * still only run from the tool-processing loop below, in order, after the
   * full turn is known — unchanged from every prior phase.
   *
   * Sending tool_results back to the API still only happens after the WHOLE
   * turn is known (stream.finalMessage() has resolved and every tool_use in
   * this turn is in hand) — early execution only starts the tool's own
   * work sooner, it never changes when results are sent (Concept 4).
   */
  export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions
  ): Promise<AgentMessage[]> {
    const { client, model, systemPrompt, tools, maxTokens = 1024, signal, onText } =
      options;

    const readFileState: ReadFileState = new Map();

    while (true) {
      // Tools whose content_block_stop already fired during this turn's
      // stream, keyed by tool_use id, started the instant we knew enough to
      // run them safely — not held back until the whole turn finishes
      // streaming (Concept 4).
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
          // turn is known (Phase 2, Concept 6). A write tool started early
          // could run before a later tool_use in the same turn gives the
          // full picture, or race a second write behind it — the same
          // "writes serialize" invariant Phase 2 established, applied one
          // level earlier (Concept 4).
          if (tool?.readOnly) {
            const input = block.input as Record<string, unknown>;
            earlyExecutions.set(
              block.id,
              executeTool(block.name, input, readFileState)
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
        // somehow wasn't tracked) execute here, in order, exactly as in
        // every prior phase.
        const earlyPromise = earlyExecutions.get(toolUse.id);
        const result =
          earlyPromise !== undefined
            ? await earlyPromise
            : await executeTool(
                toolUse.name,
                toolUse.input as Record<string, unknown>,
                readFileState
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

- [ ] Type-check it:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

This file, in exactly this form, was type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0` and Phase 2's unmodified `tools.ts`, in an isolated scratch directory, as part of writing this tutorial.

**This was also verified at runtime, against the compiled code, using a fake client** — the same technique Phase 4's Concept 2 used to prove the abort-during-tool-execution scenario without a live API call. A fake `client.messages.stream()` returned an object mimicking `MessageStream`'s `.on()`/`.finalMessage()` shape, scripted to emit two read-only `tool_use` blocks (backed by test-only tools with an artificial 300ms delay each, standing in for a hypothetical slower/asynchronous tool per Concept 4's caveat — real `read_file` completes in microseconds, too fast to observe overlap on a wall clock), staggered 20ms apart exactly as real streaming would arrive. Real captured output from that run:

```
callLog: [ { event: 'block0_stop', t: 0 }, { event: 'block1_stop', t: 22 } ]
elapsed ms: 327
```

Two 300ms-delay early-started tools completed in ~327ms total, not ~600ms — direct, measured proof that both promises ran concurrently rather than sequentially, exactly the "observable via timing" verification the phase plan calls for. A second run against the same code, using a test-only *write*-classified tool (`readOnly: false`) with the same delay, confirmed the opposite: its `content_block_stop` fired at ~2ms, but its actual execution only began at ~54ms — after the simulated remainder of the turn's streaming and `finalMessage()` resolution — proving the `tool?.readOnly` gate correctly withholds early execution from write tools:

```
content_block_stop fired at (ms since start): 2
write tool execution actually began at (ms since start): 54
execution began AFTER content_block_stop, not at it: true
```

Both fake-client scripts also confirmed `messages` ends up with the correct, fully-formed structure afterward (4 entries: `user`, `assistant` with both `tool_use` blocks, `user` with both `tool_result` blocks correctly matched back to their `tool_use_id`s, `assistant` with the final text) — the two-entries-per-turn growth from Phase 1, Concept 3 is unchanged by any of this.

---

## Concept 5: Composing streaming with Phase 4's AbortSignal

Phase 4's entire interrupt-handling design rested on one proven property: `messages` is never left in a half-written state after an abort, because every `messages.push(...)` sits *after* the one operation (`client.messages.create(...)`) that could reject, so an abort either happens before any push for that turn, or after the turn's full pair has already been pushed (Phase 4, Concept 2). Streaming has to preserve that property exactly, not merely "also support cancellation" — and it does, for the same structural reason: `stream.finalMessage()` is still the one `await` that can reject, and `messages.push({ role: "assistant", ... })` still sits strictly after it.

**Verified directly against the real SDK, not assumed.** `client.messages.stream(...)` takes the exact same second-argument shape Phase 4 verified for `create()` — `{ signal }` in `RequestOptions` — and produces the identical failure mode on an already-aborted signal:

```typescript
// run directly against the real, installed SDK — no live API call needed,
// the same pre-aborted-signal trick Phase 4's Concept 2 used for create()
const client = new Anthropic({ apiKey: "sk-ant-fake-key-for-abort-test" });
const controller = new AbortController();
controller.abort();
const stream = client.messages.stream(
  { model: "claude-opus-4-6", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
  { signal: controller.signal }
);
await stream.finalMessage(); // rejects
```

Real captured output from this exact script:

```
stream() returned synchronously without throwing, object type: MessageStream
caught error, name: Error message: Request was aborted.
instanceof APIUserAbortError: true
```

`client.messages.stream(...)` itself returns a `MessageStream` object immediately, without throwing — the rejection only surfaces once you `await stream.finalMessage()`, exactly mirroring how `create()`'s rejection only surfaces once you `await` it. Same error class (`Anthropic.APIUserAbortError`), same `instanceof` check Phase 4 established as the correct one (not a string comparison against `e.name`). This confirms Phase 4's whole abort mechanism — `currentController.abort()` in `cli.ts`'s SIGINT handler, the `try/catch` checking `instanceof Anthropic.APIUserAbortError` — composes with streaming with **zero changes to that mechanism**. The `signal` field in `RunAgentLoopOptions` didn't move, `cli.ts`'s SIGINT handler doesn't need to know or care that the call underneath is now a stream.

**One new, honest nuance streaming introduces that Phase 4 didn't have to consider.** Phase 4's proof was about `messages` — the array stays valid either way. Streaming adds a second, separate observable: **the terminal**. If a turn is interrupted partway through the model's text, whatever text had already streamed via `onText` is already sitting on the user's screen — written, real, and not retractable — even though that same text never makes it into `messages` (the `messages.push` for that turn's assistant message never runs, exactly as Phase 4 proved). This is not a bug or a gap in the abort guarantee; it's a direct, expected consequence of streaming showing the user more, sooner, than a blocking call ever would have. The property that actually matters — `messages` staying valid for the *next* API call — is untouched; what's new is simply that the human on the other end of the terminal may have honestly seen a few sentences of an answer that the conversation's official record doesn't retain. Worth being able to say this precisely in an interview: streaming can make "what the user saw" and "what's in the model's context" diverge on an interrupt, in a way a non-streaming design never could, and that divergence is acceptable specifically because it only ever shows the user *more* true information, never less or wrong.

---

## Implement 4: Thread `signal` through `.stream()`; the one justified `cli.ts` change

`signal` is already threaded through `streamOneTurn` into `client.messages.stream(..., { signal })` in Implement 3's `agent.ts` above — no further change is needed there; this step is about `cli.ts`, and about proving the composition holds.

Recall Phase 4's own comment, left specifically for this phase to act on: *"Phase 5 (Streaming) replaces this call (and only this call) with a streaming equivalent — nothing else in this function needs to change for that."* That's almost exactly true — `runAgentLoop`'s call site itself doesn't need a different shape — but one small, unavoidable knock-on change follows directly from Implement 1: text now prints to the terminal *during* the call, via `onText`, so the old `printFinalText(messages)` call *after* `runAgentLoop` returns would now print the same text a second time. This is the one specific, justified reason to touch `cli.ts` at all in this phase — nothing about parsing, sessions, or the SIGINT handler changes.

- [ ] Replace `src/cli.ts` with this (complete file, replacing Phase 4's version — every change from Phase 4 is marked below):

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

    let currentController: AbortController | null = null;
    let sigintCount = 0;

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

        // ─── The one call site: every REPL turn goes through here ────────
        // Phase 5 change: onText streams tokens to stdout as they arrive
        // (Concept 1/Step 1), so the old printFinalText(messages) call that
        // used to run after this — reading the finished response back out
        // of messages and printing it in one shot — has been removed; it
        // would now double-print text that already streamed to the
        // terminal. A single trailing newline replaces it for a clean
        // prompt separation.
        try {
          await runAgentLoop(messages, {
            client,
            model,
            systemPrompt,
            tools,
            signal: currentController.signal,
            onText: (text) => process.stdout.write(text),
          });
          process.stdout.write("\n");
        } catch (e) {
          if (!(e instanceof Anthropic.APIUserAbortError)) {
            console.error(`Error: ${(e as Error).message}`);
          }
          // An aborted turn already got its "(interrupted)" message from
          // the SIGINT handler above — nothing more to print here. Any
          // text that streamed before the abort is already on screen
          // (Concept 5) — there is nothing left to print or roll back.
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
      // Phase 5 change: same onText/trailing-newline swap as the REPL
      // branch above, for the identical reason — text now streams to
      // stdout during the call instead of being printed once afterward.
      messages.push({ role: "user", content: prompt });
      try {
        await runAgentLoop(messages, {
          client,
          model,
          systemPrompt,
          tools,
          onText: (text) => process.stdout.write(text),
        });
        process.stdout.write("\n");
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

The diff against Phase 4's version is exactly two call sites (each gaining `onText: (text) => process.stdout.write(text)` and swapping `printFinalText(messages)` for `process.stdout.write("\n")`) and the removal of the now-unused `printFinalText` function. `parseArgs`, `buildSessionData`, `ReplOptions`, the SIGINT handler, `askQuestion`'s structure, and `main`'s `--resume` handling are byte-for-byte unchanged from Phase 4.

- [ ] Confirm the diff is exactly that:

  ```bash
  cd /Users/grexrr/Documents/NAC
  git diff src/cli.ts
  ```

- [ ] Type-check the whole project:

  ```bash
  npx tsc --noEmit
  ```

This file was type-checked (`npx tsc --noEmit`, zero errors) in an isolated scratch directory alongside this phase's `agent.ts`, Phase 2's unmodified `tools.ts`, Phase 3's unmodified `prompt.ts`, and Phase 4's unmodified `session.ts`, as part of writing this tutorial.

---

## Concept 6: What real Claude Code does differently (production contrast)

Three real, cited differences worth knowing about even though this phase deliberately doesn't build them:

**Real Claude Code doesn't use the SDK's convenience `MessageStream` wrapper at all.** It calls the lower-level streaming overload of `create()` directly and reduces the raw event stream itself, with an explicit comment naming exactly why:

```typescript
// verified directly — real claude-code/src/services/api/claude.ts, lines 1818-1824
// Use raw stream instead of BetaMessageStream to avoid O(n²) partial JSON parsing
// BetaMessageStream calls partialParse() on every input_json_delta, which we don't need
// since we handle tool input accumulation ourselves
const result = await anthropic.beta.messages
  .create({ ...params, stream: true }, { signal, ... })
  .withResponse()
```

Interesting, precise nuance worth flagging honestly rather than repeating the comment as unqualified current truth: checking the *currently installed* `@anthropic-ai/sdk@0.110.0`'s own implementation shows this specific concern has since been mitigated in the SDK itself — its internal `withLazyInput` helper installs `.input` as a **memoized getter**, so the partial-JSON parse happens once, on first read, not on every delta (`node_modules/@anthropic-ai/sdk/internal/message-stream-utils.js`, verified directly: *"installing `.input` as a memoized getter so the partial-JSON parse happens on first read instead of on every delta"*). Real Claude Code's comment may well have been accurate against whatever SDK version it was written against; it's flagged here as a real, cited engineering concern from production, not as proof that today's convenience wrapper still has the exact cost described. Either way, this phase's own accumulation approach — track raw string fragments per index, parse exactly once, at `content_block_stop` (Concept 3, Implement 2) — is the *same technique* real Claude Code's manual reducer uses; the only difference is that this phase receives the raw events through the SDK's `streamEvent` passthrough rather than a fully hand-rolled SSE reducer over `create({ stream: true })`. For a single-file, three-tool registry, that's the right trade — a hand-rolled SSE reducer buys instrumentation and error-handling control this project has no use for yet (retry-classification, idle-stream watchdogs, analytics event logging — all real, all visible in the ~380-line excerpt this phase's Concept 2/3 quoted from).

**Real concurrency has a hard cap and a cancellation-propagation rule this phase's registry is too small to need.** Production's `StreamingToolExecutor` (`claude-code/src/services/tools/StreamingToolExecutor.ts`, ~530 lines) generalizes exactly this phase's `earlyExecutions` idea into a proper scheduler, with two refinements worth knowing by name: a **hard concurrency ceiling**, `MAX_TOOL_USE_CONCURRENCY = 10` (configurable via `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`), specifically to stop a model that requests 20 simultaneous file reads from exhausting file handles or saturating I/O (`how-claude-code-works/docs/04-tool-system.md`, §4.5, line 470); and a **sibling-cancellation mechanism** (`siblingAbortController`) — if one `Bash` tool in a concurrent batch errors, its siblings in the same batch are cancelled too, on the reasoning that a failed shell command often invalidates the point of running the others, whereas a failed `FileReadTool`/`WebFetchTool` call is treated as independent and doesn't cancel its siblings (same section, line 472). This phase's three-tool registry (two read-only tools, no subprocess execution) has no scenario where either refinement changes behavior yet — a documented, deliberately-unbuilt concept in the same spirit as Phase 2's deferred tool loading (Phase 2, Concept 5) and Phase 3's prompt-caching boundary (Phase 3, "What's next").

**The reference project's dual-backend design is the origin point of this exact chapter, and stays a stretch note, not a requirement, per this series' Anthropic-only decision.** `claude-code-from-scratch`'s chapter 5 introduces exactly this streaming material specifically as the natural point to *also* add an OpenAI-compatible backend — because OpenAI's `tool_calls` delta shape has no `content_block_stop`-equivalent per-block signal (arguments arrive as fragments identified only by an `index`, with no explicit "this one's done" event), that backend has to accumulate everything and only act once the whole stream ends, using explicit `Promise.all` batching over consecutive safe tools as its only available parallelism mechanism (`claude-code-from-scratch/docs/05-streaming.md`, its `callOpenAIStream`/OpenAI-batching sections). Per this series' Phase 1 decision (Anthropic-only, `x-api-key`, no provider abstraction), this project does not build that second backend — it's noted here only so the *reason* streaming and dual-backend support are paired in the reference material is understood, not left as an unexplained coincidence.

---

## Verify

- [ ] **Type-check the whole project:**

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

  Expect zero errors.

- [ ] **Watch text appear token-by-token, not all at once.** With `ANTHROPIC_API_KEY` exported, run:

  ```bash
  npm start -- "Write a 150-word explanation of how TCP handshakes work."
  ```

  Expect the response to visibly print incrementally — words appearing in a stream rather than the whole paragraph showing up at once after a pause. Contrast this against Phase 4's behavior on the same prompt (a single multi-second pause, then the entire answer appears at once) if you still have that version checked out to compare against (e.g. `git stash` / `git diff HEAD~1` on `agent.ts`).

- [ ] **Confirm two read-only tool calls in one turn observably overlap, using timing logs.** Temporarily add timestamped logging around the early-execution gate in `agent.ts`'s `onToolBlockComplete` callback (inside `runAgentLoop`) and around the corresponding line in the tool-processing `for` loop:

  ```typescript
  onToolBlockComplete: (block) => {
    const tool = findTool(block.name);
    if (tool?.readOnly) {
      console.error(`[early-start] ${block.name} at t=${Date.now()}`);
      const input = block.input as Record<string, unknown>;
      earlyExecutions.set(block.id, executeTool(block.name, input, readFileState));
    }
  },
  ```

  Ask something that triggers two independent reads in one turn, e.g. `npm start -- "Read package.json and tsconfig.json and summarize both."` Expect both `[early-start]` lines to print with timestamps close together — both well *before* the model has finished streaming its full response — confirming both reads started during the stream, not after it. Because `read_file` itself completes in microseconds (Concept 4's caveat), this log won't show a large *duration* difference between "early" and "not," but it does prove the *timing* claim: both tool executions began while `content_block_stop` events were still arriving, not after `stream.finalMessage()` resolved. Remove the temporary logging afterward.

- [ ] **See genuine multi-tool wall-clock overlap, using an artificial-delay scratch script (optional, deeper verification).** Because this registry's actual tools are too fast to show overlap duration directly, reproduce the fake-client timing test described in Implement 3's verification notes in a scratch directory: a fake `client.messages.stream()` emitting two read-only `tool_use` blocks backed by test-only tools with a 300ms artificial delay each. Confirm total elapsed time is close to 300ms (both ran concurrently), not close to 600ms (which would mean they ran sequentially). This mirrors exactly how Phase 2's tutorial used `utimesSync` to make an otherwise-instant mtime check observable, and Phase 4's tutorial used a fake client to make an otherwise-instant abort race observable.

- [ ] **Confirm write tools are never early-started.** Run a prompt that both reads and edits a file, e.g. `npm start -- "Read src/index.ts, then add a comment '// hello' at the top."` — this should behave correctly (the edit happens after the read, mtime guard still enforced exactly as Phase 2 built it), and if you added the `[early-start]` logging above, confirm no `[early-start]` line prints for the `edit_file` call — only for `read_file`.

- [ ] **Interrupt mid-stream and confirm `messages` stays valid, composing with Phase 4's mechanism unchanged.** Ask a longer question, press Ctrl+C while text is actively streaming to the terminal. Expect: whatever text had already printed remains visible (Concept 5's honest nuance — it's not retracted), `(interrupted)` prints, the REPL stays alive, and a follow-up question in the same session still has full access to everything from before the interrupted turn (the interrupted turn contributes nothing to `messages`, exactly as Phase 4 proved for the non-streaming case). Confirm session persistence still works across this: `--resume` after an interrupted-then-continued session should recall the conversation correctly.

- [ ] **Confirm one-shot mode also streams.** Run `npm start -- "What is 2 + 2?"` (no REPL) and confirm text still appears incrementally rather than all at once, and the process still exits cleanly afterward, with a session file still written to `~/.nac-mini-agent/sessions/`.

---

## What's next

Phase 6 (Permissions & Safety) is the other consumer of Phase 2's `readOnly` flag this series has been building toward — it will use the identical field to decide which tool calls need to pause and ask a human before running at all, the same way this phase used it to decide which tool calls are safe to start early. Phase 7 (Context Engineering) builds directly on this phase's streaming: compaction has to operate correctly on a `messages` array that may have been grown by a turn whose text streamed and whose tools ran early, and needs to preserve the same tool_use/tool_result pairing invariant Phase 1 established regardless of how the turn that produced it was executed internally.

---

## Grounding notes

Every non-trivial claim above is grounded in one of these sources, or flagged where it isn't:

- **Perceived-latency framing (token rate, 2-3s tolerance, SSE rationale)** — direct (translated) quotes from `claude-code-from-scratch/docs/05-streaming.md`, lines 30-34, read directly.
- **Real Claude Code's tool-execution-vs-streaming-window timing numbers ("~1s tool exec, 5-30s streaming, hides most tool latency")** — direct (translated) quote from `how-claude-code-works/docs/04-tool-system.md`, §4.5, line 457, read directly.
- **`messages.stream()`'s exact signature, its JSDoc example, and `MessageStream`'s `.on()`/`.finalMessage()`/`AsyncIterable` shape** — verified directly against the installed `@anthropic-ai/sdk@0.110.0`'s own `.d.ts` files: `resources/messages/messages.d.ts` (lines 31-74 for the `create`/`stream` method signatures) and `lib/MessageStream.d.ts` (the full class declaration and its `MessageStreamEvents` interface, lines 6-120), both read directly in an isolated scratch install.
- **The exact event interfaces (`InputJSONDelta`, `RawContentBlockStartEvent`, `RawContentBlockDeltaEvent`, `RawContentBlockStopEvent`, `RawMessageStartEvent`, `RawMessageStopEvent`, `RawMessageStreamEvent`)** — verified directly against `resources/messages/messages.d.ts`, lines 618-944, read directly in the same scratch install.
- **`Anthropic.ToolUseBlock` requiring a `caller` field in this SDK version, and the exact compile error produced by omitting it** — discovered directly while type-checking this phase's own code against `@anthropic-ai/sdk@0.110.0` (`resources/messages/messages.d.ts`, lines 1520-1529); the `TS2345 ... Property 'caller' is missing` error was actually produced and then actually resolved in the isolated scratch directory used to write this tutorial, not inferred.
- **Partial JSON fragments not being independently parseable, and the exact three-fragment example** — independently verified via a standalone Node script run in an isolated scratch directory while writing this tutorial; the captured output quoted in Concept 3 is real, not a predicted transcript.
- **Real Claude Code's exact stream-event reducer (`message_start`, `content_block_start`, `content_block_delta`'s `input_json_delta`/`text_delta` handling, `content_block_stop`, `message_delta`, `message_stop`)** — read directly from real `claude-code/src/services/api/claude.ts`, lines 1980-2296 (the full `switch (part.type)` block), with the `contentBlock.input += delta.partial_json` accumulation quoted from lines 2087-2112.
- **Real Claude Code using the raw `create({ stream: true })` overload instead of the SDK's convenience `MessageStream`/`BetaMessageStream` wrapper, and its stated reason (avoiding O(n²) partial-JSON parsing)** — direct quote and code excerpt from real `claude-code/src/services/api/claude.ts`, lines 1818-1832, read directly.
- **The currently-installed SDK's `withLazyInput` memoized-getter mitigation for that same concern** — read directly from `node_modules/@anthropic-ai/sdk/internal/message-stream-utils.js` in the isolated scratch install used for this tutorial; presented explicitly as a nuance/caveat on the real-source comment above, not as proof the production comment is outdated (no claim is made about which SDK version real Claude Code is pinned to).
- **The `CONCURRENCY_SAFE_TOOLS`-gated `earlyExecutions` Map pattern, and the "Anthropic backend needs no explicit Promise.all, OpenAI backend does" contrast** — read directly from `claude-code-from-scratch/docs/05-streaming.md` (lines 416-444 for the early-execution mechanism and its design-point bullets, line 577 for the "流式工具执行天然处理了并行" quote) and `claude-code-from-scratch/src/agent.ts` (the real `chatAnthropic`/`callAnthropicStream` implementation, lines 1035-1229, and `CONCURRENCY_SAFE_TOOLS`'s definition in `claude-code-from-scratch/src/tools.ts`, line 21), all read directly. The streaming-tool-pre-execution **ASCII timeline** itself is not in this file (it does not appear anywhere in `claude-code-from-scratch/docs/05-streaming.md`) — it is read directly from `how-claude-code-works/docs/04-tool-system.md`, §4.5, lines 445-455.
- **`StreamingToolExecutor`'s `MAX_TOOL_USE_CONCURRENCY = 10` cap and its sibling-cancellation mechanism** — read directly from `how-claude-code-works/docs/04-tool-system.md`, §4.5, lines 461-472 (including the `canExecuteTool()` excerpt and the `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` env var name).
- **Read-only-vs-write tool classification determining safe concurrency, reused as-is from Phase 2** — this tutorial's own application of Phase 2, Concept 6's forward reference (`phase-02-tool-system.md`), not a new claim; cross-checked against the identical real-source principle in `how-claude-code-works/docs/04-tool-system.md` §4.5's `isReadOnly`-gated `runTools()` excerpt (lines 387-405).
- **`AbortSignal`/`APIUserAbortError` composing identically with `.stream()` as with `.create()`** — independently verified via a standalone script run against the real, installed SDK in an isolated scratch directory while writing this tutorial (Concept 5's quoted script and its real captured output: `instanceof APIUserAbortError: true`), directly extending Phase 4, Concept 2's own verified proof for `.create()`.
- **All TypeScript in Implement 1-4 (`agent.ts` in each of its three incremental states, and the final `cli.ts`)** — actually type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0`, Phase 2's unmodified `tools.ts`, Phase 3's unmodified `prompt.ts`, and Phase 4's unmodified `session.ts`, in an isolated scratch directory (`/private/tmp/.../scratchpad/verify-streaming-phase5`), as part of writing this tutorial.
- **The early-execution overlap timing test (327ms for two 300ms-delay early-started read-only tools) and the write-tool-not-early-started timing test (content_block_stop at ~2ms, actual execution at ~54ms)** — both actually executed against the real compiled `agent.ts` from Implement 3, driven by a fake client mimicking `MessageStream`'s `.on()`/`.finalMessage()` shape, in the same isolated scratch directory. Both are real captured output from real runs, not predicted transcripts — including the correctly-reconstructed final `messages` array (4 entries, tool_result blocks matched to the right `tool_use_id`s) confirmed in the same runs.
- **Unverified / flagged explicitly:** no live Anthropic API call was made while writing this tutorial — no API key was available in this authoring environment, consistent with every prior phase's own flagged limitation. This means the Verify section's live-model steps (watching real token-by-token output from an actual streamed response, the exact tool-call sequence a live model chooses when asked to read two files, the exact wording of any live response) were not captured directly and are left for you to confirm with your own API key. What *is* independently verified, not merely predicted, is everything about the mechanism: the SDK's real type shapes and streaming method signature, the real behavior of an aborted signal against both `.create()` and `.stream()`, the partial-JSON-fragment accumulation logic, and — most importantly for this phase's central claim — genuine, measured wall-clock overlap between two early-started tool executions and the correct exclusion of a write-classified tool from early execution, both verified by actually running the real compiled `agent.ts` code against a scripted fake client, not by reasoning about it in the abstract.
