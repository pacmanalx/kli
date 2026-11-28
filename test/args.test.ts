import { expect, test } from "bun:test";
import { ArgsError, buildPrompt, parseArgs } from "../src/cli/args.ts";

test("loose prompt, options in any position", () => {
  expect(parseArgs(["what", "is", "--json", "2+2"])).toEqual({ command: "prompt", prompt: "what is 2+2", model: undefined, days: undefined, print: false, json: true });
  expect(parseArgs(["--model=mac/ollama/lfm3", "hi"]).model).toBe("mac/ollama/lfm3");
  expect(parseArgs(["-m", "vertex/gemini-3.5-flash", "hi"])).toMatchObject({ prompt: "hi", model: "vertex/gemini-3.5-flash" });
  expect(parseArgs(["-p", "hi"])).toMatchObject({ command: "prompt", prompt: "hi", print: true });
});

test("subcommands", () => {
  expect(parseArgs(["locations"]).command).toBe("locations");
  expect(parseArgs(["models"])).toMatchObject({ command: "models", id: undefined });
  expect(parseArgs(["models", "mac/ollama"])).toMatchObject({ command: "models", id: "mac/ollama" });
  expect(parseArgs(["check", "gpubox"])).toMatchObject({ command: "check", id: "gpubox" });
  expect(parseArgs(["sessions", "2026"])).toMatchObject({ command: "sessions", id: "2026" });
  expect(parseArgs(["--help"]).command).toBe("help");
  expect(parseArgs(["-v"]).command).toBe("version");
  // with more words, or with -p, a subcommand name is just the start of a prompt
  expect(parseArgs(["models", "of", "AI"])).toMatchObject({ command: "prompt", prompt: "models of AI" });
  expect(parseArgs(["-p", "golem"])).toMatchObject({ command: "prompt", prompt: "golem" });
  expect(parseArgs(["--", "--json"])).toMatchObject({ command: "prompt", prompt: "--json", json: false });
});

test("unknown options, --model without a value, and the options that went away", () => {
  expect(() => parseArgs(["--xyz"])).toThrow(ArgsError);
  expect(() => parseArgs(["--model"])).toThrow(ArgsError);
  expect(() => parseArgs(["--provider", "gemini"])).toThrow(/--model location\/provider\/model/);
  expect(() => parseArgs(["--profile=kli.chat"])).toThrow(/--profile is gone/);
});

test("piped input becomes context; with no prompt, it is the prompt", () => {
  expect(buildPrompt("review", "diff\n")).toBe("<input>\ndiff\n</input>\n\nreview");
  expect(buildPrompt(undefined, "  hi  ")).toBe("hi");
  expect(buildPrompt(" hi ", "")).toBe("hi");
});
