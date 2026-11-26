// formula.js — 레퍼런스 릴스 2편 분석 공식 (2026-11-26)
//  분석 대상: @home_tembbly "미니 폴더"(22.5초) · @homterior_pick "맥세이프 배터리 케이스"(28.4초)
//  원문 분석표: work/ref_reels_20261126/ANALYSIS.md
//
//  두 릴스의 공통 문법
//   ① 문제 제기·공감(0~15%)  "~하다고 / ~하지 마세요" · "~잖아요?" 반문
//   ② 전환(15~25%)          "근데 이건…"
//   ③ 해결·기능 체감(25~70%) 동작→결과 쌍. 한 비트에 한 기능
//   ④ 정보(70~80%)          기종·가격·스펙 한 줄("3만원대란 말이죠?")
//   ⑤ CTA(80~90%)           "'나도' 남겨주세요" / "정보 드릴게요"
//   ⑥ 마무리(90~100%)       엔드카드 2줄 또는 리훅 카드 + 금지 명령 클로징
//  자막: 4~13자 · 1줄 · 해요체 구어체 · 0.8~1.5초 호흡 · 숫자·스펙은 한 줄에 하나

// ── 자막 호흡(박자) ────────────────────────────────────
// steady = 기존 확정 기준(2~3초에 한 줄), ref = 레퍼런스 실측(0.8~1.5초)
//  예나님 지침·기존 결과물이 steady 기준이라 기본값은 steady로 두고,
//  레퍼런스처럼 빠른 호흡을 쓸 때만 ref를 고릅니다.
export const TEMPOS = {
  steady: { id: 'steady', label: '여유 (2~3초에 한 줄)', min: 2.0, ideal: 2.4, max: 3.0 },
  ref: { id: 'ref', label: '레퍼런스 (1.2~1.8초에 한 줄)', min: 1.2, ideal: 1.6, max: 2.2 },
};
export function tempoById(id) { return TEMPOS[id] || TEMPOS.steady; }

// ── 배치 기본값 (1080×1920 기준) ───────────────────────
// 1컷만 상단 후킹, 2컷부터는 하단 세이프존.
// 레퍼런스 실측: 자막 중심이 릴스 프레임 세로 25~60% 안(상단 계정줄·하단 캡션 UI 비움).
export const PLACEMENT = {
  title: { x: 540, y: 208 },      // 1컷 상단 후킹 (11%)
  badge: { x: 540, y: 318 },      // 1컷 배지 (17%)
  subFirst: { x: 540, y: 1120 },  // 1컷 자막 (58%) — 제품을 가리지 않는 자리
  subSafe: { x: 540, y: 1420 },   // 2컷~ 자막 (74%) — 인스타 캡션 UI 위
  endCardTop: { x: 540, y: 940 }, // 엔드카드 1줄 (49%)
  endCardBottom: { x: 540, y: 1060 }, // 엔드카드 2줄 (55%)
};

// ── 카피 기본 틀(키 없는 원클릭) ────────────────────────
// {t} = 주제(또는 프로젝트 이름). 없는 정보를 지어내지 않도록 사실 주장 없는 문장만 씁니다.
export const DEFAULT_COPY = [
  '아직도 그렇게 쓰세요?',     // ① 문제 제기(주제는 1컷 제목·엔드카드가 담당)
  '그냥 넘기지 마세요',        // ① 문제 제기(금지 명령)
  '이거 하나면 달라요',        // ② 전환
  '먼저 보여드릴게요',         // ③ 해결
  '생각보다 간단해요',         // ③ 해결·체감
  '이런 점이 좋아요',          // ③ 기능
  '가격까지 확인하세요',       // ④ 정보
  '정보 드릴게요',             // ⑤ CTA
  "'나도' 남겨주세요",         // ⑤ CTA(댓글 유도)
];

// ── 구조 단계(안내문·프롬프트 공용) ────────────────────
export const STORY_STEPS = [
  { key: 'hook', label: '① 문제 제기', share: 0.15, hint: '문제 한 문장 + "~하지 마세요" 금지 명령' },
  { key: 'turn', label: '② 전환', share: 0.10, hint: '"근데 이건…" 반전' },
  { key: 'solve', label: '③ 해결·체감', share: 0.45, hint: '동작→결과 쌍, 한 비트에 한 기능' },
  { key: 'info', label: '④ 정보', share: 0.12, hint: '기종·가격·스펙 한 줄' },
  { key: 'cta', label: '⑤ CTA', share: 0.10, hint: '"\'나도\' 남겨주세요" / "정보 드릴게요"' },
  { key: 'end', label: '⑥ 마무리', share: 0.08, hint: '엔드카드 2줄(제품명 + 후킹 재진술)' },
];

export const END_CARD = { top: '{t} 하나로', bottom: '그냥 지나치지 마세요' };

/** "1컷 상단 후킹 · 2컷~ 하단 세이프존" 배치를 구간에 적용합니다. */
export function layoutSegments(segs, firstEnd = 0) {
  const list = (segs || []).slice().sort((a, b) => a.start - b.start);
  if (!list.length) return segs;
  list.forEach((sg, i) => {
    if (!sg.pos) sg.pos = {};
    if (i === 0) {
      sg.pos.title = { ...PLACEMENT.title };
      sg.pos.badge = { ...PLACEMENT.badge };
      sg.pos.subtitle = { ...PLACEMENT.subFirst };
      if (firstEnd > sg.start + 0.2 && sg.end < firstEnd - 0.05 && sg.end > sg.start) {
        // 1컷(첫 클립)이 자막 한 칸보다 길면 1컷 끝까지 늘립니다(상단 후킹이 1컷에 머물도록).
        sg.end = Math.min(firstEnd, Math.max(sg.end, sg.start + 0.4));
      }
    } else {
      sg.pos.subtitle = { ...PLACEMENT.subSafe };
      if (sg.pos.title) delete sg.pos.title;
      if (sg.pos.badge) delete sg.pos.badge;
    }
  });
  return segs;
}

/** 마지막 구간을 2줄 엔드카드(가운데)로 만듭니다. */
export function applyEndCard(seg, lines) {
  if (!seg) return seg;
  const [top, bottom] = (lines || []).map((t) => String(t || '').trim());
  if (!top) return seg;
  seg.title = top;
  seg.badge = '';
  seg.subtitle = bottom || '';
  if (!seg.pos) seg.pos = {};
  seg.pos.title = { ...PLACEMENT.endCardTop };
  seg.pos.subtitle = { ...PLACEMENT.endCardBottom };
  return seg;
}

/** 주제에서 뒤쪽 단어만 남겨 짧은 이름을 만듭니다("아이폰 사진 백업 미니 폴더" → "사진 백업 미니 폴더"). */
export function shortTopic(t, max = 12) {
  const words = String(t || '').split(/\s+/).filter(Boolean);
  let out = '';
  for (let i = words.length - 1; i >= 0; i--) {
    const next = out ? `${words[i]} ${out}` : words[i];
    if (next.length > max) break;
    out = next;
  }
  return out || String(t || '').slice(0, max);
}

/** 한 줄 자막을 14자 안으로 자릅니다(단어 경계). */
export function fitLine(s, limit = CAPTION_LIMIT) {
  const str = String(s || '').trim();
  if (str.length <= limit) return str;
  const words = str.split(/\s+/).filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > limit) break;
    out = next;
  }
  return (out || str.slice(0, limit)).trim();
}

/** 주제·이름에서 엔드카드 2줄을 만듭니다. */
export function endCardLines({ topic = '', name = '' } = {}) {
  const t = shortTopic(String(topic || name || '').replace(/\s+/g, ' ').trim(), 10);
  if (!t) return ['오늘의 추천', '그냥 지나치지 마세요'];
  return [fitLine(`${t} 하나로`, 14), fitLine(END_CARD.bottom, 14)];
}

/** 카피 틀(줄 단위)을 실제 자막 문장 배열로 바꿉니다. */
export function copyLinesFromText(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.replace(/^\s*(?:[-•·]|\d+[.)\]])\s*/, '').trim())
    .filter(Boolean);
}

/**
 * 키 없는 원클릭용 자막 문장을 만듭니다.
 *  · copy(줄 배열)가 있으면 그 순서대로, 모자라면 DEFAULT_COPY로 채웁니다.
 *  · {t}는 주제·프로젝트 이름으로 바꿉니다. 없는 사실은 지어내지 않습니다.
 */
export function buildBeats({ count = 8, topic = '', name = '', copy = null } = {}) {
  const t = String(topic || name || '').replace(/\s+/g, ' ').trim();
  const short = shortTopic(t, 12);
  const fill = (s) => String(s)
    .replace(/\{t\}/g, t)
    .replace(/\{ts\}/g, short)
    .trim();
  const pool = (copy && copy.length ? copy : DEFAULT_COPY).map(fill).filter(Boolean);
  const fallback = DEFAULT_COPY.map(fill).filter(Boolean);
  const n = Math.max(1, Math.min(120, count | 0));
  const out = [];
  for (let i = 0; i < n; i++) {
    const tpl = pool.length ? pool[i % pool.length] : (fallback[i % fallback.length] || '');
    // {t}가 들어간 문장만 14자 제한으로 다듬습니다(직접 쓴 카피는 그대로 살립니다).
    const line = /\{t|\{ts\}/.test(String(tpl)) ? fitLine(tpl, CAPTION_LIMIT) : String(tpl).slice(0, 40);
    out.push(line.trim());
  }
  return out;
}

// ── 자막 검사(길이·호흡) ───────────────────────────────
export const CAPTION_LIMIT = 14;
export function checkCaption(text) {
  const s = String(text || '').trim();
  const len = s.replace(/\s/g, '').length;
  const bytes = s.length;
  const notes = [];
  if (len > CAPTION_LIMIT) notes.push(`길이 ${len}자 — ${CAPTION_LIMIT}자 이하로 줄이기`);
  if (/[.。]$/.test(s)) notes.push('마침표로 끝남 — 빼기');
  if (/습니다|입니다/.test(s)) notes.push('설명문 말투 — 해요체 구어체로');
  return { len, bytes, ok: notes.length === 0, notes };
}

// ── 프롬프트용 규칙 문장 ───────────────────────────────
export function hookRulesText() {
  return [
    '[레퍼런스 공식 — 2편 실측]',
    '1) 구조: ① 문제 제기·공감 → ② 전환("근데 이건…") → ③ 해결·기능 체감 → ④ 정보(기종·가격·스펙) → ⑤ CTA → ⑥ 마무리. 제품은 15~25% 지점에 처음 등장시키고, 정보·가격은 70~80%에서 한 번만 던진다.',
    '2) 1컷 후킹: 문제를 짧은 문장으로 던지고 바로 다음 자막에 "~하지 마세요" 금지 명령을 붙인다(예: "핸드폰 용량 부족하다고" → "사진 지우지 마세요"). 후킹은 2~4비트로 쪼개고 3초를 넘기지 않는다.',
    '3) ③해결 구간: 기능 하나를 "동작 → 결과" 두 비트로 쓴다(예: "버튼만 딱 누르면" → "바로 충전됩니다"). 기능을 나열하지 말고 한 비트에 하나만.',
    '4) 자막 길이: 한 줄 4~13자(최대 14자), 1줄. 두 정보를 한 줄에 넣지 않는다. 숫자·스펙은 한 자막에 하나.',
    '5) 말투: 해요체 구어체. 말끝 올리기·반문을 1~2번 섞는다("~거든요?", "~잖아요?", "~있죠?", "~더라고요"). 설명문·존댓말체·"자세히 알아보겠습니다" 금지.',
    '6) ④정보: "3만원대란 말이죠?"처럼 짧게 던지고 스펙을 길게 풀지 않는다.',
    '7) ⑤CTA: 댓글 유도("\'나도\' 남겨주세요", "정보 드릴게요") 또는 블로그 유도("자세한 내용은 본문에서 확인하세요👇") 중 하나.',
    '8) ⑥마무리: 엔드카드는 2줄 — 윗줄 제품명·한 줄 요약(12자 이내), 아랫줄은 1컷 후킹을 그대로 반복. 중간에 지루한 구간이 생기면 자막 없는 제품 컷 2~3초 + 큰 리훅 카드("~분들 무조건 보세요")로 이탈을 막는다.',
    '9) 자막 색·모양: 흰 글씨 + 검정 외곽선이 기본(레퍼런스 공통). 강조 카드만 시안 발광을 쓴다.',
    '10) 배치: 1컷만 상단 후킹, 2컷부터는 하단 세이프존(세로 70~78%). 상단 15%·하단 20%에는 아무것도 두지 않는다.',
  ].join('\n');
}

export function placementRulesText() {
  return '배치: 1컷은 상단 후킹(제목·배지), 1컷 자막은 세로 58%, 2컷부터 자막은 하단 세이프존(세로 74%), 마지막 엔드카드는 가운데 2줄.';
}
