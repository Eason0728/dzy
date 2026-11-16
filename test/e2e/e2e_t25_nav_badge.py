#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉕：側邊欄待辦數字不管在哪一頁都要出現（2026-11-16 Eason：功能列表沒有顯示數字）。全程 mock 後端，零真實資料。

① 首頁數字還沒算好就點去別的功能：算好後側邊欄照樣出現數字（以前首頁「過期」就把數字丟掉）。
② 一開就在模組頁（重新整理、LINE 連結）：首頁沒跑過，背景補算後側邊欄也有數字。
③ 「功能」頁直接進來：側邊欄也有數字（以前只更新卡片、不更新側邊欄）。
mock 的盤點抽查（audit-stock）待辦＝5。上次件數（home_badges）一律先清掉，確定數字是這次算出來的。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8864

HOLD_JS = """
(() => {
  const f = window.fetch.bind(window);
  window.fetch = (u, o) => {
    const b = (o && o.body) || '';
    const ms = Number(localStorage.getItem('e2e.hold') || 0);
    return ms && !/"action":"me"/.test(b) ? new Promise((r) => setTimeout(r, ms)).then(() => f(u, o)) : f(u, o);
  };
})();
"""

NAV5 = "() => { const b = document.querySelector('[data-nav=audit-stock] .badge'); return !!b && b.textContent === '5' && !b.className.includes('stale'); }"


def clear_last(page):
    page.evaluate("() => Object.keys(localStorage).filter(k => k.includes('home_badges')).forEach(k => localStorage.removeItem(k))")


def new_page(browser, base):
    ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    page = ctx.new_page()
    MockBackend(base).install(page)
    page.add_init_script(HOLD_JS)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    return ctx, page, errors


def main():
    httpd, base = start_server(PORT)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ① 首頁讀取慢 1.5 秒，登入後馬上點「我的資料」
            ctx, page, errs = new_page(browser, base)
            page.goto(base + '/index.html')
            page.evaluate("() => localStorage.setItem('e2e.hold', '1500')")
            login(page, base, 'admin')
            clear_last(page)
            page.click('[data-nav="me"]')
            page.wait_for_function("() => location.hash.startsWith('#/me')", timeout=5000)
            try:
                page.wait_for_function(NAV5, timeout=15000); ok = True
            except Exception:
                ok = False
            check(ok and page.evaluate("() => location.hash").startswith('#/me'), '①首頁還沒算好就切到我的資料：側邊欄盤點抽查照樣出現 5')
            check(not errs, '①沒有 JS 錯誤：%s' % errs)
            ctx.close()

            # ② 停在宿舍合約頁重新整理（首頁沒跑）
            ctx, page, errs = new_page(browser, base)
            login(page, base, 'admin')
            page.wait_for_function(NAV5, timeout=15000)
            page.click('[data-nav="dorm"]')
            page.wait_for_function("() => location.hash.startsWith('#/dorm')", timeout=5000)
            clear_last(page)
            page.reload()
            page.wait_for_selector('[data-nav="audit-stock"]', state='attached', timeout=10000)
            check(page.locator('[data-nav="audit-stock"] .badge').count() == 0, '②重新整理後一開始沒有數字（沒有上次件數）')
            try:
                page.wait_for_function(NAV5, timeout=15000); ok = True
            except Exception:
                ok = False
            check(ok and page.evaluate("() => location.hash").startswith('#/dorm'), '②一開就在宿舍合約頁：背景補算後側邊欄出現 5，人還在宿舍合約')
            check(not errs, '②沒有 JS 錯誤：%s' % errs)
            ctx.close()

            # ③ 直接開「功能」頁
            ctx, page, errs = new_page(browser, base)
            login(page, base, 'admin')
            page.wait_for_function(NAV5, timeout=15000)
            clear_last(page)
            page.goto(base + '/index.html#/apps')
            page.wait_for_selector('[data-nav="audit-stock"]', state='attached', timeout=10000)
            try:
                page.wait_for_function(NAV5, timeout=15000); ok = True
            except Exception:
                ok = False
            check(ok, '③直接開「功能」頁：側邊欄也出現 5')
            ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
