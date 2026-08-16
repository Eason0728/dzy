#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ③：店長只看得到自己店，改網址參數也拿不到別店資料（requirements §10 第 3 條）。

光復店長（node=sxl-gf，只有 audit.read.own）：
- 首頁只有兩張稽核卡片
- 進盤點模組落在「我的門市」，分頁列沒有總覽／報告／異常分析
- 畫面上是光復的資料（2026-07 95%、異常品項肉燥），看不到他店專屬品項（打拋醬）
- 手動改網址 #/audit-stock/overview → 彈回首頁
- 資料層證據：api.js 已把他店 rows 裁掉（window 端實測 getAll 回傳只剩 sxl-gf）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8793


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            mock.install(page)
            login(page, base, 'lead')

            page.wait_for_selector('[data-role="module-card"]')
            ids = [c.get_attribute('data-module') for c in page.locator('[data-role="module-card"]').all()]
            check(ids == ['audit-stock', 'audit-ops'], '店長首頁只有兩張稽核卡片，實際：%s' % ids)

            page.click('[data-role="module-card"][data-module="audit-stock"]')
            page.wait_for_selector('[data-role="view-nav"] .nav-item')
            tabs = page.locator('[data-role="view-nav"] .nav-item').all_inner_texts()
            check(tabs == ['我的門市'], '店長只有「我的門市」一個分頁，實際：%s' % tabs)

            page.wait_for_selector('text=目前門市：小辛辣光復', timeout=8000)
            check(True, '「我的門市」顯示的是自己店（小辛辣光復）')
            page.wait_for_selector('#my-issues-list li', timeout=8000)
            content = page.locator('[data-role="view-content"]').inner_text()
            check('95%' in content, '看得到自己店最近一次合格率 95%%（2026-07），實際內容含 95%%：%s' % ('95%' in content))
            check('肉燥' in content, '看得到自己店的異常品項（肉燥）')
            check('打拋醬' not in content, '看不到他店專屬品項（打拋醬＝墨竹亭的異常品項）')
            check('墨竹亭金山' not in content, '畫面上沒有其他店名（墨竹亭金山）')

            # 改網址闖總覽（需要 audit.read）→ 彈回首頁
            page.evaluate("() => { window.location.hash = '#/audit-stock/overview'; }")
            page.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            check(True, '手動改網址 #/audit-stock/overview 被彈回 #/home')

            # 資料層證據：平台 api.js 的店長裁切真的把他店 rows 拿掉了
            filtered = page.evaluate("""async () => {
              const api = await import('./platform/api.js');
              const res = await api.call('audit', 'getAll', {});
              if (!res.ok) return 'call failed: ' + res.error;
              const stores = (rows) => [...new Set((rows || []).map(r => r.store))];
              return {
                records: stores(res.data.records),
                details: stores(res.data.details),
                items: stores(res.data.items),
                ops: stores(res.data.ops_records)
              };
            }""")
            check(isinstance(filtered, dict) and all(v == ['sxl-gf'] or v == [] for v in filtered.values()),
                  '資料層實測：getAll 每個 rows 陣列只剩 sxl-gf（%s）' % filtered)

            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
