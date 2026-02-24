/** ===========================
 *  CONFIG
 *  =========================== */
const WORKER_URL = "https://gptim24.timashevanatoly10.workers.dev";

// API token (для доступа к Worker). Храним локально на устройстве.
const API_TOKEN_STORAGE_KEY = "PUCHKI_API_TOKEN";

/** ===========================
 *  TOKEN HELPERS
 *  =========================== */
function getApiToken(){
  try{
    return (localStorage.getItem(API_TOKEN_STORAGE_KEY) || "").trim();
  }catch{
    return "";
  }
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
  if(t === null) return null; // cancel
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
 *  STATE
 *  =========================== */
let db = loadDB();
let currentPuchokId = null;
let openItemId = null;
let openItemType = null;

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

/** ===========================
 *  DB wrappers (use storage.js signatures)
 *  =========================== */
function saveDBLocal(){ saveDB(db); }
function getPuchokLocal(id){ return getPuchok(db, id); }
function getItemLocal(pId, itemId){ return getItem(db, pId, itemId); }

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

function renderPuchokList(){
  const wrap = document.createElement("div");
  wrap.className = "list";

  if(db.puchki.length === 0){
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
      const count = (p.items || []).length;

      const pill1 = document.createElement("span");
      pill1.className = "pill";
      pill1.textContent = `Элементов: ${count}`;

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

  if((p.items || []).length === 0){
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "Внутри пусто.<br>Нажми <b>+</b> сверху справа → добавь текст / файл / аудио / код / ссылку.";
    wrap.appendChild(empty);
  }else{
    const sorted = [...p.items].sort((a,b)=> (b.updatedAt||b.createdAt||"").localeCompare(a.updatedAt||a.createdAt||""));
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
 *  NAV
 *  =========================== */
function openPuchok(id){
  currentPuchokId = id;
  render();
}
function goBack(){
  closeAddMenu();
  currentPuchokId = null;
  render();
}

/** ===========================
 *  CRUD: Puchok
 *  =========================== */
function createPuchok(){
  const name = prompt("Название пучка:", "Новый пучок");
  if(name === null) return;
  const p = {
    id: uid(),
    title: (name || "").trim() || "Новый пучок",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    items: []
  };
  db.puchki.push(p);
  saveDBLocal();
  openPuchok(p.id);
}
function renameCurrentPuchok(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p) return;
  const name = prompt("Новое название пучка:", p.title || "");
  if(name === null) return;
  p.title = (name || "").trim() || "Без названия";
  p.updatedAt = nowISO();
  saveDBLocal();
  render();
}
async function deleteCurrentPuchok(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p) return;
  closeAddMenu();
  const ok = confirm(`Удалить пучок “${p.title || "Без названия"}”?`);
  if(!ok) return;

  for(const it of (p.items || [])){
    await cleanupItemBlobs(it);
  }

  db.puchki = db.puchki.filter(x => x.id !== p.id);
  saveDBLocal();
  currentPuchokId = null;
  render();
}

/** ===========================
 *  CRUD: Items
 *  =========================== */
function ensureCurrentPuchok(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p){
    alert("Сначала открой пучок — тогда можно добавлять туда элементы.");
    return null;
  }
  return p;
}

function addTextItemToCurrent(initialText = ""){
  const p = ensureCurrentPuchok();
  if(!p) return;

  const it = {
    id: uid(),
    type: "text",
    title: safeTitleFromText(initialText) || "Текст",
    content: (initialText || "").toString(),
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  p.items.push(it);
  p.updatedAt = nowISO();
  saveDBLocal();
  render();
  openItem(p.id, it.id);
}

function addCodeItemToCurrent(initialCode = ""){
  const p = ensureCurrentPuchok();
  if(!p) return;

  const it = {
    id: uid(),
    type: "code",
    title: safeTitleFromText(initialCode) || "Код",
    content: (initialCode || "").toString(),
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
  p.items.push(it);
  p.updatedAt = nowISO();
  saveDBLocal();
  render();
  openItem(p.id, it.id);
}

function addLinkItemsToCurrent(rawInput){
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

  for(const line of lines){
    const u = normalizeUrl(line);
    if(!u) continue;
    const it = {
      id: uid(),
      type: "link",
      title: urlTitle(u),
      url: u,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    p.items.push(it);
  }

  p.updatedAt = nowISO();
  saveDBLocal();
  render();
}

async function addFileItemToCurrent(file){
  const p = ensureCurrentPuchok();
  if(!p) return;

  const isImg = (file.type || "").startsWith("image/");
  const id = uid();
  const blobKey = `blob:${id}:main`;
  await idbPutBlob(blobKey, file);

  let it;
  if(isImg){
    const thumbKey = `blob:${id}:thumb`;
    await idbPutBlob(thumbKey, file);
    it = {
      id,
      type: "image",
      title: file.name ? file.name : "Фото",
      blobKey,
      thumbKey,
      mime: file.type || "image/*",
      size: file.size || 0,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
  }else{
    it = {
      id,
      type: "file",
      title: file.name || "Файл",
      blobKey,
      mime: file.type || "application/octet-stream",
      size: file.size || 0,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
  }

  p.items.push(it);
  p.updatedAt = nowISO();
  saveDBLocal();
  render();
  openItem(p.id, it.id);
}

/** ===========================
 *  MODAL / OPEN ITEM
 *  =========================== */
function closeModal(){
  // audio.js exports these
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
    modalHint.textContent = "Текст можно редактировать и сохранять.";
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
    modalHint.textContent = "Код: редактирование + Copy.";
    modalWrap.style.display = "flex";
    setTimeout(()=> modalTextarea.focus(), 50);
    return;
  }

  modalTextarea.style.display = "none";
  modalViewer.style.display = "block";
  modalWrap.style.display = "flex";

  if(it.type === "link"){
    modalHint.textContent = "Ссылка: открыть или скопировать.";
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
    modalHint.textContent = "Фото хранится локально (IndexedDB).";
    const b = await idbGetBlob(it.blobKey);
    if(!b){
      modalViewer.innerHTML = `<div class="empty">Файл не найден в хранилище.</div>`;
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
    modalHint.textContent = "Файл хранится локально (IndexedDB).";
    const b = await idbGetBlob(it.blobKey);
    if(!b){
      modalViewer.innerHTML = `<div class="empty">Файл не найден в хранилище.</div>`;
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
    // audio.js exports renderAudioViewer
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
function saveModal(){
  const p = getPuchokLocal(currentPuchokId);
  if(!p) return;
  const it = (p.items || []).find(x => x.id === openItemId);
  if(!it) return;

  if(it.type === "text"){
    const txt = modalTextarea.value || "";
    it.content = txt;
    it.title = safeTitleFromText(txt) || (it.title || "Текст");
    it.updatedAt = nowISO();
    p.updatedAt = nowISO();
    saveDBLocal();
    closeModal();
    render();
    return;
  }

  if(it.type === "code"){
    const code = modalTextarea.value || "";
    it.content = code;
    it.title = safeTitleFromText(code) || (it.title || "Код");
    it.updatedAt = nowISO();
    p.updatedAt = nowISO();
    saveDBLocal();
    closeModal();
    render();
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

  await cleanupItemBlobs(it);

  p.items = (p.items || []).filter(x => x.id !== it.id);
  p.updatedAt = nowISO();
  saveDBLocal();
  closeModal();
  render();
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
  return await fetch(WORKER_URL + "/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ message: text })
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
    // 1) убеждаемся что есть токен (если нет — спросим)
    const t = ensureApiToken({ force: false });
    if(!t){
      addMsg("Нужен API token. Нажми отправить ещё раз и введи токен.", "err");
      send.disabled = false;
      return;
    }

    // 2) отправляем
    let resp = await postChatOnce(text);

    // 3) если не авторизованы — попросим токен ещё раз и повторим 1 раз
    if(resp.status === 401 || resp.status === 403){
      const t2 = ensureApiToken({ force: true });
      if(!t2){
        addMsg("Без токена доступа нет (401/403).", "err");
        send.disabled = false;
        return;
      }
      resp = await postChatOnce(text);
    }

    const raw = await resp.text();
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
    addMsg("Ошибка сети: " + (e?.message || e), "err");
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
  if(typeof createAudioItemAndRecord === "function"){
    await createAudioItemAndRecord();
  }else{
    alert("audio.js не загрузился (нет createAudioItemAndRecord).");
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

// audioPicker change handler переехал в /assets/audio.js

send.addEventListener("click", handleSend);
input.addEventListener("keydown", (e) => { if(e.key === "Enter") handleSend(); });
clearChatBtn.addEventListener("click", clearChat);

// Доп. горячая кнопка: двойной клик по "Очистить" — сменить токен
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
(function init(){
  render();
  clearChat();
  collapseChat();
})();
