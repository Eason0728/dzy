/**
 * modules/me/perm-block.js — 「我能用的功能」（個人帳號第二期，docs/permissions/spec.md §7.2）
 * 呼叫 myPerms：enabled:false（開關沒開）時整塊不顯示。純文字函式另外 export，node 測試直接用。
 */
'use strict';

const NAMES = {
  'audit.read.own': '看自己店稽核', 'audit.read.brand': '看自己品牌稽核', 'audit.read': '看全部店稽核',
  'audit.write': '填稽核單與門市管理', 'dorm.read': '看宿舍清單', 'dorm.write': '宿舍建約點交',
  'platform.staff': '同仁名單', 'platform.users': '人員管理', 'platform.permmap': '改權限對照表',
  'platform.permex': '個別例外', 'platform.review': '待審核', 'platform.unitstaff': '我的單位', 'platform.bulletin': '公告管理', '*': '全部功能'
};
/** 技術性的碼，不列給同仁看 */
const HIDDEN = { 'platform.login': true, 'platform.self': true };

function shortDate(d) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(d || '');
}

/** 單一來源的白話。profile＝myProfile 的資料（title_name／dept_name） */
export function sourceText(src, profile) {
  profile = profile || {};
  switch (src.source) {
    case 'title': return `因為職稱：${profile.title_name || '你的職稱'}`;
    case 'dept': return `因為部門：${profile.dept_name || '你的部門'}`;
    case 'exception': return src.until ? `個別例外，到 ${shortDate(src.until)}` : '個別例外';
    case 'implied': return '因為能填稽核單';
    case 'acting': return '因為兼任店長';
    case 'role': return '系統角色';
    default: return String(src.source || '');
  }
}

/** 稽核範圍：'all' | 'none' | [店代碼] */
export function scopeText(scope, perms) {
  if (scope === 'all') return '全部店';
  if (Array.isArray(scope)) {
    const has = (p) => (perms || []).indexOf(p) !== -1;
    if (has('audit.read.brand')) return `自己品牌 ${scope.length} 家`;
    return scope.length ? '自己店' : '自己店（還沒對照稽核店）';
  }
  return '';
}

/** 把 myPerms 的 items 合併成「一個功能一列」：[{perm, name, texts:[來源白話]}] */
export function permLines(items, profile) {
  const order = [];
  const by = {};
  (items || []).forEach((it) => {
    if (HIDDEN[it.perm]) return;
    if (!by[it.perm]) { by[it.perm] = { perm: it.perm, name: NAMES[it.perm] || it.name_zh || it.perm, texts: [] }; order.push(it.perm); }
    const t = sourceText(it, profile);
    if (by[it.perm].texts.indexOf(t) === -1) by[it.perm].texts.push(t);
  });
  return order.map((p) => by[p]);
}

/** 組出整塊 HTML；不顯示時回 ''。 */
export function permBlockHtml(data, profile, esc) {
  if (!data || data.enabled === false) return '';
  const lines = permLines(data.items, profile);
  const perms = (data.items || []).map((i) => i.perm);
  const scope = scopeText(data.audit_scope, perms);
  const rows = lines.length
    ? lines.map((l) => `<tr data-role="my-perm" data-perm="${esc(l.perm)}"><th>${esc(l.name)}</th><td>${esc(l.texts.join('、'))}</td></tr>`).join('')
    : '<tr><td colspan="2" class="text-muted">目前沒有額外的功能。</td></tr>';
  return `<div class="card stack" data-role="my-perms">
    <div class="card-title">我能用的功能</div>
    <div class="table-wrap"><table class="table"><tbody>${rows}</tbody></table></div>
    ${scope ? `<p class="text-muted" data-role="my-scope">稽核範圍：${esc(scope)}</p>` : ''}
  </div>`;
}

/** 在 profile 頁下方補上這一塊；失敗或沒開就什麼都不做 */
export async function mountPermBlock(host, ctx, profile, isAlive) {
  let r;
  try { r = await ctx.api.call('me', 'myPerms', {}); } catch (e) { return; }
  if (!r || !r.ok || r.dryrun || (isAlive && !isAlive())) return;
  const html = permBlockHtml(r.data, profile, ctx.fmt.esc);
  if (!html) return;
  const old = host.querySelector('[data-role="my-perms"]');
  if (old) old.remove();
  host.insertAdjacentHTML('beforeend', html);
}
