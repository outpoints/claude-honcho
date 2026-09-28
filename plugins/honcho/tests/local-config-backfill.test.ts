import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Backfill walks transcripts from every project on the machine in a single run,
// so it must resolve each transcript's cwd against that project's own
// `.honcho/config.json` — not against whatever directory the command was
// launched from. These tests pin that routing.

const testRoot = mkdtempSync(join(tmpdir(), "claude-honcho-backfill-"));
const testHome = join(testRoot, "home");
const backfillModuleUrl = new URL("../src/skills/backfill.js", import.meta.url).href;

function writeGlobalConfig(): void {
  const configDir = join(testHome, ".honcho");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      apiKey: "test-key",
      peerName: "test-user",
      sessionPeerPrefix: false,
      sessionStrategy: "per-directory",
      workspace: "global-workspace",
    })
  );
}

/** A project dir with a git root and an optional repo-local honcho config. */
function makeProject(name: string, localConfig?: Record<string, unknown>): string {
  const root = join(testRoot, name);
  mkdirSync(join(root, ".git"), { recursive: true });
  if (localConfig) {
    const configDir = join(root, ".honcho");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(localConfig));
  }
  return root;
}

/** Minimal transcript: one user turn, one assistant turn, recorded at `cwd`. */
function writeTranscript(name: string, cwd: string, sessionId: string): string {
  const path = join(testRoot, `${name}.jsonl`);
  const lines = [
    { type: "user", sessionId, cwd, gitBranch: "main", timestamp: "2026-01-01T00:00:00Z", message: { content: "hello" } },
    {
      type: "assistant",
      sessionId,
      cwd,
      gitBranch: "main",
      timestamp: "2026-01-01T00:00:01Z",
      message: { content: [{ type: "text", text: "hi back" }] },
    },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"));
  return path;
}

/** Run groupIntoSessions in a subprocess with HOME pointed at the temp global config. */
function group(
  transcripts: string[],
  opts: { launchedFrom?: string; workspaceOverride?: string } = {}
): Array<{ name: string; workspace: string; messages: number }> {
  const script = [
    `const backfill = await import(${JSON.stringify(backfillModuleUrl)});`,
    `const config = await import(${JSON.stringify(new URL("../src/config.js", import.meta.url).href)});`,
    // Mimic a runner launched from a specific directory: the ambient context
    // must NOT leak onto transcripts belonging to other projects.
    opts.launchedFrom ? `config.setLocalConfigContext(${JSON.stringify(opts.launchedFrom)});` : "",
    `const global = config.loadConfig();`,
    `const { groups } = backfill.groupIntoSessions(`,
    `  ${JSON.stringify(transcripts.map((p) => ({ path: p, mtimeMs: 1 })))},`,
    `  global,`,
    `  {},`,
    `  ${opts.workspaceOverride ? JSON.stringify(opts.workspaceOverride) : "undefined"}`,
    `);`,
    `process.stdout.write(JSON.stringify([...groups.values()].map((g) => ({`,
    `  name: g.name, workspace: g.workspace, messages: g.messages.length,`,
    `}))));`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    env: {
      HOME: testHome,
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      USER: "test-user",
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("a project's repo-local workspace wins over the global one", () => {
  writeGlobalConfig();
  const pinned = makeProject("Pinned Project", {
    workspace: "project-workspace",
    sessionStrategy: "per-repo",
    sessionPeerPrefix: false,
  });
  const transcript = writeTranscript("pinned", join(pinned, "src"), "uuid-pinned");

  const groups = group([transcript]);
  expect(groups).toHaveLength(1);
  expect(groups[0].workspace).toBe("project-workspace");
  // per-repo anchors to the git root, not the nested cwd it was recorded in.
  expect(groups[0].name).toBe("pinned-project");
});

test("projects without a repo-local config keep the global workspace", () => {
  writeGlobalConfig();
  const plain = makeProject("Plain Project");
  const transcript = writeTranscript("plain", plain, "uuid-plain");

  const groups = group([transcript]);
  expect(groups).toHaveLength(1);
  expect(groups[0].workspace).toBe("global-workspace");
  expect(groups[0].name).toBe("plain-project");
});

test("the launch directory's config does not leak onto other projects", () => {
  writeGlobalConfig();
  const pinned = makeProject("Launch Project", {
    workspace: "launch-workspace",
    sessionStrategy: "per-repo",
    sessionPeerPrefix: false,
  });
  const other = makeProject("Other Project");
  const transcripts = [
    writeTranscript("launch", pinned, "uuid-launch"),
    writeTranscript("other", other, "uuid-other"),
  ];

  // Launched from inside the pinned project — the regression this guards against
  // is every transcript inheriting `launch-workspace`.
  const groups = group(transcripts, { launchedFrom: pinned }).sort((a, b) =>
    a.workspace.localeCompare(b.workspace)
  );

  expect(groups.map((g) => g.workspace)).toEqual(["global-workspace", "launch-workspace"]);
});

test("--workspace overrides every project's routing", () => {
  writeGlobalConfig();
  const pinned = makeProject("Override Project", {
    workspace: "ignored-workspace",
    sessionStrategy: "per-repo",
    sessionPeerPrefix: false,
  });
  const other = makeProject("Override Other");
  const transcripts = [
    writeTranscript("override-a", pinned, "uuid-a"),
    writeTranscript("override-b", other, "uuid-b"),
  ];

  const groups = group(transcripts, { workspaceOverride: "forced" });
  expect(new Set(groups.map((g) => g.workspace))).toEqual(new Set(["forced"]));
});

test("identical session names in different workspaces stay separate", () => {
  writeGlobalConfig();
  // Same basename in both projects → same derived session name, different workspace.
  const a = makeProject(join("a", "Twin"), {
    workspace: "workspace-a",
    sessionStrategy: "per-repo",
    sessionPeerPrefix: false,
  });
  const b = makeProject(join("b", "Twin"));
  const transcripts = [
    writeTranscript("twin-a", a, "uuid-twin-a"),
    writeTranscript("twin-b", b, "uuid-twin-b"),
  ];

  const groups = group(transcripts);
  expect(groups).toHaveLength(2);
  expect(new Set(groups.map((g) => g.name))).toEqual(new Set(["twin"]));
  expect(new Set(groups.map((g) => g.workspace))).toEqual(new Set(["workspace-a", "global-workspace"]));
});
