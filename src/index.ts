import Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop, type AgentMessage } from "./agents.js";
import { getToolSchemas } from "./tools.js";


function extractFinalText(messages: AgentMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !Array.isArray(last.content)){
    return "";
  }

  return last.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function main() {
  const userMessage = process.argv.slice(2).join(" ") || "List the files in the current directory.?";
  const client = new Anthropic();

  const messages: AgentMessage[] = [{ role: "user", content: userMessage }];

  const finalMessages = await runAgentLoop(messages, {
    client,
    model: "claude-opus-4-8",
    systemPrompt: "You are a terse assistant.",
    tools: getToolSchemas(),
  });

  console.log(extractFinalText(finalMessages));
  console.log(JSON.stringify(finalMessages, null, 2));
}

main();
