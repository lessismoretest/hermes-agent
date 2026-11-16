#!/usr/bin/env bash
# 从本仓库构建并安装 MyHermes.app（macOS）。
#
#   bash scripts/build-myhermes.sh
#
# 幂等：重复跑就是重新构建并覆盖 /Applications/MyHermes.app。
# 需要：macOS + Node >= 26 + pnpm。仓库必须停在 myhermes 分支。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_SRC="$REPO_ROOT/apps/desktop"
DEST="/Applications/MyHermes.app"
BRANCH="myhermes"

cd "$REPO_ROOT"

current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
if [ "$current" != "$BRANCH" ]; then
  echo "当前分支是 $current，MyHermes 的改动在 $BRANCH 上。先切过去：" >&2
  echo "  git checkout $BRANCH" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 26 ]; then
  bundled="$HOME/.hermes/tools/node-26.12.1-darwin-arm64/bin"
  if [ -x "$bundled/node" ]; then
    export PATH="$bundled:$PATH"
    echo "· 使用 Hermes 自带的 Node $(node -v)"
  else
    echo "需要 Node >= 26（当前 $(node -v 2>/dev/null || echo '没有 node')）。" >&2
    echo "装好后重跑，或用 nvm 切到 26。" >&2
    exit 1
  fi
fi

cd "$APP_SRC"
if [ ! -d node_modules ]; then
  echo "· 安装依赖（pnpm install）"
  pnpm install --frozen-lockfile
fi

echo "· 构建（pnpm run pack，约 1–2 分钟）"
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run pack

BUILT="$APP_SRC/release/mac-arm64/Hermes.app"
if [ ! -d "$BUILT" ]; then
  echo "构建产物缺失：$BUILT" >&2
  exit 1
fi

echo "· 安装到 $DEST"
rm -rf "$DEST"
ditto "$BUILT" "$DEST"

PLIST="$DEST/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.lessismore.myhermes" "$PLIST"
# CFBundleName 必须保持 Hermes：Electron 用它定位 Hermes Helper.app。
# 改了会启动即崩（Unable to find helper app）。只改显示名。
if ! /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName MyHermes" "$PLIST" 2>/dev/null; then
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string MyHermes" "$PLIST"
fi

# 官方更新源：删掉，免得 electron-updater 用上游包覆盖掉我们的界面。
rm -f "$DEST/Contents/Resources/app-update.yml"

codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || echo "· 签名跳过（ad-hoc 失败也不影响本机启动）"

echo "✓ 已安装：$DEST"
echo "  首次启动会把内置外观（皮肤 + 桌面插件）写进 ~/.hermes，已有的文件不会覆盖。"
