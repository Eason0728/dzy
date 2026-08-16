#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""e2e ⑤：稽核既有八支 node 測試全過（task.md T4-1 第 ⑤ 條）。

八支的分佈照 docs/plan.md「既有測試怎麼搬」定案：
- 測前端純函式的四支 → 已搬進 ~/dzy/test/（只改過 require 路徑，斷言一行沒動）
- 測後端 .gs 的四支 → 留在 ~/mala-audit/test/ 原地（後端本來就不搬）

這支 runner 把八支各自用 node 跑一輪，任何一支非零退出即整體失敗。
不打網路（八支本來就全是本機測試）。
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import check, finish

DZY = os.path.expanduser('~/dzy')
MALA_AUDIT = os.path.expanduser('~/mala-audit')

SUITE = [
    # (執行目錄, 測試檔, 標籤)
    (DZY, 'test/audit-format.test.js', '前端純函式 format（搬入 dzy）'),
    (DZY, 'test/audit-api.mock.test.js', '前端純函式 api.mock（搬入 dzy）'),
    (DZY, 'test/audit-sampling.test.js', '前端純函式 sampling（搬入 dzy）'),
    (DZY, 'test/audit-ops-format.test.js', '前端純函式 ops-format（搬入 dzy）'),
    (MALA_AUDIT, 'test/gas-core.test.js', '後端 gas-core（原地 ~/mala-audit）'),
    (MALA_AUDIT, 'test/gas-submit.test.js', '後端 gas-submit（原地 ~/mala-audit）'),
    (MALA_AUDIT, 'test/gas-import.test.js', '後端 gas-import（原地 ~/mala-audit）'),
    (MALA_AUDIT, 'test/gas-ops.test.js', '後端 gas-ops（原地 ~/mala-audit）'),
]


def main():
    for cwd, rel, label in SUITE:
        path = os.path.join(cwd, rel)
        if not os.path.exists(path):
            check(False, '%s：檔案不存在 %s' % (label, path))
            continue
        r = subprocess.run(['node', rel], cwd=cwd, capture_output=True, text=True, timeout=120)
        ok = r.returncode == 0
        # 「要確認有輸出，不能只 grep 通過」（task.md T4-1 註）——空輸出視同失敗
        has_output = bool((r.stdout or '').strip() or (r.stderr or '').strip())
        check(ok and has_output, '%s（exit=%d, 輸出 %d 字）' % (label, r.returncode, len(r.stdout or '')))
        if not ok:
            print((r.stdout or '')[-500:])
            print((r.stderr or '')[-500:])
    finish()


if __name__ == '__main__':
    main()
