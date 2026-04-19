'use strict';

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { isWindows, isMac, isLinux, getVenvPath, getPythonPath, getUvPath, getUvInstallDir, log, fileExists, ensureDir } = require('./utils');

const execAsync = promisify(exec);

const SUPPORTED_VERSIONS = ['3.11', '3.12', '3.10'];

// ── Windows environment helpers ───────────────────────────────────────────────

/**
 * Build a sane Windows PATH that includes System32 and common Python locations.
 * Electron strips the inherited PATH, so PowerShell and other tools are not found.
 */
function getWindowsEnv() {
  const username = os.userInfo().username;
  const extraPaths = [
    'C:\\Windows\\System32',
    'C:\\Windows',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
    `C:\\Users\\${username}\\AppData\\Local\\Programs\\Python\\Python312`,
    `C:\\Users\\${username}\\AppData\\Local\\Programs\\Python\\Python311`,
    `C:\\Users\\${username}\\AppData\\Local\\Programs\\Python\\Python310`,
    'C:\\Python312',
    'C:\\Python311',
    'C:\\Python310',
    `C:\\Users\\${username}\\AppData\\Local\\Microsoft\\WindowsApps`,
    `C:\\Users\\${username}\\AppData\\Roaming\\Python\\Python312\\Scripts`,
    `C:\\Users\\${username}\\AppData\\Roaming\\Python\\Python311\\Scripts`,
    `C:\\Users\\${username}\\.local\\bin`,
    getUvInstallDir(), // our app-data uv directory
  ];

  const existing = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...extraPaths, ...existing])].join(path.delimiter);

  return {
    ...process.env,
    PATH: merged,
    PYTHONIOENCODING: 'utf-8',
  };
}

function getEnv() {
  return isWindows ? getWindowsEnv() : { ...process.env, PYTHONIOENCODING: 'utf-8' };
}

/**
 * Run a shell command with the fixed environment. Returns { stdout, stderr }.
 */
async function shellExec(cmd, opts = {}) {
  return execAsync(cmd, {
    shell: true,
    env: getEnv(),
    timeout: opts.timeout || 30000,
    ...opts,
  });
}

// ── Version parsing ───────────────────────────────────────────────────────────

function parseVersion(versionStr) {
  const match = (versionStr || '').match(/(\d+)\.(\d+)\.?(\d*)/);
  if (!match) return null;
  return {
    major: parseInt(match[1]),
    minor: parseInt(match[2]),
    patch: parseInt(match[3] || '0'),
    full: `${match[1]}.${match[2]}.${match[3] || '0'}`,
  };
}

// ── Python probing ────────────────────────────────────────────────────────────

/**
 * Detect Microsoft Store Python app-execution aliases. These are 0-byte (or tiny)
 * reparse points in WindowsApps that open the Store when run, and hang or return
 * nothing when probed non-interactively. They must never be treated as real Python.
 */
function isWindowsStoreStub(pythonPath) {
  if (!isWindows || !pythonPath) return false;
  const lower = pythonPath.toLowerCase();
  if (!lower.includes('\\microsoft\\windowsapps\\')) return false;
  try {
    const stat = fs.statSync(pythonPath);
    // Real python.exe is ~100 KB+; Store stubs are 0 bytes or reparse points
    if (stat.size < 1024) return true;
  } catch (_) {
    return true;
  }
  return false;
}

/**
 * Test a Python binary: runs --version, returns version info if supported.
 */
async function probePython(pythonPath) {
  try {
    if (isWindowsStoreStub(pythonPath)) {
      log(`Skipping Microsoft Store Python stub at ${pythonPath}`);
      return null;
    }
    const quoted = `"${pythonPath}"`;
    const { stdout, stderr } = await shellExec(`${quoted} --version`, { timeout: 8000 });
    const raw = (stdout || stderr || '').trim();
    const ver = parseVersion(raw);
    if (!ver) return null;
    const key = `${ver.major}.${ver.minor}`;
    if (ver.major === 3 && SUPPORTED_VERSIONS.includes(key)) {
      log(`Suitable Python found: ${pythonPath} (${raw})`);
      return { path: pythonPath, version: ver.full };
    }
    log(`Python at ${pythonPath} is version ${raw} — not in supported list`);
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Try the Windows "py" launcher for a specific version.
 */
async function checkPyLauncher(ver) {
  if (!isWindows) return null;
  try {
    const { stdout, stderr } = await shellExec(`py -${ver} --version`, { timeout: 8000 });
    const raw = (stdout || stderr || '').trim();
    const parsed = parseVersion(raw);
    if (!parsed) return null;

    const { stdout: pathOut } = await shellExec(`py -${ver} -c "import sys; print(sys.executable)"`, { timeout: 8000 });
    const pythonPath = pathOut.trim();
    if (pythonPath && fileExists(pythonPath) && !isWindowsStoreStub(pythonPath)) {
      log(`Found Python ${parsed.full} via py launcher at ${pythonPath}`);
      return { path: pythonPath, version: parsed.full };
    }
  } catch (_) {}
  return null;
}

/**
 * Find a pre-existing suitable Python (does not install anything).
 */
async function checkPython() {
  // 1. Venv Python (already set up)
  const venvPython = getPythonPath();
  if (fileExists(venvPython)) {
    const result = await probePython(venvPython);
    if (result) return { found: true, ...result, inVenv: true };
  }

  // 2. Windows py launcher
  if (isWindows) {
    for (const ver of SUPPORTED_VERSIONS) {
      const r = await checkPyLauncher(ver);
      if (r) return { found: true, ...r, inVenv: false };
    }
  }

  // 3. Common executable names / absolute paths
  const username = os.userInfo().username;
  const candidates = isWindows
    ? [
        'python',
        'python3',
        ...SUPPORTED_VERSIONS.flatMap(ver => {
          const [maj, min] = ver.split('.');
          return [
            `C:\\Python${maj}${min}\\python.exe`,
            `C:\\Users\\${username}\\AppData\\Local\\Programs\\Python\\Python${maj}${min}\\python.exe`,
          ];
        }),
      ]
    : [
        ...SUPPORTED_VERSIONS.map(v => `python${v}`),
        'python3',
        'python',
      ];

  for (const candidate of candidates) {
    // Resolve via where/which first. On Windows, "where" returns ALL matches —
    // try each, not only the first, so Store stubs don't poison the lookup.
    let resolvedPaths = [];
    if (!path.isAbsolute(candidate)) {
      try {
        const cmd = isWindows ? `where "${candidate}"` : `which "${candidate}"`;
        const { stdout } = await shellExec(cmd, { timeout: 5000 });
        resolvedPaths = stdout.split('\n').map(s => s.trim()).filter(Boolean);
        if (resolvedPaths.length === 0) continue;
      } catch (_) {
        continue;
      }
    } else if (!fileExists(candidate)) {
      continue;
    } else {
      resolvedPaths = [candidate];
    }

    for (const resolved of resolvedPaths) {
      const result = await probePython(resolved);
      if (result) return { found: true, ...result, inVenv: false };
    }
  }

  return { found: false };
}

// ── uv helpers ────────────────────────────────────────────────────────────────

async function checkUv() {
  const uvPath = getUvPath();
  if (fileExists(uvPath)) return uvPath;
  try {
    const cmd = isWindows ? 'where uv' : 'which uv';
    const { stdout } = await shellExec(cmd, { timeout: 5000 });
    const found = stdout.trim().split('\n')[0].trim();
    if (found) return found;
  } catch (_) {}
  return null;
}

/**
 * Download a URL to a file (follows redirects). Returns a Promise.
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'open-webui-desktop/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

/**
 * Extract uv.exe from the downloaded zip. Tries tar.exe first (Windows 10 1803+),
 * falls back to PowerShell's Expand-Archive (available since Windows 8.1) for
 * older / stripped-down systems where tar.exe is missing.
 */
async function extractUv(zipPath, destDir) {
  ensureDir(destDir);
  try {
    await shellExec(`tar -xf "${zipPath}" -C "${destDir}"`, { timeout: 30000 });
    if (fileExists(getUvPath())) return;
    log('tar extraction produced no uv.exe — trying PowerShell fallback');
  } catch (err) {
    log(`tar extraction failed (${err.message}); trying PowerShell fallback`);
  }
  // PowerShell Expand-Archive fallback
  const ps = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
  await shellExec(ps, { timeout: 60000 });
}

/**
 * Install uv by downloading the binary directly from GitHub — no PowerShell needed.
 */
async function installUv(onProgress) {
  onProgress({ type: 'log', text: 'Installing uv package manager...' });
  log('Installing uv...');

  const uvDir = getUvInstallDir();
  ensureDir(uvDir);

  if (isWindows) {
    // Direct binary download from GitHub releases
    const url = 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip';
    const zipPath = path.join(uvDir, 'uv-download.zip');

    onProgress({ type: 'log', text: 'Downloading uv binary from GitHub...' });
    log(`Downloading uv from ${url}`);
    await downloadFile(url, zipPath);
    onProgress({ type: 'log', text: 'Extracting uv...' });
    await extractUv(zipPath, uvDir);

    // Clean up zip
    try { fs.unlinkSync(zipPath); } catch (_) {}

    const uvExe = getUvPath();
    if (!fileExists(uvExe)) {
      throw new Error(`uv binary not found after extraction at ${uvExe}`);
    }
    log(`uv installed at ${uvExe}`);
    onProgress({ type: 'log', text: 'uv installed successfully.' });
    return uvExe;
  } else {
    // Unix: curl installer
    onProgress({ type: 'log', text: 'Running uv installer script...' });
    await new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'], {
        env: getEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout?.on('data', d => onProgress({ type: 'log', text: d.toString().trim() }));
      proc.stderr?.on('data', d => onProgress({ type: 'log', text: d.toString().trim() }));
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`uv installer exited ${code}`)));
      proc.on('error', reject);
    });
    onProgress({ type: 'log', text: 'uv installed successfully.' });
    return getUvPath();
  }
}

/**
 * Use uv to install Python 3.11 and return the path to the binary.
 */
async function installPythonWithUv(uvPath, onProgress) {
  onProgress({ type: 'log', text: 'Installing Python 3.11 via uv...' });
  log(`Installing Python 3.11 using uv at ${uvPath}`);

  await new Promise((resolve, reject) => {
    const proc = spawn(`"${uvPath}"`, ['python', 'install', '3.11'], {
      shell: true,
      env: getEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc.stdout?.on('data', d => onProgress({ type: 'log', text: d.toString().trim() }));
    proc.stderr?.on('data', d => onProgress({ type: 'log', text: d.toString().trim() }));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Python install exited ${code}`)));
    proc.on('error', reject);
  });

  // Find the installed Python binary
  const { stdout } = await shellExec(`"${uvPath}" python find 3.11`, { timeout: 15000 });
  const pythonPath = stdout.trim();
  if (!pythonPath) throw new Error('Could not locate Python 3.11 after installation');
  log(`Python 3.11 installed at ${pythonPath}`);
  onProgress({ type: 'log', text: `Python 3.11 installed at ${pythonPath}` });
  return pythonPath;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Full Python ensure flow: check existing → install uv if needed → install Python.
 */
async function ensurePython(onProgress) {
  onProgress({ type: 'step', step: 'python', text: 'Checking Python installation...' });

  const existing = await checkPython();
  if (existing.found && !existing.inVenv) {
    onProgress({ type: 'log', text: `Found Python ${existing.version} at ${existing.path}` });
    return existing.path;
  }

  onProgress({ type: 'log', text: 'No suitable Python (3.10–3.12) found. Installing Python 3.11...' });

  let uvPath = await checkUv();
  if (!uvPath) {
    uvPath = await installUv(onProgress);
  } else {
    onProgress({ type: 'log', text: `Using existing uv at ${uvPath}` });
  }

  return installPythonWithUv(uvPath, onProgress);
}

module.exports = {
  checkPython,
  ensurePython,
  parseVersion,
  checkUv,
  installUv,
  installPythonWithUv,
};
