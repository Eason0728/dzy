#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉖：我的資料 → 設定，每個功能的提醒開關（2026-11-17 Eason；docs/alert-prefs/spec.md）。全程 mock 後端，零真實資料。

① 關掉「盤點抽查」：一按就存，側邊欄數字立刻消失。
② 回首頁：盤點抽查卡片標「提醒已關閉」、要處理的事沒有盤點、多一行「你關了 1 項提醒」。
③ 換一個瀏覽器（沒有本機快取）登入同帳號：照樣是關的（跟著帳號走）。
④ 點「你關了 1 項提醒」到設定、打開回來：數字 5 回來。
⑤ 存檔失敗：開關退回原狀、顯示原因。
⑥ 試跑模式（?dryrun=1）：不存、開關退回、說明試跑。
⑦ 手機 375／320 寬：設定頁沒有橫向捲動；截圖。
mock 的盤點抽查（audit-stock）待辦＝5。截圖存到環境變數 SHOTS（沒給就不存）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, USERS, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8866
SHOTS = os.environ.get('SHOTS', '')

NAV5 = "() => { const b = document.querySelector('[data-nav=audit-stock] .badge'); return !!b && b.textContent === '5' && !b.className.includes('stale'); }"
NAV0 = "() => !document.querySelector('[data-nav=audit-stock] .badge')"
ROW = '[data-role=alert-pref][data-module=audit-stock]'
BOX = ROW + ' input'


def login(page, base, username, query=''):
    """mini 上登入頁偶爾 30 秒出不來（主線 e2e 一樣，環境問題）：最多重開三次"""
    for i in range(3):
        try:
            page.goto(base + '/index.html' + query)
            page.wait_for_selector('#login-username', timeout=10000)
            break
        except Exception:
            if i == 2:
                raise
    page.fill('#login-username', username)
    page.fill('#login-password', USERS[username]['password'])
    page.click('[data-role="submit"]')
    page.wait_for_selector('[data-role="view-content"]', state='attached', timeout=15000)


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name), full_page=True)


def new_page(browser, mock, width=1280, height=800):
    ctx = browser.new_context(viewport={'width': width, 'height': height})
    page = ctx.new_page()
    mock.install(page)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page, errors


def open_settings(page):
    page.goto(page.url.split('#')[0] + '#/me/settings')
    page.wait_for_selector(ROW, timeout=10000)


def status_text(page):
    return page.locator('[data-role=ap-status]').inner_text()


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ① 關掉盤點抽查
            ctx, page, errs = new_page(browser, mock)
            login(page, base, 'admin')
            page.wait_for_function(NAV5, timeout=15000)
            open_settings(page)
            check(page.locator(BOX).is_checked(), '①一開始盤點抽查是開著的（預設全部開）')
            check(page.locator('[data-role=alert-pref]').count() >= 10, '①管理者看得到十個以上會跳提醒的功能（%d）' % page.locator('[data-role=alert-pref]').count())
            shot(page, 'desk-settings-before.png')
            page.click(ROW + ' .ap-sw')
            page.wait_for_function("() => /已存檔/.test(document.querySelector('[data-role=ap-status]').textContent)", timeout=8000)
            check(not page.locator(BOX).is_checked(), '①開關變成關')
            check(mock.prefs.get('e2e-token-admin', {}).get('alerts_off') == ['audit-stock'], '①後端存到 alerts_off=[audit-stock]：%s' % mock.prefs)
            try:
                page.wait_for_function(NAV0, timeout=8000); ok = True
            except Exception:
                ok = False
            check(ok, '①側邊欄盤點抽查的數字立刻消失')
            shot(page, 'desk-settings-off.png')

            # ② 首頁
            page.click('[data-nav="home"]') if page.locator('[data-nav="home"]').count() else page.goto(base + '/index.html#/home')
            page.wait_for_selector('[data-role=module-card][data-module=audit-stock] [data-role=muted-note]', timeout=10000)
            check(True, '②首頁盤點抽查卡片標「提醒已關閉」')
            page.wait_for_selector('[data-role=muted-hint]', timeout=8000)
            check('你關了 1 項提醒（盤點抽查）' in page.locator('[data-role=muted-hint]').first.inner_text(), '②首頁多一行「你關了 1 項提醒（盤點抽查）」')
            todo_txt = page.locator('[data-role=m-todo]').all_inner_texts() if page.locator('[data-role=m-todo]').count() else []
            check(not any('盤點抽查' in t.split('你關了')[0] for t in todo_txt), '②要處理的事裡沒有盤點抽查')
            page.wait_for_timeout(500)
            shot(page, 'desk-home-muted.png')
            check(not errs, '①②沒有 JS 錯誤：%s' % errs)
            ctx.close()

            # ③ 換瀏覽器（沒有本機快取）
            ctx, page, errs = new_page(browser, mock)
            login(page, base, 'admin')
            page.wait_for_selector('[data-role=module-card][data-module=audit-stock] [data-role=muted-note]', timeout=15000)
            page.wait_for_timeout(1500)
            check(page.evaluate(NAV0), '③換一個瀏覽器登入：盤點抽查照樣沒有數字（跟著帳號走）')

            # ④ 點提示 → 設定 → 打開
            page.locator('[data-role=muted-hint]').first.click()
            try:
                page.wait_for_selector(ROW, timeout=10000)
            except Exception:
                print('DEBUG hash=', page.evaluate("() => location.hash"), 'hints=', page.locator('[data-role=muted-hint]').count())
                shot(page, 'debug-hint.png')
                raise
            check(page.evaluate("() => location.hash") == '#/me/settings', '④點「你關了 1 項提醒」到我的資料 → 設定')
            check(not page.locator(BOX).is_checked(), '④設定頁顯示盤點抽查是關的')
            page.click(ROW + ' .ap-sw')
            page.wait_for_function("() => /已存檔/.test(document.querySelector('[data-role=ap-status]').textContent)", timeout=8000)
            try:
                page.wait_for_function(NAV5, timeout=15000); ok = True
            except Exception:
                ok = False
            check(ok, '④打開回來：側邊欄數字 5 回來，不用重新整理')
            check(mock.prefs['e2e-token-admin']['alerts_off'] == [], '④後端存成全部開著')

            # ⑤ 存檔失敗
            mock.prefs_fail = True
            page.click('[data-role=alert-pref][data-module=dorm] .ap-sw')
            page.wait_for_function("() => document.querySelector('[data-role=ap-status]').classList.contains('err')", timeout=8000)
            check(page.locator('[data-role=alert-pref][data-module=dorm] input').is_checked(), '⑤存檔失敗：宿舍合約開關退回「開」')
            check('忙碌' in status_text(page), '⑤顯示失敗原因：%s' % status_text(page))
            mock.prefs_fail = False
            check(not errs, '③④⑤沒有 JS 錯誤：%s' % errs)
            ctx.close()

            # ⑥ 試跑模式
            ctx, page, errs = new_page(browser, mock)
            login(page, base, 'admin', '?dryrun=1')
            page.goto(base + '/index.html?dryrun=1#/me/settings')
            page.wait_for_selector(ROW, timeout=10000)
            page.click(ROW + ' .ap-sw')
            page.wait_for_function("() => document.querySelector('[data-role=ap-status]').classList.contains('err')", timeout=8000)
            check(page.locator(BOX).is_checked() and '試跑' in status_text(page), '⑥試跑模式：不存、開關退回、說明試跑（%s）' % status_text(page))
            check(mock.prefs['e2e-token-admin']['alerts_off'] == [], '⑥後端沒有被寫')
            ctx.close()

            # ⑦ 手機寬
            for w in (375, 320):
                ctx, page, errs = new_page(browser, mock, w, 760)
                login(page, base, 'admin')
                page.goto(base + '/index.html#/me/settings')
                page.wait_for_selector(ROW, timeout=10000)
                page.wait_for_timeout(400)
                sw = page.evaluate("() => document.documentElement.scrollWidth")
                check(sw <= w, '⑦%d 寬設定頁沒有橫向捲動（scrollWidth=%d）' % (w, sw))
                shot(page, 'm%d-settings.png' % w)
                check(not errs, '⑦%d 寬沒有 JS 錯誤：%s' % (w, errs))
                ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
    check(not mock.leaked, '全程沒有請求流到真實後端：%s' % mock.leaked[:3])
    finish()


if __name__ == '__main__':
    main()
