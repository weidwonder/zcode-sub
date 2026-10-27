#!/usr/bin/env bash
# 跟随 ZCode 上游：fetch → 从 origin/main 建补丁分支 → cherry-pick 本地补丁提交 → typecheck/lint。
# - 补丁提交来源：本仓 patch/series（一行一个 SHA；'#' 注释行与空行忽略；'! <命令>' 行声明 pick 后要跑的自定义校验）
#   净提交 SHA 由派发者在补丁评审通过后固化于此；未固化时 sync-upstream.sh 仅建立跟随上游的分支，不 cherry-pick
# - cherry-pick 冲突即停（退出码 4），只打印冲突文件清单，不做任何 reset/清理
# - git 一律带 -c safe.directory='*'
set -euo pipefail

SRC="${1:-}"
DRY_RUN=0
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)"
SERIES_FILE="$PATCH_DIR/series"
NODE_VERSION="24.14.0"
TOOLCHAIN_ROOT="/Users/weidwonder/projects/.toolchains"
BRANCH_PREFIX="local/patched"

log() { printf '[patch] %s\n' "$*"; }
die() { log "错误：$*"; exit 1; }
g() { git -c safe.directory='*' "$@"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) SRC="$1"; shift ;;
  esac
done
[[ -n "$SRC" ]] || { sed -n '2,8p' "$0"; echo "用法：$0 <ZCode源码目录> [--dry-run]"; exit 1; }
[[ -d "$SRC/.git" || -f "$SRC/.git" ]] || die "$SRC 不是 git 仓库"

# ---- 写权限预检（受限环境给 dwc grant 提示，不绕过）----
ensure_writable() { # $1=将写入的目录 $2=用途
  local d="$1"
  if ! mkdir -p "$d" 2>/dev/null || [[ -e "$d" && ! -w "$d" ]]; then
    die "无权限写入：${d}（$2）。若在 dwc 座位内，请在座位外执行：dwc grant $d"
  fi
}
cd "$SRC"
log "源码仓库：$SRC"
[[ $DRY_RUN -eq 1 ]] || ensure_writable "$SRC" "git 仓库写入"

# ---- 工具链（typecheck/lint 需要 Node 24.14.0）----
if [[ -x "$TOOLCHAIN_ROOT/node-v$NODE_VERSION/bin/node" ]]; then
  export PATH="$TOOLCHAIN_ROOT/node-v$NODE_VERSION/bin:$PATH"
  log "node: $(node --version)"
else
  log "提示：未找到 Node $NODE_VERSION 工具链（${TOOLCHAIN_ROOT}）；校验阶段将用当前 PATH 的 node"
fi

# ---- fetch ----
log "> git fetch origin"
[[ $DRY_RUN -eq 1 ]] || g fetch origin || die "git fetch 失败"
UPSTREAM_SHA="$(g rev-parse --short origin/main)"
UPSTREAM_VER="$(g show origin/main:package.json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version","?"))' 2>/dev/null || echo '?')"
BRANCH="$BRANCH_PREFIX-$UPSTREAM_SHA"
log "上游：origin/main ${UPSTREAM_SHA}（版本 ${UPSTREAM_VER}）→ 分支 $BRANCH"
if g show-ref --verify --quiet "refs/heads/$BRANCH"; then
  die "分支已存在：${BRANCH}（如需重建请先手工处理，本脚本不删分支）"
fi

# ---- 补丁提交序列 ----
picks=()
custom_checks=()
if [[ -f "$SERIES_FILE" ]]; then
  while IFS= read -r line; do
    [[ -z "${line// /}" || "$line" == \#* ]] && continue
    if [[ "$line" == '!'* ]]; then
      custom_checks+=("${line#! }")
    else
      picks+=("$line")
    fi
  done < "$SERIES_FILE"
  log "补丁来源：$SERIES_FILE"
fi
if [[ ${#picks[@]} -eq 0 ]]; then
  log "警告：patch/series 未列出净提交 SHA（由派发者在补丁评审通过后固化）；本轮仅建立跟随上游的分支，不 cherry-pick。"
fi

log "将 cherry-pick ${#picks[@]} 个提交："
for p in ${picks[@]+"${picks[@]}"}; do
  subject="$(g log -1 --format='%s' "$p" 2>/dev/null || echo '（SHA 在仓库中不存在）')"
  log "  $p  $subject"
  if [[ $DRY_RUN -eq 0 && "$subject" == '（SHA 在仓库中不存在）' ]]; then
    die "series 中的 SHA 在仓库里找不到：${p}（先 git fetch 或核对 patch/series）"
  fi
done
if [[ ${#custom_checks[@]} -gt 0 ]]; then
  log "pick 后将跑自定义校验："
  for c in ${custom_checks[@]+"${custom_checks[@]}"}; do log "  ! $c"; done
fi

if [[ $DRY_RUN -eq 1 ]]; then
  log "dry-run 计划："
  log "  git switch -c ${BRANCH} origin/main"
  for p in ${picks[@]+"${picks[@]}"}; do log "  git cherry-pick $p"; done
  log "  pnpm typecheck && pnpm lint${custom_checks:+ && ${custom_checks[*]}}"
  log "dry-run：未执行任何写操作。"
  exit 0
fi

# ---- 建分支 + cherry-pick ----
g switch -c "$BRANCH" origin/main || die "建分支失败：$BRANCH"
for p in ${picks[@]+"${picks[@]}"}; do
  log "> git cherry-pick $p"
  if ! g cherry-pick "$p"; then
    log "cherry-pick 冲突，停止。冲突文件："
    log "当前状态："
    g status --short
    g diff --name-only --diff-filter=U | sed 's/^/  冲突: /'
    log "现场已保留（分支 ${BRANCH}）：解决冲突后 git cherry-pick --continue，或 git cherry-pick --abort 放弃本轮。"
    exit 4
  fi
done

# ---- 校验 ----
log "> pnpm typecheck"
pnpm typecheck || { log "typecheck 失败（分支 $BRANCH 保留现场）"; exit 5; }
log "> pnpm lint"
pnpm lint || { log "lint 失败（分支 $BRANCH 保留现场）"; exit 5; }
for c in ${custom_checks[@]+"${custom_checks[@]}"}; do
  log "> $c"
  bash -c "$c" || { log "自定义校验失败：${c}（分支 $BRANCH 保留现场）"; exit 5; }
done

log "同步完成：${BRANCH}（基于 origin/main ${UPSTREAM_SHA}，含 ${#picks[@]} 个补丁提交，校验全过）"
log "下一步：patch/build-desktop.sh '$SRC' 构建，然后 patch/install-desktop.sh 安装。"
