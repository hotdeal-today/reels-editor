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

export function makeClip(rec) {
  if (rec.kind === 'image') {
    return {
      id: uid('clip'), kind: 'image', assetId: rec.id, name: rec.name,
      duration: 3, trimIn: 0, trimOut: 3, speed: 1, volume: 100, muted: true,
      motion: 'none', transition: 'cut', fit: 'fill',
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

/** 오디오 파일(효과음/나레이션/BGM)을 자산으로 저장합니다. */
export async function importAudioFile(file) {
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
