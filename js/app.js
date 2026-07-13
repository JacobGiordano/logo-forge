// ── State ──────────────────────────────────────────────────────────────────
let srcImage = null;
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
    badge.textContent = value.toFixed(decimals);
  });
}

CONTROL_DEFS.forEach(({ id, valueId, decimals }) => {
  const el = document.getElementById(id);
  if (valueId) {
    const badge = document.getElementById(valueId);
    badge.textContent = parseFloat(el.value).toFixed(decimals);
  }
  el.addEventListener('input', () => {
    if (valueId) {
      document.getElementById(valueId).textContent = parseFloat(el.value).toFixed(decimals);
    }
    scheduleLive();
  });
  el.addEventListener('change', scheduleLive);
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
function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      srcImage = img;
      document.getElementById('dropzone').style.display = 'none';
      document.getElementById('thumb-wrap').style.display = 'block';
      document.getElementById('thumb-img').src = e.target.result;
      document.getElementById('trace-btn').disabled = false;
      setStatus('Loaded ' + img.width + '×' + img.height + 'px — ready to trace');
      autoDetect(img);
      scheduleLive();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
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

  const filledPixels = countFilledPixels(mask);
  const imageData = maskToImageData(mask, imgData.width, imgData.height);
  const previewUrl = makePreviewURL(imageData);

  return {
    imageData,
    resolvedThreshold,
    autoThreshold,
    coverage: filledPixels / mask.length,
    maskPreviewUrl: previewUrl,
    previewUrl,
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

  document.getElementById('svg-meta').innerHTML =
    '<div class="meta-chip">Paths: <b>' + pathCount + '</b></div>' +
    '<div class="meta-chip">Holes: <b>' + holeCount + '</b></div>' +
    '<div class="meta-chip">Threshold: <b>' + thresholdText + '</b></div>' +
    '<div class="meta-chip">Coverage: <b>' + coverageText + '</b></div>' +
    '<div class="meta-chip">Size: <b>' + (byteSize / 1024).toFixed(1) + ' KB</b></div>';

  const svgDark = recolor(svgStr, '#000000');
  const svgLight = recolor(svgStr, '#ffffff');
  const svgColor = recolor(svgStr, selectedColor);

  const maskCard = maskPreviewUrl
    ? '<div class="prev-card">' +
        '<div class="prev-card-lbl">Processed mask</div>' +
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
