// sw.js：新版一定換掉舊檔、絕不碰後端、不存版本對不上的檔案
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup(net) {
  const stores = new Map();
  const listeners = {};
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (k) => stores.delete(k),
    open: async (k) => {
      if (!stores.has(k)) stores.set(k, new Map());
      const s = stores.get(k);
      return { match: async (r) => s.get(r.url), put: async (r, v) => { s.set(r.url, v); } };
    }
  };
  const self = { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: 'https://site' }, clients: { claim: async () => {} }, skipWaiting() {} };
  const calls = [];
  const fetchFn = async (r, init) => {
    const url = typeof r === 'string' ? r : r.url;
    calls.push({ url, cache: (init && init.cache) || r.cache });
    return net(url);
  };
  class Req { constructor(r, i) { this.url = r.url; this.method = r.method; this.mode = r.mode; this.cache = i && i.cache; } }
  vm.runInNewContext(fs.readFileSync('sw.js', 'utf8'), { self, caches, fetch: fetchFn, Request: Req, URL, Date, Set, Promise, console });
  const fire = async (url, mode = 'cors', method = 'GET') => {
    let resp, used = false; const waits = [];
    listeners.fetch({ request: { url, mode, method }, respondWith: (p) => { used = true; resp = p; }, waitUntil: (p) => waits.push(p) });
    const r = used ? await resp : undefined;
    await Promise.all(waits);
    return { used, r };
  };
  return { fire, stores, calls };
}
const res = (lm, body = 'x', extra = {}) => ({ ok: true, type: 'basic', redirected: false, body, headers: { get: (h) => (h === 'last-modified' ? lm : null) }, clone() { return this; }, ...extra });

let lm = 'A', assetLm = 'A', body = 'old';
const t = setup(() => res(assetLm, body));
const net = setup((u) => (u.endsWith('/') ? res(lm) : res(assetLm, body)));
const JS = 'https://site/platform/a.js';

// 第一次：抓首頁認定版本，檔案存起來；第二次直接用裝置上的，不連網
await net.fire('https://site/', 'navigate');
assert.equal(net.calls[0].cache, 'no-cache', '開頁一定連網看版本');
assert.equal((await net.fire(JS)).r.body, 'old');
assert.equal(net.calls.at(-1).cache, 'no-cache', '存之前不可用瀏覽器快取');
let n = net.calls.length;
assert.equal((await net.fire(JS)).r.body, 'old');
assert.equal(net.calls.length, n, '第二次不連網');

// 有新版：舊檔整包丟掉、拿到新檔
lm = 'B'; assetLm = 'B'; body = 'new';
await net.fire('https://site/', 'navigate');
assert.equal(net.stores.size, 0, '舊版整包刪掉');
assert.equal((await net.fire(JS)).r.body, 'new');
assert.equal(net.stores.size, 1);

// 部署途中，檔案版本跟首頁不同：照常給，但不存
assetLm = 'C'; body = 'mixed';
assert.equal((await net.fire('https://site/platform/b.js')).r.body, 'mixed');
n = net.calls.length;
await net.fire('https://site/platform/b.js');
assert.equal(net.calls.length, n + 1, '版本對不上的檔不存');

// 後端、POST、其他網域、其他路徑一律不攔
assert.equal((await net.fire('https://backend/platform/api')).used, false);
assert.equal((await net.fire('https://site/platform/a.js', 'cors', 'POST')).used, false);
assert.equal((await net.fire('https://site/docs/x.md')).used, false);
assert.equal((await net.fire('https://site/preview/a.html', 'navigate')).used, false);

// 伺服器沒給版本標記：完全不存
const none = setup(() => res(null));
await none.fire('https://site/', 'navigate');
await none.fire(JS); n = none.calls.length; await none.fire(JS);
assert.equal(none.calls.length, n + 1);
assert.equal(none.stores.size, 0);

// 連不上網：照常失敗，不拿舊畫面
const off = setup(() => { throw new Error('offline'); });
await assert.rejects(off.fire('https://site/', 'navigate'));
console.log('sw 全部通過');
