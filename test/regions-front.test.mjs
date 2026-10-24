// node test/regions-front.test.mjs —— 區域（督導負責區）前端：我的區域渲染、區域分頁純函式、首頁提醒規則（docs/regions/spec.md 第 4、7、8 節）
// 全部假資料、代稱。輸入形狀照 apps-script/platform/Regions.gs（regionList／regionSave preview／regionCheck）與 Staff.gs handleMyUnit_。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { esc } = await import('../platform/fmt.js');
const { mountUnit, regionsHtml, REGION_COLLAPSE_OVER } = await import('../modules/me/views/unit.js');
const M = await import('../modules/staff/views/regions-model.js');
const A = await import('../modules/staff/views/regions-alerts.js');
const { validateManifest } = await import('../platform/manifest-check.js');

let passed = 0, failed = 0;
const ok = (c, label, extra) => { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flush = () => new Promise((r) => setImmediate(r));
const render = async (data) => {
  const el = { innerHTML: '' };
  mountUnit(el, { fmt: { esc }, api: { call: async () => ({ ok: true, data }) } });
  await flush(); await flush();
  return el.innerHTML;
};

// ============ 1. 我的區域（單位通訊錄） ============
const P = (emp, nm) => ({ emp_no: emp, name: nm, title: 'pt', title_name: '計時同仁', phone: '0911000' + emp.slice(3) });
const office = { unit_name: '測試品牌辦公室', private: false, people: [P('DZY101', '督導甲')] };
let h = await render(Object.assign({}, office, { regions: [] }));
ok(h.indexOf('我的區域') === -1 && h.indexOf('data-role="region') === -1, '1 regions 空陣列：不顯示我的區域');
h = await render(office);
ok(h.indexOf('我的區域') === -1, '1 舊後端沒回 regions：不顯示我的區域');
const big = Array.from({ length: REGION_COLLAPSE_OVER + 1 }, (_, i) => P('DZY' + (300 + i), '同仁' + i));
const regs = [
  { code: 'r-mala-1', name: '北區', stores: [{ unit: 'mala-a', unit_name: '測試甲店', people: [Object.assign(P('DZY201', '店長<乙>'), { title_name: '店長', birthday: '1990-01-01', address: '測試路1號' }), Object.assign(P('DZY202', '同仁丙'), { phone: '' })] },
    { unit: 'mala-b', unit_name: '測試乙店', people: big }] },
  { code: 'r-mala-2', name: '南區', stores: [] }
];
h = await render(Object.assign({}, office, { regions: regs }));
const iUnit = h.indexOf('data-role="unit-row"'), iReg = h.indexOf('我的區域');
ok(iUnit >= 0 && iReg > iUnit, '1 我的區域接在辦公室同事下面');
ok(h.indexOf('>北區<') > iReg && h.indexOf('>南區<') > h.indexOf('>北區<'), '1 每區一個標題（區名）');
const stores = [...h.matchAll(/<details class="card" data-role="region-store" data-unit="([^"]+)"( open)?>\s*<summary><b>([^<]*)<\/b>　<span class="text-muted">(\d+) 位<\/span>/g)].map((m) => ({ unit: m[1], open: !!m[2], name: m[3], n: Number(m[4]) }));
ok(eq(stores, [{ unit: 'mala-a', open: true, name: '測試甲店', n: 2 }, { unit: 'mala-b', open: false, name: '測試乙店', n: REGION_COLLAPSE_OVER + 1 }]), '1 每家店一個可收合區塊（店名＋人數）；超過 30 人預設收合', stores);
const rows = [...h.matchAll(/data-role="region-row" data-emp="([^"]+)">([\s\S]*?)<\/div>\s*<\/div>/g)];
ok(rows.length === 2 + REGION_COLLAPSE_OVER + 1 && rows[0][2].indexOf('<b>店長&lt;乙&gt;</b>') >= 0 && rows[0][2].indexOf('店長・DZY201') >= 0, '1 每人姓名（跳脫）、職稱', rows.length);
ok(/data-field="phone"><span class="text-muted">手機<\/span>　0911000201/.test(rows[0][2]) && /手機<\/span>　—/.test(rows[1][2]), '1 手機；空的顯示「—」');
const regPart = h.slice(iReg);
ok(regPart.indexOf('生日') === -1 && regPart.indexOf('地址') === -1 && regPart.indexOf('1990-01-01') === -1 && regPart.indexOf('測試路') === -1 && regPart.indexOf('birthday') === -1, '1 我的區域不出現生日、地址（就算後端多給也不畫）');
ok(h.indexOf('這個區域目前沒有門市') >= 0, '1 沒有門市的區有提示');
ok(h.indexOf('style=') === -1, '1 沒有內嵌樣式（spec §4.10）');
ok(regionsHtml(null, esc) === '' && regionsHtml(undefined, esc) === '', '1 regionsHtml 沒資料 → 空字串');
// 門市主管（生日地址那條）不受影響
h = await render({ unit_name: '測試店', private: true, people: [Object.assign(P('DZY901', '測試甲'), { birthday: '1995-05-05', address: '測試市' })], regions: [] });
ok(h.indexOf('data-field="birthday"') >= 0 && h.indexOf('我的區域') === -1, '1 門市主管：生日地址照舊、沒有我的區域');

// ============ 2. 區域分頁純函式 ============
const org = {
  brands: [{ code: 'mzt', name: '墨竹亭' }, { code: 'mala', name: '麻的小辛辣' }, { code: 'dzy', name: '鼎兆元' }, { code: 'ck', name: '中央工廠' }],
  units: [
    { code: 'mzt-a', name: '墨竹甲店', parent: 'mzt', ladder: 'store' }, { code: 'mzt-b', name: '墨竹乙店', parent: 'mzt', ladder: 'store' },
    { code: 'mzt-office', name: '墨竹亭品牌辦公室', parent: 'mzt', ladder: 'office' },
    { code: 'mala-a', name: '小辛甲店', parent: 'mala', ladder: 'store' }, { code: 'mala-b', name: '小辛乙店', parent: 'mala', ladder: '' },
    { code: 'dzy-hq', name: '鼎兆元總部', parent: 'dzy', ladder: 'hq' }, { code: 'ck', name: '中央工廠（央廚）', parent: 'ck', ladder: 'store' }
  ]
};
ok(eq(M.assignableStores(org, 'mzt').map((s) => s.unit), ['mzt-a', 'mzt-b']), '2 可劃區門市：不含品牌辦公室');
ok(eq(M.assignableStores(org, 'mala').map((s) => s.unit), ['mala-a', 'mala-b']) && M.assignableStores(org, 'ck').length === 0 && M.assignableStores(org, 'dzy').length === 0, '2 ladder 空＝門市；總部、中央工廠不能劃區');
const list = {
  regions: [
    { code: 'r-mzt-1', name: '北區', brand: 'mzt', stores: ['mzt-a', 'mzt-old'], supervisor: 'DZY101', active: true },
    { code: 'r-mzt-2', name: '舊區', brand: 'mzt', stores: ['mzt-b'], supervisor: '', active: false },
    { code: 'r-mala-1', name: '中區', brand: 'mala', stores: ['mala-a'], supervisor: 'DZY999', active: true }
  ],
  flags: {
    region_no_supervisor: [{ code: 'r-mala-1', name: '中區', brand: 'mala', reason: 'invalid' }],
    region_store_inactive: [{ code: 'r-mzt-1', name: '北區', brand: 'mzt', stores: ['mzt-old'] }],
    store_no_region: [{ unit: 'mzt-b', unit_name: '墨竹乙店', brand: 'mzt' }, { unit: 'mala-b', unit_name: '小辛乙店', brand: 'mala' }]
  },
  ver: 'abc', on: false,
  candidates: [{ emp_no: 'DZY101', name: '督導甲', unit: 'mzt-office', unit_name: '墨竹亭品牌辦公室', brand: 'mzt' }, { emp_no: 'DZY102', name: '督導乙', unit: 'mala-office', unit_name: '小辛辣品牌辦公室', brand: 'mala' }]
};
const blocks = M.buildBlocks(list, org);
ok(eq(blocks.map((b) => b.brand_name), ['墨竹亭', '麻的小辛辣']), '2 依品牌分塊：只列有門市的品牌（不含總部、央廚），依 orgOptions 順序', blocks.map((b) => b.brand));
ok(eq(blocks[0].regions.map((g) => g.code), ['r-mzt-1', 'r-mzt-2']) && blocks[0].regions[0].store_inactive.join() === 'mzt-old' && blocks[1].regions[0].no_supervisor === 'invalid', '2 每區帶旗標（停用門市、督導失效）；停用的區排後面');
ok(eq(blocks[0].unassigned, [{ unit: 'mzt-b', unit_name: '墨竹乙店' }]) && eq(blocks[1].unassigned.map((s) => s.unit_name), ['小辛乙店']), '2 尚未劃區的門市：照後端旗標、依品牌');
ok(eq(M.unassignedStores({ regions: list.regions }, org, 'mzt').map((s) => s.unit), ['mzt-b']), '2 沒給旗標時自己算（停用的區不算劃過）');
// 已在別區
ok(eq(M.takenStores(list.regions, ''), { 'mzt-a': '北區', 'mzt-old': '北區', 'mala-a': '中區' }), '2 takenStores：只算 active 區域');
ok(eq(M.takenStores(list.regions, 'r-mzt-1'), { 'mala-a': '中區' }), '2 takenStores：自己這區不算');
let opts = M.storeOptions(org, { code: '', brand: 'mzt', stores: [] }, list.regions);
ok(eq(opts.map((o) => [o.unit, o.checked, o.disabled, o.taken_by]), [['mzt-a', false, true, '北區'], ['mzt-b', false, false, '']]), '2 新區域：已在北區的店不能勾、顯示區名；停用區的店可以勾', opts);
opts = M.storeOptions(org, list.regions[0], list.regions);
ok(eq(opts.map((o) => [o.unit, o.checked, o.disabled]), [['mzt-a', true, false], ['mzt-b', false, false], ['mzt-old', true, false]]) && opts[2].inactive && opts[2].unit_name === '已停用的門市', '2 既有區域：自己的店勾著；已停用的店列在後面（不出現代號）', opts);
opts = M.storeOptions(org, list.regions[1], list.regions);
ok(opts.find((o) => o.unit === 'mzt-a').disabled && opts.find((o) => o.unit === 'mzt-b').checked, '2 停用的區：別區用的店不能勾，自己的店勾著');
// 督導下拉
let s = M.supervisorOptions(list.candidates, 'mzt', 'DZY101');
ok(eq(s.list.map((c) => c.emp_no), ['DZY101']) && s.stale === false, '2 督導下拉只列該品牌候選人');
s = M.supervisorOptions(list.candidates, 'mala', 'DZY999');
ok(eq(s.list.map((c) => c.emp_no), ['DZY102']) && s.stale === true && M.supervisorOptions(list.candidates, 'mala', '').stale === false, '2 存著的督導不在候選名單＝已失效');
// preview 差異
ok(eq(M.diffLines([]), ['這次存檔不會改變任何督導看得到的門市。']) && eq(M.diffLines(undefined), M.diffLines([])), '2 沒有差異 → 一句說明');
ok(eq(M.diffLines([{ emp_no: 'DZY101', name: '督導甲', gained: [{ unit: 'mzt-b', unit_name: '墨竹乙店' }, { unit: 'x', unit_name: '' }], lost: [] }, { emp_no: 'DZY102', name: '督導乙', gained: [{ unit: 'mala-b', unit_name: '小辛乙店' }], lost: [{ unit: 'mala-a', unit_name: '小辛甲店' }] }]),
  ['督導甲：多看到 墨竹乙店、已停用的門市', '督導乙：多看到 小辛乙店；少看到 小辛甲店']), '2 diff → 「誰多看到／少看到哪幾家店」');
ok(M.diffLines([{ emp_no: 'DZY103', name: '', gained: [], lost: [{ unit: 'mzt-a', unit_name: '墨竹甲店' }] }])[0] === '督導：少看到 墨竹甲店', '2 沒有姓名時寫「督導」、不出現編號');
// 衝突
ok(M.isConflict({ ok: false, error: '區域設定剛被別人改過', data: { code: 'conflict' } }) && !M.isConflict({ ok: false, error: 'x', data: { code: 'bad_input' } }) && !M.isConflict({ ok: true }) && !M.isConflict(null), '2 ver 衝突判斷（code 經 api.js 放 data）');
ok(M.CONFLICT_TEXT === '資料已被別人改過，請重新整理', '2 衝突文案');
// 切換檢查
const chk = {
  on: false,
  stores_no_region: [{ brand: 'mzt', brand_name: '墨竹亭', stores: [{ unit: 'mzt-b', unit_name: '墨竹乙店' }] }],
  regions_no_supervisor: [{ code: 'r-mala-1', name: '中區', brand: 'mala', reason: 'invalid' }, { code: 'r-mala-2', name: '南區', brand: 'mala', reason: 'empty' }],
  no_director: [],
  pending_moves: [{ unit: 'mala-a', unit_name: '小辛甲店', count: 2, supervisors: ['DZY102'] }],
  att_pending_note: '考勤申請的待審在門市營運系統，請到營運系統確認',
  warn: true
};
const ci = M.checkItems(chk, org.brands);
ok(eq(ci.items.map((x) => x.key), ['stores_no_region', 'regions_no_supervisor', 'no_director', 'pending_moves']), '2 切換檢查四項、順序同規格第 7 節');
ok(eq(ci.items[0].lines, ['墨竹亭：墨竹乙店']) && eq(ci.items[1].lines, ['麻的小辛辣 中區（督導已離職或調職）', '麻的小辛辣 南區（還沒指定督導）']), '2 第 1、2 項文字（品牌＋店名／區名＋原因）', ci.items.slice(0, 2));
ok(ci.items[2].bad === false && eq(ci.items[3].lines, ['小辛甲店：2 位']) && ci.items[3].lines[0].indexOf('DZY') === -1, '2 第 3 項空；第 4 項只列店名與人數');
ok(ci.note === chk.att_pending_note && ci.warn === true && ci.on === false, '2 att_pending_note 原文、warn、開關狀態');
ok(M.checkItems({}, []).items.every((x) => !x.bad) && M.checkItems({}, []).warn === false, '2 空資料不壞');
ok(M.SWITCH_ON_TEXT.indexOf('督導只審得到自己區的店長申請與認領') >= 0 && M.SWITCH_ON_TEXT.indexOf('沒劃區的店只剩總監、人資能審') >= 0, '2 開始依區域審核的確認文字');

// ============ 3. 首頁提醒 ============
ok(eq(M.regionAlertRows(list), [{ level: 'warn', text: '1 個區域沒有督導', view: 'regions', count: 1 }, { level: 'warn', text: '1 個區域裡有停用的門市', view: 'regions', count: 1 }]), '3 開關關：沒督導、有停用門市提醒；沒劃區不提醒');
const on = Object.assign({}, list, { on: true });
ok(M.regionAlertRows(on).length === 3 && M.regionAlertRows(on)[2].text === '2 家門市還沒劃進區域' && M.regionAlertRows(on)[2].view === 'regions', '3 開關開：多「門市還沒劃進區域」');
ok(eq(M.regionAlertRows({ flags: { region_no_supervisor: [], region_store_inactive: [], store_no_region: [{ unit: 'a' }] }, on: false }), []) && eq(M.regionAlertRows(null), []), '3 沒事 → 空');
// 快取 10 分鐘、要 platform.staff
let calls = 0;
const actx = (can, id) => ({ user: { id }, can: (p) => can && p === 'platform.staff', api: { call: async (m, a) => { calls++; return { ok: true, data: on }; } } });
A.clearRegionAlerts();
ok(eq(await A.regionAlerts(actx(false, 'u1'), 0), []) && calls === 0, '3 沒有 platform.staff → 不打後端、沒提醒');
const r1 = await A.regionAlerts(actx(true, 'u1'), 1000);
const r2 = await A.regionAlerts(actx(true, 'u1'), 1000 + A.REGION_ALERT_TTL_MS - 1);
ok(r1.length === 3 && eq(r1, r2) && calls === 1 && A.REGION_ALERT_TTL_MS === 600000, '3 10 分鐘內共用快取');
await A.regionAlerts(actx(true, 'u1'), 1000 + A.REGION_ALERT_TTL_MS);
ok(calls === 2, '3 超過 10 分鐘重新讀');
await A.regionAlerts(actx(true, 'u2'), 1000 + A.REGION_ALERT_TTL_MS);
ok(calls === 3, '3 換人不共用快取');
A.clearRegionAlerts();
await A.regionAlerts(actx(true, 'u2'), 1000 + A.REGION_ALERT_TTL_MS);
ok(calls === 4, '3 存檔後清快取 → 重新讀');
A.clearRegionAlerts();
ok(eq(await A.regionAlerts({ user: { id: 'u3' }, can: () => true, api: { call: async () => ({ ok: false, error: 'x' }) } }, 0), []) &&
   eq(await A.regionAlerts({ user: { id: 'u3' }, can: () => true, api: { call: async () => { throw new Error('net'); } } }, 0), []), '3 讀不到 → 空（不影響其他提醒）');
// 模組 alerts() 有接上區域提醒
A.clearRegionAlerts();
const staffMod = (await import('../modules/staff/index.js')).default;
const mctx = { user: { id: 'u-hr' }, can: (p) => p === 'platform.staff', api: { call: async (m, a) => a === 'staffList' ? { ok: true, data: { staff: [] } } : a === 'regionList' ? { ok: true, data: on } : { ok: false } } };
const al = await staffMod.alerts(mctx);
ok(Array.isArray(al) && al.filter((x) => x.view === 'regions').length === 3, '3 同仁名單 alerts() 帶出區域提醒', al);

// ============ 4. manifest／接線 ============
const man = (await import('../modules/staff/manifest.js')).default;
ok(validateManifest(man).ok && eq(man.views.map((v) => v.id), ['list', 'import', 'clockmap', 'regions']), '4 staff manifest 四個分頁、驗證通過');
ok(eq(man.views.find((v) => v.id === 'regions').requires, ['platform.staff']) && man.views.find((v) => v.id === 'regions').name === '區域', '4 「區域」分頁 requires platform.staff');
const idx = fs.readFileSync(path.join(ROOT, 'modules/staff/index.js'), 'utf8');
ok(/regions: mountRegions/.test(idx), '4 index.js VIEW_MOUNTERS 接上 regions（從入口點得到）');
for (const f of ['modules/staff/views/regions.js', 'modules/staff/views/regions-model.js', 'modules/staff/views/regions-alerts.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(!/from '\.\.\/(\.\.\/)?(\.\.\/)?platform\//.test(src) && src.indexOf('style=') === -1, `4 ${f} 沒有 import platform/、沒有內嵌樣式`);
}
const view = fs.readFileSync(path.join(ROOT, 'modules/staff/views/regions.js'), 'utf8');
ok(/ctx\.user\.role === 'admin'/.test(view) && /expected_ver: list\.ver, preview: true/.test(view) && /ctx\.ui\.dialog/.test(view), '4 開關按鈕只給 role admin；存檔先 preview、帶 expected_ver；用共用 dialog');

console.log(`\n通過 ${passed}／${passed + failed}`);
process.exit(failed ? 1 : 0);
