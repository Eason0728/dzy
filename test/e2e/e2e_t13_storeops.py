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
  try { console.log('FAKESTORE ' + JSON.stringify(e.data)); } catch (x) {}
  if (window.parent !== window) window.parent.postMessage({ fakeStoreGot: e.data, origin: e.origin }, '*'); // 讓外層在 iframe 被移除後仍看得到
});
if (window.parent !== window) window.parent.postMessage({ type: 'dzy-store-ready', v: 1 }, '*');
</script><body>fake store %s</body>"""


class Mock13(MockBackend):
    def __init__(self, base):
        super().__init__(base)
        mk = lambda name, perms: {'password': 'e2e-pw', 'perms': perms,
                                  'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
        USERS['att1'] = mk('督導甲', ['platform.self', 'platform.att', 'platform.sched', 'platform.storeops'])   # 店長同等職：考勤管理＋排班管理
        USERS['att2'] = mk('督導乙', ['platform.self', 'platform.att', 'platform.storeops'])   # 區督導／總監類：有考勤管理、沒有排班管理（2026-10-24）
        USERS['plain1'] = mk('同仁乙', ['platform.self', 'platform.storeops'])
        USERS['none1'] = mk('同仁丙', ['platform.self'])  # 總開關關著／不屬於任何營運系統門市：兩個衍生權限都沒有
        self.sso_calls = []
        # 排班管理首頁待辦（hr-move-spec §5）：預設兩列（光復店 T01、T02／美村店 T01）
        self.sched_alerts = {'ok': True, 'data': {'items': [{'code': 'gf', 'name': '光復店', 'periods': ['T01', 'T02']}, {'code': 'mc', 'name': '美村店', 'periods': ['T01']}], 'asOf': '2026-10-24T00:00:00Z'}}
        # 考勤管理首頁待辦（spec §17.5）：預設三列（核定 3 天／申請 2 筆／新手機 1 支）
        self.att_alerts = {'ok': True, 'data': {'items': [{'kind': 'approve', 'count': 3}, {'kind': 'request', 'count': 2}, {'kind': 'device', 'count': 1}], 'partial': False, 'asOf': '2026-10-24T00:00:00Z', 'pending': False}}

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

            # ④ 切走保留 30 分鐘（2026-10-20 Eason）：離開模組不登出、iframe 還在；點回來是同一個頁面（不重載、不重新換券）；
            #    登出管理系統時，保留中的頁面一起卸載、收到 dzy-store-logout
            store_log = []
            pl.on('console', lambda m: store_log.append(m.text) if m.text.startswith('FAKESTORE ') else None)
            n_sso = len(mock.sso_calls)
            n_hits = len(store_hits)
            pl.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            pl.wait_for_selector('[data-role="module-card"]')
            pl.wait_for_timeout(500)
            check(not any('dzy-store-logout' in x for x in store_log), '切走（回首頁）不登出營運系統：%s' % store_log)
            check(pl.locator('[data-keep="storeops"] iframe[data-role="store-frame"]').count() == 1 and not pl.locator('[data-keep="storeops"]').is_visible(),
                  '切走後營運系統的頁面還在、只是藏起來')
            check(pl.locator('[data-role="view-nav"] .nav-item').count() == 0, '首頁不顯示門市營運的頁頂分頁')
            fr.evaluate("() => { window.__mark = 'still-here'; }")
            pl.click('[data-role="nav-desktop"] [data-nav="storeops"]')
            pl.wait_for_selector('[data-keep="storeops"]:not([hidden])')
            pl.wait_for_timeout(400)
            fr_back = store_frame(pl)
            check(fr_back is not None and fr_back.evaluate("() => window.__mark") == 'still-here' and len(mock.sso_calls) == n_sso and len(store_hits) == n_hits,
                  '點回來是同一個頁面：沒有重新載入、沒有重新換券（sso %d→%d、載入 %d→%d）' % (n_sso, len(mock.sso_calls), n_hits, len(store_hits)))
            check(pl.locator('[data-role="view-nav"] .nav-item').count() == 4 and pl.evaluate('location.hash') == '#/storeops/duty'
                  and pl.locator('[data-role="view-nav"] .nav-item.is-active').inner_text() == '出勤核定',
                  '從左側點回來：頁頂分頁還在、停在上次的「出勤核定」（網址 %s）' % pl.evaluate('location.hash'))
            check(not any('"id":"main"' in x for x in store_log), '點回來不會叫營運系統切去不存在的分頁：%s' % store_log)
            # 背景收到營運系統換頁訊息不可以把人拉回來
            pl.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            pl.wait_for_selector('[data-role="module-card"]')
            fr_back.evaluate(NAV, 'inventory')
            pl.wait_for_timeout(500)
            check(pl.locator('[data-role="module-card"]').count() > 0 and not pl.evaluate('location.hash').startswith('#/storeops'), '保留中的營運系統在背景換頁，不會把人從首頁拉回去：%s' % pl.evaluate('location.hash'))
            # 登出管理系統（此時門市營運是保留中）→ 一起卸載、營運系統收到登出
            pl.click('[data-nav="__logout__"]')
            pl.wait_for_selector('#login-username', timeout=15000)
            pl.wait_for_timeout(300)
            check(any('"type":"dzy-store-logout"' in x for x in store_log), '登出管理系統時，保留中的營運系統收到 dzy-store-logout：%s' % store_log[-3:])

            # ⑤ 有 platform.att：考勤管理出現、iframe 帶 &only=duty、也能握手
            at = new_page()
            at.goto(base + '/index.html')
            do_login(at, 'att1')
            ids = [c.get_attribute('data-module') for c in at.locator('[data-role="module-card"]').all()]
            check('attendance' in ids and 'storeops' in ids, '有 platform.att：首頁有考勤管理與門市營運，實際：%s' % ids)
            check(at.locator('[data-role="nav-desktop"] [data-nav="attendance"]').count() == 1, '有 platform.att：左側選單有「考勤管理」')
            # ⑤0 有 platform.att 沒有 platform.sched（區督導、總監類）：有考勤管理、沒有排班管理（卡片與左側選單都沒有）
            ao = new_page()
            ao.goto(base + '/index.html')
            do_login(ao, 'att2')
            ids2 = [c.get_attribute('data-module') for c in ao.locator('[data-role="module-card"]').all()]
            check('attendance' in ids2 and 'schedule' not in ids2, '有 platform.att 沒有 platform.sched：有考勤管理、沒有排班管理，實際：%s' % ids2)
            check(ao.locator('[data-role="nav-desktop"] [data-nav="schedule"]').count() == 0, '沒有 platform.sched：左側選單沒有「排班管理」')
            check(at.locator('[data-role="nav-desktop"] [data-nav="schedule"]').count() == 1, '有 platform.sched：左側選單有「排班管理」')
            ao.close()
            # ⑤a 首頁考勤管理組的待辦（2026-10-24，spec §17.5）：只回件數，三列提醒文字逐字
            ATT = '[data-role="alert-list"][data-module="attendance"] [data-role="alert-row"]'
            at.wait_for_selector(ATT + ':has-text("支新手機等核准")', timeout=10000)
            rows = [x.replace('›', '').strip() for x in at.locator(ATT).all_inner_texts()]
            check(rows == ['本月還有 3 天沒核定', '2 筆加班請假申請待審', '1 支新手機等核准'], '首頁考勤管理組顯示三列提醒（只有件數）：%s' % rows)
            check(('attendance', 'attAlerts') in getattr(mock, 'proxy_calls', []), '首頁待辦走代轉 ns attendance／action attAlerts')
            # 點「1 支新手機等核准」→ 網址 #/attendance/device，且 iframe 收到 dzy-store-go device
            at.click(ATT + ':has-text("支新手機等核准")')
            at.wait_for_selector('[data-keep="attendance"] iframe[data-role="store-frame"]')
            check(at.evaluate('location.hash') == '#/attendance/device', '點「1 支新手機等核准」→ 網址 #/attendance/device：%s' % at.evaluate('location.hash'))
            fa0 = None
            for _ in range(50):
                fa0 = store_frame(at)
                if fa0:
                    try:
                        if fa0.evaluate("() => window.__got.length") >= 1:
                            break
                    except Exception:
                        pass
                at.wait_for_timeout(100)
            fa0.evaluate("(cur) => parent.postMessage({ type: 'dzy-store-nav', v: 1, cur: cur, items: [{ id: 'approve', label: '核定工時', badge: 0 }, { id: 'request', label: '申請審核', badge: 0 }, { id: 'device', label: '手機核准', badge: 1 }] }, '*')", 'approve')
            at.wait_for_timeout(500)
            g0 = [m for m in fa0.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go']
            check(g0 == [{'type': 'dzy-store-go', 'v': 1, 'id': 'device'}] and at.evaluate('location.hash') == '#/attendance/device',
                  'iframe 收到 {dzy-store-go, id:device}、網址維持 #/attendance/device：%s %s' % (g0, at.evaluate('location.hash')))
            at.goto(base + '/index.html')
            at.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

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

            # ⑤c 排班管理（hr-move-spec §5）：首頁提醒列、點了導到 #/schedule/board、頁頂四個動態分頁
            at.goto(base + '/index.html')
            at.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
            SCH = '[data-role="alert-list"][data-module="schedule"] [data-role="alert-row"]'
            at.wait_for_selector(SCH + ':has-text("美村店")', timeout=10000)
            rows = [x.replace('›', '').strip() for x in at.locator(SCH).all_inner_texts()]
            check(rows == ['光復店 T01、T02 班表還沒送到 LINE', '美村店 T01 班表還沒送到 LINE'], '首頁排班管理組顯示每家店一列提醒：%s' % rows)
            check(('schedule', 'schedAlerts') in getattr(mock, 'proxy_calls', []), '首頁待辦走代轉 ns schedule／action schedAlerts')
            at.click(SCH + ':has-text("光復店")')
            at.wait_for_selector('[data-keep="schedule"] iframe[data-role="store-frame"]')
            check(at.evaluate('location.hash') == '#/schedule/board', '點「光復店 T01、T02…」→ 網址 #/schedule/board：%s' % at.evaluate('location.hash'))
            fs = None
            for _ in range(50):
                fs = store_frame(at)
                if fs:
                    try:
                        if fs.evaluate("() => window.__got.length") >= 1:
                            break
                    except Exception:
                        pass
                at.wait_for_timeout(100)
            check(fs is not None and fs.url == STORE + '/dzy-store/?embed=dzy&only=schedule', '排班管理 iframe 網址帶 &only=schedule：%s' % (fs.url if fs else None))
            SNAV = "(cur) => parent.postMessage({ type: 'dzy-store-nav', v: 1, cur: cur, items: [{ id: 'board', label: '班表', badge: 0 }, { id: 'needs', label: '指定與需求', badge: 0 }, { id: 'staff', label: '同仁', badge: 0 }, { id: 'shifts', label: '班別與設定', badge: 0 }] }, '*')"
            fs.evaluate(SNAV, 'board')
            at.wait_for_function("() => document.querySelectorAll('[data-role=\"view-nav\"] .nav-item').length === 4")
            stabs = [x.replace('\n', '') for x in at.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(stabs == ['班表', '指定與需求', '同仁', '班別與設定'] and at.evaluate('location.hash') == '#/schedule/board', '排班管理頁頂收到四個動態分頁、網址 #/schedule/board：%s %s' % (stabs, at.evaluate('location.hash')))
            check({'type': 'dzy-store-tabs', 'v': 1} in fs.evaluate("() => window.__got.map(m => m.data)"), '排班管理：收到選單後回 dzy-store-tabs')
            at.locator('[data-role="view-nav"] .nav-item', has_text='同仁').click()
            at.wait_for_timeout(300)
            sgos = [m for m in fs.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go']
            check(sgos[-1:] == [{'type': 'dzy-store-go', 'v': 1, 'id': 'staff'}] and at.evaluate('location.hash') == '#/schedule/staff', '點頁頂「同仁」→ 送 {dzy-store-go, id:staff}、網址 #/schedule/staff：%s' % sgos)

            # ⑤d 總部排班提醒（schedule-hq spec §10.2）：svc/sched-alerts 回傳 self → 本人下月未送出、等核准、未送出三列；點了導到 #/schedule/approve（營運系統 mock，不跑真的 iframe 內容）
            mock.sched_alerts = {'ok': True, 'data': {'items': [], 'asOf': '2026-10-25T00:00:00Z', 'self': {'due': ['2026-11'], 'wait': 2, 'missing': 1}}}
            at.goto(base + '/index.html')
            at.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
            at.wait_for_selector(SCH + ':has-text("等你核准")', timeout=10000)
            hrows = [x.replace('›', '').strip() for x in at.locator(SCH).all_inner_texts()]
            check(hrows == ['11 月班表還沒送出', '2 位同仁的班表等你核准', '1 位同仁下個月班表還沒送出'], '首頁排班管理組顯示總部三種提醒：%s' % hrows)
            at.click(SCH + ':has-text("等你核准")')
            at.wait_for_selector('[data-keep="schedule"] iframe[data-role="store-frame"]')
            check(at.evaluate('location.hash') == '#/schedule/approve', '點「2 位同仁的班表等你核准」→ 網址 #/schedule/approve：%s' % at.evaluate('location.hash'))
            # 門市狀態（頁頂只有 board／needs／staff／shifts，沒有 approve）：營運系統回報選單後，管理系統仍要送 go approve（營運系統收到會自動切店）
            fh = None
            for _ in range(50):
                fh = store_frame(at)
                if fh:
                    try:
                        if fh.evaluate("() => window.__got.length") >= 1:
                            break
                    except Exception:
                        pass
                at.wait_for_timeout(100)
            fh.evaluate(SNAV, 'board')
            at.wait_for_timeout(500)
            hgos = [m for m in fh.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go']
            check(hgos == [{'type': 'dzy-store-go', 'v': 1, 'id': 'approve'}], '從門市狀態點總部提醒「等你核准」→ 送 {dzy-store-go, id:approve}：%s' % hgos)
            at.goto(base + '/index.html')
            at.wait_for_selector(SCH + ':has-text("還沒送出")', timeout=10000)
            at.click(SCH + ':has-text("11 月")')
            at.wait_for_selector('[data-keep="schedule"] iframe[data-role="store-frame"]')
            check(at.evaluate('location.hash') == '#/schedule/self', '點「11 月班表還沒送出」→ 網址 #/schedule/self：%s' % at.evaluate('location.hash'))
            fh2 = None
            for _ in range(50):
                fh2 = store_frame(at)
                if fh2:
                    try:
                        if fh2.evaluate("() => window.__got.length") >= 1:
                            break
                    except Exception:
                        pass
                at.wait_for_timeout(100)
            fh2.evaluate(SNAV, 'board')
            at.wait_for_timeout(500)
            hgos2 = [m for m in fh2.evaluate("() => window.__got.map(m => m.data)") if m.get('type') == 'dzy-store-go']
            check(hgos2 == [{'type': 'dzy-store-go', 'v': 1, 'id': 'self'}], '從門市狀態點總部提醒「11 月班表還沒送出」→ 送 {dzy-store-go, id:self}：%s' % hgos2)

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

            # ⑩ 代轉失敗／部分門市讀不到：首頁考勤管理組顯示「暫時讀不到」，不出現假的件數
            mock.att_alerts_fail = True
            fl = new_page()
            fl.goto(base + '/index.html')
            do_login(fl, 'att1')
            ATT = '[data-role="alert-list"][data-module="attendance"] [data-role="alert-row"]'
            fl.wait_for_selector(ATT, timeout=10000)
            rows = [x.replace('›', '').strip() for x in fl.locator(ATT).all_inner_texts()]
            check(rows == ['暫時讀不到'], '代轉失敗：首頁考勤管理組只顯示「暫時讀不到」：%s' % rows)
            mock.att_alerts_fail = False
            mock.att_alerts = {'ok': True, 'data': {'items': [{'kind': 'request', 'count': 2}], 'partial': True, 'asOf': '2026-10-24T00:00:00Z', 'pending': False}}
            pt = new_page()
            pt.goto(base + '/index.html')
            do_login(pt, 'att1')
            pt.wait_for_selector(ATT + ':has-text("部分門市暫時讀不到")', timeout=10000)
            rows = [x.replace('›', '').strip() for x in pt.locator(ATT).all_inner_texts()]
            check(rows == ['2 筆加班請假申請待審', '部分門市暫時讀不到'], '部分門市讀不到：件數照出、另加一列「部分門市暫時讀不到」：%s' % rows)

            check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
