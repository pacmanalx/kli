// A stand-in for an agent harness CLI: `bun fake-harness.ts <mode> [prompt]`; without a prompt argument it reads stdin.
const [mode, arg] = process.argv.slice(2);
const prompt = arg ?? (await Bun.stdin.text());
const out = (o: object) => process.stdout.write(JSON.stringify(o) + "\n");
switch (mode) {
  case "claude":
    out({ type: "system", subtype: "init", tools: [] });
    process.stdout.write("a log line that is not JSON\n");
    for (const t of ["Hel", "lo"]) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } });
    out({ type: "result", subtype: "success", is_error: false, result: "Hello", total_cost_usd: 0.0005, usage: { input_tokens: 2, cache_creation_input_tokens: 2700, cache_read_input_tokens: 10, output_tokens: 4 } });
    break;
  case "claude-whole":
    out({ type: "result", subtype: "success", is_error: false, result: `got ${prompt.length} chars`, usage: { input_tokens: 5, output_tokens: 3 } });
    break;
  case "claude-error":
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Credit balance is too low" });
    break;
  case "agy":
    out({ event: "init", init: { tools: ["x"] } });
    out({ event: "step_update", step_update: { step_type: "tool_call", text_delta: "ignored" } });
    out({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "ok" } });
    out({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "\n" } });
    out({ event: "result", result: { status: "SUCCESS", response: "ok\n", usage: { input_tokens: 6027, output_tokens: 1, thinking_tokens: 2 } } });
    break;
  case "opencode":
    out({ type: "step_start", part: { type: "step-start" } });
    out({ type: "text", part: { type: "text", text: "ok" } });
    out({ type: "step_finish", part: { type: "step-finish", tokens: { input: 900, output: 2 }, cost: 0 } });
    break;
  case "text":
    process.stdout.write(`echo: ${prompt}\n`);
    break;
  // where it ran and with what: the folder and the arguments after the mode
  case "where":
    process.stdout.write(`${process.cwd()} | ${process.argv.slice(3).filter((a) => a !== prompt).join(" ")}\n`);
    break;
  // the folder as $PWD says it (OpenCode goes by it)
  case "pwd":
    process.stdout.write(`${process.env.PWD}\n`);
    break;
  // their own tools, as each CLI tells them (shapes taken from real runs)
  case "claude-tools":
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: `ls -la ${process.cwd()} && echo oi > oi.txt` } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "src\nvendas.csv" }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: `${process.cwd()}/nada.txt` } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "File does not exist." }], is_error: true }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "feito" });
    break;
  case "agy-tools":
    out({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls -la" } } } });
    out({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls -la" }, output: "Command exited with code 0.\n\nCommand output:\nsrc\r\nvendas.csv\r\n" } } });
    out({ event: "step_update", step_update: { step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "write_file", tool_info: { name: "write_file", parameters: { Path: `${process.cwd()}/oi.txt` } } } });
    out({ event: "step_update", step_update: { step_index: 4, state: "DONE", step_type: "tool", tool_name: "write_file", tool_info: { name: "write_file", parameters: { Path: `${process.cwd()}/oi.txt` } } } });
    out({ event: "step_update", step_update: { step_index: 6, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: `${process.cwd()}/package.json` }, output: "17 lines, 373 bytes" } } });
    out({ event: "step_update", step_update: { step_index: 8, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "bun test" }, output: "The tool's output was truncated due to being too long. You can find the full output in a file at file:///tmp/output.txt.\n\nHere is a preview with the middle of the output truncated:\nCommand exited with code 1.\n\nCommand output:\nbun test v1.4.4\r\n 3 fail\r\n" } } });
    out({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "feito" } });
    out({ event: "result", result: { status: "SUCCESS", response: "feito" } });
    break;
  case "opencode-tools":
    out({ type: "tool_use", part: { id: "call_8", type: "tool", tool: "shell", state: { status: "completed", input: { command: "false" }, output: "", metadata: { metadata: { exit: 1 } } } } });
    out({ type: "text", part: { type: "text", text: "feito" } });
    break;
  case "kimi-tools":
    out({ role: "meta", type: "system.version", version: "2.2.0" });
    out({ role: "assistant", tool_calls: [{ type: "function", id: "t1", function: { name: "Bash", arguments: '{"command":"ls"}' } }, { type: "function", id: "t2", function: { name: "Write", arguments: '{"path":"oi.txt","content":"oi"}' } }] });
    out({ role: "tool", tool_call_id: "t1", content: "src\nvendas.csv\n" });
    out({ role: "tool", tool_call_id: "t2", content: "Wrote 2 bytes to oi.txt" });
    out({ role: "assistant", content: "feito" });
    break;
  // each CLI says what it will do, uses a tool, then answers (shapes taken from real runs, 06/11/2026)
  case "claude-narrates":
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Vou listar os arquivos." } } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "um.txt\ndois.txt" }] } });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "São 2 arquivos .txt.\n\nFINAL: 2" } } });
    out({ type: "result", subtype: "success", is_error: false, result: "São 2 arquivos .txt.\n\nFINAL: 2" });
    break;
  // with -p, a command its rules do not allow is refused and the run ends there, as a success (12/11/2026)
  case "agy-asks": {
    const git = { name: "run_command", parameters: { CommandLine: "git log --oneline -3" } };
    out({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Vou ler o docs/kli.md e ver os últimos commits.\n" } });
    out({ event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: git } });
    out({ event: "step_update", step_update: { step_index: 3, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { ...git, error: { type: "TOOL_ERROR", message: 'permission check failed for unsandboxed "git log --oneline -3": user denied permission to run command:\ngit log --oneline -3\nProceed without performing this action.' } } } });
    out({ event: "result", result: { status: "SUCCESS", response: "Vou ler o docs/kli.md e ver os últimos commits.\n", num_turns: 1, denied_actions: [{ action: "command", display_name: "RunCommand" }] } });
    break;
  }
  // an explicit deny rule: the model gets the error and goes on
  case "agy-denied": {
    const git = { name: "run_command", parameters: { CommandLine: "git log --oneline -3" } };
    out({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Vou ver os últimos commits.\n" } });
    out({ event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: git } });
    out({ event: "step_update", step_update: { step_index: 3, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { ...git, error: { type: "TOOL_ERROR", message: 'permission check failed for unsandboxed "git log --oneline -3": Permission denied for unsandboxed(git log --oneline -3). Matches user-configured deny rule.' } } } });
    out({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "feito" } });
    out({ event: "result", result: { status: "SUCCESS", response: "Vou ver os últimos commits.\nfeito\n" } });
    break;
  }
  // agy's "response" is the whole text, not its last message
  case "agy-narrates":
    out({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Vou listar os arquivos.\n\n" } });
    out({ event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls" } } } });
    out({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls" }, output: "Command exited with code 0.\n\nCommand output:\num.txt\r\ndois.txt\r\n" } } });
    out({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "Existem 2 arquivos .txt.\n\nFINAL: 2" } });
    out({ event: "result", result: { status: "SUCCESS", response: "Vou listar os arquivos.\n\nExistem 2 arquivos .txt.\n\nFINAL: 2" } });
    break;
  case "kimi-narrates":
    out({ role: "assistant", content: "I will list the files.", tool_calls: [{ type: "function", id: "t1", function: { name: "Glob", arguments: '{"pattern":"*"}' } }] });
    out({ role: "tool", tool_call_id: "t1", content: "um.txt\ndois.txt\n" });
    out({ role: "assistant", content: "There are 2 .txt files.\n\nFINAL: 2" });
    out({ role: "meta", type: "session.resume_hint", session_id: "s1" });
    break;
  case "opencode-narrates":
    out({ type: "text", part: { type: "text", text: "Vou listar." } });
    out({ type: "tool_use", part: { id: "c1", type: "tool", tool: "glob", state: { status: "completed", input: { pattern: "*" }, output: "um.txt\ndois.txt" } } });
    out({ type: "text", part: { type: "text", text: "São 2." } });
    break;
  // the review comes before its last tool (it ran the tests at the end), and nothing after
  case "ends-on-tool":
    out({ type: "text", part: { type: "text", text: "Vou revisar." } });
    out({ type: "tool_use", part: { id: "c1", type: "tool", tool: "read", state: { status: "completed", input: { filePath: "csv.py" }, output: "…" } } });
    out({ type: "text", part: { type: "text", text: "A revisão: o csv.py quebra com 0x81." } });
    out({ type: "tool_use", part: { id: "c2", type: "tool", tool: "shell", state: { status: "completed", input: { command: "pytest" }, output: "ok" } } });
    break;
  case "fail":
    process.stderr.write("starting\nboom: not logged in\n");
    process.exit(3);
  case "slow":
    process.stdout.write("partial ");
    await Bun.sleep(10_000);
    break;
}
