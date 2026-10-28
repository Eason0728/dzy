/**
 * modules/perms/lib.js — 權限設定的純函式（不碰 DOM、不碰網路，node 測試直接 import）
 * 對照後端：apps-script/platform/PermActions.gs（輸入輸出）、Perms.gs（PERM_GRANTABLE／PERM_NAMES）。
 */
'use strict';

/** 可給的 19 個功能（順序＝畫面順序＝後端 PERM_GRANTABLE） */
export const FEATURE_ORDER = ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write', 'platform.staff', 'platform.users', 'platform.permmap', 'store.void', 'att.extra', 'payroll.write', 'cashbook.write', 'platform.bulletin', 'platform.purchase',
  'pnl.read', 'pnl.write', 'pnl.admin', 'transfer.write'];

/** 人資主管（platform.permmap 但不是 admin）在個別例外只能動的三碼（2026-10-26 加公告管理）；對照後端 STORE_HR_GRANTABLE，真正擋的是後端，前端只是不顯示選不了的 */
export const HR_EX_FEATURES = ['store.void', 'att.extra', 'platform.bulletin'];

export const FEATURE_NAMES = {
  'audit.read.own': '看自己店稽核',
  'audit.read.brand': '看自己品牌稽核',
  'audit.read': '看全部店稽核',
  'audit.write': '填稽核單與門市管理',
  'dorm.read': '看宿舍清單',
  'dorm.write': '宿舍建約點交',
  'platform.staff': '同仁名單',
  'platform.users': '人員管理',
  'platform.permmap': '改權限對照表',
  'store.void': '收支作廢',
  'att.extra': '額外考勤核定',
  'payroll.write': '薪酬管理',
  'cashbook.write': '收支管理',
  'platform.bulletin': '公告管理',
  'platform.purchase': '貨單核對',
  'pnl.read': '看損益',
  'pnl.write': '填損益',
  'pnl.admin': '損益定稿與設定',
  'transfer.write': '調撥管理'
};

/** 其他會出現在 myPerms／異動裡的碼 */
const OTHER_NAMES = {
  'platform.permex': '個別例外', 'platform.self': '我的資料', 'platform.review': '待審核',
  'platform.login': '登入', '*': '全部功能'
};

/**
 * 功能碼 → 中文。units（選填）＝可設「只看考勤」的門市（permExList 的 att_view_units：[{code, name}]，或 {code: name}），
 * 只用在 att.view@<單位>（2026-10-26 指定門市只看考勤）；不是物件（例如 Array.map 傳進來的 index）就忽略。
 */
export function featureName(code, units, payStores) {
  const ps = payrollStoreOf(code);
  if (ps) return `薪酬負責門市：${payrollStoreName(ps, payStores)}`;
  const u = attViewUnitOf(code);
  if (u) return `只看考勤（${attViewUnitName(u, units)}）`;
  return FEATURE_NAMES[code] || OTHER_NAMES[code] || code;
}

// ---- 指定門市只看考勤（att.view@<單位>，docs/att-support/spec.md §2；只有 admin 能設、只能多給、只能用個別例外） ----
export const ATT_VIEW_PREFIX = 'att.view@';
/** 功能下拉裡「指定門市只看考勤」那一項的值（不是權限碼；送出時換成 att.view@<門市>） */
export const ATT_VIEW_CHOICE = '__att_view__';
export const ATT_VIEW_CHOICE_NAME = '指定門市只看考勤';
const ATT_VIEW_RE = /^att\.view@([A-Za-z0-9_-]{1,40})$/;
/** att.view@<單位> → 單位代碼；其他 → '' */
export function attViewUnitOf(code) {
  const m = ATT_VIEW_RE.exec(String(code || ''));
  return m ? m[1] : '';
}
/** 門市代碼 → 權限碼；代碼格式不對回 '' */
export function attViewCode(unit) {
  const c = ATT_VIEW_PREFIX + String(unit || '').trim();
  return attViewUnitOf(c) ? c : '';
}
function attViewUnitName(unit, units) {
  if (!units || typeof units !== 'object') return unit;
  if (Array.isArray(units)) {
    const hit = units.find((x) => x && x.code === unit);
    return hit && hit.name ? hit.name : unit;
  }
  return units[unit] || unit;
}

// ---- 薪酬負責門市（payroll.store@<薪資店代碼>，docs/payroll-scope/spec.md §5；只有 admin 能設、只能多給、只能用個別例外） ----
export const PAYROLL_STORE_PREFIX = 'payroll.store@';
/** 功能下拉裡「薪酬：負責門市」那一項的值（不是權限碼；送出時換成 payroll.store@<代碼>） */
export const PAYROLL_STORE_CHOICE = '__payroll_store__';
export const PAYROLL_STORE_CHOICE_NAME = '薪酬：負責門市';
const PAYROLL_STORE_RE = /^payroll\.store@([A-Z0-9]{2,12})$/;   // 與後端 Perms.gs PERM_PAYROLL_STORE_RE 一致
/** payroll.store@<代碼> → 代碼；其他 → '' */
export function payrollStoreOf(perm) {
  const m = PAYROLL_STORE_RE.exec(String(perm || ''));
  return m ? m[1] : '';
}
/** 薪資店代碼（前後空白、大小寫都容忍）→ 權限碼；格式不對回 '' */
export function payrollStoreCode(code) {
  const c = PAYROLL_STORE_PREFIX + String(code == null ? '' : code).trim().toUpperCase();
  return payrollStoreOf(c) ? c : '';
}
function payrollStoreName(code, stores) {
  const hit = Array.isArray(stores) ? stores.find((x) => x && x.code === code) : null;
  return hit && hit.name ? `${hit.name}（${code}）` : code;
}
/** 下拉顯示：名稱（代碼），停用的加「停用」 */
/** 薪資後端門市表的 active 存字串 'true'／'false'（也可能是布林）：只有 false／'false'（不分大小寫、前後空白）算停用 */
function payrollStoreOff(v) { return String(v).trim().toLowerCase() === 'false'; }
export function payrollStoreLabel(st) {
  return `${st.name || st.code}（${st.code}）${payrollStoreOff(st.active) ? '停用' : ''}`;
}
/**
 * payroll_store_get 的回應 → [{code,name,active}]；失敗或讀不到陣列回 null。
 * 殼對代轉 ns 的包法不固定（flat：r.data.stores；上游 {ok,data} 被整包塞進來：r.data.data.stores），兩種都收。
 */
export function parsePayrollStores(r) {
  if (!r || r.ok === false) return null;
  let d = r.data;
  let arr = d && d.stores;
  if (!Array.isArray(arr) && d && d.data) { d = d.data; arr = d && d.stores; }
  if (!Array.isArray(arr)) return null;
  return arr.filter((x) => x && typeof x === 'object' && x.code).map((x) => ({ code: String(x.code), name: x.name ? String(x.name) : '', active: !payrollStoreOff(x.active) }));
}

const LADDER_FALLBACK = { store: '門市', office: '品牌辦公室', hq: '總部' };
const LADDER_ORDER = ['store', 'office', 'hq'];

/**
 * 一條規則的對象文字：「門市・店長」「總部・人資部・全部職稱」「總部・全部部門・執行長」。
 * 只有總部才有「部門」這一段。org＝permMapGet 回傳（titles／depts／ladders）。
 */
export function ruleTargetText(rule, org) {
  org = org || {};
  const ladders = org.ladders || [];
  const lad = ladders.find((l) => l.code === rule.ladder);
  const parts = [lad ? lad.name : (LADDER_FALLBACK[rule.ladder] || rule.ladder)];
  if (rule.ladder === 'hq') {
    if (!rule.dept) parts.push('全部部門');
    else {
      const d = (org.depts || []).find((x) => x.code === rule.dept);
      parts.push(d ? d.name : rule.dept);
    }
  }
  if (rule.title === '*') parts.push('全部職稱');
  else {
    const titles = org.titles || [];
    const t = titles.find((x) => x.code === rule.title && x.ladder === rule.ladder) || titles.find((x) => x.code === rule.title);
    parts.push(t ? t.name : rule.title);
  }
  return parts.join('・');
}

function titleRank(rule, org) {
  if (rule.title === '*') return 0;
  const t = ((org && org.titles) || []).find((x) => x.code === rule.title && x.ladder === rule.ladder);
  return t && typeof t.rank === 'number' ? t.rank : 99;
}

/**
 * 對照表的列：一個功能一列，順序固定＝FEATURE_ORDER（後端 grantable 有多的接在後面）。
 * 每列 { perm, name, locked, rules:[{rule_id, text}] }；規則依 階梯→部門→職級→編號 排。
 */
export function featureRows(data) {
  data = data || {};
  const names = data.names || {};
  const lockedSet = new Set(data.locked || []);
  const perms = FEATURE_ORDER.slice();
  (data.grantable || []).forEach((p) => { if (perms.indexOf(p) === -1) perms.push(p); });
  return perms.map((perm) => {
    const rules = (data.rules || []).filter((r) => r.perm === perm).slice().sort((a, b) =>
      (LADDER_ORDER.indexOf(a.ladder) - LADDER_ORDER.indexOf(b.ladder))
      || (String(a.dept).localeCompare(String(b.dept)))
      || (titleRank(a, data) - titleRank(b, data))
      || String(a.rule_id).localeCompare(String(b.rule_id)));
    return {
      perm,
      name: FEATURE_NAMES[perm] || names[perm] || perm,
      locked: lockedSet.has(perm),
      rules: rules.map((r) => ({ rule_id: r.rule_id, text: ruleTargetText(r, data) }))
    };
  });
}

/** 錯誤碼 → 中文（畫面判斷用 code；沒對到就顯示後端的 error） */
export function codeOf(res) {
  if (!res) return '';
  return res.code || (res.data && res.data.code) || '';
}

export function errorText(res) {
  const code = codeOf(res);
  switch (code) {
    case 'perm_self': return '這個改動會改到你自己的權限，請系統管理員處理';
    case 'perm_locked': return '只有系統管理員能改這個功能的對象';
    case 'perm_admin_only': return '人資主管要請系統管理員設定';
    case 'self_org_edit': return '不能修改自己的單位、部門或職稱，請找人資或系統管理員';
    case 'not_inited': return '權限設定還沒初始化，請系統管理員先按「初始化」';
    case 'no_perm': return '沒有權限';
    default: return (res && res.error) || '失敗了，請稍後再試';
  }
}

/** 異動原因類型 */
export const CAUSE_TEXT = {
  staff_edit: '改了同仁的單位／職稱',
  confirm: '後台確認同仁資料',
  perm_map: '改了權限對照表',
  perm_ex: '個別例外'
};

export function causeText(cause) {
  return CAUSE_TEXT[cause] || cause || '';
}

function permList(csv) {
  return String(csv || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** 一列權限異動的白話：{ who, causeText, added:[中文], removed:[中文], isMap, detail } */
export function auditRowView(item) {
  const isMap = item.cause === 'perm_map';
  const detail = isMap ? (item.detail || null) : null;
  return {
    who: item.name ? `${item.name}（${item.emp_no}）` : (item.emp_no || ''),
    causeText: causeText(item.cause),
    isMap,
    detail,
    added: isMap ? [] : permList(item.added).map(featureName),
    removed: isMap ? [] : permList(item.removed).map(featureName),
    summary: isMap && detail
      ? `新增 ${(detail.rules_added || []).length} 條、移除 ${(detail.rules_removed || []).length} 條規則，影響 ${detail.affected || 0} 人`
      : ''
  };
}

/** 例外清單的狀態文字與是否灰掉 */
export function exStatus(item) {
  if (item.status === 'revoked' || item.active === false) return { text: '已撤銷', dim: true, revocable: false };
  if (item.status === 'expired') return { text: '已過期', dim: true, revocable: true };
  return { text: '生效中', dim: false, revocable: true };
}

export function untilText(until) {
  return until ? `到 ${until}` : '不到期';
}

/** 例外清單排序：生效中在前，其餘（過期、撤銷）在後；各自新的在前 */
export function sortExItems(items) {
  const rank = (i) => (i.status === 'active' && i.active !== false ? 0 : (i.status === 'expired' ? 1 : 2));
  return (items || []).slice().sort((a, b) =>
    (rank(a) - rank(b)) || String(b.created_at).localeCompare(String(a.created_at)));
}

/** 從輸入的字（「DZY001」「王小明」「DZY001 王小明」）找出同仁；回 {person}|{error} */
export function resolvePerson(text, staff) {
  const t = String(text || '').trim();
  if (!t) return { error: '請選擇同仁' };
  const list = staff || [];
  const first = t.split(/\s+/)[0].toUpperCase();
  let hit = list.filter((p) => String(p.emp_no).toUpperCase() === first);
  if (hit.length === 1) return { person: hit[0] };
  hit = list.filter((p) => p.name === t);
  if (hit.length === 1) return { person: hit[0] };
  if (hit.length > 1) return { error: '有同名的同仁，請改用編號' };
  return { error: '找不到這位同仁' };
}

/** 拿掉「看全部店稽核」時，對方若同時有填單權限，畫面要提醒 */
export function removeAuditReadHint(perm, mode) {
  return perm === 'audit.read' && mode === 'remove'
    ? '提醒：如果對方有「填稽核單」的權限，填單權限仍可看全部店；要連填單都拿掉，請另外拿掉「填稽核單與門市管理」。'
    : '';
}

/** 沒對照到稽核店的門市單位 */
export function unmappedStoreUnits(storeData) {
  const d = storeData || {};
  const mapped = {};
  (d.items || []).forEach((i) => { if (i.audit_store) mapped[i.unit] = true; });
  return (d.units || []).filter((u) => u.ladder === 'store' && !mapped[u.code]);
}

/**
 * 首頁提醒（只給 admin）。入參都是 API 的 data（可為 null＝讀不到）：
 *  - map：permMapGet；audit：permAuditList；stores：permStoreGet
 * 回 [{level,text,view}]。
 */
export function computeAlerts(input) {
  const { isAdmin, map, audit, stores } = input || {};
  if (!isAdmin) return [];
  const out = [];
  if (map && map.inited === false) {
    out.push({ level: 'warn', text: '權限設定還沒初始化', view: 'map' });
    return out;
  }
  if (audit && audit.inited !== false && Number(audit.unseen) > 0) {
    out.push({ level: 'warn', text: `有 ${audit.unseen} 筆權限異動待看`, view: 'audit' });
  }
  if (stores && stores.inited !== false) {
    const n = unmappedStoreUnits(stores).length;
    if (n > 0) out.push({ level: 'info', text: `有 ${n} 個門市單位還沒對照稽核店`, view: 'stores' });
  }
  return out;
}

// ============================================================
// 對照表改版（版本 B：先選身分、再開關功能）
// 身分鍵 key＝`ladder|dept|title`（dept 空＝不分部門；title '*'＝全部職稱），與後端 permMapGet.counts 同格式。
// ============================================================

/** 每個功能的一句白話說明（畫面用） */
export const FEATURE_DESC = {
  'audit.read.own': '看自己那家店的盤點與稽核結果',
  'audit.read.brand': '看同品牌所有店的總覽與報告',
  'audit.read': '看全公司每家店的總覽、報告、異常分析',
  'audit.write': '到店填盤點與營運稽核、管理門市清單',
  'dorm.read': '看宿舍合約清單',
  'dorm.write': '建立合約、退宿點交、終止',
  'platform.staff': '新增、離職、匯入同仁',
  'platform.users': '管理系統帳號（BOSS 這類）',
  'platform.permmap': '改這一頁',
  'store.void': '門市現金收支可以作廢（店長預設有；其他人要在個別例外給）',
  'att.extra': '額外核定本單位所有要考勤的人（只能在個別例外給，可設到期日）',
  'payroll.write': '進薪酬管理：看與改全集團薪資、鎖定月份（建議只用個別例外開給指定的人）',
  'cashbook.write': '進收支管理：會計跨店查現金收支、作廢、月結鎖定、改會計科目、匯出 Excel（財務部門預設有）',
  'platform.bulletin': '進電子佈告欄的公告管理：新增、上架、下架、置頂公告與看簽名回條（總監級以上預設有）',
  'platform.purchase': '進貨單核對：核對入帳廠商貨單、看食材成本與單價報表（財務部門預設有）',
  'pnl.read': '進損益系統，只能看儀表板',
  'pnl.write': '進損益系統：看、填資料、匯入、確認為 0（財務部門預設有）',
  'pnl.admin': '損益定稿、解除定稿、改設定（只有系統管理員能開）',
  'transfer.write': '進調撥管理：看調撥月報、品項記憶、卡關總覽，產月報、改品項記憶（財務部門預設有）'
};

/** 總部高層（不分部門）的職稱代碼 */
const HQ_TOP_TITLES = ['ceo', 'gm', 'chair'];
/** 總監的職稱代碼 */
const HQ_HEAD_TITLE = 'hm';

export function keyOf(ladder, dept, title) {
  return `${ladder || ''}|${dept || ''}|${title || ''}`;
}
export function ruleKey(rule) {
  return keyOf(rule.ladder, rule.dept, rule.title);
}

function titleList(data, ladder) {
  return ((data && data.titles) || []).filter((t) => t.ladder === ladder).slice()
    .sort((a, b) => (a.rank || 0) - (b.rank || 0));
}

/**
 * 左側身分清單：[{ id, title, items:[{ key, ladder, dept, title, name }] }]
 * 分組：門市、品牌辦公室、總部（依部門：每部門「全部職稱」＋「總監」）、總部（高層）、其他（現有規則的目標不在以上清單，不得隱藏）。
 */
export function identityGroups(data) {
  data = data || {};
  const groups = [];
  const known = {};
  const mk = (ladder, dept, title, name) => { const key = keyOf(ladder, dept, title); known[key] = true; return { key, ladder, dept, title, name }; };
  const stores = titleList(data, 'store').map((t) => mk('store', '', t.code, t.name));
  if (stores.length) groups.push({ id: 'store', title: '門市（含中央工廠）', items: stores });
  const offices = titleList(data, 'office').map((t) => mk('office', '', t.code, t.name));
  if (offices.length) groups.push({ id: 'office', title: '品牌辦公室', items: offices });
  const hqItems = [];
  (data.depts || []).forEach((d) => {
    hqItems.push(mk('hq', d.code, '*', `${d.name}・全部職稱`));
    hqItems.push(mk('hq', d.code, HQ_HEAD_TITLE, `${d.name}・總監`));
  });
  if (hqItems.length) groups.push({ id: 'hq-dept', title: '總部（依部門）', items: hqItems });
  const tops = titleList(data, 'hq').filter((t) => HQ_TOP_TITLES.indexOf(t.code) !== -1).map((t) => mk('hq', '', t.code, t.name));
  // 2026-10-26：「總監（全部部門）」＝一條規則涵蓋每個部門的總監（公告管理預設用它，之後新增的部門也自動適用）
  const head = titleList(data, 'hq').find((t) => t.code === HQ_HEAD_TITLE);
  if (head) tops.unshift(mk('hq', '', HQ_HEAD_TITLE, `${head.name}（全部部門）`));
  if (tops.length) groups.push({ id: 'hq-top', title: '總部（不分部門）', items: tops });
  const others = [];
  const seen = {};
  (data.rules || []).forEach((r) => {
    const key = ruleKey(r);
    if (known[key] || seen[key]) return;
    seen[key] = true;
    others.push({ key, ladder: r.ladder, dept: r.dept, title: r.title, name: ruleTargetText(r, data) });
  });
  if (others.length) groups.push({ id: 'other', title: '其他', items: others });
  return groups;
}

export function identityName(data, key) {
  const g = identityGroups(data);
  for (const grp of g) for (const it of grp.items) if (it.key === key) return it.name;
  const [ladder, dept, title] = String(key).split('|');
  return ruleTargetText({ ladder, dept, title }, data);
}

/** 某身分在「畫面上的暫存狀態」下，有沒有某功能。pending＝{ 'key|perm': true|false }（只放有改的） */
export function isOn(data, pending, key, perm) {
  const pk = `${key}|${perm}`;
  if (pending && Object.prototype.hasOwnProperty.call(pending, pk)) return !!pending[pk];
  return (data.rules || []).some((r) => ruleKey(r) === key && r.perm === perm);
}

function savedOn(data, key, perm) {
  return isOn(data, null, key, perm);
}

/** 目前未儲存的變更：[{ key, perm, on }]（跟已存的狀態相同的不算） */
export function pendingChanges(data, pending) {
  const out = [];
  Object.keys(pending || {}).forEach((pk) => {
    const i = pk.lastIndexOf('|');
    const key = pk.slice(0, i);
    const perm = pk.slice(i + 1);
    const on = !!pending[pk];
    if (on !== savedOn(data, key, perm)) out.push({ key, perm, on });
  });
  return out;
}

/** 變更 → permMapSave 的 payload：開＝add 一條；關＝remove 該目標＋功能的所有規則 */
export function buildPayload(data, changes) {
  const add = [];
  const remove = [];
  (changes || []).forEach((c) => {
    const [ladder, dept, title] = c.key.split('|');
    if (c.on) add.push({ ladder, dept, title, perm: c.perm });
    else (data.rules || []).forEach((r) => { if (ruleKey(r) === c.key && r.perm === c.perm && remove.indexOf(r.rule_id) === -1) remove.push(r.rule_id); });
  });
  return { add, remove };
}

/** 其他規則有沒有「一定會命中」這個身分（含畫面暫存狀態）：回那些規則的白話名稱 */
export function alsoFrom(data, pending, key, perm) {
  const [ladder, dept, title] = key.split('|');
  const keys = {};
  (data.rules || []).forEach((r) => { keys[ruleKey(r)] = true; });
  Object.keys(pending || {}).forEach((pk) => { keys[pk.slice(0, pk.lastIndexOf('|'))] = true; });
  const out = [];
  Object.keys(keys).forEach((k) => {
    if (k === key) return;
    const [l, d, t] = k.split('|');
    if (l !== ladder) return;
    if (t !== '*' && t !== title) return;          // 目標職稱要是全部，或剛好就是這個身分的職稱
    if (title === '*' && t !== '*') return;        // 這個身分是「全部職稱」，只有同為全部職稱的規則才一定命中所有人
    if (d !== '' && d !== dept) return;            // 目標有部門就要同部門
    if (isOn(data, pending, k, perm)) out.push(identityName(data, k));
  });
  return out.sort();
}

/** 未儲存變更摘要：「店長 多了『看宿舍清單』」；多筆「…、… 等 N 項」 */
export function changeSummary(data, changes) {
  const parts = (changes || []).map((c) => `${identityName(data, c.key)} ${c.on ? '多了' : '少了'}『${featureName(c.perm)}』`);
  if (!parts.length) return '';
  if (parts.length <= 2) return parts.join('、');
  return `${parts.slice(0, 2).join('、')} 等 ${parts.length} 項`;
}

/** preview 名單：最多顯示 cap 人，其餘算「其餘 N 人」。回 { lines:[{who, text}], rest, total } */
export function previewView(people, cap) {
  const limit = cap || 30;
  const list = people || [];
  const lines = list.slice(0, limit).map((p) => {
    const bits = [];
    if ((p.added || []).length) bits.push(`多了 ${p.added.map(featureName).join('、')}`);
    if ((p.removed || []).length) bits.push(`少了 ${p.removed.map(featureName).join('、')}`);
    return { who: p.name ? `${p.name}（${p.emp_no}）` : p.emp_no, text: bits.join('；') };
  });
  return { lines, rest: Math.max(0, list.length - limit), total: list.length };
}

// ---- 搜尋同仁（permWho）的來源白話：與 modules/me/perm-block.js 的 sourceText／permLines 同義（test/perms-front.test.mjs 比對） ----
const HIDDEN_PERMS = { 'platform.login': true, 'platform.self': true };
function shortDate(d) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(d || '');
}
export function sourceText(src, profile) {
  profile = profile || {};
  switch (src.source) {
    case 'title': return `因為職稱：${profile.title_name || '你的職稱'}`;
    case 'dept': return `因為部門：${profile.dept_name || '你的部門'}`;
    case 'exception': return src.until ? `個別例外，到 ${shortDate(src.until)}` : '個別例外';
    case 'implied': return '因為能填稽核單';
    case 'role': return '系統角色';
    default: return String(src.source || '');
  }
}
/** permWho 一個人的結果 → [{perm, name, texts}]（一個功能一列） */
export function whoLines(item) {
  const order = [];
  const by = {};
  (item.sources || []).forEach((s) => {
    if (HIDDEN_PERMS[s.perm]) return;
    if (!by[s.perm]) { by[s.perm] = { perm: s.perm, name: featureName(s.perm), texts: [] }; order.push(s.perm); }
    const t = sourceText(s, item);
    if (by[s.perm].texts.indexOf(t) === -1) by[s.perm].texts.push(t);
  });
  return order.map((p) => by[p]);
}

/** 儲存失敗的中文（preview 與正式送出共用） */
export function saveErrorText(res) {
  return errorText(res);
}

/** 稽核範圍白話（同 modules/me/perm-block.js 的 scopeText） */
export function scopeLabel(scope, perms) {
  if (scope === 'all') return '全部店';
  if (Array.isArray(scope)) {
    const has = (p) => (perms || []).indexOf(p) !== -1;
    if (has('audit.read.brand')) return `自己品牌 ${scope.length} 家`;
    return scope.length ? '自己店' : '自己店（還沒對照稽核店）';
  }
  return '';
}
