// carousel.js — 인스타·클립용 캐러셀 이미지 카드 만들기
//  · 1번 카드: 대표 썸네일 + 제목 + 배지
//  · 이후 카드: 클립(구간)별 사진/영상 프레임 + 해당 구간 자막
//  · 모자이크 설정과 색감 보정도 그대로 반영
import { state, getAsset, clipStart, clipDur, mosaicOf } from './state.js';
import { videoFor, imageFor, seekVideo, waitVideoReady } from './media.js';
import { applyMosaic, DESIGN_W, DESIGN_H } from './render.js';
import { clamp, hexToRgba } from './util.js';

export const CAROUSEL_RATIOS = {
  '4:5': { w: 1080, h: 1350, label: '4:5 피드' },
  '9:16': { w: 1080, h: 1920, label: '9:16 세로' },
};

function filterString(adj) {
  const b = 1 + (adj?.brightness || 0) / 100;
  const c = 1 + (adj?.contrast || 0) / 100;
  const s = 1 + (adj?.saturate || 0) / 100;
  if (b === 1 && c === 1 && s === 1) return 'none';
  return `brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  return { c, ctx };
}

/** 9:16 기준으로 잡은 모자이크 위치를 카드 비율에 맞게 옮깁니다(크롭되는 만큼 같이 이동). */
function mosaicForCard(m, W, H) {
  if (!m || !m.on) return m;
  const fit = Math.max(W / DESIGN_W, H / DESIGN_H);
  const offX = (DESIGN_W * fit - W) / 2;
  const offY = (DESIGN_H * fit - H) / 2;
  const dW = (clamp(m.w ?? 100, 1, 100) / 100) * DESIGN_W;
  const dH = (clamp(m.h ?? 18, 1, 100) / 100) * DESIGN_H;
  const dX = (DESIGN_W - dW) / 2;
  const dY = (clamp(m.y ?? 76, 0, 100) / 100) * DESIGN_H - dH / 2;
  const w = dW * fit, h = dH * fit;
  const y = dY * fit - offY, x = dX * fit - offX;
  return {
    ...m,
    w: clamp((w / W) * 100, 1, 100),
    h: clamp((h / H) * 100, 1, 100),
    y: clamp(((y + h / 2) / H) * 100, 0, 100),
  };
}

/** 카드 배경: 클립 프레임을 카드 비율에 맞게 꽉 채웁니다. */
function drawCover(ctx, clip, W, H) {
  const asset = getAsset(clip.assetId);
  let src = null, sw = 0, sh = 0;
  if (clip.kind === 'video') {
    const v = videoFor(clip.assetId);
    if (v && v.readyState >= 2 && v.videoWidth) { src = v; sw = v.videoWidth; sh = v.videoHeight; }
  } else {
    const img = imageFor(clip.assetId);
    if (img && img.complete && img.naturalWidth) { src = img; sw = img.naturalWidth; sh = img.naturalHeight; }
  }
  if (!src) {
    ctx.fillStyle = asset ? '#161b22' : '#10141a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#5d6675';
    ctx.font = '600 40px "Noto Sans KR", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(asset ? '프레임 준비 중…' : '미디어를 찾을 수 없습니다', W / 2, H / 2);
    return;
  }
  const fit = Math.max(W / sw, H / sh);
  const scale = fit * ((clip.zoom || 100) / 100);
  const dw = sw * scale, dh = sh * scale;
  const dx = (W - dw) / 2 + ((clip.offsetX || 0) / 100) * W;
  const dy = (H - dh) / 2 + ((clip.offsetY || 0) / 100) * H;
  ctx.save();
  const f = filterString(clip.adjust);
  if (f !== 'none') ctx.filter = f;
  try { ctx.drawImage(src, dx, dy, dw, dh); } catch (e) { /* 프레임 미준비 */ }
  ctx.restore();
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
    cut[cut.length - 1] = cut[cut.length - 1].replace(/.{2}$/, '…');
    return cut;
  }
  return out;
}

/**
 * 프로젝트 글자 스타일(색·폰트·배경·테두리·그림자)을 그대로 써서 카드에 글자를 올립니다.
 * st: texts.title | texts.subtitle 같은 스타일 객체
 */
function drawText(ctx, st, text, { cx, cy, maxW, size, maxLines = 3, lineHeight = 1.2, centerY = true }) {
  const str = String(text || '').trim();
  if (!str) return null;
  const weight = st.weight || 800;
  const family = st.font || 'Noto Sans KR';
  let px = size;
  const fontOf = (v) => `${weight} ${v}px "${family}", "Noto Sans KR", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.font = fontOf(px);
  let lines = wrapLines(ctx, str, maxW, maxLines);
  // 한 줄이 너무 길면 글자를 줄여 가며 맞춤
  let guard = 0;
  while (lines.length > maxLines && px > 22 && guard++ < 12) {
    px *= 0.92;
    ctx.font = fontOf(px);
    lines = wrapLines(ctx, str, maxW, maxLines);
  }
  const lineH = px * lineHeight;
  let maxLineW = 0;
  for (const l of lines) maxLineW = Math.max(maxLineW, ctx.measureText(l).width);

  const bg = st.bg || {};
  const padX = bg.on ? (bg.padX || 0) : 0;
  const padY = bg.on ? (bg.padY || 0) : 0;
  const boxW = maxLineW + padX * 2;
  const boxH = lineH * lines.length + padY * 2;
  const left = cx - boxW / 2;
  const top = centerY ? cy - boxH / 2 : cy;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (bg.on) {
    ctx.globalAlpha = clamp((bg.opacity ?? 70) / 100, 0, 1);
    ctx.fillStyle = bg.color || '#000';
    const r = Math.min(bg.radius || 0, boxH / 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, top, boxW, boxH, r);
    else ctx.rect(left, top, boxW, boxH);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (st.shadow && st.shadow.on) {
    ctx.shadowColor = hexToRgba(st.shadow.color || '#000000', clamp((st.shadow.opacity ?? 50) / 100, 0, 1));
    ctx.shadowBlur = st.shadow.blur || 0;
    ctx.shadowOffsetX = st.shadow.x || 0;
    ctx.shadowOffsetY = st.shadow.y || 0;
  }
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  lines.forEach((line, i) => {
    const ly = top + padY + lineH * (i + 0.5);
    if (st.stroke && st.stroke.on && st.stroke.width > 0) {
      ctx.lineWidth = st.stroke.width * 2;
      ctx.strokeStyle = st.stroke.color || '#000';
      ctx.strokeText(line, cx, ly);
    }
    ctx.fillStyle = st.color || '#fff';
    ctx.fillText(line, cx, ly);
  });
  ctx.restore();
  return { x: left, y: top, w: boxW, h: boxH };
}

/** 글자가 잘 읽히도록 아래쪽에 어둡게 깔아 줍니다. */
function drawScrim(ctx, W, H, strength = 0.62) {
  const g = ctx.createLinearGradient(0, H * 0.42, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.55, `rgba(0,0,0,${(strength * 0.55).toFixed(3)})`);
  g.addColorStop(1, `rgba(0,0,0,${strength.toFixed(3)})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.42, W, H * 0.58);
  ctx.restore();
}

function topScrim(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.3);
  g.addColorStop(0, 'rgba(0,0,0,0.34)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H * 0.3);
  ctx.restore();
}

/** 이 클립 구간에 걸친 글자(자막 우선, 없으면 제목)를 찾습니다. */
function textForClip(clip, index) {
  const p = state.project;
  const start = clipStart(index);
  const end = start + clipDur(clip);
  const segs = p.segments || [];
  const hit = segs.find((s) => s.end > start + 0.05 && s.start < end - 0.05 && ((s.subtitle || '').trim() || (s.title || '').trim()));
  if (hit) return ((hit.subtitle || '').trim() || (hit.title || '').trim());
  return '';
}

function coverText() {
  const p = state.project;
  const segs = p.segments || [];
  const first = segs.find((s) => (s.title || '').trim()) || segs[0] || {};
  const title = (first.title || '').trim() || (p.name && p.name !== '새 릴스' ? p.name : '');
  const badge = (first.badge || '').trim();
  return { title, badge };
}

function waitImageLoad(img, timeout = 6000) {
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

async function prepareClipFrame(clip, index) {
  if (!clip) return;
  if (clip.kind !== 'video') {
    // 사진은 디코딩이 끝나야 검은 화면이 아니라 실제 사진이 찍힙니다.
    await waitImageLoad(imageFor(clip.assetId));
    return;
  }
  const v = videoFor(clip.assetId);
  if (!v) return;
  let ok = await waitVideoReady(v, 8000);
  if (!ok || v.readyState < 2) {
    // 첫 로딩이 늦으면 한 번 더 시도
    try { v.load(); } catch (e) { /* 무시 */ }
    await waitVideoReady(v, 8000);
  }
  const dur = Math.max(0.3, clipDur(clip));
  const want = clamp((clip.trimIn || 0) + Math.min(dur * 0.35, 1.2) * (clip.speed || 1), 0, Math.max(0, (v.duration || 1) - 0.05));
  await seekVideo(v, want);
}

/**
 * 캐러셀 카드 세트를 만듭니다.
 * @returns {Promise<{ratio:string,w:number,h:number,cards:Array}>}
 */
export async function buildCarousel({ ratio = '4:5', quality = 0.92, onProgress = () => {} } = {}) {
  const p = state.project;
  const clips = (p.clips || []).slice(0, 20);
  if (!clips.length) throw new Error('먼저 사진이나 영상을 추가하세요.');
  const spec = CAROUSEL_RATIOS[ratio] || CAROUSEL_RATIOS['4:5'];
  const W = spec.w, H = spec.h;
  const isWide = H / W < 1.5; // 4:5
  const cards = [];
  const titleStyle = p.texts.title;
  const badgeStyle = p.texts.badge;
  const subStyle = p.texts.subtitle;
  const scale = W / DESIGN_W;

  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }

  // 1) 대표 카드
  onProgress(0, '대표 카드');
  const first = clips[0];
  await prepareClipFrame(first, 0);
  {
    const { c, ctx } = makeCanvas(W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawCover(ctx, first, W, H);
    const m = mosaicForCard(mosaicOf(first), W, H);
    if (m.on) applyMosaic(ctx, m, 1, W, H);
    topScrim(ctx, W, H);
    drawScrim(ctx, W, H, 0.8);

    const { title, badge } = coverText();
    const titleSize = Math.round((isWide ? 78 : 84) * scale);
    const badgeSize = Math.round((isWide ? 34 : 38) * scale);
    const maxW = W * 0.84;
    const titleY = H * (isWide ? 0.63 : 0.6);
    if (badge) {
      drawText(ctx, badgeStyle, badge, {
        cx: W / 2, cy: titleY - titleSize * 0.95, maxW: maxW * 0.6, size: badgeSize, maxLines: 1,
      });
    }
    if (title) {
      drawText(ctx, titleStyle, title, { cx: W / 2, cy: titleY, maxW, size: titleSize, maxLines: 3 });
    }
    cards.push(await toCard(c, { index: 0, label: '대표', title, quality }));
  }

  // 2) 클립별 카드
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    onProgress((i + 1) / clips.length, `${i + 1}/${clips.length} 클립`);
    await prepareClipFrame(clip, i);
    const { c, ctx } = makeCanvas(W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawCover(ctx, clip, W, H);
    const m = mosaicForCard(mosaicOf(clip), W, H);
    if (m.on) applyMosaic(ctx, m, 1, W, H);

    const text = textForClip(clip, i);
    if (text) {
      drawScrim(ctx, W, H, 0.8);
      drawText(ctx, subStyle, text, {
        cx: W / 2,
        cy: H * (isWide ? 0.8 : 0.79),
        maxW: W * 0.86,
        size: Math.round((isWide ? 52 : 56) * scale),
        maxLines: 3,
      });
    }
    cards.push(await toCard(c, { index: i + 1, label: `${i + 1}번 클립`, title: text, quality }));
  }

  onProgress(1, '완료');
  return { ratio, w: W, h: H, cards };
}

function toCard(canvas, { index, label, title, quality }) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve({
        index, label, title,
        w: canvas.width, h: canvas.height,
        blob,
        url: blob ? URL.createObjectURL(blob) : '',
      });
    }, 'image/jpeg', quality);
  });
}

export function releaseCards(cards) {
  for (const c of cards || []) {
    if (c && c.url) { try { URL.revokeObjectURL(c.url); } catch (e) {} }
  }
}

export function carouselFileName(projectName, index, ratio) {
  const base = String(projectName || 'reels').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 32) || 'reels';
  const r = String(ratio || '4:5').replace(':', 'x');
  return `${base}_carousel_${r}_${String(index).padStart(2, '0')}.jpg`;
}
