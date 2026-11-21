import { expect, test } from "bun:test";
import { cleanRecording, scriptArgs, shellNote } from "../src/cli/shell-mode.ts";

test("the command goes under script, the way each system's script takes it", () => {
  expect(scriptArgs("sudo ls", "/tmp/r.txt", "darwin", () => true)).toEqual(["script", "-q", "/tmp/r.txt", "bash", "-c", "sudo ls"]);
  expect(scriptArgs("echo 'a b'", "/tmp/r.txt", "linux", () => true)).toEqual(["script", "-q", "-e", "-c", `bash -c 'echo '\\''a b'\\'''`, "/tmp/r.txt"]);
  expect(scriptArgs("ls", "/tmp/r.txt", "darwin", () => false)).toBeUndefined();
});

test("a recording as text: no script lines, no codes, no ^D", () => {
  const linux = 'Script started on 2026-10-30 17:58:46-03:00 [COMMAND="ls"]\nhi\r\n\x1b[32mok\x1b[0m\r\n\nScript done on 2026-10-30 17:58:46-03:00 [COMMAND_EXIT_CODE="0"]\n';
  expect(cleanRecording(linux)).toBe("hi\nok");
  expect(cleanRecording("Password:\r\nlogged in\r\n^D\x08\x08")).toBe("Password:\nlogged in");
});

test("the note for the model says who ran it, what it printed and how it ended", () => {
  expect(shellNote("git push", { code: 1, ms: 10, output: "rejected" })).toBe("The person ran this command themselves, in the terminal, in the working directory:\n$ git push\nrejected\n[exit code 1]");
  expect(shellNote("vim x", { code: 0, ms: 10 })).toContain("(what it printed was not recorded)");
});
