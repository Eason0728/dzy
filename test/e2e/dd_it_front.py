#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""資料帶入測試：資訊部門（人員管理、權限設定）＋平台登入層（登入／改密碸／登出／第一次使用／忘記密碼）前端。

全程 mock 後端、零真實網路（外網守門 re ^https?://(?!127\\.0\\.0\\.1)）。資料每次全部隨機重抽（E2E_SEED=<種子> 重現）。
四種角色都跑：admin、人資主管（platform.permmap）、人資同仁（platform.staff）、一般同仁（platform.self）。
每顆按鈕／連結用 dd_it_clickmap 稽核：掃到沒點到就報失敗。截圖存 test/dd/artifacts/it/。
埠：9201（規定 9200–9219）。
"""
import json
import os
import random
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, USERS, check, failures, finish, start_server
from dd_it_clickmap import ClickMap, SKIP

from playwright.sync_api import sync_playwright

PORT = 9201
SEED = int(os.environ.get('E2E_SEED') or (int(time.time()) % 2147483647))
R = random.Random(SEED)
print('SEED=%d（重現：E2E_SEED=%d python3 test/e2e/dd_it_front.py）' % (SEED, SEED))
ART = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dd', 'artifacts', 'it')
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')

GRANTABLE = ['audit.read.own', 'audit.read.brand', 'audit.read', 'audit.write', 'dorm.read', 'dorm.write', 'platform.staff', 'platform.users', 'platform.permmap',
             'store.void', 'att.extra', 'payroll.write', 'cashbook.write', 'platform.bulletin', 'platform.purchase', 'pnl.read', 'pnl.write', 'pnl.admin', 'transfer.write',
             'platform.eval-manage', 'platform.eval-brand', 'platform.eval-all', 'platform.eval-admin',
             'platform.insp-do', 'platform.insp-own', 'platform.insp-brand', 'platform.insp-all', 'platform.insp-bank']
LOCKED = ['platform.users', 'platform.permmap', 'audit.write', 'platform.staff', 'payroll.write', 'pnl.admin']
HR_EX = ['store.void', 'att.extra', 'platform.bulletin']
NAMES = {p: p for p in GRANTABLE}
TITLES = [('pt', '計時同仁', 'store', 1), ('ft', '正職同仁', 'store', 2), ('sm', '店長', 'store', 3), ('am', '區經理', 'store', 4), ('fm', '廠長', 'store', 3), ('rdd', '廚藝總監', 'store', 4),
          ('ofs', '行政同仁', 'office', 1), ('osv', '區督導', 'office', 2), ('odir', '總監', 'office', 3),
          ('hs', '部門同仁', 'hq', 1), ('hm', '總監', 'hq', 2), ('ceo', '執行長', 'hq', 3), ('gm', '總經理', 'hq', 4), ('chair', '董事長', 'hq', 5)]
DEPTS = [('fin', '財務部'), ('hr', '人資部'), ('it', '資訊部'), ('eng', '工程部'), ('ops', '營運部'), ('mgmt', '管理部'), ('marketing', '行銷部')]
UNITS = [('mzt-js', '墨竹亭 新竹金山', 'mzt', 'store'), ('mzt-gf', '墨竹亭 新竹光復', 'mzt', 'store'), ('mzt-lzl', '墨竹亭 台北六張犁', 'mzt', 'store'),
         ('mala-gf', '麻的小辛辣 新竹光復', 'mala', 'store'), ('yiwu-js', '一悟 新竹金山', 'yiwu', 'store'), ('ck', '中央工廠（央廚）', 'ck', 'store'),
         ('mzt-hq', '墨竹亭品牌辦公室', 'mzt', 'office'), ('dzy-hq', '鼎兆元總部', 'dzy', 'hq')]
SURN = ['假', '測', '虛', '擬', '樣', '範']
GIVEN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']
DEFAULT_RULES = ([('store', '', 'sm', 'audit.read.own')] + [('office', '', t, 'audit.read.brand') for t in ('oam', 'osv', 'odir')]
                 + [('hq', 'ops', '*', 'audit.read'), ('hq', 'mgmt', '*', 'audit.read'), ('hq', 'mgmt', '*', 'audit.write'), ('hq', 'fin', '*', 'audit.read'), ('hq', 'fin', '*', 'audit.write')]
                 + [('hq', '', t, p) for t in ('ceo', 'gm', 'chair') for p in ('audit.read', 'dorm.read')]
                 + [('hq', 'hr', '*', p) for p in ('platform.staff', 'dorm.read', 'dorm.write')] + [('hq', 'hr', 'hm', 'platform.permmap'), ('store', '', 'sm', 'store.void')])


def fake_name(i):
    return R.choice(SURN) + R.choice(GIVEN) + '第%d' % i


def rand_hex(n):
    return ''.join(R.choice('0123456789abcdef') for _ in range(n))


class MockIT(MockBackend):
    """有狀態的假平台後端：人員管理、權限設定、登入鎖、改密碼、登出。資料全由本測試隨機注入。"""

    def __init__(self, base):
        super().__init__(base)
        self.calls_log = []
        self.fail_count = {}
        self.pw_changes = []
        self.token_gen = {}
        # ── 四種角色（帳號、密碼隨機）──
        emp = R.sample(range(100, 999), 3)
        self.acct = {
            'admin': 'admin',
            'hrm': 'DZY%03d' % emp[0], 'hrs': 'DZY%03d' % emp[1], 'gen': 'DZY%03d' % emp[2],
        }
        mk = lambda name, perms: {'password': 'fake-' + rand_hex(6), 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
        self.names = {'hrm': fake_name(901), 'hrs': fake_name(902), 'gen': fake_name(903)}
        USERS[self.acct['hrm']] = mk(self.names['hrm'], ['platform.self', 'platform.review', 'platform.staff', 'platform.permmap', 'dorm.read', 'dorm.write'])
        USERS[self.acct['hrs']] = mk(self.names['hrs'], ['platform.self', 'platform.review', 'platform.staff', 'dorm.read', 'dorm.write'])
        USERS[self.acct['gen']] = mk(self.names['gen'], ['platform.self'])
        # ── 同仁名單（含三位角色；單位／職稱／部門隨機）──
        self.staff = []
        n = 6 + R.randint(0, 6)
        for i in range(n):
            u = R.choice(UNITS)
            titles = [t for t in TITLES if t[2] == u[3] and (u[0] != 'ck' or t[0] in ('pt', 'ft', 'fm', 'rdd')) and (t[0] not in ('fm', 'rdd') or u[0] == 'ck')]
            t = R.choice(titles)
            self.staff.append({'emp_no': 'DZY%03d' % (10 + i), 'name': fake_name(i), 'status': R.choice(['active'] * 5 + ['disabled']), 'brand': u[2], 'unit': u[0],
                               'dept': R.choice(DEPTS)[0] if u[3] == 'hq' else '', 'title': t[0], 'reset_fail': 0})
        self.staff.append({'emp_no': self.acct['hrm'], 'name': self.names['hrm'], 'status': 'active', 'brand': 'dzy', 'unit': 'dzy-hq', 'dept': 'hr', 'title': 'hm', 'reset_fail': 0})
        self.staff.append({'emp_no': self.acct['hrs'], 'name': self.names['hrs'], 'status': 'active', 'brand': 'dzy', 'unit': 'dzy-hq', 'dept': 'hr', 'title': 'hs', 'reset_fail': 0})
        gu = R.choice([x for x in UNITS if x[3] == 'store' and x[0] != 'ck'])
        self.staff.append({'emp_no': self.acct['gen'], 'name': self.names['gen'], 'status': 'active', 'brand': gu[2], 'unit': gu[0], 'dept': '', 'title': R.choice(['pt', 'ft']), 'reset_fail': 0})
        # ── 系統帳號（人員管理）──
        self.roles = [('admin', '系統管理者', ['*']), ('accountant', '會計', ['audit.read', 'audit.write']), ('hrsys', '系統人資', ['platform.staff']),
                      ('manager', '部門主管', ['audit.read', 'dorm.read']), ('viewer', '唯讀', ['dorm.read']), ('storelead', '店長', ['audit.read.own'])]
        self.nodes = [{'value': 'sxl-gf', 'label': '麻的小辛辣 光復店'}, {'value': 'ck', 'label': '中央廚房'}, {'value': 'mzt-gf', 'label': '墨竹亭 光復店'},
                      {'value': 'mzt-js', 'label': '墨竹亭 金山店'}, {'value': 'mzt-lzl', 'label': '墨竹亭 六張犁店'}]
        if R.random() < 0.6:
            self.nodes.append({'value': 'yiwu-js', 'label': '一悟 新竹金山'})
        self.sys_users = [{'id': 'u-admin', 'username': 'BOSS', 'name': '管理者', 'role': 'admin', 'node': '', 'active': 'TRUE', 'created_at': '2026-01-01 09:00:00', 'last_login_at': '2026-10-28 08:00:00'}]
        for i in range(3 + R.randint(0, 5)):
            r = R.choice(self.roles[1:])
            self.sys_users.append({'id': 'u%03d' % (i + 2), 'username': r[0] + rand_hex(2), 'name': fake_name(100 + i), 'role': r[0],
                                   'node': R.choice([''] + [x['value'] for x in self.nodes]) if r[0] == 'storelead' else '',
                                   'active': R.choice(['TRUE', 'TRUE', 'FALSE']), 'created_at': '2026-%02d-%02d 10:00:00' % (R.randint(1, 10), R.randint(1, 28)), 'last_login_at': ''})
        self.next_uid = 100
        # ── 權限設定 ──
        self.inited = True
        self.rules = [{'rule_id': 'R%03d' % (i + 1), 'ladder': a, 'dept': b, 'title': c, 'perm': d} for i, (a, b, c, d) in enumerate(DEFAULT_RULES)]
        for rid in R.sample([r['rule_id'] for r in self.rules if r['perm'] not in LOCKED], R.randint(0, 3)):
            self.rules = [r for r in self.rules if r['rule_id'] != rid]
        for _ in range(R.randint(1, 4)):
            ladder = R.choice(['store', 'office', 'hq'])
            t = R.choice([x for x in TITLES if x[2] == ladder])
            rule = {'ladder': ladder, 'dept': R.choice(DEPTS)[0] if ladder == 'hq' and R.random() < .5 else '', 'title': R.choice(['*', t[0]]), 'perm': R.choice([p for p in GRANTABLE if p not in LOCKED])}
            if not any(self._same(r, rule) for r in self.rules):
                rule['rule_id'] = 'R%03d' % (self._max_rid() + 1)
                self.rules.append(rule)
        self.exs = []
        today = time.strftime('%Y-%m-%d', time.gmtime(time.time() + 8 * 3600))
        actives = [s for s in self.staff if s['status'] == 'active']
        for i in range(2 + R.randint(0, 4)):
            s = R.choice(actives)
            until = R.choice(['', '2099-12-31', today, '2020-01-01'])
            self.exs.append({'ex_id': 'X%03d' % (i + 1), 'emp_no': s['emp_no'], 'name': s['name'], 'perm': R.choice(GRANTABLE), 'mode': R.choice(['add', 'add', 'remove']),
                             'until': until, 'note': '隨機原因' + rand_hex(3), 'active': True, 'status': 'expired' if until == '2020-01-01' else 'active',
                             'created_at': '2026-10-%02d 09:00:00' % R.randint(1, 28), 'created_by': 'u-admin', 'revoked_at': '', 'revoked_by': ''})
        if self.exs and R.random() < .5:
            self.exs[0].update({'active': False, 'status': 'revoked', 'revoked_at': '2026-10-20 09:00:00', 'revoked_by': 'u-admin'})
        self.store_map = {u[0]: (u[0] if R.random() < .6 else '') for u in UNITS if u[3] == 'store'}
        self.audit = []
        for i in range(1 + R.randint(0, 3)):
            s = R.choice(actives)
            self.audit.append({'row': i + 2, 'at': '2026-10-%02d 10:00:00' % R.randint(1, 28), 'by': 'u-admin', 'emp_no': s['emp_no'], 'name': s['name'],
                               'added': R.choice(GRANTABLE), 'removed': '', 'cause': R.choice(['staff_edit', 'perm_ex', 'confirm']), 'seen': R.random() < .3})
        self.audit.append({'row': len(self.audit) + 2, 'at': '2026-10-27 11:00:00', 'by': 'u-admin', 'emp_no': '', 'name': '', 'added': '{}', 'removed': '', 'cause': 'perm_map', 'seen': False,
                           'detail': {'rules_added': ['R0%02d' % R.randint(10, 99)], 'rules_removed': [], 'affected': 2,
                                      'people': [{'emp_no': s['emp_no'], 'name': s['name'], 'added': ['dorm.write'], 'removed': []} for s in R.sample(actives, min(2, len(actives)))]}})
        self.my = {}
        for k in ('hrm', 'hrs', 'gen'):
            perms = [p for p in USERS[self.acct[k]]['perms'] if p in GRANTABLE]
            self.my[self.acct[k]] = {'enabled': True, 'audit_scope': 'none', 'items': [{'perm': p, 'name_zh': p, 'source': 'title', 'rule_id': 'R001'} for p in perms]}
        self.perm_calls = []
        self.user_calls = []
        self.locked_msg = '嘗試次數過多，請 15 分鐘後再試'

    # ── 小工具 ──
    @staticmethod
    def _same(a, b):
        return all(a[k] == b[k] for k in ('ladder', 'dept', 'title', 'perm'))

    def _max_rid(self):
        return max([int(r['rule_id'][1:]) for r in self.rules] + [0])

    def _who(self, body):
        tok = (body.get('token') or '')
        who = tok.replace('e2e-token-', '').split('#')[0]
        u = USERS.get(who)
        if u and self.token_gen.get(who, 0) and tok != self._token(who):
            return who, None, False   # 舊世代 token：已登出／改密碼
        return who, u, bool(u and u['user'].get('role') == 'admin')

    def _token(self, who):
        g = self.token_gen.get(who, 0)
        return 'e2e-token-' + who + ('#%d' % g if g else '')

    def _err(self, code, msg):
        return {'ok': False, 'error': msg, 'code': code}

    def matches(self, s, rule):
        u = next((x for x in UNITS if x[0] == s['unit']), None)
        if not u or u[3] != rule['ladder']:
            return False
        if rule['title'] != '*' and rule['title'] != s['title']:
            return False
        if rule['dept'] and rule['dept'] != s['dept']:
            return False
        return True

    def perms_of(self, s, rules):
        return sorted(set(r['perm'] for r in rules if self.matches(s, r)))

    def counts(self):
        out = {}
        keys = set('%s|%s|%s' % (r['ladder'], r['dept'], r['title']) for r in self.rules)
        for t in TITLES:
            keys.add('%s||%s' % (t[2], t[0]))
        for d in DEPTS:
            keys.add('hq|%s|*' % d[0])
            for t in TITLES:
                if t[2] == 'hq':
                    keys.add('hq|%s|%s' % (d[0], t[0]))
        for k in keys:
            l, d, t = k.split('|')
            out[k] = sum(1 for s in self.staff if s['status'] == 'active' and self.matches(s, {'ladder': l, 'dept': d, 'title': t}))
        return out

    # ── 分派 ──
    def platform_action(self, action, body):
        p = body.get('payload') or {}
        self.calls_log.append(action)
        if action == 'login':
            name = (p.get('username') or '').strip()
            u = USERS.get(name) or USERS.get(name.upper())
            key = name.lower()
            if self.fail_count.get(key, 0) >= 3:
                return {'ok': False, 'error': self.locked_msg}
            if not u or u['password'] != p.get('password'):
                self.fail_count[key] = self.fail_count.get(key, 0) + 1
                return {'ok': False, 'error': '帳號或密碼錯誤'}
            self.fail_count.pop(key, None)
            who = name if name in USERS else name.upper()
            return {'ok': True, 'data': {'token': self._token(who), 'user': u['user'], 'perms': u['perms'], 'device': 'dev.' + rand_hex(8)}}
        if action == 'me':
            who, u, _ = self._who(body)
            if not u:
                return {'ok': False, 'error': '登入已失效，請重新登入'}
            return {'ok': True, 'data': {'user': u['user'], 'perms': u['perms']}}
        if action == 'logout':
            who, u, _ = self._who(body)
            self.logouts = getattr(self, 'logouts', []) + [body.get('token') or '']
            if not u:
                return {'ok': False, 'error': '登入已失效，請重新登入'}
            self.token_gen[who] = self.token_gen.get(who, 0) + 1
            return {'ok': True, 'data': {}}
        if action == 'changePassword':
            who, u, _ = self._who(body)
            if not u:
                return {'ok': False, 'error': '登入已失效，請重新登入'}
            self.pw_changes.append(dict(p, who=who))
            if 'id' in p or 'emp_no' in p:
                return {'ok': False, 'error': 'mock: 前端不該送 id／emp_no'}
            if p.get('oldPassword') != u['password']:
                return {'ok': False, 'error': '目前密碼不正確'}
            if len(p.get('newPassword') or '') < 8:
                return {'ok': False, 'error': '密碼至少需要 8 個字元'}
            u['password'] = p['newPassword']
            self.token_gen[who] = self.token_gen.get(who, 0) + 1
            return {'ok': True, 'data': {'token': self._token(who), 'device': 'dev.' + rand_hex(8)}}
        if action in ('listUsers', 'saveUser', 'setActive', 'resetPassword', 'listRoles'):
            return self.users_action(action, body)
        if action.startswith('perm') or action == 'myPerms':
            self.perm_calls.append(action)
            return self.perm_action(action, body)
        if action == 'staffList':
            who, u, is_admin = self._who(body)
            if not u or not (is_admin or 'platform.staff' in u['perms']):
                return {'ok': False, 'error': '沒有權限'}
            return {'ok': True, 'data': {'staff': [dict(s, **{'brand_name': '', 'unit_name': '', 'dept_name': '', 'title_name': ''}) for s in self.staff]}}
        return super().platform_action(action, body)

    def users_action(self, action, body):
        who, u, is_admin = self._who(body)
        p = body.get('payload') or {}
        self.user_calls.append((action, who, dict(p)))
        if not u:
            return {'ok': False, 'error': '登入已失效，請重新登入'}
        if not (is_admin or 'platform.users' in u['perms']):
            return {'ok': False, 'error': '沒有權限'}
        if action == 'listUsers':
            return {'ok': True, 'data': {'users': [dict(x) for x in self.sys_users], 'nodes': list(self.nodes)}}
        if action == 'listRoles':
            return {'ok': True, 'data': {'roles': [{'role': r[0], 'name_zh': r[1], 'perms': r[2]} for r in self.roles]}}
        if action == 'saveUser':
            uname = (p.get('username') or '').strip()
            if not uname:
                return {'ok': False, 'error': '帳號不得為空'}
            if not re.search(r'[A-Za-z]', uname):
                return {'ok': False, 'error': '帳號至少要有一個英文字母'}
            if p.get('role') == 'staff':
                return {'ok': False, 'error': '同仁帳號請到同仁名單操作'}
            if not p.get('id'):
                if any(x['username'].lower() == uname.lower() for x in self.sys_users):
                    return {'ok': False, 'error': '帳號已存在'}
                if len(p.get('password') or '') < 8:
                    return {'ok': False, 'error': '密碼至少需要 8 個字元'}
                self.next_uid += 1
                nu = {'id': 'u%03d' % self.next_uid, 'username': uname, 'name': p['name'], 'role': p['role'], 'node': p.get('node') or '', 'active': 'TRUE',
                      'created_at': '2026-10-29 12:00:00', 'last_login_at': ''}
                self.sys_users.append(nu)
                return {'ok': True, 'data': {'id': nu['id']}}
            x = next((x for x in self.sys_users if x['id'] == p['id']), None)
            if not x:
                return {'ok': False, 'error': '找不到使用者'}
            if x['id'] == u['user']['id'] and x['role'] != p['role']:
                return {'ok': False, 'error': '不能修改自己的角色'}
            x.update({'username': uname, 'name': p['name'], 'role': p['role'], 'node': p.get('node') or ''})
            return {'ok': True, 'data': {'id': x['id']}}
        if action == 'setActive':
            x = next((x for x in self.sys_users if x['id'] == p.get('id')), None)
            if not x:
                return {'ok': False, 'error': '找不到使用者'}
            if p.get('active') is False and x['id'] == u['user']['id']:
                return {'ok': False, 'error': '不能停用自己的帳號'}
            x['active'] = 'TRUE' if p.get('active') else 'FALSE'
            return {'ok': True, 'data': {}}
        if action == 'resetPassword':
            x = next((x for x in self.sys_users if x['id'] == p.get('id')), None)
            if not x:
                return {'ok': False, 'error': '找不到使用者'}
            if len(p.get('newPassword') or '') < 8:
                return {'ok': False, 'error': '密碼至少需要 8 個字元'}
            return {'ok': True, 'data': {}}
        return {'ok': False, 'error': 'mock: 未知 users action'}

    def perm_action(self, action, body):
        p = body.get('payload') or {}
        who, u, is_admin = self._who(body)
        if not u:
            return {'ok': False, 'error': '登入已失效，請重新登入'}
        has_map = is_admin or 'platform.permmap' in u['perms']
        no_perm = self._err('no_perm', '沒有權限')
        me_staff = next((s for s in self.staff if s['emp_no'] == who), None)
        if action == 'myPerms':
            return {'ok': True, 'data': self.my.get(who, {'enabled': False})}
        if action in ('permMapGet', 'permMapSave', 'permWho', 'permStoreGet') and not has_map:
            return no_perm
        if action in ('permExList', 'permExSave', 'permExRevoke'):
            hr_head = bool(me_staff and me_staff['dept'] == 'hr' and me_staff['title'] == 'hm')
            if not (is_admin or hr_head):
                return no_perm
            if not is_admin and action == 'permExSave':
                if p.get('perm') not in HR_EX and not str(p.get('perm', '')).startswith('store.sm@'):
                    return no_perm
                if p.get('emp_no') == who:
                    return self._err('perm_self', '不能對自己設定例外')
        elif action in ('permStoreSave', 'permAuditList', 'permAuditSeen', 'permInit') and not is_admin:
            return no_perm
        if action == 'permMapGet':
            return {'ok': True, 'data': {
                'inited': True, 'rules': [dict(r) for r in self.rules], 'grantable': list(GRANTABLE), 'locked': list(LOCKED), 'names': dict(NAMES), 'counts': self.counts(),
                'ladders': [{'code': 'store', 'name': '門市'}, {'code': 'office', 'name': '品牌辦公室'}, {'code': 'hq', 'name': '總部'}],
                'titles': [{'code': t[0], 'name': t[1], 'ladder': t[2], 'rank': t[3]} for t in TITLES],
                'depts': [{'code': d[0], 'name': d[1], 'unit': 'dzy-hq'} for d in DEPTS], 'is_admin': is_admin}}
        if action == 'permMapSave':
            add, rem = p.get('add') or [], p.get('remove') or []
            for a in add:
                if a['perm'] not in GRANTABLE:
                    return self._err('bad_perm', '這個功能不能設定在對照表裡')
                if a['perm'] in LOCKED and not is_admin:
                    return self._err('perm_locked', '只有系統管理者能改這個功能的對象')
                if any(self._same(r, a) for r in self.rules):
                    return self._err('dup_rule', '這條規則已經存在')
            for rid in rem:
                hit = next((r for r in self.rules if r['rule_id'] == rid), None)
                if not hit:
                    return self._err('no_rule', '找不到這條規則：' + rid)
                if hit['perm'] in LOCKED and not is_admin:
                    return self._err('perm_locked', '只有系統管理者能改這個功能的對象')
            after = [r for r in self.rules if r['rule_id'] not in rem] + [dict(a, rule_id='TMP') for a in add]
            if not is_admin and me_staff and self.perms_of(me_staff, self.rules) != self.perms_of(me_staff, after):
                return self._err('perm_self', '這次修改會改變你自己的權限，請找系統管理員處理')
            people = []
            for s in self.staff:
                if s['status'] != 'active':
                    continue
                b, a2 = self.perms_of(s, self.rules), self.perms_of(s, after)
                if b != a2:
                    people.append({'emp_no': s['emp_no'], 'name': s['name'], 'added': [x for x in a2 if x not in b], 'removed': [x for x in b if x not in a2]})
            if p.get('preview') is True:
                return {'ok': True, 'data': {'preview': True, 'affected': len(people), 'people': people}}
            added = []
            for a in add:
                rid = 'R%03d' % (self._max_rid() + 1)
                self.rules.append({'rule_id': rid, 'ladder': a['ladder'], 'dept': a['dept'], 'title': a['title'], 'perm': a['perm']})
                added.append(rid)
            self.rules = [r for r in self.rules if r['rule_id'] not in rem]
            self.last_save = {'add': add, 'remove': rem, 'people': people}
            return {'ok': True, 'data': {'added': added, 'removed': list(rem), 'affected': len(people)}}
        if action == 'permWho':
            q = (p.get('q') or '').strip()
            hits = [s for s in self.staff if s['status'] == 'active' and (s['emp_no'].upper() == q.upper() or q in s['name'])][:10]
            return {'ok': True, 'data': {'items': [{'emp_no': s['emp_no'], 'name': s['name'], 'unit_name': s['unit'], 'dept_name': s['dept'], 'title_name': s['title'],
                                                     'perms': self.perms_of(s, self.rules), 'sources': [{'perm': x, 'source': 'title', 'rule_id': 'R001'} for x in self.perms_of(s, self.rules)],
                                                     'audit_scope': 'none'} for s in hits]}}
        if action == 'permExList':
            items = [dict(x) for x in self.exs if is_admin or x['perm'] in HR_EX or x['perm'].startswith('store.sm@')]
            data = {'inited': True, 'items': items, 'acting_units': [{'code': u[0], 'name': u[1]} for u in UNITS if u[3] == 'store' and u[0] != 'ck']}
            if is_admin:
                data['att_view_units'] = [{'code': u[0], 'name': u[1]} for u in UNITS if u[3] == 'store']
            return {'ok': True, 'data': data}
        if action == 'permExSave':
            if not (p.get('note') or '').strip():
                return self._err('bad_note', '原因必填，1 到 50 個字')
            hit = next((s for s in self.staff if s['emp_no'] == p.get('emp_no')), None)
            if not hit:
                return self._err('no_staff', '找不到這位同仁')
            self.last_ex = dict(p)
            self.exs.append({'ex_id': 'X%03d' % (len(self.exs) + 1), 'emp_no': p['emp_no'], 'name': hit['name'], 'perm': p['perm'], 'mode': p['mode'], 'until': p.get('until') or '',
                             'note': p['note'], 'active': True, 'status': 'active', 'created_at': '2026-10-29 13:00:00', 'created_by': u['user']['id'], 'revoked_at': '', 'revoked_by': ''})
            return {'ok': True, 'data': {'ex_id': self.exs[-1]['ex_id']}}
        if action == 'permExRevoke':
            hit = next((x for x in self.exs if x['ex_id'] == p.get('ex_id')), None)
            if not hit:
                return self._err('no_ex', '找不到這筆例外')
            hit.update({'active': False, 'status': 'revoked'})
            return {'ok': True, 'data': {'ex_id': hit['ex_id']}}
        if action == 'permStoreGet':
            return {'ok': True, 'data': {'inited': True, 'items': [{'unit': k, 'unit_name': k, 'audit_store': v} for k, v in self.store_map.items()],
                                         'units': [{'code': u[0], 'name': u[1], 'brand': u[2], 'ladder': u[3]} for u in UNITS]}}
        if action == 'permStoreSave':
            store = p.get('audit_store') or ''
            if store and any(k != p['unit'] and v == store for k, v in self.store_map.items()):
                return self._err('dup_store', '這家稽核店已經對照給別的單位了')
            self.store_map[p['unit']] = store
            return {'ok': True, 'data': {'unit': p['unit'], 'audit_store': store}}
        if action == 'permAuditList':
            return {'ok': True, 'data': {'inited': True, 'items': [dict(x) for x in reversed(self.audit)], 'unseen': sum(1 for x in self.audit if not x['seen'])}}
        if action == 'permAuditSeen':
            marked = 0
            for x in self.audit:
                if (p.get('all') is True or x['row'] in (p.get('rows') or [])) and not x['seen']:
                    x['seen'] = True
                    marked += 1
            return {'ok': True, 'data': {'marked': marked}}
        return self._err('bad_input', '未知的 perm action：' + action)


def main():
    httpd, base = start_server(PORT)
    mock = MockIT(base)
    os.makedirs(ART, exist_ok=True)
    cm = ClickMap()
    external = []
    shots = []

    def shot(pg, name):
        path = os.path.join(ART, name + '.png')
        pg.screenshot(path=path, full_page=True)
        shots.append(path)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(width=1280, height=900, query=''):
                pg = browser.new_context(viewport={'width': width, 'height': height}).new_page()
                # 外網守門：先註冊（Playwright 後註冊的先比對，所以這條是最後的保險），任何非 127.0.0.1 都擋下並記錄
                pg.route(EXTERNAL, lambda route: (external.append(route.request.url), route.abort()))
                mock.install(pg)
                pg.goto(base + '/index.html' + query)
                return pg

            def login(pg, who):
                pg.fill('#login-username', mock.acct[who])
                pg.fill('#login-password', USERS[mock.acct[who]]['password'])
                cm.click(pg, '[data-role="submit"]', '登入 → 進首頁')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def go(pg, route):
                pg.evaluate("(r) => { window.location.hash = r; }", route)

            def tabs(pg):
                pg.wait_for_selector('[data-role="view-nav"] .nav-item')
                return pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()

            def dlg(pg, label):
                sel = '.dialog-actions button:has-text("%s")' % label
                pg.wait_for_selector(sel)
                cm.scan(pg, 'dialog')
                cm.click(pg, sel, '對話框「%s」' % label)

            def toast(pg, text, timeout=4000):
                try:
                    pg.wait_for_selector('.toast:has-text("%s")' % text, timeout=timeout)
                    return True
                except Exception:
                    return False

            def cards(pg):
                return [c.get_attribute('data-module') for c in pg.locator('[data-role="module-card"]').all()]

            # ============ 登入頁：錯密碼、鎖定、第一次使用、忘記密碼、LINE 連結 ============
            lp = new_page()
            cm.scan(pg := lp, 'login')
            check(lp.locator('a[data-role="line-reset"]').count() == 1 and lp.get_attribute('a[data-role="line-reset"]', 'href').startswith('https://liff.line.me/'), 'LINE 重設密碼連結指向 liff.line.me（只驗 href，不點）')
            check(lp.locator('[data-role="line-links"] a').count() == 1, '登入頁只有「用 LINE 重設密碼」一顆（沒有開通；R3）')
            lp.fill('#login-username', mock.acct['gen'])
            lp.fill('#login-password', 'wrong-' + rand_hex(4))
            cm.click(lp, '[data-role="submit"]', '登入失敗顯示錯誤')
            lp.wait_for_selector('[data-role="error"]:not([hidden])')
            check(lp.inner_text('[data-role="error"]') == '帳號或密碼錯誤' and lp.input_value('#login-password') == '', '密碼錯 → 顯示「帳號或密碼錯誤」、密碼欄清空')
            for i in range(2):
                lp.fill('#login-password', 'wrong-' + rand_hex(4))
                lp.click('[data-role="submit"]')
                lp.wait_for_function("() => document.querySelector('[data-role=\"submit\"]').disabled === false || document.querySelector('[data-role=\"hint\"]').innerText.includes('秒')")
            check('嘗試次數過多' in lp.inner_text('[data-role="hint"]') and lp.locator('[data-role="submit"]').is_disabled(), '前端連錯 3 次 → 冷卻倒數、送出鈕 disabled：%s' % lp.inner_text('[data-role="hint"]'))
            check(mock.fail_count.get(mock.acct['gen'].lower()) == 3, '後端 mock 收到 3 次失敗')
            # 另一個頁面：後端鎖定訊息原樣顯示
            lp2 = new_page()
            lp2.fill('#login-username', mock.acct['gen'])
            lp2.fill('#login-password', USERS[mock.acct['gen']]['password'])
            lp2.click('[data-role="submit"]')
            lp2.wait_for_selector('[data-role="error"]:not([hidden])')
            check(lp2.inner_text('[data-role="error"]') == mock.locked_msg, '後端鎖定 → 畫面顯示「嘗試次數過多，請 15 分鐘後再試」（正確密碼也擋）')
            mock.fail_count.clear()
            # 第一次使用
            cm.click(lp2, 'a[data-role="to-claim"]', '第一次使用 → 查詢編號畫面')
            lp2.wait_for_selector('#claim-name')
            cm.scan(lp2, 'claim-name')
            lp2.fill('#claim-name', '不存在的名字')
            cm.click(lp2, '[data-role="submit"]', '查詢編號')
            lp2.wait_for_selector('[data-role="error"]:not([hidden])')
            check('找不到' in lp2.inner_text('[data-role="error"]'), '第一次使用：名字不在名單 → 中文提示')
            cm.click(lp2, 'button[data-role="back"]', '回登入')
            lp2.wait_for_selector('#login-username')
            check(lp2.evaluate('() => location.hash') in ('', '#', '#/'), '回登入頁後網址不留 #/claim（%s）' % lp2.evaluate('() => location.hash'))
            # 忘記密碼（原流程只能從網址進，登入頁沒有連結——見回報）
            go(lp2, '#/forgot')
            lp2.wait_for_selector('#forgot-emp')
            cm.scan(lp2, 'forgot')
            lp2.fill('#forgot-emp', mock.acct['gen'])
            lp2.fill('#forgot-birthday', '1990-01-01')
            lp2.fill('#forgot-phone', '0912345678')
            lp2.fill('#forgot-pw', 'fake-newpw-1')
            lp2.fill('#forgot-pw2', 'fake-newpw-2')
            cm.click(lp2, 'button[data-role="submit"]', '忘記密碼送出')
            lp2.wait_for_selector('[data-role="error"]:not([hidden])')
            check('不一樣' in lp2.inner_text('[data-role="error"]'), '忘記密碼：兩次密碼不一樣 → 前端擋')
            lp2.fill('#forgot-pw2', 'fake-newpw-1')
            lp2.click('button[data-role="submit"]')
            lp2.wait_for_function("() => document.querySelector('[data-role=\"error\"]') && !document.querySelector('[data-role=\"error\"]').hidden && document.querySelector('[data-role=\"error\"]').innerText.includes('資料不符')")
            check('forgotReset' in mock.calls_log, '忘記密碼：送到後端 forgotReset、顯示後端「資料不符」')
            cm.click(lp2, 'button[data-role="back"]', '忘記密碼 → 回登入')
            lp2.wait_for_selector('#login-username')
            shot(lp2, 'login-375' if False else 'login-1280')
            lp.close(); lp2.close()

            # ============ admin ============
            ad = new_page()
            login(ad, 'admin')
            ids = cards(ad)
            check('users' in ids and 'perms' in ids, 'admin 首頁有人員管理、權限設定卡片')
            cm.scan(ad, 'home-admin', ['.side-user'])
            # ── 人員管理 ──
            cm.click(ad, '[data-nav="users"]', '側欄 → 人員管理')
            ad.wait_for_selector('[data-role="user-row"]')
            cm.scan(ad, 'users-list')
            cm.click(ad, '[data-view="list"]', '分頁「人員清單」（唯一分頁，點了留在原頁）')
            ad.wait_for_selector('[data-role="user-row"]')
            rows = ad.locator('[data-role="user-row"]').all()
            exp_users = [u for u in mock.sys_users]
            check(len(rows) == len(exp_users), '人員清單筆數＝mock %d' % len(exp_users))
            got = [[c.inner_text() for c in r.locator('td').all()[:6]] for r in rows]
            role_zh = {r[0]: r[1] for r in mock.roles}
            node_zh = {n['value']: n['label'] for n in mock.nodes}
            node_zh[''] = '不限節點'
            exp_rows = [[u['id'], u['username'], u['name'], role_zh[u['role']], node_zh.get(u['node'], u['node']), '啟用' if u['active'] == 'TRUE' else '停用'] for u in exp_users]
            check(got == exp_rows, '每列 ID／帳號／姓名／角色中文／節點中文／狀態逐格一致', )
            if got != exp_rows:
                print('  got=%s\n  exp=%s' % (got, exp_rows))
            check(ad.locator('[data-role="user-row"][data-id="u-admin"] [data-action="toggle-active"]').count() == 0, '自己那列沒有停用鈕')
            # 新增：取消、Esc、送出
            cm.click(ad, '[data-role="add-user"]', '開新增使用者對話框')
            ad.wait_for_selector('[data-role="user-form-overlay"]')
            cm.scan(ad, 'users-add-dialog', ['[data-role="user-form-overlay"]'])
            opts = ad.locator('[data-role="user-form-overlay"] select[data-field="role"] option').all_inner_texts()
            check(opts == [r[1] for r in mock.roles], '角色下拉＝listRoles 回的中文名：%s' % opts)
            nopts = ad.locator('[data-role="user-form-overlay"] select[data-field="node"] option').all_inner_texts()
            check(nopts == ['不限節點'] + [n['label'] for n in mock.nodes], '節點下拉＝listUsers 回的 nodes（含隨機加的門市）：%s' % nopts)
            cm.click(ad, '[data-role="user-form-overlay"] [data-role="cancel"]', '取消新增')
            check(ad.locator('[data-role="user-form-overlay"]').count() == 0, '取消關閉對話框')
            ad.click('[data-role="add-user"]')
            ad.keyboard.press('Escape')
            check(ad.locator('[data-role="user-form-overlay"]').count() == 0, 'Esc 關閉對話框')
            ad.click('[data-role="add-user"]')
            cm.click(ad, '[data-role="user-form-overlay"] [data-role="submit"]', '空白送出 → 必填提示')
            check(ad.inner_text('[data-role="user-form-overlay"] [data-role="form-error"]') == '帳號與姓名為必填', '帳號姓名空白 → 「帳號與姓名為必填」')
            new_user = {'username': 'newacc' + rand_hex(3), 'name': fake_name(500), 'role': R.choice(mock.roles[1:])[0], 'node': R.choice(mock.nodes)['value'], 'password': 'fake-pw-' + rand_hex(5)}
            ad.fill('[data-role="user-form-overlay"] input[data-field="username"]', new_user['username'])
            ad.fill('[data-role="user-form-overlay"] input[data-field="name"]', new_user['name'])
            ad.fill('[data-role="user-form-overlay"] input[data-field="password"]', 'short')
            ad.click('[data-role="user-form-overlay"] [data-role="submit"]')
            check('至少需要 8' in ad.inner_text('[data-role="user-form-overlay"] [data-role="form-error"]'), '密碼太短 → 前端擋')
            ad.fill('[data-role="user-form-overlay"] input[data-field="password"]', new_user['password'])
            ad.select_option('[data-role="user-form-overlay"] select[data-field="role"]', new_user['role'])
            ad.select_option('[data-role="user-form-overlay"] select[data-field="node"]', new_user['node'])
            cm.mark(cm.key(ad, '[data-role="user-form-overlay"] select[data-field="role"]'), '角色／節點下拉 select_option')
            ad.click('[data-role="user-form-overlay"] [data-role="submit"]')
            check(toast(ad, '已新增'), '新增 → 「已新增」')
            sent = [c for c in mock.user_calls if c[0] == 'saveUser'][-1][2]
            check(sent == new_user, '送出的 saveUser payload 逐欄一致：%s' % sent)
            ad.wait_for_function("(n) => document.querySelectorAll('[data-role=\"user-row\"]').length === n", arg=len(exp_users) + 1)
            new_id = mock.sys_users[-1]['id']
            check(ad.locator('[data-role="user-row"][data-id="%s"]' % new_id).inner_text().find(new_user['username']) != -1, '清單重讀後出現新帳號')
            # 編輯
            cm.click(ad, '[data-role="user-row"][data-id="%s"] [data-action="edit-user"]' % new_id, '編輯使用者')
            ad.wait_for_selector('[data-role="user-form-overlay"]')
            check(ad.input_value('[data-role="user-form-overlay"] input[data-field="username"]') == new_user['username'] and ad.locator('[data-role="user-form-overlay"] input[data-field="password"]').count() == 0, '編輯表單帶入現值、沒有密碼欄')
            ad.fill('[data-role="user-form-overlay"] input[data-field="name"]', new_user['name'] + '改')
            ad.click('[data-role="user-form-overlay"] [data-role="submit"]')
            check(toast(ad, '已儲存'), '編輯 → 「已儲存」')
            sent = [c for c in mock.user_calls if c[0] == 'saveUser'][-1][2]
            check(sent == {'id': new_id, 'username': new_user['username'], 'name': new_user['name'] + '改', 'role': new_user['role'], 'node': new_user['node']}, '編輯 payload 含 id、不含密碼：%s' % sent)
            # 停用／啟用
            cm.click(ad, '[data-role="user-row"][data-id="%s"] [data-action="toggle-active"]' % new_id, '停用（確認框）')
            dlg(ad, '取消')
            check(mock.sys_users[-1]['active'] == 'TRUE', '取消 → 沒停用')
            ad.click('[data-role="user-row"][data-id="%s"] [data-action="toggle-active"]' % new_id)
            dlg(ad, '確定')
            check(toast(ad, '已更新') and mock.sys_users[-1]['active'] == 'FALSE', '確定 → 停用、「已更新」')
            ad.wait_for_function("(id) => document.querySelector('[data-role=\"user-row\"][data-id=\"' + id + '\"]').innerText.includes('停用')", arg=new_id)
            check(ad.locator('[data-role="user-row"][data-id="%s"] [data-action="toggle-active"]' % new_id).inner_text() == '啟用', '停用後按鈕變「啟用」')
            # 重設密碼
            cm.click(ad, '[data-role="user-row"][data-id="%s"] [data-action="reset-password"]' % new_id, '重設密碼對話框')
            ad.wait_for_selector('[data-role="password-form-overlay"]')
            cm.scan(ad, 'users-pw-dialog', ['[data-role="password-form-overlay"]'])
            ad.fill('[data-role="password-form-overlay"] input[data-field="newPassword"]', 'short')
            cm.click(ad, '[data-role="password-form-overlay"] [data-role="submit"]', '重設送出')
            check('至少需要 8' in ad.inner_text('[data-role="password-form-overlay"] [data-role="form-error"]') and ad.locator('[data-role="password-form-overlay"]').count() == 1, '太短：不關窗、顯示錯誤')
            cm.click(ad, '[data-role="password-form-overlay"] [data-role="cancel"]', '取消重設')
            check(ad.locator('[data-role="password-form-overlay"]').count() == 0 and not any(c[0] == 'resetPassword' for c in mock.user_calls), '取消 → 不送後端')
            ad.click('[data-role="user-row"][data-id="%s"] [data-action="reset-password"]' % new_id)
            npw = 'fake-reset-' + rand_hex(4)
            ad.fill('[data-role="password-form-overlay"] input[data-field="newPassword"]', npw)
            ad.click('[data-role="password-form-overlay"] [data-role="submit"]')
            dlg(ad, '確定')
            check(toast(ad, '密碼已重設') and [c for c in mock.user_calls if c[0] == 'resetPassword'][-1][2] == {'id': new_id, 'newPassword': npw}, '重設密碼 payload 正確、「密碼已重設」')
            shot(ad, 'users-admin')

            # ── 權限設定：對照表 ──
            cm.click(ad, '[data-nav="perms"]', '側欄 → 權限設定')
            ad.wait_for_selector('[data-role="feature-row"]')
            check(tabs(ad) == ['對照表', '個別例外', '店別對照', '權限異動'], 'admin 四個分頁：%s' % tabs(ad))
            cm.scan(ad, 'perms-map')
            cm.click(ad, '[data-view="map"]', '分頁「對照表」')
            ad.wait_for_selector('[data-role="feature-row"]')
            perms_order = [r.get_attribute('data-perm') for r in ad.locator('[data-role="feature-row"]').all()]
            check(perms_order == GRANTABLE, '右側功能列順序＝grantable（%d 列）' % len(perms_order))
            locked_rows = [r.get_attribute('data-perm') for r in ad.locator('[data-role="feature-row"][data-locked="1"]').all()]
            check(sorted(locked_rows) == sorted(LOCKED), '鎖碼列＝後端 locked：%s' % locked_rows)
            role_btns = ad.locator('.pm-role').all()
            keys = [b.get_attribute('data-key') for b in role_btns]
            counts = mock.counts()
            # 人數逐身分比對
            bad = []
            for b in role_btns:
                k = b.get_attribute('data-key')
                txt = b.locator('[data-role="role-count"]').inner_text().strip()
                exp = ('%d 人' % counts[k]) if k in counts else ''
                if txt != exp:
                    bad.append((k, txt, exp))
            check(not bad, '每個身分的人數＝mock counts（%d 身分）' % len(keys))
            if bad:
                print('  不一致：%s' % bad)
            # 「其他」分組：現有規則目標不在清單時要顯示（例如停用的 oam）
            other_keys = set('%s|%s|%s' % (r['ladder'], r['dept'], r['title']) for r in mock.rules) - set(keys)
            check(not other_keys, '每條現有規則的目標都有身分列（不會被藏起來）：缺 %s' % other_keys)
            # 逐身分：開關狀態＝規則
            bad = []
            for k in R.sample(keys, min(5, len(keys))):
                ad.click('.pm-role[data-key="%s"]' % k)
                l, d, t = k.split('|')
                for perm in GRANTABLE:
                    on = ad.get_attribute('[data-role="feature-row"][data-perm="%s"] [data-act="toggle"]' % perm, 'aria-checked') == 'true'
                    exp = any(r['ladder'] == l and r['dept'] == d and r['title'] == t and r['perm'] == perm for r in mock.rules)
                    if on != exp:
                        bad.append((k, perm, on, exp))
            cm.mark(cm.key(ad, '.pm-role'), '選身分 → 右側開關刷新')
            check(not bad, '抽 5 個身分 × %d 功能：開關狀態＝規則' % len(GRANTABLE))
            if bad:
                print('  不一致：%s' % bad[:5])
            # 隨機改幾個開關 → 摘要 → 還原 → 再改 → preview → 取消 → 確認 → mock 規則集＝預期
            target_key = R.choice([k for k in keys if k.split('|')[0] != 'hq' or k.split('|')[2] != 'hm'])
            ad.click('.pm-role[data-key="%s"]' % target_key)
            editable = [p for p in GRANTABLE if p not in LOCKED]
            flips = R.sample(editable, 2 + R.randint(0, 2))
            l, d, t = target_key.split('|')
            before_on = {perm: any(r['ladder'] == l and r['dept'] == d and r['title'] == t and r['perm'] == perm for r in mock.rules) for perm in flips}
            for perm in flips:
                ad.click('[data-role="feature-row"][data-perm="%s"] [data-act="toggle"]' % perm)
            cm.mark(cm.key(ad, '[data-act="toggle"]'), '開關 → 未儲存摘要')
            msg = ad.inner_text('[data-role="bar-msg"]')
            check(msg.startswith('未儲存') and (('等 %d 項' % len(flips)) in msg if len(flips) > 2 else True), '開關後摘要：%s' % msg)
            n_calls = len(mock.perm_calls)
            cm.click(ad, '[data-act="revert"]', '還原 → 開關回原狀')
            check(all((ad.get_attribute('[data-role="feature-row"][data-perm="%s"] [data-act="toggle"]' % perm, 'aria-checked') == 'true') == before_on[perm] for perm in flips) and '沒有未儲存' in ad.inner_text('[data-role="bar-msg"]'), '還原後開關與摘要回原狀')
            check(len(mock.perm_calls) == n_calls, '開關與還原都不打後端')
            for perm in flips:
                ad.click('[data-role="feature-row"][data-perm="%s"] [data-act="toggle"]' % perm)
            exp_add = [{'ladder': l, 'dept': d, 'title': t, 'perm': perm} for perm in flips if not before_on[perm]]
            exp_remove = sorted(r['rule_id'] for r in mock.rules if r['ladder'] == l and r['dept'] == d and r['title'] == t and r['perm'] in flips and before_on[r['perm']])
            # preview 名單預期：mock.staff 中 active 且命中身分、且實際權限會變的人
            cm.click(ad, '[data-act="save"]', '儲存 → preview 對話框')
            ad.wait_for_selector('[data-role="preview-body"]')
            cm.scan(ad, 'perms-preview')
            pv = ad.inner_text('[data-role="preview-body"]')
            after_rules = [r for r in mock.rules if r['rule_id'] not in exp_remove] + [dict(a, rule_id='TMP') for a in exp_add]
            exp_people = [s for s in mock.staff if s['status'] == 'active' and mock.perms_of(s, mock.rules) != mock.perms_of(s, after_rules)]
            check(('%d' % len(exp_people) in pv) if exp_people else ('不會改到' in pv), 'preview 人數＝獨立算 %d：%s' % (len(exp_people), pv.replace('\n', ' ')[:120]))
            check(all(('%s（%s）' % (s['name'], s['emp_no'])) in pv for s in exp_people[:30]), 'preview 列出每位受影響同仁的名字與編號')
            check(mock.perm_calls[-1] == 'permMapSave' and len(mock.rules) == len([r for r in mock.rules]), 'preview 已送 permMapSave(preview)')
            n_rules = len(mock.rules)
            dlg(ad, '取消')
            check(len(mock.rules) == n_rules and '未儲存' in ad.inner_text('[data-role="bar-msg"]'), '取消 → 不寫入、畫面變更保留')
            ad.click('[data-act="save"]')
            ad.wait_for_selector('[data-role="preview-body"]')
            dlg(ad, '確認儲存')
            ad.wait_for_function("() => document.querySelector('[data-role=\"bar-msg\"]').innerText.includes('沒有未儲存')")
            check(toast(ad, '已儲存'), '確認儲存 → 「已儲存」')
            ls = mock.last_save
            check(sorted(json.dumps(a, sort_keys=True) for a in ls['add']) == sorted(json.dumps(a, sort_keys=True) for a in exp_add) and sorted(ls['remove']) == exp_remove,
                  '送出的 add／remove＝由開關獨立推算：add=%s remove=%s' % (ls['add'], ls['remove']))
            for perm in flips:
                on = ad.get_attribute('[data-role="feature-row"][data-perm="%s"] [data-act="toggle"]' % perm, 'aria-checked') == 'true'
                check(on == (not before_on[perm]), '儲存後重讀 %s 開關＝%s' % (perm, not before_on[perm]))
            shot(ad, 'perms-map-admin')
            # 查同仁
            who = R.choice([s for s in mock.staff if s['status'] == 'active'])
            ad.fill('[data-role="who-input"]', who['emp_no'])
            ad.wait_for_selector('[data-role="who-item"]')
            wtxt = ad.inner_text('[data-role="who-result"]')
            check(who['name'] in wtxt and who['emp_no'] in wtxt, '查同仁（編號）→ 顯示 %s' % who['name'])
            exp_perms = mock.perms_of(who, mock.rules)
            check(all(ad.locator('[data-role="who-item"] li[data-perm="%s"]' % perm).count() == 1 for perm in exp_perms) and ad.locator('[data-role="who-item"] li[data-perm]').count() == len(exp_perms), '查同仁：列出的功能＝該同仁依規則算出的 %d 個' % len(exp_perms))
            ad.fill('[data-role="who-input"]', who['name'][:2])
            exp_hits = [s for s in mock.staff if s['status'] == 'active' and who['name'][:2] in s['name']][:10]
            ad.press('[data-role="who-input"]', 'Enter')
            ad.wait_for_function("(n) => document.querySelectorAll('[data-role=\"who-item\"]').length === n", arg=len(exp_hits), timeout=5000)
            check(ad.locator('[data-role="who-item"]').count() == len(exp_hits), '查同仁（姓名模糊）→ %d 筆' % len(exp_hits))
            ad.fill('[data-role="who-input"]', '沒這個人zz')
            ad.press('[data-role="who-input"]', 'Enter')
            ad.wait_for_selector('[data-role="who-msg"]')
            check('找不到' in ad.inner_text('[data-role="who-msg"]'), '查不到 → 提示')
            cm.mark(cm.key(ad, '[data-role="who-input"]'), '查同仁輸入')

            # ── 個別例外 ──
            cm.click(ad, '[data-view="ex"]', '分頁 → 個別例外')
            ad.wait_for_selector('[data-role="ex-form"]')
            cm.scan(ad, 'perms-ex')
            exp_items = sorted(mock.exs, key=lambda x: ({'active': 0, 'expired': 1, 'revoked': 2}[x['status']], x['ex_id']))
            got_ids = [e.get_attribute('data-ex') for e in ad.locator('[data-role="ex-item"]').all()]
            check(len(got_ids) == len(mock.exs), '例外清單 %d 筆' % len(mock.exs))
            status_order = [e.get_attribute('data-status') for e in ad.locator('[data-role="ex-item"]').all()]
            check(status_order == sorted(status_order, key=lambda s: {'active': 0, 'expired': 1, 'revoked': 2}[s]), '生效中排前、過期／撤銷排後：%s' % status_order)
            for x in mock.exs:
                it = ad.locator('[data-role="ex-item"][data-ex="%s"]' % x['ex_id'])
                txt = it.inner_text()
                okk = x['name'] in txt and x['emp_no'] in txt and x['note'] in txt and (('拿掉' if x['mode'] == 'remove' else '多給') in txt)
                okk = okk and (('到 %s' % x['until']) in txt if x['until'] else True)
                okk = okk and ((x['status'] != 'active') == ('is-dim' in (it.get_attribute('class') or '')))
                okk = okk and (it.locator('[data-act="revoke"]').count() == (0 if x['status'] == 'revoked' else 1))   # 過期的仍可撤銷（列還在 perm_ex）
                check(okk, '例外 %s 每欄顯示正確（%s／%s／%s）' % (x['ex_id'], x['mode'], x['status'], x['until'] or '不到期'))
            feat_opts = ad.locator('[data-role="ex-perm"] option').all()
            vals = [o.get_attribute('value') for o in feat_opts]
            missing_feats = [p for p in GRANTABLE if p not in vals]
            check(not missing_feats, '★系統問題候選：admin 個別例外的功能下拉應含後端 grantable 全部 %d 碼，缺 %s（lib.js FEATURE_ORDER 沒跟上 Perms.gs PERM_GRANTABLE）' % (len(GRANTABLE), missing_feats))
            check('__att_view__' in vals and '__acting__' in vals and '__payroll_store__' in vals, 'admin 功能下拉含只看考勤／兼任店長／薪酬負責門市')
            ad.fill('[data-role="ex-who"]', '沒這個人')
            ad.fill('[data-role="ex-note"]', '')
            cm.click(ad, '[data-role="ex-submit"]', '新增例外送出')
            check('原因必填' in ad.inner_text('[data-role="ex-error"]') or '找不到' in ad.inner_text('[data-role="ex-error"]'), '表單驗證有擋：%s' % ad.inner_text('[data-role="ex-error"]'))
            target = R.choice([s for s in mock.staff if s['status'] == 'active'])
            perm = R.choice(GRANTABLE)
            mode = R.choice(['add', 'remove'])
            ad.fill('[data-role="ex-who"]', target['emp_no'])
            ad.select_option('[data-role="ex-perm"]', perm)
            ad.select_option('[data-role="ex-mode"]', mode)
            hint_visible = ad.locator('[data-role="ex-hint"]').is_visible()
            check(hint_visible == (perm == 'audit.read' and mode == 'remove'), '「拿掉看全部店稽核」才顯示填單提示（%s %s → %s）' % (perm, mode, hint_visible))
            until = R.choice(['', '2099-06-30'])
            ad.fill('[data-role="ex-until"]', until)
            note = '隨機原因' + rand_hex(4)
            ad.fill('[data-role="ex-note"]', note)
            ad.click('[data-role="ex-submit"]')
            check(toast(ad, '已新增例外'), '新增例外 → 「已新增例外」')
            check(mock.last_ex == {'emp_no': target['emp_no'], 'perm': perm, 'mode': mode, 'until': until, 'note': note}, '送出 payload 正確：%s' % mock.last_ex)
            new_ex = mock.exs[-1]['ex_id']
            ad.wait_for_selector('[data-role="ex-item"][data-ex="%s"]' % new_ex)
            cm.click(ad, '[data-role="ex-item"][data-ex="%s"] [data-act="revoke"]' % new_ex, '撤銷（確認框）')
            dlg(ad, '取消')
            check(mock.exs[-1]['active'], '取消撤銷 → 仍生效')
            ad.click('[data-role="ex-item"][data-ex="%s"] [data-act="revoke"]' % new_ex)
            dlg(ad, '確定')
            ad.wait_for_selector('[data-role="ex-item"][data-ex="%s"][data-status="revoked"]' % new_ex)
            check(not mock.exs[-1]['active'] and ad.locator('[data-role="ex-item"][data-ex="%s"] [data-act="revoke"]' % new_ex).count() == 0, '撤銷 → 標已撤銷、沒有撤銷鈕')
            # 只看考勤／兼任店長／薪酬門市：選了才出現門市欄、模式鎖 add
            ad.select_option('[data-role="ex-perm"]', '__att_view__')
            check(ad.locator('[data-role="ex-unit-field"]').is_visible() and ad.locator('[data-role="ex-mode"]').is_disabled() and ad.input_value('[data-role="ex-mode"]') == 'add', '只看考勤 → 門市下拉出現、模式鎖多給')
            ad.select_option('[data-role="ex-perm"]', '__acting__')
            check(ad.locator('[data-role="ex-acting-field"]').is_visible() and ad.locator('[data-role="ex-unit-field"]').is_hidden(), '兼任店長 → 兼任門市下拉出現、只看考勤收起')
            ad.fill('[data-role="ex-who"]', target['emp_no'])
            ad.fill('[data-role="ex-note"]', '兼任測試')
            ad.click('[data-role="ex-submit"]')
            check('請選擇門市' in ad.inner_text('[data-role="ex-error"]'), '兼任店長沒選門市 → 「請選擇門市」')
            act_unit = R.choice([u[0] for u in UNITS if u[3] == 'store' and u[0] != 'ck'])
            ad.select_option('[data-role="ex-acting"]', act_unit)
            ad.click('[data-role="ex-submit"]')
            check(toast(ad, '已新增例外') and mock.last_ex['perm'] == 'store.sm@' + act_unit and mock.last_ex['mode'] == 'add', '兼任店長送出 store.sm@%s、add' % act_unit)
            ad.wait_for_selector('[data-role="ex-item"][data-ex="%s"]' % mock.exs[-1]['ex_id'])
            check('兼任店長' in ad.locator('[data-role="ex-item"][data-ex="%s"]' % mock.exs[-1]['ex_id']).inner_text(), '清單顯示「兼任店長（門市）」')
            ad.select_option('[data-role="ex-perm"]', '__payroll_store__')
            check(ad.locator('[data-role="ex-pay-field"]').is_visible(), '薪酬負責門市 → 門市欄出現')
            ad.fill('[data-role="ex-who"]', target['emp_no'])
            ad.fill('[data-role="ex-note"]', '薪酬測試')
            pay_input = ad.locator('[data-role="ex-pay"]')
            if pay_input.evaluate('e => e.tagName') == 'INPUT':
                pay_input.fill('cf')
                ad.click('[data-role="ex-submit"]')
                check(toast(ad, '已新增例外') and mock.last_ex['perm'] == 'payroll.store@CF', '薪酬門市手動輸入 cf → payroll.store@CF（轉大寫）')
            cm.mark(cm.key(ad, '[data-role="ex-perm"]'), '功能下拉切換')
            cm.mark(cm.key(ad, '[data-role="ex-mode"]'), '模式下拉')
            for sel in ('[data-role="ex-unit"]', '[data-role="ex-acting"]', '[data-role="ex-pay"]'):
                if ad.locator(sel).count():
                    cm.mark(cm.key(ad, sel), '門市下拉')
            shot(ad, 'perms-ex-admin')

            # ── 店別對照 ──
            cm.click(ad, '[data-view="stores"]', '分頁 → 店別對照')
            ad.wait_for_selector('[data-role="store-row"]')
            cm.scan(ad, 'perms-stores')
            store_units = [u for u in UNITS if u[3] == 'store']
            check(ad.locator('[data-role="store-row"]').count() == len(store_units), '門市單位列數 %d（辦公室、總部不列）' % len(store_units))
            for u in store_units:
                row = ad.locator('[data-role="store-row"][data-unit="%s"]' % u[0])
                cur = mock.store_map.get(u[0], '')
                check((('還沒對照' in row.inner_text()) == (cur == '')) and (cur == '' or cur in row.inner_text()), '店別 %s 顯示＝mock（%s）' % (u[0], cur or '還沒對照'))
            tgt = R.choice(store_units)[0]
            row = ad.locator('[data-role="store-row"][data-unit="%s"]' % tgt)
            row.locator('select').select_option('__other__')
            check(row.locator('[data-role="store-other-wrap"]').is_visible(), '選「其他代碼…」→ 出現輸入框')
            code = 'st-' + rand_hex(4)
            row.locator('[data-role="store-other"]').fill(code)
            cm.click(ad, '[data-role="store-row"][data-unit="%s"] [data-act="save"]' % tgt, '店別對照儲存')
            ad.wait_for_function("(a) => document.querySelector('[data-role=\"store-row\"][data-unit=\"' + a[0] + '\"]').innerText.includes(a[1])", arg=[tgt, code])
            check(mock.store_map[tgt] == code, '店別對照寫入 mock：%s→%s' % (tgt, code))
            other = R.choice([u[0] for u in store_units if u[0] != tgt])
            row2 = ad.locator('[data-role="store-row"][data-unit="%s"]' % other)
            row2.locator('select').select_option('__other__')
            row2.locator('[data-role="store-other"]').fill(code)
            row2.locator('[data-act="save"]').click()
            check(toast(ad, '已經對照給別的單位'), '重複店代碼 → 後端中文錯誤 toast')
            for sel_el in ad.locator('[data-role="store-sel"]').all():
                cm.mark(sel_el.evaluate(__import__('dd_it_clickmap').KEY_JS), '稽核店別下拉（select_option）')

            # ── 權限異動 ──
            cm.click(ad, '[data-view="audit"]', '分頁 → 權限異動')
            ad.wait_for_selector('[data-role="audit-item"]')
            cm.scan(ad, 'perms-audit')
            unseen = sum(1 for x in mock.audit if not x['seen'])
            check(ad.locator('[data-role="audit-item"]').count() == len(mock.audit) and ad.locator('[data-role="audit-item"][data-seen="0"]').count() == unseen, '異動 %d 筆、未看 %d' % (len(mock.audit), unseen))
            pm = [x for x in mock.audit if x['cause'] == 'perm_map'][0]
            cm.click(ad, '[data-role="audit-item"][data-row="%d"] [data-act="toggle"]' % pm['row'], '展開受影響的人')
            ptxt = ad.inner_text('[data-role="audit-item"][data-row="%d"] [data-role="people"]' % pm['row'])
            check(all(pp['name'] in ptxt for pp in pm['detail']['people']), 'perm_map 列展開：受影響同仁名字都在')
            first_unseen = next((x for x in mock.audit if not x['seen'] and x['cause'] != 'perm_map'), None)
            if first_unseen:
                cm.click(ad, '[data-role="audit-item"][data-row="%d"] [data-act="seen"]' % first_unseen['row'], '逐列已看過')
                ad.wait_for_function("(n) => document.querySelectorAll('[data-role=\"audit-item\"][data-seen=\"0\"]').length === n", arg=unseen - 1)
                check(first_unseen['seen'] and sum(1 for x in mock.audit if not x['seen']) == unseen - 1, '逐列「已看過」只標那一列')
            cm.click(ad, '[data-act="seen-all"]', '全部標為已看過')
            ad.wait_for_function("() => document.querySelectorAll('[data-role=\"audit-item\"][data-seen=\"0\"]').length === 0")
            check(all(x['seen'] for x in mock.audit), '全部已看過')
            shot(ad, 'perms-audit-admin')

            # ── 側欄：首頁、我的資料、改密碼、登出 ──
            cm.click(ad, '[data-nav="__home__"]', '側欄首頁')
            ad.wait_for_selector('[data-role="module-card"]')
            cm.click(ad, '[data-nav="__password__"]', '改密碼對話框')
            ad.wait_for_selector('#pw-old')
            cm.scan(ad, 'pw-dialog')
            dlg(ad, '取消')
            check(ad.locator('.dialog').count() == 0 and not mock.pw_changes, '改密碼取消 → 不送後端')
            ad.click('[data-nav="__password__"]')
            ad.fill('#pw-old', USERS['admin']['password'])
            ad.fill('#pw-new', 'fake-new-pw-1')
            ad.fill('#pw-new2', 'fake-new-pw-2')
            dlg(ad, '確定修改')
            check(toast(ad, '兩次輸入的新密碼不一致') and not mock.pw_changes, '新密碼不一致 → 前端擋、重開對話框')
            ad.wait_for_selector('#pw-old')
            ad.fill('#pw-old', USERS['admin']['password'])
            ad.fill('#pw-new', 'short')
            ad.fill('#pw-new2', 'short')
            dlg(ad, '確定修改')
            check(toast(ad, '至少需要 8') and not mock.pw_changes, '太短 → 前端擋')
            ad.wait_for_selector('#pw-old')
            ad.fill('#pw-old', 'wrong-old')
            ad.fill('#pw-new', 'fake-new-pw-1')
            ad.fill('#pw-new2', 'fake-new-pw-1')
            dlg(ad, '確定修改')
            check(toast(ad, '目前密碼不正確') and len(mock.pw_changes) == 1 and 'id' not in mock.pw_changes[0], '舊密碼錯 → 後端訊息；payload 不含 id')
            old_tok = ad.evaluate("() => localStorage.getItem('dzy.token')")
            ad.click('[data-nav="__password__"]')
            ad.fill('#pw-old', USERS['admin']['password'])
            new_admin_pw = 'fake-admin-' + rand_hex(5)
            ad.fill('#pw-new', new_admin_pw)
            ad.fill('#pw-new2', new_admin_pw)
            dlg(ad, '確定修改')
            check(toast(ad, '密碼已更新'), '改密碼成功 → 「密碼已更新」')
            new_tok = ad.evaluate("() => localStorage.getItem('dzy.token')")
            check(new_tok != old_tok and new_tok == mock._token('admin'), '前端換上後端新發的 token（舊的已失效）')
            go(ad, '#/users/list')
            ad.wait_for_selector('[data-role="user-row"]')
            check(True, '改密碼後不用重登，仍能用')
            shot(ad, 'home-admin')
            cm.click(ad, '[data-nav="__logout__"]', '登出')
            ad.wait_for_selector('#login-username')
            check(getattr(mock, 'logouts', [])[-1:] == [new_tok] and ad.evaluate("() => localStorage.getItem('dzy.token')") is None, '登出：後端收到該 token、本機 token 清掉、回登入頁')
            check(ad.evaluate("() => localStorage.getItem('dzy.device')") is not None, '登出不清「認得的手機」憑證')
            ad.goto(base + '/index.html#/users/list')
            ad.wait_for_selector('#login-username')
            check(ad.locator('[data-role="user-row"]').count() == 0, '登出後重開網址直接回登入頁、看不到資料')
            ad.close()

            # ============ 人資主管（platform.permmap，非 admin） ============
            hr = new_page()
            login(hr, 'hrm')
            ids = cards(hr)
            check('perms' in ids and 'users' not in ids and 'staff' in ids, '人資主管首頁：有權限設定、同仁名單，沒有人員管理：%s' % ids)
            check(hr.locator('[data-dept="it"] [data-nav="perms"]').count() == 1, '權限設定在資訊部門底下')
            cm.click(hr, '[data-nav="perms"]', '人資主管 → 權限設定')
            hr.wait_for_selector('[data-role="feature-row"]')
            check(tabs(hr) == ['對照表', '個別例外'], '人資主管兩個分頁：%s' % tabs(hr))
            lk = hr.locator('[data-role="feature-row"][data-locked="1"] [data-act="toggle"]')
            check(lk.count() == len(LOCKED) and lk.locator(':scope[disabled]').count() == len(LOCKED), '鎖碼 %d 列開關 disabled' % len(LOCKED))
            check(hr.locator('[data-role="lock-note"]').count() == len(LOCKED), '鎖列標「只有系統管理員能改」')
            hr.locator('[data-perm="platform.users"] [data-act="toggle"]').click(force=True)
            check('沒有未儲存' in hr.inner_text('[data-role="bar-msg"]'), '硬點 disabled 的鎖碼開關 → 沒有變更')
            # 自改 → perm_self
            hr.click('.pm-role[data-key="hq|hr|hm"]')
            cand = [p for p in GRANTABLE if p not in LOCKED and not any(r['ladder'] == 'hq' and r['dept'] in ('hr', '') and r['title'] in ('*', 'hm') and r['perm'] == p for r in mock.rules)]
            hr.click('[data-perm="%s"] [data-act="toggle"]' % cand[0])
            hr.click('[data-act="save"]')
            check(toast(hr, '這個改動會改到你自己的權限'), '人資主管改到自己 → perm_self 中文 toast')
            hr.click('[data-act="revert"]')
            # 不碰自己：成功
            hr.click('.pm-role[data-key="store||pt"]')
            cand2 = [p for p in GRANTABLE if p not in LOCKED and not any(r['ladder'] == 'store' and r['title'] in ('*', 'pt') and r['perm'] == p for r in mock.rules)]
            hr.click('[data-perm="%s"] [data-act="toggle"]' % cand2[0])
            hr.click('[data-act="save"]')
            hr.wait_for_selector('[data-role="preview-body"]')
            dlg(hr, '確認儲存')
            check(toast(hr, '已儲存') and any(r['ladder'] == 'store' and r['title'] == 'pt' and r['perm'] == cand2[0] for r in mock.rules), '人資主管改門市計時同仁 → 儲存成功')
            # 直接打 API 送鎖碼 → perm_locked 中文
            res = hr.evaluate("""async () => {
              const api = await import('./platform/api.js');
              const lib = await import('./modules/perms/lib.js');
              const r = await api.call('platform', 'permMapSave', { add: [{ ladder: 'store', dept: '', title: 'pt', perm: 'platform.staff' }] });
              return { ok: r.ok, code: lib.codeOf(r), text: lib.errorText(r) };
            }""")
            check(res['ok'] is False and res['code'] == 'perm_locked' and '系統管理員' in res['text'], '繞過畫面送鎖碼 → perm_locked 中文：%s' % res)
            go(hr, '#/perms/ex')
            hr.wait_for_selector('[data-role="ex-perm"]')
            opts = hr.locator('[data-role="ex-perm"] option').all()
            vals = [o.get_attribute('value') for o in opts]
            check(vals == HR_EX + ['__acting__'], '人資主管功能下拉＝三碼＋兼任店長（沒有只看考勤、薪酬門市）：%s' % vals)
            check(hr.locator('[data-role="ex-unit-field"]').count() == 0 and hr.locator('[data-role="ex-pay-field"]').count() == 0, '沒有只看考勤／薪酬門市欄')
            shown = [e.get_attribute('data-ex') for e in hr.locator('[data-role="ex-item"]').all()]
            exp_shown = [x['ex_id'] for x in mock.exs if x['perm'] in HR_EX or x['perm'].startswith('store.sm@')]
            check(sorted(shown) == sorted(exp_shown), '人資主管只看到三碳＋兼任的例外（%d 筆）' % len(exp_shown))
            hr.fill('[data-role="ex-who"]', mock.acct['hrm'])
            hr.fill('[data-role="ex-note"]', '給自己')
            hr.click('[data-role="ex-submit"]')
            hr.wait_for_selector('[data-role="ex-error"]:not([hidden])')
            et = hr.inner_text('[data-role="ex-error"]')
            check('不能對自己' in et or '改到你自己' in et, '人資主管對自己設例外 → perm_self 中文：%s' % et)
            go(hr, '#/perms/stores')
            hr.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            check(True, '人資主管改網址進店別對照 → 彈回首頁')
            go(hr, '#/perms/audit')
            hr.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            go(hr, '#/users/list')
            hr.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            check(hr.locator('[data-role="user-row"]').count() == 0 and not any(c[1] == mock.acct['hrm'] for c in mock.user_calls), '人資主管改網址進人員管理 → 彈回首頁、沒打 listUsers')
            shot(hr, 'perms-map-hrm')
            hr.close()

            # ============ 人資同仁（platform.staff，沒有 permmap） ============
            hs = new_page()
            login(hs, 'hrs')
            ids = cards(hs)
            check('perms' not in ids and 'users' not in ids and 'staff' in ids and 'me' in ids, '人資同仁首頁：同仁名單、我的資料；沒有權限設定、人員管理：%s' % ids)
            go(hs, '#/perms/map')
            hs.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            check(not any(a in ('permMapGet',) for a in mock.perm_calls[-3:]), '人資同仁改網址進權限設定 → 彈回首頁、不打 permMapGet')
            res = hs.evaluate("""async () => { const api = await import('./platform/api.js'); const r = await api.call('platform', 'permMapGet', {}); return r; }""")
            check(res.get('ok') is False and (res.get('code') == 'no_perm' or res.get('error') == '沒有權限'), '人資同仁直接打 permMapGet → 沒有權限：%s' % res)
            go(hs, '#/me/profile')
            hs.wait_for_selector('[data-role="my-perms"]')
            check('我能用的功能' in hs.inner_text('[data-role="my-perms"]'), '我的資料顯示「我能用的功能」')
            hs.close()

            # ============ 一般同仁（只有 platform.self） ============
            gp = new_page(width=375, height=812)
            login(gp, 'gen')
            ids = cards(gp)
            check('me' in ids and not ({'users', 'perms', 'staff'} & set(ids)), '一般同仁首頁沒有人員管理／權限設定／同仁名單：%s' % ids)
            for route in ('#/users/list', '#/perms/map', '#/perms/ex', '#/staff/list'):
                go(gp, route)
                gp.wait_for_function("() => window.location.hash === '#/home'", timeout=5000)
            check(not any(c[1] == mock.acct['gen'] for c in mock.user_calls), '一般同仁改網址進四個後台頁都彈回首頁、沒打人員管理 API')
            check(gp.evaluate('() => document.documentElement.scrollWidth <= 375'), '手機 375 寬無橫向捲動')
            cm.scan(gp, 'home-gen-375', ['.side-user'])
            gp.click('[data-nav="__password__"]')
            gp.wait_for_selector('#pw-old')
            gp.fill('#pw-old', USERS[mock.acct['gen']]['password'])
            gpw = 'fake-gen-' + rand_hex(5)
            gp.fill('#pw-new', gpw)
            gp.fill('#pw-new2', gpw)
            dlg(gp, '確定修改')
            check(toast(gp, '密碼已更新') and mock.pw_changes[-1]['who'] == mock.acct['gen'] and 'id' not in mock.pw_changes[-1], '一般同仁改密碼：身分只由 token 決定、payload 無 id')
            shot(gp, 'home-gen-375')
            cm.click(gp, '[data-nav="__logout__"]', '一般同仁登出')
            gp.wait_for_selector('#login-username')
            # 離線登出補送：模擬登出時後端沒回（pendingLogout）
            gp2 = new_page()
            login(gp2, 'gen') if False else None
            gp2.fill('#login-username', mock.acct['gen'])
            gp2.fill('#login-password', gpw)
            gp2.click('[data-role="submit"]')
            gp2.wait_for_selector('[data-role="module-card"]', state='attached')
            tok = gp2.evaluate("() => localStorage.getItem('dzy.token')")
            mock.logout_fail = True
            orig = mock.platform_action

            def flaky(action, body):
                if action == 'logout' and getattr(mock, 'logout_fail', False):
                    return {'ok': False, 'error': 'BUSY'}
                return orig(action, body)
            mock.platform_action = flaky
            gp2.click('[data-nav="__logout__"]')
            gp2.wait_for_selector('#login-username')
            check(gp2.evaluate("() => localStorage.getItem('dzy.pendingLogout')") == tok and gp2.evaluate("() => localStorage.getItem('dzy.token')") is None, '登出時後端忙 → 記 pendingLogout、本機照樣清 token')
            mock.logout_fail = False
            n_logout = len(getattr(mock, 'logouts', []))
            gp2.reload()
            gp2.wait_for_selector('#login-username')
            gp2.wait_for_function("() => localStorage.getItem('dzy.pendingLogout') === null", timeout=5000)
            check(mock.logouts[-1] == tok and len(mock.logouts) == n_logout + 1, '下次開頁補送那一個 token 的 logout、成功後刪掉 pendingLogout')
            gp2.close()

            browser.close()

        check(mock.leaked == [] and external == [], '真實網路零流出：leaked=%s external=%s' % (mock.leaked, external))
        rep = cm.report()
        print('按鈕稽核：掃到 %d、點過 %d、刻意不點 %d、漏 %d' % (rep['total'], rep['clicked'], len(rep['skipped']), len(rep['missed'])))
        for k, v in rep['skipped'].items():
            print('  SKIP %s：%s' % (k, v))
        check(not rep['missed'], '每顆掃到的按鈕／連結都點過：漏 %s' % rep['missed'])
        print('截圖 %d 張：%s' % (len(shots), ART))
    finally:
        httpd.shutdown()
    print('共 %d 項檢查，失敗 %d（SEED=%d）' % (_count[0], len(failures), SEED))
    finish()


# 計數：包一層 check 以便最後印「共 N 項」
_count = [0]
_orig_check = check


def check(cond, label):   # noqa: F811
    _count[0] += 1
    _orig_check(cond, label)


if __name__ == '__main__':
    main()
