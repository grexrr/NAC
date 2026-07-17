import Anthropic from "@anthropic-ai/sdk";
import { checkAndCompact, CompactionState, persistLargeResult, runCompressionPipeline } from "./compact.js";
import { PermissionMode } from "./permissions.js";
import { executeTool, findTool, PermissionState, ReadFileState } from "./tools.js";

export type AgentMessage = Anthropic.MessageParam;

export interface RunAgentLoopOptions {
  client: Anthropic;
  model: string;
  systemPrompt?: string,
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (textDelta: string) => void; // onText handeler for textDelta
  permissionMode?: PermissionMode;
  confirmTool?: (message: string) => Promise<boolean>;
  compaction?: CompactionState
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
  inputJson: string
}

/**
 * Streams one turn of the Messages API. Forwards text deltas to onText as
 * they arrive, and separately tracks every tool_use block's
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
  /**
   * What the server actually sends over this stream (SSE), phase by phase.
   * Each content block in the eventual `response.content` array is built
   * from three kinds of events, tied together by `index` (block-indexed,
   * not message-scoped — several blocks can be in flight in one turn).
   *
   * Example turn: the model writes some text, then calls one tool.
   *
   * ── phase 0: message_start ─ the empty Message envelope ──────────────
   *   { type: "message_start",
   *     message: { id: "msg_01...", role: "assistant", content: [],
   *                stop_reason: null, usage: {...} } }
   *
   * ── phase 1: content_block_start ─ announces block `index` + its type ─
   *   "text" block:
   *     { type: "content_block_start", index: 0,
   *       content_block: { type: "text", text: "" } }        // text starts empty
   *   "tool_use" block (id + name known immediately, input NOT):
   *     { type: "content_block_start", index: 1,
   *       content_block: { type: "tool_use", id: "toolu_01...",
   *                        name: "read_file", input: {} } }  // input starts {}
   *
   * ── phase 2: content_block_delta ─ zero or more, keyed by `index` ─────
   *   "text" deltas are usable string fragments — just concatenate:
   *     { type: "content_block_delta", index: 0,
   *       delta: { type: "text_delta", text: "Let me read" } }
   *   "tool_use" deltas are fragments of a JSON *string*, not values —
   *   e.g. {"file_path": "a.txt"} may arrive as three fragments, and
   *   JSON.parse throws on the first two:
   *     { type: "content_block_delta", index: 1,
   *       delta: { type: "input_json_delta", partial_json: '{"file_pat' } }
   *     { ... delta: { type: "input_json_delta", partial_json: 'h": "a.txt' } }
   *     { ... delta: { type: "input_json_delta", partial_json: '"}' } }
   *
   * ── phase 3: content_block_stop ─ block `index` is complete ──────────
   *     { type: "content_block_stop", index: 1 }
   *   Only NOW is a tool_use block's accumulated JSON guaranteed parseable.
   *   (Phase 5's early-execution trick hangs off exactly this event.)
   *
   * ── phase 4: message_delta + message_stop ─ turn is done ─────────────
   *     { type: "message_delta",
   *       delta: { type: "message_delta", stop_reason: "tool_use" }, usage: {...} }
   *     { type: "message_stop" }
   *
   * finalMessage() then resolves with the fully assembled Message — the
   * same shape create() would have returned — where each block is complete:
   *   response.content = [
   *     { type: "text", text: "Let me read that file." },
   *     { type: "tool_use", id: "toolu_01...", name: "read_file",
   *       input: { file_path: "a.txt" } }   // parsed object, no longer fragments
   *   ]
   * and response.stop_reason === "tool_use" tells the loop to execute tools.
   */
  const { client, model, systemPrompt, tools, maxTokens, signal, onText, onToolBlockComplete } = options;
  const stream = client.messages.stream(
    {
      model: model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: tools,
      messages: messages
    },
    { signal }
  );

  // onText handler for normal text streaming, defined in outer function
  if (onText) {
    stream.on("text", (textDelta) => onText(textDelta));
  }

  const toolBlocksByIndex = new Map<number, TrackedToolBlock>();

  // Anthropic.Messages.RawMessageStreamEvent shape:
  // content_block_start index=1 type=tool_use name=read_file
  // content_block_delta index=1 partial_json='{"file_path"'
  // content_block_delta index=1 partial_json=':"src/cli.ts"}'
  // content_block_stop index=1
  // content_block_start index=2 type=text
  // content_block_delta index=2 text_delta="I will also inspect..."
  // content_block_stop index=2
  // ...

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
          id: tracked.id,
          caller: tracked.caller,
          input: input,
          name: tracked.name,
          type: "tool_use",
        });
        toolBlocksByIndex.delete(event.index);
      }
    }
  });
  return stream.finalMessage();
}

export async function runAgentLoop(
  messages: AgentMessage[],
  options: RunAgentLoopOptions,
): Promise<AgentMessage[]> {
  const {
    client,
    model,
    systemPrompt,
    tools,
    maxTokens = 16384,
    signal,
    onText,
    permissionMode = "default",
    confirmTool,
    compaction
  } = options;

  const readFileState: ReadFileState = new Map();
  const permission: PermissionState = {
    mode: permissionMode,
    confirmedActions: new Set(),
    confirmTool
  };

  if (compaction) {
    await checkAndCompact(messages, compaction, client, model);
  }

  while (true) {

    if (compaction) {
      runCompressionPipeline(messages, compaction);
    }

    // Tools with content_block_stop already fired during this turn's stream
    // Basically a read-only tool registry for the mvp
    const earlyExecutions = new Map<string, Promise<string>>();

    const response = await streamOneTurn(messages, {
      client,
      model,
      systemPrompt,
      tools,
      maxTokens,
      signal, // ctrl + c for now
      onText,
      onToolBlockComplete: (block) => {
        //wired to early tool execution
        const tool = findTool(block.name);
        if (tool?.isReadOnly) {
          const input = block.input as Record<string, unknown>;
          earlyExecutions.set(
            block.id,
            executeTool(block.name, input, readFileState, permission)
          )
        }
      }
    })

    if (compaction) {
      compaction.lastInputTokens = response.usage.input_tokens;
      compaction.lastApiCallTime = Date.now();
    }

    // assistant resp
    messages.push({
      role:"assistant",
      content: response.content
    });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length == 0) {
      break;
    }

    // Execute every requested tool and collect one tool_result per tool_use, correlated by tool_use_id
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const earlyPromise = earlyExecutions.get(toolUse.id);
      const raw_res =
        earlyPromise !== undefined
          ? await earlyPromise
          : await executeTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>,
            readFileState,
            permission
          );

      // Tier 0 Compact
      const result = persistLargeResult(toolUse.name, raw_res);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result
      });
    }

    // user tool result
    messages.push({
      role: "user",
      content: toolResults
    });
  }

  return messages;
}
