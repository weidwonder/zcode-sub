#!/usr/bin/env bash
# 备份 ZCode 用户数据（~/.zcode）到指定目录。
# - SQLite 库用 sqlite3 在线备份（.backup），WAL 活跃时也能拿到一致快照
# - 其余配置/数据文件按 spec §4.1 的范围复制；可再生大目录跳过并记入 manifest
# - 生成 manifest.json + sha256sums.txt；不修改源数据；目标已存在则拒绝（防覆盖旧备份）
set -euo pipefail

# ---- 参数 ----
BACKUP_DIR="${1:-}"
DRY_RUN=0
MINIMAL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --minimal) MINIMAL=1 ;;
    -h|--help)
      sed -n '2,10p' "$0"; exit 0 ;;
    *) ;;
  esac
done

REAL_HOME="/Users/weidwonder"   # 座位 HOME 被重定向，用户真实家目录固定为此
ZCODE_ROOT="${ZCODE_ROOT:-$REAL_HOME/.zcode}"
BACKUP_ROOT="${ZCODE_BACKUP_ROOT:-$REAL_HOME/projects/zcode-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_DIR:-$BACKUP_ROOT/$STAMP}"

log() { printf '[patch] %s\n' "$*"; }
die() { log "错误：$*"; exit 1; }

# ---- 写权限预检（受限环境给 dwc grant 提示，不绕过）----
ensure_writable() { # $1=将写入的目录 $2=用途
  local d="$1"
  if ! mkdir -p "$d" 2>/dev/null || [[ -e "$d" && ! -w "$d" ]]; then
    die "无权限写入：${d}（$2）。若在 dwc 座位内，请在座位外执行：dwc grant $d"
  fi
}

if [[ ! -d "$ZCODE_ROOT" ]]; then
  log "错误：ZCode 数据目录不存在或不可读：$ZCODE_ROOT"
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  log "错误：需要 sqlite3（macOS 自带）；当前 PATH 找不到"
  exit 1
fi
if [[ -e "$BACKUP_DIR" && $DRY_RUN -eq 0 ]]; then
  log "错误：备份目标已存在（防止覆盖旧备份）：$BACKUP_DIR"
  exit 2
fi

# ---- 备份范围（相对 ${ZCODE_ROOT}）----
SQLITE_DBS=("cli/db/db.sqlite" "v2/tasks-index.sqlite")
COPY_DIRS=()   # 整目录递归复制
COPY_GLOBS=()  # glob 展开的文件（v2 顶层 json 等）
if [[ $MINIMAL -eq 1 ]]; then
  COPY_GLOBS=("v2/*.json")
  COPY_DIRS=("v2/certs" "v2/agent-config")
else
  COPY_GLOBS=("v2/*.json")
  COPY_DIRS=("v2/certs" "v2/agent-config" "v2/runtime" "v2/gen-ui-state" "skills" "cli/agents" "cli/plugins" "cli/memories" "cli/log")
fi
SKIP_REASONS=(
  "workspace/|任务工作区（可再生，体积大）"
  "cli/artifacts/|任务产物（体积大）"
  "cli/exec/|执行记录（体积大）"
  "cli/rollout/|发布产物（体积大）"
  "cli/image-cache/|图片缓存"
  "cli/pdf-cache/|PDF 缓存"
  "v2/visualizations/|可视化产物（体积大）"
  "v2/cache/|运行缓存"
  "v2/crash/|崩溃转储"
  "v2/logs/|日志（体积大）"
  "feedback/|反馈附件"
  "backup/|ZCode 自身的迁移备份（已有备份机制）"
  "plugin-workspace/|插件工作区（可再生）"
)

log "源：$ZCODE_ROOT"
log "目标：${BACKUP_DIR}（minimal=$MINIMAL dry-run=${DRY_RUN}）"

# ---- 计划输出函数（dry-run 与实跑共用同一计划，保证 dry-run 忠实）----
plan_sqlite=()
plan_copy=()
for db in "${SQLITE_DBS[@]}"; do
  [[ -f "$ZCODE_ROOT/$db" ]] && plan_sqlite+=("$db")
done
# bash 3.2（macOS 自带）无关联数组，用线性查重（清单很小，性能无碍）
collect_copy() {
  local p="$1" existing
  [[ -z "$p" ]] && return 0
  [[ -e "$ZCODE_ROOT/$p" ]] || return 0
  for existing in ${plan_copy[@]+"${plan_copy[@]}"}; do
    [[ "$existing" == "$p" ]] && return 0
  done
  plan_copy+=("$p")
}
for g in "${COPY_GLOBS[@]}"; do
  for f in "$ZCODE_ROOT"/$g; do
    [[ -f "$f" ]] && collect_copy "${g%/*}/$(basename "$f")"
  done
done
for d in "${COPY_DIRS[@]}"; do collect_copy "$d"; done

TOTAL_BYTES=0
PY3="$(command -v python3 || true)"
size_of() {
  if [[ -d "$1" ]]; then
    if [[ -n "$PY3" ]]; then
      "$PY3" - "$1" <<'PY' 2>/dev/null || echo 0
import os, sys
t = 0
for root, _, files in os.walk(sys.argv[1]):
    for f in files:
        try: t += os.lstat(os.path.join(root, f)).st_size
        except OSError: pass
print(t)
PY
    else
      echo '?'
    fi
  else
    stat -f %z "$1" 2>/dev/null || echo 0
  fi
}

log "计划备份：SQLite ${#plan_sqlite[@]} 个，复制 ${#plan_copy[@]} 项"
for db in "${plan_sqlite[@]}"; do log "  [sqlite-backup] $db ($(size_of "$ZCODE_ROOT/$db") bytes)"; done
for p in "${plan_copy[@]}"; do log "  [copy] $p ($(size_of "$ZCODE_ROOT/$p") bytes)"; done
log "跳过："
for entry in "${SKIP_REASONS[@]}"; do
  p="${entry%%|*}"; r="${entry#*|}"
  log "  $p —— $r"
done

if [[ $DRY_RUN -eq 1 ]]; then
  log "dry-run：未写任何文件。"
  exit 0
fi

# ---- 执行 ----
START_TS=$(date +%s)
ensure_writable "$(dirname "$BACKUP_DIR")" "备份目录"
mkdir -p "$BACKUP_DIR/zcode"
shopt -s nullglob nocaseglob

manifest_entries=()
add_manifest() { # $1=相对路径 $2=method；目录展开为逐文件条目
  local rel="$1" method="$2" bytes hash src_mtime item abs
  if [[ -d "$BACKUP_DIR/zcode/$rel" ]]; then
    while IFS= read -r item; do
      add_manifest "${item#"$BACKUP_DIR/zcode/"}" "$method"
    done < <(find "$BACKUP_DIR/zcode/$rel" -type f | sort)
    return 0
  fi
  abs="$BACKUP_DIR/zcode/$rel"
  bytes=$(stat -f %z "$abs" 2>/dev/null || echo 0)
  hash=$(shasum -a 256 "$abs" | awk '{print $1}')
  src_mtime=$(stat -f %Sm -t '%Y-%m-%dT%H:%M:%S%z' "$ZCODE_ROOT/$rel" 2>/dev/null || echo null)
  TOTAL_BYTES=$((TOTAL_BYTES + bytes))
  manifest_entries+=("{\"path\": \"$rel\", \"bytes\": $bytes, \"sha256\": \"$hash\", \"method\": \"$method\", \"sourceMtime\": \"$src_mtime\"}")
  printf '%s  %s\n' "$hash" "zcode/$rel" >> "$BACKUP_DIR/sha256sums.txt"
}

: > "$BACKUP_DIR/sha256sums.txt"
for db in "${plan_sqlite[@]}"; do
  log "> sqlite3 -readonly $ZCODE_ROOT/$db \".backup $BACKUP_DIR/zcode/$db\""
  mkdir -p "$BACKUP_DIR/zcode/$(dirname "$db")"
  sqlite3 -readonly "$ZCODE_ROOT/$db" ".backup '$BACKUP_DIR/zcode/$db'"
  add_manifest "$db" "sqlite-backup"
done

for p in "${plan_copy[@]}"; do
  dst_dir="$BACKUP_DIR/zcode/$(dirname "$p")"
  mkdir -p "$dst_dir"
  log "> cp -Rp '$ZCODE_ROOT/$p' -> '$dst_dir/'"
  cp -Rp "$ZCODE_ROOT/$p" "$dst_dir/"
  add_manifest "$p" "copy"
done

# ---- manifest ----
APP_VERSION=null
if [[ -f /Applications/ZCode.app/Contents/Info.plist ]]; then
  APP_VERSION=$(plutil -extract CFBundleShortVersionString raw /Applications/ZCode.app/Contents/Info.plist 2>/dev/null || echo null)
fi
{
  printf '{\n'
  printf '  "createdAt": "%s",\n' "$(date +%Y-%m-%dT%H:%M:%S%z)"
  printf '  "sourceRoot": "%s",\n' "$ZCODE_ROOT"
  printf '  "zcodeAppVersion": "%s",\n' "$APP_VERSION"
  printf '  "files": [\n'
  first=1
  for e in "${manifest_entries[@]}"; do
    [[ $first -eq 0 ]] && printf ',\n'
    printf '    %s' "$e"
    first=0
  done
  printf '\n  ],\n'
  printf '  "skipped": [\n'
  first=1
  for entry in "${SKIP_REASONS[@]}"; do
    p="${entry%%|*}"; r="${entry#*|}"
    [[ $first -eq 0 ]] && printf ',\n'
    printf '    {"path": "%s", "reason": "%s"}' "$p" "$r"
    first=0
  done
  printf '\n  ]\n}\n'
} > "$BACKUP_DIR/manifest.json"

END_TS=$(date +%s)
log "备份完成：${#manifest_entries[@]} 个文件，共 $TOTAL_BYTES 字节，耗时 $((END_TS - START_TS))s"
log "备份目录：$BACKUP_DIR"
log "校验：cd '$BACKUP_DIR' && shasum -a 256 -c sha256sums.txt"
