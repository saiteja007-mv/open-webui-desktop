# open-webui-desktop

A cross-platform Electron desktop wrapper that automatically installs and runs Open WebUI locally. Ships native installers for Windows, macOS, and Linux via GitHub Actions CI/CD.

## Project Context

- **Goal:** Package Open WebUI as a native desktop app — handles Python venv setup, server lifecycle, and UI in one click
- **Releases:** Published on GitHub Releases (v1.0.0, v1.1.0, v1.2.0+)
- **Testing:** No access to other machines — all cross-platform testing is done via GitHub Actions CI
- **Owner:** Saiteja (F-1 student, CS + Data Science @ UCM)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | **Electron v33** (`electron`) |
| Packaging | **electron-builder v25** |
| IPC security | `contextBridge` + `contextIsolation: true` |
| Persistence | `electron-store` (setupComplete, installedVersion, windowBounds) |
| Python runtime | Auto-detected system Python 3.x → managed venv |
| Server | `open-webui.exe` binary inside venv |
| CI/CD | GitHub Actions (`.github/workflows/build.yml`) |
| Platforms | Windows (.exe + portable), macOS (.dmg x64/arm64), Linux (.AppImage + .deb) |

## Key Commands

```bash
npm install          # Install dependencies
npm start            # Run in development (electron .)
npm run build:win    # Build Windows installers → dist/
npm run build:mac    # Build macOS DMGs → dist/
npm run build:linux  # Build Linux AppImage + deb → dist/
npm run build:all    # Build all platforms → dist/
```

> There is no `dev`, `test`, or `watch` script. Development = `npm start`.

## File Structure

```
open-webui-desktop/
├── main.js                        ← Electron main process (window, tray, IPC, server lifecycle)
├── preload.js                     ← contextBridge API surface (window.api)
├── package.json                   ← electron-builder config inside "build" field
│
├── src/
│   ├── app.html / app.css / app.js      ← Main app window (webview + loading/error screens)
│   └── setup.html / setup.css / setup.js ← First-run installer wizard
│
├── scripts/
│   ├── python-manager.js          ← Detects / installs Python
│   ├── venv-manager.js            ← Creates venv, installs open-webui via pip
│   ├── server-manager.js          ← Spawns open-webui.exe, health checks, lifecycle events
│   └── utils.js                   ← Paths (appData, venv, logs), logging helpers
│
├── assets/
│   ├── icon.png / icon.svg        ← App icon (512×512 PNG, SVG source)
│   └── tray-icon.png / tray-icon.svg ← System tray icon (256×256 PNG, SVG source)
│
├── build/
│   ├── linux-postinstall.sh       ← deb post-install: fixes chrome-sandbox, writes .desktop, installs icon
│   └── open-webui-desktop.desktop ← Linux desktop entry template
│
├── .github/workflows/
│   ├── build.yml                  ← Build + release pipeline (triggered on v* tags)
│   └── release-test.yml           ← Cross-platform install/launch testing
│
├── open-webui-logo.png            ← Source logo (used to generate assets/icon.png at 512×512)
├── open-webui-trayicon.png        ← Source tray logo (used to generate assets/tray-icon.png at 256×256)
└── CLAUDE.md                      ← This file
```

## Architecture

### IPC API (`preload.js` → `window.api`)
```
window.api.setup.checkEnv()         → platform, python, installed, version
window.api.setup.install()          → streams progress events via setup:progress
window.api.server.start/stop/restart/status()
window.api.server.onStateChange(cb) → 'starting' | 'running' | 'stopped' | 'error'
window.api.server.onReady(cb)       → { url }
window.api.app.uninstall()          → deletes venv, resets store, quits app
window.api.app.showLogs()           → opens logs directory in file manager
```

### Startup flow
1. `app.whenReady()` checks `store.setupComplete` + `venvManager.checkInstallation()`
2. If installed → `app.html` (starts server, shows webview once ready)
3. If not installed → `setup.html` (wizard: Python → venv → pip → open-webui → verify)

### Server lifecycle
- `server-manager.js` spawns `open-webui.exe` from the venv `Scripts/` directory
- Emits `onStateChange` (starting / running / stopped / error) and `onReady({ url })`
- `isUninstalling` flag in `main.js` suppresses state-change forwarding during uninstall to prevent the error screen from appearing

## Platform Notes

### Linux
- `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu-sandbox`, `--disable-gpu` applied at startup via `app.commandLine.appendSwitch()` before `app.whenReady()`
- `executableName: "open-webui-desktop"` avoids spaces in the installed binary path
- `build/linux-postinstall.sh` runs automatically after `dpkg -i`:
  - Fixes `chrome-sandbox` SUID permissions (`chown root:root` + `chmod 4755`)
  - Detects Ubuntu ≥23.10 (unprivileged namespaces) → adds `--no-sandbox` to wrapper
  - Creates smart launcher at `/usr/bin/open-webui-desktop`
  - Writes correct `.desktop` file to `/usr/share/applications/`
  - Installs icon to `/usr/share/icons/hicolor/512x512/apps/`

### macOS
- Builds both `x64` and `arm64` DMGs in one CI job (`macos-latest`)
- Code signing skipped (`CSC_IDENTITY_AUTO_DISCOVERY: false`) — unsigned builds

### Windows
- NSIS one-click installer + standalone portable `.exe`
- Code signing disabled (`sign: null`) — unsigned builds

## CI/CD Pipeline

### `build.yml` — Build & Release
Triggered by: pushing a `v*` tag (e.g. `git tag v1.2.0 && git push origin v1.2.0`)

1. Runs 3 parallel jobs: `build-windows` / `build-mac` / `build-linux`
2. Each builds with `--publish=never` (no auto-upload during build step)
3. `release` job (waits for all 3) creates GitHub Release + uploads all dist artifacts
4. Can also be triggered manually via `workflow_dispatch`

### `release-test.yml` — Cross-Platform Testing
Triggered by: GitHub Release published, or manually with a tag

| Job | Runner | What it tests |
|-----|--------|---------------|
| `get-release` | ubuntu | Fetches release assets, detects installer URLs by extension |
| `test-windows` | windows-latest | Silent install, process launch check, desktop screenshot |
| `test-macos` | macos-latest | DMG mount, app bundle structure verify, launch + PID check |
| `test-linux` | ubuntu-latest | deb/AppImage install, Xvfb virtual display, scrot screenshot |
| `test-summary` | ubuntu | Writes pass/fail markdown table to Actions summary |

Artifacts uploaded per run (7-day retention): `screenshot-windows.png`, `screenshot-macos.png`, `screenshot-linux.png`

### To ship a new release:
```bash
# Bump version in package.json first, then:
git add package.json && git commit -m "vX.Y.Z — description"
git tag vX.Y.Z && git push origin master && git push origin vX.Y.Z
```

### To manually test an existing release:
Actions → "Cross-Platform Release Testing" → Run workflow → enter tag (e.g. `v1.2.0`)

## Regenerating Icons

```bash
# Requires: npm install sharp
node -e "
const sharp = require('sharp');
sharp('./open-webui-logo.png').resize(512,512).png().toFile('./assets/icon.png');
sharp('./open-webui-trayicon.png').resize(256,256).png().toFile('./assets/tray-icon.png');
"
```

## Code Rules

- Use `process.platform` for platform-specific branches (`win32`, `darwin`, `linux`)
- Never hardcode paths — use `utils.getAppDataPath()`, `utils.getVenvPath()`, `app.getPath()`
- All renderer↔main communication goes through `preload.js` contextBridge (no `nodeIntegration`)
- `img-src` CSP must include `file:` to allow loading local assets in packaged asar builds
- Theme: pure black (`#000000` background, `#ffffff` text) matching Open WebUI's aesthetic

## CI Troubleshooting

| Symptom | Fix |
|---------|-----|
| Installer not found in release-test | Asset filenames must end in `.exe`/`.msi` (Win), `.dmg` (Mac), `.AppImage`/`.deb` (Linux) |
| macOS test skipped | Verify DMG was uploaded to the release (not just the zip) |
| Linux app won't launch | Ensure `--no-sandbox` is passed; check chrome-sandbox permissions via post-install script |
| Logo missing in loading screen | Verify `img-src` CSP includes `file:` in both `app.html` and `setup.html` |
| Build fails — GH_TOKEN not set | Workflow passes `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` automatically — re-check workflow env block |
| Build fails — author email missing | `package.json` must have `"author": { "name": "...", "email": "..." }` for deb packaging |
| Screenshots missing in test run | Xvfb failed to start — check `test-linux` job logs for display server errors |
