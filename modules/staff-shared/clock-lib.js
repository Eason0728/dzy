/**
 * modules/staff-shared/clock-lib.js — 員工名單統一：前端純函式（docs/personnel/master-data/spec.md §4.1～4.3、§5；契約 api.md）
 *
 * 沒有 DOM、沒有網路：日期限制、輪詢、權限顯示判斷、打卡網址、首頁提醒整理。
 * 所有規則都只是「讓人選不到錯的」，真正的權限與日期檢查在後端（StaffClock.gs）。
 * 測試：test/staff-master-front.test.mjs
 */
'use strict';

/** 打卡頁網域與各店頁名（頁名＝~/mala-clock-in/tools/stores.json 的 page 欄；store_code 同 clock_stores 預設六列） */
export const CLOCK_BASE = 'https://eason0728.github.io/mala-clock-in/';
export const STORE_PAGE = {
  gf: 'clock.html',
  mztjs: 'clock-mztjs.html',
  mztgf: 'clock-mztgf.html',
  mztlzl: 'clock-mztlzl.html',
  hq: 'clock-hq.html',
  cf: 'clock-cf.html'
};

export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_MS = 60000;
export const LEAVE_BACK_DAYS = 7;
export const LEAVE_FAR_DAYS = 365;
/** 姓名上限：平台 CLK_NAME_MAX＝打卡端 svc_add 的上限（20） */
export const NAME_MAX = 20;

const pad = (n) => (n < 10 ? '0' : '') + n;

/** Date → 'yyyy-MM-dd'（用 Date 本地欄位；使用者在台灣，瀏覽器時區＝台北） */
export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return d;
}

/** 'yyyy-MM-dd' 加減天數，格式錯回 '' */
export function addDays(s, n) {
  const d = parseYmd(s);
  if (!d) return '';
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 登記離職日期選擇器的最小值：店長＝今天 −7 天（含第 7 天）；總部不擋往回（回 ''） */
export function leaveMinDate(today, isHq) {
  return isHq ? '' : addDays(today, -LEAVE_BACK_DAYS);
}

/** 登記離職的日期檢查；回 ''＝可以送，否則是白話訊息（後端會再驗一次） */
export function leaveDateError(lastDay, today, isHq) {
  if (!parseYmd(lastDay)) return '請選擇最後上班日';
  const min = leaveMinDate(today, isHq);
  if (min && lastDay < min) return `店長最多只能往回補 ${LEAVE_BACK_DAYS} 天（最早 ${min}），更早的請找總部`;
  if (lastDay >= addDays(today, LEAVE_FAR_DAYS)) return '離職日太遠了，請確認日期';
  return '';
}

/** 'yyyy-MM-dd' → '10/31 離職' */
export function leaveLabel(lastDay) {
  const d = parseYmd(lastDay);
  return d ? `${d.getUTCMonth() + 1}/${d.getUTCDate()} 離職` : '';
}

/** 「打卡已停 n/m」：有打卡對照，且已登記離職或已停用才顯示；否則 '' */
export function stoppedLabel(p) {
  const total = Number(p && p.clock_total) || 0;
  if (!total) return '';
  if (!(p.last_day || p.status === 'disabled')) return '';
  return `打卡已停 ${Number(p.clock_stopped) || 0}/${total}`;
}

/** 這個人所有打卡是否都已停 */
export function allStopped(p) {
  const total = Number(p && p.clock_total) || 0;
  return total > 0 && (Number(p.clock_stopped) || 0) >= total;
}

/** 是不是本人（後端也會擋；這裡只是不顯示按鈕）。優先用後端給的 is_self；沒有才退回比對 user 的編號欄位 */
export function isSelf(p, user) {
  if (p && typeof p.is_self === 'boolean') return p.is_self; // 後端算好的（staffUnitList／staffList 每列帶 is_self）
  const me = user && (user.username || user.emp_no || '');
  return !!me && String(me).toUpperCase() === String(p && p.emp_no).toUpperCase();
}

/**
 * 每個按鈕該不該出現。viewer＝{isHq, isLead, user}。
 * 資料本身就是後端依權限裁過的（店長只拿得到自己單位），這裡只管「這一列此刻能做什麼」。
 */
export function personActions(p, viewer) {
  const v = viewer || {};
  const can = v.isHq || v.isLead;
  const self = isSelf(p, v.user);
  const active = p.status !== 'disabled';
  return {
    // 已登記離職的人可以「改日期」（staffLeave 同一支），所以只要在職、不是自己就能按
    leave: !!can && active && !self,
    // 撤銷：只在 can_cancel_leave；店長不能撤銷自己的
    cancelLeave: !!can && active && !!p.last_day && !!p.can_cancel_leave && !(self && !v.isHq),
    // 顯示打卡連結：該單位店長與總部；要有 confirmed 對照、人沒停用
    link: !!can && active && (Number(p.clock_total) || 0) > 0,
    // 改名、復職：只有總部
    rename: !!v.isHq && p.status !== 'unclaimed', // 未開通者走既有「改姓名」(staffEdit)
    reinstate: !!v.isHq && p.status === 'disabled',
    // 在主店建打卡帳號：只有總部，且後端判定在 no_home_map（no_home＝true）
    addHome: !!v.isHq && active && p.no_home === true
  };
}

/** 單位同仁名單的單位篩選：店長固定自己單位（不能選）；總部可選 */
export function addUnitChoice(viewer, units, myUnit) {
  if (!viewer.isHq) return { fixed: true, unit: myUnit || '' };
  return { fixed: false, unit: '', options: units };
}

/** 新增表單檢查（後端會再驗）：姓名≤30、職稱必選、到職日在 2000-01-01～今天+365、手機 09 開頭 10 碼 */
export function addFormErrors(f, today) {
  const e = [];
  const name = String((f && f.name) || '').trim();
  if (!name) e.push('請填姓名');
  else if (name.length > NAME_MAX) e.push(`姓名最多 ${NAME_MAX} 字`);
  if (!f.title) e.push('請選職稱');
  if (!parseYmd(f.hire_date)) e.push('請選到職日');
  else if (f.hire_date < '2000-01-01' || f.hire_date > addDays(today, LEAVE_FAR_DAYS)) e.push('到職日不合理，請確認');
  if (!/^09\d{8}$/.test(String(f.phone || '').replace(/[\s-]/g, ''))) e.push('手機要 09 開頭、共 10 碼');
  return e;
}

/**
 * 輪詢待辦單（api.md 2.1：每 3 秒、最多 60 秒）。
 * fetchJob() → Promise<{ok,data,error,code}>；sleep(ms)、now() 可注入（測試用假時鐘）。
 * 回傳 {status, job}：
 *   done      待辦單完成（job＝data）
 *   failed    state failed／cancelled，或單查不到（no_job）
 *   timeout   到 maxMs 還沒結束（也包含期間網路一直失敗）
 *   stopped   shouldStop() 回 true（使用者關了畫面）
 */
export async function pollJob(fetchJob, opts) {
  const o = Object.assign({ intervalMs: POLL_INTERVAL_MS, maxMs: POLL_MAX_MS, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), shouldStop: () => false }, opts || {});
  const start = o.now();
  let last = null;
  for (;;) {
    if (o.shouldStop()) return { status: 'stopped', job: last };
    let r = null;
    try { r = await fetchJob(); } catch (e) { r = null; }
    if (o.shouldStop()) return { status: 'stopped', job: last };
    if (r && r.ok && r.data) {
      last = r.data;
      if (last.state === 'done') return { status: 'done', job: last };
      if (last.state === 'failed' || last.state === 'cancelled') return { status: 'failed', job: last };
    } else if (r && r.code === 'no_job') {
      return { status: 'failed', job: last };
    }
    if (o.now() - start + o.intervalMs > o.maxMs) return { status: 'timeout', job: last };
    await o.sleep(o.intervalMs);
  }
}

/** 取連結用：done 且有 link_key → 'ok'；link_expired → 'expired'；其他 'none' */
export function linkOutcome(res) {
  if (res.status === 'done' && res.job && res.job.link_key) return { kind: 'ok', key: res.job.link_key };
  if (res.job && res.job.link_expired) return { kind: 'expired' };
  if (res.status === 'timeout') return { kind: 'timeout' };
  if (res.status === 'stopped') return { kind: 'stopped' };
  return { kind: 'failed', error: res.job && res.job.last_error };
}

/** 完整打卡網址；查不到頁名（店代碼不認得）回 '' 讓畫面只顯示金鑰 */
export function clockLinkUrl(storeCode, key) {
  const page = STORE_PAGE[String(storeCode || '').toLowerCase()];
  if (!page || !key) return '';
  return `${CLOCK_BASE}${page}?k=${encodeURIComponent(key)}`;
}

const KIND_TEXT = { add: '建立打卡', deactivate: '停用打卡', reactivate: '恢復打卡', link: '取打卡連結', build: '建立打卡對照' };
export function jobKindText(kind) { return KIND_TEXT[kind] || kind || '待辦'; }

/**
 * clockAlerts 的 data → 首頁提醒列（每一類一列；筆數 0 不出現）。
 * 回 [{key, level, text, count, view, params?, retry?}]；view 是「所在模組」的分頁 id，
 * hq 版（staff 模組）：list／clockmap；店長版（me 模組）：clock／team。
 * 沒有 retry 的列點了只是導覽；outbox_failed 帶 retry:true，由畫面加「重試」鈕（總部）。
 */
export function alertRows(d, viewer) {
  const v = viewer || {};
  const out = [];
  if (!d) return out;
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  const go = (hqView, leadView) => (v.isHq ? hqView : leadView);
  const add = (key, level, count, text, view, params, extra) => {
    if (count > 0) out.push(Object.assign({ key, level, text: text.replace('{n}', count), count, view, params }, extra || {}));
  };
  add('outbox_failed', 'error', n(d.outbox_failed), '{n} 筆打卡待辦單失敗（打卡未建或停用失敗）', go('clockmap', 'team'), v.isHq ? { t: 'jobs' } : { f: 'jobs' }, { retry: true });
  add('unmapped', 'warn', n(d.unmapped), '{n} 位打卡上在職、但沒有對照到同仁', 'clockmap', { t: 'needs' });
  add('left_but_active', 'error', n(d.left_but_active), '{n} 筆同仁已離職、打卡卻還在職', go('list', 'team'), { f: 'left' });
  add('leave_overdue', 'error', n(d.leave_overdue), '{n} 位同仁離職日已過、卻還沒停用成功', go('list', 'team'), { f: 'overdue' });
  add('home_stopped', 'warn', n(d.home_stopped), '{n} 位在職同仁的主店打卡被停掉了', go('list', 'team'), { f: 'homestopped' });
  if (v.isHq) add('transfer_failed', 'error', n(d.transfer_failed), '{n} 位調店同仁的新店打卡沒開成功', 'clockmap', { t: 'all' });
  const pc = d.pending_confirm && Number(d.pending_confirm.count) ? Number(d.pending_confirm.count) : 0;
  add('pending_confirm', 'warn', pc, '{n} 筆打卡對照等你確認', go('clockmap', 'clock'), { t: 'suggested' });
  add('no_home_map', 'warn', n(d.no_home_map), '{n} 位同仁還沒有主店打卡編號', go('list', 'team'), { f: 'nohome' });
  add('name_diff', 'warn', n(d.name_diff), '{n} 筆打卡姓名和管理系統不同，請到打卡端改成一致', go('list', 'team'), { f: 'namediff' });
  if (v.isHq) {
    add('payroll_diff', 'warn', n(d.payroll_diff), '{n} 筆薪資主檔姓名和打卡名冊不同，請會計改成一致', 'clockmap', { t: 'needs' });
    add('transfer_ask', 'warn', n(d.transfer_ask), '{n} 位調店的同仁，舊主店要不要停用？', 'clockmap', { t: 'oldhome' });
    add('needs_hq', 'warn', Number(d.needs_hq_count) || 0, '{n} 筆打卡對照需要總部處理', 'clockmap', { t: 'needs' });
    add('candidates', 'info', Number(d.candidates_count) || 0, '{n} 位打卡上有、管理系統找不到的候選新人', 'clockmap', { t: 'cand' });
  }
  return out;
}

/** 超過 26 小時沒同步的店（api.md last_sync；spec §11 第 18 條：mini 停跑時不要假裝零異常） */
export function staleSyncStores(lastSync, now) {
  const out = [];
  const t = now instanceof Date ? now.getTime() : Number(now);
  Object.keys(lastSync || {}).forEach((k) => {
    const ms = Date.parse(String(lastSync[k]).replace(' ', 'T') + '+08:00');
    if (!isNaN(ms) && t - ms > 26 * 3600 * 1000) out.push(k);
  });
  return out;
}

/** 名單篩選（總部名單與店長「我的單位」共用）；p＝名單一列，today＝'yyyy-MM-dd' */
export function personFilter(f, p, today) {
  switch (f) {
    case 'left': return (p.status === 'disabled' || !!p.last_day) && (p.clock_total || 0) > (p.clock_stopped || 0);
    // 後端有帶 no_home（與首頁 no_home_map 同一套判斷）就用它；舊後端沒帶時退回舊判斷
    case 'nohome': return typeof p.no_home === 'boolean' ? p.no_home : (p.status === 'active' && !p.clock_total && !p.clock_job);
    case 'namediff': return p.name_diff === true;
    case 'overdue': return !!p.last_day && p.last_day < today && p.status !== 'disabled';
    case 'homestopped': return p.status === 'active' && !p.last_day && (p.clocks || []).some((c) => c.role === 'home' && c.roster_active === false);
    default: return true;
  }
}

/** 試跑模式（?dryrun=1）下寫入被攔、api 回 {ok:true, dryrun:true}：沒有 job_id，不可輪詢 */
export function isDryRunResult(r) {
  return !!(r && r.dryrun === true);
}

/** 後端回 no_perm 時的白話說明（總部單位的部門主管也有 platform.review，分頁看得到但後端只給門市店長） */
export function storeLeadOnlyText(r) {
  return r && r.code === 'no_perm' ? '這個分頁給門市店長用；總部同仁請到「同仁名單」處理。' : '';
}

/**
 * 打卡對照卡片的「主店」區塊（總部「全部對照」）：
 * 已確認且不是主店 → 'btn'（給「設為主店」按鈕）；已確認且已是主店 → 'mark'（只顯示標記、不給按鈕）；
 * 其他（待確認、已退回、店長檢視）→ ''。
 */
export function homeAction(x, viewer) {
  if (!viewer || !viewer.isHq || !x || x.state !== 'confirmed') return '';
  return x.role === 'home' ? 'mark' : 'btn';
}
