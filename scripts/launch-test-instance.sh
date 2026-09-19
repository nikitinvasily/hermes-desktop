#!/bin/bash
# Launch a dist test instance with CDP on 9333 (ud-clone, real agent home)
cd "$(dirname "$0")"
pkill -9 -x Electron 2>/dev/null
lsof -ti :9333 | xargs kill -9 2>/dev/null
rm -rf /tmp/hermes-desktop-ud-clone
cp -R "$HOME/Library/Application Support/hermes-desktop" /tmp/hermes-desktop-ud-clone
HERMES_DESKTOP_USER_DATA_DIR=/tmp/hermes-desktop-ud-clone \
  "$HOME/Documents/Hermes/desktop-agent/hermes-desktop/dist/mac-arm64/Hermes One.app/Contents/MacOS/Hermes One" \
  --remote-debugging-port=9333 >/tmp/hermes-test.log 2>&1 &
sleep 12
curl -s http://127.0.0.1:9333/json/version | head -3
echo "PIDS: $(pgrep -f 'dist/mac-arm64' | tr '\n' ' ')"
