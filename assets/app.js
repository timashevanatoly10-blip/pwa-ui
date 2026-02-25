/** ===========================
 *  PUCHKI — APP (cloud-first for D1)
 *  - Puchki + text/code/link items live in D1 via Worker
 *  - Blobs (image/file/audio segments) stay local in IndexedDB (storage.js) for now
 *  - audio.js compatibility: we keep an in-memory db mirror + shims
 *  =========================== */

/** ===========================
 *  CONFIG
 *  =========================== */
const WORKER_URL = "https://gptim24.timashevanatoly10.workers.dev";
const API_TOKEN_STORAGE_KEY = "PUCHKI_API_TOKEN";

/** ===========================
 *  TOKEN HELPERS
 *  =========================== */
function getApiToken(){
  try{ return (localStorage.getItem(API_TOKEN_STORAGE_KEY) || "").trim(); }
  catch{ return ""; }
}
function setApiToken(token){
  try{
    const t = (token || "").toString().trim();
    if(!t) localStorage.removeItem(API_TOKEN_STORAGE_KEY);
    else localStorage.setItem(API_TOKEN_STORAGE_KEY, t);
  }catch{}
}
function promptApiToken(){
  const current = getApiToken();
  const t = prompt("Введи API token для доступа к приложению:", current || "");
  if(t === null) return null;
  const cleaned = (t || "").toString().trim();
  setApiToken(cleaned);
  return cleaned;
}
function ensureApiToken({ force = false } = {}){
  const t = getApiToken();
  if(t && !force) return t;
  const entered = promptApiToken();
  return (entered || "").trim();
}
function authHeaders(){
  const t = getApiToken();
  return t ? { "Authorization": "Bearer " + t } : {};
}

/** ===========================
 *  DOM
 *  =========================== */
const mainPanel = document.getElementById("mainPanel");
const backBtn = document.getElementById("backBtn");
const headTitle = document.getElementById("headTitle");
const headCrumb = document.getElementById("headCrumb");

const newPuchokBtn = document.getElementById("newPuchokBtn");

const editPuchokBtn = document.getElementById("editPuchokBtn");
const addMenuBtn = document.getElementById("addMenuBtn");
const addMenu = document.getElementById("addMenu");
const menuAddText = document.getElementById("menuAddText");
const menuAddFile = document.getElementById("menuAddFile");
const menuAddAudio = document.getElementById("menuAddAudio");
const menuAddCode = document.getElementById("menuAddCode");
const menuAddLink = document.getElementById("menuAddLink");
const menuDeletePuchok = document.getElementById("menuDeletePuchok");

const chatDock = document.getElementById("chatDock");
const collapseBar = document.getElementById("collapseBar");
const chat = document.getElementById("chat");
const input = document.getElementById("input");
const send = document.getElementById("send");
const clearChatBtn = document.getElementById("clearChatBtn");
const chatHint = document.getElementById("chatHint");

const filePicker = document.getElementById("filePicker");
const audioPicker = document.getElementById("audioPicker");

const modalWrap = document.getElementById("modalWrap");
const modalTitle = document.getElementById("modalTitle");
const modalTextarea = document.getElementById("modalTextarea");
const modalViewer = document.getElementById("modalViewer");
const modalClose = document.getElementById("modalClose");
const modalSave = document.getElementById("modalSave");
const modalDelete = document.getElementById("modalDelete");
const modalCopy = document.getElementById("modalCopy");
const modalHint = document.getElementById("modalHint");

/** ===========================
 *  STATE (cloud-first)
 *  =========================== */
let currentPuchokId = null;
let openItemId = null;
let openItemType = null;
let isBusy = false;

// In-memory mirror shaped like old local DB (for UI + audio.js compatibility)
let db = { puchki: [] }; // [{id,title,createdAt,updatedAt, items: []}]
window.db = db; // audio.js expects global "db"
window.currentPuchokId = currentPuchokId; // keep synced below

/** ===========================
 *  PLATFORM / FEATURE DETECT
 *  =========================== */
function isIOS(){
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function hasMediaRecorder(){
  return typeof MediaRecorder !== "undefined" && typeof MediaRecorder === "function";
}
function canUseWebAudio(){
  return typeof (window.AudioContext || window.webkitAudioContext) !== "undefined";
}
function chooseAudioMode(){
  return hasMediaRecorder() ? "mediarecorder" : "capture";
}

/** ===========================
 *  HELPERS
 *  =========================== */
function nowISO(){ return new Date().toISOString(); }
function uid(){ return Math.random().toString(16).slice(2) + Date.now().toString(16); }
function safeTitleFromText(t){
  const s = (t || "").toString().trim().replace(/\s+/g," ");
  return s.length > 48 ? s.slice(0, 48) + "…" : (s || "Без названия");
}
function fmtDate(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleString(undefined, { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
  }catch{ return iso; }
}
function fmtBytes(bytes){
  const b = Number(bytes || 0);
  if(!b) return "0 B";
  const units = ["B","KB","MB","GB"];
  let i = 0; let n = b;
  while(n >= 1024 && i < units.length-1){ n/=1024; i++; }
  return `${n.toFixed(n>=10||i===0?0:1)} ${units[i]}`;
}
function fmtTimeSec(sec){
  sec = Math.max(0, Number(sec || 0));
  const m = Math.floor(sec/60);
  const s = Math.floor(sec%60);
  return `${m}:${s.toString().padStart(2,"0")}`;
}
function escapeHTML(s){
  return (s||"").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }

function normalizeUrl(raw){
  const s = (raw || "").toString().trim();
  if(!s) return "";
  if(/^https?:\/\//i.test(s)) return s;
  if(/^mailto:/i.test(s)) return s;
  if(/^tel:/i.test(s)) return s;
  return "https://" + s;
}
function urlTitle(u){
  try{
    const url = new URL(u);
    const host = url.host || u;
    const path = (url.pathname && url.pathname !== "/") ? url.pathname : "";
    const t = (host + path).replace(/\/{2,}/g,"/");
    return t.length > 60 ? t.slice(0,60) + "…" : t;
  }catch{
    const t = (u || "").toString().trim();
    return t.length > 60 ? t.slice(0,60) + "…" : (t || "Ссылка");
  }
}

function icoSVG(kind){
  const common = `class="ico" viewBox="0 0 24 24" fill="none"`;
  if(kind==="file"){
    return `<svg ${common}><path d="M7 3h7l3 3v15H7V3Z" stroke="#111317" stroke-width="2"/><path d="M14 3v6h6" stroke="#111317" stroke-width="2"/></svg>`;
  }
  if(kind==="audio"){
    return `<svg ${common}><path d="M12 3v12" stroke="#111317" stroke-width="2"/><path d="M8 7v8" stroke="#111317" stroke-width="2"/><path d="M16 7v8" stroke="#111317" stroke-width="2"/><path d="M5 11v4" stroke="#111317" stroke-width="2"/><path d="M19 11v4" stroke="#111317" stroke-width="2"/></svg>`;
  }
  if(kind==="code"){
    return `<svg ${common}><path d="M9 18L3 12l6-6" stroke="#111317" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 6l6 6-6 6" stroke="#111317" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if(kind==="link"){
    return `<svg ${common}><path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1" stroke="#111317" stroke-width="2" stroke-linecap="round"/><path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1" stroke="#111317" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  return `<svg ${common}><path d="M4 6h16v12H4V6Z" stroke="#111317" stroke-width="2"/><path d="M8 11l2.5 3 2-2 3.5 4" stroke="#111317" stroke-width="2" stroke-linejoin="round"/><path d="M9 9.5h.01" stroke="#111317" stroke-width="3" stroke-linecap="round"/></svg>`;
}
function typeLabel(it){
  if(it.type==="image") return { text:"Фото", cls:"tagText tagImg" };
  if(it.type==="file") return { text:"Файл", cls:"tagText tagFile" };
  if(it.type==="audio") return { text:"Аудио", cls:"tagText tagAudio" };
  if(it.type==="code") return { text:"Код", cls:"tagText tagCode" };
  if(it.type==="link") return { text:"Ссылка", cls:"tagText tagLink" };
  return { text:"Текст", cls:"tagText" };
}

/** ===========================
 *  RANGE FILL (cross-browser)
 *  =========================== */
function setRangeFill(el){
  if(!el) return;
  const min = Number(el.min || 0);
  const max = Number(el.max || 0);
  const val = Number(el.value || 0);
  const denom = (max - min) || 1;
  const pct = clamp(((val - min) / denom) * 100, 0, 100);
  el.style.setProperty("--fill", pct + "%");
}
window.setRangeFill = setRangeFill; // audio.js uses it

/** ===========================
 *  STORAGE.JS SHIMS (blobs only)
 *  - storage.js must provide: idbPutBlob, idbGetBlob, cleanupItemBlobs
 *  =========================== */
async function cleanupItemBlobsSafe(it){
  try{
    if(typeof cleanupItemBlobs === "function") await cleanupItemBlobs(it);
  }catch{}
}

/** ===========================
 *  DB SHIMS for audio.js
 *  =========================== */
function saveDBLocal(){
  // audio.js expects: persist modified item (segments/durationSec/etc).
  // Here we push those changes into D1 (meta field) when possible.
  try{
    if(!currentPuchokId) return;
    const p = getPuchokLocal(currentPuchokId);
    if(!p) return;

    // Patch only the item that is currently open/playing/recording is messy;
    // we do a safe, small pass: patch all items in current puchok that have meta-ish fields.
    // To avoid spamming: throttle by an in-flight lock.
    schedulePersistCurrentPuchokItems();
  }catch{}
}
function getPuchokLocal(id){ return (db.puchki || []).find(x => x.id === id) || null; }
function getItemLocal(pId, itemId){
  const p = getPuchokLocal(pId);
  if(!p) return null;
  return (p.items || []).find(x => x.id === itemId) || null;
}
window.saveDBLocal = saveDBLocal;
window.getPuchokLocal = getPuchokLocal;
window.getItemLocal = getItemLocal;
window.nowISO = nowISO;
window.uid = uid;
window.fmtBytes = fmtBytes;
window.fmtTimeSec = fmtTimeSec;
window.clamp = clamp;
window.escapeHTML = escapeHTML;
window.isIOS = isIOS;
window.hasMediaRecorder = hasMediaRecorder;
window.canUseWebAudio = canUseWebAudio;
window.chooseAudioMode = chooseAudioMode;
window.audioPicker = audioPicker;
window.modalViewer = modalViewer;
window.modalHint = modalHint;

/** ===========================
 *  NETWORK (Worker API)
 *  =========================== */
async function apiFetch(path, { method="GET", json=null, headers={}, retryAuth=true } = {}){
  const url = WORKER_URL + path;

  // ensure token once for auth-zone calls
  const needsToken = (path === "/chat" || path.startsWith("/db/") || path.startsWith("/puchki") || path.startsWith("/items"));
  if(needsToken){
    const t = ensureApiToken({ force:false });
    if(!t) throw new Error("NO_TOKEN");
  }

  const resp = await fetch(url, {
    method,
    headers: {
      ...(json ? { "Content-Type":"application/json" } : {}),
      ...authHeaders(),
      ...headers,
    },
    body: json ? JSON.stringify(json) : undefined,
  });

  if((resp.status === 401 || resp.status === 403) && retryAuth && needsToken){
    const t2 = ensureApiToken({ force:true });
    if(!t2) throw new Error("UNAUTHORIZED");
    return await apiFetch(path, { method, json, headers, retryAuth:false });
  }

  return resp;
}

async function apiJson(path, opts){
  const resp = await apiFetch(path, opts);
  const raw = await resp.text().catch(()=>"");
  let data = {};
  try{ data = JSON.parse(raw); }catch{}
  if(!resp.ok || !data || data.ok === false){
    const msg = (data && data.error) ? data.error : (raw || `HTTP ${resp.status}`);
    throw new Error(msg);
  }
  return data;
}

/** ===========================
 *  DATA MAPPING (D1 -> UI objects)
 *  =========================== */
function parseMeta(meta){
  if(!meta) return null;
  if(typeof meta === "object") return meta;
  try{ return JSON.parse(meta); }catch{ return null; }
}

function mapPuchokRow(row){
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: [], // loaded on open
    itemsCount: null,
  };
}

function mapItemRow(row){
  const meta = parseMeta(row.meta) || null;

  const it = {
    id: row.id,
    type: row.type,
    title: row.title || null,
    content: row.content || null,
    url: row.url || null,
    mime: row.mime || null,
    size: Number(row.size || 0),
    meta: meta || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  // Back-compat fields stored in meta (local blobs / audio segments)
  if(meta && typeof meta === "object"){
    if(meta.blobKey) it.blobKey = meta.blobKey;
    if(meta.thumbKey) it.thumbKey = meta.thumbKey;
    if(meta.segments) it.segments = meta.segments;
    if(meta.durationSec != null) it.durationSec = meta.durationSec;
  }

  // Normalize types for UI labels (we use "image" when mime starts with image/)
  if(it.type === "file" && it.mime && it.mime.startsWith("image/")){
    it.type = "image";
  }

  return it;
}

function itemToPatchPayload(it){
  // For cloud-first: store blob/audio stuff in meta JSON
  const meta = Object.assign({}, (it.meta && typeof it.meta === "object") ? it.meta : {});
  if(it.blobKey) meta.blobKey = it.blobKey;
  if(it.thumbKey) meta.thumbKey = it.thumbKey;
  if(it.segments) meta.segments = it.segments;
  if(it.durationSec != null) meta.durationSec = it.durationSec;

  const payload = {};
  if(it.type) payload.type = it.type === "image" ? "file" : it.type; // keep D1 types simple if you prefer
  if(it.title !== undefined) payload.title = it.title;
  if(it.content !== undefined) payload.content = it.content;
  if(it.url !== undefined) payload.url = it.url;
  if(it.mime !== undefined) payload.mime = it.mime;
  if(it.size !== undefined) payload.size = it.size;
  payload.meta = Object.keys(meta).length ? meta : null;
  return payload;
}

/** ===========================
 *  CLOUD LOADERS
 *  =========================== */
async function loadPuchkiList(){
  const data = await apiJson("/puchki", { method:"GET" });
  const list = (data.puchki || []).map(mapPuchokRow);
  db.puchki = list;
}

async function loadPuchokWithItems(puchokId){
  const data = await apiJson(`/puchki/${encodeURIComponent(puchokId)}`, { method:"GET" });
  const pRow = data.puchok;
  const itemsRows = data.items || [];

  const p = mapPuchokRow(pRow);
  p.items = itemsRows.map(mapItemRow);

  // update/insert into db mirror
  const idx = (db.puchki || []).findIndex(x => x.id === p.id);
  if(idx >= 0) db.puchki[idx] = Object.assign(db.puchki[idx], p);
  else db.puchki.unshift(p);

  // ensure current pointer exists
  return getPuchokLocal(p.id);
}

/** ===========================
 *  PERSIST (throttled) — for audio.js changes
 *  =========================== */
let persistTimer = null;
let persistInFlight = false;

function schedulePersistCurrentPuchokItems(){
  if(persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async ()=>{
    if(persistInFlight) return;
    persistInFlight = true;
    try{
      const p = getPuchokLocal(currentPuchokId);
      if(!p) return;

      // Persist only audio/file/image items that carry meta keys
      const toPersist = (p.items || []).filter(it => {
        if(!it) return false;
        if(it.type === "audio") return true;
        if(it.type === "file" || it.type === "image") return !!(it.blobKey || it.thumbKey || it.meta);
        return false;
      });

      for(const it of toPersist){
        try{
          await apiJson(`/items/${encodeURIComponent(it.id)}`, {
            method:"PATCH",
            json: itemToPatchPayload(it),
          });
        }catch{}
      }
    }finally{
      persistInFlight = false;
    }
  }, 600);
}

/** ===========================
 *  MENU (Add)
 *  =========================== */
function closeAddMenu(){
  addMenu.style.display = "none";
  addMenu.setAttribute("aria-hidden","true");
}
function toggleAddMenu(){
  if(addMenu.style.display === "block") closeAddMenu();
  else{
    addMenu.style.display = "block";
    addMenu.setAttribute("aria-hidden","false");
  }
}

/** ===========================
 *  CHAT DOCK COLLAPSE/EXPAND
 *  =========================== */
function expandChat(){
  chatDock.classList.remove("collapsed");
  chatDock.classList.add("expanded");
  setTimeout(()=> { chat.scrollTop = chat.scrollHeight; }, 10);
}
function collapseChat(){
  chatDock.classList.remove("expanded");
  chatDock.classList.add("collapsed");
}
input.addEventListener("focus", expandChat);
collapseBar.addEventListener("click", collapseChat);

/** ===========================
 *  UI HEADER
 *  =========================== */
function setHeaderForList(){
  backBtn.style.display = "none";
  headTitle.textContent = "ПУЧКИ";
  headCrumb.textContent = "Пучки + чат";

  editPuchokBtn.style.display = "none";
  addMenuBtn.style.display = "none";
  closeAddMenu();

  newPuchokBtn.style.display = "";
  chatHint.textContent = "Совет: сначала открой пучок → тогда “В пучок” будет сохранять ответы прямо туда.";
}
function setHeaderForPuchok(p){
  backBtn.style.display = "";
  headTitle.textContent = "ПУЧКИ";
  headCrumb.textContent = p.title || "Без названия";

  newPuchokBtn.style.display = "none";
  editPuchokBtn.style.display = "";
  addMenuBtn.style.display = "";
  closeAddMenu();

  chatHint.textContent = "Ты в пучке: ответы бота можно сохранять кнопкой “В пучок”.";
}

/** ===========================
 *  UI RENDER
 *  =========================== */
function render(){
  mainPanel.innerHTML = "";
  window.currentPuchokId = currentPuchokId; // keep in sync for audio.js

  if(!currentPuchokId){
    setHeaderForList();
    renderPuchokList();
  }else{
    const p = getPuchokLocal(currentPuchokId);
    if(!p){
      currentPuchokId = null;
      render();
      return;
    }
    setHeaderForPuchok(p);
    renderPuchokInside(p);
  }
}
window.render = render; // audio.js expects render()

function renderPuchokList(){
  const wrap = document.createElement("div");
  wrap.className = "list";

  if((db.puchki || []).length === 0){
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "Пока нет пучков.<br>Нажми <b>+ Пучок</b>, потом зайди внутрь и сохраняй туда ответы / заметки / файлы / аудио.";
    wrap.appendChild(empty);
  }else{
    const sorted = [...db.puchki].sort((a,b)=> (b.updatedAt||b.createdAt||"").localeCompare(a.updatedAt||a.createdAt||""));
    for(const p of sorted){
      const card = document.createElement("div");
      card.className = "card";

      const meta = document.createElement("div");
      meta.className = "meta";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = p.title || "Без названия";

      const sub = document.createElement("div");
      sub.className = "sub";

      const pill1 = document.createElement("span");
      pill1.className = "pill";
      // D1 list doesn’t provide count — we show "—"
      pill1.textContent = `Элементов: ${Number.isFinite(p.itemsCount) ? p.itemsCount : "—"}`;

      const pill2 = document.createElement("span");
      pill2.className = "pill";
      pill2.textContent = `Обновлён: ${fmtDate(p.updatedAt || p.createdAt || nowISO())}`;

      sub.appendChild(pill1);
      sub.appendChild(pill2);

      meta.appendChild(name);
      meta.appendChild(sub);

      const btn = document.createElement("button");
      btn.className = "btnGhost";
      btn.textContent = "Открыть";
      btn.addEventListener("click", () => openPuchok(p.id));

      card.appendChild(meta);
      card.appendChild(btn);
      wrap.appendChild(card);
    }
  }

  mainPanel.appendChild(wrap);
}

function renderPuchokInside(p){
  const wrap = document.createElement("div");
  wrap.className = "list";

  const items = p.items || [];
  if(items.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "Внутри пусто.<br>Нажми <b>+</b> сверху справа → добавь текст / файл / аудио / код / ссылку.";
    wrap.appendChild(empty);
  }else{
    const sorted = [...items].sort((a,b)=> (b.updatedAt||b.createdAt||"").localeCompare(a.updatedAt||a.createdAt||""));
    for(const it of sorted){
      const row = document.createElement("div");
      row.className = "itemRow";
      row.addEventListener("click", () => openItem(p.id, it.id));

      const left = document.createElement("div");
      left.className = "itemLeft";

      const thumb = document.createElement("div");
      thumb.className = "thumb";

      if(it.type === "image" && it.thumbKey){
        thumb.innerHTML = `<span style="color:#98a2b3;font-size:12px;font-weight:900">…</span>`;
        (async()=>{
          try{
            const b = await idbGetBlob(it.thumbKey);
            if(b){
              const url = URL.createObjectURL(b);
              const img = document.createElement("img");
              img.src = url;
              img.onload = ()=> URL.revokeObjectURL(url);
              thumb.innerHTML = "";
              thumb.appendChild(img);
            }else{
              thumb.innerHTML = icoSVG("image");
            }
          }catch{
            thumb.innerHTML = icoSVG("image");
          }
        })();
      }else{
        if(it.type==="file") thumb.innerHTML = icoSVG("file");
        else if(it.type==="audio") thumb.innerHTML = icoSVG("audio");
        else if(it.type==="code") thumb.innerHTML = icoSVG("code");
        else if(it.type==="link") thumb.innerHTML = icoSVG("link");
        else thumb.innerHTML = icoSVG("image");
      }

      const textWrap = document.createElement("div");
      textWrap.className = "itemText";

      const title = document.createElement("div");
      title.className = "itemTitle";
      title.textContent = it.title || "Элемент";

      const desc = document.createElement("div");
      desc.className = "itemDesc";

      if(it.type === "text"){
        const preview = (it.content || "").toString().trim().replace(/\s+/g," ");
        desc.textContent = preview ? (preview.length > 90 ? preview.slice(0,90)+"…" : preview) : "Пусто";
      }else if(it.type === "code"){
        const preview = (it.content || "").toString().replace(/\s+$/,"");
        const oneLine = preview.replace(/\s+/g," ").trim();
        desc.textContent = oneLine ? (oneLine.length > 90 ? oneLine.slice(0,90)+"…" : oneLine) : "Пусто";
      }else if(it.type === "link"){
        desc.textContent = it.url ? it.url : "—";
      }else if(it.type === "image"){
        desc.textContent = `${fmtBytes(it.size)} • ${fmtDate(it.createdAt || it.updatedAt || nowISO())}`;
      }else if(it.type === "file"){
        desc.textContent = `${fmtBytes(it.size)} • ${it.mime || "file"} • ${fmtDate(it.createdAt || it.updatedAt || nowISO())}`;
      }else if(it.type === "audio"){
        const segs = (it.segments || []).length;
        const total = (it.segments || []).reduce((s,x)=> s + (x.size || 0), 0);
        desc.textContent = `Сегментов: ${segs} • ${fmtBytes(total)} • ${fmtDate(it.createdAt || it.updatedAt || nowISO())}`;
      }else{
        desc.textContent = fmtDate(it.createdAt || it.updatedAt || nowISO());
      }

      textWrap.appendChild(title);
      textWrap.appendChild(desc);

      left.appendChild(thumb);
      left.appendChild(textWrap);

      const right = document.createElement("div");
      const t = typeLabel(it);
      right.className = t.cls;
      right.textContent = t.text;

      row.appendChild(left);
      row.appendChild(right);
      wrap.appendChild(row);
    }
  }

  mainPanel.appendChild(wrap);
}

/** ===========================
 *  NAV (cloud)
 *  =========================== */
async function openPuchok(id){
  if(isBusy) return;
  isBusy = true;
  try{
    currentPuchokId = id;
    await loadPuchokWithItems(id);
  }catch(e){
    addMsg("Ошибка загрузки пучка: " + (e?.message || e), "err");
    currentPuchokId = null;
  }finally{
    isBusy = false;
    render();
  }
}
function goBack(){
  closeAddMenu();
  currentPuchokId = null;
  render();
}

/** ===========================
 *  CRUD: Puchok (cloud)
 *  =========================== */
async function createPuchok(){
  if(isBusy) return;
  const name = prompt("Название пучка:", "Новый пучок");
  if(name === null) return;

  const title = (name || "").trim() || "Новый пучок";
  isBusy = true;
  try{
    const data = await apiJson("/puchki", { method:"POST", json:{ title } });
    const p = mapPuchokRow(data.puchok);
    db.puchki.unshift(p);
    currentPuchokId = p.id;
    await loadPuchokWithItems(p.id);
  }catch(e){
    addMsg("Ошибка создания пучка: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    render();
  }
}

async function renameCurrentPuchok(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p) return;

  const name = prompt("Новое название пучка:", p.title || "");
  if(name === null) return;

  const title = (name || "").trim() || "Без названия";

  isBusy = true;
  try{
    await apiJson(`/puchki/${encodeURIComponent(p.id)}`, { method:"PATCH", json:{ title } });
    p.title = title;
    p.updatedAt = nowISO();
  }catch(e){
    addMsg("Ошибка переименования: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    render();
  }
}

async function deleteCurrentPuchok(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p) return;

  closeAddMenu();
  const ok = confirm(`Удалить пучок “${p.title || "Без названия"}”?`);
  if(!ok) return;

  isBusy = true;
  try{
    // cleanup local blobs (best-effort)
    for(const it of (p.items || [])){
      await cleanupItemBlobsSafe(it);
    }

    await apiJson(`/puchki/${encodeURIComponent(p.id)}`, { method:"DELETE" });

    db.puchki = (db.puchki || []).filter(x => x.id !== p.id);
    currentPuchokId = null;
  }catch(e){
    addMsg("Ошибка удаления пучка: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    render();
  }
}

/** ===========================
 *  CRUD: Items (cloud)
 *  =========================== */
function ensureCurrentPuchok(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p){
    alert("Сначала открой пучок — тогда можно добавлять туда элементы.");
    return null;
  }
  return p;
}

async function refreshCurrentPuchok(){
  if(!currentPuchokId) return;
  await loadPuchokWithItems(currentPuchokId);
}

async function addTextItemToCurrent(initialText = ""){
  const p = ensureCurrentPuchok();
  if(!p) return;

  const content = (initialText || "").toString();
  const title = safeTitleFromText(content) || "Текст";

  isBusy = true;
  try{
    const data = await apiJson(`/puchki/${encodeURIComponent(p.id)}/items`, {
      method:"POST",
      json:{ type:"text", title, content }
    });

    const it = mapItemRow(data.item);
    p.items = p.items || [];
    p.items.unshift(it);
    p.updatedAt = it.updatedAt;
    render();
    await openItem(p.id, it.id);
  }catch(e){
    addMsg("Ошибка добавления текста: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function addCodeItemToCurrent(initialCode = ""){
  const p = ensureCurrentPuchok();
  if(!p) return;

  const content = (initialCode || "").toString();
  const title = safeTitleFromText(content) || "Код";

  isBusy = true;
  try{
    const data = await apiJson(`/puchki/${encodeURIComponent(p.id)}/items`, {
      method:"POST",
      json:{ type:"code", title, content }
    });

    const it = mapItemRow(data.item);
    p.items = p.items || [];
    p.items.unshift(it);
    p.updatedAt = it.updatedAt;
    render();
    await openItem(p.id, it.id);
  }catch(e){
    addMsg("Ошибка добавления кода: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function addLinkItemsToCurrent(rawInput){
  const p = ensureCurrentPuchok();
  if(!p) return;

  const lines = (rawInput || "")
    .toString()
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if(lines.length === 0){
    alert("Вставь ссылку (или несколько строк — несколько ссылок).");
    return;
  }

  isBusy = true;
  try{
    for(const line of lines){
      const u = normalizeUrl(line);
      if(!u) continue;
      const title = urlTitle(u);

      const data = await apiJson(`/puchki/${encodeURIComponent(p.id)}/items`, {
        method:"POST",
        json:{ type:"link", title, url: u }
      });

      const it = mapItemRow(data.item);
      p.items = p.items || [];
      p.items.unshift(it);
      p.updatedAt = it.updatedAt;
    }
    render();
  }catch(e){
    addMsg("Ошибка добавления ссылок: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function addFileItemToCurrent(file){
  const p = ensureCurrentPuchok();
  if(!p) return;

  // 1) Save blob locally (IndexedDB) — we keep as before
  const isImg = (file.type || "").startsWith("image/");
  const idLocal = uid();
  const blobKey = `blob:${idLocal}:main`;
  try{ await idbPutBlob(blobKey, file); }catch{}

  let thumbKey = null;
  if(isImg){
    thumbKey = `blob:${idLocal}:thumb`;
    try{ await idbPutBlob(thumbKey, file); }catch{}
  }

  // 2) Create D1 item with meta pointing to local keys (until R2)
  const meta = {
    blobKey,
    ...(thumbKey ? { thumbKey } : {}),
    localOnly: true,
  };

  isBusy = true;
  try{
    const data = await apiJson(`/puchki/${encodeURIComponent(p.id)}/items`, {
      method:"POST",
      json:{
        type: "file",
        title: file.name || (isImg ? "Фото" : "Файл"),
        mime: file.type || (isImg ? "image/*" : "application/octet-stream"),
        size: file.size || 0,
        meta,
      }
    });

    const it = mapItemRow(data.item);
    // Keep UI-friendly type for images
    if(isImg) it.type = "image";
    it.blobKey = blobKey;
    if(thumbKey) it.thumbKey = thumbKey;

    p.items = p.items || [];
    p.items.unshift(it);
    p.updatedAt = it.updatedAt;

    render();
    await openItem(p.id, it.id);
  }catch(e){
    addMsg("Ошибка добавления файла: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function createAudioItemCloud(){
  const p = ensureCurrentPuchok();
  if(!p) return null;

  const title = `Аудио ${new Date().toLocaleDateString()}`;
  const meta = { segments: [], durationSec: 0, localOnly: true };

  const data = await apiJson(`/puchki/${encodeURIComponent(p.id)}/items`, {
    method:"POST",
    json:{ type:"audio", title, meta }
  });

  const it = mapItemRow(data.item);
  it.type = "audio";
  it.segments = [];
  it.durationSec = 0;

  p.items = p.items || [];
  p.items.unshift(it);
  p.updatedAt = it.updatedAt;

  return it;
}

/** ===========================
 *  MODAL / OPEN ITEM
 *  =========================== */
function closeModal(){
  if(typeof stopAnyRecordingSafely === "function") stopAnyRecordingSafely();
  if(typeof stopRecClock === "function") stopRecClock();
  if(typeof stopSmartPlayback === "function") stopSmartPlayback();

  modalWrap.style.display = "none";
  modalTextarea.style.display = "none";
  modalViewer.style.display = "none";
  modalViewer.innerHTML = "";
  modalTextarea.classList.remove("codeTextarea");
  modalCopy.style.display = "none";
  openItemId = null;
  openItemType = null;
}

async function openItem(puchokId, itemId){
  const p = getPuchokLocal(puchokId);
  if(!p) return;
  const it = (p.items || []).find(x => x.id === itemId);
  if(!it) return;

  if(typeof stopSmartPlayback === "function") stopSmartPlayback();

  openItemId = itemId;
  openItemType = it.type;

  modalTitle.textContent = it.title || "Элемент";
  modalHint.textContent = "";
  modalViewer.innerHTML = "";

  modalDelete.style.display = "";
  modalSave.style.display = "none";
  modalCopy.style.display = "none";
  modalTextarea.classList.remove("codeTextarea");

  if(it.type === "text"){
    modalTextarea.style.display = "block";
    modalViewer.style.display = "none";
    modalTextarea.value = it.content || "";
    modalSave.style.display = "";
    modalHint.textContent = "Текст хранится в облаке (D1).";
    modalWrap.style.display = "flex";
    setTimeout(()=> modalTextarea.focus(), 50);
    return;
  }

  if(it.type === "code"){
    modalTextarea.style.display = "block";
    modalViewer.style.display = "none";
    modalTextarea.value = it.content || "";
    modalTextarea.classList.add("codeTextarea");
    modalSave.style.display = "";
    modalCopy.style.display = "";
    modalHint.textContent = "Код хранится в облаке (D1).";
    modalWrap.style.display = "flex";
    setTimeout(()=> modalTextarea.focus(), 50);
    return;
  }

  modalTextarea.style.display = "none";
  modalViewer.style.display = "block";
  modalWrap.style.display = "flex";

  if(it.type === "link"){
    modalHint.textContent = "Ссылка хранится в облаке (D1).";
    const url = it.url || "";
    modalViewer.innerHTML = `
      <div class="fileRow">
        <div class="fileMeta">
          <div class="fileName">${escapeHTML(it.title || "Ссылка")}</div>
          <div class="fileSub" style="word-break:break-all">${escapeHTML(url)}</div>
        </div>
        <div class="tagText tagLink">Ссылка</div>
      </div>
      <div class="viewerActions">
        <button class="btnGhost" id="btnOpenLink" ${url ? "" : "disabled"}>Открыть</button>
        <button class="btnGhost" id="btnCopyLink" ${url ? "" : "disabled"}>Copy</button>
      </div>
    `;
    const btnOpen = document.getElementById("btnOpenLink");
    const btnCopy = document.getElementById("btnCopyLink");
    if(btnOpen) btnOpen.onclick = () => url && window.open(url, "_blank");
    if(btnCopy) btnCopy.onclick = async () => {
      if(!url) return;
      try{
        await navigator.clipboard.writeText(url);
      }catch{
        const ta = document.createElement("textarea");
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        try{ document.execCommand("copy"); }catch{}
        ta.remove();
      }
    };
    return;
  }

  if(it.type === "image"){
    modalHint.textContent = "Фото: метаданные в облаке (D1), файл пока локально (IndexedDB).";
    const key = it.blobKey || (it.meta && it.meta.blobKey) || null;
    if(!key){
      modalViewer.innerHTML = `<div class="empty">Локальный blobKey не найден (пока без R2 фото не восстановить на другом устройстве).</div>`;
      return;
    }
    const b = await idbGetBlob(key).catch(()=>null);
    if(!b){
      modalViewer.innerHTML = `<div class="empty">Файл не найден в локальном хранилище (IndexedDB).</div>`;
      return;
    }
    const url = URL.createObjectURL(b);
    modalViewer.innerHTML = `
      <img src="${url}" alt="Фото" />
      <div class="viewerActions">
        <button class="btnGhost" id="btnOpenNewTab">Открыть</button>
        <button class="btnGhost" id="btnDownload">Скачать</button>
      </div>
    `;
    document.getElementById("btnOpenNewTab").onclick = () => window.open(url, "_blank");
    document.getElementById("btnDownload").onclick = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = it.title || "image";
      a.click();
    };
    return;
  }

  if(it.type === "file"){
    modalHint.textContent = "Файл: метаданные в облаке (D1), файл пока локально (IndexedDB).";
    const key = it.blobKey || (it.meta && it.meta.blobKey) || null;
    if(!key){
      modalViewer.innerHTML = `<div class="empty">Локальный blobKey не найден (пока без R2 файл не восстановить на другом устройстве).</div>`;
      return;
    }
    const b = await idbGetBlob(key).catch(()=>null);
    if(!b){
      modalViewer.innerHTML = `<div class="empty">Файл не найден в локальном хранилище (IndexedDB).</div>`;
      return;
    }
    const url = URL.createObjectURL(b);
    modalViewer.innerHTML = `
      <div class="fileRow">
        <div class="fileMeta">
          <div class="fileName">${escapeHTML(it.title || "Файл")}</div>
          <div class="fileSub">${escapeHTML(it.mime || "file")} • ${fmtBytes(it.size)}</div>
        </div>
        <div class="tagText tagFile">Файл</div>
      </div>
      <div class="viewerActions">
        <button class="btnGhost" id="btnOpenNewTab">Открыть</button>
        <button class="btnGhost" id="btnDownload">Скачать</button>
      </div>
      <div class="hint">Открытие зависит от типа файла и возможностей браузера. Если не откроется — используй “Скачать”.</div>
    `;
    document.getElementById("btnOpenNewTab").onclick = () => window.open(url, "_blank");
    document.getElementById("btnDownload").onclick = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = it.title || "file";
      a.click();
    };
    return;
  }

  if(it.type === "audio"){
    // audio.js expects local-style item with segments + can record and update it
    if(typeof renderAudioViewer === "function"){
      await renderAudioViewer(it, puchokId);
    }else{
      modalViewer.innerHTML = `<div class="empty">audio.js не загрузился.</div>`;
    }
    return;
  }
}

/** ===========================
 *  MODAL SAVE/DELETE/COPY
 *  =========================== */
async function saveModal(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p) return;
  const it = (p.items || []).find(x => x.id === openItemId);
  if(!it) return;

  if(it.type === "text"){
    const txt = modalTextarea.value || "";
    it.content = txt;
    it.title = safeTitleFromText(txt) || (it.title || "Текст");
    it.updatedAt = nowISO();

    isBusy = true;
    try{
      await apiJson(`/items/${encodeURIComponent(it.id)}`, {
        method:"PATCH",
        json:{ title: it.title, content: it.content }
      });
      await refreshCurrentPuchok();
      closeModal();
      render();
    }catch(e){
      addMsg("Ошибка сохранения: " + (e?.message || e), "err");
    }finally{
      isBusy = false;
    }
    return;
  }

  if(it.type === "code"){
    const code = modalTextarea.value || "";
    it.content = code;
    it.title = safeTitleFromText(code) || (it.title || "Код");
    it.updatedAt = nowISO();

    isBusy = true;
    try{
      await apiJson(`/items/${encodeURIComponent(it.id)}`, {
        method:"PATCH",
        json:{ title: it.title, content: it.content }
      });
      await refreshCurrentPuchok();
      closeModal();
      render();
    }catch(e){
      addMsg("Ошибка сохранения: " + (e?.message || e), "err");
    }finally{
      isBusy = false;
    }
    return;
  }
}

async function copyModal(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p) return;
  const it = (p.items || []).find(x => x.id === openItemId);
  if(!it) return;

  let text = "";
  if(it.type === "code") text = (modalTextarea.value || it.content || "").toString();
  else if(it.type === "text") text = (modalTextarea.value || it.content || "").toString();
  else if(it.type === "link") text = (it.url || "").toString();
  if(!text) return;

  try{
    await navigator.clipboard.writeText(text);
  }catch{
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); }catch{}
    ta.remove();
  }
}

async function deleteModal(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p) return;
  const it = (p.items || []).find(x => x.id === openItemId);
  if(!it) return;

  const ok = confirm("Удалить этот элемент?");
  if(!ok) return;

  if(typeof stopAnyRecordingSafely === "function") stopAnyRecordingSafely();
  if(typeof stopRecClock === "function") stopRecClock();
  if(typeof stopSmartPlayback === "function") stopSmartPlayback();

  isBusy = true;
  try{
    await cleanupItemBlobsSafe(it);
    await apiJson(`/items/${encodeURIComponent(it.id)}`, { method:"DELETE" });
    await refreshCurrentPuchok();
    closeModal();
    render();
  }catch(e){
    addMsg("Ошибка удаления: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

/** ===========================
 *  CHAT UI
 *  =========================== */
function addMsg(text, cls){
  const wrap = document.createElement("div");
  wrap.className = "msg " + cls;

  const body = document.createElement("div");
  body.textContent = text;
  wrap.appendChild(body);

  if(cls === "bot"){
    const tools = document.createElement("div");
    tools.className = "msgTools";

    const btnSave = document.createElement("button");
    btnSave.className = "miniBtn miniBtnOk";
    btnSave.textContent = "В пучок";
    btnSave.addEventListener("click", () => {
      if(!currentPuchokId){
        alert("Открой пучок — тогда “В пучок” сохранит ответ туда.");
        return;
      }
      addTextItemToCurrent(text);
    });

    tools.appendChild(btnSave);
    wrap.appendChild(tools);
  }

  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

function clearChat(){
  chat.innerHTML = "";
  const hasToken = !!getApiToken();
  addMsg(
    hasToken
      ? "Чат очищен. Пиши сообщение — отправлю в Worker (/chat)."
      : "Чат очищен. ВНИМАНИЕ: нет API token. При первой отправке попрошу токен.",
    "bot"
  );
}

/** ===========================
 *  CHAT NETWORK
 *  =========================== */
async function postChatOnce(text){
  return await apiFetch("/chat", {
    method: "POST",
    json: { message: text },
  });
}

async function handleSend(){
  const text = input.value.trim();
  if(!text) return;

  expandChat();
  addMsg(text, "me");
  input.value = "";
  send.disabled = true;

  try{
    const resp = await postChatOnce(text);
    const raw = await resp.text().catch(()=> "");
    let data = {};
    try{ data = JSON.parse(raw); }catch{}

    if(!resp.ok){
      addMsg(`HTTP ${resp.status}: ${raw || "error"}`, "err");
    }else if(data && data.ok){
      addMsg(data.answer || "Нет ответа", "bot");
    }else{
      addMsg(raw || "Неожиданный ответ", "err");
    }
  }catch(e){
    const msg = (e && e.message === "NO_TOKEN")
      ? "Нужен API token. Нажми отправить ещё раз и введи токен."
      : ("Ошибка сети: " + (e?.message || e));
    addMsg(msg, "err");
  }

  send.disabled = false;
}

/** ===========================
 *  EVENTS
 *  =========================== */
backBtn.addEventListener("click", goBack);
newPuchokBtn.addEventListener("click", createPuchok);

editPuchokBtn.addEventListener("click", () => {
  closeAddMenu();
  renameCurrentPuchok();
});

addMenuBtn.addEventListener("click", (e)=>{
  e.stopPropagation();
  toggleAddMenu();
});

menuAddText.addEventListener("click", ()=>{
  closeAddMenu();
  addTextItemToCurrent("");
});

menuAddFile.addEventListener("click", ()=>{
  closeAddMenu();
  if(!currentPuchokId){ alert("Сначала открой пучок."); return; }
  filePicker.value = "";
  filePicker.click();
});

menuAddAudio.addEventListener("click", async ()=>{
  closeAddMenu();
  if(!currentPuchokId){ alert("Сначала открой пучок."); return; }
  try{
    // Create cloud item first, then let audio.js record into it
    const it = await createAudioItemCloud();
    if(!it){
      alert("Не удалось создать аудио-элемент в облаке.");
      return;
    }
    render();
    await openItem(currentPuchokId, it.id);

    if(typeof startRecordingToAudioItem === "function"){
      await startRecordingToAudioItem(currentPuchokId, it.id);
    }else if(typeof createAudioItemAndRecord === "function"){
      // fallback (shouldn’t happen now)
      await createAudioItemAndRecord();
    }else{
      alert("audio.js не загрузился (нет startRecordingToAudioItem).");
    }
  }catch(e){
    addMsg("Ошибка аудио: " + (e?.message || e), "err");
  }
});

menuAddCode.addEventListener("click", ()=>{
  closeAddMenu();
  addCodeItemToCurrent("");
});

menuAddLink.addEventListener("click", ()=>{
  closeAddMenu();
  const raw = prompt("Вставь ссылку (или несколько строк):", "");
  if(raw === null) return;
  addLinkItemsToCurrent(raw);
});

menuDeletePuchok.addEventListener("click", async ()=>{
  await deleteCurrentPuchok();
});

filePicker.addEventListener("change", async () => {
  const f = filePicker.files && filePicker.files[0];
  if(!f) return;
  await addFileItemToCurrent(f);
});

// audioPicker change handler is in /assets/audio.js (it appends segments, then saveDBLocal() persists)

send.addEventListener("click", handleSend);
input.addEventListener("keydown", (e) => { if(e.key === "Enter") handleSend(); });
clearChatBtn.addEventListener("click", clearChat);

// Double click "Очистить" — change token
clearChatBtn.addEventListener("dblclick", ()=>{
  promptApiToken();
  clearChat();
});

modalClose.addEventListener("click", closeModal);
modalWrap.addEventListener("click", (e)=>{ if(e.target === modalWrap) closeModal(); });
modalSave.addEventListener("click", saveModal);
modalDelete.addEventListener("click", deleteModal);
modalCopy.addEventListener("click", copyModal);

document.addEventListener("click", ()=> closeAddMenu());
addMenu.addEventListener("click", (e)=> e.stopPropagation());

/** ===========================
 *  INIT
 *  =========================== */
(async function init(){
  try{
    // Load cloud list
    await loadPuchkiList();
  }catch(e){
    // If no token yet, we still render empty list and allow chat/token prompt
  }
  render();
  clearChat();
  collapseChat();
})();
