// player.js — 미리보기 재생 엔진 (오디오 믹스 + 캔버스 + 비디오 동기화)
import { $, clamp, debounce, emit } from './util.js';
import { state, totalDuration, locate, clipDur } from './state.js';
import { renderFrame } from './render.js';
import { buildMix, audioCtx } from './audio.js';
import { videoFor, seekVideo, waitVideoReady, allVideoEls } from './media.js';

const canvas = $('#preview');
const ctx = canvas.getContext('2d', { alpha: false });

let mixBuffer = null;
let mixPromise = null;
let sourceNode = null;
let gainNode = null;
let startCtxTime = 0;
let startPerf = 0;
let startPos = 0;
let raf = null;
let lastSeekKey = '';
let starting = false;

export function invalidateMix() {
  state.mixDirty = true;
  mixBuffer = null;
}

export function getMix() { return mixBuffer; }

export async function ensureMix() {
  if (!state.mixDirty && mixBuffer) return mixBuffer;
  if (mixPromise) return mixPromise;
  state.mixDirty = false;
  mixPromise = buildMix(totalDuration())
    .then((b) => { mixBuffer = b; mixPromise = null; return b; })
    .catch((e) => { console.warn(e); mixPromise = null; return null; });
  return mixPromise;
}

function clockNow() {
  if (sourceNode) return startPos + (audioCtx().currentTime - startCtxTime);
  return startPos + (performance.now() - startPerf) / 1000;
}

function stopSource() {
  if (sourceNode) {
    try { sourceNode.onended = null; sourceNode.stop(); } catch (e) {}
    try { sourceNode.disconnect(); } catch (e) {}
    sourceNode = null;
  }
}

function syncVideos(t) {
  const p = state.project;
  if (!p) return;
  const loc = locate(t);
  const activeId = loc && loc.clip.kind === 'video' ? loc.clip.assetId : null;
  for (const [id, v] of allVideoEls()) {
    if (id !== activeId && !v.paused) { try { v.pause(); } catch (e) {} }
  }
  if (!activeId) return;
  const v = videoFor(activeId);
  if (!v) return;
  const want = clamp((loc.clip.trimIn || 0) + loc.local * (loc.clip.speed || 1), 0, Math.max(0, (v.duration || 1) - 0.03));
  if (v.readyState >= 2) {
    if (Math.abs(v.currentTime - want) > 0.25) { try { v.currentTime = want; } catch (e) {} }
    v.playbackRate = clamp(loc.clip.speed || 1, 0.25, 4);
    if (v.paused && state.playing) v.play().catch(() => {});
  }
}

function updateTimeUI(t) {
  const el = $('#timeNow');
  if (el) el.textContent = fmtClock(t);
  const totalEl = $('#timeTotal');
  if (totalEl) totalEl.textContent = fmtClock(totalDuration());
  const scrub = $('#scrub');
  if (scrub && document.activeElement !== scrub) {
    const dur = Math.max(0.001, totalDuration());
    scrub.value = String(Math.round((t / dur) * 1000));
  }
  emit('time', t);
}

function fmtClock(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

export function updatePlayButton() {
  const b = $('#btnPlay');
  if (!b) return;
  b.classList.toggle('playing', state.playing);
  b.setAttribute('aria-label', state.playing ? '일시정지' : '재생');
}

export async function play() {
  const dur = totalDuration();
  if (dur <= 0.01) { emit('need:media'); return; }
  if (state.playing || starting) return;
  starting = true;
  try { await startPlayback(dur); } finally { starting = false; }
}

async function startPlayback(dur) {
  if (state.time >= dur - 0.02) state.time = 0;
  const mix = await ensureMix();
  const ac = audioCtx();
  stopSource();
  const from = clamp(state.time, 0, Math.max(0, dur - 0.01));
  if (mix) {
    sourceNode = ac.createBufferSource();
    sourceNode.buffer = mix;
    gainNode = ac.createGain();
    gainNode.gain.value = state.muted ? 0 : 1;
    sourceNode.connect(gainNode);
    gainNode.connect(ac.destination);
    const when = ac.currentTime + 0.06;
    try { sourceNode.start(when, Math.min(from, Math.max(0, mix.duration - 0.01))); } catch (e) { console.warn(e); }
    startCtxTime = when;
  } else {
    startPerf = performance.now();
  }
  startPos = from;
  state.playing = true;
  updatePlayButton();
  emit('play', true);
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

export function pause() {
  state.playing = false;
  stopSource();
  cancelAnimationFrame(raf);
  raf = null;
  syncPauseMedia();
  updatePlayButton();
  emit('play', false);
  renderNow();
}

function syncPauseMedia() {
  const p = state.project;
  if (!p) return;
  for (const [id, v] of allVideoEls()) {
    if (!v.paused) { try { v.pause(); } catch (e) {} }
  }
}

function loop() {
  if (!state.playing) return;
  const dur = totalDuration();
  let t = clockNow();
  if (t >= dur) {
    state.time = dur;
    pause();
    seek(dur);
    return;
  }
  state.time = t;
  syncVideos(t);
  renderFrame(ctx, t);
  updateTimeUI(t);
  raf = requestAnimationFrame(loop);
}

export function togglePlay() {
  if (state.playing) pause(); else play();
}

/** 재생 위치 이동 — 재생 중이면 오디오도 그 지점부터 다시 시작합니다. */
export function seek(t) {
  const dur = totalDuration();
  const nt = clamp(t, 0, dur);
  state.time = nt;
  lastSeekKey = '';
  if (state.playing) {
    // 오디오 재시작
    const wasPlaying = state.playing;
    stopSource();
    state.playing = false;
    cancelAnimationFrame(raf);
    state.time = nt;
    if (wasPlaying) play();
  } else {
    lastSeekKey = '';
    renderNow();
    updateTimeUI(nt);
  }
  emit('seek', nt);
}

/** 현재 위치(또는 지정 위치)의 프레임을 그립니다. 비디오는 정확한 프레임으로 이동합니다. */
export async function renderAt(t, opts = {}) {
  const target = t == null ? state.time : t;
  const p = state.project;
  if (p) {
    const loc = locate(target);
    if (loc && loc.clip.kind === 'video' && opts.seekMedia !== false) {
      const v = videoFor(loc.clip.assetId);
      if (v) {
        const want = clamp((loc.clip.trimIn || 0) + loc.local * (loc.clip.speed || 1), 0, Math.max(0, (v.duration || 1) - 0.03));
        const key = `${loc.clip.assetId}:${want.toFixed(2)}`;
        if (key !== lastSeekKey) {
          lastSeekKey = key;
          await waitVideoReady(v, 3000);
          await seekVideo(v, want);
        }
      }
    }
  }
  renderFrame(ctx, target);
}

const renderNow = debounce(() => { renderAt(state.time); updateTimeUI(state.time); }, 24);

export function requestRender() { renderNow(); }

export function resizeCanvas(cssW, cssH) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
    renderNow();
  }
}

export function isPlaying() { return state.playing; }

export function setMuted(m) {
  state.muted = m;
  if (gainNode) gainNode.gain.value = m ? 0 : 1;
  const b = $('#btnMute');
  if (b) b.classList.toggle('active', m);
}

export function initPlayer() {
  const scrub = $('#scrub');
  if (scrub) {
    scrub.addEventListener('input', () => {
      const dur = totalDuration();
      const t = (Number(scrub.value) / 1000) * dur;
      if (state.playing) pause();
      state.time = t;
      emit('time', t);
      renderNow();
    });
  }
  window.addEventListener('media-ready', () => requestRender());
  window.addEventListener('resize', () => {
    const wrap = $('#canvasWrap');
    const c = $('#preview');
    if (!wrap || !c) return;
    const r = c.getBoundingClientRect();
    if (r.width && r.height) resizeCanvas(r.width, r.height);
  });
  const c = $('#preview');
  if (c) {
    // 첫 프레임
    requestAnimationFrame(() => {
      const r = c.getBoundingClientRect();
      if (r.width && r.height) resizeCanvas(r.width, r.height);
      renderNow();
      updateTimeUI(0);
    });
  }
}
