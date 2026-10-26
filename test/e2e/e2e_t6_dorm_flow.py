#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑥：宿舍「建單 → 簽約 → 點交」全流程（task.md T4-1 第 ⑥ 條）。

以部門主管（manager）身分在新系統走完整條路，dorm 後端全程是有狀態的 mock
（common.py MockBackend），一筆資料都不會寫進正式試算表：

1. 建單：宿舍合約 → 建立合約 → 填四人房＋床位＋起日 → 送出 → 拿到簽署連結
2. 簽約：只驗簽署連結格式（sign.html 在舊站，dzy 不開）；mock 後端直接把合約設成已簽
3. 點交：回合約清單（狀態變「在住」）→ 開點交單 → 七項設備逐項點選
   （一項標異常未歸還 500 元＋勾清潔費 800）→ 簽名 → 送出 → 點交完成 1,300 元
4. 收尾：清單重載，狀態變「已退宿」
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8796


def draw_signature(page, canvas_selector):
    """在簽名板上畫一筆（mousedown → move → up），觸發 dirty。

    page.mouse 打的是視口座標——簽名板通常在長頁面底部，要先捲進可視範圍
    再取 bounding_box，否則座標落在視口外、事件全落空（送出鈕永遠鎖住）。
    """
    loc = page.locator(canvas_selector)
    loc.scroll_into_view_if_needed()
    box = loc.bounding_box()
    assert box, '找不到簽名板 ' + canvas_selector
    x, y = box['x'] + box['width'] / 3, box['y'] + box['height'] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    for i in range(1, 6):
        page.mouse.move(x + i * 18, y + (8 if i % 2 else -8))
    page.mouse.up()


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            mock.install(page)
            login(page, base, 'mgr')

            # ---- 1. 建單 ----
            page.click('[data-role="module-card"][data-module="dorm"] .todo-head')  # 卡片中間是提醒列（點了會進該列的分頁），進模組要點組頭
            page.wait_for_selector('[data-role="view-nav"] .nav-item:has-text("建立合約")')
            page.click('[data-role="view-nav"] .nav-item:has-text("建立合約")')
            page.wait_for_selector('#dorm-create-name', timeout=8000)

            page.fill('#dorm-create-name', 'ｅ２ｅ測試員')
            page.select_option('#dorm-create-room', '二樓四人房')
            page.wait_for_selector('#dorm-create-bed-field:not([hidden])')
            page.select_option('#dorm-create-bed', '2號床位')
            page.fill('#dorm-create-start', '2026-09-01')
            page.click('text=建立並產生簽署連結')

            page.wait_for_selector('#dorm-create-result:not([hidden])', timeout=8000)
            sign_url = page.locator('#dorm-create-link').inner_text().strip()
            check('sign.html?t=' in sign_url, '建單成功，畫面給出簽署連結：%r' % sign_url)
            check(mock.contracts and list(mock.contracts.values())[0]['status'] == '待簽',
                  'mock 後端收到建單，狀態＝待簽')

            # ---- 2. 簽約（2026-10-18：dzy 不再保留 sign.html 副本，簽約頁在舊站 mala-dorm）----
            # 只驗簽署連結格式；「已簽署」狀態由 mock 後端直接設定，後續點交照常測。
            check(sign_url.startswith('http') and '/sign.html?t=e2e-sign-' in sign_url,
                  '簽署連結格式為 …/sign.html?t=<token>：%r' % sign_url)
            c0 = list(mock.contracts.values())[0]
            c0['status'] = '在住'
            c0['signed_at'] = '2026-08-17 10:00'

            # ---- 3. 點交（回殼內）----
            page.goto(base + '/index.html#/dorm/list')
            page.wait_for_selector('[data-role="contract-row"]', timeout=8000)
            row_text = page.locator('[data-role="contract-row"]').first.inner_text()
            check('在住' in row_text, '合約清單看得到「在住」狀態，實際：%r' % row_text[:80])

            page.click('[data-action="open-handover"]')
            # 2026-10-12：進頁不再自動建點交單，要先按「建立點交單」並確認
            page.wait_for_selector('#dorm-handover-create', timeout=8000)
            page.click('#dorm-handover-create')
            page.wait_for_selector('.dialog .btn-primary', timeout=5000)
            page.click('.dialog .btn-primary')
            page.wait_for_selector('#dorm-handover-items li', timeout=8000)
            items = page.locator('#dorm-handover-items > li')
            n = items.count()
            check(n == 7, '點交單列出簽約時點收的 7 項設備，實際：%d' % n)

            # 第一項標「異常＋未歸還」（賠 500），其餘正常＋已歸還
            first = items.nth(0)
            first.locator('button:has-text("異常")').click()
            page.locator('#dorm-handover-items > li').nth(0).locator('button:has-text("未歸還")').click()
            for i in range(1, n):
                row = page.locator('#dorm-handover-items > li').nth(i)
                row.locator('button:has-text("正常")').first.click()
                page.locator('#dorm-handover-items > li').nth(i).locator('button:has-text("已歸還")').click()

            page.check('#dorm-handover-clean')  # 清潔費 800
            total_preview = page.locator('#dorm-handover-total').inner_text()
            check('1,300' in total_preview, '賠償預覽＝500＋清潔 800＝1,300，實際：%r' % total_preview)

            draw_signature(page, '#dorm-handover-pad')
            page.click('#dorm-handover-submit')
            page.wait_for_selector('text=點交完成', timeout=8000)
            done_text = page.locator('[data-role="view-content"]').inner_text()
            check('1,300' in done_text, '點交完成畫面顯示賠償合計 1,300 元')

            # ---- 3b. 現場下載給同仁（2026-10-26）：按鈕先抓好檔，按下去下載 PDF ----
            give = page.locator('[data-act="handover-give"]')
            page.wait_for_function(
                "() => { const b = document.querySelector('[data-act=handover-give]'); return b && !b.disabled; }",
                timeout=8000)
            check('下載給同仁' in give.inner_text(), '點交完成後出現「下載給同仁（PDF）」，實際：%r' % give.inner_text())
            with page.expect_download(timeout=8000) as dl_info:
                give.click()
            dl = dl_info.value
            check(dl.suggested_filename.endswith('.pdf'), '下載的檔名是 PDF：%r' % dl.suggested_filename)
            with open(dl.path(), 'rb') as fh:
                check(fh.read(5) == b'%PDF-', '下載內容是 PDF 檔頭')

            # ---- 4. 收尾：清單狀態變「已退宿」 ----
            page.click('[data-role="view-nav"] .nav-item:has-text("合約清單")')
            page.wait_for_selector('[data-role="contract-row"]', timeout=8000)
            row_text2 = page.locator('[data-role="contract-row"]').first.inner_text()
            check('已退宿' in row_text2, '點交後合約狀態變「已退宿」，實際：%r' % row_text2[:80])

            browser.close()
        check(mock.leaked == [], '真實網路零流出（正式試算表一筆沒碰）：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
