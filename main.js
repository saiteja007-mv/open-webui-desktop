'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ─── Linux Compatibility Flags ───────────────────────────────────────────────
// Must be called before app is ready.
// Fixes: chrome-sandbox SUID permissions, AppArmor restrictions, GPU launch failures.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  // Gracefully fall back to software rendering if GPU process fails
  app.commandLine.appendSwitch('disable-gpu');
}

// Modules — loaded after app path is available
let utils, pythonManager, venvManager, serverManager, store;

let mainWindow = null;
let tray = null;
let isQuitting = false;
let installCancelled = false;
let isUninstalling = false;

// ─── Initialization ─────────────────────────────────────────────────────────

function initModules() {
  utils = require('./scripts/utils');
  pythonManager = require('./scripts/python-manager');
  venvManager = require('./scripts/venv-manager');
  serverManager = require('./scripts/server-manager');

  const Store = require('electron-store');
  store = new Store({
    defaults: {
      setupComplete: false,
      installedVersion: null,
      windowBounds: { width: 1280, height: 800 },
      firstMinimize: true,
    },
  });
}

// ─── Window Management ──────────────────────────────────────────────────────

function createWindow(page) {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    title: 'Open WebUI Desktop',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // Enable <webview> tag for embedding open-webui
    },
    icon: getAppIcon(),
  });

  mainWindow.loadFile(path.join(__dirname, 'src', page));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools();
    }
  });

  mainWindow.on('resize', () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getSize();
    store.set('windowBounds', { width, height });
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();

      // Show notification on first minimize to tray
      if (store.get('firstMinimize') && tray) {
        store.set('firstMinimize', false);
        tray.displayBalloon?.({
          iconType: 'info',
          title: 'Open WebUI Desktop',
          content: 'Running in the background. Right-click the tray icon to quit.',
        });
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function getAppIcon() {
  const iconDir = path.join(__dirname, 'assets');
  if (process.platform === 'win32') {
    const ico = path.join(iconDir, 'icon.ico');
    if (fs.existsSync(ico)) return ico;
  } else if (process.platform === 'darwin') {
    const icns = path.join(iconDir, 'icon.icns');
    if (fs.existsSync(icns)) return icns;
  }
  const png = path.join(iconDir, 'icon.png');
  if (fs.existsSync(png)) return png;
  return undefined;
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray() {
  const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const iconImage = fs.existsSync(trayIconPath)
    ? nativeImage.createFromPath(trayIconPath)
    : nativeImage.createEmpty();

  tray = new Tray(iconImage);
  tray.setToolTip('Open WebUI Desktop');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const status = serverManager ? serverManager.getStatus() : { status: 'stopped' };
  const isRunning = status.status === 'running';

  const menu = Menu.buildFromTemplate([
    { label: 'Open WebUI Desktop', enabled: false },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: isRunning ? 'Stop Server' : 'Start Server',
      click: async () => {
        if (isRunning) {
          await serverManager.stopServer();
        } else {
          try {
            await serverManager.startServer();
            navigateToApp();
          } catch (err) {
            utils.log(`Tray start server error: ${err.message}`);
          }
        }
        updateTrayMenu();
      },
    },
    {
      label: 'Open in Browser',
      enabled: isRunning,
      click: () => {
        if (isRunning) shell.openExternal(status.url);
      },
    },
    { type: 'separator' },
    {
      label: 'Uninstall Open WebUI...',
      click: () => uninstallOpenWebUI(),
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ─── Navigation ─────────────────────────────────────────────────────────────

function navigateToApp() {
  if (!mainWindow) {
    createWindow('app.html');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'src', 'app.html'));
  }
}

function navigateToSetup() {
  if (!mainWindow) {
    createWindow('setup.html');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'src', 'setup.html'));
  }
}

// ─── Uninstall ───────────────────────────────────────────────────────────────

async function uninstallOpenWebUI() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Uninstall Open WebUI',
    message: 'Remove Open WebUI?',
    detail: 'This will delete the Python virtual environment and all installed packages. Your chat data and settings will be preserved. You can reinstall at any time.',
    buttons: ['Uninstall', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });

  if (response !== 0) return { cancelled: true };

  isUninstalling = true;

  // Stop server first (suppress state-change events so renderer doesn't show error)
  try { await serverManager.stopServer(); } catch (_) {}

  // Delete venv
  const venvPath = utils.getVenvPath();
  try {
    if (fs.existsSync(venvPath)) {
      fs.rmSync(venvPath, { recursive: true, force: true });
    }
  } catch (err) {
    isUninstalling = false;
    utils.log(`Uninstall error deleting venv: ${err.message}`);
    return { success: false, error: err.message };
  }

  // Reset store
  store.set('setupComplete', false);
  store.set('installedVersion', null);

  utils.log('Uninstall complete — quitting app');
  isQuitting = true;
  app.quit();
  return { success: true };
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────

function registerIpcHandlers() {
  // ── Setup ──
  ipcMain.handle('setup:check-env', async () => {
    try {
      const python = await pythonManager.checkPython();
      const installed = await venvManager.checkInstallation();
      const version = await venvManager.getInstalledVersion();
      return {
        platform: process.platform,
        arch: process.arch,
        appDataPath: utils.getAppDataPath(),
        python,
        installed,
        version,
      };
    } catch (err) {
      utils.log(`check-env error: ${err.message}`);
      return { error: err.message };
    }
  });

  ipcMain.handle('setup:is-installed', async () => {
    return store.get('setupComplete') && await venvManager.checkInstallation();
  });

  ipcMain.handle('setup:get-version', async () => {
    return venvManager.getInstalledVersion();
  });

  ipcMain.handle('setup:install', async (event) => {
    installCancelled = false;
    const sender = event.sender;

    const onProgress = (data) => {
      if (!sender.isDestroyed()) {
        sender.send('setup:progress', data);
      }
    };

    try {
      // Step 1: Check/install Python
      onProgress({ type: 'step', step: 1, stepName: 'Python', text: 'Setting up Python...' });
      const pythonPath = await pythonManager.ensurePython(onProgress);
      if (installCancelled) throw new Error('Installation cancelled');

      // Step 2: Create virtual environment
      onProgress({ type: 'step', step: 2, stepName: 'Environment', text: 'Creating virtual environment...' });
      await venvManager.createVenv(pythonPath, onProgress);
      if (installCancelled) throw new Error('Installation cancelled');

      // Step 3: Upgrade pip
      onProgress({ type: 'step', step: 3, stepName: 'pip', text: 'Preparing package manager...' });
      await venvManager.upgradePip(onProgress);
      if (installCancelled) throw new Error('Installation cancelled');

      // Step 4: Install open-webui
      onProgress({ type: 'step', step: 4, stepName: 'Open WebUI', text: 'Installing Open WebUI...' });
      await venvManager.installOpenWebUI(onProgress);
      if (installCancelled) throw new Error('Installation cancelled');

      // Step 5: Verify
      onProgress({ type: 'step', step: 5, stepName: 'Verify', text: 'Verifying installation...' });
      const installed = await venvManager.checkInstallation();
      if (!installed) throw new Error('Installation verification failed — open-webui module not found');

      const version = await venvManager.getInstalledVersion();
      onProgress({ type: 'log', text: `Open WebUI ${version} installed successfully!` });

      // Mark setup complete
      store.set('setupComplete', true);
      store.set('installedVersion', version);

      onProgress({ type: 'complete', version });
      return { success: true, version };
    } catch (err) {
      utils.log(`Installation error: ${err.message}`);
      onProgress({ type: 'error', error: err.message });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('setup:cancel-install', () => {
    installCancelled = true;
  });

  ipcMain.handle('setup:update', async (event) => {
    const onProgress = (data) => {
      if (!event.sender.isDestroyed()) event.sender.send('setup:progress', data);
    };
    try {
      await venvManager.updateOpenWebUI(onProgress);
      const version = await venvManager.getInstalledVersion();
      store.set('installedVersion', version);
      onProgress({ type: 'complete', version });
      return { success: true, version };
    } catch (err) {
      onProgress({ type: 'error', error: err.message });
      return { success: false, error: err.message };
    }
  });

  // ── Server ──
  ipcMain.handle('server:start', async () => {
    try {
      const result = await serverManager.startServer();
      updateTrayMenu();
      return { success: true, ...result };
    } catch (err) {
      utils.log(`server:start error: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('server:stop', async () => {
    try {
      await serverManager.stopServer();
      updateTrayMenu();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('server:restart', async () => {
    try {
      const result = await serverManager.restartServer();
      updateTrayMenu();
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('server:status', () => {
    return serverManager.getStatus();
  });

  // ── App ──
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('app:open-external', (_event, url) => {
    shell.openExternal(url);
  });

  ipcMain.handle('app:show-logs', () => {
    shell.openPath(utils.getLogsDir());
  });

  ipcMain.on('app:navigate-to-app', () => {
    navigateToApp();
  });

  ipcMain.handle('app:uninstall', () => uninstallOpenWebUI());
}

// ─── Server Event Forwarding ─────────────────────────────────────────────────

function setupServerEventForwarding() {
  serverManager.onLog((data) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('server:log', data);
    }
  });

  serverManager.onReady((data) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('server:ready', data);
    }
    updateTrayMenu();
  });

  serverManager.onStateChange((data) => {
    if (!isUninstalling && mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('server:state', data);
    }
    updateTrayMenu();
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  initModules();
  registerIpcHandlers();
  setupServerEventForwarding();

  // Determine startup page
  const setupComplete = store.get('setupComplete');
  const installed = setupComplete ? await venvManager.checkInstallation() : false;

  if (installed) {
    createWindow('app.html');
  } else {
    store.set('setupComplete', false);
    createWindow('setup.html');
  }

  createTray();
});

app.on('window-all-closed', () => {
  // Don't quit when all windows are closed (tray app)
  // On macOS, this is standard behavior
});

app.on('activate', () => {
  // macOS: re-open window when dock icon is clicked
  if (mainWindow) {
    mainWindow.show();
  } else {
    const setupComplete = store.get('setupComplete');
    createWindow(setupComplete ? 'app.html' : 'setup.html');
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  utils.log('App quitting — stopping server');
  try {
    await serverManager.stopServer();
  } catch (_) {}
});
