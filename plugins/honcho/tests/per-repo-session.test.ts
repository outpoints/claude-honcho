import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";

const testRoot = mkdtempSync(join(tmpdir(), "claude-honcho-config-"));
const testHome = join(testRoot, "home");
const configModuleUrl = new URL("../src/config.js", import.meta.url).href;

function writeGlobalConfig(sessionStrategy: "per-directory" | "per-repo" = "per-directory"): void {
  const configDir = join(testHome, ".honcho");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    apiKey: "test-key",
    peerName: "test-user",
    sessionPeerPrefix: false,
    sessionStrategy,
  }));
}

function writeLocalConfig(root: string, config: Record<string, unknown>): void {
  const configDir = join(root, ".honcho");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

function getSessionName(cwd: string, localConfig = false): string {
  const script = [
    `const config = await import(${JSON.stringify(configModuleUrl)});`,
    localConfig ? `config.setLocalConfigContext(${JSON.stringify(cwd)});` : "",
    `process.stdout.write(config.getSessionName(${JSON.stringify(cwd)}));`,
  ].filter(Boolean).join("\n");

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
  return new TextDecoder().decode(result.stdout);
}

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("per-repo uses the nearest Git root from a nested directory", () => {
  writeGlobalConfig("per-repo");
  const repo = join(testRoot, "My Project");
  const child = join(repo, "packages", "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(child, { recursive: true });

  expect(getSessionName(child)).toBe("my-project");
});

test("per-repo recognizes worktrees and submodules with a .git file", () => {
  writeGlobalConfig("per-repo");
  const repo = join(testRoot, "Feature Checkout");
  const child = join(repo, "src");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(repo, ".git"), "gitdir: ../parent/.git/worktrees/checkout\n");

  expect(getSessionName(child)).toBe("feature-checkout");
});

test("per-repo falls back to the current directory outside Git", () => {
  writeGlobalConfig("per-repo");
  const plain = mkdtempSync(join(testRoot, "plain-"));

  expect(getSessionName(plain)).toBe(basename(plain).toLowerCase());
});

test("repo-local per-repo selects a nested repository without splitSubmodules", () => {
  writeGlobalConfig();
  const project = join(testRoot, "Workspace");
  const nestedRepo = join(project, "worktrees", "Feature Checkout");
  const child = join(nestedRepo, "src");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(child, { recursive: true });
  writeFileSync(join(nestedRepo, ".git"), "gitdir: ../../.git/worktrees/checkout\n");
  writeLocalConfig(project, {
    workspace: "project-workspace",
    sessionStrategy: "per-repo",
  });
  expect(getSessionName(child, true)).toBe("feature-checkout");
});

test("default per-directory behavior remains scoped to the working directory", () => {
  writeGlobalConfig();
  const project = join(testRoot, "Default Project");
  const child = join(project, "packages", "app");
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(child, { recursive: true });

  expect(getSessionName(child)).toBe("app");
});
