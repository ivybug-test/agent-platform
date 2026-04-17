const mockText =
  "This is a mock response for UI development. The real LLM is not being called. You can disable mock mode by setting MOCK_LLM=false in your .env file.";

export async function* mockStream(): AsyncGenerator<string> {
  const words = mockText.split(" ");
  for (const word of words) {
    await new Promise((r) => setTimeout(r, 80));
    yield word + " ";
  }
}

// Simulated OpenAI streaming chunks for tool-call verification.
// Round 0 emits a tool_call to `echo`. Round 1 emits plain text referencing
// the tool result — lets us verify the full loop without a real LLM key.
export async function* mockToolStream(
  round: number,
  toolNames: string[]
): AsyncGenerator<any> {
  await new Promise((r) => setTimeout(r, 40));
  if (round === 0 && toolNames.length > 0) {
    const name = toolNames[0];
    const argsText = JSON.stringify({ message: "hello from mock" });
    // fragment tool_call across chunks to mirror real streaming
    yield {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_mock_0",
                type: "function",
                function: { name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    for (let i = 0; i < argsText.length; i += 8) {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: argsText.slice(i, i + 8) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }
    yield {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    };
    return;
  }

  // Round >= 1: plain-text answer reflecting the tool ran
  const final = "Mock reply: the tool loop executed successfully.";
  for (const word of final.split(" ")) {
    await new Promise((r) => setTimeout(r, 40));
    yield {
      choices: [
        { delta: { content: word + " " }, finish_reason: null },
      ],
    };
  }
  yield { choices: [{ delta: {}, finish_reason: "stop" }] };
}
