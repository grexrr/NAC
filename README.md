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
