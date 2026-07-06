# Mini-Claude-Code Learning Plan — Phase Breakdown

## Goal

Learn the architecture of Claude Code deeply enough to demonstrate solid understanding of core AI/agent engineering concepts in a job interview, by building a working mini coding agent from scratch in TypeScript — as fast as reasonably possible (milestone-based, no fixed deadline) — then deepening afterward.

## Sources

- **Target codebase to understand:** `/Users/grexrr/Documents/claude-code` — the real Claude Code source (1,884 TS files, ~512K lines).
- **Reference analysis (architecture explanations):** `/Users/grexrr/Documents/how-claude-code-works` — 15-chapter deep dive mapping every subsystem to the real source.
- **Tutorial backbone (what we actually build from):** `/Users/grexrr/Documents/claude-code-from-scratch` — a companion project that reimplements Claude Code's core architecture in ~4,300 lines of TypeScript across 13 chapters (+ intro + testing), each chapter's doc pairing hand-written code with the real source. This already exists locally with a working TS reference implementation (`src/*.ts`) and Python port (`python/mini_claude/`).
- **Where the learner builds:** this repo, `/Users/grexrr/Documents/NAC` (currently empty aside from README/git init) — a fresh TypeScript implementation, typed by hand by the learner, not copied from the reference.

## Key decisions from planning

- **Language: TypeScript** — matches the real Claude Code source directly and the primary reference implementation in the tutorial repo.
- **API: Anthropic (standard `x-api-key`)**, not OpenAI. The learner will get an Anthropic API key. This follows the tutorial's original chapter sequencing (Anthropic-only through ch1–4; OpenAI-compatible dual-backend introduced naturally at ch5) rather than front-loading a provider abstraction — avoids translating every code sample into a different wire shape and keeps 1:1 comparison with the real source, which is also Anthropic-only.
  - Verified: the real Claude Code source's wire-level Messages API body (`messages`/`tools`/`system`/`cache_control`) is identical to the public documented API — no private schema. The only differences are (a) an OAuth-subscription auth path for Claude Pro/Max/Team logins (`Authorization: Bearer` + `oauth-2025-04-20` beta flag) instead of `x-api-key`, and (b) extra `anthropic-beta` flags marking internal/CC-specific traffic. A standard purchased API key (what we're using) hits the exact same `x-api-key` path as any third-party developer — no divergence relevant to this build.
- **Build location:** this repo (NAC), not a new standalone directory — user confirmed NAC *is* the project.
- **Each phase must end in something runnable** — the learner types the implementation themselves, using the reference `src/*.ts` and the real `claude-code/src` as comparison/verification material, not as source to copy.

## Phase sequencing note

The tutorial's native order is: Phase 1 (ch1–7, core working agent) → Phase 2 (ch8 Memory, ch9 Skills, ch10 Plan Mode, ch11 Multi-Agent, ch12 MCP, ch13 Comparison). Per the user's choice, Memory (ch8) and Multi-Agent (ch11) are pulled forward into the MVP track, ahead of Skills and Plan Mode. Verified via source inspection that this reordering is safe: `subagent.ts` and `memory.ts` only import `tools.ts`/`frontmatter.ts` (already built in Phase 1) — neither has a build dependency on Skills or Plan Mode. One soft dependency is noted: Plan Mode (Phase 11) revisits permission inheritance into sub-agents (Phase 9) as a security nuance — flagged in that phase's brief, not a blocker.

---

## MVP Track — ends in a working, streaming, safe, memory-enabled, multi-agent coding CLI

### Phase 1 — Agent Loop
**Tutorial:** [`tutorials/phase-01-agent-loop.md`](tutorials/phase-01-agent-loop.md)
**Covers:** The core think → act → observe loop: call the Anthropic Messages API, parse the response, detect tool calls, execute, feed results back, repeat until done.
**Why first:** Every other subsystem hangs off this loop. It's the single most important concept for an interview — "how does an agent actually work" starts here.
**Source mapping:** `claude-code-from-scratch/docs/01-agent-loop.md`, `src/agent.ts` (Anthropic-only portion) ↔ real `claude-code/src/query.ts`.
**Tutorial should teach:** the message/tool_use/tool_result content-block shape of the Anthropic API, why tool results are pushed back as `role: "user"`, and why the same array grows by two entries per turn (this is *the* mechanism that gives the agent "memory" within a session).
**Depends on:** nothing (first phase).
**Learner should be able to verify by:** running a minimal REPL that can ask Claude a question and get a streamed-back-eventually text answer (no tools yet, or one trivial tool).

### Phase 2 — Tool System
**Tutorial:** [`tutorials/phase-02-tool-system.md`](tutorials/phase-02-tool-system.md)
**Covers:** Tool registry/dispatch, defining tool schemas, the mtime guard pattern (detect stale file reads before writes), deferred/lazy tool loading.
**Why here:** Tools are what make an "agent" different from a chatbot — this is core interview material (function calling / tool orchestration).
**Source mapping:** ch02, `src/tools.ts` ↔ real `Tool.ts` + the 66 built-in tools.
**Tutorial should teach:** the shared interface every tool implements, why read-only vs write tools matter for later parallelism (Phase 5) and permissions (Phase 6), and what the mtime guard actually prevents (a stale-write race).
**Depends on:** Phase 1 (the loop that dispatches tools).
**Learner should be able to verify by:** the CLI can read a file, edit it via string replacement, and list a directory, all agent-driven.

### Phase 3 — System Prompt
**Tutorial:** [`tutorials/phase-03-system-prompt.md`](tutorials/phase-03-system-prompt.md)
**Covers:** Prompt engineering fundamentals as applied to agents: composing a system prompt, `@include`-style recursive composition, template variables.
**Why here:** Directly follows tools since the system prompt is what tells the model tools exist and how to use them; also a strong interview topic (prompt design for agents, not just prompting for chat).
**Source mapping:** ch03, `src/prompt.ts` ↔ real `prompts.ts`.
**Depends on:** Phase 2 (prompt needs to describe the actual tool set).
**Learner should be able to verify by:** swapping/editing the system prompt changes observable agent behavior (e.g. tone, tool preference) without touching agent.ts.

### Phase 4 — CLI & Sessions
**Tutorial:** [`tutorials/phase-04-cli-sessions.md`](tutorials/phase-04-cli-sessions.md)
**Covers:** REPL loop, Ctrl+C/interrupt handling, session persistence (save/resume conversations).
**Why here:** Turns the agent into something actually usable interactively — first genuinely demo-able artifact.
**Source mapping:** ch04, `src/cli.ts` + `src/session.ts` ↔ real `cli.tsx`.
**Depends on:** Phase 1–3.
**Learner should be able to verify by:** `npm start`, have a multi-turn conversation, Ctrl+C mid-response cleanly, `--resume` picks the conversation back up.

### Phase 5 — Streaming & Parallel Tool Execution
**Tutorial:** [`tutorials/phase-05-streaming.md`](tutorials/phase-05-streaming.md)
**Covers:** Token-by-token streaming output using the Anthropic SDK's stream events; parallel execution of read-only tools; the "streaming tool pre-execution" trick (start executing a tool the instant its `tool_use` block finishes streaming, before the model's full turn ends).
**Why here:** This is the tutorial's original point for introducing the second (OpenAI-compatible) backend — since we're staying Anthropic-only per the user's decision, this phase stays scoped to the Anthropic streaming event model, and the OpenAI backend becomes an optional stretch note rather than a requirement.
**Source mapping:** ch05, `src/agent.ts` (streaming portion) ↔ real `api/claude.ts`.
**Tutorial should teach:** why perceived latency matters more than raw latency for agent UX, and how `content_block_stop` enables early tool execution.
**Depends on:** Phase 1, 2, 4.
**Learner should be able to verify by:** watching text appear incrementally instead of all-at-once; two independent read-only tool calls in one turn complete in parallel (observable via timing/logs).

### Phase 6 — Permissions & Safety
**Tutorial:** [`tutorials/phase-06-permissions.md`](tutorials/phase-06-permissions.md)
**Covers:** 5 trust modes, declarative allow/deny rules, regex-based dangerous-command detection.
**Why here:** Once the agent can execute real commands (Phase 2) and run unattended (Phase 4–5), safety has to exist before going further. Strong interview material for AI-safety-adjacent questions.
**Source mapping:** ch06, `src/tools.ts` (permission layer) ↔ real `permissions/` (52KB in the real source — a whole subsystem).
**Depends on:** Phase 2 (gates tool execution), Phase 4 (needs a place to prompt the user for confirmation).
**Learner should be able to verify by:** a destructive-looking bash command triggers a confirmation prompt; a `.claude/settings.json`-style rule can pre-approve or block specific commands without prompting.

### Phase 7 — Context Engineering (Compression)
**Tutorial:** [`tutorials/phase-07-context-engineering.md`](tutorials/phase-07-context-engineering.md)
**Covers:** 4-tier context compression pipeline, large-tool-result offload to disk (>30KB), why compaction preserves tool_use/tool_result pairing.
**Why here:** Completes the "working coding agent" milestone — this is the subsystem the reference project calls one of the most elegant designs in the whole system, and it's a guaranteed interview topic ("what happens when the context window fills up").
**Source mapping:** ch07, `src/agent.ts` (compaction portion) ↔ real `compact/`.
**Depends on:** Phase 1 (operates on the message history), Phase 5 (compaction must not break streaming).
**Learner should be able to verify by:** deliberately generating a long conversation with large tool outputs and observing compaction trigger, the agent still working coherently afterward, and large results persisted to disk with only a summary in-context.

**— End of core agent milestone: a working, safe, streaming, context-managed CLI coding agent. —**

### Phase 8 — Memory System
**Tutorial:** [`tutorials/phase-08-memory.md`](tutorials/phase-08-memory.md)
**Covers:** 4 memory types, semantic recall (using a cheap "side query" model call to decide what's relevant), async prefetch.
**Why pulled into MVP:** Strong "agents with state" interview topic; demonstrates retrieval-adjacent thinking without needing a vector DB. No build dependency on Skills/Plan Mode (verified: `memory.ts` only imports `frontmatter.ts`).
**Source mapping:** ch08, `src/memory.ts` ↔ real `memory.ts`.
**Depends on:** Phase 1 (needs the agent loop to hook into), Phase 3 (memory content gets injected into context, adjacent to system prompt handling).
**Learner should be able to verify by:** telling the agent a fact in one session, starting a new session, and having the agent recall it via `/memory` or spontaneously when relevant.

### Phase 9 — Multi-Agent (Sub-Agent)
**Tutorial:** [`tutorials/phase-09-multi-agent.md`](tutorials/phase-09-multi-agent.md)
**Covers:** Fork-return sub-agent pattern — main agent dispatches a task to a child agent instance and waits for its result.
**Why pulled into MVP:** High-relevance interview topic (agent orchestration, task delegation, isolation). No build dependency on Skills/Plan Mode (verified: `subagent.ts` only imports `tools.ts`/`frontmatter.ts`).
**Source mapping:** ch11, `src/subagent.ts` ↔ real `AgentTool/`.
**Note for later:** flag here that permission inheritance into sub-agents (default `bypassPermissions`, but Plan Mode's read-only restriction *must* still propagate) will be revisited when Phase 11 (Plan Mode) is built — a real security nuance in the source.
**Depends on:** Phase 1, 2, 6 (permission inheritance model must exist first).
**Learner should be able to verify by:** the main agent delegating an independent subtask (e.g. "check if tests pass" while continuing other work) to a sub-agent and incorporating its result.

**— MVP complete: interview-ready demo covering agent loop, tool orchestration, streaming, permissions/safety, context engineering, memory, and multi-agent delegation. —**

---

## Deep-Dive Track — no rush, pursued after MVP

### Phase 10 — Skills System
**Covers:** Skill discovery (project vs user level), inline vs. fork execution modes.
**Source mapping:** ch09, `src/skills.ts` ↔ real `SkillTool/`.
**Depends on:** Phase 1–4 (needs the loop, tools, prompt composition, and CLI commands like `/skills`).

### Phase 11 — Plan Mode
**Covers:** Read-only planning mode, the 4-option approval workflow, revisiting the permission-inheritance interaction with sub-agents flagged in Phase 9.
**Source mapping:** ch10, `src/agent.ts` (plan-mode portion) ↔ real `EnterPlanMode`.
**Depends on:** Phase 6 (permissions), Phase 9 (sub-agent permission inheritance).

### Phase 12 — MCP Integration
**Covers:** JSON-RPC over stdio to connect external tool servers, dynamic tool discovery.
**Source mapping:** ch12, `src/mcp.ts` ↔ real `mcpClient.ts`.
**Depends on:** Phase 2 (tools must already have a uniform interface external tools can plug into).

### Phase 13 — Testing & Verification
**Covers:** How the reference project tests an agent system — a genuinely good interview topic ("how do you test something non-deterministic").
**Source mapping:** ch14 (`claude-code-from-scratch/docs/14-testing.md`), `test/` directory in the reference repo.
**Depends on:** whichever phases have been built so far (can be done incrementally, but as a distinct phase it's cleanest after Phase 12).

### Phase 14 — Capstone: Real-Source Comparison & Interview Synthesis
**Covers:** Cross-reference the learner's ~4,300-line build against the real `claude-code/src` (512K lines) for the topics they most want depth on; consolidate a one-page "what production adds beyond MVP" comparison; assemble interview talking points per subsystem (tradeoffs, why-not-alternatives, scaling concerns).
**Aside to fold in:** a short, factual note that the real Claude Code source's wire-level API calls are structurally identical to the public Anthropic API the learner used throughout this build — the only differences are OAuth-subscription auth (vs. the standard API key used here) and some internal-only beta flags — so nothing in this build diverges from "how the real thing actually talks to the API."
**Source mapping:** ch13 (`claude-code-from-scratch/docs/13-whats-next.md`) + direct reads of relevant real-source files as needed.
**Depends on:** all prior phases.
