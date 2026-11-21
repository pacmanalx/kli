import { expect, test } from "bun:test";
import { sseData } from "../src/core/providers/sse.ts";

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });

test("joins lines split across chunks and ignores anything that is not data:", async () => {
  const seen: string[] = [];
  for await (const d of sseData(stream(": comment\n", 'data: {"a":', "1}\r\n\n", "event: x\ndata: [DONE]"))) seen.push(d);
  expect(seen).toEqual(['{"a":1}', "[DONE]"]);
});
