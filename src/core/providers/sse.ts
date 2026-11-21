/** Reads a text/event-stream body and yields each `data:` line, even when a chunk splits a line. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of body) {
    rest += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, end).replace(/\r$/, "");
      rest = rest.slice(end + 1);
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
  rest += decoder.decode();
  if (rest.startsWith("data:")) yield rest.slice(5).trimStart();
}
