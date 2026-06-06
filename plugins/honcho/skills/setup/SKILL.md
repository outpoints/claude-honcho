---
description: First-time Honcho configuration -- set API key, validate connection, create config
user-invocable: true
---

# Honcho Setup

Walk the user through first-time Honcho configuration so persistent memory works in Claude Code.

## Steps

### 1. Check current state

Check if `HONCHO_API_KEY` is set as an environment variable OR if `~/.honcho/config.json` already has an apiKey:

```bash
bun -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.honcho', 'config.json');
const envKey = process.env.HONCHO_API_KEY;
let configKey = '';
try { configKey = JSON.parse(fs.readFileSync(configPath, 'utf-8')).apiKey || ''; } catch {}
console.log(envKey || configKey ? 'set' : 'not set');
"
```

If the output is `set`, skip to step 3 (validation). Otherwise continue.

### 2. Direct user to set their API key

Tell the user to get a free API key at https://app.honcho.dev, then set it as an environment variable.

Detect the platform and give the appropriate command:

**If Windows** (check with `bun -e "console.log(process.platform)"` if unsure):

> Set your API key in PowerShell:
> ```powershell
> setx HONCHO_API_KEY "your-key-here"
> ```
> Then restart Claude Code and run `/honcho:setup` again.

**If macOS / Linux:**

> Add to your shell config (`~/.zshrc` or `~/.bashrc`):
> ```
> export HONCHO_API_KEY="your-key-here"
> ```
> Then restart Claude Code and run `/honcho:setup` again.

IMPORTANT: Do NOT ask the user to paste their API key into the chat. Keys must be set via environment variable outside of Claude Code.

Stop here and wait for the user to come back after restarting. Do not proceed to validation until the user runs `/honcho:setup` again.

### 3. Validate the API key

Run the setup runner to validate the connection:

```bash
bun run "${CLAUDE_PLUGIN_ROOT}/src/skills/setup-runner.ts"
```

If `CLAUDE_PLUGIN_ROOT` is not set, resolve the path:

```bash
bun -e "const h=require('os').homedir();const p=require('path');console.log(p.join(h,'.claude','plugins','cache','honcho','honcho'))"
```

Then find the version directory inside that path and run the setup runner from there.

If it succeeds, the key is valid and the full config file has been created. The
runner also installs the memory statusLine: it copies the renderer to
`~/.honcho/honcho-statusline.sh` and registers it in `~/.claude/settings.json`
(only when no `statusLine` is already configured — an existing one is left
untouched and the path is printed for manual use). Toggle visibility later with
the `statusline` key in `~/.honcho/config.json`: `on` (default) or `off`.

If it fails, help the user troubleshoot:
- Authentication error: key may be invalid, get a new one from https://app.honcho.dev
- Network error: check internet connection

### 4. Confirm setup

Tell the user that Honcho is configured and memory will be active on their next session. Suggest they restart Claude Code to see the memory context load.
