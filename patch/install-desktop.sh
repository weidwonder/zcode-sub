#!/usr/bin/env bash
# 安装补丁版 ZCode 桌面应用到 /Applications。
# - 产物身份由 Info.plist 决定：dev.zcode.app → /Applications/ZCode.app（替换，旧包移入备份区）
#                               dev.zcode.app.preview → /Applications/ZCode Preview.app（并存）
# - 目标在运行则退出（不杀进程）；旧包只 mv 不删；默认 ad-hoc 重签（--no-sign 跳过）
set -euo pipefail

ARTIFACT="${1:-}"
DRY_RUN=0; DO_SIGN=1; ASSUME_YES=0
REAL_HOME="/Users/weidwonder"
BACKUP_ROOT="${ZCODE_BACKUP_ROOT:-$REAL_HOME/projects/zcode-backups}"

log() { printf '[patch] %s\n' "$*"; }
die() { log "错误：$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-sign) DO_SIGN=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) ARTIFACT="$1"; shift ;;
  esac
done
[[ -n "$ARTIFACT" ]] || { sed -n '2,6p' "$0"; echo "用法：$0 <产物 .app 目录或 .dmg> [--no-sign] [--yes] [--dry-run]"; exit 1; }
[[ -e "$ARTIFACT" ]] || die "产物不存在：$ARTIFACT"

# ---- 定位 .app ----
SRC_APP=""
MOUNT_POINT=""
cleanup() { [[ -n "$MOUNT_POINT" ]] && hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true; }
trap cleanup EXIT
if [[ -d "$ARTIFACT" && -f "$ARTIFACT/Contents/Info.plist" ]]; then
  SRC_APP="$ARTIFACT"
elif [[ "$ARTIFACT" == *.dmg ]]; then
  MOUNT_POINT="$(mktemp -d)/dmg"
  log "> hdiutil attach -nobrowse -readonly '$ARTIFACT'（挂载点 ${MOUNT_POINT}；dry-run 下只读挂载取身份后即卸载）"
  mkdir -p "$MOUNT_POINT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$ARTIFACT" >/dev/null
  found="$(find "$MOUNT_POINT" -maxdepth 2 -name '*.app' -type d | head -1)"
  if [[ -z "$found" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
    die "dmg 内未找到 .app"
  fi
  SRC_APP="$found"
  if [[ $DRY_RUN -eq 1 ]]; then
    # 只读挂载不留写副作用：取到身份即卸载，拷贝动作留给实跑
    hdiutil detach "$MOUNT_POINT" -quiet || true
    MOUNT_POINT=""
  fi
else
  die "无法识别的产物形态（既非 .app 目录也非 .dmg）：$ARTIFACT"
fi

# ---- 读身份 ----
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$SRC_APP/Contents/Info.plist" 2>/dev/null || true)"
BUNDLE_NAME="$(plutil -extract CFBundleName raw "$SRC_APP/Contents/Info.plist" 2>/dev/null || true)"
APP_VERSION="$(plutil -extract CFBundleShortVersionString raw "$SRC_APP/Contents/Info.plist" 2>/dev/null || echo '?')"
case "$BUNDLE_ID" in
  dev.zcode.app)          TARGET="/Applications/ZCode.app" ;;
  dev.zcode.app.preview)  TARGET="/Applications/ZCode Preview.app" ;;
  *) die "产物的 CFBundleIdentifier=$BUNDLE_ID 不是 ZCode 身份（dev.zcode.app / dev.zcode.app.preview），拒绝安装" ;;
esac
log "产物：${SRC_APP}（$BUNDLE_NAME ${APP_VERSION}，${BUNDLE_ID}）"
log "安装目标：$TARGET"

# ---- 运行检测 ----
if [[ -d "$TARGET" ]]; then
  if command -v pgrep >/dev/null 2>&1; then
    RUNNING="$(pgrep -f "$TARGET" || true)"
    if [[ -n "$RUNNING" ]]; then
      log "目标应用正在运行（PID: $(echo "$RUNNING" | tr '\n' ' ')）。请先退出后重试。"
      exit 3
    fi
  elif [[ $ASSUME_YES -eq 0 ]]; then
    log "警告：无法用 pgrep 检测运行状态（受限环境）。确认已退出 $TARGET 后加 --yes 重跑。"
    exit 3
  fi
fi

# ---- 写权限预检（受限环境给 dwc grant 提示，不绕过）----
ensure_writable() { # $1=将写入的目录 $2=用途
  local d="$1"
  if ! mkdir -p "$d" 2>/dev/null || [[ -e "$d" && ! -w "$d" ]]; then
    die "无权限写入：${d}（$2）。若在 dwc 座位内，请在座位外执行：dwc grant $d"
  fi
}
# ---- 备份现有包并安装 ----
STAMP="$(date +%Y%m%d-%H%M%S)"
[[ $DRY_RUN -eq 1 ]] || { ensure_writable /Applications "/Applications 安装目标"; ensure_writable "$BACKUP_ROOT/apps" "旧包备份区"; }
if [[ -d "$TARGET" ]]; then
  OLD_VER="$(plutil -extract CFBundleShortVersionString raw "$TARGET/Contents/Info.plist" 2>/dev/null || echo unknown)"
  OLD_BACKUP="$BACKUP_ROOT/apps/$(basename "$TARGET" .app)-$OLD_VER-$STAMP.app"
  log "> mv '$TARGET' -> '$OLD_BACKUP'"
  [[ $DRY_RUN -eq 1 ]] || { mkdir -p "$BACKUP_ROOT/apps"; mv "$TARGET" "$OLD_BACKUP"; }
  ROLLED_FROM="$OLD_BACKUP"
else
  log "目标不存在，全新安装（无旧包需要备份）"
  ROLLED_FROM=""
fi

log "> ditto '$SRC_APP' '$TARGET'"
[[ $DRY_RUN -eq 1 ]] || ditto "$SRC_APP" "$TARGET"

log "> xattr -dr com.apple.quarantine '$TARGET'"
[[ $DRY_RUN -eq 1 ]] || xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

if [[ $DO_SIGN -eq 1 ]]; then
  log "> codesign --force --deep --sign - '$TARGET'（ad-hoc）"
  [[ $DRY_RUN -eq 1 ]] || codesign --force --deep --sign - "$TARGET"
else
  log "跳过 ad-hoc 签名（--no-sign）"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  log "dry-run：未做任何改动。"
else
  log "安装完成：$TARGET"
  [[ -n "$ROLLED_FROM" ]] && log "旧包已保留：${ROLLED_FROM}（可用 patch/rollback-desktop.sh 恢复）"
  log "打开前建议先跑：patch/backup-zcode-data.sh（若尚未备份）"
fi
