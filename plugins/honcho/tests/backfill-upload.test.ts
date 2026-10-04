import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RequestLog = { path: string; authorization: string | null; body: any };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

/** Exercise the actual SDK and runner against isolated HTTP destinations. */
function endpoint() {
  const requests: RequestLog[] = [];
  let fail = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.json() as any;
      requests.push({ path, authorization: request.headers.get("authorization"), body });
      if (path.endsWith("/messages")) {
        if (fail) return Response.json({ detail: "fixture rejection" }, { status: 400 });
        return Response.json(body.messages.map((m: any, i: number) => ({ ...m, id: String(i) })));
      }
      return Response.json({ id: body.id, metadata: {}, configuration: {} });
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    url: server.url.origin, requests,
    messages: () => requests.filter((r) => r.path.endsWith("/messages")),
    rejectMessages: (value: boolean) => { fail = value; },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "honcho-upload-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const configDir = join(home, ".honcho");
  const transcripts = join(home, ".claude/projects/fixture");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  const global = endpoint();
  const local = endpoint();
  const configFile = join(configDir, "config.json");
  const globalConfig = JSON.stringify({
    apiKey: "fixture-global", endpoint: { baseUrl: global.url }, workspace: "shared",
    peerName: "global-user", hosts: { claude_code: { workspace: "shared", aiPeer: "global-ai" } }, sessionPeerPrefix: false,
  });
  writeFileSync(configFile, globalConfig);
  function project(parent: string, overrides?: Record<string, unknown>) {
    const cwd = join(root, parent, "twin");
    mkdirSync(cwd, { recursive: true });
    if (overrides) {
      mkdirSync(join(cwd, ".honcho"));
      writeFileSync(join(cwd, ".honcho/config.json"), JSON.stringify(overrides));
    }
    return cwd;
  }
  const plain = project("plain");
  const localConfig = {
    apiKey: "fixture-local", endpoint: { baseUrl: local.url },
    peerName: "local-user", aiPeer: "local-ai", observationMode: "directional",
  };
  const pinned = project("pinned", localConfig);
  function transcript(cwds = [plain, pinned]) {
    const path = join(transcripts, "conversation.jsonl");
    writeFileSync(path, cwds.flatMap((cwd) => [
      { type: "user", cwd, message: { content: "hello" }, timestamp: "2026-01-01T00:00:00Z" },
      { type: "assistant", cwd, message: { content: "hi back" }, timestamp: "2026-01-01T00:00:01Z" },
    ]).map((line) => JSON.stringify(line)).join("\n"));
    return path;
  }
  const stateFile = join(configDir, "backfill-state.json");
  async function run(args: string[] = []) {
    const child = Bun.spawn({
      cmd: [process.execPath, new URL("../src/skills/backfill-runner.ts", import.meta.url).pathname, ...args],
      cwd: pinned, // launch config must not affect other projects
      env: { HOME: home, PATH: process.env.PATH!, USER: "fixture" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(readFileSync(configFile, "utf8")).toBe(globalConfig);
    return stdout;
  }
  return { global, local, pinned, plain, localConfig, project, transcript, stateFile, run };
}

for (const override of [undefined, "forced"]) {
  test(`uploads use each repo's endpoint, credentials, peers and observation mode${override ? " with --workspace" : ""}`, async () => {
    const f = fixture();
    // A third project shares an endpoint, workspace and session but has its
    // own credentials and identities. Client reuse must preserve those too.
    const third = f.project("third", {
      ...f.localConfig, apiKey: "fixture-third", peerName: "third-user", aiPeer: "third-ai",
      observationMode: "unified",
    });
    f.transcript([f.plain, f.pinned, third]);
    expect(await f.run(override ? ["--workspace", override] : [])).toContain("Imported 6 message(s)");
    const workspace = override ?? "shared";
    expect(f.global.messages()).toHaveLength(1);
    expect(f.local.messages()).toHaveLength(2);
    for (const [server, identity] of [[f.global, "global"], [f.local, "local"], [f.local, "third"]] as const) {
      const requests = server.requests.filter((r) => r.authorization === `Bearer fixture-${identity}`);
      expect(requests.length).toBeGreaterThan(0);
      const upload = requests.find((r) => r.path.endsWith("/messages"))!;
      expect(upload.path).toBe(`/v3/workspaces/${workspace}/sessions/twin/messages`);
      expect(upload.body.messages.map((m: any) => m.peer_id)).toEqual([`${identity}-user`, `${identity}-ai`]);
      expect(upload.body.messages[0].created_at).toStartWith("2026-01-01T00:00:00");
      const peers = requests.find((r) => r.path.endsWith("/sessions/twin/peers"))!;
      expect(peers.body[`${identity}-ai`]?.observe_others).toBe(identity === "local" ? true : undefined);
    }
    const ledger = readFileSync(f.stateFile, "utf8");
    expect(ledger).not.toContain("fixture-local");
    expect(ledger).not.toContain("fixture-third");
    f.global.requests.length = f.local.requests.length = 0;
    // Credential rotation must not cause a second import.
    writeFileSync(join(f.pinned, ".honcho/config.json"), JSON.stringify({ ...f.localConfig, apiKey: "rotated" }));
    expect(await f.run(override ? ["--workspace", override] : [])).toContain("Nothing new to import");
    expect(f.global.requests).toHaveLength(0);
    expect(f.local.requests).toHaveLength(0);
  });
}

test("partial failures retry only the failed destination of a shared transcript", async () => {
  const f = fixture();
  f.transcript();
  f.local.rejectMessages(true);
  expect(await f.run()).toContain("1 session(s) failed");
  expect(f.global.messages()).toHaveLength(1);
  f.global.requests.length = f.local.requests.length = 0;
  f.local.rejectMessages(false);
  expect(await f.run()).toContain("Imported 2 message(s)");
  expect(f.global.requests).toHaveLength(0);
  expect(f.local.messages()).toHaveLength(1);
});

test("legacy workspace ledger skips correct global imports but cannot hide misrouted repo imports", async () => {
  const f = fixture();
  const transcript = f.transcript();
  writeFileSync(f.stateFile, JSON.stringify({ imported: { [`shared::${transcript}`]: statSync(transcript).mtimeMs } }));
  expect(await f.run()).toContain("Imported 2 message(s)");
  expect(f.global.requests).toHaveLength(0);
  expect(f.local.messages()).toHaveLength(1);
});

test("changing a repo's workspace imports to the new destination without replaying other projects", async () => {
  const f = fixture();
  f.transcript();
  await f.run();
  f.global.requests.length = f.local.requests.length = 0;
  writeFileSync(join(f.pinned, ".honcho/config.json"), JSON.stringify({ ...f.localConfig, workspace: "moved" }));
  expect(await f.run()).toContain("Imported 2 message(s)");
  expect(f.global.requests).toHaveLength(0);
  expect(f.local.messages()[0].path).toContain("/workspaces/moved/");
});
