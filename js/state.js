// state.js — 프로젝트 상태 · 저장 · 시간 계산
import { idbGet, idbPut, idbAll } from './db.js';
import { uid, clamp, debounce, emit } from './util.js';

export const TEXT_KEYS = ['title', 'badge', 'subtitle'];
export const TEXT_LABEL = { title: '제목', badge: '배지', subtitle: '자막' };

export function defaultStyle(key) {
  const base = {
    font: 'Noto Sans KR',
    size: 72,
    weight: 800,
    color: '#ffffff',
    stroke: { on: false, color: '#000000', width: 3 },
    shadow: { on: true, color: '#000000', opacity: 55, x: 0, y: 6, blur: 14 },
    bg: { on: false, color: '#000000', opacity: 70, radius: 16, padX: 24, padY: 12 },
    x: 540,
    y: 240,
  };
  if (key === 'title') return { ...base, size: 76, y: 208 };
  if (key === 'badge') {
    return {
      ...base, size: 40, y: 318,
      bg: { on: true, color: '#ff3b6b', opacity: 100, radius: 99, padX: 26, padY: 12 },
      shadow: { on: true, color: '#000000', opacity: 35, x: 0, y: 4, blur: 10 },
    };
  }
  return {
    ...base, size: 50, weight: 700, y: 1610,
    bg: { on: false, color: '#000000', opacity: 65, radius: 12, padX: 22, padY: 10 },
    shadow: { on: true, color: '#000000', opacity: 60, x: 0, y: 4, blur: 12 },
  };
}

export function defaultProject() {
  return {
    version: 1,
    name: '새 릴스',
    clips: [],
    texts: {
      title: defaultStyle('title'),
      badge: defaultStyle('badge'),
      subtitle: defaultStyle('subtitle'),
    },
    segments: [
      { id: uid('seg'), start: 0, end: 4, title: '', badge: '', subtitle: '', pos: {} },
    ],
    audio: { narration: null, bgm: null, sfx: [], customSfx: [] },
    export: { width: 1080, height: 1920, fps: 30, realtime: false, bitrateMbps: 8 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export const state = {
  project: null,
  assets: new Map(),       // id -> { id, name, kind, mime, size, blob, url, duration, width, height, thumb }
  time: 0,
  playing: false,
  muted: false,
  sel: { clip: 0, text: 'title', segment: 0, sfx: null },
  mixDirty: true,
  savedAt: 0,
};

// ── 자산 ──────────────────────────────────────────────
export function addAssetRecord(rec) {
  const url = URL.createObjectURL(rec.blob);
  const full = { ...rec, url };
  state.assets.set(rec.id, full);
  return full;
}
export function getAsset(id) { return state.assets.get(id) || null; }
export function removeAsset(id) {
  const a = state.assets.get(id);
  if (!a) return;
  if (a.url) URL.revokeObjectURL(a.url);
  state.assets.delete(id);
}
export async function loadAssets() {
  let rows = [];
  try { rows = await idbAll('assets'); } catch (e) { rows = []; }
  for (const rec of rows) {
    if (!rec || !rec.blob) continue;
    addAssetRecord(rec);
  }
  return rows.length;
}
export async function persistAsset(rec) {
  await idbPut('assets', rec);
}

// ── 시간 ─────────────────────────────────────────────
export function clipDur(clip) {
  if (!clip) return 0;
  if (clip.kind === 'image') return Math.max(0.2, clip.duration || 3);
  const tin = clip.trimIn || 0;
  const tout = clip.trimOut == null ? (clip.srcDuration || 0) : clip.trimOut;
  return Math.max(0.1, (tout - tin) / Math.max(0.1, clip.speed || 1));
}
export function clipStart(i) {
  let s = 0;
  const clips = state.project ? state.project.clips : [];
  for (let k = 0; k < i && k < clips.length; k++) s += clipDur(clips[k]);
  return s;
}
export function totalDuration() {
  const clips = state.project ? state.project.clips : [];
  return clips.reduce((a, c) => a + clipDur(c), 0);
}
export function locate(t) {
  const clips = state.project ? state.project.clips : [];
  let start = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = clipDur(clips[i]);
    if (t < start + d || i === clips.length - 1) {
      return { index: i, clip: clips[i], start, local: clamp(t - start, 0, d), dur: d };
    }
    start += d;
  }
  return null;
}
export function activeSegment(t) {
  const segs = state.project ? state.project.segments : [];
  return segs.find((s) => t >= s.start - 1e-6 && t < s.end - 1e-6) || null;
}
export function ensureSegments() {
  const p = state.project;
  if (!p) return;
  const dur = totalDuration();
  if (!p.segments.length) {
    p.segments.push({ id: uid('seg'), start: 0, end: Math.max(1, dur || 4), title: '', badge: '', subtitle: '', pos: {} });
  }
  for (const s of p.segments) {
    s.start = clamp(s.start, 0, Math.max(0, dur || s.end));
    s.end = clamp(s.end, s.start + 0.2, Math.max(s.start + 0.2, dur || s.end));
    if (!s.pos) s.pos = {};
  }
  p.segments.sort((a, b) => a.start - b.start);
}
export function textPos(key, t) {
  const seg = activeSegment(t);
  const st = state.project.texts[key];
  const p = seg && seg.pos && seg.pos[key];
  if (p) return { x: p.x, y: p.y, seg };
  return { x: st.x, y: st.y, seg };
}

// ── 저장 ─────────────────────────────────────────────
const save = debounce(async () => {
  const p = state.project;
  if (!p) return;
  p.updatedAt = Date.now();
  emit('save:start');
  try {
    await idbPut('project', JSON.parse(JSON.stringify(p)), 'current');
    state.savedAt = Date.now();
    emit('save:done');
  } catch (e) {
    console.error(e);
    emit('save:error', e);
  }
}, 550);

export function persist() { save(); }
export function persistNow() { save.flush(); }

export async function loadProject() {
  let p = null;
  try { p = await idbGet('project', 'current'); } catch (e) { p = null; }
  if (!p || !p.clips) {
    state.project = defaultProject();
  } else {
    // 기본값 병합 (이전 저장본 호환)
    const d = defaultProject();
    state.project = {
      ...d, ...p,
      texts: {
        title: { ...d.texts.title, ...(p.texts && p.texts.title) },
        badge: { ...d.texts.badge, ...(p.texts && p.texts.badge) },
        subtitle: { ...d.texts.subtitle, ...(p.texts && p.texts.subtitle) },
      },
      audio: { narration: null, bgm: null, sfx: [], customSfx: [], ...(p.audio || {}) },
      export: { ...d.export, ...(p.export || {}) },
      segments: Array.isArray(p.segments) && p.segments.length ? p.segments : d.segments,
    };
  }
  mixDirty();
  return state.project;
}

export function mixDirty() { state.mixDirty = true; }

export function newProject() {
  state.project = defaultProject();
  state.time = 0;
  state.sel = { clip: 0, text: 'title', segment: 0, sfx: null };
  state.mixDirty = true;
  persist();
}
