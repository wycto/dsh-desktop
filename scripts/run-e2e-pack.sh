#!/bin/zsh
# E2E：测试打包好的 macOS app（含更新弹窗自动应答）
cd /Users/weiyi/develop/gitea/chat/dsh-desktop || exit 1
pkill -f 'DSH Desktop.app/Contents/MacOS/DSH' 2>/dev/null
sleep 1
rm -f /tmp/dsh-e2e.log
export DSH_E2E=1
export DSH_E2E_UPDATE_CHOICE="${1:-update}"
export DSH_E2E_SETTINGS='{"host":"127.0.0.1","port":18513,"lastUsedVersion":"0.0.1"}'
exec "./dist/mac-arm64/DSH Desktop.app/Contents/MacOS/DSH Desktop" > /tmp/electron-test-pack.log 2>&1
