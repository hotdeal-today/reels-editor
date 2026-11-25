// main.js — 앱 부팅 · 탭 · 전역 이벤트
import { $, $$, clamp, on, emit, fmtSec } from './util.js';
import { state, loadProject, loadAssets, persist, newProject, totalDuration, activeSegment, getAsset, mixDirty } from './state.js';
import { openDB, idbClear } from './db.js';
import { warmupBuiltinFonts, loadCustomFontsFromDB, ensureFont } from './fonts.js';
import { initClipsPanel, addMediaFiles, refreshClips, setSelectedClip, syncMosaicControls } from './panels/clips.js';
import { initTextPanel, refreshTextPanel, syncPositionInputs, renderStyleCard } from './panels/text.js';
import { initAudioPanel, refreshAudioPanel, selectSfx } from './panels/audio.js';
import { initExportPanel, refreshExportPanel } from './panels/export.js';
import { initAiPanel, refreshAiPanel } from './panels/ai.js';
import { initTimeline, renderTimeline, setPlayhead } from './timeline.js';
import { initPlayer, togglePlay, play, pause, seek, requestRender, resizeCanvas, setMuted } from './player.js';
import { hitTestText, mosaicHitInfo, mosaicRect, setMosaicDragging } from './render.js';
import { buildMix } from './audio.js';

let activeTab = 'clips';

async function boot() {
  warmupBuiltinFonts();
  try { await openDB(); } catch (e) { console.warn(e); }
  await loadProject();
  await loadAssets();
  try { await loadCustomFontsFromDB(); } catch (e) { console.warn(e); }

  initClipsPanel($('[data-pane="clips"]'));
  initTextPanel($('[data-pane="text"]'));
  initAudioPanel($('[data-pane="audio"]'));
  initExportPanel($('[data-pane="export"]'));
  initAiPanel($('[data-pane="ai"]'));
  initTimeline();
  initPlayer();

  bindTabs();
  bindTransport();
  bindGlobalDnd();
  bindCanvasDrag();
  bindKeys();
  bindUI();
  wireEvents();

  $('#projectName').value = state.project.name || '새 릴스';
  $('#globalFilePicker').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await addMediaFiles(files);
  });
  $('#emptyPick').addEventListener('click', () => $('#globalFilePicker').click());

  // 디버깅용 (읽기 전용 참고): 콘솔에서 현재 상태 확인
  window.__reels = { state, totalDuration, render: () => requestRender(), seek, mix: () => buildMix(totalDuration()) };

  refreshAll();
  // 폰트 로딩 후 한 번 더 그려 폴백 글꼴로 굳는 것을 방지
  const fonts = ['title', 'badge', 'subtitle'].map((k) => state.project.texts[k]);
  Promise.all(fonts.map((t) => ensureFont(t.font, t.weight || 800))).then(() => requestRender());
  if (document.fonts) {
    document.fonts.ready.then(() => { requestRender(); });
  }
  setTimeout(() => { refreshAll(); }, 400);
}

function refreshAll() {
  refreshClips();
  refreshTextPanel();
  refreshAudioPanel();
  refreshExportPanel();
  refreshAiPanel();
  renderTimeline();
  updateChrome();
  requestRender();
}

function updateChrome() {
  const dur = totalDuration();
  const badge = $('#durBadge');
  if (badge) badge.textContent = fmtSec(dur);
  const total = $('#timeTotal');
  if (total) total.textContent = clock(dur);
  const empty = $('#emptyState');
  if (empty) empty.classList.toggle('hidden', state.project.clips.length > 0);
  const pn = $('#projectName');
  if (pn && document.activeElement !== pn) pn.value = state.project.name || '새 릴스';
}

function clock(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function bindTabs() {
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === activeTab));
      if (activeTab === 'export') refreshExportPanel();
      if (activeTab === 'ai') refreshAiPanel();
      if (activeTab === 'text') { renderStyleCardSafe(); }
    });
  });
}

function renderStyleCardSafe() {
  try { renderStyleCard(); } catch (e) { console.warn(e); }
}

function bindTransport() {
  $('#btnPlay').addEventListener('click', () => togglePlay());
  $('#btnMute').addEventListener('click', () => setMuted(!state.muted));
  $('#btnExportQuick').addEventListener('click', () => {
    const btn = $$('.tab').find((b) => b.dataset.tab === 'export');
    if (btn) btn.click();
  });
  $('#btnNew').addEventListener('click', () => {
    showModal({
      title: '새 프로젝트',
      body: '<p>지금 편집 중인 내용을 지우고 새로 시작합니다.<br>저장된 미디어는 새 프로젝트에서 다시 추가해야 합니다.</p>',
      actions: [
        { label: '취소', cls: 'ghost' },
        {
          label: '새로 시작', cls: 'primary', onClick: async () => {
            newProject();
            state.assets.forEach((a) => { if (a.url) URL.revokeObjectURL(a.url); });
            state.assets.clear();
            state.time = 0;
            try { await idbClear('assets'); } catch (e) { console.warn(e); }
            refreshAll();
            emit('toast', { msg: '새 프로젝트를 시작했습니다.', type: 'ok' });
          },
        },
      ],
    });
  });
  $('#btnHelp').addEventListener('click', showHelp);
  $('#modalClose').addEventListener('click', hideModal);

  const pn = $('#projectName');
  pn.addEventListener('input', () => {
    state.project.name = pn.value.trim() || '새 릴스';
    persist();
  });
  pn.addEventListener('keydown', (e) => { if (e.key === 'Enter') pn.blur(); });
}

function bindUI() {
  on('toast', ({ msg, type }) => toast(msg, type));
  on('save', () => persist());
  on('save:start', () => setSaveStatus('saving'));
  on('save:done', () => setSaveStatus('saved'));
  on('save:error', () => setSaveStatus('error'));
  on('need:media', () => toast('먼저 사진이나 영상을 추가하세요.', 'err'));
  on('time', (t) => { setPlayhead(t); });
  on('seek', (t) => { setPlayhead(t); });
}

function setSaveStatus(kind) {
  const el = $('#saveStatus');
  if (!el) return;
  el.classList.remove('saving', 'error');
  if (kind === 'saving') { el.classList.add('saving'); el.innerHTML = '<i></i> 저장 중…'; }
  else if (kind === 'error') { el.classList.add('error'); el.innerHTML = '<i></i> 저장 실패'; }
  else { el.innerHTML = '<i></i> 자동 저장됨'; }
}

function wireEvents() {
  on('project', (d = {}) => {
    const panels = d.panels || [];
    if (panels.includes('clips')) refreshClips();
    if (panels.includes('text')) refreshTextPanel();
    if (panels.includes('audio')) refreshAudioPanel();
    if (panels.includes('export')) refreshExportPanel();
    if (panels.includes('ai')) refreshAiPanel();
    renderTimeline();
    updateChrome();
    requestRender();
  });

  on('timeline', () => renderTimeline());

  on('select:clip', (i) => { setSelectedClip(i); renderTimeline(); });
  on('select:segment', (id) => {
    state.sel.segment = id;
    const seg = state.project.segments.find((s) => s.id === id);
    if (seg) state.sel.text = ['title', 'badge', 'subtitle'].find((k) => (seg[k] || '').trim()) || state.sel.text;
    switchTab('text');
    refreshTextPanel();
  });
  on('select:text', () => { if (activeTab === 'text') renderStyleCardSafe(); });
  on('select:sfx', (id) => { selectSfx(id); });
  on('select:audio', (kind) => { switchTab('audio'); });

  on('media-ready', () => requestRender());
}

function switchTab(name) {
  const btn = $$('.tab').find((b) => b.dataset.tab === name);
  if (btn) btn.click();
}

// ── 드래그 & 드롭 ──────────────────────────────────────
function bindGlobalDnd() {
  let depth = 0;
  const hint = $('#dropHint');
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    depth++;
    hint?.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) hint?.classList.add('hidden');
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    hint?.classList.add('hidden');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const media = files.filter((f) => /^(image|video)\//.test(f.type) || /\.(jpe?\w|png|webp|gif|mp4|mov|webm|m4v)$/i.test(f.name));
    if (!media.length) { toast('사진·영상 파일이 아닙니다.', 'err'); return; }
    switchTab('clips');
    await addMediaFiles(media);
  });
}

// ── 캔버스 위 글자·자막 가림 드래그 ──────────────────────
function bindCanvasDrag() {
  const canvas = $('#preview');
  if (!canvas) return;
  let drag = null;      // 글자 드래그
  let mDrag = null;     // 블러(자막 가리기) 박스 드래그

  const toDesign = (ev) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp(((ev.clientX - r.left) / r.width) * 1080, 0, 1080),
      y: clamp(((ev.clientY - r.top) / r.height) * 1920, 0, 1920),
    };
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (!state.project.clips.length) return;
    const pt = toDesign(ev);
    const hit = hitTestText(pt.x, pt.y);
    if (hit) {
      ev.preventDefault();
      if (state.playing) pause();
      state.sel.text = hit.key;
      const seg = state.project.segments.find((s) => s.id === hit.segId);
      if (seg) state.sel.segment = seg.id;
      const st = state.project.texts[hit.key];
      const cur = (seg && seg.pos && seg.pos[hit.key]) || { x: st.x, y: st.y };
      drag = { key: hit.key, segId: hit.segId, dx: pt.x - cur.x, dy: pt.y - cur.y, startX: pt.x, startY: pt.y, moved: false };
      canvas.classList.add('is-dragging');
      canvas.setPointerCapture(ev.pointerId);
      if (activeTab === 'text') renderStyleCardSafe();
      return;
    }

    // 글자가 없으면 자막 가림(블러) 박스를 집습니다.
    const mos = mosaicHitInfo(pt.x, pt.y);
    if (mos) {
      ev.preventDefault();
      if (state.playing) pause();
      const m = mos.m;
      const r = mosaicRect(m);
      mDrag = {
        target: mos.target,
        perClip: mos.perClip,
        w: clamp(Number(m.w != null ? m.w : 68), 1, 100),
        h: clamp(Number(m.h != null ? m.h : 9), 1, 100),
        dx: pt.x - (r.x + r.w / 2),
        dy: pt.y - (r.y + r.h / 2),
        startX: pt.x,
        startY: pt.y,
        moved: false,
      };
      setMosaicDragging(true);
      canvas.classList.add('is-dragging', 'is-mosaic-drag');
      canvas.setPointerCapture(ev.pointerId);
      requestRender();
      return;
    }
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!drag && !mDrag) {
      const pt = toDesign(ev);
      if (hitTestText(pt.x, pt.y)) canvas.style.cursor = 'grab';
      else if (mosaicHitInfo(pt.x, pt.y)) canvas.style.cursor = 'move';
      else canvas.style.cursor = 'default';
      return;
    }
    const pt = toDesign(ev);
    if (drag) {
      if (Math.abs(pt.x - drag.startX) > 2 || Math.abs(pt.y - drag.startY) > 2) drag.moved = true;
      const st = state.project.texts[drag.key];
      const nx = clamp(pt.x - drag.dx, 0, 1080);
      const ny = clamp(pt.y - drag.dy, 0, 1920);
      const seg = state.project.segments.find((s) => s.id === drag.segId);
      if (seg) {
        seg.pos = seg.pos || {};
        seg.pos[drag.key] = { x: nx, y: ny };
      } else {
        st.x = nx; st.y = ny;
      }
      requestRender();
      return;
    }
    if (mDrag) {
      if (Math.abs(pt.x - mDrag.startX) > 2 || Math.abs(pt.y - mDrag.startY) > 2) mDrag.moved = true;
      // 박스가 화면 밖으로 나가지 않게 중심값을 잘라 넣습니다.
      const minX = mDrag.w / 2, maxX = 100 - mDrag.w / 2;
      const minY = mDrag.h / 2, maxY = 100 - mDrag.h / 2;
      const x = clamp(((pt.x - mDrag.dx) / 1080) * 100, minX, maxX);
      const y = clamp(((pt.y - mDrag.dy) / 1920) * 100, minY, maxY);
      mDrag.target.x = Math.round(x * 10) / 10;
      mDrag.target.y = Math.round(y * 10) / 10;
      requestRender();
      syncMosaicControls({ x: mDrag.target.x, y: mDrag.target.y });
    }
  });

  const endDrag = () => {
    if (drag) {
      const moved = drag.moved;
      drag = null;
      canvas.classList.remove('is-dragging');
      if (moved) {
        persist();
        if (activeTab === 'text') { syncPositionInputs(); }
        emit('toast', { msg: '글자 위치를 옮겼습니다.' });
      }
      return;
    }
    if (!mDrag) return;
    const moved = mDrag.moved;
    const x = Math.round(Number(mDrag.target.x != null ? mDrag.target.x : 50));
    const y = Math.round(Number(mDrag.target.y != null ? mDrag.target.y : 78));
    mDrag = null;
    setMosaicDragging(false);
    canvas.classList.remove('is-dragging', 'is-mosaic-drag');
    requestRender();
    if (moved) {
      mixDirty();
      persist();
      emit('project', { panels: ['clips'] });
      emit('toast', { msg: `자막 가림 위치를 옮겼습니다 — 가로 ${x}% · 세로 ${y}%`, type: 'ok' });
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', (ev) => { if (!drag && !mDrag) canvas.style.cursor = 'default'; });
}

// ── 키보드 ─────────────────────────────────────────────
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      persist();
      toast('저장했습니다.', 'ok');
      return;
    }
    if (typing) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); seek(state.time - (e.shiftKey ? 1 : 0.1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); seek(state.time + (e.shiftKey ? 1 : 0.1)); }
    else if (e.key === 'Home') { e.preventDefault(); seek(0); }
  });
}

// ── 토스트 / 모달 ──────────────────────────────────────
function toast(msg, type) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

let modalActions = [];
function showModal({ title, body, actions = [] }) {
  const modal = $('#modal');
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const foot = $('#modalFoot');
  foot.innerHTML = '';
  modalActions = actions;
  actions.forEach((a, i) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.cls || '');
    b.textContent = a.label;
    b.addEventListener('click', () => {
      hideModal();
      if (a.onClick) a.onClick();
    });
    foot.appendChild(b);
  });
  modal.classList.remove('hidden');
}
function hideModal() { $('#modal')?.classList.add('hidden'); }

function showHelp() {
  showModal({
    title: '단축키 · 사용 팁',
    body: `
      <h4>재생</h4>
      <p><kbd>Space</kbd> 재생 / 정지 · <kbd>←</kbd><kbd>→</kbd> 0.1초 이동 · <kbd>Shift</kbd>+<kbd>←</kbd><kbd>→</kbd> 1초 이동 · <kbd>Home</kbd> 처음으로</p>
      <h4>편집</h4>
      <p>미리보기에서 <b>글자를 끌면</b> 위치가 바뀝니다. <b>자막 가리기(블러)</b>를 켰을 때는 미리보기의 <b>블러 박스를 직접 끌어</b> 가로·세로 위치를 옮길 수 있습니다. 타임라인의 주황색 효과음 블록은 끌어서 0.05초 단위로 옮길 수 있습니다.</p>
      <p><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd> 즉시 저장 (자동 저장도 됩니다)</p>
      <h4>내보내기</h4>
      <p>탭 4에서 MP4로 저장합니다. 기기 성능에 따라 1~2분 걸릴 수 있고, 진행률이 표시됩니다.</p>
      <h4>개인정보</h4>
      <p>사진·영상·음성은 서버로 전송되지 않고 이 브라우저(메모리·IndexedDB) 안에서만 처리됩니다.</p>
    `,
    actions: [{ label: '닫기', cls: 'primary' }],
  });
}

// 부팅
boot().catch((e) => {
  console.error(e);
  const box = document.getElementById('toasts');
  if (box) {
    const el = document.createElement('div');
    el.className = 'toast err';
    el.textContent = '앱을 시작하지 못했습니다: ' + (e.message || e);
    box.appendChild(el);
  }
});
