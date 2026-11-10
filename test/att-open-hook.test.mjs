// node test/att-open-hook.test.mjs —— 沒有「考勤管理」權限的同仁，手機「待處理 → 我送出的」也要看得到自己的考勤申請
// （2026-11-06 Eason 的需求；2026-11-10 挑錯問題 4：後端與營運系統都放行了，卡在殼只對「有模組權限的人」跑 mine）。
// 做法：模組在 manifest 宣告 openHooks:['mine']，殼對沒有模組權限的人也照跑這一支（只這一支、列出來的項目不給連結）。
// 這裡驗 manifest 規則與考勤模組的 mine()；殼的實際行為在 e2e ㉓（一般同仁那一段）。全部假資料。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from '../platform/manifest-check.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, label, extra) { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label + (extra !== undefined ? '\n  ' + JSON.stringify(extra) : '')); } }

class MemoryStorage { constructor() { this._m = new Map(); } getItem(k) { return this._m.has(k) ? this._m.get(k) : null; } setItem(k, v) { this._m.set(k, String(v)); } removeItem(k) { this._m.delete(k); } }
globalThis.localStorage = new MemoryStorage();

const att = (await import('../modules/attendance/manifest.js')).default;
ok(JSON.stringify(att.openHooks) === '["mine"]', '考勤管理 manifest 宣告 openHooks:["mine"]', att.openHooks);
const v = validateManifest(att);
ok(v.errors.length === 0 && !v.warnings.some((w) => w.includes('openHooks')), '考勤管理 manifest 驗證：沒有錯誤、openHooks 是已知欄位', v);

// 只准開放 mine：待我處理的清單與核准（quick／decide）、已處理（decided）絕不能對沒有權限的人開
const base = { id: 'xx', ns: 'xx', backend: 'xx', name: '測試模組', desc: '測試', icon: 'xx', work: att.work, requires: ['xx.read'], views: [{ id: 'a', name: '甲', requires: ['xx.read'] }], entry: () => Promise.resolve({}) };
const errOf = (oh) => validateManifest(Object.assign({}, base, { openHooks: oh })).errors.filter((e) => e.includes('openHooks'));
ok(errOf(['mine']).length === 0, 'openHooks:["mine"] 合格');
for (const bad of [['quick'], ['mine', 'decide'], ['decided'], 'mine', [1], ['alerts'], ['badge']]) ok(errOf(bad).length > 0, 'openHooks ' + JSON.stringify(bad) + ' 被擋', errOf(bad));
ok(errOf([]).length === 0, 'openHooks:[] 合格（等於沒開）');

// 目前只有考勤管理開放（新模組要開放要有理由，改這條測試時一起寫進規格）
const dirs = fs.readdirSync(path.join(ROOT, 'modules')).filter((d) => fs.existsSync(path.join(ROOT, 'modules', d, 'manifest.js')));
const open = [];
for (const d of dirs) { const m = (await import(pathToFileURL(path.join(ROOT, 'modules', d, 'manifest.js')).href)).default; if (m.openHooks !== undefined) open.push(m.id); }
ok(JSON.stringify(open) === '["attendance"]', '只有考勤管理宣告 openHooks', open);

// 考勤模組的 mine()：讀到 → 清單；其他失敗 → null（殼顯示「暫時讀不到」）。
// 代轉 403 有兩種來源（mini 代轉 AUTH_STATUS）：這個帳號沒有同仁編號（後端 storeSubForUser_：不是同仁、也不是系統管理者的系統帳號一定沒有）
// ＝沒有東西可列；或考勤通行碼沒設定（NO_SECRET，是故障）。前端只拿得到狀態碼、分不出來，
// 所以只有系統帳號的 403 當空清單；同仁、系統管理者、角色不明的 403 一律算讀不到（不可把故障顯示成「沒有送出的單」）。
const mod = (await import('../modules/attendance/index.js')).default;
const item = { store: 'MZGF', storeName: '測試門市', id: 'R1', kind: 'leave', label: '事假', date: '2026-11-08', from: '14:00', to: '18:00', hours: 4, reason: '', status: 'pending', rejectReason: '' };
const ctxOf = (r, role) => ({ user: role === undefined ? null : { id: 'u1', name: '測試', role, node: '' }, api: { call: async (ns, action) => { if (ns !== 'attendance' || action !== 'reqMine') throw new Error('不該呼叫 ' + ns + '/' + action); if (r instanceof Error) throw r; return r; } } });
const got = await mod.mine(ctxOf({ ok: true, data: { data: { items: [item], partial: false, asOf: '' } } }, 'staff'));
ok(Array.isArray(got) && got.length === 1 && got[0].text === '事假 4 小時' && got[0].state === 'wait', 'mine()：讀到 → 轉成清單列', got);
const R403 = { ok: false, error: '沒有權限', status: 403 };
for (const role of ['accountant', 'manager', 'storelead']) ok(JSON.stringify(await mod.mine(ctxOf(R403, role))) === '[]', 'mine()：系統帳號（' + role + '，沒有同仁編號）代轉回 403 → 空清單，不算讀不到');
ok((await mod.mine(ctxOf(R403, 'staff'))) === null, 'mine()：同仁代轉回 403（他有同仁編號，403 是故障）→ null，不可當成沒有送出的單');
ok((await mod.mine(ctxOf(R403, 'admin'))) === null, 'mine()：系統管理者代轉回 403 → null');
ok((await mod.mine(ctxOf(R403))) === null, 'mine()：角色不明代轉回 403 → null（保守）');
ok((await mod.mine(ctxOf({ ok: false, error: '舊系統暫時無法連線', status: 502 }, 'accountant'))) === null, 'mine()：系統帳號代轉回 502 → null（只有 403 才當空清單）');
ok((await mod.mine(ctxOf({ ok: false, error: '舊系統暫時無法連線', status: 502 }, 'staff'))) === null, 'mine()：代轉回 502 → null（殼顯示暫時讀不到）');
ok((await mod.mine(ctxOf({ ok: false, error: '請求逾時，請稍後再試' }, 'staff'))) === null, 'mine()：逾時 → null');

console.log(`\natt-open-hook: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
