/**
 * sw.js — 網站檔案存在同仁裝置上，第二次開啟不用再一個一個下載（2026-11-09）。
 *
 * 只存「公開的程式檔與圖片」（platform/、modules/、assets/），絕不經手後端請求與任何資料：
 * 後端在別的網域，這裡一律不攔。
 *
 * 怎麼保證大家拿到新版（這支最重要的事）：
 *   GitHub Pages 每次部署後，全站每個檔案的 Last-Modified 都一樣、都變成部署時間。
 *   每次開頁一定連網抓首頁、看 Last-Modified，跟裝置上存的不同＝有新版，舊檔整包丟掉。
 *   存進裝置前也比對該檔的 Last-Modified，部署途中新舊混雜的檔案不存。
 *   保險：不管有沒有新版，每天清空重抓一次；抓不到 Last-Modified 就完全不存。
 *   連不上網時照舊顯示連線失敗，不會拿舊畫面騙人。
 *
 * 緊急關閉：把 tools/sw-off.js 的內容蓋掉這支 sw.js 並部署，裝置下次開頁就會自動清掉。
 */
'use strict';

const PREFIX = 'dzy-static-';
const ENTRY_PAGES = new Set(['/', '/index.html', '/line.html']);
const STORED_DIRS = ['/platform/', '/modules/', '/assets/'];

let current = null; // { name, lastModified }

const today = () => new Date().toISOString().slice(0, 10);
const nameFor = (lastModified) => PREFIX + today() + '|' + lastModified;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/** 程式被瀏覽器暫停後記憶體會清空：從裝置上現有的快取名稱找回版本（不是今天的就不算） */
async function getCurrent() {
  if (current && current.name.startsWith(PREFIX + today() + '|')) return current;
  const head = PREFIX + today() + '|';
  const name = (await caches.keys()).find((k) => k.startsWith(head));
  current = name ? { name, lastModified: name.slice(head.length) } : null;
  return current;
}

/** 認定目前版本，其餘舊版整包刪掉。lastModified 是空的＝不存任何東西 */
async function adopt(lastModified) {
  const keep = lastModified ? nameFor(lastModified) : null;
  current = keep ? { name: keep, lastModified } : null;
  const names = await caches.keys();
  await Promise.all(names.filter((k) => k.startsWith(PREFIX) && k !== keep).map((k) => caches.delete(k)));
}

async function openEntryPage(request) {
  const res = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
  if (res.ok && !res.redirected) await adopt(res.headers.get('last-modified'));
  return res;
}

async function serveStored(event) {
  const request = event.request;
  const version = await getCurrent();
  if (!version) return fetch(request);
  const cache = await caches.open(version.name);
  const hit = await cache.match(request);
  if (hit) return hit;
  // no-cache：不可拿瀏覽器 10 分鐘快取裡的舊版檔案存進新版
  const res = await fetch(new Request(request, { cache: 'no-cache' }));
  if (res.ok && res.type === 'basic' && !res.redirected && res.headers.get('last-modified') === version.lastModified) {
    event.waitUntil(cache.put(request, res.clone()).catch(() => {}));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (ENTRY_PAGES.has(url.pathname)) event.respondWith(openEntryPage(request));
    return;
  }
  if (STORED_DIRS.some((dir) => url.pathname.startsWith(dir))) event.respondWith(serveStored(event));
});
