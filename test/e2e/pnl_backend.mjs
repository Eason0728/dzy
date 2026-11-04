#!/usr/bin/env node
/**
 * 損益原生化 P3：本機起一個「真的」損益後端給 e2e／手動測試用（不連任何正式系統）。
 *   node test/e2e/pnl_backend.mjs <port>
 * 用 ~/dzy-minikit 的 kit 執行器載入 ~/mala-pnl-auto/gas（依 ~/dzy-minikit/apps/pnl/app.json 的清單）＋測試輔助函式，
 * 資料放暫存資料夾（每次全新）：初始化、載入光復種子、加一家測試店 S02、建 2026-08 草稿＋寫入裁判明細（假資料，來自損益 repo 的測試 fixture）。
 * 金鑰是測試用假值 PNL_DZY_KEY=test-dzy-key-0123456789abcdef（pnl_mock.py 用同一把）。印出「READY <port>」後常駐。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HOME = os.homedir();
const KIT = path.join(HOME, 'dzy-minikit');
const PNL = path.join(HOME, 'mala-pnl-auto');
const KEY = 'test-dzy-key-0123456789abcdef';
const port = Number(process.argv[2] || 18804);

const real = JSON.parse(fs.readFileSync(path.join(KIT, 'apps/pnl/app.json'), 'utf8'));
const gas = real.gasSource.map((p) => path.join(HOME, p.replace(/^~\//, '')));
gas.push(path.join(KIT, 'test/apps/pnl-fixtures/TestHelpers.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-e2e-app-'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-e2e-data-'));
fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ name: 'pnl', port, path: '/pnl', dataDir: data, gas, props: ['PNL_DZY_KEY'], tz: 'Asia/Taipei', maxBodyBytes: 4194304, files: { dir: 'files' } }));

const { loadApp } = require(path.join(KIT, 'kit/lib/config'));
const { createRunner } = require(path.join(KIT, 'kit/runner/server'));
const cfg = loadApp(dir, { MINIKIT_DATA_DIR: data, MINIKIT_PORT: String(port), GAS_PROP_PNL_DZY_KEY: KEY });
const r = createRunner(dir, { config: cfg, log: () => {} });
await r.listen(port);
await r.runGas('initSystem');
await r.runGas('loadStoreSeed_S01_');
await r.runGas('__testAddStore', 'S02');
// 2026-08 光復：建草稿（直接跑工作佇列那段邏輯）＋裁判明細
const post = (b) => fetch('http://127.0.0.1:' + port + '/pnl/api', { method: 'POST', body: JSON.stringify(b) }).then((x) => x.json());
const q = await post({ action: 'dzyProxy', key: KEY, level: 'admin', account: 'SEED', operator: 'seed', inner: 'createDraft', payload: { store_id: 'S01', month: '2026-08', client_id: 'seed-draft-0001' } });
if (q.ok && q.data && q.data.queued) { const j = await r.runGas('pnlJobClaim_'); await r.runGas('pnlJobRun_', j.job_id, {}); }
const fx = JSON.parse(fs.readFileSync(path.join(PNL, 'test/fixtures/202608-S01.json'), 'utf8'));
await r.runGas('__testAppendEntries', fx.entries);
// 排隊工作（建立草稿／立即拉取／建上月草稿）：用 mini 正式的 jobs.js 每秒撿一次單（沒有連接器就不連網）
const { createJobs } = require(path.join(KIT, 'apps/pnl/jobs.js'));
const jobs = createJobs({ runGas: r.runGas, env: { PNL_JOBS_ON: '1' }, log: () => {}, setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; } });
await jobs.ready;
setInterval(() => { jobs._.drainQueue(); }, 1000);
// 結束時刪掉暫存資料夾（夜審 #14：不在 $TMPDIR 累積）
const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(data, { recursive: true, force: true }); } catch (_) { /* 盡力 */ } };
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
console.log('READY ' + port);
