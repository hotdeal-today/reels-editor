// voicelayout.js — 구간 음성(나레이션) 겹침 0 보장 배치 계산
//
// 왜 필요한가:
//   자막 구간이 2.0초인데 Gemini TTS가 2.9초짜리 음성을 만들면, 그 음성을 2.0초에 그대로 두면
//   앞 음성이 끝나기 전에 다음 음성이 시작돼 목소리가 2~3개 겹쳐 들립니다(중복 재생처럼 들림).
//
// 여기서는 음성마다 '시작 시각 + 배속 + 읽을 구간'을 계산합니다.
//   ① 앞 음성이 끝난 뒤에만 시작합니다(겹침 0, 최소 여백 LAYOUT_GAP).
//   ② 다음 자막이 뜨기 전에 끝나도록 필요한 만큼만 배속합니다(최대 LAYOUT_MAX_RATE = 1.35배).
//   ③ 그래도 넘치면 최대 배속으로 맞추고, 남는 만큼은 다음 자막이 뜨는 자리(또는 영상 끝)에서
//      짧게 끊습니다(클릭 방지 페이드아웃은 오디오 믹스에서). 시작을 미룬 음성은 pushed 로 표시됩니다.
//
// 이 계산은 미리듣기(audio.js buildMix)와 MP4 내보내기(export.js → 같은 buildMix)가 함께 쓰므로
// 두 곳의 결과가 항상 같습니다. 저장된 프로젝트 값(start·duration)은 건드리지 않습니다(계산만).

export const LAYOUT_GAP = 0.04;       // 앞 음성 끝 ~ 다음 음성 시작 최소 여백(초)
export const LAYOUT_MAX_RATE = 1.35;  // 자동 배속 상한 (1.35배 ≈ 반음 4.5개 — 목소리가 그대로 들리는 선)
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
 * @param {Array} items  p.audio.voice (id·start·duration·lead·tail)
 * @param {{duration?:number, gap?:number, maxRate?:number}} opts  duration = 영상 전체 길이
 * @returns {Map<string, {id,start,rate,end,played,content,offset,pushed,spedUp,trimmed}>}
 */
export function planVoiceLayout(items, { duration = 0, gap = LAYOUT_GAP, maxRate = LAYOUT_MAX_RATE } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter((v) => v && v.id)
    .map((v, i) => ({ v, i, at: Math.max(0, Number(v.start) || 0) }))
    .sort((a, b) => (a.at - b.at) || (a.i - b.i));

  const total = Math.max(0, Number(duration) || 0);
  const gapS = Math.max(0, Number(gap) || 0);
  const cap = Math.max(1, Number(maxRate) || 1);
  const plan = new Map();
  let prevEnd = -Infinity;

  for (let k = 0; k < list.length; k++) {
    const { v, at } = list[k];
    const { lead, speak } = voiceContent(v);

    // ① 앞 음성과 절대 겹치지 않게
    let start = at;
    if (Number.isFinite(prevEnd) && start < prevEnd + gapS) start = prevEnd + gapS;

    // ② 끝나야 할 시각 = 다음 음성의 자막 시작(마지막 음성은 영상 끝)
    const nextAt = k + 1 < list.length ? list[k + 1].at : null;
    let deadline = nextAt != null ? nextAt : total;
    if (!(deadline > start + LAYOUT_MIN_SLOT)) deadline = 0; // 이미 늦었으면 자연 길이대로 두고 다음 음성을 미룹니다

    let rate = 1;
    if (deadline) {
      const avail = deadline - start;
      if (speak > avail) rate = Math.min(cap, Math.max(1, speak / avail));
    }
    rate = Math.max(1, Math.ceil(rate * 1000) / 1000); // 올림 — 반올림 때문에 1ms씩 잘리는 일 방지

    let played = speak / rate;          // 실제로 들리는 길이(초)
    let trimmed = false;
    if (deadline && start + played > deadline) {
      const room = deadline - start;
      if (start + played - deadline > 0.008) {
        played = room < 0.05 ? 0 : room;  // 최대 배속으로도 넘치면 그 자리에서 끊습니다
        trimmed = true;
      }
    }
    if (total > 0 && start + played > total) {
      const room = total - start;         // 영상 끝을 넘는 꼬리
      played = room < 0.05 ? 0 : room;
      trimmed = true;
    }
    if (!(played > 0)) { plan.set(v.id, emptyPlan(v.id, start, rate)); continue; }

    const content = Math.min(speak, trimmed ? played * rate : speak); // 버퍼에서 읽을 초
    plan.set(v.id, {
      id: v.id,
      start: r3(start),
      rate,
      end: r3(start + played),
      played: r3(played),
      content: r3(content),
      offset: r3(lead),
      pushed: start > at + 0.1,
      spedUp: rate > 1.0005,
      trimmed,
    });
    prevEnd = start + played;
  }
  return plan;
}

function emptyPlan(id, start, rate) {
  return { id, start: r3(start), rate, end: r3(start), played: 0, content: 0, offset: 0, pushed: false, spedUp: false, trimmed: false };
}

/** 배치를 사람이 읽는 문장으로 — 화면 안내·로그용 */
export function describePlan(plan) {
  if (!plan) return '';
  const bits = [];
  if (plan.pushed) bits.push('시작 미룸');
  if (plan.spedUp) bits.push(`${plan.rate.toFixed(2)}배속`);
  if (plan.trimmed) bits.push('끝 잘림');
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
    lastEnd: r3(lastEnd),
    overDuration: duration > 0 ? r3(Math.max(0, lastEnd - duration)) : 0,
  };
}
