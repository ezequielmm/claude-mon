#!/usr/bin/env node
/**
 * fetch-xterm.mjs — vendor @xterm/headless (MIT) into vendor/xterm/
 *
 * The universal compositor (scripts/doomscreen.mjs) needs a headless terminal
 * emulator to maintain Claude Code's virtual screen. Same zero-runtime-deps
 * policy as fetch-doom: the npm tarball is downloaded once, extracted into
 * vendor/ (gitignored), and loaded with createRequire at runtime.
 *
 * Idempotent: skips when the vendored copy already validates.
 * Run: node scripts/fetch-xterm.mjs
 */

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR_XTERM = path.join(ROOT, 'vendor', 'xterm');

// ── Helpers (same shape as fetch-doom) ────────────────────────────────────────

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * GET a URL, following redirects. Returns Buffer.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(fetchBuffer(res.headers.location));
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * GET a URL as a parsed JSON object.
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function fetchJson(url) {
  const buf = await fetchBuffer(url);
  return JSON.parse(buf.toString('utf8'));
}

/** Format bytes as MB string. */
function fmt(bytes) {
  return (bytes / 1_048_576).toFixed(2) + ' MB';
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * True when vendor/xterm loads and a Terminal can round-trip a character.
 * This is the real contract the compositor depends on — not just file sizes.
 * @returns {Promise<boolean>}
 */
export async function xtermVendorValid() {
  try {
    const require = createRequire(import.meta.url);
    const { Terminal } = require(VENDOR_XTERM);
    const term = new Terminal({ cols: 10, rows: 4, allowProposedApi: true });
    await new Promise((resolve) => term.write('h', resolve));
    const cell = term.buffer.active.getLine(0)?.getCell(0);
    const ok = cell?.getChars() === 'h';
    term.dispose();
    return ok;
  } catch {
    return false;
  }
}

// ── Fetch + extract ───────────────────────────────────────────────────────────

const PKG = '@xterm/headless';
const PREFERRED_VERSION = '5.5.0';

async function fetchXterm() {
  if (await xtermVendorValid()) {
    process.stdout.write('  vendor/xterm — already valid, skipping\n');
    return;
  }

  process.stdout.write(`  Querying npm registry for ${PKG}…\n`);
  const registry = await fetchJson(`https://registry.npmjs.org/${PKG.replace('/', '%2f')}`);
  const chosenVersion = registry.versions[PREFERRED_VERSION]
    ? PREFERRED_VERSION
    : registry['dist-tags'].latest;
  const tarballUrl = registry.versions[chosenVersion].dist.tarball;
  process.stdout.write(`  Using version ${chosenVersion}: ${tarballUrl}\n`);

  const tarball = await fetchBuffer(tarballUrl);
  process.stdout.write(`  Downloaded ${fmt(tarball.length)}\n`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mon-xterm-'));
  const tgzPath = path.join(tmpDir, 'xterm-headless.tgz');
  fs.writeFileSync(tgzPath, tarball);

  // Fresh extraction directory; whole package is extracted (it is small and
  // its package.json "main" drives module resolution at load time).
  const extractDir = path.join(tmpDir, 'extract');
  mkdirp(extractDir);

  // On Windows, use the inbox bsdtar (System32\tar.exe) which handles
  // drive-letter paths natively. GNU tar (MSYS) misreads "C:" as a host.
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tarBin, [
    '-xzf', tgzPath,
    '-C', extractDir,
    '--strip-components=1',       // strip "package/"
  ]);

  // Replace vendor/xterm atomically-ish: copy tree, then validate.
  fs.rmSync(VENDOR_XTERM, { recursive: true, force: true });
  mkdirp(path.dirname(VENDOR_XTERM));
  // cpSync handles cross-device (tmp on C:, vendor on D:) unlike rename.
  fs.cpSync(extractDir, VENDOR_XTERM, { recursive: true });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  if (!(await xtermVendorValid())) {
    throw new Error('vendor/xterm failed validation after extraction');
  }

  process.stdout.write(`  vendor/xterm — OK (${chosenVersion})\n`);
}

// ── Main (skipped when imported for xtermVendorValid) ────────────────────────

const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  process.stdout.write('claude-mon fetch-xterm\n\n');
  fetchXterm().catch((err) => {
    process.stderr.write(`fetch-xterm error: ${err.message}\n`);
    process.exit(1);
  });
}
