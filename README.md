<div align="center">

<img src="assets/icon.png" width="120" alt="Open WebUI Desktop Logo" />

# Open WebUI Desktop

**A native desktop wrapper that installs, manages, and runs [Open WebUI](https://github.com/open-webui/open-webui) locally — no Docker, no terminal, no setup.**

[![Build](https://github.com/saiteja007-mv/open-webui-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/saiteja007-mv/open-webui-desktop/actions/workflows/build.yml)
[![Release Testing](https://github.com/saiteja007-mv/open-webui-desktop/actions/workflows/release-test.yml/badge.svg)](https://github.com/saiteja007-mv/open-webui-desktop/actions/workflows/release-test.yml)
[![Latest Release](https://img.shields.io/github/v/release/saiteja007-mv/open-webui-desktop?label=latest)](https://github.com/saiteja007-mv/open-webui-desktop/releases/latest)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#-download)
[![Electron](https://img.shields.io/badge/Electron-v33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)

</div>

---

## ✨ What It Does

Open WebUI Desktop wraps the full [Open WebUI](https://github.com/open-webui/open-webui) AI chat interface into a single installable desktop app. First launch walks you through a guided installer — it handles Python detection, virtual environment creation, and package installation automatically. After that, just open the app and your local AI interface is ready.

- 🔒 **Fully local** — no cloud dependency, all data stays on your machine
- ⚡ **One-click install** — guided wizard installs Open WebUI into an isolated Python venv
- 🖥️ **Pure black UI** — matches Open WebUI's native aesthetic
- 🔄 **Server lifecycle management** — starts, monitors, and restarts the server automatically
- 🗑️ **Clean uninstall** — removes the venv and all packages from within the app

---

## 📥 Download

| Platform | Installer | Format |
|----------|-----------|--------|
| 🪟 **Windows** | [Open.WebUI.Desktop.Setup.1.2.0.exe](https://github.com/saiteja007-mv/open-webui-desktop/releases/latest) | NSIS one-click installer |
| 🪟 **Windows Portable** | [Open.WebUI.Desktop.1.2.0.exe](https://github.com/saiteja007-mv/open-webui-desktop/releases/latest) | No install required |
| 🍎 **macOS (Intel)** | [Open.WebUI.Desktop-1.2.0.dmg](https://github.com/saiteja007-mv/open-webui-desktop/releases/latest) | DMG disk image |
| 🍎 **macOS (Apple Silicon)** | [Open.WebUI.Desktop-1.2.0-arm64.dmg](https://github.com/saiteja007-mv/open-webui-desktop/releases/latest) | DMG disk image |
| 🐧 **Linux (Debian/Ubuntu)** | [open-webui-desktop_1.2.0_amd64.deb](https://github.com/saiteja007-mv/open-webui-desktop/releases/latest) | `.deb` package |
| 🐧 **Linux (AppImage)** | [Open.WebUI.Desktop-1.2.0.AppImage](https://github.com/saiteja007-mv/open-webui-desktop/releases/latest) | Portable AppImage |

> **Linux note:** After `dpkg -i`, the post-install script automatically fixes sandbox permissions and creates the `/usr/bin/open-webui-desktop` launcher. No manual steps required.

---

## 🏗️ Architecture

### Application Flow

```mermaid
flowchart TD
    A([App Launch]) --> B{setupComplete\n+ venv exists?}
    B -- Yes --> C[Load app.html]
    B -- No --> D[Load setup.html]

    D --> E[Welcome Screen\nDetect Python & env]
    E --> F[Install Wizard]
    F --> F1[Step 1: Python]
    F1 --> F2[Step 2: Virtual Env]
    F2 --> F3[Step 3: Upgrade pip]
    F3 --> F4[Step 4: Install open-webui]
    F4 --> F5[Step 5: Verify]
    F5 -- success --> G[Mark setupComplete=true]
    G --> C

    C --> H[Start Server]
    H --> I{Server Ready?}
    I -- yes --> J[Show Webview\nopenwebui at localhost:8080]
    I -- timeout/error --> K[Error Screen\nRestart · Logs · Reinstall]
    K --> H
```

### IPC Architecture

```mermaid
graph LR
    subgraph Renderer["🖥️ Renderer Process"]
        R1[app.html / app.js]
        R2[setup.html / setup.js]
    end

    subgraph Bridge["🔒 preload.js\ncontextBridge"]
        P1[window.api.setup.*]
        P2[window.api.server.*]
        P3[window.api.app.*]
    end

    subgraph Main["⚙️ Main Process — main.js"]
        M1[IPC Handlers]
        M2[BrowserWindow]
        M3[Tray]
        M4[electron-store]
    end

    subgraph Scripts["📦 scripts/"]
        S1[python-manager.js]
        S2[venv-manager.js]
        S3[server-manager.js]
        S4[utils.js]
    end

    R1 <--> Bridge
    R2 <--> Bridge
    Bridge <--> M1
    M1 --> S1
    M1 --> S2
    M1 --> S3
    M1 --> S4
    S3 -- events --> M1
    M1 -- server:state\nserver:ready\nserver:log --> R1
```

### Server Lifecycle

```mermaid
stateDiagram-v2
    [*] --> idle : App starts

    idle --> starting : server.start() called
    starting --> running : HTTP health check passes
    starting --> error : timeout (120s) or spawn fail
    running --> stopped : server.stop() or app quit
    stopped --> starting : server.restart() or Retry click
    error --> starting : Restart button clicked
    running --> error : Process exits unexpectedly

    note right of running
        Emits onReady({ url })
        Webview loads localhost:8080
    end note

    note right of error
        Error screen shown
        isUninstalling flag suppresses
        state events during uninstall
    end note
```

### CI/CD Pipeline

```mermaid
flowchart LR
    subgraph Trigger
        T1[git push v*.*.*]
        T2[workflow_dispatch]
    end

    subgraph build.yml["🔨 build.yml"]
        direction TB
        BW[🪟 build-windows\nNSIS + Portable .exe]
        BM[🍎 build-mac\nDMG x64 + arm64]
        BL[🐧 build-linux\nAppImage + .deb]
        BR[📦 release\nCreate GitHub Release\n+ upload all artifacts]
        BW --> BR
        BM --> BR
        BL --> BR
    end

    subgraph release-test.yml["🧪 release-test.yml"]
        direction TB
        GR[📦 Fetch Release Info\ndetect asset filenames]
        TW[🪟 test-windows\nsilent install · process check\ndesktop screenshot]
        TM[🍎 test-macos\nDMG mount · bundle verify\nlaunch · screenshot]
        TL[🐧 test-linux\ndpkg install · Xvfb\nscrot screenshot]
        TS[📊 Summary\npass/fail table\n+ artifact links]
        GR --> TW & TM & TL
        TW & TM & TL --> TS
    end

    T1 --> build.yml
    T2 --> release-test.yml
    BR -.->|"release published\ntriggers auto-test"| release-test.yml
```

### Linux Installation Flow

```mermaid
sequenceDiagram
    participant U as User
    participant D as dpkg
    participant P as linux-postinstall.sh
    participant S as System

    U->>D: sudo dpkg -i open-webui-desktop_1.2.0_amd64.deb
    D->>S: Extract files to /opt/Open WebUI Desktop/
    D->>P: Run post-install script (as root)
    P->>S: Detect install dir (handles spaces in path)
    P->>S: chown root:root chrome-sandbox
    P->>S: chmod 4755 chrome-sandbox
    P->>S: Detect Ubuntu ≥23.10 → set --no-sandbox in wrapper
    P->>S: Write /usr/bin/open-webui-desktop (launcher)
    P->>S: Write /usr/share/applications/open-webui-desktop.desktop
    P->>S: Copy icon → /usr/share/icons/hicolor/512x512/apps/
    P->>S: update-desktop-database
    P->>S: gtk-update-icon-cache
    P-->>U: ✅ App icon appears in application menu
    U->>S: Click app icon
    S->>S: Launch /usr/bin/open-webui-desktop
    Note over S: Wrapper auto-adds --no-sandbox if needed
```

---

## 🛠️ Development

### Prerequisites

- **Node.js** 18+
- **npm** 9+
- **Python** 3.10+ (for running Open WebUI locally)

### Setup

```bash
git clone https://github.com/saiteja007-mv/open-webui-desktop.git
cd open-webui-desktop
npm install
npm start
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run in development (`electron .`) |
| `npm run build:win` | Build Windows `.exe` installers → `dist/` |
| `npm run build:mac` | Build macOS `.dmg` (x64 + arm64) → `dist/` |
| `npm run build:linux` | Build `.AppImage` + `.deb` → `dist/` |
| `npm run build:all` | Build all platforms |

---

## 📁 Project Structure

```
open-webui-desktop/
├── main.js                    # Electron main process
│                              # Window · Tray · IPC · server lifecycle
├── preload.js                 # contextBridge API (window.api)
├── package.json               # electron-builder config in "build" field
│
├── src/
│   ├── app.html / app.js      # Main window: webview + loading/error screens
│   ├── app.css                # Pure black theme (#000000)
│   ├── setup.html / setup.js  # First-run installation wizard
│   └── setup.css
│
├── scripts/
│   ├── python-manager.js      # Python detection & installation
│   ├── venv-manager.js        # venv creation, pip, open-webui install
│   ├── server-manager.js      # Spawn open-webui.exe, health check, events
│   └── utils.js               # Paths, logging helpers
│
├── assets/
│   ├── icon.png               # App icon  (512×512)
│   └── tray-icon.png          # Tray icon (256×256)
│
├── build/
│   ├── linux-postinstall.sh   # deb post-install: sandbox · launcher · .desktop
│   └── open-webui-desktop.desktop
│
└── .github/workflows/
    ├── build.yml              # Build & release (on v* tag)
    └── release-test.yml       # Cross-platform install tests
```

---

## 🚀 Releasing

```bash
# 1. Bump version in package.json
# 2. Commit, tag, push — CI does the rest
git add package.json
git commit -m "vX.Y.Z — description"
git tag vX.Y.Z
git push origin master && git push origin vX.Y.Z
```

The `build.yml` workflow builds all 3 platforms in parallel and publishes a GitHub Release automatically. The `release-test.yml` workflow then runs cross-platform install/launch tests and uploads screenshots as artifacts.

---

## 🔒 Security & Privacy

- All processing is **100% local** — no data ever leaves your machine
- Open WebUI runs inside an isolated Python virtual environment
- The Electron renderer uses `contextIsolation: true` with a strict `contextBridge` — no `nodeIntegration`
- Content Security Policy enforced on all HTML pages

---

## 📋 Requirements

| Platform | Minimum | Notes |
|----------|---------|-------|
| Windows | Windows 10 x64 | Unsigned installer — SmartScreen may warn |
| macOS | macOS 10.13 (x64) / 11.0 (arm64) | Unsigned — right-click → Open to bypass Gatekeeper |
| Linux | Ubuntu 20.04+ / Debian 11+ | `.deb` or AppImage; post-install handles sandbox setup |
| Python | 3.10+ | Auto-detected; installer can download if missing |
| Disk | ~2 GB | For Open WebUI and its dependencies |
| RAM | 4 GB+ | 8 GB recommended for running LLMs |

---

<div align="center">

Built with [Electron](https://electronjs.org) · Powered by [Open WebUI](https://github.com/open-webui/open-webui)

</div>
