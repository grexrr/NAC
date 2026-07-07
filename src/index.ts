import Anthropic from "@anthropic-ai/sdk";
import { runAgentLoop, type AgentMessage } from "./agents.js";

const TIME_TOOL: Anthropic.Tool = {
    name: "get_current_time",
    description: "Get the current date and time in IOS 8601 format.",
    input_schema: { type: "object", properties: {}}
};

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
    const userMessage = process.argv.slice(2).join(" ") || "What time is it right now?";
    const client = new Anthropic();
    
    const messages: AgentMessage[] = [{ role: "user", content: userMessage }];

    const finalMessages = await runAgentLoop(messages, {
        client,
        model: "claude-opus-4-8",
        systemPrompt: "You are a terse assistant.",
        tools: [TIME_TOOL],
    });

    console.log(extractFinalText(finalMessages));
    console.log(JSON.stringify(finalMessages, null, 2));
}

main();