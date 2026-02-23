/* ===========================
   AUDIO MODULE
   Recording + Smart Player + WAV export
   Depends on globals from index.html:
   - db, currentPuchokId
   - saveDBLocal(), getPuchokLocal(), getItemLocal(), render()
   - idbPutBlob(), idbGetBlob()
   - audioPicker, modalViewer, modalHint
   - helpers: nowISO(), uid(), fmtBytes(), fmtTimeSec(), clamp(), setRangeFill(), escapeHTML()
   - feature helpers: isIOS(), hasMediaRecorder(), canUseWebAudio(), chooseAudioMode()
   =========================== */

(function(){
  // --- Recording state
  let mediaRecorder = null;
  let recChunks = [];
  let isRecording = false;
  let currentAudioAppendTarget = null; // { pId, itemId }
  let pendingAudioTarget = null;       // for capture fallback

  // --- Recording UI clock (LIVE while recording)
  let recClockRaf = null;
  let recClockStartPerf = 0;
  let recClockBaseSec = 0;
  let recClockItemId = null;

  // --- Smart audio player state
  let audioCtx = null;
  let activeSource = null;
  let activePlayingItemId = null;
  let playStartCtxTime = 0;
  let playStartOffset = 0;
  let currentOffset = 0;
  let rafId = null;

  // --- Cache merged buffers + wav blobs per item
  const audioCache = {}; // { [itemId]: { sig, buffer, duration, wavBlob } }

  // Expose some state to global (for compatibility / debug if needed)
  window.audioCache = audioCache;

  // Audio mode global (same name as раньше)
  window.AUDIO_MODE = window.AUDIO_MODE || "mediarecorder";

  /* ===========================
     iOS MediaRecorder safe stop
     =========================== */
  function safeStopRecorder(){
    if(!mediaRecorder) return;
    try{
      if(typeof isIOS === "function" && isIOS()){
        try{ mediaRecorder.requestData(); }catch{}
        setTimeout(()=>{ try{ mediaRecorder.stop(); }catch{} }, 140);
      }else{
        try{ mediaRecorder.stop(); }catch{}
      }
    }catch{}
  }

  /* ===========================
     RECORDING LIVE CLOCK
     =========================== */
  function stopRecClock(){
    if(recClockRaf) cancelAnimationFrame(recClockRaf);
    recClockRaf = null;
    recClockItemId = null;
  }

  function startRecClock(itemId, baseSec){
    stopRecClock();
    recClockItemId = itemId;
    recClockBaseSec = Number(baseSec || 0);
    recClockStartPerf = performance.now();

    const tick = () => {
      if(!isRecording || !recClockItemId || recClockItemId !== itemId){
        stopRecClock();
        return;
      }
      const live = recClockBaseSec + (performance.now() - recClockStartPerf)/1000;
      const el = document.getElementById("recLiveTime");
      if(el) el.textContent = "Запись: " + fmtTimeSec(live);
      recClockRaf = requestAnimationFrame(tick);
    };
    recClockRaf = requestAnimationFrame(tick);
  }

  /* ===========================
     STOP helpers for modal close
     =========================== */
  function stopAnyRecordingSafely(){
    try{
      if(mediaRecorder && isRecording){
        safeStopRecorder();
      }
    }catch{}
  }

  function stopSmartPlayback(){
    try{
      if(activeSource){
        try{ activeSource.stop(0); }catch{}
      }
    }catch{}
    activeSource = null;
    activePlayingItemId = null;
    if(rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // Export for existing calls in index.html
  window.stopAnyRecordingSafely = stopAnyRecordingSafely;
  window.stopRecClock = stopRecClock;
  window.stopSmartPlayback = stopSmartPlayback;

  /* ===========================
     AUDIO: RECORDING
     =========================== */
  async function ensureMic(){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      alert("Запись аудио не поддерживается в этом браузере.");
      return null;
    }
    try{
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }catch(e){
      alert("Нет доступа к микрофону.");
      return null;
    }
  }

  function pickBestMime(){
    try{
      if(typeof hasMediaRecorder === "function" && hasMediaRecorder()){
        const prefer = [];
        if(typeof isIOS === "function" && isIOS()){
          prefer.push("audio/mp4");
          prefer.push("audio/mp4;codecs=mp4a.40.2");
        }
        prefer.push("audio/webm;codecs=opus");
        prefer.push("audio/webm");
        prefer.push("audio/ogg;codecs=opus");
        for(const m of prefer){
          if(MediaRecorder.isTypeSupported(m)) return m;
        }
      }
    }catch{}
    return "";
  }

  async function appendAudioSegmentFromBlob(pId, itemId, blob, fileName){
    const p = getPuchokLocal(pId);
    const it = getItemLocal(pId, itemId);
    if(!p || !it || it.type !== "audio") return;

    if(!blob || !blob.size){
      await renderAudioViewer(it, pId);
      return;
    }

    const segKey = `blob:${it.id}:seg:${uid()}`;
    await idbPutBlob(segKey, blob);

    it.segments = it.segments || [];
    it.segments.push({
      key: segKey,
      mime: blob.type || "application/octet-stream",
      size: blob.size || 0,
      createdAt: nowISO(),
      name: fileName || null
    });

    it.updatedAt = nowISO();
    p.updatedAt = nowISO();
    saveDBLocal();

    delete audioCache[it.id];

    await renderAudioViewer(it, pId);
    render();
  }

  async function startRecordingToAudioItem(pId, itemId){
    const it = getItemLocal(pId, itemId);
    const p = getPuchokLocal(pId);
    if(!it || !p || it.type !== "audio") return;

    if(isRecording){
      stopAnyRecordingSafely();
      return;
    }

    if(window.AUDIO_MODE === "mediarecorder"){
      const stream = await ensureMic();
      if(!stream) return;

      const mime = pickBestMime();
      recChunks = [];
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      isRecording = true;
      currentAudioAppendTarget = { pId, itemId };

      mediaRecorder.ondataavailable = (ev) => {
        if(ev.data && ev.data.size > 0) recChunks.push(ev.data);
      };

      mediaRecorder.onstop = async () => {
        isRecording = false;
        stopRecClock();
        try{ stream.getTracks().forEach(t=>t.stop()); }catch{}

        const target = currentAudioAppendTarget;
        currentAudioAppendTarget = null;

        const chunks = recChunks;
        recChunks = [];

        if(!target) return;
        const blob = new Blob(chunks, { type: (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : "application/octet-stream" });
        await appendAudioSegmentFromBlob(target.pId, target.itemId, blob, null);
      };

      // iOS лучше без timeslice
      if(typeof isIOS === "function" && isIOS()){
        mediaRecorder.start();
      }else{
        mediaRecorder.start(1000);
      }

      const baseSec = Number(it.durationSec || (audioCache[it.id]?.duration) || 0);
      startRecClock(it.id, baseSec);

      renderAudioViewer(it, pId);
      return;
    }

    // capture fallback
    pendingAudioTarget = { pId, itemId };
    if(window.audioPicker){
      audioPicker.value = "";
      audioPicker.click();
    }else{
      alert("Audio picker не найден.");
    }
  }

  async function createAudioItemAndRecord(){
    // ensure current puchok exists
    const p = getPuchokLocal(currentPuchokId);
    if(!p){
      alert("Сначала открой пучок — тогда можно добавлять туда элементы.");
      return;
    }

    const id = uid();
    const it = {
      id,
      type: "audio",
      title: `Аудио ${new Date().toLocaleDateString()}`,
      segments: [],
      durationSec: 0,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    p.items.push(it);
    p.updatedAt = nowISO();
    saveDBLocal();
    render();

    // openItem defined in index.html global scope
    if(typeof openItem === "function"){
      await openItem(p.id, it.id);
    }
    await startRecordingToAudioItem(p.id, it.id);
  }

  // Export for existing calls
  window.startRecordingToAudioItem = startRecordingToAudioItem;
  window.createAudioItemAndRecord = createAudioItemAndRecord;

  /* ===========================
     AUDIO: SMART PLAYER (WebAudio)
     =========================== */
  function getAudioSig(it){
    const segs = it.segments || [];
    return segs.map(s => `${s.key}:${s.size || 0}:${s.mime || ""}`).join("|");
  }

  async function ensureAudioContext(){
    if(typeof canUseWebAudio !== "function" || !canUseWebAudio()) return null;
    if(!audioCtx){
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if(audioCtx.state === "suspended"){
      try{ await audioCtx.resume(); }catch{}
    }
    return audioCtx;
  }

  async function decodeBlobToAudioBuffer(ctx, blob){
    const ab = await blob.arrayBuffer();
    return await ctx.decodeAudioData(ab.slice(0));
  }

  function concatAudioBuffers(ctx, buffers){
    if(!buffers || buffers.length === 0) return null;
    const channels = Math.max(...buffers.map(b => b.numberOfChannels));
    const sampleRate = buffers[0].sampleRate;
    const totalLength = buffers.reduce((sum,b)=> sum + b.length, 0);

    const out = ctx.createBuffer(channels, totalLength, sampleRate);
    for(let ch=0; ch<channels; ch++){
      const outData = out.getChannelData(ch);
      let offset = 0;
      for(const b of buffers){
        const src = b.getChannelData(Math.min(ch, b.numberOfChannels-1));
        outData.set(src, offset);
        offset += b.length;
      }
    }
    return out;
  }

  function audioBufferToWavBlob(buffer){
    const numCh = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;

    const interleaved = new Float32Array(numFrames * numCh);
    for(let i=0; i<numFrames; i++){
      for(let ch=0; ch<numCh; ch++){
        interleaved[i*numCh + ch] = buffer.getChannelData(ch)[i];
      }
    }

    const pcm16 = new Int16Array(interleaved.length);
    for(let i=0;i<interleaved.length;i++){
      let s = Math.max(-1, Math.min(1, interleaved[i]));
      pcm16[i] = s < 0 ? (s * 0x8000) : (s * 0x7FFF);
    }

    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcm16.length * bytesPerSample;

    const bufferSize = 44 + dataSize;
    const ab = new ArrayBuffer(bufferSize);
    const view = new DataView(ab);

    function writeStr(off, str){
      for(let i=0;i<str.length;i++) view.setUint8(off+i, str.charCodeAt(i));
    }

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for(let i=0;i<pcm16.length;i++, offset+=2){
      view.setInt16(offset, pcm16[i], true);
    }

    return new Blob([ab], { type: "audio/wav" });
  }

  async function getMergedAudioForItem(it){
    if(!it || it.type !== "audio") return null;
    const sig = getAudioSig(it);
    const cached = audioCache[it.id];
    if(cached && cached.sig === sig && cached.buffer){
      return cached;
    }

    const ctx = await ensureAudioContext();
    if(!ctx) return null;

    const segs = it.segments || [];
    if(segs.length === 0){
      audioCache[it.id] = { sig, buffer: null, duration: 0, wavBlob: null };
      return audioCache[it.id];
    }

    const blobs = [];
    for(const s of segs){
      const b = await idbGetBlob(s.key);
      if(b) blobs.push(b);
    }
    if(blobs.length === 0){
      audioCache[it.id] = { sig, buffer: null, duration: 0, wavBlob: null };
      return audioCache[it.id];
    }

    const decoded = [];
    for(const b of blobs){
      try{
        const buf = await decodeBlobToAudioBuffer(ctx, b);
        decoded.push(buf);
      }catch{}
    }
    if(decoded.length === 0){
      audioCache[it.id] = { sig, buffer: null, duration: 0, wavBlob: null };
      return audioCache[it.id];
    }

    const merged = concatAudioBuffers(ctx, decoded);
    const duration = merged ? merged.duration : decoded.reduce((s,b)=> s + b.duration, 0);

    audioCache[it.id] = { sig, buffer: merged, duration, wavBlob: null };
    return audioCache[it.id];
  }

  function startPlayback(itemId, buffer, offsetSec){
    if(!audioCtx || !buffer) return;

    stopSmartPlayback();

    activePlayingItemId = itemId;
    currentOffset = clamp(offsetSec || 0, 0, buffer.duration);

    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);

    playStartCtxTime = audioCtx.currentTime;
    playStartOffset = currentOffset;

    activeSource = src;

    src.onended = () => {
      if(activePlayingItemId === itemId){
        currentOffset = buffer.duration;
        stopSmartPlayback();
        const p = getPuchokLocal(currentPuchokId);
        const it = p ? (p.items||[]).find(x=>x.id===itemId) : null;
        if(it && it.type==="audio") renderAudioViewer(it, currentPuchokId);
      }
    };

    try{
      src.start(0, currentOffset);
    }catch(e){
      stopSmartPlayback();
      return;
    }

    tickUI(itemId, buffer);
  }

  function pausePlayback(){
    if(!audioCtx || !activeSource) return;
    const elapsed = audioCtx.currentTime - playStartCtxTime;
    currentOffset = Math.min((playStartOffset + elapsed), Number.MAX_SAFE_INTEGER);
    stopSmartPlayback();
  }

  function isPlayingItem(itemId){
    return !!activeSource && activePlayingItemId === itemId;
  }

  function getCurrentPlayTime(buffer){
    if(!audioCtx || !buffer) return currentOffset || 0;
    if(activeSource && activePlayingItemId){
      const elapsed = audioCtx.currentTime - playStartCtxTime;
      return clamp(playStartOffset + elapsed, 0, buffer.duration);
    }
    return currentOffset || 0;
  }

  function tickUI(itemId, buffer){
    if(rafId) cancelAnimationFrame(rafId);
    const slider = document.getElementById("smartSlider");
    const timeEl = document.getElementById("smartTime");
    const playBtn = document.getElementById("btnPlayPause");

    const step = () => {
      if(!isPlayingItem(itemId)){
        rafId = null;
        return;
      }
      const t = getCurrentPlayTime(buffer);
      if(slider){
        slider.value = String(t);
        setRangeFill(slider);
      }
      if(timeEl){
        timeEl.textContent = `${fmtTimeSec(t)} / ${fmtTimeSec(buffer.duration)}`;
      }
      rafId = requestAnimationFrame(step);
    };

    if(playBtn) playBtn.textContent = "⏸";
    if(timeEl){
      const t = getCurrentPlayTime(buffer);
      timeEl.textContent = `${fmtTimeSec(t)} / ${fmtTimeSec(buffer.duration)}`;
    }
    if(slider) setRangeFill(slider);
    rafId = requestAnimationFrame(step);
  }

  /* ===========================
     AUDIO VIEWER (smart)
     =========================== */
  async function renderAudioViewer(it, pId){
    if(!it || it.type !== "audio") return;

    const segs = it.segments || [];
    const totalBytes = segs.reduce((s,x)=> s + (x.size || 0), 0);

    const canSmart = (typeof canUseWebAudio === "function") ? canUseWebAudio() : false;
    const mergedInfo = canSmart ? await getMergedAudioForItem(it) : null;
    const duration = (mergedInfo && mergedInfo.duration) ? mergedInfo.duration : 0;

    // persist duration in metadata
    if(typeof duration === "number" && duration >= 0){
      const p = getPuchokLocal(pId);
      const ref = getItemLocal(pId, it.id);
      if(p && ref){
        ref.durationSec = duration;
        p.updatedAt = nowISO();
        ref.updatedAt = nowISO();
        saveDBLocal();
      }
    }

    if(activePlayingItemId !== it.id){
      currentOffset = 0;
    }else{
      currentOffset = clamp(currentOffset, 0, duration || 0);
    }

    const isRecThis = isRecording && currentAudioAppendTarget && currentAudioAppendTarget.itemId === it.id;
    const playing = isPlayingItem(it.id);

    const recLabel = (window.AUDIO_MODE === "mediarecorder")
      ? (isRecThis ? "Стоп запись" : (segs.length ? "Дозаписать" : "Записать"))
      : (segs.length ? "Дозаписать" : "Записать");

    const modeTxt = (window.AUDIO_MODE === "mediarecorder")
      ? "Запись: MediaRecorder (браузер)."
      : "Запись: системная (capture), если браузер не поддерживает MediaRecorder.";
    if(window.modalHint){
      modalHint.textContent = `${modeTxt} Воспроизведение/таймлайн: умный плеер. Скачивание: WAV (одним файлом).`;
    }

    const smartBlock = canSmart
      ? `
        <div class="audioBar">
          <div class="audioTop">
            <div class="audioBtns">
              <button class="audioBtn audioBtnPrimary" id="btnPlayPause" ${(duration>0 && !isRecThis) ? "" : "disabled"}>${playing ? "⏸" : "▶︎"}</button>
              <button class="audioBtn" id="btnStop" ${(duration>0 && !isRecThis) ? "" : "disabled"}>⏹</button>
            </div>
            <div class="audioTime" id="smartTime">${fmtTimeSec(getCurrentPlayTime(mergedInfo && mergedInfo.buffer ? mergedInfo.buffer : {duration:duration}))} / ${fmtTimeSec(duration)}</div>
          </div>

          <div class="audioSliderWrap">
            <input class="audioSlider" id="smartSlider" type="range" min="0" max="${duration || 0}" step="0.01" value="${Math.min(currentOffset || 0, duration || 0)}" ${(duration>0 && !isRecThis) ? "" : "disabled"} />
          </div>

          <div class="hint" style="margin-top:10px;">
            Умный плеер: один таймлайн, перемотка работает по всему аудио. Скачивание: один файл.
          </div>
        </div>
      `
      : `<div class="empty">Этот браузер не поддерживает WebAudio. Воспроизведение “умным” таймлайном недоступно.</div>`;

    modalViewer.innerHTML = `
      <div class="fileRow">
        <div class="fileMeta">
          <div class="fileName">${escapeHTML(it.title || "Аудио")}</div>
          <div class="fileSub">Сегментов: ${segs.length} • ${fmtBytes(totalBytes)} • ${duration ? ("Длина: " + fmtTimeSec(duration)) : "Длина: —"}</div>
        </div>
        <div class="tagText tagAudio">Аудио</div>
      </div>

      ${smartBlock}

      <div class="viewerActions" style="margin-top:12px;">
        <button class="btnOk" id="btnRec">${recLabel}</button>
        <button class="btnGhost" id="btnDownloadWav" ${(duration>0 && !isRecThis) ? "" : "disabled"}>Скачать</button>
      </div>

      <div class="recLine">
        <div>
          ${isRecThis ? `<div class="recBadge"><span class="dot"></span>Запись…</div>` : ""}
          ${(!(typeof hasMediaRecorder === "function" && hasMediaRecorder()) ? `<div class="hint">Запись идёт через системный диктофон (capture), потому что MediaRecorder недоступен.</div>` : "")}
        </div>
        <div class="recTimePill" id="recLiveTime">${isRecThis ? ("Запись: " + fmtTimeSec((it.durationSec||0))) : "Запись: —"}</div>
      </div>
    `;

    const btnRec = document.getElementById("btnRec");
    if(btnRec){
      btnRec.onclick = async () => {
        if(window.AUDIO_MODE === "mediarecorder"){
          if(isRecThis) stopAnyRecordingSafely();
          else await startRecordingToAudioItem(pId, it.id);
        }else{
          pendingAudioTarget = { pId, itemId: it.id };
          if(window.audioPicker){
            audioPicker.value = "";
            audioPicker.click();
          }
        }
      };
    }

    const playPauseBtn = document.getElementById("btnPlayPause");
    const stopBtn = document.getElementById("btnStop");
    const slider = document.getElementById("smartSlider");

    if(slider){
      setRangeFill(slider);
      slider.addEventListener("input", () => setRangeFill(slider));
    }

    if(canSmart && mergedInfo && mergedInfo.buffer && !isRecThis){
      await ensureAudioContext();

      if(slider){
        slider.addEventListener("input", () => {
          const v = Number(slider.value || 0);
          currentOffset = v;
          const timeEl = document.getElementById("smartTime");
          if(timeEl){
            timeEl.textContent = `${fmtTimeSec(v)} / ${fmtTimeSec(mergedInfo.buffer.duration)}`;
          }
        });

        slider.addEventListener("change", async () => {
          const v = Number(slider.value || 0);
          currentOffset = v;
          if(isPlayingItem(it.id)){
            await ensureAudioContext();
            startPlayback(it.id, mergedInfo.buffer, currentOffset);
          }
        });
      }

      if(playPauseBtn){
        playPauseBtn.onclick = async () => {
          await ensureAudioContext();
          if(isPlayingItem(it.id)){
            pausePlayback();
            playPauseBtn.textContent = "▶︎";
            const timeEl = document.getElementById("smartTime");
            if(timeEl){
              timeEl.textContent = `${fmtTimeSec(currentOffset)} / ${fmtTimeSec(mergedInfo.buffer.duration)}`;
            }
            return;
          }
          startPlayback(it.id, mergedInfo.buffer, currentOffset || 0);
          playPauseBtn.textContent = "⏸";
        };
      }

      if(stopBtn){
        stopBtn.onclick = () => {
          pausePlayback();
          currentOffset = 0;
          if(slider){ slider.value = "0"; setRangeFill(slider); }
          const timeEl = document.getElementById("smartTime");
          if(timeEl){
            timeEl.textContent = `${fmtTimeSec(0)} / ${fmtTimeSec(mergedInfo.buffer.duration)}`;
          }
          if(playPauseBtn) playPauseBtn.textContent = "▶︎";
        };
      }
    }else{
      if(playPauseBtn) playPauseBtn.disabled = true;
      if(stopBtn) stopBtn.disabled = true;
      if(slider) slider.disabled = true;
    }

    const btnWav = document.getElementById("btnDownloadWav");
    if(btnWav){
      btnWav.onclick = async () => {
        const info = await getMergedAudioForItem(it);
        if(!info || !info.buffer){
          alert("Не удалось собрать аудио для скачивания.");
          return;
        }
        if(!info.wavBlob){
          info.wavBlob = audioBufferToWavBlob(info.buffer);
          audioCache[it.id] = info;
        }
        const url = URL.createObjectURL(info.wavBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = (it.title || "audio") + ".wav";
        a.click();
        setTimeout(()=> URL.revokeObjectURL(url), 1000);
      };
    }

    if(isRecThis){
      const baseSec = Number(it.durationSec || (audioCache[it.id]?.duration) || 0);
      startRecClock(it.id, baseSec);
    }else{
      const recEl = document.getElementById("recLiveTime");
      if(recEl) recEl.textContent = "Запись: —";
    }
  }

  // Export for existing calls
  window.renderAudioViewer = renderAudioViewer;

  /* ===========================
     Init: attach audioPicker handler + set AUDIO_MODE
     =========================== */
  function initAudio(){
    try{
      if(typeof chooseAudioMode === "function"){
        window.AUDIO_MODE = chooseAudioMode();
      }else{
        window.AUDIO_MODE = (typeof hasMediaRecorder === "function" && hasMediaRecorder()) ? "mediarecorder" : "capture";
      }
    }catch{
      window.AUDIO_MODE = "capture";
    }

    // Attach picker handler here (moved out from index.html)
    if(window.audioPicker){
      audioPicker.addEventListener("change", async ()=>{
        const f = audioPicker.files && audioPicker.files[0];
        if(!f || !pendingAudioTarget) return;

        const target = pendingAudioTarget;
        pendingAudioTarget = null;

        await appendAudioSegmentFromBlob(target.pId, target.itemId, f, f.name || "audio");
      });
    }
  }

  // run init after DOM ready (safe)
  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", initAudio);
  }else{
    initAudio();
  }
})();
