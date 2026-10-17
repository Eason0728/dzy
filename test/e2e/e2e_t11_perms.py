#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑪：個人帳號第二期「依職稱給權限」前端（docs/permissions/task.md T4-2～T4-6）。全部代稱、全程 mock 後端、零真實網路。

mock 形狀照 apps-script/platform/PermActions.gs（permInit／permMapGet／permMapSave／permExList／permExSave／permExRevoke／
permStoreGet／permStoreSave／myPerms／permAuditList／permAuditSeen）；錯誤 {ok:false, error, code}。
① admin 未初始化 → 初始化 → 對照表 19 條、新增對象三段選、刪除確認、權限異動產生
② 人資主管：鎖列灰掉、只有「對照表」分頁、送出自己會被改到的規則 → perm_self 中文、鎖碼 → perm_locked 中文
③ 個別例外：新增（提示填單權限）、過期灰掉、撤銷　④ 店別對照　⑤ 權限異動：未讀 → 逐列／全部已看過、首頁提醒
⑥ 店長只看到「我的門市」、我的資料「我能用的功能」　⑦ 區督導看到總覽不見填寫　⑧ enabled:false 不顯示　⑨ 試跑模式只讀不寫　⑩ 手機寬無橫向捲動
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, USERS, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8802

LOCKED = ['platform.users', 'platform.permmap', 'audit.write', 'platform.staff']
# 預設規則（Perms.gs PERM_DEFAULT_RULES，19 條）
DEFAULT_RULES = (
    [('store', '', 'sm', 'audit.read.own')]
    + [('office', '', t, 'audit.read.brand') for t in ('oam', 'osv', 'odir')]
    + [('hq', 'ops', '*', 'audit.read')]
    + [('hq', 'mgmt', '*', 'audit.read'), ('hq', 'mgmt', '*', 'audit.write'), ('hq', 'fin', '*', 'audit.read'), ('hq', 'fin', '*', 'audit.write')]
    + [('hq', '', t, p) for t in ('ceo', 'gm', 'chair') for p in ('audit.read', 'dorm.read')]
    + [('hq', 'hr', '*', p) for p in ('platform.staff', 'dorm.read', 'dorm.write')]
    + [('hq', 'hr', 'hm', 'platform.permmap')]
)
HRM_PERMS = ['platform.staff', 'dorm.read', 'dorm.write', 'platform.permmap']


class Mock11(MockBackend):
    def __init__(self, base):
        super().__init__(base)
        mk = lambda name, perms, node='': {'password': 'e2e-pw', 'perms': perms,
                                           'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': node}}
        USERS['hrm'] = mk('人資主管甲', ['platform.self', 'platform.staff', 'platform.permmap'])
        USERS['DZY901'] = mk('店長甲', ['platform.self', 'audit.read.own'], 'sxl-gf')
        USERS['DZY902'] = mk('區督導乙', ['platform.self', 'audit.read.brand'])
        USERS['DZY903'] = mk('店長丙', ['platform.self', 'audit.read.own'], 'sxl-gf')
        self.staff = [
            {'emp_no': 'DZY001', 'name': '王小明', 'status': 'active', 'brand': 'mzt', 'unit': 'mzt-gf', 'title': 'sm', 'reset_fail': 0},
            {'emp_no': 'DZY002', 'name': '李大華', 'status': 'active', 'brand': 'dzy', 'unit': 'dzy-hq', 'title': 'hs', 'reset_fail': 0},
            {'emp_no': 'DZY901', 'name': '店長甲', 'status': 'active', 'brand': 'mzt', 'unit': 'mzt-gf', 'title': 'sm', 'reset_fail': 0},
            {'emp_no': 'DZY902', 'name': '區督導乙', 'status': 'active', 'brand': 'mzt', 'unit': 'dzy-hq', 'title': 'hs', 'reset_fail': 0},
            {'emp_no': 'DZY903', 'name': '店長丙', 'status': 'active', 'brand': 'mzt', 'unit': 'mzt-gf', 'title': 'sm', 'reset_fail': 0},
        ]
        self.inited = False
        self.rules = []
        self.exs = [
            {'ex_id': 'X001', 'emp_no': 'DZY001', 'name': '王小明', 'perm': 'dorm.read', 'mode': 'add', 'until': '2099-12-31', 'note': '代理宿舍業務',
             'active': True, 'status': 'active', 'created_at': '2026-10-01 09:00:00', 'created_by': 'u-admin', 'revoked_at': '', 'revoked_by': ''},
            {'ex_id': 'X002', 'emp_no': 'DZY002', 'name': '李大華', 'perm': 'audit.read', 'mode': 'add', 'until': '2020-01-01', 'note': '專案已結束',
             'active': True, 'status': 'expired', 'created_at': '2026-09-01 09:00:00', 'created_by': 'u-admin', 'revoked_at': '', 'revoked_by': ''},
        ]
        self.store_map = {'mala-gf': 'sxl-gf', 'mzt-gf': 'mzt-gf'}
        self.audit = [
            {'row': 2, 'at': '2026-10-15 10:00:00', 'by': 'u-admin', 'emp_no': 'DZY001', 'name': '王小明', 'added': '', 'removed': 'audit.read.own',
             'cause': 'staff_edit', 'seen': False},
            {'row': 3, 'at': '2026-10-16 11:00:00', 'by': 'u-admin', 'emp_no': '', 'name': '', 'added': '{}', 'removed': '', 'cause': 'perm_map', 'seen': False,
             'detail': {'rules_added': ['R020'], 'rules_removed': [], 'affected': 2, 'people': [
                 {'emp_no': 'DZY002', 'name': '李大華', 'added': ['dorm.write'], 'removed': []},
                 {'emp_no': 'DZY001', 'name': '王小明', 'added': ['dorm.write'], 'removed': []}]}},
        ]
        self.my = {
            'DZY901': {'enabled': True, 'audit_scope': ['sxl-gf'], 'items': [{'perm': 'audit.read.own', 'name_zh': '稽核：我的門市', 'source': 'title', 'rule_id': 'R001'},
                                                                           {'perm': 'dorm.read', 'name_zh': '宿舍：查看', 'source': 'exception', 'ex_id': 'X001', 'until': '2026-10-31'}]},
            'DZY902': {'enabled': True, 'audit_scope': ['mzt-gf', 'mzt-js'], 'items': [{'perm': 'audit.read.brand', 'name_zh': '稽核：自己品牌的店', 'source': 'title', 'rule_id': 'R003'}]},
            'DZY903': {'enabled': False},
        }
        self.perm_calls = []

    # ---- 輔助 ----
    def _who(self, body):
        who = (body.get('token') or '').replace('e2e-token-', '')
        u = USERS.get(who)
        return who, u, bool(u and u['user'].get('role') == 'admin')

    def _err(self, code, msg):
        return {'ok': False, 'error': msg, 'code': code}

    def platform_action(self, action, body):
        if action.startswith('perm') or action == 'myPerms':
            self.perm_calls.append(action)
            return self.perm_action(action, body)
        return super().platform_action(action, body)

    def perm_action(self, action, body):
        p = body.get('payload') or {}
        who, u, is_admin = self._who(body)
        if not u:
            return {'ok': False, 'error': 'token 無效'}
        has_map = is_admin or 'platform.permmap' in u['perms']
        no_perm = self._err('no_perm', '沒有權限')
        if action == 'myPerms':
            return {'ok': True, 'data': self.my.get(who, {'enabled': False})}
        if action == 'permInit':
            if not is_admin:
                return no_perm
            self.inited = True
            self.rules = [{'rule_id': 'R%03d' % (i + 1), 'ladder': a, 'dept': b, 'title': c, 'perm': d} for i, (a, b, c, d) in enumerate(DEFAULT_RULES)]
            return {'ok': True, 'data': {'created': ['perm_map', 'perm_ex', 'perm_store_map', 'perm_audit'], 'rules_seeded': len(self.rules), 'stores_seeded': 2}}
        if action in ('permMapGet', 'permStoreGet') and not has_map:
            return no_perm
        if action in ('permMapSave',) and not has_map:
            return no_perm
        if action in ('permExList', 'permExSave', 'permExRevoke', 'permStoreSave', 'permAuditList', 'permAuditSeen') and not is_admin:
            return no_perm
        if action == 'permMapGet':
            if not self.inited:
                return {'ok': True, 'data': {'inited': False}}
            return {'ok': True, 'data': {
                'inited': True, 'rules': list(self.rules),
                'grantable': ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write', 'platform.staff', 'platform.users', 'platform.permmap'],
                'locked': LOCKED, 'names': {},
                'ladders': [{'code': 'store', 'name': '門市'}, {'code': 'office', 'name': '品牌辦公室'}, {'code': 'hq', 'name': '總部'}],
                'titles': [
                    {'code': 'sm', 'name': '店長', 'ladder': 'store', 'rank': 3}, {'code': 'pt', 'name': '計時同仁', 'ladder': 'store', 'rank': 1},
                    {'code': 'oam', 'name': '區經理', 'ladder': 'office', 'rank': 3}, {'code': 'osv', 'name': '區督導', 'ladder': 'office', 'rank': 4}, {'code': 'odir', 'name': '區總監', 'ladder': 'office', 'rank': 5},
                    {'code': 'hs', 'name': '部門同仁', 'ladder': 'hq', 'rank': 1}, {'code': 'hm', 'name': '人資主管', 'ladder': 'hq', 'rank': 5},
                    {'code': 'ceo', 'name': '執行長', 'ladder': 'hq', 'rank': 9}, {'code': 'gm', 'name': '總經理', 'ladder': 'hq', 'rank': 8}, {'code': 'chair', 'name': '董事長', 'ladder': 'hq', 'rank': 10}],
                'depts': [{'code': 'hr', 'name': '人資部', 'unit': 'dzy-hq'}, {'code': 'ops', 'name': '營運部', 'unit': 'dzy-hq'},
                          {'code': 'mgmt', 'name': '管理部', 'unit': 'dzy-hq'}, {'code': 'fin', 'name': '財務部', 'unit': 'dzy-hq'}],
                'is_admin': is_admin}}
        if not self.inited and action != 'permAuditList':
            return self._err('not_inited', '權限分頁還沒初始化，請系統管理者先按「初始化」')
        if action == 'permMapSave':
            add, rem = p.get('add') or [], p.get('remove') or []
            for a in add:
                if a['perm'] in LOCKED and not is_admin:
                    return self._err('perm_locked', '只有系統管理者能改這個功能的對象')
            for rid in rem:
                hit = next((r for r in self.rules if r['rule_id'] == rid), None)
                if not hit:
                    return self._err('no_rule', '找不到這條規則：' + rid)
                if hit['perm'] in LOCKED and not is_admin:
                    return self._err('perm_locked', '只有系統管理者能改這個功能的對象')
            # 自改擋下（13.1）：人資主管 hrm 是「總部・人資部・人資主管」，加到他自己命中的規則且會多出權限 → perm_self
            if not is_admin and who == 'hrm' and any(a['ladder'] == 'hq' and a['dept'] in ('hr', '') and a['title'] in ('*', 'hm') and a['perm'] not in HRM_PERMS for a in add):
                return self._err('perm_self', '這次修改會改變你自己的權限，請找系統管理員處理')
            nid = max([int(r['rule_id'][1:]) for r in self.rules] + [0])
            added = []
            for a in add:
                nid += 1
                self.rules.append({'rule_id': 'R%03d' % nid, 'ladder': a['ladder'], 'dept': a['dept'], 'title': a['title'], 'perm': a['perm']})
                added.append('R%03d' % nid)
            self.rules = [r for r in self.rules if r['rule_id'] not in rem]
            self.audit.append({'row': len(self.audit) + 2, 'at': '2026-10-17 12:00:00', 'by': u['user']['id'], 'emp_no': '', 'name': '', 'added': '{}', 'removed': '',
                               'cause': 'perm_map', 'seen': False,
                               'detail': {'rules_added': added, 'rules_removed': list(rem), 'affected': 3, 'people': [{'emp_no': 'DZY002', 'name': '李大華', 'added': ['dorm.write'], 'removed': []}]}})
            return {'ok': True, 'data': {'added': added, 'removed': list(rem), 'affected': 3}}
        if action == 'permExList':
            return {'ok': True, 'data': {'inited': True, 'items': [dict(x) for x in self.exs]}}
        if action == 'permExSave':
            if not (p.get('note') or '').strip():
                return self._err('bad_note', '原因必填，1 到 50 個字')
            hit = next((s for s in self.staff if s['emp_no'] == p.get('emp_no')), None)
            if not hit:
                return self._err('no_staff', '找不到這位同仁')
            self.last_ex = p
            self.exs.append({'ex_id': 'X%03d' % (len(self.exs) + 1), 'emp_no': p['emp_no'], 'name': hit['name'], 'perm': p['perm'], 'mode': p['mode'],
                             'until': p.get('until') or '', 'note': p['note'], 'active': True, 'status': 'active',
                             'created_at': '2026-10-17 13:00:00', 'created_by': u['user']['id'], 'revoked_at': '', 'revoked_by': ''})
            return {'ok': True, 'data': {'ex_id': self.exs[-1]['ex_id']}}
        if action == 'permExRevoke':
            hit = next((x for x in self.exs if x['ex_id'] == p.get('ex_id')), None)
            if not hit:
                return self._err('no_ex', '找不到這筆例外')
            hit.update({'active': False, 'status': 'revoked'})
            return {'ok': True, 'data': {'ex_id': hit['ex_id']}}
        if action == 'permStoreGet':
            return {'ok': True, 'data': {
                'inited': True,
                'items': [{'unit': k, 'unit_name': k, 'audit_store': v} for k, v in self.store_map.items()],
                'units': [{'code': 'mala-gf', 'name': '麻的小辛辣 光復', 'brand': 'mala', 'ladder': 'store'},
                          {'code': 'mala-mm', 'name': '麻的小辛辣 美村', 'brand': 'mala', 'ladder': 'store'},
                          {'code': 'mzt-gf', 'name': '墨竹亭 光復', 'brand': 'mzt', 'ladder': 'store'},
                          {'code': 'dzy-hq', 'name': '鼎兆元總部', 'brand': 'dzy', 'ladder': 'hq'}]}}
        if action == 'permStoreSave':
            store = p.get('audit_store') or ''
            if store and any(k != p['unit'] and v == store for k, v in self.store_map.items()):
                return self._err('dup_store', '這家稽核店已經對照給別的單位了')
            self.store_map[p['unit']] = store
            return {'ok': True, 'data': {'unit': p['unit'], 'audit_store': store}}
        if action == 'permAuditList':
            if not self.inited:
                return {'ok': True, 'data': {'inited': False}}
            return {'ok': True, 'data': {'inited': True, 'items': [dict(x) for x in reversed(self.audit)], 'unseen': self.unseen()}}
        if action == 'permAuditSeen':
            marked = 0
            for x in self.audit:
                if (p.get('all') is True or x['row'] in (p.get('rows') or [])) and not x['seen']:
                    x['seen'] = True
                    marked += 1
            return {'ok': True, 'data': {'marked': marked}}
        return self._err('bad_input', '未知的 perm action：' + action)

    def unseen(self):
        return sum(1 for x in self.audit if not x['seen'])


def main():
    httpd, base = start_server(PORT)
    mock = Mock11(base)
    os.makedirs(SHOTS, exist_ok=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def open_as(user, route=None, width=1280, height=900, query=''):
                pg = browser.new_context(viewport={'width': width, 'height': height}).new_page()
                mock.install(pg)
                pg.goto(base + '/index.html' + query)
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
                pg.card_ids = [c.get_attribute('data-module') for c in pg.locator('[data-role="module-card"]').all()]
                if route:
                    pg.evaluate("(r) => { window.location.hash = r; }", route)
                return pg

            def dlg(pg, label):
                pg.click('.dialog-actions button:has-text("%s")' % label)

            def tabs(pg):
                pg.wait_for_selector('[data-role="view-nav"] .nav-item')
                return pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()

            def has_toast(pg, text):
                try:
                    pg.wait_for_selector('.toast:has-text("%s")' % text, timeout=4000)
                    return True
                except Exception:
                    return False

            # ============ ① admin：未初始化 → 初始化 → 對照表 ============
            ad = open_as('admin', '/perms/map')
            ids = ad.card_ids
            check('perms' in ids and ids.index('perms') == ids.index('users') + 1, 'admin 首頁有「權限設定」卡片，實際：%s' % ids)
            ad.wait_for_selector('[data-role="not-inited"]')
            check(ad.locator('[data-act="init"]').count() == 1, '★未初始化：admin 看到「初始化」按鈕')
            check(tabs(ad) == ['對照表', '個別例外', '店別對照', '權限異動'], 'admin 四個分頁：%s' % tabs(ad))
            ad.click('[data-act="init"]')
            check('19 條預設規則' in ad.inner_text('.dialog-body') and '四張' in ad.inner_text('.dialog-body'), '初始化確認框說明會建四張表＋19 條預設規則')
            dlg(ad, '取消')
            check(mock.inited is False, '取消不會初始化')
            ad.click('[data-act="init"]')
            dlg(ad, '確定')
            ad.wait_for_selector('[data-role="feature-row"]')
            check(mock.inited is True and 'permInit' in mock.perm_calls, '按確定後呼叫 permInit')
            perms_order = [r.get_attribute('data-perm') for r in ad.locator('[data-role="feature-row"]').all()]
            check(perms_order == ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write', 'platform.staff', 'platform.users', 'platform.permmap'],
                  '★對照表 9 列、順序正確：%s' % perms_order)
            check(ad.locator('[data-role="chip"]').count() == 19, '★對照表共 19 個 chip，實際 %d' % ad.locator('[data-role="chip"]').count())
            names = [t.split('\n')[0].replace('鎖定', '').strip() for t in ad.locator('[data-role="feature-row"] .card-title').all_inner_texts()]
            check(names[0] == '看自己店稽核' and names[3] == '填稽核單與門市管理' and names[8] == '改權限對照表', '功能中文名：%s' % names)
            row = lambda perm: ad.locator('[data-role="feature-row"][data-perm="%s"]' % perm)
            check('門市・店長' in row('audit.read.own').inner_text(), 'chip「門市・店長」')
            check('品牌辦公室・區督導' in row('audit.read.brand').inner_text(), 'chip「品牌辦公室・區督導」')
            check('總部・人資部・全部職稱' in row('platform.staff').inner_text(), 'chip「總部・人資部・全部職稱」')
            check('總部・全部部門・執行長' in row('audit.read').inner_text(), 'chip「總部・全部部門・執行長」')
            check(ad.locator('[data-role="feature-row"][data-locked="1"]').count() == 4, '鎖住的四列有標記')
            check(ad.locator('[data-role="feature-row"][data-locked="1"] [data-act="add"]:not([disabled])').count() == 4, 'admin 鎖住的四列仍可新增（不灰掉）')
            ad.screenshot(path=os.path.join(SHOTS, 'perms-map.png'), full_page=True)

            # 新增對象：階梯→（總部才有）部門→職稱
            row('dorm.write').locator('[data-act="add"]').click()
            ad.wait_for_selector('#pm-ladder')
            check(ad.locator('#pm-dept-wrap, [data-role="pm-dept-wrap"]').first.is_hidden(), '階梯＝門市時不出現部門')
            ad.select_option('#pm-ladder', 'hq')
            check(ad.locator('[data-role="pm-dept-wrap"]').is_visible(), '階梯＝總部才出現部門')
            dept_opts = ad.locator('#pm-dept option').all_inner_texts()
            check(dept_opts[0] == '全部部門' and '營運部' in dept_opts, '部門選項含「全部部門」：%s' % dept_opts)
            check(ad.locator('#pm-title option').first.inner_text() == '全部職稱', '職稱選項含「全部職稱」')
            check('區督導' not in ad.locator('#pm-title option').all_inner_texts() and '執行長' in ad.locator('#pm-title option').all_inner_texts(), '職稱依所選階梯過濾（總部只有總部職稱）')
            ad.select_option('#pm-dept', 'ops')
            dlg(ad, '新增')
            ad.wait_for_selector('[data-role="feature-row"][data-perm="dorm.write"] [data-role="chip"]:has-text("總部・營運部・全部職稱")')
            check(ad.locator('[data-role="chip"]').count() == 20, '新增對象後 chip 變 20')
            check(any(r['perm'] == 'dorm.write' and r['dept'] == 'ops' and r['title'] == '*' and r['ladder'] == 'hq' for r in mock.rules), '送出的規則 ladder/dept/title/perm 正確')
            # 刪除要確認
            chip = row('dorm.write').locator('[data-role="chip"]:has-text("總部・營運部・全部職稱")')
            chip.locator('[data-act="del"]').click()
            check('總部・營運部・全部職稱' in ad.inner_text('.dialog-body'), '刪除前跳確認框')
            dlg(ad, '取消')
            check(ad.locator('[data-role="chip"]').count() == 20, '取消不刪')
            chip.locator('[data-act="del"]').click()
            dlg(ad, '確定')
            ad.wait_for_function("() => document.querySelectorAll('[data-role=\"chip\"]').length === 19")
            check(True, '確認後刪除，chip 回 19')

            # ============ ⑤ 權限異動 ============
            ad.evaluate("() => { window.location.hash = '#/perms/audit'; }")
            ad.wait_for_selector('[data-role="audit-item"]')
            unseen0 = mock.unseen()
            check(unseen0 == 4 and ad.locator('[data-role="audit-item"][data-seen="0"]').count() == 4, '權限異動：4 筆未看（2 筆既有＋新增／刪除各一筆）')
            txt = ad.inner_text('[data-role="audit-item"][data-row="2"]')
            check('王小明' in txt and '少了' in txt and '看自己店稽核' in txt and '改了同仁的單位／職稱' in txt, '個人異動列：誰、少了什麼、原因類型中文：%s' % txt.replace('\n', ' '))
            ad.click('[data-role="audit-item"][data-row="3"] [data-act="toggle"]')
            ptxt = ad.inner_text('[data-role="audit-item"][data-row="3"] [data-role="people"]')
            check('李大華' in ptxt and '多了 宿舍建約點交' in ptxt, 'perm_map 那列可展開受影響的人與差異：%s' % ptxt.replace('\n', ' '))
            check('改了權限對照表' in ad.inner_text('[data-role="audit-item"][data-row="3"]') and '影響 2 人' in ad.inner_text('[data-role="audit-item"][data-row="3"]'), 'perm_map 摘要：新增幾條、影響幾人')
            ad.click('[data-role="audit-item"][data-row="2"] [data-act="seen"]')
            ad.wait_for_function("() => document.querySelectorAll('[data-role=\"audit-item\"][data-seen=\"0\"]').length === 3")
            check(mock.unseen() == 3 and mock.audit[0]['seen'], '逐列「已看過」只標那一列')

            # 首頁提醒（admin）：未讀異動＋未對照稽核店
            ad.evaluate("() => { window.location.hash = '#/home'; }")
            ad.wait_for_selector('.todo-row')
            ad.wait_for_function("() => document.body.innerText.includes('權限異動待看')")
            home = ad.inner_text('[data-role="module-card"][data-module="perms"]')
            check('有 3 筆權限異動待看' in home, '★首頁提醒：未讀異動 3 筆：%s' % home.replace('\n', ' '))
            check('有 1 個門市單位還沒對照稽核店' in home, '★首頁提醒：門市單位沒對照稽核店：%s' % home.replace('\n', ' '))
            ad.click('[data-role="module-card"][data-module="perms"] .todo-row:has-text("權限異動待看")')
            ad.wait_for_selector('[data-role="audit-item"]')
            check(ad.evaluate("() => window.location.hash").startswith('#/perms/audit'), '點提醒導到「權限異動」分頁')
            ad.click('[data-act="seen-all"]')
            ad.wait_for_function("() => document.querySelectorAll('[data-role=\"audit-item\"][data-seen=\"0\"]').length === 0")
            check(mock.unseen() == 0, '★「全部標為已看過」')

            # ============ ③ 個別例外 ============
            ad.evaluate("() => { window.location.hash = '#/perms/ex'; }")
            ad.wait_for_selector('[data-role="ex-item"]')
            check(ad.locator('[data-role="ex-item"]').count() == 2, '例外清單 2 筆')
            first = ad.locator('[data-role="ex-item"]').first
            check(first.get_attribute('data-ex') == 'X001', '生效中排前面、過期排後面')
            exp = ad.locator('[data-role="ex-item"][data-ex="X002"]')
            check('已過期' in exp.inner_text() and 'opacity' in (exp.get_attribute('style') or ''), '過期那筆灰掉並標「已過期」')
            check('王小明' in first.inner_text() and '看宿舍清單' in first.inner_text() and '多給' in first.inner_text() and '到 2099-12-31' in first.inner_text()
                  and '代理宿舍業務' in first.inner_text() and 'u-admin' in first.inner_text(), '清單欄位：同仁、功能、多給、到期、原因、建立者')
            # 驗證：原因必填
            ad.fill('[data-role="ex-who"]', 'DZY001 王小明')
            ad.click('[data-role="ex-submit"]')
            check('原因必填' in ad.inner_text('[data-role="ex-error"]'), '原因空白 → 「原因必填」')
            ad.fill('[data-role="ex-who"]', '不存在的人')
            ad.fill('[data-role="ex-note"]', '測試')
            ad.click('[data-role="ex-submit"]')
            check('找不到這位同仁' in ad.inner_text('[data-role="ex-error"]'), '同仁找不到 → 中文提示')
            # 新增：拿掉看全部店稽核 → 提示
            ad.fill('[data-role="ex-who"]', '王小明')
            ad.select_option('[data-role="ex-perm"]', 'audit.read')
            ad.select_option('[data-role="ex-mode"]', 'remove')
            check('填單權限仍可看全部店' in ad.inner_text('[data-role="ex-hint"]') and ad.locator('[data-role="ex-hint"]').is_visible(), '★拿掉「看全部店稽核」→ 提示「填單權限仍可看全部店」')
            ad.fill('[data-role="ex-until"]', '2099-06-30')
            ad.fill('[data-role="ex-note"]', '暫時不給看全部')
            ad.screenshot(path=os.path.join(SHOTS, 'perms-ex.png'), full_page=True)
            ad.click('[data-role="ex-submit"]')
            ad.wait_for_selector('[data-role="ex-item"][data-ex="X003"]')
            lx = mock.last_ex
            check(lx['emp_no'] == 'DZY001' and lx['perm'] == 'audit.read' and lx['mode'] == 'remove' and lx['until'] == '2099-06-30' and lx['note'] == '暫時不給看全部', '送出 payload 正確：%s' % lx)
            check('拿掉' in ad.inner_text('[data-role="ex-item"][data-ex="X003"]'), '新例外出現在清單（拿掉）')
            # 撤銷
            ad.click('[data-role="ex-item"][data-ex="X003"] [data-act="revoke"]')
            dlg(ad, '取消')
            check(mock.exs[-1]['active'] is True, '撤銷前確認，取消不撤')
            ad.click('[data-role="ex-item"][data-ex="X003"] [data-act="revoke"]')
            dlg(ad, '確定')
            ad.wait_for_selector('[data-role="ex-item"][data-ex="X003"][data-status="revoked"]')
            check(mock.exs[-1]['active'] is False and ad.locator('[data-role="ex-item"][data-ex="X003"] [data-act="revoke"]').count() == 0, '★撤銷後標「已撤銷」並移除撤銷鈕')

            # ============ ④ 店別對照 ============
            ad.evaluate("() => { window.location.hash = '#/perms/stores'; }")
            ad.wait_for_selector('[data-role="store-row"]')
            check(ad.locator('[data-role="store-row"]').count() == 3, '門市單位 3 個（總部不列）')
            mm = ad.locator('[data-role="store-row"][data-unit="mala-mm"]')
            check('還沒對照' in mm.inner_text(), '沒對照的單位標「還沒對照」')
            sel_opts = ad.locator('[data-role="store-row"][data-unit="mala-gf"] select option').all_inner_texts()
            check(sel_opts[0] == '（不對照）' and 'sxl-gf' in sel_opts and 'mzt-gf' in sel_opts and sel_opts[-1] == '其他代碼…', '稽核店別下拉：不對照＋已有代碼＋其他：%s' % sel_opts)
            mm.locator('select').select_option('__other__')
            mm.locator('[data-role="store-other"]').fill('mala-mm')
            mm.locator('[data-act="save"]').click()
            ad.wait_for_function("() => document.querySelector('[data-role=\"store-row\"][data-unit=\"mala-mm\"]').innerText.includes('mala-mm') && !document.querySelector('[data-role=\"store-row\"][data-unit=\"mala-mm\"]').innerText.includes('還沒對照')")
            check(mock.store_map.get('mala-mm') == 'mala-mm', '店別對照存進去')
            # 清空
            gf = ad.locator('[data-role="store-row"][data-unit="mzt-gf"]')
            gf.locator('select').select_option('')
            gf.locator('[data-act="save"]').click()
            ad.wait_for_function("() => document.querySelector('[data-role=\"store-row\"][data-unit=\"mzt-gf\"]').innerText.includes('還沒對照')")
            check(mock.store_map.get('mzt-gf') == '', '可清空對照')
            # 重複的店 → 後端錯誤顯示中文
            gf.locator('select').select_option('__other__')
            gf.locator('[data-role="store-other"]').fill('sxl-gf')
            gf.locator('[data-act="save"]').click()
            check(has_toast(ad, '已經對照給別的單位'), '重複的稽核店 → 顯示後端中文 error')

            # ============ ⑩ 手機寬無橫向捲動（對照表、例外、店別、異動） ============
            mob = open_as('admin', '/perms/map', width=375, height=800)
            mob.wait_for_selector('[data-role="feature-row"]')
            for r in ('/perms/map', '/perms/ex', '/perms/stores', '/perms/audit'):
                mob.evaluate("(r) => { window.location.hash = r; }", r)
                mob.wait_for_timeout(500)
                mob.wait_for_selector('[data-role="view-content"] .card')
                sw = mob.evaluate("() => [document.documentElement.scrollWidth, window.innerWidth]")
                check(sw[0] <= sw[1], '手機 375 寬 %s 無橫向捲動（scrollWidth %d ≤ %d）' % (r, sw[0], sw[1]))
            mob.evaluate("() => { window.location.hash = '#/perms/map'; }")
            mob.wait_for_selector('[data-role="feature-row"]')
            mob.screenshot(path=os.path.join(SHOTS, 'perms-map-375.png'), full_page=True)

            # ============ ② 人資主管（非 admin） ============
            hr = open_as('hrm', '/perms/map')
            hr.wait_for_selector('[data-role="feature-row"]')
            check(tabs(hr) == ['對照表'], '★人資主管只有「對照表」分頁，實際：%s' % tabs(hr))
            lk = hr.locator('[data-role="feature-row"][data-locked="1"]')
            check(lk.count() == 4, '鎖住的四列仍顯示')
            check(lk.locator('[data-act="add"][disabled]').count() == 4 and lk.locator('[data-act="del"]').count() == 0, '★鎖住的四列對非 admin：新增鈕 disabled、chip 沒有刪除鈕')
            check(all('只有系統管理員能改' in t for t in lk.locator('[data-role="lock-note"]').all_inner_texts()) and lk.locator('[data-role="lock-note"]').count() == 4, '鎖列有說明「只有系統管理員能改」')
            check('opacity' in (lk.first.get_attribute('style') or ''), '鎖列灰掉')
            check(hr.locator('[data-role="feature-row"]:not([data-locked]) [data-act="add"]:not([disabled])').count() == 5, '其餘 5 列可編輯')
            check(hr.locator('[data-role="feature-row"]:not([data-locked]) [data-act="del"]').count() > 0, '未鎖的 chip 有刪除鈕')
            # 首頁：非 admin 沒有權限異動／店別提醒
            hr.evaluate("() => { window.location.hash = '#/home'; }")
            hr.wait_for_selector('[data-role="module-card"][data-module="perms"] .todo-row, [data-role="module-card"][data-module="perms"] .todo-empty')
            check('權限異動' not in hr.inner_text('[data-role="module-card"][data-module="perms"]') and '稽核店' not in hr.inner_text('[data-role="module-card"][data-module="perms"]'), '非 admin 首頁沒有 admin 專屬提醒')
            # 自改 → perm_self 中文
            hr.evaluate("() => { window.location.hash = '#/perms/map'; }")
            hr.wait_for_selector('[data-role="feature-row"]')
            hr.locator('[data-role="feature-row"][data-perm="audit.read"] [data-act="add"]').click()
            hr.select_option('#pm-ladder', 'hq')
            hr.select_option('#pm-dept', 'hr')
            dlg(hr, '新增')
            check(has_toast(hr, '這個改動會改到你自己的權限，請系統管理員處理'), '★改到自己 → perm_self 中文提示')
            check(not any(r['perm'] == 'audit.read' and r['dept'] == 'hr' for r in mock.rules), 'perm_self 被擋下，規則沒寫進去')
            # 送出鎖碼 → perm_locked 中文（繞過畫面直接打 API，驗畫面用的錯誤轉換）
            res = hr.evaluate("""async () => {
              const api = await import('./platform/api.js');
              const lib = await import('./modules/perms/lib.js');
              const r = await api.call('platform', 'permMapSave', { add: [{ ladder: 'hq', dept: '', title: '*', perm: 'platform.users' }] });
              return { ok: r.ok, code: lib.codeOf(r), text: lib.errorText(r) };
            }""")
            check(res['ok'] is False and res['code'] == 'perm_locked' and res['text'] == '只有系統管理員能改這個功能的對象', '★送出鎖碼 → perm_locked，中文：%s' % res)
            # 直接打網址進 admin 分頁 → 彈回首頁
            hr.evaluate("() => { window.location.hash = '#/perms/ex'; }")
            hr.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            check(True, '人資主管改網址進「個別例外」被彈回首頁')

            # ============ ⑥ 店長 ============
            sm = open_as('DZY901', '/audit-stock/my')
            tb = tabs(sm)
            check(tb == ['我的門市'], '★店長（audit.read.own）盤點模組只有「我的門市」，實際：%s' % tb)
            sm.evaluate("() => { window.location.hash = '#/audit-ops/my'; }")
            sm.wait_for_function("() => window.location.hash.startsWith('#/audit-ops')")
            check(tabs(sm) == ['我的門市'], '店長營運稽核也只有「我的門市」')
            ids = sm.card_ids
            check('perms' not in ids and 'audit-stock' in ids, '店長首頁沒有權限設定、有稽核：%s' % ids)
            sm.evaluate("() => { window.location.hash = '#/me/profile'; }")
            sm.wait_for_selector('[data-role="my-perms"]')
            blk = sm.inner_text('[data-role="my-perms"]')
            check('我能用的功能' in blk and '看自己店稽核' in blk and '因為職稱：店長' in blk, '★我的資料「我能用的功能」：功能＋來源（因為職稱）：%s' % blk.replace('\n', ' '))
            check('看宿舍清單' in blk and '個別例外，到 10/31' in blk, '例外來源「個別例外，到 10/31」')
            check('稽核範圍：自己店' in blk, '稽核範圍：自己店')
            sm.screenshot(path=os.path.join(SHOTS, 'perms-me.png'), full_page=True)

            # ============ ⑦ 區督導 ============
            sv = open_as('DZY902', '/audit-stock/overview')
            check(tabs(sv) == ['總覽', '報告', '異常分析'], '★區督導（audit.read.brand）盤點：總覽／報告／異常分析，沒有填寫：%s' % tabs(sv))
            sv.evaluate("() => { window.location.hash = '#/audit-ops/overview'; }")
            sv.wait_for_function("() => window.location.hash.startsWith('#/audit-ops')")
            check(tabs(sv) == ['總覽', '報告'], '區督導營運稽核：總覽／報告：%s' % tabs(sv))
            sv.evaluate("() => { window.location.hash = '#/audit-stock/fill'; }")
            sv.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            check(True, '區督導改網址進「稽核填寫」被彈回首頁')
            sv.evaluate("() => { window.location.hash = '#/me/profile'; }")
            sv.wait_for_selector('[data-role="my-perms"]')
            check('稽核範圍：自己品牌 2 家' in sv.inner_text('[data-role="my-perms"]'), '區督導稽核範圍：自己品牌 2 家')

            # ============ ⑧ enabled:false 不顯示 ============
            off = open_as('DZY903', '/me/profile')
            off.wait_for_selector('[data-role="form"]')
            off.wait_for_timeout(600)
            check('myPerms' in mock.perm_calls and off.locator('[data-role="my-perms"]').count() == 0, '★myPerms enabled:false → 不顯示「我能用的功能」')

            # ============ ⑨ 試跑模式：讀得到、寫不出去 ============
            n_before = len([a for a in mock.perm_calls if a in ('permMapSave', 'permInit')])
            dr = open_as('admin', None, query='?dryrun=1')
            dr.evaluate("() => { window.location.hash = '#/perms/map'; }")
            dr.wait_for_selector('[data-role="feature-row"]')
            check(dr.locator('[data-role="chip"]').count() == 19, '試跑模式：permMapGet 讀得到（19 chip）')
            dr.locator('[data-role="feature-row"][data-perm="dorm.write"] [data-act="add"]').click()
            dlg(dr, '新增')
            dr.wait_for_selector('.toast:has-text("試跑模式")')
            n_after = len([a for a in mock.perm_calls if a in ('permMapSave', 'permInit')])
            check(n_after == n_before and dr.locator('[data-role="chip"]').count() == 19, '★試跑模式：新增對象被攔下，後端沒收到 permMapSave')
            dr.evaluate("() => { window.location.hash = '#/perms/audit'; }")
            dr.wait_for_selector('[data-role="audit-item"]')
            check(True, '試跑模式：permAuditList 讀得到')

            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
