#!/usr/bin/env node
/**
 * Build-time bundler.
 *
 * Produces a self-contained `bundle/` directory containing:
 *   bundle/python/   — portable Python 3.11 (uv-installed)
 *   bundle/venv/     — venv with open-webui + all deps pre-installed
 *
 * electron-builder ships `bundle/` as extraResources, so the installed
 * desktop app has zero first-run dependencies.
 *
 * Usage:
 *   node scripts/prepare-bundle.js
 *
 * Cross-platform. Detects the host platform from process.platform.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'bundle');
const VENV_DIR = path.join(BUNDLE_DIR, 'venv');
const UV_DIR = path.join(BUNDLE_DIR, 'uv');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[prepare-bundle] ${msg}\n`);
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}`);
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, hops = 0) => {
      if (hops > 6) return reject(new Error(`Too many redirects: ${u}`));
      https.get(u, { headers: { 'User-Agent': 'open-webui-desktop-build' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          return follow(res.headers.location, hops + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// ─── uv install (host-platform-specific) ──────────────────────────────────────

async function installUv() {
  ensureDir(UV_DIR);
  const uvBin = IS_WIN ? path.join(UV_DIR, 'uv.exe') : path.join(UV_DIR, 'uv');
  if (fs.existsSync(uvBin)) {
    log(`uv already present at ${uvBin}`);
    return uvBin;
  }

  if (IS_WIN) {
    const url = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
    const zip = path.join(UV_DIR, 'uv.zip');
    log(`Downloading uv from ${url}`);
    await download(url, zip);
    // tar.exe ships with Windows 10 1803+; PowerShell Expand-Archive is fallback
    try {
      run('tar', ['-xf', zip, '-C', UV_DIR]);
    } catch (_) {
      run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${UV_DIR}' -Force`]);
    }
    fs.unlinkSync(zip);
  } else {
    // macOS / Linux: use official curl installer with custom install dir
    const env = { ...process.env, UV_INSTALL_DIR: UV_DIR, UV_NO_MODIFY_PATH: '1' };
    run('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], { env });
    // The installer typically drops uv at $UV_INSTALL_DIR/uv
  }

  if (!fs.existsSync(uvBin)) {
    throw new Error(`uv install completed but binary missing at ${uvBin}`);
  }
  log(`uv ready at ${uvBin}`);
  return uvBin;
}

// ─── Build the bundled venv ───────────────────────────────────────────────────

async function buildVenv(uvBin) {
  // Wipe old venv to ensure clean state
  rmrf(VENV_DIR);

  log('Creating venv with Python 3.11...');
  run(uvBin, ['venv', VENV_DIR, '--python', '3.11', '--seed']);

  const pyBin = IS_WIN
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
  if (!fs.existsSync(pyBin)) {
    throw new Error(`venv python missing at ${pyBin}`);
  }

  log('Installing open-webui (this may take several minutes)...');
  run(uvBin, [
    'pip', 'install',
    '--python', pyBin,
    'open-webui',
  ]);

  // Sanity check: import open_webui
  log('Verifying installation...');
  run(pyBin, ['-c', 'import open_webui; print("open_webui imported OK")']);
}

// ─── Slim down the bundle ─────────────────────────────────────────────────────

function pruneBundle() {
  log('Pruning __pycache__ / tests / docs to shrink installer...');
  const dropDirs = new Set(['__pycache__', 'tests', 'test', 'examples', 'docs']);
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (dropDirs.has(e.name)) {
          rmrf(p);
        } else {
          walk(p);
        }
      } else if (/\.(pyc|pyo)$/.test(e.name)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }
  }
  walk(VENV_DIR);
}

function reportSize() {
  function du(dir) {
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return 0; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += du(p);
      else { try { total += fs.statSync(p).size; } catch (_) {} }
    }
    return total;
  }
  const bytes = du(VENV_DIR);
  log(`Bundle venv size: ${(bytes / (1024 * 1024)).toFixed(1)} MB`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  log(`Platform: ${process.platform} ${process.arch}`);
  ensureDir(BUNDLE_DIR);
  const uvBin = await installUv();
  await buildVenv(uvBin);
  pruneBundle();
  reportSize();
  log('✅ Bundle ready at bundle/venv');
})().catch((err) => {
  console.error('[prepare-bundle] FAILED:', err.message);
  process.exit(1);
});
