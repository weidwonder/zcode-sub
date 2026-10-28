#!/usr/bin/env bash
# 用开源 ZCode 源码构建 mac arm64 桌面安装包（补丁版）。
# 工具链：Node 24.14.0 解压到 <家目录>/.cache/zcode-sub/toolchains（ZCODE_TOOLCHAIN_ROOT 可改，不动全局）；
# 身份：--identity preview（默认，ZCode Preview.app 与正式版并存）| production（ZCode.app 原地替换用）。
# 产物：--no-dmg 跳过 DMG 只出 zip（受限沙箱内 hdiutil 必败时用）。
# 环境变量依据（源码 3.16.2）：
#   packages/desktop/scripts/desktop-product-identity.mjs:59-68  ZCODE_ENV=production + ZCODE_PREVIEW_IDENTITY=1 → Preview 身份连生产后端
#   scripts/build-time-config.mjs:44-47                          ZCODE_AUTO_UPDATE 置 0 关闭自动更新（构建期注入）
#   packages/desktop/scripts/bundle.mjs:700-745                  bundle:desktop = prepare → build → electron-builder → 校验 → 审计
set -euo pipefail

SRC="${1:-}"
IDENTITY="preview"
DRY_RUN=0
SKIP_INSTALL=0
NO_DMG=0
NODE_VERSION="24.14.0"
TOOLCHAIN_ROOT="${ZCODE_TOOLCHAIN_ROOT:-${ZCODE_REAL_HOME:-$HOME}/.cache/zcode-sub/toolchains}"
NODE_MIRRORS=(
  "https://registry.npmmirror.com/-/binary/node"
  "https://nodejs.org/dist"
)

log() { printf '[patch] %s\n' "$*"; }
die() { log "错误：$*"; exit 1; }

# ---- 写权限预检（受限环境给 dwc grant 提示，不绕过）----
ensure_writable() { # $1=将写入的目录 $2=用途
  local d="$1"
  if ! mkdir -p "$d" 2>/dev/null || [[ -e "$d" && ! -w "$d" ]]; then
    die "无权限写入：${d}（$2）。若在 dwc 座位内，请在座位外执行：dwc grant $d"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --identity=*) IDENTITY="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-dmg) NO_DMG=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) SRC="$1"; shift ;;
  esac
done
[[ "$IDENTITY" == "preview" || "$IDENTITY" == "production" ]] || die "--identity 只支持 preview|production，收到：$IDENTITY"
[[ -n "$SRC" ]] || { sed -n '2,9p' "$0"; echo "用法：$0 <ZCode源码目录> [--identity preview|production] [--skip-install] [--no-dmg] [--dry-run]"; exit 1; }
[[ -f "$SRC/package.json" && -f "$SRC/pnpm-workspace.yaml" ]] || die "$SRC 不是 ZCode 源码仓库根（缺 package.json / pnpm-workspace.yaml）"

# ---- Node 24.14.0 工具链 ----
NODE_BIN="$TOOLCHAIN_ROOT/node-v$NODE_VERSION/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then
  TARBALL="node-v$NODE_VERSION-darwin-arm64.tar.gz"
  log "Node $NODE_VERSION 不存在，准备下载安装到 $TOOLCHAIN_ROOT"
  [[ $DRY_RUN -eq 1 ]] || ensure_writable "$TOOLCHAIN_ROOT" "Node 工具链目录"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "dry-run：将依次尝试 ${NODE_MIRRORS[*]}/v$NODE_VERSION/$TARBALL 并解压到 $TOOLCHAIN_ROOT"
  else
    mkdir -p "$TOOLCHAIN_ROOT"
    TMPDIR_DL="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR_DL"' EXIT
    ok=0
    for mirror in "${NODE_MIRRORS[@]}"; do
      url="$mirror/v$NODE_VERSION/$TARBALL"
      log "> curl -fSL $url -o $TMPDIR_DL/$TARBALL"
      if curl -fSL --retry 2 -o "$TMPDIR_DL/$TARBALL" "$url"; then ok=1; break; fi
      log "下载失败（${mirror}），尝试下一个镜像"
    done
    [[ $ok -eq 1 ]] || die "两个镜像都下载失败；请手动下载 $TARBALL 解压到 $TOOLCHAIN_ROOT/ 后重跑"
    tar -xzf "$TMPDIR_DL/$TARBALL" -C "$TOOLCHAIN_ROOT"
    [[ -x "$NODE_BIN" ]] || die "解压后仍未找到 $NODE_BIN"
  fi
fi
export PATH="$TOOLCHAIN_ROOT/node-v$NODE_VERSION/bin:$PATH"
log "node: $(command -v node) ($(node --version 2>/dev/null || echo 未验证))"

# ---- 缓存重定向（HOME 被重定向的受限环境下，pnpm/npm/electron 缓存写不进或塞爆座位目录；
# 默认指到工具链目录，用户已显式设置的环境变量不改）----
[[ -n "${npm_config_store_dir:-}" ]] || export npm_config_store_dir="$TOOLCHAIN_ROOT/pnpm-store"
[[ -n "${npm_config_cache:-}" ]] || export npm_config_cache="$TOOLCHAIN_ROOT/npm-cache"
[[ -n "${npm_config_devdir:-}" ]] || export npm_config_devdir="$TOOLCHAIN_ROOT/node-gyp"
[[ -n "${XDG_CACHE_HOME:-}" ]] || export XDG_CACHE_HOME="$TOOLCHAIN_ROOT/xdg-cache"
[[ -n "${XDG_DATA_HOME:-}" ]] || export XDG_DATA_HOME="$TOOLCHAIN_ROOT/xdg-data"
[[ -n "${ELECTRON_CACHE:-}" ]] || export ELECTRON_CACHE="$TOOLCHAIN_ROOT/electron-cache"
[[ -n "${electron_config_cache:-}" ]] || export electron_config_cache="$TOOLCHAIN_ROOT/electron-config-cache"
[[ -n "${ELECTRON_BUILDER_CACHE:-}" ]] || export ELECTRON_BUILDER_CACHE="$TOOLCHAIN_ROOT/electron-builder-cache"
log "包管理器/构建缓存默认重定向到 ${TOOLCHAIN_ROOT}（已显式设置的不覆盖）"

# ---- 残缺 Xcode 探测：xcode-select 指向的目录缺 xcodebuild 而 CommandLineTools 完整时，
# 自动切 CLT（node-pty 等 native 依赖的 electron-rebuild 需要 xcodebuild）----
if [[ "$(uname)" == "Darwin" ]]; then
  XSEL_DIR="$(xcode-select -p 2>/dev/null || true)"
  if [[ -n "$XSEL_DIR" && ! -x "$XSEL_DIR/usr/bin/xcodebuild" && -x /Library/Developer/CommandLineTools/usr/bin/clang && -d /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk ]]; then
    export DEVELOPER_DIR=/Library/Developer/CommandLineTools
    [[ -d "$DEVELOPER_DIR/SDKs/MacOSX.sdk" ]] && export SDKROOT="$DEVELOPER_DIR/SDKs/MacOSX.sdk"
    log "警告：xcode-select 指向的 $XSEL_DIR 缺 xcodebuild（残缺 Xcode），已自动改用 CommandLineTools（DEVELOPER_DIR${SDKROOT:+ + SDKROOT}）。根治请在座位外执行：sudo xcode-select -s /Library/Developer/CommandLineTools"
  fi
fi

# ---- pnpm（要求 10.33.2；本机版本不符或缺席时装到工具链目录，不动全局）----
PNPM_VERSION="10.33.2"
PNPM_HOME_TC="$TOOLCHAIN_ROOT/pnpm-$PNPM_VERSION"
ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version 2>/dev/null)" == "$PNPM_VERSION" ]]; then
    log "pnpm: $(command -v pnpm) ($(pnpm --version))"
    return 0
  fi
  if [[ -x "$PNPM_HOME_TC/bin/pnpm" ]] && [[ "$("$PNPM_HOME_TC/bin/pnpm" --version 2>/dev/null)" == "$PNPM_VERSION" ]]; then
    export PATH="$PNPM_HOME_TC/bin:$PATH"
    log "pnpm: $(command -v pnpm) ($(pnpm --version))［工具链副本］"
    return 0
  fi
  local cur_pnpm; cur_pnpm="$(command -v pnpm || true)"
  local cur_ver; cur_ver="$(pnpm --version 2>/dev/null || true)"
  log "pnpm ${PNPM_VERSION} 不可用（当前 ${cur_pnpm:-无} ${cur_ver}），安装到 ${PNPM_HOME_TC}"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "dry-run：将用 node $NODE_VERSION 的 npm 安装 pnpm@$PNPM_VERSION 到 ${PNPM_HOME_TC}（--prefix，不动全局）"
    export PATH="$TOOLCHAIN_ROOT/node-v$NODE_VERSION/bin:$PATH"
    return 0
  fi
  ensure_writable "$TOOLCHAIN_ROOT" "pnpm 工具链目录"
  "$TOOLCHAIN_ROOT/node-v$NODE_VERSION/bin/npm" install --global --prefix "$PNPM_HOME_TC" "pnpm@$PNPM_VERSION" \
    || die "pnpm@$PNPM_VERSION 安装失败（网络或权限；权限问题见上方提示）；也可自行安装后重跑"
  export PATH="$PNPM_HOME_TC/bin:$PATH"
  [[ "$(pnpm --version)" == "$PNPM_VERSION" ]] || die "工具链 pnpm 版本异常：$(pnpm --version)"
  log "pnpm: $(command -v pnpm) ($(pnpm --version))［工具链副本］"
}
ensure_pnpm

# ---- 构建环境 ----
BUILD_ENV=("ZCODE_ENV=production" "ZCODE_AUTO_UPDATE=0")
case "$IDENTITY" in
  preview)      BUILD_ENV+=("ZCODE_PREVIEW_IDENTITY=1") ;;
  production)   BUILD_ENV+=("ZCODE_PREVIEW_IDENTITY=0") ;;
esac
# Electron 下载镜像（bundle.mjs 默认即 npmmirror，显式置出于确定性；已设置则尊重既有值）
[[ -n "${ELECTRON_MIRROR:-}" ]] || BUILD_ENV+=("ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/")

PRODUCT_NAME="ZCode"; [[ "$IDENTITY" == "preview" ]] && PRODUCT_NAME="ZCode Preview"
log "构建身份：${IDENTITY}（产物名 ${PRODUCT_NAME}，后端 production）"
log "环境变量：${BUILD_ENV[*]}"

run_in_src() {
  log "> (cd $SRC && env ${BUILD_ENV[*]} $*)"
  [[ $DRY_RUN -eq 1 ]] && return 0
  (cd "$SRC" && env "${BUILD_ENV[@]}" "$@")
}

# ---- 依赖 ----
[[ $DRY_RUN -eq 1 ]] || ensure_writable "$SRC" "源码仓库（node_modules 构建写入）"
if [[ $SKIP_INSTALL -eq 0 ]]; then
  run_in_src pnpm install || die "pnpm install 失败"
else
  log "跳过 pnpm install（--skip-install）"
fi

# ---- 打包 ----
# run_in_desktop：上游 bundle.mjs 的三步都在 packages/desktop 目录下执行
run_in_desktop() {
  log "> (cd $SRC/packages/desktop && env ${BUILD_ENV[*]} $*)"
  [[ $DRY_RUN -eq 1 ]] && return 0
  (cd "$SRC/packages/desktop" && env "${BUILD_ENV[@]}" "$@")
}

DIST_DIR="$SRC/packages/desktop/dist"
START_TS=$(date +%s)

if [[ $NO_DMG -eq 1 ]]; then
  # zip 通路：复刻 bundle.mjs 的 prepare→build→electron-builder，target 显式 zip（跳过 DMG）。
  # 注意：此通路不含 bundle.mjs 的产物机械校验（asar 闭包/越界 native），装包后首启自验。
  log "--no-dmg：只出 zip（electron-builder --mac zip），跳过 DMG 与 bundle.mjs 收尾机械校验"
  run_in_desktop pnpm prepare:runtime-assets || die "prepare:runtime-assets 失败"
  run_in_desktop pnpm build || die "pnpm build 失败"
  run_in_desktop pnpm exec electron-builder --config electron-builder.config.js --mac zip --arm64 || die "electron-builder（zip）失败（输出见上）"
  ZIP_PATH="$(ls -t "$DIST_DIR/"*-mac-arm64.zip 2>/dev/null | head -1 || true)"
  [[ -n "$ZIP_PATH" ]] && run_in_desktop node scripts/audit-bundle-size.mjs --artifact-path "$ZIP_PATH"
else
  run_in_src pnpm bundle:desktop -- --os mac --arch arm64 || {
    # 失败兜底：DMG 阶段失败（受限沙箱 hdiutil 必败）时 zip/.app 往往已产出——有产物即算成功
    APP_OK=0; ZIP_OK=0
    NEW_APP="$(find "$DIST_DIR/mac-arm64" -maxdepth 1 -name "$PRODUCT_NAME.app" -newermt "@$START_TS" 2>/dev/null | head -1 || true)"
    [[ -n "$NEW_APP" ]] && APP_OK=1
    NEW_ZIP="$(find "$DIST_DIR" -maxdepth 1 -name '*-mac-arm64.zip' -newermt "@$START_TS" 2>/dev/null | head -1 || true)"
    [[ -n "$NEW_ZIP" ]] && ZIP_OK=1
    if [[ $APP_OK -eq 1 || $ZIP_OK -eq 1 ]]; then
      log "警告：bundle:desktop 整体失败（多见于 DMG 阶段，受限沙箱内 hdiutil 必败），但产物已生成："
      [[ $APP_OK -eq 1 ]] && log "  unpacked app：$NEW_APP"
      [[ $ZIP_OK -eq 1 ]] && log "  zip：$NEW_ZIP"
      log "  （bundle.mjs 的收尾机械校验未执行，装包后首启自验；受限环境可用 --no-dmg 直接走 zip 通路）"
    else
      die "bundle:desktop 失败（输出见上）"
    fi
  }
fi

# ---- 产物路径 ----
DIST_APP="$SRC/packages/desktop/dist/mac-arm64/$PRODUCT_NAME.app"
log "完成。产物："
log "  unpacked app：$DIST_APP"
if [[ $DRY_RUN -eq 0 ]]; then
  for ext in dmg zip; do
    f="$(ls -t "$SRC/packages/desktop/dist/"*.$ext 2>/dev/null | head -1 || true)"
    [[ -n "$f" ]] && log "  ${ext}：$f"
  done
  log "下一步：patch/install-desktop.sh '$DIST_APP'"
fi
