#!/usr/bin/env node
/**
 * fetch-doom.mjs — download DOOM WASM assets into vendor/doom/
 *
 * Fetches:
 *   vendor/doom/doom.js    — Emscripten CJS glue (from @muhammedaksam/opentui-doom)
 *   vendor/doom/doom.wasm  — compiled doomgeneric
 *   vendor/doom/doom1.wad  — shareware IWAD (~4.2 MB, redistributable)
 *
 * Idempotent: skips files that already exist and pass validation.
 * Run: node scripts/fetch-doom.mjs
 */

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR_DOOM = path.join(ROOT, 'vendor', 'doom');

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Atomically write a Buffer to disk (tmp + rename).
 * @param {string} dest
 * @param {Buffer} buf
 */
function writeAtomic(dest, buf) {
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

/** Format bytes as MB string. */
function fmt(bytes) {
  return (bytes / 1_048_576).toFixed(2) + ' MB';
}

// ── Validation helpers ────────────────────────────────────────────────────────

function isValidDoomJs(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 10_000) return false;
    // Must be readable text with typical Emscripten patterns
    const head = fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, 4096);
    return head.includes('Module') || head.includes('doomgeneric') || head.includes('MODULARIZE');
  } catch {
    return false;
  }
}

function isValidDoomWasm(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 100_000) return false;
    // WebAssembly magic: 0x00 0x61 0x73 0x6D
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d;
  } catch {
    return false;
  }
}

function isValidWad(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 3_500_000) return false;
    const buf = Buffer.alloc(4);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    // IWAD magic: "IWAD"
    return buf.toString('ascii') === 'IWAD';
  } catch {
    return false;
  }
}

// ── npm tarball extraction ────────────────────────────────────────────────────

/**
 * Download the opentui-doom tarball and extract doom/build/doom.js and
 * doom/build/doom.wasm into VENDOR_DOOM.
 *
 * Shells out to system `tar` for extraction (no npm runtime deps).
 */
async function fetchOpentUiDoom() {
  const doom_js   = path.join(VENDOR_DOOM, 'doom.js');
  const doom_wasm = path.join(VENDOR_DOOM, 'doom.wasm');

  const jsOk   = isValidDoomJs(doom_js);
  const wasmOk = isValidDoomWasm(doom_wasm);

  if (jsOk && wasmOk) {
    const jsSize   = fs.statSync(doom_js).size;
    const wasmSize = fs.statSync(doom_wasm).size;
    process.stdout.write(`  doom.js   — already valid (${fmt(jsSize)}), skipping\n`);
    process.stdout.write(`  doom.wasm — already valid (${fmt(wasmSize)}), skipping\n`);
    return;
  }

  // Resolve tarball URL from registry
  process.stdout.write('  Querying npm registry for @muhammedaksam/opentui-doom…\n');
  const registry = await fetchJson('https://registry.npmjs.org/@muhammedaksam/opentui-doom');
  const preferredVersion = '0.3.11';
  const chosenVersion = registry.versions[preferredVersion]
    ? preferredVersion
    : registry['dist-tags'].latest;
  const tarballUrl = registry.versions[chosenVersion].dist.tarball;
  process.stdout.write(`  Using version ${chosenVersion}: ${tarballUrl}\n`);

  // Download tarball
  process.stdout.write('  Downloading tarball…\n');
  const tarball = await fetchBuffer(tarballUrl);
  process.stdout.write(`  Downloaded ${fmt(tarball.length)}\n`);

  // Write to a temp file so tar can read it
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-mon-doom-'));
  const tgzPath = path.join(tmpDir, 'opentui-doom.tgz');
  const extractDir = path.join(tmpDir, 'extract');
  mkdirp(extractDir);
  fs.writeFileSync(tgzPath, tarball);

  // Extract only the two files we need
  // npm tarballs prefix all paths with "package/"
  // On Windows, use the inbox bsdtar (System32\tar.exe) which handles drive-letter
  // paths natively. GNU tar (MSYS/Git Bash) misinterprets "C:" as a remote host.
  const tarBin = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tarBin, [
    '-xzf', tgzPath,
    '-C', extractDir,
    '--strip-components=1',       // strip "package/"
    'package/doom/build/doom.js',
    'package/doom/build/doom.wasm',
  ]);

  // Move into vendor/doom/
  mkdirp(VENDOR_DOOM);
  const extractedJs   = path.join(extractDir, 'doom', 'build', 'doom.js');
  const extractedWasm = path.join(extractDir, 'doom', 'build', 'doom.wasm');

  if (!fs.existsSync(extractedJs) || !fs.existsSync(extractedWasm)) {
    throw new Error(`Extraction failed — expected files not found in ${extractDir}`);
  }

  // Use copy+unlink instead of rename to handle cross-device moves
  // (e.g. tmpdir on C: while vendor/ is on D: on Windows).
  fs.copyFileSync(extractedJs,   doom_js);
  fs.unlinkSync(extractedJs);
  fs.copyFileSync(extractedWasm, doom_wasm);
  fs.unlinkSync(extractedWasm);

  // Cleanup tmp dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Validate
  if (!isValidDoomJs(doom_js)) {
    throw new Error('doom.js failed validation after extraction');
  }
  if (!isValidDoomWasm(doom_wasm)) {
    throw new Error('doom.wasm failed validation after extraction');
  }

  process.stdout.write(`  doom.js   — OK (${fmt(fs.statSync(doom_js).size)})\n`);
  process.stdout.write(`  doom.wasm — OK (${fmt(fs.statSync(doom_wasm).size)})\n`);
}

// ── WAD download ──────────────────────────────────────────────────────────────

const WAD_CANDIDATES = [
  'https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad',
  // Additional verified mirrors (add more here if ibiblio goes down)
  'https://www.quaddicted.com/files/idgames/lhb/doom1.wad',
];

/**
 * Download doom1.wad from the first working mirror.
 */
async function fetchWad() {
  const wadPath = path.join(VENDOR_DOOM, 'doom1.wad');

  if (isValidWad(wadPath)) {
    const size = fs.statSync(wadPath).size;
    process.stdout.write(`  doom1.wad — already valid (${fmt(size)}), skipping\n`);
    return;
  }

  mkdirp(VENDOR_DOOM);

  for (const url of WAD_CANDIDATES) {
    try {
      process.stdout.write(`  Trying WAD mirror: ${url}\n`);
      const buf = await fetchBuffer(url);

      // Validate before writing
      if (buf.length < 3_500_000) {
        process.stdout.write(`  Skipping — too small (${fmt(buf.length)})\n`);
        continue;
      }
      const magic = buf.slice(0, 4).toString('ascii');
      if (magic !== 'IWAD') {
        process.stdout.write(`  Skipping — bad magic bytes: ${JSON.stringify(magic)}\n`);
        continue;
      }

      writeAtomic(wadPath, buf);
      process.stdout.write(`  doom1.wad — OK (${fmt(buf.length)})\n`);
      return;
    } catch (err) {
      process.stdout.write(`  Mirror failed: ${err.message}\n`);
    }
  }

  throw new Error('All doom1.wad mirrors failed. Check network connectivity.');
}

// ── .gitignore guard ──────────────────────────────────────────────────────────

/**
 * Ensure vendor/ is in .gitignore (idempotent).
 */
function ensureGitignore() {
  const gitignore = path.join(ROOT, '.gitignore');
  const entry = 'vendor/';
  try {
    const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
    if (!current.split('\n').some(line => line.trim() === entry)) {
      fs.writeFileSync(gitignore, current + (current.endsWith('\n') ? '' : '\n') + entry + '\n', 'utf8');
      process.stdout.write('  Added "vendor/" to .gitignore\n');
    }
  } catch {
    // Non-fatal
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('claude-mon fetch-doom\n\n');

  ensureGitignore();

  process.stdout.write('Fetching DOOM WASM engine (opentui-doom)…\n');
  await fetchOpentUiDoom();

  process.stdout.write('\nFetching doom1.wad (shareware IWAD)…\n');
  await fetchWad();

  process.stdout.write('\nAll assets ready:\n');
  for (const name of ['doom.js', 'doom.wasm', 'doom1.wad']) {
    const p = path.join(VENDOR_DOOM, name);
    const size = fs.statSync(p).size;
    process.stdout.write(`  ${VENDOR_DOOM}/${name}  (${fmt(size)})\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`fetch-doom error: ${err.message}\n`);
  process.exit(1);
});
