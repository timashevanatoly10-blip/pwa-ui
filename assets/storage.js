/* ===========================
   STORAGE LAYER
   localStorage + IndexedDB
   - В текущей cloud-first схеме:
     * metadata (puchki/items) живёт в D1 (через Worker)
     * IndexedDB остаётся ТОЛЬКО для аудио-сегментов (пока) и совместимости audio.js
     * Для file/image blobs теперь R2, поэтому blobKey/thumbKey для них больше не нужны
   =========================== */

// (оставляем ключи, чтобы ничего не ломалось у старого кода/аудио)
const STORAGE_KEY = "tim_puchki_v2";

// IndexedDB
const IDB_NAME = "tim_puchki_blobs";
const IDB_STORE = "blobs";

/* ===========================
   localStorage (metadata)
   ===========================
   В новой версии метаданные не сохраняем локально (они в D1).
   Но функции оставляем как no-op / безопасные, чтобы ничего не падало,
   если где-то ещё остались вызовы loadDB/saveDB.
*/

function loadDB(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return { puchki: [] };

    const parsed = JSON.parse(raw);
    if(!parsed || !Array.isArray(parsed.puchki)){
      return { puchki: [] };
    }

    parsed.puchki.forEach(p=>{
      if(!Array.isArray(p.items)) p.items = [];
    });

    return parsed;
  }catch{
    return { puchki: [] };
  }
}

function saveDB(db){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }catch{}
}

function getPuchok(db, id){
  try{ return (db && db.puchki ? db.puchki.find(p => p.id === id) : null) || null; }
  catch{ return null; }
}

function getItem(db, pId, itemId){
  const p = getPuchok(db, pId);
  if(!p) return null;
  return (p.items || []).find(x => x.id === itemId) || null;
}

/* ===========================
   IndexedDB helpers
   =========================== */

function idbOpen(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(IDB_NAME, 1);

    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(IDB_STORE)){
        db.createObjectStore(IDB_STORE, { keyPath: "key" });
      }
    };

    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

async function idbPutBlob(key, blob){
  const db = await idbOpen();

  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ key, blob });

    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  });
}

async function idbGetBlob(key){
  const db = await idbOpen();

  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);

    req.onsuccess = ()=>{
      resolve(req.result ? req.result.blob : null);
    };

    req.onerror = ()=> reject(tx.error);
  });
}

async function idbDelete(key){
  const db = await idbOpen();

  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);

    tx.oncomplete = ()=> resolve(true);
    tx.onerror = ()=> reject(tx.error);
  });
}

/* ===========================
   Blob cleanup
   ===========================
   Важно:
   - image/file blobs теперь в R2 => IndexedDB тут не трогаем для них
   - audio сегменты пока локальные => чистим как раньше
*/

async function cleanupItemBlobs(it){
  try{
    if(!it) return;

    // FILE/IMAGE: blobs в R2, локальных ключей больше может не быть
    // но если остались старые записи (legacy), безопасно подчистим
    if(it.type === "image" || it.type === "file"){
      if(it.blobKey) await idbDelete(it.blobKey).catch(()=>{});
      if(it.thumbKey) await idbDelete(it.thumbKey).catch(()=>{});
      // NOTE: если blobKey/thumbKey нет — ок
      return;
    }

    // AUDIO: сегменты локальные (IndexedDB)
    if(it.type === "audio"){
      for(const s of (it.segments || [])){
        if(s && s.key) await idbDelete(s.key).catch(()=>{});
      }
      return;
    }

  }catch(e){
    console.error("Cleanup error:", e);
  }
}

/* ===========================
   Expose for app/audio.js (если нужно)
   =========================== */
window.loadDB = loadDB;
window.saveDB = saveDB;
window.getPuchok = getPuchok;
window.getItem = getItem;

window.idbPutBlob = idbPutBlob;
window.idbGetBlob = idbGetBlob;
window.idbDelete = idbDelete;

window.cleanupItemBlobs = cleanupItemBlobs;
