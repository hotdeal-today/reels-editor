// render.js — 9:16 프레임 합성 (미리보기·내보내기 공용)
import { state, getAsset, locate, clipDur, mosaicOf } from './state.js';
import { videoFor, imageFor } from './media.js';
import { clamp, hexToRgba } from './util.js';

export const DESIGN_W = 1080;
export const DESIGN_H = 1920;
const FADE = 0.45;
let lastRects = [];
let guideOn = false;
let mosaicDragging = false;

/** 미리보기에서 모자이크 영역 가이드(점선)를 보여줄지 */
export function setMosaicGuide(v) { guideOn = !!v; }
export function getMosaicGuide() { return guideOn; }
/** 블러 박스를 끌고 있는 동안에는 가이드를 잠깐 보여 줍니다(내보내기에는 안 들어감). */
export function setMosaicDragging(v) {
  const next = !!v;
  if (next !== mosaicDragging) { mosaicDragging = next; }
}
export function isMosaicDragging() { return mosaicDragging; }

// 픽셀 모자이크용 임시 캔버스 (프레임마다 새로 만들지 않도록 재사용)
const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d');
// 희뿌연 블러 + 부드러운 가장자리 합성용 임시 캔버스
const soft = document.createElement('canvas');
const softCtx = soft.getContext('2d');

const MOSAIC_MIN_PX = 4;   // 이보다 작으면 픽셀화로 보지 않음
const FEATHER_RATIO = 0.22; // 가림 영역 가장자리에서 스며드는 폭 (짧은 변 기준)

/** 모자이크 설정(백분율)을 1080×1920 좌표계 사각형으로 바꿉니다. */
export function mosaicRect(m, designW = DESIGN_W, designH = DESIGN_H) {
  const w = clamp(Number(m && m.w != null ? m.w : 68), 1, 100) / 100 * designW;
  const h = clamp(Number(m && m.h != null ? m.h : 9), 1, 100) / 100 * designH;
  // 가로(x)·세로(y) 모두 중심 % 값입니다. 예전 저장본에 x가 없으면 50(가운데)으로 봅니다.
  const cx = clamp(Number(m && m.x != null ? m.x : 50), 0, 100) / 100 * designW;
  const cy = clamp(Number(m && m.y != null ? m.y : 78), 0, 100) / 100 * designH;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * 미리보기 캔버스에서 블러 박스를 집었는지 확인합니다.
 * 자막 가리기가 켜져 있고, 누른 지점이 지금 재생 위치의 블러 영역(여유 18px) 안이면
 * 값을 실제로 바꿀 대상(target: 프로젝트 기본값 또는 그 클립 설정)까지 돌려줍니다.
 */
export function mosaicHitInfo(x, y) {
  const p = state.project;
  if (!p || !(p.clips || []).length) return null;
  const loc = locate(state.time);
  const clip = (loc && loc.clip) || p.clips[0];
  const m = mosaicOf(clip);
  if (!m.on) return null;
  const r = mosaicRect(m);
  const pad = 18;
  if (x < r.x - pad || x > r.x + r.w + pad || y < r.y - pad || y > r.y + r.h + pad) return null;
  // 이 클립에 따로 저장한 설정이 있으면 그쪽을, 없으면 전체 기본값을 움직입니다.
  const target = clip && clip.mosaic ? clip.mosaic : p.mosaic;
  return { clipIndex: p.clips.indexOf(clip), clip, m, rect: r, target, perClip: !!(clip && clip.mosaic) };
}

/**
 * 가장자리가 서서히 사라지는 알파 마스크용 그라데이션.
 * span(전체 길이)의 양 끝 feather 폭만큼 부드럽게 0 → 1 → 0 으로 변합니다.
 */
function edgeMask(ctx, x0, y0, x1, y1, span, feather) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  const f = Math.min(Math.max(feather, 0.5), span / 2);
  const stop = (t, a) => g.addColorStop(clamp(t / span, 0, 1), `rgba(0,0,0,${a.toFixed(4)})`);
  const smooth = (k) => k * k * (3 - 2 * k);
  const N = 6;
  stop(0, 0);
  for (let i = 1; i <= N; i++) { const k = i / N; stop(f * k, smooth(k)); }
  for (let i = 1; i <= N; i++) { const k = i / N; stop(span - f + f * k, 1 - smooth(k)); }
  return g;
}

/**
 * 지금 그려져 있는 프레임의 일부 영역만 희뿌연 블러(+원하면 픽셀 모자이크)로 덮습니다.
 * 영역 경계가 칼같이 잘려 보이지 않도록 상하좌우 가장자리를 원본과 부드럽게 섞습니다.
 * 기존 영상·사진에 이미 박혀 있는 외국 자막을 가릴 때 사용합니다.
 */
export function applyMosaic(ctx, m, alpha = 1, designW = DESIGN_W, designH = DESIGN_H) {
  if (!m || !m.on) return;
  const canvas = ctx.canvas;
  if (!canvas || !canvas.width || !canvas.height) return;
  const r = mosaicRect(m, designW, designH);
  const step = clamp(Number(m.strength) || 0, 0, 80);
  const blur = clamp(Number(m.blur) || 0, 0, 40);
  const pixelate = step >= MOSAIC_MIN_PX;
  if (!pixelate && blur < 0.4) return;

  const sx = canvas.width / designW;   // 디자인 좌표 → 캔버스 픽셀
  const sy = canvas.height / designH;

  // 블러가 가장자리에서 잘리지 않도록 영역을 조금 넓게(bleed) 잡습니다.
  const bleed = Math.ceil(Math.max(blur * 1.6, 6));
  const ex = r.x - bleed, ey = r.y - bleed;
  const ew = r.w + bleed * 2, eh = r.h + bleed * 2;
  const tw = Math.max(1, Math.round(ew * sx));
  const th = Math.max(1, Math.round(eh * sy));

  // 1) 픽셀 모자이크를 원하면 작은 캔버스로 축소해 조각을 만듭니다.
  let src = { c: canvas, x: ex * sx, y: ey * sy, w: ew * sx, h: eh * sy };
  if (pixelate) {
    const bw = Math.max(1, Math.round(ew / step));
    const bh = Math.max(1, Math.round(eh / step));
    if (scratch.width !== bw || scratch.height !== bh) {
      scratch.width = bw;
      scratch.height = bh;
    }
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.filter = 'none';
    sctx.imageSmoothingEnabled = false;
    sctx.clearRect(0, 0, bw, bh);
    try { sctx.drawImage(canvas, ex * sx, ey * sy, ew * sx, eh * sy, 0, 0, bw, bh); } catch (e) { return; }
    src = { c: scratch, x: 0, y: 0, w: bw, h: bh };
  }

  // 2) 블러를 입혀 임시 캔버스에 담습니다.
  if (soft.width !== tw || soft.height !== th) {
    soft.width = tw;
    soft.height = th;
  }
  softCtx.setTransform(1, 0, 0, 1, 0, 0);
  softCtx.globalCompositeOperation = 'source-over';
  softCtx.globalAlpha = 1;
  softCtx.filter = 'none';
  softCtx.clearRect(0, 0, tw, th);
  softCtx.imageSmoothingEnabled = !pixelate || blur > 0;
  softCtx.imageSmoothingQuality = 'high';
  if (blur > 0) softCtx.filter = `blur(${(blur * sx).toFixed(2)}px)`;
  try { softCtx.drawImage(src.c, src.x, src.y, src.w, src.h, 0, 0, tw, th); } catch (e) { return; }
  softCtx.filter = 'none';

  // 3) 상하좌우 가장자리를 투명하게 깎아 원본과 자연스럽게 스며들게 합니다.
  const rx = bleed * sx, ry = bleed * sy, rw = r.w * sx, rh = r.h * sy;
  const feather = Math.min(r.w, r.h) * FEATHER_RATIO;
  const fx = Math.min(rw / 2, Math.max(1.5, feather * sx));
  const fy = Math.min(rh / 2, Math.max(1.5, feather * sy));
  softCtx.globalCompositeOperation = 'destination-in';
  softCtx.fillStyle = edgeMask(softCtx, rx, 0, rx + rw, 0, rw, fx);
  softCtx.fillRect(0, 0, tw, th);
  softCtx.fillStyle = edgeMask(softCtx, 0, ry, 0, ry + rh, rh, fy);
  softCtx.fillRect(0, 0, tw, th);
  softCtx.globalCompositeOperation = 'source-over';

  // 4) 본 캔버스에 합성합니다.
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  try { ctx.drawImage(soft, 0, 0, tw, th, ex, ey, ew, eh); } catch (e) { /* 무시 */ }
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
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  ctx.save();
  // 가로·세로 위치 안내선 (은은하게)
  ctx.setLineDash([8, 14]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,216,77,.32)';
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, DESIGN_H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(DESIGN_W, cy); ctx.stroke();
  // 영역 점선 박스
  ctx.setLineDash([18, 14]);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = 'rgba(255,216,77,.92)';
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  // 중심 핸들
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,216,77,.92)';
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fill();
  // 위치 라벨
  const xPct = Math.round(clamp(Number(m.x != null ? m.x : 50), 0, 100));
  const yPct = Math.round(clamp(Number(m.y != null ? m.y : 78), 0, 100));
  const label = `자막 가림 · 가로 ${xPct}% · 세로 ${yPct}%`;
  ctx.font = '700 30px "Noto Sans KR", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  const ly = Math.max(38, r.y - 34);
  ctx.fillStyle = 'rgba(10,13,18,.62)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(r.x, ly - 27, tw + 26, 54, 12);
  else ctx.rect(r.x, ly - 27, tw + 26, 54);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,216,77,.98)';
  ctx.fillText(label, r.x + 13, ly);
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

  // 기존 자막 가리기 — 이 클립에 자막 가림이 켜져 있으면 영역만 희뿌연 블러(원하면 픽셀화) 처리
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
  // 가이드(점선·위치 안내)는 미리보기에서만. 블러 박스를 끄는 동안에도 보여 줍니다.
  // MP4·캐러셀·썸네일 내보내기는 renderFrame(ctx, t)로 가이드 없이 그립니다.
  if (opts.guide && (guideOn || mosaicDragging)) drawMosaicGuide(ctx);
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
