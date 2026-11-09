// 緊急關閉裝置快取：把這個檔案的內容整份蓋掉根目錄 sw.js 並部署。
// 裝置下次開頁會清掉存的檔案、解除註冊，之後回到沒有裝置快取的狀態。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith('dzy-static-')) await caches.delete(name);
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
})()));
