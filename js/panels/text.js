// panels/text.js — 탭2: 제목 · 배지 · 자막
import { $, $$, clamp, emit, uid, escapeHtml, isFontFile } from '../util.js';
import { state, TEXT_KEYS, TEXT_LABEL, defaultStyle, totalDuration, activeSegment, persist, mixDirty } from '../state.js';
import { fontOptionsHtml, allFonts, addCustomFont, ensureFont } from '../fonts.js';
import { seek } from '../player.js';
import { PALETTE, PRESETS } from '../presets.js';

export { PRESETS };


let pane = null;
let fontBox = null;
let styleCard = null;
let segList = null;
let fontPicker = null;

export function initTextPanel(el) {
  pane = el;
  pane.innerHTML = `
    <div class="sec">
      <div class="sec-head">폰트 <span class="grow"></span>
        <button class="btn tiny" id="addFontBtn" type="button">+ 내 폰트 추가</button>
      </div>
      <input id="fontPicker" type="file" accept=".ttf,.otf,.woff,.woff2" hidden>
      <div class="font-grid" id="fontBox"></div>
      <button class="btn sm block" id="applyAllFonts" type="button" style="margin-top:7px">세 곳 모두 같은 폰트로 통일</button>
      <div class="sec-note" style="margin-top:7px">내장 7종 + 직접 올린 폰트. 올린 폰트는 이 브라우저(IndexedDB)에 저장됩니다.</div>
    </div>

    <div class="sec">
      <div class="sec-head">글자 디자인 프리셋</div>
      <div class="presets" id="presets"></div>
    </div>

    <div class="sec">
      <div class="sec-head">세부 디자인 <span class="count" id="styleTarget">제목</span></div>
      <div class="seg-btns" id="textTabs">
        ${TEXT_KEYS.map((k) => `<button type="button" data-texttab="${k}">${TEXT_LABEL[k]}</button>`).join('')}
      </div>
      <div class="card" id="styleCard" style="margin-top:8px"></div>
    </div>

    <div class="sec">
      <div class="sec-head">구간 제목·배지·자막 <span class="count" id="segCount"></span><span class="grow"></span>
        <button class="btn tiny" id="addSegBtn" type="button">+ 구간 추가</button>
      </div>
      <div class="seg-list" id="segList"></div>
      <div class="seg-hint">구간을 나눠 제목·배지·자막을 시간대별로 바꿀 수 있습니다. 미리보기에서 글자를 끌면 위치가 바뀝니다.</div>
    </div>
  `;

  fontBox = $('#fontBox', pane);
  styleCard = $('#styleCard', pane);
  segList = $('#segList', pane);
  fontPicker = $('#fontPicker', pane);

  $('#addFontBtn', pane).addEventListener('click', () => fontPicker.click());
  fontPicker.addEventListener('change', async () => {
    const f = fontPicker.files && fontPicker.files[0];
    fontPicker.value = '';
    if (!f) return;
    if (!isFontFile(f)) { emit('toast', { msg: 'ttf · otf · woff2 파일만 올릴 수 있습니다.', type: 'err' }); return; }
    try {
      const { family, label } = await addCustomFont(f);
      state.project.texts[state.sel.text].font = family;
      await ensureFont(family, 800);
      renderFonts();
      renderStyleCard();
      emit('toast', { msg: `${label} 폰트를 추가했습니다.`, type: 'ok' });
      afterEdit(['text']);
    } catch (e) {
      emit('toast', { msg: '폰트를 읽지 못했습니다: ' + (e.message || e), type: 'err' });
    }
  });

  $('#applyAllFonts', pane).addEventListener('click', () => {
    const fam = state.project.texts[state.sel.text].font;
    for (const k of TEXT_KEYS) state.project.texts[k].font = fam;
    renderFonts();
    emit('toast', { msg: '제목·배지·자막 폰트를 통일했습니다.', type: 'ok' });
    afterEdit([]);
  });

  fontBox.addEventListener('change', (e) => {
    const key = e.target.dataset.font;
    if (!key) return;
    state.project.texts[key].font = e.target.value;
    ensureFont(e.target.value, 800).then(() => afterEdit([]));
  });

  $('#textTabs', pane).addEventListener('click', (e) => {
    const b = e.target.closest('[data-texttab]');
    if (!b) return;
    state.sel.text = b.dataset.texttab;
    renderStyleCard();
    emit('select:text', state.sel.text);
  });

  $('#presets', pane).addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    applyPreset(b.dataset.preset);
  });

  styleCard.addEventListener('input', onStyleInput);
  styleCard.addEventListener('change', onStyleInput);
  styleCard.addEventListener('click', onStyleClick);

  $('#addSegBtn', pane).addEventListener('click', () => {
    const p = state.project;
    const dur = totalDuration() || 4;
    const start = clamp(state.time, 0, Math.max(0, dur - 0.5));
    let end = Math.min(dur, start + 3);
    if (end - start < 0.5) { end = Math.min(dur, start + 1); }
    if (end <= start) { emit('toast', { msg: '구간을 추가할 시간이 부족합니다.', type: 'err' }); return; }
    const seg = { id: uid('seg'), start, end, title: '', badge: '', subtitle: '', pos: {} };
    p.segments.push(seg);
    p.segments.sort((a, b) => a.start - b.start);
    state.sel.segment = seg.id;
    renderSegments();
    afterEdit(['text']);
  });

  segList.addEventListener('click', onSegClick);
  segList.addEventListener('input', onSegInput);

  renderFonts();
  renderPresets();
  renderStyleCard();
  renderSegments();
}

function afterEdit(panels) {
  mixDirty();
  emit('project', { panels, select: false });
  persist();
}

function renderFonts() {
  if (!fontBox) return;
  fontBox.innerHTML = TEXT_KEYS.map((k) => `
    <div class="font-row">
      <label>${TEXT_LABEL[k]}</label>
      <select data-font="${k}">${fontOptionsHtml(state.project.texts[k].font)}</select>
    </div>`).join('');
}

export function refreshFontOptions() { renderFonts(); }

function renderPresets() {
  const el = $('#presets', pane);
  if (!el) return;
  el.innerHTML = PRESETS.map((p) => {
    const st = p.style;
    const color = st.color;
    const bg = st.bg && st.bg.on
      ? `background:${st.bg.color};border-radius:${Math.min(9, Math.max(3, (st.bg.radius || 0) / 6))}px;`
      : '';
    const shadow = st.shadow && st.shadow.on ? `text-shadow:0 1px 5px rgba(0,0,0,.9);` : '';
    const stroke = st.stroke && st.stroke.on ? `-webkit-text-stroke:.6px ${st.stroke.color};` : '';
    return `<button class="preset" type="button" data-preset="${p.id}" title="${p.name}">
      <span class="p-preview"><span class="p-badge" style="color:${color};${bg}${shadow}${stroke}">가나다</span></span>
      <span class="p-name">${p.name}</span>
    </button>`;
  }).join('');
}

function activeSeg() {
  const p = state.project;
  let seg = p.segments.find((s) => s.id === state.sel.segment);
  if (!seg) seg = activeSegment(state.time) || p.segments[0];
  return seg || null;
}

function currentStyle() { return state.project.texts[state.sel.text]; }

/** 지금 선택한 구간(없으면 전체 기본값)의 실제 위치 */
function effectivePos(key) {
  const st = state.project.texts[key];
  const seg = activeSeg();
  const p = seg && seg.pos && seg.pos[key];
  return p ? { x: p.x, y: p.y } : { x: st.x, y: st.y };
}

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, val) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = val;
}

export function renderStyleCard() {
  if (!styleCard) return;
  const st = currentStyle();
  const key = state.sel.text;
  const pos = effectivePos(key);
  $('#styleTarget', pane).textContent = TEXT_LABEL[key];
  $$('#textTabs button', pane).forEach((b) => b.classList.toggle('on', b.dataset.texttab === key));

  const swatches = PALETTE.map((c) =>
    `<button class="swatch${st.color.toLowerCase() === c.toLowerCase() ? ' on' : ''}" type="button" data-color="${c}" style="background:${c}"></button>`).join('');

  styleCard.innerHTML = `
    <div class="row">
      <label>글자 크기</label>
      <input type="range" class="grow" data-style="size" min="18" max="170" step="1" value="${st.size}">
      <span class="val" data-sval="size">${st.size}px</span>
    </div>
    <div class="row">
      <label>글자 색</label>
      <div class="palette grow">${swatches}<input type="color" data-style="color" value="${toHex(st.color)}" title="직접 선택"></div>
    </div>
    <div class="row">
      <label>굵기</label>
      <select class="grow" data-style="weight">
        ${[[400, '보통 (400)'], [500, '중간 (500)'], [700, '굵게 (700)'], [800, '아주 굵게 (800)'], [900, '가장 굵게 (900)']]
          .map(([v, l]) => `<option value="${v}"${Number(st.weight) === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>

    <div class="row" style="margin-top:10px">
      <label>테두리</label>
      <label class="switch"><input type="checkbox" data-style="stroke.on" ${st.stroke.on ? 'checked' : ''}> 사용</label>
      <input type="color" data-style="stroke.color" value="${toHex(st.stroke.color)}" style="margin-left:auto">
      <span style="font-size:10.5px;color:var(--muted)">두께</span>
      <input type="number" data-style="stroke.width" value="${st.stroke.width}" min="0" max="14" step="1" style="width:52px">
    </div>

    <div class="row">
      <label>그림자</label>
      <label class="switch"><input type="checkbox" data-style="shadow.on" ${st.shadow.on ? 'checked' : ''}> 사용</label>
      <input type="color" data-style="shadow.color" value="${toHex(st.shadow.color)}" style="margin-left:auto">
      <span style="font-size:10.5px;color:var(--muted)">진하기</span>
      <input type="number" data-style="shadow.opacity" value="${st.shadow.opacity}" min="0" max="100" step="5" style="width:52px"><span style="font-size:10px;color:var(--muted)">%</span>
    </div>
    <div class="row">
      <label>그림자 거리</label>
      <span style="font-size:10.5px;color:var(--muted)">X</span>
      <input type="number" data-style="shadow.x" value="${st.shadow.x}" min="-40" max="40" step="1" style="width:52px">
      <span style="font-size:10.5px;color:var(--muted)">Y</span>
      <input type="number" data-style="shadow.y" value="${st.shadow.y}" min="-40" max="40" step="1" style="width:52px">
      <span style="font-size:10.5px;color:var(--muted)">번짐</span>
      <input type="number" data-style="shadow.blur" value="${st.shadow.blur}" min="0" max="80" step="1" style="width:52px">
    </div>

    <div class="row" style="margin-top:10px">
      <label>배경 박스</label>
      <label class="switch"><input type="checkbox" data-style="bg.on" ${st.bg.on ? 'checked' : ''}> 사용</label>
      <input type="color" data-style="bg.color" value="${toHex(st.bg.color)}" style="margin-left:auto">
      <span style="font-size:10.5px;color:var(--muted)">투명도</span>
      <input type="number" data-style="bg.opacity" value="${st.bg.opacity}" min="0" max="100" step="5" style="width:52px"><span style="font-size:10px;color:var(--muted)">%</span>
    </div>
    <div class="row">
      <label>둥글기</label>
      <input type="range" class="grow" data-style="bg.radius" min="0" max="99" step="1" value="${st.bg.radius}">
      <span class="val" data-sval="bg.radius">${st.bg.radius}px</span>
    </div>
    <div class="row">
      <label>여백</label>
      <span style="font-size:10.5px;color:var(--muted)">좌우</span>
      <input type="number" data-style="bg.padX" value="${st.bg.padX}" min="0" max="90" step="2" style="width:52px">
      <span style="font-size:10.5px;color:var(--muted)">상하</span>
      <input type="number" data-style="bg.padY" value="${st.bg.padY}" min="0" max="90" step="2" style="width:52px">
      <span style="font-size:10px;color:var(--muted)">px</span>
    </div>

    <div class="row" style="margin-top:10px">
      <label>위치 X · Y</label>
      <input type="number" data-pos="x" value="${Math.round(pos.x)}" min="0" max="1080" step="1" style="width:64px">
      <input type="number" data-pos="y" value="${Math.round(pos.y)}" min="0" max="1920" step="1" style="width:64px">
      <span class="val" style="min-width:auto">px</span>
    </div>
    <div class="row">
      <span class="grow" style="font-size:10px;color:#66707f">미리보기에서 글자를 끌어 옮길 수도 있습니다.</span>
      <button class="btn tiny" data-style-act="applyPos" type="button">이 위치를 모든 구간에 적용</button>
    </div>
    <div class="row">
      <span class="grow"></span>
      <button class="btn tiny ghost" data-style-act="reset" type="button">디자인 초기화</button>
    </div>
  `;
}

function toHex(c) {
  if (!c) return '#ffffff';
  if (c.startsWith('#')) return c.length === 4 ? '#' + c.slice(1).split('').map((x) => x + x).join('') : c;
  return '#ffffff';
}

function onStyleInput(e) {
  const t = e.target;
  const path = t.dataset.style;
  const posField = t.dataset.pos;
  const st = currentStyle();

  if (posField) {
    const v = clamp(Number(t.value) || 0, 0, posField === 'x' ? 1080 : 1920);
    const seg = activeSeg();
    if (seg) {
      seg.pos = seg.pos || {};
      seg.pos[state.sel.text] = { x: posField === 'x' ? v : (seg.pos[state.sel.text]?.x ?? st.x), y: posField === 'y' ? v : (seg.pos[state.sel.text]?.y ?? st.y) };
    } else {
      st[posField] = v;
    }
    afterEdit([]);
    return;
  }
  if (!path) return;

  let val;
  if (t.type === 'checkbox') val = t.checked;
  else if (t.type === 'color') val = t.value;
  else if (t.type === 'number' || t.type === 'range') val = Number(t.value);
  else val = t.value;
  if (path === 'size') val = clamp(Number(val), 18, 170);
  setPath(st, path, val);

  const sval = styleCard.querySelector(`[data-sval="${path}"]`);
  if (sval) sval.textContent = path === 'size' || path === 'bg.radius' ? `${val}px` : `${val}`;

  if (path === 'color') {
    $$('.swatch', styleCard).forEach((b) => b.classList.toggle('on', b.dataset.color.toLowerCase() === String(val).toLowerCase()));
  }
  afterEdit([]);
}

function onStyleClick(e) {
  const colorBtn = e.target.closest('[data-color]');
  if (colorBtn) {
    const st = currentStyle();
    st.color = colorBtn.dataset.color;
    renderStyleCard();
    afterEdit([]);
    return;
  }
  const act = e.target.closest('[data-style-act]')?.dataset.styleAct;
  if (!act) return;
  const st = currentStyle();
  const key = state.sel.text;
  if (act === 'reset') {
    const def = defaultStyle(key);
    // 위치는 유지, 디자인만 초기화
    state.project.texts[key] = { ...def, x: st.x, y: st.y };
    renderStyleCard();
    emit('toast', { msg: `${TEXT_LABEL[key]} 디자인을 초기화했습니다.` });
    afterEdit([]);
  } else if (act === 'applyPos') {
    const seg = activeSeg();
    const src = (seg && seg.pos && seg.pos[key]) || { x: st.x, y: st.y };
    for (const s of state.project.segments) {
      s.pos = s.pos || {};
      s.pos[key] = { x: src.x, y: src.y };
    }
    st.x = src.x; st.y = src.y;
    emit('toast', { msg: '이 위치를 모든 구간에 적용했습니다.', type: 'ok' });
    afterEdit([]);
  }
}

function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  const st = currentStyle();
  st.color = preset.style.color;
  st.bg = { ...st.bg, ...preset.style.bg };
  st.stroke = { ...st.stroke, ...preset.style.stroke };
  st.shadow = { ...st.shadow, ...preset.style.shadow };
  renderStyleCard();
  emit('toast', { msg: `${TEXT_LABEL[state.sel.text]}에 '${preset.name}' 디자인을 적용했습니다.`, type: 'ok' });
  afterEdit([]);
}

export function renderSegments() {
  if (!segList) return;
  const p = state.project;
  const dur = totalDuration();
  const segs = p.segments;
  $('#segCount', pane).textContent = `${segs.length}구간`;
  const active = activeSegment(state.time);
  segList.innerHTML = segs.map((s, i) => {
    const open = state.sel.segment === s.id;
    return `<div class="seg-item${open ? ' open sel' : ''}" data-segid="${s.id}">
      <div class="seg-head" data-seghead="${s.id}">
        <span class="num">${i + 1}</span>
        <span class="times">${s.start.toFixed(1)} ~ ${s.end.toFixed(1)}초</span>
        <span class="grow"></span>
        ${active && active.id === s.id ? '<span style="font-size:9px;color:var(--accent)">재생 중</span>' : ''}
        <button class="icon-btn sm" data-segact="del" data-segid="${s.id}" type="button" title="구간 삭제">✕</button>
      </div>
      <div class="seg-body">
        <div class="seg-times">
          <label>시작(초)<input type="number" data-segfield="start" data-segid="${s.id}" value="${s.start.toFixed(1)}" min="0" max="${Math.max(0.2, dur).toFixed(1)}" step="0.1"></label>
          <label>끝(초)<input type="number" data-segfield="end" data-segid="${s.id}" value="${s.end.toFixed(1)}" min="0.2" max="${Math.max(0.2, dur || 60).toFixed(1)}" step="0.1"></label>
          <label>길이<span style="color:var(--text-2);font-size:11.5px;padding-top:5px">${(s.end - s.start).toFixed(1)}초</span></label>
        </div>
        <div class="seg-field"><label>제목</label><input type="text" data-segfield="title" data-segid="${s.id}" value="${escapeHtml(s.title || '')}" placeholder="예: 동키호테 쇼핑리스트 2탄"></div>
        <div class="seg-field"><label>배지</label><input type="text" data-segfield="badge" data-segid="${s.id}" value="${escapeHtml(s.badge || '')}" placeholder="예: BEST · 1+1"></div>
        <div class="seg-field"><label>자막</label><input type="text" data-segfield="subtitle" data-segid="${s.id}" value="${escapeHtml(s.subtitle || '')}" placeholder="예: 일본 현지인 친구 추천"></div>
        <div class="seg-hint">이 구간(${s.start.toFixed(1)}~${s.end.toFixed(1)}초)에만 표시됩니다.</div>
      </div>
    </div>`;
  }).join('');
}

function onSegClick(e) {
  const del = e.target.closest('[data-segact="del"]');
  if (del) {
    const id = del.dataset.segid;
    const p = state.project;
    if (p.segments.length <= 1) { emit('toast', { msg: '구간은 최소 1개가 필요합니다.', type: 'err' }); return; }
    p.segments = p.segments.filter((s) => s.id !== id);
    if (state.sel.segment === id) state.sel.segment = p.segments[0].id;
    renderSegments();
    afterEdit(['text']);
    return;
  }
  const head = e.target.closest('[data-seghead]');
  if (!head) return;
  const id = head.dataset.seghead;
  state.sel.segment = state.sel.segment === id ? null : id;
  const seg = state.project.segments.find((s) => s.id === id);
  if (seg && state.sel.segment) {
    // 해당 구간으로 이동해 미리보기에서 바로 확인
    if (state.time < seg.start || state.time > seg.end) seek(seg.start + 0.05);
    renderStyleCard();
  }
  renderSegments();
}

function onSegInput(e) {
  const field = e.target.dataset.segfield;
  const id = e.target.dataset.segid;
  if (!field || !id) return;
  const seg = state.project.segments.find((s) => s.id === id);
  if (!seg) return;
  const dur = totalDuration();
  if (field === 'start' || field === 'end') {
    let v = Number(e.target.value);
    if (!isFinite(v)) return;
    v = Math.round(v * 10) / 10;
    if (field === 'start') seg.start = clamp(v, 0, Math.max(0, seg.end - 0.2));
    else seg.end = clamp(v, seg.start + 0.2, Math.max(seg.start + 0.2, dur || 60));
    const item = e.target.closest('.seg-item');
    const tEl = item && item.querySelector('.times');
    if (tEl) tEl.textContent = `${seg.start.toFixed(1)} ~ ${seg.end.toFixed(1)}초`;
  } else {
    seg[field] = e.target.value;
  }
  afterEdit([]);
  if (field === 'start' || field === 'end') {
    const idx = state.project.segments.indexOf(seg);
    const item = segList.querySelectorAll('.seg-item')[idx];
    if (item) {
      const len = item.querySelector('.seg-times label:last-child span');
      if (len) len.textContent = `${(seg.end - seg.start).toFixed(1)}초`;
    }
  }
}

/** 미리보기에서 드래그한 위치를 패널 숫자에 반영합니다. */
export function syncPositionInputs() {
  if (!styleCard) return;
  const pos = effectivePos(state.sel.text);
  const x = styleCard.querySelector('[data-pos="x"]');
  const y = styleCard.querySelector('[data-pos="y"]');
  if (x) x.value = String(Math.round(pos.x));
  if (y) y.value = String(Math.round(pos.y));
}

export function refreshTextPanel() {
  renderFonts();
  renderStyleCard();
  renderSegments();
}
