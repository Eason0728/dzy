#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""資料帶入測試・管理部門：盤點抽查（audit-stock）＋營運稽核（audit-ops）＋門市管理。

- 資料每次全部隨機重抽（dd_mgmt_dataset.py），印出種子；E2E_SEED=<種子> 重現。
- 每個計算（盤差、正確率、合格率、累犯品項、未完成項目、追蹤清單、店長裁切後的列）由本檔
  照規格自己算，逐筆比對畫面與送到假後端的內容；不 import 系統計算模組。
- 角色：會計（audit.write）、主管（audit.read）、店長（只看自己店）、督導（REGIONS 開／關／沒劃區）。
- 每顆按鈕都點過並稽核（dd_mgmt_clickmap.py），外網守門 ^https?://(?!127\\.0\\.0\\.1)，前端送出的 body
  不得出現通行碼。全程假後端，絕不碰正式後端。
- 關鍵畫面截圖存 test/dd/artifacts/mgmt/。

跑法：cd <repo> && python3 test/e2e/dd_mgmt_audit.py        （埠 9121，可用 E2E_PORT 改，只准 9120–9139）
"""
import copy
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
from common import AUDIT_SECRET, MockBackend, USERS, finish, login, start_server, failures  # noqa: E402

CHECKS = [0]


def check(cond, label):
    CHECKS[0] += 1
    common.check(cond, label)

from dd_mgmt_dataset import (Dataset, OPS_FLAT, OPS_TOTAL, SAMPLE_SIZE, anomaly_text, jsnum, month_label,  # noqa: E402
                             ops_counts, ops_summary, pick_seed, rate, today_taipei)
from dd_mgmt_clickmap import ClickMap  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

PORT = int(os.environ.get('E2E_PORT', '9121'))
assert 9120 <= PORT <= 9139, '本測試只准用 9120–9139 埠'
ART = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dd', 'artifacts', 'mgmt')
os.makedirs(ART, exist_ok=True)
EXTERNAL = re.compile(r'^https?://(?!127\.0\.0\.1)')

SEED = pick_seed()
print('E2E_SEED=%d' % SEED)
DS = Dataset(SEED)
RNG = DS.rng
CUR = DS.cur_month
CUR_MM = int(CUR[5:])
cm = ClickMap()
external_hits = []
raw_bodies = []


def shot(page, name):
    try:
        page.screenshot(path=os.path.join(ART, name + '.png'), full_page=True)
    except Exception as e:  # 截圖失敗不該讓測試炸掉
        print('screenshot failed', name, e)


# ============================================================
# 有狀態假後端：資料由測試注入，形狀照 ~/mala-audit/apps-script/Code.gs
# ============================================================

class MgmtMock(MockBackend):
    def __init__(self, base, ds):
        super().__init__(base)
        self.ds = ds
        self.all_stores = copy.deepcopy(ds.all_stores)
        self.records = {r['record_key']: copy.deepcopy(r) for r in ds.records}
        self.details = copy.deepcopy(ds.details)
        self.ops_records = {r['record_key']: copy.deepcopy(r) for r in ds.ops_records}
        self.ops_details = copy.deepcopy(ds.ops_details)
        self.writes = []
        self.fail_next = False
        USERS['lead']['user']['node'] = ds.lead_store
        if ds.lead_scope_from_backend:
            USERS['lead']['audit_scope'] = [ds.lead_store]
        base_sup = {'password': 'e2e-sup', 'perms': ['platform.self', 'audit.read.brand']}
        USERS['sup_on'] = dict(base_sup, user={'id': 'u-sup-on', 'name': '督導（劃區）', 'role': 'staff', 'node': ''}, audit_scope=list(ds.region_scope))
        USERS['sup_off'] = dict(base_sup, user={'id': 'u-sup-off', 'name': '督導（全品牌）', 'role': 'staff', 'node': ''}, audit_scope=list(ds.store_codes))
        USERS['sup_none'] = dict(base_sup, user={'id': 'u-sup-none', 'name': '督導（沒區）', 'role': 'staff', 'node': ''}, audit_scope=[])

    # ---- login／me 多回 audit_scope（新後端 Auth.gs handleLogin／handleMe）----
    def platform_action(self, action, body):
        res = super().platform_action(action, body)
        if action in ('login', 'me') and res.get('ok'):
            name = (body.get('payload') or {}).get('username') if action == 'login' else (body.get('token') or '').replace('e2e-token-', '')
            u = USERS.get(name) or {}
            if 'audit_scope' in u:
                res['data']['audit_scope'] = u['audit_scope']
        return res

    # ---- 代轉（照 Auth.gs proxyAuthorize_ ＋ mini filterResponse 的語意）----
    def proxy(self, body):
        def has_secret_field(o):
            return isinstance(o, dict) and ('code' in o or 'pass' in o)
        if has_secret_field(body) or has_secret_field(body.get('payload')):
            self.leaked.append('SECRET_IN_PROXY_BODY: %r' % body)
            return 400, {'ok': False, 'error': 'BAD_REQUEST'}
        ns, action = body.get('ns', ''), body.get('action', '')
        self.proxy_calls = getattr(self, 'proxy_calls', []) + [(ns, action)]
        if ns != 'audit':
            return super().proxy(body)
        token = body.get('token') or ''
        u = USERS.get(token.replace('e2e-token-', ''))
        if not token or not u:
            return 401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'}
        perms = u['perms']
        has = lambda p: '*' in perms or p in perms
        is_write = action != 'getAll'
        if is_write and action not in ('submitAudit', 'markRest', 'submitOpsAudit', 'addStore', 'setStoreStatus', 'renameStore'):
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        if is_write and not has('audit.write'):
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        if not (has('audit.write') or has('audit.read') or has('audit.read.own') or has('audit.read.brand')):
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        # filterNode：staff 走 audit_scope（'all'→不裁、陣列→照裁）；系統帳號只有 read.own → 自己節點字串
        if u['user']['role'] == 'staff' and 'audit_scope' in u:
            sc = u['audit_scope']
            filter_node = None if sc == 'all' else list(sc)
        elif not has('audit.read') and has('audit.read.own'):
            filter_node = u['user'].get('node') or ''
        else:
            filter_node = None
        flat = dict(body.get('payload') or {})
        flat.pop('action', None)
        flat['action'] = action
        flat['code'] = AUDIT_SECRET
        resp = self.dispatch('audit', flat)
        if filter_node is not None:
            resp = filter_audit(resp, filter_node)
        return 200, json.loads(json.dumps(resp).replace(AUDIT_SECRET, '[REDACTED]'))

    def _getall(self):
        data = self.ds.getall()
        active = [s for s in self.all_stores if s['active']]
        data['config']['stores'] = [{'code': s['code'], 'name': s['name'], 'order': i + 1} for i, s in enumerate(active)]
        data['config']['all_stores'] = [dict(s, order=i + 1) for i, s in enumerate(self.all_stores)]
        data['records'] = list(self.records.values())
        data['details'] = list(self.details)
        data['ops_records'] = list(self.ops_records.values())
        data['ops_details'] = list(self.ops_details)
        return data

    def dispatch(self, backend, body):
        if backend != 'audit':
            return super().dispatch(backend, body)
        action = body.get('action', '')
        self.calls.append((backend, action))
        if body.get('code') != AUDIT_SECRET:
            return {'ok': False, 'error': '通行碣錯誤（mock）'}
        if action == 'getAll':
            return self._getall()
        self.writes.append(copy.deepcopy(body))
        if self.fail_next:
            self.fail_next = False
            return {'ok': False, 'error': '模擬後端故障'}
        if action == 'submitAudit':
            rec, dets = body['record'], body.get('details') or []
            self.records[rec['record_key']] = rec
            self.details = [d for d in self.details if d['record_key'] != rec['record_key']] + list(dets)
            return {'ok': True}
        if action == 'markRest':
            key = '%s_%s' % (body['store'], body['month'])
            self.records[key] = {'record_key': key, 'store': body['store'], 'month': body['month'], 'status': '輪休',
                                 'audit_date': today_taipei(), 'sample_count': 0, 'correct_count': 0, 'correct_rate': 0,
                                 'change_fund': '', 'petty_cash': '', 'tip_amount': 0, 'tip_match': '', 'anomaly_text': '', 'note': ''}
            self.details = [d for d in self.details if d['record_key'] != key]
            return {'ok': True}
        if action == 'submitOpsAudit':
            rec, dets = body['record'], body.get('details') or []
            if not rec.get('auditor'):
                return {'ok': False, 'error': '缺少稽核人員'}
            self.ops_records[rec['record_key']] = rec
            self.ops_details = [d for d in self.ops_details if d['record_key'] != rec['record_key']] + list(dets)
            return {'ok': True}
        if action == 'addStore':
            n = 1 + sum(1 for s in self.all_stores if s['code'].startswith('st-'))
            code = 'st-%02d' % n
            while any(s['code'] == code for s in self.all_stores):
                n += 1
                code = 'st-%02d' % n
            self.all_stores.append({'code': code, 'name': body['name'], 'tab': body['name'], 'active': True})
            return {'ok': True, 'store': {'code': code, 'name': body['name']}}
        if action == 'renameStore':
            for s in self.all_stores:
                if s['code'] == body['store']:
                    s['name'] = body['name']
            return {'ok': True, 'tab_renamed': True}
        if action == 'setStoreStatus':
            for s in self.all_stores:
                if s['code'] == body['store']:
                    s['active'] = body['status'] == '啟用'
            return {'ok': True}
        return {'ok': False, 'error': '未知的 audit action（mock）：' + action}


ROW_KEYS = ['items', 'records', 'details', 'ops_records', 'ops_details']
CFG_KEYS = ['reasons', 'change_fund_std', 'petty_cash_std', 'accountant_ok', 'stores']


def filter_audit(data, node):
    """mini 端裁切（test/fixtures/filter-cases.json 的語意）：白名單鍵、五陣列依 store 裁、config.stores 依 code 裁、all_stores 刪。"""
    def allowed(store):
        if store is None:
            return False
        s = str(store)
        if isinstance(node, str):
            return node != '' and s == node
        return s in [str(x) for x in node]
    out = {}
    if 'ok' in data:
        out['ok'] = data['ok']
        if data['ok'] is False and isinstance(data.get('error'), str):
            out['error'] = data['error']
    for k in ROW_KEYS:
        if k in data:
            v = data[k]
            out[k] = [r for r in v if isinstance(r, dict) and allowed(r.get('store'))] if isinstance(v, list) else []
    cfg = data.get('config')
    if isinstance(cfg, dict):
        c = {}
        for k in CFG_KEYS:
            if k in cfg:
                c[k] = [r for r in cfg[k] if isinstance(r, dict) and allowed(r.get('code'))] if k == 'stores' else cfg[k]
        out['config'] = c
    if 'dry' in data:
        out['dry'] = data['dry']
    return out


# ============================================================
# 小工具
# ============================================================

def new_page(browser, mock, width=1280, url_suffix=''):
    ctx = browser.new_context(viewport={'width': width, 'height': 900})
    ctx.add_init_script("window.__printed = 0; window.print = () => { window.__printed++; };")
    page = ctx.new_page()
    page.on('pageerror', lambda e: js_errors.append(str(e)))

    def guard(route):
        external_hits.append(route.request.url)
        route.abort()
    page.route(EXTERNAL, guard)   # 先註冊，mock 後註冊優先；沒被 mock 接走的外網一律擋下並記錄
    mock.install(page)
    page.on('request', lambda req: raw_bodies.append(req.post_data or '') if req.method == 'POST' else None)
    return ctx, page


js_errors = []


def go_hash(page, h):
    page.evaluate("(h) => { window.location.hash = h; }", h)


def wait_hash(page, prefix, timeout=8000):
    page.wait_for_function("(p) => window.location.hash.indexOf(p) === 0", arg=prefix, timeout=timeout)


def view_tabs(page):
    page.wait_for_selector('[data-role="view-nav"] .nav-item', timeout=8000)
    return page.locator('[data-role="view-nav"] .nav-item').all_inner_texts()


def enter_module(page, module):
    page.wait_for_selector('[data-role="module-card"][data-module="%s"] .todo-head' % module, timeout=8000)
    page.click('[data-role="module-card"][data-module="%s"] .todo-head' % module)
    page.wait_for_selector('[data-keep="%s"]' % module, state='attached', timeout=8000)


def click_tab(page, text, verified):
    cm.scan(page, 'tabs')
    key = cm.key_of(page, '[data-role="view-nav"] .nav-item:has-text("%s")' % text)
    page.locator('[data-role="view-nav"] .nav-item', has_text=text).first.click()
    cm.mark(key, verified)


def select(page, selector, value, verified='下拉選擇'):
    cm.mark(cm.key_of(page, selector), verified)
    page.select_option(selector, value)


def grid_rows(page, module):
    return page.evaluate("""(sel) => [...document.querySelectorAll(sel + ' table.overview-grid tbody tr')]
      .map(tr => [tr.querySelector('th').textContent, [...tr.querySelectorAll('td')].map(td => td.textContent.trim())])""",
                         '[data-keep="%s"]' % module)


def active_stores(mock):
    return [dict(s, order=i + 1) for i, s in enumerate([x for x in mock.all_stores if x['active']])]


def expected_stock_grid(mock, codes=None):
    stores = [s for s in mock.all_stores if s['active'] and (codes is None or s['code'] in codes)]
    out = []
    for s in stores:
        cells = []
        for m in range(1, 13):
            rec = mock.records.get('%s_2026-%02d' % (s['code'], m))
            cells.append('%s%%' % rec['correct_rate'] if rec and rec['status'] == '已稽核' else ('輪休' if rec and rec['status'] == '輪休' else '—'))
        out.append([s['name'], cells])
    return out


def expected_ops_grid(mock, codes=None):
    stores = [s for s in mock.all_stores if s['active'] and (codes is None or s['code'] in codes)]
    out = []
    for s in stores:
        cells = []
        for m in range(1, 13):
            rec = mock.ops_records.get('%s_2026-%02d' % (s['code'], m))
            cells.append('%s%%' % rec['pass_rate'] if rec and rec['status'] == '已稽核' else '—')
        out.append([s['name'], cells])
    return out


def texts(page, sel):
    return page.evaluate("(s) => [...document.querySelectorAll(s)].map(e => e.textContent.trim())", sel)


def alert_rows(page, module):
    # 待辦列文字尾端有一個裝飾用的「›」箭頭，不算內容
    return [t.rstrip('›').strip() for t in texts(page, '[data-role="alert-list"][data-module="%s"] [data-role="alert-row"]' % module)]


def visible(page, sel):
    return page.evaluate("(s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }", sel)


def confirm_dialog(page, verified='確認對話框・確定'):
    page.wait_for_selector('.dialog .btn-primary', timeout=5000)
    cm.scan(page, 'dialog')
    cm.click(page, '.dialog .btn-primary', verified)


def cancel_dialog(page, verified='確認對話框・取消'):
    page.wait_for_selector('.dialog .btn-secondary', timeout=5000)
    cm.scan(page, 'dialog')
    cm.click(page, '.dialog .btn-secondary', verified)
    page.wait_for_selector('.dialog', state='detached', timeout=5000)


# ============================================================
# 會計：盤點抽查
# ============================================================

def check_stock_report(page, mock, store, month, label):
    """單月報告逐欄比對（記錄＋明細＋金庫＋異常說明＋備註）。"""
    root = '[data-keep="audit-stock"] .report-month'
    page.wait_for_selector(root + ' h3', timeout=8000)
    rec = mock.records.get('%s_%s' % (store, month))
    name = next(s['name'] for s in mock.all_stores if s['code'] == store)
    h3 = page.locator(root + ' h3').inner_text()
    check(h3 == '%s %s 稽核報告' % (name, month_label(month)), '%s：標題「%s」' % (label, h3))
    if not rec:
        check(page.locator(root + ' .report-empty').inner_text() == '無稽核紀錄', '%s：沒有紀錄顯示「無稽核紀錄」' % label)
        return
    if rec['status'] == '輪休':
        check(page.locator(root + ' .report-rest').inner_text() == '本月輪休', '%s：輪休月顯示「本月輪休」' % label)
        return
    got_rate = page.locator(root + ' .report-rate .tag').inner_text()
    check(got_rate == '%s%%' % rec['correct_rate'], '%s：正確率 %s（預期 %s%%＝round(%s/%s*100)）' % (label, got_rate, rec['correct_rate'], rec['correct_count'], rec['sample_count']))
    dets = [d for d in mock.details if d['record_key'] == rec['record_key']]
    exp_rows = [[d['item'], d['unit'], jsnum(d['book_qty']), jsnum(d['recount_qty']), d['verdict'], d['reason'] or ''] for d in dets]
    got_rows = page.evaluate("(s) => [...document.querySelectorAll(s + ' .report-detail-table tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))", root)
    if not dets:
        check(got_rows == [['無抽查明細']], '%s：無明細列' % label)
    else:
        check(got_rows == exp_rows, '%s：抽查明細 %d 列逐欄相同' % (label, len(exp_rows)) + ('' if got_rows == exp_rows else '\n    got=%s\n    exp=%s' % (got_rows[:3], exp_rows[:3])))
    vault = page.evaluate("(s) => [...document.querySelectorAll(s + ' .report-vault-table td')].map(td => td.textContent)", root)
    exp_vault = [rec['change_fund'], rec['petty_cash'], str(rec['tip_amount']), rec['tip_match']]
    check(vault == exp_vault, '%s：金庫抽查 %s' % (label, vault))
    exp_text = anomaly_text(dets) if dets else rec['anomaly_text']
    if exp_text:
        lines = texts(page, root + ' .report-anomaly .anomaly-line')
        check(lines == exp_text.split('\n'), '%s：複盤異常說明 %d 行逐行相同' % (label, len(lines)) + ('' if lines == exp_text.split('\n') else '\n    got=%s\n    exp=%s' % (lines, exp_text)))
    else:
        check(page.locator(root + ' .report-anomaly .report-empty-note').inner_text() == '無異常', '%s：零異常顯示「無異常」' % label)
    note = page.locator(root + ' .report-note p').inner_text()
    check(note == (rec['note'] or '（無）'), '%s：備註「%s」' % (label, note))


def check_annual(page, mock, store, label):
    root = '[data-keep="audit-stock"] .report-annual'
    page.wait_for_selector(root + ' table', timeout=8000)
    name = next(s['name'] for s in mock.all_stores if s['code'] == store)
    check(page.locator(root + ' h3').inner_text() == '%s 2026 年度總表' % name, '%s：年度總表標題' % label)
    rows = page.evaluate("""(s) => [...document.querySelectorAll(s + ' tbody tr')].map(tr => {
        const tds = [...tr.querySelectorAll('td')];
        return [tds.slice(0, 8).map(td => td.textContent), tds[8] ? tds[8].querySelectorAll('.anomaly-line').length : -1]; })""", root)
    exp = []
    for m in range(1, 13):
        mo = '2026-%02d' % m
        rec = mock.records.get('%s_%s' % (store, mo))
        lab = month_label(mo)
        if not rec:
            exp.append([[lab, '', '', '', '', '', '', ''], 0])
        elif rec['status'] == '輪休':
            exp.append([[lab, '', '輪休', '', '', '', '', ''], 0])
        else:
            n_lines = len(rec['anomaly_text'].split('\n')) if rec['anomaly_text'] else 0
            exp.append([[lab, str(rec['sample_count']), str(rec['correct_count']), '%s%%' % rec['correct_rate'], rec['change_fund'],
                         rec['petty_cash'], rec['tip_match'], str(rec['tip_amount'])], n_lines])
    check(rows == exp, '%s：年度總表 12 列逐欄相同' % label + ('' if rows == exp else '\n    got=%s\n    exp=%s' % (rows, exp)))


def check_analysis(page, mock, frm, to, label):
    page.wait_for_selector('#an-stores table, #an-stores .an-empty', timeout=8000)
    rep, reasons, stores = DS.analysis(frm, to, None, mock.records.values(), mock.details, active_stores(mock))
    got_rep = page.evaluate("""() => [...document.querySelectorAll('#an-repeat tbody tr')].map(tr => {
        const td = tr.querySelectorAll('td'); const sp = td[2].querySelectorAll('span');
        return [td[0].textContent, td[1].textContent, sp[0].textContent, sp[1].textContent]; })""")
    exp_rep = [[r['item'], str(r['count']), '、'.join(DS.name_of[c] for c in r['stores']), '、'.join(r['months'])] for r in rep]
    check(got_rep == exp_rep, '%s：累犯品項排行 %d 列（次數 desc、品項升冪、店別／月份）' % (label, len(exp_rep)) + ('' if got_rep == exp_rep else '\n    got=%s\n    exp=%s' % (got_rep[:4], exp_rep[:4])))
    got_rs = page.evaluate("() => [...document.querySelectorAll('#an-reasons tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))")
    exp_rs = [[k, str(n)] for k, n in reasons]
    check(got_rs == exp_rs, '%s：異常原因分類 %d 列' % (label, len(exp_rs)) + ('' if got_rs == exp_rs else '\n    got=%s\n    exp=%s' % (got_rs, exp_rs)))
    got_st = page.evaluate("() => [...document.querySelectorAll('#an-stores tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))")
    exp_st = [[s['name'], str(s['anomalies']), str(s['audits']), '%s%%' % s['rate']] for s in stores]
    check(got_st == exp_st, '%s：各店異常數／稽核次數／異常率' % label + ('' if got_st == exp_st else '\n    got=%s\n    exp=%s' % (got_st, exp_st)))
    if not rep:
        check(page.locator('#an-repeat .an-empty').count() == 1, '%s：沒有異常時顯示空狀態' % label)


def fill_vault(page, cf, pc, tip, tm, note):
    cm.scan(page, 'fill-vault')
    cm.click(page, '[data-group="change_fund"][data-value="%s"]' % cf, '零找金核定')
    cm.click(page, '[data-group="petty_cash"][data-value="%s"]' % pc, '零用金核定')
    page.fill('#audit-tip-amount', str(tip))
    cm.click(page, '[data-group="tip_match"][data-value="%s"]' % tm, '小費相符核定')
    page.fill('#audit-note', note)


def acct_stock(page, mock):
    enter_module(page, 'audit-stock')
    tabs = view_tabs(page)
    check(tabs == ['總覽', '稽核填寫', '報告', '異常分析', '門市管理'], '會計分頁列 %s' % tabs)
    # 模組 keepAlive：剛才從待辦列進過稽核填寫，再進模組會停在上次的分頁 → 明確切回總覽
    click_tab(page, '總覽', '分頁→總覽')
    page.wait_for_selector('[data-keep="audit-stock"] table.overview-grid tbody tr', timeout=8000)
    cm.scan(page, 'stock-overview')
    got = grid_rows(page, 'audit-stock')
    exp = expected_stock_grid(mock)
    check(got == exp, '盤點總覽 %d 店×12 月格子全對（%s）' % (len(exp), '%'.join([]) or '正確率／輪休／—') + ('' if got == exp else '\n    got=%s\n    exp=%s' % (got, exp)))
    select(page, '#overview-year', '2026', '年份下拉')
    shot(page, '01_acct_stock_overview')

    # 點一個已稽核格子 → 報告帶 store/month
    audited = [r for r in mock.records.values() if r['status'] == '已稽核']
    target = RNG.choice(audited)
    page.click('[data-keep="audit-stock"] td.grid-cell[data-store="%s"][data-month="%s"]' % (target['store'], target['month']))
    wait_hash(page, '#/audit-stock/report?')
    h = page.evaluate('location.hash')
    check(('store=%s' % target['store']) in h and ('month=%s' % target['month']) in h, '點格子導到報告並帶參數：%s' % h)
    check_stock_report(page, mock, target['store'], target['month'], '報告（從格子進）')
    cm.scan(page, 'stock-report')
    shot(page, '02_acct_stock_report')

    # 換店／換月下拉
    other = RNG.choice([r for r in mock.records.values()] + [{'store': DS.store_codes[0], 'month': '2026-12'}])
    select(page, '#report-store-select', other['store'], '報告店別下拉')
    select(page, '#report-month-select', other['month'], '報告月份下拉')
    check_stock_report(page, mock, other['store'], other['month'], '報告（下拉切換）')
    # 列印鈕
    cm.click(page, '#report-print-btn', 'window.print 被呼叫')
    check(page.evaluate('window.__printed') == 1, '列印／存 PDF 呼叫 window.print 一次')
    # 年度總表
    cm.click(page, '.mode-btn[data-mode="annual"]', '切年度總表')
    page.wait_for_selector('#report-annual-store-select', timeout=5000)
    annual_store = page.locator('#report-annual-store-select').input_value()
    if annual_store != other['store']:
        print('ISSUE(低): 單月報告切到店別 %s 後按「年度總表」，年度總表停在 %s（annualStore 只在掛載時同步一次，之後不跟單月店別連動）' % (other['store'], annual_store))
    check_annual(page, mock, annual_store, '年度總表')
    cm.scan(page, 'stock-annual')
    another = RNG.choice(DS.store_codes)
    select(page, '#report-annual-store-select', another, '年度總表店別下拉')
    check_annual(page, mock, another, '年度總表（換店）')
    shot(page, '03_acct_stock_annual')
    cm.click(page, '.mode-btn[data-mode="month"]', '切回單月')
    page.wait_for_selector('[data-keep="audit-stock"] .report-month', timeout=5000)

    # 異常分析
    click_tab(page, '異常分析', '分頁→異常分析')
    check_analysis(page, mock, None, None, '異常分析（不限）')
    cm.scan(page, 'stock-analysis')
    opts = DS.month_options(None, mock.records.values(), mock.details)
    if len(opts) >= 2:
        frm, to = sorted(RNG.sample(opts, 2))
        select(page, '#an-from', frm, '起月下拉')
        select(page, '#an-to', to, '迄月下拉')
        check_analysis(page, mock, frm, to, '異常分析（%s～%s）' % (frm, to))
        # 起 > 迄：剛動的那欄說了算
        select(page, '#an-from', opts[-1], '起月下拉（顛倒）')
        check(page.locator('#an-to').input_value() == opts[-1], '起訖顛倒時迄月跟上起月')
        check_analysis(page, mock, opts[-1], opts[-1], '異常分析（單月）')
    got_opts = page.evaluate("() => [...document.querySelectorAll('#an-from option')].map(o => o.value)")
    check(got_opts == [''] + opts, '起訖選單＝資料出現過的年月：%s' % got_opts)
    shot(page, '04_acct_stock_analysis')


def acct_stock_fill(page, mock):
    """稽核填寫：只填異常項模式＋完整模式各送一筆；驗證、草稿、失敗重試。"""
    owner = 'u-acct'
    # 先放三份草稿：別人的、舊格式、自己的兩份（不同店月）→ 只有自己的兩份會被列出
    s0, s1 = DS.store_codes[0], DS.store_codes[-1]
    draft_month_a, draft_month_b = '2026-02', '2026-03'
    own_a = {'store': s0, 'month': draft_month_a, 'items': [{'name': 'X', 'unit': '包', 'book_qty': 1, 'recount_qty': 2, 'verdict': '異常', 'reason': '其他', 'note': 'n'}], 'vault': {}}
    own_b = {'store': s1, 'month': draft_month_b, 'items': [], 'vault': {'tip_amount': '5'}}
    page.evaluate("""([o, s0, s1, a, b]) => {
        localStorage.setItem('dzy.u.u-mgr.draft_' + s0 + '_2026-04_anomaly', JSON.stringify({store: s0, month: '2026-04', items: [{name:'Y'}], vault: {}}));
        localStorage.setItem('draft_' + s0 + '_2026-05', JSON.stringify({store: s0, month: '2026-05', items: [{name:'Z'}], vault: {}}));
        localStorage.setItem('dzy.u.' + o + '.draft_' + s0 + '_2026-02', JSON.stringify(a));
        localStorage.setItem('dzy.u.' + o + '.draft_' + s1 + '_2026-03_anomaly', JSON.stringify(b));
    }""", [owner, s0, s1, own_a, own_b])

    click_tab(page, '總覽', '分頁→總覽')
    page.wait_for_selector('#btn-start-audit', timeout=8000)
    cm.scan(page, 'stock-overview-acct')
    cm.click(page, '#btn-start-audit', '開始稽核→稽核填寫')
    wait_hash(page, '#/audit-stock/fill')
    page.wait_for_selector('#audit-items', state='attached', timeout=8000)
    page.wait_for_function("() => document.querySelectorAll('#audit-store option').length > 0", timeout=8000)

    # 草稿一覽：只列自己的兩份
    rows = texts(page, '#audit-drafts-list .audit-draft-resume')
    exp_rows = sorted([(own_b['month'], s1, '%s　%s（只填異常項·已填 0 項）'), (own_a['month'], s0, '%s　%s（完整 20 項·已填 1 項）')], key=lambda x: (x[0], x[1]), reverse=True)
    # 系統排序：新月份在前；同月依店代碼升冪 → own_b(03) 先、own_a(02) 後
    exp_labels = ['%s　%s（只填異常項·已填 0 項）' % (DS.name_of[s1], month_label(draft_month_b)),
                  '%s　%s（完整 20 項·已填 1 項）' % (DS.name_of[s0], month_label(draft_month_a))]
    # 若 own_b 沒有內容（items 空、vault 只有 tip_amount）仍算有內容（tip_amount 非空）
    check(rows == exp_labels, '草稿一覽只列自己的兩份、不列別人的與舊格式：%s' % rows)
    cm.scan(page, 'stock-fill')
    # 接續第一份（own_b）→ 清單只剩 own_a → 接續 own_a → 清單只剩 own_b → 丟棄 own_b
    cm.click(page, '#audit-drafts-list .audit-draft-resume', '接續草稿（只填異常項）')
    page.wait_for_function("(m) => document.querySelector('#audit-month').value === m", arg=draft_month_b, timeout=5000)
    check(page.locator('#audit-store').input_value() == s1 and page.locator('#audit-tip-amount').input_value() == '5', '接續草稿：店／月／小費金額都還原')
    check(texts(page, '#audit-drafts-list .audit-draft-resume') == exp_labels[1:], '接續中的那份不再列在一覽')
    cm.click(page, '#audit-drafts-list .audit-draft-resume', '接續草稿（完整模式）')
    page.wait_for_function("(m) => document.querySelector('#audit-month').value === m", arg=draft_month_a, timeout=5000)
    check(page.locator('#audit-store').input_value() == s0 and page.locator('#audit-items li').count() == 1
          and page.locator('.audit-mode-btn.active').get_attribute('data-mode') == 'full', '接續完整模式草稿：店／月／1 項品項／模式切回完整')
    check(texts(page, '#audit-drafts-list .audit-draft-resume') == exp_labels[:1], '一覽換成另一份')
    cm.click(page, '#audit-drafts-list .audit-draft-drop', '丟棄草稿')
    check(not visible(page, '#audit-drafts-card'), '丟棄後沒有其他草稿、一覽卡片收起')
    check(page.evaluate("(o) => localStorage.getItem('dzy.u.' + o + '.draft_%s_2026-03_anomaly')" % s1, owner) is None
          and page.evaluate("(o) => localStorage.getItem('dzy.u.' + o + '.draft_%s_2026-02')" % s0, owner) is not None, '丟棄的是對的那把 key（接續中的那把還在）')
    check(page.evaluate("() => localStorage.getItem('dzy.u.u-mgr.draft_%s_2026-04_anomaly') !== null && localStorage.getItem('draft_%s_2026-05') !== null" % (s0, s0)), '別人的與舊格式草稿沒被動到')

    # ---- 只填異常項模式：挑一個沒有紀錄的店月 ----
    cands = [(c, m) for c in DS.store_codes for m in DS.months if ('%s_%s' % (c, m)) not in mock.records]
    store, month = RNG.choice(cands) if cands else (DS.store_codes[0], '2026-12')
    select(page, '#audit-store', store, '填寫店別下拉')
    select(page, '#audit-month', month, '填寫月份下拉')
    cm.scan(page, 'stock-fill-mode')
    cm.click(page, '.audit-mode-btn[data-mode="anomaly"]', '切只填異常項')
    check(not visible(page, '#audit-draw'), '只填異常項模式隱藏「隨機抽」')
    lib = [it for it in mock.ds.items_by_store[store] if it['active'] and it['unit']]
    nounit = [it for it in mock.ds.items_by_store[store] if it['active'] and not it['unit']]
    k = RNG.randint(1, 6)
    picked = RNG.sample(lib, k)
    # 加入：不在品項庫且沒單位 → 擋
    page.fill('#audit-add-input', '測試自訂品項')
    cm.click(page, '#audit-add-btn', '加入品項（缺單位擋下）')
    check(visible(page, '#audit-add-error') and '請一併填單位' in page.locator('#audit-add-error').inner_text(), '不在品項庫＋沒單位 → 錯誤提示')
    for it in picked:
        page.fill('#audit-add-input', it['name'])
        page.fill('#audit-add-unit', '')
        page.press('#audit-add-input', 'Enter')
    check(page.locator('#audit-items li').count() == k, '加入 %d 個異常品項' % k)
    # 重複加入擋下
    page.fill('#audit-add-input', picked[0]['name'])
    cm.click(page, '#audit-add-btn', '加入品項（重複擋下）')
    check('已在清單中' in page.locator('#audit-add-error').inner_text(), '重複品項擋下')
    # 品項庫缺單位的 → 要補單位
    custom = []
    if nounit:
        page.fill('#audit-add-input', nounit[0]['name'])
        page.fill('#audit-add-unit', '')
        cm.click(page, '#audit-add-btn', '加入品項（品項庫缺單位）')
        check('沒有填「%s」的單位' % nounit[0]['name'] in page.locator('#audit-add-error').inner_text(), '品項庫缺單位提示補單位')
        page.fill('#audit-add-unit', '箱')
        cm.click(page, '#audit-add-btn', '加入品項（補單位後）')
        custom.append({'name': nounit[0]['name'], 'unit': '箱'})
    page.fill('#audit-add-input', '測試自訂品項')
    page.fill('#audit-add-unit', '盤')
    cm.click(page, '#audit-add-btn', '加入自訂品項')
    custom.append({'name': '測試自訂品項', 'unit': '盤'})
    all_items = [{'name': it['name'], 'unit': it['unit']} for it in picked] + custom
    n = len(all_items)
    check(page.locator('#audit-items li').count() == n, '清單共 %d 項' % n)
    exp_rate = rate(SAMPLE_SIZE - n, SAMPLE_SIZE)
    warn = page.locator('#audit-count-warning').inner_text()
    check(warn == '異常 %d 項，其餘視同正確 → 正確率 %d%%（%d／20，分母固定 20 項）' % (n, exp_rate, SAMPLE_SIZE - n), '即時提示正確率：%s' % warn)
    # 未填就送：預期每項 3 條＋金庫 4 條
    cm.scan(page, 'stock-fill-items')
    cm.click(page, '#audit-submit-btn', '送出（驗證擋下）')
    errs = page.locator('#audit-submit-error').evaluate('e => e.textContent').split('\n')
    check(len(errs) == 3 * n + 4, '驗證錯誤 %d 條（預期 %d＝每項 3＋金庫 4）' % (len(errs), 3 * n + 4))
    # 逐項填
    rows = []
    for it in all_items:
        li = '#audit-items li[data-item="%s"]' % it['name']
        book = RNG.choice([RNG.randint(1, 50), round(RNG.uniform(0.5, 40), 1)])
        rec = RNG.choice([book + RNG.randint(1, 5), round(book + RNG.uniform(0.1, 5), 1)])
        if isinstance(book, int) and isinstance(rec, float):
            rec = round(rec, 1)
        reason = RNG.choice(DS.reasons)
        note = RNG.choice(['後場漏盤', '補單位後重盤', '']) if reason != '其他' else '其他原因說明'
        page.fill(li + ' .audit-book-qty', jsnum(book))
        page.fill(li + ' .audit-recount-qty', jsnum(rec))
        select(page, li + ' .audit-reason', reason, '異常原因下拉')
        page.fill(li + ' .audit-item-note', note)
        rows.append({'item': it['name'], 'unit': it['unit'], 'book_qty': book, 'recount_qty': rec, 'verdict': '異常', 'reason': reason, 'note': note})
    # 其他需備註：故意清掉一個「其他」的備註
    others = [r for r in rows if r['reason'] == '其他']
    if others:
        li = '#audit-items li[data-item="%s"]' % others[0]['item']
        page.fill(li + ' .audit-item-note', '')
        page.click('#audit-submit-btn')
        check('原因為「其他」需填寫備註' in page.locator('#audit-submit-error').inner_text(), '原因「其他」沒備註擋下')
        page.fill(li + ' .audit-item-note', others[0]['note'])
    cf, pc, tip, tm, note = RNG.choice(['正確', '不正確']), RNG.choice(['正確', '不正確']), RNG.randint(0, 2500), RNG.choice(['相符', '不相符']), RNG.choice(['', '測試備註'])
    fill_vault(page, cf, pc, tip, tm, note)
    draft_key = 'dzy.u.%s.draft_%s_%s_anomaly' % (owner, store, month)
    check(page.evaluate("(k) => localStorage.getItem(k) !== null", draft_key), '草稿 key 只認本人：%s 存在' % draft_key)
    # 失敗→重試
    mock.fail_next = True
    cm.click(page, '#audit-submit-btn', '送出（後端失敗）')
    page.wait_for_selector('#audit-retry-btn:not([hidden])', timeout=8000)
    check('草稿已保留' in page.locator('#audit-submit-error').inner_text(), '後端失敗：提示草稿保留＋重試鈕')
    cm.scan(page, 'stock-fill-retry')
    shot(page, '05_acct_stock_fill_anomaly')
    cm.click(page, '#audit-retry-btn', '重試送出')
    wait_hash(page, '#/audit-stock/report?store=%s&month=%s' % (store, month))
    w = mock.writes[-1]
    rec = w['record']
    exp_rec = {'record_key': '%s_%s' % (store, month), 'store': store, 'month': month, 'status': '已稽核', 'audit_date': today_taipei(),
               'sample_count': SAMPLE_SIZE, 'correct_count': SAMPLE_SIZE - n, 'correct_rate': exp_rate, 'change_fund': cf, 'petty_cash': pc,
               'tip_amount': tip, 'tip_match': tm, 'anomaly_text': anomaly_text(rows), 'note': note}
    got_rec = {k: rec.get(k) for k in exp_rec}
    check(got_rec == exp_rec, '只填異常項送出的 record 逐欄相同（分母固定 20、正確率 %d%%）' % exp_rate + ('' if got_rec == exp_rec else '\n    got=%s\n    exp=%s' % (got_rec, exp_rec)))
    check(re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$', rec.get('submitted_at', '')) is not None, 'submitted_at 是帶時區的 ISO')
    exp_det = [dict(r, record_key=exp_rec['record_key'], store=store, month=month) for r in rows]
    got_det = [{k: d.get(k) for k in exp_det[0]} for d in w['details']]
    check(got_det == exp_det, '只填異常項送出的 details %d 列逐欄相同' % n + ('' if got_det == exp_det else '\n    got=%s\n    exp=%s' % (got_det, exp_det)))
    check(page.evaluate("(k) => localStorage.getItem(k)", draft_key) is None, '送出成功後草稿清掉')
    check_stock_report(page, mock, store, month, '剛送出的報告')
    shot(page, '06_acct_stock_report_after_submit')

    # ---- 完整模式：挑一個已有紀錄的店月（覆蓋確認）----
    click_tab(page, '稽核填寫', '分頁→稽核填寫')
    page.wait_for_selector('#audit-items', state='attached', timeout=8000)
    existing = RNG.choice([r for r in mock.records.values() if r['status'] == '已稽核'])
    store2, month2 = existing['store'], existing['month']
    select(page, '#audit-store', store2, '填寫店別下拉')
    select(page, '#audit-month', month2, '填寫月份下拉')
    cm.click(page, '.audit-mode-btn[data-mode="full"]', '切完整模式')
    check(visible(page, '#audit-draw'), '完整模式顯示「隨機抽 20 項」')
    cm.click(page, '#audit-draw', '隨機抽樣')
    active_names = {it['name']: it for it in mock.ds.items_by_store[store2] if it['active']}
    names = page.evaluate("() => [...document.querySelectorAll('#audit-items li')].map(li => li.getAttribute('data-item'))")
    exp_n = min(SAMPLE_SIZE, len(active_names))
    check(len(names) == exp_n and len(set(names)) == len(names) and all(nm in active_names for nm in names), '抽樣 %d 項、不重複、全在啟用品項庫（%s）' % (len(names), exp_n))
    # 抽過標記：有歷史明細的品項要標「⚠ YYYY-MM 抽過」
    hist = {}
    for d in mock.details:
        if d['store'] == store2 and (d['item'] not in hist or d['month'] > hist[d['item']]):
            hist[d['item']] = d['month']
    flags = page.evaluate("() => [...document.querySelectorAll('#audit-items li')].map(li => { const f = li.querySelector('.audit-item-flag'); return [li.getAttribute('data-item'), f ? f.textContent : null]; })")
    exp_flags = [[nm, ('⚠ %s 抽過' % hist[nm]) if nm in hist else None] for nm in names]
    check(flags == exp_flags, '「上次抽過」標記＝該品項最近出現的月份' + ('' if flags == exp_flags else '\n    got=%s\n    exp=%s' % (flags, exp_flags)))
    cm.scan(page, 'stock-fill-full')
    # 換一項／刪除
    first = names[0]
    cm.click(page, '#audit-items li[data-item="%s"] .audit-item-redraw' % first, '換一項')
    names2 = page.evaluate("() => [...document.querySelectorAll('#audit-items li')].map(li => li.getAttribute('data-item'))")
    if len(active_names) > exp_n:
        check(names2[0] != first and len(set(names2)) == len(names2) and names2[0] in active_names, '換一項：第一項換成另一個未在清單中的品項')
    else:
        check(names2 == names, '品項庫剛好抽滿，換一項沒得換（清單不變）')
    cm.click(page, '#audit-items li[data-item="%s"] .audit-item-remove' % names2[-1], '刪除品項')
    names3 = page.evaluate("() => [...document.querySelectorAll('#audit-items li')].map(li => li.getAttribute('data-item'))")
    check(names3 == names2[:-1], '刪除最後一項後清單少一項')
    warn = page.locator('#audit-count-warning').inner_text()
    check(warn == '目前 %d 項（標準 20 項）' % len(names3), '項數不足提示：%s' % warn)
    # 逐項填寫
    rows2 = []
    for nm in names3:
        li = '#audit-items li[data-item="%s"]' % nm
        it = active_names[nm]
        unit = it['unit']
        if not unit:
            unit = '公斤'
            page.fill(li + ' .audit-unit-fix', unit)
        book = RNG.choice([RNG.randint(1, 50), round(RNG.uniform(0.5, 40), 1)])
        anomaly = RNG.random() < 0.3
        rec = (book + RNG.randint(1, 5)) if anomaly else book
        page.fill(li + ' .audit-book-qty', jsnum(book))
        page.fill(li + ' .audit-recount-qty', jsnum(rec))
        if anomaly:
            cm.click(page, li + ' [data-group="verdict"][data-value="異常"]', '核定異常')
            reason = RNG.choice([r for r in DS.reasons if r != '其他'])
            select(page, li + ' .audit-reason', reason, '異常原因下拉')
            rows2.append({'item': nm, 'unit': unit, 'book_qty': book, 'recount_qty': rec, 'verdict': '異常', 'reason': reason, 'note': ''})
        else:
            cm.click(page, li + ' [data-group="verdict"][data-value="正確"]', '核定正確')
            rows2.append({'item': nm, 'unit': unit, 'book_qty': book, 'recount_qty': rec, 'verdict': '正確', 'reason': '', 'note': ''})
    # 金庫三組核定選跟上一筆相反的值，兩種按鈕都點到
    flip = {'正確': '不正確', '不正確': '正確', '相符': '不相符', '不相符': '相符'}
    cf2, pc2, tm2 = flip[cf], flip[pc], flip[tm]
    fill_vault(page, cf2, pc2, 123, tm2, '')
    cm.click(page, '#audit-submit-btn', '送出（覆蓋確認）')
    page.wait_for_selector('.dialog', timeout=5000)
    check(('將覆蓋 %s 的紀錄' % existing['audit_date']) in page.locator('.dialog').inner_text(), '覆蓋確認框列出原稽核日期')
    cancel_dialog(page, '覆蓋確認・取消')
    check(mock.writes[-1]['record']['record_key'] != '%s_%s' % (store2, month2) or mock.writes[-1]['record']['sample_count'] == SAMPLE_SIZE, '取消覆蓋沒有送出')
    n_before = len(mock.writes)
    page.click('#audit-submit-btn')
    confirm_dialog(page, '覆蓋確認・確定')
    wait_hash(page, '#/audit-stock/report?store=%s&month=%s' % (store2, month2))
    check(len(mock.writes) == n_before + 1, '確定後送出一次')
    rec2 = mock.writes[-1]['record']
    correct = sum(1 for r in rows2 if r['verdict'] == '正確')
    exp2 = {'sample_count': len(rows2), 'correct_count': correct, 'correct_rate': rate(correct, len(rows2)),
            'anomaly_text': anomaly_text(rows2), 'change_fund': cf2, 'petty_cash': pc2, 'tip_amount': 123, 'tip_match': tm2}
    got2 = {k: rec2.get(k) for k in exp2}
    check(got2 == exp2, '完整模式 record：分母＝清單項數 %d、正確率 round(%d/%d*100)=%d%%' % (len(rows2), correct, len(rows2), exp2['correct_rate']) + ('' if got2 == exp2 else '\n    got=%s\n    exp=%s' % (got2, exp2)))
    got_d2 = [{k: d.get(k) for k in ('item', 'unit', 'book_qty', 'recount_qty', 'verdict', 'reason', 'note')} for d in mock.writes[-1]['details']]
    check(got_d2 == rows2, '完整模式 details %d 列逐欄相同（正確項 reason/note 清空）' % len(rows2) + ('' if got_d2 == rows2 else '\n    got=%s\n    exp=%s' % (got_d2[:3], rows2[:3])))
    check_stock_report(page, mock, store2, month2, '覆蓋後的報告')
    shot(page, '07_acct_stock_full_submit')


def acct_mark_rest(page, mock):
    click_tab(page, '總覽', '分頁→總覽')
    page.wait_for_selector('#btn-mark-rest', timeout=8000)
    cm.click(page, '#btn-mark-rest', '開標記輪休表單')
    check(visible(page, '#rest-dialog'), '標記輪休表單出現')
    cm.scan(page, 'rest-dialog')
    cm.click(page, '#rest-cancel', '取消標記輪休')
    check(not visible(page, '#rest-dialog'), '取消後表單隱藏')
    page.click('#btn-mark-rest')
    cands = [(c, m) for c in DS.store_codes for m in range(1, 13) if ('%s_2026-%02d' % (c, m)) not in mock.records]
    store, mm = RNG.choice(cands)
    select(page, '#rest-store', store, '輪休店別下拉')
    select(page, '#rest-month', '%02d' % mm, '輪休月份下拉')
    opts = texts(page, '#rest-month option')
    check(opts == [month_label('2026-%02d' % m) for m in range(1, 13)], '輪休月份選單＝一月～十二月')
    cm.click(page, '#rest-confirm', '確認標記輪休')
    page.wait_for_function("([s, m]) => { const td = document.querySelector('[data-keep=\"audit-stock\"] td.grid-cell[data-store=\"' + s + '\"][data-month=\"' + m + '\"]'); return td && td.textContent.trim() === '輪休'; }",
                           arg=[store, '2026-%02d' % mm], timeout=8000)
    w = mock.writes[-1]
    check(w['action'] == 'markRest' and w['store'] == store and w['month'] == '2026-%02d' % mm, 'markRest 送出 {store, month}：%s' % {k: w[k] for k in ('action', 'store', 'month')})
    check(not visible(page, '#rest-dialog'), '標記成功後表單收起')
    got = grid_rows(page, 'audit-stock')
    exp = expected_stock_grid(mock)
    check(got == exp, '標記輪休後總覽重算全對')


def acct_stores(page, mock):
    click_tab(page, '門市管理', '分頁→門市管理')
    page.wait_for_selector('#store-list tbody tr', timeout=8000)
    cm.scan(page, 'stores')
    rows = page.evaluate("() => [...document.querySelectorAll('#store-list tbody tr')].map(tr => [tr.getAttribute('data-store'), tr.querySelector('td').textContent, !!tr.querySelector('.tag-danger')])")
    exp = [[s['code'], s['name'] + ('停用中' if not s['active'] else ''), not s['active']] for s in mock.all_stores]
    check(rows == exp, '門市清單含停用：%d 家、停用標記正確' % len(exp) + ('' if rows == exp else '\n    got=%s\n    exp=%s' % (rows, exp)))
    # 空名擋下
    page.fill('#store-new-name', '   ')
    cm.click(page, '#store-add-btn', '新增門市（空名擋下）')
    check(page.locator('.dialog').count() == 0, '空白店名不開確認框')
    new_name = RNG.choice(['一悟燒肉', '墨竹亭', '小辛辣']) + RNG.choice(['竹北', '新豐', '湖口']) + str(RNG.randint(1, 99))
    page.fill('#store-new-name', new_name)
    page.click('#store-add-btn')
    cancel_dialog(page, '新增門市・取消')
    n0 = len(mock.writes)
    page.click('#store-add-btn')
    confirm_dialog(page, '新增門市・確定')
    page.wait_for_function("(n) => document.querySelectorAll('#store-list tbody tr').length === n", arg=len(exp) + 1, timeout=8000)
    w = mock.writes[-1]
    new_code = mock.all_stores[-1]['code']
    check(len(mock.writes) == n0 + 1 and w['action'] == 'addStore' and w['name'] == new_name, 'addStore 送出 {name}：%s' % w.get('name'))
    # 改名
    cm.click(page, '#store-list tr[data-store="%s"] .store-rename' % new_code, '改名對話框')
    page.wait_for_selector('#store-rename-input', timeout=5000)
    cm.scan(page, 'rename-dialog')
    page.fill('#store-rename-input', new_name + '改')
    cm.click(page, '.dialog .btn-primary', '改名・儲存')
    page.wait_for_selector('#store-list tr[data-store="%s"] >> text=%s改' % (new_code, new_name), timeout=8000)
    w = mock.writes[-1]
    check(w['action'] == 'renameStore' and w['store'] == new_code and w['name'] == new_name + '改', 'renameStore 送出 {store,name}')
    # 停用一家原本啟用的（不是店長那家，免得後面店長測試對不上）
    victim = RNG.choice([c for c in DS.store_codes if c != DS.lead_store])
    cm.click(page, '#store-list tr[data-store="%s"] .store-toggle' % victim, '停用門市')
    confirm_dialog(page, '停用・確定')
    page.wait_for_selector('#store-list tr[data-store="%s"] .tag-danger' % victim, timeout=8000)
    w = mock.writes[-1]
    check(w['action'] == 'setStoreStatus' and w['store'] == victim and w['status'] == '停用', 'setStoreStatus 停用送出')
    shot(page, '08_acct_stores')
    # 總覽：新店在、停用店不在
    click_tab(page, '總覽', '分頁→總覽')
    page.wait_for_function("(n) => document.querySelector('[data-keep=\"audit-stock\"] table.overview-grid') && [...document.querySelectorAll('[data-keep=\"audit-stock\"] table.overview-grid tbody th')].some(th => th.textContent === n)", arg=new_name + '改', timeout=8000)
    got = grid_rows(page, 'audit-stock')
    exp = expected_stock_grid(mock)
    check(got == exp, '停用／新增後總覽店列＝啟用門市（含新店、不含 %s）' % DS.name_of[victim])
    # 重新啟用
    click_tab(page, '門市管理', '分頁→門市管理')
    page.wait_for_selector('#store-list tr[data-store="%s"] .store-toggle' % victim, timeout=8000)
    cm.click(page, '#store-list tr[data-store="%s"] .store-toggle' % victim, '重新啟用門市')
    confirm_dialog(page, '重新啟用・確定')
    page.wait_for_function("(c) => { const r = document.querySelector('#store-list tr[data-store=\"' + c + '\"]'); return r && !r.querySelector('.tag-danger'); }", arg=victim, timeout=8000)
    check(mock.writes[-1]['status'] == '啟用', 'setStoreStatus 啟用送出')
    # 停用的新店也關掉，不影響後面的角色測試
    cm.click(page, '#store-list tr[data-store="%s"] .store-toggle' % new_code, '停用新店')
    confirm_dialog(page)
    page.wait_for_selector('#store-list tr[data-store="%s"] .tag-danger' % new_code, timeout=8000)


# ============================================================
# 會計：營運稽核
# ============================================================

def check_ops_report(page, mock, store, month, label):
    root = '[data-keep="audit-ops"] .report-month'
    page.wait_for_selector(root + ' h3', timeout=8000)
    rec = mock.ops_records.get('%s_%s' % (store, month))
    name = next(s['name'] for s in mock.all_stores if s['code'] == store)
    h3 = page.locator(root + ' h3').inner_text()
    check(h3 == '%s %s 營運稽核報告' % (name, month_label(month)), '%s：標題「%s」' % (label, h3))
    if not rec:
        check(page.locator(root + ' .report-empty').inner_text() == '無稽核紀錄', '%s：無紀錄' % label)
        return
    dets = [d for d in mock.ops_details if d['record_key'] == rec['record_key']]
    c = ops_counts(dets)
    check(page.locator(root + ' .report-rate').inner_text() == '合格率 %d%%' % c['pass_rate'], '%s：合格率 %d%%＝round(%d/19*100)' % (label, c['pass_rate'], c['pass']))
    chips = texts(page, root + ' .ops-stats .tag')
    exp_chips = ['細項 %d' % c['total'], '合格 %d' % c['pass'], '未完成 %d' % c['fail'], '未檢查 %d' % c['pending'], '追蹤 %d' % c['track']]
    check(chips == exp_chips, '%s：統計 chip %s' % (label, chips))
    meta = page.locator(root + ' .report-meta').inner_text()
    check(meta == '稽核日期：%s　稽核人員：%s' % (rec['audit_date'], rec['auditor']), '%s：稽核日期／人員「%s」' % (label, meta))
    fails = [d for d in dets if d['verdict'] == '未完成']
    check(page.locator(root + ' h4').first.inner_text() == '未完成項目（%d）' % len(fails), '%s：未完成項目數 %d' % (label, len(fails)))
    got_f = page.evaluate("(s) => [...document.querySelectorAll(s + ' .report-ops-fail tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))", root)
    exp_f = [[d['group'], d['text'], d['note'] or '', '★' if d['track'] else ''] for d in fails]
    if fails:
        check(got_f == exp_f, '%s：未完成清單 %d 列逐欄相同（分類／項目／說明／追蹤）' % (label, len(exp_f)) + ('' if got_f == exp_f else '\n    got=%s\n    exp=%s' % (got_f, exp_f)))
    else:
        check(page.locator(root + ' .report-empty-note').first.inner_text() == '全部合格', '%s：零未完成顯示「全部合格」' % label)
    got_all = page.evaluate("(s) => [...document.querySelectorAll(s + ' .report-ops-all tbody tr:not(.report-group-row)')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))", root)
    exp_all = [[d['text'], d['verdict'] + (' ★' if d['track'] else ''), d['note'] or ''] for d in dets]
    check(got_all == exp_all, '%s：全部檢查項目 %d 列逐欄相同' % (label, len(exp_all)) + ('' if got_all == exp_all else '\n    got=%s\n    exp=%s' % (got_all[:3], exp_all[:3])))
    groups = texts(page, root + ' .report-ops-all .report-group-row th')
    check(groups == ['營運管理｜消防安全', '營運管理｜營運', '品牌形象｜環境清潔', '品牌形象｜食安'], '%s：群組小標 4 組' % label)


def acct_ops(page, mock):
    cm_key = None
    page.click('[data-nav="audit-ops"]')
    wait_hash(page, '#/audit-ops/overview')
    page.wait_for_function("() => { const h = document.querySelector('[data-keep=\"audit-ops\"]'); return h && h.offsetParent !== null; }", timeout=8000)
    tabs = view_tabs(page)
    check(tabs == ['總覽', '稽核填寫', '報告'], '會計營運稽核分頁列 %s' % tabs)
    page.wait_for_selector('[data-keep="audit-ops"] table.overview-grid tbody tr', timeout=8000)
    cm.scan(page, 'ops-overview')
    got = grid_rows(page, 'audit-ops')
    exp = expected_ops_grid(mock)
    check(got == exp, '營運稽核總覽格子全對（合格率／—）' + ('' if got == exp else '\n    got=%s\n    exp=%s' % (got, exp)))
    select(page, '#ops-overview-year', '2026', '年份下拉')
    note = page.locator('[data-keep="audit-ops"] .field-hint').first.inner_text()
    check('÷ 19 項' in note, '總覽說明分母 19 項')
    shot(page, '09_acct_ops_overview')
    target = RNG.choice(list(mock.ops_records.values()))
    page.click('[data-keep="audit-ops"] td.grid-cell[data-store="%s"][data-month="%s"]' % (target['store'], target['month']))
    wait_hash(page, '#/audit-ops/report?store=%s&month=%s' % (target['store'], target['month']))
    check_ops_report(page, mock, target['store'], target['month'], '營運報告（從格子進）')
    cm.scan(page, 'ops-report')
    other = RNG.choice(list(mock.ops_records.values()) + [{'store': DS.store_codes[-1], 'month': '2026-12'}])
    select(page, '#opsreport-store', other['store'], '營運報告店別下拉')
    select(page, '#opsreport-month', other['month'], '營運報告月份下拉')
    check_ops_report(page, mock, other['store'], other['month'], '營運報告（下拉切換）')
    cm.click(page, '#opsreport-print', '營運報告列印')
    check(page.evaluate('window.__printed') >= 1, '營運報告列印呼叫 window.print')
    shot(page, '10_acct_ops_report')


def acct_ops_fill(page, mock):
    owner = 'u-acct'
    # 自己的一份營運草稿（另一店月）＋別人的一份 → 只列自己的
    s0 = DS.store_codes[0]
    page.evaluate("""([o, s0]) => {
        localStorage.setItem('dzy.u.' + o + '.ops_draft_' + s0 + '_2026-01', JSON.stringify({store: s0, month: '2026-01', auditor: '草稿人', entries: {c0g0i0: {verdict: '合格', track: true, note: ''}}}));
        localStorage.setItem('dzy.u.u-mgr.ops_draft_' + s0 + '_2026-02', JSON.stringify({store: s0, month: '2026-02', auditor: 'x', entries: {}}));
        localStorage.setItem('ops_draft_' + s0 + '_2026-03', JSON.stringify({store: s0, month: '2026-03', auditor: 'y', entries: {}}));
    }""", [owner, s0])
    click_tab(page, '總覽', '分頁→總覽')
    page.wait_for_selector('#btn-start-ops', timeout=8000)
    cm.scan(page, 'ops-overview-acct')
    cm.click(page, '#btn-start-ops', '開始稽核→營運稽核填寫')
    wait_hash(page, '#/audit-ops/fill')
    page.wait_for_selector('#ops-list .ops-item', timeout=8000)
    store = RNG.choice([c for c in DS.store_codes if c != s0])
    month = RNG.choice(DS.months)
    select(page, '#ops-store', store, '營運填寫店別下拉')
    select(page, '#ops-month', month, '營運填寫月份下拉')
    links = texts(page, '#ops-drafts .ops-draft-link')
    check(links == ['%s %s' % (DS.name_of[s0], month_label('2026-01'))], '營運草稿一覽只列自己的：%s' % links)
    cm.scan(page, 'ops-fill')
    cm.click(page, '#ops-drafts .ops-draft-link', '點草稿連結')
    page.wait_for_function("(s) => document.querySelector('#ops-store').value === s && document.querySelector('#ops-auditor').value === '草稿人'", arg=s0, timeout=5000)
    check(page.locator('#ops-month').input_value() == '2026-01', '草稿連結切到該店月並還原稽核人員')
    check(page.locator('#ops-s-pass').inner_text() == '1' and page.locator('.ops-item[data-item="c0g0i0"] .ops-tbtn.sel').count() == 1, '草稿內容還原（1 合格、追蹤中）')
    # 回到目標店月
    select(page, '#ops-store', store, '營運填寫店別下拉')
    select(page, '#ops-month', month, '營運填寫月份下拉')
    key = '%s_%s' % (store, month)
    existed = key in mock.ops_records
    check(page.locator('[data-keep="audit-ops"] .field-hint', has_text='修改模式').first.is_visible() == existed, '已送出過才顯示「修改模式」提示（%s）' % existed)
    items = page.locator('#ops-list .ops-item').count()
    check(items == OPS_TOTAL, '清單 19 項')
    # 先清成空白：點掉已載入的判定
    if existed:
        for d in [x for x in mock.ops_details if x['record_key'] == key]:
            if d['verdict'] in ('合格', '未完成'):
                page.click('.ops-item[data-item="%s"] .ops-vbtn[data-verdict="%s"]' % (d['item_id'], d['verdict']))  # 再點一次＝取消
            if d['track']:
                page.click('.ops-item[data-item="%s"] .ops-tbtn' % d['item_id'])
            if d['note']:
                page.fill('.ops-item[data-item="%s"] .ops-note' % d['item_id'], '')  # 說明欄不隨判定清空（合格也可留說明），要自己清
        check(page.locator('#ops-s-pending').inner_text() == '19', '已送出的紀錄逐項取消後全部回到未檢查')
    # 稽核人員沒填 → 只回這一條
    page.fill('#ops-auditor', '')
    cm.click(page, '#ops-submit', '送出（稽核人員擋下）')
    check(page.locator('#ops-message').inner_text() == '請填稽核人員。', '稽核人員必填')
    auditor = RNG.choice(['王會計', '測試稽核員'])
    page.fill('#ops-auditor', auditor)
    # 隨機核定（分層：讓未完成 2–6、未檢查 0–2）
    n_fail = RNG.randint(2, 6)
    n_pending = RNG.randint(0, 2)
    verdicts = ['未完成'] * n_fail + ['未檢查'] * n_pending + ['合格'] * (OPS_TOTAL - n_fail - n_pending)
    RNG.shuffle(verdicts)
    entries = []
    for it, v in zip(OPS_FLAT, verdicts):
        sel = '.ops-item[data-item="%s"]' % it['id']
        track = RNG.random() < (0.7 if v == '未完成' else 0.15)
        note = RNG.choice(['出口燈一盞不亮', '壓力表紅區', '未簽名']) if v == '未完成' else ''
        if v != '未檢查':
            cm.click(page, sel + ' .ops-vbtn[data-verdict="%s"]' % v, '核定 %s' % v)
        if track:
            cm.click(page, sel + ' .ops-tbtn', '標記追蹤')
        if note:
            page.fill(sel + ' .ops-note', note)
        entries.append({'item_id': it['id'], 'cat': it['cat'], 'group': it['group'], 'text': it['text'], 'verdict': v, 'track': track, 'note': note})
    c = ops_counts(entries)
    exp_stats = [str(c['total']), str(c['pass']), str(c['fail']), str(c['track']), str(c['pending']), '%d%%' % c['pass_rate']]
    # 系統問題探針：點「追蹤」後統計列的「追蹤 N」應即時更新（onTrackClick 只 renderList 沒 renderStats）
    probe = next(e for e in entries if e['verdict'] == '合格' and not e['track'])
    page.click('.ops-item[data-item="%s"] .ops-tbtn' % probe['item_id'])
    chip_after = texts(page, '[data-keep="audit-ops"] .ops-stats b')[3]
    check(chip_after == str(c['track'] + 1), '系統問題｜點「追蹤」後統計列的追蹤數要即時更新（預期 %d，實際 %s）' % (c['track'] + 1, chip_after))
    page.click('.ops-item[data-item="%s"] .ops-tbtn' % probe['item_id'])
    # 讓統計列重算一次（切判定會重算）再逐欄比對
    some_pass = next(e for e in entries if e['verdict'] == '合格')
    page.click('.ops-item[data-item="%s"] .ops-vbtn[data-verdict="合格"]' % some_pass['item_id'])
    page.click('.ops-item[data-item="%s"] .ops-vbtn[data-verdict="合格"]' % some_pass['item_id'])
    stats = texts(page, '[data-keep="audit-ops"] .ops-stats b')
    check(stats == exp_stats, '即時統計 細項／合格／未完成／追蹤／未檢查／合格率 %s（預期 %s）' % (stats, exp_stats))
    # 再點一次取消＝未檢查、再點回來；追蹤中再點＝取消
    some_pass = next(e for e in entries if e['verdict'] == '合格')
    sel = '.ops-item[data-item="%s"]' % some_pass['item_id']
    page.click(sel + ' .ops-vbtn[data-verdict="合格"]')
    check(page.locator('#ops-s-pending').inner_text() == str(c['pending'] + 1), '再點一次合格→取消回未檢查')
    page.click(sel + ' .ops-vbtn[data-verdict="合格"]')
    tracked = next(e for e in entries if e['track'])
    cm.click(page, '.ops-item[data-item="%s"] .ops-tbtn.sel' % tracked['item_id'], '取消追蹤')
    check(page.locator('.ops-item[data-item="%s"] .ops-tbtn.sel' % tracked['item_id']).count() == 0, '追蹤中再點＝取消')
    page.click('.ops-item[data-item="%s"] .ops-tbtn' % tracked['item_id'])
    # 篩選鈕：每個都點，數量照自己的規則算
    def expect_filter(f):
        return sum(1 for e in entries if f == 'all' or (f == 'pass' and e['verdict'] == '合格') or (f == 'fail' and e['verdict'] == '未完成')
                   or (f == 'pending' and e['verdict'] == '未檢查') or (f == 'track' and (e['track'] or e['verdict'] == '未完成')))
    cm.scan(page, 'ops-fill-filled')
    for f, lab in [('pass', '合格'), ('fail', '未完成'), ('track', '追蹤'), ('pending', '未檢查'), ('all', '全部')]:
        cm.click(page, '.ops-filter[data-filter="%s"]' % f, '篩選 %s' % lab)
        shown = page.locator('#ops-list .ops-item').count()
        empty = page.locator('#ops-list .ops-empty').count()
        check(shown == expect_filter(f) and (empty == (1 if shown == 0 else 0)), '篩選「%s」顯示 %d 項（預期 %d）' % (lab, shown, expect_filter(f)))
    # 未完成缺說明 → 擋下並切到未完成篩選
    missing = [e for e in entries if e['verdict'] == '未完成'][:2]
    for e in missing:
        page.fill('.ops-item[data-item="%s"] .ops-note' % e['item_id'], '')
    cm.click(page, '#ops-submit', '送出（缺說明擋下）')
    msg = page.locator('#ops-message').inner_text()
    exp_msg = '有 %d 項判「未完成」但沒填說明：%s' % (len(missing), '、'.join(e['text'] for e in missing))
    check(msg == exp_msg, '未完成缺說明訊息逐字相同：%s' % msg)
    check(page.locator('.ops-filter.sel').get_attribute('data-filter') == 'fail', '缺說明時篩選切到「未完成」')
    for e in missing:
        page.fill('.ops-item[data-item="%s"] .ops-note' % e['item_id'], e['note'])
    shot(page, '11_acct_ops_fill')
    n0 = len(mock.writes)
    cm.click(page, '#ops-submit', '送出營運稽核')
    wait_hash(page, '#/audit-ops/report?store=%s&month=%s' % (store, month))
    w = mock.writes[-1]
    check(len(mock.writes) == n0 + 1 and w['action'] == 'submitOpsAudit', 'submitOpsAudit 送出一次')
    rec = w['record']
    exp_rec = {'record_key': key, 'store': store, 'month': month, 'status': '已稽核', 'audit_date': today_taipei(), 'auditor': auditor,
               'total_count': c['total'], 'pass_count': c['pass'], 'fail_count': c['fail'], 'pending_count': c['pending'],
               'track_count': c['track'], 'pass_rate': c['pass_rate'], 'summary': ops_summary(entries), 'note': ''}
    got_rec = {k: rec.get(k) for k in exp_rec}
    check(got_rec == exp_rec, '營運稽核 record 逐欄相同（合格率 round(%d/19*100)=%d%%、summary 只列未完成）' % (c['pass'], c['pass_rate']) + ('' if got_rec == exp_rec else '\n    got=%s\n    exp=%s' % (got_rec, exp_rec)))
    got_det = [{k: d.get(k) for k in ('item_id', 'cat', 'group', 'text', 'verdict', 'track', 'note')} for d in w['details']]
    check(got_det == entries, '營運稽核 details 19 列逐欄相同' + ('' if got_det == entries else '\n    got=%s\n    exp=%s' % (got_det[:2], entries[:2])))
    check(page.evaluate("(k) => localStorage.getItem('dzy.u.u-acct.ops_draft_' + k)", key) is None, '送出後營運草稿清掉')
    check_ops_report(page, mock, store, month, '剛送出的營運報告')
    shot(page, '12_acct_ops_report_after_submit')


def acct_home_alerts(page, mock):
    """首頁待辦：由模組自己算；本月還沒盤點的店、追蹤清單未完成。"""
    page.wait_for_selector('[data-role="module-card"][data-module="audit-stock"]', timeout=8000)
    page.wait_for_function("""() => ['audit-stock','audit-ops'].every(m => { const l = document.querySelector('[data-role="alert-list"][data-module="' + m + '"]'); return l && !l.textContent.includes('讀取中'); })""", timeout=10000)
    pend = DS.pending_stock_nodes(None, mock.records.values())
    badge = page.locator('[data-role="badge"][data-module="audit-stock"]').inner_text().strip()
    check(badge == (str(len(pend)) if pend else ''), '盤點卡片 badge＝本月未盤點店數 %d（實際「%s」）' % (len(pend), badge))
    rows = alert_rows(page, 'audit-stock')
    exp_rows = ['%s：%d 月還沒盤點' % (DS.name_of[c], CUR_MM) for c in pend]
    check(rows == exp_rows, '盤點待辦列 %s' % rows + ('' if rows == exp_rows else '  預期 %s' % exp_rows))
    tr = DS.ops_track_by_store(None, mock.ops_records.values(), mock.ops_details)
    total = sum(v[1] for v in tr.values())
    badge2 = page.locator('[data-role="badge"][data-module="audit-ops"]').inner_text().strip()
    check(badge2 == (str(total) if total else ''), '營運卡片 badge＝各店最新一次追蹤項總數 %d（實際「%s」）' % (total, badge2))
    rows2 = alert_rows(page, 'audit-ops')
    exp2 = ['%s：追蹤清單還有 %d 項未完成（%d 月稽核）' % (DS.name_of[c], v[1], int(v[0][5:])) for c, v in tr.items() if v[1] > 0]
    check(sorted(rows2) == sorted(exp2), '營運待辦列 %s' % rows2 + ('' if sorted(rows2) == sorted(exp2) else '  預期 %s' % exp2))
    shot(page, '00_acct_home')
    if pend:
        page.locator('[data-role="alert-list"][data-module="audit-stock"] [data-role="alert-row"]').first.click()
        wait_hash(page, '#/audit-stock/fill?store=%s&month=%s' % (pend[0], CUR))
        check(True, '點盤點待辦列 → 該店本月的稽核填寫')
        page.wait_for_function("(s) => document.querySelector('#audit-store') && document.querySelector('#audit-store').value === s", arg=pend[0], timeout=8000)
        check(page.locator('#audit-month').input_value() == CUR, '待辦列帶入的店／月正確落在表單')
        go_hash(page, '#/home')
        page.wait_for_selector('[data-role="module-card"]', timeout=8000)


# ============================================================
# 主管／店長／督導
# ============================================================

def run_mgr(browser, mock):
    ctx, page = new_page(browser, mock)
    login(page, BASE, 'mgr')
    enter_module(page, 'audit-stock')
    tabs = view_tabs(page)
    check(tabs == ['總覽', '報告', '異常分析'], '主管（audit.read）盤點分頁 %s' % tabs)
    page.wait_for_selector('[data-keep="audit-stock"] table.overview-grid tbody tr', timeout=8000)
    check(page.locator('#btn-start-audit').count() == 0 and page.locator('#btn-mark-rest').count() == 0, '主管看不到開始稽核／標記輪休')
    got = grid_rows(page, 'audit-stock')
    check(got == expected_stock_grid(mock), '主管總覽格子全對（全店）')
    go_hash(page, '#/audit-stock/fill')
    page.wait_for_function("() => location.hash === '#/home'", timeout=5000)
    check(True, '主管改網址闖稽核填寫 → 彈回首頁')
    go_hash(page, '#/audit-stock/stores')
    page.wait_for_function("() => location.hash === '#/home'", timeout=5000)
    check(True, '主管改網址闖門市管理 → 彈回首頁')
    go_hash(page, '#/audit-ops/overview')
    tabs2 = view_tabs(page)
    check(tabs2 == ['總覽', '報告'], '主管營運稽核分頁 %s' % tabs2)
    page.wait_for_selector('[data-keep="audit-ops"] table.overview-grid tbody tr', timeout=8000)
    check(page.locator('#btn-start-ops').count() == 0, '主管看不到營運「開始稽核」')
    shot(page, '13_mgr_ops_overview')
    ctx.close()


def check_my_stock(page, mock, code, label):
    page.wait_for_selector('[data-keep="audit-stock"] #my-history-body tr', timeout=8000)
    check(page.locator('[data-keep="audit-stock"] #my-store-label').inner_text() == '目前門市：' + mock.ds.name_of[code], '%s：目前門市標示' % label)
    recs = [r for r in mock.records.values() if r['store'] == code]
    latest = max(recs, key=lambda r: r['month']) if recs else None
    rate_txt = page.locator('[data-keep="audit-stock"] #my-rate').inner_text().replace('　', ' ').strip()
    if not latest:
        check(rate_txt == '尚無稽核紀錄', '%s：沒有紀錄顯示尚無稽核紀錄' % label)
    elif latest['status'] == '輪休':
        check(rate_txt == '%s 本月輪休' % latest['month'], '%s：最新一筆輪休 → 本月輪休' % label)
    else:
        check(rate_txt == '%s %d%%' % (latest['month'], latest['correct_rate']), '%s：本月合格率＝最新一筆 %s %d%%（實際「%s」）' % (label, latest['month'], latest['correct_rate'], rate_txt))
        anoms = [d for d in mock.details if d['record_key'] == latest['record_key'] and d['verdict'] == '異常']
        issues = texts(page, '[data-keep="audit-stock"] #my-issues-list li .audit-item-name')
        check(issues == [d['item'] for d in anoms] if anoms else page.locator('[data-keep="audit-stock"] #my-issues-list li').inner_text() == '本次稽核全部正確，沒有被抓到的問題', '%s：被抓到的問題＝最新一筆異常品項 %s' % (label, issues))
        track = texts(page, '[data-keep="audit-stock"] #my-track-list li .audit-item-name')
        check(track == [d['item'] for d in anoms] if anoms else '沒有需要追蹤的品項' in page.locator('[data-keep="audit-stock"] #my-track-list').inner_text(), '%s：追蹤清單＝同一份異常清單' % label)
    hist = page.evaluate("() => [...document.querySelectorAll('[data-keep=\"audit-stock\"] #my-history-body tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))")
    exp = []
    for r in sorted(recs, key=lambda r: r['month'], reverse=True):
        if r['status'] == '輪休':
            exp.append([r['month'], '輪休', '—', '本月輪休'])
        else:
            anoms = [d['item'] for d in mock.details if d['record_key'] == r['record_key'] and d['verdict'] == '異常']
            exp.append([r['month'], '已稽核', '%d%%' % r['correct_rate'], '、'.join(anoms) if anoms else '全部正確'])
    if not recs:
        exp = [['尚無稽核紀錄']]
    check(hist == exp, '%s：歷史紀錄 %d 列逐欄相同（新到舊）' % (label, len(exp)) + ('' if hist == exp else '\n    got=%s\n    exp=%s' % (hist, exp)))


def check_my_ops(page, mock, code, label):
    page.wait_for_selector('[data-keep="audit-ops"] #my-history-body tr', timeout=8000)
    recs = [r for r in mock.ops_records.values() if r['store'] == code]
    latest = max(recs, key=lambda r: r['month']) if recs else None
    rate_txt = page.locator('[data-keep="audit-ops"] #my-rate').inner_text().replace('　', ' ').strip()
    if not latest:
        check(rate_txt == '尚無稽核紀錄', '%s：營運沒有紀錄' % label)
    else:
        check(rate_txt == '%s %d%%' % (latest['month'], latest['pass_rate']), '%s：營運本月合格率＝最新一筆（實際「%s」）' % (label, rate_txt))
        dets = [d for d in mock.ops_details if d['record_key'] == latest['record_key']]
        fails = [d['text'] for d in dets if d['verdict'] == '未完成']
        tracked = [d['text'] for d in dets if d['track'] is True]
        got_f = texts(page, '[data-keep="audit-ops"] #my-issues-list li .audit-item-name')
        got_t = texts(page, '[data-keep="audit-ops"] #my-track-list li .audit-item-name')
        check(got_f == fails, '%s：被抓到的問題＝未完成 %d 項' % (label, len(fails)) + ('' if got_f == fails else '\n    got=%s\n    exp=%s' % (got_f, fails)))
        check(got_t == tracked, '%s：追蹤清單＝track 旗標 %d 項（不限未完成）' % (label, len(tracked)) + ('' if got_t == tracked else '\n    got=%s\n    exp=%s' % (got_t, tracked)))
    hist = page.evaluate("() => [...document.querySelectorAll('[data-keep=\"audit-ops\"] #my-history-body tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))")
    exp = []
    for r in sorted(recs, key=lambda r: r['month'], reverse=True):
        fails = [d['text'] for d in mock.ops_details if d['record_key'] == r['record_key'] and d['verdict'] == '未完成']
        exp.append([r['month'], '已稽核', '%d%%' % r['pass_rate'], '、'.join(fails) if fails else '全部合格'])
    if not recs:
        exp = [['尚無稽核紀錄']]
    check(hist == exp, '%s：營運歷史紀錄 %d 列逐欄相同' % (label, len(exp)) + ('' if hist == exp else '\n    got=%s\n    exp=%s' % (hist, exp)))


def run_lead(browser, mock):
    ctx, page = new_page(browser, mock, width=375)
    login(page, BASE, 'lead')
    code = DS.lead_store
    page.wait_for_selector('[data-role="module-card"]', timeout=8000)
    ids = [c.get_attribute('data-module') for c in page.locator('[data-role="module-card"]').all()]
    check('audit-stock' in ids and 'audit-ops' in ids and 'users' not in ids, '店長首頁有兩張稽核卡片、沒有人員管理：%s' % ids)
    page.wait_for_function("""() => { const l = document.querySelector('[data-role="alert-list"][data-module="audit-stock"]'); return l && !l.textContent.includes('讀取中'); }""", timeout=10000)
    pend = DS.pending_stock_nodes([code], mock.records.values())
    rows = alert_rows(page, 'audit-stock')
    check(rows == ['%s：%d 月還沒盤點' % (DS.name_of[code], CUR_MM)] if pend else rows == [], '店長盤點待辦只算自己店：%s' % rows)
    enter_module(page, 'audit-stock')
    tabs = view_tabs(page)
    check(tabs == ['我的門市'], '店長只有「我的門市」：%s' % tabs)
    check_my_stock(page, mock, code, '店長我的門市')
    check(page.evaluate("() => document.querySelectorAll('[data-keep=\"audit-stock\"] button, [data-keep=\"audit-stock\"] input, [data-keep=\"audit-stock\"] select, [data-keep=\"audit-stock\"] textarea, [data-keep=\"audit-stock\"] a').length") == 0, '店長我的門市零控制項（唯讀）')
    content = page.locator('[data-keep="audit-stock"]').inner_text()
    other_names = [s['name'] for s in mock.all_stores if s['code'] != code]
    check(all(nm not in content for nm in other_names), '畫面上沒有其他店名')
    shot(page, '14_lead_my_stock_375')
    go_hash(page, '#/audit-stock/overview')
    page.wait_for_function("() => location.hash === '#/home'", timeout=5000)
    check(True, '店長改網址闖總覽 → 彈回首頁')
    filtered = page.evaluate("""async () => {
        const api = await import('./platform/api.js');
        const res = await api.call('audit', 'getAll', {});
        if (!res.ok) return 'call failed: ' + res.error;
        const st = (rows) => [...new Set((rows || []).map(r => r.store))];
        return {records: st(res.data.records), details: st(res.data.details), items: st(res.data.items), ops_records: st(res.data.ops_records),
                ops_details: st(res.data.ops_details), cfg: (res.data.config.stores || []).map(s => s.code), all_stores: 'all_stores' in res.data.config,
                n_records: res.data.records.length, n_details: res.data.details.length, n_ops: res.data.ops_records.length};
    }""")
    exp_n = len([r for r in mock.records.values() if r['store'] == code])
    check(isinstance(filtered, dict) and all(filtered[k] in ([code], []) for k in ('records', 'details', 'items', 'ops_records', 'ops_details'))
          and filtered['cfg'] == [code] and not filtered['all_stores'] and filtered['n_records'] == exp_n
          and filtered['n_details'] == len([d for d in mock.details if d['store'] == code]) and filtered['n_ops'] == len([r for r in mock.ops_records.values() if r['store'] == code]),
          '資料層：五陣列只剩自己店、config.stores 只剩自己店、all_stores 被刪、筆數＝自己店筆數 %s' % filtered)
    go_hash(page, '#/audit-ops/my')
    check_my_ops(page, mock, code, '店長營運我的門市')
    shot(page, '15_lead_my_ops_375')
    ctx.close()


def run_sup(browser, mock, who, scope, label):
    ctx, page = new_page(browser, mock)
    login(page, BASE, who)
    enter_module(page, 'audit-stock')
    tabs = view_tabs(page)
    check(tabs == ['總覽', '報告', '異常分析'], '%s：分頁 %s（沒有填寫／我的門市／門市管理）' % (label, tabs))
    if not scope:
        page.wait_for_selector('[data-keep="audit-stock"] .card-title:has-text("目前沒有負責的門市")', timeout=8000)
        check(page.locator('[data-keep="audit-stock"] table.overview-grid').count() == 0, '%s：沒劃區 → 顯示「目前沒有負責的門市」、沒有表格' % label)
        click_tab(page, '異常分析', '分頁→異常分析')
        page.wait_for_selector('[data-keep="audit-stock"] .card-title:has-text("目前沒有負責的門市")', timeout=8000)
        check(page.locator('#an-stores').count() == 0, '%s：異常分析也是空狀態' % label)
        shot(page, '18_sup_none')
        ctx.close()
        return
    page.wait_for_selector('[data-keep="audit-stock"] table.overview-grid tbody tr', timeout=8000)
    got = grid_rows(page, 'audit-stock')
    exp = expected_stock_grid(mock, scope)
    check(got == exp, '%s：總覽只列範圍內 %d 店、格子全對' % (label, len(exp)) + ('' if got == exp else '\n    got=%s\n    exp=%s' % (got, exp)))
    check(page.locator('#btn-start-audit').count() == 0, '%s：沒有開始稽核鈕' % label)
    content = page.locator('[data-keep="audit-stock"]').inner_text()
    outside = [s['name'] for s in mock.all_stores if s['code'] not in scope]
    check(all(nm not in content for nm in outside), '%s：畫面沒有範圍外店名 %s' % (label, outside))
    click_tab(page, '異常分析', '分頁→異常分析')
    page.wait_for_selector('#an-stores table, #an-stores .an-empty', timeout=8000)
    rep, reasons, stores = DS.analysis(None, None, scope, mock.records.values(), mock.details, active_stores(mock))
    got_st = page.evaluate("() => [...document.querySelectorAll('#an-stores tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))")
    exp_st = [[s['name'], str(s['anomalies']), str(s['audits']), '%s%%' % s['rate']] for s in stores]
    check(got_st == exp_st, '%s：各店異常數只算範圍內' % label + ('' if got_st == exp_st else '\n    got=%s\n    exp=%s' % (got_st, exp_st)))
    got_rep = texts(page, '#an-repeat tbody tr td:first-child')
    check(got_rep == [r['item'] for r in rep], '%s：累犯品項只算範圍內 %d 項' % (label, len(rep)))
    go_hash(page, '#/audit-ops/overview')
    page.wait_for_selector('[data-keep="audit-ops"] table.overview-grid tbody tr', timeout=8000)
    got2 = grid_rows(page, 'audit-ops')
    exp2 = expected_ops_grid(mock, scope)
    check(got2 == exp2, '%s：營運總覽只列範圍內店' % label)
    data_stores = page.evaluate("""async () => { const api = await import('./platform/api.js'); const r = await api.call('audit','getAll',{});
        return [...new Set(r.data.records.map(x => x.store))].sort(); }""")
    check(data_stores == sorted({r['store'] for r in mock.records.values() if r['store'] in scope}), '%s：資料層 records 只剩範圍內店 %s' % (label, data_stores))
    shot(page, '16_%s' % who)
    ctx.close()


def run_dryrun(browser, mock):
    ctx, page = new_page(browser, mock)
    page.goto(BASE + '/index.html?dryrun=1')
    page.fill('#login-username', 'acct')
    page.fill('#login-password', USERS['acct']['password'])
    page.click('[data-role="submit"]')
    page.wait_for_selector('[data-role="view-content"]', state='attached', timeout=10000)
    page.wait_for_selector('[data-role="module-card"][data-module="audit-stock"]', timeout=10000)
    go_hash(page, '#/audit-stock/stores')
    page.wait_for_selector('#store-add-btn', timeout=8000)
    n0 = len(mock.writes)
    p0 = len(getattr(mock, 'proxy_calls', []))
    page.fill('#store-new-name', '試跑門市')
    page.click('#store-add-btn')
    page.click('.dialog .btn-primary')
    page.wait_for_selector('.toast, [class*="toast"]', timeout=8000)
    time.sleep(0.5)
    writes_after = [c for c in getattr(mock, 'proxy_calls', [])[p0:] if c[1] != 'getAll']
    check(len(mock.writes) == n0 and not writes_after, '試跑模式：門市新增沒有送到後端（寫入代轉 %s）' % writes_after)
    check('試跑' in page.locator('body').inner_text(), '試跑模式有提示「試跑」')
    go_hash(page, '#/audit-ops/fill')
    page.wait_for_selector('#ops-submit', timeout=8000)
    page.fill('#ops-auditor', '試跑人')
    page.click('#ops-submit')
    time.sleep(0.8)
    writes_after = [c for c in getattr(mock, 'proxy_calls', [])[p0:] if c[1] != 'getAll']
    check(len(mock.writes) == n0 and not writes_after, '試跑模式：營運稽核送出沒有到後端')
    # 盤點稽核填寫在試跑模式：寫入被攔是對的，但畫面不該宣告「已送出」、草稿不該被清掉（會計以為送成功、內容卻沒了）
    go_hash(page, '#/audit-stock/fill')
    page.wait_for_selector('#audit-add-btn', timeout=8000)
    page.wait_for_function("() => document.querySelectorAll('#audit-store option').length > 0", timeout=8000)
    store = page.locator('#audit-store').input_value()
    month = page.locator('#audit-month').input_value()
    page.click('.audit-mode-btn[data-mode="anomaly"]')
    page.fill('#audit-add-input', '試跑品項')
    page.fill('#audit-add-unit', '包')
    page.click('#audit-add-btn')
    li = '#audit-items li[data-item="試跑品項"]'
    page.fill(li + ' .audit-book-qty', '1')
    page.fill(li + ' .audit-recount-qty', '2')
    page.select_option(li + ' .audit-reason', DS.reasons[0] if DS.reasons[0] != '其他' else DS.reasons[1])
    page.click('[data-group="change_fund"][data-value="正確"]')
    page.click('[data-group="petty_cash"][data-value="正確"]')
    page.fill('#audit-tip-amount', '0')
    page.click('[data-group="tip_match"][data-value="相符"]')
    key = 'dzy.u.u-acct.draft_%s_%s_anomaly' % (store, month)
    check(page.evaluate("(k) => localStorage.getItem(k) !== null", key), '試跑：送出前草稿存在')
    page.click('#audit-submit-btn')
    if page.locator('.dialog .btn-primary').count():
        page.click('.dialog .btn-primary')
    time.sleep(1.0)
    writes_after = [c for c in getattr(mock, 'proxy_calls', [])[p0:] if c[1] != 'getAll']
    check(len(mock.writes) == n0 and not writes_after, '試跑模式：盤點稽核送出沒有到後端')
    body = page.locator('body').inner_text()
    check(page.evaluate("(k) => localStorage.getItem(k) !== null", key), '系統問題｜試跑模式送出盤點稽核後，草稿不該被清掉（實際：%s）' % ('還在' if page.evaluate("(k) => localStorage.getItem(k) !== null", key) else '被清掉了'))
    check('試跑' in body or '未寫入' in body, '系統問題｜試跑模式送出盤點稽核後，畫面要提示「試跑／未寫入」而不是「稽核已送出」（畫面含：%s）' % ('稽核已送出' if '稽核已送出' in body else body[:80].replace('\n', ' ')))
    shot(page, '17_dryrun')
    ctx.close()


# ============================================================
# 主流程
# ============================================================

BASE = None


def main():
    global BASE
    httpd, base = start_server(PORT)
    BASE = base
    mock = MgmtMock(base, DS)
    print('門市 %d 家（啟用 %d）、紀錄 %d 筆、明細 %d 列、營運紀錄 %d 筆、店長店 %s、督導區 %s、本月 %s' % (
        len(DS.all_stores), len(DS.stores), len(DS.records), len(DS.details), len(DS.ops_records), DS.lead_store, DS.region_scope, CUR))
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            # 會計
            ctx, page = new_page(browser, mock)
            login(page, base, 'acct')
            acct_home_alerts(page, mock)
            acct_stock(page, mock)
            acct_stock_fill(page, mock)
            acct_mark_rest(page, mock)
            acct_stores(page, mock)
            acct_ops(page, mock)
            acct_ops_fill(page, mock)
            # 分頁都點過一次（報告／稽核填寫／總覽 已點；補點營運三個與盤點報告）
            for t in ['報告', '總覽', '稽核填寫']:
                click_tab(page, t, '分頁→' + t)
            go_hash(page, '#/audit-stock/report')
            for t in ['總覽', '報告', '異常分析', '稽核填寫', '門市管理']:
                click_tab(page, t, '分頁→' + t)
            ctx.close()
            # 其他角色
            run_mgr(browser, mock)
            run_lead(browser, mock)
            run_sup(browser, mock, 'sup_on', DS.region_scope, '督導（REGIONS 開）')
            run_sup(browser, mock, 'sup_off', DS.store_codes, '督導（REGIONS 關＝全品牌）')
            run_sup(browser, mock, 'sup_none', [], '督導（沒劃區）')
            run_dryrun(browser, mock)
            browser.close()
    finally:
        httpd.shutdown()

    # ---- 守門 ----
    check(not external_hits, '外網零流出（^https?://(?!127.0.0.1)）：%s' % external_hits[:3])
    check(not mock.leaked, '沒有請求漏出 mock、前端 body 不帶通行碼欄位：%s' % mock.leaked[:3])
    check(all(AUDIT_SECRET not in b for b in raw_bodies), '前端送出的任何 body 都不含通行碼字串')
    check(all(('"code"' not in b and '"pass"' not in b) for b in raw_bodies if '/proxy' in b or 'ns' in b), '代轉 body 沒有 code／pass 欄')
    check(not js_errors, '頁面無 JS 錯誤：%s' % js_errors[:3])
    rep = cm.report()
    check(not rep['missed'], '按鈕稽核：看過 %d、點過 %d、漏點 %s' % (rep['total'], rep['clicked'], rep['missed']))
    print('\nE2E_SEED=%d  共 %d 項檢查，通過 %d，失敗 %d' % (SEED, CHECKS[0], CHECKS[0] - len(failures), len(failures)))
    finish()


if __name__ == '__main__':
    main()
