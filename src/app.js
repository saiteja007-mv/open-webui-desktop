'use strict';

const STARTUP_TIMEOUT_MS = 120000; // 2 minutes
let startupTimer = null;
let serverUrl = null;

function setLoadingStatus(text) {
  const el = document.getElementById('loading-status');
  if (el) el.textContent = text;
}

function showError(msg) {
  clearTimeout(startupTimer);
  document.getElementById('loading-screen').classList.add('hidden');
  document.getElementById('error-screen').classList.remove('hidden');
  const errEl = document.getElementById('error-msg');
  if (errEl) errEl.textContent = msg || 'The Open WebUI server could not be started.';
}

function showWebView(url) {
  clearTimeout(startupTimer);
  const webview = document.getElementById('webview');
  const loadingScreen = document.getElementById('loading-screen');

  // Intercept popup/new-tab requests: keep localhost in webview, send external links to system browser
  webview.addEventListener('new-window', (e) => {
    const target = e.url || '';
    if (target.startsWith('http://localhost') || target.startsWith('http://127.0.0.1')) {
      webview.src = target;
    } else if (target.startsWith('http://') || target.startsWith('https://')) {
      window.api.app.openExternal(target);
    }
  });

  // Catch any navigation away from localhost (e.g. open-webui redirecting to an external OAuth page etc.)
  webview.addEventListener('will-navigate', (e) => {
    const target = e.url || '';
    if (!target.startsWith('http://localhost') && !target.startsWith('http://127.0.0.1') && !target.startsWith('about:')) {
      if (target.startsWith('http://') || target.startsWith('https://')) {
        window.api.app.openExternal(target);
      }
    }
  });

  webview.src = url;
  webview.addEventListener('did-finish-load', () => {
    loadingScreen.classList.add('hidden');
    webview.classList.remove('hidden');
    document.getElementById('settings-fab')?.classList.remove('hidden');
  }, { once: true });
  webview.addEventListener('did-fail-load', (_e, errCode, errDesc) => {
    if (errCode === -3) return; // Aborted — ignore
    showError(`Failed to load Open WebUI: ${errDesc} (${errCode})`);
  }, { once: true });
}

async function restartServer() {
  document.getElementById('error-screen').classList.add('hidden');
  document.getElementById('loading-screen').classList.remove('hidden');
  setLoadingStatus('Restarting server...');

  const result = await window.api.server.restart();
  if (!result.success) {
    showError(result.error || 'Failed to restart server.');
  }
}

async function showLogs() {
  window.api.app.showLogs();
}

async function reinstall() {
  window.api.app.navigateToApp();
}

function toggleSettingsMenu() {
  const menu = document.getElementById('settings-menu');
  menu.classList.toggle('hidden');
  if (!menu.classList.contains('hidden')) {
    setTimeout(() => {
      document.addEventListener('click', closeSettingsMenu, { once: true });
    }, 0);
  }
}

function closeSettingsMenu() {
  document.getElementById('settings-menu')?.classList.add('hidden');
}

async function confirmUninstall() {
  closeSettingsMenu();
  await window.api.app.uninstall();
}

async function init() {
  // Check current server status
  const status = await window.api.server.status();

  if (status.status === 'running') {
    serverUrl = status.url;
    setLoadingStatus('Connecting to Open WebUI...');
    showWebView(serverUrl);
    return;
  }

  // Subscribe to server events
  const unsubLog = window.api.server.onLog((data) => {
    if (data.text) setLoadingStatus(data.text.slice(0, 80));
  });

  const unsubReady = window.api.server.onReady((data) => {
    unsubLog();
    unsubReady();
    serverUrl = data.url;
    setLoadingStatus('Open WebUI is ready!');
    setTimeout(() => showWebView(serverUrl), 500);
  });

  const unsubState = window.api.server.onStateChange((data) => {
    if (data.status === 'error' || data.status === 'stopped') {
      unsubLog();
      unsubReady();
      unsubState();
      showError(`Server stopped unexpectedly. Code: ${data.code ?? 'unknown'}`);
    }
  });

  // Set startup timeout
  startupTimer = setTimeout(() => {
    unsubLog();
    unsubReady();
    unsubState();
    showError('Server did not start within 2 minutes. Check logs for details.');
  }, STARTUP_TIMEOUT_MS);

  // Start the server
  setLoadingStatus('Starting Open WebUI server...');
  const result = await window.api.server.start();

  if (!result.success) {
    clearTimeout(startupTimer);
    unsubLog();
    unsubReady();
    unsubState();
    showError(result.error || 'Failed to start server.');
  }
}

document.addEventListener('DOMContentLoaded', init);
