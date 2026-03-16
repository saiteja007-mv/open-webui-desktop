'use strict';

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const { isWindows, getVenvPath, getPythonPath, getUvPath, log, fileExists, ensureDir } = require('./utils');

const execFileAsync = promisify(execFile);

/**
 * Create a Python virtual environment
 */
async function createVenv(pythonPath, onProgress) {
  const venvPath = getVenvPath();
  onProgress({ type: 'step', step: 'venv', text: 'Creating virtual environment...' });
  log(`Creating venv at ${venvPath} using ${pythonPath}`);

  ensureDir(path.dirname(venvPath));

  // Remove partial/broken venv if it exists
  if (fs.existsSync(venvPath)) {
    const venvPython = getPythonPath();
    if (!fileExists(venvPython)) {
      onProgress({ type: 'log', text: 'Removing incomplete virtual environment...' });
      fs.rmSync(venvPath, { recursive: true, force: true });
    } else {
      onProgress({ type: 'log', text: 'Virtual environment already exists.' });
      return venvPath;
    }
  }

  return new Promise((resolve, reject) => {
    // Try python -m venv first
    const proc = spawn(pythonPath, ['-m', 'venv', venvPath]);

    proc.stdout?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) onProgress({ type: 'log', text });
    });
    proc.stderr?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) onProgress({ type: 'log', text });
    });
    proc.on('close', async (code) => {
      if (code === 0 && fileExists(getPythonPath())) {
        log('Venv created successfully');
        onProgress({ type: 'log', text: 'Virtual environment created.' });
        resolve(venvPath);
      } else {
        // Fallback: try uv venv
        log('python -m venv failed, trying uv venv...');
        onProgress({ type: 'log', text: 'Falling back to uv venv...' });
        try {
          const uvPath = getUvPath();
          if (fileExists(uvPath)) {
            await fallbackUvVenv(uvPath, venvPath, onProgress);
            resolve(venvPath);
          } else {
            reject(new Error('Failed to create virtual environment. Please ensure Python 3.11+ is properly installed.'));
          }
        } catch (err) {
          reject(err);
        }
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to run Python: ${err.message}`));
    });
  });
}

async function fallbackUvVenv(uvPath, venvPath, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(uvPath, ['venv', venvPath, '--python', '3.11']);
    proc.stdout?.on('data', (d) => onProgress({ type: 'log', text: d.toString().trim() }));
    proc.stderr?.on('data', (d) => onProgress({ type: 'log', text: d.toString().trim() }));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`uv venv failed with exit code ${code}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Run pip in the venv, streaming output
 */
function runPip(args, onProgress, timeoutMs = 600000) {
  const python = getPythonPath();
  return new Promise((resolve, reject) => {
    const proc = spawn(python, ['-m', 'pip', ...args], {
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PIP_NO_INPUT: '1',
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
      },
    });

    let lastProgress = 0;

    const handleLine = (line) => {
      if (!line.trim()) return;
      onProgress({ type: 'log', text: line });

      // Parse pip download progress like: Downloading open_webui-0.6.0...tar.gz (50.4 MB)
      const downloadMatch = line.match(/Downloading .+?\s+\([\d.]+ \w+\)/);
      if (downloadMatch) {
        onProgress({ type: 'progress', value: lastProgress });
      }
      // Parse progress percentage if available
      const percentMatch = line.match(/(\d+)%/);
      if (percentMatch) {
        lastProgress = parseInt(percentMatch[1]);
        onProgress({ type: 'progress', value: lastProgress });
      }
    };

    let buffer = '';
    proc.stdout?.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(handleLine);
    });
    proc.stderr?.on('data', (data) => {
      const text = data.toString();
      text.split('\n').forEach((line) => {
        if (line.trim()) handleLine(line);
      });
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('pip operation timed out after 10 minutes'));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (buffer.trim()) handleLine(buffer);
      if (code === 0) resolve();
      else reject(new Error(`pip failed with exit code ${code}`));
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`pip error: ${err.message}`));
    });
  });
}

/**
 * Upgrade pip in the venv
 */
async function upgradePip(onProgress) {
  onProgress({ type: 'log', text: 'Upgrading pip...' });
  log('Upgrading pip');
  try {
    await runPip(['install', '--upgrade', 'pip'], onProgress, 60000);
    onProgress({ type: 'log', text: 'pip upgraded.' });
  } catch (err) {
    // Non-fatal — log and continue
    onProgress({ type: 'log', text: `pip upgrade warning: ${err.message}` });
    log(`pip upgrade warning: ${err.message}`);
  }
}

/**
 * Install open-webui into the venv
 */
async function installOpenWebUI(onProgress) {
  onProgress({ type: 'step', step: 'install', text: 'Installing Open WebUI (this may take several minutes)...' });
  log('Installing open-webui via pip');

  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      await runPip(
        ['install', 'open-webui'],
        onProgress,
        900000 // 15 min timeout — open-webui has many deps
      );
      onProgress({ type: 'log', text: 'Open WebUI installed successfully.' });
      log('open-webui installed');
      return;
    } catch (err) {
      retries++;
      if (retries < maxRetries) {
        const delay = retries * 5000;
        onProgress({ type: 'log', text: `Installation attempt ${retries} failed. Retrying in ${delay / 1000}s... (${err.message})` });
        log(`pip install failed, retry ${retries}: ${err.message}`);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        throw new Error(`Failed to install Open WebUI after ${maxRetries} attempts: ${err.message}`);
      }
    }
  }
}

/**
 * Update open-webui to latest version
 */
async function updateOpenWebUI(onProgress) {
  onProgress({ type: 'step', step: 'update', text: 'Updating Open WebUI...' });
  await runPip(['install', '--upgrade', 'open-webui'], onProgress, 900000);
  onProgress({ type: 'log', text: 'Open WebUI updated.' });
}

/**
 * Check if open-webui is installed in the venv
 */
async function checkInstallation() {
  const python = getPythonPath();
  if (!fileExists(python)) return false;
  try {
    await execFileAsync(python, ['-c', 'import open_webui'], { timeout: 15000 });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Get installed open-webui version
 */
async function getInstalledVersion() {
  const python = getPythonPath();
  if (!fileExists(python)) return null;
  try {
    const { stdout } = await execFileAsync(
      python,
      ['-c', 'import importlib.metadata; print(importlib.metadata.version("open-webui"))'],
      { timeout: 10000 }
    );
    return stdout.trim();
  } catch (_) {
    return null;
  }
}

module.exports = {
  createVenv,
  upgradePip,
  installOpenWebUI,
  updateOpenWebUI,
  checkInstallation,
  getInstalledVersion,
};
