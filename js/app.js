// ── State ──────────────────────────────────────────────────────────────────
let srcImage = null;
let pendingImage = null; // full uploaded image, awaiting selection confirmation
// Persistent "what to reopen" state — distinct from pendingImage/selectionBox,
// which are transient and only live while the selection view is actively open.
// Populated right before finalizeImage() on a confirmed selection; reset
// whenever a genuinely new file comes in via handleFile (a fresh upload is
// not "editing" the previous crop). Stays null for images that skipped the
// selection view entirely (see SELECT_SKIP_MAX_DIM) — there was no selection
// to re-edit.
let lastUploadedSheet = null; // the original uploaded Image that was cropped
let lastCropRect = null; // {sx,sy,sw,sh} in true source-image pixels
let currentSVG = null;
let currentMaskPreview = null;
let currentTraceStats = null;
let detectedInvert = false;
let selectedColor = '#000000';
let liveEnabled = false;
let liveTimer = null;

const CONTROL_DEFS = [
  { id: 'threshold-mode', valueId: null, decimals: 0 },
  { id: 'threshold', valueId: 'v-threshold', decimals: 0 },
  { id: 'threshold-bias', valueId: 'v-threshold-bias', decimals: 0 },
  { id: 'despeckle', valueId: 'v-despeckle', decimals: 0 },
  { id: 'hole-preservation', valueId: 'v-hole-preservation', decimals: 0 },
  { id: 'corner-smoothing', valueId: 'v-corner-smoothing', decimals: 0 },
  { id: 'curve-fit', valueId: 'v-curve-fit', decimals: 1 },
  { id: 'path-simplify', valueId: 'v-path-simplify', decimals: 0 },
  { id: 'upscale-factor', valueId: null, decimals: 0 },
  { id: 'invert', valueId: null, decimals: 0 },
];

// ── Undo/Redo history ─────────────────────────────────────────────────────
const HISTORY_LIMIT = 20;
let history = [];
let historyIndex = -1;

function pushHistory(snap) {
  history = history.slice(0, historyIndex + 1);
  history.push(snap);
  if (history.length > HISTORY_LIMIT) history.shift();
  historyIndex = history.length - 1;
  updateHistoryButtons();
}

function snapshotSettings() {
  return {
    thresholdMode: document.getElementById('threshold-mode').value,
    threshold: document.getElementById('threshold').value,
    thresholdBias: document.getElementById('threshold-bias').value,
    despeckle: document.getElementById('despeckle').value,
    holePreservation: document.getElementById('hole-preservation').value,
    cornerSmoothing: document.getElementById('corner-smoothing').value,
    curveFit: document.getElementById('curve-fit').value,
    pathSimplify: document.getElementById('path-simplify').value,
    upscaleFactor: document.getElementById('upscale-factor').value,
    invert: document.getElementById('invert').value,
  };
}

function applySettings(settings) {
  document.getElementById('threshold-mode').value = settings.thresholdMode;
  document.getElementById('threshold').value = settings.threshold;
  document.getElementById('threshold-bias').value = settings.thresholdBias;
  document.getElementById('despeckle').value = settings.despeckle;
  document.getElementById('hole-preservation').value = settings.holePreservation;
  document.getElementById('corner-smoothing').value = settings.cornerSmoothing;
  document.getElementById('curve-fit').value = settings.curveFit;
  document.getElementById('path-simplify').value = settings.pathSimplify;
  document.getElementById('upscale-factor').value = settings.upscaleFactor;
  document.getElementById('invert').value = settings.invert;
  syncControlBadges();
}

function applySnapshot(snap) {
  applySettings(snap.settings);
  currentSVG = snap.svgString;
  currentMaskPreview = snap.maskPreviewUrl || null;
  currentTraceStats = snap.stats || null;
  renderSVGTab(snap.svgString, snap.stats, snap.maskPreviewUrl);
  renderExportsTab(snap.svgString);
  document.querySelector('[data-tab="svg"]').click();
  setStatus('Restored — SVG ready ✓', 'ok');
}

function updateHistoryButtons() {
  document.getElementById('undo-btn').disabled = historyIndex <= 0;
  document.getElementById('redo-btn').disabled = historyIndex >= history.length - 1;
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  applySnapshot(history[historyIndex]);
  updateHistoryButtons();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  applySnapshot(history[historyIndex]);
  updateHistoryButtons();
}

document.getElementById('undo-btn').addEventListener('click', undo);
document.getElementById('redo-btn').addEventListener('click', redo);

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  }
});

// ── Live update toggle ────────────────────────────────────────────────────
const liveToggle = document.getElementById('live-toggle');
liveToggle.addEventListener('click', () => {
  liveEnabled = !liveEnabled;
  liveToggle.classList.toggle('on', liveEnabled);
  liveToggle.setAttribute('aria-pressed', liveEnabled);
  if (liveEnabled && srcImage) scheduleLive();
});

function scheduleLive() {
  if (!liveEnabled || !srcImage) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    document.getElementById('trace-btn').click();
  }, 350);
}

// ── Tab switching ──────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Controls ──────────────────────────────────────────────────────────────
function syncControlBadges() {
  CONTROL_DEFS.forEach(({ id, valueId, decimals }) => {
    if (!valueId) return;
    const el = document.getElementById(id);
    const badge = document.getElementById(valueId);
    const value = parseFloat(el.value);
    badge.value = value.toFixed(decimals);
  });
}

function clampToSlider(rawValue, slider) {
  const min = slider.min === '' ? -Infinity : parseFloat(slider.min);
  const max = slider.max === '' ? Infinity : parseFloat(slider.max);
  const step = slider.step && slider.step !== 'any' ? parseFloat(slider.step) : null;
  let value = Number.isFinite(rawValue) ? rawValue : parseFloat(slider.value);

  value = Math.max(min, Math.min(max, value));

  if (step && Number.isFinite(step) && step > 0 && Number.isFinite(min)) {
    const steps = Math.round((value - min) / step);
    value = min + steps * step;
  }

  const precision = step && String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Number(value.toFixed(precision));
}

function commitValueInput(slider, valueInput, decimals) {
  const parsed = parseFloat(valueInput.value);
  const clamped = clampToSlider(parsed, slider);
  slider.value = String(clamped);
  valueInput.value = clamped.toFixed(decimals);
  scheduleLive();
}

CONTROL_DEFS.forEach(({ id, valueId, decimals }) => {
  const el = document.getElementById(id);
  if (valueId) {
    const badge = document.getElementById(valueId);
    badge.value = parseFloat(el.value).toFixed(decimals);
  }
  el.addEventListener('input', () => {
    if (valueId) {
      document.getElementById(valueId).value = parseFloat(el.value).toFixed(decimals);
    }
    scheduleLive();
  });
  el.addEventListener('change', scheduleLive);

  if (valueId) {
    const valueInput = document.getElementById(valueId);
    valueInput.addEventListener('change', () => commitValueInput(el, valueInput, decimals));
    valueInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitValueInput(el, valueInput, decimals);
        valueInput.blur();
      }
      if (event.key === 'Escape') {
        valueInput.value = parseFloat(el.value).toFixed(decimals);
        valueInput.blur();
      }
    });
  }
});

// ── Color swatches ────────────────────────────────────────────────────────
document.querySelectorAll('.color-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.remove('active');
      s.setAttribute('aria-pressed', 'false');
    });
    sw.classList.add('active');
    sw.setAttribute('aria-pressed', 'true');
    const val = sw.dataset.color;
    document.getElementById('custom-color-row').style.display = val === 'custom' ? 'flex' : 'none';
    if (val !== 'custom') selectedColor = val;
    else selectedColor = document.getElementById('custom-color').value;
    if (currentSVG) {
      renderSVGTab(currentSVG, currentTraceStats, currentMaskPreview);
      renderExportsTab(currentSVG);
    }
    scheduleLive();
  });
});
document.getElementById('custom-color').addEventListener('input', e => {
  selectedColor = e.target.value;
  if (currentSVG) {
    renderSVGTab(currentSVG, currentTraceStats, currentMaskPreview);
    renderExportsTab(currentSVG);
  }
  scheduleLive();
});

// ── File handling ─────────────────────────────────────────────────────────
// Images at or below this size (in either dimension) are already icon-sized
// on their own — a marquee-select step would add friction with no benefit,
// so they skip straight to the existing immediate-trace-ready flow. Larger
// images (the multi-icon sheet case this issue targets) go through the
// selection view instead.
const SELECT_SKIP_MAX_DIM = 256;

function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  // A fresh upload is not "editing" the previous crop — discard whatever
  // selection state was remembered for the prior image.
  lastUploadedSheet = null;
  lastCropRect = null;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      if (img.width <= SELECT_SKIP_MAX_DIM && img.height <= SELECT_SKIP_MAX_DIM) {
        finalizeImage(img, e.target.result);
      } else {
        openSelectionView(img);
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Same tail the pre-selection flow always ran on upload: set srcImage, swap
// the source-panel view to the thumbnail, enable tracing, auto-detect
// polarity, and kick off a live trace if enabled. Used both for the
// skip-selection path and after a marquee selection is confirmed and
// cropped — autoDetect runs on whichever image ends up here, so a cropped
// selection is characterized on its own pixels, not the full sheet's.
function finalizeImage(img, dataUrl) {
  srcImage = img;
  pendingImage = null;
  document.getElementById('dropzone').style.display = 'none';
  document.getElementById('select-wrap').style.display = 'none';
  document.getElementById('thumb-wrap').style.display = 'block';
  document.getElementById('thumb-img').src = dataUrl;
  document.getElementById('trace-btn').disabled = false;
  updateEditCropButton();
  setStatus('Loaded ' + img.width + '×' + img.height + 'px — ready to trace');
  autoDetect(img);
  scheduleLive();
}

// Shows "edit crop" only when there's an original sheet + prior crop to
// re-edit — i.e. this image actually went through the selection view.
// Images that skipped it (SELECT_SKIP_MAX_DIM) never set lastUploadedSheet,
// so the button stays hidden rather than reopening a broken/empty view.
const editCropBtn = document.getElementById('edit-crop-btn');
function updateEditCropButton() {
  editCropBtn.style.display = lastUploadedSheet ? '' : 'none';
}

function autoDetect(img) {
  const c = document.createElement('canvas');
  c.width = Math.min(img.width, 80);
  c.height = Math.min(img.height, 80);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    sum += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * a + 255 * (1 - a);
  }
  detectedInvert = (sum / (d.length / 4)) < 128;
}

// ── Marquee selection view ───────────────────────────────────────────────
// Fits the whole uploaded image into the left panel's width on open (fit-
// to-view default, viewZoom 1 — see the Zoom block below for #7's scroll/
// button zoom and space-drag pan on top of that). The user click-drags a
// free-form rectangle over the icon they want; coordinates are tracked in
// on-screen canvas pixels, then mapped back to true source-image pixels
// at confirm time (selectionRectToSourceRect, correct at any zoom/pan
// state) so the crop is always taken from the full-resolution source,
// never from the downscaled/zoomed display.
const MAX_SELECT_DISPLAY_WIDTH = 260;
const MIN_SELECT_PX = 6; // minimum on-screen drag size before a selection counts as non-trivial
const HANDLE_TOL = 8; // hit-test tolerance (canvas display px) around each corner handle

const selectCanvas = document.getElementById('select-canvas');
const selectRectEl = document.getElementById('select-rect');
const selectConfirmBtn = document.getElementById('select-confirm-btn');
const selectClearBtn = document.getElementById('select-clear-btn');
const selectChangeBtn = document.getElementById('select-change-btn');
const selectCrosshairBtn = document.getElementById('select-crosshair-btn');
const selectCenterBtn = document.getElementById('select-center-btn');
const selectAutoTrimBtn = document.getElementById('select-autotrim-btn');
const selectZoomOutBtn = document.getElementById('select-zoom-out-btn');
const selectZoomInBtn = document.getElementById('select-zoom-in-btn');
const selectZoomFitBtn = document.getElementById('select-zoom-fit-btn');
const selectZoomReadout = document.getElementById('select-zoom-readout');

let selectionBox = null; // {x,y,w,h} in select-canvas display pixels — the frame; stays fixed while panning
let dragOrigin = null; // origin point for a brand-new box drag
let dragMode = null; // 'new' | 'resize' | 'pan' | 'view-pan'
let resizeAnchor = null; // {x,y} — the corner opposite the one being dragged, stays fixed during a resize
let panDragStart = null; // {x,y,panX,panY} — mouse start + pan offset at start of a box-relative pan drag (#8)
let viewPanDragStart = null; // {x,y,panX,panY,sourceBoxRect} — same, for a whole-view pan drag (#7)
let imagePanX = 0; // image draw offset (canvas display px) at the current zoom
let imagePanY = 0;
let showCrosshair = false;

// Zoom (#7) — viewZoom is a multiplier on top of selectBaseScale (the
// fit-to-view scale computed once per openSelectionView call). 1 = fit to
// view, matching today's behavior for a single image. selectionBox stays
// expressed in canvas-display px (unchanged from #8) — whenever the view
// transform itself changes (zoom, or a whole-view pan), the box is
// reprojected through the old→new transform so it stays visually attached
// to the same source content instead of drifting. See
// displayRectToSourceRect/sourceRectToDisplayRect below.
const ZOOM_MIN = 1;
const ZOOM_MAX = 16;
const ZOOM_WHEEL_STEP = 1.2;
const ZOOM_BUTTON_STEP = 1.5;
const PAN_KEY_STEP = 40; // canvas display px per arrow-key press
let selectBaseScale = 1; // source px → canvas display px at viewZoom 1
let viewZoom = 1;
let spacePanning = false; // true while space is held — drag-anywhere pans the view

// #6 auto-trim — persists across selection-view sessions like showCrosshair
// (a sticky user preference, not per-image state), so it isn't silently
// reset by openSelectionView(). Defaults on: the whole point of the
// feature is that a loose selection is good enough, so the benefit should
// apply without the user having to discover and flip a switch first. Users
// with deliberate whitespace-in-selection needs (the documented non-goal)
// disable it with one click, same cost as the default-off alternative
// would have imposed on everyone else.
let autoTrimEnabled = true;

function openSelectionView(img) {
  pendingImage = img;
  imagePanX = 0;
  imagePanY = 0;
  viewZoom = 1;
  spacePanning = false;
  dragMode = null;
  viewPanDragStart = null;
  document.getElementById('dropzone').style.display = 'none';
  document.getElementById('thumb-wrap').style.display = 'none';
  document.getElementById('select-wrap').style.display = 'block';

  selectBaseScale = Math.min(1, MAX_SELECT_DISPLAY_WIDTH / img.width);
  selectCanvas.width = Math.max(1, Math.round(img.width * selectBaseScale));
  selectCanvas.height = Math.max(1, Math.round(img.height * selectBaseScale));
  redrawSelectCanvasBackground();

  clearSelectionBox();
  updateZoomReadout();
  setStatus('Drag to select a region, then confirm — scroll to zoom');
}

// Redraws the sheet image onto select-canvas at the current pan/zoom. The
// frame (selectionBox) is a separate absolutely-positioned overlay and
// never moves when this runs — only the pixels underneath it do.
function redrawSelectCanvasBackground() {
  if (!pendingImage) return;
  const ctx = selectCanvas.getContext('2d');
  ctx.clearRect(0, 0, selectCanvas.width, selectCanvas.height);
  const scale = selectBaseScale * viewZoom;
  ctx.drawImage(
    pendingImage, 0, 0, pendingImage.width, pendingImage.height,
    imagePanX, imagePanY, pendingImage.width * scale, pendingImage.height * scale
  );
}

// Clamps imagePanX/Y so the given box (canvas-display px) stays fully
// covered by drawn image content at the current zoom — panning stops once
// the image edge would reach the frame edge. This is #8's original pan
// model: the frame is fixed, only the content under it slides. Generalized
// here to use the current zoomed draw size instead of always assuming
// zoom 1 (previously destW/destH == selectCanvas.width/height always).
function clampPanToBox(box) {
  if (!box || !pendingImage) return;
  const scale = selectBaseScale * viewZoom;
  const destW = pendingImage.width * scale;
  const destH = pendingImage.height * scale;
  imagePanX = clamp(imagePanX, box.x + box.w - destW, box.x);
  imagePanY = clamp(imagePanY, box.y + box.h - destH, box.y);
}

// Clamps imagePanX/Y so the WHOLE canvas stays covered by drawn image
// content at the current zoom — the standard image-viewer pan clamp
// (#7), used whenever the view itself is being navigated (zoom, view-pan
// drag, keyboard pan) rather than nudging content under an existing
// frame. At viewZoom 1 this pins pan to (0,0), matching the pre-#7
// fit-to-view-only behavior exactly.
function clampPanToCanvas() {
  if (!pendingImage) return;
  const scale = selectBaseScale * viewZoom;
  const destW = pendingImage.width * scale;
  const destH = pendingImage.height * scale;
  imagePanX = clamp(imagePanX, selectCanvas.width - destW, 0);
  imagePanY = clamp(imagePanY, selectCanvas.height - destH, 0);
}

// Keeps a display-space box's coordinates sane after being reprojected
// through a transform change — defensive against float drift at extreme
// zoom/pan rather than anything expected to trigger in normal use.
function clampBoxToCanvas(box) {
  const x = clamp(box.x, 0, selectCanvas.width);
  const y = clamp(box.y, 0, selectCanvas.height);
  return {
    x, y,
    w: clamp(box.w, 0, selectCanvas.width - x),
    h: clamp(box.h, 0, selectCanvas.height - y),
  };
}

// ── View transform (zoom/pan) — screen ⇄ source coordinate mapping ──────
// selectBaseScale * viewZoom is the current source-px → canvas-display-px
// scale; imagePanX/Y is the draw offset at that scale. Together these are
// the single source of truth for every screen↔source conversion below.

function displayToSourcePoint(dx, dy) {
  const scale = selectBaseScale * viewZoom;
  return { x: (dx - imagePanX) / scale, y: (dy - imagePanY) / scale };
}

function sourceToDisplayPoint(sx, sy) {
  const scale = selectBaseScale * viewZoom;
  return { x: sx * scale + imagePanX, y: sy * scale + imagePanY };
}

// Raw (unrounded) display-rect → source-rect. Used internally to keep the
// selection box visually attached to the same source content while the
// view transform changes — rounding here would cause visible jitter on
// every drag tick or wheel notch.
function displayRectToSourceRect(rect) {
  const p1 = displayToSourcePoint(rect.x, rect.y);
  const p2 = displayToSourcePoint(rect.x + rect.w, rect.y + rect.h);
  return { sx: p1.x, sy: p1.y, sw: p2.x - p1.x, sh: p2.y - p1.y };
}

function sourceRectToDisplayRect(rect) {
  const p1 = sourceToDisplayPoint(rect.sx, rect.sy);
  const p2 = sourceToDisplayPoint(rect.sx + rect.sw, rect.sy + rect.sh);
  return { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y };
}

// Public mapping: a display-space selection rect → true, integer,
// bounds-clamped source-image pixels, correct at any zoom/pan state. This
// is the one function anything downstream of the selection view — the
// confirm handler below, and #6 (auto-trim) after it — should call rather
// than re-deriving the scale/pan math directly.
function selectionRectToSourceRect(rect) {
  if (!pendingImage) return null;
  const raw = displayRectToSourceRect(rect);
  const sw = Math.max(1, Math.min(pendingImage.width, Math.round(raw.sw)));
  const sh = Math.max(1, Math.min(pendingImage.height, Math.round(raw.sh)));
  const sx = clamp(Math.round(raw.sx), 0, pendingImage.width - sw);
  const sy = clamp(Math.round(raw.sy), 0, pendingImage.height - sh);
  return { sx, sy, sw, sh };
}

// Applies a new absolute zoom level, keeping the given canvas-display
// anchor point stationary on screen (cursor-centered when called from the
// wheel handler; canvas-centered from the zoom buttons/keyboard/Fit). Any
// existing selection box is reprojected so it stays attached to the same
// source content through the zoom change.
function applyZoom(newZoomRaw, anchor) {
  if (!pendingImage) return;
  const newZoom = clamp(newZoomRaw, ZOOM_MIN, ZOOM_MAX);
  const sourceAnchor = displayToSourcePoint(anchor.x, anchor.y);
  const sourceBoxRect = selectionBox ? displayRectToSourceRect(selectionBox) : null;

  viewZoom = newZoom;
  const scale = selectBaseScale * viewZoom;
  imagePanX = anchor.x - sourceAnchor.x * scale;
  imagePanY = anchor.y - sourceAnchor.y * scale;
  clampPanToCanvas();

  if (sourceBoxRect) selectionBox = clampBoxToCanvas(sourceRectToDisplayRect(sourceBoxRect));
  redrawSelectCanvasBackground();
  updateSelectRectEl();
  updateZoomReadout();
}

function zoomBy(factor, anchor) {
  applyZoom(viewZoom * factor, anchor || { x: selectCanvas.width / 2, y: selectCanvas.height / 2 });
}

// Whole-view pan by a fixed canvas-display-px delta (keyboard arrow keys).
// Same reprojection treatment as applyZoom so an existing box stays put
// relative to its content.
function panViewBy(dx, dy) {
  if (!pendingImage) return;
  const sourceBoxRect = selectionBox ? displayRectToSourceRect(selectionBox) : null;
  imagePanX += dx;
  imagePanY += dy;
  clampPanToCanvas();
  if (sourceBoxRect) selectionBox = clampBoxToCanvas(sourceRectToDisplayRect(sourceBoxRect));
  redrawSelectCanvasBackground();
  updateSelectRectEl();
}

function updateZoomReadout() {
  selectZoomReadout.textContent = Math.round(viewZoom * 100) + '%';
  selectZoomOutBtn.disabled = viewZoom <= ZOOM_MIN + 1e-6;
  selectZoomInBtn.disabled = viewZoom >= ZOOM_MAX - 1e-6;
}

function isFormField(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function clearSelectionBox() {
  selectionBox = null;
  dragOrigin = null;
  dragMode = null;
  redrawSelectCanvasBackground();
  selectRectEl.style.display = 'none';
  selectConfirmBtn.disabled = true;
}

function updateSelectRectEl() {
  if (!selectionBox) { selectRectEl.style.display = 'none'; return; }
  selectRectEl.style.display = 'block';
  selectRectEl.style.left = selectionBox.x + 'px';
  selectRectEl.style.top = selectionBox.y + 'px';
  selectRectEl.style.width = selectionBox.w + 'px';
  selectRectEl.style.height = selectionBox.h + 'px';
  selectRectEl.classList.toggle('show-crosshair', showCrosshair);
}

function eventToCanvasPoint(e) {
  const rect = selectCanvas.getBoundingClientRect();
  const scaleX = selectCanvas.width / rect.width;
  const scaleY = selectCanvas.height / rect.height;
  return {
    x: clamp((e.clientX - rect.left) * scaleX, 0, selectCanvas.width),
    y: clamp((e.clientY - rect.top) * scaleY, 0, selectCanvas.height),
  };
}

// Which corner handle (if any) a canvas point is within tolerance of.
function hitTestHandle(p) {
  if (!selectionBox) return null;
  const corners = {
    nw: { x: selectionBox.x, y: selectionBox.y },
    ne: { x: selectionBox.x + selectionBox.w, y: selectionBox.y },
    sw: { x: selectionBox.x, y: selectionBox.y + selectionBox.h },
    se: { x: selectionBox.x + selectionBox.w, y: selectionBox.y + selectionBox.h },
  };
  for (const name of Object.keys(corners)) {
    const c = corners[name];
    if (Math.abs(p.x - c.x) <= HANDLE_TOL && Math.abs(p.y - c.y) <= HANDLE_TOL) return name;
  }
  return null;
}

function pointInBox(p) {
  return !!selectionBox &&
    p.x >= selectionBox.x && p.x <= selectionBox.x + selectionBox.w &&
    p.y >= selectionBox.y && p.y <= selectionBox.y + selectionBox.h;
}

// Hover feedback only (not part of any drag) — signals which of the four
// interactions (view-pan / resize / pan / new-box) a mousedown here would
// start. Space-held (or an implicit middle-click) always means "pan the
// view", regardless of what's under the cursor — same convention as
// Photoshop/Figma/Illustrator's hold-to-pan, chosen so it never collides
// with plain left-drag drawing a new marquee.
selectCanvas.addEventListener('mousemove', e => {
  if (dragMode) return;
  if (spacePanning) { selectCanvas.style.cursor = 'grab'; return; }
  const p = eventToCanvasPoint(e);
  const handle = hitTestHandle(p);
  if (handle) {
    selectCanvas.style.cursor = (handle === 'nw' || handle === 'se') ? 'nwse-resize' : 'nesw-resize';
  } else if (pointInBox(p)) {
    selectCanvas.style.cursor = 'move';
  } else {
    selectCanvas.style.cursor = 'crosshair';
  }
});

selectCanvas.addEventListener('mousedown', e => {
  if (!pendingImage) return;
  e.preventDefault();
  const p = eventToCanvasPoint(e);

  if (spacePanning || e.button === 1) {
    dragMode = 'view-pan';
    viewPanDragStart = {
      x: p.x, y: p.y, panX: imagePanX, panY: imagePanY,
      sourceBoxRect: selectionBox ? displayRectToSourceRect(selectionBox) : null,
    };
    selectCanvas.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onSelectDrag);
    document.addEventListener('mouseup', onSelectDragEnd);
    return;
  }

  const handle = hitTestHandle(p);

  if (handle) {
    dragMode = 'resize';
    const opposite = {
      nw: { x: selectionBox.x + selectionBox.w, y: selectionBox.y + selectionBox.h },
      ne: { x: selectionBox.x, y: selectionBox.y + selectionBox.h },
      sw: { x: selectionBox.x + selectionBox.w, y: selectionBox.y },
      se: { x: selectionBox.x, y: selectionBox.y },
    }[handle];
    resizeAnchor = opposite;
  } else if (pointInBox(p)) {
    dragMode = 'pan';
    panDragStart = { x: p.x, y: p.y, panX: imagePanX, panY: imagePanY };
  } else {
    dragMode = 'new';
    dragOrigin = p;
    selectionBox = { x: p.x, y: p.y, w: 0, h: 0 };
  }
  updateSelectRectEl();
  document.addEventListener('mousemove', onSelectDrag);
  document.addEventListener('mouseup', onSelectDragEnd);
});

// Middle-click alone (no drag) shouldn't open the OS autoscroll icon or
// context menu in browsers that treat it that way.
selectCanvas.addEventListener('auxclick', e => {
  if (e.button === 1) e.preventDefault();
});

function onSelectDrag(e) {
  const p = eventToCanvasPoint(e);

  if (dragMode === 'new') {
    if (!dragOrigin) return;
    selectionBox = {
      x: Math.min(dragOrigin.x, p.x),
      y: Math.min(dragOrigin.y, p.y),
      w: Math.abs(p.x - dragOrigin.x),
      h: Math.abs(p.y - dragOrigin.y),
    };
  } else if (dragMode === 'resize') {
    if (!resizeAnchor) return;
    // Never shrink below MIN_SELECT_PX while dragging — keeps the box
    // anchored to the fixed opposite corner instead of needing a
    // post-drag correction.
    const nw = Math.max(Math.abs(p.x - resizeAnchor.x), MIN_SELECT_PX);
    const nh = Math.max(Math.abs(p.y - resizeAnchor.y), MIN_SELECT_PX);
    const dirX = p.x >= resizeAnchor.x ? 1 : -1;
    const dirY = p.y >= resizeAnchor.y ? 1 : -1;
    let nx = dirX === 1 ? resizeAnchor.x : resizeAnchor.x - nw;
    let ny = dirY === 1 ? resizeAnchor.y : resizeAnchor.y - nh;
    nx = clamp(nx, 0, selectCanvas.width - nw);
    ny = clamp(ny, 0, selectCanvas.height - nh);
    selectionBox = { x: nx, y: ny, w: nw, h: nh };
    clampPanToBox(selectionBox);
    redrawSelectCanvasBackground();
  } else if (dragMode === 'pan') {
    if (!panDragStart) return;
    imagePanX = panDragStart.panX + (p.x - panDragStart.x);
    imagePanY = panDragStart.panY + (p.y - panDragStart.y);
    clampPanToBox(selectionBox);
    redrawSelectCanvasBackground();
  } else if (dragMode === 'view-pan') {
    if (!viewPanDragStart) return;
    imagePanX = viewPanDragStart.panX + (p.x - viewPanDragStart.x);
    imagePanY = viewPanDragStart.panY + (p.y - viewPanDragStart.y);
    clampPanToCanvas();
    if (viewPanDragStart.sourceBoxRect) {
      selectionBox = clampBoxToCanvas(sourceRectToDisplayRect(viewPanDragStart.sourceBoxRect));
    }
    redrawSelectCanvasBackground();
  }
  updateSelectRectEl();
}

function onSelectDragEnd() {
  document.removeEventListener('mousemove', onSelectDrag);
  document.removeEventListener('mouseup', onSelectDragEnd);

  if (dragMode === 'new') {
    const valid = selectionBox && selectionBox.w >= MIN_SELECT_PX && selectionBox.h >= MIN_SELECT_PX;
    if (!valid) {
      selectionBox = null;
    } else {
      clampPanToBox(selectionBox);
    }
    selectConfirmBtn.disabled = !valid;
    updateSelectRectEl();
  }
  // 'resize' and 'pan' drags only ever run against an already-valid
  // selectionBox, so confirm stays enabled and no correction is needed.

  if (dragMode === 'view-pan') {
    selectCanvas.style.cursor = spacePanning ? 'grab' : 'crosshair';
  }

  dragOrigin = null;
  dragMode = null;
  resizeAnchor = null;
  panDragStart = null;
  viewPanDragStart = null;
}

selectClearBtn.addEventListener('click', clearSelectionBox);

selectChangeBtn.addEventListener('click', () => {
  document.getElementById('file-input2').click();
});

selectCrosshairBtn.addEventListener('click', () => {
  showCrosshair = !showCrosshair;
  selectCrosshairBtn.classList.toggle('active', showCrosshair);
  selectCrosshairBtn.setAttribute('aria-pressed', String(showCrosshair));
  updateSelectRectEl();
});

selectAutoTrimBtn.addEventListener('click', () => {
  autoTrimEnabled = !autoTrimEnabled;
  selectAutoTrimBtn.classList.toggle('active', autoTrimEnabled);
  selectAutoTrimBtn.setAttribute('aria-pressed', String(autoTrimEnabled));
});

// One-shot re-center: finds the subject's bounding box within the currently
// visible frame region (reusing the same Otsu-threshold + mask primitives
// the main trace pipeline uses) and pans the image so that box is centered
// under the frame. Not an ongoing snap — runs once per click.
selectCenterBtn.addEventListener('click', () => {
  if (!pendingImage || !selectionBox) return;
  centerSubjectInFrame();
});

function centerSubjectInFrame() {
  const ctx = selectCanvas.getContext('2d');
  const fx = Math.round(selectionBox.x);
  const fy = Math.round(selectionBox.y);
  const fw = Math.max(1, Math.round(selectionBox.w));
  const fh = Math.max(1, Math.round(selectionBox.h));
  const frameData = ctx.getImageData(fx, fy, fw, fh);

  const luminance = new Uint8Array(fw * fh);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, px = 0; i < frameData.data.length; i += 4, px++) {
    const alpha = frameData.data[i + 3] / 255;
    const lum = (frameData.data[i] * 0.299 + frameData.data[i + 1] * 0.587 + frameData.data[i + 2] * 0.114) * alpha + 255 * (1 - alpha);
    const rounded = Math.max(0, Math.min(255, Math.round(lum)));
    luminance[px] = rounded;
    hist[rounded]++;
    sum += rounded;
  }

  // Same auto-polarity heuristic as autoDetect(): a mostly-dark visible
  // region means the background is dark and the subject is the lighter
  // pixels, and vice versa.
  const threshold = computeOtsuThreshold(hist, luminance.length);
  const invert = (sum / luminance.length) < 128;
  const mask = buildMask(luminance, fw, fh, threshold, invert);

  let minX = fw;
  let minY = fh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      if (mask[y * fw + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return; // no distinguishable subject — leave framing as-is

  const subjectCx = (minX + maxX + 1) / 2;
  const subjectCy = (minY + maxY + 1) / 2;
  imagePanX += fw / 2 - subjectCx;
  imagePanY += fh / 2 - subjectCy;
  clampPanToBox(selectionBox);
  redrawSelectCanvasBackground();
  updateSelectRectEl();
}

// ── Auto-trim (#6) ────────────────────────────────────────────────────────
// Tightens a loose marquee selection to the bounding box of non-background
// content found inside it. Reuses the same lightweight luminance + Otsu-
// threshold + buildMask detection as centerSubjectInFrame just above,
// rather than the full preprocessImageData trace pipeline — that pipeline
// applies trace-only settings (despeckle, hole-preservation, upscale) that
// have nothing to do with finding a subject's extent and would make the
// trim result depend on whatever the Trace panel's sliders currently say.
//
// Deliberately operates on true source-image pixels — drawn fresh into an
// offscreen canvas from pendingImage — rather than reading back from
// select-canvas the way centerSubjectInFrame does. centerSubjectInFrame
// only needs to *pan* the view, so display-resolution pixels are fine; a
// *trim* decides the actual crop bounds, so it must be correct at whatever
// zoom the user happened to be at when they clicked confirm (#7), not
// degrade with the display's downscale.
const AUTO_TRIM_MARGIN_PX = 2; // small breathing room left around the detected bbox, in source px

function autoTrimSourceRect(sx, sy, sw, sh) {
  const c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext('2d');
  ctx.drawImage(pendingImage, sx, sy, sw, sh, 0, 0, sw, sh);
  const frameData = ctx.getImageData(0, 0, sw, sh);

  const luminance = new Uint8Array(sw * sh);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, px = 0; i < frameData.data.length; i += 4, px++) {
    const alpha = frameData.data[i + 3] / 255;
    const lum = (frameData.data[i] * 0.299 + frameData.data[i + 1] * 0.587 + frameData.data[i + 2] * 0.114) * alpha + 255 * (1 - alpha);
    const rounded = Math.max(0, Math.min(255, Math.round(lum)));
    luminance[px] = rounded;
    hist[rounded]++;
    sum += rounded;
  }

  // Same auto-polarity heuristic as autoDetect()/centerSubjectInFrame: a
  // mostly-dark selection means the background is dark and the subject is
  // the lighter pixels, and vice versa.
  const threshold = computeOtsuThreshold(hist, luminance.length);
  const invert = (sum / luminance.length) < 128;
  const mask = buildMask(luminance, sw, sh, threshold, invert);

  let minX = sw, minY = sh, maxX = -1, maxY = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (mask[y * sw + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // No distinguishable subject (e.g. a uniform-color selection, or the
  // whole frame is above/below threshold) — leave the loose rect as-is
  // rather than collapsing to nothing or guessing.
  if (maxX < minX || maxY < minY) return { sx, sy, sw, sh };

  const tx0 = clamp(minX - AUTO_TRIM_MARGIN_PX, 0, sw - 1);
  const ty0 = clamp(minY - AUTO_TRIM_MARGIN_PX, 0, sh - 1);
  const tx1 = clamp(maxX + AUTO_TRIM_MARGIN_PX, 0, sw - 1);
  const ty1 = clamp(maxY + AUTO_TRIM_MARGIN_PX, 0, sh - 1);

  return {
    sx: sx + tx0,
    sy: sy + ty0,
    sw: tx1 - tx0 + 1,
    sh: ty1 - ty0 + 1,
  };
}

// ── Zoom / pan the sheet view (#7) ───────────────────────────────────────
// Scroll-wheel zoom, centered on the cursor. Guarded against an in-progress
// drag so a wheel notch mid-resize/pan can't fight with the mouse.
selectCanvas.addEventListener('wheel', e => {
  if (!pendingImage || dragMode) return;
  e.preventDefault();
  const factor = Math.pow(ZOOM_WHEEL_STEP, -Math.sign(e.deltaY));
  zoomBy(factor, eventToCanvasPoint(e));
}, { passive: false });

selectZoomInBtn.addEventListener('click', () => zoomBy(ZOOM_BUTTON_STEP));
selectZoomOutBtn.addEventListener('click', () => zoomBy(1 / ZOOM_BUTTON_STEP));
selectZoomFitBtn.addEventListener('click', () => {
  applyZoom(1, { x: selectCanvas.width / 2, y: selectCanvas.height / 2 });
});

// Keyboard equivalents on the canvas itself: +/- zoom, 0 resets to fit,
// arrow keys pan (a no-op at fit-to-view, where clampPanToCanvas pins pan
// to 0). The zoom buttons above are the primary keyboard path — this is a
// secondary affordance for anyone tabbed into the canvas directly.
selectCanvas.addEventListener('keydown', e => {
  if (!pendingImage) return;
  let handled = true;
  if (e.key === '+' || e.key === '=') zoomBy(ZOOM_BUTTON_STEP);
  else if (e.key === '-' || e.key === '_') zoomBy(1 / ZOOM_BUTTON_STEP);
  else if (e.key === '0') applyZoom(1, { x: selectCanvas.width / 2, y: selectCanvas.height / 2 });
  else if (e.key === 'ArrowLeft') panViewBy(-PAN_KEY_STEP, 0);
  else if (e.key === 'ArrowRight') panViewBy(PAN_KEY_STEP, 0);
  else if (e.key === 'ArrowUp') panViewBy(0, -PAN_KEY_STEP);
  else if (e.key === 'ArrowDown') panViewBy(0, PAN_KEY_STEP);
  else handled = false;
  if (handled) e.preventDefault();
});

// Space held = pan-anywhere mode (mousedown handler above checks
// spacePanning), matching the standard hold-to-pan convention used by
// Photoshop/Figma/Illustrator. Scoped to while the selection view is open
// and guarded against form fields so it doesn't hijack space's normal
// behavior (activating a focused button, typing a space) elsewhere on the
// page. Also exempts BUTTON — isFormField alone (INPUT/SELECT/TEXTAREA)
// didn't actually cover the "activating a focused button" case this
// comment always claimed to handle: a focused select-tools button (the #6
// auto-trim toggle included) would have its native Space-activation
// silently eaten by this handler's preventDefault() otherwise. Discovered
// while keyboard-testing #6's new toggle button.
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || !pendingImage || isFormField(e.target) || e.target.tagName === 'BUTTON') return;
  if (!spacePanning) {
    spacePanning = true;
    if (!dragMode) selectCanvas.style.cursor = 'grab';
  }
  e.preventDefault();
});
document.addEventListener('keyup', e => {
  if (e.code !== 'Space') return;
  spacePanning = false;
  if (!dragMode) selectCanvas.style.cursor = 'crosshair';
});

selectConfirmBtn.addEventListener('click', () => {
  if (!pendingImage || !selectionBox) return;

  // Map the on-screen selection back to true source-image pixels via the
  // single screen→source mapping function (selectionRectToSourceRect,
  // defined above with the rest of the view-transform helpers) — correct
  // regardless of the current pan/zoom state (#7), not just the pre-#7
  // fixed-scale case.
  let { sx, sy, sw, sh } = selectionRectToSourceRect(selectionBox);

  // #6: tighten to the subject's bounding box within that source rect.
  // Runs after the screen→source mapping above, on true source pixels, so
  // trim tightness never depends on the zoom/pan state the user happened
  // to be at when confirming. Re-running this on an already-trimmed rect
  // (e.g. confirming "Edit crop" unchanged, #9) is idempotent — the
  // detected bbox converges to the same margin-padded rect it started
  // from — so no special-casing is needed to avoid it "double-trimming".
  if (autoTrimEnabled) {
    ({ sx, sy, sw, sh } = autoTrimSourceRect(sx, sy, sw, sh));
  }

  // Remember the original sheet and this crop rect (true source pixels) so
  // "Edit crop" can reopen the selection view pre-filled later — separate
  // from pendingImage, which finalizeImage() is about to null out.
  lastUploadedSheet = pendingImage;
  lastCropRect = { sx, sy, sw, sh };

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = sw;
  cropCanvas.height = sh;
  cropCanvas.getContext('2d').drawImage(pendingImage, sx, sy, sw, sh, 0, 0, sw, sh);

  const dataUrl = cropCanvas.toDataURL('image/png');
  const cropped = new Image();
  cropped.onload = () => finalizeImage(cropped, dataUrl);
  cropped.src = dataUrl;
});

// Reopens the selection view on the original sheet, pre-filling the frame
// with the previously confirmed crop rect (converted from source pixels
// back to the fresh view's display pixels) so the user is adjusting their
// prior selection rather than starting over. Uses the same openSelectionView
// a fresh large upload goes through — no new interaction code, this just
// pre-seeds state the existing drag/resize/pan/crosshair/center code already
// knows how to work with.
editCropBtn.addEventListener('click', () => {
  if (!lastUploadedSheet) return;
  // openSelectionView() always resets to fit-to-view (viewZoom 1, pan 0,
  // per #7) — re-editing a crop reopens at that same default rather than
  // restoring whatever zoom/pan was active when it was originally
  // confirmed. Pre-filling the box is a plain source→display projection
  // at that fit-to-view scale (selectBaseScale, i.e. viewZoom 1).
  openSelectionView(lastUploadedSheet);
  if (lastCropRect) {
    selectionBox = sourceRectToDisplayRect(lastCropRect);
    updateSelectRectEl();
    selectConfirmBtn.disabled = false;
  }
});

['file-input', 'file-input2'].forEach(id => {
  document.getElementById(id).addEventListener('change', e => handleFile(e.target.files[0]));
});

const dz = document.getElementById('dropzone');
dz.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.getElementById('file-input').click();
  }
});
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

// ── Status ────────────────────────────────────────────────────────────────
function setStatus(msg, cls) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = cls || '';
}

// ── Main trace ────────────────────────────────────────────────────────────
document.getElementById('trace-btn').addEventListener('click', async () => {
  if (!srcImage) return;
  setLoading(true);
  setStatus('Preparing mask…');
  await tick();

  try {
    const canvas = document.getElementById('work-canvas');
    canvas.width = srcImage.naturalWidth;
    canvas.height = srcImage.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(srcImage, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const settings = readSettings();

    const invertSel = settings.invert;
    const doInvert = invertSel === 'auto' ? detectedInvert : invertSel === '1';

    const processed = preprocessImageData(imageData, settings, doInvert);

    setStatus('Tracing cleaned silhouette…');
    await tick();

    const traceOptions = buildTraceOptions(settings);
    const tracedata = ImageTracer.imagedataToTracedata(processed.imageData, traceOptions);
    const svgStr = ImageTracer.getsvgstring(tracedata, traceOptions);
    const cleaned = cleanupSVG(svgStr, selectedColor, canvas.width, canvas.height, settings.pathSimplify);
    const stats = collectTraceStats(tracedata, cleaned, processed);

    currentSVG = cleaned;
    currentMaskPreview = processed.previewUrl;
    currentTraceStats = stats;

    pushHistory({
      settings: snapshotSettings(),
      svgString: cleaned,
      maskPreviewUrl: processed.previewUrl,
      stats,
    });

    renderSVGTab(cleaned, stats, processed.previewUrl);
    await renderExportsTab(cleaned);

    setLoading(false);
    setStatus('Done — SVG ready ✓', 'ok');

    document.querySelector('[data-tab="svg"]').click();
  } catch (err) {
    console.error(err);
    setLoading(false);
    setStatus('Error: ' + err.message, 'err');
  }
});

function tick() {
  return new Promise(r => setTimeout(r, 16));
}

function setLoading(on) {
  document.getElementById('spinner').style.display = on ? 'block' : 'none';
  document.getElementById('trace-lbl').textContent = on ? 'Tracing…' : '↗ Trace to SVG';
  document.getElementById('trace-btn').disabled = on;
}

function readSettings() {
  return {
    thresholdMode: document.getElementById('threshold-mode').value,
    threshold: parseInt(document.getElementById('threshold').value, 10),
    thresholdBias: parseInt(document.getElementById('threshold-bias').value, 10),
    despeckle: parseInt(document.getElementById('despeckle').value, 10),
    holePreservation: parseInt(document.getElementById('hole-preservation').value, 10),
    cornerSmoothing: parseInt(document.getElementById('corner-smoothing').value, 10),
    curveFit: parseFloat(document.getElementById('curve-fit').value),
    pathSimplify: parseInt(document.getElementById('path-simplify').value, 10),
    upscaleFactor: parseInt(document.getElementById('upscale-factor').value, 10),
    invert: document.getElementById('invert').value,
  };
}

function preprocessImageData(imgData, settings, invert) {
  const luminance = new Uint8Array(imgData.width * imgData.height);
  const hist = new Uint32Array(256);

  for (let i = 0, px = 0; i < imgData.data.length; i += 4, px++) {
    const alpha = imgData.data[i + 3] / 255;
    const lum = (imgData.data[i] * 0.299 + imgData.data[i + 1] * 0.587 + imgData.data[i + 2] * 0.114) * alpha + 255 * (1 - alpha);
    const rounded = Math.max(0, Math.min(255, Math.round(lum)));
    luminance[px] = rounded;
    hist[rounded]++;
  }

  const autoThreshold = computeOtsuThreshold(hist, luminance.length);
  const resolvedThreshold = clamp(
    settings.thresholdMode === 'auto' ? autoThreshold + settings.thresholdBias : settings.threshold,
    1,
    254
  );

  let mask = buildMask(luminance, imgData.width, imgData.height, resolvedThreshold, invert);

  if (settings.cornerSmoothing > 0) {
    const prePasses = Math.max(1, Math.floor(settings.cornerSmoothing / 2));
    mask = smoothMask(mask, imgData.width, imgData.height, prePasses);
  }

  if (settings.despeckle > 0) {
    mask = removeSmallComponents(mask, imgData.width, imgData.height, settings.despeckle);
  }

  if (settings.holePreservation > 0) {
    mask = fillSmallHoles(mask, imgData.width, imgData.height, settings.holePreservation);
  }

  if (settings.cornerSmoothing > 1) {
    mask = smoothMask(mask, imgData.width, imgData.height, settings.cornerSmoothing - 1);
  }

  mask = refineMaskEdges(mask, imgData.width, imgData.height, settings.cornerSmoothing);

  // Coverage is measured on the natural-resolution mask, before any
  // upscaling — despeckle/hole-preservation area thresholds above are
  // already in natural-resolution mask-pixel units, so this keeps the
  // reported ratio meaningful regardless of upscale factor.
  const filledPixels = countFilledPixels(mask);
  const coverage = filledPixels / mask.length;

  // Perceptual upscale (Scale2x/3x family, js/upscale.js) runs here — on
  // the final cleaned binary mask, not the raw grayscale source. A 2-color
  // mask is exactly the kind of discrete, sharp-edge pixel data this
  // algorithm family is designed for, and running it after despeckle/hole
  // fill means those passes never need factor-aware area thresholds. The
  // upscaled mask (not the natural-resolution one) is what gets rasterized
  // below and handed to ImageTracer, which is what gives ImageTracer extra
  // coordinate resolution to fit smoother curves against (supersampled
  // tracing) — cleanupSVG's viewBox/width/height split then scales the
  // traced result back down to natural size for display/export.
  let maskWidth = imgData.width;
  let maskHeight = imgData.height;
  const upscaleFactor = settings.upscaleFactor || 1;

  if (upscaleFactor > 1) {
    const upscaled = Upscale.upscaleMask(mask, maskWidth, maskHeight, upscaleFactor);
    mask = upscaled.data;
    maskWidth = upscaled.width;
    maskHeight = upscaled.height;
  }

  const imageData = maskToImageData(mask, maskWidth, maskHeight);
  const previewUrl = makePreviewURL(imageData);

  return {
    imageData,
    resolvedThreshold,
    autoThreshold,
    coverage,
    maskPreviewUrl: previewUrl,
    previewUrl,
    maskWidth,
    maskHeight,
    upscaleFactor,
  };
}

function buildTraceOptions(settings) {
  const pathSimplify = settings.pathSimplify;
  const ltres = 0.25 + pathSimplify * 0.18;
  const qtres = 0.25 + settings.curveFit * 0.9;
  const pathomit = Math.max(0, Math.floor(settings.despeckle / 12));

  return {
    colorsampling: 0,
    numberofcolors: 2,
    ltres,
    qtres,
    pathomit,
    roundcoords: pathSimplify >= 18 ? 1 : 2,
    desc: false,
    viewbox: true,
    linefilter: false,
    rightangleenhance: settings.cornerSmoothing < 2,
    pal: [
      { r: 0, g: 0, b: 0, a: 255 },
      { r: 255, g: 255, b: 255, a: 255 },
    ],
  };
}

function buildMask(luminance, width, height, threshold, invert) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < luminance.length; i++) {
    let dark = luminance[i] < threshold;
    if (invert) dark = !dark;
    mask[i] = dark ? 1 : 0;
  }
  return mask;
}

function computeOtsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let weightB = 0;
  let maxVariance = -1;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;

    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  return threshold;
}

function smoothMask(mask, width, height, passes) {
  let current = mask;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            sum += current[ny * width + nx];
          }
        }
        const idx = y * width + x;
        if (current[idx]) {
          next[idx] = sum >= 4 ? 1 : 0;
        } else {
          next[idx] = sum >= 6 ? 1 : 0;
        }
      }
    }
    current = next;
  }
  return current;
}

function morphMask(mask, width, height, mode, passes) {
  let current = mask;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        let sum = 0;
        let samples = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            samples++;
            sum += current[ny * width + nx];
          }
        }
        next[idx] = mode === 'dilate' ? (sum > 0 ? 1 : 0) : (sum === samples ? 1 : 0);
      }
    }
    current = next;
  }
  return current;
}

function refineMaskEdges(mask, width, height, strength) {
  if (strength < 2) return mask;
  const passes = Math.max(1, Math.floor((strength - 1) / 2));
  let refined = morphMask(mask, width, height, 'dilate', passes);
  refined = morphMask(refined, width, height, 'erode', passes);
  if (strength >= 3) {
    refined = morphMask(refined, width, height, 'erode', 1);
    refined = morphMask(refined, width, height, 'dilate', 1);
  }
  return refined;
}

function removeSmallComponents(mask, width, height, maxArea) {
  const next = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start++) {
    if (!next[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    const cells = [];

    while (head < tail) {
      const idx = queue[head++];
      cells.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);

      if (x > 0) visitNeighbor(idx - 1);
      if (x < width - 1) visitNeighbor(idx + 1);
      if (y > 0) visitNeighbor(idx - width);
      if (y < height - 1) visitNeighbor(idx + width);
      if (x > 0 && y > 0) visitNeighbor(idx - width - 1);
      if (x < width - 1 && y > 0) visitNeighbor(idx - width + 1);
      if (x > 0 && y < height - 1) visitNeighbor(idx + width - 1);
      if (x < width - 1 && y < height - 1) visitNeighbor(idx + width + 1);
    }

    if (cells.length <= maxArea) {
      cells.forEach(idx => { next[idx] = 0; });
    }

    function visitNeighbor(nIdx) {
      if (!next[nIdx] || visited[nIdx]) return;
      visited[nIdx] = 1;
      queue[tail++] = nIdx;
    }
  }

  return next;
}

function fillSmallHoles(mask, width, height, maxArea) {
  const next = new Uint8Array(mask);
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < next.length; start++) {
    if (next[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    let touchesBorder = false;
    const cells = [];

    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const idx = queue[head++];
      cells.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true;
      }

      if (x > 0) visitNeighbor(idx - 1);
      if (x < width - 1) visitNeighbor(idx + 1);
      if (y > 0) visitNeighbor(idx - width);
      if (y < height - 1) visitNeighbor(idx + width);
    }

    if (!touchesBorder && cells.length <= maxArea) {
      cells.forEach(idx => { next[idx] = 1; });
    }

    function visitNeighbor(nIdx) {
      if (next[nIdx] || visited[nIdx]) return;
      visited[nIdx] = 1;
      queue[tail++] = nIdx;
    }
  }

  return next;
}

function countFilledPixels(mask) {
  let filled = 0;
  for (let i = 0; i < mask.length; i++) filled += mask[i];
  return filled;
}

function maskToImageData(mask, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 0 : 255;
    const idx = i * 4;
    data[idx] = v;
    data[idx + 1] = v;
    data[idx + 2] = v;
    data[idx + 3] = 255;
  }
  return { width, height, data };
}

function makePreviewURL(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(new ImageData(imageData.data, imageData.width, imageData.height), 0, 0);
  return canvas.toDataURL('image/png');
}

function collectTraceStats(tracedata, svgStr, processed) {
  const darkestLayerIndex = findDarkestLayerIndex(tracedata.palette);
  const layer = tracedata.layers[darkestLayerIndex] || [];
  let pathCount = 0;
  let holeCount = 0;
  let segmentCount = 0;

  layer.forEach(path => {
    if (!path.isholepath) pathCount++;
    holeCount += path.holechildren ? path.holechildren.length : 0;
    segmentCount += path.segments ? path.segments.length : 0;
  });

  return {
    resolvedThreshold: processed.resolvedThreshold,
    autoThreshold: processed.autoThreshold,
    coverage: processed.coverage,
    pathCount,
    holeCount,
    segmentCount,
    byteSize: new Blob([svgStr]).size,
    upscaleFactor: processed.upscaleFactor,
    maskWidth: processed.maskWidth,
    maskHeight: processed.maskHeight,
  };
}

function findDarkestLayerIndex(palette) {
  let bestIndex = 0;
  let bestLum = Infinity;
  palette.forEach((color, index) => {
    const lum = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
    if (lum < bestLum) {
      bestLum = lum;
      bestIndex = index;
    }
  });
  return bestIndex;
}

// ── Post-process SVG: cleanup, merge fills, normalize ────────────────────
function cleanupSVG(svgStr, color, origW, origH, pathSimplify) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgStr, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) return svgStr;

  const viewBox = svg.getAttribute('viewBox') || ('0 0 ' + origW + ' ' + origH);
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(origW));
  svg.setAttribute('height', String(origH));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const darkPathData = [];
  doc.querySelectorAll('path').forEach(path => {
    const fill = (path.getAttribute('fill') || '').toLowerCase().replace(/\s/g, '');
    if (!isLightColor(fill)) {
      const d = compactPathData(path.getAttribute('d') || '', pathSimplify);
      if (d) darkPathData.push(d);
    }
  });

  doc.querySelectorAll('rect,desc,title,path').forEach(el => el.remove());

  if (darkPathData.length) {
    const mergedPath = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    mergedPath.setAttribute('fill', color);
    mergedPath.setAttribute('fill-rule', 'evenodd');
    mergedPath.setAttribute('stroke', 'none');
    mergedPath.setAttribute('d', darkPathData.join(' '));
    svg.appendChild(mergedPath);
  }

  return new XMLSerializer().serializeToString(doc);
}

function compactPathData(d, pathSimplify) {
  const precision = pathSimplify >= 18 ? 1 : pathSimplify >= 10 ? 2 : 3;
  return d
    .replace(/-?\d*\.\d+/g, match => trimTrailingZeros(Number(match).toFixed(precision)))
    .replace(/\s+/g, ' ')
    .replace(/\s([A-Z])/g, ' $1')
    .trim();
}

function trimTrailingZeros(value) {
  return value.replace(/\.?0+$/, '');
}

function isLightColor(fill) {
  if (!fill) return false;
  if (fill === 'white' || fill === '#fff' || fill === '#ffffff') return true;
  if (fill.startsWith('#') && fill.length === 7) {
    const r = parseInt(fill.slice(1, 3), 16);
    const g = parseInt(fill.slice(3, 5), 16);
    const b = parseInt(fill.slice(5, 7), 16);
    return (r * 0.299 + g * 0.587 + b * 0.114) > 210;
  }
  if (fill.startsWith('rgb')) {
    const nums = fill.match(/\d+/g);
    if (nums && nums.length >= 3) {
      return (parseInt(nums[0], 10) * 0.299 + parseInt(nums[1], 10) * 0.587 + parseInt(nums[2], 10) * 0.114) > 210;
    }
  }
  return false;
}

// ── Recolor SVG for a given hex color ────────────────────────────────────
function recolor(svgStr, color) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgStr, 'image/svg+xml');
  doc.querySelectorAll('path,circle,rect,ellipse,polygon,polyline').forEach(el => {
    const fill = el.getAttribute('fill');
    if (fill && fill !== 'none') el.setAttribute('fill', color);
  });
  return new XMLSerializer().serializeToString(doc);
}

// ── SVG tab rendering ─────────────────────────────────────────────────────
function renderSVGTab(svgStr, stats, maskPreviewUrl) {
  const byteSize = stats?.byteSize ?? new Blob([svgStr]).size;
  const pathCount = stats?.pathCount ?? (svgStr.match(/<path/g) || []).length;
  const holeCount = stats?.holeCount ?? 0;
  const thresholdText = stats ? stats.resolvedThreshold + ' (auto ' + stats.autoThreshold + ')' : 'n/a';
  const coverageText = stats ? Math.round(stats.coverage * 100) + '%' : 'n/a';
  const upscaleChip = (stats && stats.upscaleFactor > 1)
    ? '<div class="meta-chip">Supersample: <b>' + stats.upscaleFactor + '× (' + stats.maskWidth + '×' + stats.maskHeight + ')</b></div>'
    : '';

  document.getElementById('svg-meta').innerHTML =
    '<div class="meta-chip">Paths: <b>' + pathCount + '</b></div>' +
    '<div class="meta-chip">Holes: <b>' + holeCount + '</b></div>' +
    '<div class="meta-chip">Threshold: <b>' + thresholdText + '</b></div>' +
    '<div class="meta-chip">Coverage: <b>' + coverageText + '</b></div>' +
    '<div class="meta-chip">Size: <b>' + (byteSize / 1024).toFixed(1) + ' KB</b></div>' +
    upscaleChip;

  const svgDark = recolor(svgStr, '#000000');
  const svgLight = recolor(svgStr, '#ffffff');
  const svgColor = recolor(svgStr, selectedColor);

  const maskLabel = (stats && stats.upscaleFactor > 1)
    ? 'Processed mask (upscaled ' + stats.upscaleFactor + '×, as traced)'
    : 'Processed mask';
  const maskCard = maskPreviewUrl
    ? '<div class="prev-card">' +
        '<div class="prev-card-lbl">' + maskLabel + '</div>' +
        '<div class="prev-card-body mask-preview"><img src="' + maskPreviewUrl + '" alt="Processed binary mask preview"></div>' +
      '</div>'
    : '';

  document.getElementById('preview-grid').innerHTML =
    maskCard +
    '<div class="prev-card">' +
      '<div class="prev-card-lbl">On white</div>' +
      '<div class="prev-card-body on-light">' + svgDark + '</div>' +
    '</div>' +
    '<div class="prev-card">' +
      '<div class="prev-card-lbl">On black</div>' +
      '<div class="prev-card-body on-dark">' + svgLight + '</div>' +
    '</div>' +
    '<div class="prev-card">' +
      '<div class="prev-card-lbl">Transparency check</div>' +
      '<div class="prev-card-body on-checker-light">' + svgDark + '</div>' +
    '</div>' +
    '<div class="prev-card">' +
      '<div class="prev-card-lbl">Custom color</div>' +
      '<div class="prev-card-body on-checker-dark">' + svgColor + '</div>' +
    '</div>';

  const row = document.getElementById('action-row');
  row.innerHTML = '';
  mkBtn(row, '↓ Download SVG', 'btn-primary', () => dlText(recolor(svgStr, selectedColor), 'logo.svg', 'image/svg+xml'));
  mkBtn(row, '↓ Dark variant', 'btn-secondary', () => dlText(svgDark, 'logo-dark.svg', 'image/svg+xml'));
  mkBtn(row, '↓ Light variant', 'btn-secondary', () => dlText(svgLight, 'logo-light.svg', 'image/svg+xml'));

  const copyBtn = mkBtn(row, 'Copy code', 'btn-secondary', null);
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(svgStr).then(() => {
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 2000);
    });
  };

  document.getElementById('svg-empty').style.display = 'none';
  document.getElementById('svg-result').style.display = 'block';
}

function mkBtn(parent, label, cls, onclick) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = label;
  if (onclick) b.onclick = onclick;
  parent.appendChild(b);
  return b;
}

// ── Export sizes ──────────────────────────────────────────────────────────
const EXPORTS = [
  { group: 'Favicons', label: '16×16', w: 16, h: 16, mode: 'dark', bg: 'transparent' },
  { group: 'Favicons', label: '32×32', w: 32, h: 32, mode: 'dark', bg: 'transparent' },
  { group: 'Favicons', label: '48×48', w: 48, h: 48, mode: 'dark', bg: 'transparent' },
  { group: 'Favicons', label: '64×64', w: 64, h: 64, mode: 'dark', bg: 'transparent' },
  { group: 'Favicons', label: 'Apple Touch', w: 180, h: 180, mode: 'dark', bg: 'transparent' },
  { group: 'Favicons', label: 'Android', w: 192, h: 192, mode: 'dark', bg: 'transparent' },
  { group: 'Favicons', label: 'PWA 512', w: 512, h: 512, mode: 'dark', bg: 'transparent' },
  { group: 'Light Mode', label: '100px', w: 100, h: 100, mode: 'dark', bg: 'transparent' },
  { group: 'Light Mode', label: '200px', w: 200, h: 200, mode: 'dark', bg: 'transparent' },
  { group: 'Light Mode', label: '400px', w: 400, h: 400, mode: 'dark', bg: 'transparent' },
  { group: 'Light Mode', label: '800px', w: 800, h: 800, mode: 'dark', bg: 'transparent' },
  { group: 'Light Mode', label: 'OG 1200×630', w: 1200, h: 630, mode: 'dark', bg: '#ffffff' },
  { group: 'Dark Mode', label: '100px', w: 100, h: 100, mode: 'light', bg: 'transparent' },
  { group: 'Dark Mode', label: '200px', w: 200, h: 200, mode: 'light', bg: 'transparent' },
  { group: 'Dark Mode', label: '400px', w: 400, h: 400, mode: 'light', bg: 'transparent' },
  { group: 'Dark Mode', label: '800px', w: 800, h: 800, mode: 'light', bg: 'transparent' },
  { group: 'Dark Mode', label: 'OG 1200×630', w: 1200, h: 630, mode: 'light', bg: '#111111' },
];

// ── Exports tab ───────────────────────────────────────────────────────────
async function renderExportsTab(svgStr) {
  const cont = document.getElementById('exp-result');
  cont.innerHTML = '';
  document.getElementById('exp-empty').style.display = 'none';
  document.getElementById('exp-result').style.display = 'block';

  const topRow = document.createElement('div');
  topRow.className = 'exp-top-row';
  const zipBtn = mkBtn(topRow, '↓ Download All (ZIP)', 'btn-primary', null);
  const favBtn = mkBtn(topRow, '↓ Favicons ZIP', 'btn-secondary', null);
  cont.appendChild(topRow);

  const groups = {};
  EXPORTS.forEach(e => {
    if (!groups[e.group]) groups[e.group] = [];
    groups[e.group].push(e);
  });

  const allEntries = [];

  for (const [groupName, sizes] of Object.entries(groups)) {
    const title = document.createElement('div');
    title.className = 'exp-sec-title';
    title.textContent = groupName;
    cont.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'export-grid';
    cont.appendChild(grid);

    for (const size of sizes) {
      const color = size.mode === 'light' ? '#ffffff' : '#000000';
      const colored = recolor(svgStr, color);
      const card = buildExpCard(size);
      grid.appendChild(card);

      const canvas = card.querySelector('canvas');
      await renderToCanvas(colored, size, canvas);

      const entry = { svg: colored, size, canvas };
      allEntries.push(entry);

      card.querySelector('.exp-dl').onclick = async () => {
        const btn = card.querySelector('.exp-dl');
        btn.textContent = '…';
        await dlExport(colored, size);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '↓'; }, 2000);
      };
    }
  }

  zipBtn.onclick = async () => {
    zipBtn.disabled = true;
    zipBtn.textContent = 'Building ZIP…';
    await downloadZip(allEntries, svgStr, 'logo-exports.zip');
    zipBtn.disabled = false;
    zipBtn.textContent = '↓ Download All (ZIP)';
  };
  favBtn.onclick = async () => {
    favBtn.disabled = true;
    favBtn.textContent = 'Building…';
    const favs = allEntries.filter(e => e.size.group === 'Favicons');
    await downloadZip(favs, svgStr, 'favicons.zip');
    favBtn.disabled = false;
    favBtn.textContent = '↓ Favicons ZIP';
  };
}

function buildExpCard(size) {
  const card = document.createElement('div');
  card.className = 'exp-card';

  const thumbBg = size.bg === 'transparent'
    ? (size.mode === 'light'
        ? 'background:repeating-conic-gradient(#2a2a2a 0% 25%,#1a1a1a 0% 50%) 0 0/12px 12px'
        : 'background:repeating-conic-gradient(#ddd 0% 25%,#f0f0f0 0% 50%) 0 0/12px 12px')
    : 'background:' + size.bg;

  const pvW = Math.min(size.w, 128);
  const pvH = Math.min(size.h, 128);

  card.innerHTML =
    '<div class="exp-thumb" style="' + thumbBg + '">' +
      '<canvas width="' + pvW + '" height="' + pvH + '"></canvas>' +
    '</div>' +
    '<div class="exp-foot">' +
      '<div>' +
        '<div class="exp-name">' + size.label + '</div>' +
        '<div class="exp-dim">' + size.w + '×' + size.h + '</div>' +
      '</div>' +
      '<button class="exp-dl">↓</button>' +
    '</div>';
  return card;
}

// ── Render SVG → canvas ───────────────────────────────────────────────────
function renderToCanvas(svgStr, size, canvas) {
  return new Promise(resolve => {
    let s = svgStr;
    if (size.bg !== 'transparent') {
      s = s.replace('<svg ', '<svg style="background:' + size.bg + '" ');
    }
    const blob = new Blob([s], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (size.bg !== 'transparent') {
        ctx.fillStyle = size.bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      const pad = 0.1;
      const W = canvas.width * (1 - pad * 2);
      const H = canvas.height * (1 - pad * 2);
      const nat = img.naturalWidth || size.w;
      const nah = img.naturalHeight || size.h;
      const ar = nat / nah;
      let dw;
      let dh;
      if (ar > W / H) {
        dw = W;
        dh = W / ar;
      } else {
        dh = H;
        dw = H * ar;
      }
      ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    img.src = url;
  });
}

// ── Download single export ────────────────────────────────────────────────
async function dlExport(svgStr, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  await renderToCanvas(svgStr, size, canvas);
  const slug = size.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return new Promise(r => canvas.toBlob(blob => {
    dlBlob(blob, slug + '-' + size.w + 'x' + size.h + '.png');
    r();
  }, 'image/png'));
}

// ── ZIP all exports ───────────────────────────────────────────────────────
async function downloadZip(entries, rawSvg, filename) {
  const files = [];

  files.push({ name: 'svg/logo-dark.svg', data: enc(recolor(rawSvg, '#000000')) });
  files.push({ name: 'svg/logo-light.svg', data: enc(recolor(rawSvg, '#ffffff')) });
  if (selectedColor !== '#000000' && selectedColor !== '#ffffff') {
    files.push({ name: 'svg/logo-color.svg', data: enc(recolor(rawSvg, selectedColor)) });
  }

  for (const { svg, size } of entries) {
    const c = document.createElement('canvas');
    c.width = size.w;
    c.height = size.h;
    await renderToCanvas(svg, size, c);
    const buf = await new Promise(r => c.toBlob(b => b.arrayBuffer().then(r), 'image/png'));
    const folder = size.group.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const slug = size.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    files.push({ name: folder + '/' + slug + '-' + size.w + 'x' + size.h + '.png', data: new Uint8Array(buf) });
  }

  const zip = buildZip(files);
  dlBlob(new Blob([zip], { type: 'application/zip' }), filename);
}

function enc(str) {
  return new TextEncoder().encode(str);
}

// ── Download helpers ──────────────────────────────────────────────────────
function dlText(str, name, mime) {
  dlBlob(new Blob([str], { type: mime }), name);
}

function dlBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
