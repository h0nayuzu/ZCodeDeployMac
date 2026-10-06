#!/bin/bash
# ZCode-Deploy for macOS — 命令行入口（等价于 Windows 的 deploy.ps1）
# 用法: ./deploy.sh install | restore | status | diag | help
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "[失败] 未找到 node —— 请先安装 Node.js:  brew install node"
    exit 1
fi

exec node "$DIR/deploy.cjs" "$@"
