# Phase 8: Memory System

> Series: Mini-Claude-Code Learning Plan — see [`../phase-breakdown.md`](../phase-breakdown.md) for full context.
> **Prerequisites:** [`phase-01-agent-loop.md`](phase-01-agent-loop.md) (the `messages: AgentMessage[]` array — this phase injects into that exact array), [`phase-03-system-prompt.md`](phase-03-system-prompt.md) (`buildSystemPrompt()` — memory's static instructions get one more section appended to it), and — **critically** — [`phase-07-context-engineering.md`](phase-07-context-engineering.md), read in full, not skimmed. The phase breakdown's own dependency list for this phase says "Depends on: Phase 1, Phase 3" — that's the *conceptual* dependency (the loop to hook into, and where prompt-adjacent content gets injected). But every phase in this series builds in strict order, and by the time this phase starts, the learner's actual `src/agent.ts`, `src/tools.ts`, `src/cli.ts`, `src/permissions.ts`, and `src/compact.ts` already contain everything from Phases 1–7: streaming (`streamOneTurn`, `earlyExecutions`), permissions (`PermissionState`, `checkPermission`-gated `executeTool`), and Tier 0–4 context compaction (`checkAndCompact`, `runCompressionPipeline`). This tutorial is written as a diff against **that** code — Phase 7's own final `agent.ts` (its Step 7) and `cli.ts` (its Step 8) — not against some earlier, simpler hypothetical state. (This series has one recorded instance of skipping this discipline and paying for it: Phase 6 was originally drafted against Phase 4's `agent.ts` instead of Phase 5's, silently reverting Phase 5's streaming work; it had to be fixed after the fact. This tutorial does not repeat that mistake.) Phase 7's own closing section anticipates this phase directly and is quoted in Concept 5 below — read it before writing any code.

## Goal

By the end of this phase your agent remembers things *across different sessions*, not just within one. Phase 4 already gave you `--resume`, which reloads a specific saved conversation's `messages` array — but that's the same conversation continuing, not a fact surviving into a conversation that has never seen it before. This phase adds a second, independent persistence mechanism: a small, file-based memory store, scoped to the closed four-type taxonomy real Claude Code uses (`user`, `feedback`, `project`, `reference`), with a semantic-recall mechanism that decides which stored memories are worth injecting into a given turn — using a second, minimal Anthropic API call (a "side query"), not a vector database — and an async-prefetch design so that side query never adds perceived latency to the turn it's serving.

Concretely, you will build:

- **`src/frontmatter.ts`** — a tiny, dependency-free YAML-frontmatter parser (memory files are Markdown with a `---`-delimited metadata header).
- **`src/memory.ts`** — the memory store itself: CRUD over per-project memory files, the `MEMORY.md` index, semantic recall via a side query, async prefetch, and the system-prompt section describing all of this to the model.
- **Two new tools**, `save_memory` and `forget_memory`, added to Phase 2's registry (Concept 2 explains precisely why this project needs dedicated tools here, unlike the reference project).
- **One new, load-bearing integration point in `agent.ts`**: recalled memory content gets appended to the conversation at a specific place relative to Phase 7's `checkAndCompact()` call — get this wrong, and either your compaction step or your memory step corrupts the other's assumptions. Concept 5 is the crux of this phase, in the same way Phase 7's Concept 8 was the crux of that one.
- **A `/memory` REPL command** so you can inspect what's actually been saved without leaving the CLI.

## Why this is interview material

"Does your agent have memory?" is a question with a lazy wrong answer ("yes, the conversation history") and a substantive right one. The substantive answer has three parts, and this phase makes you build all three, not just describe them:

1. **A closed taxonomy, not a junk drawer.** Four fixed memory types — not free-form tags — force a real classification decision every time something is worth remembering, which is exactly what prevents the store from silently turning into an unstructured, un-recallable pile of notes. Being able to name the four types and *why* they're closed (not "however many categories seem useful today") is a concrete, checkable signal that you understand the design, not just the feature.
2. **Semantic recall without a vector database.** The obvious-sounding solution to "find memories relevant to this query" is an embeddings index. The actual solution here is much smaller and worth being able to defend: send a compact manifest of filenames + one-line descriptions (not full content) to the model itself, in a dedicated side call, and let it pick. This is retrieval-adjacent thinking that demonstrates you understand the tradeoff (a real, tiny API cost vs. real infrastructure) without requiring you to have built a RAG pipeline.
3. **Async prefetch as a general latency-hiding pattern.** The side query costs real wall-clock time. Kicking it off the instant a turn starts, polling for it non-blockingly rather than awaiting it, and being honest about the failure mode (it can lose the race and simply not make it into the turn it was meant for) is a pattern that generalizes far past memory — it's the same idea as speculative execution or optimistic pre-fetching anywhere else in engineering.

---

## Files

This phase creates two new files and modifies three files Phase 7 left behind (`tools.ts`, `agent.ts`, `prompt.ts`), plus a fourth (`cli.ts`) for the `/memory` command and state threading. `src/permissions.ts`, `src/session.ts`, and `src/compact.ts` are **not modified at all**.

- `src/frontmatter.ts` **(new)** — `parseFrontmatter()`/`formatFrontmatter()`, a ~30-line, dependency-free `key: value` parser for the `---`-delimited header every memory file has.
- `src/memory.ts` **(new)** — the memory store: `MemoryType`, `getMemoryDir()` (per-project, sha256-hashed path), `saveMemory()`/`deleteMemory()`/`listMemories()`, `MEMORY.md` index read/write with two-layer truncation, `scanMemoryHeaders()`/`formatMemoryManifest()` for the recall selector, `memoryAge()`/`memoryFreshnessWarning()`, `selectRelevantMemories()` (the side query), `startMemoryPrefetch()` (async prefetch with its three gates), `formatMemoriesForInjection()`, `MemoryRecallState`/`createMemoryRecallState()` (session-scoped recall bookkeeping — the `agent.ts`-side counterpart to Phase 7's `CompactionState`), and `buildMemoryPromptSection()` (the system-prompt section). Deliberately has **no** import of `@anthropic-ai/sdk` or a live client — see Concept 5 for exactly why, and where the one piece of this system that *does* need a client (`buildSideQuery`) actually lives instead.
- `src/tools.ts` **(modified)** — adds `save_memory` and `forget_memory` to Phase 6's four-tool registry (`read_file`, `edit_file`, `list_files`, `run_shell`). Nothing else changes: `ToolDefinition`, `ReadFileState`, `PermissionState`, `findTool`, `getToolSchemas`, and the `checkPermission`-gated `executeTool()` from Phase 6 are byte-for-byte unchanged.
- `src/agent.ts` **(modified — diffed against Phase 7's final version, Step 7)** — `RunAgentLoopOptions` gains one new optional field, `memoryRecall?: MemoryRecallState`, alongside Phase 7's `compaction?: CompactionState` (itself alongside Phase 6's `permissionMode?`/`confirmTool?` and Phase 5's `onText?`). Adds a local `buildSideQuery()` helper, an `extractLastUserText()` helper, one prefetch-start call positioned strictly after Phase 7's `checkAndCompact()` call (and still strictly before the `while (true)` loop), and one poll-and-inject block inside the `while (true)` loop, at the same per-iteration cadence as Phase 7's `runCompressionPipeline()`. Phase 7's `streamOneTurn`, `TrackedToolBlock`, `earlyExecutions`, `checkAndCompact` call site, and both `executeTool()` call sites are otherwise untouched.
- `src/prompt.ts` **(modified)** — one new import (`buildMemoryPromptSection` from `memory.ts`) and one new entry appended to `buildSystemPrompt()`'s composition array, positioned *last* — after `loadClaudeMd()` — per Phase 3's own recency-effect reasoning (Concept 2 of that phase). Every static section, `buildToolsSection()`, and `buildEnvironmentSection()` are unchanged.
- `src/cli.ts` **(modified, narrowly — diffed against Phase 7's final version, Step 8)** — creates one `MemoryRecallState` per process invocation (alongside Phase 7's `CompactionState`, the same lifetime as `sessionId`) and threads it into both `runAgentLoop` call sites; adds a `/memory` REPL command that lists saved memories without consuming a turn. `parseArgs`, the SIGINT handler, `confirmTool`, session save/load, `--resume`, and Phase 7's `compaction` threading are all untouched.
- `src/permissions.ts`, `src/session.ts`, `src/compact.ts` **(not modified)** — see Concept 2 (why `checkPermission` needs zero changes for the two new tools) and Concept 5 (why compaction's own code doesn't need to know memory exists).

---

## Concept 1: The four memory types, and the constraint that makes them worth having

The single governing rule behind this whole subsystem, stated exactly once and worth repeating verbatim because everything else follows from it: **only remember what is not derivable from the current project state.** Code patterns, architecture, file layout, git history, an in-progress debugging session — all of that is *self-describing*: reading the code or running `git log` is always more accurate than recalling a memory about it, because the memory is a snapshot and the code is live. A memory that says "auth lives in `src/auth/`" becomes actively wrong the moment someone refactors, and there is no mechanism to know that happened. Real Claude Code's `WHAT_NOT_TO_SAVE_SECTION` (`claude-code/src/memdir/memoryTypes.ts`, lines 183–195, quoted directly) states this with a sharp edge case worth internalizing: *"These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list or activity summary, ask what was surprising or non-obvious about it — that is the part worth keeping."* A user saying "remember this" doesn't override the rule — it's a prompt to find the one non-derivable fact buried in an otherwise-derivable request.

Within that constraint, the reference project's `memory.ts` and real Claude Code's `memdir/memoryTypes.ts` independently converge on the identical **four-type closed taxonomy** — confirmed by reading both sources directly, not assumed from one:

| Type | What it captures | When it's written |
|---|---|---|
| **user** | The user's role, preferences, knowledge level | When you learn something about who the user is |
| **feedback** | Corrections **and confirmations** of your behavior | User corrects ("don't do X") *or* confirms ("yes, exactly, keep doing that") |
| **project** | Ongoing work, decisions, deadlines | When you learn who's doing what, why, or by when — relative dates converted to absolute ones |
| **reference** | Pointers to external systems | When you learn where something lives outside the project (a dashboard, a tracker) |

Two details in this table are easy to state vaguely and worth pinning down precisely, both grounded directly in `memoryTypes.ts`:

**`feedback` records successes, not only failures — and this is a deliberate, named design decision, not an oversight.** The real source's own doc comment states the reasoning directly (`memoryTypes.ts`, line 60, quoted): *"Record from failure AND success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious."* If a user says "yes, that single bundled PR was the right call," and the model never records it, a later session might "improve" by splitting future PRs into many small ones — a regression dressed up as helpfulness. Recording confirmations is what stops good, already-validated judgment calls from silently eroding across sessions.

**`feedback` and `project` memories both require a structured body** — not just the fact, but a **Why:** line and a **How to apply:** line. The reason is stated directly in the real source's prompt text and echoed in the deep-dive chapter: *"Knowing why lets you judge edge cases instead of blindly following the rule"* (`how-claude-code-works/docs/08-memory-system.md`, line 90, translated). A memory that only says "don't mock the database in tests" gives the model no way to distinguish a legitimate lightweight unit-test mock from the integration-test mocking the rule was actually written to forbid; a memory that also says *why* ("a mocked test passed but the prod migration failed last quarter") gives the model the judgment to apply the rule correctly to a case nobody wrote down explicitly. `project` memories have an additional, specific requirement: relative dates in the user's own words ("merge freeze after Thursday") must be converted to absolute ones ("2026-03-05") at save time, because the memory may be read weeks later, at which point "Thursday" means nothing.

**Why a closed taxonomy at all, rather than free-form tags?** A model given free rein to invent categories will invent a slightly different one every time, and recall — which has to match a query against a category conceptually, not just by string — degrades as the vocabulary drifts. Four fixed types is a small, memorizable ontology the model applies consistently turn after turn, which is exactly what makes automated, non-keyword recall (Concept 3) tractable at all.

---

## Implement 1: `src/frontmatter.ts` and the storage half of `src/memory.ts`

Every memory file is a Markdown file with a `---`-delimited YAML-ish header (`name`, `description`, `type`) followed by the memory body — the same shape a Jekyll/Hugo post uses, and the same shape Phase 3 never needed (its `CLAUDE.md`/`.claude/rules/` files have no frontmatter, only `@include` directives). This phase is the first one that needs to parse it, so it gets its own tiny, dependency-free module rather than pulling in a YAML library — the same "20-line hand-written parser is enough, don't reach for a dependency you don't need yet" call Phase 2 made about JSON Schema validation.

- [ ] Create `src/frontmatter.ts` with this content (complete file):

  ```typescript
  // Shared YAML frontmatter parser for memory files. Handles simple
  // `key: value` pairs between `---` delimiters — no nested structures,
  // no lists, no quoting rules. Memory files never need more than that.

  export interface FrontmatterResult {
    meta: Record<string, string>;
    body: string;
  }

  export function parseFrontmatter(content: string): FrontmatterResult {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---") return { meta: {}, body: content };

    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") { endIdx = i; break; }
    }
    if (endIdx === -1) return { meta: {}, body: content };

    const meta: Record<string, string> = {};
    for (let i = 1; i < endIdx; i++) {
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx === -1) continue;
      const key = lines[i].slice(0, colonIdx).trim();
      const value = lines[i].slice(colonIdx + 1).trim();
      if (key) meta[key] = value;
    }

    const body = lines.slice(endIdx + 1).join("\n").trim();
    return { meta, body };
  }

  export function formatFrontmatter(meta: Record<string, string>, body: string): string {
    const lines = ["---"];
    for (const [key, value] of Object.entries(meta)) {
      lines.push(`${key}: ${value}`);
    }
    lines.push("---");
    lines.push("");
    lines.push(body);
    return lines.join("\n");
  }
  ```

  Adapted directly, unchanged, from `claude-code-from-scratch/src/frontmatter.ts` — this is one of the few modules in this series ported nearly verbatim, because there's no NAC-specific adaptation to make: a frontmatter parser doesn't care which tools or permission model the surrounding project has.

Now the storage half of the memory store itself — everything needed to save, list, delete, and index memory files, with nothing yet about recall or prompt injection (Implement 2–4 add those).

- [ ] Create `src/memory.ts` with this content (partial file — later steps append to it; this is the complete file as it stands after this step):

  ```typescript
  // Memory system — 4-type file-based memory with a MEMORY.md index.
  // Mirrors claude-code-from-scratch/src/memory.ts's architecture: semantic
  // recall via a "side query", async prefetch, a session-scoped byte budget.
  //
  // Deliberately has no dependency on @anthropic-ai/sdk or a live client —
  // the only import below is frontmatter.ts. The one piece of this system
  // that DOES need a client (buildSideQuery, the function that actually
  // calls the model) lives in agent.ts instead — see this phase's Concept 5
  // for exactly why, and where that split matters.

  import {
    readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
    unlinkSync, statSync,
  } from "node:fs";
  import { join } from "node:path";
  import { homedir } from "node:os";
  import { createHash } from "node:crypto";
  import { parseFrontmatter, formatFrontmatter } from "./frontmatter.js";

  /** A function that sends a prompt and returns the model's text response. */
  export type SideQueryFn = (
    system: string,
    userMessage: string,
    signal?: AbortSignal
  ) => Promise<string>;

  // ─── Types ──────────────────────────────────────────────────

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

  // ─── Paths ──────────────────────────────────────────────────
  //
  // Memory is scoped per-project, unlike sessions (~/.nac-mini-agent/sessions/,
  // Phase 4) and tool-result offloads (~/.nac-mini-agent/tool-results/, Phase
  // 7), which are flat. A fact learned while working on project A shouldn't
  // surface while working on project B. Adapted directly from the reference
  // project's getProjectHash()/getMemoryDir() (sha256(cwd), first 16 hex
  // chars). Real Claude Code's equivalent (claude-code/src/memdir/paths.ts,
  // getAutoMemPath()) hashes the canonical GIT ROOT instead of the raw cwd,
  // specifically so every worktree of the same repo shares one memory space
  // (findCanonicalGitRoot() — real source, cited directly) — this project's
  // simpler cwd-hash doesn't have that refinement. A real, cited, un-built
  // improvement, not a claim the reference project does otherwise (it hashes
  // raw cwd too).

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

  // ─── Slugify ────────────────────────────────────────────────

  function slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);
  }

  // ─── CRUD ───────────────────────────────────────────────────

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
          content: body,
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

  // ─── Index ──────────────────────────────────────────────────
  //
  // MEMORY.md is an INDEX, not a container: one line per memory, loaded in
  // full into the system prompt on every session start (buildMemoryPromptSection,
  // Step 3). Real content lives in the individual files and is only read on
  // demand via semantic recall (Step 3) or the model's own read_file call.

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
    // Two-layer truncation, matching the reference project and real Claude
    // Code exactly: line truncation (200) catches normal growth (too many
    // entries); byte truncation (25KB) catches the pathological case of a
    // small number of lines that are each individually enormous — real
    // Claude Code's own doc comment cites an observed p100 case of 197KB
    // packed into under 200 lines (claude-code/src/memdir/memdir.ts, line 37).
    const lines = content.split("\n");
    if (lines.length > MAX_INDEX_LINES) {
      content =
        lines.slice(0, MAX_INDEX_LINES).join("\n") +
        "\n\n[... truncated, too many memory entries ...]";
    }
    if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
      content = content.slice(0, MAX_INDEX_BYTES) + "\n\n[... truncated, index too large ...]";
    }
    return content;
  }
  ```

- [ ] Sanity-check the storage layer directly — no API key needed, this module has no dependency on the Anthropic client at all, exactly like Phase 2's `tools.ts` and Phase 4's `session.ts`:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/memory.js').then((m) => {
    const f1 = m.saveMemory({ name: 'User prefers concise output', description: 'User dislikes trailing summaries after edits', type: 'feedback', content: 'Do not summarize at the end.\n\n**Why:** user can read the diff.\n**How to apply:** end responses right after the change.' });
    console.log('saved:', f1);
    console.log('listMemories:', m.listMemories().map((e) => ({ name: e.name, type: e.type })));
    console.log('index:\n' + m.loadMemoryIndex());
    console.log('deleted:', m.deleteMemory(f1));
    console.log('remaining:', m.listMemories().length);
  });
  "
  ```

  This exact sequence was run while writing this tutorial, in an isolated scratch directory (`/private/tmp/.../scratchpad/verify-memory-phase8`), against precisely this code. Real captured output:

  ```
  saved: feedback_user_prefers_concise_output.md
  listMemories: [ { name: 'User prefers concise output', type: 'feedback' } ]
  index:
  # Memory Index

  - **[User prefers concise output](feedback_user_prefers_concise_output.md)** (feedback) — User dislikes trailing summaries after edits
  deleted: true
  remaining: 0
  ```

  Confirm a real file appeared under `~/.nac-mini-agent/memory/<16-hex-chars>/feedback_user_prefers_concise_output.md` while the script ran (delete happens at the end of this smoke test) — the hash directory name is deterministic for your current working directory, so running this again from the same directory reuses the same memory space.

---

## Concept 2: Two new tools, not a generic write — and why `permissions.ts` needs zero changes

The reference project lets the model save a memory by calling its existing, generic `write_file` tool with frontmatter content. That doesn't transfer to this project as-is: **NAC's registry has no generic write-a-new-file tool.** Phase 2's `edit_file` requires the target file to already exist and to have been `read_file`'d earlier in the conversation (the read-before-edit guard, Phase 2 Concept 4) — it structurally cannot create a brand-new file. So the reference project's save mechanism has no direct equivalent here; the fix is two small, purpose-built tools that wrap `memory.ts`'s `saveMemory()`/`deleteMemory()` directly, rather than generalizing `edit_file` into a write-anything tool just to support this one feature (which would reopen exactly the mtime-guard question Phase 2 spent a whole concept establishing, for a directory that doesn't need it).

```typescript
// New tool definitions — schema mirrors MemoryEntry's shape exactly.
{
  name: "save_memory",
  description: "Save a fact to persistent, cross-session memory. type must be one of: user, feedback, project, reference. Only save information that is NOT derivable by reading the current code, git history, or CLAUDE.md.",
  input_schema: { /* name, description, type, content — all required */ },
  readOnly: false,
  execute: (input) => saveMemoryTool(input as {...}),
},
{
  name: "forget_memory",
  description: "Delete a saved memory by its filename (as shown in the memory index).",
  input_schema: { /* filename — required */ },
  readOnly: false,
  execute: (input) => forgetMemoryTool(input as { filename: string }),
},
```

Both are `readOnly: false` — they write to disk — which means they pass through the exact same `checkPermission()` gate every other write tool does (Phase 6, Concept 5). This is worth tracing through precisely rather than assuming it "just works," because it's a genuinely useful thing to be able to say in an interview: *adding a new write-capable tool to an already-built permission system required zero changes to the permission system itself.* Walk `checkPermission(toolName, input, readOnly, mode)` (Phase 6, Step 4's final version) for `save_memory` in each mode:

- **`default`**: no declarative rule matches (Layer 1), `readOnly` is `false` so the early-allow doesn't fire, mode isn't `plan`, mode isn't `acceptEdits`, tool name isn't `run_shell` so the dangerous-pattern check (Layer 2) doesn't apply — falls through to the final `return { action: "allow" }`. Same as `edit_file`'s own default-mode behavior: writes are allowed without a confirmation prompt; the safety net for `edit_file` was the mtime guard, and the safety net here is that a memory file lives in a small, contained directory with low blast radius (Phase 2 Concept 3's reversibility framing) rather than the user's actual project files.
- **`plan`**: `checkPermission`'s `plan`-mode branch denies *every* non-read-only tool call unconditionally (`return { action: "deny", message: `Blocked in plan mode: ${toolName}` }`) — `save_memory`/`forget_memory` are denied exactly like `edit_file` and `run_shell` are, with no special-casing needed, because the branch doesn't enumerate tool names, it checks the `readOnly` flag.
- **`bypassPermissions`**: the very first line of `checkPermission` is an unconditional `return { action: "allow" }` for this mode — applies identically to any tool name, new ones included.

This was verified directly, not just reasoned through, while writing this tutorial:

```bash
npx tsx -e "
import('./src/permissions.js').then((m) => {
  console.log('save_memory, default:', m.checkPermission('save_memory', {}, false, 'default'));
  console.log('save_memory, plan:', m.checkPermission('save_memory', {}, false, 'plan'));
  console.log('save_memory, bypassPermissions:', m.checkPermission('save_memory', {}, false, 'bypassPermissions'));
});
"
```

Real captured output:

```
save_memory, default: { action: 'allow' }
save_memory, plan: { action: 'deny', message: 'Blocked in plan mode: save_memory' }
save_memory, bypassPermissions: { action: 'allow' }
```

**`src/permissions.ts` is not modified anywhere in this phase** — this is the concrete proof of why: Phase 6's design gates on the `readOnly` flag and a fixed set of tool-name special cases (`run_shell` for dangerous-pattern detection, `edit_file` for `acceptEdits` mode), not an enumerated allowlist of every tool that exists. A new write tool slots into the existing gate for free.

---

## Implement 2: Add `save_memory` and `forget_memory` to the registry

- [ ] Modify `src/tools.ts` — add the import from `memory.ts`, the two wrapper functions, and two new entries in `toolRegistry`. This is the complete file as of this step (everything else — `readFile`/`editFile`/`listFiles`/`runShell`, `findTool`/`getToolSchemas`/`executeTool` — is byte-for-byte Phase 6's version):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
  import { execSync } from "node:child_process";
  import { resolve } from "node:path";
  import { checkPermission, type PermissionMode } from "./permissions.js";
  import { saveMemory, deleteMemory, type MemoryType } from "./memory.js";

  export type ReadFileState = Map<string, number>;

  export interface PermissionState {
    mode: PermissionMode;
    confirmedActions: Set<string>;
    confirmTool?: (message: string) => Promise<boolean>;
  }

  export interface ToolDefinition {
    name: string;
    description: string;
    input_schema: Anthropic.Tool["input_schema"];
    readOnly: boolean;
    execute(input: Record<string, unknown>, state: ReadFileState): string | Promise<string>;
  }

  function readFile(input: { file_path: string }, state: ReadFileState): string {
    const absPath = resolve(input.file_path);
    try {
      const content = readFileSync(absPath, "utf-8");
      state.set(absPath, statSync(absPath).mtimeMs);
      const numbered = content
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
        .join("\n");
      return numbered;
    } catch (e) {
      return `Error reading file: ${(e as Error).message}`;
    }
  }

  function editFile(
    input: { file_path: string; old_string: string; new_string: string },
    state: ReadFileState
  ): string {
    const absPath = resolve(input.file_path);
    if (!existsSync(absPath)) return `Error: file not found: ${input.file_path}`;
    if (!state.has(absPath)) return `Error: you must read_file("${input.file_path}") before editing it.`;
    const lastKnownMtime = state.get(absPath)!;
    const currentMtime = statSync(absPath).mtimeMs;
    if (currentMtime !== lastKnownMtime) {
      return `Error: ${input.file_path} was modified on disk since you last read it. Call read_file again before editing.`;
    }
    const content = readFileSync(absPath, "utf-8");
    const count = content.split(input.old_string).length - 1;
    if (count === 0) return `Error: old_string not found in ${input.file_path}`;
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique — add more surrounding context to old_string.`;
    }
    const newContent = content.split(input.old_string).join(input.new_string);
    writeFileSync(absPath, newContent);
    state.set(absPath, statSync(absPath).mtimeMs);
    return `Successfully edited ${input.file_path}`;
  }

  function listFiles(input: { path?: string }): string {
    const dirPath = resolve(input.path ?? ".");
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      if (entries.length === 0) return `(empty directory: ${dirPath})`;
      return entries
        .map((e) => `${e.isDirectory() ? "d" : "f"}  ${e.name}`)
        .sort()
        .join("\n");
    } catch (e) {
      return `Error listing directory: ${(e as Error).message}`;
    }
  }

  function runShell(input: { command: string; timeout?: number }): string {
    try {
      const result = execSync(input.command, {
        encoding: "utf-8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: input.timeout ?? 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result || "(no output)";
    } catch (e: any) {
      const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";
      const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";
      return `Command failed (exit code ${e.status})${stdout}${stderr}`;
    }
  }

  // ─── save_memory / forget_memory ──────────────────────────────
  //
  // New in this phase. NAC has no generic write_file tool (edit_file requires
  // the target to already exist and be previously read — Phase 2's guards),
  // so the reference project's "save a memory by calling write_file with
  // frontmatter" pattern doesn't transfer as-is. Two small, purpose-built
  // tools wrap memory.ts's saveMemory()/deleteMemory() directly instead.

  const VALID_MEMORY_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

  function saveMemoryTool(input: {
    name: string;
    description: string;
    type: string;
    content: string;
  }): string {
    if (!VALID_MEMORY_TYPES.has(input.type as MemoryType)) {
      return `Error: invalid memory type "${input.type}". Must be one of: user, feedback, project, reference.`;
    }
    const filename = saveMemory({
      name: input.name,
      description: input.description,
      type: input.type as MemoryType,
      content: input.content,
    });
    return `Saved memory to ${filename}. The memory index has been updated.`;
  }

  function forgetMemoryTool(input: { filename: string }): string {
    const ok = deleteMemory(input.filename);
    return ok
      ? `Deleted memory ${input.filename}.`
      : `Error: no memory file named "${input.filename}" (check the index for exact filenames).`;
  }

  export const toolRegistry: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read the contents of a file. Returns the file content with line numbers.",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string", description: "The path to the file to read" } },
        required: ["file_path"],
      },
      readOnly: true,
      execute: (input, state) => readFile(input as { file_path: string }, state),
    },
    {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact string match with new content. The old_string must match exactly, including whitespace and indentation, and must be unique within the file. You must call read_file on this file earlier in the conversation before calling edit_file.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to edit" },
          old_string: { type: "string", description: "The exact string to find and replace" },
          new_string: { type: "string", description: "The string to replace it with" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
      readOnly: false,
      execute: (input, state) =>
        editFile(input as { file_path: string; old_string: string; new_string: string }, state),
    },
    {
      name: "list_files",
      description:
        "List the contents of a directory (non-recursive). Returns one entry per line, prefixed with 'd' for directories and 'f' for files.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "The directory to list. Defaults to the current working directory." },
        },
        required: [],
      },
      readOnly: true,
      execute: (input) => listFiles(input as { path?: string }),
    },
    {
      name: "run_shell",
      description:
        "Execute a shell command and return its output. Use this for running tests, installing packages, git operations, etc. Destructive-looking commands trigger a confirmation prompt.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
        },
        required: ["command"],
      },
      readOnly: false,
      execute: (input) => runShell(input as { command: string; timeout?: number }),
    },
    {
      name: "save_memory",
      description:
        "Save a fact to persistent, cross-session memory. type must be one of: user, feedback, project, reference. Only save information that is NOT derivable by reading the current code, git history, or CLAUDE.md.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short, human-readable memory name" },
          description: { type: "string", description: "One-line description used later to judge relevance — be specific" },
          type: { type: "string", description: "One of: user, feedback, project, reference" },
          content: { type: "string", description: "The memory content. For feedback/project types, include a Why: and How to apply: line." },
        },
        required: ["name", "description", "type", "content"],
      },
      readOnly: false,
      execute: (input) =>
        saveMemoryTool(input as { name: string; description: string; type: string; content: string }),
    },
    {
      name: "forget_memory",
      description: "Delete a saved memory by its filename (as shown in the memory index).",
      input_schema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "The memory file's filename, e.g. feedback_no_summary.md" },
        },
        required: ["filename"],
      },
      readOnly: false,
      execute: (input) => forgetMemoryTool(input as { filename: string }),
    },
  ];

  export function findTool(name: string): ToolDefinition | undefined {
    return toolRegistry.find((t) => t.name === name);
  }

  export function getToolSchemas(): Anthropic.Tool[] {
    return toolRegistry.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  }

  export async function executeTool(
    name: string,
    input: Record<string, unknown>,
    state: ReadFileState,
    permission: PermissionState
  ): Promise<string> {
    const tool = findTool(name);
    if (!tool) return `Unknown tool: ${name}`;

    const decision = checkPermission(name, input, tool.readOnly, permission.mode);

    if (decision.action === "deny") {
      return `Action denied: ${decision.message ?? name}`;
    }

    if (decision.action === "confirm") {
      const key = decision.message ?? name;
      if (!permission.confirmedActions.has(key)) {
        if (!permission.confirmTool) {
          return `Action denied: confirmation required but no interactive confirmation handler is available (non-interactive mode): ${key}`;
        }
        const approved = await permission.confirmTool(key);
        if (!approved) return "User denied this action.";
        permission.confirmedActions.add(key);
      }
    }

    try {
      return await tool.execute(input, state);
    } catch (e) {
      return `Error executing ${name}: ${(e as Error).message}`;
    }
  }
  ```

- [ ] Confirm the diff against Phase 6's version is exactly `save_memory`/`forget_memory` added — nothing about `read_file`/`edit_file`/`list_files`/`run_shell` or `executeTool()`'s gating logic changed:

  ```bash
  cd /Users/grexrr/Documents/NAC
  git diff src/tools.ts
  ```

- [ ] Type-check:

  ```bash
  npx tsc --noEmit
  ```

  This exact file was type-checked (`npx tsc --noEmit`, zero errors) alongside this phase's `memory.ts`/`frontmatter.ts` and Phase 6's unmodified `permissions.ts`, in an isolated scratch directory, as part of writing this tutorial. The `save_memory`/`forget_memory` round trip through the gated `executeTool()` (including the exact permission-mode behavior quoted in Concept 2) was independently verified at runtime in the same directory.

---

## Concept 3: Semantic recall — the "side query," precisely

Here is the mechanism, stripped of anything that sounds more sophisticated than it is: **a second, ordinary Anthropic API call**, sent alongside (not instead of) the main conversation, whose only job is to answer one narrow question — "given this query and this list of memory filenames + one-line descriptions, which ones (if any) are worth injecting?" It is not an embeddings index, not a vector database, and not a separate retrieval service. It's `client.messages.create()` again, with a small, purpose-built system prompt and `max_tokens: 256`.

**Reading the manifest, not the memories.** `scanMemoryHeaders()` (this step) reads only the first 30 lines of each memory file — enough to get past the frontmatter — and returns `{ filename, filePath, mtimeMs, description, type }` for each. `formatMemoryManifest()` turns that into one line per memory:

```
- [feedback] feedback_no_summary.md (2026-06-28T10:30:00.000Z): User dislikes trailing summaries after edits
- [reference] reference_ci_dashboard.md (2026-06-20T09:00:00.000Z): Where CI/CD status is tracked
```

This is the entire input the side query sees for every memory that exists — never the full memory body. This is precisely why the cost stays low even with dozens of memories: a manifest line is a handful of tokens; a full memory file, sent for every candidate on every turn, would not be.

**"Cheap" describes the token cost of this call, not a cheaper model — and this is a real, precisely grounded distinction, not a stylistic choice.** The reference project's `sideQuery` closes over `this.model` — literally the same model the user configured for the main conversation (`claude-code-from-scratch/src/agent.ts`, `buildSideQuery()`, read directly: `const resp = await client.messages.create({ model, max_tokens: 256, ... })`, where `model` is the same variable used everywhere else). Real Claude Code does the opposite, and it's worth knowing the actual production choice even though this tutorial doesn't follow it: `findRelevantMemories()` pins this specific call to a fixed, separate model via `getDefaultSonnetModel()`, *regardless* of what model the main conversation is running (`claude-code/src/memdir/findRelevantMemories.ts`, line 99: `model: getDefaultSonnetModel()`, read directly). This phase follows the reference project's simpler choice — reuse whichever model the caller configured — and flags the real-source difference here rather than silently picking one and calling it "the" answer.

**The selector prompt and its JSON contract**, adapted directly from the reference project (`claude-code-from-scratch/src/memory.ts`, `SELECT_MEMORIES_PROMPT`, quoted verbatim):

```
You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.
```

The response is parsed by regex-extracting the first `{...}` block (in case the model wraps it in a Markdown code fence) and `JSON.parse`-ing it — the same tolerant, "don't assume perfect output" instinct as everywhere else a model's raw text has to become structured data in this series. Up to 5 filenames come back; each selected memory's *full* content is then read from disk (not the manifest line) and truncated to a 4KB-per-file cap if it's larger. **`alreadySurfaced` is filtered out before the side query even runs**, not after — the reasoning matters: if you filtered after, a model that fills all 5 of its slots with memories the caller is about to discard as "already shown" would leave zero room for anything genuinely new this turn. Filtering the candidate list first means every one of the 5 slots is spent on a memory the caller can actually use.

**Freshness**, precisely: any memory older than 1 day gets a warning prepended to its header text, because a raw ISO timestamp doesn't reliably trigger "this might be stale" reasoning in a model the way a phrase like "10 days old" does — this is stated directly in the deep-dive doc (`how-claude-code-works/docs/08-memory-system.md`, line 396: *"模型不擅长日期算术"* — "models aren't good at date arithmetic") and mirrored exactly in this phase's `memoryFreshnessWarning()`.

---

## Implement 3: Semantic recall and the system-prompt section

- [ ] Append this to `src/memory.ts` (the file so far — Implement 1's content plus this addition; the next step keeps appending in the same way):

  ```typescript
  // ─── Memory Header (lightweight scan for semantic recall) ────

  export interface MemoryHeader {
    filename: string;
    filePath: string;
    mtimeMs: number;
    description: string | null;
    type: MemoryType | undefined;
  }

  const MAX_MEMORY_FILES = 200;
  const MAX_MEMORY_BYTES_PER_FILE = 4096;
  const MAX_SESSION_MEMORY_BYTES = 60 * 1024; // 60KB cumulative per session

  /** Scan the memory directory, reading only frontmatter, for the recall selector. */
  export function scanMemoryHeaders(): MemoryHeader[] {
    const dir = getMemoryDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    const headers: MemoryHeader[] = [];
    for (const file of files) {
      try {
        const filePath = join(dir, file);
        const stat = statSync(filePath);
        const raw = readFileSync(filePath, "utf-8");
        const first30 = raw.split("\n").slice(0, 30).join("\n");
        const { meta } = parseFrontmatter(first30);
        headers.push({
          filename: file,
          filePath,
          mtimeMs: stat.mtimeMs,
          description: meta.description || null,
          type: VALID_TYPES.has(meta.type as MemoryType) ? (meta.type as MemoryType) : undefined,
        });
      } catch {
        // Skip corrupt files.
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
        const ts = new Date(h.mtimeMs).toISOString();
        return h.description
          ? `- ${tag}${h.filename} (${ts}): ${h.description}`
          : `- ${tag}${h.filename} (${ts})`;
      })
      .join("\n");
  }

  // ─── Memory Age / Freshness ────────────────────────────────

  export function memoryAge(mtimeMs: number): string {
    const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    return `${days} days ago`;
  }

  /**
   * A memory is a point-in-time observation, not live state. Anything over a
   * day old gets an explicit warning telling the model to verify before
   * asserting it as current fact — a raw timestamp doesn't reliably trigger
   * this reasoning in the model the way "47 days old" does.
   */
  export function memoryFreshnessWarning(mtimeMs: number): string {
    const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
    if (days <= 1) return "";
    return `This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior may be outdated. Verify against current code before asserting as fact.`;
  }

  // ─── Semantic Recall (the "side query") ──────────────────────
  //
  // Not an embedding/vector-search system: a single extra Anthropic API call
  // that sends the query plus a compact MANIFEST of memory filenames and
  // descriptions (never full memory content) and asks the model to pick which
  // ones are worth injecting. "Cheap" refers to the token cost of that
  // request, not a smaller/cheaper model — this reuses whichever model the
  // caller configured (see agent.ts's buildSideQuery). Real Claude Code
  // deliberately does the opposite: it pins this call to a fixed, separate
  // model via getDefaultSonnetModel() regardless of which model the main
  // conversation uses (claude-code/src/memdir/findRelevantMemories.ts, line
  // 99) — a real, cited production difference this tutorial does not follow,
  // matching the reference project's own simpler choice instead.

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
    alreadySurfaced: Set<string>,
    signal?: AbortSignal
  ): Promise<RelevantMemory[]> {
    const headers = scanMemoryHeaders();
    if (headers.length === 0) return [];

    // Filter already-shown memories out BEFORE asking the model — otherwise a
    // model that fills its 5-slot budget with memories the caller is about to
    // discard leaves no room for anything genuinely new this turn.
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

      const filenameSet = new Set(selectedFilenames);
      const selected = candidates.filter((h) => filenameSet.has(h.filename));

      return selected.slice(0, 5).map((h) => {
        let content = readFileSync(h.filePath, "utf-8");
        if (Buffer.byteLength(content) > MAX_MEMORY_BYTES_PER_FILE) {
          content =
            content.slice(0, MAX_MEMORY_BYTES_PER_FILE) +
            "\n\n[... truncated, memory file too large ...]";
        }
        const freshness = memoryFreshnessWarning(h.mtimeMs);
        const headerText = freshness
          ? `${freshness}\n\nMemory: ${h.filePath}:`
          : `Memory (saved ${memoryAge(h.mtimeMs)}): ${h.filePath}:`;

        return { path: h.filePath, content, mtimeMs: h.mtimeMs, header: headerText };
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

  // ─── System prompt section ────────────────────────────────────

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
  ```

- [ ] Verify semantic recall directly, using a fake `sideQuery` function — no API key needed for this step, since `selectRelevantMemories` takes the side-query function as a parameter rather than owning the client itself:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/memory.js').then(async (m) => {
    const f1 = m.saveMemory({ name: 'CI dashboard', description: 'Where CI/CD status is tracked', type: 'reference', content: 'CI dashboard is at https://ci.example.com/dashboard' });
    m.saveMemory({ name: 'Merge freeze', description: '2026-03-05 merge freeze for mobile release', type: 'project', content: 'Merge freeze begins 2026-03-05.' });

    const fakeSideQuery = async (system, userMessage) => JSON.stringify({ selected_memories: [f1] });
    const selected = await m.selectRelevantMemories('what is our deployment process', fakeSideQuery, new Set());
    console.log('selected count:', selected.length);
    console.log('picked the CI memory, not the merge-freeze one:', selected[0]?.path.endsWith(f1));

    const selected2 = await m.selectRelevantMemories('what is our deployment process', fakeSideQuery, new Set([selected[0].path]));
    console.log('already-surfaced filtering works (re-query excludes it):', selected2.length === 0);

    const section = m.buildMemoryPromptSection();
    console.log('prompt section mentions save_memory/forget_memory tools:', section.includes('save_memory') && section.includes('forget_memory'));
  });
  "
  ```

  Real captured output from this exact scenario, run while writing this tutorial:

  ```
  selected count: 1
  picked the CI memory, not the merge-freeze one: true
  already-surfaced filtering works (re-query excludes it): true
  prompt section mentions save_memory/forget_memory tools: true
  ```

---

## Concept 4: Async prefetch — three gates, and what "settled" actually buys you

Kicking off the side query the instant a turn starts, rather than waiting for a good moment to make time for it, is the whole idea — but doing that unconditionally would waste an API call on every single message, including the ones with nothing to recall against. Three gates decide whether it's worth starting at all, adapted directly from the reference project's `startMemoryPrefetch()`:

1. **The query must be "substantial."** A one-word message ("hi", "thanks") can't match anything meaningfully — `isQuerySubstantial()` requires either multiple whitespace-separated words, or (for CJK text, where whitespace doesn't separate words the same way) at least two CJK characters.
2. **The session recall budget must not already be spent.** `MAX_SESSION_MEMORY_BYTES = 60 * 1024` (60KB) caps how much recalled-memory content one session will inject cumulatively — roughly 20–30 medium memories, per the reference project's own sizing note. Past that, further recall is skipped outright rather than continuing to spend API calls on memories that would just get dropped for budget reasons anyway.
3. **Memory files must actually exist.** If the directory has nothing but (at most) an empty index, there's nothing to recall — skip before spending an API call to learn that.

Any one of these failing returns `null` from `startMemoryPrefetch()` — no promise, no API call, nothing to poll later. If all three pass, a `MemoryPrefetch` handle comes back:

```typescript
export interface MemoryPrefetch {
  promise: Promise<RelevantMemory[]>;
  settled: boolean;
  consumed: boolean;
}
```

`promise` is the actual in-flight side query. `settled` starts `false` and flips to `true` via a `.then(..., ...)` attached immediately — critically, both the success and failure branches set it, so a failed side query (network error, malformed JSON, an aborted signal) still gets marked settled rather than leaving a caller polling forever for something that will never resolve. `consumed` starts `false` and is the caller's own bookkeeping — nothing in `memory.ts` sets it; `agent.ts` sets it once it has actually read the result, specifically so a value already retrieved once is never re-injected on a later poll. This structure exists for exactly one reason: it lets a caller check `handle.settled` **without ever awaiting `handle.promise` directly** — checking a boolean is synchronous and free; `await`-ing a pending promise would block until it resolves, defeating the entire point of prefetching in the background. Concept 5 is where this gets consumed.

---

## Implement 4: Async prefetch, injection formatting, and session-scoped state

- [ ] Append this to `src/memory.ts` — this is the final addition; the file is complete after this step:

  ```typescript
  // ─── Async Prefetch ───────────────────────────────────────────

  export interface MemoryPrefetch {
    promise: Promise<RelevantMemory[]>;
    settled: boolean;
    consumed: boolean;
  }

  /** Query substantial enough to be worth a semantic-match API call: multi-word, or 2+ CJK characters. */
  function isQuerySubstantial(query: string): boolean {
    const trimmed = query.trim();
    if (trimmed.length === 0) return false;
    const cjkRegex = /[一-鿿぀-ヿ가-힯]/g;
    const cjkMatches = trimmed.match(cjkRegex);
    if (cjkMatches && cjkMatches.length >= 2) return true;
    if (/\s/.test(trimmed)) return true;
    return false;
  }

  /**
   * Kick off semantic recall in the background, without blocking the caller.
   * Returns null (skip recall entirely) under any of three gates: the query
   * is too short to match meaningfully, this session has already spent its
   * 60KB recall budget, or no memory files exist yet — each one saves a
   * wasted API call. Returns a MemoryPrefetch handle otherwise: `.promise`
   * resolves in the background; `.settled`/`.consumed` let a caller poll it
   * without ever awaiting (and therefore never blocking on) it directly.
   */
  export function startMemoryPrefetch(
    query: string,
    sideQuery: SideQueryFn,
    alreadySurfaced: Set<string>,
    sessionMemoryBytes: number,
    signal?: AbortSignal
  ): MemoryPrefetch | null {
    if (!isQuerySubstantial(query)) return null;
    if (sessionMemoryBytes >= MAX_SESSION_MEMORY_BYTES) return null;

    const dir = getMemoryDir();
    const hasMemories = readdirSync(dir).some((f) => f.endsWith(".md") && f !== "MEMORY.md");
    if (!hasMemories) return null;

    const handle: MemoryPrefetch = {
      promise: selectRelevantMemories(query, sideQuery, alreadySurfaced, signal),
      settled: false,
      consumed: false,
    };
    handle.promise.then(
      () => { handle.settled = true; },
      () => { handle.settled = true; }
    );
    return handle;
  }

  /** Wrap each recalled memory in <system-reminder> tags for injection as user-message content. */
  export function formatMemoriesForInjection(memories: RelevantMemory[]): string {
    return memories
      .map((m) => `<system-reminder>\n${m.header}\n\n${m.content}\n</system-reminder>`)
      .join("\n\n");
  }

  // ─── Session-scoped recall bookkeeping ────────────────────────
  //
  // Created once per process invocation in cli.ts (the same lifetime as
  // Phase 7's CompactionState) and threaded into every runAgentLoop call for
  // that session — NOT created fresh per call the way ReadFileState/
  // PermissionState are (Phase 2/6), because "which memories have already
  // been shown" and "how many bytes of memory content this session has
  // spent" both need to persist ACROSS turns, not reset every turn.

  export interface MemoryRecallState {
    alreadySurfaced: Set<string>;
    sessionMemoryBytes: number;
  }

  export function createMemoryRecallState(): MemoryRecallState {
    return { alreadySurfaced: new Set(), sessionMemoryBytes: 0 };
  }
  ```

- [ ] Verify the three prefetch gates and the injection formatter directly:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsx -e "
  import('./src/memory.js').then(async (m) => {
    m.saveMemory({ name: 'test fact', description: 'a fact', type: 'project', content: 'Some content.' });
    const fakeSideQuery = async () => JSON.stringify({ selected_memories: [] });

    console.log('single-word query -> null:', m.startMemoryPrefetch('hi', fakeSideQuery, new Set(), 0) === null);
    console.log('budget exhausted -> null:', m.startMemoryPrefetch('what is the deploy process', fakeSideQuery, new Set(), 61 * 1024) === null);
    const handle = m.startMemoryPrefetch('what is the deploy process', fakeSideQuery, new Set(), 0);
    console.log('substantial query + memories exist + budget ok -> handle:', handle !== null);
    await handle.promise;
    console.log('settled flag flips after the promise resolves:', handle.settled);

    const inj = m.formatMemoriesForInjection([{ path: 'x', content: 'body', mtimeMs: Date.now(), header: 'Memory (saved today): x:' }]);
    console.log('wrapped in system-reminder tags:', inj.startsWith('<system-reminder>') && inj.trim().endsWith('</system-reminder>'));
  });
  "
  ```

  Real captured output from this exact scenario, run while writing this tutorial:

  ```
  single-word query -> null: true
  budget exhausted -> null: true
  substantial query + memories exist + budget ok -> handle: true
  settled flag flips after the promise resolves: true
  wrapped in system-reminder tags: true
  ```

  `src/memory.ts` is complete after this step. Confirm it type-checks in isolation (no dependency on `@anthropic-ai/sdk` at all — only `frontmatter.ts` and Node built-ins):

  ```bash
  npx tsc --noEmit
  ```

---

## Concept 5: The exact integration point — this phase's crux

Everything above is a pile of correct, independently-testable functions. None of it matters if `agent.ts` calls it from the wrong place — this is the same warning Phase 7's Concept 8 gave about its own compaction hooks, and it applies here with an added wrinkle: **this phase's hook and Phase 7's hook now have to coexist correctly in the same function**, and Phase 7's own closing section flagged exactly this risk in advance:

> *"Phase 8's semantic recall injects recalled memory content into the conversation by appending it to the most recent user message (to preserve user/assistant alternation)... as part of a turn's setup, before the model is asked to respond. Anyone building Phase 8 on top of this phase should keep one thing in mind: if a turn happens to trigger both Tier 4 auto-compact and a memory injection, the compaction... must run before memory content gets appended to the user's message — otherwise a freshly-injected memory block would either get summarized away along with everything else, or (worse) end up as part of the 'last message' `compactConversation` assumes is plain, simple user text, when it might now be a multi-part message with an appended memory block."* — `phase-07-context-engineering.md`, "What's next"

### Where `buildSideQuery` lives, and why it's not in `memory.ts`

`memory.ts`'s `selectRelevantMemories()` takes a `SideQueryFn` as a parameter — it never constructs one itself. The function that actually builds one, `buildSideQuery(client, model)`, lives in `agent.ts`, not `memory.ts`:

```typescript
function buildSideQuery(client: Anthropic, model: string): SideQueryFn {
  return async (system, userMessage, signal) => {
    const resp = await client.messages.create(
      { model, max_tokens: 256, system, messages: [{ role: "user", content: userMessage }] },
      { signal }
    );
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}
```

This is a deliberate placement, not an arbitrary one: `agent.ts` already has both a `client: Anthropic` and a `model: string` in scope (they're `runAgentLoop`'s own options), so building the closure there costs nothing new. Putting it in `memory.ts` instead would mean `memory.ts` importing `@anthropic-ai/sdk` for one function, when every other function in that file is deliberately client-agnostic and independently testable without a live API key or even an installed SDK — exactly the property this phase's Implement 1–4 verification relied on. This mirrors the phase breakdown's own verified claim about the reference project's dependency shape (`phase-breakdown.md`: *"memory.ts only imports frontmatter.ts"*) — this project's `memory.ts` keeps that property too; the one piece of the system that needs a live client sits in the one file that already has one.

### Where the query text comes from

`runAgentLoop` doesn't receive "the user's typed text" as a separate parameter — by Phase 4's own established convention, `cli.ts` pushes `{ role: "user", content: input }` onto `messages` *before* calling `runAgentLoop`. So the current turn's query is derived by reading the array itself:

```typescript
function extractLastUserText(messages: AgentMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content !== "string") return "";
  return last.content;
}
```

### The ordering that matters

Two things happen once, before the `while (true)` loop's first iteration — in this exact order:

```typescript
// 1. Tier 4 compaction — unchanged from Phase 7. Fully resolves before
//    ANYTHING below touches messages again.
if (compaction) {
  await checkAndCompact(messages, compaction, client, model);
}

// 2. Memory prefetch — started only AFTER checkAndCompact() has fully
//    resolved. This ordering is the entire reason memory injection is
//    safe: if compaction fired, `messages` has already been rebuilt to
//    its final, post-compaction shape by this line.
let memoryPrefetch: MemoryPrefetch | null = null;
if (memoryRecall) {
  const query = extractLastUserText(messages);
  const sideQuery = buildSideQuery(client, model);
  memoryPrefetch = startMemoryPrefetch(
    query, sideQuery, memoryRecall.alreadySurfaced, memoryRecall.sessionMemoryBytes, signal
  );
}
```

If `checkAndCompact` fires, it slices off the (guaranteed-plain-text) last message, sends everything before it off for summarization, and rebuilds `messages` to `[summary, acknowledgment, <re-appended last message>]` (Phase 7, Step 6) — all of that happens and fully resolves *before* `extractLastUserText(messages)` ever runs. There is no way for the memory system to read a message that's about to be destroyed, and no way for the compaction system to summarize a message that has memory content spliced into it, because by construction the two operations never touch `messages` in the same tick.

### Injection happens inside the `while (true)` loop, on the same cadence as Tiers 1–3 — not once, like Tier 4

This is the one design question this phase's brief specifically calls out as needing to be reasoned through rather than assumed, and the reference implementation's actual call site (`claude-code-from-scratch/src/agent.ts`, lines 977–1030, read directly) answers it unambiguously: the prefetch is *started* once, but it is *polled* on **every iteration** of the `while (true)` loop, guarded by a `consumed` flag so the actual injection only ever fires once:

```typescript
while (true) {
  if (compaction) {
    runCompressionPipeline(messages, compaction);
  }

  // Non-blocking poll: consume the prefetch the FIRST iteration it's
  // settled, never block waiting for it.
  if (memoryPrefetch && memoryPrefetch.settled && !memoryPrefetch.consumed) {
    memoryPrefetch.consumed = true;
    const memories = await memoryPrefetch.promise;
    if (memories.length > 0) {
      const injectionText = formatMemoriesForInjection(memories);
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          last.content = last.content + "\n\n" + injectionText;
        } else if (Array.isArray(last.content)) {
          last.content.push({ type: "text", text: injectionText });
        }
      } else {
        messages.push({ role: "user", content: injectionText });
      }
      for (const m of memories) {
        memoryRecall!.alreadySurfaced.add(m.path);
        memoryRecall!.sessionMemoryBytes += Buffer.byteLength(m.content);
      }
    }
  }

  // ...streamOneTurn(), tool execution, exactly as Phase 7 left it...
}
```

Why per-iteration polling, not a single check before the loop (the way Tier 4 does it)? Because the two hooks have opposite safety properties. Tier 4's `compactConversation` is only safe to call once, at the one moment `messages`' last entry is guaranteed to be plain user text — calling it again mid-loop, after a tool result has been pushed, would try to slice off a `tool_result` message and corrupt the `tool_use`/`tool_result` pairing (Phase 7, Concept 4). Memory injection has no such fragility: appending a text block to whatever the current last message is — whether that's the original plain-text query (iteration 1) or a `tool_result`-bearing message from a prior iteration of the *same* turn (iteration 2+) — never removes anything and never breaks pairing. It's exactly as safe to check every iteration as Phase 7's own `runCompressionPipeline()` is, for the identical reason: neither one ever deletes a message or a `tool_use`/`tool_result` pair, both only ever mutate content in place or append.

**Two branches, both preserving alternation, never a new standalone user turn back-to-back with another.** If the current last message's `content` is a plain string (the turn hasn't called any tools yet), the memory text is string-concatenated onto it. If it's already a content-block array (a `tool_result` message from an earlier iteration of this same turn), the memory text is pushed as one more `text` block into that same array. Either way, the recalled memory becomes part of an *existing* user turn — never a second, separate `role: "user"` message immediately following another `role: "user"` message, which Phase 1's Concept 2 established the API rejects outright (*"roles must alternate between 'user' and 'assistant'"*). The `else` branch — pushing a brand-new message — is a defensive fallback matching the reference implementation's own structure, for a state (`last.role !== "user"`) that shouldn't actually occur at this call site, not a code path this design relies on.

### Verified end to end, not just reasoned about

This exact ordering and injection behavior was independently tested against the real, compiled `agent.ts`, using a fake client that mimics `MessageStream`'s `.on()`/`.finalMessage()` shape (the same technique Phases 4–7 used for their own abort/streaming/compaction proofs) and logs every `.messages.create()`/`.messages.stream()` call it receives. The scenario: a 5-message prior history (long enough for `compactConversation` to actually have something to summarize), `compaction.lastInputTokens` forced far above the auto-compact threshold, and one saved memory. Real captured output:

```
callLog: [ 'compact-summarize-call', 'sidequery-call', 'stream#1', 'stream#2' ]
compact-summarize-call happened: true
compact ran strictly before stream#1: true
sidequery-call happened after compact-summarize-call: true
```

The rebuilt `messages` array confirmed every claim above directly: the first message was the compacted summary (`[Previous conversation summary]...`), the original last user-text message was re-appended verbatim right after it, a tool call (`list_files`) ran in the first model turn, and the recalled memory's `<system-reminder>`-wrapped text landed as an *additional* content block inside that turn's `tool_result` message — not as a new standalone `user` message:

```json
{
  "role": "user",
  "content": [
    { "type": "tool_result", "tool_use_id": "t1", "content": "d  ...\nf  ..." },
    { "type": "text", "text": "<system-reminder>\nMemory (saved today): .../project_test_fact.md:\n\n---\nname: test fact\n...\n---\n\nThe codename is Zephyr-9.\n</system-reminder>" }
  ]
}
```

`roles.every((r, i) => i === 0 || r !== roles[i-1])` (strict alternation) held `true` across the whole rebuilt array, and `memoryRecall.alreadySurfaced.size` was `1`/`sessionMemoryBytes` was `97` afterward — confirming the session-scoped state genuinely accumulates, ready to be read by the *next* `runAgentLoop` call for this session (Concept 7's threading in `cli.ts`).

### An honest limitation, also directly observed, not merely predicted

A single-iteration turn — the model answers with no tool call at all — gives the prefetch exactly one polling check, at the very top of iteration 1, which happens *synchronously*, in the same tick `startMemoryPrefetch()` returned. A `Promise` can never be settled by the time the very next line of synchronous code runs — JS's own execution model guarantees at least one microtask tick has to elapse first. This means: **if the model's very first response has no tool call, the prefetch never gets a second chance to be polled inside that call, and its result — even though the API call for it was genuinely made and will eventually resolve — is silently discarded** when `runAgentLoop` returns, because `memoryPrefetch` is a local variable scoped to that one call. This was directly observed, not just reasoned through:

```
sideQuery API call was made (prefetch DID start): true
final messages length (no tool call -> single iteration): 2
memoryRecall.alreadySurfaced size (0 = prefetch's result was never consumed/injected this turn): 0
```

This is a real, inherited limitation of the design — present in the reference implementation too, not a NAC-specific bug — worth being able to state precisely in an interview: the async-prefetch pattern's stated worst case ("at most one round late, the user never waits" — this phase's own tutorial backbone) is scoped to *rounds within a single turn's tool-calling loop*, not across separate REPL turns. A turn that never calls a tool wastes the side query's API cost and gets no recall benefit from it at all. Fixing this — e.g., letting the prefetch's promise survive into the *next* `runAgentLoop` call rather than being dropped — is a real, buildable improvement this phase does not implement, flagged here rather than glossed over.

---

## Implement 5: Wire memory into `agent.ts`

- [ ] Replace `src/agent.ts` with this (complete file — this is the final state of `agent.ts` for this phase; every change from Phase 7's Step 7 is called out in the doc comments below):

  ```typescript
  import Anthropic from "@anthropic-ai/sdk";
  import { executeTool, findTool, type ReadFileState, type PermissionState } from "./tools.js";
  import type { PermissionMode } from "./permissions.js";
  import {
    persistLargeResult,
    runCompressionPipeline,
    checkAndCompact,
    type CompactionState,
  } from "./compact.js";
  import {
    startMemoryPrefetch,
    formatMemoriesForInjection,
    type MemoryRecallState,
    type MemoryPrefetch,
    type SideQueryFn,
  } from "./memory.js";

  export type AgentMessage = Anthropic.MessageParam;

  export interface RunAgentLoopOptions {
    client: Anthropic;
    model: string;
    systemPrompt?: string;
    tools?: Anthropic.Tool[];
    maxTokens?: number;
    signal?: AbortSignal;
    onText?: (textDelta: string) => void;
    permissionMode?: PermissionMode;
    confirmTool?: (message: string) => Promise<boolean>;
    compaction?: CompactionState;
    memoryRecall?: MemoryRecallState;
  }

  interface TrackedToolBlock {
    id: string;
    name: string;
    caller: Anthropic.ToolUseBlock["caller"];
    inputJson: string;
  }

  /**
   * Build the sideQuery function memory.ts's selectRelevantMemories() needs:
   * a plain (system, userMessage, signal) -> string function. This lives
   * here, not in memory.ts, specifically so memory.ts has no dependency on
   * @anthropic-ai/sdk or a live client — the same reasoning Phase 2 gave for
   * keeping tools.ts's registry self-contained. Uses max_tokens: 256 and the
   * SAME model the caller configured for the main conversation — not a
   * separate, cheaper model (see memory.ts's own doc comment on
   * selectRelevantMemories for why real Claude Code differs here).
   */
  function buildSideQuery(client: Anthropic, model: string): SideQueryFn {
    return async (system, userMessage, signal) => {
      const resp = await client.messages.create(
        { model, max_tokens: 256, system, messages: [{ role: "user", content: userMessage }] },
        { signal }
      );
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    };
  }

  /** The plain-text content of the last message, or "" if it isn't a plain string. */
  function extractLastUserText(messages: AgentMessage[]): string {
    const last = messages[messages.length - 1];
    if (!last || typeof last.content !== "string") return "";
    return last.content;
  }

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
    const { client, model, systemPrompt, tools, maxTokens, signal, onText, onToolBlockComplete } = options;

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
            // Degrade to an empty input rather than throwing inside a stream
            // event handler (Phase 2's "errors are data" instinct).
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
   * tool_use blocks, execute them, push exactly two entries per turn, repeat.
   *
   * New in this phase: an optional `memoryRecall` state (see memory.ts). If
   * present:
   *   1. Once, immediately AFTER Tier 4 compaction has already resolved
   *      (never before it — see this phase's tutorial, Concept 5) and before
   *      the while(true) loop's first iteration, a semantic-recall side
   *      query is KICKED OFF against the current turn's plain-text user
   *      message — not awaited here, just started. This is the async
   *      prefetch.
   *   2. On every iteration of the while(true) loop — the same cadence as
   *      Tiers 1-3's runCompressionPipeline(), not Tier 4's one-time
   *      checkAndCompact() — a non-blocking poll checks whether that
   *      prefetch has settled. The FIRST iteration where it has, its result
   *      is consumed exactly once (guarded by `.consumed`) and, if any
   *      memories were selected, appended to the CURRENT last message in
   *      `messages` (string-concatenated if that message's content is a
   *      plain string, pushed as an extra text block if it's already a
   *      content-block array) to preserve user/assistant alternation —
   *      never as a new, separate user-role message.
   *
   * Carried over unchanged from Phase 7: a single checkAndCompact() call
   * strictly before the while(true) loop; runCompressionPipeline() inside
   * it; persistLargeResult() wrapping every tool result; a fresh
   * PermissionState built once per call and threaded into both of
   * executeTool()'s call sites.
   */
  export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions
  ): Promise<AgentMessage[]> {
    const {
      client,
      model,
      systemPrompt,
      tools,
      maxTokens = 1024,
      signal,
      onText,
      permissionMode = "default",
      confirmTool,
      compaction,
      memoryRecall,
    } = options;

    const readFileState: ReadFileState = new Map();
    const permission: PermissionState = {
      mode: permissionMode,
      confirmedActions: new Set(),
      confirmTool,
    };

    // Turn-boundary compaction (Tier 4) — unchanged from Phase 7. Runs to
    // completion before ANYTHING below touches `messages` again.
    if (compaction) {
      await checkAndCompact(messages, compaction, client, model);
    }

    // Async memory prefetch — started only after checkAndCompact() has fully
    // resolved. This ordering is the entire reason memory injection is safe:
    // if compaction fired, `messages` has already been rebuilt to its final,
    // post-compaction shape by this line.
    let memoryPrefetch: MemoryPrefetch | null = null;
    if (memoryRecall) {
      const query = extractLastUserText(messages);
      const sideQuery = buildSideQuery(client, model);
      memoryPrefetch = startMemoryPrefetch(
        query,
        sideQuery,
        memoryRecall.alreadySurfaced,
        memoryRecall.sessionMemoryBytes,
        signal
      );
    }

    while (true) {
      // Tiers 1-3 — zero API cost, safe on every iteration of this loop.
      if (compaction) {
        runCompressionPipeline(messages, compaction);
      }

      // Non-blocking poll: consume the prefetch the FIRST iteration it's
      // settled, never block waiting for it. If still in flight, skip
      // silently and check again next iteration (there may not be one, if
      // the model answers with no tool calls — Concept 5's honest
      // limitation: the memories simply arrive too late for this turn).
      if (memoryPrefetch && memoryPrefetch.settled && !memoryPrefetch.consumed) {
        memoryPrefetch.consumed = true;
        const memories = await memoryPrefetch.promise;
        if (memories.length > 0) {
          const injectionText = formatMemoriesForInjection(memories);
          const last = messages[messages.length - 1];
          if (last && last.role === "user") {
            if (typeof last.content === "string") {
              last.content = last.content + "\n\n" + injectionText;
            } else if (Array.isArray(last.content)) {
              last.content.push({ type: "text", text: injectionText });
            }
          } else {
            // Defensive fallback matching the reference implementation: if
            // the last message somehow isn't role "user" (shouldn't happen
            // at this call site), push a new one rather than corrupting an
            // assistant message.
            messages.push({ role: "user", content: injectionText });
          }
          for (const m of memories) {
            memoryRecall!.alreadySurfaced.add(m.path);
            memoryRecall!.sessionMemoryBytes += Buffer.byteLength(m.content);
          }
        }
      }

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
          if (tool?.readOnly) {
            const input = block.input as Record<string, unknown>;
            earlyExecutions.set(block.id, executeTool(block.name, input, readFileState, permission));
          }
        },
      });

      if (compaction) {
        compaction.lastInputTokens = response.usage.input_tokens;
        compaction.lastApiCallTime = Date.now();
      }

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUses.length === 0) {
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const earlyPromise = earlyExecutions.get(toolUse.id);
        const raw =
          earlyPromise !== undefined
            ? await earlyPromise
            : await executeTool(toolUse.name, toolUse.input as Record<string, unknown>, readFileState, permission);

        const result = persistLargeResult(toolUse.name, raw);

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

- [ ] Confirm the diff against Phase 7's version is exactly what Concept 5 described — one new import, `buildSideQuery`/`extractLastUserText` helpers, `memoryRecall?` on `RunAgentLoopOptions`, one prefetch-start block right after `checkAndCompact`, and one poll-and-inject block at the top of the `while (true)` loop:

  ```bash
  cd /Users/grexrr/Documents/NAC
  git diff src/agent.ts
  ```

- [ ] Type-check:

  ```bash
  npx tsc --noEmit
  ```

  This exact file was type-checked (`npx tsc --noEmit`, zero errors) against Phase 6's `tools.ts`/`permissions.ts` and Phase 7's `compact.ts`, plus this phase's `memory.ts`, in an isolated scratch directory. Its integration behavior — the full ordering and injection proof quoted in Concept 5, including the single-iteration wasted-prefetch case — was verified at runtime against this exact compiled file using a fake client, not merely reasoned about.

---

## Concept 6: The system-prompt section — index only, placed last

`buildMemoryPromptSection()` (Implement 3) is called exactly once inside `buildSystemPrompt()` — at session/process start, the same cadence Phase 3 established for every other section (Phase 3's own closing note: *"call it once per new session... not once at process startup and never again"* — true here in the same way it was true for `buildToolsSection()`). It has exactly one job: describe the four types, the two tools, what not to save, and load the **`MEMORY.md` index** (filenames + one-line descriptions) — never the full content of any individual memory file. That distinction matters: the index is small and static enough to justify paying for it on every single turn of every conversation (Phase 3's whole reasoning for what belongs in the system prompt at all); the *specific*, semantically-recalled memory content for a given query is comparatively large, genuinely dynamic, and belongs in the messages array instead (Concept 5), injected only for the turns that actually need it.

Placement is the last entry in `buildSystemPrompt()`'s composition array, after `loadClaudeMd()` — this is Phase 3's own recency-effect argument (Concept 2 of that phase), applied to one more kind of dynamic, per-project content: *"the concepts a model forms early become the lens it uses to interpret everything that comes after... the reverse principle governs where dynamic, per-conversation content goes: at the end, not the start."* The memory index is exactly this kind of content — it changes as the project accumulates memories, and it's the most personalized, most likely-to-be-relevant-right-now section in the whole prompt, so it goes where the model weighs things most heavily.

---

## Implement 6: Wire the memory section into `prompt.ts`

- [ ] In `src/prompt.ts`, add one import alongside the existing `tools.js` import:

  ```typescript
  import { buildMemoryPromptSection } from "./memory.js";
  ```

- [ ] Add `buildMemoryPromptSection()` as the final entry in `buildSystemPrompt()`'s composition array — after `loadClaudeMd()`, which was already last as of Phase 3:

  ```typescript
  export function buildSystemPrompt(): string {
    return [
      IDENTITY_SECTION,
      SYSTEM_SECTION,
      DOING_TASKS_SECTION,
      ACTIONS_SECTION,
      buildToolsSection(),
      TONE_SECTION,
      OUTPUT_EFFICIENCY_SECTION,
      buildEnvironmentSection(),
      loadClaudeMd(),
      buildMemoryPromptSection(),
    ].join("\n\n");
  }
  ```

  Nothing else in `prompt.ts` changes — every static section, `buildToolsSection()` (still iterating `toolRegistry`, which now includes `save_memory`/`forget_memory` automatically, for the identical reason Phase 3, Concept 4 established: generate from the registry, don't hand-maintain a second list), and `buildEnvironmentSection()` are untouched.

- [ ] Confirm the diff is exactly the one import and the one new array entry:

  ```bash
  cd /Users/grexrr/Documents/NAC
  git diff src/prompt.ts
  ```

- [ ] Print the composed prompt and confirm the new section appears last, and that `# Using your tools` now lists `save_memory`/`forget_memory` alongside the original four:

  ```bash
  npx tsx -e "import('./src/prompt.js').then((m) => console.log(m.buildSystemPrompt()))"
  ```

  This was run against this exact code, in the isolated scratch directory used throughout this phase's verification — the `# Memory System` section appeared last, after `# Environment` and any `CLAUDE.md`/rules content, exactly as composed above, and `# Using your tools` correctly listed all six registry entries (`read_file`, `edit_file`, `list_files`, `run_shell`, `save_memory`, `forget_memory`) with zero changes needed to `buildToolsSection()` itself.

---

## Concept 7: `/memory`, and where `MemoryRecallState` lives

Just like Phase 7's `CompactionState`, `MemoryRecallState` (`{ alreadySurfaced: Set<string>; sessionMemoryBytes: number }`) has to persist **across** separate calls to `runAgentLoop` — i.e., across separate REPL turns — not be recreated fresh on every call the way `ReadFileState`/`PermissionState` are. If it were recreated per call, `alreadySurfaced` would forget every memory it had already shown after a single turn, and the same memory could be re-injected into every subsequent turn of the same conversation, defeating the entire point of the whitelist. So `cli.ts` creates exactly one `MemoryRecallState` per process invocation — the same lifetime as `sessionId` and Phase 7's own `compactionState` — and threads it into every `runAgentLoop` call for that session, both the REPL's per-turn call and the one-shot branch.

`/memory` is a plain REPL command, handled entirely client-side: it never pushes anything onto `messages`, never calls `runAgentLoop`, and therefore never consumes a turn or costs an API call — the same "handled before the message ever reaches the model" treatment Phase 4 gave `exit`/`quit`.

---

## Implement 7: Thread `MemoryRecallState` and add `/memory` to `cli.ts`

- [ ] In `src/cli.ts`, add the import (alongside the existing `agent.js`/`tools.js`/`prompt.js`/`session.js`/`permissions.js`/`compact.js` imports):

  ```typescript
  import { createMemoryRecallState, listMemories, type MemoryRecallState } from "./memory.js";
  ```

- [ ] In `main()`, create the state once, alongside Phase 7's `compactionState`:

  ```typescript
  const memoryRecall = createMemoryRecallState();
  ```

- [ ] Thread it into every `runAgentLoop` call — both the REPL branch's per-turn call and the one-shot branch — by adding `memoryRecall` to each call's options object, alongside the `compaction: compactionState` key Phase 7 already put there, and pass `memoryRecall` into `runRepl` the same way `compactionState` is already threaded (add it to `ReplOptions` and destructure it inside `runRepl`).

- [ ] Add the `/memory` command inside `runRepl`'s `rl.once("line", ...)` handler, checked immediately after the `exit`/`quit` check and *before* the line is pushed onto `messages`:

  ```typescript
  if (input === "/memory") {
    const memories = listMemories();
    if (memories.length === 0) {
      console.log("No memories saved yet.");
    } else {
      console.log(`${memories.length} memories:`);
      for (const m of memories) {
        console.log(`    [${m.type}] ${m.name} — ${m.description}`);
      }
    }
    askQuestion();
    return;
  }
  ```

- [ ] Update the REPL's startup banner to mention it, alongside `exit`/`quit`:

  ```typescript
  console.log(
    `nac-mini-agent — session ${sessionId}. Type "exit" or "quit" to leave, or "/memory" to list saved memories.`
  );
  ```

  Only these additions change in `cli.ts` — `parseArgs`, the SIGINT handler, `confirmTool`'s `rl.question(...)` implementation, session save/load, `--resume` handling, and Phase 7's `compaction: compactionState` threading are all untouched.

- [ ] Type-check the whole project:

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

  This exact set of files — `memory.ts`/`frontmatter.ts` (new), `tools.ts`/`agent.ts`/`prompt.ts`/`cli.ts` (modified per this phase's Implement 2, 5, 6, 7) alongside Phase 6's unmodified `permissions.ts` and Phase 4/7's unmodified `session.ts`/`compact.ts` — was type-checked together (`npx tsc --noEmit`, zero errors) in an isolated scratch directory as part of writing this tutorial.

---

## Verify

- [ ] **Type-check the whole project:**

  ```bash
  cd /Users/grexrr/Documents/NAC
  npx tsc --noEmit
  ```

  Expect zero errors.

- [ ] **`/memory` with nothing saved yet:**

  ```bash
  npm start
  ```

  At the `> ` prompt, type `/memory`. Expect `No memories saved yet.` — confirming the command works and doesn't consume a turn (no API call happens; the REPL immediately reprompts).

- [ ] **The phase's own stated verification method: tell the agent a fact in one session, start a new session, recall it.** With `ANTHROPIC_API_KEY` exported:

  ```
  $ npm start
  > Remember that this project's internal codename is Zephyr-9. It's not written down anywhere in the code or docs — I just told you.
  ```

  Confirm the model calls `save_memory` (you should see it happen — if you want to watch the raw tool call, temporarily add a `console.error` inside `executeTool`). Type `exit`. Then start a **completely new process**:

  ```
  $ npm start
  > What's this project's codename?
  ```

  Confirm the agent answers "Zephyr-9" — correctly recalling a fact that was never in this new process's `messages` array at all, proving it came from the file-based memory store, not from any conversation history (Phase 4's `--resume` is not involved here at all — this is a brand-new session with an empty `messages` array).

- [ ] **Confirm `/memory` now shows the saved fact:**

  ```
  > /memory
  ```

  Expect one line: `[project] <name> — <description>` (or whichever type the model chose — it may reasonably classify a codename as `project` or `reference`).

- [ ] **Confirm the memory file actually exists on disk, with frontmatter:**

  ```bash
  find ~/.nac-mini-agent/memory -name "*.md" | xargs cat
  ```

  Expect a `---`-delimited frontmatter block (`name:`, `description:`, `type:`) followed by the memory body, plus a separate `MEMORY.md` index file in the same directory.

- [ ] **Confirm `forget_memory` works:**

  ```
  > Forget the codename memory, it's no longer accurate.
  ```

  Confirm the model calls `forget_memory`, and a follow-up `/memory` shows it gone.

- [ ] **Confirm semantic recall picks up a memory relevant to a DIFFERENT but related phrasing, not just an exact repeat.** Save a memory about something specific (e.g., "the CI dashboard is at https://example.com/ci"), start a new session, and ask a related-but-differently-worded question ("where do I check build status?"). Confirm the agent's answer references the dashboard URL — this is the semantic-match property Concept 3 described (a keyword search for "check build status" would not literally match a memory about "CI dashboard").

- [ ] **Confirm the async prefetch doesn't add perceived latency.** This is harder to observe directly without instrumentation, but the mechanism claim is checkable: temporarily add a `console.error("[memory] prefetch started")` right after `startMemoryPrefetch(...)` in `agent.ts` and a `console.error("[memory] injected")` inside the poll-and-inject block. Ask a multi-word question in a session with existing memories, in a way that also triggers at least one tool call (so the loop has 2+ iterations — Concept 5's honest limitation about single-iteration turns). Confirm `"[memory] prefetch started"` prints immediately, well before the model's streamed response finishes, and `"[memory] injected"` prints inside the tool-processing round-trip, not after the whole turn completes.

- [ ] **Confirm compaction and memory coexist correctly in one real, live session (the load-bearing integration this phase's Concept 5 exists to prove).** Reuse Phase 7's own live-compaction verification trick: temporarily lower `createCompactionState()`'s default in `cli.ts` (e.g. `createCompactionState(4000)`) so a real conversation crosses the auto-compact threshold within a handful of turns. In the same session, save a memory, have several more exchanges to push the conversation past the compaction threshold, then ask something that would only make sense if the agent still has the saved memory. Confirm: a compaction fires (the array's length drops sharply — Phase 7's own verification technique), memory recall still works on a later turn in the same session, and no error about malformed request structure occurs (which is exactly what an incorrectly-ordered injection-before-compaction bug would produce — Phase 7's Concept 4). Revert the temporary override afterward.

**Unverified / flagged explicitly:** every live-model command above was written and reasoned through against code verified in Implement 1–7 — `memory.ts`'s storage/CRUD/index/recall/prefetch logic was actually executed (`npx tsx`) against exactly the code shown, in an isolated scratch directory, with real captured output quoted directly at each step (not predicted transcripts). `agent.ts`'s full integration — the compaction-then-prefetch ordering, the append-to-last-message injection mechanic across both its string and array-content branches, the session-state accumulation, and the single-iteration wasted-prefetch limitation — was independently verified at runtime against a fake client mimicking `MessageStream`'s shape, the same technique every prior phase in this series used for its own hard-to-observe timing/ordering claims. What was **not** independently executed: any live call to the Anthropic API (no API key was available in this authoring environment, consistent with every prior phase's own flagged limitation) — the Verify section's live-model steps (the exact wording the model uses to decide to call `save_memory`, the specific memory type it picks, and the exact recall behavior on a differently-worded follow-up question) are predicted from the mechanism, not observed directly.

---

## What's next

Phase 9 (Multi-Agent / Sub-Agent) is next. One seam this phase leaves for it, worth deciding deliberately rather than defaulting into: **should a sub-agent's own `runAgentLoop` call receive `memoryRecall` at all?** The reference project's answer is a clean, explicit gate — `chatAnthropic`'s prefetch-start block is wrapped in `if (!this.isSubAgent) { ... }` (`claude-code-from-scratch/src/agent.ts`, line 985, read directly) — sub-agents never get a memory prefetch started for them at all. The reasoning generalizes past this specific codebase: a sub-agent is dispatched to do one narrow, delegated task and hand back a result; injecting the *parent* session's accumulated cross-session facts into a child agent's own isolated context is more likely to be noise or a distraction from its one job than a genuine help, and it's an extra API call (the side query) spent on a context that's about to be discarded once the sub-agent returns anyway. When Phase 9 builds its fork-return sub-agent pattern, the natural, grounded default is to simply not pass `memoryRecall` into the child's `runAgentLoop` call at all (leave it `undefined`, the same way a one-shot CLI invocation doesn't pass `confirmTool` — Phase 6's own precedent for "this optional field legitimately doesn't apply in this calling context"). Phase 9's actual permission-inheritance question (already flagged in Phase 6's own "What's next") is a separate, orthogonal decision — this note is only about memory, not about what tools or permission mode a sub-agent inherits.

Two further things worth carrying forward, both explicitly out of this phase's scope and named rather than silently absent: real Claude Code runs a **background memory-extraction agent** after every turn that had no explicit `save_memory`/`write_file` call, specifically to catch memories the main agent didn't think to save proactively (`claude-code/src/services/extractMemories/`, covered in `how-claude-code-works/docs/08-memory-system.md` §6.7) — this phase only builds the explicit, tool-driven save path, not that background pass. And real Claude Code shares one memory directory across every git worktree of the same repository (`findCanonicalGitRoot()`), where this phase's simpler `sha256(cwd)` hash would give each worktree its own, disconnected memory space — a real, cited, un-built refinement, flagged in this phase's `memory.ts` doc comment (Implement 1) rather than glossed over.

---

## Grounding notes

Every non-trivial claim above is grounded in one of these sources, or flagged where it isn't:

- **The four memory types, their exact definitions, and `feedback`'s "record successes too" design decision** — read directly from real `claude-code/src/memdir/memoryTypes.ts` (the `MEMORY_TYPES` array, `TYPES_SECTION_INDIVIDUAL`'s per-type `<description>`/`<when_to_save>` blocks, and the direct quote on lines 60–61 about not only recording corrections), cross-checked against `claude-code-from-scratch/docs/08-memory.md` (the Chinese-language backbone chapter's own table and prose) and the deep-dive chapter `how-claude-code-works/docs/08-memory-system.md` §6.2's independent, matching treatment. All three sources converge on the identical four-type taxonomy — confirmed by reading all three directly, not assumed from one.
- **`WHAT_NOT_TO_SAVE_SECTION`'s exact text and the "even if the user explicitly asks" exclusion** — quoted directly from real `claude-code/src/memdir/memoryTypes.ts`, lines 183–195.
- **The `feedback`/`project` structured-body requirement (rule + Why: + How to apply:) and its stated rationale** — read directly from `memoryTypes.ts`'s `<body_structure>` tags and cross-checked (translated) against `how-claude-code-works/docs/08-memory-system.md`, lines 79–92.
- **`parseFrontmatter`/`formatFrontmatter`'s exact implementation** — ported directly, unmodified, from `claude-code-from-scratch/src/frontmatter.ts`, read directly.
- **`saveMemory`/`listMemories`/`deleteMemory`/`updateMemoryIndex`/`loadMemoryIndex`'s exact shape, the `{type}_{slugified_name}.md` filename convention, and the two-layer (200-line / 25KB) index truncation** — adapted directly from `claude-code-from-scratch/src/memory.ts`, read directly, and cross-checked against real `claude-code/src/memdir/memdir.ts`'s `truncateEntrypointContent()` and its own `MAX_ENTRYPOINT_LINES`/`MAX_ENTRYPOINT_BYTES` constants (lines 35–38) — including the real source's own cited p100 case of "197KB packed into under 200 lines" that justifies the byte-cap as a distinct safeguard from the line-cap, read directly from the real source's comment.
- **Per-project memory scoping via `sha256(cwd).slice(0, 16)`** — adapted directly from `claude-code-from-scratch/src/memory.ts`'s `getProjectHash()`/`getMemoryDir()`, read directly. Real Claude Code's git-worktree-sharing refinement via `findCanonicalGitRoot()` — read directly from `claude-code/src/memdir/paths.ts`, lines 203–205, and cross-checked against `how-claude-code-works/docs/08-memory-system.md`, lines 178–180 — is cited as a real, un-built improvement, not a claim the reference project implements it (it does not; it hashes raw `cwd`, confirmed by direct reading).
- **This phase's `save_memory`/`forget_memory` tools as an adaptation, not a direct port** — this is this tutorial's own design decision, explicitly flagged as such in Concept 2: the reference project saves memories via its own generic `write_file` tool (`claude-code-from-scratch/src/memory.ts`'s own prose, read directly: *"Use the write_file tool to create a memory file"*), which has no equivalent in this project's registry (Phase 2 built `read_file`/`edit_file`/`list_files` only; `edit_file` cannot create new files per its own read-before-edit guard). The decision to add two purpose-built tools instead, and the verification that this requires zero changes to `permissions.ts`, is this tutorial's own contribution, grounded in direct execution against Phase 6's actual `checkPermission()` (Concept 2's quoted real output), not a claim about what the reference project itself does here (it has no equivalent problem to solve, since it has a generic write tool).
- **`scanMemoryHeaders`/`formatMemoryManifest`'s exact shape (30-line frontmatter-only read, sort-by-mtime-desc, cap at 200 files)** — adapted directly from `claude-code-from-scratch/src/memory.ts`, cross-checked against real `claude-code/src/memdir/memoryScan.ts`'s `scanMemoryFiles()`/`formatMemoryManifest()` (near-identical shape, `MAX_MEMORY_FILES = 200`, `FRONTMATTER_MAX_LINES = 30`), both read directly.
- **`memoryAge`/`memoryFreshnessWarning`'s exact thresholds (≤1 day: no warning) and text** — read directly from `claude-code-from-scratch/src/memory.ts` and cross-checked verbatim against real `claude-code/src/memdir/memoryAge.ts` (`memoryFreshnessText()`, near-identical wording, read directly) — the "models are poor at date arithmetic, 'N days ago' triggers staleness reasoning better than an ISO timestamp" rationale is a direct (translated) quote from `how-claude-code-works/docs/08-memory-system.md`, lines 386–396.
- **`selectRelevantMemories()`'s exact mechanism (manifest not full content, JSON-object response contract, up-to-5 cap, `alreadySurfaced` pre-filtering, per-file 4KB truncation)** — adapted directly from `claude-code-from-scratch/src/memory.ts`, read directly (including the exact `SELECT_MEMORIES_PROMPT` text, quoted verbatim), cross-checked against real `claude-code/src/memdir/findRelevantMemories.ts`'s `selectRelevantMemories()` (near-identical structure, its own `SELECT_MEMORIES_SYSTEM_PROMPT`, and its `recentTools` noise-filtering parameter — the one real feature this tutorial does not port, since this project's registry has no equivalent "recently used tool" concept to filter against yet).
- **The side query using the SAME model as the main conversation (this tutorial's choice) versus real Claude Code pinning it to `getDefaultSonnetModel()` (a fixed, different model) regardless of the main model** — both independently verified by direct reading: `claude-code-from-scratch/src/agent.ts`'s `buildSideQuery()` closing over `this.model` (the reference project's own choice, which this tutorial follows), and real `claude-code/src/memdir/findRelevantMemories.ts`, line 99's `model: getDefaultSonnetModel()` (the real production choice, which this tutorial does not follow, flagged explicitly in Concept 3 rather than silently adopting one and presenting it as the only approach).
- **`startMemoryPrefetch()`'s exact three gates (substantial-query check including the CJK-character path, 60KB session budget, memory-files-exist check) and the `settled`/`consumed` polling contract** — adapted directly from `claude-code-from-scratch/src/memory.ts`, read directly (including its `isQuerySubstantial()`'s CJK-regex branch), cross-checked (translated) against `claude-code-from-scratch/docs/08-memory.md`'s own three-gate prose (lines 533–536) and `how-claude-code-works/docs/08-memory-system.md`'s independent framing of the same async-prefetch design (§6.5's closing paragraph, "~250ms 延迟...对用户来说,记忆召回是'免费'的").
- **`formatMemoriesForInjection()`'s `<system-reminder>`-wrapping** — read directly from `claude-code-from-scratch/src/memory.ts`, cross-checked against real Claude Code's own `wrapMessagesInSystemReminder()`/`isMeta: true` treatment of recalled memories, described directly in `how-claude-code-works/docs/08-memory-system.md`, lines 630–672 (this project's simpler design has no `isMeta` UI-hiding concept, since Phase 4's REPL has no UI layer to hide messages from in the first place — a real, cited, structurally-inapplicable-rather-than-omitted difference).
- **The exact integration ordering (checkAndCompact strictly before startMemoryPrefetch; startMemoryPrefetch called once per turn, polled every while(true) iteration, consumed exactly once) and the append-to-last-message injection mechanic (string-concat vs. content-block-array push, guarding user/assistant alternation)** — read directly from `claude-code-from-scratch/src/agent.ts`, lines 976–1030 (`chatAnthropic`'s full body, quoted and walked through in Concept 5), matching this phase's own adaptation for a plain-function `runAgentLoop` rather than a class instance method (the same "no `Agent` class in this project" adaptation Phase 4 and Phase 6 already established for `isProcessing`/`PermissionState`).
- **Phase 7's own forward-note anticipating this exact integration risk** — quoted verbatim from `phase-07-context-engineering.md`'s "What's next" section, read directly from that file in this repository.
- **All TypeScript across Implement 1–7 (`frontmatter.ts`, `memory.ts` in each of its incremental states, the modified `tools.ts`/`agent.ts`/`prompt.ts`/`cli.ts`)** — actually type-checked (`npx tsc --noEmit`, zero errors) against a freshly installed `@anthropic-ai/sdk@0.110.0`, in an isolated scratch directory (`/private/tmp/.../scratchpad/verify-memory-phase8`), alongside reconstructions of Phase 6's actual `tools.ts`/`permissions.ts` (four-tool registry, `PermissionState`-gated `executeTool`) and Phase 7's actual `compact.ts`/`agent.ts` (Tier 0–4 compaction, `streamOneTurn`/`earlyExecutions`) — this phase's own code is a diff against that reconstruction, exactly as its header states, not against an earlier or simpler hypothetical state.
- **The storage/CRUD round trip (save → list → index → delete), the semantic-recall fake-sideQuery scenario (correct memory picked, `alreadySurfaced` filtering verified by re-query), the three prefetch gates, and the injection-formatter's `<system-reminder>` wrapping** — all actually executed (`npx tsx`) against the exact code shown in Implement 1–4, in the same isolated scratch directory, with real captured stdout quoted directly at each step (not predicted transcripts).
- **The full `agent.ts` integration proof (compaction-before-prefetch ordering, `sidequery-call` after `compact-summarize-call`, the tool-result-message-plus-injected-text-block final structure, strict alternation, session-state accumulation) and the single-iteration wasted-prefetch limitation** — both actually executed against the real, compiled `agent.ts` from Implement 5, driven by a fake client mimicking `MessageStream`'s `.on()`/`.finalMessage()` shape (the same technique Phases 4–7 each used for their own hard-to-observe timing/ordering claims), in the same isolated scratch directory. Every quoted callLog, JSON fragment, and boolean assertion result in Concept 5 is real captured output from a real run, not a predicted transcript.
- **`checkPermission()` requiring zero changes for the two new tools, across `default`/`plan`/`bypassPermissions` modes** — actually executed (`npx tsx`) against Phase 6's exact, unmodified `permissions.ts`, in the same isolated scratch directory, with real captured output quoted directly in Concept 2.
- **Unverified / flagged explicitly:** no live Anthropic API call was made while writing this tutorial — no API key was available in this authoring environment, consistent with every prior phase's own flagged limitation. This means the Verify section's live-model steps (the exact tool-call sequence a real model chooses when told to remember something, the specific memory type it classifies a fact as, and the exact wording of a semantically-recalled follow-up answer) are predicted from the verified mechanism, not observed directly. What *is* independently verified, not merely predicted, is every claim about mechanism: `memory.ts`'s full storage/recall/prefetch behavior, `tools.ts`'s permission-gating of the two new tools, and — most importantly for this phase's central claim — the exact ordering and injection behavior of `agent.ts`'s integration with Phase 7's compaction, verified by actually running the real, compiled code against a scripted fake client, not by reasoning about it in the abstract.
