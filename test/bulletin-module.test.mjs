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
process.exit(failed ? 1 : 0);
