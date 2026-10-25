# -*- coding: utf-8 -*-
"""收支管理（2026-10-24）的假現金帳＋假代轉：模擬 Mac mini /platform/proxy（ns cashbook）＋現金帳伺服器的管理通道。

形狀照 docs/cashbook-fin/spec.md 第 4、10 節：回應是扁平 {ok:true,...}／{ok:false,error:'<碼>'}；
作廢列帶 voidedBy／voidReason；鎖定帶 lockedBy／lockedVia（acct／store）。全部假資料。
授權照 Auth.gs proxyAuthorize_：只認 cashbook.write（'*' 也算），讀寫都要；動作要在白名單。
前端送來的 payload 只要出現 operator／adminKey／newStorePass／newAdminPass 就記進 leaked（操作人由平台決定，不是瀏覽器）。
"""
import datetime

READ = ['adminStores', 'adminList', 'adminLocks', 'adminGet']
WRITE = ['adminSave', 'adminVoid', 'adminLock', 'adminUnlock']
FORBIDDEN_FIELDS = ('operator', 'adminKey', 'admin_key', 'newStorePass', 'newAdminPass', 'code', 'pass')
ALERT_MONTH = '2026-09'   # e2e 的「假時鐘」頁面用（2026-10-05 → 上個月 2026-09）


def taipei_month(offset=0):
    t = datetime.datetime.utcnow() + datetime.timedelta(hours=8)
    y, m = t.year, t.month + offset
    while m < 1:
        y, m = y - 1, m + 12
    return '%04d-%02d' % (y, m)


def _row(i, store, month, day, kind, subject, name, amount, inv, seq, status='正常', photo=''):
    net = round(amount / 1.05) if inv else amount
    r = {'id': 'R%s%03d' % (store, i), 'store': store, 'date': '%s-%02d' % (month, day), 'kind': kind, 'subject': subject, 'name': name,
         'amount': amount, 'hasInvoice': inv, 'net': net, 'tax': amount - net, 'seq': seq, 'photo': photo, 'author': '店長',
         'createdAt': '%s-%02d 09:%02d:00' % (month, day, i % 60), 'status': status, 'voidedAt': '', 'voidReason': '', 'voidedBy': ''}
    if status == '作廢':
        r.update({'voidedAt': '%s-%02d 18:00:00' % (month, day), 'voidReason': '重複登記', 'voidedBy': '會計乙（ACC）（管理系統）'})
    return r


def new_state():
    cur, last = taipei_month(0), taipei_month(-1)
    st = {'stores': [{'code': 'gf', 'name': '新竹光復'}, {'code': 'mc', 'name': '台中美村'}],
          'rows': {'gf': [], 'mc': []}, 'locks': {'gf': {}, 'mc': {}},
          'subjects': {'expenseSubjects': ['食材', '雜支', '人事'], 'incomeSubjects': ['其他收入']},
          'calls': [], 'leaked': [], 'cur': cur, 'last': last}
    i = 0
    for month in sorted({cur, last, ALERT_MONTH}):
        for j, (kind, sub, name, amt, inv, st_, day) in enumerate([
                ('支出', '食材', '青菜', 1000, True, '正常', 3), ('收入', '其他收入', '廠商退款', 400, False, '正常', 3),
                ('支出', '雜支', '垃圾袋', 120, False, '作廢', 4)]):
            i += 1
            st['rows']['gf'].append(_row(i, '新竹光復', month, day, kind, sub, name, amt, inv, j + 1, st_,
                                         'https://example.test/photo/a.jpg' if j == 0 else ''))
    st['rows']['mc'].append(_row(900, '台中美村', ALERT_MONTH, 2, '支出', '食材', '豆干', 300, False, 1))
    st['locks']['mc'][ALERT_MONTH] = {'month': ALERT_MONTH, 'status': '鎖定', 'lockedAt': '2026-10-02 09:00:00', 'lockedBy': '會計乙（ACC）（管理系統）', 'lockedVia': 'acct'}
    # 上個月店長自己鎖過（月結鎖定分頁要看得到「店長鎖定」）
    st['locks']['gf'][last] = {'month': last, 'status': '鎖定', 'lockedAt': last + '-28 22:00:00', 'lockedBy': '店長', 'lockedVia': 'store'}
    return st


def _locked(st, store, month):
    rec = st['locks'][store].get(month)
    return bool(rec and rec['status'] == '鎖定')


def proxy(mock, body):
    """回 (http 狀態, 回應)。mock＝common.MockBackend（借它的 USERS 與 leaked）"""
    from common import USERS
    if not hasattr(mock, 'cashbook_state'):
        mock.cashbook_state = new_state()
    st = mock.cashbook_state
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
    if action not in READ and action not in WRITE:
        return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
    if not ('*' in perms or 'cashbook.write' in perms):
        return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
    for k in FORBIDDEN_FIELDS:
        if isinstance(payload, dict) and k in payload:
            st['leaked'].append('FIELD %s in %s' % (k, action))
    st['calls'].append((action, dict(payload)))
    operator = '%s（%s）（管理系統）' % (u['user']['name'], who)
    store = payload.get('store')

    if action == 'adminStores':
        return 200, {'ok': True, 'stores': st['stores']}
    if action in ('adminList', 'adminLocks', 'adminVoid', 'adminLock', 'adminUnlock'):
        if store not in st['rows']:
            return 200, {'ok': False, 'error': 'BAD_INPUT'}
    name = next((s['name'] for s in st['stores'] if s['code'] == store), '')
    if action == 'adminList':
        month = payload.get('month') or ''
        rows = [r for r in st['rows'][store] if r['date'].startswith(month)]
        return 200, {'ok': True, 'store': store, 'name': name, 'month': month, 'rows': rows, 'locked': _locked(st, store, month)}
    if action == 'adminLocks':
        return 200, {'ok': True, 'store': store, 'locks': sorted(st['locks'][store].values(), key=lambda x: x['month'])}
    if action == 'adminGet':
        return 200, dict(st['subjects'], ok=True)
    if action == 'adminVoid':
        r = next((x for x in st['rows'][store] if x['id'] == payload.get('id')), None)
        reason = payload.get('reason')
        if r is None or not isinstance(reason, str) or not (1 <= len(reason.strip()) <= 200) or r['status'] == '作廢':
            return 200, {'ok': False, 'error': 'BAD_INPUT'}
        if _locked(st, store, r['date'][:7]):
            return 200, {'ok': False, 'error': 'LOCKED'}
        r.update({'status': '作廢', 'voidReason': reason.strip(), 'voidedBy': operator, 'voidedAt': '2026-10-24 12:00:00'})
        return 200, {'ok': True}
    if action == 'adminLock':
        month = payload.get('month') or ''
        if month not in st['locks'][store]:
            st['locks'][store][month] = {'month': month, 'status': '鎖定', 'lockedAt': '2026-10-24 12:00:00', 'lockedBy': operator, 'lockedVia': 'acct'}
        return 200, {'ok': True}
    if action == 'adminUnlock':
        st['locks'][store].pop(payload.get('month') or '', None)
        return 200, {'ok': True}
    if action == 'adminSave':
        if 'newStorePass' in payload or 'newAdminPass' in payload:
            return 200, {'ok': False, 'error': 'BAD_INPUT'}
        for k in ('expenseSubjects', 'incomeSubjects'):
            if k in payload:
                st['subjects'][k] = payload[k]
        return 200, dict(st['subjects'], ok=True)
    return 200, {'ok': False, 'error': 'BAD_INPUT'}
