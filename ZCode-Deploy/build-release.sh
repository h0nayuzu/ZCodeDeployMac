#!/bin/bash
# ============================================
# ZCode-Deploy 发布打包脚本 (macOS)
# 等价于 build-release.ps1
#
# 用法: ./build-release.sh [版本号]
# 产物: dist/ZCode-Deploy-v<版本>.zip + .sha256
#
# 打包内容是白名单：只有 Payload 里列出的文件会进包，
# 机器本地产物（backups/、zcode-dir.txt 等）永远不会被打进去。
# ============================================
set -euo pipefail
cd "$(dirname "$0")"

DIST="dist"
STAGE_ROOT="$DIST/_stage"

# ---- 版本号：默认从 deploy.cjs 的 ToolVersion 读取 ----
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    VERSION="$(grep -m1 -oE "const ToolVersion = ['\"][^'\"]+" deploy.cjs | sed "s/.*['\"]//")"
    if [ -z "$VERSION" ]; then
        echo "[失败] 无法从 deploy.cjs 读取版本号，请用参数指定: ./build-release.sh 2.1.0"
        exit 1
    fi
fi

RELEASE="ZCode-Deploy-v$VERSION"
STAGE="$STAGE_ROOT/$RELEASE"
ZIP="$DIST/$RELEASE.zip"
SHA="$ZIP.sha256"

echo "=== ZCode-Deploy 发布打包 ==="
echo "版本:   $VERSION"
echo "产物:   $ZIP"
echo

# ---- 发布白名单 ----
# 必需：macOS 核心脚本 + 人格文件。缺任一即中止。
REQUIRED=(
    deploy.cjs deploy.sh verify-patch.cjs build-release.sh
    部署.command 恢复.command 查看状态.command 验证.command
    人格.txt
)
# 可选：Windows 版脚本与文档，存在才打包
OPTIONAL=(
    deploy.ps1 build-release.ps1
    部署.bat 恢复.bat 查看状态.bat 验证.bat
    README.md README-mac.md 修改记录.md CHANGELOG.md LICENSE .gitignore
)

echo "[1/5] 校验白名单文件..."
missing=0
for f in "${REQUIRED[@]}"; do
    if [ -f "$f" ]; then
        echo "  [OK] $f ($(wc -c < "$f" | tr -d ' ') bytes)"
    else
        echo "  [缺失] $f"
        missing=$((missing + 1))
    fi
done
for f in "${OPTIONAL[@]}"; do
    if [ -f "$f" ]; then
        echo "  [OK·可选] $f ($(wc -c < "$f" | tr -d ' ') bytes)"
    else
        echo "  [无·可选] $f"
    fi
done
if [ "$missing" -gt 0 ]; then
    echo
    echo "[失败] 缺少 $missing 个必需发布文件，已中止"
    exit 1
fi
# 只打包实际存在的文件（可选文件可能缺失）
PAYLOAD=()
for f in "${REQUIRED[@]}" "${OPTIONAL[@]}"; do
    [ -f "$f" ] && PAYLOAD+=("$f")
done

# ---- 预检：.sh/.command 必须 LF 行尾 ----
echo "  预检行尾..."
badlf=0
for f in "${REQUIRED[@]}" "${OPTIONAL[@]}"; do
    case "$f" in
        *.sh|*.command)
            if file "$f" | grep -q CRLF; then
                echo "  [失败] $f 是 CRLF 行尾，macOS bash 无法执行"
                badlf=$((badlf + 1))
            fi
            ;;
    esac
done
if [ "$badlf" -gt 0 ]; then
    echo "[失败] 有 $badlf 个脚本行尾不合格，已中止"
    exit 1
fi

echo "[2/5] 准备暂存目录..."
rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE"

echo "[3/5] 复制文件并生成清单..."
for f in "${PAYLOAD[@]}"; do
    cp -p "$f" "$STAGE/$f"
done
chmod +x "$STAGE"/*.command "$STAGE"/*.sh 2>/dev/null || true

{
    echo "# $RELEASE"
    echo "生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "文件数:   ${#PAYLOAD[@]}"
    echo
    echo "SHA256                                                            SIZE  NAME"
    printf '%.0s-' {1..78}; echo
    total=0
    for f in "${PAYLOAD[@]}"; do
        h=$(shasum -a 256 "$STAGE/$f" | awk '{print $1}')
        sz=$(wc -c < "$STAGE/$f" | tr -d ' ')
        total=$((total + sz))
        printf '%s  %8s  %s\n' "$h" "$sz" "$f"
    done
    printf '%.0s-' {1..78}; echo
    echo "总计: $total bytes"
} > "$STAGE/MANIFEST.txt"
echo "  已写入 MANIFEST.txt"

echo "[4/5] 打包 zip..."
mkdir -p "$DIST"
rm -f "$ZIP"
(cd "$STAGE" && zip -qr "$OLDPWD/$ZIP" .)
echo "  [OK] $(basename "$ZIP") ($(wc -c < "$ZIP" | tr -d ' ') bytes)"

echo "[5/5] 计算校验和..."
shasum -a 256 "$ZIP" | awk -v n="$RELEASE.zip" '{print $1 "  " n}' > "$SHA"
echo "  [OK] $(awk '{print $1}' "$SHA")"

rm -rf "$STAGE_ROOT"

echo
echo "=== 打包完成 ==="
echo "  $ZIP"
echo "  $SHA"
