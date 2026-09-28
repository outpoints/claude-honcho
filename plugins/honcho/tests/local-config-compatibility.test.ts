import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = mkdtempSync(join(tmpdir(), "honcho-compat-"));
const testHome = join(root, "home");
const project = join(root, "project");
const child = join(project, "src");
const plain = join(root, "plain");
const configUrl = new URL("../src/config.js", import.meta.url).href;
const cacheUrl = new URL("../src/cache.js", import.meta.url).href;
const env = { HOME: testHome, PATH: process.env.PATH!, USER: "fixture" };
for (const dir of [join(testHome, ".honcho"), join(project, ".honcho"), child, plain]) {
  mkdirSync(dir, { recursive: true });
}
const globalPath = join(testHome, ".honcho/config.json");
const localPath = join(project, ".honcho/config.json");
const globalText = JSON.stringify({ apiKey: "fixture-key", peerName: "fixture", workspace: "global", logging: false });
const localText = JSON.stringify({
  workspace: "local", sessionName: "pinned",
  hosts: { claude_code: { workspace: "host-local" } },
});
writeFileSync(globalPath, globalText);
writeFileSync(localPath, localText);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function evaluate(body: string): any {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", `const c = await import(${JSON.stringify(configUrl)});\n${body}`],
    env,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

test("repo-local workspace overrides by host, inherits credentials, and stays read-only", () => {
  const result = evaluate(`
    c.setLocalConfigContext(${JSON.stringify(child)});
    const cfg = c.loadConfig();
    c.saveConfig(cfg);
    c.setSessionForPath(${JSON.stringify(child)}, 'must-not-persist');
    console.log(JSON.stringify({ cfg, session: c.getSessionName(${JSON.stringify(child)}) }));
  `);
  expect(result.cfg).toMatchObject({
    apiKey: "fixture-key", workspace: "host-local",
  });
  expect(result.session).toBe("fixture-pinned");
  expect(readFileSync(globalPath, "utf8")).toBe(globalText);
  expect(readFileSync(localPath, "utf8")).toBe(localText);
});

test("no-overlay config is byte-identical and assistant cache stays workspace-isolated", () => {
  const result = evaluate(`
    const cache = await import(${JSON.stringify(cacheUrl)});
    const before = JSON.stringify(c.loadConfig());
    c.setLocalConfigContext(${JSON.stringify(plain)});
    const after = JSON.stringify(c.loadConfig());
    cache.setCachedClaudeContext('global-context');
    c.setLocalConfigContext(${JSON.stringify(child)});
    const localMiss = cache.getCachedClaudeContext();
    cache.setCachedClaudeContext('project-context');
    c.setLocalConfigContext(${JSON.stringify(plain)});
    console.log(JSON.stringify({ before, after, localMiss, global: cache.getCachedClaudeContext() }));
  `);
  expect(result.after).toBe(result.before);
  expect(result.localMiss).toBeNull();
  expect(result.global).toBe("global-context");
});

test("MCP stays in its repo-local workspace despite another window's cache", async () => {
  writeFileSync(join(testHome, ".honcho/cache.json"), JSON.stringify({ sessions: {
    [plain]: { name: "elsewhere", id: "elsewhere", updatedAt: new Date().toISOString() },
  } }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../mcp-server.ts", import.meta.url).pathname],
    cwd: child, env, stderr: "pipe",
  });
  const client = new Client({ name: "regression-test", version: "1" });
  try {
    await client.connect(transport);
    const config = await client.callTool({ name: "get_config", arguments: {} });
    expect(JSON.stringify(config)).toContain("host-local");
    const write = await client.callTool({ name: "set_config", arguments: { field: "workspace", value: "bad", confirm: true } });
    expect(JSON.stringify(write)).toContain("read-only");
    expect(readFileSync(globalPath, "utf8")).toBe(globalText);
  } finally {
    await client.close();
  }
});
