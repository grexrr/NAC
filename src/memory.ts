import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";

// ------ Sends a prompt and returns the model's text response
export type SideQueryFn = (
  system: string,
  userMessage: string,
  signal?: AbortSignal,
) => Promise<string>;

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  filename: string;
  content: string;
}

export const VALID_MEMORY_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25000;

function getProjectHash(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

export function getMemoryDir(): string {
  const dir = join(homedir(), ".nac-mini-agent", "memory", getProjectHash());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getIndexPath(): string {
  return join(getMemoryDir(), "MEMORY.md");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

// ------ INDEX ------

function updateMemoryIndex(): void {
  const memories = listMemories();
  const lines = ["# Memory Index", ""];
  for (const m of memories) {
    lines.push(`- **[${m.name}](${m.filename})** (${m.type}) — ${m.description}`);
  }
  writeFileSync(getIndexPath(), lines.join("\n"));
}

export function loadMemoryIndex(): string {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return "";

  let content = readFileSync(indexPath, "utf-8");
  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    content = lines.slice(0, MAX_INDEX_LINES).join("\n") +
    "\n\n[... truncated, too many memory entries ...]";
  }

  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength > MAX_INDEX_BYTES) {
    content = buf.subarray(0, MAX_INDEX_BYTES).toString("utf-8") + "\n\n[... truncated, index too large ...]";
  }

  return content;
}
// ------ CRUD ------

export function listMemories(): MemoryEntry[] {
  const dir = getMemoryDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");

  const entries: MemoryEntry[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      if (!meta.name || !meta.type) continue;
      entries.push({
        name: meta.name,
        description: meta.description || "",
        type: (VALID_MEMORY_TYPES.has(meta.type as MemoryType) ? meta.type : "project") as MemoryType,
        filename: file,
        content: body
      });
    } catch {
      // Skip a corrupt memory file rather than failing the whole listing —
      // the same "errors are data" instinct Phase 2 established for tools.
    }
  }
  entries.sort((a, b) => {
    try {
      const statA = statSync(join(dir, a.filename));
      const statB = statSync(join(dir, b.filename));
      return statB.mtimeMs - statA.mtimeMs;
    } catch {
      return 0;
    }
  });

  return entries;
}

export function saveMemory(entry: Omit<MemoryEntry, "filename">): string {
  const dir = getMemoryDir();
  const filename = `${entry.type}_${slugify(entry.name)}.md`;
  const content = formatFrontmatter(
    { name: entry.name, description: entry.description, type: entry.type },
    entry.content
  );
  writeFileSync(join(dir, filename), content);
  updateMemoryIndex();
  return filename;
}

export function deleteMemory(filename: string): boolean {
  const filepath = join(getMemoryDir(), filename);
  if (!existsSync(filepath)) return false;
  unlinkSync(filepath);
  updateMemoryIndex();
  return true;
}

// ------ Memory Header ------

export interface MemoryHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
}

const MAX_MEMORY_FILES = 200;
const MAX_MEMORY_BYTES_PER_FILE = 4096;

export function scanMemoryHeaders(): MemoryHeader[] {
  const dir = getMemoryDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f != "MEMORY.md");

  const headers: MemoryHeader[] = [];
  for (const f of files) {
    try {
      const filepath = join(dir, f);

      const stat = statSync(filepath);

      const raw = readFileSync(filepath, "utf-8");
      const first = raw.split("\n").slice(0, 30).join("\n");
      const { meta } = parseFrontmatter(first);

      headers.push({
        filename: f,
        filePath: filepath,
        mtimeMs: stat.mtimeMs,
        description: meta.description || null,
        type: VALID_MEMORY_TYPES.has(meta.type as MemoryType) ? (meta.type as MemoryType) : undefined,
      });
    } catch {

    }
  }
  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return headers.slice(0, MAX_MEMORY_FILES);
}

/** One line per memory: [type] filename (ISO timestamp): description. */
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const tag = h.type ? `[${h.type}] ` : "";
      const ts = new Date(h.mtimeMs).toISOString;
      return h.description
        ? `- ${tag}${h.filename} (${ts}: ${h.description})`
        : `- ${tag}${h.filename} (${ts})`;
    })
    .join("\n");
}

// ------ Memory Age / Freshness ------
export function memoryAge(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function memoryFreshnessWarning(mtimeMs: number): string {
  const days = Math.max(0,Math.floor((Date.now() - mtimeMs) / 86_400_400));
  if (days <= 1) return "";
  return `This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior may be outdated. Verify against current code before asserting as fact.`;
}

// ------ Semantic Recall ------

const SELECT_MEMORIES_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.`;

export interface RelevantMemory {
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
}

export async function selectRelevantMemories(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>, // already-shown memories
  signal?: AbortSignal
): Promise<RelevantMemory[]>{
  const headers = scanMemoryHeaders();
  if (headers.length === 0) return [];

  const candidates = headers.filter((h) => !alreadySurfaced.has(h.filePath));
  if (candidates.length === 0) return [];

  const manifest = formatMemoryManifest(candidates);

  try {
    const text = await sideQuery(
      SELECT_MEMORIES_PROMPT,
      `Query: ${query}\n\nAvailable memories:\n${manifest}`,
      signal
    );

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { selected_memories?: string[] };
    const selectedFilenames = parsed.selected_memories || [];
    if (!selectedFilenames) return [];

    const filenameSet = new Set(selectedFilenames);
    const selected = candidates.filter((h) => filenameSet.has(h.filename));

    return selected.slice(0, 5).map((h) => {
      let content = readFileSync(h.filePath, "utf-8");
      const buf = Buffer.from(content, "utf-8");
      if (buf.byteLength > MAX_MEMORY_BYTES_PER_FILE) {
        content =
          buf.subarray(0, MAX_MEMORY_BYTES_PER_FILE).toString("utf-8") +
          "\n\n[... truncated, memory file too large ...]";
      }
      const freshness = memoryFreshnessWarning(h.mtimeMs);
      const headerText = freshness
        ? `${freshness}\n\nMemory: ${h.filePath}`
        : `Memory: (saved ${memoryAge(h.mtimeMs)}: ${h.filePath})`;

      return { path: h.filePath, content, mtimeMs:h.mtimeMs, header: headerText };
    });
  } catch (err) {
    // Silent failure by design: memory recall must never block or crash the
    // main loop over a side-query hiccup. Signal-abort is expected (the
    // user interrupted the turn) and not logged as an error.
    if (signal?.aborted) return [];
    console.error(`[memory] semantic recall failed: ${(err as Error).message}`);
    return [];
  }
}

// ------ System Prompt ------

export function buildMemoryPromptSection(): string {
  const index = loadMemoryIndex();
  const memoryDir = getMemoryDir();

  return [
    `# Memory System`,
    `You have a persistent, file-based memory system at \`${memoryDir}\`. Unlike the messages array (which starts empty every new session — Phase 4's --resume restores a specific conversation, not this), memory survives across every session in this project directory.`,
    ``,
    `## Memory Types`,
    `- **user**: the user's role, preferences, knowledge level`,
    `- **feedback**: corrections and confirmations of your behavior — record both what to stop doing and what worked, so you don't drift away from an approach the user already validated`,
    `- **project**: ongoing work, goals, deadlines, decisions (convert relative dates like "Thursday" to absolute dates — this may be read weeks later)`,
    `- **reference**: pointers to external resources (URLs, tools, dashboards)`,
    ``,
    `## How to Save Memories`,
    `Call the save_memory tool with { name, description, type, content }. type must be exactly one of: user, feedback, project, reference. The description is what a later semantic-recall pass uses to judge relevance — be specific ("user dislikes trailing summaries after edits", not "user preference").`,
    `Call forget_memory with a filename (shown in the index below) to remove a memory that turns out to be wrong or obsolete.`,
    ``,
    `## What NOT to Save`,
    `- Code patterns or architecture (read the code instead)`,
    `- Git history (use run_shell with git log)`,
    `- Anything already in CLAUDE.md`,
    `- Ephemeral details specific to only this conversation`,
    `These exclusions apply even if the user explicitly asks you to save something covered above — if asked to save a PR list or activity summary, ask what about it was actually surprising or non-obvious; that's the part worth keeping.`,
    ``,
    `## When to Recall`,
    `Relevant memories are recalled automatically in the background and injected into context when found — you do not need to search for them yourself. If the user asks you to check or recall something specific that hasn't appeared, read_file the index or a specific memory file directly.`,
    ``,
    index ? `## Current Memory Index\n${index}` : `(No memories saved yet.)`,
  ].join("\n");
}
