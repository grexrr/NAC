import Anthropic from "@anthropic-ai/sdk";

export type AgentMessage = Anthropic.MessageParam;

export interface RunAgentLoopOptions {
    client: Anthropic;
    model: string;
    systemPrompt?: string,
    tools?: Anthropic.Tool[];
    maxTokens?: number;
}

async function executeTool(
    name: string,
    input: Record<string, unknown>
): Promise<string> {
    if (name == "get_current_time") {
        return new Date().toISOString();
    }

    return `Unknown tool: ${name}`;
}

export async function runAgentLoop(
    messages: AgentMessage[],
    options: RunAgentLoopOptions,
): Promise<AgentMessage[]> {
    const { client, model, systemPrompt, tools, maxTokens = 1024 } = options;

    while (true) {
        const resp = await client.messages.create({
            model: model,
            max_tokens: maxTokens,
            system: systemPrompt,
            tools: tools,
            messages: messages
        });

        // The assistant's response (text and/or tool_use blocks) becomes
        // the next entry in the array. We push response.content directly
        // rather than re-building it — it's already in the shape the API
        // expects to see echoed back.
        messages.push({ role:"assistant", content: resp.content });

        const toolUses = resp.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type == "tool_use"
        );


        // No tool calls in this response → the model considers the task
        // done. This is the ONLY stopping condition in this phase (see
        // Concept 4 — production handles six more reasons to continue,
        // which we're not implementing here).
        if (toolUses.length == 0) {
            break;
        }

        // Execute every requested tool and collect one tool_result per
        // tool_use, correlated by tool_use_id (see Concept 1).
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUses) {
            const input = toolUse.input as Record<string, unknown>;
            const result = await executeTool(toolUse.name, input);

            toolResults.push({
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: result
            });
        }

        messages.push({
            role: "user",
            content: toolResults
        });
    }

    return messages;
}