// panels/ai.js — 탭5: AI 자동 세팅 (원클릭 · 프롬프트 복사/붙여넣기 · Gemini · TTS · 프로젝트 파일)
import { $, $$, clamp, emit, escapeHtml, fmtSec, downloadBlob, uid } from '../util.js';
import { state, totalDuration, persist, getAsset, ensureSegments, mixDirty } from '../state.js';
import {
  loadAiSettings, saveAiSettings, maskKey, listModels, pickModels,
  buildChatPrompt, buildPrompt, collectFrames, askGemini, askGeminiText, parsePlan, applyPlan,
  autoLayout, applyDesignSet, VOICES, TTS_MODEL_CANDIDATES, TEXT_MODEL_CANDIDATES, subtitleStats,
} from '../ai.js';
import {
  CAPTION_CHANNELS, loadCaptionState, saveCaptionState, fetchBlogText,
  buildCaptionPrompt, parseCaptions, checkNaverClipCaption, normalizeBlogUrl,
  buildLocalCaptions, extractKeywords, pickInfoLines,
} from '../captions.js';
import { loadBlogStore, loadBlogIntoProject } from '../blogflow.js';
import { cardsFromImages, cardsFromTimeline, saveCarousel } from '../carousel.js';
import { reloadCarouselFromProject } from './export.js';
import { makeClip } from '../media.js';
import { DESIGN_SETS } from '../presets.js';
import { DEFAULT_COPY } from '../formula.js';
import {
  geminiTts, addVoiceClip, removeVoiceClip, voiceClips, previewSpeech, stopSpeech,
  localVoices, speechSupported, recordVoice, voiceAssetName,
  pruneVoiceClips, voiceLayoutNow, voiceTimingText,
} from '../tts.js';
import { planSummary } from '../voicelayout.js';
import { forgetAsset } from '../assets.js';
import { buildProjectJson, loadProjectJson, projectFileName } from '../project-io.js';
import { seek } from '../player.js';

let pane = null;
let rec = null;
let busy = false;
let capBusy = false;
let auditionAudio = null; // 구간 음성 '듣기'는 한 번에 하나만

/** 구간 음성 미리듣기 정지 */
function stopAudition() {
  if (!auditionAudio) return;
  try { auditionAudio.pause(); } catch (e) { /* 무시 */ }
  auditionAudio = null;
}
let availableModels = null; // { ids, text, tts }

export function initAiPanel(el) {
  pane = el;
  const s = loadAiSettings();
  const local = localVoices();

  pane.innerHTML = `
    <div class="ai-hero" id="aiHero">
      <b>✨ AI 자동 세팅</b>
      <p>사진·영상을 올린 뒤 한 번만 누르면 <b>컷·모션·전환·디자인·효과음·마지막 멘트</b>가 자동으로 배치됩니다.
      아래 <b>무료 원클릭</b>은 키가 필요 없고, <b>Gemini</b>는 무료 API 키를 넣으면 사진을 읽고 제목·자막까지 만들어 줍니다.</p>
    </div>

    <div class="sec" data-sec="blog">
      <div class="sec-head">📥 블로그 URL 하나로 끝내기 <span class="count">릴스 · 캐러셀 · 5채널 캡션</span></div>
      <div class="card ai-card blog-hub">
        <div class="row">
          <label>블로그 URL</label>
          <input type="text" class="grow" id="blogUrl" placeholder="https://blog.naver.com/rkwhr83/224491139890" spellcheck="false" autocomplete="off">
          <button class="btn tiny" id="blogLoad" type="button">불러오기</button>
        </div>
        <div class="sec-note" style="margin:6px 0 7px">
          네이버 블로그 주소를 넣으면 <b>글 제목 · 본문 · 사진</b>을 가져와 <b>릴스 컷</b>과 <b>캐러셀 카드</b>, <b>5채널 캡션</b>까지 한 번에 만듭니다.
          사진은 프록시를 거쳐 이 브라우저로만 받아 오기 때문에 내보내기(Canvas)에서 CORS 오류가 나지 않습니다.
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <label style="flex:0 0 auto">사진 길이</label>
          <select id="blogImageDur" style="flex:1 1 90px">
            <option value="2.2">2.2초</option>
            <option value="2.6" selected>2.6초</option>
            <option value="3.2">3.2초</option>
          </select>
          <label style="flex:0 0 auto">총 길이</label>
          <select id="blogTotal" style="flex:1 1 80px">
            <option value="15">15초</option>
            <option value="18" selected>18초</option>
            <option value="20">20초</option>
          </select>
          <label style="flex:0 0 auto">카드</label>
          <select id="blogCarCount" style="flex:1 1 80px">
            <option value="4">4장</option>
            <option value="5" selected>5장</option>
            <option value="6">6장</option>
            <option value="8">8장</option>
            <option value="10">10장</option>
            <option value="0">전체</option>
          </select>
        </div>
        <div class="row"><label style="flex:0 0 auto">사진 수</label>
          <select id="blogMax" style="flex:1 1 80px">
            <option value="0" selected>전체</option>
            <option value="4">4장</option>
            <option value="6">6장</option>
            <option value="8">8장</option>
            <option value="10">10장</option>
            <option value="12">12장</option>
          </select>
          <label class="switch" style="flex:0 0 auto;margin-left:auto"><input type="checkbox" id="blogReplace" checked> 기존 컷 새로 만들기</label>
        </div>
        <div class="ai-status hidden" id="blogStatus"></div>
        <div class="blog-info hidden" id="blogInfo"></div>
        <div class="row blog-actions" style="gap:6px">
          <button class="btn primary grow" id="blogMakeReel" type="button">⚡ 릴스 만들기</button>
          <button class="btn grow" id="blogMakeCarousel" type="button">🖼 캐러셀</button>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn primary block" id="blogMakeAll" type="button">⚡ 둘 다 만들기 (릴스 + 캐러셀 + 캡션)</button>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn sm ghost grow" id="blogGoExport" type="button">4번 내보내기에서 카드 고치기 →</button>
        </div>
        <div class="sec-note" style="margin:6px 0 0">
          컷·자막은 본문과 사진 설명에서 뽑아 만들고, Gemini 키가 저장돼 있으면 사진을 읽어 더 맞는 자막으로 다듬습니다.
          나레이션은 아래 TTS 설정대로 자막과 1:1로 다시 만들어집니다.
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sec-head">📝 5채널 캡션 확인·수정 <span class="count">클립·인스타·유튜브·페이스북·스레드</span></div>
      <div class="card ai-card">
        <div class="row">
          <label>블로그 URL</label>
          <input type="text" class="grow" id="capUrl" placeholder="https://blog.naver.com/… (선택)" spellcheck="false" autocomplete="off">
          <button class="btn tiny" id="capFetch" type="button">가져오기 시도</button>
        </div>
        <div class="sec-note" style="margin:6px 0 7px">
          위 <b>📥 블로그 URL</b>에서 불러오면 이 칸이 자동으로 채워집니다. 본문을 직접 붙여넣어도 됩니다.
          (URL만 무료 텍스트 추출 서비스로 전달되고, 사진·본문은 이 브라우저 안에서만 처리됩니다.)
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

    <div class="sec" data-sec="oneclick">
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
        <div class="row">
          <label>자막 호흡</label>
          <select class="grow" id="aiTempo">
            <option value="steady">여유 (2~3초에 한 줄)</option>
            <option value="ref">레퍼런스 (1.2~1.8초에 한 줄)</option>
          </select>
        </div>
        <div class="row" style="gap:8px;align-items:flex-start">
          <label>카피 틀</label>
          <div class="grow">
            <textarea id="aiCopyLines" class="ai-textarea" rows="5" placeholder="한 줄에 하나씩. {t}는 주제·프로젝트 이름으로 바뀝니다. 비우면 기본 틀(문제 제기 → 전환 → 해결 → 정보 → CTA)을 씁니다."></textarea>
            <div class="row" style="gap:6px;margin-top:5px">
              <button class="btn tiny ghost" id="aiCopyDefault" type="button">기본 틀 넣기</button>
              <button class="btn tiny ghost" id="aiCopyClear" type="button">비우기</button>
            </div>
          </div>
        </div>
        <div class="sec-note" style="margin:0 0 7px">
          레퍼런스 릴스 2편(@home_tembbly·@homterior_pick) 공식: <b>문제 제기 → “~하지 마세요” → 전환 → 기능(동작→결과) → 정보 → CTA → 엔드카드 2줄</b>.
          한 자막 4~14자, 해요체 구어체, 1컷만 상단 후킹·2컷부터는 하단 세이프존에 놓입니다.
        </div>
        <button class="btn primary block ai-big" id="aiOneClick" type="button">⚡ 원클릭 자동 배치</button>
        <div class="sec-note" id="aiOneClickNote" style="margin:6px 0 0">지금 타임라인의 구간·효과음을 새로 배치합니다. 자막 글자는 유지되지 않으니, 글자를 이미 썼다면 먼저 <b>💾 프로젝트 저장</b>을 해 두세요.</div>
      </div>
    </div>

    <div class="sec" data-sec="prompt">
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

    <div class="sec" data-sec="gemini">
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
        <div class="row" style="gap:8px">
          <label class="switch"><input type="checkbox" id="aiAutoTts" checked> 🎙 나레이션까지 자동 생성</label>
          <span class="grow"></span>
          <span class="ai-key-state" id="aiAutoTtsNote" style="font-size:10px"></span>
        </div>
        <div class="row">
          <label>모델</label>
          <span class="ai-model grow" id="aiModelInfo">연결 확인을 누르면 모델을 확인합니다</span>
        </div>
        <button class="btn primary block ai-big" id="aiGenerate" type="button">✨ AI로 제목·자막·효과음 세팅</button>
        <div class="sec-note" style="margin:6px 0 0">
          키는 이 브라우저(localStorage)에만 저장되고 서버로 보내지 않습니다. 사진·영상 프레임은 Gemini에 전송됩니다(무료 한도 내).
          나레이션까지 켜 두면 자막과 <b>1:1 같은 글·같은 시간</b>으로 Gemini TTS를 만들어 영상에 섞습니다(구간당 2~5초 걸립니다).
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
        <div class="sec-note" style="margin:6px 0 0">
          목소리는 위에서 고른 <b>한 가지로 전부</b> 만들고, 다시 만들면 그 구간의 옛 음성은 남기지 않습니다.<br>
          음성이 자막 구간보다 길면 <b>겹쳐 들리지 않게</b> 자동으로 최대 1.35배속·시작 시각을 맞춥니다(미리듣기·MP4 동일).
        </div>
        <div class="ai-warn hidden" id="ttsStaleNote" style="margin-top:8px"></div>
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
  $('#aiTempo', pane).value = s.tempo || 'steady';
  $('#aiCopyLines', pane).value = s.copyLines || '';
  $('#aiUseSfx', pane).checked = s.useSfx !== false;
  $('#aiUseName', pane).checked = s.useName !== false;
  $('#aiTopic', pane).value = s.topic || '';
  $('#ttsVoice', pane).value = s.voice || 'Kore';
  if ($('#aiAutoTts', pane)) $('#aiAutoTts', pane).checked = s.ttsAuto !== false;

  bindEvents();
  initCaptions();
  initBlogHub();
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
    tempo: $('#aiTempo', pane).value || 'steady',
    copyLines: $('#aiCopyLines', pane).value || '',
    useSfx: $('#aiUseSfx', pane).checked,
    useName: $('#aiUseName', pane).checked,
    topic: $('#aiTopic', pane).value.trim(),
    voice: $('#ttsVoice', pane).value,
    ttsAuto: $('#aiAutoTts', pane) ? $('#aiAutoTts', pane).checked : true,
  });
}

/**
 * Gemini 키가 저장되어 있으면 '✨ Gemini로 자동 세팅' 카드를 원클릭보다 위로 올려
 * 키 없는 원클릭을 헷갈려 누르는 일이 없게 합니다.
 */
let keyOrdered = null;
function orderSectionsFor(keyReady) {
  const gemini = pane.querySelector('[data-sec="gemini"]');
  const oneclick = pane.querySelector('[data-sec="oneclick"]');
  const prompt = pane.querySelector('[data-sec="prompt"]');
  if (!gemini || !oneclick) return;
  gemini.classList.toggle('ai-priority', !!keyReady);
  oneclick.classList.toggle('ai-secondary', !!keyReady);
  if (keyOrdered === !!keyReady) return;
  keyOrdered = !!keyReady;
  if (keyReady) {
    // ✨ Gemini 카드는 블로그 URL 카드 바로 아래로 (블로그 URL이 항상 맨 위)
    const blogSec = pane.querySelector('[data-sec="blog"]');
    if (blogSec && blogSec.nextSibling) pane.insertBefore(gemini, blogSec.nextSibling);
    else if (blogSec) pane.appendChild(gemini);
  } else if (prompt && prompt.parentNode === gemini.parentNode) {
    prompt.parentNode.insertBefore(gemini, prompt.nextSibling);
  }
  const hero = $('#aiHero', pane);
  if (hero) {
    hero.innerHTML = keyReady
      ? `<b>✨ AI 자동 세팅</b>
         <p><b class="ai-hero-key">Gemini 키가 연결돼 있습니다.</b> 사진을 읽고 제목·자막·나레이션까지 만들어 주는 <b>✨ Gemini로 자동 세팅</b>을 먼저 쓰세요.
         키 없이 빠르게 컷만 배치하려면 <b>⚡ 무료 원클릭</b>을 쓰면 됩니다(아래로 내려가 있습니다).</p>`
      : `<b>✨ AI 자동 세팅</b>
         <p>사진·영상을 올린 뒤 한 번만 누르면 <b>컷·모션·전환·디자인·효과음·마지막 멘트</b>가 자동으로 배치됩니다.
         아래 <b>무료 원클릭</b>은 키가 필요 없고, <b>Gemini</b>는 무료 API 키를 넣으면 사진을 읽고 제목·자막까지 만들어 줍니다.</p>`;
  }
  const note = $('#aiOneClickNote', pane);
  if (note) {
    note.innerHTML = keyReady
      ? '키 없이 쓰는 기본 배치입니다. <b>Gemini 키가 있으니 위 ✨ Gemini로 자동 세팅을 먼저 쓰세요.</b> 그래도 컷만 빠르게 잡고 싶을 때 이 버튼을 씁니다.'
      : '지금 타임라인의 구간·효과음을 새로 배치합니다. 자막 글자는 유지되지 않으니, 글자를 이미 썼다면 먼저 <b>💾 프로젝트 저장</b>을 해 두세요.';
  }
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
  // 키가 있으면 Gemini 카드를 맨 위로 올리고 강조
  orderSectionsFor(keyReady());
  const autoTts = $('#aiAutoTts', pane);
  if (autoTts) autoTts.disabled = !keyReady();
  const autoNote = $('#aiAutoTtsNote', pane);
  if (autoNote) autoNote.textContent = keyReady() ? '자막과 1:1로 나레이션 생성' : '키를 넣으면 켜집니다';
}

/** 키가 저장돼 있으면 Gemini 기능을 '준비됨'으로 봅니다. */
function keyReady() {
  return !!loadAiSettings().apiKey;
}

// ── 자막 ↔ 나레이션 동기화 ─────────────────────────────
function narrationText(sg) {
  return String((sg && (sg.subtitle || sg.title || sg.badge)) || '').trim();
}

const segTime = (sg) => (sg ? `${sg.start.toFixed(1)}~${sg.end.toFixed(1)}초` : '');

/**
 * 자막(segments)이 새로 만들어지면 옛 나레이션을 먼저 비웁니다.
 *  · 구간(segId)에 묶인 옛 음성은 새 구간에 없으면 지웁니다
 *    (4초 나레이션이 13초 자막과 따로 놀던 문제).
 *  · all=true면 구간이 안 묶인 나레이션까지 모두 비웁니다.
 */
function purgeOldNarration({ all = false } = {}) {
  const segIds = new Set((state.project.segments || []).map((s) => s.id));
  const drop = voiceClips().slice().filter((v) => all || (v.segId && !segIds.has(v.segId)));
  for (const v of drop) {
    removeVoiceClip(v.id);
    const aid = v.assetId;
    const stillUsed = voiceClips().some((x) => x.assetId === aid)
      || (state.project.audio.narration && state.project.audio.narration.assetId === aid)
      || (state.project.audio.bgm && state.project.audio.bgm.assetId === aid);
    if (aid && !stillUsed) forgetAsset(aid).catch(() => {});
  }
  return drop.length;
}

/** 자막 각각과 1:1(같은 글·같은 시작 시간)로 나레이션을 만듭니다. */
async function narrateSegments() {
  const s = loadAiSettings();
  if (!s.apiKey) return { ok: 0, fail: 0, skipped: 'key' };
  const segs = (state.project.segments || []).filter((sg) => narrationText(sg));
  if (!segs.length) return { ok: 0, fail: 0, skipped: 'empty' };
  // 이 배치 전체를 한 목소리로 고정합니다.
  const voice = ($('#ttsVoice', pane) && $('#ttsVoice', pane).value) || s.voice || 'Kore';
  saveAiSettings({ voice });
  let model = (availableModels && availableModels.tts) || s.ttsModel;
  if (!availableModels) {
    try {
      const ids = await listModels(s.apiKey);
      const picked = pickModels(ids, s);
      availableModels = picked;
      model = picked.tts || TTS_MODEL_CANDIDATES[0];
      saveAiSettings({ model: picked.text || s.model, ttsModel: model });
    } catch (e) { /* 기본 모델로 시도 */ }
  }
  const pruned = pruneVoiceClips();
  const done = new Set(voiceClips().filter((v) => v.segId).map((v) => v.segId));
  const todo = segs.filter((sg) => !done.has(sg.id));
  let ok = 0, fail = 0, lastErr = '';
  for (let i = 0; i < todo.length; i++) {
    const sg = todo[i];
    const text = narrationText(sg);
    status(`나레이션 ${i + 1}/${todo.length} — ${text.slice(0, 20)}… (${segTime(sg)}부터, 자막과 1:1)`, 'warn');
    try {
      const { blob } = await geminiTts(text, { apiKey: s.apiKey, model, voice });
      voiceClips().filter((v) => v.segId === sg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
      await addVoiceClip({ blob, name: voiceAssetName(sg, 'TTS'), start: sg.start, segId: sg.id, kind: 'tts', voiceName: voice });
      ok++;
    } catch (e) {
      fail++;
      lastErr = e.message || String(e);
      if (/API 키|한도|권한/.test(lastErr)) break;
    }
  }
  pruneVoiceClips();
  emit('project', { panels: ['audio', 'ai'] });
  renderTts();
  return { ok, fail, lastErr, total: todo.length, pruned };
}

/**
 * 자동 배치·붙여넣기·Gemini 세팅 직후 공통 처리:
 *  ① 옛 나레이션을 비우고 ② (TTS 자동이 켜져 있으면) 자막과 1:1로 다시 만듭니다.
 */
async function syncNarrationAfterLayout() {
  // 타임라인을 통째로 다시 만드는 작업이라, 옛 나레이션은 구간에 안 묶인 것까지 모두 비웁니다.
  const removed = purgeOldNarration({ all: true });
  const s = loadAiSettings();
  if (s.ttsAuto === false) {
    if (removed) emit('toast', { msg: `옛 나레이션 ${removed}개를 비웠습니다(자막과 따로 놀지 않게).`, type: 'warn' });
    return { removed, ok: 0, fail: 0, off: true };
  }
  if (!s.apiKey) {
    if (removed) emit('toast', { msg: `옛 나레이션 ${removed}개를 비웠습니다. 키를 넣으면 자막과 1:1로 다시 만들어 집니다.`, type: 'warn' });
    return { removed, ok: 0, fail: 0, noKey: true };
  }
  busyState(true);
  let r = { ok: 0, fail: 0, total: 0 };
  try {
    r = await narrateSegments();
  } finally {
    busyState(false);
  }
  if (r.ok || r.fail) {
    status(`나레이션 ${r.ok}개를 자막과 1:1로 새로 만들었습니다${r.fail ? ` · 실패 ${r.fail}개${r.lastErr ? ` (${r.lastErr})` : ''}` : ''}`, r.fail ? 'warn' : 'ok');
    emit('toast', { msg: r.fail ? `나레이션 ${r.ok}개 완료 · ${r.fail}개 실패` : `나레이션 ${r.ok}개를 자막과 똑같이 다시 만들었습니다.`, type: r.fail ? 'warn' : 'ok' });
  }
  return { removed, ...r };
}

function bindEvents() {
  // 설정 변경 저장
  ['aiDesignSel', 'aiImageDur', 'aiTempo', 'aiCopyLines', 'aiUseSfx', 'aiUseName', 'aiTopic', 'ttsVoice', 'aiAutoTts'].forEach((id) => {
    const el = $(`#${id}`, pane);
    if (!el) return;
    el.addEventListener('change', saveSettingsFromUI);
    if (el.tagName === 'INPUT' && el.type === 'text') el.addEventListener('blur', saveSettingsFromUI);
    if (el.tagName === 'TEXTAREA') el.addEventListener('blur', saveSettingsFromUI);
  });

  $('#aiOneClick', pane).addEventListener('click', async () => {
    saveSettingsFromUI();
    const s = loadAiSettings();
    const hasText = (state.project.segments || []).some((sg) => (sg.title || sg.badge || sg.subtitle || '').trim());
    if (hasText && !window.confirm('기존 구간·자막·효과음이 새로 배치됩니다(지금 쓴 글자는 사라집니다). 계속할까요?\n\n글자를 지키려면 [취소] 후 💾 .json 저장을 먼저 해 두세요.')) return;
    try {
      const res = autoLayout({ design: s.design, imageDur: s.imageDur, useSfx: s.useSfx, useName: s.useName, tempo: s.tempo, copyLines: s.copyLines });
      emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
      const sub = res.subtitles || {};
      const subTxt = sub.count ? ` · 자막 ${sub.count}개(0~${res.duration}초, 가장 큰 빈 구간 ${sub.maxGap}초)` : '';
      emit('toast', { msg: `원클릭 배치 완료 — 컷 ${res.clips}개 · 구간 ${res.segments}개${subTxt} · 효과음 ${res.sfx}개 · ${res.design}`, type: 'ok' });
      status(`원클릭 배치 완료 — 제목 “${res.title || '없음'}” · 구간 ${res.segments}개, 자막 ${sub.count || 0}개가 0~${res.duration}초를 ${sub.maxGap > 0.4 ? `(가장 큰 빈 구간 ${sub.maxGap}초)` : '빈틈없이'} 덮습니다.`, 'ok');
      await syncNarrationAfterLayout();
    } catch (e) {
      emit('toast', { msg: e.message || '자동 배치에 실패했습니다.', type: 'err' });
    }
  });

  $('#aiCopyDefault', pane).addEventListener('click', () => {
    $('#aiCopyLines', pane).value = DEFAULT_COPY.join('\n');
    saveSettingsFromUI();
    emit('toast', { msg: '레퍼런스 공식 기본 카피 틀을 넣었습니다. 문장은 자유롭게 고치세요.', type: 'ok' });
  });

  $('#aiCopyClear', pane).addEventListener('click', () => {
    $('#aiCopyLines', pane).value = '';
    saveSettingsFromUI();
    emit('toast', { msg: '카피 틀을 비웠습니다(비우면 기본 틀을 씁니다).' });
  });

  // 프롬프트
  $('#aiCopyPrompt', pane).addEventListener('click', async () => {
    saveSettingsFromUI();
    const text = buildChatPrompt($('#aiTopic', pane).value.trim(), loadAiSettings().tempo);
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
      ta.value = buildChatPrompt($('#aiTopic', pane).value.trim(), loadAiSettings().tempo);
      ta.classList.remove('hidden');
    } else {
      ta.classList.add('hidden');
    }
  });

  $('#aiApplyPaste', pane).addEventListener('click', async () => {
    const text = $('#aiPaste', pane).value.trim();
    if (!text) { emit('toast', { msg: 'AI가 준 JSON을 먼저 붙여넣어 주세요.', type: 'err' }); return; }
    try {
      const plan = parsePlan(text);
      const res = applyPlan(plan);
      emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
      status(`붙여넣기 적용 완료 — 제목 “${res.title || '없음'}” · 구간 ${res.segments}개(자막 ${res.subtitles ? res.subtitles.count : 0}개) · 효과음 ${res.sfx}개`, 'ok');
      emit('toast', { msg: `자동 채우기 완료 (구간 ${res.segments}개)`, type: 'ok' });
      await syncNarrationAfterLayout();
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
      const frames = await collectFrames(12);
      if (!frames.length) throw new Error('사진·영상 프레임을 읽지 못했습니다. 파일을 다시 올려 주세요.');
      const videos = new Set(frames.filter((f) => /^영상/.test(f.label || '')).map((f) => (f.label || '').split(' ')[1])).size;
      status(`Gemini(${model})가 프레임 ${frames.length}장${videos ? `(영상 ${videos}개 × 2~3프레임)` : ''}을 보고 세팅을 만드는 중… (10~30초)`, 'warn');
      const { plan } = await askGemini({ apiKey: s.apiKey, model, prompt: buildPrompt($('#aiTopic', pane).value.trim(), s.tempo), frames });
      const res = applyPlan(plan);
      emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
      status(`AI 세팅 완료 — 제목 “${res.title || '없음'}” · 구간 ${res.segments}개(자막 ${res.subtitles ? res.subtitles.count : 0}개) · 효과음 ${res.sfx}개`, 'ok');
      emit('toast', { msg: 'AI가 타임라인을 세팅했습니다.', type: 'ok' });
      await syncNarrationAfterLayout();
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
    saveSettingsFromUI();
    const settings = loadAiSettings();
    // 목소리는 이 배치 전체에서 하나로 고정합니다(중간에 바뀌어 2~3가지 목소리가 섞이는 일 방지).
    const voice = ($('#ttsVoice', pane) && $('#ttsVoice', pane).value) || settings.voice || 'Kore';
    saveAiSettings({ voice });
    // 옛 구간·중복 음성을 먼저 정리합니다(겹침·중복 재생의 원인).
    const pruned = pruneVoiceClips();
    const done = new Set(voiceClips().filter((v) => v.segId).map((v) => v.segId));
    let todo = segs.filter((sg) => !done.has(sg.id));
    if (!todo.length) {
      const redo = window.confirm('모든 구간에 이미 음성이 있습니다.\n\n같은 목소리로 전부 새로 만들까요? [확인] 기존 음성을 지우고 다시 만듭니다.');
      if (!redo) { status('그대로 두었습니다. 필요한 구간만 ✨ TTS로 다시 만들 수 있습니다.', 'warn'); return; }
      todo = segs.slice();
    }
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
      status(`TTS ${i + 1}/${todo.length} — ${text.slice(0, 20)}… (${segTime(sg)} · 겹침 없이 배치)`, 'warn');
      try {
        const { blob } = await geminiTts(text, { apiKey: s.apiKey, model, voice });
        // 같은 구간의 옛 음성은 남김없이 지우고 새로 넣습니다(중복 잔여 금지).
        voiceClips().filter((v) => v.segId === sg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
        await addVoiceClip({ blob, name: voiceAssetName(sg, 'TTS'), start: sg.start, segId: sg.id, kind: 'tts', voiceName: voice });
        ok++;
      } catch (e) {
        fail++;
        lastErr = e.message || String(e);
        if (/API 키|한도|권한/.test(lastErr)) break;
      }
    }
    busyState(false);
    pruneVoiceClips();
    emit('project', { panels: ['audio'] });
    renderTts();
    const sum = planSummary(voiceLayoutNow(), totalDuration());
    const layNote = sum.count ? ` · 겹침 ${sum.overlaps}건${sum.sped ? ` · 자동 배속 ${sum.sped}개` : ''}` : '';
    status(`TTS 완료 — 성공 ${ok}개${pruned ? ` · 옛 음성 ${pruned}개 정리` : ''}${fail ? ` · 실패 ${fail}개 (${lastErr})` : ''}${layNote}`, fail ? 'warn' : 'ok');
    if (ok) emit('toast', { msg: `${voice} 목소리로 구간 음성 ${ok}개를 만들었습니다${sum.sped ? ` (겹치지 않게 ${sum.sped}개 자동 배속)` : ''}. 미리보기와 MP4에 섞입니다.`, type: 'ok' });
  });

  $('#ttsSegList', pane).addEventListener('click', onSegAction);
  $('#ttsVoiceList', pane).addEventListener('click', onVoiceAction);
  window.addEventListener('reels:audition-stop', stopAudition);
  const staleBox = $('#ttsStaleNote', pane);
  if (staleBox) staleBox.addEventListener('click', onVoiceAction);
  $('#ttsVoiceList', pane).addEventListener('input', (e) => {
    const id = e.target.dataset.voicevol;
    if (!id) return;
    const item = voiceClips().find((v) => v.id === id);
    if (!item) return;
    item.volume = clamp(Number(e.target.value) || 0, 0, 150);
    const label = $(`[data-voicevol-label="${id}"]`, pane);
    if (label) label.textContent = `${item.volume}%`;
    mixDirty();
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
  const lay = voiceLayoutNow();
  box.innerHTML = segs.map((sg, i) => {
    const text = (sg.subtitle || sg.title || '').trim();
    const mine = voices.filter((v) => v.segId === sg.id);
    const has = mine[0] || null;
    const l = has ? lay.get(has.id) : null;
    let badge = '';
    if (has) {
      if (l && l.played) {
        const tag = [l.spedUp ? `${l.rate.toFixed(2)}배속` : '', l.trimmed ? '끝 잘림' : ''].filter(Boolean).join(' · ');
        badge = `<span class="ai-badge-ok" title="${escapeHtml(`음성 ${(has.duration || 0).toFixed(1)}초 → 실제 ${l.played.toFixed(1)}초${tag ? ` (${tag})` : ''}`)}">음성 ${l.played.toFixed(1)}초${l.spedUp ? ' ⚡' : ''}${l.trimmed ? ' ✂' : ''}</span>`;
      } else {
        badge = `<span class="ai-badge-ok">음성 ${has.duration ? has.duration.toFixed(1) + '초' : '있음'}</span>`;
      }
    }
    if (mine.length > 1) badge += `<span class="ai-badge-warn">중복 ${mine.length}개</span>`;
    return `<div class="ai-seg${text ? '' : ' dim'}" data-segid="${sg.id}">
      <div class="ai-seg-head">
        <span class="num">${i + 1}</span>
        <span class="time">${sg.start.toFixed(1)}~${sg.end.toFixed(1)}초</span>
        <span class="grow"></span>
        ${badge}
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
  renderStaleNote();
  if (!items.length) {
    box.innerHTML = `<div class="ai-empty">아직 구간 음성이 없습니다. 위에서 TTS·녹음·파일로 넣을 수 있습니다.</div>`;
    return;
  }
  const lay = voiceLayoutNow();
  box.innerHTML = items.map((v) => {
    const seg = state.project.segments.find((s) => s.id === v.segId);
    const l = lay.get(v.id) || null;
    const at = l ? l.start : (v.start || 0);
    const played = l ? l.played : (v.duration || 0);
    const durTxt = voiceTimingText(v, l) || `${played.toFixed(1)}초`;
    return `<div class="ai-voice" data-voice="${v.id}">
      <button class="icon-btn sm" data-voiceact="play" data-voiceid="${v.id}" type="button" title="듣기">▶</button>
      <div class="ai-voice-meta">
        <b>${escapeHtml(v.name || '음성')}${v.voiceName ? ` <span class="ai-voice-tag">${escapeHtml(v.voiceName)}</span>` : ''}</b>
        <small>${at.toFixed(2)}초 · ${durTxt}${seg ? ` · ${seg.start.toFixed(1)}~${seg.end.toFixed(1)}초 구간` : ''}</small>
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
      const voice = ($('#ttsVoice', pane) && $('#ttsVoice', pane).value) || s.voice || 'Kore';
      saveAiSettings({ voice });
      const { blob } = await geminiTts(text, { apiKey: s.apiKey, model, voice });
      voiceClips().filter((v) => v.segId === seg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
      await addVoiceClip({ blob, name: voiceAssetName(seg, 'TTS'), start: seg.start, segId: seg.id, kind: 'tts', voiceName: voice });
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
      voiceClips().filter((v) => v.segId === seg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
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
        voiceClips().filter((v) => v.segId === seg.id).forEach((v) => removeVoiceClip(v.id, { forget: true }));
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

function renderStaleNote() {
  const el = $('#ttsStaleNote', pane);
  if (!el) return;
  const segIds = new Set((state.project.segments || []).map((s) => s.id));
  const items = voiceClips();
  const stale = items.filter((v) => v.segId && !segIds.has(v.segId));
  const bySeg = new Map();
  items.forEach((v) => { if (v.segId) bySeg.set(v.segId, (bySeg.get(v.segId) || 0) + 1); });
  const dup = Array.from(bySeg.values()).reduce((a, n) => a + Math.max(0, n - 1), 0);
  if (!stale.length && !dup) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  const bits = [];
  if (stale.length) bits.push(`지금 자막과 맞지 않는 <b>옛 나레이션 ${stale.length}개</b>`);
  if (dup) bits.push(`같은 구간에 <b>중복 음성 ${dup}개</b>`);
  el.innerHTML = `${bits.join(' · ')}가 남아 있습니다(겹쳐 들리는 원인).
    <button class="btn tiny danger" id="ttsClearStale" type="button" style="margin-left:6px">정리하기</button>`;
}

function onVoiceAction(e) {
  if (e.target.closest('#ttsClearStale')) {
    const n = pruneVoiceClips();
    renderTts();
    emit('project', { panels: ['audio', 'ai'] });
    emit('toast', { msg: n ? `옛·중복 음성 ${n}개를 정리했습니다.` : '정리할 음성이 없습니다.', type: n ? 'ok' : '' });
    return;
  }
  const btn = e.target.closest('[data-voiceact]');
  const id = btn.dataset.voiceid;
  if (btn.dataset.voiceact === 'del') {
    removeVoiceClip(id, { forget: true });
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
      stopAudition();   // 이전에 누른 ▶ 음성을 먼저 멈춥니다(중복 재생 방지)
      const audio = new Audio(asset.url);
      auditionAudio = audio;
      audio.volume = clamp((item.volume ?? 100) / 100, 0, 1);
      audio.addEventListener('ended', () => { if (auditionAudio === audio) auditionAudio = null; }, { once: true });
      audio.play().catch(() => emit('toast', { msg: '재생할 수 없습니다.', type: 'err' }));
    } catch (err) { /* 무시 */ }
  }
}

export function refreshAiPanel() {
  if (!pane) return;
  saveSettingsFromUI();
  syncCaptionsFromStore();
  renderBlogInfo();
  renderTts();
}

/** 다른 탭(내보내기)에서 캡션을 고쳤으면 이 탭도 맞춥니다. */
function syncCaptionsFromStore() {
  const latest = loadCaptionState();
  const changed = latest.url !== capState.url
    || latest.body !== capState.body
    || latest.title !== capState.title
    || JSON.stringify(latest.captions || {}) !== JSON.stringify(capState.captions || {});
  if (!changed) return;
  const active = document.activeElement;
  if (active && active.matches && active.matches('[data-captext]')) { capState = { ...latest, captions: { ...capState.captions } }; return; }
  capState = latest;
  const urlEl = $('#capUrl', pane);
  const bodyEl = $('#capBody', pane);
  if (urlEl && document.activeElement !== urlEl) urlEl.value = capState.url || '';
  if (bodyEl && document.activeElement !== bodyEl) bodyEl.value = capState.body || '';
  renderCapMeta();
  renderCaptions();
}

// ══ 📥 블로그 URL 하나로 끝내기 ══════════════════════
let blogBusy = false;

function blogStatus(msg, type = '') {
  const box = $('#blogStatus', pane);
  if (!box) return;
  box.classList.remove('hidden', 'ok', 'err', 'warn');
  if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
  if (type) box.classList.add(type);
  box.textContent = msg;
}

function setBlogBusy(on) {
  blogBusy = on;
  $$('#blogLoad, #blogMakeReel, #blogMakeCarousel, #blogMakeAll', pane).forEach((b) => { b.disabled = on; });
  const load = $('#blogLoad', pane);
  if (load) load.textContent = on ? '처리 중…' : '불러오기';
}

function initBlogHub() {
  const urlEl = $('#blogUrl', pane);
  const blog = loadBlogStore();
  if (urlEl && blog && blog.url) urlEl.value = blog.url;
  renderBlogInfo();
  $('#blogLoad', pane).addEventListener('click', () => loadBlogOneStop());
  $('#blogMakeReel', pane).addEventListener('click', () => runBlogAction('reel'));
  $('#blogMakeCarousel', pane).addEventListener('click', () => runBlogAction('carousel'));
  $('#blogMakeAll', pane).addEventListener('click', () => runBlogAction('both'));
  $('#blogGoExport', pane).addEventListener('click', () => {
    const tab = document.querySelector('.tab[data-tab="export"]');
    if (tab) tab.click();
  });
  urlEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadBlogOneStop(); } });
}

function renderBlogInfo() {
  const box = $('#blogInfo', pane);
  if (!box) return;
  const blog = loadBlogStore();
  if (!blog || !blog.images || !blog.images.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const thumbs = blog.images.map((it) => {
    const a = getAsset(it.assetId);
    return a && a.thumb ? `<img src="${a.thumb}" alt="">` : '';
  }).join('');
  box.innerHTML = `
    <div class="blog-info-head"><b>${escapeHtml(blog.title || '블로그 글')}</b>
      <span>${blog.images.length}장 · 본문 ${(blog.body || '').length.toLocaleString()}자</span></div>
    <div class="blog-thumbs">${thumbs}</div>`;
}

async function loadBlogOneStop() {
  if (blogBusy) return;
  const input = $('#blogUrl', pane);
  const url = normalizeBlogUrl(input.value);
  if (!url) { blogStatus('블로그 주소를 먼저 입력해 주세요.', 'err'); return; }
  const prevUrl = loadCaptionState().url;
  input.value = url;
  setBlogBusy(true);
  blogStatus('글 제목·본문·사진을 가져오는 중… (최대 40초)', 'warn');
  try {
    const picked = Number($('#blogMax', pane).value);
    const maxImages = Number.isFinite(picked) ? Math.max(0, picked) : 0; // 0 = 전체
    const { post, images, via, found = 0, failed = 0 } = await loadBlogIntoProject(url, {
      maxImages,
      onProgress: (msg) => blogStatus(msg, 'warn'),
    });
    // 캡션 칸 동기화
    const capUrlEl = $('#capUrl', pane);
    const capBodyEl = $('#capBody', pane);
    if (capUrlEl) capUrlEl.value = post.url;
    if (capBodyEl) capBodyEl.value = post.body;
    capState.url = post.url;
    capState.body = post.body;
    renderCapMeta();
    renderCaptions();
    const topicEl = $('#aiTopic', pane);
    if (topicEl && !topicEl.value.trim()) { topicEl.value = String(post.title || '').slice(0, 60); saveSettingsFromUI(); }
    renderBlogInfo();
    emit('project', { panels: [] });
    const missNote = failed ? ` (${failed}장은 내려받지 못해 뺐습니다)` : '';
    blogStatus(`불러왔습니다 — “${post.title}” · 사진 ${images.length}장${missNote} · 본문 ${post.body.length.toLocaleString()}자${via ? ` (${via})` : ''}`, images.length ? 'ok' : 'warn');
    // 5채널 캡션은 바로 만들기 (키 있으면 Gemini, 없으면 본문 기반)
    await makeCaptionsFromBlog({ silent: true, onlyEmpty: prevUrl === post.url });
  } catch (e) {
    blogStatus(`${e.message}${e.detail ? ` [${e.detail}]` : ''}`, 'err');
  } finally {
    setBlogBusy(false);
  }
}

async function runBlogAction(kind) {
  if (blogBusy) return;
  const blog = loadBlogStore();
  if (!blog || !blog.images || !blog.images.length) {
    blogStatus('먼저 [불러오기]를 눌러 글과 사진을 가져오세요.', 'err');
    return;
  }
  setBlogBusy(true);
  try {
    if (kind === 'reel' || kind === 'both') await makeReelFromBlog(blog);
    if (kind === 'carousel' || kind === 'both') await makeCarouselFromBlog(blog);
    if (kind === 'both') await makeCaptionsFromBlog({ silent: false });
  } catch (e) {
    blogStatus(e.message || '만들지 못했습니다.', 'err');
  } finally {
    setBlogBusy(false);
  }
}

function splitShortLines(text, max = 16) {
  const src = String(text || '').replace(/[🔻▶▼▽★☆■◆●•]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  if (src.length <= max) return [src];
  const words = src.split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (test.length <= max || !line) line = test;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out.map((l) => l.replace(/[,·]$/, '').trim()).filter((l) => l.length >= 2);
}

function blogHeadline(title) {
  const t = String(title || '').replace(/[!?~]+$/, '').trim();
  const first = t.split(/[,·|]/)[0].trim();
  return first.length <= 14 ? first : `${first.slice(0, 13).trim()}…`;
}

function blogBadge(body) {
  const b = String(body || '');
  const m = b.match(/(\d{1,2})\s*%/);
  if (/1\s*\+\s*1/.test(b)) return '1+1';
  if (m) return `${m[1]}% 할인`;
  if (/무료/.test(b)) return '무료';
  if (/할인|쿠폰/.test(b)) return '할인';
  return '총정리';
}

function sentenceParts(text) {
  return String(text || '')
    .split(/(?<=[.!?~])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** 자막 한 줄로 쓰기 좋은 문장을 고릅니다. (소제목 → 사진 앞 문단 → 본문 핵심 정보) */
function blogLines(blog) {
  const FILLER = /(달라질 수 있|경우가 있|수 있습니다|좋답니다|생각합니다|같습니다|정도입니다|보시면|알려드릴게요|시작해볼까요|다녀왔습니다|추천합니다)$/;
  const GOOD = /(조식|수영장|객실|뷰|가격|할인|무료|주차|체크인|체크아웃|위치|도보|원|층|호|박|메뉴|어메니티|스파|사우나|바베큐|캠핑|전망|루프탑|라운지|키즈|프라이빗|예약|셔틀|공항|역)/;
  const AD = /(마이리얼트립|아고다|트립닷컴|여기어때|부킹닷컴|클룩|야놀자|쿠팡|예약하기|바로가기|쿠폰|자세히 ?보기|상세 ?보기|더 ?보기)/;
  const clean = (s) => String(s || '')
    .replace(/^[\d]{1,2}[.)]\s*/, '')
    .replace(/^[▼▶▪◆■●•\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?~]+$/, '')
    .trim();
  const cands = [];
  let order = 0;
  const DANGLING = /(에|은|는|이|가|을|를|과|와|도|며|고|나|랑|으로|에서|부터|까지|보다|처럼|만|의|달라질|비교해|예약하는|추천하는)$/;
  const tidyEnding = (t) => {
    const words = String(t || '').trim().split(' ');
    while (words.length > 1 && words.join(' ').length > 6) {
      const last = words[words.length - 1];
      if (DANGLING.test(last)) words.pop();
      else break;
    }
    return words.join(' ');
  };
  const add = (raw, score) => {
    const t0 = tidyEnding(clean(raw));
    const t = t0;
    if (!t || t.length < 5 || t.length > 20) return;
    if (AD.test(t) || FILLER.test(t)) return;
    cands.push({ t, score, order: order++ });
  };

  // ① 소제목 — 글의 흐름을 알려 주는 짧은 말
  for (const img of blog.images || []) add(img.section, 2);
  // ② 사진 바로 앞 문단 — 그 사진을 설명하는 문장
  for (const img of blog.images || []) {
    for (const s of sentenceParts(img.caption)) {
      const t = clean(s);
      if (t.length <= 20) add(t, 3 + (GOOD.test(t) ? 2 : 0) + (/\d/.test(t) ? 2 : 0));
      else {
        const clause = t.split(/[,·]/)[0].trim();
        if (clause.length >= 8 && clause.length <= 20) add(clause, 2);
      }
    }
  }
  // ③ 본문의 가격·혜택 문장
  for (const l of pickInfoLines(blog.body || '', 6)) add(l, 3);

  const seen = new Set();
  const picked = [];
  for (const c of cands.slice().sort((a, b) => (b.score - a.score) || (a.order - b.order))) {
    const key = c.t.replace(/\s/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(c);
    if (picked.length >= 12) break;
  }
  picked.sort((a, b) => a.order - b.order);
  const lines = picked.map((c) => c.t);
  if (!lines.length) lines.push(blogHeadline(blog.title));
  return lines;
}

function buildBlogPlan(blog, totalDur) {
  const lines = blogLines(blog).slice(0, 12);
  const title = blogHeadline(blog.title);
  const badge = blogBadge(blog.body);
  const s = loadAiSettings();
  return {
    title: title || '오늘의 추천',
    badge,
    design: s.design || 'ref',
    segments: lines.map((subtitle) => ({ subtitle })),
    endcard: [blogHeadline(blog.title), lines[0] || ''],
    hook: '자세한 후기는 블로그에서 확인하세요👇',
    totalDur,
  };
}

function buildBlogReelPrompt(blog, totalSec) {
  const body = String(blog.body || '').slice(0, 4000);
  const caps = (blog.images || []).map((it, i) => `${i + 1}) ${it.caption || it.section || ''}`).join('\n');
  return [
    '너는 한국 여행·리빙 블로그 운영자가 쓰는 9:16 릴스(네이버 클립·인스타 릴스) 자막 작가다.',
    '아래 블로그 본문과 사진 설명을 읽고, 릴스 자막 세팅을 JSON 하나로만 답한다.',
    '',
    '[규칙]',
    '- title: 12자 이내 후킹(지명·숫자 환영). badge: 6자 이내(할인·무료·총정리 등).',
    `- segments: 0초부터 ${totalSec}초까지 빈틈없이, subtitle은 4~14자 한 줄 해요체 구어체.`,
    '- 본문에 있는 사실(가격·혜택·위치·시간)만 쓴다. 사진에서 확인되지 않은 효능은 쓰지 않는다.',
    '- 첫 구간은 문제 제기, 두 번째는 "~하지 마세요" 금지, 마지막은 CTA(자세한 후기는 블로그에서).',
    '- design: ref | neon | clean | bold 중 하나.',
    '',
    `[전체 길이] ${totalSec}초`,
    `[블로그 제목] ${blog.title || ''}`,
    '[사진 설명]',
    caps || '(없음)',
    '[본문]',
    body || '(없음)',
    '',
    '[출력 스키마]',
    '{"title":"릴스 제목","badge":"배지","design":"ref","segments":[{"start":0,"end":2,"subtitle":"자막"}],"endcard":["윗줄","아랫줄"],"hook":"마지막 멘트","sfx":[]}',
  ].join('\n');
}

async function makeReelFromBlog(blog) {
  if (!state.project) return;
  const imageDur = Number($('#blogImageDur', pane).value) || 2.6;
  const target = Number($('#blogTotal', pane).value) || 18;
  const replace = $('#blogReplace', pane).checked;
  // 불러온 사진을 자르지 않고 전부 컷으로 넣습니다.
  const images = (blog.images || []).slice();
  if (!images.length) throw new Error('블로그 사진이 없어 릴스를 만들지 못했습니다.');

  if (replace) state.project.clips = [];
  const per = clamp(target / images.length, 0.8, 5);
  for (const img of images) {
    const asset = getAsset(img.assetId);
    if (!asset) continue;
    const clip = makeClip({ id: asset.id, kind: 'image', name: asset.name, width: asset.width, height: asset.height });
    clip.duration = per;
    clip.trimOut = per;
    state.project.clips.push(clip);
  }
  if (!state.project.clips.length) throw new Error('사진을 컷으로 넣지 못했습니다.');
  ensureSegments();

  const dur = totalDuration();
  let used = '본문 기반';
  const s = loadAiSettings();
  let applied = false;
  if (s.apiKey) {
    try {
      busyState(true);
      blogStatus('Gemini가 블로그 글과 사진을 보고 자막을 다듬는 중…', 'warn');
      let model = (availableModels && availableModels.text) || s.model;
      if (!availableModels) {
        const ids = await listModels(s.apiKey);
        const picked = pickModels(ids, s);
        availableModels = picked;
        model = picked.text || model;
        saveAiSettings({ model });
      }
      const raw = await askGeminiText({ apiKey: s.apiKey, model, prompt: buildBlogReelPrompt(blog, Math.round(dur)) });
      const plan = parsePlan(raw);
      if (plan && plan.segments && plan.segments.length) {
        applyPlan(plan);
        used = 'Gemini';
        applied = true;
      }
    } catch (e) {
      // 키·한도 문제로 실패하면 본문 기반으로
    } finally {
      busyState(false);
    }
  }
  if (!applied) {
    const plan = buildBlogPlan(blog, dur);
    applyPlan(plan);
  }
  seek(0);
  emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
  renderBlogInfo();
  const stats = subtitleStats(state.project.segments, totalDuration());
  blogStatus(`릴스 준비 완료 — 컷 ${state.project.clips.length}개 · ${totalDuration().toFixed(1)}초 · 자막 ${stats.count}개 (${used})`, 'ok');
  emit('toast', { msg: `블로그로 릴스를 만들었습니다 (${totalDuration().toFixed(1)}초 · ${used})`, type: 'ok' });
  await syncNarrationAfterLayout();
}

async function makeCarouselFromBlog(blog) {
  const picked = Number($('#blogCarCount', pane).value);
  // 0 = 불러온 사진 전체
  const count = Number.isFinite(picked) && picked > 0 ? picked : (blog.images || []).length;
  const ratio = state.project.export.carouselRatio || '4:5';
  const made = cardsFromImages({ images: blog.images, title: blog.title, count });
  if (!made.cards.length) throw new Error('블로그 사진으로 카드를 만들지 못했습니다.');
  saveCarousel({ ratio, cards: made.cards });
  await reloadCarouselFromProject();
  blogStatus(`캐러셀 카드 ${made.cards.length}장을 만들었습니다 — 4번 내보내기에서 문구·위치·색·사진을 고치고 JPG·ZIP으로 저장하세요.`, 'ok');
  emit('toast', { msg: `캐러셀 카드 ${made.cards.length}장을 만들었습니다.`, type: 'ok' });
}

/** 블로그 본문으로 5채널 캡션 만들기 — 키가 있으면 Gemini, 없으면 본문 기반 */
async function makeCaptionsFromBlog({ silent = false, onlyEmpty = false } = {}) {
  const cap = loadCaptionState();
  const blog = loadBlogStore();
  const body = (cap.body || (blog && blog.body) || '').trim();
  if (!body || body.length < 40) return null;
  const title = cap.title || (blog && blog.title) || '';
  const keywords = extractKeywords({ title, body, hashtags: (blog && blog.hashtags) || [], n: 3 });
  const s = loadAiSettings();
  let caps = null;
  if (s.apiKey) {
    try {
      if (!silent) capStatus('Gemini가 5채널 캡션을 만드는 중… (10~30초)', 'warn');
      let model = (availableModels && availableModels.text) || s.model;
      if (!availableModels) {
        const ids = await listModels(s.apiKey);
        availableModels = pickModels(ids, s);
        model = availableModels.text || model;
        saveAiSettings({ model });
      }
      const raw = await askGeminiText({ apiKey: s.apiKey, model, prompt: buildCaptionPrompt(body, { url: cap.url, title, keywords }) });
      caps = parseCaptions(raw, { body, title, keywords });
    } catch (e) {
      caps = null;
    }
  }
  if (!caps) {
    const local = buildLocalCaptions({ title, body, hashtags: (blog && blog.hashtags) || [], url: cap.url });
    caps = parseCaptions(JSON.stringify(local), { body, title, keywords: local.keywords });
  }
  mergeCaptions(caps, { onlyEmpty });
  const n = CAPTION_CHANNELS.filter((c) => (caps[c.id] || '').trim()).length;
  capStatus(`5채널 캡션 준비 완료 — ${n}개 채널. 네이버 클립은 #오늘클립챌린지 #클립크리에이터 + 핵심 태그 3개로 맞췄습니다.`, n === 5 ? 'ok' : 'warn');
  return caps;
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

function mergeCaptions(caps, { onlyEmpty = false } = {}) {
  for (const ch of CAPTION_CHANNELS) {
    const v = (caps[ch.id] || '').trim();
    if (!v) continue;
    // 같은 글을 다시 불러왔을 때는 직접 고친 캡션을 덮어쓰지 않습니다.
    if (onlyEmpty && (capState.captions[ch.id] || '').trim()) continue;
    capState.captions[ch.id] = v;
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
  const btn = $('#capGenerate', pane);
  if (capBusy) return;
  capBusy = true;
  btn.disabled = true;
  const title = loadCaptionState().title || '';
  const keywords = extractKeywords({ title, body, n: 3 });
  let model = (availableModels && availableModels.text) || s.model;
  try {
    let caps = null;
    if (s.apiKey) {
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
      try {
        const raw = await askGeminiText({
          apiKey: s.apiKey,
          model,
          prompt: buildCaptionPrompt(body, { url: ($('#capUrl', pane).value || '').trim(), title, keywords }),
        });
        caps = parseCaptions(raw, { body, title, keywords });
      } catch (e) {
        caps = null;
      }
    }
    if (!caps) {
      const local = buildLocalCaptions({ title, body, hashtags: [], url: ($('#capUrl', pane).value || '').trim() });
      caps = parseCaptions(JSON.stringify(local), { body, title, keywords: local.keywords });
    }
    mergeCaptions(caps);
    const n = CAPTION_CHANNELS.filter((c) => (caps[c.id] || '').trim()).length;
    capStatus(`5채널 캡션 준비 완료 — ${n}개 채널${s.apiKey ? '' : ' (Gemini 키가 없어 본문 기반으로 만들었습니다)'}. 각 칸에서 고치고 📋 복사하세요.`, n === 5 ? 'ok' : 'warn');
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
