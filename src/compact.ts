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

// ----------- Tier 0: Large tool-result disk offload -----------
export function persistLargeResult(toolName: string, result: string): string {
  if (Buffer.byteLength(result) <= DISK_OFFLOAD_THRESHOLD_BYTES) return result;

  // disk offload
  mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filepath = join(TOOL_RESULTS_DIR, `${Date.now()}-${toolName}.txt`);
  writeFileSync(filepath, result);

  // preview
  const lines = result.split("\n");
  const preview = lines.slice(0, 200).join("\n");
  const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

  return (
    `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. ` +
    `You can use read_file to see the full result.]\n\nPreview (first ${PREVIEW_LINES} lines):\n${preview}`
  );  // preview fed as string
}

// ----------- Tier 1: Budget -----------
const RESERVED_OUTPUT_TOKENS = 20_000;
const AUTO_COMPACT_UTILIZATION = 0.85;

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



export function createCompactionState(contextWindowTokens = 200_000): CompactionState {
  return {
    lastInputTokens: 0,
    lastApiCallTime: null,
    contextWindowTokens: contextWindowTokens,
  }
}

