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
  getObservationMode,
  resolveSessionName,
  findLocalConfigDir,
  setLocalConfigContext,
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

/** Idempotency ledger: which (workspace, transcript@mtime) pairs already imported. */
interface BackfillState {
  imported: Record<string, number>; // key `${workspace}::${transcriptPath}` -> mtimeMs
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
  messages: Array<ParsedMessage & { sourceTranscript: string }>;
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

    setLocalConfigContext(cwd);
    const resolved: CwdConfig = { config: loadConfig() ?? globalConfig, localDir };
    byLocalDir.set(key, resolved);
    return resolved;
  };
}

/** Group all messages into Honcho sessions, naming each via the strategy that
 *  applies to that message's cwd and the per-message cwd/branch (+ the transcript
 *  uuid for chat-instance). Sessions carry the workspace they belong to. */
export function groupIntoSessions(
  transcripts: Array<{ path: string; mtimeMs: number }>,
  globalConfig: HonchoCLAUDEConfig,
  sessionOverrides: Record<string, string> = {},
  workspaceOverride?: string
): {
  groups: Map<string, SessionGroup>;
  parsed: number;
  empty: number;
  transcriptWorkspaces: Map<string, Set<string>>;
} {
  const groups = new Map<string, SessionGroup>();
  const transcriptWorkspaces = new Map<string, Set<string>>();
  const configFor = makeCwdConfigResolver(globalConfig);
  let parsed = 0;
  let empty = 0;

  for (const { path } of transcripts) {
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

      const { config, localDir } = configFor(cwd);
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

      // Same session name can exist in two workspaces — key on both.
      const key = `${workspace}::${name}`;
      let group = groups.get(key);
      if (!group) {
        group = { name, workspace, messages: [] };
        groups.set(key, group);
      }
      group.messages.push({ ...msg, sourceTranscript: source });

      let seen = transcriptWorkspaces.get(path);
      if (!seen) {
        seen = new Set<string>();
        transcriptWorkspaces.set(path, seen);
      }
      seen.add(workspace);
    }
  }
  return { groups, parsed, empty, transcriptWorkspaces };
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

  // Discover + filter transcripts.
  // A transcript's workspace isn't known until its cwd is parsed, so without an
  // explicit --workspace the ledger is consulted across all workspaces: a
  // transcript already imported at this mtime is done, wherever it landed.
  const allTranscripts = findTranscripts(args.days);
  const state = loadState();
  const importedMtimeByPath = new Map<string, number>();
  for (const [key, mtimeMs] of Object.entries(state.imported)) {
    const sep = key.indexOf("::");
    if (sep === -1) continue;
    importedMtimeByPath.set(key.slice(sep + 2), mtimeMs);
  }
  const isImported = (t: { path: string; mtimeMs: number }): boolean =>
    args.workspace
      ? state.imported[`${args.workspace}::${t.path}`] === t.mtimeMs
      : importedMtimeByPath.get(t.path) === t.mtimeMs;
  const already = allTranscripts.filter(isImported);
  const todo = allTranscripts.filter((t) => !isImported(t));

  console.log(s.section("Scanning transcripts"));
  console.log(s.listItem(`${allTranscripts.length} transcript(s) in window`));
  if (already.length > 0) {
    console.log(s.listItem(s.dim(`${already.length} already imported — skipping`)));
  }
  if (todo.length === 0) {
    console.log("");
    console.log(s.success("Nothing new to import."));
    process.exit(0);
  }

  // Group into sessions
  const { groups, parsed, empty, transcriptWorkspaces } = groupIntoSessions(
    todo,
    config,
    config.sessions ?? {},
    args.workspace
  );
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

  // Upload. One client per target workspace — a run can span several when
  // projects carry their own repo-local config.
  const clients = new Map<string, Honcho>();
  const clientFor = (workspace: string): Honcho => {
    let client = clients.get(workspace);
    if (!client) {
      const opts = getHonchoClientOptions(config);
      opts.workspaceId = workspace;
      // Backfilling large histories: give the network more headroom than the hooks.
      opts.timeout = 60_000;
      opts.maxRetries = 3;
      client = new Honcho(opts);
      clients.set(workspace, client);
    }
    return client;
  };
  const observationMode = getObservationMode(config);

  const workspaceList = [...new Set(sorted.map((g) => g.workspace))];
  if (workspaceList.length === 0) workspaceList.push(defaultWorkspace);
  console.log(s.section(`Uploading to ${workspaceList.join(", ")}`));

  let uploadedSessions = 0;
  let uploadedMessages = 0;
  const errors: string[] = [];
  const failedWorkspaces = new Set<string>();

  for (const g of sorted) {
    const honcho = clientFor(g.workspace);
    try {
      const [session, userPeer, aiPeer] = await Promise.all([
        honcho.session(g.name),
        honcho.peer(config.peerName),
        honcho.peer(config.aiPeer),
      ]);

      const peers: Parameters<typeof session.addPeers>[0] =
        observationMode === "directional" ? [userPeer, [aiPeer, { observeOthers: true }]] : [userPeer, aiPeer];
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
      uploadedSessions++;
      uploadedMessages += g.messages.length;
      console.log(s.listItem(s.success(`${g.name} ${s.dim(`(${g.messages.length} msg)`)}`)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${g.name}: ${msg}`);
      failedWorkspaces.add(g.workspace);
      console.log(s.listItem(s.warn(`${g.name} — ${msg}`)));
    }
  }

  // Mark a transcript imported only for workspaces that took it cleanly; a
  // workspace with any failure stays unmarked so a re-run retries just that one.
  for (const t of todo) {
    // Transcripts that parsed empty produced no group — mark them so they are
    // not re-scanned every run.
    const targets = transcriptWorkspaces.get(t.path) ?? new Set([defaultWorkspace]);
    for (const workspace of targets) {
      if (failedWorkspaces.has(workspace)) continue;
      state.imported[`${workspace}::${t.path}`] = t.mtimeMs;
    }
  }
  saveState(state);

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
