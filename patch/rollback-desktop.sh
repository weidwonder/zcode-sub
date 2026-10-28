#!/usr/bin/env bash
# 把 /Applications 里的 ZCode（或 ZCode Preview）回滚到备份区的上一份快照。
# - 不删除任何 .app：当前包先 mv 回备份区（rolledback-from- 前缀），快照再 mv 回 /Applications
# - --list 只列可回滚快照；--from 指定快照；默认取备份区最新
set -euo pipefail

DRY_RUN=0; ASSUME_YES=0; LIST=0; FROM=""
REAL_HOME="/Users/weidwonder"
BACKUP_ROOT="${ZCODE_BACKUP_ROOT:-$REAL_HOME/projects/zcode-backups}"
APPS_DIR="$BACKUP_ROOT/apps"

log() { printf '[patch] %s\n' "$*"; }
die() { log "错误：$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --list) LIST=1; shift ;;
    --from) FROM="$2"; shift 2 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

# ---- 列快照 ----
snapshots=()
if [[ -d "$APPS_DIR" ]]; then
  while IFS= read -r f; do snapshots+=("$f"); done < <(ls -d "$APPS_DIR"/*.app 2>/dev/null | sort -r)
fi
if [[ $LIST -eq 1 ]]; then
  log "可回滚快照（新→旧）："
  for s in ${snapshots[@]+"${snapshots[@]}"}; do
    v="$(plutil -extract CFBundleShortVersionString raw "$s/Contents/Info.plist" 2>/dev/null || echo '?')"
    log "  ${s}（版本 ${v}）"
  done
  [[ ${#snapshots[@]:-0} -eq 0 ]] && log "  （无）"
  exit 0
fi
[[ ${#snapshots[@]} -gt 0 ]] || die "备份区没有快照：${APPS_DIR}（先确认 ZCODE_BACKUP_ROOT）"

# ---- 选快照、推目标路径 ----
SNAP="$FROM"; [[ -z "$SNAP" ]] && SNAP="${snapshots[0]}"
[[ -d "$SNAP" ]] || die "指定快照不存在：$SNAP"
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$SNAP/Contents/Info.plist" 2>/dev/null || true)"
case "$BUNDLE_ID" in
  dev.zcode.app)          TARGET="/Applications/ZCode.app" ;;
  dev.zcode.app.preview)  TARGET="/Applications/ZCode Preview.app" ;;
  *) die "快照的 CFBundleIdentifier=$BUNDLE_ID 不是 ZCode 身份，拒绝恢复" ;;
esac
SNAP_VER="$(plutil -extract CFBundleShortVersionString raw "$SNAP/Contents/Info.plist" 2>/dev/null || echo '?')"
log "恢复：${SNAP}（版本 ${SNAP_VER}）→ $TARGET"

log "本脚本由用户本人在本机终端直接运行（需要 /Applications 写权限）。"
log "执行计划："
if [[ -d "$TARGET" ]]; then
  log "  1. 运行检测（在运行则退出，不杀进程）"
  log "  2. 保留当前包：mv '$TARGET' -> '$APPS_DIR/rolledback-from-$(basename "$TARGET" .app)-<当前版本>-<时间戳>.app'"
  log "  3. 恢复快照：mv '$SNAP' -> '$TARGET'"
else
  log "  1. 运行检测（目标不存在，跳过）"
  log "  2. 恢复快照：mv '$SNAP' -> '$TARGET'"
fi

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
# ---- 执行 ----
STAMP="$(date +%Y%m%d-%H%M%S)"
[[ $DRY_RUN -eq 1 ]] || { ensure_writable /Applications "/Applications 回滚目标"; ensure_writable "$APPS_DIR" "快照备份区"; }
if [[ -d "$TARGET" ]]; then
  CUR_VER="$(plutil -extract CFBundleShortVersionString raw "$TARGET/Contents/Info.plist" 2>/dev/null || echo unknown)"
  CUR_SAVE="$APPS_DIR/rolledback-from-$(basename "$TARGET" .app)-$CUR_VER-$STAMP.app"
  log "> mv '$TARGET' -> '$CUR_SAVE'（当前包保留，可再回退）"
  [[ $DRY_RUN -eq 1 ]] || mv "$TARGET" "$CUR_SAVE"
else
  log "$TARGET 不存在，直接放入快照"
fi
log "> mv '$SNAP' -> '$TARGET'"
[[ $DRY_RUN -eq 1 ]] || mv "$SNAP" "$TARGET"

if [[ $DRY_RUN -eq 1 ]]; then
  log "dry-run：未做任何改动。"
else
  log "回滚完成：${TARGET}（版本 ${SNAP_VER}）"
  log "数据层未动。若需恢复数据快照，见 patch/README.md「数据恢复」一节。"
fi
