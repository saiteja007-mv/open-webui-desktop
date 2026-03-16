#!/bin/bash
# Post-install script for Open WebUI Desktop (deb package)
# Fixes: chrome-sandbox SUID, path-with-spaces, AppArmor, desktop launcher

set -e

# ── Locate install directory ──────────────────────────────────────────────────
# electron-builder may use productName (with spaces) or executableName (no spaces)
if   [ -d "/opt/open-webui-desktop" ];    then APP_DIR="/opt/open-webui-desktop"
elif [ -d "/opt/Open WebUI Desktop" ];    then APP_DIR="/opt/Open WebUI Desktop"
elif [ -d "/opt/openwebui-desktop" ];     then APP_DIR="/opt/openwebui-desktop"
else
  APP_DIR=$(find /opt -maxdepth 1 -iname "*open*webui*" -type d 2>/dev/null | head -1)
fi

if [ -z "$APP_DIR" ]; then
  echo "Warning: Could not locate Open WebUI Desktop install directory" >&2
  exit 0
fi

EXEC_BIN="$APP_DIR/open-webui-desktop"
# Fallback: find the actual binary
if [ ! -f "$EXEC_BIN" ]; then
  EXEC_BIN=$(find "$APP_DIR" -maxdepth 1 -type f -executable ! -name "*.so*" ! -name "chrome-sandbox" | head -1)
fi

# ── Fix chrome-sandbox SUID permissions (Issues #1 & #5) ─────────────────────
SANDBOX="$APP_DIR/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX" 2>/dev/null || true
  chmod 4755 "$SANDBOX"       2>/dev/null || true
fi

# ── Detect if sandbox is usable ───────────────────────────────────────────────
SANDBOX_OK=0
if [ -f "$SANDBOX" ] && [ "$(stat -c '%u' "$SANDBOX" 2>/dev/null)" = "0" ]; then
  PERMS=$(stat -c '%a' "$SANDBOX" 2>/dev/null)
  if [ "$PERMS" = "4755" ]; then
    SANDBOX_OK=1
  fi
fi

# Ubuntu 23.10+ uses unprivileged namespace restriction → always need --no-sandbox
if grep -q "ubuntu" /etc/os-release 2>/dev/null; then
  UBUNTU_VER=$(grep "^VERSION_ID=" /etc/os-release | tr -d '"' | cut -d= -f2 | cut -d. -f1)
  if [ "${UBUNTU_VER:-0}" -ge 23 ] 2>/dev/null; then
    SANDBOX_OK=0
  fi
fi

# ── Create smart launcher at /usr/bin/open-webui-desktop ─────────────────────
LAUNCHER="/usr/bin/open-webui-desktop"
if [ "$SANDBOX_OK" = "1" ]; then
  cat > "$LAUNCHER" << LAUNCHEREOF
#!/bin/bash
exec "${EXEC_BIN}" "\$@"
LAUNCHEREOF
else
  cat > "$LAUNCHER" << LAUNCHEREOF
#!/bin/bash
exec "${EXEC_BIN}" --no-sandbox --disable-dev-shm-usage "\$@"
LAUNCHEREOF
fi
chmod +x "$LAUNCHER"

# ── Install desktop file ──────────────────────────────────────────────────────
DESKTOP_DIR="/usr/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/open-webui-desktop.desktop"

mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_FILE" << DESKTOPEOF
[Desktop Entry]
Name=Open WebUI Desktop
Comment=Your local AI interface — fully private, fully yours
GenericName=AI Interface
Exec=/usr/bin/open-webui-desktop %U
Terminal=false
Type=Application
Icon=open-webui-desktop
StartupWMClass=open-webui-desktop
StartupNotify=true
Categories=Utility;Network;Science;
Keywords=AI;chat;local;openwebui;llm;
DESKTOPEOF
chmod 644 "$DESKTOP_FILE"

# ── Install icon ──────────────────────────────────────────────────────────────
ICON_SRC="$APP_DIR/resources/assets/icon.png"
if [ -f "$ICON_SRC" ]; then
  ICON_DIR="/usr/share/icons/hicolor/512x512/apps"
  mkdir -p "$ICON_DIR"
  cp "$ICON_SRC" "$ICON_DIR/open-webui-desktop.png"
fi

# ── Refresh system databases ──────────────────────────────────────────────────
command -v update-desktop-database &>/dev/null && \
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

command -v gtk-update-icon-cache &>/dev/null && \
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true

command -v xdg-mime &>/dev/null && \
  xdg-mime default open-webui-desktop.desktop x-scheme-handler/openwebui 2>/dev/null || true

exit 0
