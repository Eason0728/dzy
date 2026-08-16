#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e 共用工具：本機靜態伺服器＋三支後端的 Playwright 攔截 mock＋登入流程。

【鐵律】六支 e2e 全程不打任何真後端——page.route 把 script.google.com 全部攔下，
未攔到的 script.google.com 請求一律 abort 並記錄（跑完斷言 leaked == []）。
正式試算表一筆資料都不會碰。

mock 的形狀不是猜的，逐一對過：
- platform login/me：platform/auth.js applySession()（token/user/perms/secrets）＋ spec §4.3 角色表
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
    urls = dict(re.findall(r"(platform|audit|dorm):\s*'(https://[^']+)'", src))
    assert set(urls) == {'platform', 'audit', 'dorm'}, urls
    return urls


# ------------------------------------------------------------
# 帳號（照 spec §4.3 角色表；通行碼是 mock 專用假值，斷言後端有收到它）
# ------------------------------------------------------------

AUDIT_SECRET = 'E2E-AUDIT-CODE'
DORM_SECRET = 'E2E-DORM-PASS'

USERS = {
    'admin': {'password': 'e2e-admin', 'user': {'id': 'u-admin', 'name': '管理者', 'role': 'admin', 'node': ''},
              'perms': ['*'], 'secrets': {'audit': AUDIT_SECRET, 'dorm': DORM_SECRET}},
    'mgr':   {'password': 'e2e-mgr', 'user': {'id': 'u-mgr', 'name': '部門主管', 'role': 'manager', 'node': ''},
              'perms': ['audit.read', 'dorm.read', 'dorm.write'],
              'secrets': {'audit': AUDIT_SECRET, 'dorm': DORM_SECRET}},
    'acct':  {'password': 'e2e-acct', 'user': {'id': 'u-acct', 'name': '王會計', 'role': 'accountant', 'node': ''},
              'perms': ['audit.read', 'audit.write'], 'secrets': {'audit': AUDIT_SECRET}},
    'lead':  {'password': 'e2e-lead', 'user': {'id': 'u-lead', 'name': '光復店長', 'role': 'storelead', 'node': 'sxl-gf'},
              'perms': ['audit.read.own'], 'secrets': {'audit': AUDIT_SECRET}},
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
        for b, u in self.urls.items():
            if url.startswith(u):
                return b
        return None

    def install(self, page):
        page.route('https://script.google.com/**', self._route)

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
            resp = self.dispatch(backend, body)
        except Exception as e:  # mock 自己出錯要看得見，不是靜默 500
            resp = {'ok': False, 'error': 'mock exception: %r' % e}
        route.fulfill(
            status=200,
            headers={'Access-Control-Allow-Origin': '*'},
            content_type='application/json',
            body=json.dumps(resp),
        )

    # ---- 各後端 dispatch ----
    def dispatch(self, backend, body):
        action = body.get('action', '')
        self.calls.append((backend, action))
        if backend == 'platform':
            return self.platform_action(action, body)
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
            return {'ok': True, 'data': {
                'token': 'e2e-token-' + payload['username'],
                'user': u['user'], 'perms': u['perms'], 'secrets': u['secrets'],
            }}
        if action == 'me':
            token = body.get('token') or ''
            name = token.replace('e2e-token-', '')
            u = USERS.get(name)
            if not u:
                return {'ok': False, 'error': 'token 無效'}
            return {'ok': True, 'data': {'user': u['user'], 'perms': u['perms'], 'secrets': u['secrets']}}
        return {'ok': False, 'error': '未知的 platform action（mock）：' + action}

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
