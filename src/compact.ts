import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentMessage } from "./agent.js";


export const DISK_OFFLOAD_THRESHOLD_BYTES = 30 * 1024; // 30 kb
const PREVIEW_LINES = 200;
const TOOL_RESULTS_DIR = join(homedir(), ".nac-mini-agent", "tool-results");

// ----------- Compaction State -----------
// Decision of executing compaction should be persisted ACROSS every separate calls to runAgentLoop

export interface CompactionState {
  lastInputTokens: number;
  lastApiCallTime: number | null;
  contextWindowTokens: number;
}

export function createCompactionState(contextWindowTokens = 200_000): CompactionState {
  return {
    lastInputTokens: 0,
    lastApiCallTime: null,
    contextWindowTokens: contextWindowTokens,
  }
}

// ----------- Tier 0: Large tool-result disk offload -----------
export function persistLargeResult(toolName: string, result: string): string {
  if (Buffer.byteLength(result) <= DISK_OFFLOAD_THRESHOLD_BYTES) return result;

  // disk offload
  mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filepath = join(TOOL_RESULTS_DIR, `${Date.now()}-${toolName}.txt`);
  writeFileSync(filepath, result);

  // preview
  const lines = result.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

  return (
    `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. ` +
    `You can use read_file to see the full result.]\n\nPreview (first ${PREVIEW_LINES} lines):\n${preview}`
  );  // preview fed as string
}

// ----------- Tier 1: Budget -----------
const RESERVED_OUTPUT_TOKENS = 20_000;  // for the llm to generate the next output
const AUTO_COMPACT_UTILIZATION = 0.85;  // for tier 4, when effective window usage surpasses 85, trigger full Auto-compact

function effectiveWindow(state: CompactionState): number {
  return state.contextWindowTokens - RESERVED_OUTPUT_TOKENS;
}

export function budgetToolResults(messages: AgentMessage[], state: CompactionState): void {
  const utilization = state.lastInputTokens / effectiveWindow(state);
  if (utilization < 0.5) return;

  const budget = utilization > 0.7 ? 15000 : 30000;

  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const b = block as Anthropic.ToolResultBlockParam;
      if (
        b.type === "tool_result" &&
        typeof b.content === "string" &&
        b.content.length > budget
      ) {
        const keepEach = Math.floor((budget - 80) / 2); // 80 for the insertion marker, keeps the head and tail
        b.content =
          b.content.slice(0, keepEach) +
          `\n\n[... budgeted: ${b.content.length - keepEach * 2} chars truncated ...]\n\n` +
          b.content.slice(-keepEach);
      }
    }
  }
}

// ----------- Tier 2: Snip -----------

const SNIPPABLE_TOOLS = new Set(["read_file", "list_files"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const KEEP_RECENT_RESULTS = 3;
const SNIP_UTILIZATION_THRESHOLD = 0.6;

function findToolUseNameById(messages: AgentMessage[], toolUseId: string): string | undefined {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    // role === "assistant" && content is an array
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

  const candidates: { msgIdx: number, blockIdx: number }[] = [];
  for (let mid = 0; mid < messages.length; mid++) {
    const msg = messages[mid];
    if (msg.role !=="user" || !Array.isArray(msg.content)) continue;

    for (let bid = 0; bid < msg.content.length; bid++) {
      const block = msg.content[bid] as Anthropic.ToolResultBlockParam;
      if (block.type === "tool_result" &&
        typeof block.content === "string" &&
        block.content !== SNIP_PLACEHOLDER
      ) {
        const toolName = findToolUseNameById(messages, block.tool_use_id);
        if (toolName && SNIPPABLE_TOOLS.has(toolName)) {
          candidates.push({ msgIdx: mid, blockIdx: bid});
        }
      }
    }
  }

  // One snip pass over the COMPLETE candidate list, after the scan —
  // keep the most recent KEEP_RECENT_RESULTS, snip everything older.
  const toSnip = candidates.slice(0, Math.max(0, candidates.length - KEEP_RECENT_RESULTS));
  for (const { msgIdx, blockIdx } of toSnip) {
    const content = messages[msgIdx].content as Anthropic.ToolResultBlockParam[];
    content[blockIdx].content = SNIP_PLACEHOLDER;
  }
}

// ----------- Tier 3: Microcompact -----------
// Idle-triggered, indiscriminate: once idle exceeds MICROCOMPACT_IDLE_MS,
// clear every tool_result older than the most recent KEEP_RECENT_RESULTS,
// regardless of which tool produced it.

const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;
const MICROCOMPACT_PLACEHOLDER = "[Old tool result content cleared]"

export function microcompact(messages: AgentMessage[], state: CompactionState): void {
  if (state.lastApiCallTime === null) return;
  if (Date.now() - state.lastApiCallTime < MICROCOMPACT_IDLE_MS) return;

  const allResults: { msgIdx: number; blockIdx: number }[] = [];
  for (let mid = 0; mid < messages.length; mid ++) {
    const msg = messages[mid];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (let bid = 0; bid < msg.content.length; bid++) {
      const block = msg.content[bid] as Anthropic.ToolResultBlockParam;
      if (
        block.type === "tool_result" &&
        typeof block.content === "string" &&
        block.content !== MICROCOMPACT_PLACEHOLDER
      ) {
        allResults.push({ msgIdx: mid, blockIdx: bid });
      }
    }
  }

  const toClear = allResults.slice(0, Math.max(0, allResults.length - KEEP_RECENT_RESULTS));
  for (const { msgIdx, blockIdx } of toClear) {
    const content = messages[msgIdx].content as Anthropic.ToolResultBlockParam[];
    content[blockIdx].content = MICROCOMPACT_PLACEHOLDER;
  }
}

// ----------- Tier 1-3: Pipeline -----------
export function runCompressionPipeline(messages: AgentMessage[], state: CompactionState): void {
  budgetToolResults(messages, state);
  snipStaleResults(messages, state);
  microcompact(messages, state);
}


// ----------- Tier 4: full LLM Summerization -----------
// last message, if msg.role === "user" is kept for the next agentic loop.
// compact should very safely follow the paring invariant principle
export async function compactConversation(
  messages: AgentMessage[],
  client: Anthropic,
  model: string
): Promise<void> {
  if (messages.length < 4) return;

  const lastMsg = messages[messages.length - 1];

  // Defense-in-depth beyond the reliance purely on the call-site guarantee: refuse
  // to compact if the conversation ends in tool content — a tool_result (role "user",
  // array content) or a pending tool_use (assistant, array content). Slicing either
  // off would break the pairing invariant; fail safe by doing nothing rather than
  // corrupting the array.
  if (
    Array.isArray(lastMsg.content) &&
    lastMsg.content.some((b) => b.type === "tool_use" || b.type === "tool_result")
  ) {
    return;
  }

  const summaryResp = await client.messages.create({
    model,
    max_tokens:2048,
    system: "You are a conversation summarizer. Be concise but preserve important details.",
    messages: [
      ...messages.slice(0, -1),
      {
        role: "user",
        content: "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.",
      }
    ]
  });

  const summaryText = summaryResp.content[0]?.type === "text" ? summaryResp.content[0].text : "No summary available";

  const rebuilt: AgentMessage[] = [
    { role: "user", content: `[Previous converssation summary]\n${summaryText}`},
    {
      role: "assistant",
      content: "Understood. I have the context from our previous conversation. How can I continue helping?",
    }
  ];

  // typeof check: a tool_result message is ALSO role "user" but carries
  // array content — only plain user text may survive compaction.
  if (lastMsg.role === "user" && typeof lastMsg.content === "string") rebuilt.push(lastMsg);

  // reassign the messages pointer so the outer loop can see
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
