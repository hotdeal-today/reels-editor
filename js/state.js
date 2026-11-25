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

export const MOSAIC_DEFAULT = {
  on: false,
  y: 78,        // 가림 영역 중심 Y (%) — 하단 자막 글자 줄 주변
  h: 9,         // 높이 (%) — 글자 한 줄만
  w: 68,        // 너비 (%) — 양옆 배경은 건드리지 않음
  strength: 0,  // 모자이크 조각 크기 (1080 기준 px, 0 = 픽셀화 없이 희뿌연 블러만)
  blur: 11,     // 희뿌연 블러 (px)
};

// 예전 기본값(배경까지 넓게 덮는 굵은 블록 모자이크) — 저장본을 새 기본값으로 옮길 때 씁니다.
const LEGACY_MOSAIC_DEFAULT = { y: 76, h: 18, w: 100, strength: 32, blur: 4 };

export function defaultProject() {
  return {
    version: 1,
    name: '새 릴스',
    clips: [],
    mosaic: { ...MOSAIC_DEFAULT },
    texts: {
      title: defaultStyle('title'),
      badge: defaultStyle('badge'),
      subtitle: defaultStyle('subtitle'),
    },
    segments: [
      { id: uid('seg'), start: 0, end: 4, title: '', badge: '', subtitle: '', pos: {} },
    ],
    audio: { narration: null, bgm: null, sfx: [], customSfx: [], voice: [] },
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
  // 글자를 아직 안 넣은 단일 구간은 영상 전체 길이를 덮도록
  if (p.segments.length === 1 && dur > 0.3) {
    const only = p.segments[0];
    if (!(only.title || '').trim() && !(only.badge || '').trim() && !(only.subtitle || '').trim()) {
      only.start = 0;
      only.end = dur;
    }
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
      mosaic: { ...d.mosaic, ...(p.mosaic || {}) },
      audio: { narration: null, bgm: null, sfx: [], customSfx: [], voice: [], ...(p.audio || {}) },
      export: { ...d.export, ...(p.export || {}) },
      segments: Array.isArray(p.segments) && p.segments.length ? p.segments : d.segments,
    };
    migrateMosaic(state.project.mosaic);
    for (const c of state.project.clips || []) { if (c.mosaic) migrateMosaic(c.mosaic); }
  }
  mixDirty();
  return state.project;
}

export function mixDirty() { state.mixDirty = true; }

/** 클립에 따로 저장한 모자이크 설정이 있으면 그것을, 없으면 전체 설정을 씁니다. */
export function mosaicOf(clip) {
  const p = state.project;
  const base = (p && p.mosaic) || MOSAIC_DEFAULT;
  const merged = { ...MOSAIC_DEFAULT, ...base };
  if (clip && clip.mosaic) return { ...merged, ...clip.mosaic };
  return merged;
}

/** 예전 기본값 그대로인 저장본은 새 기본값(글자 영역만 희뿌연 블러)으로 옮깁니다. */
function migrateMosaic(m) {
  if (!m || m.on) return;
  const same = Object.keys(LEGACY_MOSAIC_DEFAULT).every((k) => Number(m[k]) === LEGACY_MOSAIC_DEFAULT[k]);
  if (same) Object.assign(m, { y: MOSAIC_DEFAULT.y, h: MOSAIC_DEFAULT.h, w: MOSAIC_DEFAULT.w, strength: MOSAIC_DEFAULT.strength, blur: MOSAIC_DEFAULT.blur });
}

export function newProject() {
  state.project = defaultProject();
  state.time = 0;
  state.sel = { clip: 0, text: 'title', segment: 0, sfx: null };
  state.mixDirty = true;
  persist();
}
