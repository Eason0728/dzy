#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉔：首頁少等（2026-11-10）。全程 mock 後端（platform/proxy 都是 Playwright 攔截），零真實資料。

① 開關關閉（預設）：首頁每個白名單讀取各發一筆（記基準請求數）、沒有 batchRead、localStorage 沒有 home_badges、sessionStorage 空。
② ?homefast=1：同一輪的讀取併成 batchRead（記併後請求數）；卡片數字與提醒文字跟關閉時逐字相同；
   localStorage 的 home_badges 只有數字，提醒文字與姓名一個字都沒存；sessionStorage 只多一個 dzy.homefast。
③ 本機 8862 埠不帶參數也自動開。
④ 上次件數：重新整理後、最新結果回來之前，卡片先顯示上次件數（灰色 stale）；回來就換成最新、灰色拿掉、localStorage 更新。
⑤ 手機 375：功能磚也先顯示上次件數。
⑥ 整批失敗（模擬舊後端）：首頁照常完整顯示（逐筆退回）。
⑦ 登出清除；換帳號看不到別人的上次件數。
"""
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, USERS, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8863
PORT_LOCAL = 8862
HERE = os.path.dirname(os.path.abspath(__file__))

# 讓「最新結果」延遲回來，才看得到上次件數（me 不延遲，不然開機就卡住）
HOLD_JS = """
(() => {
  const f = window.fetch.bind(window);
  window.__hold = 0;
  window.fetch = (u, o) => {
    const b = (o && o.body) || '';
    const wait = window.__hold && !/"action":"me"/.test(b);
    return wait ? new Promise((r) => setTimeout(r, window.__hold)).then(() => f(u, o)) : f(u, o);
  };
})();
"""


def batch_actions():
    src = open(os.path.join(HERE, '..', '..', 'platform', 'dryrun.js'), encoding='utf-8').read()
    return re.findall(r"'([A-Za-z]+)'", re.search(r'BATCH_READ_ACTIONS = \[(.*?)\]', src, re.S).group(1))


def home_snapshot(page):
    """各模組卡片的數字與提醒文字（用來比對開關前後一樣）"""
    page.wait_for_selector('[data-role="module-card"]')
    page.wait_for_function("() => ![...document.querySelectorAll('[data-role=alert-list]')].some(l => l.textContent.includes('讀取中'))", timeout=15000)
    return page.evaluate("""() => [...document.querySelectorAll('[data-role=module-card]')].map(c => ({
        id: c.getAttribute('data-module'),
        badge: c.querySelector('[data-role=badge]').textContent,
        rows: c.querySelector('[data-role=alert-list]').innerText
    }))""")


def storage_dump(page):
    return page.evaluate("""() => ({ local: Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])),
                                     session: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])) })""")


def run_home(browser, base, query='', mut=None):
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    page = ctx.new_page()
    mock = MockBackend(base)
    if mut:
        mut(mock)
    mock.install(page)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    login(page, base, 'admin', query)
    snap = home_snapshot(page)
    page.wait_for_timeout(500)
    return ctx, page, mock, snap, errors


def set_last(page, module, n):
    page.evaluate("""([m, n]) => { const k = 'dzy.u.u-admin.home_badges'; const d = JSON.parse(localStorage.getItem(k));
        d.n[m] = n; d.at = Date.now(); localStorage.setItem(k, JSON.stringify(d)); }""", [module, n])


def main():
    allow = batch_actions()
    httpd, base = start_server(PORT)
    httpd2, base2 = start_server(PORT_LOCAL)
    mock = None
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ---------- ① 關閉（基準） ----------
            ctx, page, mock, snap_off, errs = run_home(browser, base)
            plat = [a for b, a in mock.calls if b == 'platform']
            reads_off = [a for a in plat if a in allow]
            proxy_off = list(getattr(mock, 'proxy_calls', []))
            check('batchRead' not in plat and getattr(mock, 'batch_calls', None) is None, '①關閉：沒有 batchRead')
            check(len(reads_off) >= 10, '①關閉：白名單讀取各自一筆（基準 %d 筆：%s）' % (len(reads_off), dict(collections.Counter(reads_off))))
            st = storage_dump(page)
            check(not any('home_badges' in k for k in st['local']), '①關閉：localStorage 沒有 home_badges')
            check(st['session'] == {}, '①關閉：sessionStorage 空的：%s' % st['session'])
            check(errs == [], '①關閉：無 pageerror：%s' % errs)
            print('基準 platform 請求（含 login、ssoTicket）：%d；白名單讀取 %d；proxy %d；合計首頁後端請求 %d'
                  % (len(plat), len(reads_off), len(proxy_off), len(plat) - 1 + len(proxy_off)))
            print('基準 platform 逐項：%s' % dict(collections.Counter(plat)))
            print('基準 proxy 逐項：%s' % dict(collections.Counter(proxy_off)))
            ctx.close()

            # ---------- ② ?homefast=1 ----------
            ctx, page, mock, snap_on, errs = run_home(browser, base, '?homefast=1')
            plat = [a for b, a in mock.calls if b == 'platform']
            proxy_on = list(getattr(mock, 'proxy_calls', []))
            direct = [a for a in plat if a in allow]
            check(direct == [] and plat.count('batchRead') in (1, 2), '②開啟：白名單讀取沒有單獨送，只有 %d 次 batchRead：%s' % (plat.count('batchRead'), mock.batch_calls))
            inner = [a for batch in mock.batch_calls for a in batch]
            check(sorted(set(inner)) == sorted(set(reads_off)), '②開啟：批次內是基準讀取去重後的集合（%d 筆 → %d 筆）' % (len(reads_off), len(inner)))
            check(proxy_on and collections.Counter(proxy_on) == collections.Counter(proxy_off), '②開啟：代轉 ns（audit、cashbook…）請求與基準相同、不併：%d 筆' % len(proxy_on))
            check(snap_on == snap_off, '②開啟：各卡片的數字與提醒文字跟關閉時逐字相同')
            print('併後 platform 請求（含 login、ssoTicket）：%d；batchRead %d 次（內含 %d 筆）；proxy %d；合計首頁後端請求 %d'
                  % (len(plat), plat.count('batchRead'), len(inner), len(proxy_on), len(plat) - 1 + len(proxy_on)))
            st = storage_dump(page)
            hb = {k: v for k, v in st['local'].items() if 'home_badges' in k}
            check(list(hb) == ['dzy.u.u-admin.home_badges'], '②開啟：key 格式 dzy.u.<user id>.home_badges：%s' % list(hb))
            d = json.loads(hb['dzy.u.u-admin.home_badges'])
            check(sorted(d) == ['at', 'n', 'v'] and d['v'] == 1 and all(isinstance(x, int) for x in d['n'].values()) and len(d['n']) >= 5, '②開啟：只存 v、at、n，n 裡全是整數（%d 個模組）' % len(d['n']))
            alert_lines = [ln.strip() for r in snap_on for ln in r['rows'].split('\n') if len(ln.strip()) >= 4]
            dumped = ' '.join(st['local'].values())
            hit = [ln for ln in alert_lines if ln in dumped]
            check(alert_lines and not hit, '②開啟：%d 行提醒文字，沒有任何一行出現在 localStorage：%s' % (len(alert_lines), hit))
            check(d['n'].get('audit-stock') == 5, '②開啟：盤點抽查件數 5 有記下來')
            check(st['session'] == {'dzy.homefast': '1'}, '②開啟：sessionStorage 只多 dzy.homefast=1：%s' % st['session'])
            check(errs == [], '②開啟：無 pageerror：%s' % errs)

            # ---------- ④ 上次件數（重新整理，最新結果延遲 1.5 秒） ----------
            ctx.close()

            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page = ctx.new_page()
            m4 = MockBackend(base)
            m4.install(page)
            # __hold 用 localStorage 旗標帶過重新整理（HOLD_JS 載入時讀）
            page.add_init_script(HOLD_JS.replace('window.__hold = 0;', "window.__hold = Number(localStorage.getItem('e2e.hold') || 0);"))
            login(page, base, 'admin', '?homefast=1')
            home_snapshot(page)
            page.wait_for_timeout(300)
            set_last(page, 'audit-stock', 7)
            page.evaluate("() => localStorage.setItem('e2e.hold', '1500')")
            page.reload()
            page.wait_for_selector('.module-badge.stale', timeout=8000)
            b = page.locator('[data-role="badge"][data-module="audit-stock"]')
            check(b.inner_text().startswith('7') and 'stale' in (b.get_attribute('class') or '') and b.get_attribute('title'),
                  '④重新整理後先顯示上次件數 7（灰色 stale、有「更新中」提示）：%s／%s' % (b.inner_text(), b.get_attribute('class')))
            nav = page.locator('[data-nav="audit-stock"] .badge')
            check(nav.count() == 1 and 'stale' in (nav.get_attribute('class') or '') and nav.inner_text() == '7', '④側邊欄同一個模組也是灰色上次件數')
            os.makedirs(os.path.join(HERE, 'shots'), exist_ok=True)
            page.screenshot(path=os.path.join(HERE, 'shots', 'home-fast-stale-1280.png'))
            page.wait_for_function("() => document.querySelector('[data-role=badge][data-module=audit-stock]').textContent === '5'", timeout=15000)
            b = page.locator('[data-role="badge"][data-module="audit-stock"]')
            check('stale' not in (b.get_attribute('class') or '') and not b.get_attribute('title'), '④最新結果到了：數字換成 5、灰色拿掉')
            nav = page.locator('[data-nav="audit-stock"] .badge')
            check(nav.count() == 1 and nav.inner_text() == '5' and 'stale' not in (nav.get_attribute('class') or ''), '④側邊欄也換成最新 5：%s／%s' % (nav.count(), nav.evaluate_all('e => e.map(x => x.className + ":" + x.textContent)')))
            page.wait_for_function("() => document.querySelectorAll('.module-badge.stale').length === 0", timeout=15000)
            check(True, '④畫面上不剩任何灰色上次件數')
            page.wait_for_timeout(300)
            d = json.loads(storage_dump(page)['local']['dzy.u.u-admin.home_badges'])
            check(d['n'].get('audit-stock') == 5, '④localStorage 也更新成最新 5')

            # ---------- ⑤ 手機 375：功能磚 ----------
            home_snapshot(page)
            page.evaluate("() => localStorage.setItem('e2e.hold', '0')")
            page.set_viewport_size({'width': 375, 'height': 812})
            page.reload()
            page.wait_for_selector('[data-role="m-tabs"]')
            page.wait_for_timeout(2500)   # 這一輪（手機版）的結果全部回來、寫完 localStorage，下面種的 9 才不會被落後的結果蓋掉
            set_last(page, 'audit-stock', 9)
            page.evaluate("() => localStorage.setItem('e2e.hold', '2500')")
            page.reload()
            page.wait_for_selector('[data-role="m-tabs"]')
            page.click('[data-m-tab="apps"]')
            page.wait_for_selector('[data-role="m-tile"][data-module="audit-stock"]')
            tile = page.locator('[data-role="m-tile"][data-module="audit-stock"] .badge')
            check(tile.count() == 1 and tile.inner_text() == '9' and 'stale' in (tile.get_attribute('class') or ''),
                  '⑤手機功能磚先顯示上次件數 9（灰色）：%s' % tile.evaluate_all('e => e.map(x => x.className + ":" + x.textContent)'))
            page.screenshot(path=os.path.join(HERE, 'shots', 'home-fast-stale-375.png'))
            page.wait_for_function("() => { const t = document.querySelector('[data-role=m-tile][data-module=audit-stock] .badge'); return t && t.textContent === '5' && !t.className.includes('stale'); }", timeout=25000)
            check(True, '⑤最新結果到了：磚上的數字換成 5、灰色拿掉')
            check(page.evaluate('() => document.documentElement.scrollWidth <= 375'), '⑤375 寬無橫向捲動')

            # ---------- ⑦ 登出清除 ----------
            page.evaluate("() => localStorage.removeItem('e2e.hold')")
            page.set_viewport_size({'width': 1280, 'height': 800})
            page.evaluate("() => { location.hash = '#/home'; }")
            page.reload()
            home_snapshot(page)
            page.click('[data-nav="__logout__"]')
            page.wait_for_selector('#login-username', timeout=10000)
            st = storage_dump(page)
            check(not any('home_badges' in k for k in st['local']), '⑦登出後 localStorage 的 home_badges 清掉了：%s' % list(st['local']))
            ctx.close()

            # ---------- ⑦ 換帳號看不到別人的 ----------
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page = ctx.new_page()
            mock2 = MockBackend(base)
            mock2.install(page)
            page.add_init_script(HOLD_JS)
            page.goto(base + '/index.html?homefast=1')
            page.evaluate("() => localStorage.setItem('dzy.u.u-admin.home_badges', JSON.stringify({v:1, at: Date.now(), n: {'audit-stock': 77, dorm: 66}}))")
            page.evaluate('() => { window.__hold = 1500; }')
            page.fill('#login-username', 'mgr')
            page.fill('#login-password', USERS['mgr']['password'])
            page.click('[data-role="submit"]')
            page.wait_for_selector('[data-role="module-card"]', timeout=10000)
            page.wait_for_timeout(300)
            check(page.locator('.module-badge.stale').count() == 0 and page.locator('.badge.stale').count() == 0, '⑦換成另一個帳號（部門主管）：看不到前一個帳號的上次件數')
            txt = page.locator('[data-role="view-content"]').inner_text()
            check('77' not in txt and '66' not in txt, '⑦頁面上沒有別人的數字')
            page.wait_for_function("() => !!localStorage.getItem('dzy.u.u-mgr.home_badges')", timeout=15000)
            st = storage_dump(page)
            check(json.loads(st['local']['dzy.u.u-admin.home_badges'])['n']['audit-stock'] == 77, '⑦新帳號自己一份、前一個帳號那份沒被動到')
            ctx.close()

            # ---------- ③ 本機 8862：不帶參數也開 ----------
            ctx, page, mock, snap3, errs = run_home(browser, base2)
            plat = [a for b, a in mock.calls if b == 'platform']
            check(plat.count('batchRead') in (1, 2) and not [a for a in plat if a in allow], '③本機 8862 不帶參數自動開：%d 次 batchRead' % plat.count('batchRead'))
            ctx.close()

            # ---------- ⑥ 整批失敗退回逐筆 ----------
            def failing(m):
                m.batch_fail = True
            ctx, page, mock, snap6, errs = run_home(browser, base, '?homefast=1', mut=failing)
            plat = [a for b, a in mock.calls if b == 'platform']
            check(snap6 == snap_off, '⑥批次失敗（舊後端）：首頁照常顯示，內容與基準逐字相同')
            check(len([a for a in plat if a in allow]) >= 10, '⑥批次失敗：退回逐筆（%d 筆單送）' % len([a for a in plat if a in allow]))
            ctx.close()

            browser.close()
        check(mock is None or mock.leaked == [], '真實網路零流出：%s' % (mock.leaked if mock else None))
    finally:
        httpd.shutdown()
        httpd2.shutdown()
    finish()


if __name__ == '__main__':
    main()
