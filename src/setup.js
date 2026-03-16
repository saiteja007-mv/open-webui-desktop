'use strict';

const MAX_LOG_LINES = 500;
let currentStep = 0;
let logLines = [];
let unsubProgress = null;

// ── Screen management ─────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const screen = document.getElementById(`screen-${id}`);
  if (screen) screen.classList.add('active');
}

// ── Steps ────────────────────────────────────────────────────────────────────

function setStep(stepNum) {
  currentStep = stepNum;
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`step-${i}`);
    if (!el) continue;
    el.classList.remove('active', 'done', 'error');
    if (i < stepNum) el.classList.add('done');
    else if (i === stepNum) el.classList.add('active');
  }
}

function markStepError(stepNum) {
  const el = document.getElementById(`step-${stepNum}`);
  if (el) {
    el.classList.remove('active');
    el.classList.add('error');
  }
}

function setStepText(text) {
  const el = document.getElementById('step-text');
  if (el) el.textContent = text;
}

// ── Log ──────────────────────────────────────────────────────────────────────

function appendLog(text, type = '') {
  const logEl = document.getElementById('log-output');
  if (!logEl) return;

  // Trim old lines to prevent memory issues
  logLines.push({ text, type });
  if (logLines.length > MAX_LOG_LINES) logLines.shift();

  const cls = type === 'error' ? 'log-entry-error'
    : type === 'warn' ? 'log-entry-warn'
    : type === 'success' ? 'log-entry-success'
    : '';

  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  logEl.appendChild(span);

  // Auto-scroll to bottom
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logLines = [];
  const logEl = document.getElementById('log-output');
  if (logEl) logEl.innerHTML = '';
}

// ── Progress Bar ─────────────────────────────────────────────────────────────

function setProgress(value) {
  const wrap = document.getElementById('progress-wrap');
  const fill = document.getElementById('progress-fill');
  const pct = document.getElementById('progress-pct');
  if (value > 0) {
    wrap?.classList.remove('hidden');
    if (fill) fill.style.width = `${Math.min(100, value)}%`;
    if (pct) pct.textContent = `${Math.round(value)}%`;
  } else {
    wrap?.classList.add('hidden');
  }
}

// ── Progress Event Handler ────────────────────────────────────────────────────

function handleProgress(data) {
  if (!data) return;

  switch (data.type) {
    case 'step':
      setStep(data.step);
      if (data.text) setStepText(data.text);
      appendLog(`\n▶ ${data.text || data.stepName}`, 'success');
      break;

    case 'log': {
      const text = data.text || '';
      // Classify log line
      const isError = /error|failed|exception/i.test(text);
      const isWarn = /warning|warn/i.test(text);
      appendLog(text, isError ? 'error' : isWarn ? 'warn' : '');
      break;
    }

    case 'progress':
      setProgress(data.value || 0);
      break;

    case 'complete':
      // Mark all steps done
      for (let i = 1; i <= 5; i++) {
        const el = document.getElementById(`step-${i}`);
        if (el) { el.classList.remove('active', 'error'); el.classList.add('done'); }
      }
      setProgress(100);
      const versionEl = document.getElementById('complete-version');
      if (versionEl) versionEl.textContent = data.version ? `Version ${data.version} installed successfully.` : 'Installation complete.';
      showScreen('complete');
      break;

    case 'error':
      markStepError(currentStep);
      const errEl = document.getElementById('error-message');
      if (errEl) errEl.textContent = data.error || 'An unknown error occurred.';
      showScreen('error');
      break;
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function startInstall() {
  showScreen('installing');
  clearLog();
  setStep(1);
  setStepText('Preparing...');
  setProgress(0);

  appendLog('Starting Open WebUI installation...');
  appendLog(`Platform: ${window.api.app.platform}`);
  appendLog('');

  // Subscribe to progress events
  if (unsubProgress) unsubProgress();
  unsubProgress = window.api.setup.onProgress(handleProgress);

  // Kick off installation (runs in main process)
  window.api.setup.install().catch((err) => {
    handleProgress({ type: 'error', error: err.message });
  });
}

async function retryInstall() {
  startInstall();
}

function launchApp() {
  window.api.app.navigateToApp();
}

function showLogs() {
  window.api.app.showLogs();
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    // Check if already installed
    const isInstalled = await window.api.setup.isInstalled();
    if (isInstalled) {
      // Go straight to app
      window.api.app.navigateToApp();
      return;
    }

    // Load environment info
    const env = await window.api.setup.checkEnv();
    if (env && !env.error) {
      const envCard = document.getElementById('env-info');
      const platEl = document.getElementById('env-platform');
      const pyEl = document.getElementById('env-python');
      const statusEl = document.getElementById('env-status');

      const platNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
      if (platEl) platEl.textContent = platNames[env.platform] || env.platform || '—';
      if (pyEl) pyEl.textContent = env.python?.found ? `${env.python.version} found` : 'Will be installed';
      if (statusEl) statusEl.textContent = env.installed ? `Open WebUI ${env.version || ''} (already installed)` : 'Not installed';
      envCard?.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Init error:', err);
  }
}

// Start
document.addEventListener('DOMContentLoaded', init);
