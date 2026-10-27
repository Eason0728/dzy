// node test/storeops-module.test.mjs —— 門市營運／考勤管理：握手只認正確 origin＋source、return 白名單、兩份共用檔逐字一致
'use strict';
import assert from 'node:assert/strict';
import fs from 'node:fs';

class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.className = ''; this.textContent = ''; this.listeners = {}; this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(n, ref) { const i = this.children.indexOf(ref); n.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, n); return n; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
  get firstChild() { return this.children[0] || null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  all(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.all(pred, out)); return out; }
}
const sent = []; // iframe.contentWindow.postMessage 的記錄
const timers = [];
globalThis.document = {
  createElement: (t) => {
    const e = new El(t);
    if (t === 'iframe') e.contentWindow = { postMessage: (m, o) => sent.push({ m, o }) };
    return e;
  }
};
const winListeners = {};
const replaced = [];
globalThis.window = {
  addEventListener: (t, f) => { winListeners[t] = f; },
  removeEventListener: (t) => { delete winListeners[t]; },
  location: { replace: (u) => replaced.push(u) }
};
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; };
globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].live = false; };

let failed = 0;
async function t(name, fn) { try { await fn(); console.log('PASS: ' + name); } catch (e) { failed++; console.error('FAIL: ' + name + '\n  ' + e.message); } }

const TICKET = 'a'.repeat(64);
const ORIGIN = 'https://dzy-bulletin.github.io';
const calls = [];
let ticketReply = { ok: true, data: { ticket: TICKET, expires_in: 60 } };
const mkCtx = (params) => ({ viewId: 'main', params: params || {}, api: { call: async (ns, action, payload) => { calls.push({ ns, action, payload }); return ticketReply; } } });
const tick = () => new Promise((r) => setImmediate(r));

const storeops = (await import('../modules/storeops/index.js')).default;
const attendance = (await import('../modules/attendance/index.js')).default;
const schedule = (await import('../modules/schedule/index.js')).default;
const embedA = await import('../modules/storeops/embed.js');
const embedB = await import('../modules/attendance/embed.js');

for (const [label, mod, query] of [['門市營運', storeops, ''], ['考勤管理', attendance, '&only=duty'], ['排班管理', schedule, '&only=schedule']]) {
  const root = new El('div');
  sent.length = 0; calls.length = 0;
  const unmount = mod.mount(root, mkCtx());
  await tick();
  const frame = root.all((n) => n.tagName === 'iframe')[0];
  const ready = { type: 'dzy-store-ready', v: 1 };

  await t(label + '：iframe 網址寫死營運系統＋?embed=dzy' + query, () => assert.equal(frame.src, ORIGIN + '/dzy-store/?embed=dzy' + query));
  await t(label + '：「在新分頁開啟」帶與 iframe 相同的查詢參數', () => {
    const a = root.all((n) => n.tagName === 'a')[0];
    assert.equal(a.href, ORIGIN + '/dzy-store/' + (query ? '?' + query.slice(1) : ''));
  });
  await t(label + '：origin 不對的 ready 不理', async () => {
    await winListeners.message({ origin: 'https://evil.example', source: frame.contentWindow, data: ready });
    assert.equal(calls.length, 0); assert.equal(sent.length, 0);
  });
  await t(label + '：source 不是這個 iframe 的 ready 不理', async () => {
    await winListeners.message({ origin: ORIGIN, source: { postMessage() {} }, data: ready });
    assert.equal(calls.length, 0); assert.equal(sent.length, 0);
  });
  await t(label + '：type／v 不對不理（含佈告欄的 dzyb-sso-ready）', async () => {
    for (const d of [{ type: 'dzyb-sso-ready' }, { type: 'dzy-store-ready', v: 2 }, { type: 'dzy-store-ready' }, null, 'dzy-store-ready']) {
      await winListeners.message({ origin: ORIGIN, source: frame.contentWindow, data: d });
    }
    assert.equal(calls.length, 0); assert.equal(sent.length, 0);
  });
  await t(label + '：正確 ready → 向平台換券 {aud:store}，回 dzy-store-sso（targetOrigin 寫死）', async () => {
    await winListeners.message({ origin: ORIGIN, source: frame.contentWindow, data: ready });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'ssoTicket');
    assert.deepEqual(calls[0].payload, { aud: 'store' });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].m, { type: 'dzy-store-sso', v: 1, ticket: TICKET });
    assert.equal(sent[0].o, ORIGIN);
  });
  await t(label + '：換不到券（或格式不對）就不送 sso', async () => {
    sent.length = 0;
    for (const bad of [{ ok: false, error: 'x' }, { ok: true, data: { ticket: 'zz' } }, { ok: true, data: {} }]) {
      ticketReply = bad;
      await winListeners.message({ origin: ORIGIN, source: frame.contentWindow, data: ready });
    }
    ticketReply = { ok: true, data: { ticket: TICKET } };
    assert.equal(sent.length, 0);
  });
  await t(label + '：卸載送 dzy-store-logout 並解除監聽', async () => {
    sent.length = 0;
    const p = unmount();
    timers.filter((x) => x.live && x.ms === 150).forEach((x) => x.fn());
    await p;
    assert.deepEqual(sent.map((s) => s.m), [{ type: 'dzy-store-logout', v: 1 }]);
    assert.equal(sent[0].o, ORIGIN);
    assert.equal(winListeners.message, undefined);
    assert.equal(root.children.length, 0);
  });
}

await t('三份共用檔 embed.js 逐字相同（門市營運、考勤管理、排班管理）', () => {
  const a = fs.readFileSync(new URL('../modules/storeops/embed.js', import.meta.url), 'utf8');
  const b = fs.readFileSync(new URL('../modules/attendance/embed.js', import.meta.url), 'utf8');
  const c = fs.readFileSync(new URL('../modules/schedule/embed.js', import.meta.url), 'utf8');
  assert.equal(a, b); assert.equal(a, c);
});

await t('return 白名單：營運系統網址一律放行；本機網址只在本機開發時放行', () => {
  const f = embedA.safeReturnUrl;
  assert.equal(f('https://dzy-bulletin.github.io/dzy-store/'), 'https://dzy-bulletin.github.io/dzy-store/');
  assert.equal(f('https://dzy-bulletin.github.io/dzy-store/index.html?x=1#old'), 'https://dzy-bulletin.github.io/dzy-store/index.html?x=1');
  for (const host of ['localhost', '127.0.0.1']) {
    globalThis.location = { hostname: host };
    assert.equal(f('http://localhost:8080/web/'), 'http://localhost:8080/web/');
    assert.equal(f('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/');
  }
  delete globalThis.location;
});
await t('return 白名單：正式網址（dzy.mozhuting.com 等）拒收本機網址，且沒有 location 也拒收', () => {
  const f = embedA.safeReturnUrl;
  for (const loc of [{ hostname: 'dzy.mozhuting.com' }, { hostname: 'eason0728.github.io' }, { hostname: 'localhost.evil.example' }, undefined]) {
    if (loc) globalThis.location = loc; else delete globalThis.location;
    assert.equal(f('http://localhost:8080/web/'), null);
    assert.equal(f('http://127.0.0.1:3000/'), null);
    assert.equal(f('https://dzy-bulletin.github.io/dzy-store/'), 'https://dzy-bulletin.github.io/dzy-store/');
  }
  delete globalThis.location;
});
await t('return 白名單：其他一律拒絕（含各種繞法）', () => {
  const f = embedA.safeReturnUrl;
  const bad = [
    undefined, null, '', 123, 'https://evil.example/', 'https://dzy-bulletin.github.io/', 'https://dzy-bulletin.github.io/dzy-store',
    'https://dzy-bulletin.github.io.evil.example/dzy-store/', 'https://dzy-bulletin.github.io@evil.example/dzy-store/',
    'http://dzy-bulletin.github.io/dzy-store/',
    'https://dzy-bulletin.github.io/dzy-storeX/', 'https://dzy-bulletin.github.io\\@evil.example/dzy-store/',
    'http://localhost/', 'http://localhost:80@evil.example/', 'http://127.0.0.1:80@evil.example/', 'http://localhost.evil.example:80/',
    'https://localhost:3000/', 'javascript:alert(1)', 'data:text/html,x', ' https://dzy-bulletin.github.io/dzy-store/',
    'https://dzy-bulletin.github.io/dzy-store/\n@evil', '//evil.example/dzy-store/'
  ];
  bad.forEach((u) => assert.equal(f(u), null, String(u)));
});

await t('return 流程（門市營運）：合格 → 取券後 location.replace(return#sso=券)，且不掛 iframe', async () => {
  calls.length = 0; replaced.length = 0;
  const root = new El('div');
  const un = storeops.mount(root, mkCtx({ return: 'https://dzy-bulletin.github.io/dzy-store/?s=gf' }));
  await tick(); await tick();
  assert.deepEqual(replaced, ['https://dzy-bulletin.github.io/dzy-store/?s=gf#sso=' + TICKET]);
  assert.equal(calls.length, 1);
  assert.equal(root.all((n) => n.tagName === 'iframe').length, 0);
  un();
});
await t('return 流程：不合格 → 忽略，顯示正常模組（iframe），不取券不導向', async () => {
  calls.length = 0; replaced.length = 0;
  const root = new El('div');
  const un = storeops.mount(root, mkCtx({ return: 'https://evil.example/dzy-store/' }));
  await tick();
  assert.equal(replaced.length, 0); assert.equal(calls.length, 0);
  assert.equal(root.all((n) => n.tagName === 'iframe').length, 1);
  un();
});
await t('return 流程：合格但換不到券 → 回到正常模組，不導向', async () => {
  calls.length = 0; replaced.length = 0;
  ticketReply = { ok: false, error: 'no_emp' };
  const root = new El('div');
  const un = storeops.mount(root, mkCtx({ return: 'http://localhost:9000/' }));
  await tick(); await tick();
  ticketReply = { ok: true, data: { ticket: TICKET } };
  assert.equal(replaced.length, 0);
  assert.equal(root.all((n) => n.tagName === 'iframe').length, 1);
  un();
});
await t('考勤管理不處理 return（照樣顯示 iframe）', async () => {
  calls.length = 0; replaced.length = 0;
  const root = new El('div');
  const un = attendance.mount(root, mkCtx({ return: 'https://dzy-bulletin.github.io/dzy-store/' }));
  await tick();
  assert.equal(replaced.length, 0); assert.equal(calls.length, 0);
  assert.equal(root.all((n) => n.tagName === 'iframe').length, 1);
  un();
});

await t('排班管理 forceGo：頁頂沒有 self／approve（在門市）時，首次同步與 onRoute 仍送 dzy-store-go；一般 id 不在頁頂不送', async () => {
  const root = new El('div');
  sent.length = 0;
  const navs = [];
  const ctx = { ...mkCtx(), viewId: 'approve', tabs: () => true, nav: (id) => navs.push(id) };
  const un = schedule.mount(root, ctx);
  await tick();
  const frame = root.all((n) => n.tagName === 'iframe')[0];
  const nav = { type: 'dzy-store-nav', v: 1, items: [{ id: 'board', label: '班表' }, { id: 'needs', label: '需求' }], cur: 'board' };
  await winListeners.message({ origin: ORIGIN, source: frame.contentWindow, data: nav });
  const gos = () => sent.map((x) => x.m).filter((m) => m.type === 'dzy-store-go');
  assert.deepEqual(gos(), [{ type: 'dzy-store-go', v: 1, id: 'approve' }]);
  assert.deepEqual(navs, [], '送出 go 後不被 cur=board 拉回');
  // 營運系統切店後回報 cur=approve → 不再拉回
  await winListeners.message({ origin: ORIGIN, source: frame.contentWindow, data: { ...nav, items: [{ id: 'self', label: '我的班表' }, { id: 'approve', label: '核准' }], cur: 'approve' } });
  assert.deepEqual(navs, []);
  // 之後點首頁提醒 self：onRoute 送 go self
  sent.length = 0;
  schedule.onRoute({ ...ctx, viewId: 'self' });
  assert.deepEqual(gos(), [{ type: 'dzy-store-go', v: 1, id: 'self' }]);
  un();
  // 非 forceGo 的 id 不在頁頂：首次同步不送
  const root2 = new El('div');
  sent.length = 0;
  const ctx2 = { ...mkCtx(), viewId: 'staff', tabs: () => true, nav() {} };
  const un2 = schedule.mount(root2, ctx2);
  await tick();
  const fr2 = root2.all((n) => n.tagName === 'iframe')[0];
  await winListeners.message({ origin: ORIGIN, source: fr2.contentWindow, data: nav });
  assert.deepEqual(gos(), []);
  un2();
});

await t('manifest：dept／requires／名稱符合規格，且過 manifest 驗證器', async () => {
  const { validateManifest } = await import('../platform/manifest-check.js');
  const s = (await import('../modules/storeops/manifest.js')).default;
  const a = (await import('../modules/attendance/manifest.js')).default;
  assert.equal(s.name, '門市營運'); assert.equal(s.dept, 'ops'); assert.deepEqual(s.requires, ['platform.storeops']);
  assert.equal(a.name, '考勤管理'); assert.equal(a.dept, 'hr'); assert.deepEqual(a.requires, ['platform.att']);
  [s, a].forEach((m) => { const r = validateManifest(m); assert.ok(r.ok, r.errors.join(';')); });
});


// 試跑模式（?dryrun=1）只擋管理系統自己的 API；嵌入的營運系統照常寫入 → iframe 上方要有明顯提示（2026-10-28 #8）。行為（照常發券）不變。
for (const [label, mod] of [['門市營運', storeops], ['考勤管理', attendance], ['排班管理', schedule]]) {
  for (const dry of [true, false]) {
    await t(label + '：' + (dry ? '★?dryrun=1 → iframe 上方顯示「嵌入的子系統會真的寫入」提示，照常發券' : '沒有 ?dryrun=1 → 不顯示試跑提示'), async () => {
      const prevLoc = globalThis.location;
      globalThis.location = { hostname: 'dzy.mozhuting.com', search: dry ? '?dryrun=1' : '' };
      const root = new El('div');
      sent.length = 0; calls.length = 0; ticketReply = { ok: true, data: { ticket: TICKET } };
      const un = mod.mount(root, mkCtx());
      await tick();
      const warn = root.all((n) => n.attrs['data-role'] === 'dryrun-embed-warn');
      const frame = root.all((n) => n.tagName === 'iframe')[0];
      if (dry) {
        assert.equal(warn.length, 1);
        assert.equal(warn[0].textContent, '試跑模式只保護管理系統本身；這個嵌入的子系統按送出會真的寫入，請勿送出');
        assert.ok(root.children.indexOf(warn[0]) < root.children.indexOf(frame), '提示在 iframe 上方');
        await winListeners.message({ origin: ORIGIN, source: frame.contentWindow, data: { type: 'dzy-store-ready', v: 1 } });
        assert.deepEqual(sent.map((x) => x.m.type), ['dzy-store-sso'], '照常發入場券');
      } else {
        assert.equal(warn.length, 0);
      }
      const p = un();
      timers.filter((x) => x.live && x.ms === 150).forEach((x) => x.fn());
      await p;
      if (prevLoc === undefined) delete globalThis.location; else globalThis.location = prevLoc;
    });
  }
}

process.exit(failed ? 1 : 0);
