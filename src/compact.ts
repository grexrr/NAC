import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";


export const DISK_OFFLOAD_THRESHOLD_BYTES = 30 * 1024; // 30 kb
const PREVIEW_LINES = 200;
const TOOL_RESULTS_DIR = join(homedir(), ".nac-mini-agent", "tool-results");

// ----------- Tier0: Large tool-result disk offload -----------
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

// ----------- Compaction State -----------
// Decision of executing compaction should be persisted ACROSS every separate calls to runAgentLoop

export interface CompationState {
  lastInputTokens: number;
  lastApiCallTime: number | null;
  contextWindowTokens: number;
}

export function createCompactionState(contextWindowTokens = 200_000): CompationState {
  return {
    lastInputTokens: 0,
    lastApiCallTime: null,
    contextWindowTokens: contextWindowTokens,
  }
}

