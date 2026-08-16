#!/bin/bash
# e2e 六支總跑（task.md T4-1）：一次跑一支、間隔 20 秒——port 進 TIME_WAIT 會衝突，
# 不要圖快改成平行。任何一支失敗立刻停（set -e），Errno 48 是 port 沒釋放不是測試失敗。
set -e
cd "$(dirname "$0")"

TESTS=(
  e2e_t1_login_home.py
  e2e_t2_accountant_no_dorm.py
  e2e_t3_storelead_own_node.py
  e2e_t4_spa_switch.py
  e2e_t5_audit_suite.py
  e2e_t6_dorm_flow.py
)

for i in "${!TESTS[@]}"; do
  t="${TESTS[$i]}"
  echo "════════ ${t} ════════"
  python3 "$t"
  if [ "$i" -lt "$((${#TESTS[@]} - 1))" ]; then
    sleep 20
  fi
done

echo
echo "e2e 六支全部通過"
