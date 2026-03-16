#!/bin/bash
# Post-install script for Open WebUI Desktop (deb package)
# Fixes: chrome-sandbox permissions, AppArmor restrictions

APP_DIR="/opt/open-webui-desktop"
if [ ! -d "$APP_DIR" ]; then
  # Fallback: try product name with spaces
  APP_DIR="/opt/Open WebUI Desktop"
fi

# Fix chrome-sandbox SUID permissions (Issues #1 & #5)
SANDBOX="$APP_DIR/chrome-sandbox"
if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX" 2>/dev/null || true
  chmod 4755 "$SANDBOX" 2>/dev/null || true
fi

# Create a wrapper launcher that handles sandbox/GPU fallback (Issue #2 & #5)
LAUNCHER="/usr/bin/open-webui-desktop"
cat > "$LAUNCHER" << 'EOF'
#!/bin/bash
# Open WebUI Desktop launcher
APP_DIR="/opt/open-webui-desktop"
if [ ! -d "$APP_DIR" ]; then
  APP_DIR="/opt/Open WebUI Desktop"
fi

EXEC="$APP_DIR/open-webui-desktop"
if [ ! -f "$EXEC" ]; then
  # Try alternate executable names
  EXEC=$(find "$APP_DIR" -maxdepth 1 -type f -executable -name "*.desktop" 2>/dev/null | head -1)
  EXEC="$APP_DIR/open-webui-desktop"
fi

# Detect if running in an environment that needs --no-sandbox
NEEDS_NO_SANDBOX=0
if [ ! -f "$APP_DIR/chrome-sandbox" ] || [ "$(stat -c '%u' "$APP_DIR/chrome-sandbox" 2>/dev/null)" != "0" ]; then
  NEEDS_NO_SANDBOX=1
fi
if grep -q "ubuntu" /etc/os-release 2>/dev/null; then
  UBUNTU_VER=$(grep "VERSION_ID" /etc/os-release | cut -d'"' -f2 | cut -d'.' -f1)
  if [ "${UBUNTU_VER:-0}" -ge 23 ] 2>/dev/null; then
    NEEDS_NO_SANDBOX=1
  fi
fi

if [ "$NEEDS_NO_SANDBOX" = "1" ]; then
  exec "$EXEC" --no-sandbox --disable-dev-shm-usage "$@"
else
  exec "$EXEC" "$@"
fi
EOF
chmod +x "$LAUNCHER"

# Register MIME type and update desktop database
if command -v update-desktop-database &>/dev/null; then
  update-desktop-database /usr/share/applications 2>/dev/null || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache /usr/share/icons/hicolor 2>/dev/null || true
fi

exit 0
