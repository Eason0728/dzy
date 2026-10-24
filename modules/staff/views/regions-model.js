/**
 * modules/staff/views/regions-model.js — 區域分頁與首頁提醒的純函式（docs/regions/spec.md 第 3、7、8 節）
 * 不碰 DOM、不打後端，node 測試直接 import（test/regions-front.test.mjs）。
 *
 * 輸入形狀以 apps-script/platform/Regions.gs 為準：
 *   regionList → {regions:[{code,name,brand,stores[],supervisor,active}], idx, flags, ver, on, candidates:[{emp_no,name,unit,unit_name,brand}]}
 *   orgOptions → {brands:[{code,name}], units:[{code,name,parent,ladder}]}（只回啟用中）
 *   regionSave preview → {diff:[{emp_no,name,gained:[{unit,unit_name}],lost:[…]}]}
 *   regionCheck → {on, stores_no_region, regions_no_supervisor, no_director, pending_moves, att_pending_note, warn}
 */
'use strict';

/** 可以劃區的門市：該品牌、門市階梯（空＝門市）、不是中央工廠（同 Regions.gs regStoreOk_；orgOptions 只回啟用中） */
export function assignableStores(org, brand) {
  return ((org && org.units) || []).filter((u) => u.parent === brand && (u.ladder || 'store') === 'store' && u.code !== 'ck')
    .map((u) => ({ unit: u.code, unit_name: u.name }));
}

const nameMap = (arr) => { const m = {}; (arr || []).forEach((x) => { m[x.code] = x.name; }); return m; };

/**
 * 除了 exceptCode 這區以外，active 區域已經用掉的門市 → 區名（同後端 STORE_TAKEN 檢查：看別的 active 區域存的 stores）
 */
export function takenStores(regions, exceptCode) {
  const out = {};
  (regions || []).forEach((g) => {
    if (!g.active || g.code === exceptCode) return;
    (g.stores || []).forEach((s) => { if (!out[s]) out[s] = g.name; });
  });
  return out;
}

/** 一區的門市勾選項：該品牌可劃區門市＋這區存著但已停用的店；已在別區的不能勾 */
export function storeOptions(org, region, regions) {
  const taken = takenStores(regions, region.code || '');
  const mine = region.stores || [];
  const opts = assignableStores(org, region.brand).map((s) => {
    const by = taken[s.unit];
    return { unit: s.unit, unit_name: s.unit_name, checked: !by && mine.indexOf(s.unit) !== -1, disabled: !!by, taken_by: by || '' };
  });
  const known = opts.map((o) => o.unit);
  mine.filter((s) => known.indexOf(s) === -1).forEach((s) => {
    const by = taken[s];
    opts.push({ unit: s, unit_name: '已停用的門市', checked: !by, disabled: !!by, taken_by: by || '', inactive: true });
  });
  return opts;
}

/** 督導下拉：只列該品牌在職區督導（regionList.candidates 已由後端篩好）；目前存的督導若不在名單＝已失效 */
export function supervisorOptions(candidates, brand, current) {
  const list = (candidates || []).filter((c) => c.brand === brand).map((c) => ({ emp_no: c.emp_no, name: c.name }));
  const stale = !!current && !list.some((c) => c.emp_no === current);
  return { list, stale };
}

/** 尚未劃區的門市（依品牌）：以後端旗標 store_no_region 為準；沒給旗標就自己算 */
export function unassignedStores(list, org, brand) {
  const f = list && list.flags && Array.isArray(list.flags.store_no_region) ? list.flags.store_no_region : null;
  if (f) return f.filter((x) => x.brand === brand).map((x) => ({ unit: x.unit, unit_name: x.unit_name }));
  const used = {};
  ((list && list.regions) || []).forEach((g) => { if (g.active) (g.stores || []).forEach((s) => { used[s] = true; }); });
  return assignableStores(org, brand).filter((s) => !used[s.unit]);
}

/**
 * regionList＋orgOptions → 畫面資料：依品牌一塊（只列有可劃區門市或已有區域的品牌，依 orgOptions 順序）
 * [{brand, brand_name, regions:[{…region, no_supervisor, store_inactive:[unit], store_dup:[unit]}], unassigned:[{unit,unit_name}]}]
 */
export function buildBlocks(list, org) {
  const regions = (list && list.regions) || [];
  const flags = (list && list.flags) || {};
  const noSup = {};
  (flags.region_no_supervisor || []).forEach((x) => { noSup[x.code] = x.reason || 'empty'; });
  const inact = {};
  (flags.region_store_inactive || []).forEach((x) => { inact[x.code] = x.stores || []; });
  const dup = {};
  (flags.region_store_dup || []).forEach((x) => { dup[x.code] = x.stores || []; });
  return ((org && org.brands) || []).filter((b) => assignableStores(org, b.code).length || regions.some((g) => g.brand === b.code)).map((b) => ({
    brand: b.code,
    brand_name: b.name,
    regions: regions.filter((g) => g.brand === b.code)
      .slice().sort((x, y) => (x.active === y.active ? 0 : x.active ? -1 : 1))
      .map((g) => Object.assign({}, g, { no_supervisor: noSup[g.code] || '', store_inactive: inact[g.code] || [], store_dup: dup[g.code] || [] })),
    unassigned: unassignedStores(list, org, b.code)
  }));
}

const storeNames = (arr) => (arr || []).map((s) => s.unit_name || '已停用的門市').join('、');

/** regionSave preview 的 diff → 對話框要顯示的幾行字 */
export function diffLines(diff) {
  const d = Array.isArray(diff) ? diff : [];
  if (!d.length) return ['這次存檔不會改變任何督導看得到的門市。'];
  return d.map((x) => {
    const parts = [];
    if ((x.gained || []).length) parts.push('多看到 ' + storeNames(x.gained));
    if ((x.lost || []).length) parts.push('少看到 ' + storeNames(x.lost));
    return (x.name || '督導') + '：' + parts.join('；');
  });
}

/** 存檔失敗是不是「資料已被別人改過」（後端 code conflict，經 api.js 放在 res.data.code） */
export function isConflict(res) {
  return !!(res && res.ok === false && res.data && res.data.code === 'conflict');
}
export const CONFLICT_TEXT = '資料已被別人改過，請重新整理';

/**
 * regionCheck → 切換檢查畫面的各項（規格第 7 節）：[{key, title, lines:[字串], bad:boolean}]＋note＋warn
 * brands＝orgOptions.brands（區名旁顯示品牌）
 */
export function checkItems(chk, brands) {
  const c = chk || {};
  const bn = nameMap(brands);
  const byBrand = (arr) => (arr || []).map((g) => (g.brand_name || bn[g.brand] || '') + '：' + storeNames(g.stores));
  const reason = { empty: '還沒指定督導', invalid: '督導已離職或調職' };
  const items = [
    { key: 'stores_no_region', title: '還沒劃進任何區域的門市', lines: byBrand(c.stores_no_region) },
    { key: 'regions_no_supervisor', title: '沒有督導的區域', lines: (c.regions_no_supervisor || []).map((r) => `${bn[r.brand] || ''} ${r.name}（${reason[r.reason] || reason.empty}）`) },
    { key: 'no_director', title: '品牌沒有在職總監、又有上面兩項的店（打開後店長申請與認領只剩人資能審）', lines: byBrand(c.no_director) },
    { key: 'pending_moves', title: '目前還沒審的認領，打開後會從督導清單移走', lines: (c.pending_moves || []).map((m) => `${m.unit_name || '已停用的門市'}：${m.count} 位`) }
  ];
  items.forEach((it) => { it.bad = it.lines.length > 0; });
  return { items, note: c.att_pending_note || '', warn: !!c.warn, on: c.on === true };
}

/** 開始依區域審核前的確認文字（規格第 7 節；文案由任務指定） */
export const SWITCH_ON_TEXT = '開始後，督導只審得到自己區的店長申請與認領；沒劃區的店只剩總監、人資能審。';
export const SWITCH_OFF_TEXT = '停止後，督導立即回到審得到整個品牌的店長申請與認領。';

/**
 * 首頁提醒（spec §4.6 alerts）：regionList → [{level, text, view, count}]
 * 區沒有督導、區裡有停用門市、同店重複劃入兩區（手改試算表）：一律提醒；門市沒劃區：只有開關開著才提醒（關著時沒劃區不影響任何審核）
 */
export function regionAlertRows(list) {
  if (!list || !list.flags) return [];
  const f = list.flags;
  const out = [];
  const ns = (f.region_no_supervisor || []).length;
  const si = (f.region_store_inactive || []).length;
  const sd = (f.region_store_dup || []).length;
  const nr = (f.store_no_region || []).length;
  if (ns) out.push({ level: 'warn', text: `${ns} 個區域沒有督導`, view: 'regions', count: ns });
  if (si) out.push({ level: 'warn', text: `${si} 個區域裡有停用的門市`, view: 'regions', count: si });
  if (sd) out.push({ level: 'warn', text: `${sd} 個區域有重複劃入的門市`, view: 'regions', count: sd });
  if (nr && list.on === true) out.push({ level: 'warn', text: `${nr} 家門市還沒劃進區域`, view: 'regions', count: nr });
  return out;
}
