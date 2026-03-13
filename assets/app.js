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
const headerActionsHost = addMenuBtn ? addMenuBtn.parentElement : null;
const addMenu = document.getElementById("addMenu");
const menuAddText = document.getElementById("menuAddText");
let menuAddPhoto = document.getElementById("menuAddPhoto");
let menuAddVideo = document.getElementById("menuAddVideo");
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
let videoPicker = document.getElementById("videoPicker");

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
let deletePuchokHeaderBtn = document.getElementById("deletePuchokHeaderBtn") || null;

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

function ensureDeletePuchokHeaderBtn(){
  if(deletePuchokHeaderBtn) return deletePuchokHeaderBtn;
  const base = addMenuBtn || editPuchokBtn || refreshBtn;
  if(!base) return null;
  deletePuchokHeaderBtn = document.createElement("button");
  deletePuchokHeaderBtn.id = "deletePuchokHeaderBtn";
  deletePuchokHeaderBtn.className = base.className || "btnGhost";
  deletePuchokHeaderBtn.type = "button";
  deletePuchokHeaderBtn.textContent = "Удалить пучок";
  deletePuchokHeaderBtn.title = "Удалить пучок";
  return deletePuchokHeaderBtn;
}


function hidePuchokHeaderActionButtons(){
  if(deletePuchokHeaderBtn) deletePuchokHeaderBtn.style.display = "none";
}

function sanitizeDownloadName(name, fallback = "download"){
  const cleaned = (name || "").toString().trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ");
  return cleaned || fallback;
}

function triggerBlobDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{
    try{ URL.revokeObjectURL(url); }catch{}
    try{ a.remove(); }catch{}
  }, 1200);
}

async function fetchRowItemsForExport(rowId){
  const data = await apiJson(`/rows/${encodeURIComponent(rowId)}`, { method:"GET" });
  return (data.items || []).map(mapItemRow).filter(Boolean);
}

async function exportPhotoRowZip(rowId, rowTitle){
  if(typeof JSZip === "undefined"){
    alert("JSZip не найден.");
    return;
  }

  const items = await fetchRowItemsForExport(rowId);
  const photos = items.filter(it => it && it.type === "image");
  if(photos.length === 0){
    alert("В этом photo-row нет фото.");
    return;
  }

  const zip = new JSZip();
  for(let i = 0; i < photos.length; i++){
    const it = photos[i];
    const blob = await downloadItemBlobFromR2(it.id, it.mime || "image/*", "image");
    if(!blob) continue;

    const extFromMime = (() => {
      const mime = sanitizeMimeType(it.mime || blob.type || "", "");
      if(!mime || !mime.includes("/")) return "jpg";
      const part = mime.split("/")[1].toLowerCase();
      if(part === "jpeg") return "jpg";
      if(part === "svg+xml") return "svg";
      return part.replace(/[^a-z0-9]+/g, "") || "jpg";
    })();

    const baseName = sanitizeDownloadName(it.title || "photo", "photo");
    const uniqueName = (
      String(i + 1).padStart(3, "0") + "_" + `${baseName}.${extFromMime}`
    ).replace(/[\/:\*\?"<>\|]/g, "");

    zip.file(uniqueName, blob);
  }

  const zipBlob = await zip.generateAsync({ type:"blob" });
  triggerBlobDownload(zipBlob, `${sanitizeDownloadName(rowTitle || "row", "row")}.zip`);
}

async function exportVideoRowZip(rowId, rowTitle){
  if(typeof JSZip === "undefined"){
    alert("JSZip не найден.");
    return;
  }

  const items = await fetchRowItemsForExport(rowId);
  const videos = items.filter(it => it && it.type === "video");
  if(videos.length === 0){
    alert("В этом video-row нет видео.");
    return;
  }

  const zip = new JSZip();
  for(let i = 0; i < videos.length; i++){
    const it = videos[i];
    const blob = await downloadItemBlobFromR2(it.id, it.mime || "video/*", "video");
    if(!blob) continue;

    const extFromMime = (() => {
      const mime = sanitizeMimeType(it.mime || blob.type || "", "");
      if(!mime || !mime.includes("/")) return "webm";
      const part = mime.split("/")[1].toLowerCase();
      if(part === "quicktime") return "mov";
      if(part === "x-matroska") return "mkv";
      return part.replace(/[^a-z0-9]+/g, "") || "webm";
    })();

    const baseName = sanitizeDownloadName(it.title || "video", "video");
    const uniqueName = (
      String(i + 1).padStart(3, "0") + "_" + `${baseName}.${extFromMime}`
    ).replace(/[\/:\*\?"<>\|]/g, "");

    zip.file(uniqueName, blob);
  }

  const zipBlob = await zip.generateAsync({ type:"blob" });
  triggerBlobDownload(zipBlob, `${sanitizeDownloadName(rowTitle || "video_row", "video_row")}.zip`);
}


function buildPhotoRowHtml(rowTitle, items){
  const photos = (items || []).filter(it => it && it.type === "image");
  const imagesHtml = photos.map((it)=> {
    const src = `${WORKER_URL}${itemBlobPath(it.id)}`;
    const alt = escapeHTML(it.title || "photo");
    return `<figure><img src="${src}" alt="${alt}"></figure>`;
  }).join("\n");

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(rowTitle || "Photo Row")}</title>
<style>
body{margin:0;padding:24px;font-family:Arial,sans-serif;background:#f6f7f9;color:#111317;}
h1{margin:0 0 18px 0;font-size:24px;}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;}
figure{margin:0;background:#fff;border-radius:14px;padding:10px;box-shadow:0 6px 20px rgba(0,0,0,.08);}
img{display:block;width:100%;height:auto;border-radius:10px;}
</style>
</head>
<body>
<h1>${escapeHTML(rowTitle || "Photo Row")}</h1>
<div class="gallery">
${imagesHtml}
</div>
</body>
</html>`;
}

async function exportPhotoRowHtml(rowId, rowTitle){
  const items = await fetchRowItemsForExport(rowId);
  const photos = items.filter(it => it && it.type === "image");
  if(photos.length === 0){
    alert("В этом photo-row нет фото.");
    return;
  }

  function blobToDataURL(blob){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("FILE_READER_ERROR"));
      reader.readAsDataURL(blob);
    });
  }

  const safeRowTitle = sanitizeDownloadName(rowTitle || "row", "row");
  const parts = [];

  for(let i = 0; i < photos.length; i++){
    const it = photos[i];
    const blob = await downloadItemBlobFromR2(it.id, it.mime || "image/*", "image");
    if(!blob) continue;

    const dataURL = await blobToDataURL(blob);
    const caption = escapeHTML(it.title || `Фото ${i + 1}`);

    parts.push(`<div class="photo">
  <img src="${dataURL}" alt="${caption}">
  <div class="caption">${caption}</div>
</div>`);
  }

  if(parts.length === 0){
    alert("В этом photo-row нет фото.");
    return;
  }

  const htmlString = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHTML(rowTitle || "Photo Row")}</title>
<style>
body{
  font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:#111;
  color:#eee;
  margin:0 auto;
  max-width:900px;
  padding:24px 16px 40px;
}
h1{
  margin:0 0 24px 0;
  font-size:28px;
}
.photo{
  margin:0 0 24px 0;
}
img{
  display:block;
  width:100%;
  border-radius:10px;
  margin-bottom:16px;
}
.caption{
  font-size:14px;
  opacity:.9;
}
</style>
</head>
<body>
<h1>${escapeHTML(rowTitle || "Photo Row")}</h1>
${parts.join("\n")}
</body>
</html>`;

  const blob = new Blob([htmlString], { type:"text/html;charset=utf-8" });
  triggerBlobDownload(blob, `${safeRowTitle}.html`);
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

function bindMenuAddVideoButton(btn){
  if(!btn || btn.dataset.videoBound === "1") return;
  btn.dataset.videoBound = "1";
  btn.addEventListener("click", async (e)=>{
    e.preventDefault();
    e.stopPropagation();
    closeAddMenu();
    if(viewMode === "list"){
      alert("Сначала открой пучок.");
      return;
    }
    if(viewMode !== "puchok") return;
    const p = ensureCurrentPuchok();
    if(!p) return;
    try{
      const rowId = await createNewRowForType(p, "video");
      activeVideoCaptureRowId = rowId;
      activeVideoCapturePuchokId = p.id;
      currentRowId = rowId;
      if(isMobile()){
        const picker = ensureVideoPicker();
        openVideoPicker(picker);
      }else{
        const opened = await openVideoCaptureModalForRow(rowId);
        if(!opened){
          const picker = ensureVideoPicker();
          openVideoPicker(picker);
        }
      }
    }catch(err){
      addMsg("Ошибка подготовки видео: " + (err?.message || err), "err");
    }
  });
}

function ensureAddMenuExtras(){
  if(!addMenu) return;

  let videoBtn = document.getElementById("menuAddVideo");
  if(!videoBtn){
    videoBtn = document.createElement("button");
    videoBtn.id = "menuAddVideo";
    videoBtn.type = "button";
    videoBtn.textContent = "Видео";
    if(menuAddFile && menuAddFile.parentElement === addMenu) addMenu.insertBefore(videoBtn, menuAddFile);
    else addMenu.appendChild(videoBtn);
  }
  menuAddVideo = videoBtn;
  videoBtn.hidden = false;
  videoBtn.disabled = false;
  videoBtn.style.display = "";
  videoBtn.style.visibility = "visible";
  videoBtn.style.opacity = "1";
  bindMenuAddVideoButton(videoBtn);

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

  bindMenuAddSubpuchokButton(menuAddSubpuchok);
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


function configureVideoPickerForCurrentDevice(picker){
  if(!picker) return picker;
  const useCamera = shouldUseCameraCapture();
  picker.accept = "video/*";
  picker.multiple = true;
  if(useCamera) picker.setAttribute("capture", "environment");
  else picker.removeAttribute("capture");
  applyHiddenPickerStyles(picker);
  return picker;
}

function ensureVideoPicker(){
  if(videoPicker){
    configureVideoPickerForCurrentDevice(videoPicker);
    return videoPicker;
  }
  videoPicker = document.createElement("input");
  videoPicker.type = "file";
  videoPicker.id = "videoPicker";
  configureVideoPickerForCurrentDevice(videoPicker);
  document.body.appendChild(videoPicker);
  return videoPicker;
}

function openVideoPicker(picker){
  const target = configureVideoPickerForCurrentDevice(picker || ensureVideoPicker());
  target.value = "";
  if(typeof target.showPicker === "function"){
    try{
      target.showPicker();
      return;
    }catch{}
  }
  target.click();
}


function forceShowPuchokAddButton(){
  if(!addMenuBtn) return;
  addMenuBtn.hidden = false;
  addMenuBtn.removeAttribute("hidden");
  addMenuBtn.disabled = false;
  addMenuBtn.style.display = "inline-flex";
  addMenuBtn.style.visibility = "visible";
  addMenuBtn.style.opacity = "1";
  addMenuBtn.style.pointerEvents = "auto";
  addMenuBtn.style.position = "";
  addMenuBtn.style.zIndex = "";

  const parent =
    headerActionsHost ||
    (editPuchokBtn && editPuchokBtn.parentElement) ||
    (refreshBtn && refreshBtn.parentElement) ||
    addMenuBtn.parentElement ||
    null;

  if(parent && addMenuBtn.parentElement !== parent){
    parent.appendChild(addMenuBtn);
  }
  if(parent){
    if(editPuchokBtn && editPuchokBtn.parentElement === parent){
      if(editPuchokBtn.nextSibling !== addMenuBtn){
        parent.insertBefore(addMenuBtn, editPuchokBtn.nextSibling);
      }
    }else{
      parent.appendChild(addMenuBtn);
    }
  }
}

function forceHideRowAddButton(){
  if(!addMenuBtn) return;
  addMenuBtn.hidden = true;
  addMenuBtn.style.display = "none";
  addMenuBtn.style.visibility = "hidden";
  addMenuBtn.style.opacity = "0";
  addMenuBtn.style.pointerEvents = "none";
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
let activeVideoCaptureRowId = null;
let activeVideoCapturePuchokId = null;
let activeFileCaptureRowId = null;
let activeFileCapturePuchokId = null;
let activeCarouselRowId = null;
let activeCarouselItemId = null;
const expandedRowIds = new Set();
let imageViewerWrap = null;
let imageViewerRowId = null;
let imageViewerItemIds = [];
let imageViewerIndex = -1;
let imageViewerObjectUrl = "";
let imageViewerLoadToken = 0;
let videoViewerWrap = null;
let videoViewerRowId = null;
let videoViewerItemIds = [];
let videoViewerIndex = -1;
let videoViewerObjectUrl = "";
let videoCaptureModal = null;
let videoCaptureStream = null;
let videoCaptureRecorder = null;
let videoCaptureChunks = [];
let videoCaptureTargetRowId = null;
let videoCaptureTargetPuchokId = null;
let cameraCaptureModal = null;
let cameraCaptureStream = null;
let cameraCaptureTargetRowId = null;
let cameraCaptureTargetPuchokId = null;
let isBusy = false;

const itemPreviewUrlCache = new Map();
const itemPreviewLoadPromises = new Map();
const audioTileRecorderStates = new Map();
let activeAudioPlayback = null;

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
function isDesktopLikeDevice(){
  return !shouldUseCameraCapture();
}
function isMobile(){
  return shouldUseCameraCapture();
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
  if(it.type==="video") return { text:"Видео", cls:"tagText tagFile" };
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
function getSortedImageItems(rowId){
  return getSortedRowItems(rowId).filter(x => x && x.type === "image");
}
function getSortedVideoItems(rowId){
  return getSortedRowItems(rowId).filter(x => x && x.type === "video");
}
function isRowExpanded(rowId){
  return !!rowId && expandedRowIds.has(rowId);
}
function expandRowInline(rowId){
  if(!rowId) return;
  expandedRowIds.add(rowId);
  currentRowId = rowId;
}
function collapseRowInline(rowId){
  if(!rowId) return;
  expandedRowIds.delete(rowId);
  if(currentRowId === rowId){
    const last = Array.from(expandedRowIds);
    currentRowId = last.length ? last[last.length - 1] : null;
  }
}
function toggleRowInlineState(rowId){
  if(!rowId) return false;
  if(expandedRowIds.has(rowId)){
    collapseRowInline(rowId);
    return false;
  }
  expandRowInline(rowId);
  return true;
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

function revokeImageViewerUrl(){
  if(imageViewerObjectUrl){
    try{ URL.revokeObjectURL(imageViewerObjectUrl); }catch{}
    imageViewerObjectUrl = "";
  }
}
function ensureImageViewer(){
  if(imageViewerWrap && imageViewerWrap.parentElement === document.body) return imageViewerWrap;

  imageViewerWrap = document.createElement("div");
  imageViewerWrap.id = "imageViewerWrap";
  imageViewerWrap.style.position = "fixed";
  imageViewerWrap.style.inset = "0";
  imageViewerWrap.style.zIndex = "130000";
  imageViewerWrap.style.display = "none";
  imageViewerWrap.style.alignItems = "center";
  imageViewerWrap.style.justifyContent = "center";
  imageViewerWrap.style.background = "rgba(10,12,16,.92)";
  imageViewerWrap.innerHTML = `
    <button type="button" id="imageViewerClose"
      style="position:absolute;top:14px;right:14px;z-index:3;appearance:none;border:0;
             width:44px;height:44px;border-radius:999px;background:rgba(255,255,255,.14);
             color:#fff;font-size:28px;line-height:1;cursor:pointer;">×</button>
    <button type="button" id="imageViewerPrev"
      style="position:absolute;left:12px;top:50%;transform:translateY(-50%);z-index:3;appearance:none;border:0;
             min-width:52px;height:52px;border-radius:999px;background:rgba(17,19,23,.82);
             color:#fff;font-size:28px;line-height:1;cursor:pointer;display:none;">←</button>
    <div id="imageViewerCounter"
      style="position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:3;display:none;
             min-width:64px;padding:8px 12px;border-radius:999px;background:rgba(17,19,23,.72);
             color:#fff;font-size:12px;text-align:center;"></div>
    <button type="button" id="imageViewerNext"
      style="position:absolute;right:12px;top:50%;transform:translateY(-50%);z-index:3;appearance:none;border:0;
             min-width:52px;height:52px;border-radius:999px;background:rgba(17,19,23,.82);
             color:#fff;font-size:28px;line-height:1;cursor:pointer;display:none;">→</button>
    <div id="imageViewerStage"
      style="position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:56px 16px 24px;">
      <img id="imageViewerImg" alt="Фото"
        style="display:none;max-width:100%;max-height:100%;object-fit:contain;border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.35);" />
      <div id="imageViewerStatus"
        style="max-width:min(86vw,560px);padding:18px 22px;border-radius:18px;background:rgba(255,255,255,.08);
               color:#fff;font-size:15px;line-height:1.45;text-align:center;backdrop-filter:blur(10px);">
        Загружаю фото…
      </div>
    </div>
  `;
  document.body.appendChild(imageViewerWrap);

  const closeBtn = imageViewerWrap.querySelector("#imageViewerClose");
  const prevBtn = imageViewerWrap.querySelector("#imageViewerPrev");
  const nextBtn = imageViewerWrap.querySelector("#imageViewerNext");

  if(closeBtn) closeBtn.addEventListener("click", (e)=>{
    e.preventDefault();
    e.stopPropagation();
    closeImageViewer();
  });
  if(prevBtn) prevBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    e.stopPropagation();
    await openSiblingImageInViewer(-1);
  });
  if(nextBtn) nextBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    e.stopPropagation();
    await openSiblingImageInViewer(1);
  });

  imageViewerWrap.addEventListener("click", (e)=>{
    if(e.target === imageViewerWrap || e.target.id === "imageViewerStage"){
      closeImageViewer();
    }
  });

  return imageViewerWrap;
}
function closeImageViewer(){
  imageViewerLoadToken++;
  revokeImageViewerUrl();
  if(imageViewerWrap){
    imageViewerWrap.style.display = "none";
    const img = imageViewerWrap.querySelector("#imageViewerImg");
    const status = imageViewerWrap.querySelector("#imageViewerStatus");
    if(img){
      img.style.display = "none";
      img.removeAttribute("src");
    }
    if(status){
      status.textContent = "Загружаю фото…";
      status.style.display = "block";
      status.style.background = "rgba(255,255,255,.08)";
    }
  }
  imageViewerRowId = null;
  imageViewerItemIds = [];
  imageViewerIndex = -1;
}
function updateImageViewerNav(){
  if(!imageViewerWrap) return;
  const prevBtn = imageViewerWrap.querySelector("#imageViewerPrev");
  const nextBtn = imageViewerWrap.querySelector("#imageViewerNext");
  const counter = imageViewerWrap.querySelector("#imageViewerCounter");
  const hasPrev = imageViewerIndex > 0;
  const hasNext = imageViewerIndex >= 0 && imageViewerIndex < imageViewerItemIds.length - 1;
  if(prevBtn) prevBtn.style.display = hasPrev ? "block" : "none";
  if(nextBtn) nextBtn.style.display = hasNext ? "block" : "none";
  if(counter){
    if(imageViewerIndex >= 0 && imageViewerItemIds.length > 0){
      counter.textContent = `${imageViewerIndex + 1} / ${imageViewerItemIds.length}`;
      counter.style.display = "block";
    }else{
      counter.style.display = "none";
      counter.textContent = "";
    }
  }
}
function setImageViewerStatus(message, isError = false){
  const wrap = ensureImageViewer();
  const img = wrap.querySelector("#imageViewerImg");
  const status = wrap.querySelector("#imageViewerStatus");
  if(status){
    status.textContent = message || "";
    status.style.display = message ? "block" : "none";
    status.style.background = isError ? "rgba(163,32,53,.28)" : "rgba(255,255,255,.08)";
  }
  if(img && message){
    img.style.display = "none";
    img.removeAttribute("src");
  }
}
async function openImageViewer(rowId, itemId){
  const items = getSortedImageItems(rowId);
  const idx = items.findIndex(x => x.id === itemId);
  if(idx < 0) return;

  const wrap = ensureImageViewer();
  const img = wrap.querySelector("#imageViewerImg");
  imageViewerRowId = rowId;
  imageViewerItemIds = items.map(x => x.id);
  imageViewerIndex = idx;
  updateImageViewerNav();
  wrap.style.display = "flex";
  setActiveCarouselItem(rowId, itemId);

  const it = items[idx];
  if(!img || !it) return;

  const loadToken = ++imageViewerLoadToken;
  revokeImageViewerUrl();
  img.style.display = "none";
  img.removeAttribute("src");
  setImageViewerStatus("Загружаю фото…", false);

  try{
    const blob = await downloadItemBlobFromR2(it.id, it.mime || "image/*", "image", { showProgress:false });
    if(loadToken !== imageViewerLoadToken) return;
    if(!blob) throw new Error("Blob фото не найден");

    const finalMime = chooseBlobMimeType(blob?.type || "", it.mime || "image/*", "image");
    const typedBlob = (blob && sanitizeMimeType(blob.type || "", "") === finalMime)
      ? blob
      : new Blob([blob], { type: finalMime });

    revokeImageViewerUrl();
    imageViewerObjectUrl = URL.createObjectURL(typedBlob);

    img.src = imageViewerObjectUrl;
    img.style.display = "block";
    setImageViewerStatus("", false);
  }catch(e){
    if(loadToken !== imageViewerLoadToken) return;
    revokeImageViewerUrl();
    img.style.display = "none";
    img.removeAttribute("src");
    setImageViewerStatus("Ошибка загрузки фото: " + (e?.message || e), true);
  }
}
async function openSiblingImageInViewer(step){
  const nextIndex = imageViewerIndex + step;
  if(nextIndex < 0 || nextIndex >= imageViewerItemIds.length) return;
  const nextId = imageViewerItemIds[nextIndex];
  if(nextId) await openImageViewer(imageViewerRowId, nextId);
}


function revokeVideoViewerUrl(){
  if(videoViewerObjectUrl){
    try{ URL.revokeObjectURL(videoViewerObjectUrl); }catch{}
    videoViewerObjectUrl = "";
  }
}
function ensureVideoViewer(){
  if(videoViewerWrap && videoViewerWrap.parentElement === document.body) return videoViewerWrap;

  videoViewerWrap = document.createElement("div");
  videoViewerWrap.id = "videoViewerWrap";
  videoViewerWrap.style.position = "fixed";
  videoViewerWrap.style.inset = "0";
  videoViewerWrap.style.zIndex = "131000";
  videoViewerWrap.style.display = "none";
  videoViewerWrap.style.alignItems = "center";
  videoViewerWrap.style.justifyContent = "center";
  videoViewerWrap.style.background = "rgba(10,12,16,.92)";
  videoViewerWrap.innerHTML = `
    <button type="button" id="videoViewerClose"
      style="position:absolute;top:14px;right:14px;z-index:3;appearance:none;border:0;
             width:44px;height:44px;border-radius:999px;background:rgba(255,255,255,.14);
             color:#fff;font-size:28px;line-height:1;cursor:pointer;">×</button>
    <button type="button" id="videoViewerPrev"
      style="position:absolute;left:12px;top:50%;transform:translateY(-50%);z-index:3;appearance:none;border:0;
             min-width:52px;height:52px;border-radius:999px;background:rgba(17,19,23,.82);
             color:#fff;font-size:28px;line-height:1;cursor:pointer;display:none;">←</button>
    <div id="videoViewerCounter"
      style="position:absolute;left:50%;top:16px;transform:translateX(-50%);z-index:3;display:none;
             min-width:64px;padding:8px 12px;border-radius:999px;background:rgba(17,19,23,.72);
             color:#fff;font-size:12px;text-align:center;"></div>
    <button type="button" id="videoViewerNext"
      style="position:absolute;right:12px;top:50%;transform:translateY(-50%);z-index:3;appearance:none;border:0;
             min-width:52px;height:52px;border-radius:999px;background:rgba(17,19,23,.82);
             color:#fff;font-size:28px;line-height:1;cursor:pointer;display:none;">→</button>
    <div id="videoViewerStage"
      style="position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:56px 16px 24px;">
      <video id="videoViewerVideo" controls autoplay playsinline
        style="display:none;max-width:100%;max-height:100%;border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.35);background:#000;"></video>
      <div id="videoViewerStatus"
        style="max-width:min(86vw,560px);padding:18px 22px;border-radius:18px;background:rgba(255,255,255,.08);
               color:#fff;font-size:15px;line-height:1.45;text-align:center;backdrop-filter:blur(10px);">
        Загружаю видео…
      </div>
    </div>
  `;
  document.body.appendChild(videoViewerWrap);

  const closeBtn = videoViewerWrap.querySelector("#videoViewerClose");
  const prevBtn = videoViewerWrap.querySelector("#videoViewerPrev");
  const nextBtn = videoViewerWrap.querySelector("#videoViewerNext");

  if(closeBtn) closeBtn.addEventListener("click", (e)=>{
    e.preventDefault();
    e.stopPropagation();
    closeVideoViewer();
  });
  if(prevBtn) prevBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    e.stopPropagation();
    await openSiblingVideoInViewer(-1);
  });
  if(nextBtn) nextBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    e.stopPropagation();
    await openSiblingVideoInViewer(1);
  });
  videoViewerWrap.addEventListener("click", (e)=>{
    if(e.target === videoViewerWrap || e.target.id === "videoViewerStage"){
      closeVideoViewer();
    }
  });

  return videoViewerWrap;
}
function closeVideoViewer(){
  revokeVideoViewerUrl();
  if(videoViewerWrap){
    videoViewerWrap.style.display = "none";
    const video = videoViewerWrap.querySelector("#videoViewerVideo");
    const status = videoViewerWrap.querySelector("#videoViewerStatus");
    if(video){
      try{ video.pause(); }catch{}
      video.style.display = "none";
      video.removeAttribute("src");
      try{ video.load(); }catch{}
    }
    if(status){
      status.textContent = "Загружаю видео…";
      status.style.display = "block";
      status.style.background = "rgba(255,255,255,.08)";
    }
  }
  videoViewerRowId = null;
  videoViewerItemIds = [];
  videoViewerIndex = -1;
}
function updateVideoViewerNav(){
  if(!videoViewerWrap) return;
  const prevBtn = videoViewerWrap.querySelector("#videoViewerPrev");
  const nextBtn = videoViewerWrap.querySelector("#videoViewerNext");
  const counter = videoViewerWrap.querySelector("#videoViewerCounter");
  const hasPrev = videoViewerIndex > 0;
  const hasNext = videoViewerIndex >= 0 && videoViewerIndex < videoViewerItemIds.length - 1;
  if(prevBtn) prevBtn.style.display = hasPrev ? "block" : "none";
  if(nextBtn) nextBtn.style.display = hasNext ? "block" : "none";
  if(counter){
    if(videoViewerIndex >= 0 && videoViewerItemIds.length > 0){
      counter.textContent = `${videoViewerIndex + 1} / ${videoViewerItemIds.length}`;
      counter.style.display = "block";
    }else{
      counter.style.display = "none";
      counter.textContent = "";
    }
  }
}
function setVideoViewerStatus(message, isError = false){
  const wrap = ensureVideoViewer();
  const video = wrap.querySelector("#videoViewerVideo");
  const status = wrap.querySelector("#videoViewerStatus");
  if(status){
    status.textContent = message || "";
    status.style.display = message ? "block" : "none";
    status.style.background = isError ? "rgba(163,32,53,.28)" : "rgba(255,255,255,.08)";
  }
  if(video && message){
    try{ video.pause(); }catch{}
    video.style.display = "none";
    video.removeAttribute("src");
  }
}
async function openVideoViewer(rowId, itemId){
  const items = getSortedVideoItems(rowId);
  const idx = items.findIndex(x => x.id === itemId);
  if(idx < 0) return;

  const wrap = ensureVideoViewer();
  const video = wrap.querySelector("#videoViewerVideo");
  videoViewerRowId = rowId;
  videoViewerItemIds = items.map(x => x.id);
  videoViewerIndex = idx;
  updateVideoViewerNav();
  wrap.style.display = "flex";
  setActiveCarouselItem(rowId, itemId);

  const it = items[idx];
  if(!video || !it) return;

  revokeVideoViewerUrl();
  try{
    try{ video.pause(); }catch{}
    video.style.display = "none";
    video.removeAttribute("src");
    setVideoViewerStatus("Загружаю видео…", false);

    const blob = await downloadItemBlobFromR2(it.id, it.mime || "video/*", "video", { showProgress:false });
    if(!blob) throw new Error("Blob видео не найден");

    const finalMime = chooseBlobMimeType(blob?.type || "", it.mime || "video/*", "video");
    const typedBlob = (blob && sanitizeMimeType(blob.type || "", "") === finalMime)
      ? blob
      : new Blob([blob], { type: finalMime });

    revokeVideoViewerUrl();
    videoViewerObjectUrl = URL.createObjectURL(typedBlob);
    video.src = videoViewerObjectUrl;
    video.style.display = "block";
    setVideoViewerStatus("", false);
    try{ await video.play(); }catch{}
  }catch(e){
    revokeVideoViewerUrl();
    try{ video.pause(); }catch{}
    video.style.display = "none";
    video.removeAttribute("src");
    setVideoViewerStatus("Ошибка загрузки видео: " + (e?.message || e), true);
  }
}
async function openSiblingVideoInViewer(step){
  const nextIndex = videoViewerIndex + step;
  if(nextIndex < 0 || nextIndex >= videoViewerItemIds.length) return;
  const nextId = videoViewerItemIds[nextIndex];
  if(nextId) await openVideoViewer(videoViewerRowId, nextId);
}

/** ===========================
 *  RANGE FILL (cross-browser)
 *  =========================== */
function setRangeFill(el){
  if(!el) return;
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const val = Math.max(min, Math.min(max, Number(el.value ?? min)));
  const ratio = (val - min) / Math.max(max - min, 0.000001);
  const pct = ratio * 100;
  el.value = String(val);
  el.style.setProperty("--fill", pct + "%");
  el.style.background = `linear-gradient(to right, rgba(220,38,38,.92) 0%, rgba(220,38,38,.92) ${pct}%, rgba(17,19,23,.14) ${pct}%, rgba(17,19,23,.14) 100%)`;
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
async function deleteItemBlobFromR2(itemId){
  const resp = await apiFetch(itemBlobPath(itemId), { method:"DELETE" });
  if(resp.status === 404) return true;
  if(!resp.ok){
    const t = await resp.text().catch(()=> "");
    throw new Error(t || `HTTP ${resp.status}`);
  }
  return true;
}

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
  if(it.type === "file" && it.mime && it.mime.startsWith("video/")){
    it.type = "video";
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
  hidePuchokHeaderActionButtons();

  newPuchokBtn.style.display = "";
  chatHint.textContent = "Совет: открой пучок → тогда “В пучок” сохранит ответ туда.";
}

function setHeaderForPuchok(p){
  backBtn.style.display = "";
  headTitle.textContent = "ПУЧКИ";
  headCrumb.textContent = p.title || "Без названия";

  newPuchokBtn.style.display = "none";
  editPuchokBtn.style.display = "";
  closeAddMenu();

  ensureRefreshBtn();
  ensureDeletePuchokHeaderBtn();

  if(refreshBtn){
    refreshBtn.style.display = "";
    refreshBtn.title = "Обновить";
    refreshBtn.setAttribute("aria-label","Обновить");
  }
  if(deletePuchokHeaderBtn) deletePuchokHeaderBtn.style.display = "inline-flex";

  forceShowPuchokAddButton();

  try{
    const parent = headerActionsHost || (addMenuBtn && addMenuBtn.parentElement) || (editPuchokBtn && editPuchokBtn.parentElement) || (refreshBtn && refreshBtn.parentElement) || null;
    if(parent){
      if(refreshBtn && refreshBtn.parentElement !== parent) parent.appendChild(refreshBtn);
      if(editPuchokBtn && editPuchokBtn.parentElement !== parent) parent.appendChild(editPuchokBtn);
      if(deletePuchokHeaderBtn && deletePuchokHeaderBtn.parentElement !== parent) parent.appendChild(deletePuchokHeaderBtn);
      if(addMenuBtn && addMenuBtn.parentElement !== parent) parent.appendChild(addMenuBtn);

      if(refreshBtn && editPuchokBtn) parent.insertBefore(refreshBtn, editPuchokBtn);
      if(editPuchokBtn && deletePuchokHeaderBtn) parent.insertBefore(editPuchokBtn, deletePuchokHeaderBtn);
      if(deletePuchokHeaderBtn && addMenuBtn) parent.insertBefore(deletePuchokHeaderBtn, addMenuBtn);
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
  closeAddMenu();

  forceHideRowAddButton();
  hidePuchokHeaderActionButtons();

  ensureRefreshBtn();
  if(refreshBtn){
    refreshBtn.style.display = "";
    refreshBtn.title = "Обновить ряд";
    refreshBtn.setAttribute("aria-label","Обновить ряд");
  }

  try{
    const parent = headerActionsHost || (refreshBtn && refreshBtn.parentElement) || (addMenuBtn && addMenuBtn.parentElement) || null;
    if(parent && refreshBtn && refreshBtn.parentElement !== parent){
      parent.appendChild(refreshBtn);
    }
    if(parent && addMenuBtn && addMenuBtn.parentElement !== parent){
      parent.appendChild(addMenuBtn);
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

  const p = getPuchokLocal(currentPuchokId);
  if(!p){
    viewMode = "list";
    currentPuchokId = null;
    currentRowId = null;
    expandedRowIds.clear();
    render();
    return;
  }

  viewMode = "puchok";
  setHeaderForPuchok(p);
  forceShowPuchokAddButton();
  renderPuchokInside(p);
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


function renderStandardRowEntry(p, e){
  const block = document.createElement("div");
  block.className = "rowInlineBlock";
  block.dataset.rowInlineId = e.refId;
  block.style.display = "flex";
  block.style.flexDirection = "column";
  block.style.gap = "12px";

  const header = document.createElement("div");
  header.className = "itemRow";
  header.style.cursor = "pointer";

  const left = document.createElement("div");
  left.className = "itemLeft";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const rt = rowTypeLabel(e.rowType || "row");
  thumb.innerHTML = icoSVG(rt.ico);

  const textWrap = document.createElement("div");
  textWrap.className = "itemText";

  const title = document.createElement("div");
  title.className = "itemTitle";
  title.textContent = e.rowTitle || rt.text;

  const cached = db.rows[e.refId];
  const expanded = isRowExpanded(e.refId);
  const cnt = cached ? (cached.items || []).length : null;

  const desc = document.createElement("div");
  desc.className = "itemDesc";
  if(cnt != null){
    desc.textContent = `Элементов: ${cnt}${expanded ? " • раскрыт" : ""}`;
  }else{
    desc.textContent = expanded ? "Загружаю ряд…" : "Нажми, чтобы раскрыть";
  }

  const right = document.createElement("div");
  right.className = rt.cls;
  right.textContent = expanded ? "Свернуть" : rt.text.replace("-ряд","");

  textWrap.appendChild(title);
  textWrap.appendChild(desc);
  left.appendChild(thumb);
  left.appendChild(textWrap);
  header.appendChild(left);
  header.appendChild(right);

  header.addEventListener("click", ()=> openRow(e.refId));

  block.appendChild(header);

  if(expanded){
    if(cached){
      block.appendChild(buildInlineRowContent(p, cached));
    }else{
      const loading = document.createElement("div");
      loading.className = "empty";
      loading.textContent = "Загружаю ряд…";
      block.appendChild(loading);
    }
  }

  return block;
}

function renderPhotoRow(p, e){
  const block = renderStandardRowEntry(p, e);
  const header = block.firstElementChild;
  if(!header) return block;

  const right = header.lastElementChild;
  if(right){
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "8px";

    const rowExportBtns = document.createElement("div");
    rowExportBtns.className = "rowExportBtns";
    rowExportBtns.style.display = "flex";
    rowExportBtns.style.alignItems = "center";
    rowExportBtns.style.gap = "6px";

    const rowZipBtn = document.createElement("button");
    rowZipBtn.className = "rowZipBtn btnGhost";
    rowZipBtn.type = "button";
    rowZipBtn.textContent = "📦 ZIP";
    rowZipBtn.title = "Скачать ZIP";

    const rowHtmlBtn = document.createElement("button");
    rowHtmlBtn.className = "rowHtmlBtn btnGhost";
    rowHtmlBtn.type = "button";
    rowHtmlBtn.textContent = "🌐 HTML";
    rowHtmlBtn.title = "Скачать HTML";

    rowZipBtn.addEventListener("click", async (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      try{
        await exportPhotoRowZip(e.refId, e.rowTitle || "photo-row");
      }catch(err){
        addMsg("Ошибка экспорта ZIP: " + (err?.message || err), "err");
      }
    });

    rowHtmlBtn.addEventListener("click", async (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      try{
        await exportPhotoRowHtml(e.refId, e.rowTitle || "photo-row");
      }catch(err){
        addMsg("Ошибка экспорта HTML: " + (err?.message || err), "err");
      }
    });

    rowExportBtns.appendChild(rowZipBtn);
    rowExportBtns.appendChild(rowHtmlBtn);
    right.appendChild(rowExportBtns);
  }

  return block;
}

function renderVideoRow(p, e){
  const block = renderStandardRowEntry(p, e);
  const header = block.firstElementChild;
  if(!header) return block;

  const right = header.lastElementChild;
  if(right){
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "8px";

    const rowExportBtns = document.createElement("div");
    rowExportBtns.className = "rowExportBtns";
    rowExportBtns.style.display = "flex";
    rowExportBtns.style.alignItems = "center";
    rowExportBtns.style.gap = "6px";

    const rowZipBtn = document.createElement("button");
    rowZipBtn.className = "rowZipBtn btnGhost";
    rowZipBtn.type = "button";
    rowZipBtn.textContent = "📦 ZIP";
    rowZipBtn.title = "Скачать ZIP";

    rowZipBtn.addEventListener("click", async (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      try{
        await exportVideoRowZip(e.refId, e.rowTitle || "video-row");
      }catch(err){
        addMsg("Ошибка экспорта ZIP: " + (err?.message || err), "err");
      }
    });

    rowExportBtns.appendChild(rowZipBtn);
    right.appendChild(rowExportBtns);
  }

  return block;
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
      if((e.kind || "").toLowerCase() === "subpuchok"){
        const row = document.createElement("div");
        row.className = "itemRow";

        const left = document.createElement("div");
        left.className = "itemLeft";

        const thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.innerHTML = icoSVG("file");

        const textWrap = document.createElement("div");
        textWrap.className = "itemText";

        const title = document.createElement("div");
        title.className = "itemTitle";
        title.textContent = e.subTitle || "Подпучок";

        const desc = document.createElement("div");
        desc.className = "itemDesc";
        desc.textContent = "Открыть подпучок";

        const right = document.createElement("div");
        right.style.display = "flex";
        right.style.alignItems = "center";
        right.style.gap = "8px";

        const tag = document.createElement("div");
        tag.className = "tagText";
        tag.textContent = "Папка";

        const delBtn = document.createElement("button");
        delBtn.className = "btnGhost";
        delBtn.type = "button";
        delBtn.textContent = "🗑";
        delBtn.title = "Удалить подпучок";

        delBtn.addEventListener("click", async (ev)=>{
          ev.preventDefault();
          ev.stopPropagation();
          await deleteSubpuchok(e.refId);
        });

        right.appendChild(tag);
        right.appendChild(delBtn);

        textWrap.appendChild(title);
        textWrap.appendChild(desc);
        left.appendChild(thumb);
        left.appendChild(textWrap);
        row.appendChild(left);
        row.appendChild(right);
        row.addEventListener("click", ()=> openPuchok(e.refId));
        wrap.appendChild(row);
        continue;
      }

      const rowType = (e.rowType || "").toLowerCase();
      const block = rowType === "photo" ? renderPhotoRow(p, e) : rowType === "video" ? renderVideoRow(p, e) : renderStandardRowEntry(p, e);
      wrap.appendChild(block);
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
    <div style="height:168px;border-radius:14px;overflow:hidden;background:rgba(17,19,23,.06);display:flex;align-items:center;justify-content:center;">
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

function getAudioItemLocalByRow(rowId, itemId){
  const pack = db.rows[rowId];
  if(!pack) return null;
  return (pack.items || []).find(x => x.id === itemId) || null;
}
function getAudioSegments(it){
  const fromItem = Array.isArray(it?.segments) ? it.segments : [];
  if(fromItem.length) return fromItem;
  const fromMeta = Array.isArray(it?.meta?.segments) ? it.meta.segments : [];
  return fromMeta;
}
function getAudioTotalDurationSec(it){
  const fromMeta = Number(it?.durationSec || 0);
  if(fromMeta > 0) return fromMeta;
  return getAudioSegments(it).reduce((sum, seg)=> sum + Number(seg?.durationSec || 0), 0);
}
function formatAudioDuration(sec){
  sec = Math.max(0, Number(sec || 0));
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function getActiveAudioPlaybackPositionSec(rowId, itemId){
  if(!activeAudioPlayback || activeAudioPlayback.itemId !== itemId || activeAudioPlayback.rowId !== rowId){
    return 0;
  }
  const totalSec = Math.max(0, Number(activeAudioPlayback.totalSec || 0));
  if(activeAudioPlayback.isPaused || !activeAudioPlayback.ctx || activeAudioPlayback.startedAt == null){
    return clamp(Number(activeAudioPlayback.offsetSec || 0), 0, totalSec);
  }
  const elapsed = Math.max(0, activeAudioPlayback.ctx.currentTime - activeAudioPlayback.startedAt);
  return clamp(Number(activeAudioPlayback.offsetSec || 0) + elapsed, 0, totalSec);
}
function stopAudioPlaybackUiTimer(){
  if(activeAudioPlayback?.timerId){
    clearInterval(activeAudioPlayback.timerId);
    activeAudioPlayback.timerId = null;
  }
}
function startAudioPlaybackUiTimer(rowId, itemId){
  if(!activeAudioPlayback || activeAudioPlayback.itemId !== itemId || activeAudioPlayback.rowId !== rowId) return;
  stopAudioPlaybackUiTimer();
  activeAudioPlayback.timerId = setInterval(()=>{
    updateAudioTileDom(rowId, itemId);
  }, 120);
}
function updateAudioTileDom(rowId, itemId){
  const card = document.querySelector(`[data-row-tile-row-id="${rowId}"][data-row-tile-item-id="${itemId}"]`);
  const it = getAudioItemLocalByRow(rowId, itemId);
  if(!card || !it) return;

  const state = audioTileRecorderStates.get(itemId);
  const segments = getAudioSegments(it);
  const hasSegments = segments.length > 0;
  const recordingExtraSec = state && state.status === "recording" ? (Date.now() - state.segmentStartedAt) / 1000 : 0;
  const totalSec = Math.max(0, getAudioTotalDurationSec(it) + recordingExtraSec);

  const isRecording = !!state && state.status === "recording";
  const isPlaybackCurrent = !!activeAudioPlayback && activeAudioPlayback.itemId === itemId && activeAudioPlayback.rowId === rowId;
  const isPlaybackPaused = isPlaybackCurrent && !!activeAudioPlayback.isPaused;
  const isPlaybackPlaying = isPlaybackCurrent && !activeAudioPlayback.isPaused && !!activeAudioPlayback.source;

  const segsEl = card.querySelector("[data-audio-seg-count]");
  const recordBtn = card.querySelector("[data-audio-record]");
  const stopRecordBtn = card.querySelector("[data-audio-stop-record]");
  const playToggleBtn = card.querySelector("[data-audio-play-toggle]");
  const saveBtn = card.querySelector("[data-audio-save]");
  const deleteBtn = card.querySelector("[data-audio-delete]");
  const renameBtn = card.querySelector("[data-audio-rename]");
  const slider = card.querySelector("[data-audio-slider]");
  const currentEl = card.querySelector("[data-audio-current-time]");
  const totalEl = card.querySelector("[data-audio-total-time]");
  const recordingTotalEl = card.querySelector("[data-audio-recording-total]");

  let currentSec = 0;
  if(isPlaybackCurrent){
    currentSec = getActiveAudioPlaybackPositionSec(rowId, itemId);
  }else if(card.dataset.audioSeek && !isRecording){
    currentSec = clamp(Number(card.dataset.audioSeek || 0), 0, Math.max(totalSec, 0));
  }

  if(segsEl) segsEl.textContent = `Сегментов: ${segments.length}`;

  if(recordBtn){
    recordBtn.textContent = hasSegments ? "⏺+" : "⏺";
    recordBtn.title = hasSegments ? "Дозапись" : "Record";
    recordBtn.disabled = isRecording || isPlaybackPlaying;
  }
  if(stopRecordBtn){
    stopRecordBtn.textContent = "■";
    stopRecordBtn.title = "Stop recording";
    stopRecordBtn.disabled = !isRecording;
  }
  if(playToggleBtn){
    playToggleBtn.textContent = isPlaybackPlaying ? "❚❚" : "▶";
    playToggleBtn.title = isPlaybackPlaying ? "Pause playback" : "Play";
    playToggleBtn.disabled = isRecording || !hasSegments;
  }
  if(saveBtn){
    saveBtn.textContent = "⬇";
    saveBtn.title = "Скачать";
    saveBtn.disabled = isRecording || isPlaybackPlaying || isPlaybackPaused || !hasSegments;
  }
  if(deleteBtn){
    deleteBtn.textContent = "🗑";
    deleteBtn.title = "Удалить";
    deleteBtn.disabled = isRecording || isPlaybackPlaying || isPlaybackPaused;
  }
  if(renameBtn){
    renameBtn.textContent = "✎";
    renameBtn.title = "Переименовать";
    renameBtn.disabled = isRecording || isPlaybackPlaying;
  }

  if(recordingTotalEl){
    recordingTotalEl.textContent = formatAudioDuration(totalSec);
    recordingTotalEl.style.color = isRecording ? "red" : "";
  }

  if(slider){
    slider.min = "0";
    slider.max = String(Math.max(totalSec, 0.000001));
    slider.step = "0.01";
    slider.value = String(clamp(currentSec, 0, Math.max(totalSec, 0)));
    setRangeFill(slider);
  }

  if(currentEl) currentEl.textContent = formatAudioDuration(currentSec);
  if(totalEl) totalEl.textContent = formatAudioDuration(totalSec);
}
function startAudioTileTimer(rowId, itemId){
  const state = audioTileRecorderStates.get(itemId);
  if(!state) return;
  if(state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(()=> updateAudioTileDom(rowId, itemId), 250);
}
function stopAudioTileTimer(itemId){
  const state = audioTileRecorderStates.get(itemId);
  if(state?.timerId){
    clearInterval(state.timerId);
    state.timerId = null;
  }
}
function blobToDataURLLocal(blob){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(String(reader.result || ""));
    reader.onerror = ()=> reject(reader.error || new Error("FILE_READER_ERROR"));
    reader.readAsDataURL(blob);
  });
}
function dataURLToBlobLocal(dataURL){
  const parts = String(dataURL || "").split(",");
  const header = parts[0] || "";
  const mimeMatch = header.match(/data:([^;]+);base64/i);
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const base64 = parts[1] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
async function getAudioSegmentBlob(seg){
  if(seg?.dataUrl) return dataURLToBlobLocal(seg.dataUrl);
  if(seg?.r2?.dataUrl) return dataURLToBlobLocal(seg.r2.dataUrl);
  return null;
}
async function decodeAudioBlobWithContext(blob, ctx){
  const arr = await blob.arrayBuffer();
  return await ctx.decodeAudioData(arr.slice(0));
}
async function buildMergedAudioBufferFromItem(it){
  const segments = getAudioSegments(it);
  if(!segments.length) return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if(!AudioCtx) throw new Error("Web Audio не поддерживается");
  const decodeCtx = new AudioCtx();
  try{
    const decoded = [];
    for(const seg of segments){
      const blob = await getAudioSegmentBlob(seg);
      if(!blob) continue;
      decoded.push(await decodeAudioBlobWithContext(blob, decodeCtx));
    }
    if(!decoded.length) return null;

    const sampleRate = decoded[0].sampleRate || 44100;
    const channels = Math.max(...decoded.map(buf => buf.numberOfChannels || 1));
    let totalLength = 0;
    for(const buf of decoded) totalLength += buf.length;

    const output = decodeCtx.createBuffer(channels, totalLength, sampleRate);
    for(let ch = 0; ch < channels; ch++){
      const channelData = output.getChannelData(ch);
      let offset = 0;
      for(const buf of decoded){
        const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
        channelData.set(src, offset);
        offset += src.length;
      }
    }
    return { ctx: decodeCtx, buffer: output };
  }catch(err){
    try{ await decodeCtx.close(); }catch{}
    throw err;
  }
}
function audioBufferToWavBlob(buffer){
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const bufferLength = 44 + numFrames * blockAlign;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  function writeString(offset, str){
    for(let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + numFrames * blockAlign, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, numFrames * blockAlign, true);

  let offset = 44;
  for(let i = 0; i < numFrames; i++){
    for(let ch = 0; ch < numChannels; ch++){
      let sample = buffer.getChannelData(ch)[i] || 0;
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type:"audio/wav" });
}
async function persistAudioItem(rowId, itemId){
  const it = getAudioItemLocalByRow(rowId, itemId);
  if(!it) return;
  const segments = getAudioSegments(it);
  it.segments = segments;
  it.meta = it.meta && typeof it.meta === "object" ? it.meta : {};
  it.meta.segments = segments;
  it.durationSec = segments.reduce((sum, seg)=> sum + Number(seg?.durationSec || 0), 0);
  it.meta.durationSec = it.durationSec;
  it.updatedAt = nowISO();
  await apiJson(`/items/${encodeURIComponent(itemId)}`, {
    method:"PATCH",
    json: itemToPatchPayload(it),
  });
}
async function finalizeAudioTileSegment(rowId, itemId, blob, durationSec){
  if(!blob || !blob.size) return;
  const current = getAudioItemLocalByRow(rowId, itemId);
  if(!current) return;

  const dataUrl = await blobToDataURLLocal(blob);
  current.segments = getAudioSegments(current);
  current.segments.push({
    id: uid(),
    mime: blob.type || "audio/webm",
    size: blob.size || 0,
    durationSec: Math.max(0, Number(durationSec || 0)),
    dataUrl,
    r2: { embedded: true }
  });
  await persistAudioItem(rowId, itemId);
}
async function startAudioTileRecording(rowId, itemId){
  const it = getAudioItemLocalByRow(rowId, itemId);
  if(!it || audioTileRecorderStates.has(itemId)) return;
  if(!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function" || !hasMediaRecorder()){
    alert("Запись аудио не поддерживается на этом устройстве.");
    return;
  }
  if(activeAudioPlayback && activeAudioPlayback.itemId === itemId && activeAudioPlayback.rowId === rowId){
    await stopActiveAudioPlayback();
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
  const recorder = new MediaRecorder(stream);
  const state = {
    rowId,
    itemId,
    stream,
    recorder,
    chunks: [],
    segmentStartedAt: Date.now(),
    status: "recording",
    timerId: null,
  };
  audioTileRecorderStates.set(itemId, state);
  recorder.ondataavailable = (e)=>{
    if(e.data && e.data.size > 0) state.chunks.push(e.data);
  };
  recorder.onstop = async ()=>{
    try{
      const blob = new Blob(state.chunks, { type: recorder.mimeType || "audio/webm" });
      const durationSec = Math.max(0, (Date.now() - state.segmentStartedAt) / 1000);
      await finalizeAudioTileSegment(rowId, itemId, blob, durationSec);
    }catch(err){
      addMsg("Ошибка записи аудио: " + (err?.message || err), "err");
    }finally{
      stopAudioTileTimer(itemId);
      try{ state.stream.getTracks().forEach(track => track.stop()); }catch{}
      audioTileRecorderStates.delete(itemId);
      updateAudioTileDom(rowId, itemId);
      try{ await refreshRowAndKeepUI(rowId); }catch{}
    }
  };
  recorder.start();
  startAudioTileTimer(rowId, itemId);
  updateAudioTileDom(rowId, itemId);
}
async function stopAudioTileRecording(rowId, itemId){
  const state = audioTileRecorderStates.get(itemId);
  if(!state || state.status !== "recording") return;
  state.status = "stopping";
  stopAudioTileTimer(itemId);
  try{ state.recorder.stop(); }catch{}
}
async function waitForAudioTileRecordingStop(itemId, timeoutMs = 4000){
  const started = Date.now();
  while(audioTileRecorderStates.has(itemId) && (Date.now() - started) < timeoutMs){
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}
async function deleteAudioTile(rowId, itemId){
  const it = getAudioItemLocalByRow(rowId, itemId);
  if(!it) return;
  if(!confirm("Удалить эту аудио-плитку?")) return;

  if(audioTileRecorderStates.has(itemId)){
    await stopAudioTileRecording(rowId, itemId);
    await waitForAudioTileRecordingStop(itemId);
  }
  if(activeAudioPlayback && activeAudioPlayback.itemId === itemId && activeAudioPlayback.rowId === rowId){
    await stopActiveAudioPlayback();
  }

  await apiJson(`/items/${encodeURIComponent(itemId)}`, { method:"DELETE" });

  const p = getPuchokLocal(currentPuchokId);
  if(p?.items) p.items = p.items.filter(x => x.id !== itemId);
  if(db.rows[rowId]?.items) db.rows[rowId].items = db.rows[rowId].items.filter(x => x.id !== itemId);

  await refreshRowAndKeepUI(rowId);
}
async function stopActiveAudioPlayback(){
  if(!activeAudioPlayback) return;
  stopAudioPlaybackUiTimer();
  if(activeAudioPlayback.source){
    try{ activeAudioPlayback.source.onended = null; }catch{}
    try{ activeAudioPlayback.source.stop(0); }catch{}
  }
  if(activeAudioPlayback.ctx){
    try{ await activeAudioPlayback.ctx.close(); }catch{}
  }
  const prev = activeAudioPlayback;
  activeAudioPlayback = null;
  if(prev?.rowId && prev?.itemId) updateAudioTileDom(prev.rowId, prev.itemId);
}
async function startAudioPlaybackFromOffset(rowId, itemId, merged, offsetSec){
  if(!merged?.buffer) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if(!AudioCtx) throw new Error("Web Audio не поддерживается");

  const ctx = new AudioCtx();
  const source = ctx.createBufferSource();
  source.buffer = merged.buffer;
  source.connect(ctx.destination);

  const totalSec = Number(merged.buffer.duration || 0);
  const safeOffset = clamp(Number(offsetSec || 0), 0, totalSec);

  activeAudioPlayback = {
    rowId,
    itemId,
    ctx,
    source,
    buffer: merged.buffer,
    totalSec,
    offsetSec: safeOffset,
    startedAt: ctx.currentTime,
    isPaused: false,
    timerId: null,
  };

  source.onended = async ()=>{
    const current = activeAudioPlayback;
    if(!current || current.itemId !== itemId || current.rowId !== rowId) return;
    stopAudioPlaybackUiTimer();
    try{ await ctx.close(); }catch{}
    activeAudioPlayback = null;
    updateAudioTileDom(rowId, itemId);
  };

  source.start(0, safeOffset);
  startAudioPlaybackUiTimer(rowId, itemId);
  updateAudioTileDom(rowId, itemId);
}
async function playAudioTile(rowId, itemId){
  const it = getAudioItemLocalByRow(rowId, itemId);
  if(!it || !getAudioSegments(it).length) return;

  if(activeAudioPlayback && activeAudioPlayback.itemId === itemId && activeAudioPlayback.rowId === rowId){
    if(activeAudioPlayback.isPaused && activeAudioPlayback.buffer){
      const merged = { buffer: activeAudioPlayback.buffer };
      const resumeOffset = Number(activeAudioPlayback.offsetSec || 0);
      await stopActiveAudioPlayback();
      await startAudioPlaybackFromOffset(rowId, itemId, merged, resumeOffset);
    }
    return;
  }

  await stopActiveAudioPlayback();
  try{
    const merged = await buildMergedAudioBufferFromItem(it);
    if(!merged || !merged.buffer) return;
    await startAudioPlaybackFromOffset(rowId, itemId, merged, 0);
  }catch(err){
    addMsg("Ошибка воспроизведения аудио: " + (err?.message || err), "err");
  }
}
async function pauseAudioTilePlayback(rowId, itemId){
  if(!activeAudioPlayback || activeAudioPlayback.itemId !== itemId || activeAudioPlayback.rowId !== rowId || activeAudioPlayback.isPaused) return;
  const currentPos = getActiveAudioPlaybackPositionSec(rowId, itemId);
  const buffer = activeAudioPlayback.buffer;
  const totalSec = Number(activeAudioPlayback.totalSec || buffer?.duration || 0);
  stopAudioPlaybackUiTimer();
  if(activeAudioPlayback.source){
    try{ activeAudioPlayback.source.onended = null; }catch{}
    try{ activeAudioPlayback.source.stop(0); }catch{}
  }
  if(activeAudioPlayback.ctx){
    try{ await activeAudioPlayback.ctx.close(); }catch{}
  }
  activeAudioPlayback = {
    rowId,
    itemId,
    ctx: null,
    source: null,
    buffer,
    totalSec,
    offsetSec: currentPos,
    startedAt: 0,
    isPaused: true,
    timerId: null,
  };
  updateAudioTileDom(rowId, itemId);
}
async function seekAudioTilePlayback(rowId, itemId, valueSec){
  const it = getAudioItemLocalByRow(rowId, itemId);
  const totalSec = getAudioTotalDurationSec(it);
  const safeValue = clamp(Number(valueSec || 0), 0, totalSec);

  if(activeAudioPlayback && activeAudioPlayback.itemId === itemId && activeAudioPlayback.rowId === rowId){
    const buffer = activeAudioPlayback.buffer;
    const wasPaused = !!activeAudioPlayback.isPaused;
    if(wasPaused){
      activeAudioPlayback.offsetSec = safeValue;
      activeAudioPlayback.totalSec = Number(buffer?.duration || totalSec || 0);
      updateAudioTileDom(rowId, itemId);
      return;
    }
    if(buffer){
      await stopActiveAudioPlayback();
      await startAudioPlaybackFromOffset(rowId, itemId, { buffer }, safeValue);
      return;
    }
  }

  const card = document.querySelector(`[data-row-tile-row-id="${rowId}"][data-row-tile-item-id="${itemId}"]`);
  if(card){
    card.dataset.audioSeek = String(safeValue);
    const slider = card.querySelector("[data-audio-slider]");
    if(slider){
      slider.value = String(safeValue);
      setRangeFill(slider);
    }
    const currentEl = card.querySelector("[data-audio-current-time]");
    if(currentEl) currentEl.textContent = formatAudioDuration(safeValue);
  }
}
async function saveAudioTileWav(rowId, itemId){
  const it = getAudioItemLocalByRow(rowId, itemId);
  if(!it || !getAudioSegments(it).length) return;
  try{
    const merged = await buildMergedAudioBufferFromItem(it);
    if(!merged || !merged.buffer) return;
    const wavBlob = audioBufferToWavBlob(merged.buffer);
    try{ await merged.ctx.close(); }catch{}
    triggerBlobDownload(wavBlob, `${sanitizeDownloadName(it.title || "audio_recording", "audio_recording")}.wav`);
  }catch(err){
    addMsg("Ошибка экспорта WAV: " + (err?.message || err), "err");
  }
}
async function renameAudioTile(rowId, itemId){
  const it = getAudioItemLocalByRow(rowId, itemId);
  if(!it) return;
  const nextTitle = prompt("Новое название аудио-плитки:", it.title || "Audio Tile");
  if(nextTitle === null) return;
  const title = (nextTitle || "").trim() || "Audio Tile";
  it.title = title;
  it.updatedAt = nowISO();
  await apiJson(`/items/${encodeURIComponent(itemId)}`, {
    method:"PATCH",
    json:{ title }
  });
  const p = getPuchokLocal(currentPuchokId);
  if(p?.items){
    const legacy = p.items.find(x => x.id === itemId);
    if(legacy) legacy.title = title;
  }
  await refreshRowAndKeepUI(rowId);
}
function buildAudioTileCard(card, rowId, it){
  card.style.cursor = "default";
  const initialTotal = formatAudioDuration(getAudioTotalDurationSec(it));
  card.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0;">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <div class="itemTitle" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(it.title || "Audio Tile")}</div>
            <button type="button" class="btnGhost" data-audio-rename style="padding:4px 8px;min-width:0;">✎</button>
          </div>
          <div class="itemDesc" data-audio-seg-count>Сегментов: ${getAudioSegments(it).length}</div>
        </div>
        <div class="itemDesc" data-audio-recording-total>${initialTotal}</div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-start;">
        <button type="button" class="btnGhost" data-audio-record>⏺</button>
        <button type="button" class="btnGhost" data-audio-stop-record>■</button>
      </div>

      <div style="display:flex;flex-direction:column;gap:6px;">
        <input type="range" min="0" max="1" step="0.01" value="0" data-audio-slider
          style="appearance:none;-webkit-appearance:none;width:100%;height:6px;border-radius:999px;outline:none;background:rgba(17,19,23,.14);margin:0;" />
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div class="itemDesc" data-audio-current-time>0:00</div>
          <div class="itemDesc" data-audio-total-time>${initialTotal}</div>
        </div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
        <button type="button" class="btnGhost" data-audio-play-toggle>▶</button>
        <button type="button" class="btnGhost" data-audio-save>⬇</button>
        <button type="button" class="btnGhost" data-audio-delete>🗑</button>
      </div>
    </div>
  `;

  const btnRecord = card.querySelector("[data-audio-record]");
  const btnStopRecord = card.querySelector("[data-audio-stop-record]");
  const btnPlayToggle = card.querySelector("[data-audio-play-toggle]");
  const btnSave = card.querySelector("[data-audio-save]");
  const btnDelete = card.querySelector("[data-audio-delete]");
  const btnRename = card.querySelector("[data-audio-rename]");
  const slider = card.querySelector("[data-audio-slider]");

  if(btnRecord){
    btnRecord.addEventListener("click", async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      await startAudioTileRecording(rowId, it.id);
    });
  }
  if(btnStopRecord){
    btnStopRecord.addEventListener("click", async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      await stopAudioTileRecording(rowId, it.id);
    });
  }
  if(btnPlayToggle){
    btnPlayToggle.addEventListener("click", async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      if(activeAudioPlayback && activeAudioPlayback.itemId === it.id && activeAudioPlayback.rowId === rowId && !activeAudioPlayback.isPaused){
        await pauseAudioTilePlayback(rowId, it.id);
      }else{
        await playAudioTile(rowId, it.id);
      }
    });
  }
  if(btnSave){
    btnSave.addEventListener("click", async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      await saveAudioTileWav(rowId, it.id);
    });
  }
  if(btnDelete){
    btnDelete.addEventListener("click", async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      await deleteAudioTile(rowId, it.id);
    });
  }
  if(btnRename){
    btnRename.addEventListener("click", async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      await renameAudioTile(rowId, it.id);
    });
  }
  if(slider){
    const syncSeek = async ()=>{
      await seekAudioTilePlayback(rowId, it.id, Number(slider.value || 0));
      setRangeFill(slider);
    };
    slider.addEventListener("input", async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      await syncSeek();
    });
    slider.addEventListener("change", async (e)=>{
      e.preventDefault();
      e.stopPropagation();
      await syncSeek();
    });
    slider.addEventListener("click", (e)=>{
      e.stopPropagation();
    });
    slider.addEventListener("pointerdown", (e)=>{
      e.stopPropagation();
    });
    slider.value = "0";
    setRangeFill(slider);
  }

  card.dataset.audioSeek = "0";
  updateAudioTileDom(rowId, it.id);
}

function buildInlineRowContent(p, cached){
  const row = cached.row;
  const items = cached.items || [];

  const holder = document.createElement("div");
  holder.className = "rowInlineExpanded";
  holder.style.display = "flex";
  holder.style.flexDirection = "column";
  holder.style.gap = "12px";
  holder.style.padding = "0 0 6px 0";

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
    card.style.position = "relative";
    card.dataset.rowTileRowId = row.id;
    card.dataset.rowTileItemId = it.id;
    applyActiveTileStyles(card, activeCarouselRowId === row.id && activeCarouselItemId === it.id);
    if(it.type !== "audio"){
      card.addEventListener("click", () => openItemFromRow(row.id, it.id));
    }

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
    }else if(it.type === "video"){
      previewHTML = `<div class="itemDesc">Видео • ${fmtBytes(it.size)}</div>`;
    }else if(it.type === "file"){
      previewHTML = `<div class="itemDesc">${escapeHTML(it.mime || "file")} • ${fmtBytes(it.size)}</div>`;
    }else if(it.type === "audio"){
      const segs = (it.segments || []).length;
      previewHTML = `<div class="itemDesc">Сегментов: ${segs}</div>`;
    }else{
      previewHTML = `<div class="itemDesc">${fmtDate(it.createdAt || it.updatedAt || nowISO())}</div>`;
    }

    const isPhotoTile = it.type === "image";
    const isVideoTile = it.type === "video";
    const isAudioTile = it.type === "audio";
    if(isAudioTile){
      buildAudioTileCard(card, row.id, it);
    }else if(isPhotoTile){
      card.innerHTML = `
        <div class="itemText" style="min-width:0;padding-right:84px;">
          <div class="itemTitle">${escapeHTML(it.title || "Фото")}</div>
        </div>
        <div class="rowTilePreviewHost" style="min-height:168px;">${previewHTML}</div>
      `;
    }else{
      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;">
            <div class="thumb">${icoSVG(it.type==="image" ? "photo" : (it.type==="video" ? "video" : (it.type || "file")))}</div>
            <div class="itemText" style="min-width:0;">
              <div class="itemTitle">${escapeHTML(it.title || "Элемент")}</div>
              <div class="itemDesc">${fmtDate(it.updatedAt || it.createdAt || nowISO())}</div>
            </div>
          </div>
          <div class="${t.cls}">${t.text}</div>
        </div>
        <div class="rowTilePreviewHost" style="min-height:72px;">${previewHTML}</div>
      `;
    }

    if(isPhotoTile || isVideoTile){
      if(isPhotoTile){
        const previewHost = card.querySelector(".rowTilePreviewHost");
        mountImageTilePreview(previewHost, it);
      }

      const bubbles = document.createElement("div");
      bubbles.style.position = "absolute";
      bubbles.style.top = "8px";
      bubbles.style.right = "8px";
      bubbles.style.display = "flex";
      bubbles.style.gap = "6px";
      bubbles.style.zIndex = "6";

      const makeBubbleBtn = (label, titleText)=>{
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.title = titleText;
        btn.style.appearance = "none";
        btn.style.border = "1px solid rgba(255,255,255,.14)";
        btn.style.width = "28px";
        btn.style.height = "28px";
        btn.style.borderRadius = "999px";
        btn.style.background = "rgba(17,19,23,.62)";
        btn.style.color = "#fff";
        btn.style.backdropFilter = "blur(10px)";
        btn.style.boxShadow = "0 6px 18px rgba(0,0,0,.22)";
        btn.style.cursor = "pointer";
        btn.style.display = "inline-flex";
        btn.style.alignItems = "center";
        btn.style.justifyContent = "center";
        btn.style.fontSize = "13px";
        btn.style.fontWeight = "700";
        btn.style.lineHeight = "1";
        return btn;
      };

      const downloadBtn = makeBubbleBtn("↓", isVideoTile ? "Скачать видео" : "Скачать фото");
      downloadBtn.addEventListener("click", async (e)=>{
        e.preventDefault();
        e.stopPropagation();
        try{
          const blob = await downloadItemBlobFromR2(it.id, it.mime || (isVideoTile ? "video/*" : "image/*"), isVideoTile ? "video" : "image");
          if(!blob) throw new Error(isVideoTile ? "Blob видео не найден" : "Blob фото не найден");
          const finalMime = chooseBlobMimeType(blob?.type || "", it.mime || (isVideoTile ? "video/*" : "image/*"), isVideoTile ? "video" : "image");
          const typedBlob = (blob && sanitizeMimeType(blob.type || "", "") === finalMime)
            ? blob
            : new Blob([blob], { type: finalMime });
          const url = URL.createObjectURL(typedBlob);
          const a = document.createElement("a");
          a.href = url;
          a.download = it.title || (isVideoTile ? "video" : "photo");
          a.click();
          setTimeout(()=>{ try{ URL.revokeObjectURL(url); }catch{} }, 1500);
        }catch(err){
          addMsg((isVideoTile ? "Ошибка скачивания видео: " : "Ошибка скачивания фото: ") + (err?.message || err), "err");
        }
      });

      const deleteBtn = makeBubbleBtn("×", isVideoTile ? "Удалить видео" : "Удалить фото");
      deleteBtn.addEventListener("click", async (e)=>{
        e.preventDefault();
        e.stopPropagation();
        if(!confirm(isVideoTile ? "Удалить это видео?" : "Удалить это фото?")) return;
        isBusy = true;
        try{
          try{ await deleteItemBlobFromR2(it.id); }catch{}
          await apiJson(`/items/${encodeURIComponent(it.id)}`, { method:"DELETE" });
          if(!isVideoTile && imageViewerRowId === row.id && imageViewerItemIds.includes(it.id)){
            closeImageViewer();
          }
          if(isVideoTile && videoViewerRowId === row.id && videoViewerItemIds.includes(it.id)){
            closeVideoViewer();
          }
          try{
            const cachedPreviewUrl = itemPreviewUrlCache.get(it.id);
            if(cachedPreviewUrl) URL.revokeObjectURL(cachedPreviewUrl);
          }catch{}
          itemPreviewUrlCache.delete(it.id);
          await refreshRowAndKeepUI(row.id);
        }catch(err){
          addMsg((isVideoTile ? "Ошибка удаления видео: " : "Ошибка удаления фото: ") + (err?.message || err), "err");
        }finally{
          isBusy = false;
        }
      });

      bubbles.appendChild(downloadBtn);
      bubbles.appendChild(deleteBtn);
      card.appendChild(bubbles);
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
      <div class="itemDesc">${escapeHTML(row.type === "audio" ? "Audio Tile" : rowTypeLabel(row.type).text.replace("-ряд",""))}</div>
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

  holder.appendChild(rail);
  setTimeout(()=> updateActiveRowTileUI(row.id), 0);
  return holder;
}

/** ===========================
 *  NAV
 *  =========================== */
async function openPuchok(id){
  if(isBusy) return;
  isBusy = true;
  try{
    closeImageViewer();
    closeVideoViewer();
    currentPuchokId = id;
    currentRowId = null;
    expandedRowIds.clear();
    viewMode = "puchok";
    await loadPuchokWithEntries(id);
  }catch(e){
    addMsg("Ошибка загрузки пучка: " + (e?.message || e), "err");
    viewMode = "list";
    currentPuchokId = null;
    currentRowId = null;
    expandedRowIds.clear();
  }finally{
    isBusy = false;
    render();
  }
}

async function openRow(rowId){
  if(isBusy || !rowId) return;
  closeAddMenu();

  if(isRowExpanded(rowId)){
    collapseRowInline(rowId);
    viewMode = "puchok";
    render();
    return;
  }

  isBusy = true;
  try{
    await loadRowWithItems(rowId);
    expandRowInline(rowId);
    viewMode = "puchok";
  }catch(e){
    addMsg("Ошибка загрузки ряда: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    render();
  }
}

function goBack(){
  closeAddMenu();
  closeCameraCaptureModal();
  closeVideoCaptureModal();
  closeImageViewer();
  closeVideoViewer();
  if(viewMode === "puchok"){
    viewMode = "list";
    currentPuchokId = null;
    currentRowId = null;
    expandedRowIds.clear();
    render();
    return;
  }
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
    await apiJson("/puchki", { method:"POST", json:{ title } });
    currentPuchokId = null;
    currentRowId = null;
    expandedRowIds.clear();
    viewMode = "list";
    await loadCurrentPuchok();
    render();
  }catch(e){
    addMsg("Ошибка создания пучка: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
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
  const ok = confirm("Удалить пучок и все ряды?");
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
  if(isBusy) return;

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
  return ["photo","video","text","code","file","link","audio"].includes((rowType || "").toLowerCase());
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
    expandRowInline(rowId);
    viewMode = "puchok";
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
    expandRowInline(rowId);
    viewMode = "puchok";
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

    expandRowInline(rowId);
    viewMode = "puchok";
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

    expandRowInline(rowId);
    viewMode = "puchok";
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

  if(rowType === "video"){
    activeVideoCaptureRowId = rowId;
    activeVideoCapturePuchokId = currentPuchokId;
    if(isMobile()){
      const picker = ensureVideoPicker();
      openVideoPicker(picker);
    }else{
      const opened = await openVideoCaptureModalForRow(rowId);
      if(!opened){
        const picker = ensureVideoPicker();
        openVideoPicker(picker);
      }
    }
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
        alert("Не удалось создать аудио-плитку.");
        return;
      }
      await refreshRowAndKeepUI(rowId);
    }catch(e){
      addMsg("Ошибка аудио-плитки: " + (e?.message || e), "err");
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
async function loadCurrentPuchok(){
  if(currentPuchokId) return await loadPuchokWithEntries(currentPuchokId);
  return await loadPuchkiList();
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
  expandRowInline(rowId);
  viewMode = "puchok";
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
  if((file.type || "").startsWith("video/")){
    activeVideoCaptureRowId = rowId;
    activeVideoCapturePuchokId = p.id;
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

    let rowId = null;
    const currentPack = getCurrentRowPack();
    if(viewMode === "row" && currentPack?.row?.type === "photo"){
      rowId = currentPack.row.id;
    }else if(activePhotoCaptureRowId && activePhotoCapturePuchokId === p.id){
      rowId = activePhotoCaptureRowId;
    }else{
      rowId = await ensurePhotoRowForCapture(p);
    }

    activePhotoCaptureRowId = rowId;
    activePhotoCapturePuchokId = p.id;
    currentRowId = rowId;

    if(isDesktopLikeDevice()){
      const opened = await openCameraCaptureModalForPhotoRow(rowId);
      if(opened) return;
    }

    const picker = ensurePhotoPicker();
    openPhotoPicker(picker);
  }catch(e){
    addMsg("Ошибка подготовки фото: " + (e?.message || e), "err");
  }
}


function stopCameraCaptureStream(){
  if(cameraCaptureStream){
    try{
      for(const track of cameraCaptureStream.getTracks()){
        try{ track.stop(); }catch{}
      }
    }catch{}
  }
  cameraCaptureStream = null;
}

function ensureCameraCaptureModal(){
  if(cameraCaptureModal && cameraCaptureModal.parentElement === document.body) return cameraCaptureModal;

  cameraCaptureModal = document.createElement("div");
  cameraCaptureModal.id = "cameraCaptureModal";
  cameraCaptureModal.style.position = "fixed";
  cameraCaptureModal.style.inset = "0";
  cameraCaptureModal.style.zIndex = "120000";
  cameraCaptureModal.style.background = "rgba(17,19,23,.82)";
  cameraCaptureModal.style.display = "none";
  cameraCaptureModal.style.alignItems = "center";
  cameraCaptureModal.style.justifyContent = "center";
  cameraCaptureModal.innerHTML = `
    <div id="cameraCapturePanel"
      style="width:min(92vw, 760px);max-height:92vh;background:#fff;border-radius:20px;
             box-shadow:0 24px 80px rgba(0,0,0,.35);padding:16px;display:flex;
             flex-direction:column;gap:14px;position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="font-weight:700;font-size:18px;">Сделать фото</div>
        <button type="button" id="cameraCaptureClose"
          style="appearance:none;border:0;background:rgba(17,19,23,.08);color:#111317;
                 border-radius:12px;padding:8px 12px;font-size:14px;cursor:pointer;">Закрыть</button>
      </div>
      <div style="position:relative;border-radius:18px;overflow:hidden;background:#0f1115;min-height:240px;">
        <video id="cameraCaptureVideo" autoplay playsinline muted
          style="display:block;width:100%;height:min(68vh, 520px);object-fit:cover;background:#0f1115;"></video>
      </div>
      <div id="cameraCaptureHint" style="font-size:13px;opacity:.8;">Подожди, запускаю камеру…</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;">
        <button type="button" id="cameraCaptureFallback"
          style="appearance:none;border:0;background:rgba(17,19,23,.08);color:#111317;
                 border-radius:12px;padding:10px 14px;font-size:14px;cursor:pointer;">Выбрать файл</button>
        <button type="button" id="cameraCaptureShot"
          style="appearance:none;border:0;background:#111317;color:#fff;
                 border-radius:12px;padding:10px 16px;font-size:14px;cursor:pointer;">Сделать фото</button>
      </div>
    </div>
  `;
  document.body.appendChild(cameraCaptureModal);

  const closeBtn = cameraCaptureModal.querySelector("#cameraCaptureClose");
  const fallbackBtn = cameraCaptureModal.querySelector("#cameraCaptureFallback");
  const shotBtn = cameraCaptureModal.querySelector("#cameraCaptureShot");

  if(closeBtn) closeBtn.addEventListener("click", ()=> closeCameraCaptureModal());
  if(fallbackBtn) fallbackBtn.addEventListener("click", async ()=>{
    const rowId = cameraCaptureTargetRowId;
    const puchokId = cameraCaptureTargetPuchokId;
    closeCameraCaptureModal();
    if(rowId && puchokId && currentPuchokId === puchokId){
      activePhotoCaptureRowId = rowId;
      activePhotoCapturePuchokId = puchokId;
    }
    const picker = ensurePhotoPicker();
    openPhotoPicker(picker);
  });
  if(shotBtn) shotBtn.addEventListener("click", async ()=>{
    await takePhotoFromCameraModal();
  });

  cameraCaptureModal.addEventListener("click", (e)=>{
    if(e.target === cameraCaptureModal) closeCameraCaptureModal();
  });

  return cameraCaptureModal;
}

function closeCameraCaptureModal(){
  stopCameraCaptureStream();
  if(cameraCaptureModal){
    cameraCaptureModal.style.display = "none";
    const video = cameraCaptureModal.querySelector("#cameraCaptureVideo");
    const hint = cameraCaptureModal.querySelector("#cameraCaptureHint");
    if(video){
      try{ video.pause(); }catch{}
      try{ video.srcObject = null; }catch{}
    }
    if(hint) hint.textContent = "Подожди, запускаю камеру…";
  }
}

function makeCapturedPhotoFile(blob){
  const ext = "jpg";
  const name = `camera_${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
  try{
    return new File([blob], name, { type: blob.type || "image/jpeg", lastModified: Date.now() });
  }catch{
    blob.name = name;
    blob.lastModified = Date.now();
    return blob;
  }
}

async function openCameraCaptureModalForPhotoRow(rowId){
  const p = ensureCurrentPuchok();
  if(!p || !rowId) return false;
  if(!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function"){
    return false;
  }

  const modal = ensureCameraCaptureModal();
  const video = modal.querySelector("#cameraCaptureVideo");
  const hint = modal.querySelector("#cameraCaptureHint");
  const shotBtn = modal.querySelector("#cameraCaptureShot");

  cameraCaptureTargetRowId = rowId;
  cameraCaptureTargetPuchokId = p.id;
  modal.style.display = "flex";
  if(hint) hint.textContent = "Подожди, запускаю камеру…";
  if(shotBtn) shotBtn.disabled = true;

  stopCameraCaptureStream();

  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    cameraCaptureStream = stream;
    if(video){
      video.srcObject = stream;
      try{ await video.play(); }catch{}
    }
    if(hint) hint.textContent = "Нажми «Сделать фото».";
    if(shotBtn) shotBtn.disabled = false;
    return true;
  }catch(e){
    closeCameraCaptureModal();
    return false;
  }
}

async function takePhotoFromCameraModal(){
  if(!cameraCaptureModal || !cameraCaptureTargetRowId || !cameraCaptureTargetPuchokId) return;
  if(currentPuchokId !== cameraCaptureTargetPuchokId) return;

  const video = cameraCaptureModal.querySelector("#cameraCaptureVideo");
  const hint = cameraCaptureModal.querySelector("#cameraCaptureHint");
  const shotBtn = cameraCaptureModal.querySelector("#cameraCaptureShot");
  if(!video) return;

  const width = Math.max(1, video.videoWidth || 1280);
  const height = Math.max(1, video.videoHeight || 720);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if(!ctx) return;
  ctx.drawImage(video, 0, 0, width, height);

  if(shotBtn) shotBtn.disabled = true;
  if(hint) hint.textContent = "Сохраняю фото…";

  const blob = await new Promise((resolve)=> canvas.toBlob(resolve, "image/jpeg", 0.92));
  if(!blob){
    if(hint) hint.textContent = "Не удалось сделать снимок.";
    if(shotBtn) shotBtn.disabled = false;
    return;
  }

  const file = makeCapturedPhotoFile(blob);
  const rowId = cameraCaptureTargetRowId;
  const p = ensureCurrentPuchok();
  if(!p){
    if(shotBtn) shotBtn.disabled = false;
    return;
  }

  isBusy = true;
  try{
    const created = await addFileItemToSpecificRow(p, rowId, file);
    expandRowInline(rowId);
    viewMode = "puchok";
    await refreshRowAndKeepUI(rowId);
    closeCameraCaptureModal();
    if(created?.itemId){
      await openItemFromRow(rowId, created.itemId);
    }
  }catch(e){
    if(hint) hint.textContent = "Ошибка сохранения фото.";
    addMsg("Ошибка добавления фото: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    if(shotBtn) shotBtn.disabled = false;
  }
}

function stopVideoCaptureStream(){
  if(videoCaptureRecorder){
    try{ if(videoCaptureRecorder.state !== "inactive") videoCaptureRecorder.stop(); }catch{}
  }
  videoCaptureRecorder = null;
  if(videoCaptureStream){
    try{ for(const track of videoCaptureStream.getTracks()){ try{ track.stop(); }catch{} } }catch{}
  }
  videoCaptureStream = null;
  videoCaptureChunks = [];
}

function ensureVideoCaptureModal(){
  if(videoCaptureModal && videoCaptureModal.parentElement === document.body) return videoCaptureModal;

  videoCaptureModal = document.createElement("div");
  videoCaptureModal.id = "videoCaptureModal";
  videoCaptureModal.style.position = "fixed";
  videoCaptureModal.style.inset = "0";
  videoCaptureModal.style.zIndex = "120500";
  videoCaptureModal.style.background = "rgba(17,19,23,.82)";
  videoCaptureModal.style.display = "none";
  videoCaptureModal.style.alignItems = "center";
  videoCaptureModal.style.justifyContent = "center";
  videoCaptureModal.innerHTML = `
    <div style="width:min(92vw,760px);max-height:92vh;background:#fff;border-radius:20px;box-shadow:0 24px 80px rgba(0,0,0,.35);padding:16px;display:flex;flex-direction:column;gap:14px;position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div style="font-weight:700;font-size:18px;">Записать видео</div>
        <button type="button" id="videoCaptureCancelTop" style="appearance:none;border:0;background:rgba(17,19,23,.08);color:#111317;border-radius:12px;padding:8px 12px;font-size:14px;cursor:pointer;">Cancel</button>
      </div>
      <div style="position:relative;border-radius:18px;overflow:hidden;background:#0f1115;min-height:240px;">
        <video id="videoCapturePreview" autoplay playsinline muted style="display:block;width:100%;height:min(68vh,520px);object-fit:cover;background:#0f1115;"></video>
      </div>
      <div id="videoCaptureHint" style="font-size:13px;opacity:.8;">Подожди, запускаю камеру…</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;">
        <button type="button" id="videoCaptureStart" style="appearance:none;border:0;background:#111317;color:#fff;border-radius:12px;padding:10px 16px;font-size:14px;cursor:pointer;">Start Recording</button>
        <button type="button" id="videoCaptureStop" style="appearance:none;border:0;background:#8b1e2d;color:#fff;border-radius:12px;padding:10px 16px;font-size:14px;cursor:pointer;" disabled>Stop Recording</button>
        <button type="button" id="videoCaptureCancel" style="appearance:none;border:0;background:rgba(17,19,23,.08);color:#111317;border-radius:12px;padding:10px 14px;font-size:14px;cursor:pointer;">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(videoCaptureModal);

  const cancelTopBtn = videoCaptureModal.querySelector("#videoCaptureCancelTop");
  const cancelBtn = videoCaptureModal.querySelector("#videoCaptureCancel");
  const startBtn = videoCaptureModal.querySelector("#videoCaptureStart");
  const stopBtn = videoCaptureModal.querySelector("#videoCaptureStop");
  const cancelHandler = ()=> closeVideoCaptureModal();

  if(cancelTopBtn) cancelTopBtn.addEventListener("click", cancelHandler);
  if(cancelBtn) cancelBtn.addEventListener("click", cancelHandler);
  if(startBtn) startBtn.addEventListener("click", ()=> startVideoRecordingInModal());
  if(stopBtn) stopBtn.addEventListener("click", ()=> stopVideoRecordingInModal());

  videoCaptureModal.addEventListener("click", (e)=>{
    if(e.target === videoCaptureModal) closeVideoCaptureModal();
  });

  return videoCaptureModal;
}

function closeVideoCaptureModal(){
  stopVideoCaptureStream();
  if(videoCaptureModal){
    videoCaptureModal.style.display = "none";
    const preview = videoCaptureModal.querySelector("#videoCapturePreview");
    const hint = videoCaptureModal.querySelector("#videoCaptureHint");
    const startBtn = videoCaptureModal.querySelector("#videoCaptureStart");
    const stopBtn = videoCaptureModal.querySelector("#videoCaptureStop");
    if(preview){
      try{ preview.pause(); }catch{}
      try{ preview.srcObject = null; }catch{}
      preview.removeAttribute("src");
      try{ preview.load(); }catch{}
    }
    if(hint) hint.textContent = "Подожди, запускаю камеру…";
    if(startBtn) startBtn.disabled = false;
    if(stopBtn) stopBtn.disabled = true;
  }
}

function makeCapturedVideoFile(blob){
  const name = `video_${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
  try{
    return new File([blob], name, { type: blob.type || "video/webm", lastModified: Date.now() });
  }catch{
    blob.name = name;
    blob.lastModified = Date.now();
    return blob;
  }
}

async function openVideoCaptureModalForRow(rowId){
  const puchok = ensureCurrentPuchok();
  if(!puchok || !rowId) return false;
  if(!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function" || !hasMediaRecorder()){
    return false;
  }

  const modal = ensureVideoCaptureModal();
  const preview = modal.querySelector("#videoCapturePreview");
  const hint = modal.querySelector("#videoCaptureHint");
  const startBtn = modal.querySelector("#videoCaptureStart");
  const stopBtn = modal.querySelector("#videoCaptureStop");

  videoCaptureTargetRowId = rowId;
  videoCaptureTargetPuchokId = puchok.id;
  modal.style.display = "flex";
  if(hint) hint.textContent = "Подожди, запускаю камеру…";
  if(startBtn) startBtn.disabled = true;
  if(stopBtn) stopBtn.disabled = true;

  stopVideoCaptureStream();

  try{
    const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    videoCaptureStream = stream;
    if(preview){
      preview.srcObject = stream;
      try{ await preview.play(); }catch{}
    }
    if(hint) hint.textContent = "Нажми «Start Recording».";
    if(startBtn) startBtn.disabled = false;
    return true;
  }catch(e){
    closeVideoCaptureModal();
    return false;
  }
}

function startVideoRecordingInModal(){
  if(!videoCaptureStream || !videoCaptureModal) return;
  const hint = videoCaptureModal.querySelector("#videoCaptureHint");
  const startBtn = videoCaptureModal.querySelector("#videoCaptureStart");
  const stopBtn = videoCaptureModal.querySelector("#videoCaptureStop");
  try{
    videoCaptureChunks = [];
    videoCaptureRecorder = new MediaRecorder(videoCaptureStream);
    videoCaptureRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size > 0) videoCaptureChunks.push(e.data); };
    videoCaptureRecorder.start();
    if(hint) hint.textContent = "Идёт запись…";
    if(startBtn) startBtn.disabled = true;
    if(stopBtn) stopBtn.disabled = false;
  }catch(e){
    if(hint) hint.textContent = "Не удалось начать запись.";
  }
}

async function stopVideoRecordingInModal(){
  if(!videoCaptureRecorder || !videoCaptureModal) return;

  const hint = videoCaptureModal.querySelector("#videoCaptureHint");
  const startBtn = videoCaptureModal.querySelector("#videoCaptureStart");
  const stopBtn = videoCaptureModal.querySelector("#videoCaptureStop");
  const rowId = videoCaptureTargetRowId;
  const puchokId = videoCaptureTargetPuchokId;
  if(!rowId || !puchokId || currentPuchokId !== puchokId) return;

  if(hint) hint.textContent = "Сохраняю видео…";
  if(stopBtn) stopBtn.disabled = true;

  await new Promise((resolve, reject)=>{
    const rec = videoCaptureRecorder;
    rec.onstop = ()=> resolve();
    rec.onerror = (err)=> reject(err);
    try{ rec.stop(); }catch(err){ reject(err); }
  }).catch(()=>{ if(hint) hint.textContent = "Ошибка остановки записи."; });

  const blob = new Blob(videoCaptureChunks, { type:"video/webm" });
  videoCaptureRecorder = null;

  if(!blob || !blob.size){
    if(hint) hint.textContent = "Видео не записалось.";
    if(startBtn) startBtn.disabled = false;
    return;
  }

  const file = makeCapturedVideoFile(blob);
  const puchok = ensureCurrentPuchok();
  if(!puchok){
    if(startBtn) startBtn.disabled = false;
    return;
  }

  isBusy = true;
  try{
    const created = await addFileItemToSpecificRow(puchok, rowId, file);
    expandRowInline(rowId);
    viewMode = "puchok";
    await refreshRowAndKeepUI(rowId);
    closeVideoCaptureModal();
    if(created?.itemId){
      await openItemFromRow(rowId, created.itemId);
    }
  }catch(e){
    if(hint) hint.textContent = "Ошибка сохранения видео.";
    addMsg("Ошибка добавления видео: " + (e?.message || e), "err");
  }finally{
    isBusy = false;
    if(startBtn) startBtn.disabled = false;
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

  if(it.type === "image"){
    await openImageViewer(rowId, itemId);
    return;
  }
  if(it.type === "video"){
    await openVideoViewer(rowId, itemId);
    return;
  }
  if(it.type === "audio"){
    return;
  }

  closeImageViewer();
  closeVideoViewer();

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

  if(it.type === "file"){
    modalHint.textContent = `Файл: метаданные в облаке (D1), blob в облаке (R2).`;
    modalViewer.innerHTML = `<div class="empty">Загружаю файл из облака…</div>`;

    let blob = null;
    try{
      blob = await downloadItemBlobFromR2(it.id, it.mime || "application/octet-stream", it.type);
    }catch(e){
      modalViewer.innerHTML = `<div class="empty">Ошибка загрузки: ${escapeHTML(e?.message || e)}</div>`;
      return;
    }

    if(!blob){
      modalViewer.innerHTML = `<div class="empty">Blob не найден в R2 (404).</div>`;
      return;
    }

    const finalMime = chooseBlobMimeType(blob?.type || "", it.mime || "application/octet-stream", it.type);
    const typedBlob = (blob && sanitizeMimeType(blob.type || "", "") === finalMime)
      ? blob
      : new Blob([blob], { type: finalMime });
    const url = URL.createObjectURL(typedBlob);

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

    renderModalNav(rowId, itemId);
    const btnOpenNewTab = document.getElementById("btnOpenNewTab");
    const btnDownload = document.getElementById("btnDownload");

    if(btnOpenNewTab) btnOpenNewTab.onclick = () => window.open(url, "_blank");
    if(btnDownload) btnDownload.onclick = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = it.title || "file";
      a.click();
    };

    return;
  }

  if(it.type === "audio"){
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

ensureDeletePuchokHeaderBtn();
if(deletePuchokHeaderBtn){
  deletePuchokHeaderBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    e.stopPropagation();
    await deleteCurrentPuchok();
  });
}


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
  if(viewMode !== "puchok"){ return; }
  try{
    const p = ensureCurrentPuchok();
    if(!p) return;
    const rowId = await createNewRowForType(p, "audio");
    currentRowId = rowId;
    expandRowInline(rowId);
    await refreshRowAndKeepUI(rowId);
  }catch(e){
    addMsg("Ошибка создания audio row: " + (e?.message || e), "err");
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

      expandRowInline(targetRowId);
      viewMode = "puchok";
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
ensureVideoPicker();
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

    expandRowInline(rowId);
    viewMode = "puchok";
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

videoPicker.addEventListener("change", async () => {
  const picker = configureVideoPickerForCurrentDevice(ensureVideoPicker());
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

  const rowId = activeVideoCaptureRowId;
  const puchokId = activeVideoCapturePuchokId;
  if(!rowId || puchokId !== currentPuchokId){
    isBusy = false;
    picker.value = "";
    return;
  }

  isBusy = true;
  try{
    let lastItemId = null;
    for(const f of files){
      const created = await addFileItemToSpecificRow(p, rowId, f);
      lastItemId = created.itemId;
    }

    expandRowInline(rowId);
    viewMode = "puchok";
    await refreshRowAndKeepUI(rowId);

    if(lastItemId){
      await openItemFromRow(rowId, lastItemId);
    }
  }catch(e){
    addMsg("Ошибка добавления видео: " + (e?.message || e), "err");
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
  if(cameraCaptureModal && cameraCaptureModal.style.display === "flex" && e.key === "Escape"){
    e.preventDefault();
    closeCameraCaptureModal();
    return;
  }
  if(videoCaptureModal && videoCaptureModal.style.display === "flex" && e.key === "Escape"){
    e.preventDefault();
    closeVideoCaptureModal();
    return;
  }
  if(imageViewerWrap && imageViewerWrap.style.display === "flex"){
    if(e.key === "ArrowLeft"){
      e.preventDefault();
      await openSiblingImageInViewer(-1);
      return;
    }
    if(e.key === "ArrowRight"){
      e.preventDefault();
      await openSiblingImageInViewer(1);
      return;
    }
    if(e.key === "Escape"){
      e.preventDefault();
      closeImageViewer();
      return;
    }
  }
  if(videoViewerWrap && videoViewerWrap.style.display === "flex"){
    if(e.key === "ArrowLeft"){
      e.preventDefault();
      await openSiblingVideoInViewer(-1);
      return;
    }
    if(e.key === "ArrowRight"){
      e.preventDefault();
      await openSiblingVideoInViewer(1);
      return;
    }
    if(e.key === "Escape"){
      e.preventDefault();
      closeVideoViewer();
      return;
    }
  }
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
(function bindLongPressForSubpuchok(){})();



function bindMenuAddSubpuchokButton(btn){
  if(!btn || btn.dataset.subpuchokBound === "1") return;

  btn.dataset.subpuchokBound = "1";

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    closeAddMenu();

    if(viewMode !== "puchok"){
      alert("Подпучок можно создать только внутри пучка.");
      return;
    }

    try{
      await createSubpuchokInCurrent();
    }catch(err){
      console.error(err);
      alert("Не удалось создать подпучок.");
    }
  });
}


async function deleteSubpuchok(subId){
  if(!subId) return;
  if(!confirm("Удалить подпучок?")) return;

  await apiJson(`/puchki/${encodeURIComponent(subId)}`, {
    method: "DELETE"
  });

  await loadPuchokWithEntries(currentPuchokId);
  render();
}
