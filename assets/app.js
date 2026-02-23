/** ===========================
 *  CONFIG
 *  =========================== */
const WORKER_URL = "https://gptim24.timashevanatoly10.workers.dev";

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

/** ===========================
 *  DB wrappers
 *  =========================== */
function saveDBLocal(){ saveDB(db); }
function getPuchokLocal(id){ return getPuchok(db, id); }
function getItemLocal(pId, itemId){ return getItem(db, pId, itemId); }

/** ===========================
 *  MENU
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
 *  CHAT COLLAPSE
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
 *  HEADER
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
 *  RENDER
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
    empty.innerHTML = "Пока нет пучков.<br>Нажми <b>+ Пучок</b>.";
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

      sub.innerHTML = `
        <span class="pill">Элементов: ${count}</span>
        <span class="pill">Обновлён: ${fmtDate(p.updatedAt || p.createdAt || nowISO())}</span>
      `;

      meta.appendChild(name);
      meta.appendChild(sub);

      const btn = document.createElement("button");
      btn.className = "btnGhost";
      btn.textContent = "Открыть";
      btn.onclick = () => openPuchok(p.id);

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
    empty.innerHTML = "Внутри пусто.<br>Нажми <b>+</b>.";
    wrap.appendChild(empty);
  }else{
    const sorted = [...p.items].sort((a,b)=> (b.updatedAt||b.createdAt||"").localeCompare(a.updatedAt||a.createdAt||""));
    for(const it of sorted){
      const row = document.createElement("div");
      row.className = "itemRow";
      row.onclick = () => openItem(p.id, it.id);

      row.innerHTML = `
        <div class="itemLeft">
          <div class="thumb"></div>
          <div class="itemText">
            <div class="itemTitle">${escapeHTML(it.title || "Элемент")}</div>
            <div class="itemDesc">${fmtDate(it.createdAt)}</div>
          </div>
        </div>
      `;
      wrap.appendChild(row);
    }
  }

  mainPanel.appendChild(wrap);
}

/** ===========================
 *  CRUD
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

/** ===========================
 *  CHAT
 *  =========================== */
function addMsg(text, cls){
  const wrap = document.createElement("div");
  wrap.className = "msg " + cls;
  wrap.innerHTML = `<div>${escapeHTML(text)}</div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

function clearChat(){
  chat.innerHTML = "";
  addMsg("Чат очищен.", "bot");
}

async function handleSend(){
  const text = input.value.trim();
  if(!text) return;

  expandChat();
  addMsg(text, "me");
  input.value = "";
  send.disabled = true;

  try{
    const resp = await fetch(WORKER_URL + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });

    const data = await resp.json();
    addMsg(data.answer || "Нет ответа", "bot");
  }catch(e){
    addMsg("Ошибка сети", "err");
  }

  send.disabled = false;
}

/** ===========================
 *  EVENTS
 *  =========================== */
backBtn.onclick = goBack;
newPuchokBtn.onclick = createPuchok;
send.onclick = handleSend;
input.addEventListener("keydown", e => { if(e.key==="Enter") handleSend(); });
clearChatBtn.onclick = clearChat;

/** ===========================
 *  INIT
 *  =========================== */
(function init(){
  render();
  clearChat();
  collapseChat();
})();
