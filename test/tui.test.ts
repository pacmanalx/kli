import { expect, test } from "bun:test";
import { wrap } from "../src/cli/output.ts";
import { keys } from "../src/cli/tui.ts";

test("wrap keeps words whole, keeps indentation and breaks words that do not fit", () => {
  expect(wrap("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  expect(wrap("  indented line\nnext", 20)).toEqual(["  indented line", "next"]);
  expect(wrap("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  expect(wrap("", 5)).toEqual([""]);
  expect(wrap("ação é ótima", 7)).toEqual(["ação é", "ótima"]);
});

test("keys splits escape sequences, control keys, paste and text", () => {
  expect([...keys("olá\x1b[D\x7f\r")]).toEqual(["text:olá", "\x1b[D", "\x7f", "\r"]);
  expect([...keys("\x1b[200~a\nb\x1b[201~x")]).toEqual(["paste:a\nb", "text:x"]);
  expect([...keys("\x1b[5~\x1b\x03")]).toEqual(["\x1b[5~", "\x1b", "\x03"]);
});
