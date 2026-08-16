#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ①：登入 → 首頁卡片正確（admin 看到四張卡、圖示載入、待辦數字）。

順手產出 T4-3 的兩張驗收截圖：shots/home-1280.png、shots/home-375.png。
全程 mock 後端，不碰真資料（見 common.py 檔頭）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8791


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ---- 桌機 1280 ----
            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            page = ctx.new_page()
            mock.install(page)
            login(page, base, 'admin')

            page.wait_for_selector('[data-role="module-card"]')
            cards = page.locator('[data-role="module-card"]')
            check(cards.count() == 4, 'admin 首頁有四張模組卡片')

            ids = [cards.nth(i).get_attribute('data-module') for i in range(cards.count())]
            check(ids == ['users', 'audit-stock', 'audit-ops', 'dorm'],
                  '卡片順序＝registry 順序（users, audit-stock, audit-ops, dorm），實際：%s' % ids)

            titles = page.locator('[data-role="module-card"] .card-title').all_inner_texts()
            check(titles == ['人員管理', '月初盤點抽查', '營運稽核表', '宿舍合約'],
                  '卡片標題顯示 manifest.name，實際：%s' % titles)

            # 圖示真的載入（不是 404 的裂圖）
            icons_ok = page.evaluate(
                """() => [...document.querySelectorAll('.module-icon')]
                       .map(img => img.complete && img.naturalWidth > 0)"""
            )
            check(len(icons_ok) == 4 and all(icons_ok), '四顆模組圖示全部載入成功（naturalWidth > 0）：%s' % icons_ok)

            # 待辦數字：fixture 只到 2026-07，本月（依系統日期）五店皆未稽核 → 盤點 badge = 5
            page.wait_for_function(
                """() => document.querySelector('[data-role="badge"][data-module="audit-stock"]')
                          ?.textContent === '5'""",
                timeout=8000,
            )
            check(True, '月初盤點抽查 badge = 5（五店本月未稽核，模組自己算的）')

            os.makedirs(SHOTS, exist_ok=True)
            page.screenshot(path=os.path.join(SHOTS, 'home-1280.png'), full_page=True)
            ctx.close()

            # ---- 手機 375（T4-3 驗收另一張；同時驗無橫向捲動）----
            ctx2 = browser.new_context(viewport={'width': 375, 'height': 812})
            page2 = ctx2.new_page()
            mock.install(page2)
            login(page2, base, 'admin')
            page2.wait_for_selector('[data-role="module-card"]')
            no_hscroll = page2.evaluate('() => document.documentElement.scrollWidth <= 375')
            check(no_hscroll, '375px 寬無橫向捲動')
            page2.screenshot(path=os.path.join(SHOTS, 'home-375.png'), full_page=True)
            ctx2.close()

            browser.close()

        check(mock.leaked == [], '真實網路零流出（未被 mock 的 script.google.com 請求：%s）' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
