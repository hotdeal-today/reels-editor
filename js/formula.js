// formula.js — 릴스 자막 공식
//  ① 2026-11-26 레퍼런스 2편 분석: @home_tembbly "미니 폴더"(22.5초) · @homterior_pick "맥세이프 배터리 케이스"(28.4초)
//     원문 분석표: work/ref_reels_20261126/ANALYSIS.md  (제품 릴스 문법)
//  ② 2026-11-28 인스타 릴스 자막 5원칙: work/reels_caption_benchmark_20261128/report.md
//     → 숙소·여행 글에는 제품용 "~하지 마세요" 공식을 쓰지 않고, 한 편 = 한 문장(연결어미)으로 씁니다.
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
  subFirst: { x: 540, y: 1420 },  // 1컷 자막도 하단 세이프존(중앙 제품을 가리지 않게)
  subTop: { x: 540, y: 1290 },    // 1컷 자막을 상단 1/3 안쪽(67%)에 — 인스타 여행 릴스 표준
  subSafe: { x: 540, y: 1420 },   // 2컷~ 자막 (74%) — 인스타 캡션 UI 위
  endCardTop: { x: 540, y: 940 }, // 엔드카드 1줄 (49%)
  endCardBottom: { x: 540, y: 1060 }, // 엔드카드 2줄 (55%)
};

// ── 주제 구분(숙소·여행 / 상품 / 정보) ──────────────────
//  같은 자막 공식을 전 주제에 강제하던 것이 "어색한 자막"의 첫 번째 원인이었습니다.
//  숙소·여행은 지역 반전·거리+결과·공간 포인트로 열고, 상품만 문제 제기·금지 명령을 씁니다.
export const TOPIC_KINDS = {
  stay: { id: 'stay', label: '숙소·호캉스', cta: ['꼭 저장해두세요', "댓글에 '정보' 남겨주시면 보내드릴게요", '다음 숙소도? 팔로우하고 먼저 받아보세요'] },
  travel: { id: 'travel', label: '여행지·맛집', cta: ['꼭 저장해두세요', "댓글에 '정보' 남겨주시면 보내드릴게요", '다음 여행지도? 팔로우하고 먼저 받아보세요'] },
  product: { id: 'product', label: '제품·리빙', cta: ["댓글에 '정보' 남겨주시면 보내드릴게요", '꼭 저장해두세요', '자세한 건 본문에서 확인하세요'] },
  info: { id: 'info', label: '정보·꿀팁', cta: ['꼭 저장해두세요', "댓글에 '정보' 남겨주시면 보내드릴게요"] },
};

export function topicKindOf({ title = '', body = '', topic = '' } = {}) {
  const t = `${title} ${topic}`;
  const b = String(body || '').slice(0, 2500);
  const has = (re) => re.test(t);
  const inBody = (re) => re.test(b);
  const stay = /(숙소|호텔|펜션|리조트|료칸|온천|스파|풀빌라|독채|객실|체크인|호캉스|모텔|민박|글램핑|캠핑장)/;
  const product = /(제품|가전|두유|청소기|선풍기|가습기|공기청정|배터리|케이스|텀블러|무선|블루투스|쿠팡|네이버쇼핑|사용기)/;
  const info = /(퀴즈|정답|환율|시세|금리|대출|지원금|신청 방법|정리|꿀팀|꿀팁|방법|조건|한도|수수료|비교표|총정리|앱팀|포인트|이벤트)/;
  const travel = /(여행|맛집|카페|명소|축제|투어|공항|액티비티|나들이|당일치기|코스|걷기)/;
  // 숙소 글은 본문에도 온천·객실 같은 말이 많아 먼저 봅니다.
  if (has(stay)) return 'stay';
  if (has(product)) return 'product';
  // "환율·퀴즈·정리" 같은 정보 글은 여행 단어가 섞여도 정보 글로 둔다(숙소 후킹 공식을 쓰지 않게).
  if (has(info)) return 'info';
  if (has(travel)) return 'travel';
  if (inBody(stay)) return 'stay';
  if (inBody(product)) return 'product';
  if (inBody(info)) return 'info';
  if (inBody(travel)) return 'travel';
  return 'info';
}

export function topicKind(id) { return TOPIC_KINDS[id] || TOPIC_KINDS.info; }
export function isPlaceKind(id) { return id === 'stay' || id === 'travel'; }

// ── 카피 기본 틀(키 없는 원클릭) ────────────────────────
//  · 주제별로 나눕니다. 숙소·여행 글에 제품용 "~하지 마세요"를 쓰지 않습니다.
//  · 블로그·사진 문맥이 없을 때만 쓰는 '빈 자리 채우기' 문장이라, 사실 주장(가격·거리·효능)은 넣지 않습니다.
//  · 같은 문장을 3번 넘게 반복하지 않습니다(buildBeats).
export const DEFAULT_COPY_BY_KIND = {
  stay: [
    '먼저 방부터 보시면',     // 공간 소개
    '여기서 한 컷',           // 관찰
    '탕이 보이시죠',          // 포인트
    '창밖도 봐야죠',          // 뷰
    '아침 풍경까지',          // 흐름
    '이건 직접 가서',         // 여운
    '꼭 저장해두세요',        // CTA
  ],
  travel: [
    '여기서부터 시작이죠',
    '걸어서 한 바퀴',
    '사람 많은 쪽 말고',
    '이 코스로 가시면',
    '해 질 때가 제일 좋고',
    '사진은 여기서',
    '꼭 저장해두세요',
  ],
  product: [
    '아직도 그렇게 쓰세요?',
    '먼저 보여드릴게요',
    '생각보다 간단해요',
    '이런 점이 좋아요',
    '세척할 때만 좀 시끄러워요',
    "댓글에 '정보' 남겨주시면 보내드릴게요",
  ],
  info: [
    '이거 모르면 손해예요',
    '하나씩 보여드릴게요',
    '여기서 갈리더라고요',
    '순서만 바꿔도 달라요',
    '꼭 저장해두세요',
  ],
};

// 예전 이름(호환) — 숙소·여행 틀
export const DEFAULT_COPY = DEFAULT_COPY_BY_KIND.stay;
export function defaultCopy(kind) { return DEFAULT_COPY_BY_KIND[kind] || DEFAULT_COPY_BY_KIND.info; }

// ── 구조 단계(안내문·프롬프트 공용) ────────────────────
export const STORY_STEPS = [
  { key: 'hook', label: '① 문제 제기', share: 0.15, hint: '문제 한 문장 + "~하지 마세요" 금지 명령' },
  { key: 'turn', label: '② 전환', share: 0.10, hint: '"근데 이건…" 반전' },
  { key: 'solve', label: '③ 해결·체감', share: 0.45, hint: '동작→결과 쌍, 한 비트에 한 기능' },
  { key: 'info', label: '④ 정보', share: 0.12, hint: '기종·가격·스펙 한 줄' },
  { key: 'cta', label: '⑤ CTA', share: 0.10, hint: '"\'나도\' 남겨주세요" / "정보 드릴게요"' },
  { key: 'end', label: '⑥ 마무리', share: 0.08, hint: '엔드카드 2줄(제품명 + 후킹 재진술)' },
];

// 숙소·여행 글의 흐름 — 제품 공식 대신 쓰는 순서
export const STAY_STEPS = [
  { key: 'hook', label: '① 0~3초 후킹', share: 0.18, hint: '지역 반전 · 거리+결과 · 가장 강한 매력 1개' },
  { key: 'space', label: '② 공간 포인트', share: 0.50, hint: '사진마다 그 사진의 포인트 한 줄(연결어미)' },
  { key: 'info', label: '③ 조건·주의', share: 0.14, hint: '손해 방지 한 줄(휴무·세면도구·예약 조건)' },
  { key: 'cta', label: '④ CTA', share: 0.10, hint: '꼭 저장해두세요 / 댓글에 정보' },
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
 *  · copy(줄 배열)가 있으면 그 순서대로, 모자라면 그 주제의 기본 틀로 채웁니다.
 *  · 기본 틀은 한 바퀴 돌면 순서를 바꿔 붙여, 같은 문장이 3번 넘게 반복되지 않게 합니다.
 *  · {t}는 주제·프로젝트 이름으로 바꿉니다. 없는 사실은 지어내지 않습니다.
 */
export function buildBeats({ count = 8, topic = '', name = '', copy = null, kind = 'info' } = {}) {
  const t = String(topic || name || '').replace(/\s+/g, ' ').trim();
  const short = shortTopic(t, 12);
  const fill = (s) => String(s)
    .replace(/\{t\}/g, t)
    .replace(/\{ts\}/g, short)
    .trim();
  const base = defaultCopy(kind);
  const pool = (copy && copy.length ? copy : base).map(fill).filter(Boolean);
  const fallback = base.map(fill).filter(Boolean);
  const n = Math.max(1, Math.min(120, count | 0));
  const out = [];
  let round = 0;
  let bag = [];
  for (let i = 0; i < n; i++) {
    let tpl = '';
    if (pool.length) {
      if (round === 0) tpl = pool[i % pool.length];
      else tpl = pool[(i + round * 3) % pool.length];
    } else {
      tpl = fallback[i % Math.max(1, fallback.length)] || '';
    }
    if (i > 0 && out[i - 1] === tpl && fallback.length > 1) {
      const alt = fallback.find((x) => x !== out[i - 1]);
      if (alt) tpl = alt;
    }
    if (!tpl) {
      bag = bag.length ? bag : fallback.slice();
      tpl = bag.shift() || '';
    }
    if (i > 0 && tpl && tpl === out[i - 1]) { round++; }
    if ((i + 1) % Math.max(1, pool.length || fallback.length) === 0) round++;
    const line = /\{t|\{ts\}/.test(String(tpl)) ? fitLine(tpl, CAPTION_LIMIT) : String(tpl).slice(0, 40);
    out.push(line.trim());
  }
  return out;
}

// ── 자막 검사(길이·말투·라벨·호흡) ──────────────────────
export const CAPTION_LIMIT = 14;

// 평가어 — 실제 상위 릴스 자막에는 거의 나오지 않는 말(2026-11-28 관측)
export const EVAL_WORDS = [
  '가성비', '끝판왕', '미쳤', '필수템', '역대급', '총정리', '강추', '혜자', '대박', '인생샷', '최고', '완벽',
];
// 연결어미/조사로 끝나면 '한 문장을 끊은 자막'으로 봅니다.
const CONNECTIVE_END = /(고|서|며|면|는데|지만|니까|러|려고|다가|거나|든지|해도|어도|게|죠|네|더라고|거든|라서|어서|해서|하면|인데|아야|어야|여야|으면|다면|라면|려면)$/;
const PARTICLE_END = /(까지|부터|와|과|랑|이랑|도|만|쪽|안|너머|옆|위|아래|밖)$/;
const SPEECH_END = /(요|다|죠|네|까|니|음|함|세요)$/;

export function hasConnectiveEnding(s) { return CONNECTIVE_END.test(String(s || '').trim()); }
export function hasParticleEnding(s) { return PARTICLE_END.test(String(s || '').trim()); }
export function hasEvalWord(s) {
  const t = String(s || '');
  return EVAL_WORDS.some((w) => t.includes(w));
}
/** 서술어 없이 명사만 남은 라벨인지 ("포천 온심재" "7만 원대" "오션뷰 자쿠지") */
export function isLabelLike(s) {
  const t = String(s || '').replace(/[\s.!?~]/g, '');
  if (!t) return true;
  if (/[?]$/.test(String(s || '').trim())) return false;   // 반문형 후킹은 라벨이 아님
  if (SPEECH_END.test(t)) return false;          // 말끝이 있으면 문장
  if (CONNECTIVE_END.test(t)) return false;
  if (PARTICLE_END.test(t)) return false;
  if (/\d/.test(t) && t.length <= 8) return true;  // "7만원대" 같은 숫자 라벨
  return t.length <= 9;                            // 짧은 명사구 = 라벨 위험
}

/**
 * 자막 한 줄 검사 — 길이·말투에 더해 라벨/평가어/연결어미를 봅니다.
 * @returns {{len, bytes, ok, notes: string[], label: boolean, evalWord: boolean, connective: boolean}}
 */
export function checkCaption(text) {
  const s = String(text || '').trim();
  const len = s.replace(/\s/g, '').length;
  const bytes = s.length;
  const notes = [];
  const evalWord = hasEvalWord(s);
  const connective = hasConnectiveEnding(s) || hasParticleEnding(s);
  const label = isLabelLike(s) && !connective;
  if (len > CAPTION_LIMIT) notes.push(`길이 ${len}자 — ${CAPTION_LIMIT}자 이하로 줄이기`);
  if (len < 3 && len > 0) notes.push(`길이 ${len}자 — 너무 짧음(4자 이상)`);
  if (/[.。]$/.test(s)) notes.push('마침표로 끝남 — 빼기');
  if (/습니다|입니다/.test(s)) notes.push('설명문 말투 — 해요체 구어체로');
  if (evalWord) notes.push(`평가어(${EVAL_WORDS.filter((w) => s.includes(w)).join('·')}) — 빼기`);
  if (label) notes.push('라벨형(서술어 없음) — 연결어미로 문장으로');
  if (/(\d+\s*만?\s*원)\s*\/|\/\s*\d+\s*만?\s*원/.test(s) || (s.match(/\d+\s*만?\s*원/g) || []).length >= 2) notes.push('가격 나열 — 한 줄에 가격 하나만, 말로');
  return { len, bytes, ok: notes.length === 0, notes, label, evalWord, connective };
}

/** 자막 묶음의 문법 상태 (이어붙여 읽기·연결어미 비율·금지어 개수) */
export function captionGrammarReport(lines) {
  const list = (lines || []).map((s) => String(s || '').trim()).filter(Boolean);
  const items = list.map((s) => ({ s, ...checkCaption(s) }));
  const connectives = items.filter((it) => it.connective).length;
  const labels = items.filter((it) => it.label).length;
  const evals = items.filter((it) => it.evalWord).length;
  const dupes = list.length - new Set(list).size;
  return {
    count: list.length,
    connectives,
    connectiveRatio: list.length ? Math.round((connectives / list.length) * 100) : 0,
    labels,
    evals,
    dupes,
    bad: items.filter((it) => !it.ok).map((it) => ({ s: it.s, notes: it.notes })),
  };
}

// ── 프롬프트용 규칙 문장 ───────────────────────────────
//  공통 문법(한 편 = 한 문장, 금지어) + 주제별 후킹·CTA를 함께 넘깁니다.
export function hookRulesText(kind = 'info') {
  const k = TOPIC_KINDS[kind] ? kind : 'info';
  const place = isPlaceKind(k);
  const hookLine = place
    ? '숙소·여행: (a) 지역 반전 "여기가 한국이라고?" (b) 가격+조건 "조식까지 포함인데 6만 원대라고?" (c) 거리+결과 "서울에서 1시간, 방 안에서 온천?" (d) 희소·경고 "소문나면 망하는 ○○" 중 하나. 0~3초에 가장 강한 매력을 한 방에. 지명·숙소 정식명은 3컷 이후로.'
    : '상품: 숫자·대상·궁금증 "DM 폭발 받은 6만 원대 진열장" · "엄마도 몰랐던 ○○ 5가지". 문제가 있는 물건일 때만 금지 명령("~하지 마세요")을 쓴다.';
  return [
    '[자막 문법 — 이게 제일 중요하다]',
    '1) 한 편의 자막은 "한 문장"을 4~13자씩 끊은 것이다. 위에서 아래로 이어 읽으면 사람이 말하는 한 편의 이야기가 되어야 한다.',
    '2) 각 자막은 연결어미(~고, ~서, ~면, ~는데, ~며)나 조사(~와, ~까지)로 끝내고, 마지막 자막에서만 문장을 닫는다. 컷마다 완결문·정보 라벨을 만들지 않는다.',
    '3) 자막은 그대로 나레이션으로 읽힌다. 소리 내어 읽었을 때 안내방송처럼 들리면 다시 쓴다.',
    '4) 한 컷에 정보 하나. 숫자는 한 자막에 하나, 가격은 "~만 원대" "~부터"로 반올림하고 70~80%에서 한 번만.',
    '',
    '[첫 0~3초 후킹 — 주제별로 하나만]',
    `- ${hookLine}`,
    '- 금지: 인사말, 브랜드명·정식 상호로 시작, "가성비/끝판왕/미쳤다/필수템/역대급/총정리", 첫 컷에 지명만 박기.',
    '- 첫 컷은 15자 이내(1~2줄).',
    '',
    '[2컷 이후 — 사진마다 1:1]',
    '- 각 컷 자막은 그 컷 사진의 소제목·앞뒤 문단에서 확인되는 포인트 하나만 쓴다. 사진에 없는 내용을 붙이지 않는다.',
    '- 사진 순서를 바꾸지 않는다. 자막 개수 = 컷(사진) 개수.',
    '',
    '[말투]',
    '- 해요체 구어체. 반문("~라고?", "~잖아요?")과 회상("~더라고요")을 2~3번 섞는다. "~함/~음" 체, "~습니다" 설명체, "자세히 알아보겠습니다" 금지.',
    '',
    '[CTA — 마지막 1~2컷에 하나만]',
    `- ${(TOPIC_KINDS[k].cta || []).join(' / ')}`,
    '- 그 앞에 손해 방지 한 줄(주차·세면도구·휴무·취사·예약 조건)을 넣으면 저장률이 붙는다.',
    '- 화면 자막에 "자세한 내용은 프로필 링크에서 확인할 수 있습니다"는 쓰지 않는다(그건 캡션 문구).',
  ].join('\n');
}

export function placementRulesText() {
  return '배치: 1컷은 상단 후킹(제목·배지), 1컷 자막은 세로 58%, 2컷부터 자막은 하단 세이프존(세로 74%), 마지막 엔드카드는 가운데 2줄.';
}
