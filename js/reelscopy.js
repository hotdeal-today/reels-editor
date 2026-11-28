// reelscopy.js — 사진 문맥 → 자막 한 줄 (사진 1:1 매칭 · 한 문장 이어쓰기)
//  근거: work/reels_caption_benchmark_20261128/report.md (인스타 릴스 자막 5원칙)
//   ① 한 편 = 한 문장. 컷마다 연결어미(~고/~서/~며/~면)나 조사(~까지/~와)로 끝낸다.
//   ② 자막 = 나레이션 대본. 라벨("7만 원대")·평가어("가성비 끝판왕") 금지.
//   ③ 0~3초 후킹은 주제별 공식(숙소·여행 = 지역 반전 / 거리+결과 / 공간 포인트 1개).
//   ④ 한 컷 4~13자, 한 컷에 정보 하나.
//   ⑤ CTA는 마지막 1~2컷. 그 앞에 손해 방지 한 줄.
//
//  이 파일은 블로그 사진의 '앞뒤 문단 + 소제목' 문맥만으로 자막을 만듭니다.
//  (Gemini 키가 없어도 원클릭 결과가 사진과 1:1로 맞도록 하는 것이 목적)
import { checkCaption, topicKindOf, isPlaceKind, topicKind, hasEvalWord, CAPTION_LIMIT } from './formula.js';

export const LINE_LIMIT = 13;      // 공백 제외 4~13자 (report §3)
const MIN_LEN = 4;

// ── 문자열 유틸 ─────────────────────────────────────────
const NO_SPACE = /\s/g;
export function noSpace(s) { return String(s || '').replace(NO_SPACE, ''); }

function vowelFinal(ch) {
  const c = String(ch || '').charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0;
  return false;
}

/** 문장부호로 나눈 뒤 연결어미 뒤에서 한 번 더 끊습니다. (\"…있고 그 욕실에\" → \"…있고\" + \"그 욕실에\") */
export function clauseSplit(text) {
  const raw = String(text || '')
    .replace(/[\[\]{}<>]/g, ' ')
    .replace(/[“”"'’‘]/g, ' ')
    .replace(/[·•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return [];
  const sents = raw
    .replace(/([.!?~])\s+/g, '$1\n')
    .replace(/([,、])\s*/g, '$1\n')
    .split('\n')
    .map((s) => s.trim().replace(/[,、]$/, '').trim())
    .filter(Boolean);
  const END = /(고|서|며|면|는데|지만|니까|라서|어서|해서|해도|어도|다가|거나|든지|려고|더라고|아니라|이라서|라도)$/;
  const out = [];
  for (const sent of sents) {
    const words = sent.split(' ');
    let cur = [];
    for (const w of words) {
      cur.push(w);
      const joined = cur.join(' ');
      // 한 글자짜리 "서·고"는 동사 줄기일 수 있어 나누지 않습니다("따로 서 있어")
      if (END.test(w) && w.length >= 2 && noSpace(joined).length >= 6) {
        out.push(joined.replace(/[.!?~,]+$/, '').trim());
        cur = [];
      }
    }
    if (cur.length) out.push(cur.join(' ').replace(/[.!?~,]+$/, '').trim());
  }
  return out.filter((s) => noSpace(s).length >= 2);
}

const CONNECTIVE = /(고|서|며|면|는데|지만|니까|러|려고|다가|거나|든지|해도|어도|라서|어서|해서|죠|네|더라고|거든|아야|어야|여야|으면|다면|라면|려면|잖아|거죠)$/;
const PARTICLE = /(까지|부터|와|과|랑|이랑|로|으로|도|만)$/;
// 줄 끝에 남으면 말이 안 되는 꼬리(부사·관형어) — 후보에서 뺍니다.
const DANGLING = /(처럼|만큼|정도로|이나|하고|해서|위해|대한|같은|위한|하는|되는|있는|없는|잘|좀|더|덜|아주|너무|조용히|깔끔히|살짝|바로|특히|다시|먼저|역시|그리고|그래서|근데|하지만)$/;

/** 해요체로 끝나는 말을 연결어미로 바꿉니다. (\"들어와요\" → \"들어와서\", \"있어요\" → \"있어서\") */
export function toConnective(input) {
  let t = String(input || '').trim().replace(/[.!?~,]+$/, '').trim();
  if (!t) return '';
  if (CONNECTIVE.test(t) || PARTICLE.test(t)) return t;
  const map = [
    [/이거든요$/, '이라서'],
    [/거든요$/, '거든'],
    [/더라고요$/, '더라고'],
    [/더라구요$/, '더라구'],
    [/다더라$/, '다더라'],
    [/는데요$/, '는데'],
    [/지요$/, '죠'],
    [/네요$/, '네'],
    [/해요$/, '해서'],
    [/예요$/, '라서'],
    [/이에요$/, '이라서'],
    [/합니다$/, '하고'],
    [/됩니다$/, '되고'],
    [/입니다$/, '이고'],
    [/있습니다$/, '있고'],
    [/없습니다$/, '없고'],
    [/습니다$/, '고'],
  ];
  for (const [re, rep] of map) if (re.test(t)) return t.replace(re, rep);
  // "~하세요"는 그대로 둡니다(권유·주의 한 줄은 문장으로 읽힙니다).
  if (/(으)?세요$/.test(t)) return t;
  if (/요$/.test(t)) {
    const stem = t.slice(0, -1);
    if (/하$/.test(stem)) return `${stem.slice(0, -1)}해서`;
    if (/되$/.test(stem) || /돼$/.test(stem)) return `${stem}서`;
    if (vowelFinal(stem.slice(-1))) return `${stem}서`;
    return `${stem}어서`;
  }
  return t;
}

const HEAD_FILLER = ['저는', '저희는', '제가', '여기는', '여기가', '거기는', '그래서', '그리고', '하지만', '다만', '역시', '정말', '너무', '아주', '진짜', '사실', '그냥', '근데', '또'];
const TAIL_FILLER = /(생각이 들었|느낌이었|기분이었|것 같아요|것 같았|좋았어요|좋더라고요|좋답니다|추천해요|추천합니다|만족했|편했어요|예뻤어요|멋졌어요|유명해요|많아요|많더라고요)$/;

const FUNC_WORD = /^(해도|하고|에서|으로|부터|까지|까지는|이라|라고|라서|인데|이고|이며|이랑|랑|은|는|이|가|을|를|에|의|도|만|과|와|게|지|데|데다|나|야|요|고|서|며|면)$/;

/** 4~13자로 맞춥니다. 앞 군더더기를 빼고, 그래도 길면 앞쪽 단어를 버려 서술어(끝)를 살립니다. */
export function fitLine13(input, limit = LINE_LIMIT) {
  let s = String(input || '').replace(/\s+/g, ' ').trim().replace(/[.!?~,]+$/, '').trim();
  if (!s) return '';
  let guard = 0;
  while (guard++ < 4) {
    let hit = false;
    for (const w of HEAD_FILLER) {
      if (s.startsWith(`${w} `)) { s = s.slice(w.length + 1).trim(); hit = true; }
    }
    if (!hit) break;
  }
  if (noSpace(s).length <= limit) return s;
  const words = s.split(' ');
  while (words.length > 2 && noSpace(words.join(' ')).length > limit) words.shift();
  // 앞에 조사·어미만 남았으면 떼어 냅니다("해도 물이…" → "물이…").
  let cutGuard = 0;
  while (words.length > 1 && FUNC_WORD.test(words[0]) && cutGuard++ < 4) {
    const rest = words.slice(1);
    if (noSpace(rest.join(' ')).length < MIN_LEN) break;
    words.shift();
  }
  let out = words.join(' ').trim();
  if (noSpace(out).length > limit) {
    // 단어 하나가 길면 뒤(서술어)에서 잘라 냅니다.
    const chars = out.split('');
    let tail = '';
    for (let i = chars.length - 1; i >= 0 && noSpace(tail).length < limit; i--) tail = chars[i] + tail;
    out = tail.trim();
  }
  return out;
}

// ── 후보 뽑기 ───────────────────────────────────────────
const FEATURE = /(온천수|온천|자쿠지|노천탕|스파|사우나|수영장|오션뷰|바다|통창|뷰|전망|정원|테라스|루프탑|모닥불|침대|조식|석식|티클래스|미온수|독채|프라이빗|다실|누마루|온수|주차|셔틀|객실|탕|욕실|창|아침|밤|노을)/;
const IMPRESSION = /(좋았|좋더라|만족|추천|편했|예뻤|멋졌|훌륭|인상적|기분|완벽|최고|대박)/;

/** 자막에 들어간 대표 소재(온천수·자쿠지…) — 앞 컷과 같은 소재가 반복되면 점수를 낮춥니다. */
export function featureOf(line) {
  const m = String(line || '').match(FEATURE);
  return m ? m[1] : '';
}

export function isPriceLine(line) {
  const m = String(line || '').match(/\d+\s*만?\s*원/g);
  return !!m && m.length >= 1;
}

/**
 * 사진 한 장의 문맥에서 자막 후보를 뽑습니다.
 *  · before/after 줄들을 한 문단으로 붙쳐 다시 문장으로 나눕니다(줄바꿈으로 끊긴 말을 살립니다).
 * @param {{section?:string, before?:string[]|string, after?:string[]|string, alt?:string}} ctx
 */
export function candidatesFromContext(ctx = {}, { limit = LINE_LIMIT, avoidFeatures = [] } = {}) {
  const avoid = new Set((avoidFeatures || []).filter(Boolean));
  const join = (v) => (Array.isArray(v) ? v.join(' ') : String(v || ''));
  const afterLines = clauseSplit(join(ctx.after));
  const beforeLines = clauseSplit(join(ctx.before)).reverse();
  const out = [];
  const seen = new Set();
  const push = (cl, weight, src) => {
    if (!cl) return;
    const raw = String(cl).replace(/^\s*(Q|A|Q\.|A\.|질문|답변)\s*[.:]\s*/i, '').trim();
    if (!raw) return;
    if (hasEvalWord(raw)) return;
    if (TAIL_FILLER.test(raw)) return;
    // 물음표·의문 말끝은 반문형으로 살립니다(말끝을 억지로 바꾸지 않음).
    const isQ = /\?$/.test(raw) || /(인가|는가|나|을까|까|죠)요$/.test(raw);
    const line = isQ ? fitLine13(raw.replace(/요$/, '?'), limit) : fitLine13(toConnective(raw), limit);
    const len = noSpace(line).length;
    if (len < MIN_LEN || len > limit) return;
    if (DANGLING.test(line)) return;
    const key = noSpace(line);
    if (seen.has(key)) return;
    seen.add(key);
    const chk = checkCaption(line);
    if (chk.evalWord) return;
    let score = weight;
    if (FEATURE.test(line)) score += 3;
    if (chk.connective) score += 2;
    if (chk.label) score -= 5;
    if (isPriceLine(line)) score -= 7;                     // 가격 라벨 금지(report §2)
    if (IMPRESSION.test(line)) score -= 2;
    if (/^\S{1,3}\s/.test(line)) score -= 1;               // "그 방은" 같은 지시어로 시작
    if (avoid.size && avoid.has(featureOf(line))) score -= 5;   // 앞 컷과 같은 소재 반복 방지
    if (len >= 5 && len <= 11) score += 1;
    out.push({ line, score, src, len });
  };
  afterLines.slice(0, 8).forEach((cl, i) => push(cl, 8 - Math.min(i, 4), 'after'));
  beforeLines.slice(0, 5).forEach((cl, i) => push(cl, 7 - Math.min(i, 3), 'before'));
  if (ctx.alt && noSpace(ctx.alt).length >= MIN_LEN) push(ctx.alt, 4, 'alt');
  if (!out.length && ctx.section) push(ctx.section, 5, 'section');
  out.sort((a, b) => b.score - a.score);
  return out;
}

const keyOf = (line) => noSpace(line).slice(0, 5);

/**
 * 그 사진의 포인트 한 줄. 이미 쓴 줄·비슷한 줄은 건너뜁니다.
 * @returns {string}
 */
export function pickPointLine(ctx = {}, { used = new Set(), limit = LINE_LIMIT, avoid = [], avoidFeatures = [] } = {}) {
  const usedKeys = new Set([...used].map(keyOf).concat(avoid.map(keyOf)));
  const cands = candidatesFromContext(ctx, { limit, avoidFeatures });
  for (const c of cands) {
    if (c.score < 0) continue;
    if (usedKeys.has(keyOf(c.line))) continue;
    return c.line;
  }
  const first = cands[0];
  return first ? first.line : '';
}

// ── 0~3초 후킹 ─────────────────────────────────────────
const CITIES = ['서울', '부산', '대구', '대전', '광주', '인천', '수원', '울산'];

function firstSectionTexts(images = [], section = '') {
  const sec = section || (images[0] && images[0].section) || '';
  const out = [sec];
  for (const im of images) {
    if (sec && im.section !== sec) continue;
    out.push(...(im.before || []), ...(im.after || []));
  }
  return out.join(' ');
}

function firstFeature(text) {
  const m = String(text || '').match(/(온천수|온천|자쿠지|야외 ?노천탕|노천탕|스파|사우나|오션뷰|통창|루프탑|모닥불|개인 ?정원|정원|테라스|다실)/);
  if (!m) return '';
  const w = m[1].replace(/\s/g, '');
  if (w === '야외노천탕') return '노천탕';
  if (w === '개인정원') return '정원';
  return w;
}

/**
 * 첫 컷(0~3초) 후킹 두 줄. 숙소·여행은 지역 반전 / 거리+결과 / 희소·경고 / 조건 반전 순서로,
 * 실제 본문에 있는 사실만 씁니다.
 * @returns {{title:string, sub:string, formula:string}}
 */
export function buildHookBeats({ title = '', body = '', topic = '', kind = 'info', images = [] } = {}) {
  const k = topicKindOf({ title, body, topic });
  const text = `${title}\n${body}`;
  const firstSec = firstSectionTexts(images);
  const feature = firstFeature(firstSec) || firstFeature(text);
  const priceFirst = (String(body || '').match(/(\d{1,3})\s*만\s*원/) || [])[1] || '';

  if (isPlaceKind(k)) {
    // ① 거리 + 결과
    const dm = text.match(new RegExp(`(${CITIES.join('|')})에서[^.\\n]{0,14}?(한\\s*시간|\\d{1,2}\\s*시간|\\d{1,3}\\s*분)`));
    if (dm && feature) {
      const city = dm[1];
      const dur = /분/.test(dm[2]) ? dm[2].replace(/\s/g, '') : '한 시간';
      return {
        title: `${city}에서 ${dur}이면`,
        sub: `방 안에 ${feature}가?`,
        formula: '거리+결과',
      };
    }
    // ② 희소·경고 (매진·마감)
    if (/(매진|마감|금방 빠|서두르|빨리 빠)/.test(text)) {
      const mm = text.match(/(\d{1,2})\s*월/);
      const mon = mm ? `${mm[1]}월` : '이번 달';
      return {
        title: `${mon} 주말은 벌써 매진`,
        sub: feature ? `${feature} 때문에 그래요` : '지금 안 잡으면 없어요',
        formula: '희소·경고',
      };
    }
    // ③ 조건·반전
    const incl = text.match(/(조식|석식|티클래스|식사)[^.\\n]{0,12}포함/);
    if (incl) {
      return {
        title: `${incl[1]}까지 포함인데`,
        sub: priceFirst ? `${priceFirst}만 원대라고?` : '값이 궁금하시죠?',
        formula: '가격+조건',
      };
    }
    // ④ 공간 포인트
    if (feature) {
      return { title: `여기 ${feature}부터`, sub: '보시면 바로 이해돼요', formula: '공간 포인트' };
    }
  } else {
    // 상품: 숫자·문제·궁금증
    const num = text.match(/(\d{1,3}\s*분|\d{1,2}\s*시간|\d{1,3}\s*ml|\d{1,2}\s*단계|\d{1,2}\s*가지)/);
    if (k === 'product') {
      if (num && feature) return { title: `${num[1]}이면 끝나요`, sub: `${feature} 하나로`, formula: '숫자·궁금증' };
      if (num) return { title: `${num[1]}이면 끝나요`, sub: '이게 되더라고요', formula: '숫자·궁금증' };
      if (priceFirst) return { title: `${priceFirst}만 원대인데`, sub: '이 정도면 괜찮죠?', formula: '숫자·궁금증' };
    }
    // 제목의 후킹 조각(라벨처럼 끝나지 않는 것)을 첫 줄로
    const parts = String(title || '').split(/[,·|]/).map((s) => s.trim()).filter((s) => noSpace(s).length >= 4);
    const good = parts.filter((s) => !checkCaption(fitLine13(s)).label && noSpace(s).length <= LINE_LIMIT);
    const pickTitle = (good[good.length - 1] || parts[parts.length - 1] || '');
    if (pickTitle) return { title: fitLine13(pickTitle), sub: '숫자부터 보시면', formula: '제목 조각' };
  }
  // 마지막: 첫 사진 포인트를 후킹으로
  const firstLine = pickPointLine((images.find((im) => im.role !== 'infocard') || images[0]) || {}, {});
  if (firstLine) return { title: firstLine, sub: '여기부터 보세요', formula: '사진 포인트' };
  return { title: '이거 보고 가세요', sub: '30초만 봐주세요', formula: '기본' };
}

// ── 마무리(손해 방지 + CTA) ─────────────────────────────
function dayOffLine(text) {
  const m = String(text || '').match(/([월화수목금토일](?:\s*[·,\/]\s*[월화수목금토일])?)\s*휴무/);
  if (!m) return '';
  const days = m[1].replace(/\s/g, '');
  const sub = String(text).match(/([가-힣]{2,6}(?:온천|리조트|호텔|스파|탕|찜질방|식당|카페))[은는이가]?\s*[월화수목금토일]/);
  const name = sub ? sub[1] : '';
  return name && noSpace(`${name}은 ${days} 휴무`).length <= LINE_LIMIT ? `${name}은 ${days} 휴무` : `${days}는 휴무예요`;
}

export function lossLine(body = '', { section = '' } = {}) {
  const b = String(body || '').replace(/\s+/g, ' ');
  const near = String(section || '');
  const rules = [
    { re: /(칫솔|치약)[^.\n]{0,24}(없|준비|챙기)/, make: () => '칫솔·치약은 챙기세요' },
    { re: /당일 예약[^.\n]{0,12}(안|어렵|불가)/, make: () => '당일 예약은 안 돼요' },
    { re: /(미리|하루 전|전날)[^.\n]{0,10}(신청|예약)/, make: () => '미리 신청해야 해요' },
    { re: /(취사|조리)[^.\n]{0,10}(안|불가|없)/, make: () => '객실 취사는 안 돼요' },
    { re: /(주차)[^.\n]{0,10}(협소|어렵|안됨)/, make: () => '주차 자리는 좁아요' },
  ];
  for (const r of rules) {
    if (!r.re.test(b)) continue;
    const line = fitLine13(r.make());
    if (noSpace(line).length >= MIN_LEN) return line;
  }
  // 휴무는 특정 장소 이야기라, 그 소제목(섹션) 안에서 말할 때만 씁니다.
  const hm = b.match(/([월화수목금토일](?:\s*[·,\/]\s*[월화수목금토일])?)\s*휴무/);
  if (hm) {
    const sub = b.match(/([가-힣]{2,6}(?:온천|리조트|호텔|스파|탕|찜질방|식당|카페))[은는이가]?\s*[월화수목금토일]/);
    const name = sub ? sub[1] : '';
    if (!name || (near && near.includes(name)) || !near) {
      const line = dayOffLine(b);
      if (line && noSpace(line).length >= MIN_LEN) return line;
    }
  }
  return '';
}

export function lossLineNear(body = '', { section = '' } = {}) {
  const own = lossLine(section, { section });
  if (own) return own;
  return lossLine(body, { section });
}

export function ctaLine(kind = 'info') {
  const k = topicKind(kind);
  const list = (k.cta || []).slice();
  return list[0] || '꼭 저장해두세요';
}

// ── 블로그 사진 → 컷별 자막 ────────────────────────────
export function isReelPhoto(img) {
  if (!img) return false;
  if (img.role && img.role !== 'photo') return false;
  return !!img.url || !!img.assetId;
}

/**
 * 컷(사진) 목록 → 릴스 자막 계획. (구성은 buildPhotoPlan 과 같고, 필터링 없이 받은 순서 그대로 씁니다)
 * @param {Array<{section,before,after,alt,role}>} contexts 컷 순서대로
 * @returns {{title,badge,kind,segments:Array,design:string,endcard:Array}}
 */
export function buildPlanFromCuts(contexts = [], { title = '', body = '', topic = '' } = {}) {
  return planFromContexts(contexts.filter(Boolean), { title, body, topic });
}

/**
 * 블로그 사진들로 릴스 자막 계획을 만듭니다. (사진 1장 = 컷 1개)
 *   컷 1 = 후킹 / 가운데 = 사진마다 그 사진의 포인트 / 마지막 2컷 = 손해 방지 + CTA
 * @returns {{title,badge,kind,segments:Array,design:string,endcard:Array}}
 */
export function buildPhotoPlan({ images = [], title = '', body = '', topic = '', targetSec = 18 } = {}) {
  return planFromContexts((images || []).filter(isReelPhoto), { title, body, topic, targetSec });
}

function planFromContexts(photos = [], { title = '', body = '', topic = '' } = {}) {
  const n = photos.length;
  const kind = topicKindOf({ title, body, topic });
  const hook = buildHookBeats({ title, body, topic, images: photos });
  const cta = ctaLine(kind, body);
  if (!n) return { title: hook.title, badge: '', kind, segments: [], design: 'ref', endcard: [] };

  const used = new Set([hook.title, hook.sub]);
  const usedFeatures = [featureOf(hook.sub)];
  const segments = [{ cut: 0, title: hook.title, subtitle: hook.sub }];
  const lastTwo = n >= 5;
  const pointsEnd = lastTwo ? n - 2 : n - 1;   // 이 앞까지가 사진 포인트

  for (let i = 1; i < pointsEnd; i++) {
    const line = pickPointLine(photos[i], { used, avoidFeatures: usedFeatures }) || pickPointLine(photos[i], {});
    if (line) { used.add(line); usedFeatures.push(featureOf(line)); }
    segments.push({ cut: i, subtitle: line || `사진 ${i + 1} 보시면` });
  }
  if (lastTwo) {
    const lastIm = photos[n - 2] || {};
    const loss = lossLineNear(body, { section: String(lastIm.section || '') });
    const line = loss && !used.has(loss) ? loss : pickPointLine(lastIm, { used });
    segments.push({ cut: n - 2, subtitle: line || '여기까지 오셨으면' });
    segments.push({ cut: n - 1, subtitle: cta });
  } else {
    segments.push({ cut: n - 1, subtitle: cta });
  }

  // 배지 — 평가어 대신 사실만 (숙소 3곳 / 온천수 등). 정보·제품 글엔 배지를 두지 않습니다.
  if (!isPlaceKind(kind)) return { title: hook.title, badge: '', kind, segments, design: 'ref', endcard: [], hookFormula: hook.formula, cta };
  const GENERIC_SEC = /(자주 ?묻는|Q\s*&\s*A|FAQ|마무리|마지막|링크|함께 ?보면|정리|준비물|코스|지도|교통)/i;
  const sections = Array.from(new Set(photos.map((p) => String(p.section || '').trim()).filter((s) => s && !GENERIC_SEC.test(s))));
  let badge = '';
  if (sections.length >= 2) badge = `${sections.length}곳`;
  else {
    const f = firstFeature(firstSectionTexts(photos));
    if (f && noSpace(f).length <= 6) badge = f;
  }
  return { title: hook.title, badge, kind, segments, design: 'ref', endcard: [], hookFormula: hook.formula, cta };
}

// ── 클립 ↔ 블로그 사진 매칭 ────────────────────────────
/** 클립(assetId)과 블로그 사진을 순서대로 맞춰 컷별 문맥을 만듭니다. */
export function matchClipsToImages(clips = [], images = []) {
  const byAsset = new Map();
  for (const im of images || []) if (im && im.assetId) byAsset.set(im.assetId, im);
  return (clips || []).map((c, i) => {
    const im = c && c.assetId ? byAsset.get(c.assetId) : null;
    if (!im) return null;
    return { cut: i + 1, url: im.url, section: im.section || '', before: im.before || [], after: im.after || [], alt: im.alt || '', role: im.role || 'photo' };
  });
}

/** 프롬프트에 넣을 [컷별 사진 문맥] 블록 */
export function cutContextBlock(cuts = [], { maxChars = 110 } = {}) {
  const list = (cuts || []).filter(Boolean);
  if (!list.length) return '';
  const cut1 = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
  };
  const lines = list.map((c) => {
    const bits = [];
    if (c.section) bits.push(`소제목 "${cut1(c.section)}"`);
    if (c.before && c.before.length) bits.push(`앞 "${cut1(c.before.slice(-2).join(' '))}"`);
    if (c.after && c.after.length) bits.push(`뒤 "${cut1(c.after.slice(0, 2).join(' '))}"`);
    if (c.alt) bits.push(`alt "${cut1(c.alt)}"`);
    return `컷 ${c.cut}: ${bits.length ? bits.join(' / ') : '(문맥 없음 — 사진에 보이는 것만)'}`;
  });
  return ['[컷별 사진 문맥 — 자막은 이 컷 번호와 1:1]', ...lines].join('\n');
}

/** 계획에서 잘못된 줄(라벨·평가어·가격 나열)을 사진 문맥 기반 줄로 바꿉니다. */
export function repairPlan(plan, fallbackPlan, cutCount = 0) {
  const p = plan || {};
  const fb = fallbackPlan || {};
  const notes = [];
  let segs = Array.isArray(p.segments) ? p.segments.slice() : [];
  const n = Math.max(cutCount || 0, segs.length, (fb.segments || []).length);

  // 컷 번호가 있으면 그 순서로 정렬, 없으면 준 순서
  const hasCuts = segs.length && segs.every((s) => Number.isFinite(Number(s.cut)));
  if (hasCuts) segs.sort((a, b) => Number(a.cut) - Number(b.cut));

  const fixed = [];
  for (let i = 0; i < n; i++) {
    const cur = segs[i] || {};
    const fbSeg = (fb.segments || []).find((s) => Number(s.cut) === i) || (fb.segments || [])[i] || {};
    let subtitle = String(cur.subtitle || '').trim();
    let title = i === 0 ? String(cur.title || p.title || '').trim() : String(cur.title || '').trim();
    let badge = i === 0 ? String(cur.badge || p.badge || '').trim() : '';
    if (i === 0) {
      // 0~3초 후킹 자리는 라벨·평가어를 그대로 두지 않습니다.
      const hk = checkCaption(title);
      if (!title || hk.label || hk.evalWord) {
        if (title) notes.push(`1컷 제목 "${title}" → "${fb.title}"`);
        title = fb.title || title;
        if (!subtitle || checkCaption(subtitle).label) subtitle = fbSeg.subtitle || subtitle;
      }
      const hb = checkCaption(badge);
      if (badge && (hb.evalWord || /BEST|총정리|필수템/i.test(badge))) {
        notes.push(`배지 "${badge}" → "${fb.badge || '없음'}"`);
        badge = fb.badge || '';
      }
    }
    const chk = checkCaption(subtitle);
    const bad = subtitle && (chk.label || chk.evalWord || /(\d+\s*만?\s*원)/.test(subtitle) && (subtitle.match(/\d+\s*만?\s*원/g) || []).length >= 2);
    if (bad && fbSeg.subtitle) {
      notes.push(`컷 ${i + 1} "${subtitle}" → "${fbSeg.subtitle}"`);
      subtitle = fbSeg.subtitle;
    }
    fixed.push({ ...cur, cut: i, title, badge, subtitle });
  }
  return {
    // 1컷 제목·배지는 plan 수준 값이 우선 적용되므로 같이 맞춥니다.
    plan: {
      ...p,
      title: fixed[0] ? fixed[0].title : p.title,
      badge: fixed[0] ? fixed[0].badge : p.badge,
      segments: fixed.map(({ cut, ...rest }) => ({ ...rest, cut })),
      endcard: p.endcard || [],
    },
    notes,
  };
}

/** 자막 묶음을 이어 읽었을 때의 상태(보고용) */
export function describeLines(lines = []) {
  const list = (lines || []).filter((s) => String(s || '').trim());
  const conn = list.filter((s) => checkCaption(s).connective).length;
  const bad = list.map((s, i) => ({ i: i + 1, s, ...checkCaption(s) })).filter((x) => x.label || x.evalWord);
  return {
    count: list.length,
    connective: conn,
    bad: bad.map((b) => `컷${b.i} "${b.s}"${b.label ? ' 라벨' : ''}${b.evalWord ? ' 평가어' : ''}`),
  };
}

// 검증용 읽기 전용 참고
if (typeof window !== 'undefined') {
  window.__reelsCopy = {
    buildPhotoPlan, buildHookBeats, candidatesFromContext, pickPointLine, clauseSplit,
    toConnective, fitLine13, lossLine, ctaLine, repairPlan, cutContextBlock, describeLines, LIMIT: CAPTION_LIMIT,
  };
}
