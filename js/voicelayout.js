// voicelayout.js — 구간 음성(나레이션) 겹침 0 배치 · 전 구간 '단일 배속' 고정
//
// 왜 이렇게 바꿨나 (v12 · 2026-11-28):
//   예전에는 컷 길이에 맞추려고 컷마다 배속(playbackRate)을 1.0~1.35배로 제멋대로 바꿨습니다.
//   배속이 다르면 피치(음높이)도 같이 올라가고 내려가서, 2~3초마다 다른 사람 목소리처럼 들렸습니다.
//   이제 배속은 사용자가 고른 값(baseRate, 기본 1.0) 하나로 전 구간 100% 동일합니다.
//   길이가 모자라면 배속을 올리지 않고, 앞 음성이 끝난 뒤(prevEnd + gap)에 순서대로 놓습니다.
//   컷 길이는 나레이션을 만들 때 음성 길이에 맞춰 늘립니다(narration.js fitCutsToVoice) —
//   그래서 자막이 떠 있는 동안 그 자막의 음성이 들립니다.
//
// 이 계산은 미리듣기(audio.js buildMix)·타임라인(timeline.js)·MP4 내보내기(export.js)가 함께 쓰므로
// 어디서 봐도 결과가 같습니다. 저장된 프로젝트 값(start·duration)은 건드리지 않습니다(계산만).

export const LAYOUT_GAP = 0.04;       // 앞 음성 끝 ~ 다음 음성 시작 최소 여백(초)
export const LAYOUT_MAX_RATE = 1;     // (예전 값 · 호환용) 이제 컷별 배속 상한은 쓰지 않습니다 — 항상 baseRate
export const LAYOUT_ALLOW = 0;        // (예전 값 · 호환용) 자막을 넘겨 말하게 하는 여유 — 이제 쓰지 않습니다
export const LAYOUT_MIN_SLOT = 0.12;  // 이보다 짧은 틈은 '자리가 없는 것'으로 봅니다

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * 음성 항목에서 실제 말소리 구간을 뽑습니다.
 *  · lead/tail = 생성 때 재어 둔 앞뒤 무음(초). 무음은 들리지 않으니 배속·자리 계산에서 뺍니다.
 */
export function voiceContent(v) {
  const dur = Math.max(0, Number(v && v.duration) || 0);
  const lead = Math.max(0, Math.min(Number(v && v.lead) || 0, Math.max(0, dur - 0.1)));
  const tail = Math.max(0, Math.min(Number(v && v.tail) || 0, Math.max(0, dur - lead - 0.1)));
  return { lead, tail, speak: Math.max(0.1, dur - lead - tail) };
}

/**
 * 음성 목록 전체의 겹침 0 배치를 계산합니다.
 *  · 모든 클립의 rate = baseRate (컷마다 배속이 달라지지 않습니다 → 목소리 톤 고정)
 * @param {Array} items  p.audio.voice (id·start·duration·lead·tail)
 * @param {{duration?:number, gap?:number, baseRate?:number}} opts
 *   duration = 영상 전체 길이, baseRate = 사용자가 고른 나레이션 속도(배속)
 * @returns {Map<string, {id,start,rate,end,played,content,offset,pushed,spedUp,trimmed}>}
 */
export function planVoiceLayout(items, { duration = 0, gap = LAYOUT_GAP, baseRate = 1 } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter((v) => v && v.id)
    .map((v, i) => ({ v, i, at: Math.max(0, Number(v.start) || 0) }))
    .sort((a, b) => (a.at - b.at) || (a.i - b.i));

  const total = Math.max(0, Number(duration) || 0);
  const gapS = Math.max(0, Number(gap) || 0);
  // 전 구간 공통 배속 — 사용자가 고른 값 하나만 씁니다.
  const base = Math.max(0.5, Math.min(2, Number(baseRate) || 1));
  const plan = new Map();
  let prevEnd = -Infinity;

  for (let k = 0; k < list.length; k++) {
    const { v, at } = list[k];
    const { lead, speak } = voiceContent(v);

    // ① 앞 음성이 끝난 뒤에만 시작합니다(겹침 0). 배속으로 당기지 않습니다.
    let start = at;
    if (Number.isFinite(prevEnd) && start < prevEnd + gapS) start = prevEnd + gapS;

    // ② 길이는 배속 하나로만 정해집니다. 끝이 다음 자막보다 조금 늦어도 자르지 않습니다(문장 보존).
    const played = speak / base;

    plan.set(v.id, {
      id: v.id,
      start: r3(start),
      rate: base,
      end: r3(start + played),
      played: r3(played),
      content: r3(speak),
      offset: r3(lead),
      pushed: start > at + 0.001,
      spedUp: false,
      trimmed: false,
    });
    prevEnd = start + played;
    if (total > 0 && start >= total) prevEnd = total; // 영상 밖은 더 밀지 않습니다
  }
  return plan;
}

/** 배치를 사람이 읽는 문장으로 — 화면 안내·로그용 */
export function describePlan(plan) {
  if (!plan) return '';
  const bits = [];
  if (plan.pushed) bits.push('시작 미룸');
  return bits.join(' · ');
}

/** 겹침이 하나라도 남아 있는지 검사 (검증용 — 정상이면 빈 배열) */
export function findOverlaps(plan) {
  const rows = Array.from(plan.values()).filter((p) => p.played > 0).sort((a, b) => a.start - b.start);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (cur.start < prev.end - 1e-3) out.push({ prev: prev.id, cur: cur.id, overlap: r3(prev.end - cur.start) });
  }
  return out;
}

/** 배속 편차 — 0.000 이어야 '전 구간 같은 목소리 톤'입니다(검증용) */
export function planRateSpread(plan) {
  const rates = Array.from(plan.values()).map((p) => Number(p.rate) || 0);
  if (!rates.length) return 0;
  return r3(Math.max(...rates) - Math.min(...rates));
}

/** 배치 요약 — 화면에 "겹침 0" 확인용 */
export function planSummary(plan, duration = 0) {
  const rows = Array.from(plan.values());
  const overlaps = findOverlaps(plan);
  const sped = rows.filter((p) => p.spedUp).length;
  const trimmed = rows.filter((p) => p.trimmed).length;
  const lastEnd = rows.reduce((m, p) => Math.max(m, p.end), 0);
  return {
    count: rows.length,
    overlaps: overlaps.length,
    overlapList: overlaps,
    sped,
    trimmed,
    rateSpread: planRateSpread(plan),
    lastEnd: r3(lastEnd),
    overDuration: duration > 0 ? r3(Math.max(0, lastEnd - duration)) : 0,
  };
}
