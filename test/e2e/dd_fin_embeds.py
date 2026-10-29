#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""資料帶入測試（財務部門）：三個 iframe 型模組——貨單核對 modules/purchase、調撥管理 modules/transfer-fin、損益系統 modules/pnl。

被嵌的三個網頁本體在別的 repo（mala-purchase／mala-transfer／mala-pnl-auto），這裡用「假子頁」取代：
用正式網址當別名（dzy.mozhuting.com、dzy-bulletin.github.io、eason0728.github.io、mala-pnl.github.io 都由 Playwright route 餵本機內容），
iframe 的 origin 與 postMessage targetOrigin 跟正式環境一模一樣，驗的是 dzy 殼＋模組的轉接：握手、入場券、分頁同步、代轉白名單、
敏感欄位剝除、試跑攔截、角色可見性、首頁提醒數字。資料隨機重抽（分頁清單、張數、待補項數、門市數、動作與 payload、角色權限），
E2E_SEED=<種子> 重現；零真實後端。

用法：python3 test/e2e/dd_fin_embeds.py（埠 9182）
"""
import json
import os
import random
import re
import sys
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

PORT = 9182
SITE = 'https://dzy.mozhuting.com'
PURCHASE_ORIGIN = 'https://dzy-bulletin.github.io'
TRANSFER_ORIGIN = 'https://eason0728.github.io'
PNL_ORIGIN = 'https://mala-pnl.github.io'
PURCHASE_API = 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/purchase/api'
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, 'test', 'dd', 'artifacts', 'fin')
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')
SEED = int(os.environ.get('E2E_SEED') or random.randrange(1, 10 ** 9))
R = random.Random(SEED)
print('E2E_SEED=%d' % SEED)

T_READ = ['bootstrap', 'adminData', 'adminOverview', 'getDoc']
T_WRITE = ['buildMonthlyReport', 'adminUpdate']
P_READ = ['getMonth', 'getTrend', 'getTrendMulti', 'getSettings', 'exportEntries', 'getAttachment']
P_WRITE = ['addEntry', 'voidEntry', 'importEntries', 'uploadAttachment', 'confirmZero', 'finalize', 'unlock', 'saveSettings', 'createDraft', 'refreshConnectors', 'refreshFixed', 'loadGroupUnits']
P_ADMIN = ['finalize', 'unlock', 'saveSettings', 'createDraft', 'refreshConnectors', 'refreshFixed', 'loadGroupUnits']
SENSITIVE = ('pin_master', 'token', 'operator', 'key', 'level', 'inner', 'adminKey', 'code', 'pass', 'password')
PNL_TABS = [('dashboard', '儀表板'), ('pending', '待補'), ('food', '食材'), ('labor', '人事'), ('controllable', '可控'), ('uncontrollable', '不可控'), ('revenue', '營業收入'), ('import', '匯入'), ('settings', '設定')]
PURCHASE_TAB_POOL = [('review', '待核對'), ('confirmed', '已入帳'), ('failed', '辨識失敗'), ('alerts', '價格提醒'), ('price', '單價走勢'), ('cost', '食材成本'), ('daily', '每日進貨'), ('items', '品項廠商'), ('users', '帳號')]
STORE_POOL = [('gf', '新竹光復'), ('mc', '台中美村'), ('nc', '員林南昌'), ('ck', '中央廚房')]


def make_dataset():
    n_tabs = R.randint(3, 9)
    tabs = PURCHASE_TAB_POOL[:n_tabs]
    badges = {tid: (R.randint(1, 40) if R.random() < 0.5 else 0) for tid, _ in tabs}
    counts = {'review': R.choice([0, R.randint(1, 60)]), 'failed': R.choice([0, R.randint(1, 20)])}
    stores = R.sample(STORE_POOL, R.randint(1, 4))
    pending = {c: R.choice([0, 0, R.randint(1, 12)]) for c, _ in stores}
    return {'purchase_tabs': tabs, 'badges': badges, 'counts': counts, 'stores': stores, 'pending': pending,
            'ticket': ''.join(R.choice('0123456789abcdef') for _ in range(64)),
            'month_num': None}


# ------------------------------------------------------------
# 假子頁（三套共用骨架）：收 nav 訊息、能被測試叫去送 call、把所有收到的訊息記在 window.__got
# ------------------------------------------------------------

def child_html(kind, parent_origin, ds):
    if kind == 'purchase':
        boot = """
          post({type:'dzy-purchase-ready', v:1});
          window.addEventListener('message', (e) => {
            if (e.origin !== PARENT || e.source !== window.parent) return;
            window.__got.push(e.data);
            if (e.data && e.data.type === 'dzy-purchase-sso') { window.__ticket = e.data.ticket; sendNav(TABS[0].id); }
            if (e.data && e.data.type === 'dzy-purchase-go') { window.__cur = e.data.id; sendNav(e.data.id); }
          });
          window.sendNav = function (cur) { window.__cur = cur; post({type:'dzy-purchase-nav', v:1, items: TABS.map(t => ({id:t.id, label:t.label, badge:t.badge})), cur}); };
        """
        extra = 'const TABS = %s;' % json.dumps([{'id': t, 'label': l, 'badge': ds['badges'][t]} for t, l in ds['purchase_tabs']], ensure_ascii=False)
    else:
        pre = 'dzy-transfer' if kind == 'transfer' else 'dzy-pnl'
        boot = """
          window.__pending = {};
          window.addEventListener('message', (e) => {
            if (e.origin !== PARENT || e.source !== window.parent) return;
            window.__got.push(e.data);
            if (e.data && e.data.type === '%(pre)s-result' && window.__pending[e.data.id]) { window.__pending[e.data.id](e.data.result); delete window.__pending[e.data.id]; }
            if (e.data && e.data.type === '%(pre)s-nav') { window.__nav = e.data.p; document.getElementById('cur').textContent = e.data.p; }
          });
          window.__call = function (id, action, payload) { return new Promise((res) => { window.__pending[id] = res; post({type:'%(pre)s-call', v:1, id, action, %(field)s: payload}); setTimeout(() => res({timeout:true}), 8000); }); };
          window.__raw = function (msg) { post(msg); };
          post({type:'%(pre)s-ready', v:1});
        """ % {'pre': pre, 'field': 'payload' if kind == 'transfer' else 'body'}
        extra = ''
    return """<!doctype html><html><head><meta charset="utf-8"><title>fake %s</title></head><body><h1>假子頁 %s</h1><div id="cur"></div>
      <script>
        const PARENT = %s; window.__got = [];
        %s
        function post(m) { window.parent.postMessage(m, PARENT); }
        if (new URLSearchParams(location.search).get('embed') === 'dzy' && window.parent !== window) { %s }
      </script></body></html>""" % (kind, kind, json.dumps(parent_origin), extra, boot)


# ------------------------------------------------------------
# 假代轉：transfer／pnl ns＋platform ssoTicket＋貨單 /sso/counts
# ------------------------------------------------------------

class MockEmbeds(MockBackend):
    def __init__(self, base, ds):
        super().__init__(base)
        self.ds = ds
        self.sso_calls = []
        self.ns_calls = []      # (ns, action, payload, who)
        self.sens_leaked = []
        self.counts_hits = []

    def platform_action(self, action, body):
        if action == 'ssoTicket':
            payload = body.get('payload') or {}
            who = (body.get('token') or '').replace('e2e-token-', '')
            u = USERS.get(who)
            self.sso_calls.append((who, dict(payload)))
            if not u:
                return {'ok': False, 'error': 'token 無效'}
            if payload.get('aud') != 'purchase':
                return {'ok': False, 'error': '不支援的系統', 'code': 'bad_aud'}
            if '*' not in u['perms'] and 'platform.purchase' not in u['perms']:
                return {'ok': False, 'error': '沒有貨單核對權限', 'code': 'no_perm'}
            return {'ok': True, 'data': {'ticket': self.ds['ticket'], 'expires_in': 60}}
        return super().platform_action(action, body)

    def proxy(self, body):
        ns = body.get('ns')
        if ns not in ('transfer', 'pnl'):
            return super().proxy(body)
        action = body.get('action', '')
        self.proxy_calls = getattr(self, 'proxy_calls', []) + [(ns, action)]
        token = body.get('token') or ''
        if not token:
            return 401, {'ok': False, 'error': 'NO_TOKEN', 'code': 'NO_TOKEN'}
        who = token.replace('e2e-token-', '')
        u = USERS.get(who)
        if not u:
            return 401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'}
        perms = u['perms']
        has = lambda p: '*' in perms or p in perms
        payload = dict(body.get('payload') or {})
        for k in SENSITIVE:
            if k in payload:
                self.sens_leaked.append('%s/%s:%s' % (ns, action, k))
        reads, writes = (T_READ, T_WRITE) if ns == 'transfer' else (P_READ, P_WRITE)
        is_write = action not in reads
        if is_write and action not in writes:
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        if ns == 'pnl':
            eff = set(perms)
            if has('pnl.admin'):
                eff.add('pnl.write')
            if action in P_ADMIN and not has('pnl.admin'):
                return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
            ok_ = ('*' in eff or 'pnl.write' in eff) if is_write else ('*' in eff or 'pnl.write' in eff or 'pnl.read' in eff)
        else:
            ok_ = has('transfer.write')
        if not ok_:
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        if ns == 'transfer' and action == 'adminUpdate' and payload.get('op') not in ('memoryEdit', 'memoryDelete'):
            return 200, {'ok': False, 'error': 'OP_FORBIDDEN', 'code': 'OP_FORBIDDEN'}
        self.ns_calls.append((ns, action, payload, who))
        # 上游回傳形狀：{ok:true,data:X}；殼 transformResponse_ 會包成 data.data
        if ns == 'pnl' and action == 'getSettings':
            return 200, {'ok': True, 'data': {'stores': [{'store_id': c, 'name': n} for c, n in self.ds['stores']]}}
        if ns == 'pnl' and action == 'getMonth':
            n = self.ds['pending'].get(payload.get('store_id'), 0)
            return 200, {'ok': True, 'data': {'result': {'pending': [{'k': i} for i in range(n)]}}}
        if action == 'getDoc' and payload.get('no') == 'MISSING':
            return 200, {'ok': False, 'error': 'NOT_FOUND', 'code': 'NOT_FOUND'}
        return 200, {'ok': True, 'data': {'echo': action, 'payload': payload, 'operator': '%s（%s）（管理系統）' % (u['user']['name'], who)}}


def main():
    os.makedirs(ART, exist_ok=True)
    ds = make_dataset()
    print('資料集：貨單分頁 %s；張數 %s；損益門市 %s 待補 %s' % ([t for t, _ in ds['purchase_tabs']], ds['counts'], [c for c, _ in ds['stores']], ds['pending']))
    httpd, base = start_server(PORT)
    mock = MockEmbeds(base, ds)
    mk = lambda name, perms: {'password': 'dd-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
    USERS['finall'] = mk('財務全權', ['platform.self', 'platform.purchase', 'cashbook.write', 'transfer.write', 'pnl.write'])
    USERS['pnlread'] = mk('只看損益', ['platform.self', 'pnl.read'])
    USERS['pnladm'] = mk('損益管理', ['platform.self', 'pnl.admin'])
    USERS['nofin'] = mk('同仁乙', ['platform.self', 'audit.read.own'])
    external, stray = [], []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def site_route(route):
                u = urlparse(route.request.url)
                route.fulfill(response=route.fetch(url=base + (u.path or '/') + (('?' + u.query) if u.query else '')))

            def child(kind, path_ok):
                def h(route):
                    u = urlparse(route.request.url)
                    if u.path == path_ok:
                        route.fulfill(status=200, content_type='text/html; charset=utf-8', body=child_html(kind, SITE, ds))
                    else:
                        stray.append(route.request.url)
                        route.fulfill(status=404, content_type='text/plain', body='nf')
                return h

            def counts_route(route):
                body = json.loads(route.request.post_data or '{}')
                mock.counts_hits.append(body)
                if body.get('ticket') != ds['ticket']:
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'ok': False, 'error': 'ticket_invalid'}))
                    return
                route.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps({'ok': True, 'data': ds['counts']}))

            def new_page(query=''):
                ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
                pg = ctx.new_page()
                mock.install(pg)
                pg.route(SITE + '/**', site_route)
                pg.route(PURCHASE_ORIGIN + '/**', child('purchase', '/dzy-purchase/review.html'))
                pg.route(TRANSFER_ORIGIN + '/**', child('transfer', '/mala-transfer/report.html'))
                pg.route(PNL_ORIGIN + '/**', child('pnl', '/'))
                pg.route(PURCHASE_API + '/sso/counts', counts_route)
                pg.on('request', lambda req: external.append(req.url) if EXTERNAL.match(req.url) else None)
                pg.goto(SITE + '/index.html' + query)
                return pg

            def do_login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"], [data-keep]', state='attached', timeout=10000)

            def frame_of(pg, origin_prefix):
                for _ in range(100):
                    for f in pg.frames:
                        if f.url.startswith(origin_prefix):
                            return f
                    pg.wait_for_timeout(100)
                return None

            def tabs(pg):
                return pg.locator('[data-role="view-nav"] .nav-item').evaluate_all("els => els.map(e => ({id: e.getAttribute('data-view'), name: e.querySelector('span') ? e.querySelector('span').textContent : e.textContent, badge: e.querySelector('.badge') ? e.querySelector('.badge').textContent : ''}))")

            def wait_home_loaded(pg, mod):
                pg.wait_for_function("(m) => { const b = document.querySelector('[data-role=alert-list][data-module=' + m + ']'); return b && !b.textContent.includes('讀取中'); }", arg=mod, timeout=12000)

            def alert_lines(pg, mod):
                return [t.strip().rstrip('›').strip() for t in pg.locator('[data-role="alert-list"][data-module="%s"] [data-role="alert-row"]' % mod).all_inner_texts()]

            # ====== ① 非財務同仁 ======
            nf = new_page()
            do_login(nf, 'nofin')
            ids = [c.get_attribute('data-module') for c in nf.locator('[data-role="module-card"]').all()]
            check(not ({'purchase', 'transfer-fin', 'pnl', 'cashbook'} & set(ids)), '非財務同仁：首頁沒有財務四模組：%s' % ids)
            for mod, view in (('purchase', 'main'), ('transfer-fin', 'report'), ('pnl', 'dashboard')):
                nf.goto(SITE + '/index.html#/%s/%s' % (mod, view))
                nf.wait_for_timeout(600)
                check(nf.locator('iframe').count() == 0, '非財務同仁硬輸入 #/%s/%s：沒有 iframe' % (mod, view))
            check(not mock.sso_calls and not any(c[0] in ('transfer', 'pnl') for c in getattr(mock, 'proxy_calls', [])), '非財務同仁沒換券、沒打 transfer／pnl 代轉')
            nf.context.close()

            # ====== ② 財務全權：首頁提醒（貨單張數、損益待補）======
            pg = new_page()
            do_login(pg, 'finall')
            wait_home_loaded(pg, 'purchase')
            wait_home_loaded(pg, 'pnl')
            wait_home_loaded(pg, 'transfer-fin')
            want_p = []
            if ds['counts']['review'] > 0:
                want_p.append('貨單待核對 %d 張' % ds['counts']['review'])
            if ds['counts']['failed'] > 0:
                want_p.append('貨單辨識失敗 %d 張' % ds['counts']['failed'])
            got_p = alert_lines(pg, 'purchase')
            ptxt = pg.locator('[data-role="alert-list"][data-module="purchase"]').inner_text()
            check(got_p == want_p if want_p else '沒有待辦' in ptxt, '貨單核對首頁提醒 預期 %s 實際 %s' % (want_p or '沒有待辦', got_p or ptxt))
            badge = pg.locator('[data-role="badge"][data-module="purchase"]').inner_text()
            check(badge == (str(ds['counts']['review']) if ds['counts']['review'] > 0 else ''), '貨單核對卡片件數＝待核對張數（0 不顯示）：%r' % badge)
            check(len(mock.counts_hits) == 1 and mock.counts_hits[0] == {'ticket': ds['ticket']} and len([c for c in mock.sso_calls if c[0] == 'finall']) == 1, 'badge 與 alerts 共用一張券、/sso/counts 只打一次且只帶 ticket：%s' % mock.counts_hits)
            m_num = int(pg.evaluate("() => new Date(Date.now() + 8*3600*1000).getUTCMonth() + 1"))
            want_pnl = ['%s %d 月損益還有 %d 項待補' % (n, m_num, ds['pending'][c]) for c, n in ds['stores'] if ds['pending'][c] > 0]
            got_pnl = alert_lines(pg, 'pnl')
            pnltxt = pg.locator('[data-role="alert-list"][data-module="pnl"]').inner_text()
            check(got_pnl == want_pnl if want_pnl else '沒有待辦' in pnltxt, '損益首頁提醒 預期 %s 實際 %s' % (want_pnl or '沒有待辦', got_pnl or pnltxt))
            gm = [c for c in mock.ns_calls if c[0] == 'pnl' and c[1] == 'getMonth']
            check(sorted(c[2].get('store_id') for c in gm) == sorted(c for c, _ in ds['stores']) and all(re.match(r'^\d{4}-\d{2}$', c[2].get('month', '')) for c in gm), '每家啟用門市各打一次 getMonth{store_id,month}')
            ttxt = pg.locator('[data-role="alert-list"][data-module="transfer-fin"]').inner_text()
            check('調撥' in ttxt or '沒有待辦' in ttxt, '調撥管理沒有 alerts()：首頁顯示說明或沒有待辦：%s' % ttxt.strip()[:30])
            pg.screenshot(path=os.path.join(ART, 'embeds-home.png'))
            # 點提醒列 → 目的地
            if want_pnl:
                tgt = next(c for c, _ in ds['stores'] if ds['pending'][c] > 0)
                pg.locator('[data-role="alert-list"][data-module="pnl"] [data-role="alert-row"]').first.click()
                pg.wait_for_selector('[data-keep="pnl"] iframe', timeout=10000)
                check(pg.evaluate('location.hash') == '#/pnl/pending?store=%s' % tgt, '點損益提醒 → #/pnl/pending?store=%s：%s' % (tgt, pg.evaluate('location.hash')))
                pg.goto(SITE + '/index.html#/home')
                wait_home_loaded(pg, 'purchase')
            pre_tab = None   # 點過提醒就已掛載（keepAlive），之後從側欄進來會停在那個分頁
            if want_p:
                pg.locator('[data-role="alert-list"][data-module="purchase"] [data-role="alert-row"]').first.click()
                pg.wait_for_selector('[data-keep="purchase"] iframe', timeout=10000)
                tab_want = 'review' if ds['counts']['review'] > 0 else 'failed'
                check(pg.evaluate('location.hash') == '#/purchase/%s' % tab_want, '點貨單提醒 → #/purchase/%s：%s' % (tab_want, pg.evaluate('location.hash')))
                pre_tab = tab_want if tab_want in [t for t, _ in ds['purchase_tabs']] else ds['purchase_tabs'][0][0]
                pg.goto(SITE + '/index.html#/home')
                pg.wait_for_selector('[data-role="module-card"]', timeout=10000)

            # ====== ③ 貨單核對：握手、券、動態分頁 ======
            n_sso = len(mock.sso_calls)
            pg.click('[data-role="nav-desktop"] [data-nav="purchase"]')
            pg.wait_for_selector('[data-keep="purchase"] iframe[data-role="purchase-frame"]', timeout=10000)
            fr = frame_of(pg, PURCHASE_ORIGIN + '/dzy-purchase/review.html')
            check(fr is not None and fr.url == PURCHASE_ORIGIN + '/dzy-purchase/review.html?embed=dzy', 'iframe 開正式網址 review.html?embed=dzy：%s' % (fr and fr.url))
            fr.wait_for_function('() => !!window.__ticket', timeout=10000)
            check(fr.evaluate('window.__ticket') == ds['ticket'], '子頁收到 dzy-purchase-sso 入場券（由平台 ssoTicket 換來）')
            # 若剛才點提醒已掛載過模組（keepAlive），這次不會再換券；兩種情況都要：每一次 ssoTicket 都只帶 {aud:purchase}
            check(len(mock.sso_calls) >= 2 and all(c == ('finall', {'aud': 'purchase'}) for c in mock.sso_calls), 'ssoTicket（首頁張數＋嵌入握手）每次只帶 {aud:purchase}：%s' % mock.sso_calls)
            check(not any('token' in json.dumps(g) and 'e2e-token' in json.dumps(g) for g in fr.evaluate('window.__got')), '登入 token 沒有流進子頁')
            pg.wait_for_function("(n) => document.querySelectorAll('[data-role=view-nav] .nav-item').length === n", arg=len(ds['purchase_tabs']), timeout=10000)
            got_tabs = tabs(pg)
            want_tabs = [{'id': t, 'name': l, 'badge': (str(min(ds['badges'][t], 999)) if ds['badges'][t] > 0 else '')} for t, l in ds['purchase_tabs']]
            check(got_tabs == want_tabs, '頁頂動態分頁＝子頁送的 %d 個（名稱、badge）：%s' % (len(want_tabs), got_tabs if got_tabs != want_tabs else 'OK'))
            check(any(g.get('type') == 'dzy-purchase-tabs' for g in fr.evaluate('window.__got')), '收到選單後回 dzy-purchase-tabs')
            first = pre_tab or ds['purchase_tabs'][0][0]
            pg.wait_for_function("(h) => location.hash === h", arg='#/purchase/%s' % first, timeout=5000)
            check(pg.evaluate('location.hash') == '#/purchase/%s' % first and fr.evaluate('window.__cur') == first, '第一次同步後網址＝#/purchase/%s（%s）：%s' % (first, '提醒帶入' if pre_tab else '子頁第一個分頁', pg.evaluate('location.hash')))
            bar_link = pg.locator('[data-keep="purchase"] .bulletin-bar a')
            check(bar_link.get_attribute('href') == PURCHASE_ORIGIN + '/dzy-purchase/review.html' and bar_link.get_attribute('target') == '_blank' and 'noopener' in bar_link.get_attribute('rel'), '「在新分頁開啟」連結指向獨立網址（不帶 embed）、target=_blank、noopener')
            # 每個分頁都點：子頁收到 go、網址跟著換
            order = ds['purchase_tabs'][1:] + ds['purchase_tabs'][:1]
            R.shuffle(order)
            bad = []
            for tid, label in order:
                pg.locator('[data-role="view-nav"] .nav-item[data-view="%s"]' % tid).click()
                try:
                    fr.wait_for_function("(t) => window.__cur === t", arg=tid, timeout=5000)
                    pg.wait_for_function("(h) => location.hash === h", arg='#/purchase/%s' % tid, timeout=5000)
                except Exception:
                    bad.append((tid, fr.evaluate('window.__cur'), pg.evaluate('location.hash')))
            check(not bad, '%d 個頁頂分頁各點一次：子頁收到 dzy-purchase-go、網址＝#/purchase/<id>' % len(order) + ('' if not bad else '，錯：%s' % bad))
            # 以網址進特定分頁：第一次同步以網址為準
            pick_tab = R.choice(ds['purchase_tabs'])[0]
            pg2 = new_page('#/purchase/%s' % pick_tab)
            do_login(pg2, 'finall') if pg2.locator('#login-username').count() else None
            pg2.wait_for_selector('[data-keep="purchase"] iframe', timeout=10000)
            fr2 = frame_of(pg2, PURCHASE_ORIGIN)
            fr2.wait_for_function("(t) => window.__cur === t", arg=pick_tab, timeout=10000)
            check(pg2.evaluate('location.hash') == '#/purchase/%s' % pick_tab, '帶網址進入 #/purchase/%s：子頁被帶到該分頁、網址不跳回第一頁' % pick_tab)
            pg2.context.close()
            pg.screenshot(path=os.path.join(ART, 'embeds-purchase.png'))

            # ====== ④ 調撥管理：三分頁、call 轉接、敏感欄位剝除、op 白名單 ======
            pg.click('[data-role="nav-desktop"] [data-nav="transfer-fin"]')
            pg.wait_for_selector('[data-keep="transfer-fin"] iframe[data-role="transfer-frame"]', timeout=10000)
            tfr = frame_of(pg, TRANSFER_ORIGIN + '/mala-transfer/report.html')
            check(tfr is not None and tfr.url == TRANSFER_ORIGIN + '/mala-transfer/report.html?embed=dzy', '調撥 iframe 正式網址 ?embed=dzy')
            tfr.wait_for_function("() => window.__nav === 'report'", timeout=10000)
            check([t['id'] for t in tabs(pg)] == ['report', 'memory', 'overview'] and [t['name'] for t in tabs(pg)] == ['月報', '品項記憶', '卡關總覽'], '調撥三分頁：%s' % tabs(pg))
            for tid in R.sample(['memory', 'overview', 'report'], 3):
                pg.locator('[data-role="view-nav"] .nav-item[data-view="%s"]' % tid).click()
                tfr.wait_for_function("(t) => window.__nav === t", arg=tid, timeout=5000)
            check(True, '調撥三個分頁各點一次，子頁都收到 dzy-transfer-nav')
            # 隨機 call：讀／寫／不在白名單／adminUpdate 各種 op，payload 混入敏感欄位
            bad = []
            n_calls = R.randint(6, 12)
            for i in range(n_calls):
                kind = R.choice(['read', 'write', 'badop', 'unknown', 'notfound'])
                action = {'read': R.choice(T_READ), 'write': 'buildMonthlyReport', 'badop': 'adminUpdate', 'unknown': R.choice(['wipeData', 'deleteConfig', 'login']), 'notfound': 'getDoc'}[kind]
                payload = {'ym': '2026-%02d' % R.randint(1, 12), 'n': R.randint(1, 99)}
                if kind == 'badop':
                    payload['op'] = R.choice(['wipeData', 'deleteConfig', 'reasonAdd', 'memoryEdit', 'memoryDelete'])
                if kind == 'notfound':
                    payload['no'] = 'MISSING'
                for k in R.sample(['pin_master', 'token', 'operator', 'action'], R.randint(0, 4)):
                    payload[k] = 'LEAK-' + k
                cid = 'c%d_%d' % (i, R.randint(1, 9999))
                before = len(mock.ns_calls)
                res = tfr.evaluate("([id, a, p]) => window.__call(id, a, p)", [cid, action, payload])
                clean = {k: v for k, v in payload.items() if k not in ('pin_master', 'token', 'operator', 'action')}
                if kind in ('read', 'write') or (kind == 'badop' and payload['op'] in ('memoryEdit', 'memoryDelete')):
                    want = {'ok': True, 'data': {'echo': action, 'payload': clean, 'operator': '財務全權（finall）（管理系統）'}}
                    good = res == want and len(mock.ns_calls) == before + 1
                elif kind == 'badop':
                    good = res == {'ok': False, 'error': 'OP_FORBIDDEN', 'code': 'OP_FORBIDDEN'} and len(mock.ns_calls) == before
                elif kind == 'unknown':
                    good = res == {'ok': False, 'error': '沒有權限'} and len(mock.ns_calls) == before
                else:
                    good = res == {'ok': False, 'error': 'NOT_FOUND', 'code': 'NOT_FOUND'}
                if not good:
                    bad.append((kind, action, payload, res))
            check(not bad, '調撥 %d 次隨機 call：讀寫放行且 payload 已剝除 pin_master／token／operator／action、非白名單 op → OP_FORBIDDEN、未知動作 → 沒有權限、上游錯誤帶 code' % n_calls + ('' if not bad else '，錯：%s' % bad[:2]))
            # 形狀不對的訊息被忽略（不回覆）
            n_got = tfr.evaluate('window.__got.length')
            tfr.evaluate("() => { window.__raw({type:'dzy-transfer-call', v:2, id:'x', action:'bootstrap'}); window.__raw({type:'dzy-transfer-call', v:1, id:'bad id', action:'bootstrap'}); window.__raw({type:'dzy-transfer-call', v:1, id:'ok1', action:'9bad'}); window.__raw({type:'dzy-transfer-call', v:1, id:'ok2', action:'bootstrap', payload:[1]}); }")
            pg.wait_for_timeout(600)
            check(tfr.evaluate('window.__got.length') == n_got, '版本錯／id 錯／action 錯／payload 是陣列：四則都被忽略、不回覆')
            pg.screenshot(path=os.path.join(ART, 'embeds-transfer.png'))

            # keepAlive：切到貨單再回來 iframe 不重載
            tfr.evaluate("() => { window.__mark = 'kept'; }")
            pg.click('[data-role="nav-desktop"] [data-nav="purchase"]')
            pg.wait_for_selector('[data-keep="purchase"]:not([hidden])', timeout=10000)
            pg.click('[data-role="nav-desktop"] [data-nav="transfer-fin"]')
            pg.wait_for_selector('[data-keep="transfer-fin"]:not([hidden])', timeout=10000)
            tfr2 = frame_of(pg, TRANSFER_ORIGIN)
            check(tfr2.evaluate('window.__mark') == 'kept' and pg.locator('[data-keep="transfer-fin"] iframe').count() == 1, '切走再回來：調撥 iframe 沒重載（keepAlive）、只有一個 iframe')

            # ====== ⑤ 損益系統（填級）：八分頁、call、at 同步、管級動作被平台擋 ======
            pg.click('[data-role="nav-desktop"] [data-nav="pnl"]')
            pg.wait_for_selector('[data-keep="pnl"] iframe[data-role="pnl-frame"]', timeout=10000)
            pfr = frame_of(pg, PNL_ORIGIN + '/')
            check(pfr is not None and pfr.url == PNL_ORIGIN + '/?embed=dzy', '損益 iframe 正式網址 /?embed=dzy：%s' % (pfr and pfr.url))
            pfr.wait_for_function("() => !!window.__nav", timeout=10000)
            cur_view = pg.evaluate('location.hash').split('/')[2].split('?')[0]
            check(pfr.evaluate('window.__nav') == cur_view, '損益子頁收到的 nav＝目前分頁 %s（剛才若由提醒進過 pending，keepAlive 會停在那裡）' % cur_view)
            check([t['id'] for t in tabs(pg)] == [t for t, _ in PNL_TABS[:8]], '填級（pnl.write）：八個分頁、沒有「設定」：%s' % [t['id'] for t in tabs(pg)])
            for tid, _ in R.sample(PNL_TABS[:8], 8):
                pg.locator('[data-role="view-nav"] .nav-item[data-view="%s"]' % tid).click()
                pfr.wait_for_function("(t) => window.__nav === t", arg=tid, timeout=5000)
            check(True, '損益八個分頁各點一次，子頁收到 dzy-pnl-nav')
            # 子頁自己切頁（dzy-pnl-at）→ 頁頂跟著換；不認得的頁名不理
            at = R.choice([t for t, _ in PNL_TABS[:8]])
            pfr.evaluate("(p) => window.__raw({type:'dzy-pnl-at', v:1, p})", at)
            pg.wait_for_function("(h) => location.hash === h", arg='#/pnl/%s' % at, timeout=5000)
            check(pg.locator('[data-role="view-nav"] .nav-item.is-active').get_attribute('data-view') == at, '子頁送 dzy-pnl-at %s → 頁頂與網址跟著換' % at)
            pfr.evaluate("() => window.__raw({type:'dzy-pnl-at', v:1, p:'login'})")
            pg.wait_for_timeout(300)
            check(pg.evaluate('location.hash') == '#/pnl/%s' % at, '不認得的頁名 login：網址不變')
            bad = []
            n_calls = R.randint(6, 12)
            for i in range(n_calls):
                kind = R.choice(['read', 'write', 'admin', 'unknown'])
                action = {'read': R.choice([a for a in P_READ if a not in ('getMonth', 'getSettings')]), 'write': R.choice([a for a in P_WRITE if a not in P_ADMIN]), 'admin': R.choice(P_ADMIN), 'unknown': R.choice(['login', 'createInvite', 'dzyProxy', 'changeMyPasscode'])}[kind]   # getMonth／getSettings 的 mock 另有固定形狀（首頁提醒用）
                body = {'store_id': R.choice(ds['stores'])[0], 'month': '2026-%02d' % R.randint(1, 12)}
                for k in R.sample(['key', 'token', 'operator', 'level', 'inner', 'action'], R.randint(0, 6)):
                    body[k] = 'LEAK-' + k
                cid = 'p%d_%d' % (i, R.randint(1, 9999))
                before = len(mock.ns_calls)
                n_got = pfr.evaluate('window.__got.length')
                res = pfr.evaluate("([id, a, b]) => window.__call(id, a, b)", [cid, action, body])
                clean = {k: v for k, v in body.items() if k not in ('key', 'token', 'operator', 'level', 'inner', 'action')}
                if kind in ('read', 'write'):
                    good = res == {'ok': True, 'data': {'echo': action, 'payload': clean, 'operator': '財務全權（finall）（管理系統）'}} and len(mock.ns_calls) == before + 1
                elif kind == 'admin':
                    good = res == {'ok': False, 'error': 'BUSY', 'message': '沒有權限'} and len(mock.ns_calls) == before
                else:
                    good = res == {'timeout': True} and len(mock.ns_calls) == before and pfr.evaluate('window.__got.length') == n_got
                if not good:
                    bad.append((kind, action, body, res))
            check(not bad, '損益 %d 次隨機 call（填級）：讀寫放行且剝除 key／token／operator／level／inner／action；管級動作被平台 403 → BUSY；白名單外的 login／createInvite 直接忽略' % n_calls + ('' if not bad else '，錯：%s' % bad[:2]))
            pg.screenshot(path=os.path.join(ART, 'embeds-pnl.png'))
            pg.context.close()

            # ====== ⑥ 看級／管級 ======
            rd = new_page()
            do_login(rd, 'pnlread')
            ids = [c.get_attribute('data-module') for c in rd.locator('[data-role="module-card"]').all()]
            check({'purchase', 'cashbook', 'transfer-fin', 'pnl'} & set(ids) == {'pnl'}, '只有 pnl.read：財務四模組只看得到損益系統：%s' % ids)
            wait_home_loaded(rd, 'pnl')
            check('沒有待辦' in rd.locator('[data-role="alert-list"][data-module="pnl"]').inner_text() and not [c for c in mock.ns_calls if c[3] == 'pnlread'], '看級：首頁提醒不算待補（沒打 getMonth）')
            rd.click('[data-role="nav-desktop"] [data-nav="pnl"]')
            rd.wait_for_selector('[data-keep="pnl"] iframe', timeout=10000)
            check([t['id'] for t in tabs(rd)] == ['dashboard'], '看級：只剩儀表板分頁：%s' % [t['id'] for t in tabs(rd)])
            rfr = frame_of(rd, PNL_ORIGIN)
            rfr.wait_for_function("() => window.__nav === 'dashboard'", timeout=10000)
            res = rfr.evaluate("() => window.__call('r1', 'getMonth', {store_id:'gf', month:'2026-09'})")
            check(res.get('ok') is True, '看級：getMonth（讀）放行：%s' % res)
            res = rfr.evaluate("() => window.__call('r2', 'addEntry', {store_id:'gf'})")
            check(res == {'ok': False, 'error': 'BUSY', 'message': '沒有權限'}, '看級：addEntry（寫）被代轉 403：%s' % res)
            rd.goto(SITE + '/index.html#/pnl/settings')
            rd.wait_for_timeout(800)
            check(rd.evaluate('location.hash') != '#/pnl/settings', '看級硬輸入 #/pnl/settings：不停在設定分頁：%s' % rd.evaluate('location.hash'))
            rd.context.close()

            am = new_page()
            do_login(am, 'pnladm')
            am.click('[data-role="nav-desktop"] [data-nav="pnl"]')
            am.wait_for_selector('[data-keep="pnl"] iframe', timeout=10000)
            check([t['id'] for t in tabs(am)] == [t for t, _ in PNL_TABS], '管級（pnl.admin）：九個分頁含設定：%s' % [t['id'] for t in tabs(am)])
            afr = frame_of(am, PNL_ORIGIN)
            afr.wait_for_function("() => window.__nav === 'dashboard'", timeout=10000)
            adm_action = R.choice(P_ADMIN)
            res = afr.evaluate("(a) => window.__call('a1', a, {store_id:'gf'})", adm_action)
            check(res.get('ok') is True and res['data']['echo'] == adm_action, '管級：%s 放行：%s' % (adm_action, res))
            am.locator('[data-role="view-nav"] .nav-item[data-view="settings"]').click()
            afr.wait_for_function("() => window.__nav === 'settings'", timeout=5000)
            check(am.evaluate('location.hash') == '#/pnl/settings', '管級：設定分頁點得到')
            am.context.close()

            # ====== ⑦ 試跑模式：寫入全攔、讀取照常、嵌入警語 ======
            dr = new_page('?dryrun=1')
            do_login(dr, 'finall')
            dr.click('[data-role="nav-desktop"] [data-nav="purchase"]')
            dr.wait_for_selector('[data-keep="purchase"] iframe', timeout=10000)
            check(dr.locator('[data-keep="purchase"] [data-role="dryrun-embed-warn"]').count() == 1 and '真的寫入' in dr.locator('[data-keep="purchase"] [data-role="dryrun-embed-warn"]').inner_text(), '試跑模式：貨單核對 iframe 上方有「子系統會真的寫入」警語')
            dfr = frame_of(dr, PURCHASE_ORIGIN)
            dfr.wait_for_function('() => !!window.__ticket', timeout=10000)
            check(dfr.evaluate('window.__ticket') == ds['ticket'], '試跑模式：仍能換券自動登入（ssoTicket 是讀取）')
            n_w = len([c for c in mock.ns_calls if c[1] in T_WRITE + P_WRITE])
            dr.click('[data-role="nav-desktop"] [data-nav="transfer-fin"]')
            dr.wait_for_selector('[data-keep="transfer-fin"] iframe', timeout=10000)
            dtf = frame_of(dr, TRANSFER_ORIGIN)
            dtf.wait_for_function("() => window.__nav === 'report'", timeout=10000)
            check(dr.locator('[data-keep="transfer-fin"] [data-role="dryrun-embed-warn"]').count() == 0, '（觀察）調撥管理在試跑模式沒有嵌入警語（寫入由殼攔住，與貨單不同）')
            r1 = dtf.evaluate("() => window.__call('d1', 'adminData', {})")
            r2 = dtf.evaluate("() => window.__call('d2', 'buildMonthlyReport', {ym:'2026-09'})")
            r3 = dtf.evaluate("() => window.__call('d3', 'adminUpdate', {op:'memoryEdit'})")
            check(r1.get('ok') is True and r2 == {'ok': False, 'error': '試跑模式，未寫入', 'code': 'DRYRUN'} and r3 == {'ok': False, 'error': '試跑模式，未寫入', 'code': 'DRYRUN'}, '試跑：調撥讀取照常、buildMonthlyReport／adminUpdate 回 DRYRUN：%s' % [r2, r3])
            dr.click('[data-role="nav-desktop"] [data-nav="pnl"]')
            dr.wait_for_selector('[data-keep="pnl"] iframe', timeout=10000)
            dpf = frame_of(dr, PNL_ORIGIN)
            dpf.wait_for_function("() => window.__nav === 'dashboard'", timeout=10000)
            wa = R.choice([a for a in P_WRITE if a not in P_ADMIN])
            r4 = dpf.evaluate("(a) => window.__call('d4', a, {store_id:'gf'})", wa)
            r5 = dpf.evaluate("() => window.__call('d5', 'getSettings', {})")
            check(r4 == {'ok': False, 'error': 'BAD_INPUT', 'message': '試跑模式，未寫入'} and r5.get('ok') is True, '試跑：損益 %s 回 BAD_INPUT 試跑、getSettings 照常：%s' % (wa, r4))
            check(len([c for c in mock.ns_calls if c[1] in T_WRITE + P_WRITE]) == n_w, '試跑模式：代轉一筆寫入都沒收到')
            dr.screenshot(path=os.path.join(ART, 'embeds-dryrun.png'))
            dr.context.close()

            browser.close()

        check(mock.sens_leaked == [], '代轉 payload 沒有 pin_master／token／operator／key／level／inner：%s' % mock.sens_leaked)
        check(mock.leaked == [], '沒有未被 mock 涵蓋的外部請求：%s' % mock.leaked)
        check(stray == [], '三個子站只取了預期的頁面：%s' % stray[:5])
        allowed = {urlparse(u).netloc for u in list(mock.urls.values()) + [SITE, PURCHASE_ORIGIN, TRANSFER_ORIGIN, PNL_ORIGIN, PURCHASE_API]}
        bad_ext = [u for u in external if urlparse(u).netloc not in allowed]
        check(not bad_ext, '所有非 127.0.0.1 請求都在別名／mock 主機清單內（regex 守門）：%s' % bad_ext[:5])
    finally:
        httpd.shutdown()
    print('E2E_SEED=%d' % SEED)
    finish()


if __name__ == '__main__':
    main()
