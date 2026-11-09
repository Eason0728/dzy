/**
 * platform/home-cache.js — 首頁「上次件數」（2026-11-10，首頁少等）
 *
 * 目的：手機開首頁時，各功能卡片的待辦數字要等後端回來（常要好幾秒）。先把「上次看到的件數」顯示出來
 * （灰色、標「更新中」），最新資料到了就換掉。
 *
 * 只存「件數」：{ v:1, at:<毫秒>, n:{ <模組代號>: <非負整數> } }。
 * 絕不存提醒文字、同仁姓名、金額——這個檔案根本沒有地方接收字串內容（寫入時非數字一律丟掉，模組代號只收 [a-z0-9-]）。
 * key 帶使用者 id：dzy.u.<user id>.home_badges（比照稽核草稿的格式，換人不互看）；登出時清掉。
 * 純函式，storage 由呼叫端傳（localStorage 或測試用假的）；任何錯誤都吞掉，不影響首頁。
 */

'use strict';

export const HOME_BADGE_MAX_AGE_MS = 12 * 3600 * 1000;   // 超過半天的件數不拿來顯示（已經不是「剛剛」的狀況）
const MAX_COUNT = 99999;
const ID_RE = /^[a-z0-9-]{1,40}$/;

/** 沒有 user id 回 null（不存） */
export function homeBadgeKey(userId) {
  const id = userId === undefined || userId === null ? '' : String(userId);
  return id ? `dzy.u.${id}.home_badges` : null;
}

/** 只留 {模組代號: 非負整數}；其他一律丟掉（字串、物件、負數、NaN） */
export function sanitizeCounts(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (ID_RE.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.min(MAX_COUNT, Math.floor(v));
  }
  return out;
}

/** 讀上次件數；沒有、壞掉、太舊、storage 不能用 → {} */
export function readHomeBadges(storage, userId, now) {
  try {
    const key = homeBadgeKey(userId);
    if (!storage || !key) return {};
    const raw = storage.getItem(key);
    if (!raw) return {};
    const d = JSON.parse(raw);
    if (!d || d.v !== 1 || typeof d.at !== 'number') return {};
    const t = typeof now === 'number' ? now : Date.now();
    if (t - d.at > HOME_BADGE_MAX_AGE_MS || d.at - t > 3600 * 1000) return {};
    return sanitizeCounts(d.n);
  } catch (e) {
    return {};
  }
}

/** 寫入整份件數（先過 sanitizeCounts）；回是否真的寫了 */
export function writeHomeBadges(storage, userId, counts, now) {
  try {
    const key = homeBadgeKey(userId);
    if (!storage || !key) return false;
    storage.setItem(key, JSON.stringify({ v: 1, at: typeof now === 'number' ? now : Date.now(), n: sanitizeCounts(counts) }));
    return true;
  } catch (e) {
    return false;
  }
}

/** 登出時清掉這個人的件數 */
export function clearHomeBadges(storage, userId) {
  try {
    const key = homeBadgeKey(userId);
    if (!storage || !key) return false;
    storage.removeItem(key);
    return true;
  } catch (e) {
    return false;
  }
}
