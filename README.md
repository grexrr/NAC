# NAC

NAC is an CLI coding agent prototype to study tool routing, file-system permission control, centeralized state management, context management and the async work-flow design commonly used by modern agent.

---
## Dev Log

### Jul 6. 2026 - Phase 1 Core Agent Loop Initialization

Initialized the core agent loop: a while loop repeatedly calls the API, execute any requested tools (instructed from the *assistant* side), execute locally and feed results back to the `messages` array until the remote deside to stop the requesting tools.

**Core Observation**
- `tool_result` blocks must go back under `role: "user"` — API only has
  two roles, and results count as "not the model."
- Loop's only exit condition is when `tool_use` array has a `length == 0` being satisfied. It actually tells two things. 1. The workflow is always inited with a tool called. 2. It's always up to the `assistant` to determine no more tool needs to be called by assessing the `messages` array (as a log). 

**Next:**
- Phase 2: replace hardcoded `executeTool`/`TIME_TOOL` with a real
  tool registry in `tools.ts`.

### Jul 7. 2026 - Async Generator Experiment (`test.ts`)

Wrote a standalone `async function*` (`stream_data`) that yields three values with a delay between each, then `return`s a final value — to see how async generators behave before Phase 5 (streaming) needs them.

**Understood / clarified:**
- `for await (const item of gen)` consumes yielded values only — it stops once the generator's `done` flag is `true` and never surfaces the generator's `return` value. Calling `gen.next()` again afterward returns `{ value: "done", done: true }` directly.
- Manually driving the generator with `while (!result.done) { ...; result = await gen.next(); }` is the only way to see the `return` value inline, since the final `result.value` (when `done` is `true`) *is* that return value.
- This is the same mechanism the tutorial's Concept 4 pointed to: real Claude Code's `query()` loop is an `async function*` specifically so the agent loop can `yield` intermediate events (assistant messages, tool results) while still `return`-ing a final state — matches what I just observed by hand here.

**Next:**
- Keep `test.ts` as scratch space for this kind of isolated syntax experiment, separate from `src/agent.ts`.


### Jul 7. 2026 - Phase 2 Tool System

Now the core while loop has already been built but the `execute_tool()` is yet a hard coded to inserted directly the mock tool return into `messages`. Questins emerged: how to decide what tools exist? how does the tool `name` requests turn into the actual function call? and most improtantly, what invariants the code enforces that the model itself cannot be trusted to enforce, through prompting along (read-before-edit mtime checks)? 

The three concrete tools built here (read_file, edit_file, list_files) are also, not coincidentally, the three tools that make any coding agent minimally useful: it can see what's in a project, see what's in a specific file, and change a file's contents. Every other tool: search, shell execution, sub-agents, MCP, is an elaboration on top of this same registry/dispatch shape, not a different architecture.

**Understood**

- `Tool` is just an interface with basic fields of `name`, `description`, `input_schema`, `isReadOnly` (for safely parallel execution) and an `execution()` method taking input `Record<string, unknown>` (dictionary) and read-file state as its 2 arguments. `execute()` is invoked from inside `executeTool()` which is responsible for tools look-up and input injection. It is periodically called once per `tool_use` in the core agentic while loop.
- The dispatcher is the `executeTool()` itself. Dispatcher returns error as a string, allowing the "assistant" to react to the failure and make its own decision (retry, apologize, try something else) instead of throwing an Error and breaking the agentic loop.
- The **Mtime guard** is implemented via `ReadFileState`. `read_file` records a file's mtime when it hands the content to the model, and `edit_file` checks that recorded mtime against the file's current mtime before writing, refusing the edit if they don't match — i.e., if the file changed on disk since it was last read.
