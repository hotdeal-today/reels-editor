// audio.js — 내장 효과음 합성(Web Audio) · 오디오 믹스다운 · 미리듣기
import { state, getAsset, clipDur, clipStart } from './state.js';
import { decodeAudio } from './media.js';

export const SR = 48000;

function noiseBuffer(oc, dur) {
  const len = Math.max(1, Math.ceil(dur * oc.sampleRate));
  const buf = oc.createBuffer(1, len, oc.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function bell(oc, dest, freq, t0, dur, level = 0.5) {
  const mk = (f, lvl, d) => {
    const o = oc.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = oc.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(lvl, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + d + 0.02);
  };
  mk(freq, level, dur);
  mk(freq * 2.01, level * 0.35, dur * 0.6);
  mk(freq * 2.98, level * 0.16, dur * 0.35);
}

function clickHit(oc, dest, t0, level = 0.5, freq = 2400, dur = 0.02) {
  const n = oc.createBufferSource();
  n.buffer = noiseBuffer(oc, dur + 0.02);
  const f = oc.createBiquadFilter();
  f.type = 'highpass'; f.frequency.value = freq;
  const g = oc.createGain();
  g.gain.setValueAtTime(level, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  n.connect(f); f.connect(g); g.connect(dest);
  n.start(t0); n.stop(t0 + dur + 0.01);
}

export const SFX_DEFS = [
  {
    id: 'pop', name: '뽕 (팝)', desc: '팔 때 터지는 뽕 — 귀여운 등장 강조', dur: 0.24,
    gen(oc) {
      const o = oc.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(940, 0.005);
      o.frequency.exponentialRampToValueAtTime(150, 0.2);
      const g = oc.createGain();
      g.gain.setValueAtTime(0.0001, 0.004);
      g.gain.exponentialRampToValueAtTime(0.95, 0.014);
      g.gain.exponentialRampToValueAtTime(0.0001, 0.22);
      o.connect(g); g.connect(oc.destination);
      o.start(0.004); o.stop(0.24);
      clickHit(oc, oc.destination, 0.004, 0.3, 2200, 0.014);
    },
  },
  {
    id: 'swish', name: '쉭 (화면 전환)', desc: '화면 전환 스우시', dur: 0.63,
    gen(oc) {
      const n = oc.createBufferSource(); n.buffer = noiseBuffer(oc, 0.66);
      const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(420, 0.01);
      bp.frequency.exponentialRampToValueAtTime(5200, 0.3);
      bp.frequency.exponentialRampToValueAtTime(700, 0.62);
      const g = oc.createGain();
      g.gain.setValueAtTime(0.0001, 0.01);
      g.gain.exponentialRampToValueAtTime(0.5, 0.13);
      g.gain.exponentialRampToValueAtTime(0.0001, 0.62);
      n.connect(bp); bp.connect(g); g.connect(oc.destination);
      n.start(0.01); n.stop(0.64);
    },
  },
  {
    id: 'dingdong', name: '딩동 (알림·포인트)', desc: '딩동 — 알림·포인트 짚어주기', dur: 1.15,
    gen(oc) {
      bell(oc, oc.destination, 988, 0.02, 0.5, 0.45);
      bell(oc, oc.destination, 740, 0.36, 0.72, 0.5);
    },
  },
  {
    id: 'jjan', name: '짠 (등장·강조)', desc: '짠 — 반짝 등장·강조', dur: 1.05,
    gen(oc) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        const t = 0.02 + i * 0.075;
        const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
        const g = oc.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
        o.connect(g); g.connect(oc.destination);
        o.start(t); o.stop(t + 0.64);
      });
      const n = oc.createBufferSource(); n.buffer = noiseBuffer(oc, 0.5);
      const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
      const g = oc.createGain();
      g.gain.setValueAtTime(0.0001, 0.02);
      g.gain.exponentialRampToValueAtTime(0.16, 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, 0.6);
      n.connect(hp); hp.connect(g); g.connect(oc.destination);
      n.start(0.02); n.stop(0.62);
    },
  },
  {
    id: 'tadak', name: '타닥 (자막·타이핑)', desc: '타다다닥 — 자막이 찍히는 소리', dur: 0.52,
    gen(oc) {
      [0.0, 0.17, 0.32, 0.44].forEach((t, i) => clickHit(oc, oc.destination, t + 0.01, 0.42 - i * 0.05, 1500 + i * 250, 0.022));
    },
  },
  {
    id: 'beep', name: '삐 (검열 비프음)', desc: '삐— 이 구간 가릴 때', dur: 0.62,
    gen(oc) {
      const mk = (t0, d) => {
        const o = oc.createOscillator(); o.type = 'square'; o.frequency.value = 1000;
        const g = oc.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.16, t0 + 0.008);
        g.gain.setValueAtTime(0.16, t0 + d - 0.02);
        g.gain.linearRampToValueAtTime(0.0001, t0 + d);
        o.connect(g); g.connect(oc.destination);
        o.start(t0); o.stop(t0 + d + 0.01);
      };
      mk(0.01, 0.16); mk(0.3, 0.24);
    },
  },
  {
    id: 'ddoong', name: '두둥 (임팩트)', desc: '두둥— 묵직한 임팩트', dur: 1.35,
    gen(oc) {
      const hit = (t0, level) => {
        const o = oc.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(120, t0);
        o.frequency.exponentialRampToValueAtTime(42, t0 + 0.5);
        const g = oc.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(level, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.62);
        o.connect(g); g.connect(oc.destination);
        o.start(t0); o.stop(t0 + 0.64);
        const n = oc.createBufferSource(); n.buffer = noiseBuffer(oc, 0.35);
        const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
        const ng = oc.createGain();
        ng.gain.setValueAtTime(0.35 * level, t0);
        ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
        n.connect(lp); lp.connect(ng); ng.connect(oc.destination);
        n.start(t0); n.stop(t0 + 0.3);
      };
      hit(0.01, 0.85);
      hit(0.62, 0.6);
    },
  },
  {
    id: 'shutter', name: '찰칵 (카메라 셔터)', desc: '찰칵 — 사진·비포/애프터', dur: 0.26,
    gen(oc) {
      clickHit(oc, oc.destination, 0.005, 0.5, 2600, 0.012);
      clickHit(oc, oc.destination, 0.09, 0.36, 1900, 0.018);
      const n = oc.createBufferSource(); n.buffer = noiseBuffer(oc, 0.06);
      const bp = oc.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 1.4;
      const g = oc.createGain(); g.gain.setValueAtTime(0.18, 0.05); g.gain.exponentialRampToValueAtTime(0.0001, 0.11);
      n.connect(bp); bp.connect(g); g.connect(oc.destination);
      n.start(0.05); n.stop(0.12);
    },
  },
];

const bufferCache = new Map();

export function makeSfxBufferSync(id) {
  const def = SFX_DEFS.find((d) => d.id === id);
  if (!def) return null;
  if (bufferCache.has(id)) return bufferCache.get(id);
  const oc = new OfflineAudioContext(2, Math.ceil((def.dur + 0.05) * SR), SR);
  def.gen(oc);
  const promise = oc.startRendering().then((buf) => buf).catch((e) => { console.warn('효과음 생성 실패', id, e); return null; });
  bufferCache.set(id, promise);
  return promise;
}

export function getSfxBuffer(id) {
  const def = SFX_DEFS.find((d) => d.id === id);
  if (def) return makeSfxBufferSync(id);
  return decodeAudio(id); // 사용자 효과음(자산 id)
}

export function sfxDuration(id) {
  const def = SFX_DEFS.find((d) => d.id === id);
  if (def) return def.dur;
  const a = getAsset(id);
  return a && a.duration ? a.duration : 0.5;
}
export function sfxName(id) {
  const def = SFX_DEFS.find((d) => d.id === id);
  if (def) return def.name;
  const a = getAsset(id);
  return a ? a.name : '효과음';
}

// ── 미리듣기 ────────────────────────────────────────────
let ctx = null;
let previewSrc = null;
export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export async function previewSfx(id, volume = 1) {
  const buf = await getSfxBuffer(id);
  if (!buf) return;
  const ac = audioCtx();
  try { previewSrc?.stop(); } catch (e) {}
  const src = ac.createBufferSource();
  src.buffer = buf;
  const g = ac.createGain(); g.gain.value = volume;
  src.connect(g); g.connect(ac.destination);
  src.start();
  previewSrc = src;
}

// ── 믹스다운 ────────────────────────────────────────────
/** 타임라인 전체 오디오를 하나의 AudioBuffer로 섞습니다. */
export async function buildMix(duration) {
  const dur = Math.max(0.2, duration || 0);
  const oc = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  const master = oc.createGain();
  master.gain.value = 0.92;
  const comp = oc.createDynamicsCompressor();
  comp.threshold.value = -10; comp.knee.value = 14; comp.ratio.value = 2.6;
  comp.attack.value = 0.004; comp.release.value = 0.22;
  master.connect(comp);
  comp.connect(oc.destination);

  const p = state.project;
  if (!p) return oc.startRendering();

  // 1) 클립 원본 오디오
  for (let i = 0; i < p.clips.length; i++) {
    const clip = p.clips[i];
    if (clip.kind !== 'video') continue;
    if (clip.muted) continue;
    const vol = (clip.volume ?? 100) / 100;
    if (vol <= 0) continue;
    const buf = await decodeAudio(clip.assetId);
    if (!buf) continue;
    const start = clipStart(i);
    if (start >= dur) continue;
    const speed = Math.max(0.1, clip.speed || 1);
    const trimIn = Math.max(0, Math.min(clip.trimIn || 0, buf.duration));
    const trimOut = Math.min(clip.trimOut == null ? buf.duration : clip.trimOut, buf.duration);
    const segLen = Math.max(0.05, trimOut - trimIn);
    const src = oc.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;
    const g = oc.createGain();
    g.gain.value = vol;
    src.connect(g); g.connect(master);
    src.start(start, trimIn, segLen);
  }

  // 2) 나레이션
  if (p.audio.narration && p.audio.narration.assetId) {
    const n = p.audio.narration;
    const buf = await decodeAudio(n.assetId);
    if (buf) {
      const start = Math.max(0, n.start || 0);
      if (start < dur) {
        const src = oc.createBufferSource();
        src.buffer = buf;
        const g = oc.createGain();
        const vol = Math.max(0, (n.volume ?? 100) / 100);
        g.gain.value = vol;
        src.connect(g); g.connect(master);
        src.start(start, 0, Math.min(buf.duration, dur - start));
      }
    }
  }

  // 3) BGM (반복 + 페이드 인/아웃)
  if (p.audio.bgm && p.audio.bgm.assetId) {
    const b = p.audio.bgm;
    const buf = await decodeAudio(b.assetId);
    if (buf) {
      const start = Math.max(0, b.start || 0);
      const vol = Math.max(0, (b.volume ?? 40) / 100);
      const fadeIn = Math.max(0, b.fadeIn ?? 1);
      const fadeOut = Math.max(0, b.fadeOut ?? 1);
      const src = oc.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = oc.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(vol, Math.min(dur, start + Math.max(0.01, fadeIn)));
      const foStart = Math.max(start + fadeIn, dur - fadeOut);
      g.gain.setValueAtTime(vol, Math.min(dur, foStart));
      g.gain.linearRampToValueAtTime(0.0001, dur);
      src.connect(g); g.connect(master);
      src.start(start);
      src.stop(dur);
    }
  }

  // 4) 효과음
  for (const item of p.audio.sfx || []) {
    if (item.t >= dur) continue;
    const buf = await getSfxBuffer(item.key);
    if (!buf) continue;
    const src = oc.createBufferSource();
    src.buffer = buf;
    const g = oc.createGain();
    g.gain.value = Math.max(0, (item.volume ?? 100) / 100);
    src.connect(g); g.connect(master);
    src.start(Math.max(0, item.t), 0, Math.min(buf.duration, Math.max(0.05, dur - item.t)));
  }

  return oc.startRendering();
}
