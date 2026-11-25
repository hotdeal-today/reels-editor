// panels/audio.js — 탭3: 음성 · BGM · 효과음
import { $, $$, clamp, emit, uid, round, escapeHtml, isAudioFile } from '../util.js';
import { state, persist, mixDirty, totalDuration, getAsset } from '../state.js';
import { SFX_DEFS, previewSfx, sfxDuration, sfxName } from '../audio.js';
import { importAudioFile } from '../media.js';
import { forgetAsset, isAssetUsed } from '../assets.js';
import { seek } from '../player.js';

let pane = null;
let customListEl = null;
let trackListEl = null;
let narCard = null;
let bgmCard = null;
let sfxPicker = null;
let recState = { rec: null, stream: null, timer: null, startedAt: 0 };

export function initAudioPanel(el) {
  pane = el;
  pane.innerHTML = `
    <div class="sec">
      <div class="sec-head">내장 효과음 <span class="count">8종 · Web Audio 직접 합성</span></div>
      <div class="sec-note" style="margin-bottom:7px">▶ 로 미리 듣고 <b style="color:#ffc78a">+ 현재 위치</b>로 타임라인에 넣습니다.</div>
      <div class="sfx-grid" id="builtinSfx"></div>
    </div>

    <div class="sec">
      <div class="sec-head">내 효과음 <span class="count" id="customCount"></span><span class="grow"></span>
        <button class="btn tiny" id="addSfxBtn" type="button">+ 내 효과음 추가</button>
      </div>
      <input id="sfxPicker" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac" hidden>
      <div class="sfx-grid" id="customSfx"></div>
      <div class="sec-note" style="margin-top:6px">mp3 · wav · m4a · aac 파일을 올리면 이 브라우저에 저장됩니다.</div>
    </div>

    <div class="sec">
      <div class="sec-head">나레이션 (내 목소리)</div>
      <div class="card" id="narCard"></div>
    </div>

    <div class="sec">
      <div class="sec-head">BGM (배경음악)</div>
      <div class="card" id="bgmCard"></div>
    </div>

    <div class="sec">
      <div class="sec-head">타임라인에 넣은 효과음 <span class="count" id="sfxCount"></span></div>
      <div class="sfx-track-list" id="sfxTrackList"></div>
      <div class="sec-note" style="margin-top:6px">타임라인의 주황색 블록을 끌어 0.05초 단위로 옮길 수 있습니다.</div>
    </div>
  `;

  customListEl = $('#customSfx', pane);
  trackListEl = $('#sfxTrackList', pane);
  narCard = $('#narCard', pane);
  bgmCard = $('#bgmCard', pane);
  sfxPicker = $('#sfxPicker', pane);

  $('#builtinSfx', pane).innerHTML = SFX_DEFS.map((d) => `
    <div class="sfx-item" data-key="${d.id}">
      <button class="sfx-play" data-preview="${d.id}" type="button" title="미리듣기">▶</button>
      <div class="sfx-info"><b>${d.name}</b><small>${d.desc}</small></div>
      <span class="sfx-dur">${d.dur.toFixed(2)}초</span>
      <button class="btn tiny sfx-add" data-add="${d.id}" type="button">+ 현재 위치</button>
    </div>`).join('');

  pane.addEventListener('click', onClick);
  pane.addEventListener('input', onInput);
  pane.addEventListener('change', onChange);

  $('#addSfxBtn', pane).addEventListener('click', () => sfxPicker.click());
  sfxPicker.addEventListener('change', async () => {
    const f = sfxPicker.files && sfxPicker.files[0];
    sfxPicker.value = '';
    if (!f) return;
    await addCustomSfx(f);
  });

  renderCustomSfx();
  renderNarration();
  renderBgm();
  renderSfxTracks();
}

function onAdded() {
  mixDirty();
  emit('project', { panels: ['audio'], select: false });
  persist();
}

function insertSfx(key) {
  const p = state.project;
  const t = round(clamp(state.time, 0, Math.max(0, totalDuration())), 2);
  const item = { id: uid('sfx'), key, t, volume: 100 };
  p.audio.sfx.push(item);
  p.audio.sfx.sort((a, b) => a.t - b.t);
  state.sel.sfx = item.id;
  onAdded();
  renderSfxTracks();
  emit('toast', { msg: `${sfxName(key)} 효과음을 ${t.toFixed(2)}초에 넣었습니다.`, type: 'ok' });
}

async function addCustomSfx(file) {
  try {
    const asset = await importAudioFile(file);
    const p = state.project;
    p.audio.customSfx = p.audio.customSfx || [];
    if (!p.audio.customSfx.includes(asset.id)) p.audio.customSfx.push(asset.id);
    onAdded();
    renderCustomSfx();
    emit('toast', { msg: `${file.name} 효과음을 추가했습니다.`, type: 'ok' });
  } catch (e) {
    emit('toast', { msg: '효과음을 추가하지 못했습니다: ' + (e.message || e), type: 'err' });
  }
}

function renderCustomSfx() {
  const ids = (state.project.audio.customSfx || []).filter((id) => getAsset(id));
  $('#customCount', pane).textContent = ids.length ? `${ids.length}개` : '';
  if (!ids.length) {
    customListEl.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:4px 2px">아직 올린 효과음이 없습니다.</div>`;
    return;
  }
  customListEl.innerHTML = ids.map((id) => {
    const a = getAsset(id);
    return `<div class="sfx-item">
      <button class="sfx-play" data-preview="${id}" type="button">▶</button>
      <div class="sfx-info"><b>${escapeHtml(a.name)}</b><small>내 효과음</small></div>
      <span class="sfx-dur">${sfxDuration(id).toFixed(2)}초</span>
      <button class="btn tiny sfx-add" data-add="${id}" type="button">+ 현재 위치</button>
      <button class="icon-btn sm" data-delsfx="${id}" type="button" title="목록에서 삭제">✕</button>
    </div>`;
  }).join('');
}

function renderNarration() {
  const n = state.project.audio.narration;
  const recording = !!recState.rec;
  narCard.innerHTML = `
    <div class="audio-file">
      <span class="name ${n ? '' : 'empty'}">${n ? escapeHtml(n.name) : '녹음하거나 파일을 올려주세요'}</span>
      ${n ? `<button class="icon-btn sm" data-act="delNar" type="button" title="삭제">✕</button>` : ''}
    </div>
    <div class="row" style="margin:0">
      <button class="btn sm ${recording ? 'danger' : ''}" data-act="rec" type="button">
        ${recording ? '<span class="rec-dot recording"></span> 녹음 중지' : '● 마이크 녹음'}
      </button>
      <button class="btn sm ghost" data-act="pickNar" type="button">파일 올리기</button>
      <span class="grow"></span>
      <span class="val" data-rec-time>${recording ? '0.0초' : ''}</span>
    </div>
    ${n ? `
      <div class="row">
        <label>시작 시간</label>
        <input type="range" class="grow" data-audio="narration.start" min="0" max="${Math.max(1, totalDuration()).toFixed(1)}" step="0.1" value="${(n.start || 0).toFixed(1)}">
        <span class="val" data-nval="start">${(n.start || 0).toFixed(1)}초</span>
      </div>
      <div class="row">
        <label>볼륨</label>
        <input type="range" class="grow" data-audio="narration.volume" min="0" max="150" step="5" value="${n.volume ?? 100}">
        <span class="val" data-nval="volume">${n.volume ?? 100}%</span>
      </div>
      <div class="sec-note" style="margin:0">길이 ${(n.duration || 0).toFixed(1)}초 · 시작점부터 재생됩니다.</div>
    ` : ''}
  `;
}

function renderBgm() {
  const b = state.project.audio.bgm;
  bgmCard.innerHTML = `
    <div class="audio-file">
      <span class="name ${b ? '' : 'empty'}">${b ? escapeHtml(b.name) : 'BGM 파일을 올려주세요 (.mp3/.wav/.m4a)'}</span>
      ${b ? `<button class="icon-btn sm" data-act="delBgm" type="button" title="삭제">✕</button>` : ''}
      <button class="btn sm ghost" data-act="pickBgm" type="button">${b ? '교체' : '파일 올리기'}</button>
    </div>
    ${b ? `
      <div class="row">
        <label>볼륨</label>
        <input type="range" class="grow" data-audio="bgm.volume" min="0" max="150" step="5" value="${b.volume ?? 40}">
        <span class="val" data-bval="volume">${b.volume ?? 40}%</span>
      </div>
      <div class="row">
        <label>페이드 인</label>
        <input type="range" class="grow" data-audio="bgm.fadeIn" min="0" max="5" step="0.1" value="${b.fadeIn ?? 1}">
        <span class="val" data-bval="fadeIn">${(b.fadeIn ?? 1).toFixed(1)}초</span>
      </div>
      <div class="row">
        <label>페이드 아웃</label>
        <input type="range" class="grow" data-audio="bgm.fadeOut" min="0" max="5" step="0.1" value="${b.fadeOut ?? 1}">
        <span class="val" data-bval="fadeOut">${(b.fadeOut ?? 1).toFixed(1)}초</span>
      </div>
      <div class="sec-note" style="margin:0">영상 길이만큼 반복 재생됩니다.</div>
    ` : ''}
  `;
}

function renderSfxTracks() {
  const items = state.project.audio.sfx || [];
  $('#sfxCount', pane).textContent = items.length ? `${items.length}개` : '';
  if (!items.length) {
    trackListEl.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:4px 2px">아직 넣은 효과음이 없습니다. 위에서 [+ 현재 위치]를 눌러보세요.</div>`;
    return;
  }
  trackListEl.innerHTML = items.map((it) => `
    <div class="sfx-track-item${state.sel.sfx === it.id ? ' sel' : ''}" data-id="${it.id}" style="${state.sel.sfx === it.id ? 'border-color:rgba(255,216,77,.5)' : ''}">
      <span class="t">${it.t.toFixed(2)}초</span>
      <span class="n">${escapeHtml(sfxName(it.key))}</span>
      <input type="range" data-sfxvol="${it.id}" min="0" max="150" step="5" value="${it.volume ?? 100}">
      <span class="v" data-vol="${it.id}">${it.volume ?? 100}%</span>
      <button class="icon-btn sm" data-deltrack="${it.id}" type="button" title="삭제">✕</button>
    </div>`).join('');
}

// ── 이벤트 ────────────────────────────────────────────
async function onClick(e) {
  const prev = e.target.closest('[data-preview]');
  if (prev) {
    const key = prev.dataset.preview;
    const item = (state.project.audio.sfx || []).find((s) => s.key === key);
    await previewSfx(key, item ? Math.min(1.5, (item.volume ?? 100) / 100) : 1);
    return;
  }
  const add = e.target.closest('[data-add]');
  if (add) { insertSfx(add.dataset.add); return; }

  const delSfx = e.target.closest('[data-delsfx]');
  if (delSfx) {
    const id = delSfx.dataset.delsfx;
    const p = state.project;
    p.audio.customSfx = (p.audio.customSfx || []).filter((x) => x !== id);
    p.audio.sfx = (p.audio.sfx || []).filter((s) => s.key !== id);
    if (!isAssetUsed(id)) forgetAsset(id);
    onAdded();
    renderCustomSfx();
    renderSfxTracks();
    emit('timeline');
    return;
  }

  const delTrack = e.target.closest('[data-deltrack]');
  if (delTrack) {
    const id = delTrack.dataset.deltrack;
    state.project.audio.sfx = state.project.audio.sfx.filter((s) => s.id !== id);
    if (state.sel.sfx === id) state.sel.sfx = null;
    onAdded();
    renderSfxTracks();
    emit('timeline');
    return;
  }

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'rec') { await toggleRecord(); }
  else if (act === 'pickNar') {
    pickAudio(async (asset) => {
      state.project.audio.narration = { assetId: asset.id, name: asset.name, start: round(state.time, 1), volume: 100, duration: asset.duration || 0 };
      onAdded(); renderNarration(); renderSfxTracks(); emit('timeline');
    });
  } else if (act === 'delNar') {
    const n = state.project.audio.narration;
    state.project.audio.narration = null;
    if (n && !isAssetUsed(n.assetId)) forgetAsset(n.assetId);
    onAdded(); renderNarration(); emit('timeline');
  } else if (act === 'pickBgm') {
    pickAudio(async (asset) => {
      state.project.audio.bgm = { assetId: asset.id, name: asset.name, volume: 40, fadeIn: 1, fadeOut: 1, start: 0, duration: asset.duration || 0 };
      onAdded(); renderBgm(); emit('timeline');
    }, true);
  } else if (act === 'delBgm') {
    const b = state.project.audio.bgm;
    state.project.audio.bgm = null;
    if (b && !isAssetUsed(b.assetId)) forgetAsset(b.assetId);
    onAdded(); renderBgm(); emit('timeline');
  }
}

function pickAudio(cb, big = false) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.mp3,.wav,.m4a,.aac';
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (!isAudioFile(f)) { emit('toast', { msg: '오디오 파일만 올릴 수 있습니다.', type: 'err' }); return; }
    try {
      const asset = await importAudioFile(f);
      await cb(asset);
      emit('toast', { msg: '오디오를 추가했습니다.', type: 'ok' });
    } catch (err) {
      emit('toast', { msg: '오디오를 읽지 못했습니다: ' + (err.message || err), type: 'err' });
    }
  });
  input.click();
}

async function toggleRecord() {
  if (recState.rec) {
    const rec = recState.rec;
    recState.rec = null;
    clearInterval(recState.timer);
    const stopped = new Promise((res) => { rec.onstop = res; });
    try { rec.stop(); } catch (e) {}
    await stopped;
    const chunks = recState.chunks || [];
    recState.stream?.getTracks().forEach((t) => t.stop());
    recState.stream = null;
    renderNarration();
    if (!chunks.length) { emit('toast', { msg: '녹음된 소리가 없습니다.', type: 'err' }); return; }
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    const ext = (rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
    const file = new File([blob], `나레이션 녹음.${ext}`, { type: blob.type });
    try {
      const asset = await importAudioFile(file);
      state.project.audio.narration = { assetId: asset.id, name: '나레이션 녹음', start: round(Math.max(0, state.time - (asset.duration || 0)), 1), volume: 100, duration: asset.duration || 0 };
      onAdded(); renderNarration(); renderSfxTracks(); emit('timeline');
      emit('toast', { msg: `녹음 완료 (${(asset.duration || 0).toFixed(1)}초)`, type: 'ok' });
    } catch (e) {
      emit('toast', { msg: '녹음을 저장하지 못했습니다: ' + (e.message || e), type: 'err' });
    }
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recState = { rec, stream, chunks: [], startedAt: performance.now(), timer: null };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) recState.chunks.push(e.data); };
    rec.start(200);
    recState.timer = setInterval(() => {
      const el = narCard.querySelector('[data-rec-time]');
      if (el) el.textContent = `${((performance.now() - recState.startedAt) / 1000).toFixed(1)}초`;
    }, 100);
    renderNarration();
  } catch (e) {
    emit('toast', { msg: '마이크를 사용할 수 없습니다. 파일로 올려주세요.', type: 'err' });
  }
}

function onInput(e) {
  const sfxVol = e.target.dataset.sfxvol;
  if (sfxVol) {
    const item = state.project.audio.sfx.find((s) => s.id === sfxVol);
    if (!item) return;
    item.volume = Number(e.target.value);
    const label = trackListEl.querySelector(`[data-vol="${sfxVol}"]`);
    if (label) label.textContent = `${item.volume}%`;
    mixDirty();
    emit('save');
    return;
  }
  const path = e.target.dataset.audio;
  if (!path) return;
  const [which, field] = path.split('.');
  const target = state.project.audio[which];
  if (!target) return;
  const v = Number(e.target.value);
  target[field] = v;
  const label = narCard.querySelector(`[data-nval="${field}"]`) || bgmCard.querySelector(`[data-bval="${field}"]`);
  if (label) label.textContent = field === 'start' || field === 'fadeIn' || field === 'fadeOut' ? `${v.toFixed(1)}초` : `${Math.round(v)}%`;
  mixDirty();
  emit('save');
}

function onChange(e) {
  if (e.target.dataset.audio) {
    mixDirty();
    emit('timeline');
  }
}

/** 타임라인에서 효과음 블록을 선택하면 목록을 갱신합니다. */
export function selectSfx(id) {
  state.sel.sfx = id;
  renderSfxTracks();
}

export function refreshAudioPanel() {
  renderCustomSfx();
  renderNarration();
  renderBgm();
  renderSfxTracks();
}
