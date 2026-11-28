// gemini.js — Gemini 설정 저장 · 모델 목록 · 목소리 목록
//  (ai.js 와 narration.js 가 함께 쓰는 공통 부분. 화면 코드는 없습니다.)
export const AI_SETTINGS_KEY = 'reels.ai.v1';

export const DEFAULT_AI_SETTINGS = {
  apiKey: '',
  model: 'gemini-2.5-flash',
  ttsModel: 'gemini-2.5-flash-preview-tts',
  voice: 'Kore',
  topic: '',
  design: 'neon',
  imageDur: 2.6,
  tempo: 'steady',   // steady(2~3초) | ref(1.2~1.8초 · 레퍼런스 실측)
  copyLines: '',     // 원클릭 카피 틀(줄 단위). 비우면 기본 틀
  useSfx: true,
  useName: true,
  // 원클릭·붙여넣기·Gemini 세팅 뒤 자막과 1:1로 나레이션(TTS)까지 만들지
  ttsAuto: true,
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

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function apiMessage(status, bodyText) {
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
