// voicesplit.js — 한 번에 읽은 나레이션 오디오를 자막 개수만큼 '무음 지점'에서 나눕니다.
//
// 왜 필요한가 (v12):
//   Gemini TTS는 문장마다 따로 호출하면 매번 톤·억양·음색이 조금씩 달라집니다.
//   그래서 전체 대본을 1번만 호출해 WAV 하나를 받고, 그 안의 쉼(무음)을 찾아
//   자막 수(N)와 정확히 같게 자릅니다. 나눌 수 없으면(쉼이 모자라거나 남으면)
//   억지로 맞추지 않고 '전체 나레이션 1트랙'으로 쓰는 쪽이 안전합니다(narration.js).

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** 오디오 버퍼의 프레임별 RMS(소리 크기) — hop 간격으로 잽니다. */
export function rmsFrames(buf, hop = 0.01) {
  const sr = buf.sampleRate || 48000;
  const step = Math.max(1, Math.round(hop * sr));
  const n = buf.length;
  const chans = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels || 1); c++) chans.push(buf.getChannelData(c));
  const frames = Math.max(1, Math.ceil(n / step));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const i0 = f * step;
    const i1 = Math.min(n, i0 + step);
    let sum = 0;
    let cnt = 0;
    // 4샘플씩 건너봅니다(충분히 정확하고 빠릅니다)
    for (let i = i0; i < i1; i += 4) {
      let m = 0;
      for (let c = 0; c < chans.length; c++) {
        const a = Math.abs(chans[c][i]);
        if (a > m) m = a;
      }
      sum += m * m;
      cnt++;
    }
    out[f] = cnt ? Math.sqrt(sum / cnt) : 0;
  }
  return out;
}

/**
 * 무음 구간(쉼) 목록을 찾습니다. 맨 앞·맨 뒤 무음은 자를 지점이 아니므로 뺍니다.
 * @returns {Array<{start:number,end:number,dur:number}>}
 */
export function findSilenceGaps(buf, { threshold = 0.012, minGap = 0.06, hop = 0.01 } = {}) {
  const sr = buf.sampleRate || 48000;
  const frames = rmsFrames(buf, hop);
  const total = buf.duration || (buf.length / sr);
  let peak = 0;
  for (let i = 0; i < frames.length; i++) if (frames[i] > peak) peak = frames[i];
  if (peak < 0.01) return [];                    // 소리가 거의 없음 → 나눌 수 없음
  const gate = Math.max(threshold, peak * 0.05);
  const gaps = [];
  let i = 0;
  while (i < frames.length) {
    if (frames[i] < gate) {
      let j = i;
      while (j + 1 < frames.length && frames[j + 1] < gate) j++;
      const start = i * hop;
      const end = Math.min(total, (j + 1) * hop);
      if (end - start >= minGap) gaps.push({ start: r3(start), end: r3(end), dur: r3(end - start) });
      i = j + 1;
    } else i++;
  }
  // 맨 앞·맨 뒤 무음 제외(첫소리 앞/마지막 소리 뒤)
  return gaps.filter((g) => g.start > 0.02 && g.end < total - 0.02);
}

/**
 * 자막 N개로 나누는 지점(N-1개)을 고릅니다. 정확히 N조각이 안 되면 null.
 *  · 쉼이 긴 곳을 우선 고르되, 너무 가까운 지점은 건너뜁니다(한 쉼에서 두 번 자르지 않게).
 *  · 각 조각이 최소 0.2초는 되어야 합니다.
 */
export function chooseCutPoints(buf, n, opts = {}) {
  const count = Math.max(1, Number(n) || 0);
  if (count <= 1) return [];
  const sr = buf.sampleRate || 48000;
  const total = buf.duration || (buf.length / sr);
  const { minSep = 0.3, minPart = 0.2, minGap = 0.06 } = opts;
  const gaps = findSilenceGaps(buf, { minGap });
  if (gaps.length < count - 1) return null;

  const ranked = gaps
    .map((g) => ({ ...g, mid: (g.start + g.end) / 2, score: Math.min(0.6, g.dur) }))
    .sort((a, b) => b.score - a.score || a.mid - b.mid);

  const chosen = [];
  for (const g of ranked) {
    if (chosen.length === count - 1) break;
    if (chosen.some((c) => Math.abs(c.mid - g.mid) < minSep)) continue;
    chosen.push(g);
  }
  if (chosen.length !== count - 1) return null;
  chosen.sort((a, b) => a.mid - b.mid);

  const bounds = [0, ...chosen.map((c) => c.mid), total];
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] - bounds[i - 1] < minPart) return null;
  }
  return chosen.map((c) => r3(c.mid));
}

/** 오디오 버퍼의 [t0, t1) 구간을 새 버퍼로 복사합니다. */
export function sliceBuffer(buf, t0, t1) {
  const sr = buf.sampleRate || 48000;
  const ch = buf.numberOfChannels || 1;
  const i0 = Math.max(0, Math.min(buf.length, Math.round(t0 * sr)));
  const i1 = Math.max(i0 + 1, Math.min(buf.length, Math.round(t1 * sr)));
  const len = i1 - i0;
  const oc = new OfflineAudioContext(ch, len, sr);
  const out = oc.createBuffer(ch, len, sr);
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c);
    out.getChannelData(c).set(src.subarray(i0, i1));
  }
  return out;
}

/** 여러 버퍼를 사이 무음(gap초)을 두고 이어 붙입니다. */
export function concatBuffers(bufs, gapSeconds = 0.4) {
  const list = (bufs || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const sr = list[0].sampleRate || 48000;
  const ch = Math.max(...list.map((b) => b.numberOfChannels || 1));
  const gap = Math.max(0, Number(gapSeconds) || 0);
  const gapLen = Math.round(gap * sr);
  const len = list.reduce((a, b) => a + b.length, 0) + gapLen * (list.length - 1);
  const oc = new OfflineAudioContext(ch, Math.max(1, len), sr);
  const out = oc.createBuffer(ch, Math.max(1, len), sr);
  let at = 0;
  for (const b of list) {
    for (let c = 0; c < ch; c++) {
      const src = b.getChannelData(Math.min(c, (b.numberOfChannels || 1) - 1));
      out.getChannelData(c).set(src, at);
    }
    at += b.length + gapLen;
  }
  return out;
}

/** AudioBuffer → WAV(16bit PCM) Blob — 잘라 낸 조각을 음성 파일로 저장할 때 씁니다. */
export function encodeWav(buf) {
  const ch = Math.max(1, buf.numberOfChannels || 1);
  const sr = buf.sampleRate || 48000;
  const frames = buf.length;
  const dataLen = frames * ch * 2;
  const ab = new ArrayBuffer(44 + dataLen);
  const v = new DataView(ab);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, dataLen, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(Math.min(c, (buf.numberOfChannels || 1) - 1)));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
