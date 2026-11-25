// timeline.js — 하단 멀티트랙 타임라인
import { $, clamp, emit, fmtSec } from './util.js';
import { state, clipDur, clipStart, totalDuration, getAsset } from './state.js';
import { sfxDuration, sfxName } from './audio.js';
import { seek } from './player.js';

const TRACKS = ['clips', 'title', 'badge', 'subtitle', 'narration', 'bgm', 'sfx'];
let root = null;
let contentEl = null;
let playheadEl = null;
let pps = 40;

function trackEl(name) { return contentEl.querySelector(`.tl-track[data-track="${name}"]`); }

export function initTimeline() {
  root = $('#timeline');
  if (!root) return;
  root.innerHTML = `
    <div class="tl-top">
      <b>타임라인</b>
      <span id="tlInfo">클립 0개 · 0.0초</span>
      <span class="grow"></span>
      <div class="tl-zoom"><span>배율</span><input id="tlZoom" type="range" min="0.6" max="3" step="0.1" value="1"></div>
      <button class="btn tiny ghost" id="tlFit" type="button">맞춤</button>
    </div>
    <div class="tl-grid">
      <div class="tl-labels">
        <div class="corner"></div>
        <div class="tl-label t-clips">클립</div>
        <div class="tl-label t-title">제목</div>
        <div class="tl-label t-badge">배지</div>
        <div class="tl-label t-sub">자막</div>
        <div class="tl-label t-audio">나레이션</div>
        <div class="tl-label t-bgm">BGM</div>
        <div class="tl-label t-sfx">효과음</div>
      </div>
      <div class="tl-scroll" id="tlScroll">
        <div class="tl-content" id="tlContent">
          <div class="tl-ruler" id="tlRuler"></div>
          ${TRACKS.map((t) => `<div class="tl-track" data-track="${t}"></div>`).join('')}
          <div class="playhead" id="playhead" style="left:0px"></div>
        </div>
      </div>
    </div>`;

  contentEl = $('#tlContent');
  playheadEl = $('#playhead');

  const zoomRange = $('#tlZoom');
  zoomRange.value = String(state.zoom || 1);
  zoomRange.addEventListener('input', () => { state.zoom = Number(zoomRange.value); renderTimeline(); });
  $('#tlFit').addEventListener('click', () => { state.zoom = 1; zoomRange.value = '1'; renderTimeline(); });

  contentEl.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('resize', () => renderTimeline());

  renderTimeline();
}

function layoutWidth() {
  const scroll = $('#tlScroll');
  const dur = totalDuration();
  const avail = Math.max(120, (scroll ? scroll.clientWidth : 600) - 2);
  const zoom = state.zoom || 1;
  const fitted = dur > 0 ? avail / dur : avail;
  pps = clamp(fitted * zoom, 6, 400);
  return Math.max(avail, dur * pps);
}

export function renderTimeline() {
  if (!contentEl) return;
  const w = layoutWidth();
  const dur = totalDuration();
  contentEl.style.width = `${Math.round(w)}px`;

  const p = state.project;
  const scroll = $('#tlScroll');
  const scrollLeft = scroll ? scroll.scrollLeft : 0;

  // 눈금
  const ruler = $('#tlRuler');
  const stepCandidates = [0.5, 1, 2, 5, 10, 30];
  const step = stepCandidates.find((s) => s * pps >= 46) || 60;
  let html = '';
  for (let t = 0; t <= dur + 0.001; t += step) {
    const x = t * pps;
    const major = Math.abs(t % (step * 2)) < 1e-6;
    html += `<div class="tick${major ? ' major' : ''}" style="left:${x}px"></div>`;
    if (major) html += `<div class="tick-label" style="left:${x}px">${formatTick(t)}</div>`;
  }
  ruler.innerHTML = html;

  // 클립 트랙
  const clipsTrack = trackEl('clips');
  if (!p || !p.clips.length) {
    clipsTrack.innerHTML = `<div class="tl-empty">클립을 추가하면 여기에 표시됩니다</div>`;
  } else {
    clipsTrack.innerHTML = p.clips.map((c, i) => {
      const left = clipStart(i) * pps;
      const w = Math.max(6, clipDur(c) * pps);
      const asset = getAsset(c.assetId);
      const thumb = asset && asset.thumb ? `<img src="${asset.thumb}" alt="">` : '';
      const nm = w > 54 ? `<span class="nm">${escapeName(c.name || '')}</span>` : '';
      return `<div class="tl-block clip${state.sel.clip === i ? ' sel' : ''}" data-clip="${i}" style="left:${left}px;width:${w}px">${thumb}${nm}</div>`;
    }).join('');
  }

  // 글자 트랙
  const keys = [['title', 'title'], ['badge', 'badge'], ['subtitle', 'subtitle']];
  for (const [key, track] of keys) {
    const el = trackEl(track);
    const segs = (p ? p.segments : []).filter((s) => (s[key] || '').trim());
    el.innerHTML = segs.map((s) => {
      const left = s.start * pps;
      const w = Math.max(6, (s.end - s.start) * pps);
      const sel = state.sel.segment === s.id ? ' sel' : '';
      return `<div class="tl-block seg-${key}${sel}" data-seg="${s.id}" data-key="${key}" style="left:${left}px;width:${w}px"><span class="lbl">${escapeName(s[key])}</span></div>`;
    }).join('');
  }

  // 나레이션
  const nTrack = trackEl('narration');
  const nar = p && p.audio.narration;
  if (nar) {
    nTrack.innerHTML = `<div class="tl-block audio" data-audio="narration" style="left:${(nar.start || 0) * pps}px;width:${Math.max(6, (nar.duration || 2) * pps)}px"><span class="lbl">${escapeName(nar.name || '나레이션')}</span></div>`;
  } else nTrack.innerHTML = '';

  // BGM
  const bTrack = trackEl('bgm');
  const bgm = p && p.audio.bgm;
  if (bgm && dur > 0) {
    bTrack.innerHTML = `<div class="tl-block bgm" data-audio="bgm" style="left:0px;width:${Math.max(6, dur * pps)}px"><span class="lbl">${escapeName(bgm.name || 'BGM')}</span></div>`;
  } else bTrack.innerHTML = '';

  // 효과음
  const sTrack = trackEl('sfx');
  const items = (p && p.audio.sfx) || [];
  sTrack.innerHTML = items.map((it) => {
    const left = it.t * pps;
    const w = Math.max(12, sfxDuration(it.key) * pps);
    return `<div class="tl-block sfx${state.sel.sfx === it.id ? ' sel' : ''}" data-sfx="${it.id}" style="left:${left}px;width:${w}px"><span class="lbl">${escapeName(sfxName(it.key))}</span></div>`;
  }).join('');

  const info = $('#tlInfo');
  if (info) info.textContent = `클립 ${p ? p.clips.length : 0}개 · ${dur.toFixed(1)}초`;

  setPlayhead(state.time);
  if (scroll) scroll.scrollLeft = scrollLeft;
}

export function setPlayhead(t) {
  if (!playheadEl) return;
  playheadEl.style.left = `${(t || 0) * pps}px`;
}

function formatTick(t) {
  if (t < 60) return `${t % 1 === 0 ? t.toFixed(0) : t.toFixed(1)}s`;
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeName(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function xToTime(clientX) {
  const rect = contentEl.getBoundingClientRect();
  return clamp((clientX - rect.left) / pps, 0, totalDuration());
}

let scrubbing = false;
let sfxDrag = null;

function onPointerDown(e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const sfxBlock = e.target.closest('[data-sfx]');
  const clipBlock = e.target.closest('[data-clip]');
  const segBlock = e.target.closest('[data-seg]');
  const audioBlock = e.target.closest('[data-audio]');

  if (sfxBlock) {
    const id = sfxBlock.dataset.sfx;
    const item = state.project.audio.sfx.find((s) => s.id === id);
    if (!item) return;
    state.sel.sfx = id;
    emit('select:sfx', id);
    const startX = e.clientX;
    const startT = item.t;
    let moved = false;
    sfxBlock.classList.add('drag');
    const move = (ev) => {
      const dt = (ev.clientX - startX) / pps;
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      item.t = Math.max(0, Math.round((startT + dt) * 20) / 20);
      sfxBlock.style.left = `${item.t * pps}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      sfxBlock.classList.remove('drag');
      if (moved) {
        state.mixDirty = true;
        renderTimeline();
        emit('change:audio');
        emit('save');
      } else {
        renderTimeline();
      }
      sfxDrag = null;
    };
    sfxDrag = id;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
    return;
  }

  if (clipBlock) {
    const i = Number(clipBlock.dataset.clip);
    state.sel.clip = i;
    emit('select:clip', i);
    seek(clipStart(i));
    renderTimeline();
    return;
  }
  if (segBlock) {
    const id = segBlock.dataset.seg;
    const key = segBlock.dataset.key;
    state.sel.segment = id;
    state.sel.text = key;
    emit('select:segment', id);
    emit('select:text', key);
    seek((state.project.segments.find((s) => s.id === id) || {}).start || 0);
    renderTimeline();
    return;
  }
  if (audioBlock) {
    const kind = audioBlock.dataset.audio;
    if (kind === 'narration') { emit('select:audio', 'narration'); seek(0); }
    else { emit('select:audio', 'bgm'); }
    return;
  }

  // 빈 곳 → 스크럽
  scrubbing = true;
  const t = xToTime(e.clientX);
  seek(t);
  contentEl.setPointerCapture(e.pointerId);
  e.preventDefault();
}

window.addEventListener('pointermove', (e) => {
  if (!scrubbing || !contentEl) return;
  seek(xToTime(e.clientX));
});
window.addEventListener('pointerup', () => { scrubbing = false; });
