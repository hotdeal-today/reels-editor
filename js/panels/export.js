// panels/export.js — 탭4: 내보내기 (MP4 · 캐러셀 카드 편집 · 5채널 캡션)
import { $, clamp, emit, downloadBlob, escapeHtml, fmtSec } from '../util.js';
import { state, totalDuration, persist } from '../state.js';
import { exportVideo, detectSupport, saveThumbnail } from '../export.js';
import {
  CAROUSEL_COUNTS, CAROUSEL_DEFAULT_COUNT, CAROUSEL_MAX_COUNT, CAROUSEL_RATIOS, CARD_POSITIONS, TEXT_SWATCHES, ACCENT_SWATCHES,
  getCarousel, saveCarousel, cardsFromTimeline, cardsFromImages, renderCards, renderCard, releaseCards,
  cardSignature, carouselFileName, patchCard, addCardFromPool, removeCardById, projectPhotos, findCard,
} from '../carousel.js';
import { loadBlogStore } from '../blog.js';
import { loadBlogIntoProject } from '../blogflow.js';
import { buildZip } from '../zip.js';
import {
  CAPTION_CHANNELS, loadCaptionState, saveCaptionState, buildCaptionPrompt, parseCaptions,
  buildLocalCaptions, checkNaverClipCaption, extractKeywords, normalizeBlogUrl,
} from '../captions.js';
import { loadAiSettings, listModels, pickModels, askGeminiText } from '../ai.js';
import { pause, requestRender } from '../player.js';

let pane = null;
let busy = false;
let support = null;
let logLines = [];

let carRuntime = [];
let carSig = '';
let carSelId = '';
let carBusy = false;
let carNoteMsg = '';
const cardRendering = new Set();
const cardTextTimers = new Map();
let capSaveTimer = null;
let exCapBusy = false;

export function initExportPanel(el) {
  pane = el;
  pane.innerHTML = `
    <div class="export-hero">
      <b>실제 MP4 파일로 저장</b>
      <p>사진·영상·음성 모두 이 브라우저 안에서만 처리되고, 서버로는 아무것도 전송되지 않습니다.</p>
    </div>

    <div class="sec">
      <div class="sec-head">해상도</div>
      <div class="seg-btns" id="resBtns">
        <button type="button" data-res="1080">1080 × 1920 (권장)</button>
        <button type="button" data-res="720">720 × 1280 (가벼움)</button>
      </div>
      <div class="sec-note" style="margin-top:7px">30fps · 9:16 세로 · H.264 MP4 (브라우저 지원에 따라 Opus 오디오)</div>
    </div>

    <div class="spec-grid" id="specs"></div>

    <div class="sec">
      <div class="sec-head">인코더 상태</div>
      <div class="card" id="codecCard"></div>
    </div>

    <div class="sec">
      <label class="switch" style="margin-bottom:9px;display:flex">
        <input type="checkbox" id="realtimeChk"> 실시간 녹화 모드 (호환 모드 — 영상 길이만큼 시간이 걸립니다)
      </label>
      <button class="btn primary block" id="doExport" type="button" style="padding:11px">MP4 내보내기</button>
      <div class="progress-wrap"><i id="expProgress"></i></div>
      <div class="export-log" id="expLog">대기 중…</div>
    </div>

    <div class="sec" data-sec="carousel">
      <div class="sec-head">🖼️ 캐러셀 카드 <span class="count">만들고 · 고치고 · 저장</span></div>
      <div class="sec-note">
        블로그 사진이나 지금 컷에서 <b>대표 카드 + 장면 카드</b>를 자동으로 만듭니다.
        장수는 <b>4~10장 또는 불러온 사진 전체</b>로 고르고, <b>＋</b>로 카드를 더 붙일 수도 있습니다.
        카드를 누르면 <b>제목·부제·위치·글자 크기·색·사진</b>을 그 자리에서 고칠 수 있고, 고친 그대로 JPG·ZIP으로 저장됩니다.
      </div>
      <div class="row" style="gap:6px;align-items:center;margin-bottom:6px">
        <label style="min-width:52px">장수</label>
        <div class="seg-btns grow" id="carCount">
          ${CAROUSEL_COUNTS.map((n) => `<button type="button" data-car-count="${n}">${n}장</button>`).join('')}
          <button type="button" id="carCountAll">전체</button>
        </div>
      </div>
      <div class="row" style="gap:6px;align-items:center;margin-bottom:6px">
        <label style="min-width:52px">직접</label>
        <input type="number" id="carCountInput" class="grow" min="2" max="40" step="1" value="5" style="max-width:96px" aria-label="캐러셀 장수">
        <button class="btn tiny" id="carCountApply" type="button">이 장수로</button>
        <span id="carCountHint" style="font-size:10.5px;color:var(--muted)"></span>
      </div>
      <div class="seg-btns" id="carRatio" style="margin-bottom:8px">
        <button type="button" data-car-ratio="4:5">4:5 피드 (1080×1350)</button>
        <button type="button" data-car-ratio="9:16">9:16 세로 (1080×1920)</button>
      </div>
      <div class="row" style="gap:6px">
        <label>블로그 URL</label>
        <input type="text" class="grow" id="carBlogUrl" placeholder="https://blog.naver.com/…" spellcheck="false" autocomplete="off">
        <button class="btn tiny" id="carBlogLoad" type="button">불러오기</button>
      </div>
      <div class="row" style="gap:6px">
        <button class="btn primary grow" id="carFromClips" type="button">⚡ 지금 컷으로 카드 만들기</button>
        <button class="btn grow" id="carFromBlog" type="button">📥 블로그 사진으로</button>
      </div>
      <div class="progress-wrap"><i id="carProgress"></i></div>
      <div class="car-note" id="carNote">아직 만든 카드가 없습니다.</div>
      <div class="car-grid" id="carGrid"></div>

      <div class="car-editor hidden" id="carEditor">
        <div class="ce-head">
          <b id="ceTitle">카드 편집</b>
          <span class="grow"></span>
          <button class="btn tiny ghost" id="cePrev" type="button" title="이전 카드">←</button>
          <button class="btn tiny ghost" id="ceNext" type="button" title="다음 카드">→</button>
          <button class="btn tiny ghost" id="ceAdd" type="button" title="카드 추가">＋</button>
          <button class="btn tiny ghost danger" id="ceDel" type="button" title="이 카드 삭제">🗑</button>
          <button class="btn tiny ghost" id="ceClose" type="button" title="닫기">✕</button>
        </div>
        <div class="row ce-row"><label>제목</label><input type="text" class="grow" id="ceTitleInput" maxlength="60" placeholder="카드 제목"></div>
        <div class="row ce-row"><label>부제</label><input type="text" class="grow" id="ceSubInput" maxlength="90" placeholder="부제(자막)"></div>
        <div class="row ce-row">
          <label>위치</label>
          <div class="seg-btns grow" id="cePos">
            ${CARD_POSITIONS.map((p) => `<button type="button" data-pos="${p.id}">${p.label}</button>`).join('')}
          </div>
        </div>
        <div class="row ce-row"><label>세로</label><input type="range" class="grow" id="ceY" min="6" max="94" step="1"><span class="val" id="ceYVal">82%</span></div>
        <div class="row ce-row"><label>제목 크기</label><input type="range" class="grow" id="ceSize" min="28" max="120" step="1"><span class="val" id="ceSizeVal">66</span></div>
        <div class="row ce-row"><label>부제 크기</label><input type="range" class="grow" id="ceSubSize" min="16" max="80" step="1"><span class="val" id="ceSubSizeVal">40</span></div>
        <div class="row ce-row">
          <label>글자 색</label>
          <input type="color" id="ceColor" class="ce-color">
          <div class="ce-swatches" id="ceColorSwatches">
            ${TEXT_SWATCHES.map((c) => `<button type="button" class="sw" data-swatch="text" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
          </div>
        </div>
        <div class="row ce-row">
          <label>강조 바</label>
          <input type="color" id="ceAccent" class="ce-color">
          <div class="ce-swatches" id="ceAccentSwatches">
            ${ACCENT_SWATCHES.map((c) => `<button type="button" class="sw" data-swatch="accent" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
          </div>
          <label class="switch" style="flex:0 0 auto"><input type="checkbox" id="ceAccentOn"> 배경 켜기</label>
        </div>
        <div class="row ce-row">
          <label>사진</label>
          <select class="grow" id="cePhoto"></select>
          <button class="btn tiny" id="cePhotoFile" type="button">파일</button>
        </div>
        <div class="row ce-row"><label>확대</label><input type="range" class="grow" id="ceZoom" min="100" max="250" step="1"><span class="val" id="ceZoomVal">100%</span></div>
        <div class="row ce-row"><label>좌우</label><input type="range" class="grow" id="ceCropX" min="-50" max="50" step="1"><span class="val" id="ceCropXVal">0</span></div>
        <div class="row ce-row"><label>위아래</label><input type="range" class="grow" id="ceCropY" min="-50" max="50" step="1"><span class="val" id="ceCropYVal">0</span></div>
        <input type="file" id="cePhotoInput" accept="image/*" hidden>
        <div class="sec-note" id="ceNote" style="margin:2px 0 0">고친 내용은 미리보기와 저장 파일에 바로 반영됩니다.</div>
      </div>

      <div class="row" style="gap:6px;margin-top:8px" id="carSaveRow">
        <button class="btn grow" id="carSaveAll" type="button" style="display:none">📥 JPG 모두 저장</button>
        <button class="btn grow" id="carZip" type="button" style="display:none">🗜 ZIP으로 저장</button>
      </div>
    </div>

    <div class="sec" data-sec="cap">
      <div class="sec-head">📝 블로그 URL · 5채널 캡션 <span class="count">AI 세팅과 같은 상태</span></div>
      <div class="sec-note" style="margin:0 0 7px">AI 세팅 탭에서 블로그를 불러왔으면 URL·본문이 이미 채워져 있습니다. 여기서 다시 불러오거나 다시 만들어도 됩니다.</div>
      <div class="row">
        <label>블로그 URL</label>
        <input type="text" class="grow" id="exCapUrl" placeholder="https://blog.naver.com/…" spellcheck="false" autocomplete="off">
        <button class="btn tiny" id="exCapFetch" type="button">불러오기</button>
      </div>
      <div class="row" style="gap:6px">
        <button class="btn sm primary grow" id="exCapGen" type="button">✨ 5채널 캡션 만들기</button>
      </div>
      <div class="ai-status hidden" id="exCapStatus"></div>
      <div class="cap-out" id="exCapOut"></div>
    </div>

    <div class="sec">
      <div class="sec-head">대표 썸네일</div>
      <div class="sec-note">지금 미리보기 프레임을 JPG로 저장합니다. (인스타·클립 대표 이미지용)</div>
      <button class="btn block" id="doThumb" type="button">현재 프레임 썸네일 저장 (thumbnail.jpg)</button>
    </div>

    <div class="sec">
      <div class="sec-head">안내</div>
      <div class="sec-note">
        · 인스타그램 릴스·네이버 클립은 9:16 · 30fps를 권장합니다.<br>
        · 오디오가 Opus로 저장되면 일부 편집 앱에서 인식하지 못할 수 있습니다. 필요하면 실시간 녹화 모드를 사용하세요.<br>
        · 작업 내용은 자동 저장됩니다. 브라우저를 닫아도 이 기기에서 이어서 편집할 수 있습니다.
      </div>
    </div>
  `;

  bindMp4();
  bindCarousel();
  bindCaptions();

  syncRes();
  syncCarRatio();
  syncCarCount();
  renderSpecs();
  refreshSupport();
  syncCarUI();
}

// ══ MP4 ═════════════════════════════════════════════════
function bindMp4() {
  $('#resBtns', pane).addEventListener('click', (e) => {
    const b = e.target.closest('[data-res]');
    if (!b) return;
    state.project.export.width = Number(b.dataset.res) === 720 ? 720 : 1080;
    state.project.export.height = Number(b.dataset.res) === 720 ? 1280 : 1920;
    persist();
    syncRes();
    refreshSupport();
  });

  $('#realtimeChk', pane).addEventListener('change', (e) => {
    state.project.export.realtime = e.target.checked;
    persist();
  });

  $('#doExport', pane).addEventListener('click', () => runExport());
  $('#doThumb', pane).addEventListener('click', () => runThumb());
}

function syncRes() {
  const w = state.project.export.width;
  pane.querySelectorAll('[data-res]').forEach((b) => b.classList.toggle('on', Number(b.dataset.res) === (w === 720 ? 720 : 1080)));
  const chk = $('#realtimeChk', pane);
  if (chk) chk.checked = !!state.project.export.realtime;
}

function renderSpecs() {
  const dur = totalDuration();
  const w = state.project.export.width;
  const h = state.project.export.height;
  const mbps = w >= 1080 ? 8 : 4.5;
  const size = (mbps * 1000 * 1000 * dur) / 8;
  const specs = $('#specs', pane);
  if (!specs) return;
  specs.innerHTML = `
    <div class="spec"><span>길이</span><b>${fmtSec(dur)}</b></div>
    <div class="spec"><span>해상도</span><b>${w}×${h}</b></div>
    <div class="spec"><span>프레임</span><b>30 fps</b></div>
    <div class="spec"><span>예상 용량</span><b>${dur > 0 ? (size / 1024 / 1024).toFixed(1) + ' MB' : '-'}</b></div>
  `;
}

async function refreshSupport() {
  const card = $('#codecCard', pane);
  if (!card) return;
  card.innerHTML = `<div class="codec-line"><span>확인 중…</span></div>`;
  const w = state.project.export.width, h = state.project.export.height;
  try {
    support = await detectSupport(w, h, 30, w >= 1080 ? 8000000 : 4500000);
  } catch (e) { support = null; }
  if (!support) { card.innerHTML = `<div class="codec-line"><span>인코더 확인 실패</span></div>`; return; }
  const path = support.webcodecs ? 'WebCodecs (빠름)' : (support.realtime ? 'MediaRecorder (실시간)' : '지원 안 됨');
  card.innerHTML = `
    <div class="codec-line"><span>비디오</span><b>${support.video ? support.video.label : 'H.264 미지원'}</b></div>
    <div class="codec-line"><span>오디오</span><b>${support.audio ? support.audio.label : '미지원'}</b></div>
    <div class="codec-line"><span>내보내기 방식</span><b>${path}</b></div>
    <div class="codec-line"><span>MediaRecorder</span><b>${support.realtime ? '사용 가능' : '없음'}</b></div>
  `;
}

function log(line) {
  logLines.push(line);
  if (logLines.length > 60) logLines = logLines.slice(-60);
  const el = $('#expLog', pane);
  if (el) el.innerHTML = logLines.map((l) => `<b>›</b> ${escapeHtml(l)}`).join('<br>');
  if (el) el.scrollTop = el.scrollHeight;
}

function setProgress(p, sub) {
  const bar = $('#expProgress', pane);
  if (bar) bar.style.width = `${clamp(p * 100, 0, 100).toFixed(1)}%`;
  const title = $('#expTitle');
  if (title) title.textContent = p >= 1 ? '내보내기 완료!' : '내보내는 중…';
  const overlay = $('#exportOverlay');
  const ob = $('#expBar');
  const os = $('#expSub');
  if (overlay) overlay.classList.remove('hidden');
  if (ob) ob.style.width = `${clamp(p * 100, 0, 100).toFixed(1)}%`;
  if (os) os.textContent = `${Math.round(clamp(p * 100, 0, 100))}%${sub ? ' · ' + sub : ''}`;
}
function hideProgress() {
  const overlay = $('#exportOverlay');
  if (overlay) overlay.classList.add('hidden');
}

async function runExport() {
  if (busy) return;
  if (totalDuration() <= 0.05) { emit('toast', { msg: '먼저 사진이나 영상을 추가하세요.', type: 'err' }); return; }
  busy = true;
  logLines = [];
  log('내보내기를 시작합니다.');
  const btn = $('#doExport', pane);
  btn.disabled = true;
  btn.textContent = '내보내는 중…';
  pause();
  setProgress(0, '준비 중');
  const w = state.project.export.width, h = state.project.export.height;
  try {
    const result = await exportVideo({
      width: w, height: h, fps: 30, bitrate: w >= 1080 ? 8000000 : 4500000,
      realtime: !!state.project.export.realtime,
      onProgress: (p, sub) => setProgress(p, sub),
      onLog: (line) => log(line),
    });
    const name = safeName(state.project.name || 'reels');
    const filename = `${name}_${w}x${h}.${result.ext}`;
    downloadBlob(result.blob, filename);
    const mb = (result.blob.size / 1024 / 1024).toFixed(1);
    log(`완료: ${filename} (${mb}MB) · ${result.codecInfo}`);
    setProgress(1, '완료');
    emit('toast', { msg: `MP4 내보내기 완료 (${mb}MB) — 다운로드를 확인하세요.`, type: 'ok' });
    setTimeout(hideProgress, 1600);
  } catch (e) {
    console.error(e);
    log(`실패: ${e.message || e}`);
    emit('toast', { msg: '내보내기 실패: ' + (e.message || e), type: 'err' });
    setProgress(0, '실패');
    setTimeout(hideProgress, 1200);
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = 'MP4 내보내기';
    renderSpecs();
  }
}

async function runThumb() {
  if (totalDuration() <= 0.05) { emit('toast', { msg: '먼저 사진이나 영상을 추가하세요.', type: 'err' }); return; }
  try {
    pause();
    const w = state.project.export.width, h = state.project.export.height;
    const blob = await saveThumbnail({ width: w, height: h });
    if (!blob) throw new Error('썸네일을 만들지 못했습니다.');
    downloadBlob(blob, `thumbnail_${w}x${h}.jpg`);
    emit('toast', { msg: '썸네일 JPG를 저장했습니다.', type: 'ok' });
  } catch (e) {
    emit('toast', { msg: '썸네일 실패: ' + (e.message || e), type: 'err' });
  }
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'reels';
}

// ══ 캐러셀 카드 ═════════════════════════════════════════
function carStore() { return getCarousel(); }
function carCount() { return Number(state.project.export.carouselCount) || CAROUSEL_DEFAULT_COUNT; }
function carRatio() { return state.project.export.carouselRatio || (carStore() && carStore().ratio) || '4:5'; }

function bindCarousel() {
  $('#carRatio', pane).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-car-ratio]');
    if (!b) return;
    const ratio = b.dataset.carRatio;
    state.project.export.carouselRatio = ratio;
    persist();
    syncCarRatio();
    const store = carStore();
    if (store && store.cards.length) {
      saveCarousel({ ratio, cards: store.cards });
      await renderAll({ force: true });
    }
  });
  $('#carCount', pane).addEventListener('click', async (e) => {
    if (e.target.closest('#carCountAll')) { await applyAllPhotos(); return; }
    const b = e.target.closest('[data-car-count]');
    if (!b) return;
    await setCarCount(Number(b.dataset.carCount));
  });
  const applyBtn = $('#carCountApply', pane);
  if (applyBtn) applyBtn.addEventListener('click', () => setCarCount(Number($('#carCountInput', pane).value)));
  const countInput = $('#carCountInput', pane);
  if (countInput) countInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); setCarCount(Number(countInput.value)); }
  });
  $('#carFromClips', pane).addEventListener('click', () => buildFromClips());
  $('#carFromBlog', pane).addEventListener('click', () => buildFromBlog());
  $('#carBlogLoad', pane).addEventListener('click', () => {
    const u = ($('#carBlogUrl', pane).value || '').trim();
    if (!u) { emit('toast', { msg: '블로그 주소를 먼저 입력해 주세요.', type: 'err' }); return; }
    $('#exCapUrl', pane).value = u;
    fetchBlogInExport();
  });
  $('#carSaveAll', pane).addEventListener('click', () => saveAllJpg());
  $('#carZip', pane).addEventListener('click', () => saveZip());
  $('#carGrid', pane).addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-carsave]');
    if (saveBtn) {
      const idx = Number(saveBtn.dataset.carsave);
      const card = carRuntime[idx];
      if (card && card.blob) {
        downloadBlob(card.blob, carouselFileName(state.project.name, idx + 1, carStore() ? carStore().ratio : carRatio()));
        emit('toast', { msg: `카드 ${idx + 1}장을 저장했습니다.`, type: 'ok' });
      }
      return;
    }
    const item = e.target.closest('[data-carid]');
    if (item) selectCard(item.dataset.carid);
  });

  // 편집기
  $('#ceClose', pane).addEventListener('click', () => { carSelId = ''; syncCarUI(); });
  $('#cePrev', pane).addEventListener('click', () => stepCard(-1));
  $('#ceNext', pane).addEventListener('click', () => stepCard(1));
  $('#ceAdd', pane).addEventListener('click', () => addCard());
  $('#ceDel', pane).addEventListener('click', () => deleteCard());

  const textEdit = (input, field) => {
    input.addEventListener('input', () => {
      clearTimeout(cardTextTimers.get(field));
      cardTextTimers.set(field, setTimeout(() => editCard({ [field]: input.value }), 380));
    });
  };
  textEdit($('#ceTitleInput', pane), 'title');
  textEdit($('#ceSubInput', pane), 'subtitle');

  $('#cePos', pane).addEventListener('click', (e) => {
    const b = e.target.closest('[data-pos]');
    if (!b) return;
    const pos = CARD_POSITIONS.find((p) => p.id === b.dataset.pos);
    if (!pos) return;
    editCard({ style: { pos: pos.id, y: pos.y } }, { immediate: true });
  });
  const rangeEdit = (el, apply, label) => {
    el.addEventListener('input', () => {
      if (label) label.textContent = el.value;
      clearTimeout(cardTextTimers.get(el.id));
      cardTextTimers.set(el.id, setTimeout(() => apply(Number(el.value)), 130));
    });
  };
  rangeEdit($('#ceY', pane), (v) => editCard({ style: { y: v, pos: yPreset(v) } }), $('#ceYVal', pane));
  rangeEdit($('#ceSize', pane), (v) => editCard({ style: { size: v } }), $('#ceSizeVal', pane));
  rangeEdit($('#ceSubSize', pane), (v) => editCard({ style: { subSize: v } }), $('#ceSubSizeVal', pane));
  rangeEdit($('#ceZoom', pane), (v) => editCard({ crop: { zoom: v } }), $('#ceZoomVal', pane));
  rangeEdit($('#ceCropX', pane), (v) => editCard({ crop: { x: v } }), $('#ceCropXVal', pane));
  rangeEdit($('#ceCropY', pane), (v) => editCard({ crop: { y: v } }), $('#ceCropYVal', pane));

  $('#ceColor', pane).addEventListener('input', (e) => editCard({ style: { color: e.target.value } }));
  $('#ceAccent', pane).addEventListener('input', (e) => editCard({ style: { accent: e.target.value } }));
  $('#ceAccentOn', pane).addEventListener('change', (e) => editCard({ style: { accentOn: e.target.checked } }, { immediate: true }));
  pane.querySelectorAll('[data-swatch]').forEach((sw) => {
    sw.addEventListener('click', () => {
      const color = sw.dataset.color;
      if (sw.dataset.swatch === 'text') {
        $('#ceColor', pane).value = color;
        editCard({ style: { color } }, { immediate: true });
      } else {
        $('#ceAccent', pane).value = color;
        editCard({ style: { accent: color, accentOn: true } }, { immediate: true });
      }
    });
  });
  $('#cePhoto', pane).addEventListener('change', (e) => {
    editCard({ assetId: e.target.value, source: 'photo' }, { immediate: true });
  });
  $('#cePhotoFile', pane).addEventListener('click', () => $('#cePhotoInput', pane).click());
  $('#cePhotoInput', pane).addEventListener('change', async () => {
    const f = $('#cePhotoInput', pane).files && $('#cePhotoInput', pane).files[0];
    $('#cePhotoInput', pane).value = '';
    if (!f) return;
    try {
      const { importMediaFile } = await import('../media.js');
      const { asset } = await importMediaFile(f);
      fillPhotoSelect(asset.id);
      editCard({ assetId: asset.id, source: 'photo' }, { immediate: true });
      emit('toast', { msg: '카드 사진을 바꿨습니다.', type: 'ok' });
    } catch (err) {
      emit('toast', { msg: '사진을 넣지 못했습니다: ' + (err.message || err), type: 'err' });
    }
  });
}

function yPreset(y) {
  let best = CARD_POSITIONS[0];
  let diff = Infinity;
  for (const p of CARD_POSITIONS) {
    const d = Math.abs(p.y - y);
    if (d < diff) { diff = d; best = p; }
  }
  return diff <= 4 ? best.id : '';
}

function syncCarRatio() {
  const cur = carRatio();
  pane.querySelectorAll('[data-car-ratio]').forEach((b) => b.classList.toggle('on', b.dataset.carRatio === cur));
}

function syncCarCount() {
  const cur = carCount();
  pane.querySelectorAll('[data-car-count]').forEach((b) => b.classList.toggle('on', Number(b.dataset.carCount) === cur));
  const input = $('#carCountInput', pane);
  if (input && document.activeElement !== input) input.value = String(cur);
  const hint = $('#carCountHint', pane);
  if (hint) {
    const pool = projectPhotos().length;
    hint.textContent = pool ? `사진 ${pool}장 불러옴` : '';
  }
  const allBtn = $('#carCountAll', pane);
  if (allBtn) {
    const pool = projectPhotos().length;
    allBtn.textContent = pool ? `전체 (${pool}장)` : '전체';
    allBtn.classList.toggle('on', pool >= 2 && cur === clamp(pool, 2, CAROUSEL_MAX_COUNT));
  }
}

/** 장수를 정해 카드에 반영합니다(모자라면 사진을 더 붙이고, 넘치면 뒤에서 자름). */
async function setCarCount(n) {
  state.project.export.carouselCount = clamp(Math.round(Number(n) || CAROUSEL_DEFAULT_COUNT), 2, CAROUSEL_MAX_COUNT);
  persist();
  syncCarCount();
  await applyCount(carCount());
}

/** 불러온 사진 전체를 카드로 — 카드가 없으면 블로그 사진(없으면 지금 컷)으로 바로 만듭니다. */
async function applyAllPhotos() {
  const pool = projectPhotos().length;
  const want = clamp(pool || 2, 2, CAROUSEL_MAX_COUNT);
  state.project.export.carouselCount = want;
  persist();
  syncCarCount();
  const store = carStore();
  if (!store || !store.cards.length) {
    const blog = loadBlogStore();
    if (blog && (blog.images || []).length) { await buildFromBlog(); return; }
    if (state.project.clips.length) { await buildFromClips(); return; }
    emit('toast', { msg: '먼저 블로그 사진을 불러오거나 컷을 추가해 주세요.', type: 'warn' });
    return;
  }
  await applyCount(carCount());
  setCarNote(`사진 ${projectPhotos().length}장 중 ${carStore().cards.length}장으로 맞췄습니다.`);
}

function setCarNote(msg) {
  carNoteMsg = msg;
  const el = $('#carNote', pane);
  if (el) el.textContent = msg;
}

async function buildFromClips() {
  if (!state.project.clips.length) { emit('toast', { msg: '먼저 사진이나 영상을 추가하세요.', type: 'err' }); return; }
  if (carStore() && carStore().cards.length && !window.confirm('지금 만든 캐러셀 카드를 새로 만들까요? (카드에 고친 문구·색은 사라집니다)')) return;
  const made = cardsFromTimeline({ count: carCount() });
  saveCarousel({ ratio: carRatio(), cards: made.cards });
  carSelId = made.cards[0] ? made.cards[0].id : '';
  await renderAll({ force: true });
  emit('toast', {
    msg: made.limited ? `서로 다른 장면이 ${made.cards.length}장이라 ${made.cards.length}장으로 만들었습니다.` : `캐러셀 카드 ${made.cards.length}장을 만들었습니다.`,
    type: made.limited ? 'warn' : 'ok',
  });
}

async function buildFromBlog() {
  const blog = loadBlogStore();
  if (!blog || !blog.images || !blog.images.length) {
    emit('toast', { msg: '위쪽 블로그 URL에서 [불러오기]를 먼저 눌러 주세요.', type: 'warn' });
    const urlEl = $('#exCapUrl', pane);
    if (urlEl) { urlEl.scrollIntoView({ block: 'center' }); urlEl.focus(); }
    return;
  }
  if (carStore() && carStore().cards.length && !window.confirm('지금 만든 캐러셀 카드를 블로그 사진으로 새로 만들까요? (고친 문구·색은 사라집니다)')) return;
  const made = cardsFromImages({ images: blog.images, title: blog.title, count: carCount() });
  if (!made.cards.length) { emit('toast', { msg: '블로그 사진이 없어 카드를 만들지 못했습니다.', type: 'err' }); return; }
  saveCarousel({ ratio: carRatio(), cards: made.cards });
  carSelId = made.cards[0].id;
  await renderAll({ force: true });
  const noClips = !state.project.clips.length;
  const tail = noClips ? ' 릴스 영상까지 만들려면 AI 세팅 탭의 [⚡ 둘 다 만들기]를 쓰세요.' : '';
  setCarNote(`${made.cards.length}장 완성${made.notice ? ` · ${made.notice}` : ''} — 카드를 눌러 고치고 저장하세요.${tail}`);
  emit('toast', { msg: `블로그 사진으로 카드 ${made.cards.length}장을 만들었습니다.`, type: 'ok' });
}

async function applyCount(n) {
  const store = carStore();
  if (!store || !store.cards.length) return;
  if (n > store.cards.length) {
    while (store.cards.length < n) addCardFromPool(store.cards);
  } else if (n < store.cards.length) {
    store.cards.length = Math.max(2, n);
  }
  if (!findCard(store.cards, carSelId)) carSelId = store.cards[0] ? store.cards[0].id : '';
  saveCarousel({ ratio: store.ratio, cards: store.cards });
  await renderAll({ force: true });
}

async function renderAll({ force = false } = {}) {
  if (carBusy) return;
  const store = carStore();
  if (!store || !store.cards.length) {
    releaseCards(carRuntime);
    carRuntime = [];
    carSig = '';
    syncCarUI();
    return;
  }
  const sig = cardSignature(store.cards, store.ratio);
  if (!force && sig === carSig && carRuntime.length === store.cards.length) { syncCarUI(); return; }
  carBusy = true;
  pause();
  const bar = $('#carProgress', pane);
  if (bar) bar.style.width = '2%';
  setCarNote('카드를 만드는 중…');
  try {
    releaseCards(carRuntime);
    carRuntime = [];
    const list = await renderCards(store.cards, {
      ratio: store.ratio,
      onProgress: (p, sub) => {
        if (bar) bar.style.width = `${Math.round(clamp(p, 0, 1) * 100)}%`;
        if (sub) setCarNote(`카드를 만드는 중… ${sub}`);
      },
    });
    carRuntime = list;
    saveCarousel({ ratio: store.ratio, cards: store.cards });
    carSig = cardSignature(store.cards, store.ratio);
    setCarNote(`${list.length}장 완성 (${store.ratio === '9:16' ? '1080×1920' : '1080×1350'}) — 카드를 눌러 문구·위치·색·사진을 고치세요.`);
    requestRender();
  } catch (e) {
    console.error(e);
    setCarNote('카드를 만들지 못했습니다: ' + (e.message || e));
    emit('toast', { msg: '캐러셀 생성 실패: ' + (e.message || e), type: 'err' });
  } finally {
    carBusy = false;
    if (bar) setTimeout(() => { if (bar) bar.style.width = '0%'; }, 900);
    syncCarUI();
  }
}

function selectCard(id) {
  carSelId = id;
  syncCarUI();
  const ed = $('#carEditor', pane);
  if (ed && !ed.classList.contains('hidden')) ed.scrollIntoView({ block: 'nearest' });
}

function stepCard(dir) {
  const store = carStore();
  if (!store || !store.cards.length) return;
  const idx = Math.max(0, store.cards.findIndex((c) => c.id === carSelId));
  const next = (idx + dir + store.cards.length) % store.cards.length;
  selectCard(store.cards[next].id);
}

async function addCard() {
  const store = carStore();
  if (!store) return;
  if (store.cards.length >= 10) { emit('toast', { msg: '카드는 10장까지 만들 수 있습니다.' }); return; }
  const card = addCardFromPool(store.cards);
  saveCarousel({ ratio: store.ratio, cards: store.cards });
  carSelId = card.id;
  await renderAll({ force: true });
  emit('toast', { msg: `카드 ${store.cards.length}장으로 늘렸습니다.` });
}

async function deleteCard() {
  const store = carStore();
  if (!store || !carSelId) return;
  if (store.cards.length <= 2) { emit('toast', { msg: '캐러셀은 최소 2장이 필요합니다.', type: 'warn' }); return; }
  const idx = store.cards.findIndex((c) => c.id === carSelId);
  removeCardById(store.cards, carSelId);
  carSelId = (store.cards[Math.min(idx, store.cards.length - 1)] || {}).id || '';
  saveCarousel({ ratio: store.ratio, cards: store.cards });
  await renderAll({ force: true });
  emit('toast', { msg: '카드를 지웠습니다.' });
}

/** 편집 반영 → 그 카드만 다시 그립니다. */
function editCard(patch, { immediate = false } = {}) {
  const store = carStore();
  if (!store || !carSelId) return;
  const card = patchCard(store.cards, carSelId, patch);
  if (!card) return;
  saveCarousel({ ratio: store.ratio, cards: store.cards });
  if (patch.style) syncStyleButtons(card);
  clearTimeout(cardTextTimers.get('__render'));
  if (immediate) renderOne(card.id);
  else cardTextTimers.set('__render', setTimeout(() => renderOne(card.id), 300));
}

async function renderOne(id) {
  const store = carStore();
  if (!store) return;
  const idx = store.cards.findIndex((c) => c.id === id);
  if (idx < 0) return;
  if (cardRendering.has(id)) {
    clearTimeout(cardTextTimers.get('__queue'));
    cardTextTimers.set('__queue', setTimeout(() => renderOne(id), 260));
    return;
  }
  cardRendering.add(id);
  try {
    pause();
    const fresh = await renderCard(store.cards[idx], { ratio: store.ratio });
    if (carRuntime[idx] && carRuntime[idx].url) { try { URL.revokeObjectURL(carRuntime[idx].url); } catch (e) { /* 무시 */ } }
    carRuntime[idx] = fresh;
    saveCarousel({ ratio: store.ratio, cards: store.cards });
    carSig = cardSignature(store.cards, store.ratio);
    updateCardDom(idx);
    setCarNote(`카드 ${idx + 1}을 고쳤습니다 — 그대로 JPG·ZIP으로 저장됩니다.`);
    requestRender();
  } catch (e) {
    console.error(e);
    setCarNote('카드를 다시 그리지 못했습니다: ' + (e.message || e));
  } finally {
    cardRendering.delete(id);
  }
}

function updateCardDom(idx) {
  const rt = carRuntime[idx];
  const store = carStore();
  if (!rt || !store) return;
  const item = $(`#carGrid .car-item[data-carid="${rt.id}"]`, pane);
  if (!item) { renderCarGrid(); return; }
  const img = item.querySelector('img');
  if (img && rt.url) img.src = rt.url;
  const label = item.querySelector('.car-cap span');
  if (label) label.textContent = cardLabel(store.cards[idx], idx);
  if (carSelId === rt.id) fillEditor();
}

function cardLabel(card, idx) {
  const t = String((card && card.title) || '').trim();
  if (t) return t.length > 18 ? t.slice(0, 17) + '…' : t;
  return idx === 0 ? '대표 카드' : `카드 ${idx + 1}`;
}

function renderCarGrid() {
  const grid = $('#carGrid', pane);
  if (!grid) return;
  const store = carStore();
  const cards = store ? store.cards : [];
  const tall = (store && store.ratio) === '9:16';
  if (!cards.length) {
    grid.innerHTML = '';
    $('#carSaveAll', pane).style.display = 'none';
    $('#carZip', pane).style.display = 'none';
    return;
  }
  grid.innerHTML = cards.map((c, i) => {
    const rt = carRuntime[i];
    return `
    <div class="car-item${c.id === carSelId ? ' sel' : ''}" data-carid="${c.id}">
      <div class="car-thumb ${tall ? 'tall' : ''}">
        <img src="${rt && rt.url ? rt.url : ''}" alt="카드 ${i + 1}" loading="lazy">
        <span class="car-num">${i + 1}</span>
        ${i === 0 ? '<span class="car-role">대표</span>' : ''}
      </div>
      <div class="car-cap">
        <b>${i + 1}</b>
        <span>${escapeHtml(cardLabel(c, i))}</span>
        <button class="btn tiny" data-carsave="${i}" type="button">저장</button>
      </div>
    </div>`;
  }).join('');
  $('#carSaveAll', pane).style.display = 'block';
  $('#carZip', pane).style.display = 'block';
  $('#carSaveAll', pane).textContent = `📥 JPG ${cards.length}장 모두 저장`;
}

function syncCarUI() {
  renderCarGrid();
  const store = carStore();
  const ed = $('#carEditor', pane);
  if (!ed) return;
  if (!store || !store.cards.length) {
    ed.classList.add('hidden');
    if (!carNoteMsg) setCarNote('아직 만든 카드가 없습니다.');
    return;
  }
  if (!carSelId || !findCard(store.cards, carSelId)) carSelId = store.cards[0].id;
  ed.classList.remove('hidden');
  fillEditor();
}

function fillPhotoSelect(currentAssetId) {
  const sel = $('#cePhoto', pane);
  if (!sel) return;
  const store = carStore();
  const card = store && carSelId ? findCard(store.cards, carSelId) : null;
  const want = currentAssetId || (card && card.assetId) || '';
  const photos = projectPhotos();
  if (want && !photos.some((p) => p.assetId === want)) {
    const name = (() => {
      try {
        // 자산 이름을 직접 읽기 위해 state에서 찾습니다.
        return (window.__reels && window.__reels.state.assets.get(want) || {}).name || '지금 사진';
      } catch (e) { return '지금 사진'; }
    })();
    photos.unshift({ assetId: want, name });
  }
  sel.innerHTML = photos.length
    ? photos.map((p) => `<option value="${p.assetId}">${escapeHtml(p.name || '사진')}</option>`).join('')
    : '<option value="">사진 없음</option>';
  if (want) sel.value = want;
}

function fillEditor() {
  const store = carStore();
  if (!store || !carSelId) return;
  const idx = store.cards.findIndex((c) => c.id === carSelId);
  const card = store.cards[idx];
  if (!card) return;
  const st = { ...card.style };
  $('#ceTitle', pane).textContent = `카드 ${idx + 1} 편집${idx === 0 ? ' (대표)' : ''}`;
  const titleEl = $('#ceTitleInput', pane);
  if (document.activeElement !== titleEl) titleEl.value = card.title || '';
  const subEl = $('#ceSubInput', pane);
  if (document.activeElement !== subEl) subEl.value = card.subtitle || '';
  $('#ceY', pane).value = String(Math.round(Number(st.y) || 82));
  $('#ceYVal', pane).textContent = `${Math.round(Number(st.y) || 82)}%`;
  $('#ceSize', pane).value = String(Math.round(Number(st.size) || 66));
  $('#ceSizeVal', pane).textContent = String(Math.round(Number(st.size) || 66));
  $('#ceSubSize', pane).value = String(Math.round(Number(st.subSize) || 40));
  $('#ceSubSizeVal', pane).textContent = String(Math.round(Number(st.subSize) || 40));
  $('#ceColor', pane).value = st.color || '#ffffff';
  $('#ceAccent', pane).value = st.accent || '#0b0d12';
  $('#ceAccentOn', pane).checked = st.accentOn !== false;
  $('#ceZoom', pane).value = String(Math.round(Number(card.crop && card.crop.zoom) || 100));
  $('#ceZoomVal', pane).textContent = `${Math.round(Number(card.crop && card.crop.zoom) || 100)}%`;
  $('#ceCropX', pane).value = String(Math.round(Number(card.crop && card.crop.x) || 0));
  $('#ceCropXVal', pane).textContent = String(Math.round(Number(card.crop && card.crop.x) || 0));
  $('#ceCropY', pane).value = String(Math.round(Number(card.crop && card.crop.y) || 0));
  $('#ceCropYVal', pane).textContent = String(Math.round(Number(card.crop && card.crop.y) || 0));
  fillPhotoSelect(card.assetId);
  syncStyleButtons(card);
}

function syncStyleButtons(card) {
  const y = Number(card.style && card.style.y) || 82;
  pane.querySelectorAll('#cePos [data-pos]').forEach((b) => b.classList.toggle('on', b.dataset.pos === yPreset(y)));
}

async function saveAllJpg() {
  const store = carStore();
  if (!store || !carRuntime.length) return;
  for (let i = 0; i < carRuntime.length; i++) {
    const c = carRuntime[i];
    if (!c || !c.blob) continue;
    downloadBlob(c.blob, carouselFileName(state.project.name, i + 1, store.ratio));
    setCarNote(`저장 중… ${i + 1}/${carRuntime.length}`);
    await new Promise((r) => setTimeout(r, 420));
  }
  setCarNote(`${carRuntime.length}장을 모두 저장했습니다. (여러 파일 다운로드를 물어보면 허용해 주세요)`);
  emit('toast', { msg: `카드 ${carRuntime.length}장을 저장했습니다.`, type: 'ok' });
}

async function saveZip() {
  const store = carStore();
  if (!store || !carRuntime.length) return;
  try {
    setCarNote('ZIP으로 묶는 중…');
    const files = carRuntime.map((c, i) => ({
      name: carouselFileName(state.project.name, i + 1, store.ratio),
      blob: c && c.blob,
    })).filter((f) => f.blob);
    const zip = await buildZip(files);
    downloadBlob(zip, `${safeName(state.project.name || 'reels')}_carousel_${store.ratio.replace(':', 'x')}.zip`);
    const kb = Math.round(zip.size / 1024);
    setCarNote(`ZIP 저장 완료 (${files.length}장, ${kb.toLocaleString()}KB)`);
    emit('toast', { msg: `카드 ${files.length}장을 ZIP으로 저장했습니다.`, type: 'ok' });
  } catch (e) {
    console.error(e);
    setCarNote('ZIP을 만들지 못했습니다: ' + (e.message || e));
    emit('toast', { msg: 'ZIP 저장 실패: ' + (e.message || e), type: 'err' });
  }
}

// ══ 5채널 캡션 (내보내기 탭) ═══════════════════════════
function bindCaptions() {
  const urlEl = $('#exCapUrl', pane);
  urlEl.addEventListener('change', () => {
    const url = normalizeBlogUrl(urlEl.value);
    if (url) { urlEl.value = url; saveCaptionState({ url }); }
  });
  $('#exCapFetch', pane).addEventListener('click', () => fetchBlogInExport());
  $('#exCapGen', pane).addEventListener('click', () => generateCaptionsInExport());

  const out = $('#exCapOut', pane);
  out.addEventListener('input', (e) => {
    const id = e.target.dataset.captext;
    if (!id) return;
    const cap = loadCaptionState();
    cap.captions[id] = e.target.value;
    clearTimeout(capSaveTimer);
    capSaveTimer = setTimeout(() => saveCaptionState({ captions: cap.captions }), 500);
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
    capStatus(ok ? `${(CAPTION_CHANNELS.find((c) => c.id === id) || {}).label || ''} 캡션을 복사했습니다.` : '복사가 막혔습니다. 칸을 눌러 직접 복사해 주세요.', ok ? 'ok' : 'warn');
  });
  renderExCaptions();
}

function capStatus(msg, type = '') {
  const box = $('#exCapStatus', pane);
  if (!box) return;
  box.classList.remove('hidden', 'ok', 'err', 'warn');
  if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
  if (type) box.classList.add(type);
  box.textContent = msg;
}

function renderExCaptions() {
  const out = $('#exCapOut', pane);
  if (!out) return;
  const active = document.activeElement;
  if (active && active.matches && active.matches('[data-captext]')) return; // 입력 중이면 건드리지 않음
  const cap = loadCaptionState();
  const urlEl = $('#exCapUrl', pane);
  if (urlEl && document.activeElement !== urlEl) urlEl.value = cap.url || '';
  out.innerHTML = CAPTION_CHANNELS.map((ch) => {
    const text = cap.captions[ch.id] || '';
    return `<div class="cap-card" data-capcard="${ch.id}">
      <div class="cap-head">
        <b>${ch.icon} ${ch.label}</b>
        <span class="grow"></span>
        <button class="btn tiny" data-capcopy="${ch.id}" type="button">📋 복사</button>
      </div>
      <div class="cap-hint">${escapeHtml(ch.hint)}</div>
      <textarea class="cap-text" data-captext="${ch.id}" rows="4" placeholder="아직 캡션이 없습니다. 위에서 만들거나 AI 세팅 탭에서 만들면 채워집니다.">${escapeHtml(text)}</textarea>
      <div class="cap-foot"><span data-capcount="${ch.id}"></span><span data-capwarn="${ch.id}"></span></div>
    </div>`;
  }).join('');
  for (const ch of CAPTION_CHANNELS) updateCapFoot(ch.id);
}

function updateCapFoot(id) {
  const out = $('#exCapOut', pane);
  if (!out) return;
  const ta = out.querySelector(`[data-captext="${id}"]`);
  const count = out.querySelector(`[data-capcount="${id}"]`);
  const warn = out.querySelector(`[data-capwarn="${id}"]`);
  const text = ta ? ta.value : '';
  if (count) count.textContent = text.trim() ? `${text.trim().length}자` : '';
  if (!warn) return;
  if (id === 'naverClip' && text.trim()) {
    const c = checkNaverClipCaption(text);
    warn.textContent = c.ok
      ? `해시태그 ${c.tags}개 · 유도 문구 ✓`
      : `해시태그 ${c.tags}개${c.hasChallenge && c.hasCreator ? '' : ' — 고정 2개 누락'}${c.hasCta ? '' : ' · 유도 문구 없음'} (총 5개 권장)`;
    warn.className = c.ok ? 'ok' : 'warn';
  } else {
    warn.textContent = '';
    warn.className = '';
  }
}

async function fetchBlogInExport() {
  if (exCapBusy) return;
  const input = $('#exCapUrl', pane);
  const url = normalizeBlogUrl(input.value);
  if (!url) { capStatus('블로그 주소를 먼저 입력해 주세요.', 'err'); return; }
  input.value = url;
  const cu = $('#carBlogUrl', pane);
  if (cu) cu.value = url;
  const btn = $('#exCapFetch', pane);
  exCapBusy = true;
  btn.disabled = true;
  btn.textContent = '가져오는 중…';
  capStatus('글 제목·본문·사진을 가져오는 중… (최대 40초)', 'warn');
  try {
    // 4번 탭에서도 블로그 사진을 6장·8장에서 자르지 않고 전부 가져옵니다.
    const { post, images, via, failed = 0 } = await loadBlogIntoProject(url, {
      maxImages: 0,
      onProgress: (msg) => capStatus(msg, 'warn'),
    });
    renderExCaptions();
    const missNote = failed ? ` (${failed}장은 내려받지 못해 뺐습니다)` : '';
    capStatus(`가져왔습니다 — “${post.title}” · 사진 ${images.length}장${missNote} · 본문 ${post.body.length.toLocaleString()}자${via ? ` (${via})` : ''}`, 'ok');
    emit('project', { panels: ['ai', 'export'] });
    // 카드가 아직 없으면 바로 카드까지 만들기 (URL → 카드 원스톱)
    const store = carStore();
    if ((!store || !store.cards.length) && images.length) {
      // 카드가 아직 없으면 불러온 사진 전부를 카드로 만들어 4번 탭에서 바로 보이게 합니다.
      state.project.export.carouselCount = clamp(images.length, 2, CAROUSEL_MAX_COUNT);
      persist();
      await buildFromBlog();
    }
    syncCarCount();
    // 캡션이 비어 있으면 바로 만들기
    const cur = loadCaptionState();
    const hasCaption = CAPTION_CHANNELS.some((ch) => (cur.captions[ch.id] || '').trim());
    if (!hasCaption) await buildCaptionsCore();
  } catch (e) {
    capStatus(`${e.message}${e.detail ? ` [${e.detail}]` : ''}`, 'err');
  } finally {
    exCapBusy = false;
    btn.disabled = false;
    btn.textContent = '불러오기';
  }
}

let exModels = null;

/** 캡션 생성 본체 — 자동(불러오기 직후)과 버튼 모두 여기를 부릅니다. */
async function buildCaptionsCore() {
  const cap = loadCaptionState();
  const body = (cap.body || '').trim();
  if (!body || body.length < 40) { capStatus('본문이 없습니다. 위에서 [불러오기]를 누르거나 AI 세팅 탭에서 본문을 넣어 주세요.', 'err'); return null; }
  const keywords = extractKeywords({ title: cap.title, body, n: 3 });
  const s = loadAiSettings();
  let caps = null;
  if (s.apiKey) {
    try {
      let model = (exModels && exModels.text) || s.model;
      if (!exModels) {
        const ids = await listModels(s.apiKey);
        exModels = pickModels(ids, s);
        model = exModels.text || model;
      }
      capStatus(`Gemini(${model})가 5채널 캡션을 만드는 중… (10~30초)`, 'warn');
      const raw = await askGeminiText({
        apiKey: s.apiKey,
        model,
        prompt: buildCaptionPrompt(body, { url: cap.url, title: cap.title, keywords }),
      });
      caps = parseCaptions(raw, { body, title: cap.title, keywords });
    } catch (e) {
      capStatus('Gemini 실패 — 블로그 본문으로 기본 캡션을 만듭니다. (' + (e.message || e) + ')', 'warn');
    }
  }
  if (!caps) {
    const local = buildLocalCaptions({ title: cap.title, body, hashtags: [], url: cap.url });
    caps = parseCaptions(JSON.stringify(local), { body, title: cap.title, keywords: local.keywords });
  }
  const merged = { ...cap.captions, ...caps };
  saveCaptionState({ captions: merged });
  renderExCaptions();
  capStatus('5채널 캡션 완료 — 네이버 클립은 고정 태그 2개 + 핵심 태그 3개로 맞췄습니다.', 'ok');
  emit('project', { panels: ['ai'] });
  return caps;
}

async function generateCaptionsInExport() {
  if (exCapBusy) return;
  const btn = $('#exCapGen', pane);
  exCapBusy = true;
  btn.disabled = true;
  capStatus('5채널 캡션을 만드는 중…', 'warn');
  try {
    await buildCaptionsCore();
  } catch (e) {
    capStatus(e.message || '캡션을 만들지 못했습니다.', 'err');
  } finally {
    exCapBusy = false;
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

// ══ 새로고침 ════════════════════════════════════════════
export function refreshExportPanel() {
  if (!pane || !state.project) return;
  syncRes();
  syncCarRatio();
  syncCarCount();
  renderSpecs();
  renderExCaptions();
  syncCarUI();
  const bUrl = $('#carBlogUrl', pane);
  if (bUrl) {
    const blog = loadBlogStore();
    if (blog && blog.url && !bUrl.value) bUrl.value = blog.url;
  }
  // 탭이 보일 때, 저장된 카드가 아직 안 그려졌으면 이어서 그립니다.
  if (carStore() && !carRuntime.length && pane.offsetParent !== null) renderAll({ force: false });
}

/** AI 세팅 탭에서 카드를 만들었을 때 내보내기 탭이 이어서 그립니다. */
export async function reloadCarouselFromProject() {
  if (!pane) return;
  const store = carStore();
  if (!store) { carRuntime = []; carSig = ''; syncCarUI(); return; }
  state.project.export.carouselRatio = store.ratio;
  state.project.export.carouselCount = store.cards.length;
  syncCarRatio();
  syncCarCount();
  carSelId = carSelId || (store.cards[0] && store.cards[0].id) || '';
  await renderAll({ force: true });
}
