// fonts.js — 내장 한글·영문 웹폰트 + 사용자 폰트(.ttf/.otf/.woff2)
import { idbAll, idbPut, idbDel } from './db.js';
import { uid, readAsArrayBuffer } from './util.js';

/**
 * 내장 폰트 — group: 'ko'(한글) | 'en'(영문 전용)
 * sample: 미리보기 버튼에 그려 넣는 글자. 영문 전용 폰트는 한글 글리프가 없어 영문으로 보여 줍니다.
 */
export const BUILTIN_FONTS = [
  // ── 한글 · 깔끔
  { family: 'Noto Sans KR', label: '노토 산스 · 깔끔 기본', group: 'ko', sample: '가나다 Aa' },
  { family: 'Nanum Gothic', label: '나눔고딕 · 무난한 본문', group: 'ko', sample: '가나다 Aa' },
  { family: 'Gowun Dodum', label: '고운돋움 · 부드러운 고딕', group: 'ko', sample: '가나다 Aa' },
  { family: 'Gowun Batang', label: '고운바탕 · 감성 명조', group: 'ko', sample: '가나다 Aa' },
  // ── 한글 · 귀여운 손글씨
  { family: 'Jua', label: '주아 · 동글동글', group: 'ko', sample: '가나다 Aa' },
  { family: 'Dongle', label: '동글 · 작고 귀여운', group: 'ko', sample: '가나다 Aa' },
  { family: 'Gamja Flower', label: '감자꽃 · 삐뚤삐뚤', group: 'ko', sample: '가나다 Aa' },
  { family: 'Gaegu', label: '개구 · 연필 손글씨', group: 'ko', sample: '가나다 Aa' },
  { family: 'Single Day', label: '싱글데이 · 가벼운 손글씨', group: 'ko', sample: '가나다 Aa' },
  { family: 'Hi Melody', label: '하이멜로디 · 통통 손글씨', group: 'ko', sample: '가나다 Aa' },
  { family: 'Nanum Pen Script', label: '나눔손글씨 펜', group: 'ko', sample: '가나다 Aa' },
  { family: 'Nanum Brush Script', label: '나눔손글씨 붓', group: 'ko', sample: '가나다 Aa' },
  { family: 'Poor Story', label: '푸어스토리 · 낙서 느낌', group: 'ko', sample: '가나다 Aa' },
  // ── 한글 · 포인트 제목
  { family: 'Black Han Sans', label: '검은고딕 · 굵은 제목', group: 'ko', sample: '가나다 Aa' },
  { family: 'Do Hyeon', label: '도현 · 큼직한 제목', group: 'ko', sample: '가나다 Aa' },
  { family: 'Bagel Fat One', label: '베이글팻원 · 통통 제목', group: 'ko', sample: '가나다 Aa' },
  // ── 영문 전용 · 감성/필기
  { family: 'Pacifico', label: 'Pacifico · 감성 필기', group: 'en', sample: 'Aa Bb 123' },
  { family: 'Dancing Script', label: 'Dancing Script · 흘림', group: 'en', sample: 'Aa Bb 123' },
  { family: 'Caveat', label: 'Caveat · 손글씨', group: 'en', sample: 'Aa Bb 123' },
  { family: 'Fredoka', label: 'Fredoka · 동글 영문', group: 'en', sample: 'Aa Bb 123' },
  { family: 'Bubblegum Sans', label: 'Bubblegum · 말랑 영문', group: 'en', sample: 'Aa Bb 123' },
  { family: 'Lobster', label: 'Lobster · 굵은 필기', group: 'en', sample: 'Aa Bb 123' },
  { family: 'Playfair Display', label: 'Playfair · 우아한 세리프', group: 'en', sample: 'Aa Bb 123' },
  { family: 'Montserrat', label: 'Montserrat · 깔끔 영문', group: 'en', sample: 'Aa Bb 123' },
];

export const FONT_GROUPS = [
  { id: 'ko', name: '[한글]' },
  { id: 'en', name: '[영문]' },
  { id: 'mine', name: '[내 폰트]' },
];

export const customFonts = []; // { id, family, label }

/** Google Fonts CSS2 요청용 — 가족 이름 → 축/굵기 지정 */
const GTAG = {
  'Noto Sans KR': 'Noto+Sans+KR:wght@400;700;900',
  'Nanum Gothic': 'Nanum+Gothic:wght@400;700;800',
  'Gowun Dodum': 'Gowun+Dodum',
  'Gowun Batang': 'Gowun+Batang:wght@400;700',
  'Jua': 'Jua',
  'Dongle': 'Dongle:wght@300;400;700',
  'Gamja Flower': 'Gamja+Flower',
  'Gaegu': 'Gaegu:wght@300;400;700',
  'Single Day': 'Single+Day',
  'Hi Melody': 'Hi+Melody',
  'Nanum Pen Script': 'Nanum+Pen+Script',
  'Nanum Brush Script': 'Nanum+Brush+Script',
  'Poor Story': 'Poor+Story',
  'Black Han Sans': 'Black+Han+Sans',
  'Do Hyeon': 'Do+Hyeon',
  'Bagel Fat One': 'Bagel+Fat+One',
  'Pacifico': 'Pacifico',
  'Dancing Script': 'Dancing+Script:wght@400;700',
  'Caveat': 'Caveat:wght@400;700',
  'Fredoka': 'Fredoka:wght@400;600',
  'Bubblegum Sans': 'Bubblegum+Sans',
  'Lobster': 'Lobster',
  'Playfair Display': 'Playfair+Display:wght@400;700',
  'Montserrat': 'Montserrat:wght@400;700',
};

/**
 * 웹폰트 CSS는 쓰는 글꼴만 그때그때 한 장씩 붙입니다.
 * 한글 글꼴 CSS는 16종을 한 번에 받으면 1.5MB라서, 첫 화면·필요한 글꼴만 받게 나눴습니다.
 * (같은 글꼴은 한 번만 요청합니다)
 */
const fontCssPending = new Map(); // family -> Promise

function ensureFontCss(family) {
  if (!family) return Promise.resolve();
  if (fontCssPending.has(family)) return fontCssPending.get(family);
  const tag = GTAG[family];
  if (!tag) return Promise.resolve(); // 직접 올린 폰트나 웹폰트가 아닌 이름
  const p = new Promise((res) => {
    const el = document.createElement('link');
    el.rel = 'stylesheet';
    el.href = `https://fonts.googleapis.com/css2?family=${tag}&display=swap`;
    el.dataset.fontFamily = family;
    el.addEventListener('load', () => res('ok'), { once: true });
    el.addEventListener('error', () => { console.warn('웹폰트 목록을 받지 못했습니다:', family); res('error'); }, { once: true });
    document.head.appendChild(el);
  });
  fontCssPending.set(family, p);
  return p;
}

/** 첫 화면 기본 글꼴만 미리 받습니다. 나머지는 고를 때 그 자리에서 받습니다. */
export function warmupBuiltinFonts(families = ['Noto Sans KR']) {
  return Promise.all(families.map((f) => ensureFontCss(f)));
}

export function allFonts() {
  return [
    ...BUILTIN_FONTS,
    ...customFonts.map((f) => ({ family: f.family, label: f.label, group: 'mine', sample: '가나다 Aa', custom: true })),
  ];
}

export function fontLabel(family) {
  const f = allFonts().find((x) => x.family === family);
  return f ? f.label : family;
}

export function fontInfo(family) {
  return allFonts().find((x) => x.family === family) || null;
}

/** 캔버스에서 쓰기 전에 폰트가 준비되었는지 확인합니다. 웹폰트면 CSS도 함께 받아 옵니다. */
export async function ensureFont(family, weight = 700, size = 64) {
  if (!family || !document.fonts) return;
  await ensureFontCss(family);
  try { await document.fonts.load(`${weight} ${size}px "${family}"`, '가나다ABC'); } catch (e) { /* 무시 */ }
  try { await document.fonts.load(`400 ${size}px "${family}"`, 'Aa가나다'); } catch (e) { /* 무시 */ }
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

/** 폰트 목록에서 이 폰트가 한글 글리프를 가지는지(대략) */
export function fontIsKorean(family) {
  const f = fontInfo(family);
  return !f || f.group !== 'en';
}

export function fontOptionsHtml(selected) {
  const groups = FONT_GROUPS.map((g) => ({
    name: g.name,
    items: g.id === 'mine' ? customFonts.map((f) => ({ family: f.family, label: f.label })) : BUILTIN_FONTS.filter((f) => f.group === g.id),
  }));
  return groups.map((g) => {
    if (!g.items.length) return '';
    return `<optgroup label="${g.name}">` + g.items.map((f) =>
      `<option value="${f.family}"${f.family === selected ? ' selected' : ''}>${f.label}</option>`).join('') + '</optgroup>';
  }).join('');
}
