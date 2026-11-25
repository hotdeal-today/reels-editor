// panels/export.js — 탭4: 내보내기
import { $, emit, clamp, downloadBlob, fmtSec } from '../util.js';
import { state, totalDuration, persist } from '../state.js';
import { exportVideo, detectSupport, saveThumbnail } from '../export.js';
import { pause } from '../player.js';

let pane = null;
let busy = false;
let support = null;
let logLines = [];

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

  syncRes();
  renderSpecs();
  refreshSupport();
}

function syncRes() {
  const w = state.project.export.width;
  pane.querySelectorAll('[data-res]').forEach((b) => b.classList.toggle('on', Number(b.dataset.res) === (w === 720 ? 720 : 1080)));
  const chk = $('#realtimeChk', pane);
  chk.checked = !!state.project.export.realtime;
}

function renderSpecs() {
  const dur = totalDuration();
  const w = state.project.export.width;
  const h = state.project.export.height;
  const mbps = w >= 1080 ? 8 : 4.5;
  const size = (mbps * 1000 * 1000 * dur) / 8;
  const specs = $('#specs', pane);
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
  if (el) el.innerHTML = logLines.map((l) => `<b>›</b> ${escapeLog(l)}`).join('<br>');
  const box = $('#expLog', pane);
  if (box) box.scrollTop = box.scrollHeight;
}
function escapeLog(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

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

export function refreshExportPanel() {
  if (!pane || !state.project) return;
  syncRes();
  renderSpecs();
}
