import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseTranscriptForBackfill } from "../src/skills/transcript-parse";
import { attributedReminder, injectedPrompts, userPrompts } from "./harness-fixtures";

function transcript(lines: object[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "backfill-test-")), "t.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

describe("parseTranscriptForBackfill", () => {
  test.each(["string", "blocks", "top-level"])("filters harness reports but keeps user text (%s)", (shape) => {
    const entry = (text: string) => shape === "top-level"
      ? { role: "user", content: text }
      : { type: "user", message: { content: shape === "blocks" ? [{ type: "text", text }] : text } };
    const path = transcript([
      ...injectedPrompts.map(entry),
      ...userPrompts.map(({ prompt }) => entry(prompt)),
      entry(attributedReminder + "/honcho:status"),
      { ...entry("skill body"), isMeta: true },
      { ...entry("subagent prompt"), isSidechain: true },
      { type: "user", message: { content: [{ type: "tool_result", content: "tool output" }] } },
    ]);
    expect(parseTranscriptForBackfill(path).messages.map((m) => m.content)).toEqual(userPrompts.map((p) => p.text));
  });

  test("strips a reminder in a separate content block", () => {
    const path = transcript([{ type: "user", message: { content: [
      { type: "text", text: attributedReminder },
      { type: "text", text: "Keep my actual request." },
    ] } }]);
    expect(parseTranscriptForBackfill(path).messages.map((m) => m.content)).toEqual(["Keep my actual request."]);
  });

  test("keeps a prompt behind a leading system-reminder, without the reminder", () => {
    const path = transcript([
      { type: "user", message: { content: "<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n\ndo the thing" } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ]);
    const users = parseTranscriptForBackfill(path).messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["do the thing"]);
  });
});
