#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "============================================"
echo "  ZCode - verify (诊断 + 功能验证)"
echo "============================================"
echo
./deploy.sh diag
echo
echo "--- functional verify ---"
echo
if command -v node >/dev/null 2>&1; then
    node "$PWD/verify-patch.cjs"
else
    echo "node not found - functional verify skipped (brew install node)"
fi
echo
read -n 1 -s -r -p "按任意键关闭..."
echo
