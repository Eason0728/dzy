// node test/adv/fix_alert_view.mjs —— 對抗驗證 ⑦「沒有 view 的首頁提醒不給連結」
// 攻擊：盤點所有模組 alerts() 會回的 view 型態（字串／undefined／null／數字／物件／空字串），
// 以及 dynamicTabs 模組 view 不合格、view 對不到分頁、分頁沒權限等退回規則，與 shell.js 搬過來前的語意比對。
'use strict';
import { alertViewId } from '../../platform/tabs.js';

let failed = 0, passed = 0;
function ok(c, label, extra) { if (c) passed++; else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  actual=' + JSON.stringify(extra) : '')); } }

const M = { id: 'm', views: [{ id: 'rows', requires: ['x.write'] }, { id: 'lock', requires: ['x.write'] }, { id: 'admin', requires: ['x.admin'] }] };
const permAll = () => true;
const permNoAdmin = (v) => !(v.requires || []).includes('x.admin');
const permNone = () => false;

// 沒有 view（各種非字串）→ null，只顯示不導頁
for (const v of [undefined, null, 0, 1, {}, [], true]) {
  ok(alertViewId(M, { level: 'warn', text: 't', view: v }, permAll) === null, `view=${JSON.stringify(v)} → null`);
}
ok(alertViewId(M, null, permAll) === null && alertViewId(M, {}, permAll) === null, 'item 空／沒 view → null');
// 空字串是字串 → 對不到分頁 → 退回第一個有權限的分頁（舊語意；殼自己的列用 moduleHomeTarget）
ok(alertViewId(M, { view: '' }, permAll) === 'rows', "view='' → 退回 rows");
// 對到有權限分頁
ok(alertViewId(M, { view: 'lock' }, permAll) === 'lock', 'view=lock → lock');
// 對到但沒權限 → 退回第一個有權限
ok(alertViewId(M, { view: 'admin' }, permNoAdmin) === 'rows', 'admin 沒權限 → rows');
// 全沒權限 → null
ok(alertViewId(M, { view: 'lock' }, permNone) === null, '全沒權限 → null');
// 對不到分頁 → 退回
ok(alertViewId(M, { view: 'nope' }, permAll) === 'rows', '對不到 → rows');
// manifest 沒 views
ok(alertViewId({ id: 'm' }, { view: 'rows' }, permAll) === null, '沒 views → null');

// dynamicTabs：合格 id 直接用；不合格 id（大寫／太長）走一般規則；views[0] 沒權限 → 一般規則
const D = { id: 'd', dynamicTabs: true, views: [{ id: 'home', requires: ['platform.att'] }] };
ok(alertViewId(D, { view: 'approve' }, permAll) === 'approve', 'dynamicTabs 合格 id → 原樣');
ok(alertViewId(D, { view: 'Approve' }, permAll) === 'home', 'dynamicTabs 不合格 id → 退回 home');
ok(alertViewId(D, { view: 'approve' }, permNone) === null, 'dynamicTabs views[0] 沒權限 → null');
ok(alertViewId(D, { view: undefined }, permAll) === null, 'dynamicTabs 沒 view → null（部分門市暫時讀不到）');

console.log(`fix_alert_view: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
