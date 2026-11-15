import { describe, expect, test } from "bun:test";
import { isHarnessInjected, isSlashCommand, stripLeadingReminders } from "../src/prompt-filters";

import { attributedReminder, injectedPrompts, userPrompts } from "./harness-fixtures";

const worktreeNotice =
  "<system-reminder>\nYou are operating in a git worktree.\nWorktree path: /tmp/wt\n</system-reminder>\n\n";
const taskNotice = "<system-reminder>\nThe user started your suggested background task.\n</system-reminder>\n";

describe("stripLeadingReminders", () => {
  test.each(userPrompts)("preserves user text: $prompt", ({ prompt, text }) => {
    expect(stripLeadingReminders(prompt)).toBe(text);
  });

  test("strips attributed reminders with quoted angle brackets", () => {
    expect(stripLeadingReminders('<system-reminder note="a > b">notice</system-reminder>\nhello')).toBe("hello");
  });

  test("removes a leading reminder and keeps the typed text", () => {
    expect(stripLeadingReminders(worktreeNotice + "is this resolved on main?")).toBe("is this resolved on main?");
  });

  test("removes stacked reminders", () => {
    expect(stripLeadingReminders(worktreeNotice + taskNotice + "go")).toBe("go");
  });

  test("leaves reminders that are not leading", () => {
    const p = "see this <system-reminder>x</system-reminder>";
    expect(stripLeadingReminders(p)).toBe(p);
  });
});

describe("isHarnessInjected", () => {
  test.each(injectedPrompts)("rejects harness envelope %p", (prompt) => {
    expect(isHarnessInjected(prompt)).toBe(true);
  });

  test.each(userPrompts)("accepts user text: $prompt", ({ prompt }) => {
    expect(isHarnessInjected(prompt)).toBe(false);
  });

  test("typed prompt behind a reminder is user input", () => {
    expect(isHarnessInjected(worktreeNotice + "This live llm test failed")).toBe(false);
  });

  test("reminder with nothing after it is harness-injected", () => {
    expect(isHarnessInjected(taskNotice)).toBe(true);
  });

  test("unclosed reminder is harness-injected", () => {
    expect(isHarnessInjected("<system-reminder>\ntruncated")).toBe(true);
  });

  test("other harness tags behind a reminder are still harness-injected", () => {
    expect(isHarnessInjected(worktreeNotice + "<task-notification>done</task-notification>")).toBe(true);
  });

  test("plain prompt is user input", () => {
    expect(isHarnessInjected("do the thing")).toBe(false);
  });

  const crossSession =
    '<cross-session-message from="uds:/tmp/cc-socks/1234.sock" from-name="reviewer-session" from-mode="prompting">\n' +
    "The user plans to merge PR #12 tonight.\n</cross-session-message>";

  test("cross-session message from another Claude Code session is harness-injected", () => {
    expect(isHarnessInjected(crossSession)).toBe(true);
  });

  test("cross-session message behind a reminder is still harness-injected", () => {
    expect(isHarnessInjected(worktreeNotice + crossSession)).toBe(true);
  });

  test("prompt that only mentions the tag is user input", () => {
    expect(isHarnessInjected("why does <cross-session-message> show up in my memory?")).toBe(false);
  });
});

describe("isSlashCommand", () => {
  test.each([
    ["/compact", true],
    [attributedReminder + "/honcho:status", true],
    [attributedReminder + "/tmp is missing", false],
    ["/honcho:config", true],
    ["/loop 5m /foo", true],
    [worktreeNotice + "/honcho:status", true],
    ["/Users/me/app/src/index.ts is failing", false],
    ["/foo.ts is broken", false],
    ["/tmp is missing", false],
    ["/etc", false],
    ["fix the /api route", false],
  ])("%p -> %p", (prompt, expected) => {
    expect(isSlashCommand(prompt)).toBe(expected);
  });

  test("matches either tag order", () => {
    expect(isSlashCommand("<command-message>honcho:status</command-message>\n<command-name>/honcho:status</command-name>")).toBe(true);
    expect(isSlashCommand("<command-name>/model</command-name>\n<command-message>model</command-message>")).toBe(true);
  });

  test("matches behind a leading reminder", () => {
    expect(isSlashCommand(worktreeNotice + "<command-name>/honcho</command-name>")).toBe(true);
  });

  test("does not match command output or typed text", () => {
    expect(isSlashCommand("<local-command-stdout>ok</local-command-stdout>")).toBe(false);
    expect(isSlashCommand("what does <command-name> mean?")).toBe(false);
  });
});
