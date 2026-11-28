// narration.js — 자막 ↔ 나레이션 1:1 연동 (단일 진실 원천)
//
//  · 자막(segments)이 바뀌면 그 구간 나레이션의 대본(text)·시작 시각(start)이 즉시 같이 바뀝니다.
//  · 음성을 만들 때 읽힌 대본(genText)과 지금 대본(text)이 다르면 stale 로 표시합니다.
//  · 전체/동기화 생성은 '구간 1개 = 음성 1개'로만 맞추고, 목소리는 한 가지로 고정합니다.
//  · 속도(배속)는 프로젝트에 저장되어 미리듣기·타임라인 재생·MP4 내보내기가 모두 같은 값을 씁니다.
import { state, persist, mixDirty } from './state.js';
import {
  geminiTts, addVoiceClip, removeVoiceClip, voiceClips, voiceAssetName, voiceLayoutNow,
} from './tts.js';
import { loadAiSettings, saveAiSettings, listModels, pickModels, TTS_MODEL_CANDIDATES } from './gemini.js';
import { clamp, round } from './util.js';
import { planSummary } from './voicelayout.js';

export const NARR_RATE_MIN = 0.5;
export const NARR_RATE_MAX = 2;
export const NARR_RATE_DEFAULT = 1;

/** 이 구간이 읽어 줄 대본 — 자막 → 제목 → 배지 순 (한 곳에서만 정합니다) */
export function segmentNarrationText(seg) {
  return String((seg && (seg.subtitle || seg.title || seg.badge)) || '').trim();
}

/**
 * 이 음성이 지금 자막과 어긋났는지.
 *  · genText = 이 음성을 만들 때 읽힌 대본. 없으면(이전 버전에서 만든 음성) 확인이 안 된 것이라 다시 만들기 대상입니다.
 */
export function voiceIsStale(v) {
  if (!v || !v.segId) return false;
  if (v.genText == null) return true;
  return String(v.text == null ? '' : v.text) !== String(v.genText);
}

export function voiceFor(segId) {
  if (!segId) return null;
  return voiceClips().find((v) => v.segId === segId) || null;
}

/** 프로젝트의 나레이션 속도 (배속) */
export function narrationRate() {
  const n = Number(state.project && state.project.audio && state.project.audio.narrRate);
  return Number.isFinite(n) && n > 0 ? clamp(n, NARR_RATE_MIN, NARR_RATE_MAX) : NARR_RATE_DEFAULT;
}

export function setNarrationRate(v) {
  const p = state.project;
  if (!p) return NARR_RATE_DEFAULT;
  const rate = clamp(Number(v) || NARR_RATE_DEFAULT, NARR_RATE_MIN, NARR_RATE_MAX);
  p.audio.narrRate = Math.round(rate * 100) / 100;
  mixDirty();
  persist();
  return p.audio.narrRate;
}

/**
 * 자막에 없는 음성(구간 삭제·옛 구간 id·한 구간에 여러 개)을 정리합니다.
 *  · 이 앱은 '구간 1개 = 음성 1개'만 씁니다. 겹쳐 들리는 원인을 여기서 없앱니다.
 *  · forget=true 면 IndexedDB 의 오디오 파일까지 지웁니다.
 */
export function cleanNarrationTrack({ forget = false } = {}) {
  const p = state.project;
  if (!p) return 0;
  p.audio.voice = Array.isArray(p.audio.voice) ? p.audio.voice : [];
  const voices = p.audio.voice.slice();
  if (!voices.length) return 0;
  const segIds = new Set((p.segments || []).map((s) => s.id));
  const keep = new Map();
  const drop = [];
  for (const v of voices) {
    if (!v || !v.id || !v.assetId) { if (v && v.id) drop.push(v); continue; }
    if (!v.segId) { drop.push(v); continue; }          // 구간에 안 묶인 옛 음성
    if (!segIds.has(v.segId)) { drop.push(v); continue; } // 사라진 구간의 음성
    const prev = keep.get(v.segId);
    if (!prev) { keep.set(v.segId, v); continue; }
    const newer = (Number(v.createdAt) || 0) >= (Number(prev.createdAt) || 0) ? v : prev;
    const older = newer === v ? prev : v;
    keep.set(v.segId, newer);
    drop.push(older);
  }
  if (!drop.length) return 0;
  for (const v of drop) {
    removeVoiceClip(v.id, { forget });
  }
  return drop.length;
}

/**
 * 자막 → 나레이션 대본·시각 동기화.
 *  · 자막 글자를 고치면 그 구간 음성의 text 가 바로 바뀝니다(오디오는 stale 표시).
 *  · 자막 시작 시각을 고치면 그 구간 음성의 start 가 바로 바뀝니다.
 *  · 구간이 사라졌거나 한 구간에 음성이 2개면 여기서 1개로 정리합니다.
 */
export function syncNarrationToSegments({ prune = true, forget = false } = {}) {
  const p = state.project;
  if (!p) return { changed: 0, removed: 0 };
  let changed = 0;
  const removed = prune ? cleanNarrationTrack({ forget }) : 0;
  for (const v of (p.audio.voice || [])) {
    if (!v || !v.segId) continue;
    const seg = (p.segments || []).find((s) => s.id === v.segId);
    if (!seg) continue;
    const txt = segmentNarrationText(seg);
    if (v.text == null) v.text = txt;
    // genText 가 없는 예전 음성은 '확인 안 됨'으로 두어 한 번 다시 만들 수 있게 합니다.
    if (v.text !== txt) { v.text = txt; changed++; }
    const at = round(seg.start, 2);
    if (Math.abs((Number(v.start) || 0) - at) > 0.001) { v.start = at; changed++; }
  }
  if (changed || removed) { mixDirty(); persist(); }
  return { changed, removed };
}

/** 화면·요약용 상태 */
export function narrationReport() {
  const p = state.project;
  const segs = ((p && p.segments) || []).filter((s) => segmentNarrationText(s));
  const voices = (p && p.audio && p.audio.voice) || [];
  const bySeg = new Map();
  for (const v of voices) {
    if (!v || !v.segId) continue;
    bySeg.set(v.segId, (bySeg.get(v.segId) || 0) + 1);
  }
  const missing = segs.filter((s) => !bySeg.has(s.id));
  const stale = voices.filter((v) => voiceIsStale(v));
  const staleTts = stale.filter((v) => v.kind === 'tts' || !v.kind);
  const staleManual = stale.filter((v) => v.kind && v.kind !== 'tts');
  const dup = segs.reduce((n, s) => n + Math.max(0, (bySeg.get(s.id) || 0) - 1), 0);
  const unbound = voices.filter((v) => !v.segId).length;
  const names = Array.from(new Set(voices.map((v) => v.voiceName).filter(Boolean)));
  const tts = voices.filter((v) => v.kind === 'tts').length;
  return {
    captions: segs.length,
    voices: voices.length,
    tts,
    missing,
    stale,
    staleTts,
    staleManual,
    dup,
    unbound,
    names,
    mixed: names.length > 1,
    segments: segs,
  };
}

/** 이 프로젝트에서 쓸 TTS 모델을 확인합니다(키로 실제 목록 확인, 실패하면 저장값). */
async function resolveTtsModel(apiKey) {
  const s = loadAiSettings();
  let model = s.ttsModel || TTS_MODEL_CANDIDATES[0];
  try {
    const ids = await listModels(apiKey);
    const picked = pickModels(ids, s);
    if (picked.tts) model = picked.tts;
    saveAiSettings({ ttsModel: model, model: picked.text || s.model });
  } catch (e) { /* 기본 모델로 시도 */ }
  return model;
}

/**
 * 자막 기준으로 나레이션을 만듭니다.
 * @param {'all'|'sync'|'one'} mode
 *   all  = 나레이션 트랙을 전부 비우고 현재 자막 컷 기준으로 딱 1세트를 새로 채웁니다.
 *   sync = 목소리가 다르거나 대본이 바뀐(stale)·빠진 구간만, 고른 목소리 하나로 다시 만듭니다.
 *   one  = 지정한 구간(segIds)만 다시 만듭니다.
 * @param {{segIds?: string[], voice?: string, onProgress?: (msg:string)=>void}} opts
 */
export async function buildNarration({ mode = 'sync', segIds = null, voice = null, onProgress = () => {} } = {}) {
  const p = state.project;
  if (!p) return { ok: 0, fail: 0, total: 0 };
  const s = loadAiSettings();
  if (!s.apiKey) throw new Error('Gemini 무료 API 키가 필요합니다. 5번 AI 세팅에서 키를 먼저 넣어 주세요.');
  const chosen = voice || s.voice || 'Kore';
  saveAiSettings({ voice: chosen });
  p.audio.narrVoice = chosen;

  const all = (p.segments || []).filter((sg) => segmentNarrationText(sg));
  if (!all.length) return { ok: 0, fail: 0, total: 0, empty: true };

  let cleared = 0;
  if (mode === 'all') {
    // 옛 클립을 부분 유지하지 않고 전부 비웁니다(중복·다른 목소리·옛 구간 잔재까지).
    for (const v of voiceClips().slice()) {
      removeVoiceClip(v.id, { forget: true });
      cleared++;
    }
  } else {
    cleared += cleanNarrationTrack({ forget: true });
    // 목소리가 섞이지 않게: 고른 목소리가 아닌 TTS 음성은 지웁니다(다시 만듭니다).
    for (const v of voiceClips().slice()) {
      if (v.kind === 'tts' && v.voiceName !== chosen) {
        removeVoiceClip(v.id, { forget: true });
        cleared++;
      }
    }
  }

  let targets;
  if (mode === 'one') {
    const want = new Set(segIds || []);
    targets = all.filter((sg) => want.has(sg.id));
  } else {
    targets = all.filter((sg) => {
      const v = voiceFor(sg.id);
      if (!v) return true;
      // 녹음·올린 파일은 사용자가 넣은 목소리라 자동으로 갈아치우지 않습니다(✨로 직접 바꿀 수 있음).
      if (v.kind && v.kind !== 'tts') return false;
      return voiceIsStale(v);
    });
  }
  if (!targets.length) {
    mixDirty();
    persist();
    return { ok: 0, fail: 0, total: 0, cleared, voice: chosen, upToDate: true };
  }

  const model = await resolveTtsModel(s.apiKey);
  let ok = 0, fail = 0, lastErr = '';
  for (let i = 0; i < targets.length; i++) {
    const sg = targets[i];
    const text = segmentNarrationText(sg);
    onProgress(`나레이션 ${i + 1}/${targets.length} — ${text.slice(0, 18)}… (${chosen} · ${sg.start.toFixed(1)}~${sg.end.toFixed(1)}초)`);
    try {
      const { blob } = await geminiTts(text, { apiKey: s.apiKey, model, voice: chosen });
      // 같은 구간의 옛 음성은 남김없이 지우고 새로 넣습니다(구간 1개 = 음성 1개).
      voiceClips().filter((v) => v.segId === sg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
      await addVoiceClip({
        blob, name: voiceAssetName(sg, 'TTS'), start: sg.start, segId: sg.id,
        kind: 'tts', voiceName: chosen, text,
      });
      ok++;
    } catch (e) {
      fail++;
      lastErr = e.message || String(e);
      if (/API 키|한도|권한/.test(lastErr)) break;
    }
  }
  cleanNarrationTrack({ forget: false });
  syncNarrationToSegments({ prune: false });
  // 자막별 나레이션을 만들었으면 전체 길이 나레이션 파일은 꺼서 두 목소리가 겹치지 않게 합니다.
  let narrationOff = false;
  if (p.audio.narration && p.audio.narration.on !== false) {
    p.audio.narration.on = false;
    narrationOff = true;
  }
  mixDirty();
  persist();
  const sum = planSummary(voiceLayoutNow(), totalTime());
  return { ok, fail, lastErr, total: targets.length, cleared, voice: chosen, narrationOff, overlaps: sum.overlaps };
}

/** 전체 길이(초) — 순환 import 를 피하려고 여기서 계산합니다. */
function totalTime() {
  const clips = (state.project && state.project.clips) || [];
  return clips.reduce((a, c) => {
    if (!c) return a;
    if (c.kind === 'image') return a + Math.max(0.2, c.duration || 3);
    const tin = c.trimIn || 0;
    const tout = c.trimOut == null ? (c.srcDuration || 0) : c.trimOut;
    return a + Math.max(0.1, (tout - tin) / Math.max(0.1, c.speed || 1));
  }, 0);
}
