'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Setup operations
  setup: {
    checkEnv: () => ipcRenderer.invoke('setup:check-env'),
    install: () => ipcRenderer.invoke('setup:install'),
    cancelInstall: () => ipcRenderer.invoke('setup:cancel-install'),
    isInstalled: () => ipcRenderer.invoke('setup:is-installed'),
    getVersion: () => ipcRenderer.invoke('setup:get-version'),
    update: () => ipcRenderer.invoke('setup:update'),
    onProgress: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('setup:progress', handler);
      return () => ipcRenderer.removeListener('setup:progress', handler);
    },
  },

  // Server operations
  server: {
    start: () => ipcRenderer.invoke('server:start'),
    stop: () => ipcRenderer.invoke('server:stop'),
    restart: () => ipcRenderer.invoke('server:restart'),
    status: () => ipcRenderer.invoke('server:status'),
    onLog: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('server:log', handler);
      return () => ipcRenderer.removeListener('server:log', handler);
    },
    onReady: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('server:ready', handler);
      return () => ipcRenderer.removeListener('server:ready', handler);
    },
    onStateChange: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('server:state', handler);
      return () => ipcRenderer.removeListener('server:state', handler);
    },
  },

  // App-level
  app: {
    platform: process.platform,
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    showLogs: () => ipcRenderer.invoke('app:show-logs'),
    navigateToApp: () => ipcRenderer.send('app:navigate-to-app'),
    uninstall: () => ipcRenderer.invoke('app:uninstall'),
  },
});
