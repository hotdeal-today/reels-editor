// fonts.js — 내장 한글 웹폰트 + 사용자 폰트(.ttf/.otf/.woff2)
import { idbAll, idbPut, idbDel } from './db.js';
import { uid, readAsArrayBuffer } from './util.js';

export const BUILTIN_FONTS = [
  { family: 'Noto Sans KR', label: '노토 산스 (기본 고딕)' },
  { family: 'Black Han Sans', label: '검은고딕 (굵은 제목)' },
  { family: 'Do Hyeon', label: '도현 (큰 제목)' },
  { family: 'Jua', label: '주아 (귀여운 손글씨)' },
  { family: 'Nanum Gothic', label: '나눔고딕' },
  { family: 'Nanum Pen Script', label: '나눔손글씨 펜' },
  { family: 'Gowun Batang', label: '고운바탕 (명조)' },
];

export const customFonts = []; // { id, family, label }

const GTAG = {
  'Noto Sans KR': 'Noto+Sans+KR:wght@400;500;700;800;900',
  'Black Han Sans': 'Black+Han+Sans',
  'Do Hyeon': 'Do+Hyeon',
  'Jua': 'Jua',
  'Nanum Gothic': 'Nanum+Gothic:wght@400;700;800',
  'Nanum Pen Script': 'Nanum+Pen+Script',
  'Gowun Batang': 'Gowun+Batang:wght@400;700',
};

/** 폰트 CSS를 미리 요청해 두어 첫 렌더에서 기본 글꼴로 보이는 일을 줄입니다. */
export function warmupBuiltinFonts() {
  const families = Object.values(GTAG).map((v) => `family=${v}`).join('&');
  const href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
  if (!document.querySelector(`link[data-font-warm="1"]`) && !document.querySelector('link[href*="fonts.googleapis.com/css2"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.fontWarm = '1';
    document.head.appendChild(link);
  }
}

export function allFonts() {
  return [
    ...BUILTIN_FONTS,
    ...customFonts.map((f) => ({ family: f.family, label: f.label, custom: true })),
  ];
}

export function fontLabel(family) {
  const f = allFonts().find((x) => x.family === family);
  return f ? f.label : family;
}

/** 캔버스에서 쓰기 전에 폰트가 준비되었는지 확인합니다. */
export async function ensureFont(family, weight = 700, size = 64) {
  if (!family || !document.fonts) return;
  try { await document.fonts.load(`${weight} ${size}px "${family}"`, '가나다ABC'); } catch (e) { /* 무시 */ }
}

export async function loadCustomFontsFromDB() {
  let rows = [];
  try { rows = await idbAll('fonts'); } catch (e) { rows = []; }
  for (const row of rows) {
    try {
      const face = new FontFace(row.family, row.buffer, { display: 'swap' });
      await face.load();
      document.fonts.add(face);
      customFonts.push({ id: row.id, family: row.family, label: row.label });
    } catch (e) {
      console.warn('폰트를 불러오지 못했습니다:', row.label, e);
    }
  }
}

export async function addCustomFont(file) {
  const buf = await readAsArrayBuffer(file);
  const base = (file.name || 'myfont').replace(/\.[^.]+$/, '').replace(/[^\w가-힣\- ]/g, '').slice(0, 40) || 'myfont';
  const family = `${base}_${Math.random().toString(36).slice(2, 5)}`;
  const label = `${base} (내 폰트)`;
  const face = new FontFace(family, buf, { display: 'swap' });
  await face.load();
  document.fonts.add(face);
  const rec = { id: uid('font'), family, label, buffer: buf, addedAt: Date.now() };
  await idbPut('fonts', rec);
  customFonts.push({ id: rec.id, family, label });
  return { family, label };
}

export async function removeCustomFont(id) {
  const i = customFonts.findIndex((f) => f.id === id);
  if (i >= 0) customFonts.splice(i, 1);
  await idbDel('fonts', id);
}

export function fontOptionsHtml(selected) {
  const groups = [
    { name: '내장 폰트', items: BUILTIN_FONTS },
    { name: '내 폰트', items: customFonts.map((f) => ({ family: f.family, label: f.label })) },
  ];
  return groups.map((g) => {
    if (!g.items.length) return '';
    return `<optgroup label="${g.name}">` + g.items.map((f) =>
      `<option value="${f.family}"${f.family === selected ? ' selected' : ''}>${f.label}</option>`).join('') + '</optgroup>';
  }).join('');
}
