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

const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
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
        type: (VALID_TYPES.has(meta.type as MemoryType) ? meta.type : "project") as MemoryType,
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
