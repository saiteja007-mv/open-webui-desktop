'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

// Platform detection
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

/**
 * Get the user data directory for storing venv, data, logs
 */
function getAppDataPath() {
  if (app) {
    return app.getPath('userData');
  }
  // Fallback for when called outside Electron context
  if (isWindows) return path.join(os.homedir(), 'AppData', 'Roaming', 'open-webui-desktop');
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', 'open-webui-desktop');
  return path.join(os.homedir(), '.local', 'share', 'open-webui-desktop');
}

function getVenvPath() {
  return path.join(getAppDataPath(), 'venv');
}

function getPythonPath() {
  const venv = getVenvPath();
  if (isWindows) return path.join(venv, 'Scripts', 'python.exe');
  return path.join(venv, 'bin', 'python');
}

function getPipPath() {
  const venv = getVenvPath();
  if (isWindows) return path.join(venv, 'Scripts', 'pip.exe');
  return path.join(venv, 'bin', 'pip');
}

function getOpenWebuiBinPath() {
  const venv = getVenvPath();
  if (isWindows) return path.join(venv, 'Scripts', 'open-webui.exe');
  return path.join(venv, 'bin', 'open-webui');
}

function getUvInstallDir() {
  // Keep uv inside the app data dir so we fully control it
  return path.join(getAppDataPath(), 'uv');
}

function getUvPath() {
  const uvDir = getUvInstallDir();
  if (isWindows) return path.join(uvDir, 'uv.exe');
  return path.join(uvDir, 'uv');
}

function getDataDir() {
  return path.join(getAppDataPath(), 'data');
}

function getLogsDir() {
  return path.join(getAppDataPath(), 'logs');
}

function getLogFilePath() {
  return path.join(getLogsDir(), 'app.log');
}

function getSecretKeyPath() {
  return path.join(getDataDir(), '.webui_secret_key');
}

/**
 * Write a log message to the log file
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  try {
    const logsDir = getLogsDir();
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(getLogFilePath(), line);
  } catch (_) {
    // Ignore log write failures
  }
  if (process.env.NODE_ENV === 'development') {
    process.stdout.write(line);
  }
}

/**
 * Ensure a directory exists, creating it if needed
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Check if a file/binary exists and is executable
 */
function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Get readable file size
 */
function getFreeDiskSpace() {
  try {
    const stats = fs.statSync(getAppDataPath().split(path.sep)[0] + path.sep);
    // Cross-platform disk space check — just return a large number if we can't determine
    return Infinity;
  } catch (_) {
    return Infinity;
  }
}

module.exports = {
  isWindows,
  isMac,
  isLinux,
  getAppDataPath,
  getVenvPath,
  getPythonPath,
  getPipPath,
  getOpenWebuiBinPath,
  getUvPath,
  getUvInstallDir,
  getDataDir,
  getLogsDir,
  getLogFilePath,
  getSecretKeyPath,
  log,
  ensureDir,
  fileExists,
  getFreeDiskSpace,
};
