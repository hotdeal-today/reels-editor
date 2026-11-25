// panels/ai.js — 탭5: AI 자동 세팅 (원클릭 · 프롬프트 복사/붙여넣기 · Gemini · TTS · 프로젝트 파일)
import { $, $$, clamp, emit, escapeHtml, fmtSec, downloadBlob } from '../util.js';
import { state, totalDuration, persist, getAsset } from '../state.js';
import {
  loadAiSettings, saveAiSettings, maskKey, listModels, pickModels,
  buildChatPrompt, buildPrompt, collectFrames, askGemini, askGeminiText, parsePlan, applyPlan,
  autoLayout, applyDesignSet, VOICES, TTS_MODEL_CANDIDATES, TEXT_MODEL_CANDIDATES,
} from '../ai.js';
import {
  CAPTION_CHANNELS, loadCaptionState, saveCaptionState, fetchBlogText,
  buildCaptionPrompt, parseCaptions, checkNaverClipCaption, normalizeBlogUrl,
} from '../captions.js';
import { DESIGN_SETS } from '../presets.js';
import {
  geminiTts, addVoiceClip, removeVoiceClip, voiceClips, previewSpeech, stopSpeech,
  localVoices, speechSupported, recordVoice, voiceAssetName,
} from '../tts.js';
import { buildProjectJson, loadProjectJson, projectFileName } from '../project-io.js';
import { seek } from '../player.js';

let pane = null;
let rec = null;
let busy = false;
let capBusy = false;
let availableModels = null; // { ids, text, tts }

export function initAiPanel(el) {
  pane = el;
  const s = loadAiSettings();
  const local = localVoices();

  pane.innerHTML = `
    <div class="ai-hero">
      <b>✨ AI 자동 세팅</b>
      <p>사진·영상을 올린 뒤 한 번만 누르면 <b>컷·모션·전환·디자인·효과음·마지막 멘트</b>가 자동으로 배치됩니다.
      아래 <b>무료 원클릭</b>은 키가 필요 없고, <b>Gemini</b>는 무료 API 키를 넣으면 사진을 읽고 제목·자막까지 만들어 줍니다.</p>
    </div>

    <div class="sec">
      <div class="sec-head">📝 블로그 글 → 5채널 캡션 <span class="count">클립·인스타·유튜브·페이스북·스레드</span></div>
      <div class="card ai-card">
        <div class="row">
          <label>블로그 URL</label>
          <input type="text" class="grow" id="capUrl" placeholder="https://blog.naver.com/… (선택)" spellcheck="false" autocomplete="off">
          <button class="btn tiny" id="capFetch" type="button">가져오기 시도</button>
        </div>
        <div class="sec-note" style="margin:6px 0 7px">
          네이버 블로그는 브라우저에서 직접 열람이 막히는 경우가 많아요. 실패하면 블로그 앱·PC에서 본문을 복사해 아래 칸에 붙여넣으면 바로 이어서 만들 수 있습니다.
          (URL로 시도할 때는 주소만 무료 텍스트 추출 서비스로 전달됩니다.)
        </div>
        <textarea id="capBody" class="ai-textarea" rows="6" placeholder="블로그 본문을 붙여넣으세요 (제목 + 본문)"></textarea>
        <div class="cap-meta" id="capMeta"></div>
        <div class="row" style="gap:6px">
          <button class="btn sm grow" id="capCopyPrompt" type="button">📋 프롬프트 복사</button>
          <button class="btn sm ghost" id="capShowPrompt" type="button">보기</button>
        </div>
        <textarea id="capPromptText" class="ai-textarea hidden" rows="8" readonly></textarea>
        <textarea id="capPaste" class="ai-textarea" rows="5" placeholder="AI가 준 결과를 그대로 붙여넣으세요. 5채널 캡션으로 나눠 담습니다."></textarea>
        <button class="btn primary block" id="capFromPaste" type="button" style="margin-top:7px">📥 붙여넣은 결과 채우기</button>
        <button class="btn primary block" id="capGenerate" type="button">✨ 5채널 캡션 만들기 (Gemini)</button>
        <div class="ai-status hidden" id="capStatus"></div>
        <div class="cap-out" id="capOut"></div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-head">⚡ 무료 원클릭 (키 필요 없음)</div>
      <div class="card ai-card">
        <div class="row">
          <label>디자인</label>
          <select class="grow" id="aiDesignSel">
            ${Object.entries(DESIGN_SETS).map(([id, d]) => `<option value="${id}">${d.label}</option>`).join('')}
          </select>
        </div>
        <div class="row">
          <label>사진 길이</label>
          <select class="grow" id="aiImageDur">
            <option value="2.2">2.2초 (빠른 템포)</option>
            <option value="2.6">2.6초 (권장)</option>
            <option value="3.2">3.2초 (여유)</option>
            <option value="4">4초 (천천히)</option>
          </select>
        </div>
        <div class="row">
          <label class="switch"><input type="checkbox" id="aiUseSfx"> 효과음 (짠·쉭·뽕)</label>
        </div>
        <div class="row">
          <label class="switch"><input type="checkbox" id="aiUseName"> 제목에 프로젝트 이름</label>
        </div>
        <button class="btn primary block ai-big" id="aiOneClick" type="button">⚡ 원클릭 자동 배치</button>
        <div class="sec-note" style="margin:6px 0 0">지금 타임라인의 구간·효과음을 새로 배치합니다. 자막 글자는 유지되지 않으니, 글자를 이미 썼다면 먼저 <b>💾 프로젝트 저장</b>을 해 두세요.</div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-head">📋 무료 ChatGPT · Gemini 채팅용 <span class="count">키 없이</span></div>
      <div class="card ai-card">
        <div class="sec-note" style="margin:0 0 7px">① 프롬프트를 복사해 무료 ChatGPT/Gemini 채팅창에 <b>사진과 함께</b> 붙여넣고, ② 받은 JSON을 아래에 붙여넣으세요.</div>
        <div class="row" style="gap:6px">
          <button class="btn sm grow" id="aiCopyPrompt" type="button">📋 프롬프트 복사</button>
          <button class="btn sm ghost" id="aiShowPrompt" type="button">보기</button>
        </div>
        <textarea id="aiPromptText" class="ai-textarea hidden" readonly rows="8"></textarea>
        <textarea id="aiPaste" class="ai-textarea" rows="5" placeholder='AI가 준 JSON을 그대로 붙여넣으세요. 예: {"title":"...","badge":"BEST","segments":[{"start":0,"end":3,"subtitle":"..."}],"hook":"자세한 내용은 본문에서 확인하세요👇"}'></textarea>
        <button class="btn primary block" id="aiApplyPaste" type="button" style="margin-top:7px">📥 붙여넣은 결과 자동 채우기</button>
      </div>
    </div>

    <div class="sec">
      <div class="sec-head">✨ Gemini로 자동 세팅 <span class="count">무료 키</span></div>
      <div class="card ai-card">
        <div class="row">
          <label>API 키</label>
          <input type="password" class="grow" id="aiKeyInput" placeholder="AIza… (aistudio.google.com/apikey)" autocomplete="off" spellcheck="false">
          <button class="btn tiny" id="aiKeySave" type="button">저장</button>
        </div>
        <div class="row" style="gap:6px">
          <span class="ai-key-state grow" id="aiKeyState"></span>
          <button class="btn tiny ghost" id="aiKeyClear" type="button">키 삭제</button>
          <button class="btn tiny" id="aiTest" type="button">연결 확인</button>
        </div>
        <div class="row">
          <label>주제</label>
          <input type="text" class="grow" id="aiTopic" placeholder="예: 오사카 3박4일 총정리 (선택)" maxlength="80">
        </div>
        <div class="row">
          <label>모델</label>
          <span class="ai-model grow" id="aiModelInfo">연결 확인을 누르면 모델을 확인합니다</span>
        </div>
        <button class="btn primary block ai-big" id="aiGenerate" type="button">✨ AI로 제목·자막·효과음 세팅</button>
        <div class="sec-note" style="margin:6px 0 0">
          키는 이 브라우저(localStorage)에만 저장되고 서버로 보내지 않습니다. 사진·영상 프레임은 Gemini에 전송됩니다(무료 한도 내).
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">무료 키 발급</a>
        </div>
        <div class="ai-status hidden" id="aiStatus"></div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-head">🗣 한국어 TTS (자막 읽어주기)</div>
      <div class="card ai-card">
        <div class="ai-warn">
          브라우저 기본 음성(<b>speechSynthesis</b>)은 스피커로만 나가고 MP4 파일에 섞이지 않습니다.
          그래서 <b>① Gemini 무료 키 TTS</b>는 실제 오디오로 만들어 영상에 믹싱하고,
          <b>② 브라우저 음성</b>은 타이밍 미리듣기 전용, <b>③ 마이크 녹음 / 외부 TTS 파일</b>은 구간별로 넣을 수 있게 했습니다.
        </div>
        <div class="row">
          <label>TTS 목소리</label>
          <select class="grow" id="ttsVoice">
            ${VOICES.map((v) => `<option value="${v.id}">${v.label}</option>`).join('')}
          </select>
        </div>
        <button class="btn primary block" id="ttsGenAll" type="button">🗣 전체 자막 TTS 만들기 (Gemini)</button>
        <div class="row" style="margin-top:8px">
          <label>브라우저 음성</label>
          <select class="grow" id="ttsLocalVoice">
            ${local.length ? local.map((v) => `<option value="${v.voiceURI}">${escapeHtml(v.name)} · ${v.lang}</option>`).join('') : '<option value="">(이 브라우저에 한국어 음성 없음)</option>'}
          </select>
        </div>
        <div class="sec-note" style="margin:6px 0 0">▶ 버튼은 그 구간 자막을 소리로만 미리 읽어 줍니다(영상에는 저장되지 않음). 녹음 파일·외부 TTS 파일(클로바더빙·브루·타입캐스트)은 그 구간 시작에 배치됩니다.</div>
        <div class="ai-seglist" id="ttsSegList"></div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-head">🎧 구간 음성 트랙 <span class="count" id="ttsVoiceCount"></span></div>
      <div class="ai-voicelist" id="ttsVoiceList"></div>
      <div class="sec-note" style="margin-top:6px">여기 들어간 음성은 미리보기와 MP4 내보내기에 함께 섞입니다.</div>
    </div>

    <div class="sec">
      <div class="sec-head">💾 프로젝트 저장 / 불러오기</div>
      <div class="card ai-card">
        <div class="row" style="gap:6px">
          <button class="btn sm grow" id="projSave" type="button">💾 .json 저장</button>
          <button class="btn sm ghost grow" id="projLoad" type="button">📂 .json 불러오기</button>
        </div>
        <input type="file" id="projFile" accept=".json,application/json" hidden>
        <div class="sec-note" style="margin:6px 0 0">타임라인·글자·디자인·오디오 설정이 저장됩니다. 사진·영상 원본은 저장되지 않아, 다른 기기에서는 같은 파일을 다시 올려야 합니다.</div>
      </div>
    </div>
  `;

  // 값 채우기
  $('#aiDesignSel', pane).value = s.design || 'neon';  $('#aiImageDur', pane).value = String(s.imageDur || 2.6);
  $('#aiUseSfx', pane).checked = s.useSfx !== false;
  $('#aiUseName', pane).checked = s.useName !== false;
  $('#aiTopic', pane).value = s.topic || '';
  $('#ttsVoice', pane).value = s.voice || 'Kore';

  bindEvents();
  initCaptions();
  refreshAiPanel();
}

function status(msg, type = '') {
  const box = $('#aiStatus', pane);
  if (!box) return;
  box.classList.remove('hidden', 'ok', 'err', 'warn');
  if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
  if (type) box.classList.add(type);
  box.textContent = msg;
}

function busyState(on) {
  busy = on;
  $$('#aiOneClick, #aiGenerate, #aiTest, #aiApplyPaste, #ttsGenAll', pane).forEach((b) => { b.disabled = on; });
}

function saveSettingsFromUI() {
  saveAiSettings({
    design: $('#aiDesignSel', pane).value,
    imageDur: Number($('#aiImageDur', pane).value) || 2.6,
    useSfx: $('#aiUseSfx', pane).checked,
    useName: $('#aiUseName', pane).checked,
    topic: $('#aiTopic', pane).value.trim(),
    voice: $('#ttsVoice', pane).value,
  });
}

function renderKeyState() {
  const s = loadAiSettings();
  const el = $('#aiKeyState', pane);
  if (!el) return;
  if (s.apiKey) {
    el.innerHTML = `저장됨 <b>${escapeHtml(maskKey(s.apiKey))}</b> · 이 브라우저에만 보관`;
    el.classList.add('has-key');
  } else {
    el.textContent = '아직 키가 없습니다 (원클릭·붙여넣기는 키 없이 동작)';
    el.classList.remove('has-key');
  }
  const info = $('#aiModelInfo', pane);
  if (info) {
    if (availableModels) {
      info.textContent = `글자 ${availableModels.text || '없음'} · TTS ${availableModels.tts || '없음'}`;
    } else {
      info.textContent = s.model ? `${s.model} (확인 전)` : '연결 확인을 누르면 모델을 확인합니다';
    }
  }
  const keyInput = $('#aiKeyInput', pane);
  if (keyInput && !keyInput.value) keyInput.placeholder = s.apiKey ? `저장된 키 ${maskKey(s.apiKey)} — 바꾸려면 새 키 입력` : 'AIza… (aistudio.google.com/apikey)';
}

function bindEvents() {
  // 설정 변경 저장
  ['aiDesignSel', 'aiImageDur', 'aiUseSfx', 'aiUseName', 'aiTopic', 'ttsVoice'].forEach((id) => {
    const el = $(`#${id}`, pane);
    el.addEventListener('change', saveSettingsFromUI);
    if (el.tagName === 'INPUT' && el.type === 'text') el.addEventListener('blur', saveSettingsFromUI);
  });

  $('#aiOneClick', pane).addEventListener('click', () => {
    saveSettingsFromUI();
    const s = loadAiSettings();
    const hasText = (state.project.segments || []).some((sg) => (sg.title || sg.badge || sg.subtitle || '').trim());
    if (hasText && !window.confirm('기존 구간·자막·효과음이 새로 배치됩니다(지금 쓴 글자는 사라집니다). 계속할까요?\n\n글자를 지키려면 [취소] 후 💾 .json 저장을 먼저 해 두세요.')) return;
    try {
      const res = autoLayout({ design: s.design, imageDur: s.imageDur, useSfx: s.useSfx, useName: s.useName });
      emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
      emit('toast', { msg: `원클릭 배치 완료 — 컷 ${res.clips}개 · 구간 ${res.segments}개 · 효과음 ${res.sfx}개 · ${res.design}`, type: 'ok' });
    } catch (e) {
      emit('toast', { msg: e.message || '자동 배치에 실패했습니다.', type: 'err' });
    }
  });

  // 프롬프트
  $('#aiCopyPrompt', pane).addEventListener('click', async () => {
    saveSettingsFromUI();
    const text = buildChatPrompt($('#aiTopic', pane).value.trim());
    const ta = $('#aiPromptText', pane);
    if (ta) { ta.value = text; }
    try {
      await navigator.clipboard.writeText(text);
      emit('toast', { msg: '프롬프트를 복사했습니다. 무료 ChatGPT/Gemini 채팅에 사진과 함께 붙여넣으세요.', type: 'ok' });
    } catch (e) {
      if (ta) {
        ta.classList.remove('hidden');
        ta.focus(); ta.select();
        try { document.execCommand('copy'); emit('toast', { msg: '프롬프트를 복사했습니다.', type: 'ok' }); } catch (e2) {
          emit('toast', { msg: '복사가 막혔습니다. 아래 칸에서 직접 복사해 주세요.', type: 'err' });
        }
      }
    }
  });

  $('#aiShowPrompt', pane).addEventListener('click', () => {
    const ta = $('#aiPromptText', pane);
    if (!ta) return;
    if (ta.classList.contains('hidden')) {
      ta.value = buildChatPrompt($('#aiTopic', pane).value.trim());
      ta.classList.remove('hidden');
    } else {
      ta.classList.add('hidden');
    }
  });

  $('#aiApplyPaste', pane).addEventListener('click', () => {
    const text = $('#aiPaste', pane).value.trim();
    if (!text) { emit('toast', { msg: 'AI가 준 JSON을 먼저 붙여넣어 주세요.', type: 'err' }); return; }
    try {
      const plan = parsePlan(text);
      const res = applyPlan(plan);
      emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
      status(`붙여넣기 적용 완료 — 구간 ${res.segments}개 · 효과음 ${res.sfx}개${res.title ? ` · 제목 “${res.title}”` : ''}`, 'ok');
      emit('toast', { msg: `자동 채우기 완료 (구간 ${res.segments}개)`, type: 'ok' });
    } catch (e) {
      status(e.message || '적용하지 못했습니다.', 'err');
      emit('toast', { msg: e.message || '적용하지 못했습니다.', type: 'err' });
    }
  });

  // 키
  $('#aiKeySave', pane).addEventListener('click', () => {
    const v = $('#aiKeyInput', pane).value.trim();
    if (!v) { emit('toast', { msg: 'API 키를 입력해 주세요.', type: 'err' }); return; }
    if (v.length < 20) { emit('toast', { msg: 'API 키가 너무 짧습니다. 전체 키를 붙여넣어 주세요.', type: 'err' }); return; }
    saveAiSettings({ apiKey: v });
    $('#aiKeyInput', pane).value = '';
    availableModels = null;
    renderKeyState();
    emit('toast', { msg: 'API 키를 이 브라우저에만 저장했습니다.', type: 'ok' });
    status('키를 저장했습니다. "연결 확인"을 눌러 사용 가능한 모델을 확인하세요.', 'ok');
  });

  $('#aiKeyClear', pane).addEventListener('click', () => {
    saveAiSettings({ apiKey: '' });
    availableModels = null;
    renderKeyState();
    status('');
    emit('toast', { msg: '저장된 API 키를 지웠습니다.' });
  });

  $('#aiTest', pane).addEventListener('click', async () => {
    const s = loadAiSettings();
    if (!s.apiKey) { status('먼저 API 키를 저장해 주세요.', 'err'); return; }
    busyState(true);
    status('모델 목록을 확인하는 중…', 'warn');
    try {
      const ids = await listModels(s.apiKey);
      const picked = pickModels(ids, s);
      availableModels = picked;
      saveAiSettings({ model: picked.text || s.model, ttsModel: picked.tts || s.ttsModel });
      renderKeyState();
      const ttsList = ids.filter((i) => /tts/i.test(i));
      status(`연결 OK — 모델 ${ids.length}개 확인. 글자: ${picked.text || '없음'} / TTS: ${picked.tts || '없음'}${ttsList.length ? ` (TTS 후보 ${ttsList.length}개)` : ''}`, picked.text ? 'ok' : 'warn');
    } catch (e) {
      status(e.message || '연결 확인에 실패했습니다.', 'err');
    } finally {
      busyState(false);
    }
  });

  $('#aiGenerate', pane).addEventListener('click', async () => {
    const s = loadAiSettings();
    if (!s.apiKey) { status('Gemini를 쓰려면 무료 API 키가 필요합니다. 키가 없다면 위의 "원클릭"이나 "프롬프트 복사"를 쓰세요.', 'err'); return; }
    if (!state.project.clips.length) { status('사진이나 영상을 먼저 추가해 주세요.', 'err'); return; }
    saveSettingsFromUI();
    busyState(true);
    status('사진·영상에서 대표 프레임을 준비하는 중…', 'warn');
    try {
      let model = s.model;
      let ttsModel = s.ttsModel;
      if (!availableModels) {
        try {
          const ids = await listModels(s.apiKey);
          const picked = pickModels(ids, s);
          availableModels = picked;
          model = picked.text || model;
          ttsModel = picked.tts || ttsModel;
          saveAiSettings({ model, ttsModel });
          renderKeyState();
        } catch (e) { /* 모델 목록을 못 받아도 기본 모델로 시도 */ }
      } else {
        model = availableModels.text || model;
      }
      const frames = await collectFrames(8);
      if (!frames.length) throw new Error('사진·영상 프레임을 읽지 못했습니다. 파일을 다시 올려 주세요.');
      status(`Gemini(${model})가 사진 프레임 ${frames.length}장을 보고 세팅을 만드는 중… (10~30초)`, 'warn');
      const { plan } = await askGemini({ apiKey: s.apiKey, model, prompt: buildPrompt($('#aiTopic', pane).value.trim()), frames });
      const res = applyPlan(plan);
      emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
      status(`AI 세팅 완료 — 제목 “${res.title || '없음'}” · 구간 ${res.segments}개 · 효과음 ${res.sfx}개`, 'ok');
      emit('toast', { msg: 'AI가 타임라인을 세팅했습니다.', type: 'ok' });
    } catch (e) {
      status(e.message || 'AI 세팅에 실패했습니다.', 'err');
    } finally {
      busyState(false);
    }
  });

  // TTS
  $('#ttsGenAll', pane).addEventListener('click', async () => {
    const s = loadAiSettings();
    if (!s.apiKey) { status('Gemini TTS는 무료 API 키가 필요합니다. 키 없이 쓰려면 구간별 "브라우저 음성" 미리듣기나 마이크 녹음을 사용하세요.', 'err'); return; }
    const segs = (state.project.segments || []).filter((sg) => (sg.subtitle || sg.title || '').trim());
    if (!segs.length) { status('읽을 자막이 없습니다. 먼저 제목·자막을 넣어 주세요.', 'err'); return; }
    const done = new Set(voiceClips().filter((v) => v.segId).map((v) => v.segId));
    const todo = segs.filter((sg) => !done.has(sg.id));
    if (!todo.length) { status('모든 구간에 이미 음성이 있습니다. 필요한 구간만 다시 만들어 주세요.', 'warn'); return; }
    saveSettingsFromUI();
    busyState(true);
    let model = (availableModels && availableModels.tts) || s.ttsModel;
    if (!availableModels) {
      try {
        const ids = await listModels(s.apiKey);
        const picked = pickModels(ids, s);
        availableModels = picked;
        model = picked.tts || TTS_MODEL_CANDIDATES[0];
        saveAiSettings({ model: picked.text || s.model, ttsModel: model });
        renderKeyState();
      } catch (e) { /* 기본 모델로 시도 */ }
    }
    let ok = 0, fail = 0, lastErr = '';
    for (let i = 0; i < todo.length; i++) {
      const sg = todo[i];
      const text = (sg.subtitle || sg.title || '').trim();
      status(`TTS ${i + 1}/${todo.length} — ${text.slice(0, 20)}…`, 'warn');
      try {
        const { blob } = await geminiTts(text, { apiKey: s.apiKey, model, voice: $('#ttsVoice', pane).value || s.voice });
        await addVoiceClip({ blob, name: voiceAssetName(sg, 'TTS'), start: sg.start, segId: sg.id, kind: 'tts' });
        ok++;
      } catch (e) {
        fail++;
        lastErr = e.message || String(e);
        if (/API 키|한도|권한/.test(lastErr)) break;
      }
    }
    busyState(false);
    emit('project', { panels: ['audio'] });
    renderTts();
    status(`TTS 완료 — 성공 ${ok}개${fail ? ` · 실패 ${fail}개 (${lastErr})` : ''}`, fail ? 'warn' : 'ok');
    if (ok) emit('toast', { msg: `구간 음성 ${ok}개를 만들었습니다. 미리보기와 MP4에 섞입니다.`, type: 'ok' });
  });

  $('#ttsSegList', pane).addEventListener('click', onSegAction);
  $('#ttsVoiceList', pane).addEventListener('click', onVoiceAction);
  $('#ttsVoiceList', pane).addEventListener('input', (e) => {
    const id = e.target.dataset.voicevol;
    if (!id) return;
    const item = voiceClips().find((v) => v.id === id);
    if (!item) return;
    item.volume = clamp(Number(e.target.value) || 0, 0, 150);
    const label = $(`[data-voicevol-label="${id}"]`, pane);
    if (label) label.textContent = `${item.volume}%`;
    emit('save');
    emit('project', { panels: [] });
  });

  // 프로젝트 파일
  $('#projSave', pane).addEventListener('click', () => {
    try {
      const json = buildProjectJson();
      downloadBlob(new Blob([json], { type: 'application/json' }), projectFileName());
      emit('toast', { msg: '프로젝트 .json을 저장했습니다.', type: 'ok' });
    } catch (e) {
      emit('toast', { msg: '저장하지 못했습니다: ' + (e.message || e), type: 'err' });
    }
  });

  $('#projLoad', pane).addEventListener('click', () => $('#projFile', pane).click());
  $('#projFile', pane).addEventListener('change', async () => {
    const f = $('#projFile', pane).files && $('#projFile', pane).files[0];
    $('#projFile', pane).value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const res = loadProjectJson(text);
      emit('project', { panels: ['clips', 'text', 'audio', 'export', 'ai'] });
      emit('toast', { msg: `불러왔습니다 — 클립 ${res.clips}개 · 구간 ${res.segments}개${res.missingMedia ? ` (사진·영상 ${res.missingMedia}개는 이 기기에 없어 제외)` : ''}`, type: res.missingMedia ? 'warn' : 'ok' });
    } catch (e) {
      emit('toast', { msg: e.message || '불러오지 못했습니다.', type: 'err' });
    }
  });

  if (speechSupported()) {
    window.speechSynthesis.onvoiceschanged = () => {
      const sel = $('#ttsLocalVoice', pane);
      if (!sel) return;
      const list = localVoices();
      if (!list.length) return;
      const cur = sel.value;
      sel.innerHTML = list.map((v) => `<option value="${v.voiceURI}">${escapeHtml(v.name)} · ${v.lang}</option>`).join('');
      if (cur) sel.value = cur;
    };
  }
}

// ── 구간 목록 ───────────────────────────────────────────
function renderTts() {
  renderKeyState();
  renderSegList();
  renderVoiceList();
}

function renderSegList() {
  const box = $('#ttsSegList', pane);
  if (!box) return;
  const segs = state.project.segments || [];
  if (!segs.length) {
    box.innerHTML = `<div class="ai-empty">구간이 없습니다. 먼저 사진·영상을 올려 주세요.</div>`;
    return;
  }
  const voices = voiceClips();
  box.innerHTML = segs.map((sg, i) => {
    const text = (sg.subtitle || sg.title || '').trim();
    const has = voices.find((v) => v.segId === sg.id);
    return `<div class="ai-seg${text ? '' : ' dim'}" data-segid="${sg.id}">
      <div class="ai-seg-head">
        <span class="num">${i + 1}</span>
        <span class="time">${sg.start.toFixed(1)}~${sg.end.toFixed(1)}초</span>
        <span class="grow"></span>
        ${has ? `<span class="ai-badge-ok">음성 ${has.duration ? has.duration.toFixed(1) + '초' : '있음'}</span>` : ''}
      </div>
      <div class="ai-seg-text">${text ? escapeHtml(text) : '<span class="mut">자막 없음 — 탭2에서 넣어 주세요</span>'}</div>
      <div class="ai-seg-acts">
        <button class="btn tiny" data-segact="preview" data-segid="${sg.id}" type="button" title="브라우저 음성으로 읽어보기">▶ 읽기</button>
        <button class="btn tiny ghost" data-segact="tts" data-segid="${sg.id}" type="button" title="Gemini TTS로 이 구간 음성 만들기">✨ TTS</button>
        <button class="btn tiny ghost" data-segact="record" data-segid="${sg.id}" type="button" title="이 구간을 마이크로 녹음">🎙 녹음</button>
        <button class="btn tiny ghost" data-segact="file" data-segid="${sg.id}" type="button" title="외부 TTS 파일 넣기">📁 파일</button>
      </div>
    </div>`;
  }).join('');
}

function renderVoiceList() {
  const box = $('#ttsVoiceList', pane);
  if (!box) return;
  const items = voiceClips();
  const countEl = $('#ttsVoiceCount', pane);
  if (countEl) countEl.textContent = items.length ? `${items.length}개` : '';
  if (!items.length) {
    box.innerHTML = `<div class="ai-empty">아직 구간 음성이 없습니다. 위에서 TTS·녹음·파일로 넣을 수 있습니다.</div>`;
    return;
  }
  box.innerHTML = items.map((v) => {
    const seg = state.project.segments.find((s) => s.id === v.segId);
    return `<div class="ai-voice" data-voice="${v.id}">
      <button class="icon-btn sm" data-voiceact="play" data-voiceid="${v.id}" type="button" title="듣기">▶</button>
      <div class="ai-voice-meta">
        <b>${escapeHtml(v.name || '음성')}</b>
        <small>${(v.start || 0).toFixed(2)}초 · ${(v.duration || 0).toFixed(1)}초${seg ? ` · ${seg.start.toFixed(1)}~${seg.end.toFixed(1)}초 구간` : ''}</small>
      </div>
      <input type="range" data-voicevol="${v.id}" min="0" max="150" step="5" value="${v.volume ?? 100}" aria-label="볼륨">
      <span class="v" data-voicevol-label="${v.id}">${v.volume ?? 100}%</span>
      <button class="icon-btn sm" data-voiceact="del" data-voiceid="${v.id}" type="button" title="삭제">✕</button>
    </div>`;
  }).join('');
}

async function onSegAction(e) {
  const btn = e.target.closest('[data-segact]');
  if (!btn) return;
  const act = btn.dataset.segact;
  const segId = btn.dataset.segid;
  const seg = state.project.segments.find((s) => s.id === segId);
  if (!seg) return;
  const text = (seg.subtitle || seg.title || '').trim();

  if (act === 'preview') {
    if (!text) { emit('toast', { msg: '이 구간에는 자막이 없습니다.', type: 'err' }); return; }
    try {
      seek(seg.start + 0.01);
      const sel = $('#ttsLocalVoice', pane);
      await previewSpeech(text, { voiceURI: sel ? sel.value : '' });
    } catch (err) {
      emit('toast', { msg: err.message || '미리듣기에 실패했습니다.', type: 'err' });
    }
    return;
  }

  if (act === 'tts') {
    const s = loadAiSettings();
    if (!s.apiKey) { status('Gemini TTS에는 무료 API 키가 필요합니다.', 'err'); return; }
    if (!text) { emit('toast', { msg: '이 구간에는 자막이 없습니다.', type: 'err' }); return; }
    busyState(true);
    status('TTS 생성 중…', 'warn');
    try {
      let model = (availableModels && availableModels.tts) || s.ttsModel;
      if (!availableModels) {
        try {
          const ids = await listModels(s.apiKey);
          availableModels = pickModels(ids, s);
          model = availableModels.tts || TTS_MODEL_CANDIDATES[0];
          saveAiSettings({ model: availableModels.text || s.model, ttsModel: model });
        } catch (err) { /* 기본값으로 시도 */ }
      }
      const { blob } = await geminiTts(text, { apiKey: s.apiKey, model, voice: $('#ttsVoice', pane).value || s.voice });
      const old = voiceClips().find((v) => v.segId === seg.id);
      if (old) removeVoiceClip(old.id);
      await addVoiceClip({ blob, name: voiceAssetName(seg, 'TTS'), start: seg.start, segId: seg.id, kind: 'tts' });
      renderTts();
      emit('project', { panels: ['audio'] });
      status('구간 TTS를 만들었습니다.', 'ok');
    } catch (err) {
      status(err.message || 'TTS에 실패했습니다.', 'err');
    } finally {
      busyState(false);
    }
    return;
  }

  if (act === 'record') {
    if (rec && rec.segId === segId) { rec.stop(); return; }
    if (rec) { emit('toast', { msg: '다른 구간을 녹음 중입니다. 먼저 ■ 중지를 눌러 주세요.' }); return; }
    const dur = Math.max(1.2, (seg.end - seg.start) + 0.4);
    const limit = Math.min(30, Math.ceil(dur));
    try {
      stopSpeech();
      seek(seg.start + 0.01);
      const handle = await recordVoice({
        maxSeconds: limit,
        onTick: (t) => { btn.textContent = `■ 중지 ${t.toFixed(1)}s`; },
      });
      rec = { segId, stop: handle.stop, done: handle.done, btn };
      status(`🎙 녹음 중… 이 구간 자막을 읽어 주세요 (최대 ${limit}초, 끝나면 자동 종료)`, 'warn');
      btn.classList.add('danger');
      const done = await handle.done;
      rec = null;
      btn.classList.remove('danger');
      btn.textContent = '🎙 녹음';
      if (!done.blob.size) throw new Error('녹음된 소리가 없습니다.');
      const old = voiceClips().find((v) => v.segId === seg.id);
      if (old) removeVoiceClip(old.id);
      await addVoiceClip({ blob: done.blob, name: voiceAssetName(seg, '녹음'), start: seg.start, segId: seg.id, kind: 'mic' });
      renderTts();
      emit('project', { panels: ['audio'] });
      status('녹음을 이 구간에 넣었습니다.', 'ok');
      emit('toast', { msg: '녹음을 구간에 넣었습니다.', type: 'ok' });
    } catch (err) {
      rec = null;
      btn.classList.remove('danger');
      btn.textContent = '🎙 녹음';
      status(err.message || '녹음하지 못했습니다. 마이크 권한을 확인해 주세요.', 'err');
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
        const old = voiceClips().find((v) => v.segId === seg.id);
        if (old) removeVoiceClip(old.id);
        await addVoiceClip({ blob: f, name: f.name.replace(/\.[a-z0-9]+$/i, '') || voiceAssetName(seg, '음성'), start: seg.start, segId: seg.id, kind: 'file' });
        renderTts();
        emit('project', { panels: ['audio'] });
        status('외부 TTS 파일을 이 구간에 넣었습니다.', 'ok');
      } catch (err) {
        status(err.message || '파일을 넣지 못했습니다.', 'err');
      }
    });
    input.click();
    return;
  }
}

function onVoiceAction(e) {
  const btn = e.target.closest('[data-voiceact]');
  if (!btn) return;
  const id = btn.dataset.voiceid;
  if (btn.dataset.voiceact === 'del') {
    removeVoiceClip(id);
    renderTts();
    emit('project', { panels: ['audio'] });
    emit('toast', { msg: '구간 음성을 삭제했습니다.' });
    return;
  }
  if (btn.dataset.voiceact === 'play') {
    const item = voiceClips().find((v) => v.id === id);
    const asset = item && getAsset(item.assetId);
    if (!asset || !asset.url) { emit('toast', { msg: '음성 파일을 찾지 못했습니다.', type: 'err' }); return; }
    try {
      stopSpeech();
      const audio = new Audio(asset.url);
      audio.volume = clamp((item.volume ?? 100) / 100, 0, 1);
      audio.play().catch(() => emit('toast', { msg: '재생할 수 없습니다.', type: 'err' }));
    } catch (err) { /* 무시 */ }
  }
}

export function refreshAiPanel() {
  if (!pane) return;
  saveSettingsFromUI();
  renderTts();
}

// ══ 블로그 글 → 5채널 캡션 ═══════════════════════════
let capState = { url: '', body: '', captions: {} };
let capSaveTimer = null;

function capStatus(msg, type = '') {
  const box = $('#capStatus', pane);
  if (!box) return;
  box.classList.remove('hidden', 'ok', 'err', 'warn');
  if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
  if (type) box.classList.add(type);
  box.textContent = msg;
}

function initCaptions() {
  capState = loadCaptionState();
  const urlEl = $('#capUrl', pane);
  const bodyEl = $('#capBody', pane);
  if (urlEl) urlEl.value = capState.url || '';
  if (bodyEl) bodyEl.value = capState.body || '';
  renderCapMeta();
  renderCaptions();

  urlEl.addEventListener('change', () => {
    capState.url = urlEl.value.trim();
    saveCaptionState({ url: capState.url });
  });
  bodyEl.addEventListener('input', () => {
    capState.body = bodyEl.value;
    renderCapMeta();
    clearTimeout(capSaveTimer);
    capSaveTimer = setTimeout(() => saveCaptionState({ body: capState.body }), 600);
  });

  $('#capFetch', pane).addEventListener('click', fetchBlogInto);
  $('#capCopyPrompt', pane).addEventListener('click', async () => {
    const body = ($('#capBody', pane).value || '').trim();
    if (!body) { capStatus('본문을 먼저 붙여넣어 주세요.', 'err'); return; }
    const text = buildCaptionPrompt(body, { url: ($('#capUrl', pane).value || '').trim() });
    const ok = await copyPlain(text);
    capStatus(ok ? '프롬프트를 복사했습니다. 무료 ChatGPT·Gemini 채팅에 붙여넣고, 받은 결과를 아래 칸에 붙여넣으세요.' : '복사가 막혔습니다. [보기]를 눌러 직접 복사해 주세요.', ok ? 'ok' : 'warn');
  });
  $('#capShowPrompt', pane).addEventListener('click', () => {
    const ta = $('#capPromptText', pane);
    if (ta.classList.contains('hidden')) {
      const body = ($('#capBody', pane).value || '').trim();
      if (!body) { capStatus('본문을 먼저 붙여넣어 주세요.', 'err'); return; }
      ta.value = buildCaptionPrompt(body, { url: ($('#capUrl', pane).value || '').trim() });
      ta.classList.remove('hidden');
    } else {
      ta.classList.add('hidden');
    }
  });
  $('#capFromPaste', pane).addEventListener('click', () => {
    const raw = ($('#capPaste', pane).value || '').trim();
    if (!raw) { capStatus('AI가 준 결과를 먼저 붙여넣어 주세요.', 'err'); return; }
    try {
      const caps = parseCaptions(raw);
      mergeCaptions(caps);
      const n = CAPTION_CHANNELS.filter((c) => (caps[c.id] || '').trim()).length;
      capStatus(`${n}개 채널 캡션을 채웠습니다. 각 칸에서 바로 수정하고 📋 복사하세요.`, 'ok');
    } catch (e) {
      capStatus(e.message || '결과를 나누지 못했습니다.', 'err');
    }
  });
  $('#capGenerate', pane).addEventListener('click', generateCaptions);

  const out = $('#capOut', pane);
  out.addEventListener('input', (e) => {
    const id = e.target.dataset.captext;
    if (!id) return;
    capState.captions[id] = e.target.value;
    clearTimeout(capSaveTimer);
    capSaveTimer = setTimeout(() => saveCaptionState({ captions: capState.captions }), 500);
    updateCapFoot(id);
  });
  out.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-capcopy]');
    if (!btn) return;
    const id = btn.dataset.capcopy;
    const ta = out.querySelector(`[data-captext="${id}"]`);
    const text = ta ? ta.value : '';
    if (!text.trim()) { capStatus('이 채널 캡션이 비었습니다.', 'err'); return; }
    const ok = await copyPlain(text);
    capStatus(ok ? `${CAPTION_CHANNELS.find((c) => c.id === id)?.label || ''} 캡션을 복사했습니다.` : '복사가 막혔습니다. 칸을 눌러 직접 복사해 주세요.', ok ? 'ok' : 'warn');
  });
}

function renderCapMeta() {
  const el = $('#capMeta', pane);
  if (!el) return;
  const len = (($('#capBody', pane)?.value) || '').length;
  if (!len) { el.textContent = ''; el.classList.remove('warn'); return; }
  el.textContent = `본문 ${len.toLocaleString()}자 ${len > 9000 ? '· 긴 글은 앞부분 9,000자까지만 씁니다' : ''}`;
  el.classList.toggle('warn', len > 9000);
}

function renderCaptions() {
  const out = $('#capOut', pane);
  if (!out) return;
  out.innerHTML = CAPTION_CHANNELS.map((ch) => {
    const text = capState.captions[ch.id] || '';
    return `<div class="cap-card" data-capcard="${ch.id}">
      <div class="cap-head">
        <b>${ch.icon} ${ch.label}</b>
        <span class="grow"></span>
        <button class="btn tiny" data-capcopy="${ch.id}" type="button">📋 복사</button>
      </div>
      <div class="cap-hint">${escapeHtml(ch.hint)}</div>
      <textarea class="cap-text" data-captext="${ch.id}" rows="4" placeholder="아직 캡션이 없습니다. 위에서 만들거나 결과를 붙여넣으면 채워집니다.">${escapeHtml(text)}</textarea>
      <div class="cap-foot"><span data-capcount="${ch.id}"></span><span data-capwarn="${ch.id}"></span></div>
    </div>`;
  }).join('');
  for (const ch of CAPTION_CHANNELS) updateCapFoot(ch.id);
}

function updateCapFoot(id) {
  const out = $('#capOut', pane);
  if (!out) return;
  const ta = out.querySelector(`[data-captext="${id}"]`);
  const count = out.querySelector(`[data-capcount="${id}"]`);
  const warn = out.querySelector(`[data-capwarn="${id}"]`);
  const text = ta ? ta.value : '';
  if (count) count.textContent = text.trim() ? `${text.trim().length}자` : '';
  if (warn) {
    if (id === 'naverClip' && text.trim()) {
      const c = checkNaverClipCaption(text);
      warn.textContent = c.ok ? `해시태그 ${c.tags}개 ✓` : `해시태그 ${c.tags}개 — #오늘클립챌린지 #클립크리에이터 + 연관 3개(총 5개) 권장`;
      warn.className = c.ok ? 'ok' : 'warn';
    } else {
      warn.textContent = '';
      warn.className = '';
    }
  }
}

function mergeCaptions(caps) {
  for (const ch of CAPTION_CHANNELS) {
    const v = (caps[ch.id] || '').trim();
    if (v) capState.captions[ch.id] = v;
  }
  saveCaptionState({ captions: capState.captions });
  renderCaptions();
}

async function fetchBlogInto() {
  if (capBusy) return;
  const input = $('#capUrl', pane).value;
  const url = normalizeBlogUrl(input);
  if (!url) { capStatus('블로그 주소를 먼저 입력해 주세요.', 'err'); return; }
  $('#capUrl', pane).value = url;
  capState.url = url;
  const btn = $('#capFetch', pane);
  capBusy = true;
  btn.disabled = true;
  btn.textContent = '가져오는 중…';
  capStatus('본문을 가져오는 중… (최대 20초)', 'warn');
  try {
    const { text, via } = await fetchBlogText(url);
    const ta = $('#capBody', pane);
    ta.value = text;
    capState.body = text;
    saveCaptionState({ body: text, url });
    renderCapMeta();
    capStatus(`본문을 가져왔습니다 (${via} · ${text.length.toLocaleString()}자). 아래에서 캡션을 만들어 주세요.`, 'ok');
  } catch (e) {
    capStatus(`${e.message}${e.detail ? `  [시도: ${e.detail}]` : ''}`, 'err');
    $('#capBody', pane).focus();
  } finally {
    capBusy = false;
    btn.disabled = false;
    btn.textContent = '가져오기 시도';
  }
}

async function generateCaptions() {
  const s = loadAiSettings();
  const body = ($('#capBody', pane).value || '').trim();
  if (!body) { capStatus('블로그 본문을 먼저 넣어 주세요. (URL 가져오기 또는 붙여넣기)', 'err'); return; }
  if (body.length < 40) { capStatus('본문이 너무 짧습니다. 글 전체를 붙여넣어 주세요.', 'err'); return; }
  if (!s.apiKey) {
    capStatus('Gemini로 만들려면 무료 API 키가 필요합니다. 키가 없다면 위의 “📋 프롬프트 복사”로 무료 ChatGPT·Gemini 채팅을 쓰세요.', 'err');
    return;
  }
  const btn = $('#capGenerate', pane);
  if (capBusy) return;
  capBusy = true;
  btn.disabled = true;
  let model = (availableModels && availableModels.text) || s.model;
  try {
    if (!availableModels) {
      try {
        const ids = await listModels(s.apiKey);
        availableModels = pickModels(ids, s);
        model = availableModels.text || model;
        saveAiSettings({ model });
        renderKeyState();
      } catch (e) { /* 기본 모델로 시도 */ }
    }
    capStatus(`Gemini(${model})가 5채널 캡션을 만드는 중… (10~30초)`, 'warn');
    const raw = await askGeminiText({
      apiKey: s.apiKey,
      model,
      prompt: buildCaptionPrompt(body, { url: ($('#capUrl', pane).value || '').trim() }),
    });
    const caps = parseCaptions(raw);
    mergeCaptions(caps);
    const n = CAPTION_CHANNELS.filter((c) => (caps[c.id] || '').trim()).length;
    capStatus(`5채널 캡션 준비 완료 — ${n}개 채널. 각 칸에서 고치고 📋 복사하세요.`, n === 5 ? 'ok' : 'warn');
    const nu = $('#capUrl', pane).value.trim();
    if (nu) saveCaptionState({ url: nu });
  } catch (e) {
    capStatus(e.message || '캡션을 만들지 못했습니다.', 'err');
  } finally {
    capBusy = false;
    btn.disabled = false;
  }
}

async function copyPlain(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) { return false; }
  }
}
