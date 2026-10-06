#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "============================================"
echo "  ZCode - install (部署人格)"
echo "============================================"
echo
./deploy.sh install
echo
read -n 1 -s -r -p "按任意键关闭..."
echo
