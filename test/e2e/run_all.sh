#!/bin/bash
# e2e 十九支總跑（task.md T4-1）：一次跑一支、間隔 20 秒——port 進 TIME_WAIT 會衝突，
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
  e2e_t7_audit_stores.py
  e2e_t8_staff_flow.py
  e2e_t9_staff_master.py
  e2e_t10_org.py
  e2e_t11_perms.py
  e2e_t12_mobile_width.py
  e2e_t13_approvals.py
  e2e_t13_storeops.py
  e2e_t14_cashbook.py
  e2e_t15_regions.py
  e2e_t14_line_auth.py
  e2e_t17_dorm_handover_give.py
  e2e_t16_transfer_fin.py
  e2e_t18_eval.py
  e2e_t19_inspection.py
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
echo "e2e 二十支全部通過"
