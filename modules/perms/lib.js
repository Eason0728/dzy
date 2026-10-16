/**
 * modules/perms/lib.js — 權限設定的純函式（不碰 DOM、不碰網路，node 測試直接 import）
 * 對照後端：apps-script/platform/PermActions.gs（輸入輸出）、Perms.gs（PERM_GRANTABLE／PERM_NAMES）。
 */
'use strict';

/** 可給的 9 個功能（順序＝畫面順序＝後端 PERM_GRANTABLE） */
export const FEATURE_ORDER = ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write', 'platform.staff', 'platform.users', 'platform.permmap'];

export const FEATURE_NAMES = {
  'audit.read.own': '看自己店稽核',
  'audit.read.brand': '看自己品牌稽核',
  'audit.read': '看全部店稽核',
  'audit.write': '填稽核單與門市管理',
  'dorm.read': '看宿舍清單',
  'dorm.write': '宿舍建約點交',
  'platform.staff': '同仁名單',
  'platform.users': '人員管理',
  'platform.permmap': '改權限對照表'
};

/** 其他會出現在 myPerms／異動裡的碼 */
const OTHER_NAMES = {
  'platform.permex': '個別例外', 'platform.self': '我的資料', 'platform.review': '待審核',
  'platform.bulletin': '公告管理', 'platform.login': '登入', '*': '全部功能'
};

export function featureName(code) {
  return FEATURE_NAMES[code] || OTHER_NAMES[code] || code;
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
