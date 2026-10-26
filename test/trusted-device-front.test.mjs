// 認得的手機（2026-10-25 全資料審查 MB-03）前端：platform/auth.js 按帳號存 device 憑證、登入時帶上、登出不清
import * as Auth from '../platform/auth.js';

let passed = 0, failed = 0;
const ok = (c, label, extra) => { if (c) { passed++; console.log('PASS: ' + label); } else { failed++; console.error('FAIL: ' + label, extra === undefined ? '' : JSON.stringify(extra)); } };

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear()
};

const sent = [];
function backend(deviceFor) {
  Auth.__setTransport(async (req) => {
    sent.push(req);
    if (req.action === 'login') {
      const d = deviceFor(req.payload.username);
      return { ok: true, data: Object.assign({ token: 'TOK-' + req.payload.username, user: { id: 'u1', name: '假', role: 'staff', node: '' }, perms: [] }, d ? { device: d } : {}) };
    }
    return { ok: true, data: {} };
  });
}

const KEY = Auth.DEVICE_STORAGE_KEY;
ok(KEY === 'dzy.device', '0 key 名稱是 dzy.device');

backend((u) => 'DEV-' + u.toUpperCase());
await Auth.login('DZY001', 'fake-pw-0001');
ok(sent[0].payload.device === undefined, '1 第一次登入（手機還沒被認得）不帶 device');
ok(JSON.parse(store.get(KEY))['dzy001'] === 'DEV-DZY001', '2 登入成功把憑證按帳號（小寫）存起來', store.get(KEY));

await Auth.logout();
ok(JSON.parse(store.get(KEY))['dzy001'] === 'DEV-DZY001', '3 ★登出不清手機憑證（認的是手機，不是這次登入）');

await Auth.login('dzy001', 'fake-pw-0001');
ok(sent.filter((r) => r.action === 'login')[1].payload.device === 'DEV-DZY001', '4 ★再次登入（大小寫不同）自動帶上同一張憑證');

await Auth.login('DZY002', 'fake-pw-0002');
const m = JSON.parse(store.get(KEY));
ok(m['dzy001'] === 'DEV-DZY001' && m['dzy002'] === 'DEV-DZY002', '5 公用手機多人輪流登入：各帳號各一張，互不覆蓋', m);
const lastLogin = sent.filter((r) => r.action === 'login').pop();
ok(lastLogin.payload.device === undefined, '6 不會把別人的憑證帶給另一個帳號');

for (let i = 0; i < 25; i++) await Auth.login('USER' + i, 'x');
const m2 = JSON.parse(store.get(KEY));
ok(Object.keys(m2).length === 20 && m2['user24'] && !m2['dzy001'], '7 最多留 20 個帳號，超過丟最舊的', Object.keys(m2).length);

store.set(KEY, 'not-json{');
backend(() => 'DEV-NEW');
const r = await Auth.login('DZY003', 'x');
ok(r.ok === true && JSON.parse(store.get(KEY))['dzy003'] === 'DEV-NEW', '8 存的內容壞掉：登入照常、重新存');

backend(() => null);
await Auth.login('DZY004', 'x');
ok(JSON.parse(store.get(KEY))['dzy004'] === undefined, '9 後端沒回 device（舊後端）：不存、登入照常');

console.log(`通過 ${passed}／${passed + failed}`);
if (failed) process.exit(1);
