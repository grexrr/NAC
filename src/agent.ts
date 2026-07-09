import Anthropic from "@anthropic-ai/sdk";
import { executeTool, ReadFileState } from "./tools.js";

export type AgentMessage = Anthropic.MessageParam;

export interface RunAgentLoopOptions {
  client: Anthropic;
  model: string;
  systemPrompt?: string,
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function runAgentLoop(
  messages: AgentMessage[],
  options: RunAgentLoopOptions,
): Promise<AgentMessage[]> {
  const { client, model, systemPrompt, tools, maxTokens = 1024, signal } = options;
  const readFileState: ReadFileState = new Map();

  while (true) {
    const resp = await client.messages.create(
      {
        model: model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: tools,
        messages: messages
      },
      { signal }
    );

    // assistant resp
    messages.push({
      role:"assistant",
      content: resp.content
    });

    const toolUses = resp.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type == "tool_use"
    );

    if (toolUses.length == 0) {
      break;
    }

    // Execute every requested tool and collect one tool_result per tool_use, correlated by tool_use_id
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const input = toolUse.input as Record<string, unknown>;
      const result = await executeTool(toolUse.name, input, readFileState);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result
      });
    }

    // user tool result
    messages.push({
      role: "user",
      content: toolResults
    });
  }

  return messages;
}
