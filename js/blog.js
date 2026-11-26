// blog.js — 네이버 블로그 글 하나에서 제목·본문·사진을 가져옵니다.
//  · CORS 경로를 차례로 시도합니다.
//      · 네이버: 텍스트 추출 서비스(r.jina.ai, CORS 허용)를 먼저 → 안 되면 공개 프록시들 → 직접
//      · 그 밖: 직접 → 텍스트 추출 서비스 → 프록시들
//  · 글 본문의 사진을 순서대로 뽑고, 사진 앞에 나온 문단을 그 사진의 설명으로 붙입니다.
//  · 사진은 프록시(images.weserv.nl)를 거쳐 Blob → File로 받아 오므로
//    Canvas에 그려도 tainted canvas(CORS) 오류가 나지 않습니다.

const MAX_BODY_CHARS = 9000;
const IMG_MIN_WIDTH = 620;
const IMG_MIN_HEIGHT = 300;

// 마지막으로 불러온 글(제목·사진)을 기억해 두는 곳 — 탭을 옮겨도 그대로 씁니다.
export const BLOG_STORE_KEY = 'reels.blog.v1';

export function loadBlogStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(BLOG_STORE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return {
      url: String(raw.url || ''),
      title: String(raw.title || ''),
      body: String(raw.body || ''),
      hashtags: Array.isArray(raw.hashtags) ? raw.hashtags : [],
      images: Array.isArray(raw.images) ? raw.images.filter((i) => i && i.assetId) : [],
      at: Number(raw.at) || 0,
    };
  } catch (e) {
    return null;
  }
}

export function saveBlogStore(patch) {
  const cur = loadBlogStore() || { url: '', title: '', body: '', hashtags: [], images: [], at: 0 };
  const next = { ...cur, ...(patch || {}) };
  try { localStorage.setItem(BLOG_STORE_KEY, JSON.stringify(next)); } catch (e) { /* 무시 */ }
  return next;
}

// ── 주소 정리 ────────────────────────────────────────────
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

/** blog.naver.com/{id}/{logNo} 형태인지 확인하고 id·logNo를 뽑습니다. */
export function parseNaverBlog(url) {
  const m = String(url || '').match(/blog\.naver\.com\/(?:PostView\.naver\?[^#]*?blogId=)?([\w.-]+)(?:\/(\d+)|\?[^#]*?logNo=(\d+))/i);
  if (!m) return null;
  const id = m[1];
  const logNo = m[2] || m[3];
  if (!id || !logNo) return null;
  return { id, logNo };
}

export function blogPageUrls(url) {
  const nv = parseNaverBlog(url);
  if (!nv) return [url];
  return [
    `https://m.blog.naver.com/${nv.id}/${nv.logNo}`,
    `https://blog.naver.com/PostView.naver?blogId=${nv.id}&logNo=${nv.logNo}&redirect=Dlog&widgetTypeCall=true`,
  ];
}

// ── 네트워크 ────────────────────────────────────────────
const enc = encodeURIComponent;

async function getText(href, { timeout = 10000, headers = {} } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  try {
    const res = await fetch(href, {
      mode: 'cors',
      credentials: 'omit',
      headers,
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length < 200) throw new Error('빈 응답');
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tryProxy(kind, page) {
  if (kind === 'direct') return { html: await getText(page, { timeout: 9000 }), via: '직접' };
  if (kind === 'allorigins') return { html: await getText(`https://api.allorigins.win/raw?url=${enc(page)}`, { timeout: 12000 }), via: 'allorigins' };
  if (kind === 'codetabs') return { html: await getText(`https://api.codetabs.com/v1/proxy?quest=${enc(page)}`, { timeout: 12000 }), via: 'codetabs' };
  if (kind === 'corsproxy') return { html: await getText(`https://corsproxy.io/?url=${enc(page)}`, { timeout: 12000 }), via: 'corsproxy' };
  throw new Error('알 수 없는 경로');
}

/** r.jina.ai — HTML을 그대로 받아 옵니다. (CORS 허용, 글자 추출 서비스) */
async function tryJinaHtml(page, timeout = 22000) {
  const html = await getText(`https://r.jina.ai/${page}`, { timeout, headers: { 'x-return-format': 'html' } });
  if (/<html|<body|<div/i.test(html.slice(0, 3000))) return { html, via: '텍스트 추출 서비스(HTML)' };
  return { md: html, via: '텍스트 추출 서비스' };
}

async function tryJinaMarkdown(page, timeout = 25000) {
  const md = await getText(`https://r.jina.ai/${page}`, { timeout });
  if (md && md.length > 300) return { md, via: '텍스트 추출 서비스(본문)' };
  throw new Error('본문이 비었습니다');
}

// ── 본문 정리 ───────────────────────────────────────────
function tidyLine(s) {
  return String(s || '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/[_`>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isJunkLine(s) {
  const t = String(s || '').trim();
  if (!t || t.length < 2) return true;
  if (/^[·•\-–—~=*#_]{1,}$/.test(t)) return true;
  if (/^(🔻+|▶+|▼+|▽+)$/.test(t)) return true;
  if (/^(공감|구독|댓글|이웃추가|블로그|홈|카테고리|전체보기)$/.test(t)) return true;
  if (/^https?:\/\//.test(t)) return true;
  if (/^[a-z0-9._-]+\.(com|net|co\.kr|in|me|blog|kr|io)$/i.test(t)) return true;
  if (/^copyright/i.test(t)) return true;
  if (/^(이 포스팅은|본 포스팅은).*(파트너스|제휴|수수료)/.test(t)) return true;
  // 제휴 광고·예약 유도 문구는 사진 설명·자막에서 뺍니다.
  if (/(마이리얼트립|아고다|트립닷컴|여기어때|부킹닷컴|클룩|야놀자|쿠팡).*(할인|예약|떠나|받아|최저가|쿠폰|비교)|예약하기|바로가기|할인쿠폰|최저가 보장/.test(t)) return true;
  if (/^(자세히 ?보기|상세 ?보기|더 ?보기|구매하러 ?가기)/.test(t.replace(/^[▼▶▪◆●•\s]+/, ''))) return true;
  if (/(자세히 ?보기|상세 ?보기|더 ?보기)/.test(t) && t.length <= 40) return true;
  if (/(🔻|▶|▼){2,}/.test(t)) return true;
  if (/^[💕❤🔥✨⭐🎄🎁]/u.test(t) && t.length <= 14) return true;
  return false;
}

function looksLikeHeading(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 46) return false;
  return /^(\d{1,2}[.)]\s|[①-⑳]|[▶▪◆■★☆●○■□]\s?|\d{1,2}\s*[장일화])/.test(t)
    || /^(체크인|체크아웃|위치|가격|주차|조식|수영장|객실|주변|맛집|총정리|준비물|가는 방법|예약)/.test(t);
}

function upscaleImage(url) {
  const u = String(url || '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return '';
  if (/pstatic\.net/i.test(u)) {
    // 글 본문 사진: 원본(blogfiles/postfiles)은 그대로, 썸네일 서버는 w800으로
    if (/mblogthumb-phinf|blogthumb\.pstatic/i.test(u)) return `${u.replace(/\?.*$/, '')}?type=w800`;
    if (/blogfiles|postfiles/i.test(u)) return u.replace(/\?.*$/, '');
    return u;
  }
  return u;
}

function imageToken(url) {
  const path = String(url || '').split('?')[0];
  const m = path.match(/MDAx[A-Za-z0-9_-]{20,}/);
  if (m) return m[0];
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

const PLACEHOLDER_IMG = /(제목을.?입력|입력해주세요|no.?image|placeholder|기본이미지|blank|spacer)/i;

function acceptImageUrl(url, { cls = '', w = 0, h = 0 } = {}) {
  if (!url) return false;
  if (/^data:|^blob:/i.test(url)) return false;
  if (/dthumb-phinf|blogpfthumb|static\.naver|ssl\.pstatic\.net\/static/i.test(url)) return false;
  if (/oglink|sticker|emoticon|profile|map|se-icon|se-profile/i.test(cls)) return false;
  if (w && w < IMG_MIN_WIDTH) return false;
  if (h && h < IMG_MIN_HEIGHT) return false;
  if (PLACEHOLDER_IMG.test(decodeURIComponent(url.split('?')[0]))) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return true;
}

/** HTML에서 제목·본문·사진(순서 + 사진 앞 문단) 뽑기 */
export function parseBlogHtml(html, { pageUrl = '' } = {}) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (e) {
    return null;
  }
  const meta = (prop) => {
    const el = doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
    return el ? el.getAttribute('content') || '' : '';
  };
  const pickRoot = () => {
    const cands = ['.se-main-container', '#postViewArea', '.post-view', '#postViewAreaWrap', '.entry-content', 'article', '#content'];
    let best = null;
    let bestImgs = 0;
    for (const sel of cands) {
      for (const el of doc.querySelectorAll(sel)) {
        const n = el.querySelectorAll('img').length;
        if (n > bestImgs) { best = el; bestImgs = n; }
      }
      if (best && bestImgs >= 2) break;
    }
    return best || doc.body;
  };
  const root = pickRoot();
  if (!root) return null;

  let title = tidyLine(meta('og:title') || '');
  if (!title) {
    const t = root.querySelector('.se-title-text, .se-documentTitle .se-module-text, #postTitle, .pcol1 h3, .tit_h3');
    title = tidyLine(t ? t.textContent : (doc.title || ''));
  }
  title = title.replace(/\s*[:|]\s*네이버\s*블로그\s*$/i, '').trim();

  const ogImage = upscaleImage(meta('og:image'));

  const items = [];
  const seenImg = new Set();
  const nodes = root.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, .se-quotation, img');
  let lastText = '';
  let lastPara = '';
  for (const el of nodes) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'img') {
      const cls = el.className || '';
      const lazy = el.getAttribute('data-lazy-src') || '';
      const src = lazy || el.getAttribute('src') || el.currentSrc || '';
      const w = Number(el.getAttribute('data-width') || el.getAttribute('width') || 0);
      const h = Number(el.getAttribute('data-height') || el.getAttribute('height') || 0);
      const url = upscaleImage(src);
      if (!acceptImageUrl(url, { cls, w, h })) continue;
      const key = imageToken(url);
      if (seenImg.has(key)) continue;
      seenImg.add(key);
      items.push({ type: 'img', url, caption: lastPara || lastText, section: '' });
      continue;
    }
    const text = tidyLine(el.innerText || el.textContent || '');
    if (isJunkLine(text)) continue;
    if (text === lastText) continue;
    lastText = text;
    if (!looksLikeHeading(text) && !/^\d{1,2}\.\s/.test(text)) lastPara = text;
    items.push({ type: 'text', text, heading: looksLikeHeading(text) || tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' });
  }

  const images = [];
  let section = '';
  const bodyLines = [];
  let lastCaption = '';
  for (const it of items) {
    if (it.type === 'text') {
      bodyLines.push(it.text);
      if (it.heading) section = it.text;
      continue;
    }
    const caption = tidyLine(it.caption || '');
    // 바로 앞 사진과 같은 설명이면 비워 두고 소제목을 씁니다.
    const useCaption = caption && caption !== lastCaption ? caption : '';
    if (useCaption) lastCaption = useCaption;
    images.push({
      url: it.url,
      caption: useCaption.slice(0, 70),
      section: section.slice(0, 40),
      index: images.length,
    });
  }

  let body = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '\n…(이하 생략)';
  const hashtags = Array.from(new Set((body.match(/#[^\s#]{1,20}/g) || []).map((t) => t.trim())));
  if (!images.length && ogImage) images.push({ url: ogImage, caption: '', section: '', index: 0 });

  if (!title && !body) return null;
  return {
    url: pageUrl,
    title: title || '블로그 글',
    body,
    hashtags,
    images,
    thumbnail: ogImage || (images[0] && images[0].url) || '',
    pageUrl,
  };
}

/** r.jina.ai 마크다운에서 제목·본문·사진 뽑기 (HTML을 못 받았을 때) */
export function parseBlogMarkdown(md, { pageUrl = '' } = {}) {
  const raw = String(md || '');
  if (!raw) return null;
  const titleM = raw.match(/^Title:\s*(.+)$/m);
  const start = raw.indexOf('Markdown Content:');
  const content = start >= 0 ? raw.slice(start + 'Markdown Content:'.length) : raw;
  const items = [];
  const seen = new Set();
  let lastText = '';
  let lastPara = '';
  for (const line of content.split(/\r?\n/)) {
    const imgs = Array.from(line.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g));
    if (imgs.length) {
      for (const m of imgs) {
        const url = upscaleImage(m[1]);
        if (!acceptImageUrl(url, {})) continue;
        const key = imageToken(url);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ type: 'img', url, caption: lastPara || lastText });
      }
      continue;
    }
    const text = tidyLine(line);
    if (isJunkLine(text)) continue;
    if (text === lastText) continue;
    lastText = text;
    if (!looksLikeHeading(text) && !/^\d{1,2}\.\s/.test(text)) lastPara = text;
    items.push({ type: 'text', text, heading: looksLikeHeading(text) });
  }
  const images = [];
  const lines = [];
  let section = '';
  for (const it of items) {
    if (it.type === 'text') {
      lines.push(it.text);
      if (it.heading) section = it.text;
    } else {
      images.push({ url: it.url, caption: tidyLine(it.caption).slice(0, 70), section: section.slice(0, 40), index: images.length });
    }
  }
  let body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '\n…(이하 생략)';
  const title = tidyLine((titleM && titleM[1]) || '').replace(/\s*[:|]\s*네이버\s*블로그\s*$/i, '');
  const hashtags = Array.from(new Set((body.match(/#[^\s#]{1,20}/g) || [])));
  if (!title && !body) return null;
  return {
    url: pageUrl,
    title: title || '블로그 글',
    body,
    hashtags,
    images,
    thumbnail: (images[0] && images[0].url) || '',
    pageUrl,
  };
}

// ── 사진 내려받기 (Blob → File) ──────────────────────────
const encUrl = (u) => `https://images.weserv.nl/?url=${enc(u)}&w=1080&we=1&output=jpg&q=90`;
const encUrl2 = (u) => `https://wsrv.nl/?url=${enc(u)}&w=1080&we=1&output=jpg&q=90`;

async function fetchOneImage(url, timeout = 16000) {
  // 네이버 사진 서버는 CORS를 열어 주지 않아 직접 받으면 콘솔에 오류만 남습니다 → 프록시 먼저.
  const naverImg = /pstatic\.net/i.test(url);
  const tries = naverImg ? [encUrl, encUrl2, (u) => u] : [(u) => u, encUrl, encUrl2];
  let lastErr = null;
  for (const make of tries) {
    const href = make(url);
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
      const res = await fetch(href, { mode: 'cors', credentials: 'omit', signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const blob = await res.blob();
      if (!blob || blob.size < 1500) { lastErr = new Error('너무 작은 이미지'); continue; }
      const type = (blob.type || '').startsWith('image/') ? blob.type : 'image/jpeg';
      return new Blob([blob], { type });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('사진을 받지 못했습니다.');
}

function fileNameFor(url, index) {
  const path = String(url || '').split('?')[0];
  let base = decodeURIComponent(path.split('/').pop() || 'blog');
  base = base.replace(/[^\w.\-가-힣]+/g, '_').slice(0, 40) || 'blog';
  if (!/\.(jpe?g|png|webp|gif)$/i.test(base)) base += '.jpg';
  return `blog_${String(index + 1).padStart(2, '0')}_${base}`;
}

/** 글 사진들을 File 객체로 내려받습니다. (실패한 사진은 건너뜀) */
export async function fetchBlogImages(images, { limit = 8, onProgress = () => {} } = {}) {
  const out = [];
  const list = (images || []).slice(0, Math.max(1, limit));
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    onProgress(i, list.length, img);
    try {
      const blob = await fetchOneImage(img.url);
      const file = new File([blob], fileNameFor(img.url, i), { type: blob.type });
      out.push({ ...img, file, size: blob.size });
    } catch (e) {
      // 실패한 사진은 다음 사진으로
    }
  }
  onProgress(list.length, list.length, null);
  return out;
}

// ── 글 전체 가져오기 ─────────────────────────────────────
/**
 * @returns {Promise<{url,title,body,images,thumbnail,via}>}
 */
export async function fetchBlogPost(rawUrl, { onProgress = () => {} } = {}) {
  const url = normalizeBlogUrl(rawUrl);
  if (!url) throw new Error('블로그 주소를 먼저 입력해 주세요.');
  onProgress('글을 불러오는 중…');

  const naver = !!parseNaverBlog(url);
  const pages = blogPageUrls(url);
  const order = naver
    ? ['jinaHtml', 'jinaMarkdown', 'corsproxy', 'allorigins', 'codetabs', 'direct']
    : ['direct', 'jinaHtml', 'jinaMarkdown', 'allorigins', 'codetabs', 'corsproxy'];

  const failures = [];
  for (const kind of order) {
    for (const page of pages) {
      try {
        if (kind === 'jinaHtml') {
          onProgress('텍스트 추출 서비스로 글을 불러오는 중…');
          const j = await tryJinaHtml(page);
          const parsed = j.html ? parseBlogHtml(j.html, { pageUrl: url }) : parseBlogMarkdown(j.md, { pageUrl: url });
          if (parsed && (parsed.images.length || parsed.body.length > 120)) {
            parsed.via = j.via;
            onProgress(`제목·본문·사진 ${parsed.images.length}장 확인`);
            return parsed;
          }
          failures.push(`${j.via} 본문 없음`);
          continue;
        }
        if (kind === 'jinaMarkdown') {
          onProgress('본문만 다시 받아 오는 중…');
          const j = await tryJinaMarkdown(page);
          const parsed = parseBlogMarkdown(j.md, { pageUrl: url });
          if (parsed && parsed.body.length > 120) {
            parsed.via = j.via;
            onProgress(`제목·본문·사진 ${parsed.images.length}장 확인`);
            return parsed;
          }
          continue;
        }
        onProgress('다른 경로로 다시 시도하는 중…');
        const r = await tryProxy(kind, page);
        const parsed = parseBlogHtml(r.html, { pageUrl: url });
        if (parsed && (parsed.images.length || parsed.body.length > 120)) {
          parsed.via = r.via;
          onProgress(`제목·본문·사진 ${parsed.images.length}장 확인`);
          return parsed;
        }
        failures.push(`${r.via} 본문 없음`);
      } catch (e) {
        failures.push(`${kind} ${e.message || '실패'}`);
      }
    }
  }
  const err = new Error('글을 가져오지 못했습니다. 네이버 블로그 주소를 확인하거나, 본문을 복사해 아래 칸에 붙여넣어 주세요.');
  err.detail = failures.slice(0, 6).join(' / ');
  throw err;
}

// 검증용 읽기 전용 참고
if (typeof window !== 'undefined') {
  window.__reelsBlog = { fetchBlogPost, parseBlogHtml, parseBlogMarkdown, parseNaverBlog };
}
