import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { AgentMessage, runAgentLoop, RunAgentLoopOptions } from "./agent.js";
import { buildSystemPrompt } from "./prompt.js";
import { getLatestSessionId, loadSession, saveSession, SessionData, SessionMetaData } from "./session.js";
import { getToolSchemas } from "./tools.js";

interface ParsedArgs {
  resume: boolean;
  prompt?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let resume = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") {
      resume = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(
        [
          "Usage: nac-mini-agent [options] [prompt]",
          "",
          "Options:",
          "  --resume       Resume the most recently saved session",
          "  --help, -h     Show this help",
          "",
          'With a prompt argument, runs once and exits. Without one, starts an',
          'interactive REPL. Type "exit" or "quit", or press Ctrl+C twice, to leave.',
        ].join("\n")
      );
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  return {
    resume,
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}

function printFinalText(messages: AgentMessage[]): void {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant" || !Array.isArray(lastMsg.content)) return;

  const text = lastMsg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (text) console.log(text);
}

function printPrompt(): void {
  process.stdout.write("\n> ");
}

function buildSessionData(
  sessionId: string,
  model: string,
  startTime: string,
  messages: AgentMessage[]
): SessionData {
  const metaData: SessionMetaData = {
    id: sessionId,
    model: model,
    cwd: process.cwd(),
    startTime: startTime,
    messageCount: messages.length,
  }
  return { metadata: metaData, messages };
}


// ──────────── Repl Config & Main Loop ────────────

interface ReplOptions {
  client: Anthropic;
  model: string;
  systemPrompt: string;
  tools: Anthropic.Tool[];
  sessionId: string;
  startTime: string;
}

async function runRepl(messages: AgentMessage[], options: ReplOptions): Promise<void> {
  const { client, model, systemPrompt, tools, sessionId, startTime } = options;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // null while idle; set to the in-flight turn's controller while a call
  // to runAgentLoop is pending. This single variable IS "is the agent
  // busy" — no separate boolean needed, mirroring the reference
  // implementation's `get isProcessing() { return this.abortController
  // !== null }` (claude-code-from-scratch/src/agent.ts, lines 293-294).
  let currentController: AbortController | null = null;
  let sigintCount = 0;

  process.on("SIGINT", () => {
    if (currentController) {
      // Mid-turn: abort only this turn's in-flight API call. The pending
      // `await client.messages.create(...)` inside runAgentLoop rejects
      // with Anthropic.APIUserAbortError; the line handler below catches
      // it without printing an error. Nothing here touches `messages` —
      // it is left exactly as it was before this turn started, or with
      // one fully-formed assistant/tool-result pair appended (Concept 1).
      currentController.abort();
      console.log("\n  (interrupted)");
      sigintCount = 0;
      printPrompt();
    } else {
      // Idle: first press warns, second press (before any line is
      // submitted) exits. No timeout window — a deliberate simplification
      // of real Claude Code's stricter 800ms double-press (Concept 1).
      sigintCount++;
      if (sigintCount >= 2) {
        console.log("\nBye!\n");
        process.exit(0);
      }
      console.log("\n  Press Ctrl+C again to exit.");
      printPrompt();
    }
  });

  console.log(`nac-mini-agent — session ${sessionId}. Type "exit" or "quit" to leave.`);

  const askQuestion = (): void => {
    printPrompt();

    rl.once("line", async (line) => {
      const input = line.trim();
      sigintCount = 0;

      if (!input) {
        askQuestion();
        return;
      }
      if (input === "exit" || input === "quit") {
        console.log("\nBye!\n");
        rl.close();
        process.exit(0);
      }

      messages.push({ role: "user", content: input});
      currentController = new AbortController();
      const replOptions: RunAgentLoopOptions = {
        client: client,
        model: model,
        systemPrompt: systemPrompt,
        tools: tools,
        signal: currentController.signal,
      };

      try {
        await runAgentLoop(messages, replOptions);
        printFinalText(messages);
      } catch (e) {
        if(!(e instanceof Anthropic.APIUserAbortError)) {
          console.error(`Error: ${(e as Error).message}`);
        }
      } finally {
        currentController = null;
        saveSession(sessionId, buildSessionData(sessionId, model, startTime, messages));
      }
    })
  };

  askQuestion();
}

export async function main(): Promise<void> {
  const { resume, prompt } = parseArgs();

  const client = new Anthropic();
  const model = "claude-opus-4-8";
  const systemPrompt = buildSystemPrompt();
  const tools = getToolSchemas();

  let messages: AgentMessage[] = [];
  let sessionId = randomUUID().slice(0, 8);
  const startTime = new Date().toISOString();

  if (resume) {
    const latestId = getLatestSessionId();
    if (latestId) {
      const session = loadSession(latestId);
      if (session) {
        messages = session.messages;
        sessionId = session.metadata.id;
        console.log(`Resumed session ${sessionId} (${messages.length} messages).`);
      } else {
        console.log("Could not read the most recent session file — starting fresh.");
      }
    } else {
      console.log("No previous sessions found — starting fresh.");
    }
  }

  if (prompt) {
    messages.push({ role: "user", content: prompt });
    try {
      await runAgentLoop(messages, { client, model, systemPrompt, tools });
      printFinalText(messages);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    saveSession(sessionId, buildSessionData(sessionId, model, startTime, messages))
  } else {
    await runRepl(
      messages,
      { client, model, systemPrompt, tools, sessionId, startTime }
    );
  }

}
