/* ===========================
   STORAGE LAYER
   localStorage + IndexedDB
   =========================== */

const STORAGE_KEY = "tim_puchki_v2";

// IndexedDB
const IDB_NAME = "tim_puchki_blobs";
const IDB_STORE = "blobs";

/* ===========================
   localStorage (metadata)
   =========================== */

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function getPuchok(db, id){
  return db.puchki.find(p => p.id === id) || null;
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
   =========================== */

async function cleanupItemBlobs(it){
  try{
    if(it.type === "image"){
      if(it.blobKey) await idbDelete(it.blobKey);
      if(it.thumbKey) await idbDelete(it.thumbKey);
    }
    else if(it.type === "file"){
      if(it.blobKey) await idbDelete(it.blobKey);
    }
    else if(it.type === "audio"){
      for(const s of (it.segments || [])){
        if(s && s.key) await idbDelete(s.key);
      }
    }
  }catch(e){
    console.error("Cleanup error:", e);
  }
}
