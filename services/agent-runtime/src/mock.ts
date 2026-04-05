const mockText =
  "This is a mock response for UI development. The real LLM is not being called. You can disable mock mode by setting MOCK_LLM=false in your .env file.";

export async function* mockStream(): AsyncGenerator<string> {
  const words = mockText.split(" ");
  for (const word of words) {
    await new Promise((r) => setTimeout(r, 80));
    yield word + " ";
  }
}
