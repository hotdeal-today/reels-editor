// panels/ai.js — 탭5: AI 자동 세팅 (원클릭 · 프롬프트 복사/붙여넣기 · Gemini · TTS · 프로젝트 파일)
import { $, $$, clamp, emit, escapeHtml, fmtSec, downloadBlob, uid } from '../util.js';
import { state, totalDuration, persist, getAsset, ensureSegments, mixDirty } from '../state.js';
import {
  loadAiSettings, saveAiSettings, maskKey, listModels, pickModels,
  buildChatPrompt, buildPrompt, collectFrames, askGemini, askGeminiText, parsePlan, applyPlan,
  autoLayout, applyDesignSet, subtitleStats,
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
import { DEFAULT_COPY, defaultCopy, topicKindOf, checkCaption, hookRulesText } from '../formula.js';
import { buildPhotoPlan, repairPlan, describeLines, isReelPhoto, cutContextBlock } from '../reelscopy.js';
import {
  buildNarration, narrationReport, cleanNarrationTrack, syncNarrationToSegments,
} from '../narration.js';
import { buildProjectJson, loadProjectJson, projectFileName } from '../project-io.js';
import { seek } from '../player.js';

let pane = null;
let busy = false;
let capBusy = false;
let availableModels = null; // { ids, text, tts }

export function initAiPanel(el) {
  pane = el;
  const s = loadAiSettings();

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
        <div class="blog-cuts hidden" id="blogCuts"></div>
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
          나레이션은 <b>3번 음성·효과</b>의 목소리·속도 설정대로 자막과 1:1로 다시 만들어집니다.
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

    <div class="sec" data-sec="narration">
      <div class="sec-head">🎙 나레이션 상태 <span class="count">자막과 1:1</span></div>
      <div class="card ai-card">
        <div class="sec-note" style="margin:0 0 7px">
          나레이션 만들기 · 목소리 · 속도 · 초별 목록은 <b>3번 음성·효과</b> 탭 한 곳에서 다룹니다.
          여기서는 지금 자막과 나레이션이 맞는지만 보여 줍니다.
        </div>
        <div class="nar-summary" id="narSummary"></div>
        <div class="row" style="gap:6px;margin-top:7px">
          <button class="btn sm primary grow" id="goAudioTab" type="button">🎙 3번 음성·효과에서 나레이션 관리 →</button>
        </div>
      </div>
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
  $$('#aiOneClick, #aiGenerate, #aiTest, #aiApplyPaste', pane).forEach((b) => { b.disabled = on; });
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
    voice: state.project.audio.narrVoice || loadAiSettings().voice || 'Kore',
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

// ── 자막 ↔ 나레이션 동기화 (생성은 js/narration.js 한 곳에서) ─────────
/**
 * 자동 배치·붙여넣기·Gemini 세팅 직후 공통 처리:
 *  · 자막이 통째로 새로 만들어졌으므로 옛 음성은 남기지 않습니다.
 *  · TTS 자동이 켜져 있으면 '자막 글자 그대로' 1세트만 새로 만듭니다(다른 대본 없음).
 */
async function syncNarrationAfterLayout() {
  const s = loadAiSettings();
  if (s.ttsAuto === false || !s.apiKey) {
    const removed = cleanNarrationTrack({ forget: true });
    renderNarrationSummary();
    emit('project', { panels: ['audio'] });
    if (removed) emit('toast', { msg: `옛 나레이션 ${removed}개를 비웠습니다(자막과 따로 놀지 않게).`, type: 'warn' });
    return { cleared: removed, ok: 0, fail: 0 };
  }
  busyState(true);
  try {
    const r = await buildNarration({ mode: 'all', voice: s.voice, onProgress: (m) => status(m, 'warn') });
    if (r.ok || r.fail) {
      status(`나레이션 ${r.ok}개를 자막 그대로 1세트로 만들었습니다${r.fail ? ` · 실패 ${r.fail}개` : ''}`, r.fail ? 'warn' : 'ok');
      emit('toast', { msg: r.fail ? `나레이션 ${r.ok}개 완료 · ${r.fail}개 실패` : `나레이션 ${r.ok}개를 자막과 똑같이 만들었습니다.`, type: r.fail ? 'warn' : 'ok' });
    }
    renderNarrationSummary();
    emit('project', { panels: ['audio'] });
    return r;
  } finally {
    busyState(false);
  }
}

/** 지금 타임라인 클립에 붙은 블로그 사진 문맥(컷 번호·소제목·앞뒤 문단) — 프롬프트에 넘깁니다. */
function currentCutContexts() {
  const blog = loadBlogStore();
  const clips = (state.project && state.project.clips) || [];
  if (!blog || !blog.images || !clips.length) return [];
  const byAsset = new Map();
  for (const im of blog.images) if (im && im.assetId) byAsset.set(im.assetId, im);
  return clips.map((c, i) => {
    const im = c && c.assetId ? byAsset.get(c.assetId) : null;
    return im ? { cut: i + 1, section: im.section || '', before: im.before || [], after: im.after || [], alt: im.alt || '' } : { cut: i + 1 };
  });
}

function promptOpts() {
  const cuts = currentCutContexts();
  const blog = loadBlogStore();
  const topic = $('#aiTopic', pane).value.trim();
  return {
    cuts,
    body: (blog && blog.body) || '',
    kind: topicKindOf({ title: (blog && blog.title) || topic, body: (blog && blog.body) || '', topic }),
  };
}

function bindEvents() {
  // 설정 변경 저장
  ['aiDesignSel', 'aiImageDur', 'aiTempo', 'aiCopyLines', 'aiUseSfx', 'aiUseName', 'aiTopic', 'aiAutoTts'].forEach((id) => {
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
      const desc = res.matched ? '사진 문맥 1:1 매칭' : '기본 틀';
      emit('toast', { msg: `원클릭 배치 완료 — 컷 ${res.clips}개 · 구간 ${res.segments}개${subTxt} · ${desc}`, type: 'ok' });
      status(`원클릭 배치 완료(${desc}) — 제목 “${res.title || '없음'}” · 구간 ${res.segments}개.`, 'ok');
      await syncNarrationAfterLayout();
    } catch (e) {
      emit('toast', { msg: e.message || '자동 배치에 실패했습니다.', type: 'err' });
    }
  });

  $('#aiCopyDefault', pane).addEventListener('click', () => {
    const kind = topicKindOf({ title: $('#aiTopic', pane).value || '', topic: $('#aiTopic', pane).value || '' });
    const tpl = defaultCopy(kind);
    $('#aiCopyLines', pane).value = tpl.join('\n');
    saveSettingsFromUI();
    emit('toast', { msg: `${kind === 'stay' ? '숙소·여행' : kind === 'product' ? '제품' : '정보'} 자막 틀을 넣었습니다. 문장은 자유롭게 고치세요.`, type: 'ok' });
  });

  $('#aiCopyClear', pane).addEventListener('click', () => {
    $('#aiCopyLines', pane).value = '';
    saveSettingsFromUI();
    emit('toast', { msg: '카피 틀을 비웠습니다(비우면 기본 틀을 씁니다).' });
  });

  // 프롬프트
  $('#aiCopyPrompt', pane).addEventListener('click', async () => {
    saveSettingsFromUI();
    const text = buildChatPrompt($('#aiTopic', pane).value.trim(), loadAiSettings().tempo, promptOpts());
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
      ta.value = buildChatPrompt($('#aiTopic', pane).value.trim(), loadAiSettings().tempo, promptOpts());
      ta.classList.remove('hidden');
    } else {
      ta.classList.add('hidden');
    }
  });

  $('#aiApplyPaste', pane).addEventListener('click', async () => {
    const text = $('#aiPaste', pane).value.trim();
    if (!text) { emit('toast', { msg: 'AI가 준 JSON을 먼저 붙여넣어 주세요.', type: 'err' }); return; }
    try {
      const parsed = parsePlan(text);
      // 블로그 글을 불러뒀으면: 컷 수를 맞추고 라벨·평가어·가격 나열 줄을 사진 문맥 줄로 바꿉니다.
      let plan = parsed;
      let notes = [];
      const blog = loadBlogStore();
      let mb = null;
      if (blog && (blog.images || []).length) {
        const local = blogPhotoPlan(blog);
        const rep = repairPlan(parsed, local, (state.project.clips || []).length);
        plan = rep.plan;
        notes = rep.notes;
        mb = blog;
      }
      const res = applyPlan(plan);
      emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
      const fixed = notes.length ? ` · 라벨·평가어 ${notes.length}곳을 사진 문맥에 맞게 교체` : '';
      status(`붙여넣기 적용 완료 — 제목 “${res.title || '없음'}” · 구간 ${res.segments}개(자막 ${res.subtitles ? res.subtitles.count : 0}개)${fixed}`, 'ok');
      emit('toast', { msg: `자동 채우기 완료 (구간 ${res.segments}개${notes.length ? ` · ${notes.length}곳 교정` : ''})`, type: 'ok' });
      if (mb) renderCutMap(mb, plan);
      else {
        const bad = describeLines((plan.segments || []).map((sg) => sg.subtitle || '')).bad;
        if (bad.length) status(`붙여넣기 적용 — 구간 ${res.segments}개 · 라벨·평가어 ${bad.length}줄은 직접 고쳐주세요: ${bad.slice(0, 3).join(' / ')}`, 'warn');
      }
      if (notes.length) console.info('[붙여넣기 교정]', notes);
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
      const { plan } = await askGemini({ apiKey: s.apiKey, model, prompt: buildPrompt($('#aiTopic', pane).value.trim(), s.tempo, promptOpts()), frames });
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

  $('#goAudioTab', pane).addEventListener('click', () => {
    const tab = document.querySelector('.tab[data-tab="audio"]');
    if (tab) tab.click();
  });
  $('#narSummary', pane).addEventListener('click', (e) => {
    const b = e.target.closest('[data-naract]');
    if (!b) return;
    if (b.dataset.naract === 'sync') resyncNarration();
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

}

// ── 나레이션 상태 요약 (만들기는 3번 음성·효과 탭에서) ─────────────
function renderNarrationSummary() {
  const box = $('#narSummary', pane);
  if (!box) return;
  const rep = narrationReport();
  const s = loadAiSettings();
  if (!rep.captions) {
    box.innerHTML = '<div class="ai-empty">아직 자막이 없습니다. 위에서 AI 세팅을 하거나 2번에서 자막을 넣어 주세요.</div>';
    return;
  }
  const keyLine = s.apiKey ? 'Gemini TTS 준비됨' : 'Gemini 키 없음 — 3번에서 녹음·파일로 넣을 수 있습니다';
  const rows = [
    `자막 <b>${rep.captions}개</b>`,
    `나레이션 <b>${rep.voices}개</b>`,
    rep.stale.length ? `<span style="color:#ffc78a">자막과 어긋난 음성 <b>${rep.stale.length}개</b></span>` : '자막과 같은 나레이션 ✓',
    rep.mixed ? `<span style="color:#ffc78a">목소리 ${rep.names.length}가지 섞임</span>` : '',
  ].filter(Boolean);
  const need = rep.stale.length || rep.mixed || rep.missing.length;
  box.innerHTML = `
    <div class="nar-sum-lines">${rows.map((r) => `<span>${r}</span>`).join('')}</div>
    <div class="ai-key-state" style="margin-top:4px">${keyLine}${rep.voices ? ` · 목소리 ${escapeHtml(rep.names[0] || '—')}` : ''}${state.project.audio.narrRate && Number(state.project.audio.narrRate) !== 1 ? ` · 속도 ${Number(state.project.audio.narrRate).toFixed(2)}x` : ''}</div>
    ${rep.missing.length ? `<div class="ai-warn" style="margin-top:6px">나레이션이 없는 구간 <b>${rep.missing.length}개</b>가 있습니다. 3번 음성·효과에서 [전체 자막 TTS 만들기]를 누르면 자막 그대로 한 번에 채웁니다.</div>` : ''}
    ${need && rep.voices ? `<button class="btn tiny danger" data-naract="sync" type="button" style="margin-top:6px">🔄 자막 기준으로 나레이션 다시 맞추기</button>` : ''}
  `;
}

async function resyncNarration() {
  const s = loadAiSettings();
  if (!s.apiKey) { status('나레이션을 다시 만들려면 Gemini 무료 API 키가 필요합니다.', 'err'); return; }
  busyState(true);
  status('자막 기준으로 나레이션을 다시 맞추는 중…', 'warn');
  try {
    const r = await buildNarration({ mode: 'sync', voice: s.voice, onProgress: (m) => status(m, 'warn') });
    status(r.upToDate ? '이미 자막과 같은 나레이션입니다.' : `나레이션 ${r.ok}개를 자막 기준으로 맞췄습니다${r.fail ? ` · 실패 ${r.fail}개` : ''}`, r.fail ? 'warn' : 'ok');
    renderNarrationSummary();
    emit('project', { panels: ['audio'] });
  } catch (e) {
    status(e.message || '나레이션을 맞추지 못했습니다.', 'err');
  } finally {
    busyState(false);
  }
}

export function refreshAiPanel() {
  if (!pane) return;
  saveSettingsFromUI();
  syncCaptionsFromStore();
  renderBlogInfo();
  renderNarrationSummary();
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
    const { post, images, via, found = 0, failed = 0, dropped = 0, infoCards = 0 } = await loadBlogIntoProject(url, {
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
    const skipNote = [
      dropped ? `광고 링크·도입 배너 ${dropped}장 제외` : '',
      infoCards ? `정보 표 사진 ${infoCards}장(릴스에서는 빠짐)` : '',
    ].filter(Boolean).join(' · ');
    blogStatus(`불러왔습니다 — “${post.title}” · 사진 ${images.length}장${missNote} · 본문 ${post.body.length.toLocaleString()}자${via ? ` (${via})` : ''}${skipNote ? `\n${skipNote}` : ''}`, images.length ? 'ok' : 'warn');
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

// ── 블로그 → 릴스 : 사진 1장 = 자막 1줄 ─────────────────
/** 사진의 소제목·앞뒤 문단으로 만든 '이 사진의 포인트' 한 줄 (Gemini 키 없이도 1:1로 맞춤) */
function blogPhotoPlan(blog) {
  return buildPhotoPlan({
    images: blog.images || [],
    title: blog.title || '',
    body: blog.body || '',
    topic: ($('#aiTopic', pane).value || '').trim() || blog.title || '',
  });
}

/** 컷 ↔ 사진 ↔ 자막을 눈으로 확인하는 표 (사진-자막 매칭 검증용) */
function renderCutMap(blog, plan) {
  const box = $('#blogCuts', pane);
  if (!box) return;
  const photos = (blog.images || []).filter(isReelPhoto);
  if (!photos.length || !plan || !plan.segments) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const rows = plan.segments.map((sg, i) => {
    const im = photos[i] || {};
    const sec = String(im.section || '사진').slice(0, 24);
    const line = [sg.title, sg.subtitle].filter(Boolean).join(' / ');
    const chk = checkCaption(sg.subtitle || '');
    const warn = chk.label ? ' label' : (chk.evalWord ? ' eval' : '');
    return `<li data-cut="${i + 1}" data-ctx="${escapeHtml(sec)}" class="cm-row${warn}"><b>컷 ${i + 1}</b> <span class="cm-ctx">${escapeHtml(sec)}</span> <span class="cm-line">${escapeHtml(line)}</span></li>`;
  }).join('');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="cm-head">컷별 사진 문맥 → 자막 (${plan.segments.length}컷 · ${plan.kindLabel || plan.kind || ''})</div><ol class="cm-list">${rows}</ol>`;
}

function printCutMapConsole(blog, plan) {
  const photos = (blog.images || []).filter(isReelPhoto);
  const rows = (plan.segments || []).map((sg, i) => ({
    cut: i + 1,
    section: (photos[i] && photos[i].section) || '',
    before: (photos[i] && photos[i].before) || [],
    after: (photos[i] && photos[i].after) || [],
    caption: [sg.title, sg.subtitle].filter(Boolean).join(' / '),
    check: checkCaption(sg.subtitle || ''),
  }));
  console.table(rows.map((r) => ({ 컷: r.cut, 소제목: r.section, 자막: r.caption, 길이: r.check.len, 연결: r.check.connective ? 'O' : '-', 지적: r.check.notes.join(' ') })));
  return rows;
}

function buildBlogReelPrompt(blog, totalSec) {
  const photos = (blog.images || []).filter(isReelPhoto);
  const kind = topicKindOf({ title: blog.title || '', body: blog.body || '' });
  const cuts = photos.map((im, i) => ({
    cut: i + 1,
    section: im.section || '',
    before: im.before || [],
    after: im.after || [],
    alt: im.alt || '',
  }));
  const cutLines = cutContextBlock(cuts);
  const body = String(blog.body || '').slice(0, 3000);
  return [
    '너는 한국 여행·리빙 블로그 운영자가 쓰는 9:16 릴스(네이버 클립·인스타 릴스) 자막 작가다.',
    '아래 블로그 본문과 [컷별 사진 문맥]을 읽고, 릴스 자막 세팅을 JSON 하나로만 답한다.',
    '',
    hookRulesText(kind),
    '',
    '[규칙]',
    '- title: 0~3초 후킹 한 줄(13자 이내). 숙소·여행은 지역 반전 · 거리+결과 · 가장 강한 매력 1개. 숙소명·가격 나열로 시작 금지.',
    '- badge: 6자 이내, 사실만(BEST·총정리·필수템 같은 평가어 금지).',
    `- segments는 정확히 ${photos.length}개. 각 구간에 \"cut\" 번호(1부터)를 붙이고, cut N의 자막은 N번 사진의 문맥에서 확인되는 포인트 하나만 쓴다. 사진 순서를 바꾸지 않는다.`,
    '- subtitle은 4~13자 한 줄 해요체 구어체, 연결어미(~고/~서/~며/~면)나 조사(~까지)로 끝낸다. 컷마다 완결문·라벨 금지.',
    '- 본문에 있는 사실(가격·혜택·위치·시간)만 쓴다. 가격은 70~80%에서 한 번만 \"~만 원대\"로. 컷마다 가격·스펙을 나열하지 않는다.',
    '- 마지막 1~2컷에 CTA 하나(꼭 저장해두세요 / 댓글에 \'정보\'). 그 앞에 손해 방지 한 줄.',
    '- design: ref | neon | clean | bold 중 하나.',
    '',
    `[전체 길이] ${totalSec}초 · [컷 수] ${photos.length}`,
    `[블로그 제목] ${blog.title || ''}`,
    cutLines,
    '[본문]',
    body || '(없음)',
    '',
    '[출력 스키마]',
    '{\"title\":\"0~3초 후킹\",\"badge\":\"사실 배지\",\"design\":\"ref\",\"segments\":[{\"cut\":1,\"start\":0,\"end\":2,\"subtitle\":\"자막\"}],\"endcard\":[],\"hook\":\"\",\"sfx\":[]}',
  ].join('\n');
}

async function makeReelFromBlog(blog) {
  if (!state.project) return;
  const imageDur = Number($('#blogImageDur', pane).value) || 2.6;
  const target = Number($('#blogTotal', pane).value) || 18;
  const replace = $('#blogReplace', pane).checked;
  // 실사진만 컷으로 넣습니다(정보 표 캡처·도입 배너·제휴 링크 썸네일 제외).
  const all = blog.images || [];
  const images = all.filter(isReelPhoto);
  if (!images.length) throw new Error('블로그 사진이 없어 릴스를 만들지 못했습니다.');
  const infoCards = all.length - images.length;

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
  // ① 사진 문맥으로 만든 1:1 자막(기본값). 키가 없어도 이대로 씁니다.
  const localPlan = blogPhotoPlan(blog);
  localPlan.kindLabel = { stay: '숙소·여행', travel: '여행지', product: '제품', info: '정보' }[localPlan.kind] || '';
  let plan = localPlan;
  let used = '사진 문맥 1:1';
  let fixes = [];
  const s = loadAiSettings();
  if (s.apiKey) {
    try {
      busyState(true);
      blogStatus('Gemini가 컷별 사진 문맥을 보고 자막을 다듬는 중…', 'warn');
      let model = (availableModels && availableModels.text) || s.model;
      if (!availableModels) {
        const ids = await listModels(s.apiKey);
        const picked = pickModels(ids, s);
        availableModels = picked;
        model = picked.text || model;
        saveAiSettings({ model });
      }
      const raw = await askGeminiText({ apiKey: s.apiKey, model, prompt: buildBlogReelPrompt(blog, Math.round(dur)) });
      const gemini = parsePlan(raw);
      if (gemini && gemini.segments && gemini.segments.length) {
        // 컷 수를 맞추고, 라벨·평가어·가격 나열 줄은 사진 문맥 줄로 바꿉니다.
        const repaired = repairPlan(gemini, localPlan, images.length);
        plan = repaired.plan;
        fixes = repaired.notes;
        used = fixes.length ? `Gemini + ${fixes.length}곳 교정` : 'Gemini';
      }
    } catch (e) {
      blogStatus(`Gemini를 쓰지 못해 사진 문맥으로 만들었습니다 (${e.message || '실패'})`, 'warn');
    } finally {
      busyState(false);
    }
  }
  applyPlan(plan);
  seek(0);
  emit('project', { panels: ['clips', 'text', 'audio', 'ai'] });
  renderBlogInfo();
  renderCutMap(blog, plan);
  const rows = printCutMapConsole(blog, plan);
  const stats = subtitleStats(state.project.segments, totalDuration());
  const grammar = describeLines(plan.segments.map((sg) => sg.subtitle).filter(Boolean));
  const note = [
    infoCards ? `정보 표 사진 ${infoCards}장은 릴스에서 뺐어요(캐러셀엔 들어갑니다)` : '',
    fixes.length ? `Gemini 줄 ${fixes.length}곳을 사진 문맥에 맞게 고쳤어요` : '',
  ].filter(Boolean).join(' · ');
  blogStatus(`릴스 준비 완료 — 컷 ${state.project.clips.length}개 · ${totalDuration().toFixed(1)}초 · 자막 ${stats.count}개 (${used})${note ? ` · ${note}` : ''}`, 'ok');
  emit('toast', { msg: `블로그로 릴스를 만들었습니다 (${state.project.clips.length}컷 · ${used})`, type: 'ok' });
  console.info('[릴스 자막] 연결어미', `${grammar.connective}/${grammar.count}`, '지적', grammar.bad, rows.map((r) => `${r.cut}. ${r.caption} (${r.section})`));
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
