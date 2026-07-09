import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentMessage } from "./agent.js";

// e.g. "/Users/grexrr/.nac-mini-agent/sessions"
// One file per session inside it: <id>.json, e.g. "a3f9c2d1.json"
const SESSION_DIR = join(homedir(), ".nac-mini-agent", "sessions");

/**
 * Label info for finding a session later, WITHOUT parsing its full
 * messages array. Example:
 * {
 *   id: "a3f9c2d1",                          // randomUUID().slice(0, 8), from cli.ts
 *   model: "claude-opus-4-8",
 *   cwd: "/Users/grexrr/Documents/NAC",
 *   startTime: "2026-07-09T06:22:15.914Z",   // ISO string, sorted on by getLatestSessionId
 *   messageCount: 4
 * }
 */
export interface SessionMetaData {
  id: string,
  model: string,
  cwd: string,
  startTime: string;
  messageCount: number;
}

/**
 * The exact shape written to disk as <id>.json. `messages` is the same
 * AgentMessage[] the loop has grown since Phase 1 — nothing new, just
 * a place to put it. Example file content:
 * {
 *   "metadata": { ...SessionMetaData example above... },
 *   "messages": [
 *     { "role": "user",      "content": "what time is it?" },
 *     { "role": "assistant", "content": [ { "type": "tool_use", "id": "toolu_01..", "name": "get_time", "input": {} } ] },
 *     { "role": "user",      "content": [ { "type": "tool_result", "tool_use_id": "toolu_01..", "content": "22:14Z" } ] },
 *     { "role": "assistant", "content": [ { "type": "text", "text": "It's 22:14 UTC." } ] }
 *   ]
 * }
 */
export interface SessionData {
  metadata: SessionMetaData;
  messages: AgentMessage[];
}

// Creates "~/.nac-mini-agent/sessions" on first save if missing
// (recursive: also creates "~/.nac-mini-agent" itself). No-op afterward.
function ensureDir(): void {
  if(!existsSync(SESSION_DIR)){
    mkdirSync(SESSION_DIR, { recursive:true });
  }
}

/**
 * ("a3f9c2d1", { metadata, messages })
 *   -> writes ~/.nac-mini-agent/sessions/a3f9c2d1.json  (whole-file overwrite,
 *      pretty-printed; the entire SessionData example above, verbatim)
 * Called after every turn from cli.ts, so the newest save always wins.
 */
export function saveSession(id: string, data: SessionData): void {
  ensureDir();
  writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

/**
 * "a3f9c2d1" -> the parsed SessionData example above (metadata + messages)
 * "nope"     -> null  (no such file)
 * corrupted  -> null  (unparseable JSON — treated same as missing)
 */
export function loadSession(id: string): SessionData | null {
  const file = join(SESSION_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as SessionData;
  } catch {
    return null;
  }
}

/**
 * Directory scan -> metadata only (full messages arrays are parsed but
 * not returned). Example, with two saved sessions on disk:
 *
 *   files = ["a3f9c2d1.json", "b7e21f00.json"]   // readdirSync: bare names, no dir!
 *   returns [
 *     { id: "a3f9c2d1", model: "claude-opus-4-8", cwd: "...", startTime: "2026-07-09T06:22:15.914Z", messageCount: 4 },
 *     { id: "b7e21f00", model: "claude-opus-4-8", cwd: "...", startTime: "2026-07-08T21:03:41.002Z", messageCount: 12 },
 *   ]  // disk order, NOT sorted — getLatestSessionId sorts
 */
export function listSessions(): SessionMetaData[] {
  ensureDir();
  const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
  const metas: SessionMetaData[] = []
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(SESSION_DIR, file), "utf-8")) as SessionData;
      metas.push(data.metadata);
    } catch {
      // Skip a corrupted or partially-written session file rather than
      // failing the whole listing. NOTE: this also swallowed a real path
      // bug once (readFileSync(file) without join(SESSION_DIR, ...)) —
      // narrow try + empty catch hides whatever throws inside it.
    }
  }
  return metas;
}

/**
 * Sorts listSessions() output by startTime, newest first, returns its id.
 * With the example above: "2026-07-09..." > "2026-07-08...", so -> "a3f9c2d1".
 * Empty directory -> null (cli.ts's --resume prints "No previous sessions found").
 */
export function getLatestSessionId(): string | null {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  return sessions[0].id;
}
