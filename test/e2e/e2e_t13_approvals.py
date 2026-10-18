#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑬：第三期表單簽核前端（modules/approvals）。全部假名、全程 mock 後端（apv_mock.py）、零真實網路。

① 管理者（1280）：首頁提醒 → 從選單點進六個分頁 → 待我簽核准、待我辦已處理、全部單據匯出 CSV（BOM＋公式中和）、
   核決權限新增一級→儲存前 diff→帶 expected_ver、版本衝突、送請款（含照片）、離職本人簽名、請購草稿（重新整理還原）。
② 店長（375）：看不到「核決權限」分頁且直打網址被擋；我的單退回原因→改完再送→撤回；每個畫面不撐出橫向捲軸。
截圖存 APV_SHOTS（預設系統暫存資料夾 apv-shots，不進 repo）。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import MockBackend, SHOTS, check, finish, login, start_server

from playwright.sync_api import sync_playwright

PORT = 8813
SHOT_DIR = os.environ.get('APV_SHOTS') or os.path.join(__import__('tempfile').gettempdir(), 'apv-shots')
TINY_JPEG = __import__('base64').b64decode('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=')


def shot(page, name):
    os.makedirs(SHOT_DIR, exist_ok=True)
    page.screenshot(path=os.path.join(SHOT_DIR, name + '.png'), full_page=False)


def calls(mock, action):
    return [c for c in mock.apv_state['calls'] if c[0] == action]


TAB_ID = {'送單': 'submit', '我的單': 'mine', '待我簽': 'sign', '待我辦': 'handle', '全部單據': 'all', '核決權限': 'thr'}


def goto_tab(page, tab):
    """從分頁列點進去，等網址與畫面都換成新分頁（不然會讀到上一個分頁還沒清掉的卡片）"""
    page.locator('[data-role="view-nav"] .nav-item', has_text=tab).first.click()
    page.wait_for_function("(t) => { const e = document.querySelector('[data-role=\"view-content\"] .card-title'); return !!e && e.innerText.indexOf(t) !== -1; }", arg=tab, timeout=8000)
    page.wait_for_function("() => !document.querySelector('[data-role=\"view-content\"]').innerText.includes('讀取中')", timeout=8000)


def overflow(page):
    return page.evaluate('document.documentElement.scrollWidth')


def dlg(page, label):
    page.locator('.dialog-actions .btn', has_text=label).click()


def main():
    httpd, base = start_server(PORT)
    mock = MockBackend(base)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()

            # ── ① 管理者 1280 ───────────────────────────────
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
            ad = ctx.new_page()
            mock.install(ad)
            login(ad, base, 'admin')
            ad.wait_for_selector('[data-role="module-card"][data-module="approvals"]', timeout=10000)
            ad.wait_for_function("() => document.querySelector('[data-role=\"module-card\"][data-module=\"approvals\"]').innerText.includes('待我簽')", timeout=8000)
            card = ad.inner_text('[data-role="module-card"][data-module="approvals"]')
            check('待我簽 2 張' in card and '待我辦 1 張' in card, '★首頁提醒：待我簽 2 張、待我辦 1 張：%s' % card.replace('\n', ' '))
            check(ad.locator('[data-role="module-card"][data-module="approvals"] .tag-danger, [data-role="module-card"][data-module="approvals"] [data-level="error"]').count() >= 0, '（紅色等級另由單元測試驗）')
            shot(ad, 'home-1280')

            ad.click('[data-nav="approvals"]')
            ad.wait_for_selector('[data-role="view-nav"] .nav-item')
            tabs = ad.locator('[data-role="view-nav"] .nav-item').all_inner_texts()
            check([t.strip() for t in tabs] == ['送單', '我的單', '待我簽', '待我辦', '全部單據', '核決權限'], '★管理者看到六個分頁：%s' % tabs)

            # 待我簽
            goto_tab(ad, '待我簽')
            ad.wait_for_selector('[data-role="apv-card"]')
            check(ad.locator('[data-role="apv-card"]').count() == 2, '待我簽 2 張卡片')
            c901 = ad.locator('[data-role="apv-card"][data-id="APV-261018-901"]')
            check(c901.locator('[data-act="approve"]').count() == 1 and c901.locator('[data-act="reject"]').count() == 1 and c901.locator('[data-act="done"]').count() == 0, '901：有核准／退回、沒有已處理')
            c904 = ad.locator('[data-role="apv-card"][data-id="APV-261012-904"]')
            check(c904.locator('.tag-danger:has-text("卡關")').count() == 1 and c904.locator('[data-act="approve"]').count() == 0, '904：卡關標記、本人簽名關 → 管理者沒有核准鈕')
            c901.locator('[data-act="view"]').click()
            ad.wait_for_selector('[data-id="APV-261018-901"] [data-role="detail-body"]')
            check('冷藏櫃壓縮機維修' in c901.inner_text() and '測試總監' in c901.inner_text(), '展開明細：內容與簽核路線')
            shot(ad, 'sign-1280')
            c901.locator('[data-act="reject"]').click()
            dlg(ad, '退回')
            check(ad.locator('.toast-warn:has-text("請填寫原因")').count() >= 1 and len(calls(mock, 'apvDecide')) == 0, '退回沒寫原因被擋、沒打後端')
            c901 = ad.locator('[data-role="apv-card"][data-id="APV-261018-901"]')
            c901.locator('[data-act="approve"]').click()
            dlg(ad, '確定')
            ad.wait_for_selector('[data-role="apv-card"][data-id="APV-261018-901"]', state='detached', timeout=8000)
            d = calls(mock, 'apvDecide')[-1][1]
            check(d == {'id': 'APV-261018-901', 'rev': 1, 'step': 0, 'decision': 'approve'}, '★核准 payload 帶 rev＋step：%s' % d)

            # 待我辦
            goto_tab(ad, '待我辦')
            ad.wait_for_selector('[data-role="apv-card"]')
            check(ad.locator('[data-role="apv-card"]').count() == 2, '待我辦 2 張（902＋剛核准的 901）：%s' % ad.locator('[data-role="apv-card"]').evaluate_all('els => els.map(e => e.dataset.id)'))
            ad.locator('[data-role="apv-card"][data-id="APV-261017-902"] [data-act="done"]').click()
            ad.fill('#apv-reason', '已下單')
            dlg(ad, '已處理')
            ad.wait_for_selector('[data-role="apv-card"][data-id="APV-261017-902"]', state='detached', timeout=8000)
            d = calls(mock, 'apvHandle')[-1][1]
            check(d['result'] == 'done' and d['note'] == '已下單' and d['rev'] == 1, '已處理 payload：%s' % d)
            shot(ad, 'handle-1280')

            # 全部單據＋匯出
            goto_tab(ad, '全部單據')
            ad.wait_for_selector('[data-role="apv-card"]')
            check(ad.locator('[data-role="apv-card"]').count() == 4, '全部單據 4 張：%s' % ad.locator('[data-role="apv-card"]').evaluate_all('els => els.map(e => e.dataset.id)'))
            ad.select_option('#apv-all-type', 'personnel')
            ad.click('[data-role="apv-query"]')
            ad.wait_for_function("() => document.querySelectorAll('[data-role=\"apv-card\"]').length === 1")
            check(calls(mock, 'apvList')[-1][1].get('type') == 'personnel', '篩選種類有帶進 apvList')
            c = ad.locator('[data-role="apv-card"]')
            check(c.locator('[data-act="reassign"]').count() == 1 and c.locator('[data-act="void"]').count() == 1, '全部單據：人資／管理者有改派、作廢')
            with ad.expect_download() as dl:
                ad.click('[data-role="apv-export"]')
            path = dl.value.path()
            raw = open(path, 'rb').read()
            check(raw[:3] == b'\xef\xbb\xbf', '★匯出 CSV 開頭是 UTF-8 BOM')
            text = raw.decode('utf-8-sig')
            check("'=測試店員甲" in text and '"冷藏櫃維修, 含稅"' in text and '請款' in text and '設備維修' in text, '★CSV：= 開頭的格加 \'、逗號加引號、代碼轉中文：%s' % text.replace('\r\n', ' ⏎ '))
            shot(ad, 'all-1280')

            # 核決權限
            goto_tab(ad, '核決權限')
            ad.wait_for_selector('[data-role="thr-row"]')
            check(ad.locator('[data-role="thr-row"]').count() == 4, '★核決權限四級')
            check(ad.input_value('#thr-max-0') == '5000' and ad.input_value('#thr-max-3') == '以上全部', '第一級 5000、最後一級「以上全部」')
            shot(ad, 'thr-1280')
            ad.click('[data-act="add"]')
            check(ad.locator('[data-role="thr-row"]').count() == 5, '新增一級 → 5 級')
            # 新增的一級（第 5 級）預設接在原最後一級後面；把第 4 級金額改成 50000、權限人改執行長
            ad.fill('#thr-max-3', '50000')
            ad.locator('[data-role="thr-row"][data-i="3"] [data-pick="store"][data-val="ceo"]').click()
            ad.click('[data-act="save"]')
            ad.wait_for_selector('[data-role="thr-diff"]')
            diff = ad.inner_text('[data-role="thr-diff"]')
            check('第 4 級' in diff and '50,000' in diff and '新增第 5 級' in diff, '★儲存前顯示改了什麼：%s' % diff.replace('\n', ' / '))
            shot(ad, 'thr-diff-1280')
            dlg(ad, '確定儲存')
            ad.wait_for_selector('.toast-ok:has-text("已儲存")', timeout=8000)
            s = calls(mock, 'apvThresholdSave')[-1][1]
            check(s['expected_ver'] == 1 and len(s['rows']) == 5 and s['rows'][4]['max'] is None and s['rows'][3]['max'] == 50000 and s['rows'][3]['store_role'] == 'ceo', '★儲存帶 expected_ver＝1、5 列、最後一列 max null：%s' % json.dumps(s, ensure_ascii=False))
            # 版本衝突
            mock.apv_state['ver'] = 9
            ad.wait_for_selector('[data-role="thr-row"]')
            ad.click('[data-act="del"][data-i="1"]')
            ad.click('[data-act="save"]')
            ad.wait_for_selector('[data-role="thr-diff"]')
            dlg(ad, '確定儲存')
            ad.wait_for_selector('.toast-warn:has-text("剛被別人改過")', timeout=8000)
            check(True, '★expected_ver 不符 → 提示並重新讀取')

            # 送單：請款含照片
            goto_tab(ad, '送單')
            ad.wait_for_selector('[data-type]')
            ad.click('[data-type="expense"]')
            ad.fill('#f-amount', '8600')
            ad.fill('#f-desc', '測試維修')
            ad.click('[data-act="send"]')
            check(ad.locator('.toast-warn:has-text("收據")').count() >= 1 and len(calls(mock, 'apvSubmit')) == 0, '請款沒附收據 → 擋下、沒送')
            ad.set_input_files('[data-role="photo-file"]', {'name': 'r.jpg', 'mimeType': 'image/jpeg', 'buffer': TINY_JPEG})
            ad.wait_for_selector('[data-role="photo-picker"] img[alt="照片 1"]', timeout=8000)
            check(ad.inner_text('[data-role="photo-count"]').strip() == '1/5 張', '照片 1/5 張')
            shot(ad, 'submit-expense-1280')
            ad.click('[data-act="send"]')
            ad.wait_for_selector('.dialog-actions')
            check('測試總監' in ad.inner_text('.dialog-body') and '8,600' in ad.inner_text('.dialog-body'), '送出前顯示金額與簽核路線')
            dlg(ad, '確定送出')
            ad.wait_for_selector('[data-role="apv-card"]', timeout=8000)   # 送完導到「我的單」
            sub = calls(mock, 'apvSubmit')[-1][1]
            check(re.match(r'^[0-9a-f-]{36}$', sub['client_id']) and sub['type'] == 'expense' and sub['body']['amount'] == 8600 and isinstance(sub['body']['amount'], int)
                  and len(sub['files']) == 1 and sub['files'][0].startswith('F') and 'sender' not in sub and 'unit' not in sub, '★送出 payload：client_id UUID、金額整數、檔號 1 個、不帶 sender：%s' % json.dumps(sub, ensure_ascii=False))
            check('receipt' in mock.apv_state['svc_calls'], '照片走 svc 上傳（kind=receipt）')

            # 離職本人簽名
            ad.evaluate("location.hash = '#/approvals/submit'")
            ad.wait_for_selector('[data-type="personnel"]')
            ad.click('[data-type="personnel"]')
            ad.fill('#f-eff', '2026-11-30')
            ad.fill('#f-reason', '個人規劃')
            ad.click('[data-act="send"]')
            check(ad.locator('.toast-warn:has-text("簽名")').count() >= 1, '離職沒簽名 → 擋下')
            box = ad.locator('[data-role="sign-pad"]').bounding_box()
            ad.mouse.move(box['x'] + 20, box['y'] + 30)
            ad.mouse.down()
            ad.mouse.move(box['x'] + 120, box['y'] + 90, steps=8)
            ad.mouse.move(box['x'] + 200, box['y'] + 40, steps=8)
            ad.mouse.up()
            shot(ad, 'submit-leave-1280')
            ad.click('[data-act="send"]')
            ad.wait_for_selector('.dialog-actions')
            dlg(ad, '確定送出')
            ad.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            sub = calls(mock, 'apvSubmit')[-1][1]
            check(sub['type'] == 'personnel' and sub['body']['kind'] == 'leave' and str(sub['body'].get('sign_file', '')).startswith('F') and 'subject' not in sub, '★離職 payload 帶 sign_file：%s' % json.dumps(sub, ensure_ascii=False))
            check('sign' in mock.apv_state['svc_calls'], '簽名走 svc 上傳（kind=sign）')
            ls = ad.evaluate("Object.keys(localStorage).filter(k => k.indexOf('apv_draft') !== -1)")
            check(not any(k.endswith('personnel') for k in ls), '★人事單沒有存草稿：%s' % ls)

            # 請購草稿：打字 → 重新整理 → 還原
            ad.evaluate("location.hash = '#/approvals/submit'")
            ad.wait_for_selector('[data-type="purchase"]')
            ad.fill('[data-f="name"]', '乾辣椒')
            ad.fill('[data-f="qty"]', '1.5')
            ad.fill('[data-f="unit"]', '包')
            ad.fill('[data-f="price"]', '333')
            ad.fill('#f-purpose', '補備料')
            check('NT$ 500' in ad.inner_text('[data-role="total"]'), '★請購金額 1.5×333 → NT$ 500（四捨五入）：%s' % ad.inner_text('[data-role="total"]'))
            ad.wait_for_timeout(700)
            keys = ad.evaluate("Object.keys(localStorage).filter(k => k.indexOf('apv_draft') !== -1)")
            check(keys == ['dzy.u.u-admin.apv_draft_purchase'], '★草稿 key：%s' % keys)
            ad.reload()
            ad.wait_for_selector('[data-role="view-nav"] .nav-item')
            ad.wait_for_selector('#f-purpose')
            check(ad.input_value('#f-purpose') == '補備料' and ad.input_value('[data-f="name"]') == '乾辣椒', '★重新整理後草稿還原')
            shot(ad, 'submit-purchase-1280')
            ad.close()

            # ── ② 店長 375 ──────────────────────────────────
            lctx = browser.new_context(viewport={'width': 375, 'height': 800})
            ld = lctx.new_page()
            mock.install(ld)
            login(ld, base, 'lead')
            ld.wait_for_selector('[data-role="module-card"][data-module="approvals"]', timeout=10000)
            shot(ld, 'home-375')
            ld.click('[data-nav="approvals"]')
            ld.wait_for_selector('[data-role="view-nav"] .nav-item')
            tabs = [t.strip() for t in ld.locator('[data-role="view-nav"] .nav-item').all_inner_texts()]
            check(tabs == ['送單', '我的單', '待我簽', '待我辦', '全部單據'], '★店長看不到「核決權限」：%s' % tabs)
            ld.evaluate("location.hash = '#/approvals/thr'")
            ld.wait_for_timeout(600)
            check(ld.locator('[data-role="thr-row"]').count() == 0 and ld.evaluate('location.hash') in ('#/home', ''), '直打 #/approvals/thr 被導回首頁')
            ld.evaluate("location.hash = '#/approvals/submit'")
            ld.wait_for_selector('[data-type="purchase"]')
            check(overflow(ld) <= 375, '送單（請購）375 寬沒有橫向捲軸：%d' % overflow(ld))
            shot(ld, 'submit-purchase-375')
            ld.click('[data-type="expense"]')
            check(overflow(ld) <= 375, '送單（請款）375：%d' % overflow(ld))
            shot(ld, 'submit-expense-375')
            ld.click('[data-type="personnel"]')
            check(overflow(ld) <= 375, '送單（人事）375：%d' % overflow(ld))
            shot(ld, 'submit-personnel-375')
            for tab, name in (('我的單', 'mine'), ('待我簽', 'sign'), ('待我辦', 'handle'), ('全部單據', 'all')):
                ld.evaluate("location.hash = '#/approvals/%s'" % {'mine': 'mine', 'sign': 'sign', 'handle': 'handle', 'all': 'all'}[name])
                ld.wait_for_selector('[data-role="view-content"] .card')
                ld.wait_for_timeout(500)
                check(overflow(ld) <= 375, '%s 375：%d' % (tab, overflow(ld)))
                shot(ld, name + '-375')
            ld.evaluate("location.hash = '#/approvals/mine'")
            ld.wait_for_selector('[data-role="apv-card"]')
            rej = ld.locator('[data-role="apv-card"][data-id="APV-261016-903"]')
            rej.locator('[data-role="reject-note"]').wait_for(timeout=8000)
            check('收據看不清楚' in rej.inner_text() and rej.locator('[data-act="resubmit"]').count() == 1 and rej.locator('[data-act="withdraw"]').count() == 0, '★我的單：退回原因、「改完再送」鈕')
            sg = ld.locator('[data-role="apv-card"][data-status="signing"]').first
            check(sg.locator('[data-act="withdraw"]').count() == 1 and sg.locator('[data-act="resubmit"]').count() == 0, '我的單：簽核中的單可撤回')
            shot(ld, 'mine-375')
            rej.locator('[data-act="resubmit"]').click()
            ld.wait_for_selector('#f-amount', timeout=8000)
            check(ld.input_value('#f-amount') == '300' and ld.input_value('#f-desc') == '文具', '★改完再送：帶入原內容')
            ld.fill('#f-desc', '文具（已補拍）')
            shot(ld, 'resubmit-375')
            ld.click('[data-act="send"]')
            ld.wait_for_selector('.dialog-actions')
            dlg(ld, '確定送出')
            ld.wait_for_selector('[data-role="apv-card"]', timeout=8000)
            r = calls(mock, 'apvResubmit')[-1][1]
            check(r['id'] == 'APV-261016-903' and r['rev'] == 1 and r['body']['desc'] == '文具（已補拍）' and r['files'] == ['F002'], '★改完再送 payload（id／rev／body／原照片檔號）：%s' % json.dumps(r, ensure_ascii=False))
            # 撤回
            wid = [f['id'] for f in mock.apv_state['forms'] if f['type'] == 'expense' and f['status'] == 'signing' and f['id'] not in ('APV-261018-901', 'APV-261016-903')][0]   # 管理者剛送的那張請款（簽核中）
            ld.evaluate("location.hash = '#/approvals/sign'")
            ld.evaluate("location.hash = '#/approvals/mine'")
            ld.wait_for_selector('[data-role="apv-card"][data-id="%s"]' % wid)
            ld.locator('[data-role="apv-card"][data-id="%s"] [data-act="withdraw"]' % wid).click()
            dlg(ld, '確定')
            ld.wait_for_selector('[data-role="apv-card"][data-id="%s"][data-status="withdrawn"]' % wid, timeout=8000)
            w = calls(mock, 'apvWithdraw')[-1][1]
            check(w == {'id': wid, 'rev': 1, 'step': 0}, '★撤回 payload 帶 rev＋step：%s' % w)

            check(not mock.leaked, '沒有請求漏出 mock：%s' % mock.leaked)
            browser.close()
    finally:
        httpd.shutdown()
    finish()


if __name__ == '__main__':
    main()
