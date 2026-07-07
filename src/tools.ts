import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";


/**
 * Tracks, for each absolute file path the agent has read in this
 * conversation, the mtimeMs recorded at read time. edit_file consults
 * this before writing so a write can never silently clobber a file that
 * changed on disk after the agent last saw its contents This map is created
 * fresh per runAgentLoop() call in agent.ts and threaded through every executeTool() call
 * tools.ts itself never instantiates or resets it, so unrelated conversations
 * never share read state.
 */
export type ReadFileState = Map<string, number> // abs file path: time

export interface ToolDefinition {
  name: string; //tool name
  description: string;
  input_schema: Anthropic.Tool["input_schema"];
  isReadOnly: boolean;
  execute(
    input: Record<string, unknown>,
    state: ReadFileState,
  ): string | Promise<string>;
}

function readFile(input: { file_path: string }, state: ReadFileState): string {
  const absPath = resolve(input.file_path);
  try {
    const content = readFileSync(absPath, "utf-8");
    // Record the mtime at the monent content is handed to the model for edit_time
    // to compare against before allowing a write
    state.set(absPath, statSync(absPath).mtimeMs);


    // Example — if content is "alpha\nbeta":
    //   split("\n")  → ["alpha", "beta"]
    //   map (i=0)    → "   1 | alpha"   (padStart(4) right-aligns the number)
    //   map (i=1)    → "   2 | beta"
    return content
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`) // Add line numbers for models
      .join("\n");

    } catch (e) {
      return `Error readingfile: ${(e as Error).message}`;
  }
}

// ─── The registry ───────────────────────────────────────────────────────
// One object per tool: schema + behavior in the same place
// Adding a new tool means adding one entry here — nothing else to update.

export const toolRegistry: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file, Returns the file content with line numbers.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to read",
        }
      },
      required: ["file_path"]
    },
    isReadOnly: true,
    execute: (input, state) => readFile(
      input as { file_path: string },
      state
    ),
  }
]

export function findTool(name: string): ToolDefinition | undefined {
  return toolRegistry.find((t) => t.name == name);
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
