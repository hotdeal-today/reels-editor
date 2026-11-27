// media.js — 파일 가져오기 · 썸네일 · 비디오/이미지/오디오 디코딩
import { addAssetRecord, getAsset, persistAsset, removeAsset } from './state.js';
import { uid, isVideoFile, isImageFile, isAudioFile } from './util.js';

const videoEls = new Map();
const imageEls = new Map();
const audioBuffers = new Map();
let decodeCtx = null;

function decodeContext() {
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(1, 1, 48000);
  return decodeCtx;
}

function makeThumb(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, w, h);
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  if (sw && sh) {
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  return c.toDataURL('image/jpeg', 0.7);
}

export function loadImageEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 열지 못했습니다.'));
    img.src = url;
  });
}

export function loadVideoEl(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    const done = () => { cleanup(); resolve(v); };
    const fail = () => { cleanup(); reject(new Error('영상을 열지 못했습니다.')); };
    const cleanup = () => { v.removeEventListener('loadedmetadata', done); v.removeEventListener('error', fail); };
    v.addEventListener('loadedmetadata', done);
    v.addEventListener('error', fail);
    v.src = url;
    v.load();
  });
}

/** 파일 하나를 자산으로 저장하고 클립 정보를 만듭니다. */
export async function importMediaFile(file) {
  let kind = null;
  if (isVideoFile(file)) kind = 'video';
  else if (isImageFile(file)) kind = 'image';
  else throw new Error(`지원하지 않는 파일입니다: ${file.name}`);

  const id = uid('as');
  const url = URL.createObjectURL(file);
  const rec = { id, name: file.name, kind, mime: file.type, size: file.size, blob: file, addedAt: Date.now() };

  if (kind === 'image') {
    const img = await loadImageEl(url);
    rec.width = img.naturalWidth;
    rec.height = img.naturalHeight;
    rec.thumb = makeThumb(img, 120, 214);
  } else {
    const v = await loadVideoEl(url);
    let dur = v.duration;
    if (!isFinite(dur) || dur <= 0) {
      // 일부 webm은 duration이 Infinity로 옵니다 — 끝까지 탐색해 확인
      dur = await probeDuration(v);
    }
    rec.duration = Math.max(0.2, dur || 1);
    rec.width = v.videoWidth;
    rec.height = v.videoHeight;
    try {
      await seekVideo(v, Math.min(0.12, rec.duration / 4));
      rec.thumb = makeThumb(v, 120, 214);
    } catch (e) { rec.thumb = null; }
    videoEls.set(id, v);
    v.muted = true;
  }

  addAssetRecord(rec);
  await persistAsset(rec);
  return { asset: getAsset(id), clip: makeClip(rec) };
}

function probeDuration(v) {
  return new Promise((resolve) => {
    const onSeek = () => {
      const d = v.duration;
      v.removeEventListener('timeupdate', onSeek);
      resolve(isFinite(d) && d > 0 ? d : 1);
    };
    v.addEventListener('timeupdate', onSeek);
    try { v.currentTime = 1e7; } catch (e) { resolve(1); }
    setTimeout(() => resolve(isFinite(v.duration) && v.duration > 0 ? v.duration : 1), 2500);
  });
}

/** 9:16이 아닌 사진(카드·가로·정사각)은 처음부터 '담기'로 — 잘리지 않게. */
export function autoFitFor(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return 'fill';
  return Math.abs((w / h) - (9 / 16)) / (9 / 16) > 0.05 ? 'fit' : 'fill';
}

export function makeClip(rec) {
  if (rec.kind === 'image') {
    return {
      id: uid('clip'), kind: 'image', assetId: rec.id, name: rec.name,
      duration: 3, trimIn: 0, trimOut: 3, speed: 1, volume: 100, muted: true,
      motion: 'none', transition: 'cut', fit: autoFitFor(rec.width, rec.height), fitSet: false,
      adjust: { brightness: 0, contrast: 0, saturate: 0 },
      zoom: 100, offsetX: 0, offsetY: 0,
    };
  }
  return {
    id: uid('clip'), kind: 'video', assetId: rec.id, name: rec.name,
    duration: rec.duration, srcDuration: rec.duration,
    trimIn: 0, trimOut: rec.duration, speed: 1, volume: 100, muted: false,
    motion: 'none', transition: 'cut', fit: 'fill',
    adjust: { brightness: 0, contrast: 0, saturate: 0 },
    zoom: 100, offsetX: 0, offsetY: 0,
  };
}

/** 비디오 엘리먼트(자산별 1개) — 렌더러가 프레임을 그릴 때 사용합니다. */
export function videoFor(assetId) {
  let v = videoEls.get(assetId);
  if (v) return v;
  const asset = getAsset(assetId);
  if (!asset || !asset.url) return null;
  v = document.createElement('video');
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.addEventListener('loadeddata', () => window.dispatchEvent(new Event('media-ready')));
  v.addEventListener('seeked', () => window.dispatchEvent(new Event('media-ready')));
  v.src = asset.url;
  v.load();
  videoEls.set(assetId, v);
  return v;
}

export function allVideoEls() { return videoEls; }

export function imageFor(assetId) {
  let img = imageEls.get(assetId);
  if (img) return img;
  const asset = getAsset(assetId);
  if (!asset || !asset.url) return null;
  img = new Image();
  img.onload = () => window.dispatchEvent(new Event('media-ready'));
  img.src = asset.url;
  imageEls.set(assetId, img);
  return img;
}

export function forgetAsset(assetId) {
  const v = videoEls.get(assetId);
  if (v) { try { v.pause(); } catch (e) {} v.removeAttribute('src'); v.load(); videoEls.delete(assetId); }
  imageEls.delete(assetId);
  audioBuffers.delete(assetId);
  removeAsset(assetId);
}

export function seekVideo(v, time) {
  return new Promise((resolve) => {
    if (!v) return resolve();
    if (v.readyState < 1) {
      const onMeta = () => { v.removeEventListener('loadedmetadata', onMeta); doSeek(); };
      v.addEventListener('loadedmetadata', onMeta);
      setTimeout(doSeek, 2000);
      return;
    }
    doSeek();
    function doSeek() {
      const target = Math.max(0, Math.min(time, (v.duration || 0) - 0.02));
      if (Math.abs(v.currentTime - target) < 0.005 && v.readyState >= 2) { resolve(); return; }
      let settled = false;
      const finish = () => { if (settled) return; settled = true; v.removeEventListener('seeked', finish); resolve(); };
      v.addEventListener('seeked', finish);
      try { v.currentTime = target; } catch (e) { finish(); }
      setTimeout(finish, 700);
    }
  });
}

export async function waitVideoReady(v, timeout = 5000) {
  if (!v) return false;
  if (v.readyState >= 2) return true;
  return new Promise((resolve) => {
    let done = false;
    const ok = () => { if (done) return; done = true; cleanup(); resolve(true); };
    const bad = () => { if (done) return; done = true; cleanup(); resolve(false); };
    const cleanup = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('canplay', ok); v.removeEventListener('error', bad); };
    v.addEventListener('loadeddata', ok);
    v.addEventListener('canplay', ok);
    v.addEventListener('error', bad);
    setTimeout(bad, timeout);
  });
}

/** 영상·오디오 파일의 소리를 AudioBuffer로 디코딩합니다 (한 번만). */
export async function decodeAudio(assetId) {
  if (audioBuffers.has(assetId)) return audioBuffers.get(assetId);
  const asset = getAsset(assetId);
  if (!asset || !asset.blob) { audioBuffers.set(assetId, null); return null; }
  try {
    const buf = await asset.blob.arrayBuffer();
    const decoded = await decodeContext().decodeAudioData(buf.slice(0));
    audioBuffers.set(assetId, decoded);
    return decoded;
  } catch (e) {
    console.warn('오디오 디코딩 실패:', asset.name, e);
    audioBuffers.set(assetId, null);
    return null;
  }
}

/**
 * 오디오의 앞뒤 무음을 잽니다. (Gemini TTS는 앞뒤에 0.2~0.5초 무음이 붙어 오는 경우가 많음)
 *  · 무음을 빼면 배속 없이도 자막 구간에 들어가는 경우가 많아집니다.
 *  · 소리가 거의 없는 파일은 자르지 않습니다(말소리 잘림 방지).
 */
export function measureSilence(buf, { threshold = 0.02, maxLead = 0.5, maxTail = 0.6 } = {}) {
  if (!buf || !buf.length) return { lead: 0, tail: 0 };
  const sr = buf.sampleRate || 48000;
  const n = buf.length;
  const chans = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels || 1); c++) chans.push(buf.getChannelData(c));
  const amp = (i) => {
    let m = 0;
    for (let c = 0; c < chans.length; c++) {
      const a = Math.abs(chans[c][i]);
      if (a > m) m = a;
    }
    return m;
  };
  let peak = 0;
  // 최대 음량은 모든 샘플을 봅니다(5ms씩 건너보면 주기적인 소리를 놓칠 수 있음)
  for (let i = 0; i < n; i++) {
    const a = amp(i);
    if (a > peak) peak = a;
  }
  if (peak < 0.05) return { lead: 0, tail: 0 };
  const gate = Math.max(threshold, peak * 0.06);
  const leadMax = Math.min(n - 1, Math.round(maxLead * sr));
  let i = 0;
  while (i < leadMax && amp(i) < gate) i++;
  const leadN = Math.max(0, i - Math.round(0.03 * sr)); // 첫소리 앞 30ms는 남김
  const tailMax = Math.min(n - 1, Math.round(maxTail * sr));
  let j = n - 1;
  const jStop = n - 1 - tailMax;
  while (j > jStop && amp(j) < gate) j--;
  const tailN = Math.max(0, (n - 1 - j) - Math.round(0.04 * sr));
  const total = n / sr;
  const lead = leadN / sr;
  const tail = tailN / sr;
  if (total - lead - tail < 0.3) return { lead: 0, tail: 0 };
  const r3 = (x) => Math.round(x * 1000) / 1000;
  return { lead: r3(lead), tail: r3(tail) };
}

/** 오디오 파일(효과음/나레이션/BGM)을 자산으로 저장합니다. */export async function importAudioFile(file) {
  if (!isAudioFile(file) && !isVideoFile(file)) throw new Error('오디오 파일이 아닙니다.');
  const id = uid('as');
  const rec = { id, name: file.name, kind: 'audio', mime: file.type, size: file.size, blob: file, addedAt: Date.now() };
  addAssetRecord(rec);
  await persistAsset(rec);
  const buf = await decodeAudio(id);
  if (buf) {
    rec.duration = buf.duration;
    const live = getAsset(id);
    if (live) live.duration = buf.duration;
    await persistAsset(rec);
  }
  return getAsset(id);
}
