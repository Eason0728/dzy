// node test/bulletin-module.test.mjs —— 公告專區 iframe：網址來源讀 BACKENDS.bulletin；載入逾時顯示提示
'use strict';
import assert from 'node:assert/strict';
import { BACKENDS } from '../platform/config.js';

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.className = ''; this.textContent = ''; this.hidden = false; this.listeners = {}; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(n, ref) { const i = this.children.indexOf(ref); n.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, n); return n; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  get firstChild() { return this.children[0] || null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all(pred, out)); return out; }
}
const timers = [];
globalThis.document = { createElement: (t) => new El(t) };
const winListeners = {};
globalThis.window = {
  addEventListener: (t, f) => { winListeners[t] = f; },
  removeEventListener: (t) => { delete winListeners[t]; }
};
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].live = false; };

const bulletin = (await import('../modules/bulletin/index.js')).default;
const ctx = { viewId: 'board', api: { call: async () => ({ ok: false }) } };
let failed = 0;
function t(name, fn) { try { fn(); console.log('PASS: ' + name); } catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + e.message); } }

const root = new El('div');
const unmount = bulletin.mount(root, ctx);
const frame = root.all((n) => n.tagName === 'iframe')[0];
t('config.js 有 BACKENDS.bulletin', () => assert.equal(BACKENDS.bulletin, 'https://dzy-bulletin.github.io'));
t('iframe 網址來自 BACKENDS.bulletin', () => assert.ok(frame.src.startsWith(BACKENDS.bulletin + '/'), frame.src));
t('排了逾時計時器（15 秒）', () => assert.ok(timers.some((x) => x.live && x.ms === 15000)));
t('逾時前不顯示提示', () => assert.equal(root.all((n) => n.attrs['data-role'] === 'bulletin-down').length, 0));
timers.filter((x) => x.live).forEach((x) => x.fn());
t('逾時後顯示「暫時連不上」並提到新分頁開啟', () => {
  const n = root.all((x) => x.attrs['data-role'] === 'bulletin-down')[0];
  assert.ok(n && /暫時連不上/.test(n.textContent) && /在新分頁開啟/.test(n.textContent));
});
unmount();

// 2026-10-20：公告／歷史區搬到管理系統分頁列
const { BOARD_TABS, navMessage } = await import('../modules/bulletin/nav.js');
const manifest = (await import('../modules/bulletin/manifest.js')).default;
const { validateManifest } = await import('../platform/manifest-check.js');
t('manifest：前兩個分頁＝BOARD_TABS（公告、歷史區，人人可看）；公告管理／新增公告仍要 platform.bulletin', () => {
  assert.deepEqual(manifest.views.slice(0, 2).map((v) => [v.id, v.name]), BOARD_TABS);
  for (const v of manifest.views.slice(0, 2)) assert.deepEqual(v.requires, ['platform.login']);
  assert.deepEqual(manifest.views.slice(2).map((v) => [v.id, v.requires]), [['manage', ['platform.bulletin']], ['new', ['platform.bulletin']]]);
  const r = validateManifest(manifest);
  assert.ok(r.ok !== false && !(r.errors && r.errors.length), JSON.stringify(r));
});
t('切換訊息：公告／歷史區照送，其他一律回公告', () => {
  assert.deepEqual(navMessage('hist'), { type: 'dzy-bulletin-nav', v: 1, p: 'hist' });
  for (const bad of [null, undefined, 'manage', 'new', '', '__proto__']) assert.equal(navMessage(bad).p, 'board');
});

const posted = [];
const fakeWin = { postMessage: (m, o) => posted.push([m, o]) };
const root2 = new El('div');
const ctx2 = { viewId: 'hist', api: { call: async () => ({ ok: true, data: { ticket: 'x'.repeat(64) } }) } };
const un2 = bulletin.mount(root2, ctx2);
const fr2 = root2.all((n) => n.tagName === 'iframe')[0];
fr2.contentWindow = fakeWin;
const src0 = fr2.src;
t('重新整理停在歷史區：iframe 載的是一般佈告欄頁', () => assert.equal(src0, BACKENDS.bulletin + '/?embed=dzy'));
t('佈告欄還沒回應前不送切換訊息', () => { bulletin.onRoute({ ...ctx2, viewId: 'hist' }); assert.equal(posted.length, 0); });
const fire = (data, origin = BACKENDS.bulletin, source = fakeWin) => winListeners.message({ data, origin, source });
await fire({ type: 'dzyb-sso-ready' }, 'https://evil.example');
await fire({ type: 'dzyb-sso-ready' }, BACKENDS.bulletin, {});
t('別的來源／別的視窗說 ready 一律不理', () => assert.equal(posted.length, 0));
await fire({ type: 'dzyb-sso-ready' });
t('佈告欄 ready → 先送「切到歷史區」再送入場券，targetOrigin 寫死', () => {
  assert.deepEqual(posted[0], [{ type: 'dzy-bulletin-nav', v: 1, p: 'hist' }, BACKENDS.bulletin]);
  assert.equal(posted[1][0].type, 'dzy-sso');
  assert.equal(posted[1][1], BACKENDS.bulletin);
});
posted.length = 0;
bulletin.onRoute({ ...ctx2, viewId: 'board' });
t('歷史區 → 公告：不重新載入 iframe，只送切換訊息', () => {
  assert.equal(fr2.src, src0);
  assert.deepEqual(posted, [[{ type: 'dzy-bulletin-nav', v: 1, p: 'board' }, BACKENDS.bulletin]]);
});
posted.length = 0;
bulletin.onRoute({ ...ctx2, viewId: 'manage' });
t('公告 → 公告管理：換成管理頁、不送切換訊息', () => {
  assert.equal(fr2.src, BACKENDS.bulletin + '/?embed=dzy&view=posts');
  assert.equal(posted.length, 0);
});
bulletin.onRoute({ ...ctx2, viewId: 'hist' });
t('公告管理 → 歷史區：重新載入一般頁（等 ready 才送切換）', () => {
  assert.equal(fr2.src, src0);
  assert.equal(posted.length, 0);
});
un2();
process.exit(failed ? 1 : 0);
