#!/bin/bash
# e2e 十九支總跑（task.md T4-1）：一次跑一支、間隔 20 秒——port 進 TIME_WAIT 會衝突，
# 不要圖快改成平行（間隔秒數可用 E2E_GAP 改）。埠：被佔用就自動換空埠（common.py pick_port），也可用 E2E_PORT_OFFSET 整體偏移。任何一支失敗立刻停（set -e），Errno 48 是 port 沒釋放不是測試失敗。
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
  e2e_t20_acting_switch.py
  e2e_t21_ai_helper.py
  e2e_t23_mobile_todo.py
  e2e_t24_home_fast.py
  e2e_t25_nav_badge.py
  e2e_t26_alert_prefs.py
  e2e_t27_mobile_group.py
)

for i in "${!TESTS[@]}"; do
  t="${TESTS[$i]}"
  echo "════════ ${t} ════════"
  python3 "$t"
  if [ "$i" -lt "$((${#TESTS[@]} - 1))" ]; then
    sleep "${E2E_GAP:-20}"
  fi
done

echo
echo "e2e 二十八支全部通過"
