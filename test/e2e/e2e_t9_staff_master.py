#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑨：員工名單統一（docs/personnel/master-data/task.md D6）。全部假名、全程 mock 後端、零真實網路。

① 店長登入（375px 與 1280px 各一）：首頁出現「打卡對照等你確認」提醒；「我的資料 → 我的單位」新增同仁，
   單位欄固定不能選；送出後輪詢 clockJobStatus（每 3 秒）→ 成功畫面有 DZY 編號＋打卡編號＋「顯示打卡連結」鈕＋LINE 說明；
   按「顯示打卡連結」→ 完整打卡網址＋複製鈕；關掉後畫面與 localStorage／sessionStorage 都找不到金鑰。
② 店長登記離職（第 8 天前擋下、提示「最多往回補 7 天」）→ 名單顯示「M/D 離職」→ 可撤銷 → 再登記；
   mock 時間推到隔天 00:10 後重新整理 → 名單顯示「打卡已停 1/1」、撤銷鈕消失。
③ 店長「打卡對照」只看到自己單位 3 筆（看不到總部那筆）→ 「對」一筆（confirmed）、「不對」一筆（轉總部）。
④ 總部：新增到沒有打卡的單位 → 「這個單位沒有打卡系統」；新增到有打卡的單位但 mock 讓打卡建檔失敗 → 失敗畫面；
   首頁看到每一類提醒 → 點「打卡待辦單失敗」→ 待辦單分頁按「重試」→ mock 單回到 pending；
   「需總部處理」看到店長轉來的那筆；名單看得到離職標籤與打卡已停。
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, USERS, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8790
TODAY = datetime.date.today()
UNIT_STORE = {'mzt-gf': ('mztgf', '墨竹亭 新竹光復'), 'dzy-hq': ('hq', '鼎兆元 總部')}  # mzt-ml（台中美村）故意沒有打卡
UNIT_BRAND = {'mzt-gf': 'mzt', 'mzt-ml': 'mzt', 'dzy-hq': 'dzy'}
LINK_KEY = 'TESTKEY123'


class Mock9(MockBackend):
    """在 t8 的 mock 上多接員工名單統一的 action（形狀照 docs/personnel/master-data/api.md）。"""
    ORG = dict(MockBackend.ORG)
    ORG['units'] = MockBackend.ORG['units'] + [{'code': 'mzt-ml', 'name': '台中美村', 'parent': 'mzt', 'ladder': 'store'}]

    def __init__(self, base):
        super().__init__(base)
        self.today = TODAY
        self.fail_next_add = False
        self.next_clock = 10
        self.jobs = {}
        self.escalated = []
        self.log9 = []
        mk = lambda n, name, unit, title: {'emp_no': 'DZY%03d' % n, 'name': name, 'status': 'active', 'unit': unit, 'brand': UNIT_BRAND[unit],
                                           'title': title, 'hire_date': '2026-01-05', 'last_day': '', 'phone': '0912000%03d' % n}
        self.staff = [mk(10, '測試店長', 'mzt-gf', 'sm'), mk(20, '測試甲', 'mzt-gf', 'pt'), mk(21, '測試乙', 'mzt-gf', 'pt'),
                      mk(22, '測試丙', 'mzt-gf', 'pt'), mk(30, '總部測試', 'dzy-hq', 'hs')]
        sug = lambda emp, store, eid: {'emp_no': emp, 'store_code': store, 'emp_id': eid, 'role': 'home', 'state': 'suggested', 'roster_active': True, 'last_punch': '2026-10-12'}
        self.maps = [sug('DZY020', 'mztgf', 'E05'), sug('DZY021', 'mztgf', 'E06'), sug('DZY022', 'mztgf', 'E07'), sug('DZY030', 'hq', 'E01')]
        USERS['DZY010'] = {'password': 'e2e-lead-pw-10', 'perms': ['platform.self', 'platform.review'],
                           'user': {'id': 'u-DZY010', 'name': '測試店長', 'role': 'staff', 'node': '', 'username': 'DZY010'}}

    # ---- 小工具 ----
    def row(self, emp):
        return next((r for r in self.staff if r['emp_no'] == emp), None)

    def person(self, r):
        o = self._staff_obj(r)
        mine = [m for m in self.maps if m['emp_no'] == r['emp_no'] and m['state'] == 'confirmed']
        o.update({'hire_date': r.get('hire_date', ''), 'last_day': r.get('last_day', ''),
                  'can_cancel_leave': bool(r.get('last_day')) and r['last_day'] >= str(self.today) and r['status'] != 'disabled',
                  'clocks': [{'store_code': m['store_code'], 'store_name': UNIT_STORE.get(r.get('unit'), ('', ''))[1] or m['store_code'], 'emp_id': m['emp_id'], 'role': m['role'],
                              'roster_active': m['roster_active']} for m in mine],
                  'clock_total': len(mine), 'clock_stopped': len([m for m in mine if not m['roster_active']]), 'clock_job': None})
        j = next((j for j in self.jobs.values() if j['kind'] == 'add' and j['emp_no'] == r['emp_no'] and j['state'] in ('pending', 'running', 'failed')), None)
        if j:
            o['clock_job'] = {'job_id': j['job_id'], 'state': j['state'], 'tries': j['tries']}
        return o

    def midnight(self):
        """模擬隔天 00:10 的每日同步：last_day < 今天 → 停用，打卡全部 roster_active=False"""
        self.today = self.today + datetime.timedelta(days=1)
        for r in self.staff:
            if r.get('last_day') and r['last_day'] < str(self.today) and r['status'] != 'disabled':
                r['status'] = 'disabled'
                for m in self.maps:
                    if m['emp_no'] == r['emp_no']:
                        m['roster_active'] = False

    def err(self, code, msg):
        return {'ok': False, 'error': msg, 'code': code}

    # ---- 分派 ----
    def staff_action(self, action, body):
        p = body.get('payload') or {}
        who = (body.get('token') or '').replace('e2e-token-', '')
        hq = USERS.get(who, {}).get('perms') == ['*']
        me = self.row(who)
        lead = bool(me) and me.get('title') == 'sm' and me['status'] == 'active' and not hq
        h = getattr(self, 'a_' + action, None)
        if h is None:
            return super().staff_action(action, body)
        self.log9.append(action)
        if not (hq or lead) and action not in ('staffList',):
            return self.err('no_perm', '沒有權限')
        return h(p, hq, me, lead)

    def a_staffList(self, p, hq, me, lead):
        if not hq:
            return self.err('no_perm', '沒有權限')
        return {'ok': True, 'data': {'staff': [self.person(r) for r in self.staff]}}

    def a_staffUnitList(self, p, hq, me, lead):
        unit = me['unit'] if lead else p.get('unit')
        people = []
        for r in self.staff:
            if unit and r.get('unit') != unit:
                continue
            o = self.person(r)
            for k in ('phone', 'birthday', 'address'):
                o.pop(k, None)
            people.append({k: o[k] for k in ('emp_no', 'name', 'status', 'unit', 'unit_name', 'title', 'title_name', 'hire_date', 'last_day',
                                              'can_cancel_leave', 'clocks', 'clock_total', 'clock_stopped', 'clock_job')})
        return {'ok': True, 'data': {'people': people, 'unit': unit or ''}}

    def a_staffCreateByUnit(self, p, hq, me, lead):
        unit = me['unit'] if lead else p.get('unit')
        if any(r['name'] == p.get('name') and r.get('unit') == unit and r['status'] != 'disabled' for r in self.staff):
            return self.err('duplicate_name', '同單位已有同名的在職同仁，請在姓名後加註')
        emp = 'DZY%03d' % (max(int(r['emp_no'][3:]) for r in self.staff) + 1)
        self.staff.append({'emp_no': emp, 'name': p['name'], 'status': 'unclaimed', 'unit': unit, 'brand': UNIT_BRAND.get(unit, ''),
                           'title': p['title'], 'hire_date': p['hire_date'], 'phone': p['phone'], 'last_day': ''})
        store = UNIT_STORE.get(unit)
        job = None
        if store:
            job = 'J%03d' % (len(self.jobs) + 1)
            self.jobs[job] = {'job_id': job, 'kind': 'add', 'emp_no': emp, 'store_code': store[0], 'state': 'pending', 'polls': 0,
                              'tries': 0, 'will_fail': self.fail_next_add, 'last_error': '', 'unit': unit}
            self.fail_next_add = False
        return {'ok': True, 'data': {'emp_no': emp, 'job_id': job, 'unit': unit, 'store_code': store[0] if store else None}}

    def a_clockJobStatus(self, p, hq, me, lead):
        j = self.jobs.get(p.get('job_id'))
        if not j:
            return self.err('no_job', '找不到這張單')
        j['polls'] += 1
        out = {'job_id': j['job_id'], 'kind': j['kind'], 'emp_no': j['emp_no'], 'store_code': j['store_code'], 'tries': j['tries'], 'last_error': j['last_error']}
        if j['kind'] == 'add' and j['state'] != 'done':
            if j['will_fail'] and j['polls'] >= 1:
                j.update(state='failed', tries=3, last_error='timeout')
            elif not j['will_fail'] and j['polls'] >= 2:
                eid = 'E%02d' % self.next_clock
                self.next_clock += 1
                j.update(state='done', emp_id=eid)
                self.maps.append({'emp_no': j['emp_no'], 'store_code': j['store_code'], 'emp_id': eid, 'role': 'home', 'state': 'confirmed', 'roster_active': True, 'last_punch': ''})
            else:
                j['state'] = 'running'
        if j['kind'] == 'link':
            if j.get('taken'):
                out.update(state='done', link_expired=True)
                return {'ok': True, 'data': out}
            j.update(state='done', taken=True)
            out['link_key'] = LINK_KEY
        out['state'] = j['state']
        out['tries'] = j['tries']
        out['last_error'] = j['last_error']
        if j.get('emp_id'):
            out['emp_id'] = j['emp_id']
        return {'ok': True, 'data': out}

    def a_clockLink(self, p, hq, me, lead):
        job = 'J%03d' % (len(self.jobs) + 1)
        self.jobs[job] = {'job_id': job, 'kind': 'link', 'emp_no': p['emp_no'], 'store_code': p.get('store_code') or 'mztgf', 'state': 'pending', 'polls': 0, 'tries': 0, 'last_error': ''}
        return {'ok': True, 'data': {'job_id': job}}

    def a_staffLeave(self, p, hq, me, lead):
        r = self.row(p['emp_no'])
        if not r:
            return self.err('not_found', '找不到同仁')
        if lead and (r['unit'] != me['unit'] or r['emp_no'] == me['emp_no']):
            return self.err('no_perm', '沒有權限')
        if lead and p['last_day'] < str(self.today - datetime.timedelta(days=7)):
            return self.err('last_day_past', '店長最多只能往回補 7 天')
        r['last_day'] = p['last_day']
        return {'ok': True, 'data': {'emp_no': r['emp_no'], 'last_day': r['last_day'], 'can_cancel': r['last_day'] >= str(self.today)}}

    def a_staffLeaveCancel(self, p, hq, me, lead):
        r = self.row(p['emp_no'])
        if not r or not r.get('last_day'):
            return self.err('no_leave', '沒有登記離職')
        r['last_day'] = ''
        return {'ok': True, 'data': {'emp_no': r['emp_no']}}

    def _suggested_rows(self, me, lead):
        out = []
        for m in self.maps:
            r = self.row(m['emp_no'])
            if m['state'] != 'suggested' or (lead and r['unit'] != me['unit']):
                continue
            out.append({'emp_no': r['emp_no'], 'name': r['name'], 'unit': r['unit'], 'unit_name': self._org_name('unit', r['unit']), 'store_code': m['store_code'],
                        'store_name': UNIT_STORE[r['unit']][1], 'emp_id': m['emp_id'], 'role': m['role'], 'state': m['state'], 'source': 'name_match',
                        'roster_active': True, 'last_punch': m['last_punch']})
        return out

    def a_clockMapList(self, p, hq, me, lead):
        needs = [] if lead else list(self.escalated)
        return {'ok': True, 'data': {'suggested': self._suggested_rows(me, lead), 'needs_hq': needs, 'candidates': [], 'confirmed_count': len([m for m in self.maps if m['state'] == 'confirmed']), 'built_at': ''}}

    def a_clockMapDecide(self, p, hq, me, lead):
        m = next((m for m in self.maps if m['store_code'] == p['store_code'] and m['emp_id'] == p['emp_id']), None)
        if not m:
            return self.err('not_found', '找不到這筆對照')
        r = self.row(m['emp_no'])
        if lead and (r['unit'] != me['unit'] or m['state'] != 'suggested'):
            return self.err('no_perm', '只能處理自己單位待確認的對照')
        if p['decision'] == 'confirm':
            m['state'] = 'confirmed'
            return {'ok': True, 'data': {'emp_no': m['emp_no'], 'store_code': m['store_code'], 'emp_id': m['emp_id'], 'role': m['role'], 'state': 'confirmed'}}
        m['state'] = 'rejected'
        self.escalated.append({'kind': 'escalated', 'name': r['name'], 'entries': [{'store_code': m['store_code'], 'emp_id': m['emp_id']}],
                               'options': [{'emp_no': x['emp_no'], 'name': x['name'], 'unit': x['unit']} for x in self.staff if x['unit'] == r['unit']][:3]})
        return {'ok': True, 'data': {'store_code': m['store_code'], 'emp_id': m['emp_id'], 'state': 'rejected', 'escalated': True}}

    def a_clockOutboxRetry(self, p, hq, me, lead):
        j = self.jobs.get(p.get('job_id'))
        if not hq:
            return self.err('no_perm', '只有總部可以重試')
        if not j or j['state'] != 'failed':
            return self.err('not_retryable', '這張單不能重試')
        j.update(state='pending', polls=0, tries=0, will_fail=False, last_error='')
        self.retried = getattr(self, 'retried', []) + [j['job_id']]
        return {'ok': True, 'data': {'job_id': j['job_id'], 'state': 'pending'}}

    def a_clockAlerts(self, p, hq, me, lead):
        failed = [j for j in self.jobs.values() if j['state'] == 'failed' and (hq or j.get('unit') == me['unit'])]
        sug = self._suggested_rows(me, lead)
        d = {'outbox_failed': [{'job_id': j['job_id'], 'kind': j['kind'], 'emp_no': j['emp_no'], 'store_code': j['store_code'], 'state': 'failed', 'tries': j['tries'], 'last_error': j['last_error']} for j in failed],
             'unmapped': [], 'left_but_active': [], 'pending_confirm': {'count': len(sug), 'items': []}, 'no_home_map': [], 'name_diff': [],
             'last_sync': {'mztgf': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}, 'counts': {}}
        if hq:
            d.update({'payroll_diff': [], 'transfer_ask': [], 'needs_hq_count': len(self.escalated), 'candidates_count': 0})
        return {'ok': True, 'data': d}


def main():
    httpd, base = start_server(PORT)
    mock = Mock9(base)
    os.makedirs(SHOTS, exist_ok=True)
    today_s = str(TODAY)
    m_d = '%d/%d 離職' % (TODAY.month, TODAY.day)
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
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)  # 首頁載完才換網址，不然登入完成的導頁會蓋掉
                return pg

            def add_person(pg, name, phone):
                pg.click('[data-role="add-staff"]')
                pg.wait_for_selector('#ad-name')
                pg.fill('#ad-name', name)
                pg.select_option('#ad-title', 'pt')
                pg.fill('#ad-hire', today_s)
                pg.fill('#ad-phone', phone)
                pg.click('.dialog .btn-primary:has-text("送出")')

            # ① 店長（1280）
            lead = lead_page(1280)
            lead.wait_for_selector('[data-role="alert-row"]:has-text("筆打卡對照等你確認")')
            check('3 筆打卡對照等你確認' in lead.inner_text('[data-role="alert-list"][data-module="me"]'), '★店長首頁出現「3 筆打卡對照等你確認」（只算自己單位）')
            lead.goto(base + '/index.html#/me/team')
            lead.wait_for_selector('[data-role="team-row"]')
            names = lead.locator('[data-role="team-row"]').count()
            check(names == 4, '「我的單位」只列自己單位 4 人（不含總部那位）：%d' % names)
            check('0912' not in lead.inner_text('[data-role="view-content"]'), '★名單沒有手機號碼（staffUnitList 不含個資）')
            lead.click('[data-role="add-staff"]')
            lead.wait_for_selector('#ad-name')
            check(lead.locator('#ad-unit').count() == 0 and lead.locator('[data-role="fixed-unit"]').count() == 1, '★店長版單位欄固定、沒有單位下拉')
            check('新竹光復' in lead.inner_text('[data-role="fixed-unit"]'), '固定顯示自己的單位')
            lead.click('.dialog .btn:has-text("取消")')
            add_person(lead, '測試新人', '0912-000-777')
            lead.wait_for_selector('[data-role="add-result"][data-state="done"]', timeout=15000)
            res_text = lead.inner_text('.dialog')
            check('DZY031' in res_text and 'E10' in res_text, '★成功畫面有 DZY 編號與打卡編號：' + res_text.replace('\n', ' ')[:80])
            check(lead.locator('[data-role="add-show-link"]').count() == 1 and 'LINE' in lead.inner_text('[data-role="line-help"]'), '成功畫面有「顯示打卡連結」鈕與 LINE 綁定說明')
            lead.screenshot(path=os.path.join(SHOTS, 'master-add-success-1280.png'))
            check('staffCreateByUnit' in mock.log9 and mock.log9.count('clockJobStatus') >= 2, '新增後有輪詢 clockJobStatus')
            lead.click('[data-role="add-show-link"]')
            lead.wait_for_selector('[data-role="link-url"]')
            url = lead.input_value('[data-role="link-url"]')
            check(url == 'https://eason0728.github.io/mala-clock-in/clock-mztgf.html?k=' + LINK_KEY, '★顯示完整打卡網址（clock-<店>.html?k=金鑰）：' + url)
            check(lead.locator('[data-role="link-copy"]').count() == 1, '有複製鈕')
            check(LINK_KEY not in json.dumps(lead.evaluate('({l: Object.assign({}, localStorage), s: Object.assign({}, sessionStorage)})')), '★金鑰沒有寫進 localStorage／sessionStorage')
            lead.click('.dialog:has([data-role="link-url"]) .btn:has-text("關閉")')
            check(lead.locator('[data-role="link-url"]').count() == 0 and LINK_KEY not in lead.content(), '★關掉連結後畫面上找不到金鑰')
            lead.click('.dialog .btn:has-text("關閉")')
            lead.wait_for_selector('[data-role="team-row"][data-emp="DZY031"]')
            check('E10' in lead.inner_text('[data-role="team-row"][data-emp="DZY031"]'), '名單上新同仁出現打卡編號')
            # 同名擋下
            add_person(lead, '測試新人', '0912000778')
            lead.wait_for_selector('.toast-danger:has-text("同名")')
            check(True, '同單位同名 → 後端擋下，訊息教加註，表單保留重填')
            lead.click('.dialog .btn:has-text("取消")')

            # ② 離職
            row = '[data-role="team-row"][data-emp="DZY031"]'
            lead.click(row + ' [data-act="leave"]')
            lead.wait_for_selector('#lv-date')
            min_attr = lead.get_attribute('#lv-date', 'min')
            check(min_attr == str(TODAY - datetime.timedelta(days=7)) and '最多往回補 7 天' in lead.inner_text('[data-role="leave-hint"]'), '★日期選擇器下限=今天−7 天，提示「最多往回補 7 天」')
            lead.fill('#lv-date', str(TODAY - datetime.timedelta(days=8)))
            lead.click('.dialog .btn-primary:has-text("送出")')
            lead.wait_for_selector('.toast-warn:has-text("7 天")')
            lead.wait_for_selector('#lv-date')
            check('staffLeave' not in mock.log9, '往回超過 7 天 → 前端擋下，沒有送到後端')
            lead.fill('#lv-date', today_s)
            lead.click('.dialog .btn-primary:has-text("送出")')
            lead.wait_for_selector(row + ' [data-role="leave-tag"]')
            check(m_d in lead.inner_text(row + ' [data-role="leave-tag"]'), '★名單顯示「%s」' % m_d)
            check(lead.locator(row + ' [data-act="leave-cancel"]').count() == 1, '當天可撤銷 → 出現「撤銷離職」')
            lead.click(row + ' [data-act="leave-cancel"]')
            lead.click('.dialog .btn-primary:has-text("確定")')
            lead.wait_for_function("() => !document.querySelector('[data-emp=\"DZY031\"] [data-role=\"leave-tag\"]')")
            check(mock.row('DZY031')['last_day'] == '', '撤銷後離職標籤消失')
            lead.click(row + ' [data-act="leave"]')
            lead.wait_for_selector('#lv-date')
            lead.click('.dialog .btn-primary:has-text("送出")')
            lead.wait_for_selector(row + ' [data-role="leave-tag"]')
            check('打卡已停 0/1' in lead.inner_text(row), '還沒到 00:10 → 顯示「打卡已停 0/1」')
            mock.midnight()  # 隔天 00:10 每日同步
            lead.reload()
            lead.wait_for_selector(row + ' [data-role="stopped-tag"]')
            check('打卡已停 1/1' in lead.inner_text(row), '★00:10 之後名單顯示「打卡已停 1/1」')
            check(lead.locator(row + ' [data-act="cancel-leave"], ' + row + ' [data-act="leave-cancel"]').count() == 0, '已停用 → 撤銷鈕消失')

            # ③ 手機版新增成功畫面、打卡對照畫面截圖
            ph = lead_page(375)
            ph.goto(base + '/index.html#/me/team')
            ph.wait_for_selector('[data-role="add-staff"]')
            add_person(ph, '測試新人乙', '0912000779')
            ph.wait_for_selector('[data-role="add-result"][data-state="done"]', timeout=15000)
            ph.screenshot(path=os.path.join(SHOTS, 'master-add-success-375.png'))
            check(ph.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), '375px：新增成功畫面沒有橫向捲動')
            ph.click('.dialog .btn:has-text("關閉")')
            ph.goto(base + '/index.html#/me/clock')
            ph.wait_for_selector('[data-role="cm-row"]')
            ph.screenshot(path=os.path.join(SHOTS, 'master-clockmap-375.png'), full_page=True)
            check(ph.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), '375px：打卡對照畫面沒有橫向捲動')

            # ④ 店長打卡對照
            lead.goto(base + '/index.html#/me/clock')
            lead.wait_for_selector('[data-role="cm-row"]')
            eids = sorted(lead.locator('[data-role="cm-row"]').evaluate_all('els => els.map(e => e.getAttribute("data-emp-id"))'))
            check(eids == ['E05', 'E06', 'E07'], '★店長只看到自己單位 3 筆（看不到總部那筆）：%s' % eids)
            lead.screenshot(path=os.path.join(SHOTS, 'master-clockmap-1280.png'), full_page=True)
            lead.click('[data-act="cm-yes"][data-eid="E05"]')
            lead.wait_for_function("() => document.querySelectorAll('[data-role=\"cm-row\"]').length === 2")
            check([m['state'] for m in mock.maps if m['emp_id'] == 'E05'] == ['confirmed'], '★按「對」→ 該筆 confirmed')
            lead.click('[data-act="cm-no"][data-eid="E06"]')
            lead.click('.dialog .btn-primary:has-text("確定")')
            lead.wait_for_function("() => document.querySelectorAll('[data-role=\"cm-row\"]').length === 1")
            check([m['state'] for m in mock.maps if m['emp_id'] == 'E06'] == ['rejected'] and len(mock.escalated) == 1, '★按「不對」→ 轉總部處理')
            lead.screenshot(path=os.path.join(SHOTS, 'master-clockmap-after-1280.png'))

            # ⑤ 總部
            admin = browser.new_context(viewport={'width': 1280, 'height': 900}).new_page()
            mock.install(admin)
            admin.goto(base + '/index.html')
            admin.fill('#login-username', 'admin')
            admin.fill('#login-password', 'e2e-admin')
            admin.click('[data-role="submit"]')
            admin.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)
            admin.goto(base + '/index.html#/staff/list')
            admin.wait_for_selector('[data-role="rows"] tr:has-text("DZY031")')
            r31 = admin.inner_text('[data-role="rows"] tr:has-text("DZY031")')
            check(m_d in r31 and '打卡已停 1/1' in r31, '總部名單也顯示離職標籤與打卡已停')
            # 新增到沒有打卡的單位
            admin.click('[data-role="add-staff"]')
            admin.wait_for_selector('#ad-brand')
            admin.fill('#ad-name', '總部加測試')
            admin.select_option('#ad-brand', 'mzt')
            admin.select_option('#ad-unit', 'mzt-ml')
            admin.select_option('#ad-title', 'pt')
            admin.fill('#ad-hire', today_s)
            admin.fill('#ad-phone', '0912000888')
            admin.click('.dialog .btn-primary:has-text("送出")')
            admin.wait_for_selector('[data-role="no-clock"]')
            check('沒有打卡系統' in admin.inner_text('[data-role="no-clock"]'), '★單位沒有打卡（job_id=null）→「這個單位沒有打卡系統」')
            admin.click('.dialog .btn-primary:has-text("完成")')
            # 打卡建檔失敗
            mock.fail_next_add = True
            admin.click('[data-role="add-staff"]')
            admin.wait_for_selector('#ad-brand')
            admin.fill('#ad-name', '總部失敗測試')
            admin.select_option('#ad-brand', 'dzy')
            admin.select_option('#ad-unit', 'dzy-hq')
            admin.select_option('#ad-title', 'hs')
            admin.fill('#ad-hire', today_s)
            admin.fill('#ad-phone', '0912000999')
            admin.click('.dialog .btn-primary:has-text("送出")')
            admin.wait_for_selector('[data-role="add-failed"]')
            check('首頁' in admin.inner_text('[data-role="add-failed"]') and admin.locator('[data-role="add-retry"]').count() == 1, '★失敗畫面：說明會在首頁待辦出現、總部有重試鈕')
            admin.click('.dialog .btn:has-text("關閉")')
            # 首頁提醒
            admin.click('[data-role="nav-desktop"] [data-nav="__home__"]')
            admin.wait_for_selector('[data-role="alert-row"]:has-text("打卡待辦單失敗")')
            home = admin.inner_text('[data-role="view-content"]')
            check('1 筆打卡待辦單失敗' in home and '1 筆打卡對照需要總部處理' in home and '2 筆打卡對照等你確認' in home, '★總部首頁每一類一列：待辦單失敗／需總部處理／等確認')
            admin.click('[data-role="alert-row"]:has-text("打卡待辦單失敗")')
            admin.wait_for_selector('[data-role="job-row"]')
            check('timeout' in admin.inner_text('[data-role="job-row"]'), '點提醒 → 打卡對照的「待辦單」分頁，列出失敗原因')
            admin.click('[data-act="job-retry"]')
            admin.wait_for_selector('[data-role="cm-empty"]')
            check(getattr(mock, 'retried', []) != [] and all(j['state'] != 'failed' for j in mock.jobs.values()), '★按「重試」→ 後端單回到 pending')
            admin.click('[data-role="cm-tab"][data-t="needs"]')
            admin.wait_for_selector('[data-role="needs-row"]')
            check('店長說不對' in admin.inner_text('[data-role="needs-row"]') and '測試乙' in admin.inner_text('[data-role="needs-row"]'), '「需總部處理」看到店長按「不對」轉來的那筆')
            admin.screenshot(path=os.path.join(SHOTS, 'master-hq-needs-1280.png'))

            browser.close()
        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
