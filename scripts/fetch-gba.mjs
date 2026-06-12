#!/usr/bin/env node
/**
 * fetch-gba.mjs — vendor the GBA emulator into vendor/gba/
 *
 * Pieces (all freely redistributable, fetched on demand, never bundled):
 *   vendor/gba/gbajs/       — gbajs (endrift's pure-JS GBA core, node-ready)
 *   vendor/gba/gbajs/node_modules/{pngjs,buffer-dataview}
 *   vendor/gba/test/        — tonc homebrew demos (brin_demo, key_demo) used
 *                             by the test suite; NOT game ROMs.
 *
 * GAME ROMS ARE NEVER FETCHED. Commercial ROMs are copyrighted — the user
 * supplies their own legally-dumped file via `/afk rom <path>`.
 *
 * Idempotent. Run: node scripts/fetch-gba.mjs
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
const VENDOR_GBA = path.join(ROOT, 'vendor', 'gba');
const GBAJS_DIR = path.join(VENDOR_GBA, 'gbajs');
const TEST_DIR = path.join(VENDOR_GBA, 'test');

const TONC_BIN_URL = 'https://www.coranac.com/files/tonc-bin.zip';
const TEST_ROMS = ['brin_demo.gba', 'key_demo.gba'];

// ── Helpers (fetch-doom pattern) ──────────────────────────────────────────────

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

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

async function fetchJson(url) {
  return JSON.parse((await fetchBuffer(url)).toString('utf8'));
}

function tarBin() {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

async function vendorNpm(pkg, destDir, preferred) {
  const registry = await fetchJson(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`);
  const version = preferred && registry.versions[preferred]
    ? preferred : registry['dist-tags'].latest;
  const tarball = await fetchBuffer(registry.versions[version].dist.tarball);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-gba-'));
  const tgz = path.join(tmpDir, 'pkg.tgz');
  fs.writeFileSync(tgz, tarball);
  fs.rmSync(destDir, { recursive: true, force: true });
  mkdirp(destDir);
  execFileSync(tarBin(), ['-xzf', tgz, '-C', tmpDir]);
  fs.cpSync(path.join(tmpDir, 'package'), destDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.stdout.write(`  ${pkg}@${version} → ${path.relative(ROOT, destDir)}\n`);
}

// ── Validation ────────────────────────────────────────────────────────────────

/** True when the vendored emulator boots a test ROM and renders a frame. */
export async function gbaVendorValid() {
  try {
    const require = createRequire(import.meta.url);
    const GameBoyAdvance = require(path.join(GBAJS_DIR, 'js', 'gba.js'));
    const bios = fs.readFileSync(path.join(GBAJS_DIR, 'resources', 'bios.bin'));
    const romPath = path.join(TEST_DIR, 'brin_demo.gba');
    const rom = fs.readFileSync(romPath);
    const gba = new GameBoyAdvance();
    gba.logLevel = gba.LOG_ERROR;
    gba.setBios(bios.buffer.slice(bios.byteOffset, bios.byteOffset + bios.byteLength));
    gba.setCanvasMemory();
    gba.setRom(rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength));
    for (let i = 0; i < 10; i++) gba.advanceFrame();
    const png = gba.screenshot();
    return png && png.width === 240 && png.height === 160;
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write('claude-mon fetch-gba\n\n');

  if (await gbaVendorValid()) {
    process.stdout.write('  vendor/gba — already valid, skipping\n');
    return;
  }

  process.stdout.write('Vendoring emulator (gbajs + deps)…\n');
  await vendorNpm('gbajs', GBAJS_DIR, '1.1.2');
  await vendorNpm('pngjs', path.join(GBAJS_DIR, 'node_modules', 'pngjs'), '3.4.0');
  await vendorNpm('buffer-dataview',
    path.join(GBAJS_DIR, 'node_modules', 'buffer-dataview'), '0.0.2');

  process.stdout.write('Fetching homebrew test demos (tonc)…\n');
  const zip = await fetchBuffer(TONC_BIN_URL);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-tonc-'));
  const zipPath = path.join(tmpDir, 'tonc-bin.zip');
  fs.writeFileSync(zipPath, zip);
  execFileSync(tarBin(), ['-xf', zipPath, '-C', tmpDir]); // bsdtar reads zip
  mkdirp(TEST_DIR);
  for (const name of TEST_ROMS) {
    fs.copyFileSync(path.join(tmpDir, 'bin', name), path.join(TEST_DIR, name));
    process.stdout.write(`  test/${name}\n`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (!(await gbaVendorValid())) {
    throw new Error('vendor/gba failed validation after fetch');
  }
  process.stdout.write('\nGBA emulator ready. Game ROMs are NEVER downloaded —\n' +
    'point the plugin at your own legally-dumped file:  /afk rom <path>\n');
}

const isMainModule = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch((err) => {
    process.stderr.write(`fetch-gba error: ${err.message}\n`);
    process.exit(1);
  });
}
