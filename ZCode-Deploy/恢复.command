#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "============================================"
echo "  ZCode - restore (恢复原版)"
echo "============================================"
echo
./deploy.sh restore
echo
read -n 1 -s -r -p "按任意键关闭..."
echo
