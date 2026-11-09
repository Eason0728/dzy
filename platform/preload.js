/**
 * platform/preload.js — 讓瀏覽器一次同時下載需要的檔案（2026-11-09）。
 *
 * 原本程式檔要下載完一層才知道下一層要什麼，一層層等；清單由 tools/gen-preload.mjs 事先算好。
 * 清單過期也不會壞：頂多少預載幾個檔，或多抓一個不存在的檔，畫面仍照原本方式載入。
 * 這裡只照 manifest.id 這種資料查表，不認識任何具體模組。
 */
import { PRELOAD } from './preload-map.js';

const requested = new Set();

export function preloadModules(ids) {
  for (const id of ids) {
    for (const path of PRELOAD[id] || []) {
      if (requested.has(path)) continue;
      requested.add(path);
      const link = document.createElement('link');
      link.rel = 'modulepreload';
      link.href = new URL('../' + path, import.meta.url).href;
      document.head.appendChild(link);
    }
  }
}

/** 正式網址才啟用裝置快取；8862 是本機試用埠。其他本機埠維持「永遠最新」，開發時才不會看到舊版。 */
export function deviceCacheAllowed(loc) {
  return loc.hostname === 'dzy.mozhuting.com' || ((loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') && loc.port === '8862');
}

export function registerDeviceCache() {
  if (!('serviceWorker' in navigator) || !deviceCacheAllowed(window.location)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url).href, { scope: new URL('../', import.meta.url).href })
      .catch((err) => console.warn('[preload] 裝置快取啟用失敗，照常連網', err));
  }, { once: true });
}
