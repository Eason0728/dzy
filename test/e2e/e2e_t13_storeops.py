#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑬：門市營運／考勤管理（嵌入營運系統 iframe、入場券握手、考勤管理選單、return 導回）。

全程 mock：營運系統網址（https://dzy-bulletin.github.io/**）由假頁面取代——假頁面載好就 postMessage
{type:'dzy-store-ready', v:1} 給 parent，並把收到的訊息記在 window.__got；平台後端 ssoTicket 由 mock 回假券。
驗：握手只認正確 origin＋source、有／無 platform.att 時考勤管理選單出現／不出現、return 白名單（合格導回帶 #sso=、不合格忽略）、
未登入點 return 連結 → 先登入 → 再導回。契約：test/fixtures/dzy-store-contract-v2.json 的 postMessage 段。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SHOTS, USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8803
STORE = 'https://dzy-bulletin.github.io'
TICKET = 'c0ffee' + '0' * 58  # 64 位十六進位

FAKE_STORE = """<!doctype html><meta charset="utf-8"><title>fake store</title>
<script>
window.__got = [];
window.addEventListener('message', function (e) {
  window.__got.push({ origin: e.origin, data: e.data });
  if (window.parent !== window) window.parent.postMessage({ fakeStoreGot: e.data, origin: e.origin }, '*'); // 讓外層在 iframe 被移除後仍看得到
});
if (window.parent !== window) window.parent.postMessage({ type: 'dzy-store-ready', v: 1 }, '*');
</script><body>fake store %s</body>"""


class Mock13(MockBackend):
    def __init__(self, base):
        super().__init__(base)
        mk = lambda name, perms: {'password': 'e2e-pw', 'perms': perms,
                                  'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
        USERS['att1'] = mk('督導甲', ['platform.self', 'platform.att', 'platform.storeops'])
        USERS['plain1'] = mk('同仁乙', ['platform.self', 'platform.storeops'])
        USERS['none1'] = mk('同仁丙', ['platform.self'])  # 總開關關著／不屬於任何營運系統門市：兩個衍生權限都沒有
        self.sso_calls = []

    def platform_action(self, action, body):
        if action == 'ssoTicket':
            payload = body.get('payload') or {}
            self.sso_calls.append(payload)
            if payload.get('aud') != 'store':
                return {'ok': False, 'error': '不支援的系統'}
            return {'ok': True, 'data': {'ticket': TICKET, 'expires_in': 60}}
        return super().platform_action(action, body)


def main():
    httpd, base = start_server(PORT)
    mock = Mock13(base)
    store_hits = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page():
                pg = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
                mock.install(pg)

                def store_route(route):
                    store_hits.append(route.request.url)
                    route.fulfill(status=200, content_type='text/html; charset=utf-8', body=FAKE_STORE % 'x')
                pg.route(STORE + '/**', store_route)
                # 其他任何外部主機都不該被碰
                return pg

            def do_login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def store_frame(pg):
                for f in pg.frames:
                    if f.url.startswith(STORE + '/dzy-store/'):
                        return f
                return None

            # ① 有 platform.storeops 的一般同仁：看得到「門市營運」，看不到「考勤管理」
            pl = new_page()
            pl.goto(base + '/index.html')
            do_login(pl, 'plain1')
            ids = [c.get_attribute('data-module') for c in pl.locator('[data-role="module-card"]').all()]
            check('storeops' in ids and 'attendance' not in ids, '無 platform.att：首頁有門市營運、沒有考勤管理，實際：%s' % ids)
            check(pl.locator('[data-role="nav-desktop"] [data-nav="attendance"]').count() == 0, '無 platform.att：左側選單沒有「考勤管理」')
            check(pl.locator('[data-role="nav-desktop"] [data-nav="storeops"]').count() == 1, '左側選單有「門市營運」')

            # ①b 沒有 platform.storeops（總開關關著或不屬於任何營運系統門市）：兩個選單都不出現
            nn = new_page()
            nn.goto(base + '/index.html')
            do_login(nn, 'none1')
            ids = [c.get_attribute('data-module') for c in nn.locator('[data-role="module-card"]').all()]
            check('storeops' not in ids and 'attendance' not in ids, '無 platform.storeops：首頁沒有門市營運、考勤管理，實際：%s' % ids)
            check(nn.locator('[data-role="nav-desktop"] [data-nav="storeops"]').count() == 0, '無 platform.storeops：左側選單沒有「門市營運」')

            # ② 握手：假營運系統送 ready → 收到 sso 帶 ticket（targetOrigin 對得上才收得到）
            pl.click('[data-role="nav-desktop"] [data-nav="storeops"]')
            pl.wait_for_selector('iframe[data-role="store-frame"]')
            pl.wait_for_function("() => document.querySelector('iframe[data-role=\"store-frame\"]').contentWindow !== null")
            fr = None
            for _ in range(50):
                fr = store_frame(pl)
                if fr:
                    try:
                        if fr.evaluate("() => window.__got.length") >= 1:
                            break
                    except Exception:
                        pass
                pl.wait_for_timeout(100)
            check(fr is not None, '門市營運：iframe 載入營運系統網址（?embed=dzy）：%s' % [f.url for f in pl.frames])
            check(fr is not None and fr.url == STORE + '/dzy-store/?embed=dzy', 'iframe 網址正確：%s' % (fr.url if fr else None))
            got = fr.evaluate("() => window.__got") if fr else []
            check(len(got) == 1 and got[0]['data'] == {'type': 'dzy-store-sso', 'v': 1, 'ticket': TICKET},
                  '收到 {dzy-store-sso, v:1, ticket}：%s' % got)
            check(mock.sso_calls == [{'aud': 'store'}], '向平台換券的 payload 只有 aud=store：%s' % mock.sso_calls)

            # ③ 偽造的 ready（來自管理系統自己這一頁，origin 不對、source 不是 iframe）→ 不換券
            n0 = len(mock.sso_calls)
            pl.evaluate("() => window.postMessage({ type: 'dzy-store-ready', v: 1 }, '*')")
            pl.wait_for_timeout(600)
            check(len(mock.sso_calls) == n0, '來源不是營運系統 iframe 的 ready 不會換券')
            check(len(fr.evaluate("() => window.__got")) == 1, '也沒有多送 sso 訊息')

            # ③b 頁頂分頁（2026-10-20）：營運系統送選單 → 管理系統畫在頁頂、帶數字、回 dzy-store-tabs；點分頁送 dzy-store-go
            NAV = "(cur) => parent.postMessage({ type: 'dzy-store-nav', v: 1, cur: cur, items: [{ id: 'home', label: '首頁', badge: 0 }, { id: 'duty', label: '出勤核定', badge: 0 }, { id: 'inventory', label: '庫存盤點', badge: 33 }, { id: 'staffperm', label: '本店同仁權限', badge: 0 }, { id: 'BAD', label: '壞的' }] }, '*')"
            tabs_txt = lambda: pl.locator('[data-role="view-nav"] .nav-item').all_inner_texts()
            pl.evaluate("() => window.postMessage({ type: 'dzy-store-nav', v: 1, cur: 'home', items: [{ id: 'evil', label: '假的' }] }, '*')")
            pl.wait_for_timeout(400)
            check('假的' not in ''.join(tabs_txt()), '頁頂分頁：不是營運系統 iframe 送的選單不理：%s' % tabs_txt())
            fr.evaluate(NAV, 'home')
            pl.wait_for_function("() => document.querySelectorAll('[data-role=\"view-nav\"] .nav-item').length === 4")
            t = [x.replace('\n', '') for x in tabs_txt()]
            check(t == ['首頁', '出勤核定', '庫存盤點33', '本店同仁權限'], '頁頂分頁＝營運系統送來的選單（壞 id 丟掉）、庫存盤點帶數字 33：%s' % t)
            check(pl.locator('[data-role="view-nav"] .nav-item.is-active').inner_text() == '首頁' and pl.evaluate('location.hash') == '#/storeops/home', '目前分頁跟著營運系統（首頁），網址 #/storeops/home：%s' % pl.evaluate('location.hash'))
            got = fr.evaluate("() => window.__got.map(m => m.data)")
            check({'type': 'dzy-store-tabs', 'v': 1} in got, '收到選單後回 {dzy-store-tabs, v:1}，營運系統才藏自己的選單：%s' % got)
            n_go = lambda: len([m for m in fr.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go'])
            pl.locator('[data-role="view-nav"] .nav-item', has_text='庫存盤點').click()
            pl.wait_for_timeout(300)
            gos = [m for m in fr.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go']
            check(gos == [{'type': 'dzy-store-go', 'v': 1, 'id': 'inventory'}] and pl.evaluate('location.hash') == '#/storeops/inventory', '點頁頂「庫存盤點」→ 送 {dzy-store-go, id:inventory}、網址跟著變：%s' % gos)
            fr.evaluate(NAV, 'inventory')
            pl.wait_for_timeout(300)
            fr.evaluate(NAV, 'duty')      # 營運系統裡自己換頁（例如點了首頁待辦）
            pl.wait_for_function("() => location.hash === '#/storeops/duty'")
            pl.wait_for_timeout(300)
            check(pl.locator('[data-role="view-nav"] .nav-item.is-active').inner_text() == '出勤核定' and n_go() == 1, '營運系統自己換頁 → 頁頂亮起「出勤核定」、網址跟著，且不會回送 go（不打轉）')
            pl.screenshot(path=os.path.join(SHOTS, 'storeops-tabs-1280.png'))
            # 重新整理停在 #/storeops/duty：營運系統開機回報首頁 → 管理系統叫它切回出勤核定，網址不跳回首頁
            pl.reload()
            pl.wait_for_selector('iframe[data-role="store-frame"]')
            fr = None
            for _ in range(50):
                fr = store_frame(pl)
                if fr:
                    try:
                        if fr.evaluate("() => window.__got.length") >= 1:
                            break
                    except Exception:
                        pass
                pl.wait_for_timeout(100)
            fr.evaluate(NAV, 'home')
            pl.wait_for_timeout(500)
            gos = [m for m in fr.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go']
            check(gos == [{'type': 'dzy-store-go', 'v': 1, 'id': 'duty'}] and pl.evaluate('location.hash') == '#/storeops/duty', '重新整理在出勤核定：營運系統先回報首頁時，管理系統叫它切回出勤核定、網址不變：%s %s' % (gos, pl.evaluate('location.hash')))

            # ④ 登出（卸載）→ iframe 收到 dzy-store-logout：切到首頁前先用 evaluate 掛一個旁路記錄
            pl.evaluate("() => { window.__fromStore = []; window.addEventListener('message', (e) => { if (e.data && e.data.fakeStoreGot) window.__fromStore.push(e.data); }); }")
            pl.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            pl.wait_for_selector('[data-role="module-card"]')
            pl.wait_for_timeout(500)
            sent = pl.evaluate("() => window.__fromStore")
            check(sent == [{'fakeStoreGot': {'type': 'dzy-store-logout', 'v': 1}, 'origin': 'http://127.0.0.1:%d' % PORT}],
                  '離開模組時 iframe 收到 dzy-store-logout（targetOrigin 寫死營運系統，收得到代表 iframe 還在、訊息送達）：%s' % sent)

            # ⑤ 有 platform.att：考勤管理出現、iframe 帶 &only=duty、也能握手
            at = new_page()
            at.goto(base + '/index.html')
            do_login(at, 'att1')
            ids = [c.get_attribute('data-module') for c in at.locator('[data-role="module-card"]').all()]
            check('attendance' in ids and 'storeops' in ids, '有 platform.att：首頁有考勤管理與門市營運，實際：%s' % ids)
            check(at.locator('[data-role="nav-desktop"] [data-nav="attendance"]').count() == 1, '有 platform.att：左側選單有「考勤管理」')
            before = len(mock.sso_calls)
            at.click('[data-role="nav-desktop"] [data-nav="attendance"]')
            at.wait_for_selector('iframe[data-role="store-frame"]')
            fa = None
            for _ in range(50):
                fa = store_frame(at)
                if fa:
                    try:
                        if fa.evaluate("() => window.__got.length") >= 1:
                            break
                    except Exception:
                        pass
                at.wait_for_timeout(100)
            check(fa is not None and fa.url == STORE + '/dzy-store/?embed=dzy&only=duty', '考勤管理 iframe 網址帶 &only=duty：%s' % (fa.url if fa else None))
            ga = fa.evaluate("() => window.__got") if fa else []
            check(len(ga) == 1 and ga[0]['data']['type'] == 'dzy-store-sso' and ga[0]['data']['ticket'] == TICKET and len(mock.sso_calls) == before + 1, '考勤管理握手拿到券：%s' % ga)
            # ⑤b 考勤管理頁頂分頁（2026-10-20）：出勤核定子分頁（核定工時／申請審核帶數字）畫在頁頂、點了送 go、重新整理停在原分頁
            DNAV = "(cur) => parent.postMessage({ type: 'dzy-store-nav', v: 1, cur: cur, items: [{ id: 'approve', label: '核定工時', badge: 0 }, { id: 'request', label: '申請審核', badge: 3 }] }, '*')"
            atabs = lambda: [x.replace('\n', '') for x in at.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            fa.evaluate(DNAV, 'approve')
            at.wait_for_function("() => document.querySelectorAll('[data-role=\"view-nav\"] .nav-item').length === 2")
            check(atabs() == ['核定工時', '申請審核3'] and at.evaluate('location.hash') == '#/attendance/approve', '考勤管理頁頂＝出勤核定子分頁、申請審核帶數字 3、網址 #/attendance/approve：%s %s' % (atabs(), at.evaluate('location.hash')))
            check({'type': 'dzy-store-tabs', 'v': 1} in fa.evaluate("() => window.__got.map(m => m.data)"), '考勤管理：收到選單後回 dzy-store-tabs')
            at.locator('[data-role="view-nav"] .nav-item', has_text='申請審核').click()
            at.wait_for_timeout(300)
            agos = [m for m in fa.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go']
            check(agos == [{'type': 'dzy-store-go', 'v': 1, 'id': 'request'}] and at.evaluate('location.hash') == '#/attendance/request', '點頁頂「申請審核」→ 送 {dzy-store-go, id:request}、網址跟著變：%s' % agos)
            fa.evaluate(DNAV, 'request')
            at.wait_for_timeout(300)
            at.screenshot(path=os.path.join(SHOTS, 'attendance-tabs-1280.png'))
            at.set_viewport_size({'width': 390, 'height': 844})
            at.wait_for_timeout(300)
            check(at.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1") and all(at.locator('[data-role="view-nav"] .nav-item').nth(i).is_visible() for i in range(2)), '手機 390 寬：考勤管理兩個頁頂分頁都看得到、沒有橫向捲動')
            at.screenshot(path=os.path.join(SHOTS, 'attendance-tabs-390.png'))
            at.set_viewport_size({'width': 1280, 'height': 800})
            at.reload()
            at.wait_for_selector('iframe[data-role="store-frame"]')
            fa = None
            for _ in range(50):
                fa = store_frame(at)
                if fa:
                    try:
                        if fa.evaluate("() => window.__got.length") >= 1:
                            break
                    except Exception:
                        pass
                at.wait_for_timeout(100)
            fa.evaluate(DNAV, 'approve')
            at.wait_for_timeout(500)
            agos = [m for m in fa.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go']
            check(agos == [{'type': 'dzy-store-go', 'v': 1, 'id': 'request'}] and at.evaluate('location.hash') == '#/attendance/request', '重新整理在申請審核：出勤核定先回報核定工時時，管理系統叫它切回申請審核、網址不變：%s %s' % (agos, at.evaluate('location.hash')))

            # ⑥ 管理員兩個都看得到
            ad = new_page()
            ad.goto(base + '/index.html')
            do_login(ad, 'admin')
            check(ad.locator('[data-role="nav-desktop"] [data-nav="attendance"]').count() == 1 and ad.locator('[data-role="nav-desktop"] [data-nav="storeops"]').count() == 1,
                  'admin 兩個選單都有')

            # ⑦ return 白名單：已登入、合格 → 導回並帶 #sso=
            rt = new_page()
            rt.goto(base + '/index.html')
            do_login(rt, 'plain1')
            good = STORE + '/dzy-store/?from=login'
            rt.goto(base + '/index.html#/storeops?return=' + __import__('urllib.parse').parse.quote(good, safe=''))
            rt.wait_for_url(good + '#sso=' + TICKET, timeout=10000)
            check(rt.url == good + '#sso=' + TICKET, '合格 return：導回營運系統並帶 #sso=券：%s' % rt.url)

            # ⑧ return 不合格：忽略、顯示正常模組（iframe），沒有導走
            bad_list = ['https://evil.example/dzy-store/', 'https://dzy-bulletin.github.io.evil.example/dzy-store/',
                        'https://dzy-bulletin.github.io@evil.example/dzy-store/', 'javascript:alert(1)', 'http://localhost:80@evil.example/']
            bd = new_page()
            bd.goto(base + '/index.html')
            do_login(bd, 'plain1')
            for bad in bad_list:
                n = len(mock.sso_calls)
                bd.goto(base + '/index.html#/storeops?return=' + __import__('urllib.parse').parse.quote(bad, safe=''))
                bd.wait_for_selector('iframe[data-role="store-frame"]', timeout=8000)
                bd.wait_for_timeout(300)
                check(bd.url.startswith(base + '/index.html#/storeops'), '不合格 return 不導走：%s → %s' % (bad, bd.url))
                check(bd.locator('iframe[data-role="store-frame"]').count() == 1, '不合格 return：顯示正常模組：%s' % bad)
                # 正常模組的握手會換一次券；return 流程不會再多換
                check(len(mock.sso_calls) - n <= 1, '不合格 return 沒有走導回換券：%s' % bad)
            check(not any('evil.example' in h for h in store_hits), '沒有請求送到 evil.example')

            # ⑨ 未登入先走登入，登入後回到這個路由並導回
            nl = new_page()
            nl.goto(base + '/index.html#/storeops?return=' + __import__('urllib.parse').parse.quote(STORE + '/dzy-store/?s=gf', safe=''))
            nl.wait_for_selector('#login-username')
            check(store_frame(nl) is None and nl.locator('[data-role="module-card"]').count() == 0, '未登入：只看到登入頁，不會直接導走')
            nl.fill('#login-username', 'plain1')
            nl.fill('#login-password', USERS['plain1']['password'])
            nl.click('[data-role="submit"]')
            nl.wait_for_url(STORE + '/dzy-store/?s=gf#sso=' + TICKET, timeout=10000)
            check(True, '登入後導回營運系統並帶 #sso=券：%s' % nl.url)

            check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
