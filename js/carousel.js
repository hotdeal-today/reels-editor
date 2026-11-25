// carousel.js — 인스타·클립용 캐러셀 이미지 카드 만들기
//  · 1번 카드: 대표 썸네일 + 제목 + 배지
//  · 2~N번 카드: 타임라인 전체에서 서로 다른 시점의 장면 (같은 그림이 두 번 나오지 않음)
//  · 모자이크 설정(가로·세로 위치 포함)과 색감 보정도 그대로 반영
import {
  state, getAsset, clipStart, clipDur, totalDuration, locate, activeSegment, mosaicOf,
} from './state.js';
import { videoFor, imageFor, seekVideo, waitVideoReady } from './media.js';
import { applyMosaic, DESIGN_W, DESIGN_H } from './render.js';
import { clamp, hexToRgba, fmtSec } from './util.js';

export const CAROUSEL_RATIOS = {
  '4:5': { w: 1080, h: 1350, label: '4:5 피드' },
  '9:16': { w: 1080, h: 1920, label: '9:16 세로' },
};

export const CAROUSEL_COUNTS = [4, 5, 6];
export const CAROUSEL_DEFAULT_COUNT = 5;

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

/** 9:16 기준으로 잡은 모자이크 위치(가로 x·세로 y 중심 %)를 카드 비율에 맞게 옮깁니다(크롭되는 만큼 같이 이동). */
function mosaicForCard(m, W, H) {
  if (!m || !m.on) return m;
  const dW = (clamp(Number(m.w != null ? m.w : 68), 1, 100) / 100) * DESIGN_W;
  const dH = (clamp(Number(m.h != null ? m.h : 9), 1, 100) / 100) * DESIGN_H;
  const dX = (clamp(Number(m.x != null ? m.x : 50), 0, 100) / 100) * DESIGN_W - dW / 2;
  const dY = (clamp(Number(m.y != null ? m.y : 78), 0, 100) / 100) * DESIGN_H - dH / 2;
  // 카드도 9:16 캔버스를 꽉 채우는(cover) 방식이므로 같은 배율로 옮긴 뒤 크롭 오프셋만큼 평행 이동합니다.
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

/** 그 시점에 화면에 떠 있는 자막(없으면 제목)을 찾습니다. */
function textAt(t) {
  const seg = activeSegment(t);
  if (!seg) return '';
  return (seg.subtitle || '').trim() || (seg.title || '').trim() || '';
}

function coverText() {
  const p = state.project;
  const segs = p.segments || [];
  const first = segs.find((s) => (s.title || '').trim()) || segs[0] || {};
  const title = (first.title || '').trim() || (p.name && p.name !== '새 릴스' ? p.name : '');
  const badge = (first.badge || '').trim();
  return { title, badge };
}

/** 1번(대표) 카드가 찍는 시점 — 클립 앞부분의 얼굴·간판이 잘 보이는 지점 */
function coverMoment(clips) {
  const first = clips[0];
  if (!first) return null;
  const dur = clipDur(first);
  const local = clamp(dur * 0.35, 0, Math.max(0.01, Math.min(1.2, dur - 0.05)));
  return { clipIndex: 0, clip: first, local, t: clipStart(0) + local };
}

function momentKey(m) {
  return `${m.clip.assetId}:${m.local.toFixed(1)}`;
}

/**
 * 2~N번 카드로 쓸 '서로 다른 장면'을 고릅니다.
 * · 타임라인 전체(0~totalDuration)를 N등분해 각 구간 가운데를 목표로 잡고,
 *   그 목표에 가장 가까우면서 아직 안 쓴 시점을 고릅니다. (자막이 있는 구간을 살짝 우선)
 * · 사진은 같은 사진(assetId)이 두 번 나오지 않게 하고, 영상은 시점이 겹치지 않게 합니다.
 * · 영상 1개만 있어도 그 안에서 여러 시점을 뽑아 4~6장이 서로 다른 장면이 됩니다.
 * @returns {{moments:Array, requested:number, available:number, limited:boolean, notice:string}}
 */
export function planCarouselMoments(count) {
  const p = state.project;
  const clips = (p.clips || []).slice(0, 40);
  const want = clamp(Math.round(Number(count) || CAROUSEL_DEFAULT_COUNT), 2, 10);
  if (!clips.length) return { moments: [], requested: want, available: 0, limited: false, notice: '' };

  const total = totalDuration();
  const cover = coverMoment(clips);
  const need = Math.max(0, want - 1);

  const usedTimes = cover ? [cover.t] : [];
  const usedKeys = new Set(cover ? [momentKey(cover)] : []);
  const usedPhotoAssets = new Set();
  const coverClip = clips[cover ? cover.clipIndex : 0];
  if (coverClip && coverClip.kind === 'image') usedPhotoAssets.add(coverClip.assetId);

  // 후보 시점 만들기
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

  // 목표 시점 사이 최소 간격 — 너무 붙은 프레임이 두 장 나오지 않게
  const minSep = clamp(total / Math.max(2, want) / 3.2, 0.25, 1.1);
  const segText = (t) => {
    const sg = activeSegment(t);
    return !!(sg && ((sg.subtitle || '').trim() || (sg.title || '').trim()));
  };

  const picked = [];
  for (let k = 1; k <= need; k++) {
    const target = total * ((k + 0.5) / want);
    const usable = (relaxed) => cands.filter((c) => {
      if (usedKeys.has(momentKey(c))) return false;
      if (c.photo && usedPhotoAssets.has(c.assetId)) return false;      // 같은 사진 중복 금지
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
      // 자막이 떠 있는 구간은 살짝 우선 (자막이 같이 얹혀 정보가 살아남)
      const cost = Math.abs(c.t - target) * (segText(c.t) ? 0.72 : 1);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    if (!best) break;
    picked.push({ ...best, t: best.t });
    usedKeys.add(momentKey(best));
    usedTimes.push(best.t);
    if (best.photo) usedPhotoAssets.add(best.assetId);
  }

  const available = picked.length + (cover ? 1 : 0);
  const limited = available < want;
  let notice = '';
  if (limited) {
    const photoCount = clips.filter((c) => c.kind === 'image').length;
    const hasVideo = clips.some((c) => c.kind === 'video');
    if (!hasVideo && photoCount) {
      notice = `서로 다른 사진이 ${available}장뿐이라 ${available}장으로 만들었습니다. 4~6장을 채우려면 사진을 더 넣거나 영상을 하나 넣어 주세요.`;
    } else if (photoCount) {
      notice = `서로 다른 장면이 ${available}개뿐이라 ${available}장으로 만들었습니다(같은 사진은 두 번 넣지 않았습니다).`;
    } else {
      notice = `${available}장으로 만들었습니다.`;
    }
  }
  return { moments: picked, requested: want, available, limited, notice, cover };
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

/** 그 클립의 local(클립 안에서의 재생 위치) 프레임이 실제로 그려질 때까지 기다립니다. */
async function prepareClipFrame(clip, local) {
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
  const dur = Math.max(0.1, clipDur(clip));
  const want = clamp((clip.trimIn || 0) + clamp(local, 0, dur) * (clip.speed || 1), 0, Math.max(0, (v.duration || 1) - 0.05));
  await seekVideo(v, want);
}

function toCard(canvas, { index, label, title, t, clipIndex, quality, text, coverTitle, coverBadge }) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve({
        index, label, title, t, clipIndex,
        text: text != null ? text : '',
        coverTitle: coverTitle != null ? coverTitle : '',
        coverBadge: coverBadge != null ? coverBadge : '',
        w: canvas.width, h: canvas.height,
        blob,
        url: blob ? URL.createObjectURL(blob) : '',
      });
    }, 'image/jpeg', quality);
  });
}

/** 카드 한 장 그리기 (대표 카드 / 장면 카드 공용) */
function drawCardInto(ctx, W, H, { clip, local, isCover, title, badge, text, titleStyle, badgeStyle, subStyle, isWide, scale }) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  drawCover(ctx, clip, W, H);
  const m = mosaicForCard(mosaicOf(clip), W, H);
  if (m.on) applyMosaic(ctx, m, 1, W, H);

  if (isCover) {
    topScrim(ctx, W, H);
    drawScrim(ctx, W, H, 0.8);
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
    return;
  }
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
}

function cardStyle(ratio) {
  const spec = CAROUSEL_RATIOS[ratio] || CAROUSEL_RATIOS['4:5'];
  const W = spec.w, H = spec.h;
  const p = state.project;
  return {
    W, H,
    isWide: H / W < 1.5,
    scale: W / DESIGN_W,
    titleStyle: p.texts.title,
    badgeStyle: p.texts.badge,
    subStyle: p.texts.subtitle,
  };
}

/**
 * 캐러셀 카드 세트를 만듭니다.
 * @param {{ratio?:string, count?:number, quality?:number, onProgress?:Function}} opts
 * @returns {Promise<{ratio:string,w:number,h:number,cards:Array,requested:number,limited:boolean,notice:string}>}
 */
export async function buildCarousel({ ratio = '4:5', count = CAROUSEL_DEFAULT_COUNT, quality = 0.92, onProgress = () => {} } = {}) {
  const p = state.project;
  const clips = (p.clips || []).slice(0, 40);
  if (!clips.length) throw new Error('먼저 사진이나 영상을 추가하세요.');
  const { W, H, isWide, scale, titleStyle, badgeStyle, subStyle } = cardStyle(ratio);

  const plan = planCarouselMoments(count);
  const total = plan.moments.length + 1; // 대표 카드 포함
  const cards = [];

  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }

  // 1) 대표 카드
  onProgress(0, '대표 카드');
  const cover = plan.cover || { clip: clips[0], local: 0, clipIndex: 0 };
  await prepareClipFrame(cover.clip, cover.local);
  {
    const { c, ctx } = makeCanvas(W, H);
    const { title, badge } = coverText();
    drawCardInto(ctx, W, H, {
      clip: cover.clip, local: cover.local, isCover: true, title, badge,
      titleStyle, badgeStyle, subStyle, isWide, scale,
    });
    cards.push(await toCard(c, {
      index: 0, label: '대표', title, t: cover.t, clipIndex: cover.clipIndex, quality,
      coverTitle: title, coverBadge: badge,
    }));
  }

  // 2) 서로 다른 장면 카드
  for (let i = 0; i < plan.moments.length; i++) {
    const mo = plan.moments[i];
    onProgress((i + 1) / total, `${i + 2}장 · ${fmtSec(mo.t)}`);
    await prepareClipFrame(mo.clip, mo.local);
    const { c, ctx } = makeCanvas(W, H);
    const text = textAt(mo.t);
    drawCardInto(ctx, W, H, {
      clip: mo.clip, local: mo.local, isCover: false, text,
      titleStyle, badgeStyle, subStyle, isWide, scale,
    });
    cards.push(await toCard(c, {
      index: i + 1,
      label: `${fmtSec(mo.t)} 지점${text ? ' · 자막' : ''}`,
      title: text,
      text,
      t: mo.t,
      clipIndex: mo.clipIndex,
      quality,
    }));
  }

  onProgress(1, '완료');
  return {
    ratio, w: W, h: H, cards,
    requested: plan.requested,
    limited: plan.limited,
    notice: plan.notice,
  };
}

/** 카드 한 장만 그 시점(초)·문구로 다시 찍습니다 — 카드별 시점·자막 직접 수정용 */
export async function rebuildCarouselCard({ ratio = '4:5', t = 0, index = 1, text = null, quality = 0.92 } = {}) {
  const p = state.project;
  const clips = (p.clips || []).slice(0, 40);
  if (!clips.length) throw new Error('먼저 사진이나 영상을 추가하세요.');
  const { W, H, isWide, scale, titleStyle, badgeStyle, subStyle } = cardStyle(ratio);
  const total = totalDuration();
  const tt = clamp(Number(t) || 0, 0, Math.max(0, total - 0.05));
  const loc = locate(tt) || { index: 0, clip: clips[0], local: 0 };
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
  await prepareClipFrame(loc.clip, loc.local);
  const { c, ctx } = makeCanvas(W, H);
  const finalText = text != null ? String(text) : textAt(tt);
  drawCardInto(ctx, W, H, {
    clip: loc.clip, local: loc.local, isCover: false, text: finalText,
    titleStyle, badgeStyle, subStyle, isWide, scale,
  });
  return toCard(c, {
    index,
    label: `${fmtSec(tt)} 지점${finalText && String(finalText).trim() ? ' · 자막' : ''}`,
    title: finalText,
    text: finalText,
    t: tt,
    clipIndex: loc.index,
    quality,
  });
}

/** 1번(대표) 카드만 제목·배지를 바꿔 다시 찍습니다. */
export async function rebuildCoverCard({ ratio = '4:5', title = null, badge = null, quality = 0.92 } = {}) {
  const p = state.project;
  const clips = (p.clips || []).slice(0, 40);
  if (!clips.length) throw new Error('먼저 사진이나 영상을 추가하세요.');
  const { W, H, isWide, scale, titleStyle, badgeStyle, subStyle } = cardStyle(ratio);
  const cover = coverMoment(clips);
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
  await prepareClipFrame(cover.clip, cover.local);
  const auto = coverText();
  const finalTitle = title != null ? String(title) : auto.title;
  const finalBadge = badge != null ? String(badge) : auto.badge;
  const { c, ctx } = makeCanvas(W, H);
  drawCardInto(ctx, W, H, {
    clip: cover.clip, local: cover.local, isCover: true, title: finalTitle, badge: finalBadge,
    titleStyle, badgeStyle, subStyle, isWide, scale,
  });
  return toCard(c, {
    index: 0, label: '대표', title: finalTitle, t: cover.t, clipIndex: cover.clipIndex, quality,
    coverTitle: finalTitle, coverBadge: finalBadge,
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

// 검증용 읽기 전용 참고 (콘솔·자동 테스트에서 현재 로직 확인)
if (typeof window !== 'undefined') {
  window.__reelsCarousel = { planCarouselMoments, buildCarousel, rebuildCarouselCard, mosaicForCard };
}
