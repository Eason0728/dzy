#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑩：組織架構改版前端（docs/org/task.md T5／T6）。全部代稱、全程 mock 後端、零真實網路。

mock 形狀照 apps-script/platform/Staff.gs：list 的 extra_depts／extra_dept_names／flags；
orgUpgrade2026（dryrun 預覽：titles 帶 from_name／to_name、clock 可為 custom）；
orgRollback2026（成功回 restored／clock_restored／titles_restored／titles_skipped／orphans；被拒回 ok:false 帶 diff）。
① admin 看得到「切換組織」「退回組織」，人資看不到　② 名單標籤、兼任文字、「需處理」篩選
③ 改資料兼任區　④ 切換組織（預覽→取消→確定）　⑤ 退回組織（取消→報告→被拒差異）　⑥ 我的資料兼任
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, USERS, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8798


class Mock10(MockBackend):
    ORG = {
        'brands': [{'code': 'dzy', 'name': '鼎兆元'}, {'code': 'ck', 'name': '中央工廠'}],
        'units': [{'code': 'dzy-hq', 'name': '鼎兆元總部', 'parent': 'dzy', 'ladder': 'hq'},
                  {'code': 'ck', 'name': '中央工廠（央廚）', 'parent': 'ck', 'ladder': 'store'}],
        'depts': [{'code': 'it', 'name': '資訊部', 'parent': 'dzy-hq'}, {'code': 'training', 'name': '訓練部', 'parent': 'dzy-hq'},
                  {'code': 'ops', 'name': '營運部', 'parent': 'dzy-hq'}, {'code': 'zzz', 'name': '別處部門', 'parent': 'other-hq'}],
        'titles': [{'code': 'hs', 'name': '部門同仁', 'parent': 'hq', 'rank': 1}, {'code': 'pt', 'name': '計時同仁', 'parent': 'store', 'rank': 1}],
    }
    DEPT_NAME = {'it': '資訊部', 'training': '訓練部', 'ops': '營運部', 'ck': '中央工廠'}

    def __init__(self, base):
        super().__init__(base)
        USERS['hr'] = {'password': 'e2e-hr', 'perms': ['platform.self', 'platform.staff'], 'user': {'id': 'u-hr', 'name': '人資代稱', 'role': 'hr', 'node': ''}}
        for emp, nm in (('DZY001', '測試甲'), ('DZY003', '測試丙')):
            USERS[emp] = {'password': 'e2e-pw-' + emp, 'perms': ['platform.self'], 'user': {'id': 'u-' + emp, 'name': nm, 'role': 'staff', 'node': ''}}
        base_row = lambda emp, nm, **kw: dict({'emp_no': emp, 'name': nm, 'status': 'active', 'brand': 'dzy', 'unit': 'dzy-hq', 'dept': 'it', 'title': 'hs',
                                               'phone': '0911000%03d' % int(emp[3:]), 'birthday': '1990-01-01', 'address': '測試路1號', 'extra': ['training'], 'flags': []}, **kw)
        self.staff = [base_row('DZY001', '測試甲'),
                      base_row('DZY002', '測試乙', unit='mala-old', brand='mala', dept='', title='sv', extra=[], flags=['unit_inactive', 'title_ladder', 'dept_inactive']),
                      base_row('DZY003', '測試丙', extra=[])]
        self.log10 = []
        self.edits = []
        self.upgrades = []
        self.rollbacks = 0
        self.tamper = False

    def obj(self, r):
        o = self._staff_obj(r)
        names = {'mala-old': '舊店（已停用）'}
        if r['unit'] in names:
            o['unit_name'] = names[r['unit']]
        o['title_name'] = {'sv': '督導'}.get(r['title'], o['title_name'])
        o['brand_name'] = o['brand_name'] or {'mala': '麻的小辛辣'}.get(r['brand'], '')
        o['dept_name'] = self._org_name('dept', r['dept'])
        o['extra_depts'] = list(r['extra'])
        o['extra_dept_names'] = [self.DEPT_NAME[c] for c in r['extra']]
        o['flags'] = list(r['flags'])
        return o

    def staff_action(self, action, body):
        p = body.get('payload') or {}
        who = (body.get('token') or '').replace('e2e-token-', '')
        perms = USERS.get(who, {}).get('perms', [])
        role = USERS.get(who, {}).get('user', {}).get('role')
        staff_ok = '*' in perms or 'platform.staff' in perms
        if action in ('staffList', 'staffEdit', 'orgUpgrade2026', 'orgRollback2026'):
            self.log10.append(action)
        if action == 'staffList':
            return {'ok': True, 'data': {'staff': [self.obj(r) for r in self.staff]}} if staff_ok else {'ok': False, 'error': '沒有權限'}
        if action == 'staffEdit':
            self.edits.append(p)
            r = next(x for x in self.staff if x['emp_no'] == p['emp_no'])
            if 'extra_depts' in p:
                if not staff_ok:
                    return {'ok': False, 'error': '沒有權限修改兼任部門'}
                r['extra'] = [c for c in p['extra_depts']]
            return {'ok': True, 'data': {'staff': self.obj(r)}}
        if action in ('orgUpgrade2026', 'orgRollback2026') and role != 'admin':
            return {'ok': False, 'error': '沒有權限'}
        if action == 'orgUpgrade2026':
            self.upgrades.append(bool(p.get('dryrun')))
            return {'ok': True, 'data': {
                'dryrun': bool(p.get('dryrun')), 'backup': 'created', 'clock': 'custom', 'staffColumn': 'added',
                'org': [{'code': 'ck', 'kind': 'brand', 'field': 'name', 'from': '央廚', 'to': '中央工廠'}, {'code': 'yiwu-hq', 'kind': 'unit', 'field': 'row', 'from': '', 'to': 'added'}],
                'titles': [{'emp_no': 'DZY010', 'name': '測試丁', 'from': 'hs', 'to': 'ofs', 'from_name': '部門同仁', 'to_name': '行政同仁'}],
                'todo': [{'emp_no': 'DZY002', 'name': '測試乙', 'unit_name': '舊店（已停用）', 'flag': 'title_ladder', 'submitted': False}, {'emp_no': 'DZY002', 'name': '測試乙', 'unit_name': '舊店（已停用）', 'flag': 'dept_inactive', 'submitted': True}]}}
        if action == 'orgRollback2026':
            self.rollbacks += 1
            if self.tamper:
                return {'ok': False, 'error': '切換後組織資料又被改過，為避免蓋掉新的修改，拒絕整表覆蓋；差異已列出',
                        'data': {'diff': [{'kind': 'unit', 'code': 'ck', 'field': 'name', 'expected': '中央工廠（央廚）', 'actual': '央廚改名測試'}],
                                'clock_diff': [{'key': 'hq', 'field': 'unit_code', 'expected': 'dzy-hq', 'actual': 'yiwu-x-hq'}]}}
            return {'ok': True, 'data': {'restored': 41, 'clock_restored': True, 'titles_restored': 2, 'titles_skipped': ['DZY777'],
                                          'orphans': [{'emp_no': 'DZY002', 'name': '測試乙', 'unit': 'mala-old', 'dept': 'olddept', 'title': 'sv'}], 'backup': 'org_bak_202610141200'}}
        if action == 'myProfile':
            r = next((x for x in self.staff if x['emp_no'] == who), None)
            return {'ok': True, 'data': self.obj(r)} if r else {'ok': True, 'data': {'none': True}}
        return super().staff_action(action, body)


def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, 't10_' + name + '.png'), full_page=True)


def main():
    httpd, base = start_server(PORT)
    mock = Mock10(base)
    os.makedirs(SHOTS, exist_ok=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def open_as(user, pw, route, width=1280):
                pg = browser.new_context(viewport={'width': width, 'height': 900}).new_page()
                mock.install(pg)
                pg.goto(base + '/index.html')
                pg.fill('#login-username', user)
                pg.fill('#login-password', pw)
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
                pg.goto(base + '/index.html#' + route)
                return pg

            # ① 人資看不到按鈕
            hr = open_as('hr', 'e2e-hr', '/staff/list')
            hr.wait_for_selector('[data-role="rows"] tr:has-text("DZY001")')
            check(hr.locator('[data-role="org-upgrade"]').count() == 0 and hr.locator('[data-role="org-rollback"]').count() == 0, '★人資（非 admin）看不到「切換組織」「退回組織」')
            check(hr.locator('[data-role="add-staff"]').count() == 1, '人資仍有「新增同仁」（其他功能沒被拿掉）')

            # ② 名單
            ad = open_as('admin', 'e2e-admin', '/staff/list')
            ad.wait_for_selector('[data-role="rows"] tr:has-text("DZY001")')
            check(ad.locator('[data-role="org-upgrade"]:has-text("切換組織")').count() == 1 and ad.locator('[data-role="org-rollback"]:has-text("退回組織")').count() == 1, '★admin 看得到兩顆按鈕')
            r1 = ad.inner_text('[data-role="rows"] tr:has-text("DZY001")')
            check('兼任：訓練部' in r1, '有兼任的人顯示「兼任：訓練部」')
            r2 = ad.inner_text('[data-role="rows"] tr:has-text("DZY002")')
            check('所屬門市已停用' in r2 and '職稱需重選' in r2 and '部門已停用' in r2, '★flags 標籤：所屬門市已停用／職稱需重選')
            check('所屬門市已停用' not in ad.inner_text('[data-role="rows"] tr:has-text("DZY003")'), '沒 flags 的人沒有標籤')
            shot(ad, 'list_tags_extra')
            ad.select_option('#stf-f', 'flags')
            check(ad.locator('[data-role="rows"] tr:has-text("DZY002")').count() == 1 and ad.locator('[data-role="rows"] tr:has-text("DZY001")').count() == 0, '★「需處理」篩選只留 flags 非空的人')
            ad.select_option('#stf-f', 'all')

            # ③ 改資料兼任區
            row1 = '[data-role="rows"] tr:has-text("DZY001")'
            ad.click(row1 + ' [data-act="edit"]')
            ad.wait_for_selector('#ed-name')
            check(ad.locator('[data-code="it"]').count() == 0, '★兼任區排除主要部門（資訊部）')
            check(ad.locator('[data-code="ops"]').count() == 1 and ad.locator('[data-code="ck"]').count() == 1 and ad.locator('[data-code="zzz"]').count() == 0, '有營運部與中央工廠，不列別單位的部門')
            check(ad.is_checked('[data-code="training"]') and not ad.is_checked('[data-code="ops"]'), '目前兼任（訓練部）預先勾選')
            shot(ad, 'edit_dialog')
            ad.click('.dialog .btn-primary:has-text("儲存")')
            ad.wait_for_function("() => !document.querySelector('.dialog')")
            ad.wait_for_timeout(300)
            check(len(mock.edits) == 1 and 'extra_depts' not in mock.edits[0], '★兼任沒動 → staffEdit 不帶 extra_depts：%s' % mock.edits[-1:])
            ad.click(row1 + ' [data-act="edit"]')
            ad.wait_for_selector('[data-code="ops"]')
            ad.check('[data-code="ops"]')
            ad.click('.dialog .btn-primary:has-text("儲存")')
            ad.wait_for_function("() => document.querySelector('[data-role=\"rows\"]').innerText.includes('訓練部、營運部')")
            check(mock.edits[-1].get('extra_depts') == ['training', 'ops'], '★勾選營運部 → 帶 extra_depts=[training, ops]：%s' % mock.edits[-1].get('extra_depts'))
            check('兼任：訓練部、營運部' in ad.inner_text(row1), '儲存後名單兼任文字更新')

            # ④ 切換組織
            ad.click('[data-role="org-upgrade"]')
            ad.wait_for_selector('.dialog:has-text("預覽")')
            pv = ad.inner_text('.dialog')
            check(mock.upgrades == [True], '★按「切換組織」先送 dryrun:true：%s' % mock.upgrades)
            check('測試丁' in pv and '部門同仁' in pv and '行政同仁' in pv, '預覽逐人列 姓名：從→到')
            check('（送出待審的資料）' in pv and '測試乙' in pv and '職稱需重選' in pv and '自訂' in pv and 'yiwu-hq' in pv, '預覽有需處理名單、打卡對照狀態、組織表變更')
            shot(ad, 'upgrade_preview')
            ad.click('.dialog .btn:has-text("取消")')
            ad.wait_for_function("() => !document.querySelector('.dialog')")
            ad.wait_for_timeout(300)
            check(mock.upgrades == [True], '★取消 → 只有那一次請求（沒有 dryrun:false）')
            lists_before = mock.log10.count('staffList')
            ad.click('[data-role="org-upgrade"]')
            ad.wait_for_selector('.dialog:has-text("預覽")')
            ad.click('.dialog .btn:has-text("確定切換")')
            ad.wait_for_selector('.dialog:has-text("已切換完成")')
            check(mock.upgrades == [True, True, False], '★確定切換 → 再送 dryrun:false：%s' % mock.upgrades)
            shot(ad, 'upgrade_report')
            ad.click('.dialog .btn:has-text("知道了")')
            ad.wait_for_function("() => !document.querySelector('.dialog')")
            ad.wait_for_timeout(300)
            check(mock.log10.count('staffList') == lists_before + 1, '★完成後重新載入名單')

            # ⑤ 退回組織
            ad.click('[data-role="org-rollback"]')
            ad.wait_for_selector('.dialog')
            ad.click('.dialog .btn:has-text("取消")')
            ad.wait_for_timeout(300)
            check(mock.rollbacks == 0, '★退回：確認框按取消 → 零請求')
            ad.click('[data-role="org-rollback"]')
            ad.wait_for_selector('.dialog')
            ad.click('.dialog .btn-primary:has-text("確定")')
            ad.wait_for_selector('.dialog:has-text("組織已退回")')
            rb = ad.inner_text('.dialog')
            check(mock.rollbacks == 1 and '41' in rb and 'DZY777' in rb and '測試乙' in rb and '孤兒' in rb and 'olddept' in rb, '★退回報告：還原列數／略過／孤兒名單')
            shot(ad, 'rollback_report')
            ad.click('.dialog .btn:has-text("知道了")')
            ad.wait_for_function("() => !document.querySelector('.dialog')")
            mock.tamper = True
            ad.click('[data-role="org-rollback"]')
            ad.wait_for_selector('.dialog')
            ad.click('.dialog .btn-primary:has-text("確定")')
            ad.wait_for_selector('.dialog:has-text("拒絕整表覆蓋")')
            df = ad.inner_text('.dialog')
            check('打卡對照差異' in df and 'yiwu-x-hq' in df and df.index('組織表差異') < df.index('打卡對照差異') and '央廚改名測試' in df and '中央工廠（央廚）' in df and 'name' in df, '★退回被拒 → 顯示原因與差異表')
            shot(ad, 'rollback_diff')
            ad.click('.dialog .btn:has-text("知道了")')

            # ⑥ 我的資料
            m1 = open_as('DZY001', 'e2e-pw-DZY001', '/me/profile')
            m1.wait_for_selector('[data-role="extra-depts"]')
            check('兼任：訓練部、營運部' in m1.inner_text('[data-role="extra-depts"]'), '★我的資料顯示「兼任：訓練部、營運部」')
            check(m1.locator('input[id*="extra"], #me-x-it').count() == 0, '唯讀（沒有可編輯欄位）')
            shot(m1, 'profile_extra')
            m2 = open_as('DZY003', 'e2e-pw-DZY003', '/me/profile')
            m2.wait_for_selector('.card-title')
            m2.wait_for_timeout(300)
            check(m2.locator('[data-role="extra-depts"]').count() == 0 and '兼任' not in m2.inner_text('[data-role="view-content"]'), '★沒有兼任就不顯示')
            shot(m2, 'profile_none')
            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
