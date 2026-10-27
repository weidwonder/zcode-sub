#!/bin/bash
# zcode-sub 真机冒烟：在装好「本机 Webhook Bot 入站端点」补丁并完成 setup 绑定的
# ZCode 桌面版上，验证派发 → 出站消息 → 终态取结果全链路。
# 用法：scripts/smoke-real-zcode.sh ["<任务文本>"]   （缺省用一个 30 秒可完成的小任务）
set -euo pipefail

ZCODE_SUB="${ZCODE_SUB:-zcode-sub}"
TASK_TEXT="${1:-请回答：1+1 等于几？只回答一行。}"
NAME="smoke-$(date +%Y%m%d-%H%M%S)"
TIMEOUT_WAIT="${TIMEOUT_WAIT:-120}"

step() { printf '\n=== %s ===\n' "$1"; }

step "0. 前置检查：zcode-sub 命令可用"
command -v "$ZCODE_SUB" >/dev/null || { echo "FAIL: 找不到 $ZCODE_SUB（先安装，见 README）"; exit 1; }
echo "OK: $($ZCODE_SUB --help | head -1)"

step "1. 配置检查（config.json 有 botId/secret，health 可达）"
HOME_DIR="${ZCODE_SUB_HOME:-$HOME/.zcode-sub}"
if [ ! -f "$HOME_DIR/config.json" ]; then
  echo "FAIL: $HOME_DIR/config.json 不存在——先跑 $ZCODE_SUB setup 并完成 GUI 配置与绑定（README「一次性配置」）"
  exit 1
fi
echo "OK: 配置文件存在"
$ZCODE_SUB setup | sed -n '1,8p'
echo "（上面应看到入站端点 ✓ 与 daemon ✓；✗ 则先按提示排查）"

step "2. 派发任务 name=$NAME"
RUN_OUT=$("$ZCODE_SUB" run "$TASK_TEXT" --cwd "$HOME_DIR" --name "$NAME")
echo "$RUN_OUT"
echo "$RUN_OUT" | grep -q '"status": "dispatched"' || { echo "FAIL: run 未返回 dispatched"; exit 1; }
echo "OK: 已派发（此时 ZCode GUI 里应出现新任务并开始执行——去 GUI 看一眼）"

step "3. 等出站消息（最多 ${TIMEOUT_WAIT}s，可能需要多轮 wait）"
DEADLINE=$(( $(date +%s) + TIMEOUT_WAIT ))
GOT_MSG=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if WAIT_OUT=$("$ZCODE_SUB" wait "$NAME" --timeout 15); then
    echo "$WAIT_OUT"
    GOT_MSG=1
    break
  else
    echo "（本轮无新消息，继续等…）"
  fi
done
[ "$GOT_MSG" -eq 1 ] || { echo "FAIL: ${TIMEOUT_WAIT}s 内没收到任何出站消息——检查 GUI 里任务是否在跑、daemon 日志 $HOME_DIR/daemon.log"; exit 1; }
echo "OK: 收到出站消息"

step "4. 轮询 result 直到终态（最多 ${TIMEOUT_WAIT}s）"
DEADLINE=$(( $(date +%s) + TIMEOUT_WAIT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if RESULT_OUT=$("$ZCODE_SUB" result "$NAME"); then
    echo "$RESULT_OUT"
    if echo "$RESULT_OUT" | grep -q "还在跑"; then
      echo "（仍在运行，稍后再查…）"; sleep 10
    else
      echo "$RESULT_OUT" | grep -q "----- 最终回复 -----" \
        && { echo "PASS: 全链路打通（派发→出站→终态结果）"; exit 0; } \
        || { echo "WARN: 终态但没抓到回复正文（启发式边界，见 README「重要边界与风险」）；人工核对 GUI 结果"; exit 0; }
    fi
  else
    echo "result 命令失败：$RESULT_OUT" >&2; sleep 5
  fi
done
echo "FAIL: ${TIMEOUT_WAIT}s 内未到终态——GUI 里查看任务状态后重跑本脚本"
exit 1
