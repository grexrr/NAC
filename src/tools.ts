import Anthropic from "@anthropic-ai/sdk";
import {
  existsSync, // path -> boolean; does this file/dir exist on disk right now
  readdirSync, // dirPath -> Dirent[]; list a directory's immediate entries (used by list_files)
  readFileSync, // path, encoding -> string; read a whole file's contents synchronously
  statSync, // path -> fs.Stats; file metadata — only .mtimeMs is used here, for the mtime guard
  writeFileSync // path, content -> void; overwrite a file's contents synchronously
} from "node:fs";
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

// ================= Tool Implementations  =================

function readFile(input: { file_path: string }, state: ReadFileState): string {
  const absPath = resolve(input.file_path);
  try {
    const content = readFileSync(absPath, "utf-8");
    // Record the mtime at the moment content is handed to the model for edit_time
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

function editFile(
  input: { file_path: string, old_string: string, new_string: string},
  state: ReadFileState
): string {
  const absPath = resolve(input.file_path);

  if (!existsSync(absPath)) {
    return `Error: file not found: ${input.file_path}`;
  }

  if(!state.has(absPath)){
    return `Error: read_file("${input.file_path}") must be read before editing.`;
  }

  const lastKnownMtime = state.get(absPath);
  const currentMtime = statSync(absPath).mtimeMs;

  if (currentMtime !== lastKnownMtime) {
    return `Error: ${input.file_path} was modified on disk since you last read it. Call read_file again before editing.`;
  }

  const content = readFileSync(absPath, "utf-8");
  const count = content.split(input.old_string).length - 1;
  if (count == 0) {
    return `Error: old_string not found in ${input.file_path}`;
  } else if (count > 1) {
    return `Error: old_string found ${count} times in ${input.file_path}. Must be unique — add more surrounding context to old_string.`;
  }

  const newContent = content.split(input.old_string).join(input.new_string);
  writeFileSync(absPath, newContent);

  state.set(absPath, statSync(absPath).mtimeMs);

  return `Successfully edited ${input.file_path}`
}

function listFiles(input: { path?: string }): string {
  const dirPath = resolve(input.path ?? ".");
  try {
    const entries = readdirSync(dirPath, { withFileTypes:true });
    if (entries.length === 0) {
      return `(empty directory: ${dirPath})`;
    }
    return entries
      .map((e) => `${e.isDirectory() ? "d": "f"}  ${e.name}`)
      .sort()
      .join("\n");
  } catch (e) {
    return `Error listing directory: ${(e as Error).message}`;
  }
}

//  ================= The registry  =================
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
  },

  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match with new content. The old_string musst match exactly, including whitespace and indentation, and must be unique within the file. You must call read_file on this file earlier in the conversation before calling edit_file.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "The path to the file to edit",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace",
        },
        new_string: {
          type: "string",
          description: "The string to replace it with",
        },
      },
      required: ["file_path", "old_string", "new_string"]
    },
    isReadOnly: false,
    execute: (input, state) => editFile(
      input as { file_path: string, old_string: string, new_string: string },
      state
    ),
  },

  {
    name: "list_files",
    description:
      "List the contents of a directory (non-recursive). Returns one entry per line, prefixed with 'd' for directories and 'f' for files.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The directory to list. Defaults to the current working directory.",
        },
      },
      required: []
    },
    isReadOnly: true,
    execute: (input) => listFiles(input as { path?: string }),
  }
]

//  ================= Dispatcher  =================

export function findTool(name: string): ToolDefinition | undefined {
  return toolRegistry.find((t) => t.name == name);
}

/**
 * The array to hand to the Anthropic API's `tools` parameter. Strips
 * the registry-only fields (readOnly, execute) down to exactly the
 * three fields the wire format expects (Phase 1, Concept 1).
 *
 * This is also the seam Phase 3 (System Prompt) will use to describe
 * the available tools by name and behavior — iterate toolRegistry
 * directly (not this stripped version) to get each tool's name,
 * description, and readOnly flag.
 */
export function getToolSchemas(): Anthropic.Tool[] {
  return toolRegistry.map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema
    })
  );
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
