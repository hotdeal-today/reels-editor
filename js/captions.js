// captions.js — 블로그 글 하나로 5채널 캡션 만들기
//  · 블로그 URL에서 본문 긁어오기 시도(직접 → 무료 텍스트 추출 서비스 순)
//  · 본문 붙여넣기 지원
//  · 프롬프트/파서 (키 없이 무료 챗봇에 붙여넣는 방식과 공용)
import { clamp } from './util.js';

export const CAPTION_CHANNELS = [
  {
    id: 'naverClip',
    label: '네이버 클립',
    icon: '🟢',
    hint: '구어체 후킹 + #오늘클립챌린지 #클립크리에이터 + 연관 키워드 3개 (해시태그 총 5개)',
    aliases: ['naverClip', 'naverclip', 'naver_clip', 'naverclip', 'naver', 'clip', '네이버클립', '네이버 클립', '클립'],
  },
  {
    id: 'instagram',
    label: '인스타그램',
    icon: '📸',
    hint: '구어체 후킹 + 프로필 링크 유도 + 해시태그',
    aliases: ['instagram', 'insta', 'ig', '인스타', '인스타그램'],
  },
  {
    id: 'youtube',
    label: '유튜브 쇼츠',
    icon: '▶️',
    hint: '호기심 유발 제목 + 설명 + 해시태그',
    aliases: ['youtube', 'shorts', 'youtubeShorts', 'yt', '유튜브', '유튜브쇼츠', '유튜브 쇼츠', '쇼츠'],
  },
  {
    id: 'facebook',
    label: '페이스북',
    icon: '📘',
    hint: '공감·정보 후킹 + 짧은 안내',
    aliases: ['facebook', 'fb', '페이스북'],
  },
  {
    id: 'threads',
    label: '스레드',
    icon: '🧵',
    hint: '반말 구어체 후킹 + 가독성 줄바꿈 + 링크 없이 단독 본문',
    aliases: ['threads', 'thread', '스레드'],
  },
];

export const CAPTION_STORE_KEY = 'reels.captions.v1';
const MAX_BODY_CHARS = 9000;

// ── 저장 ────────────────────────────────────────────────
export function loadCaptionState() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAPTION_STORE_KEY) || '{}');
    const out = { url: '', body: '', captions: {} };
    if (raw && typeof raw === 'object') {
      out.url = String(raw.url || '');
      out.body = String(raw.body || '');
      if (raw.captions && typeof raw.captions === 'object') {
        for (const ch of CAPTION_CHANNELS) {
          if (typeof raw.captions[ch.id] === 'string') out.captions[ch.id] = raw.captions[ch.id];
        }
      }
    }
    return out;
  } catch (e) {
    return { url: '', body: '', captions: {} };
  }
}

export function saveCaptionState(patch) {
  const cur = loadCaptionState();
  const next = { ...cur, ...(patch || {}) };
  try { localStorage.setItem(CAPTION_STORE_KEY, JSON.stringify(next)); } catch (e) { /* 용량 초과 무시 */ }
  return next;
}

// ── 블로그 본문 가져오기 ─────────────────────────────────
export function normalizeBlogUrl(input) {
  let u = String(input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch (e) {
    return '';
  }
}

function looksLikeHtml(s) {
  return /<(html|body|div|p|article|section)\b/i.test(s.slice(0, 4000));
}

function tidyMarkdown(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // 이미지
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // 링크 → 글자만
    .replace(/^[ \t]*[-*+][ \t]+/gm, '· ')            // 목록
    .replace(/^#{1,6}[ \t]*/gm, '')                   // 제목 기호
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
}

/** HTML 또는 마크다운에서 읽을 만한 본문만 뽑습니다. */
export function extractReadableText(raw) {
  let text = String(raw || '');
  if (!text) return '';
  if (looksLikeHtml(text)) {
    try {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      doc.querySelectorAll('script,style,noscript,iframe,svg,header,footer,nav,form').forEach((n) => n.remove());
      const main = doc.querySelector('#postViewArea, .se-main-container, .se_component_wrap, article, main, .post-view, #content')
        || doc.body;
      text = main ? (main.innerText || main.textContent || '') : '';
    } catch (e) {
      text = text.replace(/<[^>]+>/g, ' ');
    }
  } else {
    text = tidyMarkdown(text);
  }
  // jina 리더가 붙이는 머리말 정리
  text = text.replace(/^Title:\s*/m, '').replace(/^URL Source:\s*\S+/m, '').replace(/^Published Time:\s*.*$/m, '');
  text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > MAX_BODY_CHARS) text = text.slice(0, MAX_BODY_CHARS) + '\n…(이하 생략)';
  return text;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('시간 초과')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * 블로그 주소에서 본문을 가져옵니다. 여러 경로를 차례로 시도합니다.
 * 1) 주소로 직접 요청(공개·CORS 허용 블로그)
 * 2) 네이버면 모바일 주소(m.blog.naver.com)도 시도
 * 3) 무료 텍스트 추출 서비스(r.jina.ai) · 공개 프록시(allorigins)
 */
export async function fetchBlogText(rawUrl, { timeout = 9000 } = {}) {
  const url = normalizeBlogUrl(rawUrl);
  if (!url) throw new Error('블로그 주소를 먼저 입력해 주세요.');

  const tries = [];
  const m = url.match(/^https?:\/\/blog\.naver\.com\/([\w.-]+)\/(\d+)/i);
  const mobile = m ? `https://m.blog.naver.com/${m[1]}/${m[2]}` : '';
  if (mobile) {
    // 네이버 블로그는 브라우저 직접 요청이 CORS로 막히므로 텍스트 추출 서비스를 먼저 씁니다.
    tries.push({ href: `https://r.jina.ai/${mobile}`, via: '텍스트 추출 서비스' });
    tries.push({ href: `https://r.jina.ai/${url}`, via: '텍스트 추출 서비스' });
    tries.push({ href: `https://api.allorigins.win/raw?url=${encodeURIComponent(mobile)}`, via: '공개 프록시' });
  } else {
    tries.push({ href: url, via: '직접' });
    tries.push({ href: `https://r.jina.ai/${url}`, via: '텍스트 추출 서비스' });
    tries.push({ href: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, via: '공개 프록시' });
  }

  const failures = [];
  for (const t of tries) {
    try {
      const res = await withTimeout(fetch(t.href, { mode: 'cors', credentials: 'omit' }), timeout);
      if (!res.ok) { failures.push(`${t.via} ${res.status}`); continue; }
      const raw = await res.text();
      const text = extractReadableText(raw);
      if (text.length < 80) { failures.push(`${t.via} 본문 없음`); continue; }
      return { url, text, via: t.via };
    } catch (e) {
      failures.push(`${t.via} ${e.message || '실패'}`);
    }
  }
  const err = new Error('블로그 주소에서 본문을 가져오지 못했습니다. 네이버 블로그는 브라우저에서 직접 열람이 막혀 있는 경우가 많아요. 블로그 앱·PC에서 본문을 복사해 아래 칸에 붙여넣어 주세요.');
  err.detail = failures.join(' / ');
  throw err;
}

// ── 프롬프트 ────────────────────────────────────────────
function channelRules() {
  return [
    '1) naverClip (네이버 클립): 첫 줄은 스크롤을 멈추게 하는 구어체 후킹 한 줄. 2~3줄로 핵심 정보. 빈 줄 뒤 해시태그는 정확히 5개 — #오늘클립챌린지 #클립크리에이터 두 개는 반드시 그대로 넣고, 나머지 3개는 이 글 주제와 실제로 연관된 키워드.',
    '2) instagram (인스타그램): 구어체 후킹 2~3줄 + 저장·공유하고 싶은 정보 + 마지막에 "프로필 링크에서 자세히 확인하세요" 같은 프로필 링크 유도 한 줄 + 해시태그 8~12개(맨 아래 줄바꿔).',
    '3) youtube (유튜브 쇼츠): 첫 줄에 "제목: " 없이 호기심 유발 제목(35자 이내), 빈 줄, 설명 2~3줄, 마지막에 해시태그 3~5개.',
    '4) facebook (페이스북): 공감 가는 상황 + 정보 한두 개, 딱딱한 광고 문구 없이 안내 한 줄. 해시태그는 0~3개.',
    '5) threads (스레드): 반말 구어체. 3~5줄로 짧게 끊어 읽기 좋게 줄바꿈. 링크·해시태그 넣지 말고 본문만 단독으로.',
  ].join('\n');
}

export function buildCaptionPrompt(body, { url = '' } = {}) {
  const src = String(body || '').trim();
  const clipped = src.length > MAX_BODY_CHARS ? src.slice(0, MAX_BODY_CHARS) : src;
  return [
    '너는 한국 여행·리빙·경제 블로그를 운영하는 사람의 SNS 담당자다.',
    '아래 블로그 본문 하나를 읽고, 같은 내용을 5개 채널에 맞게 다시 쓴 캡션을 만든다.',
    '',
    '[공통 규칙]',
    '- 한국어 구어체. 사람이 말하듯 쓴다. "~습니다" 남발, 번역투, AI 티 나는 광고 문구("놓치지 마세요!" 같은 상투구) 금지.',
    '- 사실은 본문에 있는 것만 쓴다. 가격·시간·위치·주의점은 본문 그대로. 없는 사실을 만들지 않는다.',
    '- 이모지는 정말 필요할 때만 0~2개. 각 캡션은 그대로 복사해 붙여넣을 수 있는 완성된 글.',
    '- 서로 다른 채널이 같은 문장을 복사하지 않게, 채널마다 말투와 구성을 다르게.',
    '',
    '[채널별 규칙]',
    channelRules(),
    '',
    url ? `[블로그 주소] ${url}` : '',
    '[블로그 본문]',
    clipped || '(본문 없음)',
    '',
    '[출력] 설명 없이 아래 JSON 하나만. 각 값은 줄바꿈(\\n)을 넣은 하나의 문자열.',
    '{"naverClip":"...","instagram":"...","youtube":"...","facebook":"...","threads":"..."}',
  ].filter(Boolean).join('\n');
}

// ── 파싱 ────────────────────────────────────────────────
function stripFence(s) {
  let t = String(s || '').trim();
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  return t;
}

function looseJson(t) {
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let s = t.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch (e) { /* 다음 시도 */ }
  try {
    return JSON.parse(s.replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3').replace(/:\s*'([^']*)'/g, ': "$1"'));
  } catch (e) { return null; }
}

function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\r/g, '').trim();
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    const title = toText(v.title || v.제목 || '');
    const desc = toText(v.description || v.desc || v.body || v.본문 || v.caption || v.text || '');
    if (title && desc && !desc.startsWith(title)) return `${title}\n\n${desc}`;
    if (title || desc) return title || desc;
    return Object.values(v).map(toText).filter(Boolean).join('\n');
  }
  return String(v);
}

function pickByAliases(obj, aliases) {
  if (!obj || typeof obj !== 'object') return '';
  const keys = Object.keys(obj);
  for (const a of aliases) {
    const k = keys.find((key) => key.toLowerCase().replace(/[\s_-]/g, '') === a.toLowerCase().replace(/[\s_-]/g, ''));
    if (k) {
      const v = toText(obj[k]);
      if (v) return v;
    }
  }
  return '';
}

/** 제목 줄로 나눈 답변도 받아 줍니다. (§ 네이버 클립 / ## 인스타그램 …) */
function splitByHeadings(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  const head = /^\s*(?:[#*>\-\s]*)(?:\d[).]?\s*)?(?:\[?)(네이버\s*클립|클립|인스타그램|인스타|유튜브\s*쇼츠|유튜브|쇼츠|페이스북|페북|스레드)(?:\]?)\s*[:\-–]?\s*(.*)$/i;
  let cur = null;
  const bucket = {};
  for (const line of lines) {
    const m = line.match(head);
    if (m && (line.length < 40 || /[:\-–]\s*$/.test(line) || /^[#*\s]/.test(line))) {
      const label = m[1].replace(/\s+/g, '');
      cur = /네이버|클립/.test(label) ? 'naverClip'
        : /인스타/.test(label) ? 'instagram'
          : /유튜브|쇼츠/.test(label) ? 'youtube'
            : /페/.test(label) ? 'facebook'
              : /스레드/.test(label) ? 'threads' : cur;
      bucket[cur] = m[2] ? [m[2]] : [];
      continue;
    }
    if (cur) bucket[cur].push(line);
  }
  for (const [k, arr] of Object.entries(bucket)) {
    const v = arr.join('\n').replace(/^[\s:]+|[\s]+$/g, '');
    if (v) out[k] = v;
  }
  return out;
}

/** AI 답변(JSON 또는 제목별 글)을 5채널 캡션 객체로 바꿉니다. */
export function parseCaptions(raw) {
  const text = stripFence(raw);
  if (!text) throw new Error('붙여넣은 내용이 비었습니다.');
  const out = {};
  let obj = looseJson(text);
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) obj = obj.reduce((acc, it, i) => {
      const id = CAPTION_CHANNELS[i] && CAPTION_CHANNELS[i].id;
      if (id) acc[id] = it;
      return acc;
    }, {});
    const inner = obj.captions || obj.caption || obj.channels || obj.result || obj;
    for (const ch of CAPTION_CHANNELS) {
      const v = pickByAliases(inner, ch.aliases);
      if (v) out[ch.id] = v;
    }
  }
  const missing = CAPTION_CHANNELS.filter((ch) => !out[ch.id]);
  if (missing.length === CAPTION_CHANNELS.length) {
    const byHead = splitByHeadings(text);
    Object.assign(out, byHead);
  } else if (missing.length) {
    const byHead = splitByHeadings(text);
    for (const ch of missing) if (byHead[ch.id]) out[ch.id] = byHead[ch.id];
  }
  const filled = CAPTION_CHANNELS.filter((ch) => (out[ch.id] || '').trim());
  if (!filled.length) {
    throw new Error('5개 채널 캡션을 찾지 못했습니다. AI 답변 전체를 그대로 붙여넣어 주세요(JSON 또는 채널별 제목).');
  }
  for (const ch of CAPTION_CHANNELS) {
    if (out[ch.id]) out[ch.id] = String(out[ch.id]).replace(/\n{3,}/g, '\n\n').trim();
  }
  return out;
}

/** 네이버 클립 해시태그 5개 규격을 확인해 줍니다. */
export function checkNaverClipCaption(text) {
  const tags = String(text || '').match(/#[^\s#]+/g) || [];
  const hasChallenge = tags.some((t) => t === '#오늘클립챌린지');
  const hasCreator = tags.some((t) => t === '#클립크리에이터');
  return { tags: tags.length, hasChallenge, hasCreator, ok: hasChallenge && hasCreator && tags.length >= 5 };
}

export function captionCharCount(text) {
  return clamp(String(text || '').length, 0, 100000);
}
