// The one file that knows the names of the CLI's stream-json events and
// fields, and of the session transcript's records. Neither has a stated
// contract (read from CLI 2.1.332), so a renamed field is fixed here and
// nowhere else.
//
// Two things are missing on purpose. There is no accessor for what a model
// wrote: a model can say it ran a skill it never ran, so no verdict may rest
// on its text. And a run's exit code is not handed on: the process exited 0
// with a broken hook and 1 at an expected stop.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "./stage.mjs";

// The model name on a message the CLI wrote itself, such as a local
// command's output.
const SYNTHETIC = "<synthetic>";

function records(text) {
  const parsed = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { parsed, malformed };
}

const blocks = (event, type) => (Array.isArray(event.message?.content) ? event.message.content : []).filter((block) => block.type === type);

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function readTrace(stream, transcript = "") {
  const { parsed: events, malformed } = records(stream);
  const lines = records(transcript).parsed;
  const ofType = (type) => events.filter((event) => event.type === type);
  const system = (subtype) => ofType("system").filter((event) => event.subtype === subtype);

  const results = () =>
    ofType("result").map((event) => ({
      subtype: event.subtype,
      isError: event.is_error === true,
      costUsd: event.total_cost_usd,
      turns: event.num_turns,
      models: Object.keys(event.modelUsage ?? {}),
      permissionDenials: (event.permission_denials ?? []).map((denial) => ({ tool: denial.tool_name, input: denial.tool_input })),
      subagentsByType: event.subagent_stats?.by_type ?? {},
    }));

  // The init event names the configured model even when none is called, so
  // a real model is one that was billed or that signed a message.
  const models = () => {
    const named = [...results().flatMap((result) => result.models), ...ofType("assistant").map((event) => event.message?.model)];
    return [...new Set(named.filter((model) => model && model !== SYNTHETIC))];
  };

  const userEvents = () =>
    ofType("user")
      .filter((event) => typeof event.message?.content === "string" || blocks(event, "text").length)
      .map((event) => ({ text: textOf(event.message.content), isReplay: event.isReplay === true, isSynthetic: event.isSynthetic === true }));

  return {
    malformed,

    hooks: () =>
      system("hook_response").map((event) => ({
        name: event.hook_name,
        event: event.hook_event,
        exitCode: event.exit_code,
        outcome: event.outcome,
        stdout: event.stdout ?? "",
        stdoutSha256: sha256(event.stdout ?? ""),
        stdoutBytes: Buffer.byteLength(event.stdout ?? ""),
        stderr: event.stderr ?? "",
      })),

    // A stream that carries several user messages repeats the init event; the
    // first one describes the session.
    init: () => {
      const [event] = system("init");
      if (!event) return null;
      return {
        cliVersion: event.claude_code_version,
        cwd: event.cwd,
        plugins: (event.plugins ?? []).map(({ name, path, source, version }) => ({ name, path, source, version })),
        // Absent from the event when the loader has nothing to report.
        pluginErrors: (event.plugin_errors ?? []).map(({ plugin, type, message }) => ({ plugin, type, message })),
        mcpServers: (event.mcp_servers ?? []).map((server) => server.name ?? String(server)),
        tools: event.tools ?? [],
        skills: event.skills ?? [],
        slashCommands: event.slash_commands ?? [],
        agents: event.agents ?? [],
      };
    },

    results,
    result: () => results().at(-1) ?? null,
    models,

    toolUses: () =>
      ofType("assistant").flatMap((event) =>
        blocks(event, "tool_use").map((block) => ({ id: block.id, name: block.name, input: block.input, parentToolUseId: event.parent_tool_use_id ?? null })),
      ),

    toolResults: () =>
      ofType("user").flatMap((event) =>
        blocks(event, "tool_result").map((block) => ({ toolUseId: block.tool_use_id, isError: block.is_error === true, text: textOf(block.content) })),
      ),

    userEvents,
    replays: () => userEvents().filter((event) => event.isReplay),

    // Text is offered for user lines only: an assistant line is model prose.
    transcriptLines: () =>
      lines.map((line) => ({
        type: line.type,
        attachment: line.attachment?.type ?? null,
        hookName: line.attachment?.hookName ?? null,
        durationMs: line.attachment?.durationMs ?? null,
        isMeta: line.isMeta === true,
        text: line.type === "user" ? textOf(line.message?.content) : null,
      })),

    // With no model call, the result text is the output of a local command
    // such as /context. With one, it is the model's last message.
    resultText: () => {
      const last = ofType("result").at(-1);
      if (!last) return null;
      if (models().length || results().some((result) => result.costUsd !== 0)) {
        throw new Error("the result text is offered only for a trace that cost nothing and called no model");
      }
      return typeof last.result === "string" ? last.result : null;
    },
  };
}

export const runNames = (dir) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl") && !file.endsWith(".transcript.jsonl"))
    .map((file) => file.slice(0, -".jsonl".length))
    .sort();

export function readRun(dir, name) {
  const file = (suffix) => join(dir, `${name}${suffix}`);
  const bytes = readFileSync(file(".jsonl"));
  const sidecar = existsSync(file(".sidecar.json")) ? JSON.parse(readFileSync(file(".sidecar.json"), "utf8")) : {};
  const transcript = existsSync(file(".transcript.jsonl")) ? readFileSync(file(".transcript.jsonl"), "utf8") : "";
  return {
    name,
    trace: readTrace(bytes.toString("utf8"), transcript),
    sha256: sha256(bytes),
    recordedSha256: sidecar.trace_sha256 ?? null,
    argv: sidecar.argv ?? [],
  };
}
