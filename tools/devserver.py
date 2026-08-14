#!/usr/bin/env python3
"""
開發用靜態伺服器：一律回 no-store，避免瀏覽器把 ES module 快取住。

為什麼需要它（2026-08-14 踩到）：改完 platform/auth.js 後重新整理，畫面仍跑舊版程式，
一度誤判成「修沒生效」。python -m http.server 不送 Cache-Control，瀏覽器會用啟發式快取，
而 ES module 的快取又比一般資源黏。開發期間一律用這支，省掉「這到底是不是新版」的猜測。

用法：python3 tools/devserver.py [埠號，預設 8777]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 只印錯誤，正常請求不洗版
        if args and str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    handler = partial(NoCacheHandler, directory=str(ROOT))
    with ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
        print(f'開發伺服器啟動：http://localhost:{port}/　（根目錄 {ROOT}，一律不快取）')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
