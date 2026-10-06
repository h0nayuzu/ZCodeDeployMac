#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "============================================"
echo "  ZCode - status (查看状态)"
echo "============================================"
echo
./deploy.sh status
echo
read -n 1 -s -r -p "按任意键关闭..."
echo
