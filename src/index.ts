import Anthropic from "@anthropic-ai/sdk";
import { callClaude, type AgentMessage } from "./agents.js";

async function main() {
    const client = new Anthropic();
    const messages: AgentMessage[] = [
        {role: "user", content: "Greet me in exact 5 word poem."}
    ];

    const resp = await callClaude(messages, {
        client,
        model: "claude-opus-4-8"
    })

    console.log(JSON.stringify(resp.content, null, 2));
    console.log("stop_reason:", resp.stop_reason);
}

main();