// exporter.js — 실제 MP4 내보내기 (WebCodecs + mp4-muxer, 실시간 MediaRecorder 폴백)
import { ArrayBufferTarget, Muxer } from '../vendor/mp4-muxer.mjs';
import { state, totalDuration, locate, clipDur, clipStart } from './state.js';
import { renderFrame } from './render.js';
import { buildMix } from './audio.js';
import { videoFor, seekVideo, waitVideoReady } from './media.js';
import { clamp } from './util.js';

const VIDEO_CANDIDATES = [
  { codec: 'avc1.640028', mux: 'avc', label: 'H.264 High' },
  { codec: 'avc1.4D0028', mux: 'avc', label: 'H.264 Main' },
  { codec: 'avc1.42E028', mux: 'avc', label: 'H.264 Baseline' },
  { codec: 'vp09.00.10.08', mux: 'vp9', label: 'VP9' },
];
const AUDIO_CANDIDATES = [
  { codec: 'mp4a.40.2', mux: 'aac', label: 'AAC' },
  { codec: 'opus', mux: 'opus', label: 'Opus' },
];

let cachedSupport = null;

export async function detectSupport(width = 1080, height = 1920, fps = 30, bitrate = 8000000) {
  const out = { video: null, audio: null, webcodecs: false, realtime: !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream) };
  if (typeof VideoEncoder !== 'undefined') {
    for (const c of VIDEO_CANDIDATES) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width, height, bitrate, framerate: fps });
        if (r.supported) { out.video = c; break; }
      } catch (e) { /* 다음 후보 */ }
    }
  }
  if (out.video && typeof AudioEncoder !== 'undefined') {
    for (const c of AUDIO_CANDIDATES) {
      try {
        const r = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
        if (r.supported) { out.audio = c; break; }
      } catch (e) { /* 다음 후보 */ }
    }
  }
  out.webcodecs = !!(out.video && out.audio);
  cachedSupport = out;
  return out;
}

export function getSupport() { return cachedSupport; }

function exportCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  return { canvas: c, ctx };
}

async function drawExportFrame(ctx, t) {
  const loc = locate(t);
  if (loc && loc.clip.kind === 'video') {
    const v = videoFor(loc.clip.assetId);
    if (v) {
      const want = clamp((loc.clip.trimIn || 0) + loc.local * (loc.clip.speed || 1), 0, Math.max(0, (v.duration || 1) - 0.03));
      await waitVideoReady(v, 4000);
      await seekVideo(v, want);
    }
  }
  renderFrame(ctx, t);
}

function waitQueue(encoder, max) {
  return new Promise((resolve) => {
    const check = () => {
      if (encoder.encodeQueueSize <= max) resolve();
      else setTimeout(check, 4);
    };
    check();
  });
}

/** WebCodecs 경로 — 프레임을 하나씩 정확히 그려서 인코딩합니다. */
async function exportWithWebCodecs({ width, height, fps, bitrate, support, onProgress, onLog }) {
  const duration = totalDuration();
  const { canvas, ctx } = exportCanvas(width, height);

  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }

  const mix = await buildMix(duration);
  onLog(`오디오 믹스 완료 (${mix.duration.toFixed(1)}초)`);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory',
    video: { codec: support.video.mux, width, height, frameRate: fps },
    audio: { codec: support.audio.mux, numberOfChannels: 2, sampleRate: 48000 },
  });

  let encodeError = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encodeError = e; } },
    error: (e) => { encodeError = e; },
  });
  const videoConfig = {
    codec: support.video.codec,
    width, height,
    bitrate: Math.round(bitrate),
    framerate: fps,
    latencyMode: 'quality',
  };
  if (support.video.mux === 'avc') videoConfig.avc = { format: 'avc' };
  venc.configure(videoConfig);

  const aenc = new AudioEncoder({
    output: (chunk, meta) => { try { muxer.addAudioChunk(chunk, meta); } catch (e) { encodeError = e; } },
    error: (e) => { encodeError = e; },
  });
  aenc.configure({ codec: support.audio.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
  onLog(`코덱: ${support.video.label} + ${support.audio.label}`);

  // 1) 오디오 먼저 인코딩
  const CH = 2;
  const chunkFrames = 4800; // 0.1초
  const planars = [];
  for (let c = 0; c < CH; c++) planars.push(mix.getChannelData(Math.min(c, mix.numberOfChannels - 1)));
  for (let off = 0; off < mix.length; off += chunkFrames) {
    const n = Math.min(chunkFrames, mix.length - off);
    const data = new Float32Array(n * CH);
    for (let c = 0; c < CH; c++) data.set(planars[c].subarray(off, off + n), c * n);
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: 48000,
      numberOfFrames: n,
      numberOfChannels: CH,
      timestamp: Math.round((off / 48000) * 1e6),
      data,
    });
    aenc.encode(audioData);
    audioData.close();
    if (aenc.encodeQueueSize > 20) await waitQueue(aenc, 10);
  }
  await aenc.flush();
  onLog('오디오 인코딩 완료');

  // 2) 비디오 프레임
  const total = Math.max(1, Math.round(duration * fps));
  const keyEvery = Math.max(1, Math.round(fps * 2));
  for (let i = 0; i < total; i++) {
    if (encodeError) throw encodeError;
    const t = Math.min(duration - 0.0005, i / fps);
    await drawExportFrame(ctx, t);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i / fps) * 1e6),
      duration: Math.round(1e6 / fps),
    });
    venc.encode(frame, { keyFrame: i % keyEvery === 0 });
    frame.close();
    if (i % 2 === 0) await waitQueue(venc, 6);
    onProgress(0.05 + 0.9 * ((i + 1) / total), `${i + 1} / ${total} 프레임`);
  }
  await venc.flush();
  if (encodeError) throw encodeError;
  muxer.finalize();
  onLog('MP4 컨테이너 완성');
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  return { blob, ext: 'mp4', codecInfo: `${support.video.label} + ${support.audio.label}` };
}

/** MediaRecorder 실시간 녹화 경로 — WebCodecs 미지원 환경용. */
async function exportWithRecorder({ width, height, fps, bitrate, onProgress, onLog }) {
  const duration = totalDuration();
  const { canvas, ctx } = exportCanvas(width, height);
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }

  const mix = await buildMix(duration);
  onLog('오디오 믹스 완료 — 실시간으로 녹화합니다.');

  const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  const src = ac.createBufferSource();
  src.buffer = mix;
  const gain = ac.createGain();
  gain.gain.value = 1;
  src.connect(gain); gain.connect(dest);

  const videoStream = canvas.captureStream(fps);
  const stream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

  const mimes = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.4D0028,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mime = mimes.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  onLog(`MediaRecorder: ${mime || '기본값'}`);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: Math.round(bitrate), audioBitsPerSecond: 192000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  // 첫 프레임 준비
  await drawExportFrame(ctx, 0);
  rec.start(200);
  const startAt = ac.currentTime + 0.25;
  src.start(startAt);

  await new Promise((resolve) => {
    const tick = () => {
      const t = ac.currentTime - startAt;
      if (t >= duration) { resolve(); return; }
      if (t >= -0.05) {
        const tt = clamp(t, 0, duration);
        // 비디오 엘리먼트 실시간 동기화
        const loc = locate(tt);
        if (loc && loc.clip.kind === 'video') {
          const v = videoFor(loc.clip.assetId);
          if (v && v.readyState >= 2) {
            const want = clamp((loc.clip.trimIn || 0) + loc.local * (loc.clip.speed || 1), 0, Math.max(0, (v.duration || 1) - 0.03));
            if (Math.abs(v.currentTime - want) > 0.3) { try { v.currentTime = want; } catch (e) {} }
            v.playbackRate = clamp(loc.clip.speed || 1, 0.25, 4);
            if (v.paused) v.play().catch(() => {});
          }
        }
        renderFrame(ctx, tt);
        onProgress(clamp(tt / duration, 0, 0.99), `${tt.toFixed(1)} / ${duration.toFixed(1)}초`);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  try { src.stop(); } catch (e) {}
  rec.stop();
  await stopped;
  try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { await ac.close(); } catch (e) {}

  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' });
  onLog(`녹화 완료 (${(blob.size / 1024 / 1024).toFixed(1)}MB)`);
  return { blob, ext, codecInfo: mime || 'MediaRecorder 기본값' };
}

/** 내보내기 진입점 */
export async function exportVideo(opts) {
  const {
    width = 1080, height = 1920, fps = 30, bitrate = 8000000,
    realtime = false, onProgress = () => {}, onLog = () => {},
  } = opts || {};
  const duration = totalDuration();
  if (duration <= 0.05) throw new Error('먼저 사진이나 영상을 추가하세요.');

  const support = await detectSupport(width, height, fps, bitrate);
  if (realtime || !support.webcodecs) {
    if (!support.realtime) throw new Error('이 브라우저에서는 내보내기를 지원하지 않습니다. Chrome 최신 버전을 사용해 주세요.');
    if (!support.webcodecs) onLog('WebCodecs를 쓸 수 없어 실시간 녹화 모드로 내보냅니다.');
    return exportWithRecorder({ width, height, fps, bitrate, onProgress, onLog });
  }
  try {
    return await exportWithWebCodecs({ width, height, fps, bitrate, support, onProgress, onLog });
  } catch (e) {
    console.warn('WebCodecs 내보내기 실패 → 실시간 모드로 재시도', e);
    onLog(`WebCodecs 실패(${e.message || e}) → 실시간 모드로 다시 시도합니다.`);
    onProgress(0, '다시 시도 중…');
    return exportWithRecorder({ width, height, fps, bitrate, onProgress, onLog });
  }
}

/** 현재 프리뷰 프레임을 JPG 썸네일로 저장합니다. */
export async function saveThumbnail({ width = 1080, height = 1920, quality = 0.92 } = {}) {
  const { canvas, ctx } = exportCanvas(width, height);
  const t = clamp(state.time, 0, Math.max(0, totalDuration() - 0.001));
  await drawExportFrame(ctx, t);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}
