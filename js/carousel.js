// carousel.js — 캐러셀 카드 만들기 + 카드별 편집(문구·위치·크기·색·사진)
//  · 1번 카드: 대표(제목 + 부제)
//  · 2~N번 카드: 블로그 사진 또는 타임라인의 서로 다른 장면
//  · 카드마다 제목/부제·세로 위치·글자 크기·글자색·강조 바 색·사진(교체·확대·위치)을 저장하고
//    그대로 다시 그려 JPG/ZIP으로 내보냅니다.
import {
  state, getAsset, clipStart, clipDur, totalDuration, locate, activeSegment, mosaicOf, persist,
} from './state.js';
import { videoFor, imageFor, seekVideo, waitVideoReady } from './media.js';
import { applyMosaic, DESIGN_W, DESIGN_H } from './render.js';
import { clamp, uid, hexToRgba, fmtSec } from './util.js';

export const CAROUSEL_RATIOS = {
  '4:5': { w: 1080, h: 1350, label: '4:5 피드' },
  '9:16': { w: 1080, h: 1920, label: '9:16 세로' },
};

export const CAROUSEL_COUNTS = [4, 5, 6];
export const CAROUSEL_DEFAULT_COUNT = 5;

export const CARD_POSITIONS = [
  { id: 'top', label: '상단', y: 16 },
  { id: 'middle', label: '중앙', y: 50 },
  { id: 'bottom', label: '하단', y: 82 },
];

export const TEXT_SWATCHES = ['#ffffff', '#fff3b0', '#ffd84d', '#9be7c4', '#a9d4ff', '#ffb3c7', '#111418', '#ff5f6d'];
export const ACCENT_SWATCHES = ['#0b0d12', '#ffd84d', '#ff5f6d', '#45d483', '#3b82f6', '#ffffff', '#7c5cff', '#ff9f1c'];

const TITLE_WEIGHT = 800;
const SUB_WEIGHT = 600;

// ── 카드 모델 ────────────────────────────────────────────
export function defaultCardStyle() {
  return {
    pos: 'bottom',
    y: 82,                 // 글자 묶음의 세로 중심 (%)
    size: 66,              // 제목 글자 크기(1080폭 기준 px)
    subSize: 40,           // 부제 글자 크기
    color: '#ffffff',
    accent: '#0b0d12',     // 강조 바(배경 박스) 색
    accentOn: true,
  };
}

export function makeCard(partial = {}) {
  return {
    id: partial.id || uid('card'),
    role: partial.role || 'scene',
    source: partial.source || 'photo',   // photo | timeline
    assetId: partial.assetId || '',
    t: Number(partial.t) || 0,
    clipIndex: Number(partial.clipIndex) || 0,
    title: String(partial.title || ''),
    subtitle: String(partial.subtitle || ''),
    label: String(partial.label || ''),
    style: { ...defaultCardStyle(), ...(partial.style || {}) },
    crop: { zoom: 100, x: 0, y: 0, ...(partial.crop || {}) },
  };
}

export function getCarousel() {
  const p = state.project;
  if (!p || !p.carousel || !Array.isArray(p.carousel.cards) || !p.carousel.cards.length) return null;
  return p.carousel;
}

export function saveCarousel({ ratio = '4:5', cards = [] }) {
  if (!state.project) return null;
  state.project.carousel = {
    ratio,
    cards: cards.map((c) => ({
      id: c.id, role: c.role, source: c.source, assetId: c.assetId, t: c.t, clipIndex: c.clipIndex,
      title: c.title, subtitle: c.subtitle, label: c.label, style: { ...c.style }, crop: { ...c.crop },
    })),
    updatedAt: Date.now(),
  };
  persist();
  return state.project.carousel;
}

export function clearCarousel() {
  if (!state.project) return;
  delete state.project.carousel;
  persist();
}

export function findCard(cards, id) {
  return (cards || []).find((c) => c.id === id) || null;
}

/** 카드 문구·스타일·사진 설정만 patch 합니다(그리기는 renderCard). */
export function patchCard(cards, id, patch = {}) {
  const card = findCard(cards, id);
  if (!card) return null;
  if (patch.title != null) card.title = String(patch.title);
  if (patch.subtitle != null) card.subtitle = String(patch.subtitle);
  if (patch.assetId != null) { card.assetId = patch.assetId; card.source = 'photo'; }
  if (patch.t != null) card.t = Number(patch.t);
  if (patch.style) card.style = { ...card.style, ...patch.style };
  if (patch.crop) card.crop = { ...card.crop, ...patch.crop };
  return card;
}

/** 대표 카드는 항상 1번(맨 앞) */
export function normalizeCards(cards) {
  const list = (cards || []).filter(Boolean).map((c, i) => makeCard({ ...c, role: i === 0 ? 'cover' : 'scene' }));
  if (list[0]) list[0].role = 'cover';
  return list;
}

// ── 글자·장면 읽기 도우미 ────────────────────────────────
function segmentTexts(t) {
  const seg = activeSegment(t);
  if (!seg) return { title: '', subtitle: '' };
  const title = String(seg.title || '').trim();
  const subtitle = String(seg.subtitle || '').trim();
  if (title && subtitle) return { title, subtitle };
  if (subtitle) return { title: subtitle, subtitle: '' };
  if (title) return { title, subtitle: '' };
  return { title: String(seg.badge || '').trim(), subtitle: '' };
}

function coverTexts() {
  const p = state.project;
  const segs = p.segments || [];
  const first = segs.find((s) => (s.title || '').trim()) || segs[0] || {};
  const title = (first.title || '').trim() || (p.name && p.name !== '새 릴스' ? p.name : '');
  const badge = (first.badge || '').trim();
  return { title, badge };
}

function trimTo(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trim() + '…';
}

/** 타임라인에서 서로 다른 장면을 골라 카드 목록을 만듭니다. (그리기 전 단계) */
export function planCarouselMoments(count) {
  const p = state.project;
  const clips = (p.clips || []).slice(0, 40);
  const want = clamp(Math.round(Number(count) || CAROUSEL_DEFAULT_COUNT), 2, 10);
  if (!clips.length) return { moments: [], requested: want, available: 0, limited: false, notice: '' };

  const total = totalDuration();
  const first = clips[0];
  const firstDur = clipDur(first);
  const coverLocal = clamp(firstDur * 0.35, 0, Math.max(0.01, Math.min(1.2, firstDur - 0.05)));
  const cover = { clipIndex: 0, clip: first, local: coverLocal, t: clipStart(0) + coverLocal };
  const need = Math.max(0, want - 1);

  const usedTimes = [cover.t];
  const usedKeys = new Set([`${first.assetId}:${coverLocal.toFixed(1)}`]);
  const usedPhotoAssets = new Set();
  if (first.kind === 'image') usedPhotoAssets.add(first.assetId);

  const cands = [];
  clips.forEach((clip, i) => {
    const start = clipStart(i);
    const dur = clipDur(clip);
    if (clip.kind === 'image') {
      cands.push({ clipIndex: i, clip, local: dur / 2, t: start + dur / 2, photo: true, assetId: clip.assetId });
      return;
    }
    const fracs = [0.08, 0.22, 0.36, 0.5, 0.64, 0.78, 0.92];
    for (const f of fracs) {
      const local = clamp(dur * f, 0.04, Math.max(0.05, dur - 0.05));
      cands.push({ clipIndex: i, clip, local, t: start + local, photo: false, assetId: clip.assetId });
    }
  });

  const minSep = clamp(total / Math.max(2, want) / 3.2, 0.25, 1.1);
  const hasText = (t) => {
    const sg = activeSegment(t);
    return !!(sg && ((sg.subtitle || '').trim() || (sg.title || '').trim()));
  };

  const picked = [];
  for (let k = 1; k <= need; k++) {
    const target = total * ((k + 0.5) / want);
    const usable = (relaxed) => cands.filter((c) => {
      if (usedKeys.has(`${c.assetId}:${c.local.toFixed(1)}`)) return false;
      if (c.photo && usedPhotoAssets.has(c.assetId)) return false;
      if (!relaxed && usedTimes.some((t) => Math.abs(t - c.t) < minSep)) return false;
      if (relaxed && usedTimes.some((t) => Math.abs(t - c.t) < 0.12)) return false;
      return true;
    });
    let pool = usable(false);
    if (!pool.length) pool = usable(true);
    if (!pool.length) break;
    let best = null;
    let bestCost = Infinity;
    for (const c of pool) {
      const cost = Math.abs(c.t - target) * (hasText(c.t) ? 0.72 : 1);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    if (!best) break;
    picked.push(best);
    usedKeys.add(`${best.assetId}:${best.local.toFixed(1)}`);
    usedTimes.push(best.t);
    if (best.photo) usedPhotoAssets.add(best.assetId);
  }

  const available = picked.length + 1;
  const limited = available < want;
  let notice = '';
  if (limited) {
    const photoCount = clips.filter((c) => c.kind === 'image').length;
    const hasVideo = clips.some((c) => c.kind === 'video');
    if (!hasVideo && photoCount) {
      notice = `서로 다른 사진이 ${available}장뿐이라 ${available}장으로 만들었습니다. 사진을 더 넣으면 4~6장을 채울 수 있어요.`;
    } else if (photoCount) {
      notice = `서로 다른 장면이 ${available}개뿐이라 ${available}장으로 만들었습니다(같은 사진은 두 번 넣지 않았습니다).`;
    } else {
      notice = `${available}장으로 만들었습니다.`;
    }
  }
  return { moments: picked, requested: want, available, limited, notice, cover };
}

/** 현재 타임라인 → 카드 목록 */
export function cardsFromTimeline({ count = CAROUSEL_DEFAULT_COUNT } = {}) {
  const plan = planCarouselMoments(count);
  const cover = plan.cover;
  if (!cover) return { cards: [], limited: false, notice: '' };
  const ct = coverTexts();
  const coverSeg = segmentTexts(cover.t);
  const cards = [
    makeCard({
      role: 'cover',
      source: 'timeline',
      t: cover.t,
      clipIndex: cover.clipIndex,
      title: trimTo(ct.title || coverSeg.title || '오늘의 추천', 30),
      subtitle: trimTo(ct.badge || coverSeg.subtitle || '', 40),
      label: '대표',
      style: { ...defaultCardStyle(), y: 74 },
    }),
  ];
  for (const mo of plan.moments) {
    const st = segmentTexts(mo.t);
    cards.push(makeCard({
      role: 'scene',
      source: 'timeline',
      t: mo.t,
      clipIndex: mo.clipIndex,
      title: trimTo(st.title, 34),
      subtitle: trimTo(st.subtitle, 48),
      label: `${fmtSec(mo.t)} 지점`,
    }));
  }
  return { cards, limited: plan.limited, notice: plan.notice };
}

function cleanSectionName(s) {
  return String(s || '').replace(/^\d{1,2}[.)]\s*/, '').replace(/\s+/g, ' ').trim();
}

function captionParts(caption) {
  return String(caption || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?~])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const CARD_FILLER = /(달라질 수 있|경우가 있|수 있습니다|좋답니다|추천합니다|생각합니다|같습니다|정도입니다)$/;

/** 카드 제목으로 쓰기 좋은 머리말 (설명이 빈말이면 소제목으로) */
function cardHead(text, section) {
  const t = String(text || '').replace(/[.!?~]+$/, '').trim();
  if (t && t.length >= 6 && !CARD_FILLER.test(t)) return t;
  return cleanSectionName(section) || t;
}

/** 대표 카드 제목 — 단어 단위로 24자 이내 */
function coverHeadline(title) {
  const t = String(title || '').replace(/\s+/g, ' ').replace(/[!?~]+$/, '').trim();
  if (!t) return '오늘의 추천';
  const first = t.split(/[,·|]/)[0].trim();
  if (first.length <= 24) return first;
  let line = '';
  for (const w of first.split(' ')) {
    const test = line ? `${line} ${w}` : w;
    if (test.length <= 24) line = test;
    else break;
  }
  return line || first.slice(0, 23);
}

/** 블로그 사진 목록 → 카드 목록 (대표 포함) */
export function cardsFromImages({ images = [], title = '', count = CAROUSEL_DEFAULT_COUNT } = {}) {
  const pool = (images || []).filter((it) => it && it.assetId);
  if (!pool.length) return { cards: [], limited: true, notice: '사진을 불러오지 못해 카드를 만들 수 없습니다.' };
  const want = clamp(Math.round(Number(count) || CAROUSEL_DEFAULT_COUNT), 2, 10);
  const cards = [];
  const cover = pool[0];
  const coverParts = captionParts(cover.caption);
  cards.push(makeCard({
    role: 'cover',
    source: 'photo',
    assetId: cover.assetId,
    title: coverHeadline(title || coverParts[0] || '오늘의 추천'),
    subtitle: trimTo(coverParts.slice(1).join(' ') || cleanSectionName(cover.section), 46),
    label: '대표',
    style: { ...defaultCardStyle(), y: 76, size: 62 },
  }));
  for (let i = 1; i < pool.length && cards.length < want; i++) {
    const it = pool[i];
    const parts = captionParts(it.caption);
    const head = cardHead(parts[0] || '', it.section) || '';
    const rest = parts.slice(1).join(' ').trim();
    cards.push(makeCard({
      role: 'scene',
      source: 'photo',
      assetId: it.assetId,
      title: trimTo(head, 32),
      subtitle: trimTo(rest === head || CARD_FILLER.test(rest.replace(/[.!?~]+$/, '')) ? '' : rest, 44),
      label: `사진 ${i + 1}`,
    }));
  }
  const limited = cards.length < want;
  return {
    cards,
    limited,
    notice: limited ? `사진이 ${pool.length}장이라 ${cards.length}장으로 만들었습니다.` : '',
  };
}

/** 현재 프로젝트의 사진(클립) 목록 — 카드 사진 교체용 */
export function projectPhotos() {
  const out = [];
  const seen = new Set();
  const clips = state.project ? state.project.clips || [] : [];
  clips.forEach((c, i) => {
    if (c.kind !== 'image' || !c.assetId || seen.has(c.assetId)) return;
    seen.add(c.assetId);
    const asset = getAsset(c.assetId);
    out.push({ assetId: c.assetId, name: (asset && asset.name) || `사진 ${i + 1}`, thumb: (asset && asset.thumb) || '' });
  });
  return out;
}

/** 카드 하나를 더 붙입니다(아직 안 쓴 사진을 먼저). */
export function addCardFromPool(cards) {
  const list = cards || [];
  const used = new Set(list.map((c) => c.assetId).filter(Boolean));
  const pool = projectPhotos();
  const next = pool.find((p) => !used.has(p.assetId));
  const base = list[list.length - 1];
  const card = makeCard({
    source: next ? 'photo' : (base ? base.source : 'photo'),
    assetId: next ? next.assetId : (base ? base.assetId : ''),
    t: base ? base.t : 0,
    clipIndex: base ? base.clipIndex : 0,
    title: next ? '' : '새 카드',
    subtitle: '',
    label: next ? next.name : '새 카드',
    style: base ? { ...base.style } : undefined,
    crop: base ? { ...base.crop } : undefined,
  });
  list.push(card);
  return card;
}

export function removeCardById(cards, id) {
  const idx = (cards || []).findIndex((c) => c.id === id);
  if (idx < 0) return false;
  cards.splice(idx, 1);
  return true;
}

// ── 그리기 ──────────────────────────────────────────────
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  return { c, ctx };
}

function specFor(ratio) {
  return CAROUSEL_RATIOS[ratio] || CAROUSEL_RATIOS['4:5'];
}

function wrapLines(ctx, text, maxW, maxLines) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width <= maxW || !line) line = test;
      else { out.push(line); line = w; }
    }
    if (line) out.push(line);
  }
  if (maxLines && out.length > maxLines) {
    const cut = out.slice(0, maxLines);
    cut[cut.length - 1] = cut[cut.length - 1].replace(/.{1,2}$/, '…');
    return cut;
  }
  return out;
}

function waitImageLoad(img, timeout = 7000) {
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

async function prepareTimelineFrame(clip, local) {
  if (!clip) return false;
  if (clip.kind !== 'video') return waitImageLoad(imageFor(clip.assetId));
  const v = videoFor(clip.assetId);
  if (!v) return false;
  let ok = await waitVideoReady(v, 8000);
  if (!ok || v.readyState < 2) {
    try { v.load(); } catch (e) { /* 무시 */ }
    await waitVideoReady(v, 8000);
  }
  const dur = Math.max(0.1, clipDur(clip));
  const want = clamp((clip.trimIn || 0) + clamp(local, 0, dur) * (clip.speed || 1), 0, Math.max(0, (v.duration || 1) - 0.05));
  await seekVideo(v, want);
  return true;
}

/** 사진 한 장을 카드 비율에 꽉 차게(cover) 그리고, 카드의 확대·위치를 적용합니다. */
function drawPhotoCover(ctx, W, H, img, crop = {}, clip = null) {
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  if (!sw || !sh) return false;
  const zoom = clamp(Number(crop.zoom) || 100, 100, 300) / 100;
  const fit = Math.max(W / sw, H / sh);
  const scale = fit * zoom * ((clip && clip.zoom ? clip.zoom : 100) / 100);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (W - dw) / 2 + ((Number(crop.x) || 0) / 100) * W;
  const dy = (H - dh) / 2 + ((Number(crop.y) || 0) / 100) * H;
  ctx.save();
  if (clip && clip.adjust) {
    const b = 1 + (clip.adjust.brightness || 0) / 100;
    const c = 1 + (clip.adjust.contrast || 0) / 100;
    const s = 1 + (clip.adjust.saturate || 0) / 100;
    if (b !== 1 || c !== 1 || s !== 1) ctx.filter = `brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`;
  }
  try { ctx.drawImage(img, dx, dy, dw, dh); } catch (e) { /* 프레임 미준비 */ }
  ctx.restore();
  return true;
}

function drawScrim(ctx, W, H, yPct) {
  if (yPct >= 58) {
    const g = ctx.createLinearGradient(0, H * 0.34, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.34)');
    g.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.34, W, H * 0.66);
    ctx.restore();
    return;
  }
  if (yPct <= 40) {
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0.6)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.26)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H * 0.62);
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function fontOf(family, weight, px) {
  return `${weight} ${px}px "${family || 'Noto Sans KR'}", "Noto Sans KR", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
}

/** 카드 글자(제목 + 부제)를 그립니다. */
function drawCardText(ctx, W, H, card) {
  const st = { ...defaultCardStyle(), ...(card.style || {}) };
  const scale = W / DESIGN_W;
  const titleSize = clamp(Number(st.size) || 66, 20, 150) * scale;
  const subSize = clamp(Number(st.subSize) || 40, 12, 110) * scale;
  const title = String(card.title || '').trim();
  const subtitle = String(card.subtitle || '').trim();
  if (!title && !subtitle) return;

  const base = (state.project && state.project.texts && state.project.texts.title) || {};
  const subBase = (state.project && state.project.texts && state.project.texts.subtitle) || {};
  const titleFamily = base.font || 'Noto Sans KR';
  const subFamily = subBase.font || titleFamily;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontOf(titleFamily, TITLE_WEIGHT, titleSize);
  const maxW = W * 0.84;
  let titleLines = wrapLines(ctx, title, maxW, 3);
  let guard = 0;
  let tpx = titleSize;
  while (titleLines.length > 3 && tpx > 24 * scale && guard++ < 10) {
    tpx *= 0.9;
    ctx.font = fontOf(titleFamily, TITLE_WEIGHT, tpx);
    titleLines = wrapLines(ctx, title, maxW, 3);
  }
  ctx.font = fontOf(subFamily, SUB_WEIGHT, subSize);
  let subLines = subtitle ? wrapLines(ctx, subtitle, W * 0.86, 3) : [];
  guard = 0;
  let spx = subSize;
  while (subLines.length > 3 && spx > 16 * scale && guard++ < 10) {
    spx *= 0.9;
    ctx.font = fontOf(subFamily, SUB_WEIGHT, spx);
    subLines = wrapLines(ctx, subtitle, W * 0.86, 3);
  }

  const titleH = titleLines.length * tpx * 1.16;
  const subH = subLines.length ? subLines.length * spx * 1.3 : 0;
  const gap = titleLines.length && subLines.length ? 12 * scale : 0;
  const blockH = titleH + gap + subH;
  const centerY = (clamp(Number(st.y) || 82, 4, 96) / 100) * H;
  let blockTop = centerY - blockH / 2;
  blockTop = clamp(blockTop, 18 * scale, H - blockH - 18 * scale);

  // 강조 바(배경 박스)
  if (st.accentOn) {
    ctx.font = fontOf(titleFamily, TITLE_WEIGHT, tpx);
    let maxLineW = 0;
    for (const l of titleLines) maxLineW = Math.max(maxLineW, ctx.measureText(l).width);
    ctx.font = fontOf(subFamily, SUB_WEIGHT, spx);
    for (const l of subLines) maxLineW = Math.max(maxLineW, ctx.measureText(l).width);
    const padX = 30 * scale;
    const padY = 24 * scale;
    const boxW = Math.min(W - 40 * scale, maxLineW + padX * 2);
    const boxH = blockH + padY * 2;
    const left = (W - boxW) / 2;
    const top = blockTop - padY;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = st.accent || '#0b0d12';
    const r = 20 * scale;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, top, boxW, boxH, r);
    else ctx.rect(left, top, boxW, boxH);
    ctx.fill();
    ctx.restore();
  }

  // 그림자
  const sh = (base.shadow && base.shadow.on !== false) ? base.shadow : { on: true, color: '#000000', opacity: 55, x: 0, y: 4, blur: 12 };
  ctx.shadowColor = hexToRgba(sh.color || '#000000', clamp((sh.opacity ?? 55) / 100, 0, 1));
  ctx.shadowBlur = (sh.blur || 0) * scale;
  ctx.shadowOffsetX = (sh.x || 0) * scale;
  ctx.shadowOffsetY = (sh.y || 0) * scale;

  ctx.font = fontOf(titleFamily, TITLE_WEIGHT, tpx);
  ctx.fillStyle = st.color || '#ffffff';
  titleLines.forEach((line, i) => {
    const y = blockTop + tpx * 1.16 * (i + 0.5);
    ctx.fillText(line, W / 2, y);
  });
  if (subLines.length) {
    ctx.font = fontOf(subFamily, SUB_WEIGHT, spx);
    ctx.fillStyle = hexToRgba(st.color || '#ffffff', 0.92);
    const subTop = blockTop + titleH + gap;
    subLines.forEach((line, i) => {
      ctx.fillText(line, W / 2, subTop + spx * 1.3 * (i + 0.5));
    });
  }
  ctx.restore();
}

function toBlob(canvas, quality = 0.92) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

/** 카드 한 장을 실제 이미지(blob)로 그립니다. */
export async function renderCard(card, { ratio = '4:5', quality = 0.92 } = {}) {
  const spec = specFor(ratio);
  const W = spec.w;
  const H = spec.h;
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* 무시 */ } }

  let img = null;
  let clip = null;
  if (card.source === 'timeline') {
    const clips = (state.project.clips || []).slice(0, 40);
    const total = totalDuration();
    const tt = clamp(Number(card.t) || 0, 0, Math.max(0, total - 0.05));
    const loc = locate(tt) || (clips[0] ? { index: 0, clip: clips[0], local: 0 } : null);
    if (loc) {
      card.t = tt;
      card.clipIndex = loc.index;
      clip = loc.clip;
      await prepareTimelineFrame(clip, loc.local);
    }
  }
  if (clip && clip.kind === 'image') img = imageFor(clip.assetId);
  if (clip && clip.kind === 'video') img = videoFor(clip.assetId);
  if (card.source === 'photo') {
    if (!card.assetId && card.clipIndex != null) {
      const c = (state.project.clips || [])[card.clipIndex];
      if (c) card.assetId = c.assetId;
    }
    img = imageFor(card.assetId);
    await waitImageLoad(img);
  }

  const { c, ctx } = makeCanvas(W, H);
  ctx.fillStyle = '#101319';
  ctx.fillRect(0, 0, W, H);

  let drew = false;
  if (img) {
    const usable = card.source === 'photo' ? (img.naturalWidth || img.width) : true;
    if (usable) drew = drawPhotoCover(ctx, W, H, img, card.crop || {}, clip);
  }
  if (!drew) {
    const assetName = card.source === 'photo' ? getAsset(card.assetId) : getAsset(clip && clip.assetId);
    ctx.fillStyle = '#5d6675';
    ctx.font = fontOf('Noto Sans KR', 600, 34);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(assetName ? '사진을 불러오는 중…' : '사진을 찾지 못했습니다', W / 2, H / 2);
  } else {
    if (clip) {
      const m = mosaicOf(clip);
      if (m && m.on) applyMosaic(ctx, mosaicForCard(m, W, H), 1, W, H);
    }
    drawScrim(ctx, W, H, clamp(Number(card.style && card.style.y) || 82, 4, 96));
  }
  drawCardText(ctx, W, H, card);

  const blob = await toBlob(c, quality);
  return {
    ...card,
    w: W,
    h: H,
    blob,
    url: blob ? URL.createObjectURL(blob) : '',
  };
}

/** 9:16 기준 모자이크 위치를 카드 비율에 맞게 옮깁니다. */
function mosaicForCard(m, W, H) {
  if (!m || !m.on) return m;
  const dW = (clamp(Number(m.w != null ? m.w : 68), 1, 100) / 100) * DESIGN_W;
  const dH = (clamp(Number(m.h != null ? m.h : 9), 1, 100) / 100) * DESIGN_H;
  const dX = (clamp(Number(m.x != null ? m.x : 50), 0, 100) / 100) * DESIGN_W - dW / 2;
  const dY = (clamp(Number(m.y != null ? m.y : 78), 0, 100) / 100) * DESIGN_H - dH / 2;
  const fit = Math.max(W / DESIGN_W, H / DESIGN_H);
  const offX = (DESIGN_W * fit - W) / 2;
  const offY = (DESIGN_H * fit - H) / 2;
  const w = dW * fit, h = dH * fit;
  const x = dX * fit - offX;
  const y = dY * fit - offY;
  return {
    ...m,
    x: clamp(((x + w / 2) / W) * 100, 0, 100),
    y: clamp(((y + h / 2) / H) * 100, 0, 100),
    w: clamp((w / W) * 100, 1, 100),
    h: clamp((h / H) * 100, 1, 100),
  };
}

/** 카드 목록을 모두 그립니다. */
export async function renderCards(cards, { ratio = '4:5', quality = 0.92, onProgress = () => {} } = {}) {
  const out = [];
  for (let i = 0; i < (cards || []).length; i++) {
    onProgress(i / Math.max(1, cards.length), `카드 ${i + 1}/${cards.length}`);
    const runtime = await renderCard(cards[i], { ratio, quality });
    out.push(runtime);
  }
  onProgress(1, '완료');
  return out;
}

/** 카드 서명 — 같은 설정이면 다시 그리지 않습니다. */
export function cardSignature(cards, ratio) {
  return JSON.stringify({
    ratio,
    cards: (cards || []).map((c) => ({
      id: c.id, role: c.role, source: c.source, assetId: c.assetId, t: Math.round((c.t || 0) * 100) / 100,
      title: c.title, subtitle: c.subtitle, style: c.style, crop: c.crop,
    })),
  });
}

export function releaseCards(cards) {
  for (const c of cards || []) {
    if (c && c.url) { try { URL.revokeObjectURL(c.url); } catch (e) { /* 무시 */ } }
  }
}

export function carouselFileName(projectName, index, ratio) {
  const base = String(projectName || 'reels').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 32) || 'reels';
  const r = String(ratio || '4:5').replace(':', 'x');
  return `${base}_carousel_${r}_${String(index).padStart(2, '0')}.jpg`;
}

export function cardTitleForList(card, index) {
  const t = String(card.title || '').trim();
  return t || (index === 0 ? '대표 카드' : `카드 ${index + 1}`);
}

// ── 예전 이름 호환 ──────────────────────────────────────
export async function buildCarousel({ ratio = '4:5', count = CAROUSEL_DEFAULT_COUNT, quality = 0.92, onProgress = () => {} } = {}) {
  const made = cardsFromTimeline({ count });
  const cards = await renderCards(made.cards, { ratio, quality, onProgress });
  return { ratio, w: specFor(ratio).w, h: specFor(ratio).h, cards, requested: count, limited: made.limited, notice: made.notice };
}

// 검증용 읽기 전용 참고 (콘솔·자동 테스트에서 현재 로직 확인)
if (typeof window !== 'undefined') {
  window.__reelsCarousel = {
    planCarouselMoments, cardsFromTimeline, cardsFromImages, renderCard, renderCards, getCarousel, saveCarousel,
  };
}
