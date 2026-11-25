// ai.js — AI 자동 세팅 공통 로직
//  · 무료 원클릭 자동 배치 (키 없음)
//  · 무료 ChatGPT/Gemini 채팅용 프롬프트 + 결과(JSON) 붙여넣기 파싱
//  · Google AI Studio 무료 키로 Gemini 호출
import { state, totalDuration, clipDur, clipStart, persist, mixDirty, getAsset } from './state.js';
import { imageFor, videoFor, seekVideo, waitVideoReady } from './media.js';
import { DESIGN_SETS, presetById } from './presets.js';
import { uid, clamp, round } from './util.js';

// ── 설정 저장 (localStorage · 서버 전송 없음) ─────────────
export const AI_SETTINGS_KEY = 'reels.ai.v1';

export const DEFAULT_AI_SETTINGS = {
  apiKey: '',
  model: 'gemini-2.5-flash',
  ttsModel: 'gemini-2.5-flash-preview-tts',
  voice: 'Kore',
  topic: '',
  design: 'neon',
  imageDur: 2.6,
  useSfx: true,
  useName: true,
};

export function loadAiSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}');
    return { ...DEFAULT_AI_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch (e) {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function saveAiSettings(patch) {
  const next = { ...loadAiSettings(), ...(patch || {}) };
  try { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(next)); } catch (e) { console.warn(e); }
  return next;
}

/** 키는 이 브라우저에만 저장합니다. (다른 곳으로 보내지 않음) */
export function maskKey(k) {
  if (!k) return '';
  return k.length <= 8 ? '••••' : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// ── 모델 후보 ────────────────────────────────────────────
// 구글이 모델 이름을 바꿔도 동작하도록, 키로 실제 목록을 확인해 있는 것을 씁니다.
export const TEXT_MODEL_CANDIDATES = [
  'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite',
  'gemini-3.1-flash', 'gemini-3.8-flash', 'gemini-flash-latest',
];
export const TTS_MODEL_CANDIDATES = [
  'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts',
  'gemini-3.1-flash-tts-preview', 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts',
  'gemini-2.5-pro-preview-tts', 'gemini-2.5-pro-tts',
];
export const VOICES = [
  { id: 'Kore', label: 'Kore (여성 · 차분)' },
  { id: 'Aoede', label: 'Aoede (여성 · 밝음)' },
  { id: 'Leda', label: 'Leda (여성 · 젊은 톤)' },
  { id: 'Puck', label: 'Puck (남성 · 활기)' },
  { id: 'Charon', label: 'Charon (남성 · 낮은 톤)' },
  { id: 'Fenrir', label: 'Fenrir (남성 · 강조)' },
  { id: 'Orus', label: 'Orus (남성 · 안정)' },
  { id: 'Zephyr', label: 'Zephyr (중성 · 맑음)' },
];

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function apiMessage(status, bodyText) {
  let msg = '';
  try {
    const j = JSON.parse(bodyText);
    msg = j?.error?.message || '';
    const reason = (j?.error?.details || []).map((d) => d.reason).filter(Boolean).join(', ');
    if (reason) msg = msg ? `${msg} (${reason})` : reason;
  } catch (e) { msg = (bodyText || '').slice(0, 160); }
  if (status === 400 && /API key/i.test(msg)) return 'API 키가 올바르지 않습니다. aistudio.google.com/apikey 에서 키를 다시 복사해 주세요.';
  if (status === 403) return '이 키로는 호출할 수 없습니다(권한·리전 제한). 새 키를 만들어 보세요.';
  if (status === 404) return '모델을 찾을 수 없습니다. 모델 목록에서 다른 모델을 선택해 주세요.';
  if (status === 429) return '무료 사용량 한도에 걸렸습니다. 잠시(1분~하루) 뒤에 다시 시도해 주세요.';
  if (status >= 500) return 'Gemini 서버가 잠시 응답하지 않습니다. 잠시 뒤 다시 시도해 주세요.';
  return `AI 호출 실패 (${status})${msg ? ': ' + msg : ''}`;
}

/** 키로 쓸 수 있는 모델 목록을 확인합니다. */
export async function listModels(apiKey) {
  if (!apiKey) throw new Error('API 키를 먼저 입력해 주세요.');
  const res = await fetch(`${API_BASE}/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`);
  const text = await res.text();
  if (!res.ok) throw new Error(apiMessage(res.status, text));
  let json = {};
  try { json = JSON.parse(text); } catch (e) { throw new Error('모델 목록을 해석하지 못했습니다.'); }
  const ids = (json.models || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
  return ids;
}

/** 후보 중 실제로 있는 모델을 골라 줍니다. */
export function pickModels(ids, settings) {
  const has = (id) => ids.includes(id);
  const text = [settings.model, ...TEXT_MODEL_CANDIDATES].find((m) => m && has(m));
  const tts = [settings.ttsModel, ...TTS_MODEL_CANDIDATES].find((m) => m && has(m));
  return { text: text || null, tts: tts || null, ids };
}

// ── 사진/영상 → AI에 보낼 프레임 ─────────────────────────
function canvasFrame(src, maxW = 640) {
  const sw = src.videoWidth || src.naturalWidth || src.width || 0;
  const sh = src.videoHeight || src.naturalHeight || src.height || 0;
  if (!sw || !sh) return null;
  const w = Math.min(maxW, sw);
  const h = Math.max(1, Math.round((sh / sw) * w));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  try { ctx.drawImage(src, 0, 0, w, h); } catch (e) { return null; }
  const url = c.toDataURL('image/jpeg', 0.72);
  return { mimeType: 'image/jpeg', data: url.split(',')[1] || '' };
}

function waitImage(img, timeout = 4000) {
  if (!img) return Promise.resolve(false);
  if (img.complete && img.naturalWidth) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const ok = () => { if (!done) { done = true; resolve(true); } };
    img.addEventListener('load', ok, { once: true });
    img.addEventListener('error', () => { if (!done) { done = true; resolve(false); } }, { once: true });
    setTimeout(() => { if (!done) { done = true; resolve(!!(img.complete && img.naturalWidth)); } }, timeout);
  });
}

/** 지금 타임라인의 사진·영상에서 대표 프레임을 뽑습니다.
 *  · 영상은 1개당 1프레임이 아니라 길이에 맞춰 2~3프레임(시작·중간·끝)을 뽑아 내용을 더 잘 읽게 합니다.
 *  · 각 프레임에는 "영상 2 (6.0초) 3.0초 지점" 같은 설명을 붙여 Gemini가 순서를 알게 합니다.
 */
export async function collectFrames(maxFrames = 12) {
  const clips = state.project.clips || [];
  const out = [];
  if (!clips.length) return out;
  const perVideo = clips.length <= 3 ? 3 : (clips.length <= 6 ? 2 : 1);
  for (let i = 0; i < clips.length; i++) {
    if (out.length >= maxFrames) break;
    const clip = clips[i];
    const asset = getAsset(clip.assetId);
    if (!asset) continue;
    if (clip.kind === 'image') {
      const img = imageFor(clip.assetId);
      if (!(await waitImage(img))) continue;
      const f = canvasFrame(img);
      if (f) out.push({ ...f, label: `사진 ${i + 1} (${clipDur(clip).toFixed(1)}초 구간)` });
      continue;
    }
    const v = videoFor(clip.assetId);
    if (!v) continue;
    await waitVideoReady(v, 4000);
    const a = Math.max(0, Number(clip.trimIn) || 0);
    const rawOut = clip.trimOut != null ? Number(clip.trimOut) : (asset.duration || clip.srcDuration || a + 1);
    const b = Math.max(a + 0.2, rawOut);
    const span = Math.max(0.2, b - a);
    // 짧은 영상은 2프레임, 2.5초 이상은 2~3프레임, 클립이 많으면 1~2프레임
    const n = perVideo === 1 ? (span >= 4 ? 2 : 1) : (span >= 2.5 ? perVideo : Math.min(perVideo, 2));
    const fracs = n === 1 ? [0.35] : n === 2 ? [0.15, 0.8] : [0.12, 0.5, 0.88];
    for (const fn of fracs) {
      if (out.length >= maxFrames) break;
      const at = clamp(a + span * fn, a, Math.max(a, b - 0.05));
      await seekVideo(v, at);
      const f = canvasFrame(v);
      if (f) out.push({ ...f, label: `영상 ${i + 1} (${span.toFixed(1)}초) ${(at - a).toFixed(1)}초 지점` });
    }
  }
  return out;
}

export function clipSummary() {
  const clips = state.project.clips || [];
  return clips.map((c, i) => ({
    index: i + 1,
    kind: c.kind,
    length: round(clipDur(c), 1),
    name: c.name,
  }));
}

// ── 자막 박자(2~3초 간격) ──────────────────────────────
// 예나님 기준: 자막은 2~3초마다 한 줄, 0초부터 끝까지 빈틈없이.
// 4초 → 2개, 6초 → 3개, 13초 → 5~6개, 18초 → 7~9개.
export const BEAT = { min: 2.0, ideal: 2.4, max: 3.0 };

/** 전체 길이에 맞는 자막 개수(박자 수) */
export function beatCountFor(dur) {
  const d = Number(dur) || 0;
  if (d <= 0.4) return 1;
  let n = Math.round(d / BEAT.ideal);
  n = Math.max(n, Math.ceil(d / BEAT.max));
  n = Math.min(n, Math.max(1, Math.floor(d / BEAT.min)));
  return clamp(n, 1, 120);
}

/** 한 줄 자막을 단어 경계에서 두 조각으로 나눕니다(못 나누면 null). */
function splitInto2(text) {
  const str = String(text || '').trim();
  if (!str) return null;
  const words = str.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const total = words.reduce((a, w) => a + w.length, 0);
    let acc = 0;
    let cut = 1;
    let best = Infinity;
    for (let i = 1; i < words.length; i++) {
      acc += words[i - 1].length;
      const diff = Math.abs(acc * 2 - total);
      if (diff < best) { best = diff; cut = i; }
    }
    const a = words.slice(0, cut).join(' ');
    const b = words.slice(cut).join(' ');
    if (a && b) return [a, b];
  }
  const core = str.replace(/\s/g, '');
  if (core.length >= 10) {
    const mid = Math.ceil(core.length / 2);
    return [core.slice(0, mid), core.slice(mid)];
  }
  return null;
}

/**
 * 구간을 0초부터 전체 길이까지 빈틈없이 1.5~2.3초 박자로 다시 채웁니다.
 * · 이미 자막이 충분히 많으면 그대로 둡니다.
 * · 자막이 모자라면 가장 긴 자막을 단어 단위로 쪼개 개수를 채우고,
 *   경계를 전체 길이에 고르게 다시 잡습니다(클립 길이가 바뀜 뒤 눌러도 최신 totalDuration 기준).
 */
export function ensureSubtitleBeats(segs, dur) {
  const d = Math.max(0.2, Number(dur) || 0);
  const target = beatCountFor(d);
  const clean = (segs || [])
    .filter((s) => s && Number(s.end) > Number(s.start) + 0.05)
    .map((s) => ({ ...s }));
  if (!clean.length) return clean;
  const texts = clean.map((s) => String(s.subtitle || '').trim());
  if (texts.filter(Boolean).length >= target) return clean;

  const pool = texts.filter(Boolean).map((t) => ({ text: t, splits: 0 }));
  const MAX_SPLITS = 2; // 한 줄을 세 조각보더더 쪼개지 않습니다(뜯긴 단어 자막 방지)
  let guard = 0;
  while (pool.length < target && guard++ < 24) {
    let idx = -1;
    let len = 0;
    for (let i = 0; i < pool.length; i++) {
      const it = pool[i];
      if (it.splits >= MAX_SPLITS) continue;
      if (!splitInto2(it.text)) continue;
      if (it.text.length > len) { len = it.text.length; idx = i; }
    }
    if (idx < 0) break;
    const it = pool[idx];
    const parts = splitInto2(it.text);
    pool.splice(idx, 1, { text: parts[0], splits: it.splits + 1 }, { text: parts[1], splits: it.splits + 1 });
  }
  if (!pool.length) return clean;

  const n = pool.length;
  const step = d / n;
  const out = pool.map((it, i) => ({
    id: uid('seg'),
    start: round(i * step, 2),
    end: round(i === n - 1 ? d : (i + 1) * step, 2),
    title: '', badge: '', subtitle: it.text, pos: {},
  }));
  // 제목·배지는 첫 구간에만 남깁니다(중복 방지).
  out[0].title = String(clean[0].title || '').trim();
  out[0].badge = String(clean[0].badge || '').trim();
  return out;
}

/**
 * 자막이 0초~끝까지 얼마나 빈틈없이 깔렸는지 확인합니다(보고·상태 문구용).
 * count: 자막이 있는 구간 수, maxGap: 가장 큰 빈 구간(초), covered: 덮인 시간(초)
 */
export function subtitleStats(segs, dur) {
  const d = Math.max(0.1, Number(dur) || 0);
  const list = (segs || [])
    .filter((s) => String(s.subtitle || '').trim())
    .sort((a, b) => a.start - b.start);
  if (!list.length) return { count: 0, covered: 0, maxGap: round(d, 1), lastEnd: 0 };
  let covered = 0;
  let maxGap = 0;
  let prev = 0;
  for (const s of list) {
    const a = clamp(s.start, 0, d);
    const b = clamp(s.end, 0, d);
    covered += Math.max(0, b - a);
    maxGap = Math.max(maxGap, a - prev);
    prev = Math.max(prev, b);
  }
  maxGap = Math.max(maxGap, d - prev);
  return {
    count: list.length,
    covered: round(covered, 1),
    maxGap: round(maxGap, 1),
    lastEnd: round(list[list.length - 1].end, 1),
  };
}

// ── 프롬프트 ────────────────────────────────────────────
const SCHEMA = `{
  "title": "릴스 제목 (12자 이내, 후킹)",
  "badge": "배지 (6자 이내, 예: BEST · 1+1 · 무료 · 총정리)",
  "design": "neon | clean | bold 중 하나",
  "segments": [
    { "start": 0, "end": 3.0, "title": "이 구간 제목(선택)", "badge": "이 구간 배지(선택)", "subtitle": "이 구간 자막(18자 이내)", "motion": "zoomIn | zoomOut | none" }
  ],
  "hook": "마지막 클릭 유도 멘트",
  "sfx": [ { "type": "jjan | pop | swish | dingdong | ddoong | tadak | beep | shutter", "at": 0.0 } ]
}`;

function contextLine() {
  const summary = clipSummary();
  const dur = round(totalDuration(), 1);
  const lines = summary.map((c) => `${c.index}번 ${c.kind === 'video' ? '영상' : '사진'} ${c.length}초`).join(' · ');
  const beats = beatCountFor(dur);
  return `전체 길이 ${dur}초, 클립 ${summary.length}개 (${lines || '없음'}). 자막은 0초부터 ${dur}초까지 빈틈없이 2~3초 간격으로 약 ${beats}개.`;
}

export function buildPrompt(topic) {
  return [
    '너는 한국 여행·리빙 블로그 운영자가 쓰는 9:16 세로 릴스(인스타 릴스·네이버 클립) 편집자다.',
    '첨부한 사진/영상 프레임을 보고, 아래 JSON 스키마에 맞는 편집 세팅을 하나만 출력한다.',
    '',
    '[규칙]',
    '- 한국어로 쓴다. 설명·인사·코드블록 없이 JSON 객체 하나만 출력한다.',
    '- title: 12자 이내, 호기심을 자극하는 후킹 제목. 숫자·지역명을 넣으면 좋다.',
    '- badge: 6자 이내 짧은 강조 (BEST, 1+1, 무료, 총정리, 필수템 등).',
    '- segments: 전체 길이에 맞춰 2~3초 간격으로 자막을 쪼개서 만든다 (4초면 2개, 6초면 3개, 13초면 5~6개, 18초면 7~9개). start/end는 초 단위 숫자이고 0부터 시작해 전체 길이 끝까지 빈틈없이 덮는다(중간에 빈 구간을 두지 않는다).',
    '- subtitle: 시청자가 자막만 읽어도 이해되는 한 줄, 18자 이내, 구어체. 정보(가격·시간·위치·주의점)를 담는다.',
    '- 같은 자막을 두 구간에 반복하지 않는다. 영상은 시작·중간·끝 프레임을 함께 보내니 장면이 바뀌는 지점을 자막에 반영한다.',
    '- 마지막 구간의 자막은 hook과 같게 두고, hook은 "자세한 내용은 본문에서 확인하세요👇" 같은 클릭 유도 문장으로 쓴다.',
    '- motion: 사진에는 zoomIn/zoomOut을 번갈아, 영상에는 none을 권장.',
    '- sfx: 최대 5개. 첫 등장 jjan, 화면 전환 swish, 핵심 강조 pop/ddingdong 중에서 at(초)과 함께 제안.',
    '- design: 밝고 정보성인 릴스는 neon, 깔끔한 제품컷은 clean, 임팩트가 필요하면 bold.',
    '',
    '[지금 타임라인]',
    contextLine(),
    topic ? `[주제] ${topic}` : '[주제] (첨부한 사진/영상에서 추론)',
    '',
    '[출력 스키마]',
    SCHEMA,
  ].join('\n');
}

/** 채팅형 무료 AI(ChatGPT·Gemini)에 사진과 함께 붙여넣을 프롬프트 */
export function buildChatPrompt(topic) {
  return [
    '아래는 내가 만드는 9:16 세로 릴스(인스타 릴스·네이버 클립)다. 첨부한 사진/영상을 보고 편집 세팅을 JSON으로만 답해줘.',
    '',
    '[상황]',
    contextLine(),
    topic ? `[주제] ${topic}` : '[주제] 첨부한 사진을 보고 네가 추론',
    '',
    '[요청]',
    '1) 제목·배지: 첫 3초에 시선을 끄는 한국어 문구',
    '2) 구간별 자막: 0초부터 전체 길이 끝까지 빈틈없이, 2~3초 간격으로 끊어서 (4초면 2개, 6초면 3개, 13초면 5~6개, 18초면 7~9개). 각 자막은 18자 이내 구어체 한 줄, 정보 포함',
    '3) 마지막 멘트: "자세한 내용은 본문에서 확인하세요👇" 같은 클릭 유도 문장',
    '4) 효과음 추천: 종류 + 넣을 초 (jjan=짠, pop=뽕, swish=쉭, dingdong=딩동, ddoong=두둥, tadak=타닥, beep=삐, shutter=찰칵)',
    '',
    '[출력 형식] 코드블록 없이 아래 모양의 JSON 하나만. start/end는 초 단위 숫자.',
    SCHEMA,
    '',
    '※ 위 JSON만 답하면 내 편집기에 그대로 붙여넣어 자동 세팅된다.',
  ].join('\n');
}

// ── Gemini 호출 ─────────────────────────────────────────
export async function askGeminiText({ apiKey, model, prompt, temperature = 0.9, maxOutputTokens = 4096 }) {
  if (!apiKey) throw new Error('API 키를 먼저 입력해 주세요.');
  if (!model) throw new Error('모델을 먼저 확인해 주세요(연결 확인 버튼).');
  const generationConfig = { temperature, maxOutputTokens, responseMimeType: 'application/json' };
  if (/^gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(apiMessage(res.status, text));
  let json = {};
  try { json = JSON.parse(text); } catch (e) { throw new Error('AI 응답을 해석하지 못했습니다.'); }
  const cand = (json.candidates || [])[0];
  if (!cand) {
    const blocked = json.promptFeedback?.blockReason;
    throw new Error(blocked ? `AI가 요청을 거절했습니다 (${blocked}).` : 'AI가 결과를 주지 않았습니다.');
  }
  const out = (cand.content?.parts || []).map((p) => p.text || '').join('\n').trim();
  if (!out) throw new Error(`AI 응답이 비었습니다${cand.finishReason ? ` (${cand.finishReason})` : ''}.`);
  return out;
}

export async function askGemini({ apiKey, model, prompt, frames = [], temperature = 0.85 }) {
  if (!apiKey) throw new Error('API 키를 먼저 입력해 주세요.');
  if (!model) throw new Error('모델을 먼저 확인해 주세요(연결 확인 버튼).');
  const parts = [{ text: prompt }];
  for (const f of frames) {
    // 어느 클립의 어느 시점 프레임인지 붙여 주면 장면 변화를 더 잘 읽습니다.
    if (f.label) parts.push({ text: `[프레임] ${f.label}` });
    parts.push({ inline_data: { mime_type: f.mimeType, data: f.data } });
  }
  const generationConfig = { temperature, maxOutputTokens: 2048, responseMimeType: 'application/json' };
  if (/^gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(apiMessage(res.status, text));
  let json = {};
  try { json = JSON.parse(text); } catch (e) { throw new Error('AI 응답을 해석하지 못했습니다.'); }
  const cand = (json.candidates || [])[0];
  if (!cand) {
    const blocked = json.promptFeedback?.blockReason;
    throw new Error(blocked ? `AI가 요청을 거절했습니다 (${blocked}). 다른 주제로 시도해 주세요.` : 'AI가 결과를 주지 않았습니다.');
  }
  const out = (cand.content?.parts || []).map((p) => p.text || '').join('\n').trim();
  if (!out) throw new Error(`AI 응답이 비었습니다${cand.finishReason ? ` (${cand.finishReason})` : ''}.`);
  return { raw: out, plan: parsePlan(out) };
}

// ── JSON 파싱(느슨하게) ─────────────────────────────────
function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
}
function num(v) {
  if (typeof v === 'number') return v;
  const m = String(v == null ? '' : v).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== '') return obj[k];
  }
  return '';
}

const SFX_ALIAS = {
  '뽕': 'pop', '팝': 'pop', 'pop': 'pop',
  '쉭': 'swish', '스우시': 'swish', '휙': 'swish', 'swish': 'swish', 'whoosh': 'swish',
  '짠': 'jjan', '짠짝': 'jjan', 'jjan': 'jjan', 'ta-da': 'jjan', 'tada': 'jjan',
  '딩동': 'dingdong', '딩': 'dingdong', 'bell': 'dingdong', 'ding': 'dingdong', 'dingdong': 'dingdong',
  '두둥': 'ddoong', '임팩트': 'ddoong', 'boom': 'ddoong', 'ddoong': 'ddoong', 'impact': 'ddoong',
  '타닥': 'tadak', '타이핑': 'tadak', 'type': 'tadak', 'tadak': 'tadak',
  '삐': 'beep', '비프': 'beep', 'beep': 'beep',
  '찰칵': 'shutter', '셔터': 'shutter', 'shutter': 'shutter', 'click': 'shutter',
};
const KNOWN_SFX = ['pop', 'swish', 'dingdong', 'jjan', 'tadak', 'beep', 'ddoong', 'shutter'];

function mapSfxName(v) {
  const raw = clean(v).toLowerCase();
  if (!raw) return null;
  if (KNOWN_SFX.includes(raw)) return raw;
  for (const [k, id] of Object.entries(SFX_ALIAS)) {
    if (raw === k || raw.includes(k)) return id;
  }
  return null;
}

function normMotion(v) {
  const s = clean(v).toLowerCase();
  if (!s) return '';
  if (s.includes('zoom out') || s.includes('줌아웃') || s.includes('zoomout')) return 'zoomOut';
  if (s.includes('zoom') || s.includes('줌인') || s.includes('zoomin')) return 'zoomIn';
  if (s.includes('pan') || s.includes('패닝')) return 'panLR';
  if (s.includes('none') || s.includes('없음')) return 'none';
  return '';
}

export function parsePlan(raw) {
  if (!raw) throw new Error('붙여넣은 내용이 비었습니다.');
  let s = String(raw).trim();
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  s = s.replace(/,\s*([}\]])/g, '$1');
  let obj = null;
  try {
    obj = JSON.parse(s);
  } catch (e) {
    try {
      obj = JSON.parse(s.replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3').replace(/:\s*'([^']*)'/g, ': "$1"'));
    } catch (e2) {
      throw new Error('JSON을 해석하지 못했습니다. AI 답변에서 { … } 부분만 그대로 붙여넣어 주세요.');
    }
  }
  return normalizePlan(obj);
}

export function normalizePlan(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('JSON 객체가 아닙니다.');
  const src = Array.isArray(obj) ? { segments: obj } : obj;
  const plan = {
    title: clean(pick(src, ['title', '제목', 'headline', 'hookTitle', 'hook_title'])),
    badge: clean(pick(src, ['badge', '배지', 'label', 'tag'])),
    hook: clean(pick(src, ['hook', 'lastHook', 'last_hook', 'ending', 'cta', '마지막멘트', '마지막_멘트', 'hooking', '멘트', 'outro'])),
    design: clean(pick(src, ['design', '디자인', 'style', 'preset'])).toLowerCase(),
    segments: [],
    sfx: [],
  };

  let segs = src.segments || src.cuts || src.scenes || src.구간 || src.subtitles || src.captions || src.lines;
  if (typeof segs === 'string') segs = segs.split(/\n+/);
  if (!Array.isArray(segs)) segs = [];
  plan.segments = segs.map((s) => {
    if (typeof s === 'string') return { start: NaN, end: NaN, title: '', badge: '', subtitle: clean(s), motion: '' };
    return {
      start: num(pick(s, ['start', '시작', 'from', 'startTime', 'start_time', 'startSec'])),
      end: num(pick(s, ['end', '끝', 'to', 'endTime', 'end_time', 'endSec', 'duration'])),
      title: clean(pick(s, ['title', '제목', 'headline', 'text1'])),
      badge: clean(pick(s, ['badge', '배지', 'label', 'tag'])),
      subtitle: clean(pick(s, ['subtitle', '자막', 'caption', 'sub', 'text', 'line', '대사'])),
      motion: normMotion(pick(s, ['motion', '모션', 'effect', 'animation'])),
    };
  }).filter((s) => s.subtitle || s.title || s.badge);

  // duration 키만 준 경우 시작점을 이어 붙임
  if (plan.segments.length && plan.segments.every((s) => isFinite(s.end) && !isFinite(s.start))) {
    let t = 0;
    for (const s of plan.segments) { s.start = round(t, 2); t += s.end; s.end = round(t, 2); }
  }

  let sfx = src.sfx || src.effects || src.sounds || src.효과음 || src.soundEffects || [];
  if (!Array.isArray(sfx)) sfx = [];
  plan.sfx = sfx.map((x) => {
    if (typeof x === 'string') return { type: mapSfxName(x), at: NaN, volume: 80 };
    const at = num(pick(x, ['at', 't', 'time', 'timing', '위치', '초', 'start']));
    const vol = num(pick(x, ['volume', '볼륨', 'gain']));
    return { type: mapSfxName(pick(x, ['type', '종류', 'name', 'sound', '효과음', 'id'])), at, volume: isFinite(vol) ? vol : 80 };
  }).filter((x) => x.type);

  if (!plan.segments.length && !plan.title && !plan.hook) {
    throw new Error('제목·배지·자막이 하나도 없습니다. AI가 준 JSON인지 확인해 주세요.');
  }
  return plan;
}

// ── 디자인 세트 적용 ────────────────────────────────────
export function applyDesignSet(setId) {
  const set = DESIGN_SETS[setId] || DESIGN_SETS.neon;
  const p = state.project;
  const keys = [['title', set.title], ['badge', set.badge], ['subtitle', set.subtitle]];
  for (const [key, presetId] of keys) {
    const preset = presetById(presetId);
    if (!preset) continue;
    const st = p.texts[key];
    st.color = preset.style.color;
    st.bg = { ...st.bg, ...preset.style.bg };
    st.stroke = { ...st.stroke, ...preset.style.stroke };
    st.shadow = { ...st.shadow, ...preset.style.shadow };
  }
  return set;
}

// ── 컷 길이·모션·전환·효과음 자동 배치 ─────────────────
const MOTION_CYCLE = ['zoomIn', 'zoomOut', 'panLR', 'zoomIn', 'panRL', 'zoomOut'];

export function autoLayout(opts = {}) {
  const p = state.project;
  const clips = p.clips || [];
  if (!clips.length) throw new Error('먼저 사진이나 영상을 추가하세요.');
  const s = { ...loadAiSettings(), ...(opts || {}) };
  const imageDur = clamp(Number(s.imageDur) || 2.6, 1, 8);

  // 1) 컷 길이 — 영상은 예나님이 넣은 길이 그대로 둡니다(예전에 4.2초로 잘려 13초 영상이 4초짜리가 되던 문제 제거).
  clips.forEach((c, i) => {
    if (c.kind === 'image') {
      c.duration = imageDur;
    } else {
      const src = c.srcDuration || clipDur(c) || 1;
      c.trimIn = clamp(c.trimIn || 0, 0, Math.max(0, src - 0.4));
      const out = c.trimOut == null ? src : c.trimOut;
      c.trimOut = clamp(out, c.trimIn + 0.3, src);
      c.muted = false;
    }
    c.motion = c.motion && c.motion !== 'none' && !opts.forceMotion ? c.motion : MOTION_CYCLE[i % MOTION_CYCLE.length];
    c.transition = i === 0 ? 'cut' : 'fade';
  });

  const dur = totalDuration();

  // 2) 자막 박자 — 클립 개수가 아니라 전체 길이 기준 1.5~2.3초 간격, 0초부터 끝까지 빈틈없이
  const beats = beatCountFor(dur);
  const step = dur / Math.max(1, beats);
  const name = clean(p.name);
  const titleName = s.useName === false ? '' : (name && name !== '새 릴스' ? name : '');
  const topic = clean(s.topic);
  const hookText = '자세한 내용은 본문에서 확인하세요👇';

  // 자막에 쓸 수 있는 내 레이블 글(프로젝트 이름·주제) — 없는 내용을 지어내지 않습니다.
  const seed = [];
  if (titleName || (name && name !== '새 릴스')) seed.push(name);
  if (topic && topic !== name) seed.push(topic);
  seed.push(hookText);

  const segsBuild = Array.from({ length: Math.max(1, beats) }, (_, i) => ({
    id: uid('seg'),
    start: round(i * step, 2),
    end: round(i === beats - 1 ? dur : (i + 1) * step, 2),
    title: '', badge: '', subtitle: '', pos: {},
  }));
  // 첫 칸은 제목, 마지막 칸은 후킹 멘트로 시작하고, 나머지는 위 글을 순서대로 나눠 채웁니다.
  segsBuild[0].title = titleName;
  segsBuild[0].badge = titleName ? 'BEST' : '';
  const slots = segsBuild.length;
  if (slots === 1) {
    segsBuild[0].subtitle = (seed[0] || hookText).slice(0, 24);
  } else {
    seed.forEach((txt, i) => {
      const idx = i === seed.length - 1 ? slots - 1 : Math.min(i, slots - 2);
      if (!segsBuild[idx].subtitle) segsBuild[idx].subtitle = String(txt).slice(0, 24);
    });
  }
  p.segments = ensureSubtitleBeats(segsBuild, dur);
  p.segments.sort((a, b) => a.start - b.start);

  // 3) 디자인
  applyDesignSet(s.design || 'neon');

  // 4) 효과음
  if (s.useSfx !== false) {
    const list = [];
    list.push({ id: uid('sfx'), key: 'jjan', t: 0, volume: 85 });
    const hookStart = Math.max(0.4, dur - Math.max(0.4, dur / Math.max(1, p.segments.length)));
    for (let i = 1; i < p.segments.length; i++) {
      const t = round(p.segments[i].start, 2);
      if (t > 0.1 && t < hookStart) list.push({ id: uid('sfx'), key: 'swish', t, volume: 70 });
    }
    if (hookStart > 0.2) list.push({ id: uid('sfx'), key: 'pop', t: round(p.segments[p.segments.length - 1].start, 2), volume: 90 });
    p.audio.sfx = list.sort((a, b) => a.t - b.t);
  }

  mixDirty();
  if (!p.segments.some((sg) => sg.id === state.sel.segment)) state.sel.segment = p.segments[0].id;
  return {
    clips: clips.length,
    segments: p.segments.length,
    sfx: (p.audio.sfx || []).length,
    design: (DESIGN_SETS[s.design] || DESIGN_SETS.neon).label,
    duration: round(dur, 1),
    subtitles: subtitleStats(p.segments, totalDuration()),
  };
}

// ── AI/붙여넣기 결과를 타임라인에 적용 ──────────────────
export function applyPlan(plan, opts = {}) {
  const p = state.project;
  const clips = p.clips || [];
  if (!clips.length) throw new Error('먼저 사진이나 영상을 추가하세요.');
  const dur = totalDuration();
  if (dur < 0.3) throw new Error('클립 길이가 너무 짧습니다.');

  const list = plan.segments || [];

  // 1) 시간 계산
  let bounds = [];
  const timesOk = list.length && list.every((s) => isFinite(s.start) && isFinite(s.end) && s.end > s.start);
  if (timesOk) {
    bounds = list.map((s) => ({ start: s.start, end: s.end }));
  } else if (list.length === clips.length) {
    bounds = clips.map((c, i) => ({ start: clipStart(i), end: clipStart(i) + clipDur(c) }));
  } else if (list.length) {
    const step = dur / list.length;
    bounds = list.map((s, i) => ({ start: i * step, end: (i + 1) * step }));
  } else {
    bounds = clips.map((c, i) => ({ start: clipStart(i), end: clipStart(i) + clipDur(c) }));
  }

  // AI가 가정한 전체 길이가 다르면 비율로 맞춤
  const planDur = Math.max(...bounds.map((b) => b.end));
  if (isFinite(planDur) && planDur > 0 && Math.abs(planDur - dur) > Math.max(0.5, dur * 0.08)) {
    const k = dur / planDur;
    bounds = bounds.map((b) => ({ start: b.start * k, end: b.end * k }));
  }

  const segs = bounds.map((b, i) => {
    const src = list[i] || {};
    const start = round(clamp(b.start, 0, Math.max(0, dur - 0.25)), 2);
    const end = round(clamp(b.end, start + 0.25, dur), 2);
    return {
      id: uid('seg'), start, end,
      title: src.title || '',
      badge: src.badge || '',
      subtitle: src.subtitle || '',
      pos: {},
    };
  }).filter((sg) => sg.end > sg.start + 0.05);
  if (!segs.length) throw new Error('적용할 구간을 만들지 못했습니다.');
  segs.sort((a, b) => a.start - b.start);

  // 빈틈 없이 이어 붙이기 (앞 구간 끝 = 다음 구간 시작)
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i].end < segs[i + 1].start) segs[i].end = segs[i + 1].start;
    if (segs[i].end > segs[i + 1].start) segs[i].end = Math.max(segs[i].start + 0.25, segs[i + 1].start);
  }
  segs[0].start = 0;
  segs[segs.length - 1].end = round(dur, 2);

  // 2) 제목·배지
  if (plan.title) segs[0].title = plan.title;
  if (plan.badge) segs[0].badge = plan.badge;

  // 3) 마지막 후킹 멘트 — 기존 자막을 지우지 않고 자리를 만들어 넣습니다.
  if (plan.hook) {
    const last = segs[segs.length - 1];
    const norm = (t) => String(t || '').replace(/\s+/g, '');
    const hookKey = norm(plan.hook).slice(0, 14);
    const already = [last.title, last.badge, last.subtitle].some((t) => norm(t) && norm(t).includes(hookKey));
    if (already) {
      // AI가 이미 마지막 구간에 후킹 멘트를 넣은 경우 그대로 둡니다.
    } else if (!last.title) {
      last.title = plan.hook;
    } else if (!last.subtitle) {
      last.subtitle = plan.hook;
    } else {
      // 제목·자막이 둘 다 있으면 후킹용 짧은 구간을 뒤에 붙임
      const len = last.end - last.start;
      if (len > 1.2) {
        const cut = round(last.end - Math.min(2.0, Math.max(0.9, len * 0.4)), 2);
        if (cut > last.start + 0.3) {
          const tail = { id: uid('seg'), start: cut, end: last.end, title: '', badge: '', subtitle: plan.hook, pos: {} };
          last.end = cut;
          segs.push(tail);
        } else {
          last.badge = last.badge || plan.hook;
        }
      } else {
        last.badge = last.badge || plan.hook;
      }
    }
  } else if (!segs[segs.length - 1].subtitle && !segs[segs.length - 1].title) {
    segs[segs.length - 1].subtitle = '자세한 내용은 본문에서 확인하세요👇';
  }

  segs.sort((a, b) => a.start - b.start);
  // 3-2) 최신 전체 길이 기준으로 0초~끝까지 1.5~2.3초 박자를 보장 (자막이 모자라면 자동 분할)
  const durNow = totalDuration();
  let finalSegs = ensureSubtitleBeats(segs, durNow);
  if (!finalSegs.length) finalSegs = segs;
  finalSegs.sort((a, b) => a.start - b.start);
  finalSegs[0].start = 0;
  finalSegs[finalSegs.length - 1].end = round(durNow, 2);
  p.segments = finalSegs;

  // 4) 모션·전환 (구간 수와 클립 수가 같을 때만 1:1 대응)
  if (segs.length === clips.length) {
    segs.forEach((sg, i) => {
      const src = list[i] || {};
      const clip = clips[i];
      if (src.motion) clip.motion = src.motion;
      else if (!clip.motion || clip.motion === 'none') clip.motion = MOTION_CYCLE[i % MOTION_CYCLE.length];
      clip.transition = i === 0 ? 'cut' : 'fade';
    });
  } else {
    clips.forEach((c, i) => {
      if (!c.motion || c.motion === 'none') c.motion = MOTION_CYCLE[i % MOTION_CYCLE.length];
      c.transition = i === 0 ? 'cut' : 'fade';
    });
  }

  // 5) 효과음
  if (plan.sfx && plan.sfx.length) {
    const items = plan.sfx.map((x, i) => ({
      id: uid('sfx'),
      key: x.type,
      t: round(clamp(isFinite(x.at) ? x.at : dur * (i / Math.max(1, plan.sfx.length)), 0, Math.max(0, dur - 0.05)), 2),
      volume: clamp(isFinite(x.volume) ? x.volume : 80, 0, 150),
    })).filter((x) => KNOWN_SFX.includes(x.key));
    if (items.length) p.audio.sfx = items.sort((a, b) => a.t - b.t);
  }

  // 6) 디자인 세트
  if (plan.design && DESIGN_SETS[plan.design]) applyDesignSet(plan.design);

  mixDirty();
  if (!p.segments.some((sg) => sg.id === state.sel.segment)) state.sel.segment = p.segments[0].id;
  persist();
  return {
    segments: p.segments.length,
    sfx: (p.audio.sfx || []).length,
    title: plan.title,
    hook: plan.hook,
    subtitles: subtitleStats(p.segments, durNow),
  };
}

// 검증용 읽기 전용 참고 (콘솔·자동 테스트에서 현재 로직 확인)
if (typeof window !== 'undefined') {
  window.__reelsAi = { collectFrames, buildPrompt, buildChatPrompt, applyPlan, autoLayout, ensureSubtitleBeats, beatCountFor, parsePlan };
}
