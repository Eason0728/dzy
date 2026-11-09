// 由 tools/gen-preload.mjs 產生，不要手改。模組代號 → 該模組本體要用到、殼還沒載入的程式檔。
export const PRELOAD = {
 "users": [
  "modules/users/index.js",
  "modules/users/views/list.js"
 ],
 "perms": [
  "modules/perms/index.js",
  "modules/perms/lib.js",
  "modules/perms/views/audit.js",
  "modules/perms/views/ex.js",
  "modules/perms/views/map.js",
  "modules/perms/views/stores.js"
 ],
 "audit-stock": [
  "modules/audit-shared/api.js",
  "modules/audit-shared/format.js",
  "modules/audit-shared/mock-data.js",
  "modules/audit-shared/ops-checklist.js",
  "modules/audit-shared/sampling.js",
  "modules/audit-shared/umd-bridge.js",
  "modules/audit-stock/index.js",
  "modules/audit-stock/views/analysis.js",
  "modules/audit-stock/views/fill-cashbox.js",
  "modules/audit-stock/views/fill-submit.js",
  "modules/audit-stock/views/fill.js",
  "modules/audit-stock/views/my.js",
  "modules/audit-stock/views/overview.js",
  "modules/audit-stock/views/report.js",
  "modules/audit-stock/views/stores.js"
 ],
 "audit-ops": [
  "modules/audit-ops/index.js",
  "modules/audit-ops/views/fill-submit.js",
  "modules/audit-ops/views/fill.js",
  "modules/audit-ops/views/my.js",
  "modules/audit-ops/views/overview.js",
  "modules/audit-ops/views/report.js",
  "modules/audit-shared/api.js",
  "modules/audit-shared/format.js",
  "modules/audit-shared/mock-data.js",
  "modules/audit-shared/ops-checklist.js",
  "modules/audit-shared/sampling.js",
  "modules/audit-shared/umd-bridge.js"
 ],
 "dorm": [
  "modules/dorm/api.js",
  "modules/dorm/index.js",
  "modules/dorm/views/create.js",
  "modules/dorm/views/handover.js",
  "modules/dorm/views/list.js"
 ],
 "staff": [
  "modules/staff-shared/clock-lib.js",
  "modules/staff-shared/clock-ui.js",
  "modules/staff-shared/esc.js",
  "modules/staff-shared/org-fields.js",
  "modules/staff/index.js",
  "modules/staff/views/clockmap.js",
  "modules/staff/views/import.js",
  "modules/staff/views/list-cards.js",
  "modules/staff/views/list.js",
  "modules/staff/views/regions-alerts.js",
  "modules/staff/views/regions-model.js",
  "modules/staff/views/regions.js"
 ],
 "me": [
  "modules/me/index.js",
  "modules/me/perm-block.js",
  "modules/me/views/applies.js",
  "modules/me/views/clock.js",
  "modules/me/views/profile.js",
  "modules/me/views/review.js",
  "modules/me/views/team.js",
  "modules/me/views/unit.js",
  "modules/staff-shared/clock-lib.js",
  "modules/staff-shared/clock-ui.js",
  "modules/staff-shared/esc.js",
  "modules/staff-shared/org-fields.js",
  "modules/staff-shared/viewer.js"
 ],
 "bulletin": [
  "modules/bulletin/index.js",
  "modules/bulletin/nav.js"
 ],
 "approvals": [
  "modules/approvals-shared/amount.js",
  "modules/approvals/actions.js",
  "modules/approvals/cards.js",
  "modules/approvals/index.js",
  "modules/approvals/lib.js",
  "modules/approvals/list-view.js",
  "modules/approvals/photo.js",
  "modules/approvals/views/all.js",
  "modules/approvals/views/handle.js",
  "modules/approvals/views/mine.js",
  "modules/approvals/views/sign.js",
  "modules/approvals/views/submit.js",
  "modules/approvals/views/thr.js",
  "modules/approvals/widgets.js"
 ],
 "storeops": [
  "modules/storeops/embed.js",
  "modules/storeops/index.js"
 ],
 "inspection": [
  "modules/inspection/index.js",
  "modules/inspection/lib.js",
  "modules/inspection/questions.js",
  "modules/inspection/scoring.js",
  "modules/inspection/views/bank.js",
  "modules/inspection/views/fill.js",
  "modules/inspection/views/list.js"
 ],
 "attendance": [
  "modules/attendance/alerts.js",
  "modules/attendance/embed.js",
  "modules/attendance/index.js",
  "modules/attendance/mobile.js"
 ],
 "schedule": [
  "modules/attendance/alerts.js",
  "modules/schedule/alerts.js",
  "modules/schedule/embed.js",
  "modules/schedule/index.js"
 ],
 "payroll": [
  "modules/payroll/bridge.js",
  "modules/payroll/index.js"
 ],
 "eval": [
  "modules/eval-shared/calc.js",
  "modules/eval/index.js",
  "modules/eval/lib.js",
  "modules/eval/seed-mala.js",
  "modules/eval/views/fill.js",
  "modules/eval/views/mine.js",
  "modules/eval/views/newbie.js",
  "modules/eval/views/results.js",
  "modules/eval/views/self.js",
  "modules/eval/views/settings.js"
 ],
 "purchase": [
  "modules/purchase/counts.js",
  "modules/purchase/embed.js",
  "modules/purchase/index.js"
 ],
 "ai-help": [
  "modules/ai-help/editor.js",
  "modules/ai-help/index.js",
  "modules/ai-help/lib.js",
  "modules/ai-help/views/kb.js",
  "modules/ai-help/views/pending.js",
  "modules/ai-help/views/usage.js",
  "platform/helper/client.js"
 ],
 "cashbook": [
  "modules/cashbook/index.js",
  "modules/cashbook/lib/load-xlsx.js",
  "modules/cashbook/lib/matrix.js",
  "modules/cashbook/lib/util.js",
  "modules/cashbook/state.js",
  "modules/cashbook/views/common.js",
  "modules/cashbook/views/export.js",
  "modules/cashbook/views/lock.js",
  "modules/cashbook/views/rows.js",
  "modules/cashbook/views/subjects.js"
 ],
 "transfer-fin": [
  "modules/transfer-fin/bridge.js",
  "modules/transfer-fin/index.js"
 ],
 "pnl": [
  "modules/pnl/bridge.js",
  "modules/pnl/index.js",
  "modules/pnl/lib/api.js",
  "modules/pnl/lib/import-logic.js",
  "modules/pnl/lib/load-xlsx.js",
  "modules/pnl/state.js",
  "modules/pnl/views/common.js",
  "modules/pnl/views/dashboard-lib.js",
  "modules/pnl/views/dashboard.js",
  "modules/pnl/views/entry-lib.js",
  "modules/pnl/views/entry.js",
  "modules/pnl/views/import.js",
  "modules/pnl/views/settings-lib.js",
  "modules/pnl/views/settings-ops.js",
  "modules/pnl/views/settings-tables.js",
  "modules/pnl/views/settings.js"
 ]
};
