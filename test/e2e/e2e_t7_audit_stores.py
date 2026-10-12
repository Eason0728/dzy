#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑦：月初盤點抽查「門市管理」分頁（2026-09-28）。

- 會計看得到「門市管理」分頁；店長看不到
- 新增門市 → 清單多一家、送出的 action/payload 正確；兩個稽核模組的店別都讀得到新店
- 停用 → 標「停用中」、總覽不再出現；重新啟用 → 回來
mock 後端照 ~/mala-audit/apps-script/Code.gs 的 addStore／setStoreStatus 行為做成有狀態的。
"""
import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import AUDIT_SECRET, MockBackend, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8797


class StoresMock(MockBackend):
    def __init__(self, base_url):
        super().__init__(base_url)
        cfg = self.audit_fixture['config']
        self.stores = [{'code': s['code'], 'name': s['name'], 'tab': s['name'], 'active': True}
                       for s in sorted(cfg['stores'], key=lambda s: s['order'])]
        self.writes = []

    def _getall(self):
        data = copy.deepcopy(self.audit_fixture)
        active = [s for s in self.stores if s['active']]
        data['config']['stores'] = [{'code': s['code'], 'name': s['name'], 'order': i + 1}
                                    for i, s in enumerate(active)]
        data['config']['all_stores'] = [dict(s, order=i + 1) for i, s in enumerate(self.stores)]
        return data

    def dispatch(self, backend, body):
        if backend == 'audit' and body.get('code') == AUDIT_SECRET:
            action = body.get('action')
            if action == 'getAll':
                self.calls.append((backend, action))
                return self._getall()
            if action == 'addStore':
                self.calls.append((backend, action))
                self.writes.append(body)
                code = 'st-%02d' % (1 + sum(1 for s in self.stores if s['code'].startswith('st-')))
                self.stores.append({'code': code, 'name': body['name'], 'tab': body['name'], 'active': True})
                return {'ok': True, 'store': {'code': code, 'name': body['name']}}
            if action == 'renameStore':
                self.calls.append((backend, action))
                self.writes.append(body)
                for s in self.stores:
                    if s['code'] == body['store']:
                        s['name'] = body['name']
                return {'ok': True, 'tab_renamed': True}
            if action == 'setStoreStatus':
                self.calls.append((backend, action))
                self.writes.append(body)
                for s in self.stores:
                    if s['code'] == body['store']:
                        s['active'] = body['status'] == '啟用'
                return {'ok': True}
        return super().dispatch(backend, body)


def confirm_dialog(page):
    page.wait_for_selector('.dialog .btn-primary', timeout=5000)
    page.click('.dialog .btn-primary')


def main():
    httpd, base = start_server(PORT)
    mock = StoresMock(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_context(viewport={'width': 1280, 'height': 800}).new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            mock.install(page)
            login(page, base, 'acct')

            page.click('[data-role="module-card"][data-module="audit-stock"] .todo-head')  # 卡片中間是提醒列（點了會進該列的分頁），進模組要點組頭
            page.wait_for_selector('[data-role="view-nav"] .nav-item')
            tabs = page.locator('[data-role="view-nav"] .nav-item').all_inner_texts()
            check('門市管理' in tabs, '會計看得到「門市管理」分頁，實際：%s' % tabs)

            page.locator('[data-role="view-nav"] .nav-item', has_text='門市管理').click()
            page.wait_for_selector('#store-list tbody tr', timeout=8000)
            check(page.locator('#store-list tbody tr').count() == 5, '門市清單列出五家')

            # 新增
            page.fill('#store-new-name', '測試新店')
            page.click('#store-add-btn')
            confirm_dialog(page)
            page.wait_for_selector('#store-list tr[data-store="st-01"]', timeout=8000)
            check(page.locator('#store-list tbody tr').count() == 6, '新增後清單變六家')
            w = mock.writes[-1]
            check(w.get('action') == 'addStore' and w.get('name') == '測試新店' and w.get('code') == AUDIT_SECRET,
                  'addStore 送出格式正確（action/name/通行碼由平台帶），實際：%s' % w)

            # 改名
            page.click('#store-list tr[data-store="st-01"] .store-rename')
            page.wait_for_selector('#store-rename-input', timeout=5000)
            page.fill('#store-rename-input', '測試新店竹北')
            page.click('.dialog .btn-primary')
            page.wait_for_selector('#store-list tr[data-store="st-01"] >> text=測試新店竹北', timeout=8000)
            w = mock.writes[-1]
            check(w.get('action') == 'renameStore' and w.get('store') == 'st-01' and w.get('name') == '測試新店竹北',
                  'renameStore 送出格式正確，實際：%s' % w)

            # 停用央廚
            page.click('#store-list tr[data-store="ck"] .store-toggle')
            confirm_dialog(page)
            page.wait_for_selector('#store-list tr[data-store="ck"] .tag-danger', timeout=8000)
            check(True, '停用後央廚標「停用中」')
            w = mock.writes[-1]
            check(w.get('action') == 'setStoreStatus' and w.get('store') == 'ck' and w.get('status') == '停用',
                  'setStoreStatus 送出格式正確，實際：%s' % w)

            # 總覽：新店在、央廚不在
            page.locator('[data-role="view-nav"] .nav-item', has_text='總覽').click()
            page.wait_for_selector('#store-list', state='detached', timeout=8000)
            page.wait_for_selector('[data-role="view-content"] >> text=測試新店竹北', timeout=8000)
            content = page.locator('[data-role="view-content"]').inner_text()
            check('測試新店竹北' in content and '央廚' not in content, '盤點總覽：有新店、沒有停用的央廚')

            # 營運稽核表也讀到新清單（共用快取已 invalidate）
            page.evaluate("() => { window.location.hash = '#/audit-ops/overview'; }")
            page.wait_for_selector('text=測試新店竹北', timeout=8000)
            check(True, '營運稽核總覽也出現新店（改名後的名稱）')

            # 重新啟用
            page.evaluate("() => { window.location.hash = '#/audit-stock/stores'; }")
            page.wait_for_selector('#store-list tr[data-store="ck"] .store-toggle', timeout=8000)
            page.click('#store-list tr[data-store="ck"] .store-toggle')
            confirm_dialog(page)
            page.wait_for_function(
                "() => { const r = document.querySelector('#store-list tr[data-store=\"ck\"]');"
                " return r && !r.querySelector('.tag-danger'); }", timeout=8000)
            check(True, '重新啟用後央廚不再標停用中')
            page.screenshot(path=os.path.join(os.path.dirname(__file__), 'shots', 't7_stores.png'), full_page=True)

            check(page.locator('.store-rename').count() == 6, '每家店都有改名鈕')
            check(not mock.leaked, '沒有請求漏出 mock：%s' % mock.leaked)
            check(not errors, '頁面無 JS 錯誤：%s' % errors[:3])

            # 店長看不到
            page2 = browser.new_context(viewport={'width': 375, 'height': 800}).new_page()
            mock.install(page2)
            login(page2, base, 'lead')
            page2.click('[data-role="module-card"][data-module="audit-stock"] .todo-head')  # 卡片中間是提醒列（點了會進該列的分頁），進模組要點組頭
            page2.wait_for_selector('[data-role="view-nav"] .nav-item')
            tabs2 = page2.locator('[data-role="view-nav"] .nav-item').all_inner_texts()
            check('門市管理' not in tabs2, '店長沒有「門市管理」分頁，實際：%s' % tabs2)

            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
