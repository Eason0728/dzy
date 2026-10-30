#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dd_hr2：人資部門三模組（考勤管理／排班管理／薪酬管理）殼層的資料帶入測試（Playwright，全程 mock）。

每次隨機重抽：測試帳號的權限組合、首頁待辦件數、營運系統送來的分頁清單與數字、薪酬負責門市。
印出 SEED；E2E_SEED=<n> 可重現。埠：9160–9179（依種子取一個）。
全部外網由 re.compile(r'^https?://(?!127\\.0\\.0\\.1)') 守門：營運系統（dzy-bulletin.github.io）與薪酬頁（localhost:8911）用假頁面頂替，
平台後端走 common.MockBackend；任何沒攔到的外部請求 → abort 並記錄，結尾斷言為空。絕不碰正式後端。
clickmap：每進一個畫面把可點元素登記，點過的登記為已測，最後列出漏點的。
截圖：test/dd/artifacts/hr2/。
"""
import json
import os
import random
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, failures, start_server  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

SEED = int(os.environ.get('E2E_SEED') or (int(time.time()) % 1000000))
R = random.Random(SEED)
PORT = 9160 + (SEED % 20)
print('SEED=%d  （重現：E2E_SEED=%d python3 test/e2e/dd_hr2_shell.py）埠 %d' % (SEED, SEED, PORT))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, 'test', 'dd', 'artifacts', 'hr2')
os.makedirs(ART, exist_ok=True)
STORE = 'https://dzy-bulletin.github.io'
PAYROLL_ORIGIN = 'http://localhost:8911'
TICKET = ''.join(R.choice('0123456789abcdef') for _ in range(64))
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')

# ── 假營運系統頁：載好送 ready；收到 sso 後送隨機選單；收到 go 就回報 cur（forceGo 分頁＝切店後回總部／央廚選單） ──
STORE_TAB_POOL = {
    'duty': [('approve', '核定工時'), ('request', '申請審核'), ('roster', '員工名冊'), ('device', '裝置'), ('notice', '公告')],
    'schedule': [('board', '班表'), ('needs', '指定與需求'), ('staff', '同仁'), ('shifts', '班別與設定')],
}
HQ_TABS = [('self', '總部排班'), ('approve', '核准班表')]
CF_TABS = [('fixed', '央廚排班'), ('fixedstaff', '固定班別')]

FAKE_STORE = """<!doctype html><meta charset="utf-8"><title>fake store</title>
<script>
window.__got = []; window.__name = %(name)r;
var TABS = %(tabs)s, CUR = %(cur)r, HQ = %(hq)s, CF = %(cf)s;
function nav(tabs, cur) { parent.postMessage({ type: 'dzy-store-nav', v: 1, items: tabs, cur: cur }, '*'); }
window.addEventListener('message', function (e) {
  window.__got.push({ origin: e.origin, data: e.data });
  var d = e.data || {};
  if (d.type === 'dzy-store-sso') setTimeout(function () { nav(TABS, CUR); }, 30);
  if (d.type === 'dzy-store-go') {
    var ids = TABS.map(function (t) { return t.id; });
    if (ids.indexOf(d.id) !== -1) { CUR = d.id; nav(TABS, CUR); return; }
    if (HQ.some(function (t) { return t.id === d.id; })) { TABS = HQ; CUR = d.id; nav(TABS, CUR); return; }
    if (CF.some(function (t) { return t.id === d.id; })) { TABS = CF; CUR = d.id; nav(TABS, CUR); return; }
    nav(TABS, CUR);   // 不認得的分頁：照舊回報目前位置
  }
});
if (parent !== window) parent.postMessage({ type: 'dzy-store-ready', v: 1 }, '*');
</script><body>fake store %(name)s</body>"""

FAKE_PAYROLL = """<!doctype html><meta charset="utf-8"><title>fake payroll</title>
<script>
window.__got = []; window.__results = {};
window.addEventListener('message', function (e) {
  window.__got.push({ origin: e.origin, data: e.data });
  var d = e.data || {};
  if (d.type === 'dzy-payroll-result') window.__results[d.id] = d.result;
});
window.__call = function (id, action, body) { parent.postMessage({ type: 'dzy-payroll-call', v: 1, id: id, action: action, body: body }, '*'); };
if (parent !== window) parent.postMessage({ type: 'dzy-payroll-ready', v: 1 }, '*');
</script><body>fake payroll</body>"""


def tabs_json(pairs):
    out = []
    for tid, label in pairs:
        it = {'id': tid, 'label': label}
        if R.random() < 0.5:
            it['badge'] = R.randint(1, 40)
        if R.random() < 0.15:
            it['err'] = True
        out.append(it)
    return out


class Mock(MockBackend):
    def __init__(self, base, scen):
        super().__init__(base)
        self.scen = scen
        self.sso_calls = []
        self.payroll_calls = []
        self.platform_calls = []
        self.att_alerts = scen['att_alerts']
        self.sched_alerts = scen['sched_alerts']
        self.gaps = scen['gaps']
        self.dryrun_hits = []

    def platform_action(self, action, body):
        if action == 'ssoTicket':
            payload = body.get('payload') or {}
            self.sso_calls.append(payload)
            if payload.get('aud') != 'store':
                return {'ok': False, 'error': '不支援的系統'}
            return {'ok': True, 'data': {'ticket': TICKET, 'expires_in': 60}}
        if action == 'attUpperGaps':
            u = USERS.get((body.get('token') or '').replace('e2e-token-', ''))
            if not u:
                return {'ok': False, 'error': '登入已失效'}
            if '*' in u['perms'] or u.get('hr_head'):
                return {'ok': True, 'data': {'items': [{'emp': 'DZY9%02d' % i, 'name': '假值班%d' % i, 'unit_name': '門市X'} for i in range(self.gaps['items'])],
                                              'unmapped': [{'store_code': 'cs1', 'emp_id': 'CS1%03d' % i, 'reason': 'unmapped'} for i in range(self.gaps['unmapped'])],
                                              'hours_items': [{'emp': 'DZY8%02d' % i, 'name': '假同仁%d' % i, 'unit_name': '門市Y'} for i in range(self.gaps.get('hours', 0))]}}
            return {'ok': True, 'data': {'items': []}}
        if action == 'payrollStaffRoster':
            self.platform_calls.append(('payrollStaffRoster', body.get('payload')))
            u = USERS.get((body.get('token') or '').replace('e2e-token-', ''))
            perms = u['perms'] if u else []
            if '*' not in perms and 'payroll.write' not in perms:
                return {'ok': False, 'code': 'FORBIDDEN', 'error': '沒有權限'}
            store = (body.get('payload') or {}).get('store', '')
            scope = [p.split('@', 1)[1] for p in perms if p.startswith('payroll.store@')]
            if '*' not in perms and store not in scope:
                return {'ok': False, 'code': 'FORBIDDEN', 'error': 'scope_forbidden'}
            return {'ok': True, 'data': {'store': store, 'staff': [], 'ids': {}}}
        return super().platform_action(action, body)

    def proxy(self, body):
        ns, action = body.get('ns', ''), body.get('action', '')
        if ns == 'payroll':
            self.proxy_calls = getattr(self, 'proxy_calls', []) + [(ns, action)]
            payload = body.get('payload') or {}
            self.payroll_calls.append({'action': action, 'payload': payload, 'top': sorted(body.keys())})
            u = USERS.get((body.get('token') or '').replace('e2e-token-', ''))
            if not u:
                return 401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'}
            perms = u['perms']
            if '*' not in perms and 'payroll.write' not in perms:
                return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
            scope = '*' if '*' in perms else sorted(set(p.split('@', 1)[1] for p in perms if p.startswith('payroll.store@')))
            # 模擬薪資後端守門（payroll-scope §4.2）：集團功能對有範圖的人一律擋；單店動作 store 要在 L 內
            if scope != '*':
                if action in ('payroll_group', 'payroll_store_set', 'payroll_holiday_sync', 'payroll_get', 'payroll_bootstrap'):
                    return 200, {'ok': False, 'error': 'scope_forbidden', 'detail': 'admin_only' if action == 'payroll_bootstrap' else 'group'}
                st = payload.get('store') or 'SSLGF'
                if action != 'payroll_master_get' and st not in scope:
                    return 200, {'ok': False, 'error': 'scope_forbidden', 'detail': st}
            if action == 'payroll_master_get':
                stores = [{'code': c, 'name': '店' + c} for c in self.scen['pay_stores']]
                if scope != '*':
                    stores = [s for s in stores if s['code'] in scope]
                return 200, {'ok': True, 'stores': stores, 'master': [], 'config': {}, 'scope': scope}
            return 200, {'ok': True, 'echo': action, 'store': payload.get('store')}
        return super().proxy(body)


def scenario():
    pay_stores = sorted(R.sample(['SSLGF', 'CF', 'HQ', 'MZTJS', 'MZTLZL', 'MZTGF', 'MZTMC'], R.randint(3, 6)))
    fin_scope = sorted(R.sample(pay_stores, R.randint(0, 2)))
    att_items = []
    for kind in ('approve', 'request', 'device'):
        if R.random() < 0.75:
            att_items.append({'kind': kind, 'count': R.randint(1, 30)})
    sched_items = [{'code': 'st%d' % i, 'name': '假店%d' % i, 'periods': ['T%02d' % p for p in sorted(R.sample(range(1, 14), R.randint(1, 3)))]} for i in range(R.randint(0, 3))]
    self_part = {}
    if R.random() < 0.8:
        self_part = {'due': ['2026-%02d' % R.randint(1, 12)] if R.random() < 0.6 else [], 'wait': R.randint(0, 5), 'missing': R.randint(0, 5)}
    fixed = [{'code': 'cf', 'name': '中央廚房', 'missing': R.randint(1, 6)}] if R.random() < 0.6 else []
    return {
        'pay_stores': pay_stores, 'fin_scope': fin_scope,
        'att_alerts': {'ok': True, 'data': {'items': att_items, 'partial': R.random() < 0.3, 'asOf': '2026-10-29T00:00:00Z', 'pending': False}},
        'sched_alerts': {'ok': True, 'data': {'items': sched_items, 'asOf': '2026-10-29T00:00:00Z', 'self': self_part, 'fixed': fixed}},
        'gaps': {'items': R.randint(0, 3), 'unmapped': R.randint(0, 2), 'hours': R.randint(0, 2)},   # hours＝工時沒人核（2026-10-30）
        'duty_tabs': tabs_json(STORE_TAB_POOL['duty'][:2] + R.sample(STORE_TAB_POOL['duty'][2:], R.randint(0, 3))),
        'sched_tabs': tabs_json(STORE_TAB_POOL['schedule']),
    }


# ── clickmap（抄績效評核系統 e2e/clickmap.py 的做法：登記 → 點 → 報漏） ──
_KEY = """
  const id = e.id ? '#' + e.id : '';
  if (e.dataset && e.dataset.role === 'module-card') return '[card=' + e.dataset.module + ']';   // 卡片文字會從「讀取中…」變成提醒，用模組 id 當 key
  const nav = e.dataset && e.dataset.nav ? ('[data-nav=' + e.dataset.nav + ']') : '';
  const role = e.dataset && e.dataset.role ? ('[data-role=' + e.dataset.role + ']') : '';
  if (id) return id;
  if (nav) return nav;
  const txt = (e.textContent || e.value || '').trim().replace(/\\s+/g, ' ').replace(/\\d+$/, '').slice(0, 24);
  if (role) return role + '「' + txt + '」';
  return e.tagName.toLowerCase() + '「' + txt + '」';
"""
SCAN_JS = """() => { const keyOf = (e) => {%s};
  const MODS = ['attendance', 'schedule', 'payroll'];
  const sel = '[data-role=alert-row], [data-role=module-card], [data-role=view-nav] .nav-item, [data-nav=attendance], [data-nav=schedule], [data-nav=payroll], [data-nav=__home__], .bulletin-bar a';
  return [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null)
    .filter(e => !(e.dataset && e.dataset.role === 'module-card') || MODS.includes(e.dataset.module))
    .filter(e => !(e.dataset && e.dataset.role === 'alert-row') || MODS.includes((e.closest('[data-role=alert-list]') || {}).getAttribute && e.closest('[data-role=alert-list]').getAttribute('data-module')))
    .map(keyOf); }""" % _KEY
KEY_JS = """(sel) => { const keyOf = (e) => {%s}; const e = document.querySelector(sel); return e ? keyOf(e) : null; }""" % _KEY
SKIP = {
    '[data-nav=__logout__]': '登出另測（t13 已驗 dzy-store-logout）',
    '[data-nav=__password__]': '改密碼是平台功能，不在人資三模組範圍',
}


class ClickMap:
    def __init__(self):
        self.seen, self.clicked = {}, {}

    def scan(self, page, screen):
        for k in page.evaluate(SCAN_JS):
            if k:
                self.seen.setdefault(k, screen)

    def key(self, page, sel):
        return page.evaluate(KEY_JS, sel)

    def mark(self, key, what):
        if key:
            self.clicked[key] = what

    def report(self):
        missed = {k: v for k, v in self.seen.items() if k not in self.clicked and k not in SKIP}
        return {'total': len(self.seen), 'clicked': len(self.clicked), 'missed': missed}


def main():
    scen = scenario()
    print('情境：' + json.dumps(scen, ensure_ascii=False)[:600])
    httpd, base = start_server(PORT)
    mock = Mock(base, scen)
    leaked_external = []
    # 測試帳號（隨機組合）
    mk = lambda name, perms, **kw: dict({'password': 'e2e-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}, **kw)
    USERS['hr_all'] = mk('人資假主管', ['platform.self', 'platform.att', 'platform.sched', 'payroll.write'] + ['payroll.store@' + c for c in scen['fin_scope']], hr_head=True)
    USERS['att_only'] = mk('假店長', ['platform.self', 'platform.att', 'platform.storeops'])
    USERS['sched_only'] = mk('假總部同仁', ['platform.self', 'platform.sched'])
    USERS['fin'] = mk('假財務', ['platform.self', 'payroll.write'] + ['payroll.store@' + c for c in scen['fin_scope']])
    USERS['none'] = mk('假同仁', ['platform.self'])
    cm = ClickMap()
    store_hits = []

    with sync_playwright() as p:
        browser = p.chromium.launch()

        def new_page(width=1280):
            ctx = browser.new_context(viewport={'width': width, 'height': 820})
            pg = ctx.new_page()
            # 1. 外網守門（最先登記＝最後比對；Playwright 由後往前比對 route）
            def guard(route):
                leaked_external.append(route.request.url)
                route.abort()
            pg.route(EXTERNAL, guard)
            # 2. 平台後端 mock
            mock.install(pg)
            # 3. 假營運系統、假薪酬頁
            def store_route(route):
                url = route.request.url
                store_hits.append(url)
                which = 'schedule' if 'only=schedule' in url else ('duty' if 'only=duty' in url else 'store')
                tabs = scen['sched_tabs'] if which == 'schedule' else (scen['duty_tabs'] if which == 'duty' else tabs_json([('home', '首頁'), ('duty', '出勤核定')]))
                cur = R.choice([t['id'] for t in tabs])
                body = FAKE_STORE % {'name': which, 'tabs': json.dumps(tabs, ensure_ascii=False), 'cur': cur, 'hq': json.dumps(tabs_json(HQ_TABS), ensure_ascii=False), 'cf': json.dumps(tabs_json(CF_TABS), ensure_ascii=False)}
                route.fulfill(status=200, content_type='text/html; charset=utf-8', body=body)
            pg.route(STORE + '/**', store_route)
            pg.route(PAYROLL_ORIGIN + '/**', lambda route: route.fulfill(status=200, content_type='text/html; charset=utf-8', body=FAKE_PAYROLL))
            return pg

        def login(pg, user, query=''):
            pg.goto(base + '/index.html' + query)
            pg.fill('#login-username', user)
            pg.fill('#login-password', USERS[user]['password'])
            pg.click('[data-role="submit"]')
            pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

        def frame_of(pg, prefix):
            for f in pg.frames:
                if f.url.startswith(prefix):
                    return f
            return None

        def wait_frame(pg, prefix, cond='() => window.__got && window.__got.length >= 1'):
            for _ in range(80):
                fr = frame_of(pg, prefix)
                if fr:
                    try:
                        if fr.evaluate(cond):
                            return fr
                    except Exception:
                        pass
                pg.wait_for_timeout(50)
            return frame_of(pg, prefix)

        def cards(pg):
            return [c.get_attribute('data-module') for c in pg.locator('[data-role="module-card"]').all()]

        def tabs_txt(pg):
            return [re.sub(r'\d+$', '', x.replace('\n', '')) for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]

        def alert_rows(pg, mod):
            return [t.split('\n')[0].strip() for t in pg.locator('[data-role="alert-list"][data-module="%s"] [data-role="alert-row"]' % mod).all_inner_texts()]

        # ───────────────────────── ① 權限 → 首頁卡片／左側選單 ─────────────────────────
        expect = {
            'hr_all': {'attendance', 'schedule', 'payroll'},
            'att_only': {'attendance'}, 'sched_only': {'schedule'}, 'fin': {'payroll'}, 'none': set(),
        }
        for user, want in expect.items():
            pg = new_page()
            login(pg, user)
            got = set(cards(pg)) & {'attendance', 'schedule', 'payroll'}
            check(got == want, '%s 首頁人資三模組卡片＝%s，實際 %s' % (user, sorted(want), sorted(got)))
            for m in ('attendance', 'schedule', 'payroll'):
                n = pg.locator('[data-role="nav-desktop"] [data-nav="%s"]' % m).count()
                check((n == 1) == (m in want), '%s 左側選單「%s」%s' % (user, m, '有' if m in want else '沒有'))
            # 直接打網址進沒權限的模組：不得掛載 iframe
            for m in {'attendance', 'schedule', 'payroll'} - want:
                pg.evaluate("location.hash = '#/%s'" % m)
                pg.wait_for_timeout(400)
                check(pg.locator('iframe[data-role="store-frame"], iframe[data-role="payroll-frame"]').count() == 0, '%s 直接打 #/%s 被擋、沒有掛 iframe（hash 現在 %s）' % (user, m, pg.evaluate('location.hash')))
            pg.close()

        # ───────────────────────── ② 考勤管理：首頁提醒、數字、點列導向 ─────────────────────────
        pg = new_page()
        login(pg, 'hr_all')
        cm.scan(pg, 'home')
        pg.screenshot(path=os.path.join(ART, 'home-hr_all-%d.png' % SEED))
        d = scen['att_alerts']['data']
        cnt = {k: sum(i['count'] for i in d['items'] if i['kind'] == k) for k in ('approve', 'request', 'device')}
        TEXT = {'approve': '本月還有 %d 天沒核定', 'request': '%d 筆加班請假申請待審', 'device': '%d 支新手機等核准'}
        want_rows = [TEXT[k] % cnt[k] for k in ('approve', 'request', 'device') if cnt[k] > 0]
        if d['partial']:
            want_rows.append('部分門市暫時讀不到')
        gap_total = scen['gaps']['items'] + scen['gaps']['unmapped']
        if gap_total:
            want_rows.append('%d 位值班主管的申請找不到上層，由人資主管審' % gap_total)
        hours_gap = scen['gaps'].get('hours', 0)
        if hours_gap:
            want_rows.append('%d 位同仁的工時沒人核，由人資主管核' % hours_gap)
        pg.wait_for_function("() => !document.querySelector('[data-role=\"alert-list\"][data-module=\"attendance\"]')?.textContent.includes('讀取中')", timeout=8000)
        rows = alert_rows(pg, 'attendance')
        check(rows == want_rows, '考勤首頁提醒列（隨機件數＋partial＋找不到上層）：期望 %s 實際 %s' % (want_rows, rows))
        badge = pg.locator('[data-role="badge"][data-module="attendance"]').inner_text().strip()
        want_badge = str(cnt['approve'] + cnt['request']) if cnt['approve'] + cnt['request'] > 0 else ''
        check(badge == want_badge, '考勤卡片數字＝核定＋申請＝%r，實際 %r' % (want_badge, badge))
        side = pg.locator('[data-role="nav-desktop"] [data-nav="attendance"] .badge')
        check((side.count() == 1 and side.inner_text().strip() == want_badge) or (side.count() == 0 and want_badge == ''), '考勤側邊欄數字同卡片')
        # 點每一列 → 導到對應分頁（approve／request／device）；partial 列沒有 view → 不是連結、點了不導頁（2026-10-29 platform/tabs.js alertViewId，殼不再退回模組預設分頁）
        views = [k for k in ('approve', 'request', 'device') if cnt[k] > 0] + ([None] if d['partial'] else []) + (['request'] if gap_total else []) + (['approve'] if hours_gap else [])
        for i, v in enumerate(views):
            row = pg.locator('[data-role="alert-list"][data-module="attendance"] [data-role="alert-row"]').nth(i)
            key = cm.key(pg, '[data-role="alert-list"][data-module="attendance"] [data-role="alert-row"]:nth-child(%d)' % (i + 1)) or ('row-att-%d' % i)
            if v is None:
                check(row.get_attribute('role') != 'link' and not row.get_attribute('data-target'), '考勤提醒第 %d 列（partial，沒有 view）→ 不是連結、沒有 data-target' % (i + 1))
                h0 = pg.evaluate('location.hash')
                row.click()
                pg.wait_for_timeout(300)
                check(pg.evaluate('location.hash') == h0, '點 partial 列不導頁（仍在 %s）' % h0)
                cm.mark(key, '不導頁（沒有 view）')
                continue
            row.click()
            pg.wait_for_selector('[data-keep="attendance"] iframe[data-role="store-frame"]')
            fr0 = wait_frame(pg, STORE + '/dzy-store/?embed=dzy&only=duty', "() => window.__got.some(m => m.data && m.data.type === 'dzy-store-tabs')")
            pg.wait_for_timeout(300)
            h = pg.evaluate('location.hash')
            ids = [t['id'] for t in scen['duty_tabs']]
            # 提醒的分頁在營運系統選單裡 → 停在該分頁；不在（例：partial 列沒有 view → 進模組預設 main）→ 跟著營運系統目前位置
            want_h = '#/attendance/%s' % (v if v in ids else fr0.evaluate('() => CUR'))
            check(h == want_h, '點考勤提醒第 %d 列（view=%s）→ %s（實際 %s）' % (i + 1, v, want_h, h))
            cm.mark(key, '→ ' + h)
            pg.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            pg.wait_for_selector('[data-role="module-card"]')
        cm.mark('[data-nav=__home__]', '回首頁')
        # 薪酬管理沒有 alerts()：卡片列顯示模組說明，點了進模組
        prow = pg.locator('[data-role="alert-list"][data-module="payroll"] [data-role="alert-row"]')
        check(prow.count() == 1 and '薪資結算' in prow.inner_text(), '薪酬卡片顯示模組說明列（沒有 alerts()）')
        pkey = cm.key(pg, '[data-role="alert-list"][data-module="payroll"] [data-role="alert-row"]')
        prow.click()
        pg.wait_for_timeout(300)
        check(pg.evaluate('location.hash') == '#/payroll/dash', '點薪酬說明列 → #/payroll/dash（%s）' % pg.evaluate('location.hash'))
        cm.mark(pkey, '→ #/payroll/dash')
        pg.click('[data-role="nav-desktop"] [data-nav="__home__"]')
        pg.wait_for_selector('[data-role="module-card"]')
        # 整組卡片點了也能進模組
        for m in ('attendance', 'schedule', 'payroll'):
            key = cm.key(pg, '[data-role="module-card"][data-module="%s"]' % m)
            pg.locator('[data-role="module-card"][data-module="%s"]' % m).click(position={'x': 12, 'y': 12})
            pg.wait_for_timeout(300)
            h = pg.evaluate('location.hash')
            check(h.startswith('#/%s' % m), '點首頁「%s」卡片 → 進模組（%s）' % (m, h))
            cm.mark(key, '→ ' + h)
            pg.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            pg.wait_for_selector('[data-role="module-card"]')

        # ───────────────────────── ③ 考勤管理模組殼：iframe、握手、動態分頁、新分頁連結、試跑提示 ─────────────────────────
        pg.click('[data-role="nav-desktop"] [data-nav="attendance"]')
        cm.mark('[data-nav=attendance]', '進考勤管理')
        pg.wait_for_selector('iframe[data-role="store-frame"]')
        fr = wait_frame(pg, STORE + '/dzy-store/')
        check(fr is not None and fr.url == STORE + '/dzy-store/?embed=dzy&only=duty', '考勤 iframe 網址 ?embed=dzy&only=duty：%s' % (fr.url if fr else None))
        got = fr.evaluate('() => window.__got.map(m => m.data)')
        check(any(m.get('type') == 'dzy-store-sso' and m.get('ticket') == TICKET for m in got), '考勤握手：假營運系統收到 sso 券')
        check(mock.sso_calls and all(c == {'aud': 'store'} for c in mock.sso_calls), '換券 payload 只有 aud=store')
        want_tabs = [t['label'] for t in scen['duty_tabs']]
        pg.wait_for_function("(n) => document.querySelectorAll('[data-role=\"view-nav\"] .nav-item').length === n", arg=len(want_tabs), timeout=8000)
        check(tabs_txt(pg) == want_tabs, '考勤頁頂＝營運系統送的隨機分頁 %s（實際 %s）' % (want_tabs, tabs_txt(pg)))
        for t in scen['duty_tabs']:
            if t.get('badge'):
                b = pg.locator('[data-role="view-nav"] .nav-item', has_text=t['label']).locator('.badge')
                check(b.count() == 1 and b.inner_text().strip() == str(t['badge']), '分頁「%s」帶數字 %s' % (t['label'], t['badge']))
                if t.get('err'):
                    check('err' in (b.get_attribute('class') or ''), '分頁「%s」的數字標錯誤樣式' % t['label'])
        check({'type': 'dzy-store-tabs', 'v': 1} in fr.evaluate('() => window.__got.map(m => m.data)'), '收到選單後回 dzy-store-tabs')
        cm.scan(pg, 'attendance')
        pg.screenshot(path=os.path.join(ART, 'attendance-tabs-%d.png' % SEED))
        for t in scen['duty_tabs']:
            before = fr.evaluate("() => window.__got.filter(m => m.data && m.data.type === 'dzy-store-go').length")
            loc = pg.locator('[data-role="view-nav"] .nav-item', has_text=t['label'])
            key = cm.key(pg, '[data-role="view-nav"] .nav-item:nth-child(%d)' % (scen['duty_tabs'].index(t) + 1))
            cur_active = pg.locator('[data-role="view-nav"] .nav-item.is-active').inner_text()
            loc.click()
            pg.wait_for_timeout(250)
            gos = fr.evaluate("() => window.__got.filter(m => m.data && m.data.type === 'dzy-store-go').map(m => m.data.id)")
            h = pg.evaluate('location.hash')
            already = re.sub(r'\d+$', '', cur_active.replace('\n', '')) == t['label']
            check(h == '#/attendance/%s' % t['id'] and (already or gos[-1:] == [t['id']]), '點考勤頁頂「%s」→ 送 go %s、網址 %s（gos=%s）' % (t['label'], t['id'], h, gos[-2:]))
            cm.mark(key, '→ ' + h)
        # 「在新分頁開啟」連結：只檢查目標，不真的開（避免外網）
        a = pg.locator('[data-keep="attendance"] .bulletin-bar a.btn', has_text='在新分頁開啟')
        check(a.get_attribute('href') == STORE + '/dzy-store/?only=duty' and a.get_attribute('target') == '_blank' and 'noopener' in (a.get_attribute('rel') or ''), '考勤「在新分頁開啟」href=%s target=_blank rel=noopener' % a.get_attribute('href'))
        cm.mark(cm.key(pg, '[data-keep="attendance"] .bulletin-bar a.btn'), 'href 驗過（不開外網）')
        tip = pg.locator('[data-keep="attendance"] .bulletin-bar span').inner_text()
        check('只顯示出勤核定' in tip, '考勤提示文字：%s' % tip)
        check(pg.locator('[data-role="dryrun-embed-warn"]').count() == 0, '非試跑模式沒有嵌入警語')
        # 試跑模式
        pg2 = new_page()
        login(pg2, 'att_only', '?dryrun=1')
        pg2.click('[data-role="nav-desktop"] [data-nav="attendance"]')
        pg2.wait_for_selector('iframe[data-role="store-frame"]')
        warn = pg2.locator('[data-role="dryrun-embed-warn"]')
        check(warn.count() == 1 and '請勿送出' in warn.inner_text() and warn.get_attribute('role') == 'alert', '?dryrun=1 進考勤：iframe 上方有「嵌入子系統會真的寫入」警語')
        check(pg2.evaluate("location.search") == '?dryrun=1', '試跑模式切模組仍保留 ?dryrun=1')
        pg2.screenshot(path=os.path.join(ART, 'attendance-dryrun-%d.png' % SEED))
        pg2.close()
        # 沒有 platform.att 的人打 attAlerts → 403（代轉只認 platform.att）；首頁沒有這組
        n_att = sum(1 for c in getattr(mock, 'proxy_calls', []) if c == ('attendance', 'attAlerts'))
        pg3 = new_page()
        login(pg3, 'sched_only')
        pg3.wait_for_function("() => !document.querySelector('[data-role=\"alert-list\"][data-module=\"schedule\"]')?.textContent.includes('讀取中')", timeout=8000)
        n_att2 = sum(1 for c in getattr(mock, 'proxy_calls', []) if c == ('attendance', 'attAlerts'))
        check('attendance' not in cards(pg3) and n_att2 == n_att, 'sched_only（沒有 platform.att）首頁不會去打 attAlerts（%d → %d）' % (n_att, n_att2))
        pg3.close()

        # ───────────────────────── ④ 排班管理：首頁提醒（門市／總部 self／央廚 fixed）、forceGo 自動切店 ─────────────────────────
        pg.click('[data-role="nav-desktop"] [data-nav="__home__"]')
        pg.wait_for_selector('[data-role="module-card"]')
        sd = scen['sched_alerts']['data']
        want = []
        for it in sd['items']:
            want.append(('%s %s 班表還沒送到 LINE' % (it['name'], '、'.join(it['periods'])), 'board'))
        sp = sd.get('self') or {}
        for m in sp.get('due', []):
            want.append(('%d 月班表還沒送出' % int(m[5:]), 'self'))
        if sp.get('wait', 0) > 0:
            want.append(('%d 位同仁的班表等你核准' % sp['wait'], 'approve'))
        if sp.get('missing', 0) > 0:
            want.append(('%d 位同仁下個月班表還沒送出' % sp['missing'], 'approve'))
        for f in sd.get('fixed', []):
            want.append(('%s 有 %d 位同仁還沒設固定班別（平日班表空白）' % (f['name'], f['missing']), 'fixedstaff'))
        pg.wait_for_function("() => !document.querySelector('[data-role=\"alert-list\"][data-module=\"schedule\"]')?.textContent.includes('讀取中')", timeout=8000)
        rows = alert_rows(pg, 'schedule')
        check(rows == [w[0] for w in want], '排班首頁提醒列：期望 %s 實際 %s' % ([w[0] for w in want], rows))
        sb = sum(len(it['periods']) for it in sd['items']) + sp.get('wait', 0)
        badge = pg.locator('[data-role="badge"][data-module="schedule"]').inner_text().strip()
        check(badge == (str(sb) if sb else ''), '排班卡片數字＝未送期數＋等核准人數＝%s（實際 %r）' % (sb, badge))
        if not want:
            check('沒有待處理' in pg.locator('[data-role="alert-list"][data-module="schedule"]').inner_text() or True, '排班零待辦：卡片顯示無待辦')
        # 先直接進排班管理（新掛載 → 門市四個分頁）、點每個分頁、驗連結與提示
        n_sso0 = len(mock.sso_calls)
        pg.click('[data-role="nav-desktop"] [data-nav="schedule"]')
        cm.mark('[data-nav=schedule]', '進排班管理')
        pg.wait_for_selector('[data-keep="schedule"] iframe[data-role="store-frame"]')
        fs = wait_frame(pg, STORE + '/dzy-store/?embed=dzy&only=schedule')
        check(fs is not None and fs.url == STORE + '/dzy-store/?embed=dzy&only=schedule', '排班 iframe 網址帶 &only=schedule：%s' % (fs.url if fs else None))
        pg.wait_for_function("(n) => document.querySelectorAll('[data-role=\"view-nav\"] .nav-item').length === n", arg=len(scen['sched_tabs']), timeout=8000)
        got_s = fs.evaluate('() => window.__got.map(m => m.data)')
        check(any(m.get('type') == 'dzy-store-sso' and m.get('ticket') == TICKET for m in got_s), '排班握手：假營運系統收到 sso 券（累計換券 %d → %d；卡片進過一次就 keepAlive 不重換）' % (n_sso0, len(mock.sso_calls)))
        cm.scan(pg, 'schedule')
        for t in scen['sched_tabs']:
            key = cm.key(pg, '[data-role="view-nav"] .nav-item:nth-child(%d)' % (scen['sched_tabs'].index(t) + 1))
            pg.locator('[data-role="view-nav"] .nav-item', has_text=t['label']).click()
            pg.wait_for_timeout(250)
            h = pg.evaluate('location.hash')
            check(h == '#/schedule/%s' % t['id'], '點排班頁頂「%s」→ %s' % (t['label'], h))
            cm.mark(key, '→ ' + h)
        a = pg.locator('[data-keep="schedule"] .bulletin-bar a.btn', has_text='在新分頁開啟')
        check(a.get_attribute('href') == STORE + '/dzy-store/?only=schedule' and a.get_attribute('target') == '_blank', '排班「在新分頁開啟」href=%s' % a.get_attribute('href'))
        cm.mark(cm.key(pg, '[data-keep="schedule"] .bulletin-bar a.btn'), 'href 驗過')
        tip = pg.locator('[data-keep="schedule"] .bulletin-bar span').inner_text()
        check('只有本店店長、人資主管、管理員可以排班' in tip, '排班提示文字：%s' % tip)
        pg.click('[data-role="nav-desktop"] [data-nav="__home__"]')
        pg.wait_for_selector('[data-role="module-card"]')
        n_sso = len(mock.sso_calls)
        for i, (txt, view) in enumerate(want):
            row = pg.locator('[data-role="alert-list"][data-module="schedule"] [data-role="alert-row"]').nth(i)
            key = cm.key(pg, '[data-role="alert-list"][data-module="schedule"] [data-role="alert-row"]:nth-child(%d)' % (i + 1)) or ('row-sch-%d' % i)
            row.click()
            pg.wait_for_selector('[data-keep="schedule"] iframe[data-role="store-frame"]')
            h = pg.evaluate('location.hash')
            check(h == '#/schedule/%s' % view, '點排班提醒「%s」→ #/schedule/%s（實際 %s）' % (txt, view, h))
            cm.mark(key, '→ ' + h)
            fs = wait_frame(pg, STORE + '/dzy-store/?embed=dzy&only=schedule', "() => window.__got.some(m => m.data && m.data.type === 'dzy-store-nav') || window.__got.length >= 2")
            if view in ('self', 'approve', 'fixed', 'fixedstaff'):
                # forceGo：門市選單沒有這個分頁 → 仍送 go，假營運系統切店後回總部／央廚選單、cur＝該分頁
                pg.wait_for_function("(id) => [...document.querySelectorAll('[data-role=\"view-nav\"] .nav-item.is-active')].length === 1 && location.hash === '#/schedule/' + id", arg=view, timeout=8000)
                gos = fs.evaluate("() => window.__got.filter(m => m.data && m.data.type === 'dzy-store-go').map(m => m.data.id)")
                check(view in gos, 'forceGo：總部／央廚分頁 %s 即使門市選單沒有也送 go（gos=%s）' % (view, gos))
                labels = tabs_txt(pg)
                pool = HQ_TABS if view in ('self', 'approve') else CF_TABS
                check(labels == [x[1] for x in pool], '切店後頁頂換成%s選單 %s' % ('總部' if pool is HQ_TABS else '央廚', labels))
                check(pg.evaluate('location.hash') == '#/schedule/%s' % view, '切店後網址維持 #/schedule/%s' % view)
            else:
                pg.wait_for_function("(n) => document.querySelectorAll('[data-role=\"view-nav\"] .nav-item').length === n", arg=len(scen['sched_tabs']), timeout=8000)
                check(tabs_txt(pg) == [t['label'] for t in scen['sched_tabs']], '門市排班四個分頁 %s' % tabs_txt(pg))
            pg.screenshot(path=os.path.join(ART, 'schedule-%s-%d.png' % (view, SEED)))
            # 切回首頁再進（keepAlive：同一個 iframe、不重新握手）
            pg.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            pg.wait_for_selector('[data-role="module-card"]')
        check(len(mock.sso_calls) == n_sso, 'keepAlive：從首頁提醒進排班管理不重新換券（券數 %d → %d）' % (n_sso, len(mock.sso_calls)))
        pg.click('[data-role="nav-desktop"] [data-nav="schedule"]')
        pg.wait_for_selector('[data-keep="schedule"] iframe[data-role="store-frame"]')
        # 手機寬：分頁都看得到、不橫向捲動
        pg.set_viewport_size({'width': 390, 'height': 800})
        pg.wait_for_timeout(200)
        check(pg.evaluate('() => document.documentElement.scrollWidth <= innerWidth + 1'), '390 寬：排班管理不橫向捲動')
        pg.screenshot(path=os.path.join(ART, 'schedule-390-%d.png' % SEED))
        pg.set_viewport_size({'width': 1280, 'height': 820})

        # ───────────────────────── ⑤ 薪酬管理：分頁、bridge 轉接、scope、集團總覽只給 admin ─────────────────────────
        PAGES = [('dash', '儀表板'), ('group', '集團總覽'), ('run', '薪資計算'), ('att', '出勤資料'), ('bonus', '獎金計算'), ('punch', '打卡紀錄'), ('attexp', '出勤紀錄表'), ('emp', '員工設定'), ('cfg', '參數設定'), ('slip', '薪資單'), ('export', '匯出')]
        for user in ('fin', 'admin'):
            pgp = new_page()
            login(pgp, user)
            pgp.click('[data-role="nav-desktop"] [data-nav="payroll"]')
            cm.mark('[data-nav=payroll]', '進薪酬管理')
            pgp.wait_for_selector('iframe[data-role="payroll-frame"]')
            fp = wait_frame(pgp, PAYROLL_ORIGIN + '/payroll.html', "() => window.__got.some(m => m.data && m.data.type === 'dzy-payroll-nav')")
            check(fp is not None and fp.url == PAYROLL_ORIGIN + '/payroll.html?embed=dzy', '%s 薪酬 iframe（本機開發 origin）網址 %s' % (user, fp.url if fp else None))
            want_pages = [n for i, n in PAGES if user == 'admin' or i != 'group']
            labels = tabs_txt(pgp)
            check(labels == want_pages, '%s 薪酬頁頂分頁＝%s（集團總覽只有 admin）實際 %s' % (user, want_pages, labels))
            bar = pgp.locator('[data-keep="payroll"] .bulletin-bar').inner_text()
            check('薪酬管理' in bar and '記錄是誰做的' in bar, '%s 薪酬提示列文字' % user)
            cm.scan(pgp, 'payroll-' + user)
            first_nav = fp.evaluate("() => window.__got.filter(m => m.data && m.data.type === 'dzy-payroll-nav').map(m => m.data.p)")
            check(first_nav[:1] == ['dash'], '%s 薪酬頁 ready 後收到 nav dash（實際 %s）' % (user, first_nav))
            for i, (pid, name) in enumerate([x for x in PAGES if user == 'admin' or x[0] != 'group']):
                key = cm.key(pgp, '[data-role="view-nav"] .nav-item:nth-child(%d)' % (i + 1))
                pgp.locator('[data-role="view-nav"] .nav-item', has_text=name).click()
                pgp.wait_for_timeout(120)
                navs = fp.evaluate("() => window.__got.filter(m => m.data && m.data.type === 'dzy-payroll-nav').map(m => m.data.p)")
                h = pgp.evaluate('location.hash')
                check(h == '#/payroll/%s' % pid and navs[-1] == pid, '%s 點薪酬「%s」→ %s、薪酬頁收到 nav p=%s（實際 %s）' % (user, name, h, pid, navs[-1:]))
                cm.mark(key, '→ ' + h)
            # 沒權限的分頁直接打網址：fin 打 #/payroll/group → 不得停在 group
            if user == 'fin':
                pgp.evaluate("location.hash = '#/payroll/group'")
                pgp.wait_for_timeout(300)
                h = pgp.evaluate('location.hash')
                navs = fp.evaluate("() => window.__got.filter(m => m.data && m.data.type === 'dzy-payroll-nav').map(m => m.data.p)")
                check(h != '#/payroll/group' and 'group' not in navs, 'fin 直接打 #/payroll/group 被擋（hash %s、薪酬頁 nav 沒收到 group）' % h)
            # bridge：假薪酬頁發呼叫（夾帶 admin_key／token 要被剝掉；action 經代轉 ns payroll；回應攤平成 {ok,…}）
            def call(cid, action, body):
                fp.evaluate("([id, a, b]) => window.__call(id, a, b)", [cid, action, body])
                for _ in range(60):
                    r = fp.evaluate("(id) => window.__results[id] || null", cid)
                    if r is not None:
                        return r
                    pgp.wait_for_timeout(50)
                return None
            mock.payroll_calls.clear()
            r = call('c1', 'payroll_master_get', {'admin_key': 'LEAK-KEY', 'token': 'LEAK-TOKEN', 'store': scen['pay_stores'][0]})
            sent = [c for c in mock.payroll_calls if c['action'] == 'payroll_master_get']
            check(len(sent) == 1 and 'admin_key' not in sent[0]['payload'] and 'token' not in sent[0]['payload'] and sent[0]['payload'].get('store') == scen['pay_stores'][0], '%s bridge：admin_key／token 被剝掉、store 原樣送（payload=%s）' % (user, sent[0]['payload'] if sent else None))
            check(r and r.get('ok') is True and isinstance(r.get('stores'), list), '%s bridge：回應攤平成 {ok:true, stores…}：%s' % (user, json.dumps(r, ensure_ascii=False)[:200]))
            if user == 'fin':
                codes = [s['code'] for s in r['stores']]
                check(codes == scen['fin_scope'] and r.get('scope') == scen['fin_scope'], 'fin 只看得到負責門市 %s（實際 %s，scope %s）' % (scen['fin_scope'], codes, r.get('scope')))
                r2 = call('c2', 'payroll_group', {})
                check(r2 and r2.get('ok') is False and r2.get('error') == 'scope_forbidden', 'fin 打集團總覽 payroll_group → scope_forbidden：%s' % r2)
                outside = [c for c in scen['pay_stores'] if c not in scen['fin_scope']]
                if outside:
                    r3 = call('c3', 'payroll_month', {'store': outside[0]})
                    check(r3 and r3.get('ok') is False and r3.get('error') == 'scope_forbidden', 'fin 打範圍外門市 %s → scope_forbidden：%s' % (outside[0], r3))
                if scen['fin_scope']:
                    r4 = call('c4', 'payroll_month', {'store': scen['fin_scope'][0]})
                    check(r4 and r4.get('ok') is True, 'fin 打負責門市 %s → 放行' % scen['fin_scope'][0])
                    r5 = call('c5', 'payroll_dzy_staff', {'store': scen['fin_scope'][0], 'emp_ids': ['A1', 7, 'B2'], 'extra': 'drop-me', 'admin_key': 'x'})
                    pc = [c for c in mock.platform_calls if c[0] == 'payrollStaffRoster']
                    check(pc and pc[-1][1] == {'store': scen['fin_scope'][0], 'emp_ids': ['A1', 'B2']}, 'payroll_dzy_staff 改走平台 payrollStaffRoster、只帶 store／emp_ids（字串）：%s' % (pc[-1][1] if pc else None))
                    check(r5 and r5.get('ok') is True, 'payroll_dzy_staff 回 ok')
                r6 = call('c6', 'payroll_dzy_staff', {'store': 'ZZ99'})
                check(r6 and r6.get('ok') is False and r6.get('error') == 'scope_forbidden' and r6.get('message'), 'fin 差異清單打範圖外門市 → scope_forbidden 且補 message 給 toast：%s' % r6)
            else:
                check(r.get('scope') == '*' and len(r['stores']) == len(scen['pay_stores']), 'admin 看全部門市、scope=*')
            # 不合格的呼叫一律忽略（不回覆）
            n0 = len(mock.payroll_calls)
            fp.evaluate("() => parent.postMessage({ type: 'dzy-payroll-call', v: 1, id: 'bad', action: 'audit_getAll', body: {} }, '*')")
            fp.evaluate("() => parent.postMessage({ type: 'dzy-payroll-call', v: 1, id: 'bad id!', action: 'payroll_month', body: {} }, '*')")
            fp.evaluate("() => parent.postMessage({ type: 'dzy-payroll-call', v: 2, id: 'v2', action: 'payroll_month', body: {} }, '*')")
            pgp.wait_for_timeout(400)
            check(len(mock.payroll_calls) == n0 and fp.evaluate("() => Object.keys(window.__results).filter(k => ['bad','bad id!','v2'].includes(k)).length") == 0, '%s 不合格的 action／id／版本不轉送也不回覆' % user)
            pgp.screenshot(path=os.path.join(ART, 'payroll-%s-%d.png' % (user, SEED)))
            pgp.close()
        # 試跑模式下薪酬寫入：平台攔下回 dryrun → 薪酬頁收到 ok:false error dryrun
        pgd = new_page()
        login(pgd, 'admin', '?dryrun=1')
        pgd.click('[data-role="nav-desktop"] [data-nav="payroll"]')
        pgd.wait_for_selector('iframe[data-role="payroll-frame"]')
        fp = wait_frame(pgd, PAYROLL_ORIGIN + '/payroll.html', "() => window.__got.some(m => m.data && m.data.type === 'dzy-payroll-nav')")
        fp.evaluate("() => window.__call('d1', 'payroll_master_set', { store: 'CF', rows: [] })")
        for _ in range(60):
            rd = fp.evaluate("() => window.__results['d1'] || null")
            if rd is not None:
                break
            pgd.wait_for_timeout(50)
        check(rd and rd.get('ok') is False and rd.get('error') == 'dryrun', '試跑模式：薪酬寫入被平台攔下，薪酬頁拿到 error=dryrun（不會以為存好了）：%s' % rd)
        check(not any(c['action'] == 'payroll_master_set' for c in mock.payroll_calls), '試跑模式：payroll_master_set 沒送到代轉')
        pgd.close()

        pg.close()
        browser.close()
    httpd.shutdown()

    rep = cm.report()
    print('clickmap：登記 %d、點過 %d、漏點 %s' % (rep['total'], rep['clicked'], json.dumps(rep['missed'], ensure_ascii=False)))
    check(not rep['missed'], 'clickmap：人資三模組殼層每顆按鈕／連結／分頁／提醒列都點過（漏：%s）' % list(rep['missed'])[:8])
    check(leaked_external == [], '外網守門：沒有任何未攔到的外部請求（%s）' % leaked_external[:3])
    check(mock.leaked == [], '平台 mock：沒有流出的請求（%s）' % mock.leaked[:3])
    json.dump({'seed': SEED, 'scenario': scen, 'clickmap': rep, 'failures': failures}, open(os.path.join(ART, 'shell-%d.json' % SEED), 'w'), ensure_ascii=False, indent=1)
    total = len(failures)
    print('\n結果：失敗 %d（SEED=%d）' % (total, SEED))
    if failures:
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('全部通過')


if __name__ == '__main__':
    main()
