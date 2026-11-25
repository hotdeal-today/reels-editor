// project-io.js — 프로젝트 .json 내보내기 / 불러오기 (미디어 파일은 포함하지 않음)
import { state, defaultProject, defaultStyle, getAsset, persist, mixDirty } from './state.js';
import { uid, clamp } from './util.js';
import { SFX_DEFS } from './audio.js';

export const PROJECT_FILE_KIND = 'reels-studio-project';

function safeClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** 지금 프로젝트를 .json 문자열로 */
export function buildProjectJson() {
  const p = state.project;
  const media = (p.clips || []).map((c) => {
    const a = getAsset(c.assetId);
    return {
      id: c.assetId,
      name: c.name || (a && a.name) || '',
      kind: a ? a.kind : c.kind,
      width: a && a.width,
      height: a && a.height,
      duration: a && a.duration,
    };
  });
  const payload = {
    kind: PROJECT_FILE_KIND,
    version: 2,
    savedAt: new Date().toISOString(),
    note: '미디어 파일은 포함되지 않습니다(설정·타임라인만). 같은 이름의 사진·영상을 다시 올리면 그대로 이어서 편집할 수 있습니다.',
    project: safeClone(p),
    media,
  };
  return JSON.stringify(payload, null, 2);
}

export function projectFileName() {
  const name = (state.project.name || '릴스').replace(/[\\/:*?"<>|]/g, '').trim() || '릴스';
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${name}_${stamp}.json`;
}

/** .json 텍스트를 현재 프로젝트로 불러옵니다. */
export function loadProjectJson(text) {
  let data = null;
  try { data = JSON.parse(String(text || '')); } catch (e) {
    throw new Error('JSON 파일을 읽지 못했습니다. 편집기에서 저장한 .json인지 확인해 주세요.');
  }
  const raw = data && data.project ? data.project : data;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.clips)) {
    throw new Error('이 편집기의 프로젝트 파일이 아닙니다(클립 정보가 없습니다).');
  }
  const base = defaultProject();
  const next = {
    ...base,
    ...raw,
    version: 2,
    clips: [],
    texts: {
      title: { ...base.texts.title, ...(raw.texts && raw.texts.title) },
      badge: { ...base.texts.badge, ...(raw.texts && raw.texts.badge) },
      subtitle: { ...base.texts.subtitle, ...(raw.texts && raw.texts.subtitle) },
    },
    audio: { narration: null, bgm: null, sfx: [], customSfx: [], voice: [], ...(raw.audio || {}) },
    export: { ...base.export, ...(raw.export || {}) },
    segments: [],
    updatedAt: Date.now(),
  };
  next.audio.voice = Array.isArray(next.audio.voice) ? next.audio.voice : [];
  next.audio.sfx = Array.isArray(next.audio.sfx) ? next.audio.sfx : [];
  next.audio.customSfx = Array.isArray(next.audio.customSfx) ? next.audio.customSfx : [];

  let missingMedia = 0;
  for (const c of raw.clips) {
    if (!c || !c.assetId) continue;
    if (!getAsset(c.assetId)) { missingMedia++; continue; }
    const d = base.clips[0] || {};
    next.clips.push({
      ...d,
      ...c,
      id: c.id || uid('clip'),
      kind: c.kind === 'video' ? 'video' : 'image',
      duration: clamp(Number(c.duration) || 3, 0.2, 60),
      trimIn: Math.max(0, Number(c.trimIn) || 0),
      trimOut: c.trimOut == null ? undefined : Math.max(0, Number(c.trimOut)),
      speed: clamp(Number(c.speed) || 1, 0.25, 4),
      volume: clamp(Number(c.volume ?? 100), 0, 100),
      motion: c.motion || 'none',
      transition: c.transition === 'fade' ? 'fade' : 'cut',
      fit: c.fit === 'fit' ? 'fit' : 'fill',
      adjust: { brightness: 0, contrast: 0, saturate: 0, ...(c.adjust || {}) },
      zoom: clamp(Number(c.zoom) || 100, 100, 250),
      offsetX: clamp(Number(c.offsetX) || 0, -50, 50),
      offsetY: clamp(Number(c.offsetY) || 0, -50, 50),
    });
  }

  // 미디어가 없는 오디오 설정 정리
  if (next.audio.narration && !getAsset(next.audio.narration.assetId)) next.audio.narration = null;
  if (next.audio.bgm && !getAsset(next.audio.bgm.assetId)) next.audio.bgm = null;
  const builtin = new Set(SFX_DEFS.map((d) => d.id));
  next.audio.sfx = next.audio.sfx.filter((s) => s && (builtin.has(s.key) || getAsset(s.key)));
  next.audio.voice = next.audio.voice.filter((v) => v && getAsset(v.assetId));
  const custom = next.audio.customSfx.filter((id) => getAsset(id));
  next.audio.customSfx = custom;
  let missingAudio = 0;
  const rawVoice = Array.isArray(raw.audio && raw.audio.voice) ? raw.audio.voice.length : 0;
  if (rawVoice > next.audio.voice.length) missingAudio += rawVoice - next.audio.voice.length;

  // 구간 복원 (시간은 지금 타임라인 길이에 맞춰 자름)
  const dur = next.clips.reduce((a, c) => {
    if (c.kind === 'image') return a + Math.max(0.2, c.duration || 3);
    const tin = c.trimIn || 0;
    const tout = c.trimOut == null ? (c.srcDuration || c.duration || 0) : c.trimOut;
    return a + Math.max(0.1, (tout - tin) / Math.max(0.1, c.speed || 1));
  }, 0);
  const segs = Array.isArray(raw.segments) ? raw.segments : [];
  next.segments = segs.map((s) => ({
    id: s.id || uid('seg'),
    start: clamp(Number(s.start) || 0, 0, Math.max(0, dur)),
    end: clamp(Number(s.end) || 0, 0.2, Math.max(0.2, dur)),
    title: s.title || '',
    badge: s.badge || '',
    subtitle: s.subtitle || '',
    pos: s.pos && typeof s.pos === 'object' ? s.pos : {},
  })).filter((s) => s.end > s.start + 0.05);
  if (!next.segments.length) {
    next.segments = [{ id: uid('seg'), start: 0, end: Math.max(1, dur || 4), title: '', badge: '', subtitle: '', pos: {} }];
  }
  next.segments.sort((a, b) => a.start - b.start);

  state.project = next;
  state.time = 0;
  state.sel = { clip: 0, text: 'title', segment: next.segments[0].id, sfx: null };
  mixDirty();
  persist();
  return { clips: next.clips.length, missingMedia, missingAudio, segments: next.segments.length, name: next.name };
}

export { defaultStyle };
