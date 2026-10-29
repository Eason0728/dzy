# -*- coding: utf-8 -*-
"""資料帶入測試（首頁底下三模組）的有狀態假後端：每次執行隨機重抽組織、同仁（假名）、核決權限級距、單據。
規則照 docs/approvals/spec.md §2／§5／§14 與 api.md 自己實作一份（不抄 apv_mock.py 的寫死資料），
前端送來的 payload 形狀照 api.md 驗；路線、可見度、can 旗標都由這裡算，測試再用自己的算式比對畫面。
⚠ 全部假名、DZY9xx；dzy 是 public repo。
"""
import copy
import random
import time

import apv_mock            # 只借它的照片 svc 路由（file_dispatch）與 1x1 JPEG
from common import MockBackend, USERS

ROLES = ['head', 'brand_dir', 'ceo', 'gm', 'chair']
TITLE = {'pt': ('store', 1, '計時同仁'), 'ft': ('store', 2, '正職同仁'), 'sm': ('store', 3, '店長'), 'am': ('store', 4, '區經理'),
         'ofs': ('office', 1, '行政同仁'), 'osv': ('office', 2, '區督導'), 'odir': ('office', 3, '總監'),
         'hs': ('hq', 1, '部門同仁'), 'hm': ('hq', 2, '總監'), 'ceo': ('hq', 3, '執行長'), 'gm': ('hq', 4, '總經理'), 'chair': ('hq', 5, '董事長')}
UNITS = {'mala-gf': ('新竹光復', 'mala', 'store'), 'mala-hq': ('小辛辣品牌辦公室', 'mala', 'office'), 'dzy-hq': ('鼎兆元總部', 'dzy', 'hq')}
DEPT_NAME = {'fin': '財務部', 'hr': '人資部', 'purchase': '採購部', 'it': '資訊部', 'mgmt': '管理部'}
HANDLER = {'purchase': 'purchase', 'expense': 'fin', 'personnel': 'hr'}
HOUR = 3600 * 1000
NOW = int(time.time() * 1000)

SUR = ['測', '試', '假', '虛', '擬', '樣', '範', '例']
GIV = list('甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥')


class Dataset:
    """隨機資料：people（key＝角色代號）、rows（權限表）、seed。"""

    def __init__(self, seed):
        self.seed = seed
        self.r = random.Random(seed)
        self._names = set()
        self._emp = 900
        self.people = {}
        self.vacant = []
        r = self.r
        add = self._add
        add('pt', 'mala-gf', '', 'pt', ['platform.self'])
        add('ft', 'mala-gf', '', 'ft', ['platform.self'])
        add('sm', 'mala-gf', '', 'sm', ['platform.self', 'platform.review'])
        if r.random() < 0.7:
            add('odir', 'mala-hq', '', 'odir', ['platform.self', 'platform.review'])
        else:
            self.vacant.append('odir')
        if r.random() < 0.6:
            add('ceo', 'dzy-hq', 'mgmt', 'ceo', ['platform.self'])
        else:
            self.vacant.append('ceo')
        if r.random() < 0.75:
            add('gm', 'dzy-hq', 'mgmt', 'gm', ['platform.self'])
        else:
            self.vacant.append('gm')
        add('chair', 'dzy-hq', 'mgmt', 'chair', ['platform.self'])
        add('hr', 'dzy-hq', 'hr', 'hs', ['platform.self', 'platform.staff', 'platform.bulletin'])
        add('pur', 'dzy-hq', 'purchase', 'hs', ['platform.self'])
        add('fin', 'dzy-hq', 'fin', 'hs', ['platform.self'])
        if r.random() < 0.5:
            add('ithm', 'dzy-hq', 'it', 'hm', ['platform.self', 'platform.review'])
        # 認領中的新人（店長待審核）
        self.newbie = self._person('mala-gf', '', 'pt')
        self.newbie['status'] = 'pending'
        self.rows = self._table()
        pw = {k: 'pw-%s-%d' % (k, r.randint(1000, 9999)) for k in self.people}
        for k, p in self.people.items():
            USERS[p['emp']] = {'password': pw[k], 'perms': p['perms'],
                               'user': {'id': 'u-' + p['emp'], 'name': p['name'], 'role': 'hr' if k == 'hr' else 'staff', 'node': ''}}

    def _name(self):
        while True:
            n = self.r.choice(SUR) + self.r.choice(GIV) + self.r.choice(GIV)
            if n not in self._names:
                self._names.add(n)
                return n

    def _person(self, unit, dept, title):
        self._emp += 1
        r = self.r
        return {'emp': 'DZY%d' % self._emp, 'name': self._name(), 'unit': unit, 'dept': dept, 'title': title, 'status': 'active',
                'birthday': '19%02d-%02d-%02d' % (r.randint(70, 99), r.randint(1, 12), r.randint(1, 28)),
                'phone': '09%08d' % r.randint(0, 99999999), 'address': '測試市假想路%d號' % r.randint(1, 999)}

    def _add(self, key, unit, dept, title, perms):
        p = self._person(unit, dept, title)
        p['perms'] = perms
        p['key'] = key
        self.people[key] = p
        return p

    def _table(self):
        r = self.r
        if r.random() < 0.4:
            return [{'seq': 1, 'max': 5000, 'store_role': 'head', 'hq_role': 'head'}, {'seq': 2, 'max': 10000, 'store_role': 'brand_dir', 'hq_role': 'head'},
                    {'seq': 3, 'max': 30000, 'store_role': 'gm', 'hq_role': 'gm'}, {'seq': 4, 'max': None, 'store_role': 'chair', 'hq_role': 'chair'}]
        n = r.randint(2, 5)
        maxes, cur, pool = [], 0, [5000, 10000, 30000]
        for _ in range(n - 1):
            cur += r.randint(1, 20000)
            if pool and r.random() < 0.5 and pool[0] > cur:
                cur = pool.pop(0)
            maxes.append(cur)
        return [{'seq': i + 1, 'max': None if i == n - 1 else maxes[i], 'store_role': r.choice(ROLES), 'hq_role': r.choice(ROLES)} for i in range(n)]

    # ── 規格算式（給 mock 與測試共用：測試端另有自己的一份對照）──
    def by_emp(self, emp):
        for p in self.people.values():
            if p['emp'] == emp:
                return p
        return None

    def cands(self, role, of, exclude):
        lad = UNITS[of['unit']][2]
        of_rank = TITLE[of['title']][1]
        out = []
        for p in self.people.values():
            if p['status'] != 'active' or p['emp'] in exclude:
                continue
            pl, pr = TITLE[p['title']][0], TITLE[p['title']][1]
            if role == 'head':
                if lad == 'store':
                    hit = p['unit'] == of['unit'] and p['title'] in ('sm', 'fm')
                elif lad == 'hq':
                    hit = of['dept'] != '' and p['unit'] == of['unit'] and p['dept'] == of['dept'] and p['title'] == 'hm'
                else:
                    hit = p['unit'] == of['unit'] and pl == 'office' and pr == 2
            elif role == 'brand_dir':
                hit = p['title'] == 'odir' and UNITS[p['unit']][1] == UNITS[of['unit']][1] and UNITS[p['unit']][2] == 'office'
            elif role == 'direct':
                if lad == 'store' and of_rank <= 2:
                    hit = p['unit'] == of['unit'] and pl == 'store' and pr >= 3
                elif lad == 'store':   # 店長：品牌辦公室 rank≥2 或同店職級更高
                    hit = (pl == 'office' and pr >= 2 and UNITS[p['unit']][1] == UNITS[of['unit']][1]) or (p['unit'] == of['unit'] and pl == 'store' and pr > of_rank)
                elif lad == 'office':
                    hit = p['unit'] == of['unit'] and p['title'] == 'odir' if of['title'] != 'odir' else pl == 'hq' and pr >= 3
                else:
                    hit = (p['unit'] == of['unit'] and p['dept'] == of['dept'] and p['title'] == 'hm') if of_rank == 1 else (pl == 'hq' and pr >= 3)
            else:
                hit = p['title'] == role
            if hit and not (pl == lad and pr <= of_rank):
                out.append(p['emp'])
        return sorted(out)

    def spend_route(self, sender, amount):
        """回 {row, first_role, steps:[{role,status,cands}], status}"""
        row = next(r for r in self.rows if r['max'] is None or amount <= r['max'])
        role = row['hq_role'] if UNITS[sender['unit']][2] == 'hq' else row['store_role']
        steps = []
        while True:
            c = self.cands(role, sender, [sender['emp']])
            if c:
                steps.append({'role': role, 'status': 'pending', 'cands': c})
                return {'row': row, 'first_role': steps[0]['role'], 'steps': steps, 'status': 'signing'}
            steps.append({'role': role, 'status': 'skipped', 'cands': []})
            i = ROLES.index(role)
            if i == len(ROLES) - 1:
                return {'row': row, 'first_role': steps[0]['role'], 'steps': steps, 'status': 'exception'}
            role = ROLES[i + 1]

    def personnel_route(self, kind, sender, subject, signed):
        steps = []
        if kind == 'leave':
            steps.append({'role': 'self_sign', 'status': 'done' if signed else 'pending', 'cands': [] if signed else [subject['emp']], 'emp': subject['emp']})
        if kind == 'raise':
            role, of = 'gm', subject
        else:
            direct = self.cands('direct', subject, [subject['emp']])
            of = sender if sender['emp'] in direct else subject
            role = 'direct'
        exclude = [sender['emp'], subject['emp']]
        while True:
            c = self.cands(role, of, exclude)
            if c:
                steps.append({'role': role, 'status': 'pending', 'cands': c})
                return {'steps': steps, 'status': 'signing'}
            steps.append({'role': role, 'status': 'skipped', 'cands': []})
            role = 'brand_dir' if role == 'direct' else (ROLES[ROLES.index(role) + 1] if role != 'chair' else None)
            if role is None:
                return {'steps': steps, 'status': 'exception'}

    @staticmethod
    def calc_amount(items):
        total = 0
        for it in items:
            q, p = it.get('qty'), it.get('price')
            if not isinstance(q, (int, float)) or not isinstance(p, (int, float)) or isinstance(q, bool):
                return None
            if not (0 < q <= 9999) or abs(q * 100 - round(q * 100)) > 1e-7 or not (0 < p <= 1000000) or int(p) != p:
                return None
            total += int(q * p + 0.5)
        return total if 0 < total <= 10000000 else None


class HomeMock(MockBackend):
    def __init__(self, base_url, ds):
        super().__init__(base_url)
        self.ds = ds
        self.apv_state = {'files': {}, 'file_seq': 100, 'svc_calls': [], 'calls': []}
        self.forms = []
        self.events = {}
        self.seq = 0
        self.client_ids = {}
        self.ver = 1
        self.rows = copy.deepcopy(ds.rows)
        self.sso = []            # (who, aud)
        self.me_calls = []
        self.newbie_status = 'pending'
        self.newbie_reject = ''
        # 兩張種子單：卡關 3 天以上的簽核中請款（送件人 pt）、承辦中的請購（給採購）
        pt = ds.people['pt']
        rt = ds.spend_route(pt, 100)
        self._add_form('expense', pt, 100, {'spend_date': '2026-10-20', 'category': 'repair', 'amount': 100, 'desc': '種子：卡關請款', 'payee': 'self'},
                       ['F001'], rt, created=NOW - 100 * HOUR, stuck=True, seed=True)
        rt2 = ds.spend_route(pt, 2500)
        f2 = self._add_form('purchase', pt, 2500, {'items': [{'name': '乾辣椒', 'qty': 10, 'unit': '包', 'price': 250}], 'purpose': '種子：承辦中', 'need_date': '2026-11-01'},
                            [], rt2, created=NOW - 30 * HOUR, seed=True)
        for s in f2['route']['steps']:
            if s['status'] == 'pending':
                s['status'] = 'done'
                s['by'] = s['cands'][0] if s['cands'] else ''
        f2['status'], f2['step'] = 'handling', None

    # ── 共用 ──
    def who(self, token):
        name = (token or '').replace('e2e-token-', '')
        if name == 'admin':
            return {'admin': True, 'staff': True, 'emp': 'admin', 'p': None}
        p = self.ds.by_emp(name)
        if p is None and name == self.ds.newbie['emp']:
            return {'admin': False, 'staff': False, 'emp': name, 'p': None}
        if not p:
            return None
        return {'admin': False, 'staff': 'platform.staff' in p['perms'], 'emp': p['emp'], 'p': p}

    def _step_view(self, s):
        o = {'role': s['role'], 'scope': '', 'status': s['status']}
        for k in ('by', 'at', 'override', 'emp'):
            if k in s:
                o[k] = s[k]
        o['candidates'] = [{'emp': e, 'name': self.ds.by_emp(e)['name']} for e in self._live_cands(s)]
        return o

    def _live_cands(self, s):
        if s.get('override'):
            return [s['override']['to']]
        return s['cands'] if s['status'] == 'pending' else []

    def _add_form(self, typ, sender, amount, body, files, rt, created=None, stuck=False, seed=False, subject=None):
        self.seq += 1
        fid = 'APV-%s-%03d' % (time.strftime('%y%m%d', time.gmtime(NOW / 1000 + 8 * 3600)), self.seq)
        step = next((i for i, s in enumerate(rt['steps']) if s['status'] == 'pending'), None)
        if rt['status'] == 'exception':
            step = len(rt['steps']) - 1   # 同後端 apvAdvance_：exception 停在最後一個 skipped 關
        f = {'id': fid, 'type': typ, 'status': rt['status'], 'rev': 1, 'step': step if rt['status'] != 'handling' else None,
             'sender': sender, 'subject': subject, 'amount': amount, 'body': body, 'files': [{'id': x, 'kind': 'receipt', 'bytes': 1} for x in files],
             'route': {'v': 1, 'thr_ver': self.ver, 'row': ({'seq': rt['row']['seq'], 'max': rt['row']['max'], 'role': rt['first_role']} if rt.get('row') else None),
                       'steps': copy.deepcopy(rt['steps']), 'handler': HANDLER[typ]},
             'handler_dept': HANDLER[typ], 'created_at': created or NOW, 'updated_at': created or NOW, 'stuck': stuck or rt['status'] == 'exception'}
        if rt['status'] == 'signing' and step is None:
            f['status'] = 'handling'
        self.forms.append(f)
        self.events[fid] = [{'at': f['created_at'], 'rev': 1, 'actor': {'emp': sender['emp'], 'name': sender['name']}, 'action': 'submit', 'note': ''}]
        for s in rt['steps']:
            if s['status'] == 'skipped':
                self.events[fid].append({'at': f['created_at'], 'rev': 1, 'actor': {'emp': 'system', 'name': '系統'}, 'action': 'skip', 'note': s['role'] + ' 找不到合格的人'})
        return f

    def _cands_now(self, f):
        if f['status'] != 'signing' or f['step'] is None:
            return []
        return self._live_cands(f['route']['steps'][f['step']])

    def _is_handler(self, w, f):
        return bool(w['p']) and w['p']['dept'] == f['handler_dept']

    def _can(self, f, w):
        me = w['emp']
        cands = self._cands_now(f)
        step = f['route']['steps'][f['step']] if f['status'] == 'signing' and f['step'] is not None else None
        selfsign = bool(step) and step['role'] == 'self_sign'
        done_non_self = any(s['status'] == 'done' and s['role'] != 'self_sign' for s in f['route']['steps'])
        return {'decide': f['status'] == 'signing' and me in cands and not selfsign,
                'sign': f['status'] == 'signing' and me in cands and selfsign,
                'resubmit': f['status'] == 'rejected' and f['sender']['emp'] == me,
                'withdraw': f['status'] == 'signing' and f['sender']['emp'] == me and not done_non_self,
                'handle': f['status'] == 'handling' and self._is_handler(w, f),
                'reassign': f['status'] in ('signing', 'exception') and w['staff'],
                'void': f['status'] not in ('done', 'voided') and (w['staff'] or w['admin'])}

    def _signed_before(self, f, emp):
        return any(s.get('by') == emp or s.get('rej') == emp or (s.get('override') or {}).get('to') == emp for s in f['route']['steps']) or \
            any(e['actor']['emp'] == emp and e['action'] in ('approve', 'reject', 'sign', 'handle') for e in self.events.get(f['id'], []))

    def _can_view(self, f, w):
        if w['staff'] or w['admin']:
            return True
        if f['sender']['emp'] == w['emp']:
            return True
        if self._is_handler(w, f) and f['status'] in ('handling', 'done'):
            return True
        if w['emp'] in self._cands_now(f):
            return True
        return self._signed_before(f, w['emp'])

    def _view(self, f, w, body=False):
        sender = f['sender']
        o = {'id': f['id'], 'type': f['type'], 'status': f['status'], 'rev': f['rev'], 'step': f['step'],
             'sender': {'emp': sender['emp'], 'name': sender['name'], 'unit_name': UNITS[sender['unit']][0]},
             'amount': f['amount'], 'files': f['files'],
             'route': dict(f['route'], steps=[self._step_view(s) for s in f['route']['steps']]),
             'handler_dept': f['handler_dept'], 'created_at': f['created_at'], 'updated_at': f['updated_at'], 'stuck': f['stuck'], 'can': self._can(f, w)}
        if f.get('subject'):
            o['subject'] = {'emp': f['subject']['emp'], 'name': f['subject']['name']}
        if body:
            o['body'] = f['body']
        if f['status'] == 'rejected':
            ev = [e for e in self.events.get(f['id'], []) if e['action'] in ('reject', 'handle') and e['note']]
            if ev:
                o['reject_note'] = {'note': ev[-1]['note'], 'by': ev[-1]['actor']['name']}
        return o

    @staticmethod
    def _err(code, message=None):
        r = {'ok': False, 'error': code}
        if message:
            r['message'] = message
        return r

    # ── 分派 ──
    def platform_action(self, action, body):
        payload = body.get('payload') or {}
        token = body.get('token') or ''
        if action == 'ssoTicket':
            w = self.who(token)
            self.sso.append(((w or {}).get('emp'), payload.get('aud')))
            return {'ok': True, 'data': {'ticket': 'fake-ticket-%d' % len(self.sso)}}
        if action in ('myProfile', 'orgOptions', 'myUnit', 'unitPending', 'unitApprove', 'unitReject', 'clockAlerts', 'myPerms', 'saveMyProfile'):
            self.me_calls.append((action, (token or '').replace('e2e-token-', '')))
            return self.me_action(action, payload, token)
        if action.startswith('apv'):
            self.apv_state['calls'].append((action, copy.deepcopy(payload), (token or '').replace('e2e-token-', '')))
            return self.apv_action2(action, payload, token)
        return super().platform_action(action, body)

    # ── 我的資料 ──
    def _profile(self, p):
        u = UNITS[p['unit']]
        t = TITLE[p['title']]
        return {'emp_no': p['emp'], 'name': p['name'], 'status': p['status'], 'phone': p['phone'], 'birthday': p['birthday'], 'address': p['address'],
                'brand': u[1], 'brand_name': {'mala': '麻的小辛辣', 'dzy': '鼎兆元總部'}[u[1]], 'unit': p['unit'], 'unit_name': u[0],
                'dept': p['dept'], 'dept_name': DEPT_NAME.get(p['dept'], ''), 'title': p['title'], 'title_name': t[2],
                'p_brand': '', 'p_unit': '', 'p_dept': '', 'p_title': '', 'p_brand_name': '', 'p_unit_name': '', 'p_dept_name': '', 'p_title_name': '',
                'has_pending_change': False, 'reject_reason': '', 'claimed_at': '2026-10-01 10:00:00', 'extra_dept_names': []}

    def me_action(self, action, payload, token):
        w = self.who(token)
        if not w:
            return self._err('token 無效')
        p = w['p']
        if action == 'orgOptions':
            return {'ok': True, 'data': {'brands': [{'code': 'mala', 'name': '麻的小辛辣'}, {'code': 'dzy', 'name': '鼎兆元總部'}],
                                         'units': [{'code': k, 'name': v[0], 'parent': v[1], 'ladder': v[2]} for k, v in UNITS.items()],
                                         'depts': [{'code': k, 'name': v, 'parent': 'dzy-hq'} for k, v in DEPT_NAME.items()],
                                         'titles': [{'code': k, 'name': v[2], 'parent': v[0], 'rank': v[1]} for k, v in TITLE.items()]}}
        if action == 'myPerms':
            return {'ok': True, 'data': {'enabled': False}}
        if action == 'clockAlerts':
            return {'ok': False, 'error': 'mock: 不在本組範圍'}
        if action == 'myProfile':
            if not p:
                return {'ok': True, 'data': {'none': True}}
            return {'ok': True, 'data': self._profile(p)}
        if action == 'saveMyProfile':
            if not p:
                return self._err('找不到資料')
            if (payload.get('phone') or '') != p['phone'] and not payload.get('current_password'):
                return self._err('改手機要輸入目前的密碼')
            p['address'] = payload.get('address', p['address'])
            return {'ok': True, 'data': self._profile(p)}
        if action == 'myUnit':
            if not p:
                return self._err('只有店長（總部為總監）以上可以看單位通訊錄')
            lad, rank = TITLE[p['title']][0], TITLE[p['title']][1]
            mgr = (lad == 'store' and rank >= 3) or (lad == 'office' and rank >= 2) or (lad == 'hq' and rank >= 2 and p['dept'])
            if not mgr:
                return self._err('只有店長（總部為總監）以上可以看單位通訊錄')
            priv = lad == 'store' and rank >= 3
            ppl = [q for q in self.ds.people.values() if q['unit'] == p['unit'] and (lad != 'hq' or q['dept'] == p['dept'])]
            if p['unit'] == 'mala-gf' and self.newbie_status == 'active':
                ppl = ppl + [self.ds.newbie]
            out = []
            for q in ppl:
                o = {'emp_no': q['emp'], 'name': q['name'], 'title': q['title'], 'title_name': TITLE[q['title']][2], 'phone': q['phone']}
                if priv:
                    o['birthday'] = q['birthday']
                    o['address'] = q['address']
                out.append(o)
            return {'ok': True, 'data': {'unit_name': UNITS[p['unit']][0], 'private': priv, 'people': out, 'regions': []}}
        # 待審核：同店店長（mala-gf sm）或人資
        is_hr = w['staff']
        can_review = is_hr or (p and p['unit'] == 'mala-gf' and TITLE[p['title']][0] == 'store' and TITLE[p['title']][1] >= 3)
        if not can_review:
            return self._err('只有單位主管可以審核')
        nb = self.ds.newbie
        if action == 'unitPending':
            people = []
            if self.newbie_status == 'pending':
                people.append({'emp_no': nb['emp'], 'name': nb['name'], 'brand': 'mala', 'brand_name': '麻的小辛辣', 'unit': 'mala-gf', 'unit_name': UNITS['mala-gf'][0],
                               'dept': '', 'dept_name': '', 'title': 'pt', 'title_name': '計時同仁', 'birthday': nb['birthday'], 'phone': nb['phone'], 'address': nb['address'], 'claimed_at': '2026-10-28 09:00:00'})
            return {'ok': True, 'data': {'people': people, 'scope_name': '' if is_hr else UNITS['mala-gf'][0], 'all_units': is_hr}}
        if payload.get('emp_no') != nb['emp'] or self.newbie_status != 'pending':
            return self._err('這位同仁不在認領待審核')
        if action == 'unitApprove':
            self.newbie_status = 'active'
            return {'ok': True, 'data': {'emp_no': nb['emp']}}
        if not (payload.get('reason') or '').strip():
            return self._err('請填寫退回原因')
        self.newbie_status = 'unclaimed'
        self.newbie_reject = payload['reason']
        return {'ok': True, 'data': {'emp_no': nb['emp']}}

    # ── 表單簽核 ──
    def apv_action2(self, action, payload, token):
        w = self.who(token)
        if not w:
            return self._err('unauthorized')
        by_id = {f['id']: f for f in self.forms}
        ds = self.ds
        if action == 'apvThresholdGet':
            return {'ok': True, 'data': {'ver': self.ver, 'rows': self.rows}}
        if action == 'apvThresholdSave':
            if not w['admin']:
                return self._err('forbidden')
            if payload.get('expected_ver') != self.ver:
                return self._err('conflict')
            rows = payload.get('rows') or []
            prev = 0
            for i, r in enumerate(rows):
                last = i == len(rows) - 1
                if r.get('store_role') not in ROLES or r.get('hq_role') not in ROLES:
                    return self._err('bad_request', '權限人代碼不合法')
                if last and r.get('max') is not None:
                    return self._err('bad_request', '最後一列必須是以上全部')
                if not last and (not isinstance(r.get('max'), int) or r['max'] <= prev):
                    return self._err('bad_request', '金額必須遞增')
                prev = r.get('max') or prev
            self.rows = rows
            self.ver += 1
            return {'ok': True, 'data': {'ver': self.ver, 'diff': []}}
        if action == 'apvRoutePreview':
            if not w['p']:
                return self._err('forbidden')
            t = payload.get('type')
            if t in ('purchase', 'expense'):
                rt = ds.spend_route(w['p'], payload.get('amount') or 0)
                steps = rt['steps']
            else:
                subj = ds.by_emp(payload.get('subject') or '') or w['p']
                rt = ds.personnel_route(payload.get('kind') or 'leave', w['p'], subj, subj['emp'] == w['emp'])
                steps = rt['steps']
            return {'ok': True, 'data': {'steps': [self._step_view(s) for s in steps], 'handler': HANDLER.get(t, 'fin')}}
        if action == 'apvMine':
            if not w['p']:
                return {'ok': True, 'data': {'forms': []}}
            mine = [f for f in self.forms if f['sender']['emp'] == w['emp'] and (not payload.get('status') or f['status'] == payload['status'])]
            mine.sort(key=lambda f: -f['created_at'])
            return {'ok': True, 'data': {'forms': [self._view(f, w) for f in mine]}}
        if action == 'apvTodo':
            sign = [self._view(f, w) for f in self.forms if f['status'] == 'signing' and w['emp'] in self._cands_now(f)]
            handle = [self._view(f, w) for f in self.forms if f['status'] == 'handling' and self._is_handler(w, f)]
            d = {'sign': sign, 'handle': handle}
            if w['staff'] or w['admin']:
                d['exception'] = [self._view(f, w) for f in self.forms if f['status'] == 'exception']
            return {'ok': True, 'data': d}
        if action == 'apvGet':
            f = by_id.get(payload.get('id'))
            if not f:
                return self._err('not_found')
            if not self._can_view(f, w):
                return self._err('forbidden')
            return {'ok': True, 'data': {'form': self._view(f, w, True), 'events': self.events.get(f['id'], []), 'revisions': [{'rev': i + 1, 'at': f['created_at'], 'sha256': 'x'} for i in range(f['rev'])]}}
        if action == 'apvList':
            all_ = w['staff'] or w['admin']
            dept = w['p']['dept'] if w['p'] else ''
            if not all_ and dept not in ('purchase', 'fin', 'hr'):
                return self._err('forbidden')
            lst = [f for f in self.forms if all_ or (f['handler_dept'] == dept and f['status'] in ('handling', 'done'))]
            for k in ('type', 'status'):
                if payload.get(k):
                    lst = [f for f in lst if f[k] == payload[k]]
            if payload.get('month'):
                lst = [f for f in lst if time.strftime('%Y-%m', time.gmtime(f['created_at'] / 1000 + 8 * 3600)) == payload['month']]
            lst.sort(key=lambda f: -f['created_at'])
            return {'ok': True, 'data': {'forms': [self._view(f, w) for f in lst]}}
        if action == 'apvExport':
            if not (w['staff'] or w['admin'] or (w['p'] and w['p']['dept'] == 'fin')):
                return self._err('forbidden')
            rows = []
            for f in self.forms:
                if f['status'] != 'done' or f['type'] == 'personnel':
                    continue
                h = [e for e in self.events[f['id']] if e['action'] == 'handle']
                if not h or time.strftime('%Y-%m', time.gmtime(h[-1]['at'] / 1000 + 8 * 3600)) != payload.get('month'):
                    continue
                b = f['body']
                rows.append({'id': f['id'], 'rev': f['rev'], 'type': f['type'], 'unit_name': UNITS[f['sender']['unit']][0], 'sender_name': f['sender']['name'], 'amount': f['amount'],
                             'category': b.get('category') if f['type'] == 'expense' else None, 'vendor': b.get('vendor_name') or b.get('vendor') or '',
                             'desc': b.get('desc') if f['type'] == 'expense' else b.get('purpose'), 'created_at': f['created_at'], 'approved_at': f['updated_at'], 'done_at': h[-1]['at'], 'handle_note': h[-1]['note']})
            return {'ok': True, 'data': {'rows': rows}}

        # ── 寫入 ──
        def need(rev_check=True):
            f = by_id.get(payload.get('id'))
            if not f:
                return None, self._err('not_found')
            if not self._can_view(f, w):
                return None, self._err('not_found')
            if rev_check and (payload.get('rev') != f['rev'] or 'step' not in payload or payload.get('step') != f['step']):
                return None, self._err('conflict')
            return f, None

        def ev(f, actor, act, note=''):
            a = {'emp': actor, 'name': ds.by_emp(actor)['name'] if ds.by_emp(actor) else actor}
            self.events[f['id']].append({'at': NOW, 'rev': f['rev'], 'actor': a, 'action': act, 'note': note})

        def normalize(t, body, files):
            if t == 'purchase':
                items = body.get('items') or []
                if not (1 <= len(items) <= 30):
                    return None, self._err('bad_request', 'items')
                amt = ds.calc_amount(items)
                if amt is None:
                    return None, self._err('bad_amount', '金額不合法')
                if not body.get('purpose') or not body.get('need_date'):
                    return None, self._err('bad_request', 'purpose')
                return amt, None
            if t == 'expense':
                a = body.get('amount')
                if not isinstance(a, int) or isinstance(a, bool) or not (1 <= a <= 10000000):
                    return None, self._err('bad_amount', '金額要是 1～10,000,000 的整數元')
                if body.get('category') not in ('repair', 'food', 'misc', 'transport', 'supplies', 'other') or not body.get('desc') or body.get('payee') not in ('self', 'vendor'):
                    return None, self._err('bad_request', 'category')
                if not files:
                    return None, self._err('no_files')
                return a, None
            return None, None

        if action == 'apvSubmit':
            if not w['p']:
                return self._err('forbidden')
            cid = payload.get('client_id')
            if not cid:
                return self._err('bad_request', 'client_id 必填')
            if cid in self.client_ids:
                f = self.client_ids[cid]
                return {'ok': True, 'data': {'id': f['id'], 'status': f['status'], 'route': f['route']}}
            t = payload.get('type')
            body = payload.get('body') or {}
            files = payload.get('files') or []
            if t == 'personnel':
                kind = body.get('kind')
                subj = ds.by_emp(payload.get('subject') or '') if payload.get('subject') else w['p']
                if not subj:
                    return self._err('bad_request', '找不到這位對象同仁')
                if not body.get('effective') or not body.get('reason'):
                    return self._err('bad_request', 'effective')
                if kind == 'raise' and not isinstance((body.get('to') or {}).get('pay'), (int, float)):
                    return self._err('bad_request', 'to.pay')
                self_ = subj['emp'] == w['emp']
                if kind == 'leave' and self_ and not str(body.get('sign_file', '')).startswith('F'):
                    return self._err('file_invalid', '離職單本人要簽名')
                if not self_ and not w['staff'] and w['emp'] not in ds.cands('direct', subj, []) and TITLE[w['p']['title']][0] != 'hq':
                    return self._err('forbidden', '你不能送這位同仁的這種人事異動單')
                rt = ds.personnel_route(kind, w['p'], subj, kind == 'leave' and self_)
                f = self._add_form('personnel', w['p'], None, body, [], rt, subject=subj)
                if kind == 'leave' and self_:
                    f['files'] = [{'id': body['sign_file'], 'kind': 'sign', 'bytes': 1}]
            else:
                amt, e = normalize(t, body, files)
                if e:
                    return e
                rt = ds.spend_route(w['p'], amt)
                f = self._add_form(t, w['p'], amt, body, files, rt)
            self.client_ids[cid] = f
            return {'ok': True, 'data': {'id': f['id'], 'status': f['status'], 'route': f['route']}}
        if action == 'apvResubmit':
            f, e = need()
            if e:
                return e
            if f['sender']['emp'] != w['emp']:
                return self._err('forbidden')
            if f['status'] != 'rejected':
                return self._err('conflict')
            amt, e2 = normalize(f['type'], payload.get('body') or {}, payload.get('files') or [])
            if e2:
                return e2
            rt = ds.spend_route(w['p'], amt)
            f.update(body=payload['body'], amount=amt, rev=f['rev'] + 1, status=rt['status'], updated_at=NOW,
                     route=dict(f['route'], steps=copy.deepcopy(rt['steps']), row={'seq': rt['row']['seq'], 'max': rt['row']['max'], 'role': rt['first_role']}))
            f['step'] = next((i for i, s in enumerate(rt['steps']) if s['status'] == 'pending'), None)
            f['files'] = [{'id': x, 'kind': 'receipt', 'bytes': 1} for x in payload.get('files') or []]
            ev(f, w['emp'], 'submit')
            return {'ok': True, 'data': {'id': f['id'], 'rev': f['rev'], 'status': f['status'], 'route': f['route']}}
        if action == 'apvDecide':
            f, e = need()
            if e:
                return e
            if f['status'] != 'signing':
                return self._err('conflict')
            if w['emp'] not in self._cands_now(f) or f['route']['steps'][f['step']]['role'] == 'self_sign':
                return self._err('forbidden', '你不是這一關的簽核人')
            if payload.get('decision') == 'reject':
                if not (payload.get('note') or '').strip():
                    return self._err('bad_request', '退回要寫原因')
                f['route']['steps'][f['step']]['rej'] = w['emp']
                f['status'], f['step'] = 'rejected', None
                ev(f, w['emp'], 'reject', payload['note'])
                return {'ok': True, 'data': {'status': 'rejected', 'step': None}}
            st = f['route']['steps'][f['step']]
            st['status'], st['by'] = 'done', w['emp']
            ev(f, w['emp'], 'approve', payload.get('note') or '')
            nxt = next((i for i, s in enumerate(f['route']['steps']) if s['status'] == 'pending'), None)
            if nxt is None:
                f['status'], f['step'] = 'handling', None
            else:
                f['step'] = nxt
            f['updated_at'] = NOW
            return {'ok': True, 'data': {'status': f['status'], 'step': f['step']}}
        if action == 'apvHandle':
            f, e = need()
            if e:
                return e
            if f['status'] != 'handling':
                return self._err('conflict')
            if not self._is_handler(w, f):
                return self._err('forbidden')
            if payload.get('result') == 'return':
                if not (payload.get('note') or '').strip():
                    return self._err('bad_request', '退回要寫原因')
                f['status'] = 'rejected'
                ev(f, w['emp'], 'reject', '[承辦退回] ' + payload['note'])
                return {'ok': True, 'data': {'status': 'rejected'}}
            f['status'] = 'done'
            ev(f, w['emp'], 'handle', payload.get('note') or '')
            return {'ok': True, 'data': {'status': 'done'}}
        if action == 'apvWithdraw':
            f, e = need()
            if e:
                return e
            if f['sender']['emp'] != w['emp']:
                return self._err('forbidden')
            if f['status'] != 'signing' or any(s['status'] == 'done' and s['role'] != 'self_sign' for s in f['route']['steps']):
                return self._err('conflict')
            f['status'], f['step'] = 'withdrawn', None
            ev(f, w['emp'], 'withdraw')
            return {'ok': True, 'data': {'status': 'withdrawn'}}
        if action == 'apvReassign':
            f, e = need()
            if e:
                return e
            if not w['staff']:
                return self._err('forbidden')
            if f['status'] not in ('signing', 'exception'):
                return self._err('conflict')
            if not (payload.get('reason') or '').strip():
                return self._err('bad_request', '改派要寫原因')
            step = f['route']['steps'][f['step']]
            of = f['sender'] if not f.get('subject') else f['subject']
            roles = ROLES[ROLES.index(step['role']):] if step['role'] in ROLES else ['direct'] + ROLES[1:]
            if f['status'] == 'exception':
                roles = roles + [r for r in ('gm', 'chair') if r not in roles]
            allowed = set()
            for r in roles:
                for emp in ds.cands(r, of, [f['sender']['emp']] + ([f['subject']['emp']] if f.get('subject') else [])):
                    allowed.add(emp)
            # 改派不比職級（noRank）：同階梯也算
            for p in ds.people.values():
                if p['title'] in roles and p['emp'] != f['sender']['emp']:
                    allowed.add(p['emp'])
            to = (payload.get('to') or '').upper()
            if to not in allowed:
                return self._err('bad_request', '改派對象必須是這一關（或更高一級）已開通的合格簽核人，且不能是送件人')
            step['status'] = 'pending'
            step['override'] = {'to': to, 'by': w['emp'], 'reason': payload['reason'], 'rev': f['rev'], 'at': NOW}
            f['status'] = 'signing'
            f['stuck'] = False
            ev(f, w['emp'], 'reassign', '改派給 %s：%s' % (to, payload['reason']))
            return {'ok': True, 'data': {'status': 'signing', 'step': f['step']}}
        if action == 'apvVoid':
            f, e = need()
            if e:
                return e
            if not (w['staff'] or w['admin']):
                return self._err('forbidden')
            if not (payload.get('reason') or '').strip():
                return self._err('bad_request', '作廢要寫原因')
            if f['status'] in ('done', 'voided'):
                return self._err('conflict')
            f['status'], f['step'] = 'voided', None
            ev(f, w['emp'], 'void', payload['reason'])
            return {'ok': True, 'data': {'status': 'voided'}}
        if action == 'apvSign':
            f, e = need()
            if e:
                return e
            st = f['route']['steps'][f['step']]
            if st['role'] != 'self_sign' or st.get('emp') != w['emp']:
                return self._err('forbidden')
            st['status'], st['by'] = 'done', w['emp']
            ev(f, w['emp'], 'sign')
            nxt = next((i for i, s in enumerate(f['route']['steps']) if s['status'] == 'pending'), None)
            f['step'] = nxt
            if nxt is None:
                f['status'] = 'handling'
            return {'ok': True, 'data': {'status': f['status'], 'step': f['step']}}
        return self._err('not_found')
