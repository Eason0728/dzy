#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e 共用工具：本機靜態伺服器＋三支後端的 Playwright 攔截 mock＋登入流程。

【鐵律】六支 e2e 全程不打任何真後端——page.route 把 script.google.com 全部攔下，
未攔到的 script.google.com 請求一律 abort 並記錄（跑完斷言 leaked == []）。
正式試算表一筆資料都不會碰。

mock 的形狀不是猜的，逐一對過：
- platform login/me：platform/auth.js applySession()（token/user/perms；2026-10-12 起不再有 secrets）＋ spec §4.3 角色表
- /platform/proxy（2026-10-12 代轉）：照 ~/dzy-minikit/apps/dzy-platform/PROXY.md——驗 token、讀清單外要 <ns>.write、
  由 mock 代帶通行碼（扁平展開，同 proxy-hook.js buildBody）再交給 audit／dorm mock；店長裁切同 filterResponse。
  前端送來的 body 只要出現 code／pass（任何一層）就記進 leaked，八支 e2e 的「零流出」斷言會一起擋。
- audit getAll：platform/api.js 檔頭（扁平 {ok, config, items, records, details, ops_records,
  ops_details}）；資料主體直接用 modules/audit-shared/mock-data.js 產的 fixtures/audit_getall.json
- dorm：~/mala-dorm-contract/apps-script/Api.gs 各 action 的回傳；contract 用
  fixtures/dorm_contract.json（apps-script/Terms.gs 產的 mock-terms，含完整條文）
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # ~/dzy
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots')

failures = []


def check(cond, label):
    if cond:
        print('PASS: ' + label)
    else:
        failures.append(label)
        print('FAIL: ' + label)


def finish():
    if failures:
        print('\n%d 項驗收失敗：' % len(failures))
        for f in failures:
            print('  - ' + f)
        sys.exit(1)
    print('\n全部通過')
    sys.exit(0)


# ------------------------------------------------------------
# 本機靜態伺服器（no-cache，跟 tools/devserver.py 一樣不給快取騙）
# ------------------------------------------------------------

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


def start_server(port):
    os.chdir(ROOT)
    httpd = ThreadingHTTPServer(('127.0.0.1', port), NoCacheHandler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = 'http://127.0.0.1:%d' % port
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            urllib.request.urlopen(base + '/index.html', timeout=1)
            return httpd, base
        except Exception:
            time.sleep(0.2)
    raise SystemExit('http server 未在時限內啟動')


# ------------------------------------------------------------
# 三支後端網址：從 platform/config.js 抓，正本只有一份（config 改了這裡自動跟上）
# ------------------------------------------------------------

def load_backend_urls():
    src = open(os.path.join(ROOT, 'platform', 'config.js'), encoding='utf-8').read()
    urls = dict(re.findall(r"(platform|audit|dorm):\s*'(https?://[^']+)'", src))
    assert set(urls) == {'platform', 'audit', 'dorm'}, urls
    # 代轉網址＝平台網址 …/api → …/proxy（同 platform/api.js proxyUrl()）
    assert urls['platform'].endswith('/api'), urls['platform']
    urls['proxy'] = urls['platform'][:-len('/api')] + '/proxy'
    return urls


# 代轉的讀清單（同 Auth.gs PROXY_READ_ACTIONS／platform/dryrun.js READ_ACTIONS）
PROXY_READ_ACTIONS = {'audit': ['getAll'], 'dorm': ['rooms', 'list', 'contract', 'handover']}
PROXY_SECRET_FIELD = {'audit': 'code', 'dorm': 'pass'}


# ------------------------------------------------------------
# 帳號（照 spec §4.3 角色表；通行碼是 mock 專用假值，斷言後端有收到它）
# ------------------------------------------------------------

AUDIT_SECRET = 'E2E-AUDIT-CODE'
DORM_SECRET = 'E2E-DORM-PASS'

PROXY_SECRETS = {'audit': AUDIT_SECRET, 'dorm': DORM_SECRET}  # 只在 mock 的「mini」那一側，前端拿不到

USERS = {
    'admin': {'password': 'e2e-admin', 'user': {'id': 'u-admin', 'name': '管理者', 'role': 'admin', 'node': ''},
              'perms': ['*']},
    'mgr':   {'password': 'e2e-mgr', 'user': {'id': 'u-mgr', 'name': '部門主管', 'role': 'manager', 'node': ''},
              'perms': ['audit.read', 'dorm.read', 'dorm.write']},
    'acct':  {'password': 'e2e-acct', 'user': {'id': 'u-acct', 'name': '王會計', 'role': 'accountant', 'node': ''},
              'perms': ['audit.read', 'audit.write']},
    'lead':  {'password': 'e2e-lead', 'user': {'id': 'u-lead', 'name': '光復店長', 'role': 'storelead', 'node': 'sxl-gf'},
              'perms': ['audit.read.own']},
}


# ------------------------------------------------------------
# mock 後端
# ------------------------------------------------------------

class MockBackend:
    """三支後端的攔截 mock。dorm 是有狀態的（建單→簽約→點交要接得起來）。"""

    def __init__(self, base_url):
        self.base_url = base_url  # 本機站台網址，create 的 sign_url 要指回來
        self.urls = load_backend_urls()
        self.leaked = []          # 沒被 mock 涵蓋而流出去的請求（必須是空的）
        self.calls = []           # (backend, action) 流水帳，測試可斷言
        self.audit_fixture = json.load(open(os.path.join(FIXTURES, 'audit_getall.json'), encoding='utf-8'))
        self.dorm_contract_fixture = json.load(open(os.path.join(FIXTURES, 'dorm_contract.json'), encoding='utf-8'))
        # dorm 狀態
        self.contracts = {}       # contract_id -> contract row（list 回傳的形狀）
        self.sign_tokens = {}     # sign token -> contract_id
        self.handover_tokens = {} # handover token -> {contract_id, signed}
        self.seq = 0

    # ---- 依網址判斷是哪支後端 ----
    def backend_of(self, url):
        # 第三期照片路由：<平台主機>/platform/svc/apv-file-put|get（platform/config.js 的 /api 換成 /svc/…）
        if url.startswith(self.urls['platform'][:-len('/api')] + '/svc/apv-file-'):
            return 'svc'
        for b, u in self.urls.items():
            if url.startswith(u):
                return b
        return None

    def install(self, page):
        page.route('https://script.google.com/**', self._route)
        page.route('http://script.google.com/**', self._route)
        # 2026-10-11：平台後端可能搬到 Mac mini（Funnel 網址）——config.js 裡每一支後端的主機都要攔，
        # 不然換網址後 e2e 會打到真伺服器。沒被 mock 涵蓋的一樣進 leaked。
        from urllib.parse import urlparse
        for u in set(self.urls.values()):
            parsed = urlparse(u)
            host = parsed.netloc
            if host and host != 'script.google.com':
                # http／https 兩種都攔（Funnel 是 https，本機測試後端可能是 http）
                for scheme in ('https', 'http'):
                    page.route('%s://%s/**' % (scheme, host), self._route)

    def _route(self, route):
        req = route.request
        backend = self.backend_of(req.url)
        if backend is None:
            self.leaked.append(req.url)
            route.abort()
            return
        try:
            if req.method == 'POST':
                body = json.loads(req.post_data or '{}')
            else:
                # dorm 的 sign.html 用 GET ?action=contract&token=...
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(req.url).query)
                body = {k: v[0] for k, v in q.items()}
            status = 200
            self.last_url = req.url
            if backend == 'proxy':
                status, resp = self.proxy(body)
            else:
                resp = self.dispatch(backend, body)
        except Exception as e:  # mock 自己出錯要看得見，不是靜默 500
            status, resp = 200, {'ok': False, 'error': 'mock exception: %r' % e}
        route.fulfill(
            status=status,
            headers={'Access-Control-Allow-Origin': '*'},
            content_type='application/json',
            body=json.dumps(resp),
        )

    # ---- 代轉（2026-10-12，模擬 Mac mini /platform/proxy＋平台 proxyAuthorize_）----
    def proxy(self, body):
        def has_secret_field(o):
            return isinstance(o, dict) and ('code' in o or 'pass' in o)
        if has_secret_field(body) or has_secret_field(body.get('payload')):
            self.leaked.append('SECRET_IN_PROXY_BODY: %r' % body)  # 前端不准再送通行碼
            return 400, {'ok': False, 'error': 'BAD_REQUEST'}
        ns, action = body.get('ns', ''), body.get('action', '')
        self.proxy_calls = getattr(self, 'proxy_calls', []) + [(ns, action)]
        # 考勤管理首頁待辦（2026-10-24，spec §17.5）：mini 代轉到營運系統 att-alerts，只回件數。
        # 預設「沒有待辦」；測試把 att_alerts 換成 {'ok':True,'data':{...}}，或設 att_alerts_fail=True 模擬代轉失敗。
        if ns == 'attendance' and action == 'attAlerts':
            if not body.get('token') or not USERS.get((body.get('token') or '').replace('e2e-token-', '')):
                return 401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'}
            if getattr(self, 'att_alerts_fail', False):
                return 502, {'ok': False, 'error': 'UPSTREAM_DOWN'}
            return 200, getattr(self, 'att_alerts', {'ok': True, 'data': {'items': [], 'partial': False, 'pending': False}})
        if ns == 'cashbook':   # 收支管理（2026-10-24）：有狀態的假現金帳在 cashbook_mock.py
            import cashbook_mock
            return cashbook_mock.proxy(self, body)
        if ns not in PROXY_SECRETS:
            return 404, {'ok': False, 'error': 'UNKNOWN_NS'}
        token = body.get('token') or ''
        if not token:
            return 401, {'ok': False, 'error': 'NO_TOKEN', 'code': 'NO_TOKEN'}
        u = USERS.get(token.replace('e2e-token-', ''))
        if not u:
            return 401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'}
        perms = u['perms']
        has = lambda p: '*' in perms or p in perms
        is_write = action not in PROXY_READ_ACTIONS[ns]
        allowed = has(ns + '.write') if is_write else (has(ns + '.write') or has(ns + '.read') or has(ns + '.read.brand') or has(ns + '.read.own'))  # 2026-10-17：區督導 read.brand（資料已在 mini 裁切，mock 不再裁）
        if not allowed:
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        flat = dict(body.get('payload') or {})
        flat.pop('action', None)
        flat['action'] = action
        flat[PROXY_SECRET_FIELD[ns]] = PROXY_SECRETS[ns]
        resp = self.dispatch(ns, flat)
        if not has(ns + '.read') and has(ns + '.read.own') and isinstance(resp, dict):
            node = u['user'].get('node') or ''
            out = {}
            for k, v in resp.items():
                if isinstance(v, list) and v and any(isinstance(r, dict) and 'store' in r for r in v):
                    out[k] = [r for r in v if isinstance(r, dict) and node and r.get('store') == node]
                else:
                    out[k] = v
            resp = out
        return 200, json.loads(json.dumps(resp).replace(PROXY_SECRETS[ns], '[REDACTED]'))

    # ---- 各後端 dispatch ----
    def dispatch(self, backend, body):
        action = body.get('action', '')
        self.calls.append((backend, action))
        if backend == 'platform':
            return self.platform_action(action, body)
        if backend == 'svc':
            import apv_mock
            if not hasattr(self, 'apv_state'):
                self.apv_state = apv_mock.new_state()
            self.apv_state.setdefault('svc_calls', []).append(body.get('kind') or body.get('id'))
            return apv_mock.file_dispatch(self.apv_state, self.last_url, body)
        if backend == 'audit':
            if body.get('code') != AUDIT_SECRET:
                return {'ok': False, 'error': '通行碼錯誤（mock）'}
            if action == 'getAll':
                return self.audit_fixture
            return {'ok': False, 'error': '未知的 audit action（mock）：' + action}
        if backend == 'dorm':
            return self.dorm_action(action, body)
        return {'ok': False, 'error': '未知後端'}

    def platform_action(self, action, body):
        payload = body.get('payload') or {}
        if action == 'login':
            u = USERS.get(payload.get('username'))
            if not u or u['password'] != payload.get('password'):
                return {'ok': False, 'error': '帳號或密碼錯誤'}
            # 2026-10-12：認領待審的同仁密碼對了也不能登入（Auth.gs authStaffGate_）
            row = next((x for x in getattr(self, 'staff', []) if x['emp_no'] == payload.get('username')), None)
            if row and row['status'] == 'pending':
                return {'ok': False, 'error': '帳號還在等主管審核'}
            return {'ok': True, 'data': {
                'token': 'e2e-token-' + payload['username'],
                'user': u['user'], 'perms': u['perms'],
            }}
        if action == 'logout':
            # 2026-10-12：登出＝全部裝置一起登出；mock 只記一筆，讓 e2e 斷言前端真的有送
            self.logouts = getattr(self, 'logouts', []) + [body.get('token') or '']
            return {'ok': True, 'data': {}}
        if action == 'me':
            token = body.get('token') or ''
            name = token.replace('e2e-token-', '')
            u = USERS.get(name)
            if not u:
                return {'ok': False, 'error': 'token 無效'}
            return {'ok': True, 'data': {'user': u['user'], 'perms': u['perms']}}
        staff_res = self.staff_action(action, body)
        if staff_res is not None:
            return staff_res
        apv_res = self.apv_action(action, payload, body.get('token'))
        if apv_res is not None:
            return apv_res
        return {'ok': False, 'error': '未知的 platform action（mock）：' + action}

    # ---- 第三期表單簽核（2026-10-18）：有狀態的假後端在 apv_mock.py，形狀照 docs/approvals/api.md ----
    def apv_action(self, action, payload, token=''):
        if not action.startswith('apv'):
            return None
        import apv_mock
        if not hasattr(self, 'apv_state'):
            self.apv_state = apv_mock.new_state()
        who = (token or '').replace('e2e-token-', '')
        return apv_mock.dispatch(self.apv_state, action, payload, who)

    # ---- 個人帳號管理（2026-10-11）：有狀態的極簡模擬，只為了驗前端接線 ----
    # 規則正本與完整邏輯在 apps-script/platform/Staff.gs（node 測試 test/staff.mock.test.mjs 驗 106 項）；
    # 這裡只做到畫面點得通所需的最小行為。全部是假名。
    ORG = {
        'brands': [{'code': 'mzt', 'name': '墨竹亭'}, {'code': 'dzy', 'name': '鼎兆元總部'}],
        'units': [{'code': 'mzt-gf', 'name': '新竹光復', 'parent': 'mzt', 'ladder': 'store'},
                  {'code': 'dzy-hq', 'name': '鼎兆元總部', 'parent': 'dzy', 'ladder': 'hq'}],
        'depts': [],
        'titles': [{'code': 'pt', 'name': '計時同仁', 'parent': 'store', 'rank': 1},
                   {'code': 'sm', 'name': '店長', 'parent': 'store', 'rank': 3},
                   {'code': 'hs', 'name': '部門同仁', 'parent': 'hq', 'rank': 1}],
    }

    def _org_name(self, kind, code):
        for x in self.ORG[kind + 's']:
            if x['code'] == code:
                return x['name']
        return ''

    def _staff_obj(self, r):
        o = {k: r.get(k, '') for k in ('emp_no', 'name', 'status', 'phone', 'birthday', 'address', 'reject_reason', 'claimed_at')}
        for f in ('brand', 'unit', 'dept', 'title'):
            o[f] = r.get(f, '')
            o[f + '_name'] = self._org_name(f, o[f])
            o['p_' + f] = r.get('p_' + f, '')
            o['p_' + f + '_name'] = self._org_name(f, o['p_' + f])
        o['has_pending_change'] = any(o['p_' + f] for f in ('brand', 'unit', 'dept', 'title'))
        o['reset_locked'] = r.get('reset_fail', 0) >= 5
        return o

    def staff_action(self, action, body):
        if not hasattr(self, 'staff'):
            self.staff = []
        p = body.get('payload') or {}
        tok = body.get('token') or ''
        who = tok.replace('e2e-token-', '')
        if action == 'orgOptions':
            return {'ok': True, 'data': self.ORG}
        if action == 'staffImport':
            if USERS.get(who, {}).get('perms') != ['*']:
                return {'ok': False, 'error': '沒有權限'}
            start = len(self.staff) + 1
            created = [{'emp_no': 'DZY%03d' % (start + i), 'name': n} for i, n in enumerate(p.get('names') or [])]
            if not p.get('preview'):
                for c in created:
                    self.staff.append({'emp_no': c['emp_no'], 'name': c['name'], 'status': 'unclaimed', 'reset_fail': 0})
            return {'ok': True, 'data': {'created': created}}
        if action == 'staffList':
            if USERS.get(who, {}).get('perms') != ['*']:
                return {'ok': False, 'error': '沒有權限'}
            return {'ok': True, 'data': {'staff': [self._staff_obj(r) for r in self.staff]}}
        if action == 'claimLookup':
            for r in self.staff:
                if r['name'] == (p.get('name') or '').strip() and r['status'] == 'unclaimed':
                    return {'ok': True, 'data': {'emp_no': r['emp_no']}}
            return {'ok': False, 'error': '名單上找不到這個名字，請找後台'}
        if action == 'claimSubmit':
            for r in self.staff:
                if r['emp_no'] == p.get('emp_no') and r['status'] == 'unclaimed' and r['name'] == p.get('name'):
                    r.update({'status': 'pending', 'password': p.get('password'), 'birthday': p.get('birthday'),
                              'phone': p.get('phone'), 'address': p.get('address'), 'claimed_at': '2026-10-11 10:00:00'})
                    for f in ('brand', 'unit', 'dept', 'title'):
                        r['p_' + f] = p.get(f, '')
                    USERS[r['emp_no']] = {'password': p.get('password'), 'perms': ['platform.self'],
                                          'user': {'id': 'u-' + r['emp_no'], 'name': r['name'], 'role': 'staff', 'node': ''}}
                    # 2026-10-12：認領送出不回 token、不登入，等單位主管審核
                    return {'ok': True, 'pending': True, 'data': {'pending': True, 'emp_no': r['emp_no']}}
            return {'ok': False, 'error': '姓名與編號對不上，請重新輸入全名'}
        if action in ('unitPending', 'unitApprove', 'unitReject'):
            # 審核者＝同單位、已開通、店長以上（rank≥3）；規則正本在 Staff.gs stfManagerScope_／stfCanReviewRow_
            me = next((x for x in self.staff if x['emp_no'] == who), None)
            rank = next((t['rank'] for t in self.ORG['titles'] if t['code'] == (me or {}).get('title')), 0)
            if not me or me['status'] != 'active' or rank < 3:
                return {'ok': False, 'error': '只有單位主管可以審核'}
            mine = [x for x in self.staff if x['status'] == 'pending' and x.get('p_unit') == me.get('unit') and x is not me]
            if action == 'unitPending':
                people = []
                for x in mine:
                    o = self._staff_obj(x)
                    people.append({'emp_no': o['emp_no'], 'name': o['name'], 'birthday': o['birthday'], 'phone': o['phone'],
                                   'address': o['address'], 'claimed_at': o['claimed_at'],
                                   **{f: o['p_' + f] for f in ('brand', 'unit', 'dept', 'title')},
                                   **{f + '_name': o['p_' + f + '_name'] for f in ('brand', 'unit', 'dept', 'title')}})
                return {'ok': True, 'data': {'people': people, 'scope_name': self._org_name('unit', me.get('unit')), 'all_units': False}}
            r = next((x for x in mine if x['emp_no'] == p.get('emp_no')), None)
            if r is None:
                return {'ok': False, 'error': '只有單位主管可以審核'}
            if action == 'unitApprove':
                for f in ('brand', 'unit', 'dept', 'title'):
                    r[f] = r.get('p_' + f, '')
                    r['p_' + f] = ''
                r['status'] = 'active'
            else:
                if not (p.get('reason') or '').strip():
                    return {'ok': False, 'error': '請填寫退回原因'}
                r.update({'status': 'unclaimed', 'reject_reason': p['reason'], 'birthday': '', 'phone': '', 'address': ''})
                USERS.pop(r['emp_no'], None)
            return {'ok': True, 'data': {'emp_no': r['emp_no']}}
        if action in ('myProfile', 'myUnit', 'saveMyProfile'):
            r = next((x for x in self.staff if x['emp_no'] == who), None)
            if r is None:
                return {'ok': True, 'data': {'none': True}} if action == 'myProfile' else {'ok': False, 'error': '只有店長以上可以看'}
            if action == 'myUnit':
                # 簡化版：只模擬門市店長（store 階梯 → 回生日、地址，2026-10-25）；正本 Staff.gs handleMyUnit_
                if r.get('title') != 'sm' or r.get('status') != 'active':
                    return {'ok': False, 'error': '只有店長（總部為總監）以上可以看單位通訊錄'}
                people = [{'emp_no': x['emp_no'], 'name': x['name'], 'title': x.get('title', ''), 'title_name': self._org_name('title', x.get('title', '')),
                           'phone': x.get('phone', ''), 'birthday': x.get('birthday', ''), 'address': x.get('address', '')}
                          for x in self.staff if x.get('status') == 'active' and x.get('unit') == r.get('unit')]
                return {'ok': True, 'data': {'unit_name': self._org_name('unit', r.get('unit')), 'private': True, 'people': people}}
            return {'ok': True, 'data': self._staff_obj(r)}
        if action == 'staffConfirm':
            r = next((x for x in self.staff if x['emp_no'] == p.get('emp_no')), None)
            for f in ('brand', 'unit', 'dept', 'title'):
                r[f] = r.get('p_' + f, '')
                r['p_' + f] = ''
            r['status'] = 'active'
            return {'ok': True, 'data': {'staff': self._staff_obj(r)}}
        if action == 'forgotReset':
            r = next((x for x in self.staff if x['emp_no'] == p.get('emp_no')), None)
            if not r or r['status'] in ('unclaimed', 'disabled'):
                return {'ok': False, 'error': '資料不符，請確認或找後台'}
            if r.get('reset_fail', 0) >= 5:
                return {'ok': False, 'error': '錯太多次，請 1 小時後再試，或找後台'}
            if r.get('birthday') != p.get('birthday') or r.get('phone') != p.get('phone'):
                r['reset_fail'] = r.get('reset_fail', 0) + 1
                return {'ok': False, 'error': '資料不符，請確認或找後台'}
            USERS[r['emp_no']]['password'] = p.get('new_password')
            r['reset_fail'] = 0
            return {'ok': True, 'data': {}}
        return None

    # ---- dorm（有狀態）----
    # 讀取類（rooms/list/contract/handover）：2026-08-15 後端 @17 已補進 doPost，
    #   前端一律 POST 帶 pass；contract 例外——sign.html 是舊式 GET query（不帶 pass）。
    # 寫入類（create/terminate/sign/handoverCreate/handoverSign）：照 Api.gs doPost。
    ROOMS = [
        {'room': '二樓單人房', 'beds': [], 'type': '單人房'},
        {'room': '二樓四人房', 'beds': ['1號床位', '2號床位', '3號床位', '4號床位'], 'type': '四人房'},
        {'room': '三樓1號房', 'beds': ['雙人床位A', '雙人床位B'], 'type': '雙人房'},
    ]
    EQUIP_ITEMS = ['書桌', '椅子', '床架', '床墊', '衣櫃', '房間鑰匙', '大門遙控器']

    def dorm_action(self, action, body):
        # sign.html 的 GET contract 與 POST sign 不帶 pass（簽署人只有 token）；其餘都要驗
        if action not in ('contract', 'sign') and body.get('pass') != DORM_SECRET:
            return {'ok': False, 'error': '通行碼錯誤（mock）'}

        if action == 'rooms':
            return {'ok': True, 'rooms': self.ROOMS, 'equip': self.EQUIP_ITEMS}

        if action == 'list':
            return {'ok': True, 'contracts': list(self.contracts.values())}

        if action == 'create':
            self.seq += 1
            cid = 'E2E-C%03d' % self.seq
            token = 'e2e-sign-%d' % self.seq
            row = {
                'contract_id': cid, 'name': body.get('name', ''),
                'room': body.get('room', ''), 'bed': body.get('bed', ''),
                'room_bed_display': (body.get('room', '') + ' ' + body.get('bed', '')).strip(),
                'rent': 2000, 'term_start': body.get('term_start', ''),
                'term_end': '2027-01-31', 'term_no': 1,
                'status': '待簽', 'terminate_flag': '', 'signed_at': '', 'md': '',
            }
            self.contracts[cid] = row
            self.sign_tokens[token] = cid
            return {'ok': True, 'contract_id': cid, 'token': token,
                    'rent': row['rent'], 'term_start': row['term_start'], 'term_end': row['term_end'],
                    'sign_url': self.base_url + '/sign.html?t=' + token}

        if action == 'contract':
            cid = self.sign_tokens.get(body.get('token', ''))
            if not cid:
                return {'ok': False, 'error': '連結無效（mock）'}
            c = self.contracts[cid]
            fx = dict(self.dorm_contract_fixture)
            contract = dict(fx['contract'])
            contract.update({'name': c['name'], 'room_bed': c['room_bed_display'],
                             'rent': c['rent'], 'term_start': c['term_start'], 'term_end': c['term_end']})
            if c['status'] == '在住':
                fx['state'] = 'signed'
                contract['signed_at'] = c['signed_at']
            fx['contract'] = contract
            return fx

        if action == 'sign':
            cid = self.sign_tokens.get(body.get('token', ''))
            if not cid:
                return {'ok': False, 'error': '連結無效（mock）'}
            c = self.contracts[cid]
            if c['status'] == '在住':
                return {'ok': False, 'error': '這份合約已完成簽署'}
            c['status'] = '在住'
            c['signed_at'] = '2026-08-17 10:00'
            return {'ok': True, 'pdf_url': ''}

        if action == 'terminate':
            c = self.contracts.get(body.get('contract_id', ''))
            if not c:
                return {'ok': False, 'error': '找不到合約（mock）'}
            c['terminate_flag'] = '' if c['terminate_flag'] else '已標記終止'
            return {'ok': True}

        if action == 'handoverCreate':
            cid = body.get('contract_id', '')
            if cid not in self.contracts:
                return {'ok': False, 'error': '找不到合約（mock）'}
            # 已有未完成點交單就沿用（同 Api.gs reused 邏輯）
            for tok, h in self.handover_tokens.items():
                if h['contract_id'] == cid and not h['signed']:
                    return {'ok': True, 'token': tok, 'reused': True}
            tok = 'e2e-hand-%d' % (len(self.handover_tokens) + 1)
            self.handover_tokens[tok] = {'contract_id': cid, 'signed': False}
            return {'ok': True, 'token': tok}

        if action == 'handover':
            h = self.handover_tokens.get(body.get('token', ''))
            if not h:
                return {'ok': False, 'error': '點交單連結無效（mock）'}
            if h['signed']:
                return {'ok': True, 'state': 'signed', 'handover': h.get('summary', {})}
            equip = [{'item': it, 'price': 500} for it in self.EQUIP_ITEMS]
            return {'ok': True, 'state': 'pending', 'equip': equip, 'cleaning_fee': 800}

        if action == 'handoverSign':
            h = self.handover_tokens.get(body.get('token', ''))
            if not h:
                return {'ok': False, 'error': '點交單連結無效（mock）'}
            items = body.get('items') or []
            total = sum(500 for it in items if it.get('normal') is False and it.get('returned') is False)
            if body.get('need_cleaning'):
                total += 800
            h['signed'] = True
            c = self.contracts[h['contract_id']]
            h['summary'] = {'name': c['name'], 'room_bed': c['room_bed_display'],
                            'signed_at': '2026-08-17 10:30', 'compensation_total': total, 'pdf_url': ''}
            c['status'] = '已退宿'
            return {'ok': True, 'compensation_total': total, 'pdf_url': ''}

        return {'ok': False, 'error': '未知的 dorm action（mock）：' + action}


# ------------------------------------------------------------
# 登入流程（走真 UI，不塞 localStorage——登入頁本身也是被測物）
# ------------------------------------------------------------

def login(page, base, username):
    page.goto(base + '/index.html')
    page.fill('#login-username', username)
    page.fill('#login-password', USERS[username]['password'])
    page.click('[data-role="submit"]')
    # 375px 手機版 sidebar（nav-desktop）是 display:none，等 attached 而不是 visible
    page.wait_for_selector('[data-role="view-content"]', state='attached', timeout=10000)


def new_page(pw, mock_backend, width=1280, height=800):
    browser = pw.chromium.launch()
    context = browser.new_context(viewport={'width': width, 'height': height})
    page = context.new_page()
    mock_backend.install(page)
    return browser, page
