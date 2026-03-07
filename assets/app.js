/** ===========================
 *  PUCHKI — APP (V2 UI for D1 + R2)
 *  ✅ V2 model:
 *    - puchki = контейнер (и подпучок тоже puchki через parent_id)
 *    - puchok_entries = “лента” внутри контейнера: subpuchok + row
 *    - rows = ряды (photo/video/audio/text/code/link/file...)
 *    - items = элементы внутри ряда
 *  ✅ Worker endpoints (V2):
 *    - GET/POST           /puchki
 *    - GET/PATCH/DELETE   /puchki/:id
 *    - POST               /puchki/:id/subpuchok
 *    - POST               /puchki/:id/rows
 *    - GET/PATCH/DELETE   /rows/:id (GET returns row + items)
 *    - POST               /rows/:id/items
 *    - PATCH/DELETE       /items/:id
 *    - PUT/GET/DELETE     /items/:id/blob (+ /blob/complete, /r2/presign)
 *
 *  ⚠️ audio.js: пока как было (локальные сегменты).
 *    Мы сохраняем сегменты через PATCH /items/:id (meta.segments),
 *    но сами “аудио айтемы” теперь живут в audio-row.
 *    Для совместимости audio.js оставляем window.db.puchki[].items как "legacy view"
 *    (только для audio) — чтобы audio.js не ломался.
 *  =========================== */

/** ===========================
 *  CONFIG
 *  =========================== */
const WORKER_URL = "https://gptim24.timashevanatoly10.workers.dev";
const API_TOKEN_STORAGE_KEY = "PUCHKI_API_TOKEN";

// Порог: всё <= 20MB грузим через Worker
const WORKER_UPLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

function itemBlobPath(itemId, qs = "") {
  const base = `/items/${encodeURIComponent(itemId)}/blob`;
  return qs ? `${base}?${qs}` : base;
}
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
let menuAddPhoto = document.getElementById("menuAddPhoto");
const menuAddFile = document.getElementById("menuAddFile");
const menuAddAudio = document.getElementById("menuAddAudio");
const menuAddCode = document.getElementById("menuAddCode");
const menuAddLink = document.getElementById("menuAddLink");
let menuAddSubpuchok = document.getElementById("menuAddSubpuchok");
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
let photoPicker = document.getElementById("photoPicker");

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
 *  REFRESH BUTTON (inside puchok/row)
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

  const parent = addMenuBtn.parentElement;
  if(parent){
    if(addMenuBtn.nextSibling) parent.insertBefore(refreshBtn, addMenuBtn.nextSibling);
    else parent.appendChild(refreshBtn);
  }
  return refreshBtn;
}

/** ===========================
 *  ADD MENU EXTRA BUTTONS
 *  =========================== */
function bindMenuAddPhotoButton(btn){
  if(!btn || btn.dataset.photoBound === "1") return;
  btn.dataset.photoBound = "1";
  btn.addEventListener("click", (e)=>{
    e.preventDefault();
    e.stopPropagation();
    closeAddMenu();
    if(viewMode === "list"){ alert("Сначала открой пучок."); return; }
    addPhotoFromCamera();
  });
}

function ensureAddMenuExtras(){
  if(!addMenu) return;

  let photoBtn = document.getElementById("menuAddPhoto");
  if(!photoBtn){
    photoBtn = document.createElement("button");
    photoBtn.id = "menuAddPhoto";
    photoBtn.type = "button";
    photoBtn.textContent = "Добавить фото";
    if(menuAddFile && menuAddFile.parentElement === addMenu) addMenu.insertBefore(photoBtn, menuAddFile);
    else addMenu.appendChild(photoBtn);
  }
  menuAddPhoto = photoBtn;
  photoBtn.hidden = false;
  photoBtn.disabled = false;
  photoBtn.style.display = "";
  photoBtn.style.visibility = "visible";
  photoBtn.style.opacity = "1";
  bindMenuAddPhotoButton(photoBtn);

  if(!menuAddSubpuchok){
    const btn = document.createElement("button");
    btn.id = "menuAddSubpuchok";
    btn.type = "button";
    btn.textContent = "Подпучок";
    addMenu.insertBefore(btn, addMenu.firstChild);
    menuAddSubpuchok = btn;
  }else{
    menuAddSubpuchok.style.display = "";
    menuAddSubpuchok.hidden = false;
  }
}

function applyHiddenPickerStyles(el){
  if(!el) return;
  el.hidden = false;
  el.style.display = "";
  el.style.visibility = "visible";
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.opacity = "0";
  el.style.width = "1px";
  el.style.height = "1px";
  el.style.pointerEvents = "none";
}

function configurePhotoPickerForCurrentDevice(picker){
  if(!picker) return picker;
  const useCamera = shouldUseCameraCapture();
  picker.accept = "image/*";
  picker.multiple = !useCamera;
  if(useCamera) picker.setAttribute("capture", "environment");
  else picker.removeAttribute("capture");
  applyHiddenPickerStyles(picker);
  return picker;
}

function ensurePhotoPicker(){
  if(photoPicker){
    configurePhotoPickerForCurrentDevice(photoPicker);
    return photoPicker;
  }
  photoPicker = document.createElement("input");
  photoPicker.type = "file";
  photoPicker.id = "photoPicker";
  configurePhotoPickerForCurrentDevice(photoPicker);
  document.body.appendChild(photoPicker);
  return photoPicker;
}

function openPhotoPicker(picker){
  const target = configurePhotoPickerForCurrentDevice(picker || ensurePhotoPicker());
  target.value = "";
  if(typeof target.showPicker === "function"){
    try{
      target.showPicker();
      return;
    }catch{}
  }
  target.click();
}

/** ===========================
 *  STATE
 *  =========================== */
let viewMode = "list";              // "list" | "puchok" | "row"
let currentPuchokId = null;         // container id
let currentRowId = null;            // row id (when viewMode==="row")

let openItemId = null;
let openItemType = null;
let currentModalRowId = null;
let currentModalItemIds = [];
let currentModalItemIndex = -1;
let modalNavBar = null;
let modalOverlayNav = null;
let activePhotoCaptureRowId = null;
let activePhotoCapturePuchokId = null;
let activeFileCaptureRowId = null;
let activeFileCapturePuchokId = null;
let activeCarouselRowId = null;
let activeCarouselItemId = null;
let isBusy = false;

const itemPreviewUrlCache = new Map();
const itemPreviewLoadPromises = new Map();

// In-memory store:
// - db.puchki: root containers list + cached containers
// - db.rows: cached rows
// - legacy db.puchki[].items: ONLY for audio.js compatibility (audio items)
let db = {
  puchki: [],     // [{id,title,createdAt,updatedAt, entries:[], items:[], audioRowId:null}]
  rows: {},       // rowId -> { row:{...}, items:[...], updatedAt }
};
window.db = db;
window.currentPuchokId = currentPuchokId;

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
function isCoarsePointerDevice(){
  try{
    if(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true;
  }catch{}
  return Number(navigator.maxTouchPoints || 0) > 0;
}
function shouldUseCameraCapture(){
  return isIOS() || isCoarsePointerDevice();
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

function sanitizeMimeType(value, fallback = "application/octet-stream"){
  const raw = (value || "").toString().trim();
  if(!raw) return fallback;
  const first = raw.split(";")[0].trim().toLowerCase();
  if(!first || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(first)) return fallback;
  return first;
}
function chooseBlobMimeType(responseType, fallbackType, itemType = ""){
  const fallback = sanitizeMimeType(
    fallbackType || (itemType === "image" ? "image/*" : "application/octet-stream"),
    itemType === "image" ? "image/*" : "application/octet-stream"
  );
  const responseMime = sanitizeMimeType(responseType || "", "");
  const lower = responseMime.toLowerCase();
  const looksGeneric =
    !responseMime ||
    lower === "application/octet-stream" ||
    lower === "binary/octet-stream" ||
    lower === "application/binary" ||
    lower === "text/plain";
  return looksGeneric ? fallback : responseMime;
}


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
  if(kind==="text"){
    return `<svg ${common}><path d="M5 6h14M9 6v12m6-12v12M7 18h10" stroke="#111317" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  if(kind==="photo"){
    return `<svg ${common}><path d="M4 7h4l2-2h4l2 2h4v12H4V7Z" stroke="#111317" stroke-width="2"/><path d="M12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" stroke="#111317" stroke-width="2"/></svg>`;
  }
  if(kind==="video"){
    return `<svg ${common}><path d="M4 6h12v12H4V6Z" stroke="#111317" stroke-width="2"/><path d="M16 10l4-2v8l-4-2v-4Z" stroke="#111317" stroke-width="2" stroke-linejoin="round"/></svg>`;
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

function rowTypeLabel(type){
  const t = (type || "").toLowerCase();
  if(t === "photo") return { text:"Фото-ряд", cls:"tagText tagImg", ico:"photo" };
  if(t === "video") return { text:"Видео-ряд", cls:"tagText tagFile", ico:"video" };
  if(t === "audio") return { text:"Аудио-ряд", cls:"tagText tagAudio", ico:"audio" };
  if(t === "code")  return { text:"Код-ряд", cls:"tagText tagCode", ico:"code" };
  if(t === "link")  return { text:"Ссылки-ряд", cls:"tagText tagLink", ico:"link" };
  if(t === "file")  return { text:"Файлы-ряд", cls:"tagText tagFile", ico:"file" };
  if(t === "text")  return { text:"Текст-ряд", cls:"tagText", ico:"text" };
  return { text: (type || "Ряд"), cls:"tagText", ico:"file" };
}

function getSortedRowItems(rowId){
  const pack = rowId ? db.rows[rowId] : null;
  const items = Array.isArray(pack?.items) ? pack.items : [];
  return [...items].sort((a,b)=> (a.createdAt||a.updatedAt||"").localeCompare(b.createdAt||b.updatedAt||""));
}
function rebuildModalNavState(rowId, itemId){
  currentModalRowId = rowId || null;
  currentModalItemIds = getSortedRowItems(rowId).map(x => x.id);
  currentModalItemIndex = currentModalItemIds.indexOf(itemId);
}

function getModalPanelEl(){
  return modalTextarea?.parentElement || modalViewer?.parentElement || modalWrap?.firstElementChild || modalWrap || null;
}
function ensureModalNavBar(){
  const parent = getModalPanelEl();
  if(!parent) return null;
  if(modalNavBar && modalNavBar.parentElement === parent) return modalNavBar;

  if(modalNavBar && modalNavBar.parentElement){
    try{ modalNavBar.parentElement.removeChild(modalNavBar); }catch{}
  }

  modalNavBar = document.createElement("div");
  modalNavBar.id = "modalNavBar";
  modalNavBar.style.display = "none";
  modalNavBar.style.alignItems = "center";
  modalNavBar.style.justifyContent = "center";
  modalNavBar.style.gap = "10px";
  modalNavBar.style.margin = "0 0 10px 0";
  modalNavBar.style.position = "relative";
  modalNavBar.style.zIndex = "70";

  parent.insertBefore(modalNavBar, modalTextarea || modalViewer || null);
  return modalNavBar;
}
function ensureModalOverlayNav(){
  const panel = getModalPanelEl();
  if(!panel) return null;
  if(modalOverlayNav && modalOverlayNav.parentElement === panel) return modalOverlayNav;

  if(modalOverlayNav && modalOverlayNav.parentElement){
    try{ modalOverlayNav.parentElement.removeChild(modalOverlayNav); }catch{}
  }

  if(getComputedStyle(panel).position === "static"){
    panel.style.position = "relative";
  }
  panel.style.overflow = "visible";

  modalOverlayNav = document.createElement("div");
  modalOverlayNav.id = "modalOverlayNav";
  modalOverlayNav.style.position = "absolute";
  modalOverlayNav.style.left = "0";
  modalOverlayNav.style.right = "0";
  modalOverlayNav.style.top = "0";
  modalOverlayNav.style.bottom = "0";
  modalOverlayNav.style.pointerEvents = "none";
  modalOverlayNav.style.overflow = "visible";
  modalOverlayNav.style.zIndex = "9999";
  modalOverlayNav.innerHTML = `
    <button type="button" id="modalOverlayPrev" aria-label="Предыдущий элемент"
      style="position:absolute;left:12px;top:50%;transform:translateY(-50%);
             min-width:52px;height:52px;padding:0 16px;border:0;border-radius:999px;
             background:rgba(17,19,23,0.88);color:#fff;font-size:28px;line-height:1;
             cursor:pointer;pointer-events:auto;display:none;z-index:10000;
             box-shadow:0 8px 24px rgba(0,0,0,.28);">←</button>
    <div id="modalOverlayCounter"
      style="position:absolute;left:50%;top:12px;transform:translateX(-50%);
             min-width:64px;padding:8px 12px;border-radius:999px;background:rgba(17,19,23,0.72);
             color:#fff;font-size:12px;line-height:1;pointer-events:none;display:none;
             z-index:10000;box-shadow:0 8px 24px rgba(0,0,0,.22);text-align:center;"></div>
    <button type="button" id="modalOverlayNext" aria-label="Следующий элемент"
      style="position:absolute;right:12px;top:50%;transform:translateY(-50%);
             min-width:52px;height:52px;padding:0 16px;border:0;border-radius:999px;
             background:rgba(17,19,23,0.88);color:#fff;font-size:28px;line-height:1;
             cursor:pointer;pointer-events:auto;display:none;z-index:10000;
             box-shadow:0 8px 24px rgba(0,0,0,.28);">→</button>
  `;
  panel.appendChild(modalOverlayNav);
  return modalOverlayNav;
}
function renderModalNav(rowId, itemId){
  const bar = ensureModalNavBar();
  const overlay = ensureModalOverlayNav();
  if(!bar) return;

  rebuildModalNavState(rowId, itemId);

  const hasNav = !!rowId && currentModalItemIndex >= 0 && currentModalItemIds.length > 1;
  if(!hasNav){
    bar.style.display = "none";
    bar.innerHTML = "";
    if(overlay){
      const prev = overlay.querySelector("#modalOverlayPrev");
      const next = overlay.querySelector("#modalOverlayNext");
      const counter = overlay.querySelector("#modalOverlayCounter");
      if(prev){
        prev.style.display = "none";
        prev.onclick = null;
      }
      if(next){
        next.style.display = "none";
        next.onclick = null;
      }
      if(counter){
        counter.style.display = "none";
        counter.textContent = "";
      }
    }
    return;
  }

  const hasPrev = currentModalItemIndex > 0;
  const hasNext = currentModalItemIndex < currentModalItemIds.length - 1;
  const counterText = `${currentModalItemIndex + 1} / ${currentModalItemIds.length}`;

  bar.style.display = "flex";
  bar.innerHTML = `<div style="font-size:12px;opacity:.8;white-space:nowrap;">${counterText}</div>`;

  if(overlay){
    const prev = overlay.querySelector("#modalOverlayPrev");
    const next = overlay.querySelector("#modalOverlayNext");
    const counter = overlay.querySelector("#modalOverlayCounter");

    if(counter){
      counter.textContent = counterText;
      counter.style.display = "block";
    }
    if(prev){
      prev.style.display = hasPrev ? "block" : "none";
      prev.disabled = !hasPrev;
      prev.onclick = hasPrev ? async (e)=>{
        e.preventDefault();
        e.stopPropagation();
        const prevId = currentModalItemIds[currentModalItemIndex - 1];
        if(prevId) await openItemFromRow(rowId, prevId);
      } : null;
    }
    if(next){
      next.style.display = hasNext ? "block" : "none";
      next.disabled = !hasNext;
      next.onclick = hasNext ? async (e)=>{
        e.preventDefault();
        e.stopPropagation();
        const nextId = currentModalItemIds[currentModalItemIndex + 1];
        if(nextId) await openItemFromRow(rowId, nextId);
      } : null;
    }
  }
}

function getModalSiblingItemId(step){
  const nextIndex = currentModalItemIndex + step;
  if(nextIndex < 0 || nextIndex >= currentModalItemIds.length) return null;
  return currentModalItemIds[nextIndex] || null;
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
window.setRangeFill = setRangeFill;

/** ===========================
 *  STORAGE.JS SHIMS (best-effort)
 *  =========================== */
async function cleanupItemBlobsSafe(it){
  try{
    if(typeof cleanupItemBlobs === "function") await cleanupItemBlobs(it);
  }catch{}
}

/** ===========================
 *  DB SHIMS for audio.js (legacy)
 *  =========================== */
function getPuchokLocal(id){ return (db.puchki || []).find(x => x.id === id) || null; }
function getItemLocal(pId, itemId){
  const p = getPuchokLocal(pId);
  if(!p) return null;
  return (p.items || []).find(x => x.id === itemId) || null; // legacy audio items list
}
function saveDBLocal(){
  try{
    if(!currentPuchokId) return;
    schedulePersistAudioItems();
  }catch{}
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
 *  TRANSFER UI (upload/download progress) — JS-only
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
  style.textContent = `@keyframes xferSpin { from { transform:rotate(0deg);} to { transform:rotate(360deg);} }`;
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
  if(now - _xferLastPaint < 70) return;
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

    try{ xhr.send(body); }
    catch(e){ reject(e); }
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
    path.startsWith("/rows") ||
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
async function uploadItemBlobToR2(itemId, file, { enforceLimit = true } = {}){
  if(!file) throw new Error("NO_FILE");
  if(enforceLimit && (file.size || 0) > WORKER_UPLOAD_LIMIT_BYTES){
    throw new Error(`Файл слишком большой для загрузки через Worker (лимит ${fmtBytes(WORKER_UPLOAD_LIMIT_BYTES)}).`);
  }

  const qs = new URLSearchParams();
  qs.set("name", (file.name || "file").toString());
  qs.set("mime", (file.type || "application/octet-stream").toString());

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


async function downloadItemBlobFromR2(itemId, fallbackType = "application/octet-stream", itemType = "", opts = {}){
  const showProgress = opts.showProgress !== false;
  const resp = await apiFetch(itemBlobPath(itemId), { method:"GET" });
  if(resp.status === 404) return null;
  if(!resp.ok){
    const t = await resp.text().catch(()=> "");
    throw new Error(t || `HTTP ${resp.status}`);
  }

  const responseContentType = (resp.headers.get("content-type") || "").trim();
  const blobType = chooseBlobMimeType(responseContentType, fallbackType, itemType);

  if(!resp.body || typeof resp.body.getReader !== "function"){
    const ready = await resp.blob();
    if(ready && ready.type && sanitizeMimeType(ready.type, "") && sanitizeMimeType(ready.type, "") !== "application/octet-stream"){
      return ready;
    }
    return new Blob([ready], { type: blobType });
  }

  let total = null;
  try{
    const cl = resp.headers.get("content-length");
    if(cl) total = Number(cl) || null;
  }catch{}

  if(showProgress){
    showXfer({
      title: "Скачиваю из облака",
      sub: "…",
      determinate: !!(total && total > 0)
    });
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;

  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    if(value){
      chunks.push(value);
      loaded += value.byteLength || value.length || 0;
      if(showProgress){
        updateXfer({ loaded, total, title:"Скачиваю из облака", sub:"" });
      }
    }
  }

  if(showProgress){
    finishXfer({ ok:true, title:"Скачано", sub: total ? "Готово" : `Получено: ${fmtBytes(loaded)}`, autoHideMs: 600 });
  }
  return new Blob(chunks, { type: blobType });
}

/** ===========================
 *  BIG FILE "obhod" (presign -> direct upload -> complete)
 *  =========================== */
async function directUploadLargeFileToR2({ itemId, puchokId, file }){
  if(!file) throw new Error("NO_FILE");

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

  const uploadUrl = presign?.uploadUrl || presign?.upload?.url || "";
  const method = ((presign?.upload?.method) || "PUT").toString().toUpperCase();
  const extraHeaders = (presign?.upload?.headers && typeof presign.upload.headers === "object") ? presign.upload.headers : {};
  const key = presign?.key || presign?.upload?.key || presign?.completed?.key || null;

  if(!uploadUrl){
    throw new Error("Воркер вернул presign без uploadUrl / upload.url (неожиданный формат ответа).");
  }

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

  finishXfer({ ok:true, title:"Загружено", sub:"Файл в R2. Финализирую…", autoHideMs: 0 });

  const done = await apiJson(itemBlobCompletePath(itemId), {
    method: "POST",
    json: {
      key,
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
 *  DATA MAPPING
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
    entries: [],     // V2 entries
    items: [],       // legacy audio-only list for audio.js
    audioRowId: null // cached audio row id if exists
  };
}
function mapRowRow(row){
  return {
    id: row.id,
    puchokId: row.puchok_id,
    type: row.type,
    title: row.title || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapEntryRow(e){
  // accept both shapes:
  // - {id, kind, ref_id, order_index, ... maybe row/subpuchok fields }
  // - {kind, ref_id, order_index, title, type}
  const kind = e.kind || e.entry_kind || e.type_kind || "";
  const refId = e.ref_id || e.refId || e.id_ref || e.ref || "";
  const orderIndex = Number.isFinite(e.order_index) ? e.order_index : Number(e.order_index || 0);

  // Try to read enriched info:
  // For subpuchok: title could be e.title or e.subpuchok_title etc
  // For row: type/title could be e.row_type / e.type / e.row?.type etc
  const subTitle =
    e.title ||
    e.subpuchok_title ||
    e.sub_title ||
    (e.subpuchok && e.subpuchok.title) ||
    (e.puchok && e.puchok.title) ||
    null;

  const rowType =
    e.row_type ||
    e.type ||
    (e.row && e.row.type) ||
    null;

  const rowTitle =
    e.row_title ||
    e.title ||
    (e.row && e.row.title) ||
    null;

  return {
    id: e.id || uid(),
    kind: kind,
    refId: refId,
    orderIndex: orderIndex,
    // optional enriched:
    subTitle: subTitle,
    rowType: rowType,
    rowTitle: rowTitle,
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
    if(meta._rowId) it._rowId = meta._rowId; // legacy helper
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
  if(it._rowId) meta._rowId = it._rowId;

  const payload = {};
  if(it.type) payload.type = it.type === "image" ? "file" : it.type;
  if(it.title !== undefined) payload.title = it.title;
  if(it.content !== undefined) payload.content = it.content;
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

async function loadPuchokWithEntries(puchokId){
  const data = await apiJson(`/puchki/${encodeURIComponent(puchokId)}`, { method:"GET" });
  const pRow = data.puchok;
  const entriesRows = data.entries || data.puchok_entries || [];

  const p = mapPuchokRow(pRow);
  p.entries = (entriesRows || []).map(mapEntryRow).sort((a,b)=> (a.orderIndex||0) - (b.orderIndex||0));

  // Keep legacy audio items list if already exists in cache
  const idx = (db.puchki || []).findIndex(x => x.id === p.id);
  if(idx >= 0){
    const prev = db.puchki[idx];
    p.items = prev.items || [];
    p.audioRowId = prev.audioRowId || null;
    db.puchki[idx] = Object.assign(prev, p);
  }else{
    db.puchki.unshift(p);
  }

  return getPuchokLocal(p.id);
}

async function loadRowWithItems(rowId){
  const data = await apiJson(`/rows/${encodeURIComponent(rowId)}`, { method:"GET" });
  const rowRow = data.row || data.rows || data;
  const itemsRows = data.items || [];

  const row = mapRowRow(rowRow);
  const items = (itemsRows || []).map(mapItemRow);

  db.rows[row.id] = {
    row,
    items,
    updatedAt: row.updatedAt || nowISO(),
  };

  return db.rows[row.id];
}

/** ===========================
 *  PERSIST (throttled) — audio.js compatibility
 *  =========================== */
let persistTimer = null;
let persistInFlight = false;

function schedulePersistAudioItems(){
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

  ensureRefreshBtn();
  if(refreshBtn) refreshBtn.style.display = "none";

  newPuchokBtn.style.display = "";
  chatHint.textContent = "Совет: открой пучок → тогда “В пучок” сохранит ответ туда.";
}

function setHeaderForPuchok(p){
  backBtn.style.display = "";
  headTitle.textContent = "ПУЧКИ";
  headCrumb.textContent = p.title || "Без названия";

  newPuchokBtn.style.display = "none";
  editPuchokBtn.style.display = "";
  addMenuBtn.style.display = "";
  closeAddMenu();

  ensureRefreshBtn();
  if(refreshBtn){
    refreshBtn.style.display = "";
    refreshBtn.title = "Обновить";
    refreshBtn.setAttribute("aria-label","Обновить");
  }

  // порядок кнопок: [⟳] [rename] [+]
  try{
    const parent = addMenuBtn && addMenuBtn.parentElement;
    if(parent && refreshBtn && editPuchokBtn && addMenuBtn){
      if(refreshBtn.parentElement !== parent) parent.appendChild(refreshBtn);
      if(editPuchokBtn.parentElement !== parent) parent.appendChild(editPuchokBtn);
      if(addMenuBtn.parentElement !== parent) parent.appendChild(addMenuBtn);

      parent.insertBefore(refreshBtn, editPuchokBtn);
      parent.insertBefore(editPuchokBtn, addMenuBtn);
    }
  }catch{}

  chatHint.textContent = "Ты в пучке: можно сохранять ответы бота кнопкой “В пучок”.";
}

function setHeaderForRow(p, row){
  backBtn.style.display = "";
  headTitle.textContent = "ПУЧКИ";
  const rt = rowTypeLabel(row?.type);
  headCrumb.textContent = `${p?.title || "Пучок"} • ${rt.text}`;

  newPuchokBtn.style.display = "none";
  editPuchokBtn.style.display = "none";
  addMenuBtn.style.display = "none";
  closeAddMenu();

  ensureRefreshBtn();
  if(refreshBtn){
    refreshBtn.style.display = "";
    refreshBtn.title = "Обновить ряд";
    refreshBtn.setAttribute("aria-label","Обновить ряд");
  }

  try{
    const parent = (refreshBtn && refreshBtn.parentElement) || (addMenuBtn && addMenuBtn.parentElement) || null;
    if(parent && refreshBtn){
      if(refreshBtn.parentElement !== parent) parent.appendChild(refreshBtn);
      if(addMenuBtn && addMenuBtn.parentElement === parent) parent.removeChild(addMenuBtn);
    }
  }catch{}

  chatHint.textContent = "Ты в ряду: добавляй элементы через плитку “+”.";
}

/** ===========================
 *  UI RENDER
 *  =========================== */
function render(){
  ensureAddMenuExtras();
  mainPanel.innerHTML = "";
  window.currentPuchokId = currentPuchokId;

  if(viewMode === "list"){
    setHeaderForList();
    renderPuchokList();
    return;
  }

  if(viewMode === "puchok"){
    const p = getPuchokLocal(currentPuchokId);
    if(!p){
      viewMode = "list";
      currentPuchokId = null;
      render();
      return;
    }
    setHeaderForPuchok(p);
    renderPuchokInside(p);
    return;
  }

  if(viewMode === "row"){
    const p = getPuchokLocal(currentPuchokId);
    const cached = db.rows[currentRowId] || null;
    const row = cached?.row || null;

    if(!p || !row){
      // fallback: go back to puchok
      viewMode = "puchok";
      currentRowId = null;
      render();
      return;
    }

    setHeaderForRow(p, row);
    renderRowInside(p, cached);
    return;
  }
}
window.render = render;

function renderPuchokList(){
  const wrap = document.createElement("div");
  wrap.className = "list";

  if((db.puchki || []).length === 0){
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "Пока нет пучков.<br>Нажми <b>+ Пучок</b>, потом зайди внутрь и добавляй подпучки/ряды.";
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
      pill1.textContent = `Контент: —`;

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

  const entries = (p.entries || []);
  if(entries.length === 0){
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "Внутри пусто.<br>Нажми <b>+</b> сверху → добавь ряд (текст/файлы/код/ссылки/голос) или подпучок.";
    wrap.appendChild(empty);
  }else{
    const sorted = [...entries].sort((a,b)=> (a.orderIndex||0) - (b.orderIndex||0));
    for(const e of sorted){
      const row = document.createElement("div");
      row.className = "itemRow";

      const left = document.createElement("div");
      left.className = "itemLeft";

      const thumb = document.createElement("div");
      thumb.className = "thumb";

      const textWrap = document.createElement("div");
      textWrap.className = "itemText";

      const title = document.createElement("div");
      title.className = "itemTitle";

      const desc = document.createElement("div");
      desc.className = "itemDesc";

      const right = document.createElement("div");

      if((e.kind || "").toLowerCase() === "subpuchok"){
        thumb.innerHTML = icoSVG("file");
        title.textContent = e.subTitle || "Подпучок";
        desc.textContent = "Открыть подпучок";
        right.className = "tagText";
        right.textContent = "Папка";

        row.addEventListener("click", ()=> openPuchok(e.refId));
      }else{
        // row entry
        const rt = rowTypeLabel(e.rowType || "row");
        thumb.innerHTML = icoSVG(rt.ico);
        title.textContent = e.rowTitle || rt.text;
        const cached = db.rows[e.refId];
        const cnt = cached ? (cached.items || []).length : null;
        desc.textContent = cnt != null ? `Элементов: ${cnt}` : "Открыть ряд";
        right.className = rt.cls;
        right.textContent = rt.text.replace("-ряд","");

        row.addEventListener("click", ()=> openRow(e.refId));
      }

      textWrap.appendChild(title);
      textWrap.appendChild(desc);

      left.appendChild(thumb);
      left.appendChild(textWrap);

      row.appendChild(left);
      row.appendChild(right);
      wrap.appendChild(row);
    }
  }

  mainPanel.appendChild(wrap);
}

function applyActiveTileStyles(card, isActive){
  if(!card) return;
  card.style.transition = "transform .16s ease, box-shadow .16s ease, border-color .16s ease";
  if(isActive){
    card.style.transform = "scale(1.05)";
    card.style.border = "1px solid rgba(84,132,255,.95)";
    card.style.boxShadow = "0 14px 28px rgba(84,132,255,.18), 0 0 0 3px rgba(84,132,255,.14)";
  }else{
    card.style.transform = "";
    card.style.border = "";
    card.style.boxShadow = "";
  }
}

function updateActiveRowTileUI(rowId = null){
  const targetRowId = rowId || activeCarouselRowId || currentRowId || null;
  const cards = document.querySelectorAll("[data-row-tile-item-id]");
  cards.forEach((card)=>{
    const isActive =
      !!activeCarouselItemId &&
      card.dataset.rowTileRowId === String(targetRowId || "") &&
      card.dataset.rowTileItemId === String(activeCarouselItemId);
    applyActiveTileStyles(card, isActive);
  });
}

function setActiveCarouselItem(rowId, itemId){
  activeCarouselRowId = rowId || null;
  activeCarouselItemId = itemId || null;
  updateActiveRowTileUI(rowId || null);
}

async function ensureItemPreviewUrl(it){
  if(!it?.id) return "";
  if(itemPreviewUrlCache.has(it.id)) return itemPreviewUrlCache.get(it.id) || "";
  if(itemPreviewLoadPromises.has(it.id)) return await itemPreviewLoadPromises.get(it.id);

  const task = (async ()=>{
    try{
      const blob = await downloadItemBlobFromR2(
        it.id,
        it.mime || "image/*",
        it.type || "image",
        { showProgress:false }
      );
      if(!blob) return "";
      const finalMime = chooseBlobMimeType(blob?.type || "", it.mime || "image/*", it.type || "image");
      const typedBlob = (blob && sanitizeMimeType(blob.type || "", "") === finalMime)
        ? blob
        : new Blob([blob], { type: finalMime });
      const url = URL.createObjectURL(typedBlob);
      itemPreviewUrlCache.set(it.id, url);
      return url;
    }catch{
      return "";
    }finally{
      itemPreviewLoadPromises.delete(it.id);
    }
  })();

  itemPreviewLoadPromises.set(it.id, task);
  return await task;
}

function mountImageTilePreview(previewHost, it){
  if(!previewHost || !it) return;
  previewHost.dataset.previewItemId = String(it.id || "");
  previewHost.innerHTML = `
    <div style="height:132px;border-radius:14px;overflow:hidden;background:rgba(17,19,23,.06);display:flex;align-items:center;justify-content:center;">
      <div class="itemDesc">Загружаю фото…</div>
    </div>
  `;

  ensureItemPreviewUrl(it).then((url)=>{
    if(previewHost.dataset.previewItemId !== String(it.id || "")) return;
    if(!url){
      previewHost.innerHTML = `<div class="itemDesc">${fmtBytes(it.size)} • фото</div>`;
      return;
    }
    previewHost.innerHTML = `
      <div style="height:132px;border-radius:14px;overflow:hidden;background:rgba(17,19,23,.06);">
        <img src="${url}" alt="${escapeHTML(it.title || "Фото")}" style="display:block;width:100%;height:100%;object-fit:cover;" />
      </div>
    `;
  }).catch(()=>{
    if(previewHost.dataset.previewItemId !== String(it.id || "")) return;
    previewHost.innerHTML = `<div class="itemDesc">${fmtBytes(it.size)} • фото</div>`;
  });
}


function renderRowInside(p, cached){
  const wrap = document.createElement("div");
  wrap.className = "list";

  const row = cached.row;
  const items = cached.items || [];

  const top = document.createElement("div");
  top.className = "itemRow";
  top.style.cursor = "default";

  const left = document.createElement("div");
  left.className = "itemLeft";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.innerHTML = icoSVG(rowTypeLabel(row.type).ico);

  const textWrap = document.createElement("div");
  textWrap.className = "itemText";

  const title = document.createElement("div");
  title.className = "itemTitle";
  title.textContent = row.title || rowTypeLabel(row.type).text;

  const desc = document.createElement("div");
  desc.className = "itemDesc";
  desc.textContent = `Элементов: ${items.length}`;

  textWrap.appendChild(title);
  textWrap.appendChild(desc);
  left.appendChild(thumb);
  left.appendChild(textWrap);
  top.appendChild(left);

  const delBtn = document.createElement("button");
  delBtn.className = "btnGhost";
  delBtn.textContent = "Удалить ряд";
  delBtn.addEventListener("click", async (e)=>{
    e.stopPropagation();
    if(!confirm("Удалить весь ряд?")) return;
    isBusy = true;
    try{
      await apiJson(`/rows/${encodeURIComponent(row.id)}`, { method:"DELETE" });
      delete db.rows[row.id];
      await loadPuchokWithEntries(currentPuchokId);
      viewMode = "puchok";
      currentRowId = null;
      render();
    }catch(err){
      addMsg("Ошибка удаления ряда: " + (err?.message || err), "err");
    }finally{
      isBusy = false;
    }
  });
  top.appendChild(delBtn);
  wrap.appendChild(top);

  const rail = document.createElement("div");
  rail.className = "rowCarousel";
  rail.style.display = "flex";
  rail.style.gap = "12px";
  rail.style.overflowX = "auto";
  rail.style.paddingBottom = "8px";
  rail.style.scrollSnapType = "x mandatory";
  rail.style.WebkitOverflowScrolling = "touch";

  const sorted = [...items].sort((a,b)=> (a.createdAt||a.updatedAt||"").localeCompare(b.createdAt||b.updatedAt||""));
  for(const it of sorted){
    const card = document.createElement("div");
    card.className = "card";
    card.style.minWidth = "260px";
    card.style.maxWidth = "320px";
    card.style.flex = "0 0 82%";
    card.style.scrollSnapAlign = "start";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "10px";
    card.style.cursor = "pointer";
    card.dataset.rowTileRowId = row.id;
    card.dataset.rowTileItemId = it.id;
    applyActiveTileStyles(card, activeCarouselRowId === row.id && activeCarouselItemId === it.id);
    card.addEventListener("click", () => openItemFromRow(row.id, it.id));

    const t = typeLabel(it);

    let previewHTML = "";
    if(it.type === "text"){
      previewHTML = escapeHTML((it.content || "").toString().trim().replace(/\s+/g," ").slice(0,220) || "Пусто");
    }else if(it.type === "code"){
      previewHTML = `<pre style="margin:0;white-space:pre-wrap;font-family:monospace;font-size:12px;">${escapeHTML((it.content || "").toString().slice(0,220) || "Пусто")}</pre>`;
    }else if(it.type === "link"){
      previewHTML = `<div class="itemDesc" style="word-break:break-all">${escapeHTML(it.url || "—")}</div>`;
    }else if(it.type === "image"){
      previewHTML = `<div class="itemDesc">${fmtBytes(it.size)} • фото</div>`;
    }else if(it.type === "file"){
      previewHTML = `<div class="itemDesc">${escapeHTML(it.mime || "file")} • ${fmtBytes(it.size)}</div>`;
    }else if(it.type === "audio"){
      const segs = (it.segments || []).length;
      previewHTML = `<div class="itemDesc">Сегментов: ${segs}</div>`;
    }else{
      previewHTML = `<div class="itemDesc">${fmtDate(it.createdAt || it.updatedAt || nowISO())}</div>`;
    }

    const isPhotoTile = it.type === "image" && (row.type || "").toLowerCase() === "photo";
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;">
          <div class="thumb">${icoSVG(it.type==="image" ? "photo" : (it.type || "file"))}</div>
          <div class="itemText" style="min-width:0;">
            <div class="itemTitle">${escapeHTML(it.title || "Элемент")}</div>
            <div class="itemDesc">${fmtDate(it.updatedAt || it.createdAt || nowISO())}</div>
          </div>
        </div>
        <div class="${t.cls}">${t.text}</div>
      </div>
      <div class="rowTilePreviewHost" style="min-height:${isPhotoTile ? "132px" : "72px"};">${previewHTML}</div>
    `;

    if(isPhotoTile){
      const previewHost = card.querySelector(".rowTilePreviewHost");
      mountImageTilePreview(previewHost, it);
    }

    rail.appendChild(card);
  }

  const addCard = document.createElement("div");
  addCard.className = "card";
  addCard.style.minWidth = "260px";
  addCard.style.maxWidth = "320px";
  addCard.style.flex = "0 0 82%";
  addCard.style.scrollSnapAlign = "start";
  addCard.style.display = "flex";
  addCard.style.flexDirection = "column";
  addCard.style.alignItems = "center";
  addCard.style.justifyContent = "center";
  addCard.style.gap = "14px";
  addCard.style.cursor = "pointer";
  addCard.style.minHeight = "180px";
  addCard.style.textAlign = "center";
  addCard.setAttribute("role", "button");
  addCard.setAttribute("tabindex", "0");
  addCard.innerHTML = `
    <div style="width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:rgba(17,19,23,.08);font-size:34px;line-height:1;">+</div>
    <div class="itemText" style="align-items:center;text-align:center;">
      <div class="itemTitle">Добавить</div>
      <div class="itemDesc">${escapeHTML(rowTypeLabel(row.type).text.replace("-ряд",""))}</div>
    </div>
  `;
  const triggerAdd = async (e)=>{
    if(e){
      e.preventDefault();
      e.stopPropagation();
    }
    await addItemViaRowTile(row.id);
  };
  addCard.addEventListener("click", triggerAdd);
  addCard.addEventListener("keydown", async (e)=>{
    if(e.key === "Enter" || e.key === " "){
      await triggerAdd(e);
    }
  });
  rail.appendChild(addCard);

  wrap.appendChild(rail);
  mainPanel.appendChild(wrap);
  updateActiveRowTileUI(row.id);
}

/** ===========================
 *  NAV
 *  =========================== */
async function openPuchok(id){
  if(isBusy) return;
  isBusy = true;
  try{
    currentPuchokId = id;
    currentRowId = null;
    viewMode = "puchok";
    await loadPuchokWithEntries(id);
  }catch(e){
    addMsg("Ошибка загрузки пучка: " + (e?.message || e), "err");
    viewMode = "list";
    currentPuchokId = null;
  }finally{
    isBusy = false;
    render();
  }
}

async function openRow(rowId){
  if(isBusy) return;
  isBusy = true;
  try{
    currentRowId = rowId;
    viewMode = "row";
    await loadRowWithItems(rowId);
  }catch(e){
    addMsg("Ошибка загрузки ряда: " + (e?.message || e), "err");
    viewMode = "puchok";
    currentRowId = null;
  }finally{
    isBusy = false;
    render();
  }
}

function goBack(){
  closeAddMenu();
  if(viewMode === "row"){
    viewMode = "puchok";
    currentRowId = null;
    render();
    return;
  }
  if(viewMode === "puchok"){
    viewMode = "list";
    currentPuchokId = null;
    currentRowId = null;
    render();
    return;
  }
  // list
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
    await openPuchok(p.id);
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
    await apiJson(`/puchki/${encodeURIComponent(p.id)}`, { method:"DELETE" });

    // drop cache
    db.puchki = (db.puchki || []).filter(x => x.id !== p.id);
    // also remove any rows cache that belong to this puchok (best-effort)
    try{
      for(const [rid, pack] of Object.entries(db.rows || {})){
        if(pack?.row?.puchokId === p.id) delete db.rows[rid];
      }
    }catch{}

    viewMode = "list";
    currentPuchokId = null;
    currentRowId = null;
  }catch(e){
    addMsg("Ошибка удаления пучка: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    render();
  }
}

/** ===========================
 *  CRUD: V2 create subpuchok / row / item
 *  =========================== */
function ensureCurrentPuchok(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p){
    alert("Сначала открой пучок.");
    return null;
  }
  return p;
}

async function createSubpuchokInCurrent(){
  const p = ensureCurrentPuchok();
  if(!p) return;

  const name = prompt("Название подпучка:", "Новый подпучок");
  if(name === null) return;
  const title = (name || "").trim() || "Новый подпучок";

  isBusy = true;
  try{
    await apiJson(`/puchki/${encodeURIComponent(p.id)}/subpuchok`, {
      method:"POST",
      json:{ title }
    });
    await loadPuchokWithEntries(p.id);
  }catch(e){
    addMsg("Ошибка создания подпучка: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    render();
  }
}

async function createRowInPuchok(puchokId, { type, title=null }){
  const data = await apiJson(`/puchki/${encodeURIComponent(puchokId)}/rows`, {
    method:"POST",
    json:{ type, title }
  });

  // Worker may return {row, entry} or similar — we only need row.id
  const row = data.row || data.rows || data.createdRow || null;
  const rowId = row?.id || data.row_id || data.id || null;

  if(!rowId) throw new Error("WORKER_NO_ROW_ID");
  return rowId;
}

async function createNewRowForType(puchok, type){
  const rowId = await createRowInPuchok(puchok.id, { type, title: null });
  await loadPuchokWithEntries(puchok.id);
  return rowId;
}

function getCurrentRowPack(){
  return currentRowId ? (db.rows[currentRowId] || null) : null;
}

function getCurrentRowType(){
  return (getCurrentRowPack()?.row?.type || "").toLowerCase();
}

function isRowAddTileSupported(rowType){
  return ["photo","text","code","file","link","audio"].includes((rowType || "").toLowerCase());
}

function openFilePickerForRow(rowId){
  if(!rowId || !filePicker) return;
  const p = ensureCurrentPuchok();
  if(!p) return;
  activeFileCaptureRowId = rowId;
  activeFileCapturePuchokId = p.id;
  filePicker.value = "";
  filePicker.click();
}

async function addTextItemToSpecificRow(rowId, initialText = ""){
  const p = ensureCurrentPuchok();
  if(!p || !rowId) return;

  const content = (initialText || "").toString();
  const title = safeTitleFromText(content) || "Текст";

  isBusy = true;
  try{
    const created = await createItemInRow(rowId, { type:"text", title, content });
    currentRowId = rowId;
    viewMode = "row";
    await refreshRowAndKeepUI(rowId);
    const it = (db.rows[rowId]?.items || []).find(x => x.id === created.id) || mapItemRow(created);
    await openItemFromRow(rowId, it.id);
  }catch(e){
    addMsg("Ошибка добавления текста: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function addCodeItemToSpecificRow(rowId, initialCode = ""){
  const p = ensureCurrentPuchok();
  if(!p || !rowId) return;

  const content = (initialCode || "").toString();
  const title = safeTitleFromText(content) || "Код";

  isBusy = true;
  try{
    const created = await createItemInRow(rowId, { type:"code", title, content });
    currentRowId = rowId;
    viewMode = "row";
    await refreshRowAndKeepUI(rowId);
    const it = (db.rows[rowId]?.items || []).find(x => x.id === created.id) || mapItemRow(created);
    await openItemFromRow(rowId, it.id);
  }catch(e){
    addMsg("Ошибка добавления кода: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function addLinkItemsToSpecificRow(rowId, rawInput){
  const p = ensureCurrentPuchok();
  if(!p || !rowId) return;

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
      await createItemInRow(rowId, { type:"link", title, url: u });
    }

    currentRowId = rowId;
    viewMode = "row";
    await refreshRowAndKeepUI(rowId);
  }catch(e){
    addMsg("Ошибка добавления ссылок: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function createAudioItemInSpecificRow(rowId){
  const p = ensureCurrentPuchok();
  if(!p || !rowId) return null;

  isBusy = true;
  try{
    const title = `Голос ${new Date().toLocaleDateString()}`;
    const meta = { segments: [], durationSec: 0, localOnly: true, _rowId: rowId };
    const created = await createItemInRow(rowId, { type:"audio", title, meta });
    const it = mapItemRow(created);
    it.type = "audio";
    it.segments = [];
    it.durationSec = 0;
    it._rowId = rowId;

    const pLocal = getPuchokLocal(p.id);
    if(pLocal){
      pLocal.items = pLocal.items || [];
      pLocal.items.unshift(it);
      pLocal.updatedAt = it.updatedAt || nowISO();
      pLocal.audioRowId = rowId;
    }

    currentRowId = rowId;
    viewMode = "row";
    await refreshRowAndKeepUI(rowId);
    return (db.rows[rowId]?.items || []).find(x => x.id === it.id) || it;
  }finally{
    isBusy = false;
  }
}

async function addItemViaRowTile(rowId){
  const pack = rowId ? db.rows[rowId] : null;
  const row = pack?.row || null;
  if(!row) return;

  const rowType = (row.type || "").toLowerCase();

  if(rowType === "photo"){
    activePhotoCaptureRowId = rowId;
    activePhotoCapturePuchokId = currentPuchokId;
    await addPhotoFromCamera();
    return;
  }

  if(rowType === "text"){
    await addTextItemToSpecificRow(rowId, "");
    return;
  }

  if(rowType === "code"){
    await addCodeItemToSpecificRow(rowId, "");
    return;
  }

  if(rowType === "file"){
    openFilePickerForRow(rowId);
    return;
  }

  if(rowType === "link"){
    const raw = prompt("Вставь ссылку (или несколько строк):", "");
    if(raw === null) return;
    await addLinkItemsToSpecificRow(rowId, raw);
    return;
  }

  if(rowType === "audio"){
    try{
      const it = await createAudioItemInSpecificRow(rowId);
      if(!it){
        alert("Не удалось создать голос-элемент в облаке.");
        return;
      }
      modalWrap.style.display = "flex";
      await openItemFromRow(rowId, it.id);

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
    return;
  }

  alert("Для этого типа ряда добавление через плитку пока не поддерживается.");
}

async function resolveTargetRowForCreate(puchok, type){
  if(viewMode === "row" && currentRowId){
    const pack = getCurrentRowPack();
    if(pack?.row?.id) return pack.row.id;
  }
  return await createNewRowForType(puchok, type);
}

async function createItemInRow(rowId, payload){
  const data = await apiJson(`/rows/${encodeURIComponent(rowId)}/items`, {
    method:"POST",
    json: payload
  });
  return data.item || data;
}

/** ===========================
 *  REFRESH
 *  =========================== */
async function refreshCurrentPuchok(){
  if(!currentPuchokId) return;
  await loadPuchokWithEntries(currentPuchokId);
}
async function refreshCurrentRow(){
  if(!currentRowId) return;
  await loadRowWithItems(currentRowId);
}
async function refreshStay(){
  if(isBusy) return;
  isBusy = true;
  try{
    const prevScroll = mainPanel ? mainPanel.scrollTop : 0;
    if(viewMode === "puchok") await refreshCurrentPuchok();
    else if(viewMode === "row") await refreshCurrentRow();
    render();
    if(mainPanel) mainPanel.scrollTop = prevScroll;
  }catch(e){
    addMsg("Ошибка обновления: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}
async function refreshRowAndKeepUI(rowId){
  if(!rowId) return null;
  await loadRowWithItems(rowId);
  if(currentPuchokId){
    try{ await loadPuchokWithEntries(currentPuchokId); }catch{}
  }
  if(viewMode === "row" || currentRowId === rowId){
    currentRowId = rowId;
  }
  render();
  return db.rows[rowId] || null;
}

/** ===========================
 *  ADD actions (stage 1: auto-create row if needed)
 *  =========================== */
async function addTextItemToCurrent(initialText = ""){
  const p = ensureCurrentPuchok();
  if(!p) return;

  const content = (initialText || "").toString();
  const title = safeTitleFromText(content) || "Текст";

  isBusy = true;
  try{
    const rowId = await resolveTargetRowForCreate(p, "text");
    const created = await createItemInRow(rowId, { type:"text", title, content });

    await refreshRowAndKeepUI(rowId);

    if(viewMode === "row" && currentRowId === rowId){
      render();
    }else{
      currentRowId = rowId;
      viewMode = "row";
      render();
    }

    const it = (db.rows[rowId]?.items || []).find(x => x.id === created.id) || mapItemRow(created);
    await openItemFromRow(rowId, it.id);
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
    const rowId = await resolveTargetRowForCreate(p, "code");
    const created = await createItemInRow(rowId, { type:"code", title, content });

    await refreshRowAndKeepUI(rowId);

    if(viewMode === "row" && currentRowId === rowId){
      render();
    }else{
      currentRowId = rowId;
      viewMode = "row";
      render();
    }

    const it = (db.rows[rowId]?.items || []).find(x => x.id === created.id) || mapItemRow(created);
    await openItemFromRow(rowId, it.id);
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
    const rowId = await resolveTargetRowForCreate(p, "link");
    for(const line of lines){
      const u = normalizeUrl(line);
      if(!u) continue;

      const title = urlTitle(u);
      await createItemInRow(rowId, { type:"link", title, url: u });
    }

    await refreshRowAndKeepUI(rowId);

    if(viewMode === "row" && currentRowId === rowId){
      render();
    }else{
      currentRowId = rowId;
      viewMode = "row";
      render();
    }
  }catch(e){
    addMsg("Ошибка добавления ссылок: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}


async function addFileItemToSpecificRow(p, rowId, file){
  const isImg = (file.type || "").startsWith("image/");
  const title = file.name || (isImg ? "Фото" : "Файл");
  const mime  = sanitizeMimeType(file.type || (isImg ? "image/*" : "application/octet-stream"), isImg ? "image/*" : "application/octet-stream");
  const size  = file.size || 0;

  const created = await createItemInRow(rowId, {
    type: "file",
    title,
    mime,
    size,
    meta: { r2: { hasBlob:false, name:title, mime } }
  });

  let it = mapItemRow(created);
  if(isImg) it.type = "image";

  if(isImg){
    await uploadItemBlobToR2(it.id, file, { enforceLimit:false });
  }else{
    if((file.size || 0) <= WORKER_UPLOAD_LIMIT_BYTES){
      await uploadItemBlobToR2(it.id, file, { enforceLimit:true });
    }else{
      await directUploadLargeFileToR2({ itemId: it.id, puchokId: p.id, file });
    }
  }

  it._rowId = rowId;
  it.r2 = { hasBlob:true, name: title, mime };
  it.meta = it.meta && typeof it.meta === "object" ? it.meta : {};
  it.meta.r2 = it.r2;
  it.meta._rowId = rowId;

  await apiJson(`/items/${encodeURIComponent(it.id)}`, {
    method:"PATCH",
    json: itemToPatchPayload(it),
  });

  await refreshRowAndKeepUI(rowId);

  if(isImg){
    activePhotoCaptureRowId = rowId;
    activePhotoCapturePuchokId = p.id;
  }

  return { rowId, itemId: it.id };
}

async function ensurePhotoRowForCapture(p){
  if(!p) return null;

  if(viewMode === "row" && currentRowId){
    const pack = getCurrentRowPack();
    if(pack?.row?.type === "photo") return pack.row.id;
  }

  if(activePhotoCaptureRowId && activePhotoCapturePuchokId === p.id){
    const cached = db.rows[activePhotoCaptureRowId];
    if(cached?.row?.id && cached.row.puchokId === p.id && cached.row.type === "photo"){
      return cached.row.id;
    }
    try{
      const fresh = await loadRowWithItems(activePhotoCaptureRowId);
      if(fresh?.row?.id && fresh.row.puchokId === p.id && fresh.row.type === "photo"){
        return fresh.row.id;
      }
    }catch{}
  }

  const rowId = await createNewRowForType(p, "photo");
  activePhotoCaptureRowId = rowId;
  activePhotoCapturePuchokId = p.id;
  return rowId;
}

async function addFileItemToCurrent(file){
  const p = ensureCurrentPuchok();
  if(!p) return;

  isBusy = true;
  try{
    const rowType = (file.type || "").startsWith("image/") ? "photo" : "file";
    const rowId = await resolveTargetRowForCreate(p, rowType);
    const created = await addFileItemToSpecificRow(p, rowId, file);

    if(viewMode === "row" && currentRowId === rowId){
      render();
    }else{
      currentRowId = rowId;
      viewMode = "row";
      render();
    }

    await openItemFromRow(rowId, created.itemId);
  }catch(e){
    addMsg("Ошибка добавления файла: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
  }
}

async function addPhotoFromCamera(){
  const p = ensureCurrentPuchok();
  if(!p) return;

  try{
    activePhotoCapturePuchokId = p.id;

    const currentPack = getCurrentRowPack();
    if(viewMode === "row" && currentPack?.row?.type === "photo"){
      activePhotoCaptureRowId = currentPack.row.id;
      currentRowId = currentPack.row.id;
    }else if(activePhotoCaptureRowId && activePhotoCapturePuchokId === p.id){
      currentRowId = activePhotoCaptureRowId;
    }

    const picker = ensurePhotoPicker();
    openPhotoPicker(picker);
  }catch(e){
    addMsg("Ошибка подготовки фото: " + (e?.message || e), "err");
  }
}

async function createAudioItemCloud(){
  const p = ensureCurrentPuchok();
  if(!p) return null;

  isBusy = true;
  try{
    const rowId = await resolveTargetRowForCreate(p, "audio");
    const pp = getPuchokLocal(p.id);
    if(pp) pp.audioRowId = rowId;

    const title = `Голос ${new Date().toLocaleDateString()}`;
    const meta = { segments: [], durationSec: 0, localOnly: true, _rowId: rowId };

    const created = await createItemInRow(rowId, { type:"audio", title, meta });
    const it = mapItemRow(created);
    it.type = "audio";
    it.segments = [];
    it.durationSec = 0;
    it._rowId = rowId;

    const pLocal = getPuchokLocal(p.id);
    if(pLocal){
      pLocal.items = pLocal.items || [];
      pLocal.items.unshift(it);
      pLocal.updatedAt = it.updatedAt || nowISO();
    }

    await loadRowWithItems(rowId);

    if(viewMode === "row" && currentRowId === rowId){
      render();
    }else{
      await openRow(rowId);
    }

    return it;
  }finally{
    isBusy = false;
  }
}

/** ===========================
 *  MODAL / OPEN ITEM (from row)
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
  if(modalNavBar){
    modalNavBar.style.display = "none";
    modalNavBar.innerHTML = "";
  }
  if(modalOverlayNav){
    const prev = modalOverlayNav.querySelector("#modalOverlayPrev");
    const next = modalOverlayNav.querySelector("#modalOverlayNext");
    const counter = modalOverlayNav.querySelector("#modalOverlayCounter");
    if(prev){ prev.style.display = "none"; prev.onclick = null; }
    if(next){ next.style.display = "none"; next.onclick = null; }
    if(counter){ counter.style.display = "none"; counter.textContent = ""; }
  }
  openItemId = null;
  openItemType = null;
  currentModalRowId = null;
  currentModalItemIds = [];
  currentModalItemIndex = -1;
}

async function openItemFromRow(rowId, itemId){
  const pack = db.rows[rowId];
  if(!pack) return;
  const it = (pack.items || []).find(x => x.id === itemId);
  if(!it) return;

  if(typeof stopSmartPlayback === "function") stopSmartPlayback();

  openItemId = itemId;
  openItemType = it.type;
  currentModalRowId = rowId;
  setActiveCarouselItem(rowId, itemId);

  modalTitle.textContent = it.title || "Элемент";
  modalHint.textContent = "";
  modalViewer.innerHTML = "";

  modalDelete.style.display = "";
  modalSave.style.display = "none";
  modalCopy.style.display = "none";
  modalTextarea.classList.remove("codeTextarea");
  renderModalNav(rowId, itemId);

  if(it.type === "text"){
    modalTextarea.style.display = "block";
    modalViewer.style.display = "none";
    modalTextarea.value = it.content || "";
    modalSave.style.display = "";
    modalHint.textContent = "Текст хранится в облаке (D1).";
    modalWrap.style.display = "flex";
    renderModalNav(rowId, itemId);
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
    renderModalNav(rowId, itemId);
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
    renderModalNav(rowId, itemId);
    const btnOpen = document.getElementById("btnOpenLink");
    const btnCopy = document.getElementById("btnCopyLink");
    if(btnOpen) btnOpen.onclick = () => url && window.open(url, "_blank");
    if(btnCopy) btnCopy.onclick = async () => {
      if(!url) return;
      try{ await navigator.clipboard.writeText(url); }
      catch{
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
      blob = await downloadItemBlobFromR2(it.id, it.mime || (it.type === "image" ? "image/*" : "application/octet-stream"), it.type);
    }catch(e){
      modalViewer.innerHTML = `<div class="empty">Ошибка загрузки: ${escapeHTML(e?.message || e)}</div>`;
      return;
    }

    if(!blob){
      modalViewer.innerHTML = `<div class="empty">Blob не найден в R2 (404).</div>`;
      return;
    }

    const finalMime = chooseBlobMimeType(blob?.type || "", it.mime || (it.type === "image" ? "image/*" : "application/octet-stream"), it.type);
    const typedBlob = (blob && sanitizeMimeType(blob.type || "", "") === finalMime)
      ? blob
      : new Blob([blob], { type: finalMime });
    const url = URL.createObjectURL(typedBlob);

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

    renderModalNav(rowId, itemId);
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
    // audio.js expects currentPuchokId + itemId
    // We keep legacy audio item list in puchok.items
    if(typeof renderAudioViewer === "function"){
      renderModalNav(rowId, itemId);
      await renderAudioViewer(it, currentPuchokId);
    }else{
      modalViewer.innerHTML = `<div class="empty">audio.js не загрузился.</div>`;
      renderModalNav(rowId, itemId);
    }
    return;
  }

  modalViewer.innerHTML = `<div class="empty">Неизвестный тип элемента.</div>`;
}

/** ===========================
 *  MODAL SAVE/DELETE/COPY
 *  =========================== */
async function saveModal(){
  if(viewMode !== "row" || !currentRowId) return;
  const pack = db.rows[currentRowId];
  if(!pack) return;

  const it = (pack.items || []).find(x => x.id === openItemId);
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
      await refreshCurrentRow();
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
      await refreshCurrentRow();
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
  if(viewMode !== "row" || !currentRowId) return;
  const pack = db.rows[currentRowId];
  if(!pack) return;

  const it = (pack.items || []).find(x => x.id === openItemId);
  if(!it) return;

  let text = "";
  if(it.type === "code") text = (modalTextarea.value || it.content || "").toString();
  else if(it.type === "text") text = (modalTextarea.value || it.content || "").toString();
  else if(it.type === "link") text = (it.url || "").toString();
  if(!text) return;

  try{ await navigator.clipboard.writeText(text); }
  catch{
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); }catch{}
    ta.remove();
  }
}

async function deleteModal(){
  if(viewMode !== "row" || !currentRowId) return;
  const pack = db.rows[currentRowId];
  if(!pack) return;

  const it = (pack.items || []).find(x => x.id === openItemId);
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

    // legacy audio list cleanup
    try{
      if(it.type === "audio"){
        const p = getPuchokLocal(currentPuchokId);
        if(p && p.items) p.items = p.items.filter(x => x.id !== it.id);
      }
    }catch{}

    await refreshCurrentRow();
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
      if(!currentPuchokId || viewMode === "list"){
        alert("Открой пучок — тогда “В пучок” сохранит ответ туда.");
        return;
      }
      // stage 1 behavior: save bot answer as text item in text-row
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
    await refreshStay();
  });
}

/**
 * Add menu:
 * - When in P U C H O K view: кнопки создают/добавляют в нужные ряды
 * - When in R O W view: кнопки добавляют items в текущий ряд (по типу ряда)
 */
menuAddText.addEventListener("click", ()=>{
  closeAddMenu();
  if(viewMode === "row"){ return; }
  addTextItemToCurrent("");
});


document.addEventListener("click", (e)=>{
  const btn = e.target && e.target.closest ? e.target.closest("#menuAddSubpuchok") : null;
  if(!btn) return;
  e.preventDefault();
  e.stopPropagation();
  closeAddMenu();
  if(viewMode !== "puchok"){ alert("Подпучок можно создать только внутри пучка."); return; }
  createSubpuchokInCurrent();
});

menuAddFile.addEventListener("click", ()=>{
  closeAddMenu();
  if(viewMode === "list"){ alert("Сначала открой пучок."); return; }
  if(viewMode === "row"){ return; }
  activeFileCaptureRowId = null;
  activeFileCapturePuchokId = null;
  filePicker.value = "";
  filePicker.click();
});

menuAddAudio.addEventListener("click", async ()=>{
  closeAddMenu();
  if(viewMode === "list"){ alert("Сначала открой пучок."); return; }
  if(viewMode === "row"){ return; }
  try{
    const it = await createAudioItemCloud();
    if(!it){
      alert("Не удалось создать голос-элемент в облаке.");
      return;
    }
    render();
    modalWrap.style.display = "flex";
    await openItemFromRow(currentRowId, it.id);

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
  if(viewMode === "list"){ alert("Сначала открой пучок."); return; }
  if(viewMode === "row"){ return; }
  addCodeItemToCurrent("");
});

menuAddLink.addEventListener("click", ()=>{
  closeAddMenu();
  if(viewMode === "list"){ alert("Сначала открой пучок."); return; }
  if(viewMode === "row"){ return; }
  const raw = prompt("Вставь ссылку (или несколько строк):", "");
  if(raw === null) return;
  addLinkItemsToCurrent(raw);
});


menuDeletePuchok.addEventListener("click", async ()=>{
  if(viewMode !== "puchok"){ alert("Удаление доступно только на уровне пучка."); return; }
  await deleteCurrentPuchok();
});

filePicker.addEventListener("change", async () => {
  const files = Array.from(filePicker.files || []).filter(Boolean);
  if(files.length === 0) return;

  const targetRowId = activeFileCaptureRowId;
  const targetPuchokId = activeFileCapturePuchokId;

  try{
    if(targetRowId && targetPuchokId && targetPuchokId === currentPuchokId){
      const p = ensureCurrentPuchok();
      if(!p){
        activeFileCaptureRowId = null;
        activeFileCapturePuchokId = null;
        return;
      }

      isBusy = true;
      let lastItemId = null;
      for(const f of files){
        const created = await addFileItemToSpecificRow(p, targetRowId, f);
        lastItemId = created.itemId;
      }

      currentRowId = targetRowId;
      viewMode = "row";
      await refreshRowAndKeepUI(targetRowId);

      if(lastItemId){
        await openItemFromRow(targetRowId, lastItemId);
      }
    }else{
      for(const f of files){
        await addFileItemToCurrent(f);
      }
    }
  }catch(e){
    addMsg("Ошибка добавления файла: " + (e?.message || e), "err");
  }finally{
    activeFileCaptureRowId = null;
    activeFileCapturePuchokId = null;
    filePicker.value = "";
    isBusy = false;
  }
});

ensurePhotoPicker();
photoPicker.addEventListener("change", async () => {
  const picker = configurePhotoPickerForCurrentDevice(ensurePhotoPicker());
  const files = Array.from(picker.files || []).filter(Boolean);
  if(files.length === 0){
    isBusy = false;
    picker.value = "";
    return;
  }

  const p = ensureCurrentPuchok();
  if(!p){
    isBusy = false;
    picker.value = "";
    return;
  }

  isBusy = true;
  try{
    const rowId = await ensurePhotoRowForCapture(p);
    let lastItemId = null;

    for(const f of files){
      const created = await addFileItemToSpecificRow(p, rowId, f);
      lastItemId = created.itemId;
    }

    currentRowId = rowId;
    viewMode = "row";
    await refreshRowAndKeepUI(rowId);

    if(lastItemId){
      await openItemFromRow(rowId, lastItemId);
    }
  }catch(e){
    addMsg("Ошибка добавления фото: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    picker.value = "";
  }
});

// audioPicker handler is in audio.js (it appends segments to legacy item, then saveDBLocal() persists)
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

document.addEventListener("keydown", async (e)=>{
  if(modalWrap.style.display !== "flex") return;
  if(e.key === "ArrowLeft"){
    const prevId = getModalSiblingItemId(-1);
    if(prevId){
      e.preventDefault();
      await openItemFromRow(currentModalRowId, prevId);
    }
  }else if(e.key === "ArrowRight"){
    const nextId = getModalSiblingItemId(1);
    if(nextId){
      e.preventDefault();
      await openItemFromRow(currentModalRowId, nextId);
    }
  }else if(e.key === "Escape"){
    e.preventDefault();
    closeModal();
  }
});

document.addEventListener("click", ()=> closeAddMenu());
addMenu.addEventListener("click", (e)=> e.stopPropagation());

/** ===========================
 *  INIT
 *  =========================== */
(async function init(){
  ensureAddMenuExtras();
  try{
    await loadPuchkiList();
  }catch(e){
    // если токена нет — просто стартуем пусто
  }
  viewMode = "list";
  currentPuchokId = null;
  currentRowId = null;

  render();
  clearChat();
  collapseChat();
})();

/** ===========================
 *  EXTRA: Long-press / hidden action to create SUBPUCHOK (stage 1 helper)
 *  - в UI пока нет кнопки, поэтому делаем: длительное нажатие на "+" в пучке => подпучок
 *  =========================== */
(function bindLongPressForSubpuchok(){
  if(!addMenuBtn) return;
  let t = null;

  const start = ()=>{
    if(viewMode !== "puchok") return;
    if(t) clearTimeout(t);
    t = setTimeout(()=>{
      // create subpuchok fast
      closeAddMenu();
      createSubpuchokInCurrent();
    }, 650);
  };
  const stop = ()=>{
    if(t) clearTimeout(t);
    t = null;
  };

  addMenuBtn.addEventListener("touchstart", start, { passive:true });
  addMenuBtn.addEventListener("touchend", stop, { passive:true });
  addMenuBtn.addEventListener("touchcancel", stop, { passive:true });

  addMenuBtn.addEventListener("mousedown", start);
  addMenuBtn.addEventListener("mouseup", stop);
  addMenuBtn.addEventListener("mouseleave", stop);
})();
