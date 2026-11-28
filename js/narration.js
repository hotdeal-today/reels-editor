// narration.js — 자막 ↔ 나레이션 1:1 연동 (단일 진실 원천)
//
//  · 자막(segments)이 바뀌면 그 구간 나레이션의 대본(text)·시작 시각(start)이 즉시 같이 바뀝니다.
//  · 음성을 만들 때 읽힌 대본(genText)과 지금 대본(text)이 다르면 stale 로 표시합니다.
//  · v12 생성 방식: 전체 대본을 Gemini TTS로 '1번만' 읽혀 WAV 하나를 받고,
//    그 안의 쉼에서 자막 수만큼 자릅니다 → 9컷이어도 목소리·톤·음색이 100% 하나입니다.
//    (예전엔 컷마다 따로 호출해 톤이 달라지고, 컷마다 배속을 바꿔 피치까지 달라졌습니다)
//  · 속도(배속)는 프로젝트에 저장되어 미리듣기·타임라인 재생·MP4 내보내기가 모두 같은 값(전 구간 동일)을 씁니다.
import { state, persist, mixDirty, clipDur } from './state.js';
import {
  geminiTts, addVoiceClip, removeVoiceClip, voiceClips, voiceAssetName, voiceLayoutNow,
  decodeAudioBlob, stopAllSpeech,
} from './tts.js';
import { importAudioFile } from './media.js';
import { loadAiSettings, saveAiSettings, listModels, pickModels, TTS_MODEL_CANDIDATES } from './gemini.js';
import { clamp, round } from './util.js';
import { planSummary, voiceContent, LAYOUT_GAP } from './voicelayout.js';
import { chooseCutPoints, sliceBuffer, concatBuffers, encodeWav } from './voicesplit.js';

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

/**
 * 프로젝트의 음성이 한 목소리로만 이루어져 있으면 그 목소리를 '이 프로젝트의 목소리'로 삼습니다.
 * (2번·3번 화면의 목소리 선택과 실제 음성이 어긋나 보이지 않게)
 */
export function adoptNarrationVoice() {
  const p = state.project;
  if (!p || !p.audio) return null;
  const names = Array.from(new Set((p.audio.voice || []).map((v) => v && v.voiceName).filter(Boolean)));
  if (names.length !== 1) return null;
  const voice = names[0];
  if (p.audio.narrVoice !== voice) {
    p.audio.narrVoice = voice;
    saveAiSettings({ voice });
    persist();
  }
  return voice;
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

/** 이 프로젝트가 쓸 목소리 — 3번(음성·효과)과 5번(AI 세팅)이 같은 1개의 상태를 봅니다. */
export function narrationVoiceNow() {
  const p = state.project;
  const proj = p && p.audio && p.audio.narrVoice;
  return String(proj || loadAiSettings().voice || 'Kore');
}

/** 900자 제한에 걸리지 않게 자막 줄을 가능한 적은 묶음으로 나눕니다(보통 1묶음 = 1회 호출). */
function chunkLines(lines, limit = 860) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    const add = (cur.length ? 2 : 0) + String(line).length;
    if (cur.length && len + add > limit) { chunks.push(cur); cur = []; len = 0; }
    cur.push(line);
    len += (cur.length > 1 ? 2 : 0) + String(line).length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * 컷(클립) 길이를 나레이션 음성 길이에 맞춰 늘립니다.
 *  · 배속은 전 구간 같은 값이라 컷마다 당길 수 없습니다. 대신 컷을 음성만큼 늘려
 *    자막이 떠 있는 동안 그 자막의 음성이 그대로 들리게 합니다.
 *  · 구간과 클립이 1:1로 맞을 때만 손대고(아니면 배치 계산이 겹침만 막습니다), 늘리기만 합니다.
 * @returns {{grew:number, added:number}} 늘린 컷 수 · 늘어난 초
 */
export function fitCutsToVoice() {
  const p = state.project;
  if (!p) return { grew: 0, added: 0 };
  const clips = p.clips || [];
  const segs = (p.segments || []).slice().filter((s) => segmentNarrationText(s)).sort((a, b) => a.start - b.start);
  if (!clips.length || segs.length !== clips.length) return { grew: 0, added: 0 };
  const base = narrationRate();
  // 1:1로 맞는지 확인 (자막 경계 = 클립 경계)
  let at = 0;
  for (let i = 0; i < clips.length; i++) {
    if (Math.abs(Number(segs[i].start) - at) > 0.06) return { grew: 0, added: 0 };
    at += clipDur(clips[i]);
  }
  let grew = 0;
  let added = 0;
  for (let i = 0; i < clips.length; i++) {
    const v = voiceFor(segs[i].id);
    if (!v) continue;
    if (v.kind && v.kind !== 'tts') continue;          // 녹음·올린 파일은 사용자의 목소리 그대로
    const { speak } = voiceContent(v);
    const need = speak / base + LAYOUT_GAP + 0.06;     // 음성 + 최소 여백
    const cur = clipDur(clips[i]);
    if (need <= cur + 0.02) continue;
    const want = Math.min(need, cur + 8);              // 한 컷에서 최대 +8초까지만
    const c = clips[i];
    if (c.kind === 'image') {
      const nd = Math.min(15, Math.max(0.3, (Number(c.duration) || 3) + (want - cur)));
      c.duration = round(nd, 2);
      c.trimIn = 0;
      c.trimOut = c.duration;
    } else {
      // 영상: 원본이 남아 있으면 창을 늘리고, 이미 꽉 찼으면 그대로 둡니다(속도는 건드리지 않습니다).
      const src = Number(c.srcDuration) || 0;
      const speed = Math.max(0.25, Number(c.speed) || 1);
      const room = src > 0 ? src / speed : want;
      const target = Math.min(want, room);
      if (target > cur + 0.02) {
        const span = target * speed;
        const tin = Math.max(0, Math.min(Number(c.trimIn) || 0, Math.max(0, (src || span) - span)));
        c.trimIn = round(tin, 3);
        c.trimOut = round(Math.min(src || tin + span, tin + span), 3);
      }
    }
    const by = clipDur(c) - cur;
    if (by > 0.01) { added += by; grew++; }
  }
  if (!grew) return { grew: 0, added: 0 };
  // 클립 경계에 맞춰 자막·음성 시작 시각을 다시 (1:1이 확인된 경우에만)
  let t = 0;
  for (let i = 0; i < clips.length; i++) {
    segs[i].start = round(t, 2);
    segs[i].end = round(t + clipDur(clips[i]), 2);
    t += clipDur(clips[i]);
  }
  for (const v of voiceClips()) {
    const seg = segs.find((s) => s.id === v.segId);
    if (seg) v.start = round(seg.start, 2);
  }
  return { grew, added: round(added, 2) };
}

/**
 * 자막 기준으로 나레이션을 만듭니다.
 *  · 전체 대본을 Gemini TTS로 1번만 읽힙니다(컷마다 호출하지 않음 → 톤·음색 하나).
 *  · 받은 WAV를 무음 지점에서 자막 수만큼 자릅니다. 정확히 안 나뉘면 전체 1트랙으로 갑니다.
 * @param {'all'|'sync'|'one'} mode
 *   all  = 나레이션 트랙을 전부 비우고 현재 자막 컷 기준으로 딱 1세트를 새로 채웁니다.
 *   sync = 자막과 어긋났거나 빠진 구간이 있으면, 전체 대본을 한 번에 다시 읽어 한 목소리로 맞춥니다.
 *   one  = 지정한 구간을 포함해 다시 만듭니다(톤이 섞이지 않게 전체 대본을 1번에 읽습니다).
 * @param {{segIds?: string[], voice?: string, onProgress?: (msg:string)=>void}} opts
 */
export async function buildNarration({ mode = 'sync', segIds = null, voice = null, onProgress = () => {} } = {}) {
  const p = state.project;
  if (!p) return { ok: 0, fail: 0, total: 0 };
  const s = loadAiSettings();
  if (!s.apiKey) throw new Error('Gemini 무료 API 키가 필요합니다. 5번 AI 세팅에서 키를 먼저 넣어 주세요.');
  const chosen = voice || narrationVoiceNow();
  saveAiSettings({ voice: chosen });
  p.audio.narrVoice = chosen;

  const all = (p.segments || [])
    .filter((sg) => segmentNarrationText(sg))
    .sort((a, b) => a.start - b.start);
  if (!all.length) return { ok: 0, fail: 0, total: 0, empty: true };

  const want = new Set(segIds || []);
  const manualIds = new Set(
    voiceClips().filter((v) => v.kind && v.kind !== 'tts').map((v) => v.segId),
  );
  // 마이크 녹음·올린 파일은 사용자의 목소리라 자동으로 갈아치우지 않습니다('one'으로 직접 고른 구간만 예외).
  const skipManual = (id) => manualIds.has(id) && !(mode === 'one' && want.has(id));

  // 1) 다시 만들 필요가 있는지 (필요 없으면 API를 부르지 않습니다)
  let need = mode === 'all' || mode === 'one';
  if (!need) {
    need = all.some((sg) => {
      if (skipManual(sg.id)) return false;
      const v = voiceFor(sg.id);
      if (!v) return true;
      if (v.kind && v.kind !== 'tts') return false;
      return voiceIsStale(v) || v.voiceName !== chosen;
    });
  }
  if (!need) {
    mixDirty();
    persist();
    return { ok: 0, fail: 0, total: 0, cleared: 0, voice: chosen, upToDate: true };
  }

  const targets = mode === 'all' ? all : all.filter((sg) => !skipManual(sg.id));
  if (!targets.length) {
    mixDirty();
    persist();
    return { ok: 0, fail: 0, total: 0, voice: chosen, upToDate: true, allManual: true };
  }
  const lines = targets.map((sg) => segmentNarrationText(sg));

  // 2) 전체 대본을 한 번에 읽힙니다 — 이 한 번의 오디오가 곧 '한 사람의 목소리'입니다.
  const model = await resolveTtsModel(s.apiKey);
  const chunks = chunkLines(lines, 860);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`나레이션 한 번에 읽는 중 (${i + 1}/${chunks.length}) — 자막 ${targets.length}개 · ${chosen}`);
    const { blob } = await geminiTts(chunks[i].join('\n\n'), { apiKey: s.apiKey, model, voice: chosen });
    const buf = await decodeAudioBlob(blob);
    if (!buf || !buf.length) throw new Error('TTS 오디오가 비어 있습니다.');
    parts.push(buf);
    if (typeof window !== 'undefined') window.__reelsTtsCalls = (window.__reelsTtsCalls || 0) + 1;
  }
  const full = parts.length > 1 ? concatBuffers(parts, 0.45) : parts[0];

  // 3) 새 오디오가 준비된 뒤에 옛 음성을 비웁니다(실패해도 기존 나레이션이 남아 있게).
  stopAllSpeech();
  let cleared = 0;
  for (const v of voiceClips().slice()) {
    const drop = mode === 'all' || !v.kind || v.kind === 'tts' || (mode === 'one' && want.has(v.segId));
    if (drop) { removeVoiceClip(v.id, { forget: true }); cleared++; }
  }
  let narrationWasOn = false;
  if (p.audio.narration) {
    narrationWasOn = p.audio.narration.on !== false;
    p.audio.narration.on = false;          // 자막별 음성과 절대 겹치지 않게
  }

  // 4) 무음 지점에서 자막 수만큼 자릅니다.
  const cuts = chooseCutPoints(full, targets.length);
  if (cuts) {
    const bounds = [0, ...cuts, full.duration];
    for (let i = 0; i < targets.length; i++) {
      const sg = targets[i];
      const piece = sliceBuffer(full, bounds[i], bounds[i + 1]);
      voiceClips().filter((v) => v.segId === sg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
      await addVoiceClip({
        blob: encodeWav(piece), name: voiceAssetName(sg, 'TTS'), start: sg.start, segId: sg.id,
        kind: 'tts', voiceName: chosen, text: lines[i],
      });
    }
    // 5) 배속은 고정이므로 컷 길이를 음성에 맞춥니다.
    const fit = fitCutsToVoice();
    syncNarrationToSegments({ prune: false });
    mixDirty();
    persist();
    const sum = planSummary(voiceLayoutNow(), totalTime());
    return {
      ok: targets.length, fail: 0, lastErr: '', total: targets.length, cleared, voice: chosen,
      split: true, pieces: targets.length, calls: chunks.length, narrationOff: narrationWasOn,
      fitted: fit.grew, added: fit.added, overlaps: sum.overlaps, rateSpread: sum.rateSpread,
    };
  }

  // 6) 자막 수와 정확히 안 나뉘면 억지로 맞추지 않고 전체 1트랙으로 (같은 목소리로 끝까지)
  let manualRemoved = 0;
  for (const v of voiceClips().slice()) {
    removeVoiceClip(v.id, { forget: false });    // 오디오 파일은 지우지 않고 보관
    manualRemoved++;
  }
  const track = await importAudioFile(new File([encodeWav(full)], `나레이션 전체 ${chosen}.wav`, { type: 'audio/wav' }));
  p.audio.narration = {
    assetId: track.id,
    name: `나레이션 전체 (${chosen} · 자막 ${targets.length}개)`,
    start: 0,
    volume: 100,
    duration: track.duration || full.duration,
    on: true,
  };
  mixDirty();
  persist();
  return {
    ok: 1, fail: 0, lastErr: '', total: targets.length, cleared, voice: chosen,
    split: false, narrationOn: true, narrationOff: false, manualRemoved, calls: chunks.length,
  };
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
