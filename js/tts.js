// tts.js — 한국어 자막 읽어주기
//  · Gemini TTS(무료 키) → 실제 WAV 오디오를 만들어 타임라인에 넣고 MP4에 믹싱
//  · 브라우저 음성(speechSynthesis)은 스피커로만 나가므로 '타이밍 미리듣기' 전용
//  · 구간별 마이크 녹음 / 외부 TTS 파일(클로바더빙·브루 등) 삽입
import { state, persist, mixDirty, getAsset, totalDuration } from './state.js';
import { importAudioFile, decodeAudio, measureSilence } from './media.js';
import { isAssetUsed, forgetAsset } from './assets.js';
import { uid, clamp, round } from './util.js';
import { planVoiceLayout, planSummary, voiceContent, describePlan } from './voicelayout.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const TTS_VOICES = [
  { id: 'ko-KR-SunHiNeural', label: '선히 (여성 · 차분)' },
  { id: 'ko-KR-InJoonNeural', label: '인준 (남성 · 안정)' },
  { id: 'ko-KR-HyunsuNeural', label: '현수 (남성 · 보통)' },
];

// ── PCM → WAV ───────────────────────────────────────────
function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** base64 PCM(16bit LE mono) 또는 WAV 바이트를 재생 가능한 Blob으로 */
export function pcm16ToWavBlob(bytes, sampleRate = 24000) {
  const dataLen = bytes.length;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);          // PCM
  v.setUint16(22, 1, true);          // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataLen, true);
  return new Blob([header, bytes], { type: 'audio/wav' });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rateFromMime(mime) {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? Number(m[1]) : 24000;
}

/**
 * Gemini TTS 호출 → { blob, duration }
 *  · 여러 자막을 '한 번에' 읽힐 때는 줄바꿈(\n\n)을 남겨 둡니다 — 문장 사이 쉼이 생겨
 *    나중에 그 쉼 자리에서 자막 수만큼 정확히 자를 수 있습니다(voicesplit.js).
 */
export async function geminiTts(text, { apiKey, model, voice = 'Kore', style = '' } = {}) {
  if (!apiKey) throw new Error('Gemini API 키가 필요합니다. (무료 키: aistudio.google.com/apikey)');
  if (!model) throw new Error('TTS 모델을 찾지 못했습니다. 연결 확인을 먼저 눌러 주세요.');
  const clean = String(text || '')
    .split(/\n+/)
    .map((t) => t.replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
  if (!clean) throw new Error('읽을 자막이 없습니다.');
  if (clean.length > 900) throw new Error('한 번에 900자까지만 읽을 수 있습니다. 구간을 나눠 주세요.');

  const body = {
    contents: [{ role: 'user', parts: [{ text: style ? `${style}\n\n${clean}` : clean }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    let msg = '';
    try { msg = JSON.parse(raw)?.error?.message || ''; } catch (e) { msg = raw.slice(0, 160); }
    if (res.status === 400 && /API key/i.test(msg)) throw new Error('API 키가 올바르지 않습니다.');
    if (res.status === 404) throw new Error('이 키로는 TTS 모델을 쓸 수 없습니다. 연결 확인에서 TTS 모델 목록을 확인해 주세요.');
    if (res.status === 429) throw new Error('무료 사용량 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요.');
    throw new Error(`TTS 실패 (${res.status})${msg ? ': ' + msg : ''}`);
  }
  let json = {};
  try { json = JSON.parse(raw); } catch (e) { throw new Error('TTS 응답을 해석하지 못했습니다.'); }
  const cand = (json.candidates || [])[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const part = parts.find((p) => p.inlineData || p.inline_data);
  if (!part) {
    const blocked = cand?.finishReason || json.promptFeedback?.blockReason;
    throw new Error(blocked ? `TTS가 응답하지 않았습니다 (${blocked}).` : 'TTS 오디오가 비어 있습니다.');
  }
  const inline = part.inlineData || part.inline_data;
  const mime = inline.mimeType || inline.mime_type || 'audio/L16;rate=24000';
  const bytes = base64ToBytes(inline.data || '');
  if (!bytes.length) throw new Error('TTS 오디오가 비어 있습니다.');
  let blob;
  if (/wav|riff/i.test(mime) || (bytes[0] === 0x52 && bytes[1] === 0x49)) {
    blob = new Blob([bytes], { type: 'audio/wav' });
  } else {
    blob = pcm16ToWavBlob(bytes, rateFromMime(mime));
  }
  const duration = await audioBlobDuration(blob);
  return { blob, duration };
}

export async function audioBlobDuration(blob) {
  try {
    const decoded = await decodeAudioBlob(blob);
    return decoded ? decoded.duration : 0;
  } catch (e) {
    return 0;
  }
}

/** Blob(WAV 등) → AudioBuffer. 자산으로 넣지 않고 바로 분석·분할할 때 씁니다. */
export async function decodeAudioBlob(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 48000);
  return ctx.decodeAudioData(buf.slice(0));
}

// ── 구간 음성(자막 읽기) 트랙 ────────────────────────────
export function voiceClips() {
  const p = state.project;
  if (!p) return [];
  p.audio.voice = Array.isArray(p.audio.voice) ? p.audio.voice : [];
  return p.audio.voice;
}

export async function addVoiceClip({ blob, name, start, volume = 100, segId = null, kind = 'tts', voiceName = '', text = '' }) {
  const p = state.project;
  const ext = (blob.type || '').includes('wav') ? 'wav' : ((blob.type || '').includes('mp4') ? 'm4a' : 'webm');
  const base = String(name || '음성').replace(/\.(wav|mp3|m4a|aac|webm|ogg)$/i, '').trim() || '음성';
  const file = new File([blob], `${base}.${ext}`, { type: blob.type || 'audio/wav' });
  const asset = await importAudioFile(file);
  let quiet = { lead: 0, tail: 0 };
  try { quiet = measureSilence(await decodeAudio(asset.id)); } catch (e) { quiet = { lead: 0, tail: 0 }; }
  p.audio.voice = Array.isArray(p.audio.voice) ? p.audio.voice : [];
  const item = {
    id: uid('vc'),
    assetId: asset.id,
    name: String(asset.name || base).replace(/\.(wav|mp3|m4a|aac|webm|ogg)$/i, ''),
    start: round(clamp(Number(start) || 0, 0, Math.max(0, 9999)), 2),
    volume: clamp(Number(volume) || 100, 0, 150),
    duration: round(asset.duration || 0, 2),
    lead: quiet.lead,   // 앞 무음(초) — 배치 계산에서 뺍니다
    tail: quiet.tail,   // 뒤 무음(초)
    segId,
    kind,
    voiceName: voiceName || '',
    text: String(text || ''),        // 지금 자막 기준 대본 (자막을 고치면 같이 바뀝니다)
    genText: String(text || ''),     // 이 음성을 만들 때 읽힌 대본 — 다르면 stale
    createdAt: Date.now(),
  };
  p.audio.voice.push(item);
  p.audio.voice.sort((a, b) => a.start - b.start);
  mixDirty();
  persist();
  return item;
}

export { measureSilence };

export function removeVoiceClip(id, { forget = false } = {}) {
  const p = state.project;
  const item = (p.audio.voice || []).find((v) => v.id === id);
  p.audio.voice = (p.audio.voice || []).filter((v) => v.id !== id);
  mixDirty();
  persist();
  if (forget && item && item.assetId && !isAssetUsed(item.assetId)) forgetAsset(item.assetId).catch(() => {});
}

/** 지금 프로젝트의 음성 배치(겹침 0 보정 결과) — 화면·검증용 */
export function voiceLayoutNow() {
  const baseRate = Number(state.project && state.project.audio && state.project.audio.narrRate) || 1;
  return planVoiceLayout(voiceClips(), { duration: totalDuration(), baseRate });
}

/** 화면에 쓸 한 줄: "2.9초 → 2.15초 (1.35배속)" */
export function voiceTimingText(v, lay) {
  if (!v) return '';
  const { speak } = voiceContent(v);
  const l = lay || voiceLayoutNow().get(v.id);
  if (!l || !l.played) return v.duration ? `${(v.duration || 0).toFixed(1)}초` : '';
  const head = speak > l.played + 0.03 ? `${speak.toFixed(1)}초 → ${l.played.toFixed(1)}초` : `${l.played.toFixed(1)}초`;
  const extra = describePlan(l);
  return extra ? `${head} (${extra})` : head;
}

/**
 * 같은 구간에 두 번 이상 들어간 음성(중복), 이미 사라진 구간의 음성을 정리합니다.
 *  · 자막을 다시 만들면 구간 id가 새로 생기므로, 옛 음성이 남아 새 음성과 겹쳐 들리는 일이 있었습니다.
 */
export function pruneVoiceClips({ orphans = true } = {}) {
  const p = state.project;
  if (!p) return 0;
  const voices = Array.isArray(p.audio.voice) ? p.audio.voice.slice() : [];
  if (!voices.length) return 0;
  const segIds = new Set((p.segments || []).map((s) => s.id));
  const keepers = new Map();
  const drop = [];
  voices.forEach((v) => {
    if (!v || !v.id || !v.assetId) { if (v && v.id) drop.push(v.id); return; }
    if (orphans && v.segId && !segIds.has(v.segId)) { drop.push(v.id); return; }
    if (!v.segId) return;
    const prev = keepers.get(v.segId);
    if (!prev) { keepers.set(v.segId, v); return; }
    const newer = (Number(v.createdAt) || 0) >= (Number(prev.createdAt) || 0) ? v : prev;
    const older = newer === v ? prev : v;
    keepers.set(v.segId, newer);
    drop.push(older.id);
  });
  for (const id of drop) removeVoiceClip(id, { forget: true });
  return drop.length;
}

/** 진단용 — 라이브 페이지 콘솔에서 겹침 여부를 바로 볼 수 있게 */
if (typeof window !== 'undefined') {
  window.__reelsVoicePlan = () => {
    try {
      const plan = voiceLayoutNow();
      return { rows: Array.from(plan.values()), ...planSummary(plan, totalDuration()) };
    } catch (e) { return { error: e.message || String(e) }; }
  };
}

/** 구간에 이미 들어간 음성 (교체용) */
export function voiceClipFor(segId) {
  return voiceClips().find((v) => v.segId === segId) || null;
}

// ── 재생 중인 소리 전부 멈추기 (목소리 겹침 원천 차단) ──
//  · 브라우저 음성(speechSynthesis), 구간 음성 '듣기' 오디오, 효과음 미리듣기를 한 번에 멈춥니다.
//  · 미리보기 재생(player)과 미리듣기 버튼이 서로 겹쳐 두 목소리가 나오지 않게 항상 먼저 부릅니다.
let auditionEl = null;

export function stopAllSpeech() {
  try { if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* 무시 */ }
  if (auditionEl) {
    try { auditionEl.pause(); auditionEl.currentTime = 0; } catch (e) { /* 무시 */ }
    auditionEl = null;
  }
  try { window.dispatchEvent(new CustomEvent('reels:audition-stop')); } catch (e) { /* 무시 */ }
}

/** 구간 음성 하나를 실제 오디오로 재생 (배속 반영) */
export function playVoiceUrl(url, { volume = 1, rate = 1, onEnd = null } = {}) {
  stopAllSpeech();
  const audio = new Audio(url);
  auditionEl = audio;
  try { audio.volume = clamp(volume, 0, 1); } catch (e) { /* 무시 */ }
  try { audio.playbackRate = clamp(rate || 1, 0.5, 4); } catch (e) { /* 무시 */ }
  audio.addEventListener('ended', () => {
    if (auditionEl === audio) auditionEl = null;
    if (onEnd) { try { onEnd(); } catch (e) { /* 무시 */ } }
  }, { once: true });
  const p = audio.play();
  if (p && p.catch) p.catch(() => { if (auditionEl === audio) auditionEl = null; });
  return audio;
}

// ── 브라우저 음성 (미리듣기 전용) ───────────────────────
export function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function localVoices() {
  if (!speechSupported()) return [];
  return (window.speechSynthesis.getVoices() || []).filter((v) => /^ko(-|_|$)/i.test(v.lang) || /korean/i.test(v.name));
}

export async function previewSpeech(text, { voiceURI = '', rate = 1, pitch = 1 } = {}) {
  if (!speechSupported()) throw new Error('이 브라우저는 음성 읽기를 지원하지 않습니다.');
  const clean = String(text || '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!clean) throw new Error('읽을 자막이 없습니다.');
  stopAllSpeech();   // 다른 목소리·오디오가 켜져 있으면 먼저 끕니다(두 목소리 동시 재생 방지)
  const utter = new SpeechSynthesisUtterance(clean);
  utter.lang = 'ko-KR';
  utter.rate = clamp(rate, 0.5, 2);
  utter.pitch = clamp(pitch, 0, 2);
  const voices = localVoices();
  const match = voiceURI ? voices.find((v) => v.voiceURI === voiceURI) : voices[0];
  if (match) utter.voice = match;
  return new Promise((resolve, reject) => {
    utter.onend = () => resolve(true);
    utter.onerror = (e) => reject(new Error('음성 미리듣기 실패: ' + (e.error || 'unknown')));
    window.speechSynthesis.speak(utter);
  });
}

export function stopSpeech() {
  if (speechSupported()) window.speechSynthesis.cancel();
}

// ── 구간별 마이크 녹음 ─────────────────────────────────
export async function recordVoice({ maxSeconds = 10, onTick = () => {} } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('이 브라우저에서는 녹음을 쓸 수 없습니다. 파일로 올려 주세요.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const startedAt = performance.now();
  let stopTimer = null;

  rec.start(200);
  const tick = setInterval(() => {
    const t = (performance.now() - startedAt) / 1000;
    onTick(t, maxSeconds);
  }, 100);

  let resolveStop = null;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  rec.onstop = () => resolveStop();

  const limit = Math.max(1, Math.min(maxSeconds || 10, 30));
  stopTimer = setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} }, limit * 1000);

  return {
    stop: () => {
      clearTimeout(stopTimer);
      try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {}
    },
    done: stopped.then(() => {
      clearInterval(tick);
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const duration = (performance.now() - startedAt) / 1000;
      return { blob, duration: Math.max(0.2, Math.min(duration, limit)) };
    }),
  };
}

/** 구간 길이만큼 "컷"으로 넣기 (긴 음성은 구간 길이에 맞춰 자르지 않고 그대로 둡니다) */
export function voiceStartFor(seg) {
  return round(seg ? seg.start : state.time, 2);
}

export function voiceAssetName(seg, suffix = '음성') {
  const label = (seg && (seg.subtitle || seg.title)) ? String(seg.subtitle || seg.title).replace(/[\\/:*?"<>|]/g, '') : '';
  return label ? `${label.slice(0, 18)} ${suffix}` : suffix;
}

export function hasAsset(id) {
  return !!getAsset(id);
}
