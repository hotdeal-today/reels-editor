// presets.js — 글자 디자인 프리셋 (탭2 · AI 자동 세팅 공용)
export const PALETTE = ['#ffffff', '#000000', '#ffd84d', '#ffe94a', '#ff5f6d', '#ff6fa5', '#33e2b0', '#5b93ff', '#b78cff', '#ff9f43'];

export const PRESETS = [
  {
    id: 'clean', name: '깔끔 화이트', sample: '깔끔',
    style: { color: '#ffffff', bg: { on: false }, stroke: { on: false }, shadow: { on: true, color: '#000000', opacity: 60, x: 0, y: 6, blur: 14 } },
  },
  {
    id: 'neon', name: '네온 옐로우', sample: '네온',
    style: { color: '#ffe94a', bg: { on: false }, stroke: { on: true, color: '#241c00', width: 4 }, shadow: { on: true, color: '#ffdf3a', opacity: 85, x: 0, y: 0, blur: 26 } },
  },
  {
    id: 'blackbox', name: '자막 검정 박스', sample: '박스',
    style: { color: '#ffffff', bg: { on: true, color: '#000000', opacity: 72, radius: 10, padX: 22, padY: 10 }, stroke: { on: false }, shadow: { on: false } },
  },
  {
    id: 'mint', name: '민트 포인트', sample: '민트',
    style: { color: '#25e6b4', bg: { on: true, color: '#06231c', opacity: 62, radius: 99, padX: 24, padY: 12 }, stroke: { on: false }, shadow: { on: true, color: '#000000', opacity: 45, x: 0, y: 4, blur: 12 } },
  },
  {
    id: 'pink', name: '핑크 배지', sample: '핑크',
    style: { color: '#ff7aa8', bg: { on: true, color: '#2a0f1a', opacity: 82, radius: 99, padX: 24, padY: 12 }, stroke: { on: false }, shadow: { on: true, color: '#000000', opacity: 50, x: 0, y: 4, blur: 12 } },
  },
  {
    id: 'ref', name: '레퍼런스 화이트', sample: '화이트',
    style: { color: '#ffffff', bg: { on: false }, stroke: { on: true, color: '#0b0b0b', width: 6 }, shadow: { on: true, color: '#000000', opacity: 45, x: 0, y: 4, blur: 10 } },
  },
  {
    id: 'refglow', name: '레퍼런스 시안 발광', sample: '시안',
    style: { color: '#ffffff', bg: { on: false }, stroke: { on: true, color: '#127b96', width: 6 }, shadow: { on: true, color: '#7fe3ff', opacity: 90, x: 0, y: 0, blur: 24 } },
  },
];

/** 제목/배지/자막에 어울리는 프리셋 조합 */
export const DESIGN_SETS = {
  ref: { label: '레퍼런스 화이트 세트', title: 'ref', badge: 'refglow', subtitle: 'ref' },
  neon: { label: '네온 옐로우 세트', title: 'neon', badge: 'pink', subtitle: 'blackbox' },
  clean: { label: '깔끔 화이트 세트', title: 'clean', badge: 'mint', subtitle: 'clean' },
  bold: { label: '블랙박스 임팩트 세트', title: 'blackbox', badge: 'neon', subtitle: 'blackbox' },
};

export function presetById(id) { return PRESETS.find((p) => p.id === id) || null; }
