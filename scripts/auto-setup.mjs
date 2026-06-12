#!/usr/bin/env node
/**
 * auto-setup.mjs — silent self-healer, runs on every SessionStart.
 *
 * IMPORTANT: This script MUST NEVER print to stdout or stderr.
 * Hook stdout is injected into Claude's context; any output would corrupt it.
 *
 * Flow:
 *   1. Read CLAUDE_PLUGIN_ROOT env — exit 0 silently if absent.
 *   2. ensurePluginConfig — create config.json with DOOM defaults if missing.
 *   3. ensureShim        — write/refresh the statusline.sh shim.
 *   4. ensureStatusline  — add statusLine to ~/.claude/settings.json if absent.
 *   5. If config.game === 'doom' → ensureDoomAssets (detached, background fetch).
 *
 * Total runtime target: <150ms when all assets are already present (no-op path).
 * Always exits 0.
 */

import {
  ensurePluginConfig,
  ensureShim,
  ensureStatusline,
  ensureDoomAssets,
  log,
} from '../lib/setup-core.mjs';

async function main() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    // Not running as a plugin — skip silently
    return;
  }

  // Step 1: Plugin config
  const configResult = ensurePluginConfig();
  log(`auto-setup: config=${configResult.created ? 'created' : 'present'}`);

  // Step 2: Statusline shim
  const shimResult = ensureShim(pluginRoot);
  log(`auto-setup: shim=${shimResult.status}`);

  // Step 3: Statusline entry in settings.json
  const statuslineResult = ensureStatusline();
  log(`auto-setup: statusLine=${statuslineResult.status}`);

  // Step 4: DOOM assets (detached background fetch if missing)
  if (configResult.config?.game === 'doom') {
    const assetsResult = ensureDoomAssets(pluginRoot, { detached: true });
    log(`auto-setup: doomAssets=${assetsResult.status}`);
  }
}

main().catch((err) => {
  // Never let an unhandled rejection surface as output
  try {
    log(`auto-setup: unexpected error: ${err?.message ?? String(err)}`);
  } catch {
    // If even logging fails, swallow it
  }
}).finally(() => {
  process.exit(0);
});
