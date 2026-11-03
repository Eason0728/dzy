# -*- coding: utf-8 -*-
"""損益試算原生化（P3）的代轉：模擬 Mac mini /platform/proxy（ns pnl）＋平台 proxyAuthorize_，轉給本機真的損益後端
（test/e2e/pnl_backend.mjs 起的 kit 執行器；環境變數 PNL_RUNNER＝http://127.0.0.1:<port>/pnl/api）。

授權照 Auth.gs：讀清單內要 pnl.read／write／admin 任一；其餘要 pnl.write（admin 隱含 write）；管級動作另要 pnl.admin。
level＝admin＞write＞read；account＝登入帳號（轉大寫）；回應是損益後端原 JSON（前端 transformResponse_ 自己包）。
前端送來的 payload 不得帶 key／token／operator／level／inner／account（有就記進 mock.leaked）。全部假資料、假金鑰。
"""
import json
import os
import urllib.request

KEY = 'test-dzy-key-0123456789abcdef'
READ = ['getMonth', 'getTrend', 'getTrendMulti', 'getSettings', 'exportEntries', 'getAttachment', 'getJob']
ADMIN = ['finalize', 'unlock', 'saveSettings', 'createDraft', 'refreshConnectors', 'refreshFixed', 'loadGroupUnits',
         'getJob', 'adminSelfCheck', 'adminSyncSeed', 'adminApplyS01Connectors', 'adminCreateLastMonthDraft', 'adminLoadStoreSeedS01']
FORBIDDEN_FIELDS = ('key', 'token', 'operator', 'level', 'inner', 'account')


def proxy(mock, body):
    from common import USERS
    action = body.get('action', '')
    payload = body.get('payload') or {}
    token = body.get('token') or ''
    if not token:
        return 401, {'ok': False, 'error': 'NO_TOKEN', 'code': 'NO_TOKEN'}
    who = token.replace('e2e-token-', '')
    u = USERS.get(who)
    if not u:
        return 401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'}
    perms = u['perms']
    has = lambda p: '*' in perms or p in perms
    level = 'admin' if has('pnl.admin') else 'write' if has('pnl.write') else 'read' if has('pnl.read') else ''
    if not level:
        return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
    if action not in READ and level == 'read':
        return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
    if action in ADMIN and level != 'admin':   # getJob 也只給管（同 Auth.gs PROXY_PNL_ADMIN_ACTIONS；夜審 #8）
        return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
    for k in FORBIDDEN_FIELDS:
        if isinstance(payload, dict) and k in payload:
            mock.leaked.append('PNL FIELD %s in %s' % (k, action))
    mock.pnl_calls = getattr(mock, 'pnl_calls', []) + [(action, level)]
    out = {'action': 'dzyProxy', 'key': KEY, 'level': level, 'account': who.upper()[:40], 'operator': u['user']['name'], 'inner': action, 'payload': payload}
    req = urllib.request.Request(os.environ['PNL_RUNNER'], data=json.dumps(out).encode('utf-8'), headers={'Content-Type': 'text/plain'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return 200, json.loads(resp.read().decode('utf-8'))
