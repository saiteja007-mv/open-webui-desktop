'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { isWindows, getPythonPath, getOpenWebuiBinPath, getDataDir, getSecretKeyPath, log, fileExists, ensureDir } = require('./utils');

let serverProcess = null;
let serverPort = 8080;
let serverReady = false;
let lastChildActivityAt = 0;
let logListeners = [];
let readyListeners = [];
let stateListeners = [];

const POLL_INTERVAL_MS = 1000;
// Overall hard cap. With embedding-model preload disabled, startup is normally
// well under a minute — keep a generous ceiling as a safety net only.
const SERVER_TIMEOUT_MS = 180000; // 3 minutes
// Only trip on actual stalls: no child output for this long = stuck.
const STALL_TIMEOUT_MS = 90000; // 90 seconds of silence = stalled

/**
 * Load or generate the secret key
 */
function getOrCreateSecretKey() {
  const keyPath = getSecretKeyPath();
  ensureDir(path.dirname(keyPath));

  // Check the original project dir secret key
  const projectKeyPath = path.join(process.cwd(), '.webui_secret_key');
  if (fs.existsSync(projectKeyPath) && !fs.existsSync(keyPath)) {
    try {
      fs.copyFileSync(projectKeyPath, keyPath);
    } catch (_) {}
  }

  if (fs.existsSync(keyPath)) {
    try {
      return fs.readFileSync(keyPath, 'utf-8').trim();
    } catch (_) {}
  }

  // Generate a new key
  const key = require('crypto').randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyPath, key, 'utf-8');
  } catch (_) {}
  return key;
}

/**
 * Find an available port starting from the preferred port
 */
async function findAvailablePort(preferredPort) {
  for (let port = preferredPort; port < preferredPort + 20; port++) {
    const available = await isPortAvailable(port);
    if (available) return port;
  }
  throw new Error('No available ports found in range 8080-8100');
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = require('net').createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Poll the server until it responds
 */
function pollServerReady(port, timeoutMs, stallTimeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      // Hard cap
      if (now - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Server did not start within ${Math.round(timeoutMs / 1000)} seconds`));
        return;
      }
      // Stall detection — child has produced no output for too long
      if (stallTimeoutMs && lastChildActivityAt && now - lastChildActivityAt > stallTimeoutMs) {
        clearInterval(interval);
        reject(new Error(`Server appears stalled — no output for ${Math.round(stallTimeoutMs / 1000)}s`));
        return;
      }
      const req = http.request({ hostname: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        clearInterval(interval);
        resolve(port);
      });
      req.on('error', () => {}); // Ignore connection errors during polling
      req.on('timeout', () => req.destroy());
      req.end();
    }, POLL_INTERVAL_MS);
  });
}

function emit(event, data) {
  if (event === 'log') logListeners.forEach((cb) => cb(data));
  if (event === 'ready') readyListeners.forEach((cb) => cb(data));
  if (event === 'state') stateListeners.forEach((cb) => cb(data));
}

/**
 * Start the open-webui server
 */
async function startServer() {
  if (serverProcess && !serverProcess.killed) {
    log('Server already running');
    return { port: serverPort, alreadyRunning: true };
  }

  const python = getPythonPath();
  if (!fileExists(python)) {
    throw new Error('Python not found in virtual environment. Please reinstall.');
  }

  serverPort = await findAvailablePort(8080);
  const dataDir = getDataDir();
  ensureDir(dataDir);
  const secretKey = getOrCreateSecretKey();

  log(`Starting open-webui on port ${serverPort}`);
  emit('state', { status: 'starting', port: serverPort });

  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    DATA_DIR: dataDir,
    WEBUI_SECRET_KEY: secretKey,
    PORT: String(serverPort),
    HOST: '127.0.0.1',
    // ── Fast-start: skip HuggingFace model downloads on launch ─────────────
    // Open WebUI otherwise fetches ~90MB (sentence-transformers/all-MiniLM-L6-v2
    // + a reranker) during lifespan startup, which adds minutes to first-run.
    // Switching the embedding engine away from the empty default makes it skip
    // SentenceTransformer load entirely. The user can switch back to local
    // embeddings from Admin → Settings → Documents once the app is open.
    RAG_EMBEDDING_ENGINE: 'ollama',
    RAG_RERANKING_ENGINE: 'ollama',
    RAG_EMBEDDING_MODEL_AUTO_UPDATE: 'False',
    RAG_RERANKING_MODEL_AUTO_UPDATE: 'False',
    // Don't auto-pull LLM models either on first boot
    OFFLINE_MODE: 'False', // keep API calls possible; only block auto-model-pulls
    // Silence the Windows symlink cache warning that spams stderr first run
    HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
  };

  // Prefer the open-webui CLI script installed in the venv (correct entry point).
  // Fall back to: python -m open_webui serve (module invocation).
  const openWebuiBin = getOpenWebuiBinPath();
  let spawnCmd, spawnArgs;
  if (fileExists(openWebuiBin)) {
    spawnCmd = openWebuiBin;
    spawnArgs = ['serve', '--port', String(serverPort), '--host', '127.0.0.1'];
    log(`Using open-webui binary: ${openWebuiBin}`);
  } else {
    spawnCmd = python;
    spawnArgs = ['-m', 'open_webui', 'serve', '--port', String(serverPort), '--host', '127.0.0.1'];
    log('open-webui binary not found, falling back to python -m open_webui serve');
  }

  serverProcess = spawn(spawnCmd, spawnArgs, {
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  lastChildActivityAt = Date.now();

  serverProcess.stdout?.on('data', (data) => {
    lastChildActivityAt = Date.now();
    const text = data.toString();
    text.split('\n').forEach((line) => {
      if (line.trim()) {
        log(`[server] ${line}`);
        emit('log', { text: line.trim() });
      }
    });
  });

  serverProcess.stderr?.on('data', (data) => {
    lastChildActivityAt = Date.now();
    const text = data.toString();
    text.split('\n').forEach((line) => {
      if (line.trim()) {
        log(`[server-err] ${line}`);
        emit('log', { text: line.trim() });
      }
    });
  });

  serverProcess.on('close', (code) => {
    log(`Server process exited with code ${code}`);
    serverReady = false;
    serverProcess = null;
    emit('state', { status: 'stopped', code });
  });

  serverProcess.on('error', (err) => {
    log(`Server process error: ${err.message}`);
    emit('state', { status: 'error', error: err.message });
  });

  // Poll until ready
  try {
    await pollServerReady(serverPort, SERVER_TIMEOUT_MS, STALL_TIMEOUT_MS);
    serverReady = true;
    log(`Server ready on port ${serverPort}`);
    emit('ready', { port: serverPort, url: `http://localhost:${serverPort}` });
    emit('state', { status: 'running', port: serverPort });
    return { port: serverPort };
  } catch (err) {
    await stopServer();
    throw err;
  }
}

/**
 * Stop the server gracefully
 */
async function stopServer() {
  if (!serverProcess) return;
  log('Stopping server...');
  emit('state', { status: 'stopping' });

  return new Promise((resolve) => {
    serverProcess.once('close', () => {
      serverProcess = null;
      serverReady = false;
      emit('state', { status: 'stopped' });
      resolve();
    });

    if (isWindows) {
      // Windows needs taskkill for proper cleanup
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
      } catch (_) {
        serverProcess.kill('SIGTERM');
      }
    } else {
      serverProcess.kill('SIGTERM');
    }

    // Force kill after 5 seconds
    setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill('SIGKILL');
      }
    }, 5000);
  });
}

/**
 * Restart the server
 */
async function restartServer() {
  await stopServer();
  await new Promise((res) => setTimeout(res, 1000));
  return startServer();
}

/**
 * Check if server is running and responding
 */
function isRunning() {
  return serverReady && serverProcess && !serverProcess.killed;
}

function getPort() {
  return serverPort;
}

function getStatus() {
  if (isRunning()) return { status: 'running', port: serverPort, url: `http://localhost:${serverPort}` };
  if (serverProcess) return { status: 'starting', port: serverPort };
  return { status: 'stopped' };
}

// Event subscription
function onLog(cb) { logListeners.push(cb); return () => { logListeners = logListeners.filter((l) => l !== cb); }; }
function onReady(cb) { readyListeners.push(cb); return () => { readyListeners = readyListeners.filter((l) => l !== cb); }; }
function onStateChange(cb) { stateListeners.push(cb); return () => { stateListeners = stateListeners.filter((l) => l !== cb); }; }

module.exports = {
  startServer,
  stopServer,
  restartServer,
  isRunning,
  getPort,
  getStatus,
  onLog,
  onReady,
  onStateChange,
};
