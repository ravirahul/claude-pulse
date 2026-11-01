#!/bin/sh
# Installs Claude Pulse on macOS or Linux: a background service that starts at login,
# plus a "Claude Pulse" app in Applications / the app menu.
# Usage:  sh install.sh            install (or update) and open it
#         sh install.sh --uninstall
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
OS=$(uname -s)

NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "Node.js 18 or newer is required: https://nodejs.org" >&2; exit 1; }
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' ||
  { echo "Node.js 18 or newer is required (found $("$NODE" -v))." >&2; exit 1; }

if [ "$OS" = Darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/com.claudepulse.server.plist"
  APP="$HOME/Applications/Claude Pulse.app"
  LOG="$HOME/Library/Application Support/ClaudePulse"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  if [ "$1" = --uninstall ]; then rm -rf "$PLIST" "$APP"; echo "Claude Pulse removed. Data left in $LOG"; exit 0; fi

  mkdir -p "$HOME/Library/LaunchAgents" "$LOG" "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claudepulse.server</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--max-old-space-size=192</string><string>$DIR/server.js</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string><key>PULSE_SUPERVISED</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG/server.log</string>
  <key>StandardErrorPath</key><string>$LOG/server.log</string>
</dict></plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST"

  cat > "$APP/Contents/MacOS/ClaudePulse" <<EOF
#!/bin/sh
exec "$NODE" "$DIR/pulse.js" "\$@"
EOF
  chmod +x "$APP/Contents/MacOS/ClaudePulse"
  cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Claude Pulse</string>
  <key>CFBundleIdentifier</key><string>com.claudepulse.app</string>
  <key>CFBundleExecutable</key><string>ClaudePulse</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF
  sips -s format icns "$DIR/icon.png" --out "$APP/Contents/Resources/icon.icns" >/dev/null 2>&1 || true
  echo "Installed. Open it from Applications > Claude Pulse (or Spotlight)."
else
  UNIT="$HOME/.config/systemd/user/claude-pulse.service"
  AUTO="$HOME/.config/autostart/claude-pulse-server.desktop"
  MENU="$HOME/.local/share/applications/claude-pulse.desktop"
  HAS_SYSTEMD=0; systemctl --user show-environment >/dev/null 2>&1 && HAS_SYSTEMD=1
  [ $HAS_SYSTEMD = 1 ] && systemctl --user disable --now claude-pulse.service 2>/dev/null || true
  if [ "$1" = --uninstall ]; then
    rm -f "$UNIT" "$AUTO" "$MENU"; pkill -f "$DIR/server.js" 2>/dev/null || true
    echo "Claude Pulse removed. Data left in ~/.local/share/ClaudePulse"; exit 0
  fi

  if [ $HAS_SYSTEMD = 1 ]; then
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<EOF
[Unit]
Description=Claude Pulse server

[Service]
ExecStart="$NODE" --max-old-space-size=192 "$DIR/server.js"
Environment="PATH=$PATH" "PULSE_SUPERVISED=1"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now claude-pulse.service
  else # no systemd user session: start at desktop login instead
    mkdir -p "$(dirname "$AUTO")"
    printf '[Desktop Entry]\nType=Application\nName=Claude Pulse server\nExec="%s" "%s/server.js"\nNoDisplay=true\n' "$NODE" "$DIR" > "$AUTO"
  fi

  mkdir -p "$(dirname "$MENU")"
  printf '[Desktop Entry]\nType=Application\nName=Claude Pulse\nComment=Claude usage, limits and sessions\nExec="%s" "%s/pulse.js"\nIcon=%s/icon.png\nCategories=Development;Utility;\nTerminal=false\n' "$NODE" "$DIR" "$DIR" > "$MENU"
  echo "Installed. Open it from your app menu: Claude Pulse."
fi

"$NODE" "$DIR/pulse.js"
