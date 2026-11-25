// util.js — 공통 도우미
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9);
export const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

export function fmtTime(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
export function fmtSec(t) { return `${(t || 0).toFixed(1)}초`; }

export function debounce(fn, ms = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function bytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function hexToRgba(hex, alpha) {
  const h = (hex || '#000000').replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v || '000000', 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function isVideoFile(f) {
  return /^video\//.test(f.type) || /\.(mp4|mov|webm|m4v|ogv)$/i.test(f.name);
}
export function isImageFile(f) {
  return /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(f.name);
}
export function isAudioFile(f) {
  return /^audio\//.test(f.type) || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name);
}
export function isFontFile(f) {
  return /\.(ttf|otf|woff2?)$/i.test(f.name);
}

export function readAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error || new Error('파일을 읽지 못했습니다.'));
    fr.readAsArrayBuffer(file);
  });
}
export function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error || new Error('파일을 읽지 못했습니다.'));
    fr.readAsDataURL(file);
  });
}

export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

// 간단한 이벤트 버스
const bus = new EventTarget();
export function emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); }
export function on(name, fn) { bus.addEventListener(name, (e) => fn(e.detail)); }
