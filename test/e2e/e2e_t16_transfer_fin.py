#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑯：調撥管理（財務部門，2026-10-26；規格 docs/transfer-fin/spec.md §2、§3、§4、§8）。

全程 mock、零真實資料——照既有慣例：mock 平台後端 /platform/api 與 /platform/proxy（本檔的 MockT16 在 common.MockBackend 上
接 ns transfer：驗 token 與 transfer.write、白名單、adminUpdate 只放行 memoryEdit／memoryDelete、補會計密碼與操作人）。
上游調撥後端＝調撥系統的假 Apps Script 環境（mala-transfer 的 mock/gas-mock.js 原檔載入 Code.gs，資料庫在暫存資料夾、示範資料全假、
日期相對今天），這樣月報／品項記憶／卡關總覽的回傳形狀就是真後端的形狀。

頁面用正式網址的「別名」跑：管理系統 https://dzy.mozhuting.com 與調撥會計頁 https://eason0728.github.io/mala-transfer/
都由 Playwright route 改由本機檔案供應（沒有任何請求真的離開本機；沒被涵蓋的請求一律 abort 並進 leaked，跑完斷言為空）。
這樣 iframe 的 origin、postMessage 的 targetOrigin 與正式環境一模一樣，不佔 8777／8787 這些常被別的對話使用的埠。

前置：調撥系統的本機複本（預設 ~/mala-transfer-wt-fin；env TRANSFER_WT 可改）要有 mock/ 與 src/report.html（嵌入模式版）；要有 node。

驗：
  ① 財務同仁左側「財務部門」底下有「調撥管理」且排在「收支管理」之後；門市店長與一般同仁看不到。
  ② 頁頂三個分頁「月報｜品項記憶｜卡關總覽」切得動（會計頁沒有自己的密碼閘與選單）。
  ③ 產月報後矩陣有數字、點金額看類別拆帳；「下載 Excel」真的下載到 .xlsx。
  ④ 品項記憶改名 → 後端收到的是 adminUpdate memoryEdit；瀏覽器送出的 payload 沒有密碼／token／operator 欄位。
  ⑤ 卡關總覽：逾期列、點一列跳出唯讀單據明細、沒有任何動作鈕。
  ⑥ 切去「收支管理」再回來，iframe 沒有重載（keepAlive 30 分鐘）。
  ⑦ 試跑模式（?dryrun=1）：讀取照常、寫入（產月報）被攔、上游一筆寫入都沒有收到。
  ⑧ 非白名單 op（wipeData）被代轉拒絕。
找文字一律限定在 [data-keep=transfer-fin] 範圍（整頁找會先找到背景藏著的模組）。
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8822
SITE = 'https://dzy.mozhuting.com'                       # 管理系統正式網址（只當別名，route 轉到本機）
CHILD = 'https://eason0728.github.io/mala-transfer/'     # 調撥會計頁正式網址（同上）
KEEP = '[data-keep="transfer-fin"]'
UPSTREAM_PIN = 'E2E-ACCT-PIN-0000'                       # 上游假環境自己的會計密碼，只在 mock「mini」那一側
TRANSFER_WT = os.path.expanduser(os.environ.get('TRANSFER_WT', '~/mala-transfer-wt-fin'))

READ_ACTIONS = ('bootstrap', 'adminData', 'adminOverview', 'getDoc')
WRITE_ACTIONS = ('buildMonthlyReport', 'adminUpdate')

# 上游示範資料（全假、日期相對今天）：上月 1 張＋本月 4 張（含一張逾期、一張已出貨未簽收、一張草稿）
SEED = r'''
const G = require("./mock/gas-mock");
G.resetDb(); G.clearCache(); G.call("bootstrap", {});
const BE = G.loadBackend();
BE.setConfig_("pin_master", process.env.UPSTREAM_PIN);
G.saveDb();
const TODAY = BE.today_();
const day = (n) => new Date(new Date(TODAY + "T00:00:00+08:00").getTime() + n * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const first = TODAY.slice(0, 8) + "01";
const prev = new Date(new Date(first + "T00:00:00+08:00").getTime() - 86400000 + 8 * 3600000).toISOString().slice(0, 8) + "15";
const N = { ck: "中央廚房", gf: "墨竹亭新竹光復店", js: "墨竹亭新竹金山店", mc: "墨竹亭台中美村店", sx: "小辛辣光復店" };
const tk = {}; Object.values(N).forEach((n) => { tk[n] = G.call("login", { node: n, pin: "0000" }).data.token; });
const it = (name, price, qty, cat) => ({ "品項名稱": name, "規格": "5kg", "單位": "箱", "類別": cat || "食材", "調撥單價": price, "應撥數量": qty });
const mk = (from, to, date, due, items) => { const r = G.call("createDraft", { doc: { "調出方": from, "調入方": to, "調撥日期": date, "預計到貨日": due, "打包人": "阿明" }, items, "操作人": "阿明", token: tk[from] }); if (!r.ok) throw new Error(JSON.stringify(r)); return r.data["單號"]; };
const ship = (no, from) => { const r = G.call("ship", { "單號": no, "操作人": "阿明", token: tk[from] }); if (!r.ok) throw new Error(JSON.stringify(r)); };
const recv = (no, to, lines) => { const r = G.call("receive", { "單號": no, "簽收人": "阿德", token: tk[to], lines }); if (!r.ok) throw new Error(JSON.stringify(r)); };
const p1 = mk(N.ck, N.gf, prev, prev, [it("雞湯底", 480, 6), it("手套", 45, 10, "包材")]);
ship(p1, N.ck); recv(p1, N.gf, [{ "列序": "01", "實收數量": 6 }, { "列序": "02", "實收數量": 10 }]);
const c1 = mk(N.ck, N.sx, day(-3), day(-1), [it("麻辣鍋底", 520, 8), it("免洗筷", 55, 12, "雜貨")]);
ship(c1, N.ck); recv(c1, N.sx, [{ "列序": "01", "實收數量": 8 }, { "列序": "02", "實收數量": 12 }]);
const c2 = mk(N.js, N.mc, day(-2), day(1), [it("青江菜", 180, 3)]);
ship(c2, N.js); recv(c2, N.mc, [{ "列序": "01", "實收數量": 3 }]);
const od = mk(N.ck, N.gf, day(-9), day(-4), [it("辣椒粉", 120, 5)]); ship(od, N.ck);     // 逾期
const sh = mk(N.ck, N.js, day(-1), day(2), [it("豆干", 60, 40)]); ship(sh, N.ck);       // 已出貨未簽收
mk(N.ck, N.mc, day(0), day(3), [it("鴨血", 100, 15)]);                                   // 草稿
G.saveDb();
console.log(JSON.stringify({ overdue: od }));
'''


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Upstream:
    """調撥系統的假後端（node 跑 mock/server.js，原檔載入 Code.gs）。資料庫在暫存資料夾，不碰調撥複本自己的 db.json。"""

    def __init__(self):
        mock_dir = os.path.join(TRANSFER_WT, 'mock')
        src_dir = os.path.join(TRANSFER_WT, 'src')
        if not os.path.exists(os.path.join(mock_dir, 'gas-mock.js')) or not os.path.exists(os.path.join(src_dir, 'report.html')):
            raise SystemExit('找不到調撥系統本機複本（要有 mock/gas-mock.js 與 src/report.html）：%s；可用 env TRANSFER_WT 指定' % TRANSFER_WT)
        self.src = src_dir
        self.tmp = tempfile.mkdtemp(prefix='transfer-e2e-')
        shutil.copytree(mock_dir, os.path.join(self.tmp, 'mock'), ignore=shutil.ignore_patterns('db.json'))
        os.symlink(src_dir, os.path.join(self.tmp, 'src'))
        env = dict(os.environ, UPSTREAM_PIN=UPSTREAM_PIN)
        out = subprocess.run(['node', '-e', SEED], cwd=self.tmp, env=env, capture_output=True, text=True)
        if out.returncode != 0:
            raise SystemExit('上游示範資料鋪不起來：' + out.stderr[-500:])
        self.overdue_no = json.loads(out.stdout.strip().splitlines()[-1])['overdue']
        self.port = free_port()
        self.proc = subprocess.Popen(['node', 'mock/server.js'], cwd=self.tmp, env=dict(os.environ, PORT=str(self.port)),
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                urllib.request.urlopen('http://127.0.0.1:%d/report.html' % self.port, timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        else:
            raise SystemExit('上游假後端未在時限內啟動')
        self.calls = []   # (action, payload)：mini 實際送到上游的內容

    def post(self, action, payload):
        self.calls.append((action, dict(payload)))
        req = urllib.request.Request('http://127.0.0.1:%d/api' % self.port,
                                     data=json.dumps({'action': action, 'payload': payload}).encode('utf-8'),
                                     headers={'Content-Type': 'text/plain;charset=utf-8'})
        return json.loads(urllib.request.urlopen(req, timeout=30).read().decode('utf-8'))

    def memory_log(self):
        db = json.load(urllib.request.urlopen('http://127.0.0.1:%d/_db' % self.port, timeout=5))
        return db['sheets'].get('會計操作紀錄', [])

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)


class MockT16(MockBackend):
    """在共用 mock 上補 ns transfer 的代轉（形狀照 spec §3 與 minikit proxy-hook.js buildTransferBody）。"""

    def __init__(self, base, upstream):
        super().__init__(base)
        self.up = upstream
        self.transfer_calls = []     # (action, op, user)

    def proxy(self, body):
        if body.get('ns') != 'transfer':
            return super().proxy(body)
        action = body.get('action', '')
        self.proxy_calls = getattr(self, 'proxy_calls', []) + [('transfer', action)]
        token = body.get('token') or ''
        if not token:
            return 401, {'ok': False, 'error': 'NO_TOKEN', 'code': 'NO_TOKEN'}
        name = token.replace('e2e-token-', '')
        u = USERS.get(name)
        if not u:
            return 401, {'ok': False, 'error': '登入已失效', 'code': 'BAD_TOKEN'}
        if '*' not in u['perms'] and 'transfer.write' not in u['perms']:
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        if action not in READ_ACTIONS and action not in WRITE_ACTIONS:
            return 403, {'ok': False, 'error': '沒有權限', 'code': 'FORBIDDEN'}
        payload = dict(body.get('payload') or {})
        for k in ('pin_master', 'token', 'operator'):          # 瀏覽器端不准夾帶（mini hook 會刪；這裡看到就記為流出）
            if k in payload:
                self.leaked.append('FRONT_SENT_%s: %s' % (k, action))
        op = payload.get('op')
        if action == 'adminUpdate' and op not in ('memoryEdit', 'memoryDelete'):
            return 403, {'ok': False, 'error': 'OP_FORBIDDEN', 'code': 'OP_FORBIDDEN'}
        self.transfer_calls.append((action, op, name))
        payload['pin_master'] = UPSTREAM_PIN
        payload['operator'] = '%s（%s）（管理系統）' % (u['user']['name'], name)
        resp = self.up.post(action, payload)
        return 200, json.loads(json.dumps(resp).replace(UPSTREAM_PIN, '[REDACTED]'))


def main():
    httpd, base = start_server(PORT)
    up = Upstream()
    mock = MockT16(base, up)
    mk = lambda name, perms: {'password': 'e2e-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
    USERS['fin1'] = mk('財務同仁', ['platform.self', 'cashbook.write', 'transfer.write'])   # 財務部門預設規則 hq/fin/* 的結果
    USERS['mgr1'] = mk('門市店長', ['platform.self', 'audit.read.own'])                      # 店長沒有 transfer.write
    stray = []        # 別名網址以外、被攔下的調撥頁請求
    out_dir = tempfile.mkdtemp(prefix='transfer-fin-e2e-')
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def site_route(route):
                u = urlparse(route.request.url)
                url = base + (u.path or '/') + (('?' + u.query) if u.query else '')
                route.fulfill(response=route.fetch(url=url))

            def child_route(route):
                u = urlparse(route.request.url)
                rel = u.path[len('/mala-transfer/'):] if u.path.startswith('/mala-transfer/') else ''
                f = os.path.join(up.src, rel or 'index.html')
                if rel in ('report.html',) and os.path.isfile(f):
                    route.fulfill(status=200, content_type='text/html; charset=utf-8', body=open(f, 'rb').read())
                else:
                    stray.append(route.request.url)
                    route.fulfill(status=404, content_type='text/plain', body='not found')

            def new_page(query=''):
                ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
                pg = ctx.new_page()
                mock.install(pg)
                pg.route(SITE + '/**', site_route)
                pg.route(CHILD + '**', child_route)
                pg.goto(SITE + '/index.html' + query)
                return pg

            def do_login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def child_frame(pg):
                for _ in range(100):
                    for f in pg.frames:
                        if f.url.startswith(CHILD + 'report.html'):
                            return f
                    pg.wait_for_timeout(100)
                return None

            def tab_names(pg):
                return [t.strip().split('\n')[0] for t in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]

            def click_tab(pg, name):
                pg.locator('[data-role="view-nav"] .nav-item', has_text=name).first.click()

            # ── ① 選單：財務同仁看得到、順序在收支管理之後；店長／一般同仁看不到 ──
            fin = new_page()
            do_login(fin, 'fin1')
            navs = fin.locator('[data-role="nav-desktop"] [data-nav]').evaluate_all('els => els.map(e => e.getAttribute("data-nav"))')
            check('transfer-fin' in navs and 'cashbook' in navs, '財務同仁左側選單有「收支管理」與「調撥管理」，實際：%s' % navs)
            check('transfer-fin' in navs and 'cashbook' in navs and navs.index('transfer-fin') == navs.index('cashbook') + 1,
                  '「調撥管理」緊接在「收支管理」之後（財務部門內）')
            check(fin.locator('[data-role="nav-desktop"] [data-nav="transfer-fin"]').inner_text().strip() == '調撥管理', '選單文字＝調撥管理')
            cards = [c.get_attribute('data-module') for c in fin.locator('[data-role="module-card"]').all()]
            check('transfer-fin' in cards, '財務同仁首頁有調撥管理卡片，實際：%s' % cards)

            mg = new_page()
            do_login(mg, 'mgr1')
            check(mg.locator('[data-role="nav-desktop"] [data-nav="transfer-fin"]').count() == 0, '店長：左側選單沒有調撥管理')
            check('transfer-fin' not in [c.get_attribute('data-module') for c in mg.locator('[data-role="module-card"]').all()], '店長：首頁沒有調撥管理卡片')
            mg.goto(SITE + '/index.html#/transfer-fin/report')
            mg.wait_for_timeout(1200)
            check(mg.locator('[data-role="transfer-frame"]').count() == 0, '店長直接輸入 #/transfer-fin/report：不會載入會計頁')
            check(not any(c[0] == 'transfer' for c in getattr(mock, 'proxy_calls', [])), '店長完全沒有打 transfer 代轉')

            # ── ② 進入模組：iframe 載入、三個分頁 ──
            fin.click('[data-role="nav-desktop"] [data-nav="transfer-fin"]')
            fin.wait_for_selector(KEEP + ' iframe[data-role="transfer-frame"]', timeout=10000)
            fr = child_frame(fin)
            check(fr is not None, 'iframe 載入調撥會計頁（%s…?embed=dzy）' % (CHILD + 'report.html'))
            check(fr.url == CHILD + 'report.html?embed=dzy', 'iframe 網址正確：%s' % fr.url)
            check(tab_names(fin)[:3] == ['月報', '品項記憶', '卡關總覽'], '頁頂三個分頁：月報｜品項記憶｜卡關總覽，實際：%s' % tab_names(fin))
            fr.wait_for_selector('#rptCard:not(.hide)', timeout=15000)
            check(not fr.locator('#gate').is_visible(), '嵌入模式：沒有會計密碼閘')
            check(fr.locator('header').count() == 0 or not fr.locator('header').first.is_visible(), '嵌入模式：會計頁自己的標題列已藏')
            check(fr.locator('#admCard').is_hidden() and fr.locator('#ovCard').is_hidden(), '月報分頁：品項記憶與卡關總覽卡片是藏的')

            # ── ③ 產月報：矩陣有數字、類別拆帳、下載 Excel ──
            ym = fr.input_value('#ym')
            check(re.match(r'^\d{4}-\d{2}$', ym) is not None, '年月預設有值：%s' % ym)
            fr.click('#gen')
            fr.wait_for_selector('#rpt table.mtx', timeout=30000)
            amts = fr.locator('#rpt a.cell').all_inner_texts()
            nums = [int(re.sub(r'[^\d]', '', a)) for a in amts if re.search(r'\d', a)]
            check(len(nums) >= 2 and all(n > 0 for n in nums), '產月報後調撥矩陣有金額：%s' % amts)
            # 本月三張已簽收單：520*8+55*12=4820（央廚→辣光復）、180*3=540（金山→美村）；逾期那張 600 也算（應撥口徑、含已出貨）
            check(4820 in nums, '矩陣金額 4,820（央廚→小辛辣，應撥數量×單價）出現在格子裡：%s' % nums)
            check('已產生' in fr.locator('#rmsg').inner_text(), '月報訊息：已產生分頁：%s' % fr.locator('#rmsg').inner_text())
            fr.locator('#rpt a.cell').first.click()
            fr.wait_for_selector('#pop:not(.hide)', timeout=5000)
            check('食材' in fr.locator('#popBox').inner_text(), '點矩陣金額跳出類別拆帳（食材…）')
            fr.click('#popClose')
            fin.screenshot(path=os.path.join(out_dir, 't16-1-report.png'))
            with fin.expect_download(timeout=15000) as dl:
                fr.click('#dlx')
            d = dl.value
            path = os.path.join(out_dir, d.suggested_filename)
            d.save_as(path)
            check(d.suggested_filename == '調撥月報_%s.xlsx' % ym, '下載 Excel 檔名：%s' % d.suggested_filename)
            try:
                z = zipfile.ZipFile(path)
                names = z.namelist()
                wb = z.read('xl/workbook.xml').decode('utf-8')
                check(any(n.startswith('xl/worksheets/') for n in names) and '彙總' in wb and '全部明細' in wb,
                      'Excel 是合法 .xlsx（zip 可解開）且有「彙總」「全部明細」分頁')
            except Exception as e:
                check(False, 'Excel 解不開：%r' % e)

            # ── ④ 品項記憶 ──
            click_tab(fin, '品項記憶')
            fr.wait_for_selector('#admCard:not(.hide)', timeout=5000)
            check(fr.locator('#rptCard').is_hidden() and fr.locator('#ovCard').is_hidden(), '品項記憶分頁：只有品項記憶卡片顯示')
            n_items = fr.locator('#mtab .me-name').count()
            check(n_items >= 3, '品項記憶有清單（%d 筆）' % n_items)
            old = fr.locator('#mtab .me-name').first.input_value()
            new = old + '改'
            fr.locator('#mtab .me-name').first.fill(new)
            fr.locator('#mtab .msave').first.click()
            fr.wait_for_function("() => document.querySelector('#amsg').textContent.indexOf('已更新') >= 0", timeout=15000)
            check(new in fr.locator('#mtab .me-name').evaluate_all('els => els.map(e => e.value)'), '品項改名成功：%s → %s' % (old, new))
            log = up.memory_log()
            acts = [r[2] for r in log[1:]]
            check('產月報' in acts and '品項改名' in acts, '上游「會計操作紀錄」有「產月報」「品項改名」：%s' % acts)
            who = {r[1] for r in log[1:]}
            check(who == {'財務同仁（fin1）（管理系統）'}, '操作人是登入的那位同仁（由平台決定，不是「會計專區」）：%s' % who)
            check(('adminUpdate', 'memoryEdit', 'fin1') in mock.transfer_calls, '代轉收到 adminUpdate／memoryEdit（操作人 fin1）')
            fin.screenshot(path=os.path.join(out_dir, 't16-2-memory.png'))

            # ── ⑤ 卡關總覽 ──
            click_tab(fin, '卡關總覽')
            fr.wait_for_selector('#ovCard:not(.hide)', timeout=5000)
            fr.wait_for_selector('#ovOverdue .ovrow', timeout=15000)
            check(fr.locator('#rptCard').is_hidden() and fr.locator('#admCard').is_hidden(), '卡關總覽分頁：只有總覽卡片顯示')
            rows = fr.locator('#ovOverdue .ovrow')
            check(rows.count() == 1 and up.overdue_no in rows.first.inner_text(), '逾期未簽收列出那一張：%s' % up.overdue_no)
            check('逾期' in rows.first.inner_text(), '逾期列有「逾期 N 天」標籤')
            rows.first.click()
            fr.wait_for_selector('#pop:not(.hide)', timeout=10000)
            box = fr.locator('#popBox')
            check('單據明細（唯讀）' in box.inner_text() and up.overdue_no in box.inner_text(), '點一列跳到單據明細（唯讀），單號對')
            check(box.locator('button').all_inner_texts() == ['關閉'], '明細彈窗只有「關閉」鈕、沒有任何動作鈕，實際：%s' % box.locator('button').all_inner_texts())
            check('辣椒粉' in box.inner_text(), '明細有品項（辣椒粉）')
            fin.screenshot(path=os.path.join(out_dir, 't16-3-overview.png'))
            fr.click('#popClose')
            check(('getDoc' in [c[0] for c in up.calls]) and ('adminOverview' in [c[0] for c in up.calls]), '上游收到 adminOverview 與 getDoc')
            check(not any(c[0] in ('ship', 'receive', 'amend', 'deleteDoc', 'createDraft', 'updateDraft') for c in up.calls[-6:]), '總覽沒有送出任何單據動作')

            # ── ⑥ keepAlive：切去收支管理再回來，iframe 不重載 ──
            fr.evaluate("() => { window.__t16mark = 'kept'; }")
            fin.click('[data-role="nav-desktop"] [data-nav="cashbook"]')
            fin.wait_for_selector('[data-keep="cashbook"]:not([hidden])', timeout=10000)
            check(fin.locator(KEEP).count() == 1 and not fin.locator(KEEP).is_visible(), '切走後調撥管理容器還在、只是藏起來')
            fin.click('[data-role="nav-desktop"] [data-nav="transfer-fin"]')
            fin.wait_for_selector(KEEP + ':not([hidden])', timeout=10000)
            fr2 = child_frame(fin)
            check(fr2 is not None and fr2.evaluate("() => window.__t16mark") == 'kept', '回到調撥管理：iframe 沒有重載（keepAlive）')
            check(fin.locator(KEEP + ' iframe[data-role="transfer-frame"]').count() == 1, '只有一個 iframe（沒有重複掛載）')

            # ⑧ 代轉守門（白名單、op 限制、沒權限 FORBIDDEN）不在這裡驗：這支 e2e 的代轉是 Python mock，驗了也不代表真程式。
            #    真正守門的是 test/proxy-authorize.test.mjs 第 18 節（Auth.gs）與 minikit test/runner/proxy.test.js（proxy-hook）。

            # ── ⑦ 試跑模式 ──
            writes_before = len([c for c in up.calls if c[0] in WRITE_ACTIONS])
            dr = new_page('?dryrun=1')
            do_login(dr, 'fin1')
            dr.click('[data-role="nav-desktop"] [data-nav="transfer-fin"]')
            dr.wait_for_selector(KEEP + ' iframe[data-role="transfer-frame"]', timeout=10000)
            dfr = child_frame(dr)
            dfr.wait_for_selector('#rptCard:not(.hide)', timeout=15000)
            check(dfr.locator('#ym').is_visible(), '試跑模式：看得到月報頁（讀取照常）')
            dfr.click('#gen')
            dr.wait_for_timeout(2000)
            check(dfr.locator('#rpt table.mtx').count() == 0, '試跑模式：產月報被攔下，沒有矩陣')
            check('試跑' in dfr.locator('#rmsg').inner_text(), '試跑模式：畫面提示「試跑模式，未寫入」：%s' % dfr.locator('#rmsg').inner_text())
            click_tab(dr, '品項記憶')
            dfr.wait_for_selector('#admCard:not(.hide)', timeout=5000)
            check(dfr.locator('#mtab .me-name').count() >= 3, '試跑模式：品項記憶（讀取）照常看得到')
            click_tab(dr, '卡關總覽')
            dfr.wait_for_selector('#ovOverdue .ovrow', timeout=15000)
            check(dfr.locator('#ovOverdue .ovrow').count() == 1, '試跑模式：卡關總覽（讀取）照常看得到')
            writes_after = len([c for c in up.calls if c[0] in WRITE_ACTIONS])
            check(writes_after == writes_before, '試跑模式：上游沒有收到任何寫入（%d→%d）' % (writes_before, writes_after))
            dr.screenshot(path=os.path.join(out_dir, 't16-4-dryrun.png'))

            browser.close()

        check(mock.leaked == [], '零流出：沒有未被涵蓋的外部請求、前端沒夾帶密碼／token／operator，實際：%s' % mock.leaked)
        check(stray == [], '調撥會計頁網域只取了 report.html：%s' % stray)
        print('截圖與下載檔：' + out_dir)
    finally:
        httpd.shutdown()
        up.close()
    finish()


if __name__ == '__main__':
    main()
