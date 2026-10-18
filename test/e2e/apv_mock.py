# -*- coding: utf-8 -*-
"""第三期表單簽核的 e2e 假後端（形狀照 docs/approvals/api.md；全部假名、DZY9xx）。
有狀態的極簡模擬：只為了驗前端分頁點得到、按鈕接線、送出的 payload 形狀。規則正本在 apps-script/platform/Approvals.gs。
"""
import copy
import json

NOW = 1792252800000  # 2026-10-18 00:00 台北，固定值讓截圖穩定
HOUR = 3600 * 1000

DEFAULT_ROWS = [
    {'seq': 1, 'max': 5000, 'store_role': 'head', 'hq_role': 'head'},
    {'seq': 2, 'max': 10000, 'store_role': 'brand_dir', 'hq_role': 'head'},
    {'seq': 3, 'max': 30000, 'store_role': 'gm', 'hq_role': 'gm'},
    {'seq': 4, 'max': None, 'store_role': 'chair', 'hq_role': 'chair'},
]

SENDER = {'emp': 'DZY901', 'name': '測試店員甲', 'unit_name': '測試光復店'}


def _route(role, name):
    return {'v': 1, 'thr_ver': 1, 'row': None, 'handler': 'fin',
            'steps': [{'role': role, 'scope': 'brand', 'status': 'pending', 'candidates': [{'emp': 'DZY902', 'name': name}]}]}


def new_state():
    forms = [
        {'id': 'APV-261018-901', 'type': 'expense', 'status': 'signing', 'rev': 1, 'step': 0, 'sender': SENDER, 'amount': 8600,
         'body': {'spend_date': '2026-10-17', 'category': 'repair', 'amount': 8600, 'desc': '冷藏櫃壓縮機維修', 'payee': 'vendor', 'vendor_name': '測試冷凍行'},
         'files': [{'id': 'F001', 'kind': 'receipt', 'bytes': 90000}], 'route': _route('brand_dir', '測試總監'), 'handler_dept': 'fin',
         'created_at': NOW - 5 * HOUR, 'updated_at': NOW - 5 * HOUR, 'stuck': False},
        {'id': 'APV-261017-902', 'type': 'purchase', 'status': 'handling', 'rev': 1, 'step': None, 'sender': SENDER, 'amount': 2500,
         'body': {'items': [{'name': '乾辣椒', 'qty': 10, 'unit': '包', 'price': 250}], 'vendor': '測試食材行', 'purpose': '補週末備料', 'need_date': '2026-10-20'},
         'files': [], 'route': _route('head', '測試店長'), 'handler_dept': 'purchase',
         'created_at': NOW - 30 * HOUR, 'updated_at': NOW - 20 * HOUR, 'stuck': False},
        {'id': 'APV-261016-903', 'type': 'expense', 'status': 'rejected', 'rev': 1, 'step': None, 'sender': SENDER, 'amount': 300,
         'body': {'spend_date': '2026-10-15', 'category': 'supplies', 'amount': 300, 'desc': '文具', 'payee': 'self'},
         'files': [{'id': 'F002', 'kind': 'receipt', 'bytes': 70000}], 'route': _route('head', '測試店長'), 'handler_dept': 'fin',
         'created_at': NOW - 50 * HOUR, 'updated_at': NOW - 40 * HOUR, 'stuck': False},
        {'id': 'APV-261012-904', 'type': 'personnel', 'status': 'signing', 'rev': 1, 'step': 0, 'sender': {'emp': 'DZY903', 'name': '測試主管', 'unit_name': '測試光復店'},
         'subject': {'emp': 'DZY901', 'name': '測試店員甲'}, 'amount': None,
         'body': {'kind': 'leave', 'effective': '2026-11-01', 'from': {'unit': '測試光復店', 'title': '店員'}, 'to': {}, 'reason': '個人規劃'},
         'files': [], 'route': _route('self_sign', '測試店員甲'), 'handler_dept': 'hr',
         'created_at': NOW - 5 * 24 * HOUR, 'updated_at': NOW - 5 * 24 * HOUR, 'stuck': True},
    ]
    events = {
        'APV-261018-901': [{'at': NOW - 5 * HOUR, 'rev': 1, 'actor': {'emp': 'DZY901', 'name': '測試店員甲'}, 'action': 'submit', 'note': ''}],
        'APV-261016-903': [{'at': NOW - 50 * HOUR, 'rev': 1, 'actor': {'emp': 'DZY901', 'name': '測試店員甲'}, 'action': 'submit', 'note': ''},
                           {'at': NOW - 40 * HOUR, 'rev': 1, 'actor': {'emp': 'DZY902', 'name': '測試店長'}, 'action': 'reject', 'note': '收據看不清楚，請重拍'}],
    }
    return {'forms': forms, 'events': events, 'rows': copy.deepcopy(DEFAULT_ROWS), 'ver': 1, 'files': {}, 'calls': [], 'client_ids': {}, 'seq': 905, 'file_seq': 10}


def _can(form, who):
    c = {'decide': False, 'sign': False, 'resubmit': False, 'withdraw': False, 'handle': False, 'reassign': False, 'void': False}
    admin = who == 'admin'
    if admin:
        c['decide'] = form['status'] == 'signing' and form['route']['steps'][0]['role'] != 'self_sign'
        c['sign'] = False
        c['handle'] = form['status'] == 'handling'
        c['reassign'] = form['status'] in ('signing', 'exception')
        c['void'] = form['status'] not in ('done', 'voided')
    if who == 'lead' and form['sender']['emp'] == 'DZY901':
        c['resubmit'] = form['status'] == 'rejected'
        c['withdraw'] = form['status'] == 'signing' and form['step'] == 0
    if who == 'acct' and form['status'] == 'signing' and form['route']['steps'][0]['role'] == 'self_sign':
        c['sign'] = True   # 讓畫面上看得到「本人簽名」按鈕（假裝 acct 是對象）
    return c


def _out(form, who, with_body=False):
    f = {k: v for k, v in form.items() if k != 'body'}
    if with_body:
        f['body'] = form['body']
    f['can'] = _can(form, who)
    return f


def _err(code, message=None):
    r = {'ok': False, 'error': code}
    if message:
        r['message'] = message
    return r


def dispatch(st, action, payload, who):
    st['calls'].append((action, copy.deepcopy(payload), who))
    forms = st['forms']
    by_id = {f['id']: f for f in forms}
    if action == 'apvThresholdGet':
        return {'ok': True, 'data': {'ver': st['ver'], 'rows': st['rows']}}
    if action == 'apvThresholdSave':
        if who != 'admin':
            return _err('forbidden')
        if payload.get('expected_ver') != st['ver']:
            return _err('conflict')
        st['rows'] = payload['rows']
        st['ver'] += 1
        return {'ok': True, 'data': {'ver': st['ver'], 'diff': []}}
    if action == 'apvRoutePreview':
        steps = [{'role': 'brand_dir', 'scope': 'brand', 'status': 'pending', 'candidates': [{'emp': 'DZY902', 'name': '測試總監'}]}]
        if payload.get('type') == 'personnel' and payload.get('kind') == 'leave':
            steps = [{'role': 'self_sign', 'scope': 'self', 'status': 'pending', 'candidates': []}, {'role': 'direct', 'scope': 'unit', 'status': 'pending', 'candidates': [{'emp': 'DZY903', 'name': '測試主管'}]}]
        return {'ok': True, 'data': {'steps': steps, 'handler': {'purchase': 'purchase', 'expense': 'fin', 'personnel': 'hr'}[payload.get('type', 'expense')]}}
    if action == 'apvMine':
        mine = [f for f in forms if (f['sender']['emp'] == 'DZY901' and who == 'lead') or (who == 'admin' and f['sender']['emp'] == 'DZY903')]
        if payload.get('status'):
            mine = [f for f in mine if f['status'] == payload['status']]
        return {'ok': True, 'data': {'forms': [_out(f, who) for f in reversed(mine)]}}
    if action == 'apvTodo':
        if who != 'admin':
            return {'ok': True, 'data': {'sign': [], 'handle': [], 'exception': []}}
        return {'ok': True, 'data': {'sign': [_out(f, who) for f in forms if f['status'] == 'signing'],
                                     'handle': [_out(f, who) for f in forms if f['status'] == 'handling'], 'exception': []}}
    if action == 'apvGet':
        f = by_id.get(payload.get('id'))
        if not f:
            return _err('not_found')
        return {'ok': True, 'data': {'form': _out(f, who, True), 'events': st['events'].get(f['id'], []), 'revisions': []}}
    if action == 'apvList':
        if who not in ('admin', 'acct'):
            return _err('forbidden')
        lst = forms
        for k in ('type', 'status'):
            if payload.get(k):
                lst = [f for f in lst if f[k] == payload[k]]
        return {'ok': True, 'data': {'forms': [_out(f, who) for f in lst]}}
    if action == 'apvExport':
        if who not in ('admin', 'acct'):
            return _err('forbidden')
        return {'ok': True, 'data': {'rows': [
            {'id': 'APV-261018-901', 'rev': 1, 'type': 'expense', 'unit_name': '測試光復店', 'sender_name': '=測試店員甲', 'amount': 8600, 'category': 'repair', 'vendor': '測試冷凍行', 'desc': '冷藏櫃維修, 含稅', 'created_at': NOW, 'approved_at': NOW, 'done_at': NOW, 'handle_note': ''}]}}
    # 寫入
    def need(rev=True):
        f = by_id.get(payload.get('id'))
        if not f:
            return None, _err('not_found')
        if rev and (payload.get('rev') != f['rev'] or ('step' in payload and payload.get('step') != f['step'])):
            return None, _err('conflict')
        return f, None
    if action == 'apvSubmit':
        cid = payload.get('client_id')
        if not cid:
            return _err('bad_request', 'client_id 必填')
        if cid in st['client_ids']:
            f = st['client_ids'][cid]
            return {'ok': True, 'data': {'id': f['id'], 'status': f['status'], 'route': f['route']}}
        t = payload.get('type')
        body = payload.get('body') or {}
        if t == 'expense' and not payload.get('files'):
            return _err('no_files')
        amount = body.get('amount') if t == 'expense' else (sum(round(i['qty'] * i['price']) for i in body.get('items', [])) if t == 'purchase' else None)
        st['seq'] += 1
        f = {'id': 'APV-261018-%03d' % st['seq'], 'type': t, 'status': 'signing', 'rev': 1, 'step': 0, 'sender': SENDER, 'amount': amount, 'body': body,
             'files': [{'id': i, 'kind': 'receipt', 'bytes': 1} for i in payload.get('files', [])], 'route': _route('brand_dir', '測試總監'),
             'handler_dept': 'fin', 'created_at': NOW, 'updated_at': NOW, 'stuck': False}
        forms.append(f)
        st['client_ids'][cid] = f
        return {'ok': True, 'data': {'id': f['id'], 'status': 'signing', 'route': f['route']}}
    if action == 'apvResubmit':
        f, e = need(rev=False)
        if e:
            return e
        if payload.get('rev') != f['rev']:
            return _err('conflict')
        f.update(body=payload['body'], rev=f['rev'] + 1, status='signing', step=0)
        return {'ok': True, 'data': {'id': f['id'], 'rev': f['rev'], 'status': 'signing', 'route': f['route']}}
    if action == 'apvDecide':
        f, e = need()
        if e:
            return e
        if payload['decision'] == 'reject':
            if not payload.get('note'):
                return _err('bad_request', '退回要寫原因')
            f['status'], f['step'] = 'rejected', None
        else:
            f['status'], f['step'] = 'handling', None
        f['rev'] += 0
        return {'ok': True, 'data': {'status': f['status'], 'step': f['step']}}
    if action == 'apvSign':
        f, e = need()
        if e:
            return e
        f['status'] = 'handling'
        return {'ok': True, 'data': {'status': 'handling', 'step': None}}
    if action == 'apvHandle':
        f, e = need(rev=False)
        if e:
            return e
        f['status'] = 'done' if payload['result'] == 'done' else 'rejected'
        return {'ok': True, 'data': {'status': f['status']}}
    if action == 'apvWithdraw':
        f, e = need()
        if e:
            return e
        f['status'] = 'withdrawn'
        return {'ok': True, 'data': {'status': 'withdrawn'}}
    if action == 'apvReassign':
        f, e = need()
        if e:
            return e
        return {'ok': True, 'data': {'status': 'signing', 'step': f['step']}}
    if action == 'apvVoid':
        f, e = need(rev=False)
        if e:
            return e
        f['status'] = 'voided'
        return {'ok': True, 'data': {'status': 'voided'}}
    return _err('not_found')


# 1x1 JPEG（有效的最小 JPEG，讀圖時當假照片）
TINY_JPEG_B64 = ('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////'
                 'wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=')


def file_dispatch(st, url, body):
    if url.endswith('apv-file-put'):
        st['file_seq'] += 1
        fid = 'F%03d' % st['file_seq']
        st['files'][fid] = {'kind': body.get('kind'), 'mime': body.get('mime'), 'b64': body.get('b64')}
        return {'ok': True, 'data': {'id': fid, 'bytes': len(body.get('b64', '')) * 3 // 4}}
    if url.endswith('apv-file-get'):
        f = st['files'].get(body.get('id'))
        if f:
            return {'ok': True, 'data': {'mime': f['mime'], 'b64': f['b64']}}
        return {'ok': True, 'data': {'mime': 'image/jpeg', 'b64': TINY_JPEG_B64}}
    return _err('not_found')
