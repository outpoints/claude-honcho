/**
 * Backfill runner — imports local Claude Code session transcripts into Honcho.
 *
 * Scans ~/.claude/projects/<dir>/<uuid>.jsonl within a recency window, rebuilds
 * each conversation, names sessions with the same rules as the live hooks, and
 * uploads with the original message timestamps.
 *
 * Usage:
 *   bun run backfill-runner.ts [--days N] [--workspace NAME] [--dry-run] [--yes]
 *   --days N          transcripts modified in the last N days (default 30)
 *   --workspace NAME  target workspace (default: configured workspace)
 *   --dry-run         print the plan without uploading
 *   --yes             reserved; non-interactive, uploads unless --dry-run
 */
import { Honcho } from "@honcho-ai/sdk";
import {
  loadConfig,
  getHonchoClientOptions,
  getHonchoBaseUrl,
  getObservationMode,
  resolveSessionName,
  findLocalConfigDir,
  setLocalConfigContext,
  getLocalConfigDir,
  setLocalConfigDir,
  getConfigDir,
  setDetectedHost,
  type HonchoCLAUDEConfig,
  type SessionStrategy,
} from "../config.js";
import { addMessagesBatched, chunkContent } from "../cache.js";
import { parseTranscriptForBackfill, findTranscripts, type ParsedMessage } from "./transcript-parse.js";
import * as s from "../styles.js";
import { join, basename } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "node:crypto";

interface Args {
  days: number;
  workspace?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 30, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes") { /* reserved, non-interactive */ }
    else if (a === "--days") args.days = parseInt(argv[++i] ?? "30", 10) || 30;
    else if (a.startsWith("--days=")) args.days = parseInt(a.slice("--days=".length), 10) || 30;
    else if (a === "--workspace") args.workspace = argv[++i];
    else if (a.startsWith("--workspace=")) args.workspace = a.slice("--workspace=".length);
  }
  return args;
}

const STATE_FILE = join(getConfigDir(), "backfill-state.json");

/** Idempotency ledger; v2 keys include the destination and session identity. */
interface BackfillState {
  imported: Record<string, number>;
}

function loadState(): BackfillState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { imported: {} };
  }
}

function saveState(state: BackfillState): void {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

interface SessionGroup {
  name: string;
  workspace: string;
  config: HonchoCLAUDEConfig;
  ledgerScope: string;
  acceptsLegacyLedger: boolean;
  messages: Array<ParsedMessage & { sourceTranscript: string; transcriptPath: string; mtimeMs: number }>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Credentials affect client reuse, but rotating a key must not re-import history. */
function destination(config: HonchoCLAUDEConfig): unknown[] {
  return [getHonchoBaseUrl(config), config.workspace, config.peerName, config.aiPeer, getObservationMode(config)];
}

/** Effective config for one transcript's cwd. */
interface CwdConfig {
  config: HonchoCLAUDEConfig;
  localDir: string | null;
}

/**
 * Resolve config per working directory, honoring each project's repo-local
 * `.honcho/config.json`.
 *
 * A backfill run walks transcripts from *every* project on the machine, so the
 * ambient local-config context (the directory the command was launched from)
 * must not be applied globally — that would import every project's history into
 * whatever workspace the current repo happens to declare. Each cwd is resolved
 * against its own nearest `.honcho/`, so a repo pinned to its own workspace
 * backfills into that workspace and everything else keeps the global one.
 *
 * Memoized on the resolved `.honcho` dir: one config read per project rather
 * than one per message.
 */
function makeCwdConfigResolver(globalConfig: HonchoCLAUDEConfig): (cwd: string) => CwdConfig {
  const byLocalDir = new Map<string, CwdConfig>();
  return (cwd: string): CwdConfig => {
    const localDir = findLocalConfigDir(cwd);
    const key = localDir ?? "";
    const memo = byLocalDir.get(key);
    if (memo) return memo;

    const previous = getLocalConfigDir();
    try {
      setLocalConfigContext(cwd);
      const resolved: CwdConfig = { config: loadConfig() ?? globalConfig, localDir };
      byLocalDir.set(key, resolved);
      return resolved;
    } finally {
      setLocalConfigDir(previous);
    }
  };
}

/** Group all messages into Honcho sessions, naming each via the strategy that
 *  applies to that message's cwd and the per-message cwd/branch (+ the transcript
 *  uuid for chat-instance). Keep the complete destination config through upload. */
export function groupIntoSessions(
  transcripts: Array<{ path: string; mtimeMs: number }>,
  globalConfig: HonchoCLAUDEConfig,
  sessionOverrides: Record<string, string> = {},
  workspaceOverride?: string
): {
  groups: Map<string, SessionGroup>;
  parsed: number;
  empty: number;
} {
  const groups = new Map<string, SessionGroup>();
  const configFor = makeCwdConfigResolver(globalConfig);
  let parsed = 0;
  let empty = 0;

  for (const { path, mtimeMs } of transcripts) {
    const { messages, cwd: tCwd, gitBranch: tBranch, sessionId } = parseTranscriptForBackfill(path);
    if (messages.length === 0) {
      empty++;
      continue;
    }
    parsed++;
    const source = basename(path);
    for (const msg of messages) {
      const cwd = msg.cwd || tCwd;
      if (!cwd) continue; // can't name a session without a directory

      const { config: resolvedConfig, localDir } = configFor(cwd);
      const config = workspaceOverride ? { ...resolvedConfig, workspace: workspaceOverride } : resolvedConfig;
      const strategy: SessionStrategy = config.sessionStrategy ?? "per-directory";
      const workspace = workspaceOverride ?? config.workspace;

      // Honor manual per-directory overrides exactly as getSessionName() does,
      // so backfilled sessions share names with future live sessions. Repo-local
      // projects ignore the global override map, same as the live path.
      const name =
        !localDir && strategy === "per-directory" && sessionOverrides[cwd]
          ? sessionOverrides[cwd]
          : resolveSessionName(cwd, config, {
              branch: msg.gitBranch || tBranch,
              instanceId: sessionId,
              localDir,
            });

      // Identical workspace/session names may belong to different servers or
      // peers. Never share credentials or observation settings between groups.
      const target = destination(config);
      const key = digest([target, name, config.apiKey]);
      let group = groups.get(key);
      if (!group) {
        group = {
          name, workspace, config,
          ledgerScope: `v2:${digest([target, name])}`,
          // Old imports always used the global endpoint and peers. Only trust
          // their workspace-only ledger when that routing was actually correct.
          acceptsLegacyLedger: digest(target) === digest(destination({ ...globalConfig, workspace })),
          messages: [],
        };
        groups.set(key, group);
      }
      group.messages.push({ ...msg, sourceTranscript: source, transcriptPath: path, mtimeMs });
    }
  }
  return { groups, parsed, empty };
}

export async function run(): Promise<void> {
  setDetectedHost("claude_code");
  const args = parseArgs(process.argv.slice(2));

  console.log("");
  console.log(s.header("honcho backfill"));
  console.log("");

  const config = loadConfig();
  if (!config) {
    console.log(s.warn("No Honcho config found — run /honcho:setup first."));
    process.exit(1);
  }

  const strategy: SessionStrategy = config.sessionStrategy ?? "per-directory";
  // Where transcripts land when no repo-local config claims them.
  const defaultWorkspace = args.workspace ?? config.workspace;

  console.log(
    `  ${s.label("Workspace")}:   ${
      args.workspace
        ? `${args.workspace}${s.dim("  (override — all transcripts)")}`
        : `${config.workspace}${s.dim("  (default — repo-local configs route their own)")}`
    }`
  );
  console.log(`  ${s.label("Strategy")}:    ${strategy}${s.dim("  (default)")}`);
  console.log(`  ${s.label("Window")}:      last ${args.days} days`);
  console.log(`  ${s.label("User peer")}:   ${config.peerName}`);
  console.log(`  ${s.label("AI peer")}:     ${config.aiPeer}`);
  console.log("");

  // Resolve destinations before consulting the ledger: one transcript can
  // span several projects, endpoints, or sessions, each with its own outcome.
  const allTranscripts = findTranscripts(args.days);
  const state = loadState();
  const { groups, parsed, empty } = groupIntoSessions(
    allTranscripts, config, config.sessions ?? {}, args.workspace
  );
  for (const [key, group] of groups) {
    group.messages = group.messages.filter((m) =>
      state.imported[`${group.ledgerScope}::${m.transcriptPath}`] !== m.mtimeMs &&
      !(group.acceptsLegacyLedger && state.imported[`${group.workspace}::${m.transcriptPath}`] === m.mtimeMs)
    );
    if (group.messages.length === 0) groups.delete(key);
  }

  console.log(s.section("Scanning transcripts"));
  console.log(s.listItem(`${allTranscripts.length} transcript(s) in window`));
  if (groups.size === 0) {
    console.log("");
    console.log(s.success("Nothing new to import."));
    process.exit(0);
  }

  const totalMessages = [...groups.values()].reduce((n, g) => n + g.messages.length, 0);

  console.log(s.listItem(`${parsed} transcript(s) with content${empty ? s.dim(` (${empty} empty, skipped)`) : ""}`));
  console.log(s.listItem(`${groups.size} session(s), ${totalMessages} message(s) to upload`));
  console.log("");

  // Show a preview of session names + counts (cap the printed list)
  console.log(s.section("Sessions"));
  const sorted = [...groups.values()].sort((a, b) => b.messages.length - a.messages.length);
  const multiWorkspace = new Set(sorted.map((g) => g.workspace)).size > 1;
  for (const g of sorted.slice(0, 15)) {
    const where = multiWorkspace ? s.dim(`  → ${g.workspace}`) : "";
    console.log(s.listItem(`${g.name} ${s.dim(`(${g.messages.length} msg)`)}${where}`));
  }
  if (sorted.length > 15) console.log(s.listItem(s.dim(`… and ${sorted.length - 15} more`)));
  console.log("");

  if (args.dryRun) {
    console.log(s.success("Dry run — no messages uploaded."));
    process.exit(0);
  }

  // Reuse clients only for identical connection settings (including credentials).
  const clients = new Map<string, Honcho>();
  const clientFor = (targetConfig: HonchoCLAUDEConfig): Honcho => {
    const opts = getHonchoClientOptions(targetConfig);
    const key = digest(opts);
    let client = clients.get(key);
    if (!client) {
      // Backfilling large histories: give the network more headroom than the hooks.
      opts.timeout = 60_000;
      opts.maxRetries = 3;
      client = new Honcho(opts);
      clients.set(key, client);
    }
    return client;
  };

  const workspaceList = [...new Set(sorted.map((g) => g.workspace))];
  if (workspaceList.length === 0) workspaceList.push(defaultWorkspace);
  console.log(s.section(`Uploading to ${workspaceList.join(", ")}`));

  let uploadedSessions = 0;
  let uploadedMessages = 0;
  const errors: string[] = [];

  for (const g of sorted) {
    const honcho = clientFor(g.config);
    try {
      const [session, userPeer, aiPeer] = await Promise.all([
        honcho.session(g.name),
        honcho.peer(g.config.peerName),
        honcho.peer(g.config.aiPeer),
      ]);

      const peers: Parameters<typeof session.addPeers>[0] =
        getObservationMode(g.config) === "directional" ? [userPeer, [aiPeer, { observeOthers: true }]] : [userPeer, aiPeer];
      await session.addPeers(peers);

      const fallbackTs = new Date().toISOString();
      const messages = g.messages.flatMap((m) => {
        const peer = m.role === "user" ? userPeer : aiPeer;
        return chunkContent(m.content).map((chunk) =>
          peer.message(chunk, {
            createdAt: m.timestamp || fallbackTs,
            metadata: {
              backfill: true,
              source_transcript: m.sourceTranscript,
              session_affinity: g.name,
              type: m.role === "assistant"
                ? (m.isResponse ? "assistant_response" : "assistant_intermediate")
                : undefined,
            },
          })
        );
      });

      await addMessagesBatched(session, messages);
      for (const m of g.messages) {
        state.imported[`${g.ledgerScope}::${m.transcriptPath}`] = m.mtimeMs;
      }
      saveState(state);
      uploadedSessions++;
      uploadedMessages += g.messages.length;
      console.log(s.listItem(s.success(`${g.name} ${s.dim(`(${g.messages.length} msg)`)}`)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${g.name}: ${msg}`);
      console.log(s.listItem(s.warn(`${g.name} — ${msg}`)));
    }
  }

  console.log("");
  console.log(
    s.success(
      `Imported ${uploadedMessages} message(s) across ${uploadedSessions} session(s) into ${workspaceList.join(", ")}.`
    )
  );
  if (errors.length > 0) {
    console.log(s.warn(`${errors.length} session(s) failed — re-run to retry (not marked complete).`));
  }
  console.log("");
}

/** Entry point: runs the backfill and reports a failure as exit 1. */
export async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.log(s.error(`Backfill failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}
