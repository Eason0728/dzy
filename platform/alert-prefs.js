/**
 * platform/alert-prefs.js — 每人自己的提醒開關（2026-11-17 Eason；docs/alert-prefs/spec.md）
 *
 * 正本在後端 user_prefs（Prefs.gs myPrefsGet／myPrefsSave，跟著帳號走）；本機 localStorage
 * `dzy.u.<id>.alert_off` 只是快取，讓首頁一開就知道哪些不用跑、不必等後端。後端回來不同以後端為準。
 * 關掉＝殼不跑那個模組的 badge()／alerts()／quick()（首頁、待處理、側邊欄都不出現），模組照常點得進去。
 * 例外：模組 manifest 宣告 alertsKeep: true 時，alerts() 照跑，只留 keep: true 的項目（固定開啟，例：我的資料的帳號狀態）。
 * 純資料層：不碰 DOM。
 */
'use strict';

const KEY = (uid) => `dzy.u.${uid}.alert_off`;
const ID_RE = /^[a-z][a-z0-9-]{0,30}$/;

let curUid = '';
let off = new Set();

/** 清洗：只留合法模組 id、去重 */
export function cleanOff(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const id of list) if (typeof id === 'string' && ID_RE.test(id) && !out.includes(id)) out.push(id);
  return out;
}

export function readLocal(storage, uid) {
  if (!storage || !uid) return [];
  try { return cleanOff(JSON.parse(storage.getItem(KEY(uid)) || '[]')); } catch (e) { return []; }
}

export function writeLocal(storage, uid, list) {
  if (!storage || !uid) return;
  try { storage.setItem(KEY(uid), JSON.stringify(cleanOff(list))); } catch (e) { /* 私密視窗寫不進去就算了，後端仍是正本 */ }
}

/** 換帳號（或第一次）時從本機快取載入；回目前清單 */
export function loadFor(storage, uid) {
  curUid = uid ? String(uid) : '';
  off = new Set(readLocal(storage, curUid));
  return [...off];
}

/** 套用一份新清單（後端讀回或存檔成功）；回 true＝跟原本不同 */
export function apply(storage, list) {
  const next = cleanOff(list);
  const changed = next.length !== off.size || next.some((id) => !off.has(id));
  off = new Set(next);
  writeLocal(storage, curUid, next);
  return changed;
}

export function isMuted(moduleId) { return off.has(moduleId); }
export function offList() { return [...off]; }

/** 關掉提醒時，模組 alerts() 回來的項目只留 keep: true 的（固定開啟） */
export function keepOnly(items) {
  return Array.isArray(items) ? items.filter((it) => it && it.keep === true) : items;
}
