#!/bin/bash
# zcode-sub 真机冒烟：在 ZCode 桌面版装好「本机任务 API」补丁、开关文件
# local-task-api.json 就绪、zcode-sub setup 已跑过之后执行，
# 验证 派发 → 事件 → 终态结果 全链路。
# 用法：scripts/smoke-real-zcode.sh ["<任务文本>"]   （缺省用一个 30 秒可完成的小任务）
# 环境变量：ZCODE_SUB=命令名或路径（默认 zcode-sub）；TIMEOUT_WAIT=每段等待秒数（默认 120）
set -euo pipefail

ZCODE_SUB="${ZCODE_SUB:-zcode-sub}"
TASK_TEXT="${1:-请回答：1+1 等于几？只回答一行。}"
NAME="smoke-$(date +%Y%m%d-%H%M%S)"
TIMEOUT_WAIT="${TIMEOUT_WAIT:-120}"

step() { printf '\n=== %s ===\n' "$1"; }

step "1. 前置：zcode-sub 命令可用"
command -v "$ZCODE_SUB" >/dev/null 2>&1 \
  || { echo "FAIL: 找不到 $ZCODE_SUB 命令——先安装/链接（npm link，或 ZCODE_SUB=/路径/zcode-sub.js 指到本仓 bin）再跑本脚本"; exit 1; }
$ZCODE_SUB --help | head -1

step "2. 健康检查：setup 应见「✓ 本机任务 API 正常」"
SETUP_OUT=$("$ZCODE_SUB" setup 2>&1) || true
echo "$SETUP_OUT" | head -8
echo "$SETUP_OUT" | grep -q "✓ 本机任务 API 正常" || {
  echo "FAIL: setup 没报「本机任务 API 正常」——先跑 $ZCODE_SUB setup 按提示排查；ZCode 没开或补丁没生效就重启 ZCode 后重试"
  exit 1
}

step "3. 派发任务 name=$NAME"
RUN_OUT=$("$ZCODE_SUB" run "$TASK_TEXT" --cwd "$PWD" --name "$NAME" 2>&1) \
  || { echo "FAIL: run 命令失败，输出如下——按输出里的错误码排查（工作区没开先去 GUI 打开 $PWD）"; echo "$RUN_OUT"; exit 1; }
echo "$RUN_OUT"
echo "$RUN_OUT" | grep -q '"status": "dispatched"' \
  || { echo "FAIL: run 输出没有 \"status\": \"dispatched\"——看上面完整输出与 $ZCODE_SUB list"; exit 1; }
echo "$RUN_OUT" | grep -q '"taskId"' \
  || { echo "FAIL: run 输出没有 taskId——契约 v2 的 run 必须回带 taskId，检查 zcode-sub 版本是否已切本机任务 API"; exit 1; }
echo "OK: 已派发——此时 ZCode GUI 应出现新对话并开始执行——去 GUI 看一眼"

step "4. 等事件（最多 ${TIMEOUT_WAIT}s，wait 单轮 15s）"
DEADLINE=$(( $(date +%s) + TIMEOUT_WAIT ))
GOT_EVENT=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if WAIT_OUT=$("$ZCODE_SUB" wait "$NAME" --timeout 15 2>&1); then
    echo "$WAIT_OUT"
    GOT_EVENT=1
    break
  fi
  echo "（本轮 15s 无新事件，继续等…）"
done
[ "$GOT_EVENT" -eq 1 ] \
  || { echo "FAIL: ${TIMEOUT_WAIT}s 内没等到任何事件——去 GUI 看该任务状态、确认 ZCode 在跑；也可手动 $ZCODE_SUB result $NAME 查看"; exit 1; }

step "5. 轮询 result 直到终态（最多 ${TIMEOUT_WAIT}s）"
DEADLINE=$(( $(date +%s) + TIMEOUT_WAIT ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  RESULT_OUT=$("$ZCODE_SUB" result "$NAME" 2>&1) \
    || { echo "FAIL: result 命令失败，输出如下——去 GUI 看任务是否还在/被删"; echo "$RESULT_OUT"; exit 1; }
  echo "$RESULT_OUT"
  if echo "$RESULT_OUT" | grep -q "GUI 处理"; then
    echo "WARN: 任务在等 GUI 处理（如权限确认）——去 ZCode GUI 处理，这里继续轮询"
    sleep 10
    continue
  fi
  if echo "$RESULT_OUT" | grep -q "还在跑"; then
    echo "（还在跑，10s 后再查…）"
    sleep 10
    continue
  fi
  if echo "$RESULT_OUT" | grep -q -- "----- 最后回复 -----"; then
    echo "PASS: 全链路打通（派发→事件→终态结果）"
    exit 0
  fi
  echo "FAIL: 到达终态但没看到「----- 最后回复 -----」——去 GUI 核对该任务输出，或 $ZCODE_SUB wait $NAME 翻历史消息"
  exit 1
done
echo "FAIL: ${TIMEOUT_WAIT}s 内未到终态——去 GUI 看任务状态与 ZCode 是否在跑，人工确认后重跑本脚本"
exit 1
