#!/usr/bin/env bun
import { initHook } from "../src/config.js";
import { handlePreToolHoncho } from "../src/hooks/pre-tool-honcho.js";

await initHook();
await handlePreToolHoncho();
