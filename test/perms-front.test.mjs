/**
 * 個人帳號第二期前端純函式測試（modules/perms/lib.js、modules/me/perm-block.js、manifest）
 * 跑法：node test/perms-front.test.mjs
 */
import assert from 'node:assert/strict';
import * as L from '../modules/perms/lib.js';
import * as B from '../modules/me/perm-block.js';
import permsManifest from '../modules/perms/manifest.js';
import stockManifest from '../modules/audit-stock/manifest.js';
import opsManifest from '../modules/audit-ops/manifest.js';
import { validateManifest } from '../platform/manifest-check.js';
import { READ_ACTIONS } from '../platform/dryrun.js';

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push(`${name}｜${e.message}`); }
}

const ORG = {
  ladders: [{ code: 'store', name: '門市' }, { code: 'office', name: '品牌辦公室' }, { code: 'hq', name: '總部' }],
  titles: [
    { code: 'sm', name: '店長', ladder: 'store', rank: 3 },
    { code: 'osv', name: '區督導', ladder: 'office', rank: 2 },
    { code: 'ceo', name: '執行長', ladder: 'hq', rank: 9 },
    { code: 'hm', name: '人資主管', ladder: 'hq', rank: 5 }
  ],
  depts: [{ code: 'hr', name: '人資部', unit: 'dzy-hq' }, { code: 'ops', name: '營運部', unit: 'dzy-hq' }]
};

t('chip：門市・店長', () => assert.equal(L.ruleTargetText({ ladder: 'store', dept: '', title: 'sm' }, ORG), '門市・店長'));
t('chip：品牌辦公室・區督導', () => assert.equal(L.ruleTargetText({ ladder: 'office', dept: '', title: 'osv' }, ORG), '品牌辦公室・區督導'));
t('chip：總部・人資部・全部職稱', () => assert.equal(L.ruleTargetText({ ladder: 'hq', dept: 'hr', title: '*' }, ORG), '總部・人資部・全部職稱'));
t('chip：總部・全部部門・執行長', () => assert.equal(L.ruleTargetText({ ladder: 'hq', dept: '', title: 'ceo' }, ORG), '總部・全部部門・執行長'));
t('chip：找不到名稱退回代碼', () => assert.equal(L.ruleTargetText({ ladder: 'hq', dept: 'zz', title: 'qq' }, ORG), '總部・zz・qq'));

const RULES = [
  { rule_id: 'R019', ladder: 'hq', dept: 'hr', title: 'hm', perm: 'platform.permmap' },
  { rule_id: 'R001', ladder: 'store', dept: '', title: 'sm', perm: 'audit.read.own' },
  { rule_id: 'R005', ladder: 'hq', dept: 'ops', title: '*', perm: 'audit.read' },
  { rule_id: 'R007', ladder: 'hq', dept: '', title: 'ceo', perm: 'audit.read' },
  { rule_id: 'R002', ladder: 'office', dept: '', title: 'osv', perm: 'audit.read.brand' }
];
const DATA = Object.assign({ rules: RULES, grantable: L.FEATURE_ORDER.slice().reverse(), locked: ['platform.users', 'platform.permmap'] }, ORG);

t('對照表 9 列、順序固定（不跟後端 grantable 順序）', () => {
  const rows = L.featureRows(DATA);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.map((r) => r.perm), L.FEATURE_ORDER);
  assert.equal(rows[0].name, '看自己店稽核');
  assert.equal(rows[8].name, '改權限對照表');
});
t('鎖住的兩列', () => {
  const locked = L.featureRows(DATA).filter((r) => r.locked).map((r) => r.perm);
  assert.deepEqual(locked, ['platform.users', 'platform.permmap']);
});
t('同一列的 chip 依階梯→部門排', () => {
  const r = L.featureRows(DATA).find((x) => x.perm === 'audit.read');
  assert.deepEqual(r.rules.map((x) => x.text), ['總部・全部部門・執行長', '總部・營運部・全部職稱']);
});
t('沒有規則的功能 rules 為空', () => assert.deepEqual(L.featureRows(DATA).find((x) => x.perm === 'dorm.write').rules, []));

t('錯誤碼 → 中文', () => {
  assert.equal(L.errorText({ ok: false, error: 'x', code: 'perm_self' }), '這個改動會改到你自己的權限，請系統管理員處理');
  assert.equal(L.errorText({ ok: false, error: 'x', data: { code: 'perm_locked' } }), '只有系統管理員能改這個功能的對象');
  assert.equal(L.errorText({ ok: false, error: '人資主管要請系統管理員設定', data: { code: 'perm_admin_only' } }), '人資主管要請系統管理員設定');
  assert.equal(L.errorText({ ok: false, error: '後端原文' }), '後端原文');
});

t('alerts：非 admin 不回', () => assert.deepEqual(L.computeAlerts({ isAdmin: false, audit: { unseen: 3 } }), []));
t('alerts：未讀異動', () => {
  const a = L.computeAlerts({ isAdmin: true, audit: { inited: true, unseen: 3 }, stores: { inited: true, items: [], units: [] } });
  assert.deepEqual(a, [{ level: 'warn', text: '有 3 筆權限異動待看', view: 'audit' }]);
});
t('alerts：門市單位沒對照稽核店', () => {
  const stores = { inited: true, items: [{ unit: 'a', audit_store: 'sxl-gf' }, { unit: 'b', audit_store: '' }],
    units: [{ code: 'a', ladder: 'store' }, { code: 'b', ladder: 'store' }, { code: 'c', ladder: 'store' }, { code: 'h', ladder: 'hq' }] };
  const a = L.computeAlerts({ isAdmin: true, audit: { inited: true, unseen: 0 }, stores });
  assert.deepEqual(a, [{ level: 'info', text: '有 2 個門市單位還沒對照稽核店', view: 'stores' }]);
});
t('alerts：全部正常＝空；未初始化＝一列提醒', () => {
  assert.deepEqual(L.computeAlerts({ isAdmin: true, audit: { inited: true, unseen: 0 }, stores: { inited: true, items: [], units: [] } }), []);
  assert.deepEqual(L.computeAlerts({ isAdmin: true, map: { inited: false } }), [{ level: 'warn', text: '權限設定還沒初始化', view: 'map' }]);
});

t('例外狀態與排序', () => {
  assert.equal(L.exStatus({ status: 'expired', active: true }).dim, true);
  assert.equal(L.exStatus({ status: 'revoked', active: false }).revocable, false);
  assert.equal(L.exStatus({ status: 'active', active: true }).dim, false);
  const s = L.sortExItems([{ ex_id: 'X1', status: 'revoked', created_at: '2026-10-03' }, { ex_id: 'X2', status: 'active', created_at: '2026-10-01' }, { ex_id: 'X3', status: 'expired', created_at: '2026-10-02' }]);
  assert.deepEqual(s.map((x) => x.ex_id), ['X2', 'X3', 'X1']);
  assert.equal(L.untilText(''), '不到期');
  assert.equal(L.untilText('2026-10-31'), '到 2026-10-31');
});
t('找同仁：編號、姓名、同名、找不到', () => {
  const staff = [{ emp_no: 'DZY001', name: '王小明' }, { emp_no: 'DZY002', name: '李大華' }, { emp_no: 'DZY003', name: '李大華' }];
  assert.equal(L.resolvePerson('dzy001', staff).person.emp_no, 'DZY001');
  assert.equal(L.resolvePerson('DZY001 王小明', staff).person.emp_no, 'DZY001');
  assert.equal(L.resolvePerson('王小明', staff).person.emp_no, 'DZY001');
  assert.ok(L.resolvePerson('李大華', staff).error.includes('同名'));
  assert.ok(L.resolvePerson('沒這人', staff).error);
  assert.ok(L.resolvePerson('', staff).error);
});
t('拿掉看全部店稽核的提示', () => {
  assert.ok(L.removeAuditReadHint('audit.read', 'remove').includes('填單權限仍可看全部店'));
  assert.equal(L.removeAuditReadHint('audit.read', 'add'), '');
  assert.equal(L.removeAuditReadHint('dorm.read', 'remove'), '');
});
t('權限異動白話', () => {
  const v = L.auditRowView({ cause: 'staff_edit', emp_no: 'DZY001', name: '王小明', added: 'audit.read.own', removed: 'dorm.read,audit.write' });
  assert.equal(v.who, '王小明（DZY001）');
  assert.equal(v.causeText, '改了同仁的單位／職稱');
  assert.deepEqual(v.added, ['看自己店稽核']);
  assert.deepEqual(v.removed, ['看宿舍清單', '填稽核單與門市管理']);
  const m = L.auditRowView({ cause: 'perm_map', detail: { rules_added: ['R020'], rules_removed: [], affected: 4, people: [] } });
  assert.equal(m.isMap, true);
  assert.equal(m.summary, '新增 1 條、移除 0 條規則，影響 4 人');
  assert.equal(L.causeText('perm_ex'), '個別例外');
});

// ---- 我的資料：我能用的功能 ----
const prof = { title_name: '店長', dept_name: '人資部' };
t('來源文字', () => {
  assert.equal(B.sourceText({ source: 'title' }, prof), '因為職稱：店長');
  assert.equal(B.sourceText({ source: 'dept' }, prof), '因為部門：人資部');
  assert.equal(B.sourceText({ source: 'exception', until: '2026-10-31' }, prof), '個別例外，到 10/31');
  assert.equal(B.sourceText({ source: 'exception' }, prof), '個別例外');
  assert.equal(B.sourceText({ source: 'implied' }, prof), '因為能填稽核單');
  assert.equal(B.sourceText({ source: 'role' }, prof), '系統角色');
});
t('稽核範圍文字', () => {
  assert.equal(B.scopeText('all', []), '全部店');
  assert.equal(B.scopeText(['sxl-gf'], ['audit.read.own']), '自己店');
  assert.equal(B.scopeText(['a', 'b', 'c'], ['audit.read.brand']), '自己品牌 3 家');
  assert.equal(B.scopeText('none', []), '');
});
t('同功能多來源合併一列、隱藏登入碼', () => {
  const lines = B.permLines([
    { perm: 'audit.read', source: 'title' }, { perm: 'audit.read', source: 'exception', until: '2026-10-31' },
    { perm: 'platform.login', source: 'role' }, { perm: 'platform.self', source: 'role' }
  ], prof);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, '看全部店稽核');
  assert.deepEqual(lines[0].texts, ['因為職稱：店長', '個別例外，到 10/31']);
});
t('enabled:false 不顯示這塊', () => {
  const esc = (s) => String(s);
  assert.equal(B.permBlockHtml({ enabled: false }, prof, esc), '');
  assert.equal(B.permBlockHtml(null, prof, esc), '');
  const h = B.permBlockHtml({ enabled: true, items: [{ perm: 'audit.read.own', source: 'title' }], audit_scope: ['sxl-gf'] }, prof, esc);
  assert.ok(h.includes('我能用的功能') && h.includes('因為職稱：店長') && h.includes('稽核範圍：自己店'));
});

// ---- manifest ----
t('perms manifest 合法、dept=it、四個分頁', () => {
  const r = validateManifest(permsManifest);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(permsManifest.dept, 'it');
  assert.deepEqual(permsManifest.requires, ['platform.permmap']);
  assert.deepEqual(permsManifest.views.map((v) => v.id), ['map', 'ex', 'stores', 'audit']);
  assert.deepEqual(permsManifest.views.slice(1).map((v) => v.requires[0]), ['platform.permex', 'platform.permex', 'platform.permex']);
});
t('稽核兩模組 requires', () => {
  for (const m of [stockManifest, opsManifest]) {
    assert.ok(validateManifest(m).ok);
    assert.deepEqual(m.requires, ['audit.read', 'audit.read.brand', 'audit.read.own']);
    const v = (id) => (m.views.find((x) => x.id === id) || {}).requires;
    assert.deepEqual(v('overview'), ['audit.read', 'audit.read.brand']);
    assert.deepEqual(v('report'), ['audit.read', 'audit.read.brand']);
    assert.deepEqual(v('fill'), ['audit.write']);
    assert.deepEqual(v('my'), ['audit.read.own']);
  }
  const s = stockManifest.views;
  assert.deepEqual(s.find((x) => x.id === 'analysis').requires, ['audit.read', 'audit.read.brand']);
  assert.deepEqual(s.find((x) => x.id === 'stores').requires, ['audit.write']);
});
t('試跑模式放行五個讀取 action、不放行寫入', () => {
  for (const a of ['permMapGet', 'permExList', 'permStoreGet', 'myPerms', 'permAuditList']) assert.ok(READ_ACTIONS.platform.includes(a), a);
  for (const a of ['permInit', 'permMapSave', 'permExSave', 'permExRevoke', 'permStoreSave', 'permAuditSeen']) assert.ok(!READ_ACTIONS.platform.includes(a), a);
});

if (fails.length) {
  console.log(`FAIL ${fails.length} 項：`);
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(`PASS ${pass}`);
