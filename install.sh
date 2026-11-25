#!/usr/bin/env bash
# 随手问 · macOS / Linux 终端安装入口
# 用法：./install.sh [install.mjs 的参数]
set -e

cd "$(dirname "$0")"

# 找 node：先看 PATH，再试 Homebrew 的两个常见位置。
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE" ]; then
  echo "找不到 Node.js。装一个再来：https://nodejs.org/（或 brew install node）" >&2
  exit 1
fi

exec "$NODE" scripts/install.mjs "$@"
