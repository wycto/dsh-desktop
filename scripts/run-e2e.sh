#!/bin/zsh
# E2E 运行脚本：run-e2e.sh <日志标签> [app可执行文件路径] [环境变量赋值...]
# 例：run-e2e.sh c1 DSH_E2E_UPDATE_CHOICE=update 'DSH_E2E_SETTINGS={"port":18500}'
#     run-e2e.sh pack1 '/path/to/DSH Desktop.app/Contents/MacOS/DSH Desktop' 'DSH_E2E_SETTINGS={"port":18510}'
cd /Users/weiyi/develop/gitea/chat/dsh-desktop || exit 1
TAG="$1"; shift
APP="./node_modules/.bin/electron ."
if [[ "$1" == /* ]]; then
  APP="'$1'"
  shift
fi
pkill -f 'dsh-desktop/node_modules/electron' 2>/dev/null
pkill -f 'DSH Desktop.app/Contents/MacOS/DSH Desktop' 2>/dev/null
sleep 1
rm -f /tmp/dsh-e2e.log
env DSH_E2E=1 "$@" /bin/zsh -c "$APP" > "/tmp/electron-test-$TAG.log" 2>&1
echo "exit=$?"
