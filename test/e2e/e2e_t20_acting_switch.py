#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑳：兼任店長「我的單位」門市切換（docs/acting-unitstaff/requirements.md，Eason 1A 2A）。全部假名、全程 mock 後端。

① 光復店長兼任台中美村：「我的單位」上方有門市切換（兩家）→ 預設光復名單；切到美村 → 美村名單、標題換店名；
   在美村按「新增同仁」→ 固定單位顯示台中美村、送出的 unit＝mzt-ml → 名單出現新人。
② 只管一家的店長：沒有門市切換。
（375 與 1280 寬各截一張）
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import SHOTS, USERS, check, finish, start_server
from e2e_t9_staff_master import Mock9, TODAY

from playwright.sync_api import sync_playwright

PORT = 8850


class Mock20(Mock9):
    """Mock9＋兼任：DZY010（光復店長）另外兼任 mzt-ml；staffUnitList 依 payload.unit 切店、回 units。"""

    def __init__(self, base):
        super().__init__(base)
        mk = lambda n, name, unit, title: {'emp_no': 'DZY%03d' % n, 'name': name, 'status': 'active', 'unit': unit, 'brand': 'mzt',
                                           'title': title, 'hire_date': '2026-01-05', 'last_day': '', 'phone': '0912000%03d' % n}
        self.staff += [mk(40, '美村甲', 'mzt-ml', 'pt'), mk(41, '美村乙', 'mzt-ml', 'ft')]
        self.acting = {'DZY010': ['mzt-ml']}
        self.creates = []

    def units_of(self, me):
        names = {u['code']: u['name'] for u in self.ORG['units']}
        codes = [me['unit']] + self.acting.get(me['emp_no'], [])
        return [{'code': c, 'name': names.get(c, c)} for c in codes]

    def pick(self, me, p):
        codes = [u['code'] for u in self.units_of(me)]
        return p.get('unit') if p.get('unit') in codes else codes[0]

    def a_staffUnitList(self, p, hq, me, lead):
        if hq:
            return super().a_staffUnitList(p, hq, me, lead)
        unit = self.pick(me, p)
        r = super().a_staffUnitList({'unit': unit}, True, me, False)
        units = self.units_of(me)
        r['data'].update({'unit': unit, 'unit_name': next(u['name'] for u in units if u['code'] == unit), 'units': units})
        return r

    def a_staffCreateByUnit(self, p, hq, me, lead):
        self.creates.append(dict(p))
        if hq:
            return super().a_staffCreateByUnit(p, hq, me, lead)
        return super().a_staffCreateByUnit(dict(p, unit=self.pick(me, p)), True, me, False)


def main():
    httpd, base = start_server(PORT)
    mock = Mock20(base)
    os.makedirs(SHOTS, exist_ok=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def lead_page(width):
                pg = browser.new_context(viewport={'width': width, 'height': 900}).new_page()
                mock.install(pg)
                pg.goto(base + '/index.html')
                pg.fill('#login-username', 'DZY010')
                pg.fill('#login-password', 'e2e-lead-pw-10')
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
                pg.goto(base + '/index.html#/me/team')
                pg.wait_for_selector('[data-role="team-row"]')
                return pg

            for width in (1280, 375):
                pg = lead_page(width)
                sw = pg.locator('[data-role="unit-switch"]')
                check(sw.count() == 1 and sw.locator('option').count() == 2, '①%d ★管兩家 → 有門市切換、兩個選項' % width)
                rows = pg.locator('[data-role="team-row"]').count()
                check(rows == 4 and '新竹光復' in pg.inner_text('.card-title >> nth=0'), '①%d 預設本店（光復 4 人）：%d' % (width, rows))
                pg.select_option('[data-role="unit-switch"]', 'mzt-ml')
                pg.wait_for_selector('[data-role="team-row"][data-emp="DZY040"]')
                rows = pg.locator('[data-role="team-row"]').count()
                check(rows == 2 and '台中美村' in pg.inner_text('.card-title >> nth=0'), '①%d ★切到美村 → 美村 2 人、標題換店名：%d' % (width, rows))
                check(pg.locator('[data-role="unit-switch"]').input_value() == 'mzt-ml', '①%d 切換停在美村' % width)
                pg.screenshot(path=os.path.join(SHOTS, 't20_switch_%d.png' % width), full_page=True)
                pg.context.close()

            # 在美村新增
            pg = lead_page(1280)
            pg.select_option('[data-role="unit-switch"]', 'mzt-ml')
            pg.wait_for_selector('[data-role="team-row"][data-emp="DZY040"]')
            pg.click('[data-role="add-staff"]')
            pg.wait_for_selector('#ad-name')
            check('台中美村' in pg.inner_text('[data-role="fixed-unit"]'), '① ★新增視窗固定單位＝台中美村')
            pg.fill('#ad-name', '美村新人')
            pg.select_option('#ad-title', 'pt')
            pg.fill('#ad-hire', str(TODAY))
            pg.fill('#ad-phone', '0912000555')
            pg.click('.dialog .btn-primary:has-text("送出")')
            pg.wait_for_function('() => document.querySelector(".dialog") && /已建立/.test(document.querySelector(".dialog").innerText)', timeout=15000)
            check(mock.creates and mock.creates[-1].get('unit') == 'mzt-ml', '① ★送出帶 unit＝mzt-ml：%s' % (mock.creates[-1] if mock.creates else None))
            pg.context.close()

            # ② 只管一家
            mock.acting = {}
            pg = lead_page(1280)
            check(pg.locator('[data-role="unit-switch"]').count() == 0, '② ★只管一家 → 沒有門市切換')
            pg.context.close()
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
