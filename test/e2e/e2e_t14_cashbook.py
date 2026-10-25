#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑭：收支管理（財務部門，2026-10-24；規格 docs/cashbook-fin/spec.md §7、§9）。

全程 mock（cashbook_mock.py 模擬 Mac mini 代轉＋現金帳管理通道），零真實資料。驗：
  ① 有 cashbook.write 的同仁選單與首頁有「收支管理」、四個分頁都點得到；沒權限的人看不到選單與卡片，也沒打任何 cashbook 代轉。
  ② 收支明細：選店選月、清單與合計（不含作廢）、點一列展開（照片）、作廢流程（沒填原因擋下、填了才送；操作人不由瀏覽器帶）。
  ③ 月結鎖定：十二個月、店長鎖定／會計鎖定顯示；鎖定、解鎖（二次確認）；鎖定後明細的作廢鈕消失。
  ④ 匯出 Excel：真的下載 .xlsx（zip 可解開）、檔名、列數與合計正確（不含作廢）。
  ⑤ 會計科目：編輯、儲存前顯示差異、只送科目欄位（沒有通行碼欄位）。
  ⑥ 試跑模式（?dryrun=1）：作廢不會真的送出。
  ⑦ 首頁提醒（假時鐘 2026-10-05）：上個月沒被會計鎖的店 → 「新竹光復 9 月還沒月結」，點了到月結鎖定、店別帶入。
"""
import os
import re
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import USERS, MockBackend, check, finish, start_server

from playwright.sync_api import sync_playwright

PORT = 8819
KEEP = '[data-keep="cashbook"]'
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082')
FAKE_DATE = """(() => { const R = Date; const fixed = new R('2026-10-05T12:00:00+08:00').getTime();
  class D extends R { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  window.Date = D; })();"""


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    mk = lambda name, perms: {'password': 'e2e-pw', 'perms': perms, 'user': {'id': 'u-' + name, 'name': name, 'role': 'staff', 'node': ''}}
    USERS['fin1'] = mk('會計甲', ['platform.self', 'cashbook.write'])
    USERS['nofin'] = mk('同仁乙', ['platform.self'])
    out_dir = tempfile.mkdtemp(prefix='cashbook-e2e-')   # 截圖與下載檔放暫存資料夾，不進 repo
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def new_page(date=False, query=''):
                ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
                pg = ctx.new_page()
                mock.install(pg)
                pg.route('https://example.test/**', lambda r: r.fulfill(status=200, content_type='image/png', body=PNG))
                if date:
                    pg.add_init_script(FAKE_DATE)
                pg.goto(base + '/index.html' + query)
                return pg

            def do_login(pg, user):
                pg.fill('#login-username', user)
                pg.fill('#login-password', USERS[user]['password'])
                pg.click('[data-role="submit"]')
                pg.wait_for_selector('[data-role="module-card"]', state='attached', timeout=10000)

            def st():
                return mock.cashbook_state

            def calls(action):
                return [c for c in st()['calls'] if c[0] == action]

            def tab(pg, name):
                pg.locator('[data-role="view-nav"] .nav-item', has_text=name).click()

            # ====== ① 沒有權限的人：沒有選單、沒有卡片、沒打 cashbook ======
            nf = new_page()
            do_login(nf, 'nofin')
            ids = [c.get_attribute('data-module') for c in nf.locator('[data-role="module-card"]').all()]
            check('cashbook' not in ids, '沒有 cashbook.write：首頁沒有收支管理卡片，實際：%s' % ids)
            check(nf.locator('[data-nav="cashbook"]').count() == 0, '沒有 cashbook.write：左側選單沒有「收支管理」')
            nf.wait_for_timeout(500)
            check(not [c for c in getattr(mock, 'proxy_calls', []) if c[0] == 'cashbook'], '沒有權限的人沒有打任何 cashbook 代轉：%s' % getattr(mock, 'proxy_calls', []))
            nf.goto(base + '/index.html#/cashbook/rows')
            nf.wait_for_timeout(800)
            check(nf.locator(KEEP).count() == 0 and nf.locator('[data-role="cb-table"]').count() == 0, '直接輸入 #/cashbook/rows：模組不會載入、畫面沒有收支資料')
            nf.context.close()

            # ====== ② 財務同仁：選單、四個分頁 ======
            pg = new_page()
            do_login(pg, 'fin1')
            ids = [c.get_attribute('data-module') for c in pg.locator('[data-role="module-card"]').all()]
            check('cashbook' in ids, '有 cashbook.write：首頁有收支管理卡片：%s' % ids)
            check(pg.locator('[data-nav="cashbook"]').count() == 1, '左側選單有「收支管理」')
            grp = pg.evaluate("() => { const b = document.querySelector('[data-role=\"nav-desktop\"] [data-nav=cashbook]'); const g = b && b.closest('.nav-dept'); return g ? g.textContent : ''; }")
            check('財務部門' in grp, '選單掛在「財務部門」底下：%s' % grp[:30])
            pg.click('[data-nav="cashbook"]')
            pg.wait_for_selector(KEEP + ' [data-role="cb-table"]', timeout=10000)
            names = [x.replace('\n', '') for x in pg.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(names == ['收支明細', '月結鎖定', '匯出 Excel', '會計科目'], '頁頂四個分頁：%s' % names)
            check(pg.locator('[data-role="cb-store"] option').all_inner_texts() == ['新竹光復', '台中美村'], '店別選單：現金帳裡有帳的店（%s）' % pg.locator('[data-role="cb-store"] option').all_inner_texts())
            check(pg.evaluate('location.hash') == '#/cashbook/rows', '網址 #/cashbook/rows：%s' % pg.evaluate('location.hash'))
            pg.screenshot(path=os.path.join(out_dir, 'rows-1280.png'))

            # ====== ③ 收支明細 ======
            cur = st()['cur']
            pg.select_option(KEEP + ' [data-role="cb-month"]', cur)
            pg.wait_for_function("(m) => { const t = document.querySelector('[data-keep=cashbook] [data-role=cb-table]'); return t && t.querySelectorAll('[data-role=cb-row]').length === 3 && document.querySelector('[data-keep=cashbook] .card-title').textContent.includes(m); }", arg=cur)
            rows_txt = pg.locator(KEEP + ' [data-role="cb-row"]').all_inner_texts()
            check(len(rows_txt) == 3 and '青菜' in rows_txt[0] and '1,000' in rows_txt[0] and '作廢' in rows_txt[2], '清單三筆（含一筆作廢）：%s' % rows_txt)
            sm = pg.locator(KEEP + ' [data-role="cb-sum"]').inner_text()
            check('支出 1,000' in sm and '收入 400' in sm and '淨額 -600' in sm and '4 筆' not in sm and '2 筆' in sm, '合計不含作廢（支出 1,000、收入 400、淨額 -600）：%s' % sm)
            check(pg.locator(KEEP + ' [data-role="cb-locked"]').inner_text() == '本月未鎖定', '本月未鎖定')
            check(pg.locator(KEEP + ' [data-act="void"]').count() == 0, '沒展開時沒有作廢鈕')
            pg.locator(KEEP + ' [data-role="cb-row"]').nth(0).click()
            pg.wait_for_selector(KEEP + ' [data-role="cb-detail"]')
            pg.wait_for_function("() => { const i = document.querySelector('[data-keep=cashbook] [data-role=cb-detail] img'); return i && i.complete && i.naturalWidth > 0; }")
            check(True, '展開後顯示收據照片縮圖（img 載入）')
            check(pg.locator(KEEP + ' [data-act="void"]').count() == 1, '正常的一筆有作廢鈕')
            pg.locator(KEEP + ' [data-role="cb-row"]').nth(2).click()   # 作廢的那筆
            pg.wait_for_selector(KEEP + ' [data-role="cb-detail"]')
            det = pg.locator(KEEP + ' [data-role="cb-detail"]').inner_text()
            check('重複登記' in det and pg.locator(KEEP + ' [data-act="void"]').count() == 0, '已作廢的一筆：看得到原因、沒有作廢鈕：%s' % det)
            pg.locator(KEEP + ' [data-role="cb-row"]').nth(0).click()   # 換展開第一筆
            pg.wait_for_selector(KEEP + ' [data-act="void"]')

            # 作廢：先不填原因 → 擋下（不送）；再填 → 送出
            pg.click(KEEP + ' [data-act="void"]')
            pg.wait_for_selector('.dialog [data-role="cb-void-reason"]')
            pg.click('.dialog .btn-danger')
            pg.wait_for_selector('.toast:has-text("請填作廢原因")')
            check(len(calls('adminVoid')) == 0, '沒填原因：不會送出作廢')
            pg.wait_for_selector('.dialog [data-role="cb-void-reason"]')
            pg.fill('.dialog [data-role="cb-void-reason"]', '店長登記錯店')
            pg.click('.dialog .btn-danger')
            pg.wait_for_function("() => document.querySelectorAll('[data-keep=cashbook] [data-role=cb-row]')[0].textContent.includes('作廢')")
            v = calls('adminVoid')
            check(len(v) == 1 and v[0][1].get('store') == 'gf' and v[0][1].get('reason') == '店長登記錯店' and v[0][1].get('id'), '送出 adminVoid{store,id,reason}：%s' % v)
            check(set(v[0][1].keys()) == {'store', 'id', 'reason'}, '作廢只帶 store／id／reason（操作人由平台決定，瀏覽器不帶）：%s' % list(v[0][1].keys()))
            sm = pg.locator(KEEP + ' [data-role="cb-sum"]').inner_text()
            check('支出 0' in sm and '收入 400' in sm and '1 筆' in sm, '作廢後合計重算（支出 0、收入 400、1 筆）：%s' % sm)
            rowobj = next(r for r in st()['rows']['gf'] if r['id'] == v[0][1]['id'])
            check(rowobj['status'] == '作廢' and rowobj['voidedBy'] == '會計甲（fin1）（管理系統）', '後端記下的作廢人＝平台依登入身分決定：%s' % rowobj['voidedBy'])

            # ====== ④ 月結鎖定 ======
            tab(pg, '月結鎖定')
            pg.wait_for_selector(KEEP + ' [data-role="cb-lock-table"]')
            check(pg.locator(KEEP + ' [data-role="cb-lock-row"]').count() == 12, '最近 12 個月')
            last = st()['last']
            rec = pg.locator(KEEP + ' [data-role="cb-lock-row"][data-month="%s"]' % last).inner_text()
            check('店長鎖定' in rec and '店長' in rec, '上個月是店長鎖的：%s' % rec)
            row_cur = KEEP + ' [data-role="cb-lock-row"][data-month="%s"]' % cur
            check(pg.locator(row_cur).get_attribute('data-kind') == 'none' and pg.locator(row_cur + ' [data-act="lock"]').count() == 1, '本月未鎖、有「鎖定」鈕')
            pg.screenshot(path=os.path.join(out_dir, 'lock-1280.png'))
            pg.click(row_cur + ' [data-act="lock"]')
            pg.wait_for_selector('.dialog')
            pg.click('.dialog .btn-primary')
            pg.wait_for_selector(row_cur + '[data-kind="acct"]')
            lk = calls('adminLock')
            check(len(lk) == 1 and lk[0][1] == {'store': 'gf', 'month': cur}, '送出 adminLock{store,month}：%s' % lk)
            check('會計鎖定' in pg.locator(row_cur).inner_text() and '會計甲' in pg.locator(row_cur).inner_text(), '本月顯示「會計鎖定」＋誰：%s' % pg.locator(row_cur).inner_text())

            # 鎖定後明細：作廢鈕消失
            tab(pg, '收支明細')
            pg.wait_for_selector(KEEP + ' [data-role="cb-table"]')
            pg.wait_for_function("() => document.querySelector('[data-keep=cashbook] [data-role=cb-locked]')?.textContent.includes('已月結鎖定')")
            pg.locator(KEEP + ' [data-role="cb-row"]').nth(1).click()
            pg.wait_for_selector(KEEP + ' [data-role="cb-detail"]')
            check(pg.locator(KEEP + ' [data-act="void"]').count() == 0, '鎖定後：正常的一筆也沒有作廢鈕')

            # 解鎖：二次確認（先取消第二次 → 不解；再兩次都確定 → 解）
            tab(pg, '月結鎖定')
            pg.wait_for_selector(row_cur + '[data-kind="acct"]')
            pg.click(row_cur + ' [data-act="unlock"]')
            pg.wait_for_selector('.dialog'); pg.click('.dialog .btn-primary')          # 第一次確定
            pg.wait_for_selector('.dialog:has-text("再確認一次")'); pg.click('.dialog .btn-secondary')   # 第二次取消
            pg.wait_for_timeout(300)
            check(len(calls('adminUnlock')) == 0 and pg.locator(row_cur).get_attribute('data-kind') == 'acct', '解鎖要二次確認：第二次取消 → 沒送、仍是鎖定')
            pg.click(row_cur + ' [data-act="unlock"]')
            pg.wait_for_selector('.dialog'); pg.click('.dialog .btn-primary')
            pg.wait_for_selector('.dialog:has-text("再確認一次")'); pg.click('.dialog .btn-primary')
            pg.wait_for_selector(row_cur + '[data-kind="none"]')
            ul = calls('adminUnlock')
            check(len(ul) == 1 and ul[0][1] == {'store': 'gf', 'month': cur}, '兩次確定後送出 adminUnlock：%s' % ul)

            # ====== ⑤ 匯出 Excel ======
            tab(pg, '匯出 Excel')
            pg.wait_for_selector(KEEP + ' [data-role="cb-export-btn"]')
            pg.select_option(KEEP + ' [data-role="cb-month"]', cur)
            with pg.expect_download(timeout=15000) as dl:
                pg.click(KEEP + ' [data-role="cb-export-btn"]')
            d = dl.value
            check(d.suggested_filename == '現金收支_新竹光復_%s.xlsx' % cur, '檔名：%s' % d.suggested_filename)
            path = os.path.join(out_dir, 'export.xlsx')
            d.save_as(path)
            z = zipfile.ZipFile(path)
            names_z = z.namelist()
            check('xl/workbook.xml' in names_z and any(n.startswith('xl/worksheets/sheet1') for n in names_z), 'xlsx 可解開（zip）：%s' % names_z[:6])
            wbx = z.read('xl/workbook.xml').decode('utf-8')
            check('name="明細"' in wbx, '工作表名「明細」')
            sheet = z.read('xl/worksheets/sheet1.xml').decode('utf-8')
            shared = z.read('xl/sharedStrings.xml').decode('utf-8') if 'xl/sharedStrings.xml' in names_z else ''
            sis = re.findall(r'<si>(.*?)</si>', shared, re.S)
            strs = [''.join(re.findall(r'<t[^>]*>(.*?)</t>', s, re.S)) for s in sis]
            cells = {}
            for m in re.finditer(r'<c r="([A-Z]+\d+)"([^>]*?)(?:/>|>(.*?)</c>)', sheet, re.S):
                ref, attrs, inner = m.group(1), m.group(2), m.group(3) or ''
                vm = re.search(r'<v>(.*?)</v>', inner)
                im = re.search(r'<is>.*?<t[^>]*>(.*?)</t>', inner, re.S)
                if 't="s"' in attrs and vm:
                    cells[ref] = strs[int(vm.group(1))]
                elif im:
                    cells[ref] = im.group(1)
                elif vm:
                    cells[ref] = vm.group(1)
            data_rows = sorted({int(re.sub(r'[A-Z]', '', k)) for k in cells if re.sub(r'[A-Z]', '', k).isdigit()})
            check(cells.get('A1') == '店別' and cells.get('M1') == '登記時間', '表頭十三欄（A1 店別 … M1 登記時間）')
            # 本月三筆：一筆剛作廢、一筆正常收入 400、一筆原本就作廢 → 匯出只剩收入 400；之後合計三列
            check(cells.get('D2') == '其他收入' and cells.get('H2') == '400' and cells.get('C2') == '收入', '資料列只有未作廢的一筆（收入 400）：%s' % {k: cells[k] for k in ('C2', 'D2', 'H2') if k in cells})
            check(cells.get('A3') is None and cells.get('A4') == '支出合計' and cells.get('H4') == '0' and cells.get('A5') == '收入合計' and cells.get('H5') == '400' and cells.get('A6') == '淨額' and cells.get('H6') == '400',
                  '空一列後三列合計（支出 0、收入 400、淨額 400）：%s' % {k: cells.get(k) for k in ('A3', 'A4', 'H4', 'A5', 'H5', 'A6', 'H6')})
            check('已匯出' in pg.locator(KEEP + ' [data-role="cb-msg"]').inner_text(), '畫面顯示已匯出：%s' % pg.locator(KEEP + ' [data-role="cb-msg"]').inner_text())

            # ====== ⑥ 會計科目 ======
            tab(pg, '會計科目')
            pg.wait_for_selector(KEEP + ' [data-role="cb-sub-exp"]')
            check(pg.locator(KEEP + ' [data-role="cb-sub-exp"]').input_value() == '食材\n雜支\n人事' and pg.locator(KEEP + ' [data-role="cb-sub-inc"]').input_value() == '其他收入', '兩個清單載入現有科目')
            pg.fill(KEEP + ' [data-role="cb-sub-exp"]', '食材\n雜支\n水電')
            pg.click(KEEP + ' [data-role="cb-sub-save"]')
            pg.wait_for_selector('.dialog [data-role="cb-sub-diff"]')
            dtxt = pg.locator('.dialog [data-role="cb-sub-diff"]').inner_text()
            check('新增：水電' in dtxt and '刪除：人事' in dtxt, '儲存前顯示差異：%s' % dtxt)
            pg.click('.dialog .btn-primary')
            pg.wait_for_selector('.toast:has-text("已儲存")')
            sv = calls('adminSave')
            check(len(sv) == 1 and set(sv[0][1].keys()) == {'expenseSubjects', 'incomeSubjects'} and sv[0][1]['expenseSubjects'] == ['食材', '雜支', '水電'], '只送科目兩欄（沒有通行碼欄位）：%s' % sv)
            pg.fill(KEEP + ' [data-role="cb-sub-exp"]', '')
            pg.click(KEEP + ' [data-role="cb-sub-save"]')
            pg.wait_for_selector('.toast:has-text("至少要有 1 個科目")')
            check(len(calls('adminSave')) == 1, '科目清單空的：擋下、不送')

            check(st()['leaked'] == [], '瀏覽器送出的內容沒有 operator／金鑰／通行碼欄位：%s' % st()['leaked'])
            pg.context.close()

            # ====== ⑦ 試跑模式 ======
            dr = new_page(query='?dryrun=1')
            do_login(dr, 'fin1')
            dr.click('[data-nav="cashbook"]')
            dr.wait_for_selector(KEEP + ' [data-role="cb-table"]')
            dr.select_option(KEEP + ' [data-role="cb-month"]', cur)
            dr.wait_for_function("() => document.querySelectorAll('[data-keep=cashbook] [data-role=cb-row]').length === 3")
            n_v = len(calls('adminVoid'))
            dr.locator(KEEP + ' [data-role="cb-row"]').nth(1).click()
            dr.wait_for_selector(KEEP + ' [data-act="void"]')
            dr.click(KEEP + ' [data-act="void"]')
            dr.wait_for_selector('.dialog [data-role="cb-void-reason"]')
            dr.fill('.dialog [data-role="cb-void-reason"]', '試跑')
            dr.click('.dialog .btn-danger')
            dr.wait_for_selector('.toast:has-text("試跑模式")')
            check(len(calls('adminVoid')) == n_v, '試跑模式：作廢沒有真的送出')
            dr.context.close()

            # ====== ⑧ 首頁提醒（假時鐘 2026-10-05）======
            al = new_page(date=True)
            do_login(al, 'fin1')
            al.wait_for_selector('[data-role="alert-list"][data-module="cashbook"] :text("還沒月結")', timeout=10000)
            txt = al.locator('[data-role="alert-list"][data-module="cashbook"]').inner_text()
            check('新竹光復 9 月還沒月結' in txt and '台中美村' not in txt, '首頁提醒：上個月沒被會計鎖的店（光復），已被會計鎖的美村不提醒：%s' % txt)
            al.locator('[data-role="alert-list"][data-module="cashbook"] :text("還沒月結")').first.click()
            al.wait_for_selector(KEEP + ' [data-role="cb-lock-table"]')
            check(al.evaluate('location.hash').startswith('#/cashbook/lock') and al.locator(KEEP + ' [data-role="cb-store"]').input_value() == 'gf', '點提醒到月結鎖定、店別帶入光復：%s' % al.evaluate('location.hash'))
            al.context.close()

            browser.close()

        check(mock.leaked == [], '真實網路零流出：%s' % mock.leaked)
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
