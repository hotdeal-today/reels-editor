// captions.js — 블로그 글 하나로 5채널 캡션 만들기
//  · 블로그 URL에서 본문 긁어오기(직접 → 프록시 → 텍스트 추출 서비스 순)
//  · 본문 붙여넣기 지원
//  · 프롬프트/파서 (키 없이 무료 챗봇에 붙여넣는 방식과 공용)
//  · 키가 없어도 블로그 본문에서 바로 쓸 수 있는 '기본 캡션'을 만듭니다.
import { clamp } from './util.js';
import { normalizeBlogUrl } from './blog.js';

export { normalizeBlogUrl };

export const CAPTION_CHANNELS = [
  {
    id: 'naverClip',
    label: '네이버 클립',
    icon: '🟢',
    hint: '구어체 후킹 + 핵심 정보(가격·혜택·포인트) 2~3줄 + 유도 문구 + #오늘클립챌린지 #클립크리에이터 + 연관 키워드 3개 (해시태그 총 5개)',
    aliases: ['naverClip', 'naverclip', 'naver_clip', 'naverclip', 'naver', 'clip', '네이버클립', '네이버 클립', '클립'],
  },
  {
    id: 'instagram',
    label: '인스타그램',
    icon: '📸',
    hint: '구어체 후킹 + 핵심 정보 + 프로필 링크 유도 + 해시태그 8~12개',
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

// 네이버 클립 규격 — 고정 해시태그 2개 + 유도 문구
export const CLIP_FIXED_TAGS = ['#오늘클립챌린지', '#클립크리에이터'];
export const CLIP_CTA = '자세한 내용은 프로필 링크, 블로그 후기에서 확인할 수 있습니다.';

// ── 저장 ────────────────────────────────────────────────
export function loadCaptionState() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAPTION_STORE_KEY) || '{}');
    const out = { url: '', body: '', title: '', captions: {} };
    if (raw && typeof raw === 'object') {
      out.url = String(raw.url || '');
      out.body = String(raw.body || '');
      out.title = String(raw.title || '');
      if (raw.captions && typeof raw.captions === 'object') {
        for (const ch of CAPTION_CHANNELS) {
          if (typeof raw.captions[ch.id] === 'string') out.captions[ch.id] = raw.captions[ch.id];
        }
      }
    }
    return out;
  } catch (e) {
    return { url: '', body: '', title: '', captions: {} };
  }
}

export function saveCaptionState(patch) {
  const cur = loadCaptionState();
  const next = { ...cur, ...(patch || {}) };
  try { localStorage.setItem(CAPTION_STORE_KEY, JSON.stringify(next)); } catch (e) { /* 용량 초과 무시 */ }
  return next;
}

// ── 블로그 본문 가져오기(간단 경로) ─────────────────────
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
 * 블로그 주소에서 본문만 가져옵니다(간단 경로). 사진까지 필요하면 blog.js의 fetchBlogPost를 씁니다.
 */
export async function fetchBlogText(rawUrl, { timeout = 9000 } = {}) {
  const url = normalizeBlogUrl(rawUrl);
  if (!url) throw new Error('블로그 주소를 먼저 입력해 주세요.');

  const tries = [];
  const m = url.match(/^https?:\/\/blog\.naver\.com\/([\w.-]+)\/(\d+)/i);
  const mobile = m ? `https://m.blog.naver.com/${m[1]}/${m[2]}` : '';
  if (mobile) {
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

// ── 키워드·핵심 정보 뽑기 ───────────────────────────────
const STOPWORDS = new Set([
  '그리고', '하지만', '그래서', '이런', '그런', '저런', '정말', '너무', '많이', '조금', '여기', '저기', '오늘', '내일',
  '여행', '블로그', '포스팅', '정보', '추천', '정리', '소개', '경우', '생각', '부분', '때문', '있는', '없는', '합니다',
  '있어요', '없어요', '했어요', '같아요', '거예요', '이에요', '그거', '이거', '저거', '사진', '모두', '다시', '바로',
  '제가', '저는', '우리', '여러분', '한번', '다음', '이번', '지금', '아주', '진짜', '완전',
]);

function words(text) {
  return String(text || '')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/[^\w가-힣\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** 제목·본문·해시태그에서 연관 검색어 3개를 고릅니다. */
export function extractKeywords({ title = '', body = '', hashtags = [], n = 3 } = {}) {
  const out = [];
  const push = (raw) => {
    let w = String(raw || '').replace(/^#/, '').replace(/[^\w가-힣]/g, '').trim();
    if (!w || w.length < 2 || w.length > 12) return;
    if (STOPWORDS.has(w)) return;
    if (CLIP_FIXED_TAGS.some((t) => t.slice(1) === w)) return;
    if (out.some((x) => x === w)) return;
    out.push(w);
  };
  // ① 글에 이미 쓴 해시태그 → ② 제목의 핵심 단어 → ③ 본문 반복 단어
  for (const t of hashtags || []) push(t);
  for (const w of words(title)) push(w);
  if (out.length < n) {
    const counts = new Map();
    for (const w of words(body)) {
      if (w.length < 2 || w.length > 8 || STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    const ranked = Array.from(counts.entries()).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
    for (const [w] of ranked) { push(w); if (out.length >= n + 2) break; }
  }
  return out.slice(0, n);
}

/** 본문에서 가격·혜택·위치처럼 캡션에 쓸 만한 한 줄을 고릅니다. */
export function pickInfoLines(body, n = 3) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/#[^\s#]+/g, '').replace(/[🔻▶▼▽★☆■◆]/g, '').trim())
    .filter((l) => l.length >= 8 && l.length <= 90)
    .filter((l) => !/^https?:/.test(l));
  const scored = [];
  lines.forEach((line, i) => {
    let score = 0;
    if (/\d+\s*(원|만원|천원|%|박|일|시간|분|층|호|개|명)/.test(line)) score += 4;
    if (/(할인|무료|혜택|쿠폰|포함|조식|수영장|주차|체크인|체크아웃|예약|가격|위치|도보|역|공항|셔틀)/.test(line)) score += 3;
    if (line.length >= 12 && line.length <= 44) score += 2;
    if (line.length > 60) score -= 2;
    // 광고·유도 문구는 캡션 본문에 쓰지 않습니다.
    if (/(쿠폰 받아|아래 표|클릭|구독|공감|댓글|이웃|파트너스|수수료|제휴|링크를|바로가기|예약하기)/.test(line)) score -= 6;
    if (/!{2,}|~~/.test(line)) score -= 2;
    if (score > 0) scored.push({ line, score, i });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  const picked = [];
  const seen = new Set();
  const usedCat = new Set();
  const catOf = (line) => {
    if (/(할인|쿠폰|%)/.test(line)) return 'discount';
    if (/(원|가격|요금)/.test(line)) return 'price';
    if (/(체크인|체크아웃|오전|오후|시간|분)/.test(line)) return 'time';
    if (/(위치|도보|역|공항|거리)/.test(line)) return 'place';
    if (/(조식|수영장|주차|스파|사우나|바베큐|루프탑|라운지)/.test(line)) return 'facility';
    return '';
  };
  for (const s of scored) {
    const key = s.line.replace(/\s/g, '').slice(0, 14);
    if (seen.has(key)) continue;
    const cat = catOf(s.line);
    // 같은 종류(할인·가격·시간…) 정보가 두 줄씩 들어가지 않게
    if (cat && usedCat.has(cat) && picked.length >= 2) continue;
    seen.add(key);
    if (cat) usedCat.add(cat);
    picked.push({ line: s.line, i: s.i });
    if (picked.length >= n) break;
  }
  picked.sort((a, b) => a.i - b.i);
  return picked.map((p) => p.line);
}

function shortTitle(title, max = 26) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trim() + '…';
}

/** 제목에서 첫 줄 후킹 문구를 만듭니다 (잘린 말꼬리 없이 단어 단위로) */
function hookFromTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').replace(/[!?~]+$/, '').trim();
  if (!t) return '오늘의 블로그 후기';
  const cut = t.split(/[,·|]/)[0].trim();
  if (cut.length <= 26) return cut;
  const words = cut.split(' ');
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (test.length <= 26) line = test;
    else break;
  }
  return line || cut.slice(0, 25);
}

function casualize(text) {
  return String(text || '')
    .replace(/습니다/g, '어요')
    .replace(/입니다/g, '이에요')
    .replace(/합니다/g, '해요')
    .replace(/하세요/g, '해')
    .replace(/해요/g, '해')
    .replace(/이에요/g, '이야')
    .replace(/예요/g, '야')
    .replace(/있어요/g, '있어')
    .replace(/없어요/g, '없어')
    .trim();
}

function tagLine(tags) {
  return tags.join(' ');
}

/** 키 없이 블로그 본문만으로 만드는 5채널 캡션 */
export function buildLocalCaptions({ title = '', body = '', hashtags = [], url = '' } = {}) {
  const kw = extractKeywords({ title, body, hashtags, n: 3 });
  const fill = ['여행추천', '숙소추천', '주말여행'].filter((k) => !kw.includes(k));
  while (kw.length < 3) kw.push(fill.shift() || '여행정보');
  const clipTags = [...CLIP_FIXED_TAGS, ...kw.slice(0, 3).map((k) => `#${k}`)];
  const info = pickInfoLines(body, 3);
  const head = hookFromTitle(title);
  const infoLines = info.length ? info : ['사진으로 먼저 분위기 보고 가세요.'];
  const extraTags = [...kw.map((k) => `#${k}`), '#여행스타그램', '#국내여행', '#호캉스', '#여행기록', '#주말나들이'];

  const naverClip = [
    head,
    ...infoLines.slice(0, 3),
    '',
    CLIP_CTA,
    tagLine(clipTags),
  ].join('\n');

  const instagram = [
    `${head} ${infoLines[0] ? `— ${infoLines[0]}` : ''}`.trim(),
    '',
    ...infoLines.slice(1, 3),
    '',
    '자세한 내용은 프로필 링크에서 확인하세요 🔗',
    '',
    Array.from(new Set(extraTags)).slice(0, 10).join(' '),
  ].join('\n');

  const youtubeTitle = (title || head).replace(/\s+/g, ' ').slice(0, 35);
  const youtube = [
    youtubeTitle,
    '',
    ...infoLines.slice(0, 3),
    '',
    `전체 후기는 블로그에 정리했습니다.${url ? ' ' + url : ''}`,
    '',
    Array.from(new Set([...kw.map((k) => `#${k}`), '#여행'])).slice(0, 4).join(' '),
  ].join('\n');

  const facebook = [
    head,
    infoLines[0] || '',
    '',
    '자세한 사진과 정보는 블로그에 올려뒀어요.',
  ].filter((l) => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');

  const threads = [
    casualize(head.replace(/[!]+$/, '')),
    casualize(infoLines[0] || ''),
    casualize(infoLines[1] || ''),
    '자세한 건 블로그에 정리해뒀어',
  ].filter(Boolean).join('\n\n');

  return {
    naverClip,
    instagram,
    youtube,
    facebook,
    threads,
    keywords: kw,
  };
}

/** 네이버 클립 캡션을 규격(유도 문구 + 고정 태그 2 + 키워드 3 = 5개)에 맞춥니다. */
export function normalizeClipCaption(text, { keywords = [] } = {}) {
  const src = String(text || '').replace(/\r/g, '').trim();
  if (!src) return src;
  const lines = src.split('\n');
  const tagLines = [];
  const bodyLines = [];
  for (const line of lines) {
    const onlyTags = /^[\s#\w가-힣]+$/.test(line) && /#/.test(line) && line.replace(/#[^\s#]+/g, '').trim() === '';
    if (onlyTags) { tagLines.push(line); continue; }
    bodyLines.push(line);
  }
  const existing = (tagLines.join(' ').match(/#[^\s#]+/g) || []).map((t) => t.trim());
  const keep = [];
  for (const t of [...existing, ...keywords.map((k) => (String(k).startsWith('#') ? k : `#${k}`))]) {
    if (!t || t.length < 2) continue;
    if (CLIP_FIXED_TAGS.includes(t)) continue;
    if (keep.some((k) => k.toLowerCase() === t.toLowerCase())) continue;
    if (/^#\d+$/.test(t)) continue;
    keep.push(t);
    if (keep.length >= 3) break;
  }
  while (keep.length < 3) keep.push(['#여행', '#일상', '#추천'][keep.length] || '#추천');
  const tags = [...CLIP_FIXED_TAGS, ...keep.slice(0, 3)];

  let body = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // 유도 문구는 한 번만, 맨 끝에
  body = body.split('\n').filter((l) => l.replace(/\s/g, '') !== CLIP_CTA.replace(/\s/g, '')).join('\n').trim();
  if (!body.includes('프로필 링크')) body = `${body}\n\n${CLIP_CTA}`;
  else if (!body.endsWith(CLIP_CTA)) {
    const hasCta = body.split('\n').some((l) => l.includes('프로필 링크'));
    if (!hasCta) body = `${body}\n\n${CLIP_CTA}`;
    else body = body.replace(/[^\n]*프로필 링크[^\n]*/g, CLIP_CTA);
  }
  return `${body}\n\n${tagLine(tags)}`;
}

// ── 프롬프트 ────────────────────────────────────────────
function channelRules() {
  return [
    '1) naverClip (네이버 클립) — 인스타그램만큼 구체적이고 알차게. 아래 4단 구성:',
    '   ① 첫 줄: 스크롤을 멈추게 하는 구어체 후킹 한 줄(제목을 그대로 베끼지 말고 말하듯).',
    '   ② 2~4줄: 본문에서 뽑은 핵심 정보. 가격·할인·혜택·위치·시간·포함 내역·추천 포인트 중 실제로 본문에 있는 것 2~3가지를 짧은 줄로. 숫자와 고유명사는 본문 그대로.',
    '   ③ 마지막에 이 문장을 글자 하나 바꾸지 말고 그대로: "' + CLIP_CTA + '"',
    '   ④ 빈 줄 뒤 해시태그는 정확히 5개: #오늘클립챌린지 #클립크리에이터 두 개는 반드시 그대로 넣고, 나머지 3개는 이 글의 핵심 키워드(예: #여수라테라스 #여수호캉스 #윈터빌리지).',
    '2) instagram (인스타그램): 구어체 후킹 2~3줄 + 저장·공유하고 싶은 구체적 정보(가격·혜택·포인트) 2~3개 + 마지막에 "프로필 링크에서 자세히 확인하세요" 같은 프로필 링크 유도 한 줄 + 해시태그 8~12개(맨 아래 줄바꿔).',
    '3) youtube (유튜브 쇼츠): 첫 줄에 "제목: " 없이 호기심 유발 제목(35자 이내), 빈 줄, 설명 2~3줄(핵심 정보 포함), 마지막에 해시태그 3~5개.',
    '4) facebook (페이스북): 공감 가는 상황 + 정보 한두 개, 딱딱한 광고 문구 없이 안내 한 줄. 해시태그는 0~3개.',
    '5) threads (스레드): 반말 구어체. 3~5줄로 짧게 끊어 읽기 좋게 줄바꿈. 링크·해시태그 넣지 말고 본문만 단독으로.',
  ].join('\n');
}

export function buildCaptionPrompt(body, { url = '', title = '', keywords = [] } = {}) {
  const src = String(body || '').trim();
  const clipped = src.length > MAX_BODY_CHARS ? src.slice(0, MAX_BODY_CHARS) : src;
  const kw = (keywords && keywords.length) ? keywords : extractKeywords({ title, body: src, n: 3 });
  return [
    '너는 한국 여행·리빙·경제 블로그를 운영하는 사람의 SNS 담당자다.',
    '아래 블로그 본문 하나를 읽고, 같은 내용을 5개 채널에 맞게 다시 쓴 캡션을 만든다.',
    '',
    '[공통 규칙]',
    '- 한국어 구어체. 사람이 말하듯 쓴다. "~습니다" 남발, 번역투, AI 티 나는 광고 문구("놓치지 마세요!" 같은 상투구) 금지.',
    '- 사실은 본문에 있는 것만 쓴다. 가격·시간·위치·주의점은 본문 그대로. 없는 사실을 만들지 않는다.',
    '- 캡션은 "핵심 정보가 실제로 들어 있어야" 한다. 제목만 반복하거나 "자세한 내용은 블로그에서"로 끝내지 말고, 가격·혜택·포인트·위치 같은 구체적인 값을 2~3개 넣는다.',
    '- 이모지는 정말 필요할 때만 0~2개. 각 캡션은 그대로 복사해 붙여넣을 수 있는 완성된 글.',
    '- 서로 다른 채널이 같은 문장을 복사하지 않게, 채널마다 말투와 구성을 다르게.',
    '',
    '[채널별 규칙]',
    channelRules(),
    '',
    '[네이버 클립 해시태그]',
    `- 고정 2개: ${CLIP_FIXED_TAGS.join(' ')} (글자 그대로)`,
    `- 연관 3개 예시: ${kw.map((k) => `#${k}`).join(' ') || '#여행 #숙소추천 #주말여행'}`,
    '',
    title ? `[글 제목] ${title}` : '',
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

/**
 * AI 답변(JSON 또는 제목별 글)을 5채널 캡션 객체로 바꿉니다.
 * @param {string} raw
 * @param {{body?:string,title?:string,keywords?:string[]}} opts 네이버 클립 규격 보정용
 */
export function parseCaptions(raw, opts = {}) {
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
  // 네이버 클립은 규격(유도 문구 + 고정 태그 2 + 키워드 3)으로 맞춥니다.
  const keywords = (opts.keywords && opts.keywords.length)
    ? opts.keywords
    : extractKeywords({ title: opts.title || '', body: opts.body || '', n: 3 });
  if (out.naverClip) out.naverClip = normalizeClipCaption(out.naverClip, { keywords });
  out.keywords = keywords;
  return out;
}

/** 네이버 클립 해시태그 5개 규격 + 유도 문구를 확인합니다. */
export function checkNaverClipCaption(text) {
  const tags = String(text || '').match(/#[^\s#]+/g) || [];
  const hasChallenge = tags.some((t) => t === '#오늘클립챌린지');
  const hasCreator = tags.some((t) => t === '#클립크리에이터');
  const hasCta = String(text || '').includes('프로필 링크');
  return {
    tags: tags.length,
    hasChallenge,
    hasCreator,
    hasCta,
    ok: hasChallenge && hasCreator && tags.length === 5 && hasCta,
  };
}

export function captionCharCount(text) {
  return clamp(String(text || '').length, 0, 100000);
}
