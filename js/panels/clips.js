// panels/clips.js — 탭1: 컷 편집
import { $, $$, clamp, emit, fmtSec, escapeHtml } from '../util.js';
import { state, getAsset, clipDur, totalDuration, persist, ensureSegments, mixDirty, mosaicOf } from '../state.js';
import { importMediaFile } from '../media.js';
import { seek, requestRender } from '../player.js';
import { forgetAsset, isAssetUsed } from '../assets.js';
import { setMosaicGuide, getMosaicGuide } from '../render.js';

let pane = null;
let listEl = null;
let detailEl = null;
let picker = null;
let replacePicker = null;
let replaceIndex = -1;
let mosaicTarget = 'global'; // 'global' | 'clip'

export function initClipsPanel(el) {
  pane = el;
  pane.innerHTML = `
    <div class="drop-zone" id="dropZone">
      <b>사진 · 영상 불러오기</b>
      여기로 끌어다 놓거나 클릭하세요<br>
      <span style="font-size:10px;color:#66707f">JPG · PNG · WEBP · MP4 · MOV · WEBM</span>
    </div>
    <input id="clipPicker" type="file" accept="image/*,video/*" multiple hidden>
    <input id="clipReplacePicker" type="file" accept="image/*,video/*" hidden>

    <div class="sec" style="margin-top:14px">
      <div class="sec-head">클립 <span class="count" id="clipCount">0개</span><span class="grow"></span>
        <button class="btn tiny" id="clipAddBtn" type="button">+ 추가</button>
      </div>
      <div class="clip-list" id="clipList"></div>
    </div>

    <div class="sec">
      <div class="sec-head">선택한 클립 설정</div>
      <div id="clipDetail"></div>
    </div>

    <div class="sec">
      <div class="sec-head">▦ 자막 모자이크 <span class="count">영상 속 기존 자막 가리기</span></div>
      <div id="mosaicBox"></div>
    </div>
  `;

  picker = $('#clipPicker', pane);
  replacePicker = $('#clipReplacePicker', pane);
  listEl = $('#clipList', pane);
  detailEl = $('#clipDetail', pane);

  $('#dropZone', pane).addEventListener('click', () => picker.click());
  $('#clipAddBtn', pane).addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const files = Array.from(picker.files || []);
    picker.value = '';
    if (files.length) await addMediaFiles(files);
  });
  replacePicker.addEventListener('change', async () => {
    const f = replacePicker.files && replacePicker.files[0];
    replacePicker.value = '';
    if (!f || replaceIndex < 0) return;
    await replaceClip(replaceIndex, f);
  });

  detailEl.addEventListener('input', onDetailInput);
  detailEl.addEventListener('change', onDetailInput);
  const mosaicBox = $('#mosaicBox', pane);
  mosaicBox.addEventListener('input', onMosaicInput);
  mosaicBox.addEventListener('change', onMosaicInput);
  mosaicBox.addEventListener('click', onMosaicClick);
  listEl.addEventListener('click', onListClick);
  listEl.addEventListener('dragstart', onDragStart);
  listEl.addEventListener('dragover', onDragOver);
  listEl.addEventListener('dragleave', onDragLeave);
  listEl.addEventListener('drop', onDrop);
  listEl.addEventListener('dragend', () => $$('.clip-item', listEl).forEach((n) => n.classList.remove('dragover-before', 'dragover-after')));

  renderList();
  renderDetail();
  renderMosaic();
}

// ── 자막 모자이크 ─────────────────────────────────────
function mosaicTargetObj(create) {
  const clip = currentClip();
  if (mosaicTarget === 'clip' && clip) {
    if (!clip.mosaic && create) clip.mosaic = { ...mosaicOf(clip) };
    return clip;
  }
  if (!state.project.mosaic) state.project.mosaic = { ...mosaicOf(null) };
  return state.project;
}

function renderMosaic() {
  const box = $('#mosaicBox', pane);
  if (!box) return;
  const clip = currentClip();
  if (!clip) {
    box.innerHTML = `<div class="card" style="color:var(--muted);font-size:11px">클립을 선택하면 모자이크 설정이 나타납니다.</div>`;
    return;
  }
  const m = mosaicTarget === 'clip' && clip.mosaic ? { ...mosaicOf(clip) } : mosaicOf(null);
  const isClip = mosaicTarget === 'clip';
  const idx = state.project.clips.indexOf(clip);
  const val = (k, unit) => `<span class="val" data-moval="${k}">${m[k] ?? 0}${unit}</span>`;

  box.innerHTML = `
    <div class="card">
      <div class="row" style="gap:8px">
        <label class="switch"><input type="checkbox" data-mos="on" ${m.on ? 'checked' : ''}> 모자이크 켜기</label>
        <span class="grow"></span>
        <label class="switch" title="미리보기에 영역을 점선으로 표시"><input type="checkbox" data-mos-guide ${getMosaicGuide() ? 'checked' : ''}> 가이드</label>
      </div>
      <div class="seg-btns" data-mostarget style="margin-bottom:8px">
        <button type="button" data-mt="global" class="${isClip ? '' : 'on'}">전체 기본값</button>
        <button type="button" data-mt="clip" class="${isClip ? 'on' : ''}">${idx + 1}번 클립만</button>
      </div>
      <div class="row">
        <label>세로 위치</label>
        <input type="range" class="grow" data-mos="y" min="0" max="100" step="1" value="${m.y}">
        ${val('y', '%')}
      </div>
      <div class="row">
        <label>높이</label>
        <input type="range" class="grow" data-mos="h" min="3" max="50" step="1" value="${m.h}">
        ${val('h', '%')}
      </div>
      <div class="row">
        <label>너비</label>
        <input type="range" class="grow" data-mos="w" min="10" max="100" step="1" value="${m.w}">
        ${val('w', '%')}
      </div>
      <div class="row">
        <label>모자이크 크기</label>
        <input type="range" class="grow" data-mos="strength" min="6" max="60" step="1" value="${m.strength}">
        ${val('strength', 'px')}
      </div>
      <div class="row">
        <label>살짝 블러</label>
        <input type="range" class="grow" data-mos="blur" min="0" max="10" step="1" value="${m.blur}">
        ${val('blur', 'px')}
      </div>
      <div class="row" style="margin-top:2px;flex-wrap:wrap;gap:4px">
        <button class="btn tiny" data-mos-act="toAll" type="button">모든 클립에 이 설정</button>
        <button class="btn tiny ghost" data-mos-act="detach" type="button" ${isClip && clip.mosaic ? '' : 'disabled'}>이 클립 개별 설정 해제</button>
      </div>
      <div class="sec-note" style="margin:6px 0 0">
        세로 위치는 화면 높이 기준 중심값입니다(아래쪽 자막이면 70~80%). 가이드를 켜면 미리보기에 점선으로 보입니다.
        ${isClip ? '지금은 선택한 클립에만 적용됩니다.' : '지금은 모든 클립의 기본값을 바꾸고 있습니다.'}
      </div>
    </div>`;
}

function onMosaicInput(e) {
  const t = e.target;
  if (t.dataset.mosGuide != null) {
    setMosaicGuide(t.checked);
    requestRender();
    return;
  }
  const key = t.dataset.mos;
  if (!key) return;
  const target = mosaicTargetObj(true);
  const v = key === 'on' ? t.checked : Number(t.value);
  if (key === 'on') target.mosaic.on = v;
  else target.mosaic[key] = clamp(v, 0, 200);
  const label = pane.querySelector(`[data-moval="${key}"]`);
  if (label) label.textContent = `${target.mosaic[key]}${key === 'strength' || key === 'blur' ? 'px' : '%'}`;
  mixDirty();
  persist();
  emit('project', { panels: [] });
  requestRender();
}

function onMosaicClick(e) {
  const mt = e.target.closest('[data-mt]');
  if (mt) {
    mosaicTarget = mt.dataset.mt;
    const clip = currentClip();
    if (mosaicTarget === 'clip' && clip && !clip.mosaic) {
      clip.mosaic = { ...mosaicOf(clip) };
      persist();
      emit('project', { panels: [] });
    }
    renderMosaic();
    requestRender();
    return;
  }
  const act = e.target.closest('[data-mos-act]')?.dataset.mosAct;
  if (!act) return;
  const clip = currentClip();
  if (act === 'toAll' && clip) {
    const m = { ...mosaicOf(clip) };
    state.project.mosaic = { ...m };
    for (const c of state.project.clips) { if (c.mosaic) delete c.mosaic; }
    mosaicTarget = 'global';
    renderMosaic();
    mixDirty();
    persist();
    emit('project', { panels: [] });
    requestRender();
    emit('toast', { msg: '이 모자이크 설정을 모든 클립에 적용했습니다.', type: 'ok' });
    return;
  }
  if (act === 'detach' && clip) {
    delete clip.mosaic;
    mosaicTarget = 'global';
    renderMosaic();
    persist();
    emit('project', { panels: [] });
    requestRender();
    emit('toast', { msg: '이 클립은 전체 모자이크 설정을 따릅니다.' });
  }
}

export async function addMediaFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  emit('toast', { msg: `${list.length}개 파일을 불러오는 중…` });
  const added = [];
  for (const f of list) {
    try {
      const { clip } = await importMediaFile(f);
      state.project.clips.push(clip);
      added.push(clip);
    } catch (e) {
      console.warn(e);
      emit('toast', { msg: `${f.name}: ${e.message || '불러오지 못했습니다'}`, type: 'err' });
    }
  }
  if (added.length) {
    ensureSegments();
    const p = state.project;
    state.sel.clip = p.clips.length - added.length;
    mixDirty();
    emit('project', { panels: ['clips', 'text'], select: true });
    emit('toast', { msg: `${added.length}개 클립을 추가했습니다.`, type: 'ok' });
    seek(0);
  } else {
    emit('project', { panels: ['clips'], select: true });
  }
}

async function replaceClip(index, file) {
  const clip = state.project.clips[index];
  if (!clip) return;
  try {
    const { asset, clip: fresh } = await importMediaFile(file);
    const oldId = clip.assetId;
    clip.assetId = fresh.assetId;
    clip.kind = fresh.kind;
    clip.name = fresh.name;
    clip.srcDuration = fresh.srcDuration;
    clip.trimIn = 0;
    clip.trimOut = fresh.trimOut;
    if (fresh.kind === 'image') { clip.duration = 3; clip.muted = true; }
    if (oldId !== clip.assetId && !isAssetUsed(oldId)) forgetAsset(oldId);
    mixDirty();
    emit('project', { panels: ['clips', 'text'], select: true });
    emit('toast', { msg: '클립을 교체했습니다.', type: 'ok' });
  } catch (e) {
    emit('toast', { msg: e.message || '교체하지 못했습니다.', type: 'err' });
  }
}

function currentClip() { return state.project.clips[state.sel.clip] || null; }

export function renderList() {
  if (!listEl) return;
  const p = state.project;
  $('#clipCount', pane).textContent = `${p.clips.length}개`;
  if (!p.clips.length) {
    listEl.innerHTML = `<div style="color:var(--muted);font-size:11px;padding:8px 2px">아직 클립이 없습니다. 위에서 사진·영상을 불러오세요.</div>`;
    return;
  }
  listEl.innerHTML = p.clips.map((c, i) => {
    const asset = getAsset(c.assetId);
    const thumb = asset && asset.thumb ? asset.thumb : '';
    const kindLabel = c.kind === 'video' ? '영상' : '사진';
    const speedTxt = c.kind === 'video' && c.speed !== 1 ? ` · ${c.speed}x` : '';
    const motion = { none: '', zoomIn: ' · 줌인', zoomOut: ' · 줌아웃', panLR: ' · 패닝', panRL: ' · 패닝↔' }[c.motion] || '';
    return `<div class="clip-item${state.sel.clip === i ? ' sel' : ''}" data-index="${i}" draggable="true">
      <span class="clip-idx">${i + 1}</span>
      <div class="clip-thumb">${thumb ? `<img src="${thumb}" alt="">` : ''}<span class="kind">${kindLabel}</span></div>
      <div class="clip-meta">
        <b>${escapeHtml(c.name || '')}</b>
        <small>${fmtSec(clipDur(c))}${speedTxt}${motion}</small>
      </div>
      <div class="clip-acts">
        <button data-act="up" title="위로">↑</button>
        <button data-act="down" title="아래로">↓</button>
        <button data-act="dup" title="복제">⧉</button>
        <button data-act="replace" title="교체">⟳</button>
        <button data-act="del" class="del" title="삭제">✕</button>
      </div>
    </div>`;
  }).join('');
}

function rowSlider(label, field, value, min, max, step, unit, extra = '') {
  return `<div class="row">
    <label>${label}</label>
    <input type="range" class="grow" data-field="${field}" min="${min}" max="${max}" step="${step}" value="${value}">
    <span class="val" data-val="${field}">${value}${unit}</span>${extra}
  </div>`;
}

export function renderDetail() {
  if (!detailEl) return;
  const clip = currentClip();
  if (!clip) {
    detailEl.innerHTML = `<div class="card" style="color:var(--muted);font-size:11px">클립을 선택하면 세부 설정이 나타납니다.</div>`;
    return;
  }
  const asset = getAsset(clip.assetId);
  const isVideo = clip.kind === 'video';
  const maxT = isVideo ? Math.max(0.2, clip.srcDuration || (asset && asset.duration) || 1) : 0;
  const speedBtns = [0.5, 0.75, 1, 1.25, 1.5, 2].map((s) =>
    `<button type="button" data-speed="${s}" class="${Number(clip.speed) === s ? 'on' : ''}">${s}x</button>`).join('');

  detailEl.innerHTML = `
    <div class="card">
      <div class="row">
        <label>파일</label>
        <span class="grow" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(clip.name || '')}</span>
        <button class="btn tiny" data-act="replace" type="button">교체</button>
      </div>
      ${isVideo ? `
        <div class="row">
          <label>시작 (in)</label>
          <button class="btn tiny ghost" data-step="trimIn:-0.1" type="button">−</button>
          <input type="range" class="grow" data-field="trimIn" min="0" max="${maxT}" step="0.1" value="${(clip.trimIn || 0).toFixed(1)}">
          <button class="btn tiny ghost" data-step="trimIn:0.1" type="button">＋</button>
          <span class="val" data-val="trimIn">${(clip.trimIn || 0).toFixed(1)}초</span>
        </div>
        <div class="row">
          <label>끝 (out)</label>
          <button class="btn tiny ghost" data-step="trimOut:-0.1" type="button">−</button>
          <input type="range" class="grow" data-field="trimOut" min="0" max="${maxT}" step="0.1" value="${(clip.trimOut || maxT).toFixed(1)}">
          <button class="btn tiny ghost" data-step="trimOut:0.1" type="button">＋</button>
          <span class="val" data-val="trimOut">${(clip.trimOut || maxT).toFixed(1)}초</span>
        </div>
        <div class="row"><label>재생 속도</label><div class="seg-btns grow" id="speedBtns">${speedBtns}</div></div>
        <div class="row">
          <label>원본 음성</label>
          <input type="range" class="grow" data-field="volume" min="0" max="100" step="5" value="${clip.volume ?? 100}" ${clip.muted ? 'disabled' : ''}>
          <span class="val" data-val="volume">${clip.volume ?? 100}%</span>
          <button class="btn tiny ${clip.muted ? 'danger' : 'ghost'}" data-act="mute" type="button">${clip.muted ? '음소거됨' : '음소거'}</button>
        </div>
      ` : `
        <div class="row">
          <label>표시 길이</label>
          <input type="range" class="grow" data-field="duration" min="0.5" max="15" step="0.1" value="${clip.duration || 3}">
          <span class="val" data-val="duration">${(clip.duration || 3).toFixed(1)}초</span>
        </div>
      `}
      <div class="row">
        <label>모션 효과</label>
        <select class="grow" data-field="motion">
          ${[['none', '없음'], ['zoomIn', '부드러운 줌인'], ['zoomOut', '줌아웃'], ['panLR', '좌→우 패닝'], ['panRL', '우→좌 패닝']]
            .map(([v, l]) => `<option value="${v}"${clip.motion === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <label>컷 전환</label>
        <select class="grow" data-field="transition">
          <option value="cut"${clip.transition === 'cut' ? ' selected' : ''}>컷 (바로 전환)</option>
          <option value="fade"${clip.transition === 'fade' ? ' selected' : ''}>페이드 (0.45초)</option>
        </select>
      </div>
      <div class="row">
        <label>화면 맞춤</label>
        <select class="grow" data-field="fit">
          <option value="fill"${clip.fit === 'fill' ? ' selected' : ''}>꽉 채우기 (Fill)</option>
          <option value="fit"${clip.fit === 'fit' ? ' selected' : ''}>전체 맞춤 (Fit)</option>
        </select>
      </div>
      ${rowSlider('확대', 'zoom', clip.zoom ?? 100, 100, 250, 1, '%')}
      <div class="row">
        <label>위치</label>
        <span style="font-size:10.5px;color:var(--muted)">X</span>
        <input type="number" data-field="offsetX" value="${clip.offsetX || 0}" min="-50" max="50" step="1" style="width:56px">
        <span style="font-size:10.5px;color:var(--muted)">Y</span>
        <input type="number" data-field="offsetY" value="${clip.offsetY || 0}" min="-50" max="50" step="1" style="width:56px">
        <span class="val">%</span>
      </div>
      <div class="sec-head" style="margin:10px 0 6px">기본 색감</div>
      ${rowSlider('밝기', 'brightness', clip.adjust?.brightness || 0, -50, 50, 1, '')}
      ${rowSlider('대비', 'contrast', clip.adjust?.contrast || 0, -50, 50, 1, '')}
      ${rowSlider('채도', 'saturate', clip.adjust?.saturate || 0, -50, 50, 1, '')}
      <div class="row" style="margin-top:2px">
        <span class="grow"></span>
        <button class="btn tiny ghost" data-act="resetAdjust" type="button">색감 초기화</button>
      </div>
    </div>
  `;
}

function onDetailInput(e) {
  const clip = currentClip();
  if (!clip) return;
  const field = e.target.dataset.field;
  if (!field) return;
  let v = e.target.value;
  if (e.target.type === 'range' || e.target.type === 'number') v = Number(v);
  applyField(clip, field, v);
  updateValLabel(field, v);
  afterEdit();
}

function updateValLabel(field, v) {
  const el = detailEl.querySelector(`[data-val="${field}"]`);
  if (!el) return;
  const unit = ['trimIn', 'trimOut', 'duration'].includes(field) ? '초' : (['volume', 'zoom'].includes(field) ? (field === 'zoom' ? '%' : '%') : '');
  if (field === 'duration' || field === 'trimIn' || field === 'trimOut') el.textContent = `${Number(v).toFixed(1)}초`;
  else if (field === 'volume' || field === 'zoom') el.textContent = `${Math.round(v)}%`;
  else el.textContent = `${v}`;
}

function applyField(clip, field, value) {
  if (field === 'trimIn') {
    clip.trimIn = clamp(Number(value), 0, (clip.trimOut || 1) - 0.1);
  } else if (field === 'trimOut') {
    clip.trimOut = clamp(Number(value), (clip.trimIn || 0) + 0.1, clip.srcDuration || Number(value));
  } else if (field === 'duration') {
    clip.duration = clamp(Number(value), 0.5, 15);
  } else if (field === 'volume') {
    clip.volume = clamp(Number(value), 0, 100);
  } else if (field === 'zoom') {
    clip.zoom = clamp(Number(value), 100, 250);
  } else if (field === 'offsetX') {
    clip.offsetX = clamp(Number(value), -50, 50);
  } else if (field === 'offsetY') {
    clip.offsetY = clamp(Number(value), -50, 50);
  } else if (['brightness', 'contrast', 'saturate'].includes(field)) {
    clip.adjust = clip.adjust || { brightness: 0, contrast: 0, saturate: 0 };
    clip.adjust[field] = clamp(Number(value), -50, 50);
  } else if (field === 'motion' || field === 'transition' || field === 'fit') {
    clip[field] = value;
  }
}

function afterEdit() {
  mixDirty();
  emit('project', { panels: [], select: false });
  persist();
}

function onListClick(e) {
  const item = e.target.closest('.clip-item');
  if (!item) return;
  const i = Number(item.dataset.index);
  const act = e.target.closest('button')?.dataset.act;
  const clips = state.project.clips;
  if (!act) {
    state.sel.clip = i;
    emit('select:clip', i);
    seek(clipStartSafe(i));
    renderList(); renderDetail(); renderMosaic();
    return;
  }
  if (act === 'up' && i > 0) {
    [clips[i - 1], clips[i]] = [clips[i], clips[i - 1]];
    state.sel.clip = i - 1;
  } else if (act === 'down' && i < clips.length - 1) {
    [clips[i + 1], clips[i]] = [clips[i], clips[i + 1]];
    state.sel.clip = i + 1;
  } else if (act === 'dup') {
    const copy = JSON.parse(JSON.stringify(clips[i]));
    copy.id = 'clip_' + Math.random().toString(36).slice(2, 9);
    clips.splice(i + 1, 0, copy);
    state.sel.clip = i + 1;
  } else if (act === 'replace') {
    replaceIndex = i;
    replacePicker.click();
    return;
  } else if (act === 'del') {
    const [removed] = clips.splice(i, 1);
    if (removed && !isAssetUsed(removed.assetId)) forgetAsset(removed.assetId);
    state.sel.clip = clamp(i, 0, Math.max(0, clips.length - 1));
  }
  mixDirty();
  ensureSegments();
  emit('project', { panels: ['clips', 'text'], select: true });
  renderList(); renderDetail(); renderMosaic();
}

// 세부 카드 내부 버튼 (속도/음소거/교체/초기화/미세조정)
document.addEventListener('click', (e) => {
  if (!detailEl || !detailEl.contains(e.target)) return;
  const speedBtn = e.target.closest('[data-speed]');
  if (speedBtn) {
    const clip = currentClip();
    if (clip) { clip.speed = Number(speedBtn.dataset.speed); afterEdit(); renderDetail(); }
    return;
  }
  const stepBtn = e.target.closest('[data-step]');
  if (stepBtn) {
    const [field, delta] = stepBtn.dataset.step.split(':');
    const clip = currentClip();
    if (!clip) return;
    applyField(clip, field, Number(clip[field] || 0) + Number(delta));
    afterEdit();
    renderDetail();
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const clip = currentClip();
  if (!clip) return;
  if (act === 'mute') { clip.muted = !clip.muted; afterEdit(); renderDetail(); }
  else if (act === 'replace') { replaceIndex = state.sel.clip; replacePicker.click(); }
  else if (act === 'resetAdjust') { clip.adjust = { brightness: 0, contrast: 0, saturate: 0 }; clip.zoom = 100; clip.offsetX = 0; clip.offsetY = 0; afterEdit(); renderDetail(); }
});

function clipStartSafe(i) {
  let s = 0;
  const clips = state.project.clips;
  for (let k = 0; k < i && k < clips.length; k++) s += clipDur(clips[k]);
  return s;
}

// 드래그로 순서 이동
let dragFrom = null;
function onDragStart(e) {
  const item = e.target.closest('.clip-item');
  if (!item) return;
  dragFrom = Number(item.dataset.index);
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(dragFrom)); } catch (err) {}
}
function onDragOver(e) {
  const item = e.target.closest('.clip-item');
  if (!item || dragFrom == null) return;
  e.preventDefault();
  const r = item.getBoundingClientRect();
  const after = e.clientY > r.top + r.height / 2;
  $$('.clip-item', listEl).forEach((n) => n.classList.remove('dragover-before', 'dragover-after'));
  item.classList.add(after ? 'dragover-after' : 'dragover-before');
}
function onDragLeave(e) {
  const item = e.target.closest('.clip-item');
  if (item) item.classList.remove('dragover-before', 'dragover-after');
}
function onDrop(e) {
  e.preventDefault();
  const item = e.target.closest('.clip-item');
  if (!item || dragFrom == null) return;
  const to = Number(item.dataset.index) + (item.classList.contains('dragover-after') ? 1 : 0);
  const clips = state.project.clips;
  const [moved] = clips.splice(dragFrom, 1);
  clips.splice(to > dragFrom ? to - 1 : to, 0, moved);
  dragFrom = null;
  mixDirty();
  ensureSegments();
  emit('project', { panels: ['clips', 'text'], select: true });
  renderList(); renderDetail(); renderMosaic();
}

export function refreshClips() { renderList(); renderDetail(); renderMosaic(); }
export function setSelectedClip(i) {
  state.sel.clip = i;
  renderList(); renderDetail(); renderMosaic();
}
