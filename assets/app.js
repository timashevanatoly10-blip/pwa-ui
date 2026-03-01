/** ===========================
 *  PUCHKI — APP (cloud-first for D1 + R2 for blobs)
 *  - Puchki + text/code/link items live in D1 via Worker
 *  - Blobs (image/file) now live in R2 via Worker (upload/download/delete)
 *  - audio.js: пока как было (локальные сегменты). R2 для голоса сделаем следующим шагом.
 *  =========================== */

/** ===========================
 *  CONFIG
 *  =========================== */
const WORKER_URL = "https://gptim24.timashevanatoly10.workers.dev";
const API_TOKEN_STORAGE_KEY = "PUCHKI_API_TOKEN";

// Порог: всё <= 20MB грузим через Worker (как ты и сказал)
// ВАЖНО: мы применяем этот лимит ТОЛЬКО к обычным файлам (не image/*),
// для фото лимит на фронте не режем (пусть воркер решает).
const WORKER_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

// R2 endpoints (в Worker мы их добавим/доделаем)
// - PUT    /items/:id/blob?name=...&mime=...     (body: binary)
// - GET    /items/:id/blob                        (response: binary)
// - DELETE /items/:id/blob
function itemBlobPath(itemId, qs = "") {
  const base = `/items/${encodeURIComponent(itemId)}/blob`;
  return qs ? `${base}?${qs}` : base;
}

// BIG FILE "obhod" (direct upload via presign)
// ✅ Worker now supports:
// - POST /r2/presign  (compat)  -> returns { ok:true, uploadUrl, key, expiresSec, ... }
//   (or older format { ok:true, upload:{ url, method, headers?, key? } })
// - POST /items/:id/blob/complete -> finalize meta/url/mime/size in D1 after direct upload
function r2PresignPath(){ return `/r2/presign`; }
function itemBlobCompletePath(itemId){ return `/items/${encodeURIComponent(itemId)}/blob/complete`; }

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
 *  REFRESH BUTTON (inside puchok)
 *  - если в HTML нет элемента refreshBtn, создаём его рядом с "+"
 *  =========================== */
let refreshBtn = document.getElementById("refreshBtn") || null;

function ensureRefreshBtn(){
  if(refreshBtn) return refreshBtn;
  if(!addMenuBtn) return null;

  refreshBtn = document.createElement("button");
  refreshBtn.id = "refreshBtn";
  refreshBtn.className = addMenuBtn.className || "btnGhost";
  refreshBtn.type = "button";
  refreshBtn.textContent = "⟳";

  // по умолчанию вставим рядом с "+" (потом переупорядочим в setHeaderForPuchok)
  const parent = addMenuBtn.parentElement;
  if(parent){
    if(addMenuBtn.nextSibling) parent.insertBefore(refreshBtn, addMenuBtn.nextSibling);
    else parent.appendChild(refreshBtn);
  }

  return refreshBtn;
}

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
  if(it.type==="file")  return { text:"Файл", cls:"tagText tagFile" };
  if(it.type==="audio") return { text:"Голос", cls:"tagText tagAudio" };
  if(it.type==="code")  return { text:"Код", cls:"tagText tagCode" };
  if(it.type==="link")  return { text:"Ссылка", cls:"tagText tagLink" };
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
 *  STORAGE.JS SHIMS (best-effort)
 *  - audio.js до сих пор использует IndexedDB сегменты
 *  - cleanupItemBlobs пусть существует (не обязательно)
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
  try{
    if(!currentPuchokId) return;
    const p = getPuchokLocal(currentPuchokId);
    if(!p) return;
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
 *  TRANSFER UI (upload/download progress) — JS-only (no HTML/CSS edits)
 *  =========================== */
let _xferToast = null;
let _xferLastPaint = 0;

function _ensureXferToast(){
  if(_xferToast) return _xferToast;

  const wrap = document.createElement("div");
  wrap.id = "xferToast";
  wrap.style.position = "fixed";
  wrap.style.left = "12px";
  wrap.style.right = "12px";
  wrap.style.bottom = "12px";
  wrap.style.zIndex = "99999";
  wrap.style.background = "rgba(17,19,23,0.92)";
  wrap.style.color = "#fff";
  wrap.style.borderRadius = "14px";
  wrap.style.padding = "12px 12px";
  wrap.style.boxShadow = "0 10px 30px rgba(0,0,0,0.25)";
  wrap.style.backdropFilter = "blur(8px)";
  wrap.style.display = "none";

  wrap.innerHTML = `
    <div style="display:flex; align-items:center; gap:10px;">
      <div id="xferSpin" aria-hidden="true"
        style="width:18px;height:18px;border-radius:50%;
               border:2px solid rgba(255,255,255,0.25);
               border-top-color:#fff;
               animation:xferSpin 0.9s linear infinite;"></div>
      <div style="flex:1; min-width:0;">
        <div id="xferTitle" style="font-weight:700; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Передача…</div>
        <div id="xferSub" style="margin-top:2px; font-size:12px; opacity:0.9; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">—</div>
      </div>
      <button id="xferHideBtn"
        style="appearance:none;border:0;background:rgba(255,255,255,0.14);color:#fff;
               border-radius:10px;padding:6px 10px;font-size:12px;cursor:pointer;">Скрыть</button>
    </div>
    <div style="margin-top:10px;">
      <div style="height:8px; background:rgba(255,255,255,0.18); border-radius:999px; overflow:hidden;">
        <div id="xferBar" style="height:100%; width:0%; background:#fff; border-radius:999px;"></div>
      </div>
      <div id="xferPct" style="margin-top:6px; font-size:12px; opacity:0.9;">—</div>
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    @keyframes xferSpin { from { transform:rotate(0deg);} to { transform:rotate(360deg);} }
  `;
  document.head.appendChild(style);

  document.body.appendChild(wrap);

  const hideBtn = wrap.querySelector("#xferHideBtn");
  if(hideBtn) hideBtn.addEventListener("click", ()=>{ wrap.style.display="none"; });

  _xferToast = wrap;
  return _xferToast;
}

function showXfer({ title="Передача…", sub="—", determinate=false } = {}){
  const wrap = _ensureXferToast();
  wrap.style.display = "block";

  const elTitle = wrap.querySelector("#xferTitle");
  const elSub = wrap.querySelector("#xferSub");
  const elBar = wrap.querySelector("#xferBar");
  const elPct = wrap.querySelector("#xferPct");
  const elSpin = wrap.querySelector("#xferSpin");

  if(elTitle) elTitle.textContent = title;
  if(elSub) elSub.textContent = sub;

  if(elSpin) elSpin.style.display = "block";

  if(elBar) elBar.style.width = determinate ? "0%" : "12%";
  if(elPct) elPct.textContent = determinate ? "0%" : "…";
}

function updateXfer({ loaded=0, total=null, title=null, sub=null } = {}){
  const now = Date.now();
  if(now - _xferLastPaint < 70) return; // throttle UI
  _xferLastPaint = now;

  const wrap = _ensureXferToast();
  if(wrap.style.display !== "block") wrap.style.display = "block";

  const elTitle = wrap.querySelector("#xferTitle");
  const elSub = wrap.querySelector("#xferSub");
  const elBar = wrap.querySelector("#xferBar");
  const elPct = wrap.querySelector("#xferPct");

  if(title != null && elTitle) elTitle.textContent = title;
  if(sub != null && elSub) elSub.textContent = sub;

  const hasTotal = Number.isFinite(total) && total > 0;
  if(hasTotal){
    const pct = clamp((loaded / total) * 100, 0, 100);
    if(elBar) elBar.style.width = pct.toFixed(1) + "%";
    if(elPct) elPct.textContent = `${pct.toFixed(1)}% • ${fmtBytes(loaded)} / ${fmtBytes(total)}`;
  }else{
    if(elBar){
      // pseudo progress when unknown total
      const pseudo = clamp((loaded / (20 * 1024 * 1024)) * 100, 5, 95);
      elBar.style.width = pseudo.toFixed(0) + "%";
    }
    if(elPct) elPct.textContent = `${fmtBytes(loaded)} • …`;
  }
}

function finishXfer({ ok=true, title=null, sub=null, autoHideMs=900 } = {}){
  const wrap = _ensureXferToast();
  const elTitle = wrap.querySelector("#xferTitle");
  const elSub = wrap.querySelector("#xferSub");
  const elBar = wrap.querySelector("#xferBar");
  const elPct = wrap.querySelector("#xferPct");
  const elSpin = wrap.querySelector("#xferSpin");

  if(title != null && elTitle) elTitle.textContent = title;
  if(sub != null && elSub) elSub.textContent = sub;

  if(elSpin) elSpin.style.display = "none";
  if(elBar) elBar.style.width = ok ? "100%" : (elBar.style.width || "0%");
  if(elPct && ok) elPct.textContent = "Готово";

  if(autoHideMs > 0){
    setTimeout(()=>{ if(wrap) wrap.style.display = "none"; }, autoHideMs);
  }
}

/** ===========================
 *  XHR HELPERS (progress for uploads)
 *  =========================== */
function xhrRequest({ url, method="GET", headers={}, body=null, responseType="" , onUploadProgress=null, onDownloadProgress=null } = {}){
  return new Promise((resolve, reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);

    if(responseType) xhr.responseType = responseType;

    try{
      for(const [k,v] of Object.entries(headers || {})){
        if(v == null) continue;
        xhr.setRequestHeader(k, String(v));
      }
    }catch{}

    if(xhr.upload && typeof onUploadProgress === "function"){
      xhr.upload.onprogress = (e)=>{
        try{
          onUploadProgress({
            loaded: Number(e.loaded || 0),
            total: e.lengthComputable ? Number(e.total || 0) : null
          });
        }catch{}
      };
    }

    if(typeof onDownloadProgress === "function"){
      xhr.onprogress = (e)=>{
        try{
          onDownloadProgress({
            loaded: Number(e.loaded || 0),
            total: e.lengthComputable ? Number(e.total || 0) : null
          });
        }catch{}
      };
    }

    xhr.onerror = ()=> reject(new Error("XHR_NETWORK_ERROR"));
    xhr.ontimeout = ()=> reject(new Error("XHR_TIMEOUT"));
    xhr.onload = ()=>{
      const status = xhr.status || 0;
      const text = (typeof xhr.response === "string") ? xhr.response : (xhr.responseText || "");
      resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: xhr.statusText || "",
        responseText: text,
        response: xhr.response,
        getHeader: (name)=> { try{ return xhr.getResponseHeader(name); }catch{ return null; } }
      });
    };

    try{
      xhr.send(body);
    }catch(e){
      reject(e);
    }
  });
}

/** ===========================
 *  NETWORK (Worker API)
 *  =========================== */
async function apiFetch(path, { method="GET", json=null, headers={}, retryAuth=true, body=null } = {}){
  const url = WORKER_URL + path;

  const needsToken = (
    path === "/chat" ||
    path.startsWith("/db/") ||
    path.startsWith("/puchki") ||
    path.startsWith("/items") ||
    path.startsWith("/r2/")
  );

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
    body: json ? JSON.stringify(json) : (body != null ? body : undefined),
  });

  if((resp.status === 401 || resp.status === 403) && retryAuth && needsToken){
    const t2 = ensureApiToken({ force:true });
    if(!t2) throw new Error("UNAUTHORIZED");
    return await apiFetch(path, { method, json, headers, retryAuth:false, body });
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
 *  R2 (via Worker) — FILE/IMAGE blobs
 *  =========================== */

// upload via Worker; enforceLimit=true => режем 20MB на фронте
async function uploadItemBlobToR2(itemId, file, { enforceLimit = true } = {}){
  if(!file) throw new Error("NO_FILE");
  if(enforceLimit && (file.size || 0) > WORKER_UPLOAD_LIMIT_BYTES){
    throw new Error(`Файл слишком большой для загрузки через Worker (лимит ${fmtBytes(WORKER_UPLOAD_LIMIT_BYTES)}).`);
  }

  const qs = new URLSearchParams();
  qs.set("name", (file.name || "file").toString());
  qs.set("mime", (file.type || "application/octet-stream").toString());

  // IMPORTANT: Worker needs token -> XHR must include Authorization header
  const url = WORKER_URL + itemBlobPath(itemId, qs.toString());
  const headers = {
    ...authHeaders(),
    "Content-Type": (file.type || "application/octet-stream"),
  };

  showXfer({
    title: "Загрузка в облако",
    sub: `${file.name || "file"} • ${fmtBytes(file.size || 0)}`,
    determinate: true
  });

  const res = await xhrRequest({
    url,
    method: "PUT",
    headers,
    body: file,
    responseType: "",
    onUploadProgress: ({ loaded, total })=>{
      updateXfer({
        loaded,
        total: total || (file.size || null),
        title: "Загрузка в облако",
        sub: `${file.name || "file"}`
      });
    }
  });

  const raw = (res.responseText || "").toString();
  let data = {};
  try{ data = JSON.parse(raw); }catch{}
  if(!res.ok || data.ok === false){
    const msg = (data && data.error) ? data.error : (raw || `HTTP ${res.status}`);
    finishXfer({ ok:false, title:"Ошибка загрузки", sub: msg, autoHideMs: 2200 });
    throw new Error(msg);
  }

  finishXfer({ ok:true, title:"Загружено", sub: "Файл в облаке", autoHideMs: 650 });
  return data;
}

/** ===========================
 *  DOWNLOAD with progress (Fetch + StreamReader)
 *  =========================== */
async function downloadItemBlobFromR2(itemId){
  const resp = await apiFetch(itemBlobPath(itemId), { method:"GET" });
  if(resp.status === 404) return null;
  if(!resp.ok){
    const t = await resp.text().catch(()=> "");
    throw new Error(t || `HTTP ${resp.status}`);
  }

  // If no streaming (very old), fallback to blob()
  if(!resp.body || typeof resp.body.getReader !== "function"){
    return await resp.blob();
  }

  // Try total from headers (if present)
  let total = null;
  try{
    const cl = resp.headers.get("content-length");
    if(cl) total = Number(cl) || null;
  }catch{}

  showXfer({
    title: "Скачиваю из облака",
    sub: "…",
    determinate: !!(total && total > 0)
  });

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;

  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    if(value){
      chunks.push(value);
      loaded += value.byteLength || value.length || 0;
      updateXfer({
        loaded,
        total,
        title: "Скачиваю из облака",
        sub: total ? "" : ""
      });
    }
  }

  finishXfer({ ok:true, title:"Скачано", sub: total ? "Готово" : `Получено: ${fmtBytes(loaded)}`, autoHideMs: 600 });

  // Build blob from chunks
  const blob = new Blob(chunks);
  return blob;
}

async function deleteItemBlobFromR2(itemId){
  const resp = await apiFetch(itemBlobPath(itemId), { method:"DELETE" });
  if(resp.status === 404) return true;
  if(!resp.ok){
    const t = await resp.text().catch(()=> "");
    throw new Error(t || `HTTP ${resp.status}`);
  }
  return true;
}

/** ===========================
 *  BIG FILE "obhod" (presign -> direct upload -> complete)
 *  =========================== */
async function directUploadLargeFileToR2({ itemId, puchokId, file }){
  if(!file) throw new Error("NO_FILE");

  // 1) presign (compat endpoint)
  let presign;
  try{
    presign = await apiJson(r2PresignPath(), {
      method: "POST",
      json: {
        itemId,
        item_id: itemId,
        puchok_id: puchokId,
        name: (file.name || "file").toString(),
        mime: (file.type || "application/octet-stream").toString(),
        size: Number(file.size || 0),
        source: "add_file",
      }
    });
  }catch(e){
    throw new Error(
      `Обходная загрузка не настроена в воркере.\n` +
      `Нужен эндпойнт: POST ${r2PresignPath()}.\n` +
      `Детали: ${(e?.message || e)}`
    );
  }

  // ✅ Поддержка двух форматов ответа:
  // A) { ok:true, uploadUrl, key, expiresSec, ... }
  // B) { ok:true, upload:{ url, method, headers?, key? } }
  const uploadUrl = presign?.uploadUrl || presign?.upload?.url || "";
  const method = ((presign?.upload?.method) || "PUT").toString().toUpperCase();
  const extraHeaders = (presign?.upload?.headers && typeof presign.upload.headers === "object") ? presign.upload.headers : {};
  const key = presign?.key || presign?.upload?.key || presign?.completed?.key || null;

  if(!uploadUrl){
    throw new Error("Воркер вернул presign без uploadUrl / upload.url (неожиданный формат ответа).");
  }

  // 2) direct PUT to R2 (XHR for progress)
  showXfer({
    title: "Загрузка (direct)",
    sub: `${file.name || "file"} • ${fmtBytes(file.size || 0)}`,
    determinate: true
  });

  const upRes = await xhrRequest({
    url: uploadUrl,
    method,
    headers: {
      ...extraHeaders,
      ...(extraHeaders["Content-Type"] ? {} : { "Content-Type": (file.type || "application/octet-stream") }),
    },
    body: file,
    responseType: "",
    onUploadProgress: ({ loaded, total })=>{
      updateXfer({
        loaded,
        total: total || (file.size || null),
        title: "Загрузка (direct)",
        sub: `${file.name || "file"}`
      });
    }
  });

  if(!upRes.ok){
    const txt = (upRes.responseText || "").toString();
    finishXfer({ ok:false, title:"Ошибка direct upload", sub: `HTTP ${upRes.status} ${txt}`.trim(), autoHideMs: 2600 });
    throw new Error(`Direct upload в R2 не прошёл: HTTP ${upRes.status} ${txt || ""}`.trim());
  }

  // 3) complete in Worker (writes url/mime/size/meta in D1)
  finishXfer({ ok:true, title:"Загружено", sub:"Файл в R2. Финализирую…", autoHideMs: 0 });

  const done = await apiJson(itemBlobCompletePath(itemId), {
    method: "POST",
    json: {
      key, // может быть null — воркер сам деривит key
      name: (file.name || "file").toString(),
      mime: (file.type || "application/octet-stream").toString(),
      size: Number(file.size || 0),
      source: "add_file",
    }
  });

  finishXfer({ ok:true, title:"Готово", sub:"Запись завершена", autoHideMs: 700 });
  return done;
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
    items: [],
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

  if(meta && typeof meta === "object"){
    if(meta.segments) it.segments = meta.segments;
    if(meta.durationSec != null) it.durationSec = meta.durationSec;
    if(meta.r2 && typeof meta.r2 === "object") it.r2 = meta.r2;
  }

  if(it.type === "file" && it.mime && it.mime.startsWith("image/")){
    it.type = "image";
  }

  return it;
}

function itemToPatchPayload(it){
  const meta = Object.assign({}, (it.meta && typeof it.meta === "object") ? it.meta : {});
  if(it.segments) meta.segments = it.segments;
  if(it.durationSec != null) meta.durationSec = it.durationSec;
  if(it.r2) meta.r2 = it.r2;

  const payload = {};
  if(it.type) payload.type = it.type === "image" ? "file" : it.type;
  if(it.title !== undefined) payload.title = it.title;
  if(it.content !== undefined) payload.content = it.content;

  // ✅ FIX: не отправляем url:null (и пустую строку) — чтобы не затирать url в D1
  if(it.url != null && String(it.url).trim() !== "") payload.url = it.url;

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
  db.puchki = (data.puchki || []).map(mapPuchokRow);
}

async function loadPuchokWithItems(puchokId){
  const data = await apiJson(`/puchki/${encodeURIComponent(puchokId)}`, { method:"GET" });
  const pRow = data.puchok;
  const itemsRows = data.items || [];

  const p = mapPuchokRow(pRow);
  p.items = itemsRows.map(mapItemRow);

  const idx = (db.puchki || []).findIndex(x => x.id === p.id);
  if(idx >= 0) db.puchki[idx] = Object.assign(db.puchki[idx], p);
  else db.puchki.unshift(p);

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

      const toPersist = (p.items || []).filter(it => it && it.type === "audio");

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

  // refresh hidden on list
  ensureRefreshBtn();
  if(refreshBtn) refreshBtn.style.display = "none";

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

  // show refresh inside puchok
  ensureRefreshBtn();
  if(refreshBtn){
    refreshBtn.style.display = "";
    refreshBtn.title = "Обновить пучок";
    refreshBtn.setAttribute("aria-label","Обновить пучок");
  }

  // ✅ ПОРЯДОК КНОПОК В ХЕДЕРЕ (как ты хотел):
  // [ ⟳ ] [ Переименовать ] [ + ]
  // делаем через DOM reorder, без HTML/CSS правок
  try{
    const parent = addMenuBtn && addMenuBtn.parentElement;
    if(parent && refreshBtn && editPuchokBtn && addMenuBtn){
      // гарантируем что все внутри одного контейнера
      if(refreshBtn.parentElement !== parent) parent.appendChild(refreshBtn);
      if(editPuchokBtn.parentElement !== parent) parent.appendChild(editPuchokBtn);
      if(addMenuBtn.parentElement !== parent) parent.appendChild(addMenuBtn);

      // порядок
      parent.insertBefore(refreshBtn, editPuchokBtn);
      parent.insertBefore(editPuchokBtn, addMenuBtn);
      // addMenuBtn останется последним (самый правый)
    }
  }catch{}

  chatHint.textContent = "Ты в пучке: ответы бота можно сохранять кнопкой “В пучок”.";
}

/** ===========================
 *  UI RENDER
 *  =========================== */
function render(){
  mainPanel.innerHTML = "";
  window.currentPuchokId = currentPuchokId;

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
window.render = render;

function renderPuchokList(){
  const wrap = document.createElement("div");
  wrap.className = "list";

  if((db.puchki || []).length === 0){
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "Пока нет пучков.<br>Нажми <b>+ Пучок</b>, потом зайди внутрь и сохраняй туда ответы / заметки / файлы / голос.";
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
    empty.innerHTML = "Внутри пусто.<br>Нажми <b>+</b> сверху справа → добавь текст / файл / голос / код / ссылку.";
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

      if(it.type==="file") thumb.innerHTML = icoSVG("file");
      else if(it.type==="image") thumb.innerHTML = icoSVG("image");
      else if(it.type==="audio") thumb.innerHTML = icoSVG("audio");
      else if(it.type==="code") thumb.innerHTML = icoSVG("code");
      else if(it.type==="link") thumb.innerHTML = icoSVG("link");
      else thumb.innerHTML = icoSVG("image");

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
    for(const it of (p.items || [])){
      if(it && (it.type === "file" || it.type === "image")){
        try{ await deleteItemBlobFromR2(it.id); }catch{}
      }else{
        await cleanupItemBlobsSafe(it);
      }
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

/** ===========================
 *  REFRESH ACTION (no page reload, no kick to home)
 *  =========================== */
async function refreshCurrentPuchokAndStay(){
  if(isBusy) return;
  if(!currentPuchokId) return;

  isBusy = true;
  try{
    const prevScroll = mainPanel ? mainPanel.scrollTop : 0;
    await refreshCurrentPuchok();
    render();
    if(mainPanel) mainPanel.scrollTop = prevScroll;
  }catch(e){
    addMsg("Ошибка обновления: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
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

  const isImg = (file.type || "").startsWith("image/");
  const title = file.name || (isImg ? "Фото" : "Файл");
  const mime  = file.type || (isImg ? "image/*" : "application/octet-stream");
  const size  = file.size || 0;

  isBusy = true;
  try{
    // 1) создаём item в D1
    const created = await apiJson(`/puchki/${encodeURIComponent(p.id)}/items`, {
      method:"POST",
      json:{
        type: "file",
        title,
        mime,
        size,
        meta: {
          r2: { hasBlob: false, name: title, mime }
        }
      }
    });

    let it = mapItemRow(created.item);
    if(isImg) it.type = "image";

    // 2) грузим blob в R2
    if(isImg){
      await uploadItemBlobToR2(it.id, file, { enforceLimit:false });
    }else{
      if((file.size || 0) <= WORKER_UPLOAD_LIMIT_BYTES){
        await uploadItemBlobToR2(it.id, file, { enforceLimit:true });
      }else{
        await directUploadLargeFileToR2({ itemId: it.id, puchokId: p.id, file });
      }
    }

    // 3) патчим meta => hasBlob:true
    it.r2 = { hasBlob:true, name: title, mime };
    it.meta = it.meta && typeof it.meta === "object" ? it.meta : {};
    it.meta.r2 = it.r2;

    await apiJson(`/items/${encodeURIComponent(it.id)}`, {
      method:"PATCH",
      json: itemToPatchPayload(it),
    });

    // 4) обновляем локальную модель гарантированно из облака (подтянуть url/size/meta)
    await refreshCurrentPuchok();

    // ✅ ВАРИАНТ A: после загрузки НЕ открываем файл (нет автодоунлоада)
    // просто перерендерим список — файл появится, а просмотр по клику.
    render();
  }catch(e){
    addMsg("Ошибка добавления файла: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function createAudioItemCloud(){
  const p = ensureCurrentPuchok();
  if(!p) return null;

  const title = `Голос ${new Date().toLocaleDateString()}`;
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

  if(it.type === "image" || it.type === "file"){
    const label = it.type === "image" ? "Фото" : "Файл";
    modalHint.textContent = `${label}: метаданные в облаке (D1), blob в облаке (R2).`;

    modalViewer.innerHTML = `<div class="empty">Загружаю файл из облака…</div>`;

    let blob = null;
    try{
      blob = await downloadItemBlobFromR2(it.id);
    }catch(e){
      modalViewer.innerHTML = `<div class="empty">Ошибка загрузки: ${escapeHTML(e?.message || e)}</div>`;
      return;
    }

    if(!blob){
      modalViewer.innerHTML = `<div class="empty">Blob не найден в R2 (404).</div>`;
      return;
    }

    const url = URL.createObjectURL(blob);

    if(it.type === "image"){
      modalViewer.innerHTML = `
        <img src="${url}" alt="Фото" />
        <div class="viewerActions">
          <button class="btnGhost" id="btnOpenNewTab">Открыть</button>
          <button class="btnGhost" id="btnDownload">Скачать</button>
        </div>
      `;
    }else{
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
    }

    const btnOpenNewTab = document.getElementById("btnOpenNewTab");
    const btnDownload = document.getElementById("btnDownload");

    if(btnOpenNewTab) btnOpenNewTab.onclick = () => window.open(url, "_blank");
    if(btnDownload) btnDownload.onclick = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = it.title || (it.type === "image" ? "image" : "file");
      a.click();
    };

    return;
  }

  if(it.type === "audio"){
    if(typeof renderAudioViewer === "function"){
      await renderAudioViewer(it, puchokId);
    }else{
      modalViewer.innerHTML = `<div class="empty">audio.js не загрузился.</div>`;
    }
    return;
  }

  modalViewer.innerHTML = `<div class="empty">Неизвестный тип элемента.</div>`;
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
    if(it.type === "file" || it.type === "image"){
      try{ await deleteItemBlobFromR2(it.id); }catch{}
    }else{
      await cleanupItemBlobsSafe(it);
    }

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

// refresh click (created on demand)
ensureRefreshBtn();
if(refreshBtn){
  refreshBtn.addEventListener("click", async (e)=>{
    e.stopPropagation();
    closeAddMenu();
    await refreshCurrentPuchokAndStay();
  });
}

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
    const it = await createAudioItemCloud();
    if(!it){
      alert("Не удалось создать голос-элемент в облаке.");
      return;
    }
    render();
    await openItem(currentPuchokId, it.id);

    if(typeof startRecordingToAudioItem === "function"){
      await startRecordingToAudioItem(currentPuchokId, it.id);
    }else if(typeof createAudioItemAndRecord === "function"){
      await createAudioItemAndRecord();
    }else{
      alert("audio.js не загрузился (нет startRecordingToAudioItem).");
    }
  }catch(e){
    addMsg("Ошибка голоса: " + (e?.message || e), "err");
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
    await loadPuchkiList();
  }catch(e){
    // если токена нет — просто стартуем пусто
  }
  render();
  clearChat();
  collapseChat();
})();
