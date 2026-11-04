#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ㉑：AI 小幫手前端（docs/ai-helper/spec.md §2、§8、§12；task T3、T4）。全部假名、全程 mock 後端（零真實資料、不打真的 AI）。

假後端同時模擬 /platform/api（aih* 管理 action）與 /platform/svc/ai-help（status／ask／feedback／draft／usage）。驗：
  ① status on 出現按鈕；off、404、網路失敗都不出現；額度用完（cap）出現但點開只寫「本月額度已用完」
  ② 問答顯示（純文字：答案含 <img onerror> 不執行）；ask 帶 rid／conv、不帶 alerts／history
  ③ 帶我去：有權限才有按鈕、能切頁；沒權限的不畫
  ④ 👎 打 feedback（後端記進待回答）
  ⑤ 管理頁：待回答 AI 擬答 → 上架 → 待回答消失 → 再問答得出；略過；知識庫搜尋／編輯／下架／歷史回到舊版本
  ⑥ 暫停按鈕、初始化按鈕、匯入初始知識庫；試跑模式寫入鈕鎖住
  ⑦ 375 寬與 320 寬無橫向捲軸、側欄全螢幕
  ⑧ 用量頁「問答紀錄」：新的在前、頁面名稱對照、結果與 👎、問題純文字（含 <img onerror> 不執行）、看全文、再顯示更多、換月份重讀
截圖（1280 與 375 側欄打開、用量頁問答紀錄 1280 與 375）存到 AIH_SHOT_DIR（沒給就用暫存資料夾，不動 repo 裡的 shots）。
"""
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8860   # 8861 保留給需要另開假後端程序時用；這支的假後端是 Playwright 攔截，不佔埠
EVIL = '<img src=x onerror="window.__pwned=1"> javascript:alert(1)'
PAGES = {('me', 'profile'), ('me', 'unit'), ('users', 'list'), ('ai-help', 'pending')}


class Mock21(MockBackend):
    """MockBackend＋小幫手：有狀態的知識庫、待回答、問答紀錄。"""

    def __init__(self, base):
        super().__init__(base)
        self.aih_mode = 'on'          # on／off／cap
        self.inited = True
        self.paused = False
        self.left = 20
        self.kb = [{'id': 'kb0001', 'm': '', 'v': '', 'question': '怎麼改密碼', 'answer': '到右上角「改密碼」。', 'who': '', 'go_m': 'me', 'go_v': 'profile',
                    'status': 'live', 'source': '員工手冊', 'verified_at': '2026-11-01', 'expires_at': '2027-04-30', 'updated_at': '2026-11-01T00:00:00.000Z', 'updated_by': 'admin'}]
        self.hist = [{'hist_id': 'kh0001', 'kb_id': 'kb0001', 'action': 'create', 'snapshot': dict(self.kb[0], answer='舊版：打電話給資訊部。'), 'by': 'admin', 'at': '2026-10-30T00:00:00.000Z'},
                     {'hist_id': 'kh0002', 'kb_id': 'kb0001', 'action': 'publish', 'snapshot': dict(self.kb[0]), 'by': 'admin', 'at': '2026-11-01T00:00:00.000Z'}]
        self.pending = [{'id': 'aip_20261101100000_0001', 'log_id': 'aih_x', 'ts': '2026-11-01T10:00:00.000Z', 'q': '薪酬管理要找誰開權限', 'm': 'users', 'v': 'list', 'reason': 'unknown', 'status': 'open', 'kb_id': ''}]
        self.logs = {}
        self.aih_calls = []
        self.aih_bodies = []
        self.n = 0
        self.kbn = 1
        self.ask_extra_go = True
        self.evil = False

    # ---- svc /platform/svc/ai-help ----
    def uid_of(self, body):
        tok = (body.get('token') or '').replace('e2e-token-', '')
        return tok if tok in USERS else None

    def aih_dispatch(self, body):
        op = body.get('op')
        self.aih_calls.append(op)
        self.aih_bodies.append(body)
        uid = self.uid_of(body)
        if not uid:
            return {'ok': False, 'code': 'unauthorized', 'error': 'x'}
        if op == 'status':
            if self.aih_mode == 'off':
                return {'ok': True, 'data': {'on': False, 'reason': 'off', 'left_today': 0}}
            if self.aih_mode == 'cap':
                return {'ok': True, 'data': {'on': False, 'reason': 'cap', 'left_today': self.left}}
            return {'ok': True, 'data': {'on': True, 'reason': '', 'left_today': self.left}}
        if op == 'ask':
            q = body.get('q', '')
            if self.paused:
                return {'ok': False, 'code': 'ai_error', 'error': 'paused'}
            if self.left <= 0:
                return {'ok': False, 'code': 'rate_person', 'error': 'x'}
            self.left -= 1
            self.n += 1
            lid = 'aih_20261102090%03d_ab%02d' % (self.n, self.n)
            hit = next((k for k in self.kb if k['status'] == 'live' and k['question'] == q), None)
            if self.evil:
                data = {'id': lid, 'kind': 'answered', 'answer': EVIL, 'who': EVIL,
                        'go': [{'m': 'me', 'v': 'profile', 'label': EVIL}]}
            elif hit:
                data = {'id': lid, 'kind': 'answered', 'answer': hit['answer'], 'who': hit['who'],
                        'go': [{'m': hit['go_m'], 'v': hit['go_v'], 'label': '去看看'}] if hit['go_m'] else []}
                if self.ask_extra_go:   # 後端多給一個一般同仁沒權限的頁面：前端要自己再擋一次
                    data['go'].append({'m': 'users', 'v': 'list', 'label': '人員清單'})
            else:
                data = {'id': lid, 'kind': 'unknown', 'answer': '這題我還不會，已經記下來了', 'who': '資訊部', 'go': []}
                self.pending.append({'id': 'aip_20261102090%03d_%04x' % (self.n, self.n), 'log_id': lid, 'ts': '2026-11-02T09:00:00.000Z', 'q': q,
                                     'm': body['page']['m'], 'v': body['page']['v'], 'reason': 'unknown', 'status': 'open', 'kb_id': ''})
            self.logs[lid] = {'uid': uid, 'q': q, 'page': body['page'], 'kind': data['kind'], 'feedback': ''}
            return {'ok': True, 'data': data}
        if op == 'feedback':
            lg = self.logs.get(body.get('id'))
            if not lg or lg['uid'] != uid:
                return {'ok': False, 'code': 'forbidden', 'error': 'x'}
            lg['feedback'] = 'up' if body.get('good') else 'down'
            if not body.get('good'):
                self.n += 1
                self.pending.append({'id': 'aip_20261102091%03d_%04x' % (self.n, self.n), 'log_id': body['id'], 'ts': '2026-11-02T09:05:00.000Z', 'q': lg['q'],
                                     'm': lg['page']['m'], 'v': lg['page']['v'], 'reason': 'thumbs_down', 'status': 'open', 'kb_id': ''})
            return {'ok': True, 'data': {'noted': not body.get('good')}}
        if op in ('draft', 'usage'):
            if '*' not in USERS[uid]['perms']:
                return {'ok': False, 'code': 'forbidden', 'error': 'x'}
            if op == 'usage':
                return {'ok': True, 'data': {'month': '2026-11', 'usd': 1.234, 'cap_usd': 28}}
            p = next((x for x in self.pending if x['id'] == body.get('pending_id')), None)
            if not p:
                return {'ok': False, 'code': 'bad_input', 'error': 'x'}
            return {'ok': True, 'data': {'question': p['q'], 'answer': 'AI 擬答：請找人資開權限。', 'who': '人資', 'm': p['m'], 'v': p['v']}}
        return {'ok': False, 'code': 'bad_input', 'error': 'x'}

    # ---- 問答紀錄（假資料 60 題，11 月；10 月 1 題）----
    LOG_QS = ['怎麼改密碼', '加班要找誰核', '年終獎金怎麼算', '<img src=x onerror="window.__xss=1">這是什麼', '請假單送出後在哪裡看', '盤點抽查怎麼填']

    def fake_logs(self):
        if getattr(self, '_logs', None) is None:
            pages = [('me', 'profile'), ('approvals', 'mine'), ('', ''), ('ai-help', 'usage'), ('approvals', 'submit'), ('audit-stock', 'fill')]
            out = []
            for i in range(60):
                day, minute = 2 - (i // 40), 59 - (i % 40)
                m, v = pages[i % len(pages)]
                kind = 'unknown' if i % 5 == 2 else 'answered'
                ans = '這題我還不會' if kind == 'unknown' else ('到「我的資料」按「修改密碼」。' + '先輸入舊密碼，再輸入兩次新密碼，最後按儲存；忘記舊密碼請用 LINE 重設。' * (3 if i == 0 else 1))
                out.append({'id': 'aih_202611%02d10%02d00_%04x' % (day, minute, i), 'ts': '2026-11-%02dT02:%02d:00.000Z' % (day, minute), 'm': m, 'v': v,
                            'q': self.LOG_QS[i % len(self.LOG_QS)] + ('' if i < 6 else '（第 %d 題）' % (i + 1)), 'kind': kind, 'answer': ans,
                            'kb_ids': 'kb0001' if kind == 'answered' else '', 'feedback': 'down' if i in (1, 7) else ('up' if i == 4 else '')})
            out.append({'id': 'aih_20261015100000_aaaa', 'ts': '2026-10-15T02:00:00.000Z', 'm': '', 'v': '', 'q': '十月的問題', 'kind': 'answered', 'answer': '十月', 'kb_ids': '', 'feedback': ''})
            self._logs = out
        return self._logs

    def log_list(self, p):
        # 瀏覽器帶的是真實本月：第一次問的月份＝11 月那 60 題，其他月份＝10 月那 1 題（不寫死今天）
        month = p.get('month') or ''
        if getattr(self, 'log_month', None) is None:
            self.log_month = month
        want = '2026-11' if month == self.log_month else '2026-10'
        rows = [x for x in self.fake_logs() if x['ts'][:7] == want]
        rows.sort(key=lambda x: (x['ts'], x['id']), reverse=True)
        total = len(rows)
        if p.get('before'):
            ms, _, bid = p['before'].partition(':')
            idx = next((i for i, x in enumerate(rows) if x['id'] == bid), None)
            rows = rows[idx + 1:] if idx is not None else []
        lim = int(p.get('limit') or 50)
        page = rows[:lim]
        nxt = ('0:' + page[-1]['id']) if len(rows) > lim else ''
        return {'ok': True, 'data': {'month': month, 'total': total, 'items': page, 'next': nxt}}

    # ---- 平台 aih* action ----
    def platform_action(self, action, body):
        if not action.startswith('aih'):
            return super().platform_action(action, body)
        self.admin_calls = getattr(self, 'admin_calls', []) + [(action, body.get('payload') or {})]
        uid = self.uid_of(body)
        if not uid or '*' not in USERS[uid]['perms']:
            return {'ok': False, 'error': 'forbidden', 'message': '沒有權限'}
        p = body.get('payload') or {}
        if action == 'aihSetup':
            self.inited = True
            return {'ok': True, 'data': {'created': ['aih_kb'], 'existed': []}}
        if not self.inited:
            return {'ok': False, 'error': 'not_inited', 'message': 'AI 小幫手還沒初始化'}
        if action == 'aihUsage':
            return {'ok': True, 'data': {'month': p.get('month') or '2026-11', 'count': 12, 'answered_ratio': 0.75, 'down_ratio': 0.0833,
                                         'by_day': [{'day': '2026-11-01', 'count': 5}, {'day': '2026-11-02', 'count': 7}], 'paused': self.paused}}
        if action == 'aihLogList':
            return self.log_list(p)
        if action == 'aihPauseSet':
            self.paused = bool(p.get('paused'))
            return {'ok': True, 'data': {'paused': self.paused, 'changed': True}}
        if action == 'aihPendingList':
            items = [dict(x, count=1) for x in self.pending if not p.get('status') or x['status'] == p['status']]
            items.reverse()
            return {'ok': True, 'data': {'items': items, 'open_count': len([x for x in self.pending if x['status'] == 'open'])}}
        if action == 'aihPendingSet':
            x = next((y for y in self.pending if y['id'] == p.get('id')), None)
            if not x:
                return {'ok': False, 'error': 'not_found', 'message': '找不到這一筆待回答'}
            if p['status'] == 'done' and not any(k['id'] == p.get('kb_id') and k['status'] == 'live' for k in self.kb):
                return {'ok': False, 'error': 'bad_request', 'message': '請先上架這一題，再標成已處理'}
            x['status'] = p['status']
            x['kb_id'] = p.get('kb_id', '') if p['status'] == 'done' else ''
            return {'ok': True, 'data': {'id': x['id'], 'status': x['status'], 'kb_id': x['kb_id']}}
        if action == 'aihKbList':
            q = (p.get('q') or '').lower()
            items = [k for k in self.kb if (not p.get('status') or k['status'] == p['status']) and (not q or q in (k['question'] + k['answer'] + k['who']).lower())]
            return {'ok': True, 'data': {'items': items, 'paused': self.paused}}
        if action == 'aihKbHist':
            items = [h for h in self.hist if h['kb_id'] == p.get('kb_id')]
            return {'ok': True, 'data': {'items': list(reversed(items))}}
        if action == 'aihKbSave':
            k = next((y for y in self.kb if y['id'] == p.get('id')), None) if p.get('id') else None
            if p.get('id') and not k:
                return {'ok': False, 'error': 'not_found', 'message': '找不到這一題'}
            if k and p.get('expected_updated_at') not in (None, k['updated_at']):
                return {'ok': False, 'error': 'conflict', 'message': '這一題已經被別人改過，請重新整理再改'}
            self.n += 1
            new = dict(k) if k else {'id': 'kb%04d' % (self.kbn + 1), 'm': '', 'v': '', 'who': '', 'go_m': '', 'go_v': '', 'source': '', 'status': 'draft',
                                     'verified_at': '2026-11-02', 'expires_at': '2027-05-01'}
            if not k:
                self.kbn += 1
            for f in ('m', 'v', 'question', 'answer', 'who', 'go_m', 'go_v', 'status', 'source', 'verified_at'):
                if f in p:
                    new[f] = p[f]
            new['updated_at'] = '2026-11-02T09:%02d:00.000Z' % (self.n % 60)
            new['updated_by'] = 'admin'
            act = 'create' if not k else ('publish' if new['status'] == 'live' and k['status'] != 'live' else ('unpublish' if new['status'] == 'off' else 'update'))
            if k:
                self.kb[self.kb.index(k)] = new
            else:
                self.kb.append(new)
            self.hist.append({'hist_id': 'kh%04d' % (len(self.hist) + 1), 'kb_id': new['id'], 'action': act, 'snapshot': dict(new), 'by': 'admin', 'at': '2026-11-02T09:00:00.000Z'})
            return {'ok': True, 'data': {'id': new['id'], 'updated_at': new['updated_at'], 'changed': True}}
        if action == 'aihKbImport':
            self.imported = getattr(self, 'imported', 0) + 1
            return {'ok': True, 'data': {'added': 3, 'skipped': 1}}
        return {'ok': False, 'error': 'bad_request', 'message': '未知的 action（mock）：' + action}


def main():
    httpd, base = start_server(PORT)
    mock = Mock21(base)
    mk = lambda name, perms: {'password': 'e2e-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
    USERS['staff1'] = mk('同仁甲', ['platform.self'])
    out_dir = os.environ.get('AIH_SHOT_DIR') or tempfile.mkdtemp(prefix='aih-e2e-')
    os.makedirs(out_dir, exist_ok=True)
    guard_hits = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(width=1280, height=900, query='', hook=None):
                ctx = browser.new_context(viewport={'width': width, 'height': height})
                pg = ctx.new_page()

                def guard(route):   # 外網守門：先註冊（優先序最低），mock 的主機路由蓋過它；漏網的就中止並記下來
                    guard_hits.append(route.request.url)
                    route.abort()
                pg.route(re.compile(r'^https?://(?!127\.0\.0\.1)'), guard)
                mock.install(pg)
                if hook:
                    hook(pg)
                pg.goto(base + '/index.html' + query)
                return pg

            def login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def ask(pg, text):
                n = pg.locator('[data-role="aih-msg"][data-from="bot"]').count()
                pg.fill('[data-role="aih-input"]', text)
                pg.click('[data-role="aih-send"]')
                pg.wait_for_function('(n) => document.querySelectorAll(\'[data-role="aih-msg"][data-from="bot"], [data-role="aih-error"]\').length > n && !document.querySelector(\'[data-role="aih-pending"]\')', arg=n, timeout=8000)

            # ====== ① status：on／off／404／網路失敗／cap ======
            mock.aih_mode = 'on'
            pg = new_page()
            login(pg, 'admin')
            pg.wait_for_selector('[data-role="aih-fab"]', timeout=8000)
            check(pg.locator('[data-role="aih-fab"]').inner_text() == '問小幫手', '① status on：右下角出現「問小幫手」按鈕')
            check(mock.aih_calls.count('status') == 1, '① 開頁只打一次 status：%s' % mock.aih_calls)
            box = pg.evaluate("() => { const r = document.querySelector('[data-role=aih-fab]').getBoundingClientRect(); return [innerWidth - r.right, innerHeight - r.bottom]; }")
            check(box[0] < 40 and box[1] < 40, '① 按鈕在右下角（距右下 %s）' % box)
            check(pg.locator('[data-role="aih-panel"]').is_hidden(), '① 側欄預設收起')
            pg.context.close()

            mock.aih_mode = 'off'
            mock.aih_calls.clear()   # 清空前面累積的呼叫，下面「關閉時仍呼叫 status」才是這一頁自己打的
            pg = new_page()
            login(pg, 'admin')
            pg.wait_for_timeout(800)
            check(pg.locator('[data-role="aih-fab"]').count() == 0 and 'status' in mock.aih_calls, '① status on:false → 按鈕不出現（status 有送出）')
            pg.context.close()

            mock.aih_mode = 'on'
            pg = new_page(hook=lambda pg: pg.route(re.compile(r'.*/svc/ai-help$'), lambda r: r.fulfill(status=404, body='not found')))
            login(pg, 'admin')
            pg.wait_for_timeout(800)
            check(pg.locator('[data-role="aih-fab"]').count() == 0, '① status 404（Mac mini 還沒更新）→ 按鈕不出現、首頁照常（%d 張卡）' % pg.locator('[data-role="module-card"]').count())
            pg.context.close()

            pg = new_page(hook=lambda pg: pg.route(re.compile(r'.*/svc/ai-help$'), lambda r: r.abort()))
            login(pg, 'admin')
            pg.wait_for_timeout(800)
            check(pg.locator('[data-role="aih-fab"]').count() == 0, '① status 網路失敗 → 按鈕不出現')
            pg.context.close()

            mock.aih_mode = 'cap'
            pg = new_page()
            login(pg, 'admin')
            pg.wait_for_selector('[data-role="aih-fab"]', timeout=8000)
            pg.click('[data-role="aih-fab"]')
            txt = pg.locator('[data-role="aih-panel"]').inner_text()
            check('本月額度已用完' in txt and pg.locator('[data-role="aih-input"]').is_hidden(), '① reason cap：按鈕出現、點開只寫「本月額度已用完」、沒有輸入框：%s' % txt[:40].replace('\n', ' '))
            pg.context.close()
            mock.aih_mode = 'on'

            # ====== ② 問答 ======
            pg = new_page()
            login(pg, 'staff1')
            pg.wait_for_selector('[data-role="aih-fab"]', timeout=8000)
            pg.click('[data-role="aih-fab"]')
            check(pg.locator('[data-role="aih-panel"]').is_visible(), '② 點按鈕 → 側欄打開')
            check('問題會送交外部 AI（Anthropic）處理，並在系統保存 90 天' in pg.locator('[data-role="aih-note"]').inner_text(), '② 底部說明字')
            check(pg.evaluate("() => document.activeElement && document.activeElement.getAttribute('data-role')") == 'aih-input', '② 開啟後焦點在輸入框（鍵盤可直接打字）')
            ask(pg, '怎麼改密碼')
            ans = pg.locator('[data-role="aih-answer"]').last.inner_text()
            check(ans == '到右上角「改密碼」。', '② 問答顯示答案：%s' % ans)
            ab = mock.aih_bodies[-1]
            check(ab['op'] == 'ask' and ab['q'] == '怎麼改密碼' and re.match(r'^aic_\d{14}_[0-9a-f]{4}$', ab['conv']) and ab['rid'] and 'alerts' not in ab and 'history' not in ab and ab['token'] == 'e2e-token-staff1',
                  '② ask 帶 rid／conv／token，不帶 alerts／history：%s' % {k: v for k, v in ab.items() if k != 'token'})
            check(ab['page'] == {'m': '', 'v': ''}, '② 在首頁問 → page 是空（通用）：%s' % ab['page'])
            ask(pg, '再問一次')
            ab2 = mock.aih_bodies[-1]
            check(ab2['conv'] == ab['conv'] and ab2['rid'] != ab['rid'], '② 同一側欄：conv 不變、rid 每次不同')
            check(pg.locator('[data-role="aih-msg"][data-kind="unknown"]').count() == 1 and '已經記下來了' in pg.locator('[data-role="aih-answer"]').last.inner_text(), '② 答不出來的題目顯示 unknown 說明')
            check(pg.locator('[data-role="aih-who"]').last.inner_text() == '可以問：資訊部', '② 顯示「可以問：找誰」')
            check(pg.locator('[data-role="aih-quota"]').inner_text() == '今天還可以問 18 題', '② 剩餘題數 18：%s' % pg.locator('[data-role="aih-quota"]').inner_text())
            # Esc 關閉
            pg.keyboard.press('Escape')
            check(pg.locator('[data-role="aih-panel"]').is_hidden() and pg.evaluate("() => document.activeElement.getAttribute('data-role')") == 'aih-fab', '② Esc 關閉側欄、焦點回到按鈕')
            # Tab 鍵能走到按鈕、Enter 打開
            pg.keyboard.press('Enter')
            check(pg.locator('[data-role="aih-panel"]').is_visible(), '② 按鈕有焦點時 Enter 可打開側欄（鍵盤可操作）')
            # 純文字
            mock.evil = True
            ask(pg, '惡意回答測試')
            pwned = pg.evaluate('() => window.__pwned === 1')
            check(not pwned and pg.locator('[data-role="aih-panel"] img').count() == 0, '② 答案含 <img onerror>：不執行、沒有 img 節點')
            check(pg.locator('[data-role="aih-answer"]').last.inner_text() == EVIL, '② 原文以純文字顯示')
            mock.evil = False
            # 帶我去的 label 也是純文字（有權限的 me/profile 那顆）
            check(pg.locator('[data-role="aih-go"]').last.inner_text() == EVIL[:30] and pg.locator('[data-role="aih-go"] img').count() == 0, '② 帶我去的 label 也是純文字（截到 30 字）')
            pg.context.close()

            # ====== ③ 帶我去 ======
            pg = new_page()
            login(pg, 'staff1')
            pg.wait_for_selector('[data-role="aih-fab"]')
            pg.click('[data-role="aih-fab"]')
            ask(pg, '怎麼改密碼')
            gos = pg.locator('[data-role="aih-go"]')
            check(gos.count() == 1 and gos.first.inner_text() == '去看看', '③ 後端給兩個去處、一般同仁只有一個有權限 → 只畫一顆（人員清單那顆不畫）：%d' % gos.count())
            gos.first.click()
            pg.wait_for_selector('[data-keep="me"], [data-host="me"]', timeout=8000)
            check(pg.evaluate('location.hash') == '#/me/profile', '③ 按下去切到 #/me/profile：%s' % pg.evaluate('location.hash'))
            check(pg.locator('[data-role="aih-panel"]').is_visible(), '③ 桌機切頁後側欄仍開著')
            pg.fill('[data-role="aih-input"]', '我在這頁問')
            pg.click('[data-role="aih-send"]')
            pg.wait_for_function('() => document.querySelectorAll(\'[data-role="aih-msg"][data-from="bot"]\').length >= 2')
            check(mock.aih_bodies[-1]['page'] == {'m': 'me', 'v': 'profile'}, '③ 切頁後問題帶目前頁面 {m:me,v:profile}：%s' % mock.aih_bodies[-1]['page'])
            pg.context.close()

            pg = new_page()
            login(pg, 'admin')
            pg.wait_for_selector('[data-role="aih-fab"]')
            pg.click('[data-role="aih-fab"]')
            ask(pg, '怎麼改密碼')
            check(pg.locator('[data-role="aih-go"]').count() == 2, '③ admin 兩個去處都有權限 → 兩顆都畫')
            pg.locator('[data-role="aih-go"]').nth(1).click()
            pg.wait_for_selector('[data-role="view-content"] >> text=人員', timeout=8000)
            check(pg.evaluate('location.hash') == '#/users/list', '③ admin 按「人員清單」→ #/users/list')
            pg.context.close()

            # ====== ④ 👎 → feedback ======
            pg = new_page()
            login(pg, 'staff1')
            pg.wait_for_selector('[data-role="aih-fab"]')
            pg.click('[data-role="aih-fab"]')
            ask(pg, '薪水怎麼算')
            before = len(mock.pending)
            pg.locator('[data-role="aih-fb"] [data-act="down"]').last.click()
            pg.wait_for_function('() => /謝謝，已通知管理人員/.test(document.querySelector(\'[data-role="aih-fb-note"]\').textContent)', timeout=5000)
            fbs = [b for b in mock.aih_bodies if b.get('op') == 'feedback']
            check(len(fbs) == 1 and fbs[0]['good'] is False and fbs[0]['id'].startswith('aih_'), '④ 👎 打 feedback{id, good:false}：%s' % [{k: v for k, v in b.items() if k != 'token'} for b in fbs])
            check(len(mock.pending) == before + 1 and mock.pending[-1]['reason'] == 'thumbs_down', '④ 後端把這題記進待回答（thumbs_down）')
            check(pg.locator('[data-role="aih-fb"] [data-act="up"]').last.is_disabled(), '④ 按過之後兩顆鎖住')
            pg.context.close()

            # ====== ⑤ 管理頁：擬答 → 上架 → 待回答消失 → 再問答得出 ======
            pg = new_page()
            login(pg, 'admin')
            pg.wait_for_selector('[data-role="module-card"][data-module="ai-help"]')
            check(pg.locator('[data-role="module-card"][data-module="ai-help"] .card-title').inner_text() == '小幫手管理', '⑤ 首頁有「小幫手管理」卡片')
            pg.wait_for_selector('[data-role="alert-list"][data-module="ai-help"] :text("題待回答")', timeout=8000)
            alert = pg.locator('[data-role="alert-list"][data-module="ai-help"]').inner_text()
            n_open = len([x for x in mock.pending if x['status'] == 'open'])
            check(('小幫手有 %d 題待回答' % n_open) in alert, '⑤ 首頁提醒「小幫手有 %d 題待回答」：%s' % (n_open, alert))
            grp = pg.evaluate("() => { const b = document.querySelector('[data-role=\"nav-desktop\"] [data-nav=ai-help]'); const g = b && b.closest('.nav-dept'); return g ? g.textContent : ''; }")
            check('資訊部門' in grp, '⑤ 選單掛在「資訊部門」底下')
            pg.click('[data-nav="ai-help"]')
            pg.wait_for_selector('[data-role="pending-item"]', timeout=8000)
            names = [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(names == ['待回答', '知識庫', '用量'], '⑤ 頁頂三個分頁：%s' % names)
            check(pg.locator('[data-role="pending-item"]').count() == n_open, '⑤ 待回答列出 %d 題' % n_open)
            item = pg.locator('[data-role="pending-item"]', has_text='薪酬管理要找誰開權限')
            check('出現' not in item.inner_text() and '小幫手答不出來' in item.inner_text() and '人員管理・人員清單' in item.inner_text(), '⑤ 顯示原因與頁面中文名：%s' % item.inner_text().replace('\n', ' | ')[:80])
            item.locator('[data-act="draft"]').click()
            pg.wait_for_selector('[data-role="ed-a"]')
            check(pg.locator('[data-role="ed-a"]').input_value() == 'AI 擬答：請找人資開權限。' and pg.locator('[data-role="ed-q"]').input_value() == '薪酬管理要找誰開權限', '⑤ AI 擬答帶入編輯框')
            dr = [b for b in mock.aih_bodies if b.get('op') == 'draft']
            check(len(dr) == 1 and dr[0]['pending_id'] == 'aip_20261101100000_0001', '⑤ 擬答打 svc draft{pending_id}')
            check('只是草稿' in item.inner_text(), '⑤ 提醒「AI 擬的答案只是草稿」')
            pg.fill('[data-role="ed-a"]', '請找人資總監開薪酬管理權限（AI 擬答已人工確認）。')
            item.locator('[data-act="publish"]').click()
            pg.wait_for_function('(n) => document.querySelectorAll(\'[data-role="pending-item"]\').length === n', arg=n_open - 1, timeout=8000)
            saves = [c for c in mock.admin_calls if c[0] == 'aihKbSave']
            sets = [c for c in mock.admin_calls if c[0] == 'aihPendingSet']
            check(saves and saves[-1][1]['status'] == 'live' and saves[-1][1]['question'] == '薪酬管理要找誰開權限' and saves[-1][1]['m'] == 'users', '⑤ 上架＝aihKbSave status live（帶問題與頁面）：%s' % saves[-1][1])
            check(sets and sets[-1][1]['status'] == 'done' and sets[-1][1]['kb_id'] == mock.kb[-1]['id'], '⑤ 接著 aihPendingSet done 帶 kb_id：%s' % sets[-1][1])
            check(pg.locator('[data-role="pending-item"]', has_text='薪酬管理要找誰開權限').count() == 0, '⑤ 待回答裡這題消失')
            # 再問答得出來（用剛上架的題目原文問）
            pg.click('[data-role="aih-fab"]')
            ask(pg, '薪酬管理要找誰開權限')
            check('請找人資總監開薪酬管理權限' in pg.locator('[data-role="aih-answer"]').last.inner_text(), '⑤ 上架後再問：答得出來')
            pg.keyboard.press('Escape')
            # 略過
            sk = pg.locator('[data-role="pending-item"]').first
            sk_id = sk.get_attribute('data-id')
            sk.locator('[data-act="ignore"]').click()
            pg.wait_for_function('(id) => !document.querySelector(\'[data-role="pending-item"][data-id="\' + id + \'"]\')', arg=sk_id, timeout=8000)
            check(next(x for x in mock.pending if x['id'] == sk_id)['status'] == 'ignored', '⑤ 「略過」＝ignored')
            # 知識庫
            pg.locator('[data-role="view-nav"] .nav-item', has_text='知識庫').click()
            pg.wait_for_selector('[data-role="kb-item"]')
            check(pg.locator('[data-role="kb-item"]').count() == len(mock.kb), '⑤ 知識庫列出全部 %d 題' % len(mock.kb))
            pg.fill('[data-role="kb-search"]', '改密碼')
            pg.wait_for_function('() => document.querySelectorAll(\'[data-role="kb-item"]\').length === 1', timeout=5000)
            check(pg.locator('[data-role="kb-q"]').first.inner_text() == '怎麼改密碼', '⑤ 搜尋「改密碼」只剩一題')
            pg.locator('[data-role="kb-item"] [data-act="hist"]').click()
            pg.wait_for_selector('[data-role="kb-hist-row"]')
            pg.locator('[data-role="kb-hist-row"]', has_text='新增').locator('[data-act="restore"]').click()
            pg.wait_for_selector('[data-role="ed-a"]')
            check(pg.locator('[data-role="ed-a"]').input_value() == '舊版：打電話給資訊部。', '⑤ 歷史「回到這個版本」→ 快照帶回編輯框（還沒存）')
            kb_before = [k for k in mock.kb if k['id'] == 'kb0001'][0]['answer']
            check(kb_before == '到右上角「改密碼」。', '⑤ 帶回編輯框不會直接改資料')
            pg.click('[data-act="save"]')
            pg.wait_for_function('() => !document.querySelector(\'[data-role="ed-a"]\')', timeout=8000)
            check([k for k in mock.kb if k['id'] == 'kb0001'][0]['answer'] == '舊版：打電話給資訊部。', '⑤ 按儲存才生效（aihKbSave 帶 expected_updated_at）')
            ex = [c for c in mock.admin_calls if c[0] == 'aihKbSave'][-1][1]
            check(ex['id'] == 'kb0001' and ex.get('expected_updated_at') and ex.get('verified_at'), '⑤ 儲存帶 id、expected_updated_at、確認日期：%s' % sorted(ex.keys()))
            pg.fill('[data-role="kb-search"]', '')
            pg.wait_for_function('(n) => document.querySelectorAll(\'[data-role="kb-item"]\').length === n', arg=len(mock.kb), timeout=5000)
            pg.locator('[data-role="kb-item"][data-id="kb0001"] [data-act="off"]').click()
            pg.wait_for_function('() => document.querySelector(\'[data-role="kb-item"][data-id="kb0001"]\').getAttribute("data-status") === "off"', timeout=8000)
            check([k for k in mock.kb if k['id'] == 'kb0001'][0]['status'] == 'off', '⑤ 下架＝status off')
            # ⑤b 上架後停在原地（Eason 2026-11-03）：題目多到要往下捲時，按上架不能跳回最上面
            seed_kb = dict([k for k in mock.kb if k['id'] == 'kb0001'][0])
            for i in range(30):
                x = dict(seed_kb); x.update({'id': 'kb%04d' % (900 + i), 'question': '捲動測試第 %d 題' % i, 'status': 'draft'}); mock.kb.append(x)
            pg.fill('[data-role="kb-search"]', '捲動測試')
            pg.wait_for_function('() => document.querySelectorAll(\'[data-role="kb-item"]\').length === 30', timeout=5000)
            pg.locator('[data-role="kb-item"][data-id="kb0920"]').scroll_into_view_if_needed()
            pg.evaluate('() => document.querySelector(\'[data-role="kb-item"][data-id="kb0920"]\').scrollIntoView({block: "center"})')
            before = pg.evaluate('() => document.querySelector(\'[data-role="kb-item"][data-id="kb0920"]\').getBoundingClientRect().top')
            pg.locator('[data-role="kb-item"][data-id="kb0920"] [data-act="on"]').click()
            pg.wait_for_function('() => { const e = document.querySelector(\'[data-role="kb-item"][data-id="kb0920"]\'); return e && e.getAttribute("data-status") === "live"; }', timeout=8000)
            after = pg.evaluate('() => document.querySelector(\'[data-role="kb-item"][data-id="kb0920"]\').getBoundingClientRect().top')
            check(before > 150 and abs(after - before) < 6, '⑤b 按上架後停在原地（上架前 %.0f、上架後 %.0f）' % (before, after))
            mock.kb[:] = [k for k in mock.kb if not k['id'].startswith('kb09')]
            pg.fill('[data-role="kb-search"]', '')
            pg.wait_for_function('(n) => document.querySelectorAll(\'[data-role="kb-item"]\').length === n', arg=len(mock.kb), timeout=5000)
            # 新增一題
            pg.click('[data-act="kb-new"]')
            pg.wait_for_selector('[data-role="kb-new-host"] [data-role="ed-q"]')
            pg.fill('[data-role="kb-new-host"] [data-role="ed-q"]', '新題目')
            pg.click('[data-act="new-draft"]')
            pg.wait_for_selector('[data-role="kb-msg"]', state='attached')
            check(pg.locator('[data-role="kb-new-host"] [data-role="ed-q"]').count() == 1, '⑤ 新增一題：答案空白 → 擋下（編輯框還在）')
            pg.fill('[data-role="kb-new-host"] [data-role="ed-a"]', '新答案')
            pg.click('[data-act="new-draft"]')
            pg.wait_for_function('() => !document.querySelector(\'[data-role="kb-new-host"] [data-role="ed-q"]\')', timeout=8000)
            check(mock.kb[-1]['question'] == '新題目' and mock.kb[-1]['status'] == 'draft', '⑤ 新增存成草稿')
            # 用量
            pg.locator('[data-role="view-nav"] .nav-item', has_text='用量').click()
            pg.wait_for_selector('[data-role="usage-body"] .aim-grid', timeout=8000)
            ut = pg.locator('[data-role="usage-body"]').inner_text()
            check('12' in ut and '75%' in ut and '8.3%' in ut and 'US$ 1.23' in ut and 'US$ 28.00' in ut, '⑤ 用量：題數 12、答得出來 75%%、👎 8.3%%、花費 US$ 1.23／28.00：%s' % ut.replace('\n', ' ')[:140])
            check(pg.locator('[data-role="usage-day"]').count() == 2, '⑤ 每日題數 2 天')
            pg.context.close()

            # ====== ⑧ 用量頁「問答紀錄」 ======
            for width, height in ((1280, 900), (375, 812)):
                pg = new_page(width=width, height=height)
                login(pg, 'admin')
                pg.goto(base + '/index.html#/ai-help/usage')
                pg.wait_for_selector('[data-role="log-item"]', timeout=8000)
                if width == 1280:
                    items = pg.locator('[data-role="log-item"]')
                    check(items.count() == 50, '⑧ 第一頁 50 題（共 %d）' % items.count())
                    cnt = pg.locator('[data-role="log-count"]').inner_text()
                    check(cnt == '共 60 題，顯示 50 題（新的在前）', '⑧ 題數說明：%s' % cnt)
                    ids = pg.eval_on_selector_all('[data-role="log-item"]', 'els => els.map(e => e.getAttribute("data-id"))')
                    check(ids[0] == 'aih_20261102105900_0000' and ids == sorted(ids, reverse=True), '⑧ 新的排最前：%s' % ids[:2])
                    first = items.nth(0)
                    check(first.locator('[data-role="log-time"]').inner_text() == '11-02 10:59', '⑧ 時間以台北時間顯示：%s' % first.locator('[data-role="log-time"]').inner_text())
                    check(first.locator('[data-role="log-page"]').inner_text() == '我的資料・個人資料', '⑧ 頁面名稱用中文對照：%s' % first.locator('[data-role="log-page"]').inner_text())
                    check(items.nth(2).locator('[data-role="log-page"]').inner_text() == '通用（不限頁面）', '⑧ m 空＝通用')
                    check(first.locator('[data-role="log-kind"]').inner_text() == '答得出來' and items.nth(2).locator('[data-role="log-kind"]').inner_text() == '沒答出來', '⑧ 結果：答得出來／沒答出來')
                    check(items.nth(1).locator('[data-role="log-down"]').count() == 1 and first.locator('[data-role="log-down"]').count() == 0 and items.nth(4).locator('[data-role="log-up"]').count() == 1, '⑧ 👎／👍 標示')
                    xq = items.nth(3).locator('[data-role="log-q"]').inner_text()
                    check(items.nth(1).locator('[data-role="log-page"]').inner_text() == '表單簽核・我的單', '⑧ 頁面名稱：%s' % items.nth(1).locator('[data-role="log-page"]').inner_text())
                    pg.evaluate('() => document.querySelector(\'[data-role="usage-day"]\').scrollIntoView({block: "start"})')
                    pg.wait_for_timeout(300)
                    pg.screenshot(path=os.path.join(out_dir, 'usage-log-1280.png'))
                    check(xq.startswith('<img src=x onerror=') and pg.evaluate('() => window.__xss === undefined') and items.nth(3).locator('img').count() == 0, '⑧ 問題當純文字（<img onerror> 原樣顯示、不執行）')
                    a = first.locator('[data-role="log-a"]')
                    short = a.inner_text()
                    check(short.endswith('…') and len(short) == 81, '⑧ 回答截短 80 字＋…（%d 字）' % len(short))
                    first.locator('[data-act="log-toggle"]').click()
                    check(len(a.inner_text()) > 100 and not a.inner_text().endswith('…') and first.locator('[data-act="log-toggle"]').inner_text() == '收起', '⑧ 看全文 → 顯示整段、按鈕變「收起」')
                    calls = [c for c in mock.admin_calls if c[0] == 'aihLogList']
                    check(calls and re.match(r'^\d{4}-\d{2}$', calls[-1][1].get('month', '')) and calls[-1][1].get('limit') == 50 and 'before' not in calls[-1][1], '⑧ aihLogList 帶 {month, limit:50}：%s' % (calls[-1][1] if calls else None))
                    pg.click('[data-act="log-more"]')
                    pg.wait_for_function('() => document.querySelectorAll(\'[data-role="log-item"]\').length === 60', timeout=8000)
                    calls = [c for c in mock.admin_calls if c[0] == 'aihLogList']
                    check(calls[-1][1].get('before') == '0:' + ids[-1], '⑧ 再顯示更多 帶 before＝上一頁的 next')
                    check(pg.locator('[data-act="log-more"]').is_hidden() and pg.locator('[data-role="log-count"]').inner_text() == '共 60 題，顯示 60 題（新的在前）', '⑧ 全部顯示完 → 「再顯示更多」消失')
                    ids2 = pg.eval_on_selector_all('[data-role="log-item"]', 'els => els.map(e => e.getAttribute("data-id"))')
                    check(len(set(ids2)) == 60, '⑧ 分頁不重複')
                    pg.select_option('[data-role="usage-month"]', index=1)
                    pg.wait_for_function('() => document.querySelectorAll(\'[data-role="log-item"]\').length === 1', timeout=8000)
                    check(pg.locator('[data-role="log-q"]').inner_text() == '十月的問題', '⑧ 換月份 → 重讀那個月')
                else:
                    over = pg.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
                    check(over <= 0, '⑧ 375 寬：問答紀錄無橫向捲軸（多出 %s px）' % over)
                    pg.locator('[data-role="log-card"]').scroll_into_view_if_needed()
                    pg.screenshot(path=os.path.join(out_dir, 'usage-log-375.png'))
                pg.context.close()

            # ====== ⑥ 暫停／初始化／匯入／試跑 ======
            pg = new_page()
            login(pg, 'admin')
            pg.goto(base + '/index.html#/ai-help/pending')
            pg.wait_for_selector('[data-act="pause"]', timeout=8000)
            check(pg.locator('[data-role="top-state"]').inner_text() == '小幫手運作中' and pg.locator('[data-act="setup"]').count() == 0, '⑥ 已初始化：顯示「運作中」、沒有初始化按鈕')
            pg.click('[data-act="pause"]')
            pg.click('.dialog .btn-primary')
            pg.wait_for_function('() => document.querySelector(\'[data-role="top-state"]\').textContent === "小幫手已暫停"', timeout=8000)
            check(mock.paused is True and [c for c in mock.admin_calls if c[0] == 'aihPauseSet'][-1][1] == {'paused': True}, '⑥ 按「暫停小幫手」→ aihPauseSet{paused:true}，狀態變「已暫停」')
            check(pg.locator('[data-act="pause"]').inner_text() == '恢復小幫手', '⑥ 按鈕變「恢復小幫手」')
            pg.click('[data-role="aih-fab"]')
            ask(pg, '怎麼改密碼')
            check('暫時無法回答' in pg.locator('[data-role="aih-error"]').last.inner_text(), '⑥ 暫停中同仁問問題：「小幫手暫時無法回答」')
            pg.keyboard.press('Escape')
            pg.click('[data-act="pause"]')
            pg.click('.dialog .btn-primary')
            pg.wait_for_function('() => document.querySelector(\'[data-role="top-state"]\').textContent === "小幫手運作中"', timeout=8000)
            check(mock.paused is False, '⑥ 再按「恢復小幫手」→ 回到運作中')
            pg.click('[data-act="import"]')
            pg.click('.dialog .btn-primary')
            pg.wait_for_selector('.toast:has-text("匯入 3 題，略過 1 題")', timeout=8000)
            check(getattr(mock, 'imported', 0) == 1 and [c for c in mock.admin_calls if c[0] == 'aihKbImport'][-1][1] == {}, '⑥ 「匯入初始知識庫」→ aihKbImport {} → 顯示「匯入 3 題，略過 1 題」')
            pg.context.close()

            mock.inited = False
            pg = new_page()
            login(pg, 'admin')
            pg.goto(base + '/index.html#/ai-help/kb')
            pg.wait_for_selector('[data-act="setup"]', timeout=8000)
            check(pg.locator('[data-role="top-state"]').inner_text() == '還沒初始化' and pg.locator('[data-act="pause"]').count() == 0 and '還沒初始化' in pg.locator('[data-role="kb-list"]').inner_text(), '⑥ 還沒初始化：只出現「初始化小幫手」，頁面提示先初始化')
            pg.click('[data-act="setup"]')
            pg.click('.dialog .btn-primary')
            pg.wait_for_selector('[data-act="pause"]', timeout=8000)
            check(mock.inited is True and pg.locator('[data-act="setup"]').count() == 0, '⑥ 初始化後按鈕消失、出現暫停按鈕')
            pg.context.close()

            pg = new_page(query='?dryrun=1')
            login(pg, 'admin')
            pg.goto(base + '/index.html?dryrun=1#/ai-help/pending')
            pg.wait_for_selector('[data-act="pause"]', timeout=8000)
            locked = pg.evaluate("() => ['pause', 'import'].map(a => document.querySelector('[data-act=' + a + ']').disabled)")
            pg.wait_for_selector('[data-role="pending-item"]')
            locked2 = pg.evaluate("() => [...document.querySelectorAll('[data-role=pending-item] [data-act]')].map(b => b.disabled)")
            check(all(locked) and all(locked2) and locked2, '⑥ 試跑模式：暫停、匯入、擬答／自己寫／略過 全部鎖住：%s %s' % (locked, locked2))
            pg.context.close()

            # ⑥b 試跑模式：小幫手不能用、擬答鈕鎖住、沒送 ask／feedback／draft
            n0 = len(mock.aih_bodies)
            pg = new_page(query='?dryrun=1')
            login(pg, 'admin')
            pg.wait_for_selector('[data-role="aih-fab"]', timeout=8000)
            pg.click('[data-role="aih-fab"]')
            check('試跑模式中，小幫手不能使用' in pg.locator('[data-role="aih-panel"]').inner_text() and pg.locator('[data-role="aih-input"]').is_hidden(), '⑥ 試跑模式：按鈕在、點開只寫「試跑模式中，小幫手不能使用」、沒有輸入框')
            check(pg.evaluate("() => new URLSearchParams(location.search).get('dryrun')") == '1' and pg.locator('[data-role="aih-send"]').is_hidden(), '⑥ 試跑模式：送出鈕不可用')
            check(all(b.get('op') == 'status' for b in mock.aih_bodies[n0:]), '⑥ 試跑模式：只打 status、沒有 ask／feedback／draft：%s' % [b.get('op') for b in mock.aih_bodies[n0:]])
            pg.context.close()

            # ====== ⑦ 手機寬度 ======
            for width, height in ((375, 812), (320, 640)):
                pg = new_page(width=width, height=height)
                login(pg, 'admin')
                pg.wait_for_selector('[data-role="aih-fab"]')
                over = pg.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
                check(over <= 0, '⑦ %d 寬：首頁（含按鈕）沒有橫向捲軸（多出 %s px）' % (width, over))
                fb = pg.evaluate("() => { const r = document.querySelector('[data-role=aih-fab]').getBoundingClientRect(); return {right: innerWidth - r.right, bottom: innerHeight - r.bottom, left: r.left}; }")
                check(fb['left'] >= 0 and fb['right'] >= 0 and fb['bottom'] >= 0, '⑦ %d 寬：按鈕完整在畫面內：%s' % (width, fb))
                pg.click('[data-role="aih-fab"]')
                ask(pg, '怎麼改密碼')
                geo = pg.evaluate("""() => { const r = document.querySelector('[data-role=aih-panel]').getBoundingClientRect();
                  return {l: r.left, t: r.top, w: r.width, h: r.height, iw: innerWidth, ih: innerHeight,
                          over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                          pover: document.querySelector('[data-role=aih-panel]').scrollWidth - document.querySelector('[data-role=aih-panel]').clientWidth,
                          lover: document.querySelector('[data-role=aih-log]').scrollWidth - document.querySelector('[data-role=aih-log]').clientWidth}; }""")
                check(geo['l'] == 0 and geo['t'] == 0 and abs(geo['w'] - geo['iw']) < 1 and abs(geo['h'] - geo['ih']) < 1, '⑦ %d 寬：側欄全螢幕 %s' % (width, geo))
                check(geo['over'] <= 0 and geo['pover'] <= 0 and geo['lover'] <= 0, '⑦ %d 寬：側欄打開（含一則答案）無橫向捲軸' % width)
                if width == 375:
                    pg.screenshot(path=os.path.join(out_dir, 'helper-375.png'))
                pg.keyboard.press('Escape')
                pg.goto(base + '/index.html#/ai-help/pending')
                pg.wait_for_selector('[data-role="pending-item"]', timeout=8000)
                over = pg.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
                check(over <= 0, '⑦ %d 寬：管理頁待回答無橫向捲軸（多出 %s px）' % (width, over))
                pg.locator('[data-role="pending-item"]').first.locator('[data-act="write"]').click()
                pg.wait_for_selector('[data-role="ed-q"]')
                over = pg.evaluate('() => document.documentElement.scrollWidth - document.documentElement.clientWidth')
                check(over <= 0, '⑦ %d 寬：編輯框展開無橫向捲軸（多出 %s px）' % (width, over))
                pg.context.close()

            # 桌機截圖
            mock.left = 20
            pg = new_page(width=1280, height=800)
            login(pg, 'admin')
            pg.wait_for_selector('[data-role="aih-fab"]')
            pg.click('[data-role="aih-fab"]')
            ask(pg, '怎麼改密碼')
            ask(pg, '年終獎金怎麼算')
            pg.screenshot(path=os.path.join(out_dir, 'helper-1280.png'))
            pg.context.close()
            browser.close()

        check(mock.leaked == [], '真實網路零流出（mock）：%s' % mock.leaked)
        check(guard_hits == [], '真實網路零流出（外網守門 regex）：%s' % guard_hits)
        print('截圖資料夾：' + out_dir)
    finally:
        httpd.shutdown()
        USERS.pop('staff1', None)
    finish()


if __name__ == '__main__':
    main()
