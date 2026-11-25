// render.js — 9:16 프레임 합성 (미리보기·내보내기 공용)
import { state, getAsset, locate, clipDur, mosaicOf } from './state.js';
import { videoFor, imageFor } from './media.js';
import { clamp, hexToRgba } from './util.js';

export const DESIGN_W = 1080;
export const DESIGN_H = 1920;
const FADE = 0.45;
let lastRects = [];
let guideOn = false;

/** 미리보기에서 모자이크 영역 가이드(점선)를 보여줄지 */
export function setMosaicGuide(v) { guideOn = !!v; }
export function getMosaicGuide() { return guideOn; }

// 픽셀 모자이크용 임시 캔버스 (프레임마다 새로 만들지 않도록 재사용)
const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d');

/** 모자이크 설정(백분율)을 1080×1920 좌표계 사각형으로 바꿉니다. */
export function mosaicRect(m, designW = DESIGN_W, designH = DESIGN_H) {
  const w = clamp(Number(m && m.w != null ? m.w : 100), 1, 100) / 100 * designW;
  const h = clamp(Number(m && m.h != null ? m.h : 18), 1, 100) / 100 * designH;
  const cy = clamp(Number(m && m.y != null ? m.y : 76), 0, 100) / 100 * designH;
  return { x: (designW - w) / 2, y: cy - h / 2, w, h };
}

/**
 * 지금 그려져 있는 프레임의 일부 영역만 픽셀 모자이크(+살짝 블러)로 덮습니다.
 * 기존 영상·사진에 이미 박혀 있는 외국 자막을 가릴 때 사용합니다.
 */
export function applyMosaic(ctx, m, alpha = 1, designW = DESIGN_W, designH = DESIGN_H) {
  if (!m || !m.on) return;
  const canvas = ctx.canvas;
  if (!canvas || !canvas.width || !canvas.height) return;
  const r = mosaicRect(m, designW, designH);
  const step = clamp(Number(m.strength) || 18, 4, 80);
  const blur = clamp(Number(m.blur) || 0, 0, 12);
  const bw = Math.max(1, Math.round(r.w / step));
  const bh = Math.max(1, Math.round(r.h / step));
  const sx = canvas.width / designW;
  const sy = canvas.height / designH;

  if (scratch.width !== bw || scratch.height !== bh) {
    scratch.width = bw;
    scratch.height = bh;
  }
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.imageSmoothingEnabled = false;
  sctx.clearRect(0, 0, bw, bh);
  try {
    sctx.drawImage(canvas, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, bw, bh);
  } catch (e) { return; }

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.imageSmoothingEnabled = false;
  if (blur > 0) ctx.filter = `blur(${blur}px)`;
  try { ctx.drawImage(scratch, 0, 0, bw, bh, r.x, r.y, r.w, r.h); } catch (e) { /* 무시 */ }
  ctx.restore();
}

function drawMosaicGuide(ctx) {
  const p = state.project;
  if (!p) return;
  const loc = locate(state.time);
  const clip = (loc && loc.clip) || p.clips[0];
  const m = mosaicOf(clip);
  if (!m.on) return;
  const r = mosaicRect(m);
  ctx.save();
  ctx.setLineDash([18, 14]);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,216,77,.95)';
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  ctx.font = '700 30px "Noto Sans KR", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,216,77,.95)';
  ctx.fillText('모자이크', r.x + 10, r.y - 10);
  ctx.restore();
}

export function prepareCtx(ctx, w, h) {
  ctx.setTransform(w / DESIGN_W, 0, 0, h / DESIGN_H, 0, 0);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rr); return; }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function filterString(adj) {
  const b = 1 + (adj?.brightness || 0) / 100;
  const c = 1 + (adj?.contrast || 0) / 100;
  const s = 1 + (adj?.saturate || 0) / 100;
  if (b === 1 && c === 1 && s === 1) return 'none';
  return `brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`;
}

function drawPlaceholder(ctx, text) {
  ctx.save();
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
  ctx.fillStyle = '#5d6675';
  ctx.font = '600 40px "Noto Sans KR", "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text || '미디어를 불러오는 중…', DESIGN_W / 2, DESIGN_H / 2);
  ctx.restore();
}

function drawClip(ctx, clip, local, alpha) {
  if (!clip) return;
  const asset = getAsset(clip.assetId);
  if (!asset) { drawPlaceholder(ctx, '미디어를 찾을 수 없습니다'); return; }

  let src = null, sw = 0, sh = 0;
  if (clip.kind === 'video') {
    const v = videoFor(clip.assetId);
    if (v && v.readyState >= 2 && v.videoWidth) { src = v; sw = v.videoWidth; sh = v.videoHeight; }
  } else {
    const img = imageFor(clip.assetId);
    if (img && img.complete && img.naturalWidth) { src = img; sw = img.naturalWidth; sh = img.naturalHeight; }
  }
  if (!src) {
    if (clip.kind === 'video') { drawPlaceholder(ctx, ''); } else { drawPlaceholder(ctx, ''); }
    return;
  }

  const dur = clipDur(clip);
  const p = clamp(local / Math.max(0.01, dur), 0, 1);
  const fit = clip.fit === 'fit' ? Math.min(DESIGN_W / sw, DESIGN_H / sh) : Math.max(DESIGN_W / sw, DESIGN_H / sh);
  let scale = fit * ((clip.zoom || 100) / 100);
  let ox = ((clip.offsetX || 0) / 100) * DESIGN_W;
  let oy = ((clip.offsetY || 0) / 100) * DESIGN_H;

  if (clip.motion === 'zoomIn') scale *= 1 + 0.09 * p;
  else if (clip.motion === 'zoomOut') scale *= 1.09 - 0.09 * p;
  else if (clip.motion === 'panLR') { scale *= 1.07; ox += (p - 0.5) * 0.07 * DESIGN_W; }
  else if (clip.motion === 'panRL') { scale *= 1.07; ox += (0.5 - p) * 0.07 * DESIGN_W; }

  const dw = sw * scale, dh = sh * scale;
  const dx = (DESIGN_W - dw) / 2 + ox;
  const dy = (DESIGN_H - dh) / 2 + oy;

  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  const f = filterString(clip.adjust);
  if (f !== 'none') ctx.filter = f;
  try { ctx.drawImage(src, dx, dy, dw, dh); } catch (e) { /* 프레임 미준비 */ }
  ctx.restore();

  // 기존 자막 가리기 — 이 클립에 모자이크가 켜져 있으면 영역만 픽셀 처리
  const mosaic = mosaicOf(clip);
  if (mosaic.on) applyMosaic(ctx, mosaic, alpha);
}

function drawTextBlock(ctx, st, text, x, y) {
  const lines = String(text).split('\n').filter((l, i, a) => !(a.length > 1 && l === '' && i === a.length - 1));
  if (!lines.length || !lines.some((l) => l.trim())) return null;
  const weight = st.weight || 800;
  ctx.font = `${weight} ${st.size}px "${st.font}", "Noto Sans KR", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lineH = st.size * 1.16;
  let maxW = 0;
  for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);

  const bg = st.bg || {};
  const blockH = lineH * lines.length;
  const boxW = maxW + (bg.on ? (bg.padX || 0) * 2 : 0);
  const boxH = blockH + (bg.on ? (bg.padY || 0) * 2 : 0);
  const left = x - boxW / 2;
  const top = y - boxH / 2;

  if (bg.on) {
    ctx.save();
    ctx.globalAlpha = clamp((bg.opacity ?? 70) / 100, 0, 1);
    ctx.fillStyle = bg.color || '#000';
    roundRect(ctx, left, top, boxW, boxH, bg.radius || 0);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (st.shadow && st.shadow.on) {
    ctx.shadowColor = hexToRgba(st.shadow.color || '#000000', clamp((st.shadow.opacity ?? 50) / 100, 0, 1));
    ctx.shadowBlur = st.shadow.blur || 0;
    ctx.shadowOffsetX = st.shadow.x || 0;
    ctx.shadowOffsetY = st.shadow.y || 0;
  }
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  lines.forEach((line, i) => {
    const ly = top + (bg.on ? (bg.padY || 0) : 0) + lineH * (i + 0.5);
    if (st.stroke && st.stroke.on && st.stroke.width > 0) {
      ctx.lineWidth = st.stroke.width * 2;
      ctx.strokeStyle = st.stroke.color || '#000';
      ctx.strokeText(line, x, ly);
    }
    ctx.fillStyle = st.color || '#fff';
    ctx.fillText(line, x, ly);
  });
  ctx.restore();

  return { x: left, y: top, w: boxW, h: boxH };
}

function drawTexts(ctx, t) {
  const p = state.project;
  lastRects = [];
  if (!p) return;
  const active = p.segments.filter((s) => t >= s.start - 0.0001 && t < s.end - 0.0001);
  for (const seg of active) {
    for (const key of ['title', 'badge', 'subtitle']) {
      const text = seg[key];
      if (!text || !String(text).trim()) continue;
      const st = p.texts[key];
      const pos = (seg.pos && seg.pos[key]) || { x: st.x, y: st.y };
      const rect = drawTextBlock(ctx, st, text, pos.x, pos.y);
      if (rect) lastRects.push({ ...rect, key, segId: seg.id });
    }
  }
}

/** 프레임 한 장 그리기. 캔버스 크기는 어떤 값이든 1080x1920 좌표계로 변환됩니다. */
export function renderFrame(ctx, t, opts = {}) {
  const canvas = ctx.canvas;
  prepareCtx(ctx, canvas.width, canvas.height);
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);

  const p = state.project;
  const clips = p ? p.clips : [];
  if (clips.length) {
    const tt = clamp(t, 0, Math.max(0, clips.reduce((a, c) => a + clipDur(c), 0)) - 0.0001);
    const loc = locate(tt);
    if (loc) {
      const fadeIn = loc.clip.transition === 'fade' && loc.index > 0 && loc.local < FADE;
      if (fadeIn) {
        const prev = clips[loc.index - 1];
        drawClip(ctx, prev, clipDur(prev) - 0.001, 1);
        drawClip(ctx, loc.clip, loc.local, loc.local / FADE);
        ctx.globalAlpha = 1;
      } else {
        drawClip(ctx, loc.clip, loc.local, 1);
      }
    }
  } else {
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, 0, DESIGN_H);
    g.addColorStop(0, '#141a22');
    g.addColorStop(1, '#0a0d12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
    ctx.restore();
  }

  drawTexts(ctx, t);
  if (opts.guide && guideOn) drawMosaicGuide(ctx);
  ctx.restore();
}

/** 미리보기에서 글자를 집어 드래그할 때 사용합니다. */
export function hitTestText(x, y) {
  for (let i = lastRects.length - 1; i >= 0; i--) {
    const r = lastRects[i];
    const pad = 12;
    if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) return r;
  }
  return null;
}

export function getTextRects() { return lastRects; }
