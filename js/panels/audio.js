// panels/audio.js — 탭3: 나레이션(자막과 1:1) · BGM · 효과음
import { $, $$, clamp, emit, uid, round, escapeHtml, isAudioFile } from '../util.js';
import { state, persist, mixDirty, totalDuration, getAsset } from '../state.js';
import { SFX_DEFS, previewSfx, sfxDuration, sfxName } from '../audio.js';
import { importAudioFile } from '../media.js';
import { forgetAsset, isAssetUsed } from '../assets.js';
import { seek } from '../player.js';
import { VOICES, loadAiSettings, saveAiSettings } from '../gemini.js';
import {
  addVoiceClip, removeVoiceClip, voiceClips, voiceLayoutNow, voiceTimingText,
  previewSpeech, stopSpeech, stopAllSpeech, playVoiceUrl, recordVoice, voiceAssetName,
} from '../tts.js';
import {
  narrationRate, setNarrationRate, narrationReport, buildNarration,
  syncNarrationToSegments, cleanNarrationTrack, voiceFor, voiceIsStale, segmentNarrationText,
} from '../narration.js';
import { planSummary } from '../voicelayout.js';

let pane = null;
let customListEl = null;
let trackListEl = null;
let narSegListEl = null;
let narVoiceListEl = null;
let fullCard = null;
let bgmCard = null;
let sfxPicker = null;
let recState = { rec: null, stream: null, timer: null, startedAt: 0 };
let segRec = null;      // 구간별 마이크 녹음 { segId, btn }
let narRunning = false; // 나레이션 생성 중복 실행 방지

export function initAudioPanel(el) {
  pane = el;
  const s = loadAiSettings();
  pane.innerHTML = `
    <div class="sec">
      <div class="sec-head">🎙 나레이션 <span class="count" id="narCount"></span></div>
      <div class="card nar-card">
        <div class="sec-note" style="margin:0 0 7px">
          <b>자막과 1:1</b>로 움직입니다 — 2번에서 자막을 고치면 이 목록의 대본·시간도 바로 바뀝니다.
          목소리는 <b>고른 한 가지</b>로 모든 구간을 만들고, 다시 만들면 옛 음성은 남기지 않습니다.
        </div>
        <div class="row">
          <label>목소리</label>
          <select class="grow" id="narVoice">
            ${VOICES.map((v) => `<option value="${v.id}">${v.label}</option>`).join('')}
          </select>
        </div>
        <div class="row">
          <label>속도</label>
          <input type="range" class="grow" id="narRate" min="0.8" max="1.5" step="0.05" value="1">
          <span class="val" id="narRateVal">1.00x</span>
        </div>
        <div class="rate-chips" id="narRateChips">
          ${[0.9, 1, 1.1, 1.2, 1.3, 1.5].map((r) => `<button type="button" data-rate="${r}">${r.toFixed(1)}x</button>`).join('')}
        </div>
        <div class="sec-note" style="margin:4px 0 8px">속도는 <b>미리듣기 · 타임라인 재생 · MP4 내보내기</b>에 똑같이 적용됩니다(길면 자동 압축은 이 속도에 곱해집니다).</div>
        <button class="btn primary block" id="narGenAll" type="button">🗣 전체 자막 TTS 만들기</button>
        <button class="btn block" id="narSync" type="button" style="margin-top:6px">🔄 자막 기준으로 나레이션 다시 맞추기</button>
        <div class="ai-status hidden" id="narStatus"></div>
        <div class="ai-warn hidden" id="narWarn"></div>
        <div class="ai-seglist" id="narSegList"></div>
        <div class="sec-head" style="margin-top:12px">🎧 구간 음성 트랙 <span class="count" id="narVoiceCount"></span></div>
        <div class="ai-voicelist" id="narVoiceList"></div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-head">🎵 BGM (배경음악)</div>
      <div class="card" id="bgmCard"></div>
    </div>

    <div class="sec">
      <div class="sec-head">내장 효과음 <span class="count">8종 · Web Audio 직접 합성</span></div>
      <div class="sec-note" style="margin-bottom:7px">▶ 로 미리 듣고 <b style="color:#ffc78a">+ 현재 위치</b>로 타임라인에 넣습니다.</div>
      <div class="sfx-grid" id="builtinSfx"></div>
    </div>

    <div class="sec">
      <div class="sec-head">내 효과음 <span class="count" id="customCount"></span><span class="grow"></span>
        <button class="btn tiny" id="addSfxBtn" type="button">+ 내 효과음 추가</button>
      </div>
      <input id="sfxPicker" type="file" accept="audio/*,.mp3,.wav,.m4a,.aac" hidden>
      <div class="sfx-grid" id="customSfx"></div>
      <div class="sec-note" style="margin-top:6px">mp3 · wav · m4a · aac 파일을 올리면 이 브라우저에 저장됩니다.</div>
    </div>

    <div class="sec">
      <div class="sec-head">타임라인에 넣은 효과음 <span class="count" id="sfxCount"></span></div>
      <div class="sfx-track-list" id="sfxTrackList"></div>
      <div class="sec-note" style="margin-top:6px">타임라인의 주황색 블록을 끌어 0.05초 단위로 옮길 수 있습니다.</div>
    </div>

    <div class="sec">
      <div class="sec-head">📼 전체 나레이션 파일 (선택) <span class="count">자막별 나레이션과 함께 쓰지 마세요</span></div>
      <div class="card" id="narFullCard"></div>
    </div>
  `;

  customListEl = $('#customSfx', pane);
  trackListEl = $('#sfxTrackList', pane);
  narSegListEl = $('#narSegList', pane);
  narVoiceListEl = $('#narVoiceList', pane);
  fullCard = $('#narFullCard', pane);
  bgmCard = $('#bgmCard', pane);
  sfxPicker = $('#sfxPicker', pane);

  $('#narVoice', pane).value = state.project.audio.narrVoice || s.voice || 'Kore';

  $('#builtinSfx', pane).innerHTML = SFX_DEFS.map((d) => `
    <div class="sfx-item" data-key="${d.id}">
      <button class="sfx-play" data-preview="${d.id}" type="button" title="미리듣기">▶</button>
      <div class="sfx-info"><b>${d.name}</b><small>${d.desc}</small></div>
      <span class="sfx-dur">${d.dur.toFixed(2)}초</span>
      <button class="btn tiny sfx-add" data-add="${d.id}" type="button">+ 현재 위치</button>
    </div>`).join('');

  pane.addEventListener('click', onClick);
  pane.addEventListener('input', onInput);
  pane.addEventListener('change', onChange);

  $('#addSfxBtn', pane).addEventListener('click', () => sfxPicker.click());
  sfxPicker.addEventListener('change', async () => {
    const f = sfxPicker.files && sfxPicker.files[0];
    sfxPicker.value = '';
    if (!f) return;
    await addCustomSfx(f);
  });

  // 나레이션 버튼
  $('#narVoice', pane).addEventListener('change', () => {
    const voice = $('#narVoice', pane).value;
    saveAiSettings({ voice });
    state.project.audio.narrVoice = voice;
    persist();
    renderNarration();
    const label = (VOICES.find((v) => v.id === voice) || {}).label || voice;
    emit('toast', { msg: `${label} 목소리로 바꿨습니다. [자막 기준으로 다시 맞추기]를 누르면 모든 구간이 이 목소리로 통일됩니다.`, type: 'ok' });
  });
  $('#narRate', pane).addEventListener('input', () => {
    const v = setNarrationRate($('#narRate', pane).value);
    paintRate(v);
  });
  $('#narRate', pane).addEventListener('change', () => { renderNarration(); emit('timeline'); });
  $('#narRateChips', pane).addEventListener('click', (e) => {
    const b = e.target.closest('[data-rate]');
    if (!b) return;
    const v = setNarrationRate(Number(b.dataset.rate));
    $('#narRate', pane).value = String(v);
    paintRate(v);
    renderNarration();
    emit('timeline');
    emit('toast', { msg: `나레이션 속도를 ${v.toFixed(2)}x 로 바꿨습니다. 미리보기·MP4에 똑같이 적용됩니다.`, type: 'ok' });
  });
  $('#narGenAll', pane).addEventListener('click', () => runNarration('all'));
  $('#narSync', pane).addEventListener('click', () => runNarration('sync'));
  narSegListEl.addEventListener('click', onSegAction);
  narSegListEl.addEventListener('input', onSegTextInput);
  narVoiceListEl.addEventListener('click', onVoiceAction);
  narVoiceListEl.addEventListener('input', onVoiceVolume);
  window.addEventListener('reels:audition-stop', stopAuditionAudio);

  renderCustomSfx();
  renderNarration();
  renderBgm();
  renderSfxTracks();
  renderFullNarration();
}

function onAdded() {
  mixDirty();
  emit('project', { panels: ['audio'], select: false });
  persist();
}

// ══ 나레이션 (자막과 1:1) ═════════════════════════════
function paintRate(v) {
  const label = $('#narRateVal', pane);
  if (label) label.textContent = `${Number(v).toFixed(2)}x`;
  $$('#narRateChips [data-rate]', pane).forEach((b) => {
    b.classList.toggle('on', Math.abs(Number(b.dataset.rate) - Number(v)) < 0.001);
  });
}

function narStatus(msg, type = '') {
  const box = $('#narStatus', pane);
  if (!box) return;
  box.classList.remove('hidden', 'ok', 'err', 'warn');
  if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
  if (type) box.classList.add(type);
  box.textContent = msg;
}

function setNarBusy(on) {
  narRunning = on;
  ['narGenAll', 'narSync'].forEach((id) => {
    const b = $(`#${id}`, pane);
    if (b) b.disabled = on;
  });
}

async function runNarration(mode) {
  if (narRunning) return;
  const p = state.project;
  const s = loadAiSettings();
  if (!s.apiKey) {
    narStatus('Gemini 무료 API 키가 필요합니다. 5번 ✨ AI 세팅에서 키를 먼저 저장해 주세요. (키 없이도 녹음·파일로 구간 음성을 넣을 수 있습니다.)', 'err');
    return;
  }
  const rep = narrationReport();
  if (!rep.captions) { narStatus('읽을 자막이 없습니다. 2번 제목·자막에서 자막을 먼저 넣어 주세요.', 'err'); return; }
  if (mode === 'all') {
    const manual = voiceClips().filter((v) => v.kind && v.kind !== 'tts').length;
    const msg = manual
      ? `나레이션 트랙을 전부 비우고 지금 자막 ${rep.captions}개로 딱 1세트를 새로 만듭니다.\n\n마이크 녹음·올린 파일 ${manual}개도 함께 지워집니다. 계속할까요?`
      : `지금 자막 ${rep.captions}개로 나레이션 1세트를 새로 만듭니다. 옛 음성은 모두 지우고 다시 만듭니다. 계속할까요?`;
    if (!window.confirm(msg)) return;
  }
  const voice = ($('#narVoice', pane) && $('#narVoice', pane).value) || s.voice || 'Kore';
  setNarBusy(true);
  narStatus(mode === 'all' ? '나레이션 트랙을 비우고 새로 만드는 중…' : '자막과 어긋난 나레이션을 다시 만드는 중…', 'warn');
  try {
    const res = await buildNarration({
      mode,
      voice,
      onProgress: (m) => narStatus(m, 'warn'),
    });
    if (res.upToDate) {
      narStatus(`자막 ${narrationReport().captions}개 모두 이미 자막과 같은 나레이션입니다.`, 'ok');
    } else if (res.empty) {
      narStatus('읽을 자막이 없습니다.', 'err');
    } else {
      const sum = planSummary(voiceLayoutNow(), totalDuration());
      const note = ` · 겹침 ${sum.overlaps}건${sum.sped ? ` · 자동 압축 ${sum.sped}개` : ''}`;
      narStatus(`나레이션 ${res.ok}개 완료${res.cleared ? ` · 옛 음성 ${res.cleared}개 정리` : ''}${res.fail ? ` · 실패 ${res.fail}개 (${res.lastErr || ''})` : ''}${note}`, res.fail ? 'warn' : 'ok');
      if (res.ok) {
        emit('toast', {
          msg: `${res.voice} 목소리 하나로 ${res.ok}개 구간 나레이션을 만들었습니다${sum.sped ? ` (길면 ${sum.sped}개 자동 압축)` : ''}.`,
          type: res.fail ? 'warn' : 'ok',
        });
      }
      if (res.narrationOff) {
        emit('toast', { msg: '전체 나레이션 파일은 자막별 나레이션과 겹치지 않게 껐습니다.', type: 'warn' });
      }
    }
    renderNarration();
    renderFullNarration();
    emit('project', { panels: ['audio'] });
  } catch (e) {
    narStatus(e.message || '나레이션을 만들지 못했습니다.', 'err');
  } finally {
    setNarBusy(false);
  }
}

function renderNarration() {
  if (!pane) return;
  const rep = narrationReport();
  const rate = narrationRate();
  const rEl = $('#narRate', pane);
  if (rEl && document.activeElement !== rEl) rEl.value = String(rate);
  paintRate(rate);
  const s = loadAiSettings();
  const voiceSel = $('#narVoice', pane);
  if (voiceSel && document.activeElement !== voiceSel) {
    voiceSel.value = state.project.audio.narrVoice || s.voice || 'Kore';
  }
  const count = $('#narCount', pane);
  if (count) count.textContent = `자막 ${rep.captions}개 · 음성 ${rep.voices}개`;

  // 경고 배너
  const warn = $('#narWarn', pane);
  const bits = [];
  if (rep.mixed) {
    bits.push(`<div>목소리가 <b>${rep.names.length}가지(${rep.names.map(escapeHtml).join(' · ')})</b> 섞여 있습니다.
      <button class="btn tiny danger" data-naract="unify" type="button">한 목소리로 다시 만들기</button></div>`);
  }
  if (rep.staleTts.length) {
    bits.push(`<div>자막과 어긋난 TTS 음성 <b>${rep.staleTts.length}개</b>가 남아 있습니다(옛 대본으로 읽은 목소리).
      <button class="btn tiny danger" data-naract="sync" type="button">지금 다시 맞추기</button></div>`);
  }
  if (rep.staleManual.length) {
    bits.push(`<div>녹음·올린 파일 <b>${rep.staleManual.length}개</b>는 자막이 바뀌었습니다. 🔊로 확인하거나 ✨TTS로 바꿔 주세요.</div>`);
  }
  if (rep.dup || rep.unbound) {
    bits.push(`<div>자막과 짝이 안 맞는 옛 음성<b> ${rep.dup + rep.unbound}개</b>가 남아 있습니다(겹쳐 들리는 원인).
      <button class="btn tiny" data-naract="clean" type="button">정리하기</button></div>`);
  }
  if (state.project.audio.narration && state.project.audio.narration.on !== false && rep.voices) {
    bits.push(`<div>전체 나레이션 파일과 자막별 나레이션이 함께 켜져 있어 목소리가 겹칩니다.
      <button class="btn tiny" data-naract="offFull" type="button">전체 파일 끄기</button></div>`);
  }
  if (bits.length) {
    warn.classList.remove('hidden');
    warn.innerHTML = bits.join('');
  } else {
    warn.classList.add('hidden');
    warn.innerHTML = '';
  }

  renderNarSegList(rep);
  renderNarVoiceList(rep);
}

function renderNarSegList(rep) {
  if (!narSegListEl) return;
  // 이 목록의 자막 칸에 커서가 있으면 다시 그리지 않습니다(타이핑 중 커서·글자 유지).
  const focused = document.activeElement;
  if (focused && focused.matches && focused.matches('textarea[data-narsegtext]') && narSegListEl.contains(focused)) return;
  const segs = state.project.segments || [];
  if (!segs.length) {
    narSegListEl.innerHTML = '<div class="ai-empty">구간이 없습니다. 먼저 사진·영상을 올려 주세요.</div>';
    return;
  }
  const lay = voiceLayoutNow();
  const rate = narrationRate();
  narSegListEl.innerHTML = segs.map((sg, i) => {
    const text = segmentNarrationText(sg);
    const vc = voiceFor(sg.id);
    const l = vc ? lay.get(vc.id) : null;
    let badge = '';
    if (vc) {
      const tag = [
        l && l.spedUp ? `${l.rate.toFixed(2)}x` : '',
        l && l.trimmed ? '끝 잘림' : '',
      ].filter(Boolean).join(' · ');
      if (voiceIsStale(vc)) {
        badge = vc.genText == null
          ? `<span class="ai-badge-warn" title="이전 버전에서 만든 음성이라 자막과 같은지 확인되지 않았습니다">대본 확인 필요 — 다시 만들기</span>`
          : `<span class="ai-badge-warn" title="자막을 고쳐서 대본이 달라졌습니다">대본 바뀜 — 다시 만들기</span>`;
      } else {
        badge = `<span class="ai-badge-ok" title="이 음성의 재생 속도 ${(l ? l.rate : rate).toFixed(2)}x">${escapeHtml(vc.voiceName || '음성')} ${l ? l.played.toFixed(1) : (vc.duration || 0).toFixed(1)}초${tag ? ` (${tag})` : ''}</span>`;
      }
    }
    if (!text) badge += '<span class="ai-badge-warn">자막 없음</span>';
    return `<div class="ai-seg${text ? '' : ' dim'}" data-segid="${sg.id}">
      <div class="ai-seg-head">
        <span class="num">${i + 1}</span>
        <span class="time">${sg.start.toFixed(1)}~${sg.end.toFixed(1)}초</span>
        <span class="grow"></span>
        ${badge}
      </div>
      <div class="ai-seg-text">
        <textarea class="nar-seg-text" data-narsegtext="${sg.id}" rows="${Math.max(1, Math.min(4, String(sg.subtitle || '').split('\n').length))}" placeholder="자막 없음 — 여기에 쓰면 2번 자막과 같이 바뀝니다">${escapeHtml(sg.subtitle || '')}</textarea>
      </div>
      <div class="ai-seg-acts">
        <button class="btn tiny" data-segact="play" data-segid="${sg.id}" type="button" title="${vc ? '이 구간 음성 듣기' : '이 자막을 브라우저 음성으로 미리 읽어 보기(저장 안 됨)'}">🔊 듣기</button>
        <button class="btn tiny ghost" data-segact="tts" data-segid="${sg.id}" type="button" title="이 구간만 Gemini TTS로 다시 만들기">✨ TTS</button>
        <button class="btn tiny ghost" data-segact="record" data-segid="${sg.id}" type="button" title="이 구간을 마이크로 녹음">🎙 녹음</button>
        <button class="btn tiny ghost" data-segact="file" data-segid="${sg.id}" type="button" title="외부 TTS 파일 넣기">📁 파일</button>
      </div>
    </div>`;
  }).join('');
}

function renderNarVoiceList(rep) {
  if (!narVoiceListEl) return;
  const items = voiceClips();
  const countEl = $('#narVoiceCount', pane);
  if (countEl) countEl.textContent = items.length ? `${items.length}개` : '';
  if (!items.length) {
    narVoiceListEl.innerHTML = '<div class="ai-empty">아직 구간 음성이 없습니다. 위에서 [전체 자막 TTS 만들기]를 누르면 자막과 1:1로 한 번에 만들어 집니다.</div>';
    return;
  }
  const lay = voiceLayoutNow();
  const rate = narrationRate();
  narVoiceListEl.innerHTML = items.map((v) => {
    const seg = state.project.segments.find((s) => s.id === v.segId);
    const l = lay.get(v.id) || null;
    const at = l ? l.start : (v.start || 0);
    const durTxt = voiceTimingText(v, l) || `${(v.duration || 0).toFixed(1)}초`;
    const stale = voiceIsStale(v);
    return `<div class="ai-voice" data-voice="${v.id}">
      <button class="icon-btn sm" data-voiceact="play" data-voiceid="${v.id}" type="button" title="듣기">▶</button>
      <div class="ai-voice-meta">
        <b>${escapeHtml(v.voiceName || v.name || '음성')} <span class="ai-voice-tag">${rate.toFixed(2)}x</span>${stale ? ' <span class="ai-badge-warn" style="font-size:8.5px">대본 바뀜</span>' : ''}</b>
        <small>${at.toFixed(2)}초 · ${durTxt}${seg ? ` · ${seg.start.toFixed(1)}~${seg.end.toFixed(1)}초` : ''}</small>
      </div>
      <input type="range" data-voicevol="${v.id}" min="0" max="150" step="5" value="${v.volume ?? 100}" aria-label="볼륨">
      <span class="v" data-voicevol-label="${v.id}">${v.volume ?? 100}%</span>
      <button class="icon-btn sm" data-voiceact="del" data-voiceid="${v.id}" type="button" title="삭제">✕</button>
    </div>`;
  }).join('');
}

/** 3번 탭에서 자막을 직접 고쳐도 2번 자막·나레이션 대본이 같이 바뀝니다. */
function onSegTextInput(e) {
  const id = e.target.dataset.narsegtext;
  if (!id) return;
  const seg = state.project.segments.find((s) => s.id === id);
  if (!seg) return;
  seg.subtitle = e.target.value;
  const rows = Math.max(1, Math.min(4, String(seg.subtitle || '').split('\n').length));
  if (e.target.rows !== rows) e.target.rows = rows;
  syncNarrationToSegments({ prune: false });
  mixDirty();
  persist();
  emit('project', { panels: ['text'] });
}

async function onSegAction(e) {
  const btn = e.target.closest('[data-segact]');
  if (!btn) return;
  const act = btn.dataset.segact;
  const segId = btn.dataset.segid;
  const seg = state.project.segments.find((s) => s.id === segId);
  if (!seg) return;
  const text = segmentNarrationText(seg);

  if (act === 'play') {
    stopAllSpeech();
    const vc = voiceFor(seg.id);
    const asset = vc && getAsset(vc.assetId);
    if (vc && asset && asset.url) {
      const l = voiceLayoutNow().get(vc.id);
      playVoiceUrl(asset.url, {
        volume: clamp((vc.volume ?? 100) / 100, 0, 1),
        rate: l ? l.rate : narrationRate(),
      });
      return;
    }
    if (!text) { emit('toast', { msg: '이 구간에는 자막이 없습니다.', type: 'err' }); return; }
    try {
      seek(seg.start + 0.01);
      await previewSpeech(text, { rate: narrationRate() });
    } catch (err) {
      emit('toast', { msg: err.message || '미리듣기에 실패했습니다.', type: 'err' });
    }
    return;
  }

  if (act === 'tts') {
    const s = loadAiSettings();
    if (!s.apiKey) { narStatus('Gemini TTS에는 무료 API 키가 필요합니다.', 'err'); return; }
    if (!text) { emit('toast', { msg: '이 구간에는 자막이 없습니다.', type: 'err' }); return; }
    if (narRunning) return;
    setNarBusy(true);
    const voice = ($('#narVoice', pane) && $('#narVoice', pane).value) || s.voice || 'Kore';
    narStatus('이 구간 TTS를 만드는 중…', 'warn');
    try {
      const res = await buildNarration({ mode: 'one', segIds: [seg.id], voice, onProgress: (m) => narStatus(m, 'warn') });
      narStatus(res.ok ? '이 구간 TTS를 만들었습니다.' : `만들지 못했습니다${res.lastErr ? `: ${res.lastErr}` : ''}`, res.ok ? 'ok' : 'err');
      renderNarration();
      emit('project', { panels: ['audio'] });
    } catch (err) {
      narStatus(err.message || 'TTS에 실패했습니다.', 'err');
    } finally {
      setNarBusy(false);
    }
    return;
  }

  if (act === 'record') {
    if (segRec && segRec.segId === segId) { segRec.stop(); return; }
    if (segRec) { emit('toast', { msg: '다른 구간을 녹음 중입니다. 먼저 ■ 중지를 눌러 주세요.' }); return; }
    const limit = Math.min(30, Math.ceil(Math.max(1.2, (seg.end - seg.start) + 0.4)));
    const label = btn.textContent;
    try {
      stopAllSpeech();
      seek(seg.start + 0.01);
      const handle = await recordVoice({
        maxSeconds: limit,
        onTick: (t) => { btn.textContent = `■ 중지 ${t.toFixed(1)}s`; },
      });
      segRec = { segId, stop: handle.stop };
      narStatus(`🎙 녹음 중… 이 구간 자막을 읽어 주세요 (최대 ${limit}초, 끝나면 자동 종료)`, 'warn');
      btn.classList.add('danger');
      const done = await handle.done;
      segRec = null;
      btn.classList.remove('danger');
      btn.textContent = label;
      if (!done.blob.size) throw new Error('녹음된 소리가 없습니다.');
      voiceClips().filter((v) => v.segId === seg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
      await addVoiceClip({ blob: done.blob, name: voiceAssetName(seg, '녹음'), start: seg.start, segId: seg.id, kind: 'mic', text });
      renderNarration();
      emit('project', { panels: ['audio'] });
      narStatus('녹음을 이 구간에 넣었습니다.', 'ok');
      emit('toast', { msg: '녹음을 구간 나레이션으로 넣었습니다.', type: 'ok' });
    } catch (err) {
      segRec = null;
      btn.classList.remove('danger');
      btn.textContent = label;
      narStatus(err.message || '녹음하지 못했습니다. 마이크 권한을 확인해 주세요.', 'err');
    }
    return;
  }

  if (act === 'file') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg';
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      try {
        voiceClips().filter((v) => v.segId === seg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
        await addVoiceClip({ blob: f, name: f.name.replace(/\.[a-z0-9]+$/i, '') || voiceAssetName(seg, '음성'), start: seg.start, segId: seg.id, kind: 'file', text });
        renderNarration();
        emit('project', { panels: ['audio'] });
        narStatus('외부 TTS 파일을 이 구간에 넣었습니다.', 'ok');
      } catch (err) {
        narStatus(err.message || '파일을 넣지 못했습니다.', 'err');
      }
    });
    input.click();
    return;
  }
}

let auditionAudio = null;
function stopAuditionAudio() {
  if (auditionAudio) {
    try { auditionAudio.pause(); } catch (e) { /* 무시 */ }
    auditionAudio = null;
  }
}

function onVoiceAction(e) {
  const actBtn = e.target.closest('[data-naract]');
  if (actBtn) {
    const act = actBtn.dataset.naract;
    if (act === 'clean') {
      const n = cleanNarrationTrack({ forget: true });
      syncNarrationToSegments({ prune: false });
      renderNarration();
      emit('project', { panels: ['audio'] });
      emit('toast', { msg: n ? `자막과 안 맞는 옛 음성 ${n}개를 정리했습니다.` : '정리할 음성이 없습니다.', type: n ? 'ok' : '' });
    } else if (act === 'sync' || act === 'unify') {
      runNarration(act === 'unify' ? 'all' : 'sync');
    } else if (act === 'offFull') {
      if (state.project.audio.narration) {
        state.project.audio.narration.on = false;
        mixDirty();
        persist();
        renderFullNarration();
        renderNarration();
        emit('toast', { msg: '전체 나레이션 파일을 껐습니다(자막별 나레이션만 들립니다).', type: 'ok' });
      }
    }
    return;
  }
  const btn = e.target.closest('[data-voiceact]');
  if (!btn) return;
  const id = btn.dataset.voiceid;
  const item = voiceClips().find((v) => v.id === id);
  if (btn.dataset.voiceact === 'del') {
    stopAllSpeech();
    removeVoiceClip(id, { forget: true });
    renderNarration();
    emit('project', { panels: ['audio'] });
    emit('toast', { msg: '구간 음성을 삭제했습니다.' });
    return;
  }
  if (btn.dataset.voiceact === 'play') {
    const asset = item && getAsset(item.assetId);
    if (!item || !asset || !asset.url) { emit('toast', { msg: '음성 파일을 찾지 못했습니다.', type: 'err' }); return; }
    const l = voiceLayoutNow().get(id);
    auditionAudio = playVoiceUrl(asset.url, {
      volume: clamp((item.volume ?? 100) / 100, 0, 1),
      rate: l ? l.rate : narrationRate(),
    });
  }
}

function onVoiceVolume(e) {
  const id = e.target.dataset.voicevol;
  if (!id) return;
  const item = voiceClips().find((v) => v.id === id);
  if (!item) return;
  item.volume = clamp(Number(e.target.value) || 0, 0, 150);
  const label = $(`[data-voicevol-label="${id}"]`, pane);
  if (label) label.textContent = `${item.volume}%`;
  mixDirty();
  emit('save');
}

// ══ 전체 나레이션 파일 (선택) ═════════════════════════
function renderFullNarration() {
  if (!fullCard) return;
  const n = state.project.audio.narration;
  const recording = !!recState.rec;
  fullCard.innerHTML = `
    <div class="audio-file">
      <span class="name ${n ? '' : 'empty'}">${n ? escapeHtml(n.name) : '녹음하거나 파일을 올려주세요'}</span>
      ${n ? `<button class="icon-btn sm" data-act="delNar" type="button" title="삭제">✕</button>` : ''}
    </div>
    <div class="row" style="margin:0">
      <button class="btn sm ${recording ? 'danger' : ''}" data-act="rec" type="button">
        ${recording ? '<span class="rec-dot recording"></span> 녹음 중지' : '● 마이크 녹음'}
      </button>
      <button class="btn sm ghost" data-act="pickNar" type="button">파일 올리기</button>
      <span class="grow"></span>
      <span class="val" data-rec-time>${recording ? '0.0초' : ''}</span>
    </div>
    ${n ? `
      <div class="row">
        <label class="switch"><input type="checkbox" data-audio="narration.on" ${n.on === false ? '' : 'checked'}> 재생·MP4에 포함</label>
        <span class="grow"></span>
        <span class="ai-key-state">${(n.duration || 0).toFixed(1)}초</span>
      </div>
      <div class="row">
        <label>시작 시간</label>
        <input type="range" class="grow" data-audio="narration.start" min="0" max="${Math.max(1, totalDuration()).toFixed(1)}" step="0.1" value="${(n.start || 0).toFixed(1)}">
        <span class="val" data-nval="start">${(n.start || 0).toFixed(1)}초</span>
      </div>
      <div class="row">
        <label>볼륨</label>
        <input type="range" class="grow" data-audio="narration.volume" min="0" max="150" step="5" value="${n.volume ?? 100}">
        <span class="val" data-nval="volume">${n.volume ?? 100}%</span>
      </div>
      <div class="sec-note" style="margin:0">자막별 나레이션과 같이 켜면 목소리가 두 개로 들립니다. 보통은 자막별 나레이션만 쓰고 이 파일은 끕니다.</div>
    ` : ''}
  `;
}

// ══ BGM ═════════════════════════════════════════════
function renderBgm() {
  const b = state.project.audio.bgm;
  bgmCard.innerHTML = `
    <div class="audio-file">
      <span class="name ${b ? '' : 'empty'}">${b ? escapeHtml(b.name) : 'BGM 파일을 올려주세요 (.mp3/.wav/.m4a)'}</span>
      ${b ? `<button class="icon-btn sm" data-act="delBgm" type="button" title="삭제">✕</button>` : ''}
      <button class="btn sm ghost" data-act="pickBgm" type="button">${b ? '교체' : '파일 올리기'}</button>
    </div>
    ${b ? `
      <div class="row">
        <label>볼륨</label>
        <input type="range" class="grow" data-audio="bgm.volume" min="0" max="150" step="5" value="${b.volume ?? 40}">
        <span class="val" data-bval="volume">${b.volume ?? 40}%</span>
      </div>
      <div class="row">
        <label>페이드 인</label>
        <input type="range" class="grow" data-audio="bgm.fadeIn" min="0" max="5" step="0.1" value="${b.fadeIn ?? 1}">
        <span class="val" data-bval="fadeIn">${(b.fadeIn ?? 1).toFixed(1)}초</span>
      </div>
      <div class="row">
        <label>페이드 아웃</label>
        <input type="range" class="grow" data-audio="bgm.fadeOut" min="0" max="5" step="0.1" value="${b.fadeOut ?? 1}">
        <span class="val" data-bval="fadeOut">${(b.fadeOut ?? 1).toFixed(1)}초</span>
      </div>
      <div class="sec-note" style="margin:0">영상 길이만큼 반복 재생됩니다.</div>
    ` : ''}
  `;
}

// ══ 효과음 ═════════════════════════════════════════
function insertSfx(key) {
  const p = state.project;
  const t = round(clamp(state.time, 0, Math.max(0, totalDuration())), 2);
  const item = { id: uid('sfx'), key, t, volume: 100 };
  p.audio.sfx.push(item);
  p.audio.sfx.sort((a, b) => a.t - b.t);
  state.sel.sfx = item.id;
  onAdded();
  renderSfxTracks();
  emit('toast', { msg: `${sfxName(key)} 효과음을 ${t.toFixed(2)}초에 넣었습니다.`, type: 'ok' });
}

async function addCustomSfx(file) {
  try {
    const asset = await importAudioFile(file);
    const p = state.project;
    p.audio.customSfx = p.audio.customSfx || [];
    if (!p.audio.customSfx.includes(asset.id)) p.audio.customSfx.push(asset.id);
    onAdded();
    renderCustomSfx();
    emit('toast', { msg: `${file.name} 효과음을 추가했습니다.`, type: 'ok' });
  } catch (e) {
    emit('toast', { msg: '효과음을 추가하지 못했습니다: ' + (e.message || e), type: 'err' });
  }
}

function renderCustomSfx() {
  const ids = (state.project.audio.customSfx || []).filter((id) => getAsset(id));
  $('#customCount', pane).textContent = ids.length ? `${ids.length}개` : '';
  if (!ids.length) {
    customListEl.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:4px 2px">아직 올린 효과음이 없습니다.</div>`;
    return;
  }
  customListEl.innerHTML = ids.map((id) => {
    const a = getAsset(id);
    return `<div class="sfx-item">
      <button class="sfx-play" data-preview="${id}" type="button">▶</button>
      <div class="sfx-info"><b>${escapeHtml(a.name)}</b><small>내 효과음</small></div>
      <span class="sfx-dur">${sfxDuration(id).toFixed(2)}초</span>
      <button class="btn tiny sfx-add" data-add="${id}" type="button">+ 현재 위치</button>
      <button class="icon-btn sm" data-delsfx="${id}" type="button" title="목록에서 삭제">✕</button>
    </div>`;
  }).join('');
}

function renderSfxTracks() {
  const items = state.project.audio.sfx || [];
  $('#sfxCount', pane).textContent = items.length ? `${items.length}개` : '';
  if (!items.length) {
    trackListEl.innerHTML = `<div style="font-size:11px;color:var(--muted);padding:4px 2px">아직 넣은 효과음이 없습니다. 위에서 [+ 현재 위치]를 눌러보세요.</div>`;
    return;
  }
  trackListEl.innerHTML = items.map((it) => `
    <div class="sfx-track-item${state.sel.sfx === it.id ? ' sel' : ''}" data-id="${it.id}" style="${state.sel.sfx === it.id ? 'border-color:rgba(255,216,77,.5)' : ''}">
      <span class="t">${it.t.toFixed(2)}초</span>
      <span class="n">${escapeHtml(sfxName(it.key))}</span>
      <input type="range" data-sfxvol="${it.id}" min="0" max="150" step="5" value="${it.volume ?? 100}">
      <span class="v" data-vol="${it.id}">${it.volume ?? 100}%</span>
      <button class="icon-btn sm" data-deltrack="${it.id}" type="button" title="삭제">✕</button>
    </div>`).join('');
}

// ── 이벤트 ────────────────────────────────────────────
async function onClick(e) {
  const prev = e.target.closest('[data-preview]');
  if (prev) {
    const key = prev.dataset.preview;
    stopAllSpeech();
    const item = (state.project.audio.sfx || []).find((s) => s.key === key);
    await previewSfx(key, item ? Math.min(1.5, (item.volume ?? 100) / 100) : 1);
    return;
  }
  const add = e.target.closest('[data-add]');
  if (add) { insertSfx(add.dataset.add); return; }

  const delSfx = e.target.closest('[data-delsfx]');
  if (delSfx) {
    const id = delSfx.dataset.delsfx;
    const p = state.project;
    p.audio.customSfx = (p.audio.customSfx || []).filter((x) => x !== id);
    p.audio.sfx = (p.audio.sfx || []).filter((s) => s.key !== id);
    if (!isAssetUsed(id)) forgetAsset(id);
    onAdded();
    renderCustomSfx();
    renderSfxTracks();
    emit('timeline');
    return;
  }

  const delTrack = e.target.closest('[data-deltrack]');
  if (delTrack) {
    const id = delTrack.dataset.deltrack;
    state.project.audio.sfx = state.project.audio.sfx.filter((s) => s.id !== id);
    if (state.sel.sfx === id) state.sel.sfx = null;
    onAdded();
    renderSfxTracks();
    emit('timeline');
    return;
  }

  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'rec') { await toggleRecord(); }
  else if (act === 'pickNar') {
    pickAudio(async (asset) => {
      state.project.audio.narration = { assetId: asset.id, name: asset.name, start: round(state.time, 1), volume: 100, duration: asset.duration || 0, on: true };
      onAdded(); renderFullNarration(); renderNarration(); emit('timeline');
    });
  } else if (act === 'delNar') {
    const n = state.project.audio.narration;
    state.project.audio.narration = null;
    if (n && !isAssetUsed(n.assetId)) forgetAsset(n.assetId);
    onAdded(); renderFullNarration(); renderNarration(); emit('timeline');
  } else if (act === 'pickBgm') {
    pickAudio(async (asset) => {
      state.project.audio.bgm = { assetId: asset.id, name: asset.name, volume: 40, fadeIn: 1, fadeOut: 1, start: 0, duration: asset.duration || 0 };
      onAdded(); renderBgm(); emit('timeline');
    }, true);
  } else if (act === 'delBgm') {
    const b = state.project.audio.bgm;
    state.project.audio.bgm = null;
    if (b && !isAssetUsed(b.assetId)) forgetAsset(b.assetId);
    onAdded(); renderBgm(); emit('timeline');
  }
}

function pickAudio(cb, big = false) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.mp3,.wav,.m4a,.aac';
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (!isAudioFile(f)) { emit('toast', { msg: '오디오 파일만 올릴 수 있습니다.', type: 'err' }); return; }
    try {
      const asset = await importAudioFile(f);
      await cb(asset);
      emit('toast', { msg: '오디오를 추가했습니다.', type: 'ok' });
    } catch (err) {
      emit('toast', { msg: '오디오를 읽지 못했습니다: ' + (err.message || err), type: 'err' });
    }
  });
  input.click();
}

async function toggleRecord() {
  if (recState.rec) {
    const rec = recState.rec;
    recState.rec = null;
    clearInterval(recState.timer);
    const stopped = new Promise((res) => { rec.onstop = res; });
    try { rec.stop(); } catch (e) {}
    await stopped;
    const chunks = recState.chunks || [];
    recState.stream?.getTracks().forEach((t) => t.stop());
    recState.stream = null;
    renderFullNarration();
    if (!chunks.length) { emit('toast', { msg: '녹음된 소리가 없습니다.', type: 'err' }); return; }
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    const ext = (rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
    const file = new File([blob], `나레이션 녹음.${ext}`, { type: blob.type });
    try {
      const asset = await importAudioFile(file);
      state.project.audio.narration = { assetId: asset.id, name: '나레이션 녹음', start: round(Math.max(0, state.time - (asset.duration || 0)), 1), volume: 100, duration: asset.duration || 0, on: true };
      onAdded(); renderFullNarration(); renderNarration(); emit('timeline');
      emit('toast', { msg: `녹음 완료 (${(asset.duration || 0).toFixed(1)}초)`, type: 'ok' });
    } catch (e) {
      emit('toast', { msg: '녹음을 저장하지 못했습니다: ' + (e.message || e), type: 'err' });
    }
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recState = { rec, stream, chunks: [], startedAt: performance.now(), timer: null };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) recState.chunks.push(e.data); };
    rec.start(200);
    recState.timer = setInterval(() => {
      const el = fullCard.querySelector('[data-rec-time]');
      if (el) el.textContent = `${((performance.now() - recState.startedAt) / 1000).toFixed(1)}초`;
    }, 100);
    renderFullNarration();
  } catch (e) {
    emit('toast', { msg: '마이크를 사용할 수 없습니다. 파일로 올려주세요.', type: 'err' });
  }
}

function onInput(e) {
  const sfxVol = e.target.dataset.sfxvol;
  if (sfxVol) {
    const item = state.project.audio.sfx.find((s) => s.id === sfxVol);
    if (!item) return;
    item.volume = Number(e.target.value);
    const label = trackListEl.querySelector(`[data-vol="${sfxVol}"]`);
    if (label) label.textContent = `${item.volume}%`;
    mixDirty();
    emit('save');
    return;
  }
  const path = e.target.dataset.audio;
  if (!path) return;
  const [which, field] = path.split('.');
  const target = state.project.audio[which];
  if (!target) return;
  target[field] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
  const label = fullCard.querySelector(`[data-nval="${field}"]`) || bgmCard.querySelector(`[data-bval="${field}"]`);
  if (label) label.textContent = field === 'start' || field === 'fadeIn' || field === 'fadeOut' ? `${Number(e.target.value).toFixed(1)}초` : `${Math.round(Number(e.target.value))}%`;
  mixDirty();
  emit('save');
}

function onChange(e) {
  if (e.target.dataset.audio) {
    mixDirty();
    emit('timeline');
    if (e.target.dataset.audio === 'narration.on') renderNarration();
  }
}

/** 타임라인에서 효과음 블록을 선택하면 목록을 갱신합니다. */
export function selectSfx(id) {
  state.sel.sfx = id;
  renderSfxTracks();
}

export function refreshAudioPanel() {
  if (!pane) return;
  renderCustomSfx();
  renderNarration();
  renderBgm();
  renderSfxTracks();
  renderFullNarration();
}
