#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑮：區域（督導負責區）前端（docs/regions/spec.md 第 4、7、8 節）。全部代稱、全程 mock 後端、零真實網路。

mock 形狀照 apps-script/platform/Regions.gs：regionList {regions, idx, flags, ver, on, candidates}、
regionSave {region, expected_ver, preview?} → preview 回 {diff:[{emp_no,name,gained,lost}]}／衝突回 ok:false code conflict、
regionCheck {on, stores_no_region, regions_no_supervisor, no_director, pending_moves, att_pending_note, warn}、regionSwitch {on}；
myUnit 多 regions（Staff.gs handleMyUnit_，只有姓名、職稱、手機）。
① 人資開「區域」：三個品牌塊、尚未劃區、切換檢查、看不到開關按鈕　② 新增一區、勾店、選督導 → preview 對話框 → 存檔
③ ver 衝突 → 「資料已被別人改過，請重新整理」　④ admin 看得到開始按鈕＋紅字警告，確認框文字 → regionSwitch
⑤ 督導：單位通訊錄有「我的區域」，超過 30 人的店收合、沒有生日地址　⑥ 375px 無橫向捲動　⑦ 首頁提醒
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, USERS, check, finish, start_server
from e2e_t12_mobile_width import overflow

from playwright.sync_api import sync_playwright

PORT = 8821
NOTE = '考勤申請的待審在門市營運系統，請到營運系統確認'


class Mock15(MockBackend):
    ORG = {
        'brands': [{'code': 'mzt', 'name': '墨竹亭'}, {'code': 'mala', 'name': '麻的小辛辣'}, {'code': 'yiwu', 'name': '一悟燒肉'}, {'code': 'dzy', 'name': '鼎兆元'}],
        'units': [{'code': 'mzt-a', 'name': '墨竹測試甲店', 'parent': 'mzt', 'ladder': 'store'},
                  {'code': 'mzt-b', 'name': '墨竹測試乙店', 'parent': 'mzt', 'ladder': 'store'},
                  {'code': 'mala-a', 'name': '小辛測試甲店', 'parent': 'mala', 'ladder': 'store'},
                  {'code': 'mala-b', 'name': '小辛測試乙店超級長的分店名稱', 'parent': 'mala', 'ladder': 'store'},
                  {'code': 'mala-c', 'name': '小辛測試丙店', 'parent': 'mala', 'ladder': 'store'},
                  {'code': 'mala-office', 'name': '小辛辣品牌辦公室', 'parent': 'mala', 'ladder': 'office'},
                  {'code': 'yiwu-a', 'name': '一悟測試甲店', 'parent': 'yiwu', 'ladder': 'store'},
                  {'code': 'dzy-hq', 'name': '鼎兆元總部', 'parent': 'dzy', 'ladder': 'hq'}],
        'depts': [],
        'titles': [{'code': 'pt', 'name': '計時同仁', 'parent': 'store', 'rank': 1}, {'code': 'sm', 'name': '店長', 'parent': 'store', 'rank': 3},
                   {'code': 'osv', 'name': '區督導', 'parent': 'office', 'rank': 3}],
    }

    def __init__(self, base):
        super().__init__(base)
        USERS['hr'] = {'password': 'e2e-hr', 'perms': ['platform.self', 'platform.staff'], 'user': {'id': 'u-hr', 'name': '人資代稱', 'role': 'hr', 'node': ''}}
        USERS['DZY101'] = {'password': 'e2e-sup', 'perms': ['platform.self'], 'user': {'id': 'u-DZY101', 'name': '督導甲', 'role': 'staff', 'node': ''}}
        self.staff = []
        row = lambda emp, nm, unit, title, **kw: dict({'emp_no': emp, 'name': nm, 'status': 'active', 'brand': unit.split('-')[0], 'unit': unit, 'title': title,
                                                       'phone': '0911%06d' % int(emp[3:]), 'birthday': '1990-01-01', 'address': '測試路1號'}, **kw)
        self.staff.append(row('DZY101', '督導甲', 'mala-office', 'osv'))
        self.staff.append(row('DZY102', '督導乙', 'mala-office', 'osv'))
        self.staff.append(row('DZY201', '店長丙', 'mala-a', 'sm'))
        self.staff.append(row('DZY202', '同仁丁', 'mala-a', 'pt', phone=''))
        for i in range(31):  # 超過 30 人的店（預設收合）
            self.staff.append(row('DZY%03d' % (300 + i), '同仁%d號' % i, 'mala-b', 'pt'))
        self.regions = [{'code': 'r-mzt-1', 'name': '北區', 'brand': 'mzt', 'stores': ['mzt-a'], 'supervisor': '', 'active': True}]
        self.ver = 1
        self.on = False
        self.reg_calls = []
        self.saved = []
        self.switches = []

    def uname(self, code):
        return self._org_name('unit', code)

    def sup_stores(self):
        out = {}
        for g in self.regions:
            if g['active'] and g['supervisor']:
                out.setdefault(g['supervisor'], set()).update(g['stores'])
        return out

    def flags(self):
        used = set(s for g in self.regions if g['active'] for s in g['stores'])
        stores = [u for u in self.ORG['units'] if u['ladder'] == 'store']
        return {'region_no_supervisor': [{'code': g['code'], 'name': g['name'], 'brand': g['brand'], 'reason': 'empty'} for g in self.regions if g['active'] and not g['supervisor']],
                'region_store_inactive': [],
                'store_no_region': [{'unit': u['code'], 'unit_name': u['name'], 'brand': u['parent']} for u in stores if u['code'] not in used]}

    def staff_action(self, action, body):
        p = body.get('payload') or {}
        who = (body.get('token') or '').replace('e2e-token-', '')
        perms = USERS.get(who, {}).get('perms', [])
        staff_ok = '*' in perms or 'platform.staff' in perms
        if action.startswith('region'):
            self.reg_calls.append((action, json.loads(json.dumps(p))))
            if not staff_ok:
                return {'ok': False, 'error': '沒有權限'}
        if action == 'regionList':
            cands = [{'emp_no': r['emp_no'], 'name': r['name'], 'unit': r['unit'], 'unit_name': self.uname(r['unit']), 'brand': 'mala'} for r in self.staff if r['title'] == 'osv']
            return {'ok': True, 'data': {'regions': [dict(g) for g in self.regions], 'idx': {}, 'flags': self.flags(), 'ver': 'v%d' % self.ver, 'on': self.on, 'candidates': cands}}
        if action == 'regionCheck':
            f = self.flags()
            by = {}
            for s in f['store_no_region']:
                by.setdefault(s['brand'], []).append({'unit': s['unit'], 'unit_name': s['unit_name']})
            return {'ok': True, 'data': {'on': self.on, 'stores_no_region': [{'brand': b['code'], 'brand_name': b['name'], 'stores': by[b['code']]} for b in self.ORG['brands'] if b['code'] in by],
                                         'regions_no_supervisor': f['region_no_supervisor'], 'no_director': [],
                                         'pending_moves': [{'unit': 'mala-a', 'unit_name': '小辛測試甲店', 'count': 2, 'supervisors': ['DZY102']}],
                                         'att_pending_note': NOTE, 'warn': bool(f['store_no_region'] or f['region_no_supervisor'])}}
        if action == 'regionSave':
            if p.get('expected_ver') != 'v%d' % self.ver:
                return {'ok': False, 'error': '區域設定剛被別人改過，請重新整理再改', 'code': 'conflict'}
            src = p['region']
            before = self.sup_stores()
            new = {'code': src.get('code') or 'r-%s-%d' % (src['brand'], len(self.regions) + 1), 'name': src['name'], 'brand': src['brand'],
                   'stores': list(src.get('stores') or []), 'supervisor': src.get('supervisor') or '', 'active': src.get('active') is not False}
            after_regions = [g for g in self.regions if g['code'] != new['code']] + [new]
            saved, self.regions = self.regions, after_regions
            after = self.sup_stores()
            self.regions = saved
            diff = []
            for emp in sorted(set(before) | set(after)):
                g = sorted(after.get(emp, set()) - before.get(emp, set()))
                l = sorted(before.get(emp, set()) - after.get(emp, set()))
                if g or l:
                    nm = next((r['name'] for r in self.staff if r['emp_no'] == emp), '')
                    diff.append({'emp_no': emp, 'name': nm, 'gained': [{'unit': s, 'unit_name': self.uname(s)} for s in g], 'lost': [{'unit': s, 'unit_name': self.uname(s)} for s in l]})
            if p.get('preview') is True:
                return {'ok': True, 'data': {'preview': True, 'region': new, 'diff': diff}}
            self.regions = after_regions
            self.ver += 1
            self.saved.append(new)
            return {'ok': True, 'data': {'region': new, 'diff': diff, 'ver': 'v%d' % self.ver}}
        if action == 'regionSwitch':
            if USERS.get(who, {}).get('user', {}).get('role') != 'admin':
                return {'ok': False, 'error': '只有系統管理者可以切換依區域審核', 'code': 'forbidden'}
            self.on = p.get('on') is True
            self.switches.append(self.on)
            return {'ok': True, 'data': {'on': self.on}}
        if action == 'myUnit' and who == 'DZY101':
            me = next(r for r in self.staff if r['emp_no'] == who)
            pick = lambda r: {'emp_no': r['emp_no'], 'name': r['name'], 'title': r['title'], 'title_name': self._org_name('title', r['title']), 'phone': r['phone']}
            office = [pick(r) for r in self.staff if r['unit'] == me['unit']]
            regs = [{'code': g['code'], 'name': g['name'], 'stores': [{'unit': s, 'unit_name': self.uname(s), 'people': [pick(r) for r in self.staff if r['unit'] == s]} for s in g['stores']]}
                    for g in self.regions if g['active'] and g['supervisor'] == who]
            return {'ok': True, 'data': {'unit_name': self.uname(me['unit']), 'private': False, 'people': office, 'regions': regs}}
        if action == 'staffList':
            return {'ok': True, 'data': {'staff': [self._staff_obj(r) for r in self.staff]}} if staff_ok else {'ok': False, 'error': '沒有權限'}
        if action == 'clockAlerts':
            return {'ok': True, 'data': {}}
        return super().staff_action(action, body)


def main():
    httpd, base = start_server(PORT)
    mock = Mock15(base)
    os.makedirs(SHOTS, exist_ok=True)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()

            def open_as(user, w=1280, route=None):
                pg = browser.new_context(viewport={'width': w, 'height': 800}).new_page()
                mock.install(pg)
                pg.goto(base + '/index.html')
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
                if route:
                    pg.evaluate("(r) => { window.location.hash = r; }", route)
                return pg

            def measure(pg, label):
                sw, bad = overflow(pg)
                check(sw <= 375, '%s：scrollWidth %d ≤ 375（超出元素：%s）' % (label, sw, bad))

            # ============ ⑦ 首頁提醒（人資：北區沒有督導） ============
            hr = open_as('hr')
            hr.wait_for_selector('text=1 個區域沒有督導', timeout=10000)
            check(hr.locator('text=家門市還沒劃進區域').count() == 0, '⑦開關關著：首頁不提醒「門市還沒劃進區域」')

            # ============ ① 人資開「區域」分頁 ============
            hr.evaluate("() => { window.location.hash = '#/staff/regions'; }")
            hr.wait_for_selector('[data-role="region-check"] [data-role="check-item"]', timeout=10000)
            tabs = [t.strip() for t in hr.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(tabs == ['名單', '匯入', '打卡對照', '區域'], '①同仁名單四個分頁：%s' % tabs)
            brands = hr.locator('[data-role="region-brand"] .section-title').all_inner_texts()
            check(brands == ['墨竹亭', '麻的小辛辣', '一悟燒肉'], '①依品牌三塊（不含總部）：%s' % brands)
            un = hr.locator('[data-role="region-brand"][data-brand="mala"] [data-role="unassigned"]').inner_text()
            check('小辛測試甲店' in un and '小辛測試丙店' in un and '品牌辦公室' not in un, '①麻的小辛辣「尚未劃區的門市」：%s' % un)
            check('墨竹測試乙店' in hr.locator('[data-role="region-brand"][data-brand="mzt"] [data-role="unassigned"]').inner_text(), '①墨竹亭尚未劃區＝乙店')
            ck = hr.locator('[data-role="region-check"]').inner_text()
            check('依區域審核：關' in ck and NOTE in ck and '小辛測試甲店：2 位' in ck and '北區（還沒指定督導）' in ck, '①切換檢查：狀態、四項、att_pending_note 原文')
            check(hr.locator('[data-act="switch-on"], [data-act="switch-off"]').count() == 0, '①人資看不到開始／停止按鈕')
            check(hr.locator('[data-role="region-card"][data-code="r-mzt-1"] [data-role="tag-no-sup"]').count() == 1, '①北區卡片標「沒有督導」')
            # 北區已用掉墨竹甲店：新增墨竹亭區域時那家店不能勾、顯示「已在 北區」
            hr.click('[data-act="add"][data-brand="mzt"]')
            newm = hr.locator('[data-role="region-brand"][data-brand="mzt"] [data-role="region-card"][data-code=""]')
            box = newm.locator('[data-f="store"][value="mzt-a"]')
            check(box.is_disabled() and '已在 北區' in newm.inner_text(), '①已在別區的門市不能勾、顯示「已在 北區」')
            newm.locator('[data-act="discard"]').click()
            check(hr.locator('[data-role="region-brand"][data-brand="mzt"] [data-role="region-card"][data-code=""]').count() == 0, '①新區域按取消就拿掉')

            # ============ ② 新增一區、勾店、選督導、存檔（preview） ============
            hr.click('[data-act="add"][data-brand="mala"]')
            card = hr.locator('[data-role="region-brand"][data-brand="mala"] [data-role="region-card"][data-code=""]')
            opts = card.locator('[data-f="supervisor"] option').all_inner_texts()
            check(opts == ['（暫時沒有督導）', '督導甲', '督導乙'], '②督導下拉只列該品牌在職區督導：%s' % opts)
            card.locator('[data-f="name"]').fill('中區')
            card.locator('[data-f="store"][value="mala-a"]').check()
            card.locator('[data-f="store"][value="mala-b"]').check()
            card.locator('[data-f="supervisor"]').select_option('DZY101')
            hr.screenshot(path=os.path.join(SHOTS, 't15_regions_edit_1280.png'), full_page=True)
            card.locator('[data-act="save"]').click()
            hr.wait_for_selector('.dialog-body', timeout=5000)
            body = hr.inner_text('.dialog-body')
            check('督導甲：多看到 小辛測試甲店、小辛測試乙店超級長的分店名稱' in body, '②preview 對話框：誰多看到哪幾家店：%s' % body)
            check(mock.saved == [] and mock.reg_calls[-1][0] == 'regionSave' and mock.reg_calls[-1][1].get('preview') is True and mock.reg_calls[-1][1].get('expected_ver') == 'v1', '②先打 preview（帶 expected_ver），還沒寫')
            hr.screenshot(path=os.path.join(SHOTS, 't15_regions_preview_1280.png'))
            hr.click('.dialog-actions button:has-text("取消")')
            check(mock.saved == [], '②preview 按取消 → 不存')
            card.locator('[data-act="save"]').click()
            hr.wait_for_selector('.dialog-body', timeout=5000)
            hr.click('.dialog-actions button:has-text("確定存檔")')
            hr.wait_for_selector('[data-role="region-card"][data-code="r-mala-2"]', timeout=5000)
            sv = mock.saved[-1] if mock.saved else {}
            check(sv.get('name') == '中區' and sv.get('stores') == ['mala-a', 'mala-b'] and sv.get('supervisor') == 'DZY101' and sv.get('active') is True, '②存檔內容：區名、門市、督導：%s' % sv)
            check('小辛測試甲店' not in hr.locator('[data-role="region-brand"][data-brand="mala"] [data-role="unassigned"]').inner_text(), '②存檔後重新載入：甲店不再是尚未劃區')

            # ============ ③ ver 衝突 ============
            mock.ver += 1   # 別人改過
            c2 = hr.locator('[data-role="region-card"][data-code="r-mala-2"]')
            c2.locator('[data-f="store"][value="mala-c"]').check()
            c2.locator('[data-act="save"]').click()
            hr.wait_for_selector('.dialog-body', timeout=5000)
            check('資料已被別人改過，請重新整理' in hr.inner_text('.dialog-body'), '③ver 衝突顯示「資料已被別人改過，請重新整理」')
            n_list = sum(1 for a, _ in mock.reg_calls if a == 'regionList')
            hr.click('.dialog-actions button:has-text("重新整理")')
            hr.wait_for_timeout(500)
            check(sum(1 for a, _ in mock.reg_calls if a == 'regionList') == n_list + 1 and len(mock.saved) == 1, '③按重新整理 → 重新讀、沒有存')

            # ============ ⑥ 375px 無橫向捲動（人資區域頁，含新卡片） ============
            hr375 = open_as('hr', 375, '#/staff/regions')
            hr375.wait_for_selector('[data-role="region-card"]', timeout=10000)
            hr375.click('[data-act="add"][data-brand="mala"]')
            measure(hr375, '⑥ #/staff/regions 375')
            hr375.screenshot(path=os.path.join(SHOTS, 't15_regions_375.png'), full_page=True)

            # ============ ④ admin：開始依區域審核 ============
            ad = open_as('admin', 1280, '#/staff/regions')
            ad.wait_for_selector('[data-act="switch-on"]', timeout=10000)
            check(ad.locator('[data-role="switch-warn"]').count() == 1, '④還有沒劃區／沒督導 → 按鈕旁紅字警告（不擋）')
            check(not ad.locator('[data-act="switch-on"]').is_disabled(), '④按鈕沒有被擋')
            ad.click('[data-act="switch-on"]')
            ad.wait_for_selector('.dialog-body', timeout=5000)
            t = ad.inner_text('.dialog-body')
            check('開始後，督導只審得到自己區的店長申請與認領；沒劃區的店只剩總監、人資能審' in t, '④確認框說明文字')
            ad.click('.dialog-actions button:has-text("取消")')
            check(mock.switches == [], '④取消不切換')
            ad.click('[data-act="switch-on"]')
            ad.click('.dialog-actions button:has-text("確定開始")')
            ad.wait_for_selector('[data-act="switch-off"]', timeout=5000)
            check(mock.switches == [True] and '依區域審核：開' in ad.inner_text('[data-role="switch-state"]'), '④regionSwitch {on:true}、狀態變「開」')
            ad.click('[data-act="switch-off"]')
            ad.click('.dialog-actions button:has-text("確定停止")')
            ad.wait_for_selector('[data-act="switch-on"]', timeout=5000)
            check(mock.switches == [True, False], '④停止依區域審核 → regionSwitch {on:false}')

            # ============ ⑤ 督導：我的資料 → 單位通訊錄 → 我的區域 ============
            sp = open_as('DZY101', 375, '#/me/unit')
            sp.wait_for_selector('[data-role="my-regions"]', timeout=10000)
            txt = sp.inner_text('[data-role="view-content"]')
            check('我的區域' in txt and '中區' in txt, '⑤督導看到「我的區域」與區名')
            st = sp.locator('[data-role="region-store"]')
            check(st.count() == 2, '⑤每家店一個區塊：%d' % st.count())
            check(sp.locator('[data-role="region-store"][data-unit="mala-a"]').get_attribute('open') is not None and sp.locator('[data-role="region-store"][data-unit="mala-b"]').get_attribute('open') is None, '⑤超過 30 人的店預設收合、其他展開')
            check('31 位' in sp.locator('[data-role="region-store"][data-unit="mala-b"] summary').inner_text(), '⑤店名旁有人數')
            check(sp.locator('[data-role="region-store"][data-unit="mala-a"] [data-role="region-row"]').count() == 2 and '0911000201' in txt, '⑤店內姓名、職稱、手機')
            check('生日' not in txt and '地址' not in txt and '1990-01-01' not in txt, '⑤沒有生日、地址')
            sp.locator('[data-role="region-store"][data-unit="mala-b"] summary').click()
            check(sp.locator('[data-role="region-store"][data-unit="mala-b"] [data-role="region-row"]').first.is_visible(), '⑤點店名展開')
            measure(sp, '⑥ #/me/unit 我的區域 375')
            sp.screenshot(path=os.path.join(SHOTS, 't15_me_regions_375.png'), full_page=True)

            check(not mock.leaked, '沒有請求漏出 mock：%s' % mock.leaked)
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
