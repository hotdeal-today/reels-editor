// db.js — IndexedDB 저장소 (프로젝트 JSON · 미디어 blob · 커스텀 폰트 · 커스텀 효과음)
const DB_NAME = 'reels-studio';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('이 브라우저는 IndexedDB를 지원하지 않습니다.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('project')) db.createObjectStore('project');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('fonts')) db.createObjectStore('fonts', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB를 열지 못했습니다.'));
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error || new Error('저장소 오류'));
    t.onabort = () => reject(t.error || new Error('저장소 중단'));
  }));
}

export function idbGet(store, key) {
  return tx(store, 'readonly', (s) => s.get(key));
}
export function idbPut(store, value, key) {
  return tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
}
export function idbDel(store, key) {
  return tx(store, 'readwrite', (s) => s.delete(key));
}
export function idbAll(store) {
  return tx(store, 'readonly', (s) => s.getAll());
}
export function idbClear(store) {
  return tx(store, 'readwrite', (s) => s.clear());
}
