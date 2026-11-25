// panels/clips.js — 탭1: 컷 편집
import { $, $$, clamp, emit, fmtSec, escapeHtml } from '../util.js';
import { state, getAsset, clipDur, totalDuration, persist, ensureSegments, mixDirty, mosaicOf } from '../state.js';
import { importMediaFile } from '../media.js';
import { seek, requestRender } from '../player.js';
import { forgetAsset, isAssetUsed } from '../assets.js';
import { setMosaicGuide, getMosaicGuide } from '../render.js';
import { ensureSubtitleBeats } from '../ai.js';

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
      <div class="sec-head">✂️ 목표 총 길이 <span class="count">자동 컷 맞추기</span></div>
      <div class="seg-btns" id="fitTargets">
        <button type="button" data-fit="15">15초</button>
        <button type="button" data-fit="18">18초</button>
        <button type="button" data-fit="20">20초</button>
      </div>
      <div class="row" style="margin-top:6px">
        <label>직접 입력</label>
        <input type="number" class="grow" id="fitCustom" min="2" max="180" step="0.5" placeholder="초" style="padding:4px 8px">
        <span class="val">초</span>
      </div>
      <button class="btn primary block" id="fitCuts" type="button" style="margin-top:6px">⚡ 자동 컷 맞추기</button>
      <div class="sec-note" style="margin:6px 0 0">
        영상은 너무 앞부분만 잘리지 않게 <b>앞~중간(35%) 지점</b>부터, 사진은 고르게 나누어 총 길이를 목표 초수에 딱 맞춥니다.
        마음에 안 들면 아래 클립별 <b>시작 지점·표시 길이</b>로 직접 조절하세요.
      </div>
    </div>

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
      <div class="sec-head">▦ 자막 가림 <span class="count">희뿌연 블러 · 모자이크</span></div>
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
  const fitBox = $('#fitTargets', pane);
  fitBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fit]');
    if (!b) return;
    fitBox.querySelectorAll('[data-fit]').forEach((x) => x.classList.toggle('on', x === b));
    const custom = $('#fitCustom', pane);
    if (custom) custom.value = b.dataset.fit;
    runAutoFit(Number(b.dataset.fit));
  });
  $('#fitCuts', pane).addEventListener('click', () => {
    const custom = Number($('#fitCustom', pane).value);
    const on = fitBox.querySelector('[data-fit].on');
    const target = custom > 0 ? custom : (on ? Number(on.dataset.fit) : 18);
    runAutoFit(target);
  });
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
    box.innerHTML = `<div class="card" style="color:var(--muted);font-size:11px">클립을 선택하면 자막 가림 설정이 나타납니다.</div>`;
    return;
  }
  const m = mosaicTarget === 'clip' && clip.mosaic ? { ...mosaicOf(clip) } : mosaicOf(null);
  const isClip = mosaicTarget === 'clip';
  const idx = state.project.clips.indexOf(clip);
  const val = (k, unit) => `<span class="val" data-moval="${k}">${m[k] ?? 0}${unit}</span>`;

  box.innerHTML = `
    <div class="card">
      <div class="row" style="gap:8px">
        <label class="switch"><input type="checkbox" data-mos="on" ${m.on ? 'checked' : ''}> 자막 가리기 켜기</label>
        <span class="grow"></span>
        <label class="switch" title="미리보기에 영역을 점선으로 표시"><input type="checkbox" data-mos-guide ${getMosaicGuide() ? 'checked' : ''}> 가이드</label>
      </div>
      <div class="seg-btns" data-mostarget style="margin-bottom:8px">
        <button type="button" data-mt="global" class="${isClip ? '' : 'on'}">전체 기본값</button>
        <button type="button" data-mt="clip" class="${isClip ? 'on' : ''}">${idx + 1}번 클립만</button>
      </div>
      <div class="row">
        <label>가로 위치</label>
        <input type="range" class="grow" data-mos="x" min="0" max="100" step="1" value="${m.x != null ? m.x : 50}">
        ${val('x', '%')}
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
        <label>모자이크 조각</label>
        <input type="range" class="grow" data-mos="strength" min="0" max="60" step="1" value="${m.strength}">
        ${val('strength', 'px')}
      </div>
      <div class="row">
        <label>희뿌연 블러</label>
        <input type="range" class="grow" data-mos="blur" min="0" max="40" step="1" value="${m.blur}">
        ${val('blur', 'px')}
      </div>
      <div class="row" style="margin-top:2px;flex-wrap:wrap;gap:4px">
        <button class="btn tiny" data-mos-act="toAll" type="button">모든 클립에 이 설정</button>
        <button class="btn tiny ghost" data-mos-act="detach" type="button" ${isClip && clip.mosaic ? '' : 'disabled'}>이 클립 개별 설정 해제</button>
      </div>
      <div class="sec-note" style="margin:6px 0 0">
        <b>미리보기 캔버스에서 블러 박스를 마우스·손가락으로 직접 끌어 옮길 수 있습니다.</b> 끄는 동안 점선 박스와 가로·세로 위치가 보이고, 내보내기(MP4·캐러셀·썸네일)에는 들어가지 않습니다.
        위치는 화면 기준 중심값입니다(가로 50% = 가운데, 아래쪽 자막이면 세로 75~80%). 가장자리는 원본과 부드럽게 섞여 경계가 드러나지 않습니다.
        모자이크 조각은 0이면 끔(희뿌연 블러만), 4px부터 픽셀화가 더해집니다. 원문 글자가 큼직하면 블러를 20~30px로 올리세요. 가이드를 켜면 미리보기에 점선으로 보입니다.
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
  else target.mosaic[key] = clamp(v, 0, 100);
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
    emit('toast', { msg: '이 자막 가림 설정을 모든 클립에 적용했습니다.', type: 'ok' });
    return;
  }
  if (act === 'detach' && clip) {
    delete clip.mosaic;
    mosaicTarget = 'global';
    renderMosaic();
    persist();
    emit('project', { panels: [] });
    requestRender();
    emit('toast', { msg: '이 클립은 전체 자막 가림 설정을 따릅니다.' });
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

// ── 목표 총 길이로 자동 컷 맞추기 ─────────────────────
function videoCap(clip) {
  if (clip.kind === 'image') return 15;
  const src = Math.max(0.3, Number(clip.srcDuration) || (getAsset(clip.assetId) && getAsset(clip.assetId).duration) || clipDur(clip));
  return src / Math.max(0.25, Number(clip.speed) || 1);
}

/**
 * 목표 총 길이에 맞춰 각 클립의 시작 지점·표시 길이를 자동 배분합니다.
 * · 영상: 쓸 수 있는 길이 안에서 앞~중간(35%) 지점부터 잡아 너무 앞만 잘리지 않게
 * · 사진: 고르게 나눔 (너무 짧거나 길지 않게 0.6~15초)
 * · 짧은 영상이 배분보다 짧으면 자기 최대치만 쓰고, 남는 시간은 다른 클립에 재분배
 */
export function autoFitCuts(targetSec) {
  const p = state.project;
  const clips = p.clips || [];
  if (!clips.length) throw new Error('먼저 사진이나 영상을 추가하세요.');
  const target = clamp(Number(targetSec) || 18, 2, 180);
  const n = clips.length;
  const cap = clips.map(videoCap);
  const share = new Array(n).fill(0);
  const fixed = new Array(n).fill(false);
  let remaining = target;
  let open = n;
  for (let iter = 0; iter < n + 2; iter++) {
    const base = remaining / Math.max(1, open);
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      if (cap[i] < base - 1e-6) {
        share[i] = cap[i];
        fixed[i] = true;
        remaining -= cap[i];
        open -= 1;
        changed = true;
      }
    }
    if (!changed) {
      for (let i = 0; i < n; i++) if (!fixed[i]) share[i] = base;
      break;
    }
  }

  clips.forEach((c, i) => {
    const d = Math.max(0.3, share[i] || 0);
    if (c.kind === 'image') {
      c.duration = clamp(Math.round(d * 1000) / 1000, 0.3, 15);
      return;
    }
    const src = Math.max(0.3, Number(c.srcDuration) || (getAsset(c.assetId) && getAsset(c.assetId).duration) || clipDur(c));
    const speed = Math.max(0.25, Number(c.speed) || 1);
    const span = clamp(d * speed, 0.3, src);
    const room = Math.max(0, src - span);
    c.trimIn = Math.round(clamp(room * 0.35, 0, room) * 1000) / 1000;
    c.trimOut = Math.round(Math.min(src, c.trimIn + span) * 1000) / 1000;
  });

  // 총 길이 오차 보정 — 마지막으로 조절 가능한 클립에서 흡수해 목표에 딱 맞춤
  const totalNow = () => clips.reduce((a, c) => a + clipDur(c), 0);
  let diff = target - totalNow();
  for (let i = clips.length - 1; i >= 0 && Math.abs(diff) > 0.02; i--) {
    const c = clips[i];
    if (c.kind === 'image') {
      const cur = Number(c.duration) || 3;
      const nd = clamp(cur + diff, 0.3, 15);
      c.duration = Math.round(nd * 1000) / 1000;
      diff -= (c.duration - cur);
      continue;
    }
    const src = Math.max(0.3, Number(c.srcDuration) || clipDur(c));
    const speed = Math.max(0.25, Number(c.speed) || 1);
    const cur = clipDur(c);
    const nd = clamp(cur + diff, 0.3, src / speed);
    const span = nd * speed;
    c.trimIn = Math.round(clamp(Number(c.trimIn) || 0, 0, Math.max(0, src - span)) * 1000) / 1000;
    c.trimOut = Math.round(Math.min(src, c.trimIn + span) * 1000) / 1000;
    diff -= (clipDur(c) - cur);
  }

  ensureSegments();
  // 자막이 있으면 새 길이에 맞춰 2~3초 박자로 다시 채움(끝에서 멈추지 않게)
  if (state.project.segments.some((s) => String(s.subtitle || '').trim())) {
    const reflowed = ensureSubtitleBeats(state.project.segments, totalDuration());
    if (reflowed.length) state.project.segments = reflowed;
  }
  mixDirty();
  persist();
  emit('project', { panels: ['clips', 'text'], select: true });
  renderList(); renderDetail(); renderMosaic();
  const total = totalNow();
  emit('toast', { msg: `총 ${total.toFixed(1)}초로 맞췄습니다 (클립 ${clips.length}개 · 목표 ${target}초)`, type: 'ok' });
  return { total: Math.round(total * 10) / 10, target, clips: clips.length };
}

function runAutoFit(target) {
  try {
    autoFitCuts(target);
  } catch (e) {
    emit('toast', { msg: e.message || '자동 컷 맞추기에 실패했습니다.', type: 'err' });
  }
}

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
          <label>시작 지점</label>
          <button class="btn tiny ghost" data-step="trimIn:-0.1" type="button">−</button>
          <input type="range" class="grow" data-field="trimIn" min="0" max="${maxT}" step="0.1" value="${(clip.trimIn || 0).toFixed(1)}">
          <button class="btn tiny ghost" data-step="trimIn:0.1" type="button">＋</button>
          <span class="val" data-val="trimIn">${(clip.trimIn || 0).toFixed(1)}초</span>
        </div>
        <div class="row">
          <label>표시 길이</label>
          <button class="btn tiny ghost" data-step="duration:-0.1" type="button">−</button>
          <input type="range" class="grow" data-field="duration" min="0.3" max="${maxT}" step="0.1" value="${clipDur(clip).toFixed(1)}">
          <button class="btn tiny ghost" data-step="duration:0.1" type="button">＋</button>
          <span class="val" data-val="duration">${clipDur(clip).toFixed(1)}초</span>
        </div>
        <div class="row"><label>끝 지점</label><span class="grow" style="font-size:11px;color:var(--muted)"><b data-val="trimOut">${(clip.trimOut || maxT).toFixed(1)}초</b> / 원본 ${maxT.toFixed(1)}초</span></div>
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
  const clip = currentClip();
  if (field === 'zoom' || field === 'volume') { if (el) el.textContent = `${Math.round(v)}%`; return; }
  if (el && field === 'duration') el.textContent = `${clipDur(clip).toFixed(1)}초`;
  if (el && field === 'trimIn') el.textContent = `${(Number(clip && clip.trimIn) || 0).toFixed(1)}초`;
  if (el && field === 'trimOut') el.textContent = `${(Number(clip && clip.trimOut) || 0).toFixed(1)}초`;
  if (el && !['duration', 'trimIn', 'trimOut', 'zoom', 'volume'].includes(field)) el.textContent = `${v}`;
  // 한 칸을 바꾸면 다른 칸 숫자도 같이 맞춰 줌
  if (clip && ['duration', 'trimIn', 'trimOut'].includes(field)) {
    const d = detailEl.querySelector('[data-val="duration"]');
    if (d) d.textContent = `${clipDur(clip).toFixed(1)}초`;
    const i = detailEl.querySelector('[data-val="trimIn"]');
    if (i) i.textContent = `${(Number(clip.trimIn) || 0).toFixed(1)}초`;
    const o = detailEl.querySelector('[data-val="trimOut"]');
    if (o) o.textContent = `${(Number(clip.trimOut) || 0).toFixed(1)}초`;
  }
}

function applyField(clip, field, value) {
  if (field === 'trimIn') {
    const src = Math.max(0.3, Number(clip.srcDuration) || videoCap(clip));
    const speed = Math.max(0.25, Number(clip.speed) || 1);
    const span = clipDur(clip) * speed; // 화면에 보이는 길이는 그대로 두고 창만 옮깁니다
    clip.trimIn = clamp(Number(value), 0, Math.max(0, src - span));
    clip.trimOut = Math.min(src, clip.trimIn + span);
  } else if (field === 'trimOut') {
    clip.trimOut = clamp(Number(value), (clip.trimIn || 0) + 0.1, clip.srcDuration || Number(value));
  } else if (field === 'duration') {
    if (clip.kind === 'video') {
      const src = Math.max(0.3, Number(clip.srcDuration) || videoCap(clip));
      const speed = Math.max(0.25, Number(clip.speed) || 1);
      const span = clamp(Number(value) * speed, 0.3, src);
      clip.trimIn = clamp(Number(clip.trimIn) || 0, 0, Math.max(0, src - span));
      clip.trimOut = Math.min(src, clip.trimIn + span);
    } else {
      clip.duration = clamp(Number(value), 0.5, 15);
    }
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

/**
 * 미리보기에서 블러 박스를 끌어 옮길 때, 패널의 슬라이더·숫자를 같이 따라오게 합니다.
 * (패널을 통째로 다시 그리지 않아 드래그가 끊기지 않습니다)
 */
export function syncMosaicControls(values = {}) {
  if (!pane) return;
  const box = $('#mosaicBox', pane);
  if (!box) return;
  for (const key of ['x', 'y']) {
    if (values[key] == null) continue;
    const v = Math.round(Number(values[key]));
    const input = box.querySelector(`input[data-mos="${key}"]`);
    if (input) input.value = String(v);
    const label = box.querySelector(`[data-moval="${key}"]`);
    if (label) label.textContent = `${v}%`;
  }
}
