#!/bin/bash
# 随手问 · macOS 双击安装入口
# Finder 里双击会用 Terminal 打开并执行；也可以在终端里 ./install.command
set -e

cd "$(dirname "$0")"
SELF_DIR="$(pwd)"

pause_and_exit() {
  status=$?
  set +e
  echo
  if [ "$status" -ne 0 ]; then
    echo "安装没有成功（退出码 $status）。上面的输出里有原因。"
  fi
  read -n 1 -r -p "按任意键关闭..."
  echo
  exit "$status"
}
trap pause_and_exit EXIT

echo
echo "随手问 · 一键安装"
echo "────────────────────"
echo

# Windows 上没法保留 +x 位；如果这个文件没有执行权限，提醒一句。
if [ ! -x "$SELF_DIR/install.command" ]; then
  echo "提示：install.command 还没有执行权限。命令行里跑请先：chmod +x install.command"
  echo "      （Finder 双击一般不受影响，Terminal 会自己处理。）"
  echo
fi

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
  echo "✗ 找不到 Node.js，装不了。"
  echo
  echo "  装法一：打开 https://nodejs.org/ 下载 LTS 版，双击安装。"
  echo "  装法二：在终端里跑  brew install node"
  echo
  echo "  装完关掉这个窗口，重新双击 install.command。"
  exit 1
fi

echo "Node.js：$("$NODE" --version)"
echo

"$NODE" scripts/install.mjs "$@"
