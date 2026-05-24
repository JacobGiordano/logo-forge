// ── State ──────────────────────────────────────────────────────────────────
let srcImage = null;
let currentSVG = null;
let detectedInvert = false;
let selectedColor = '#000000';
let liveEnabled = false;
let liveTimer = null;

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
  }, 400);
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

// ── Range inputs ──────────────────────────────────────────────────────────
[
  ['threshold','v-threshold',0],
  ['ltres','v-ltres',1],
  ['qtres','v-qtres',1],
  ['pathomit','v-pathomit',0],
].forEach(([id, vid, dec]) => {
  const el = document.getElementById(id);
  const badge = document.getElementById(vid);
  badge.textContent = parseFloat(el.value).toFixed(dec);
  el.addEventListener('input', () => {
    badge.textContent = parseFloat(el.value).toFixed(dec);
    scheduleLive();
  });
});

// ── Color swatches ────────────────────────────────────────────────────────
document.querySelectorAll('.color-swatch').forEach(sw => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    const val = sw.dataset.color;
    document.getElementById('custom-color-row').style.display = val === 'custom' ? 'flex' : 'none';
    if (val !== 'custom') selectedColor = val;
    else selectedColor = document.getElementById('custom-color').value;
    scheduleLive();
  });
});
document.getElementById('custom-color').addEventListener('input', e => {
  selectedColor = e.target.value;
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
    const a = d[i+3] / 255;
    sum += (d[i]*.299 + d[i+1]*.587 + d[i+2]*.114) * a + 255 * (1-a);
  }
  detectedInvert = (sum / (d.length/4)) < 128;
}

['file-input','file-input2'].forEach(id => {
  document.getElementById(id).addEventListener('change', e => handleFile(e.target.files[0]));
});

document.getElementById('invert').addEventListener('change', scheduleLive);

const dz = document.getElementById('dropzone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('drag-over');
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
  setStatus('Preparing…');
  await tick();

  try {
    const canvas = document.getElementById('work-canvas');
    canvas.width = srcImage.naturalWidth;
    canvas.height = srcImage.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(srcImage, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const threshold = parseInt(document.getElementById('threshold').value);
    const ltres = parseFloat(document.getElementById('ltres').value);
    const qtres = parseFloat(document.getElementById('qtres').value);
    const pathomit = parseInt(document.getElementById('pathomit').value);

    const invertSel = document.getElementById('invert').value;
    const doInvert = invertSel === 'auto' ? detectedInvert : invertSel === '1';

    setStatus('Tracing…');
    await tick();

    const processed = thresholdImageData(imageData, threshold, doInvert);

    const options = {
      colorsampling: 0,
      numberofcolors: 2,
      ltres: ltres,
      qtres: qtres,
      pathomit: pathomit,
      roundcoords: 3,
      desc: false,
      viewbox: true,
      linefilter: false,
      rightangleenhance: true,
    };

    const svgStr = ImageTracer.imagedataToSVG(processed, options);

    const cleaned = postProcess(svgStr, selectedColor, canvas.width, canvas.height);
    currentSVG = cleaned;

    renderSVGTab(cleaned);
    await renderExportsTab(cleaned);

    setLoading(false);
    setStatus('Done — SVG ready ✓', 'ok');

    document.querySelector('[data-tab="svg"]').click();

  } catch(err) {
    console.error(err);
    setLoading(false);
    setStatus('Error: ' + err.message, 'err');
  }
});

function tick() { return new Promise(r => setTimeout(r, 16)); }

function setLoading(on) {
  document.getElementById('spinner').style.display = on ? 'block' : 'none';
  document.getElementById('trace-lbl').textContent = on ? 'Tracing…' : '↗ Trace to SVG';
  document.getElementById('trace-btn').disabled = on;
}

// ── Threshold pre-pass: flatten to clean 2-color ImageData ────────────────
function thresholdImageData(imgData, threshold, invert) {
  const d = new Uint8ClampedArray(imgData.data);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i+3] / 255;
    const lum = (d[i]*.299 + d[i+1]*.587 + d[i+2]*.114) * a + 255 * (1-a);
    let dark = lum < threshold;
    if (invert) dark = !dark;
    const v = dark ? 0 : 255;
    d[i] = d[i+1] = d[i+2] = v;
    d[i+3] = 255;
  }
  return { width: imgData.width, height: imgData.height, data: d };
}

// ── Post-process SVG: recolor & strip background ──────────────────────────
function postProcess(svgStr, color, origW, origH) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgStr, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg) return svgStr;

  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const paths = Array.from(doc.querySelectorAll('path'));

  paths.forEach(p => {
    const fill = (p.getAttribute('fill') || '').toLowerCase().replace(/\s/g,'');
    if (isLightColor(fill)) {
      p.remove();
    } else {
      p.setAttribute('fill', color);
      p.removeAttribute('stroke');
    }
  });

  doc.querySelectorAll('rect').forEach(r => {
    const fill = (r.getAttribute('fill') || '').toLowerCase();
    if (isLightColor(fill) || fill === '' || fill === 'none') r.remove();
  });

  doc.querySelectorAll('desc,title').forEach(e => e.remove());

  return new XMLSerializer().serializeToString(doc);
}

function isLightColor(fill) {
  if (!fill) return false;
  if (fill === 'white' || fill === '#fff' || fill === '#ffffff') return true;
  if (fill.startsWith('#') && fill.length === 7) {
    const r = parseInt(fill.slice(1,3),16);
    const g = parseInt(fill.slice(3,5),16);
    const b = parseInt(fill.slice(5,7),16);
    return (r*.299 + g*.587 + b*.114) > 210;
  }
  if (fill.startsWith('rgb')) {
    const nums = fill.match(/\d+/g);
    if (nums && nums.length >= 3) {
      return (parseInt(nums[0])*.299 + parseInt(nums[1])*.587 + parseInt(nums[2])*.114) > 210;
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
function renderSVGTab(svgStr) {
  const byteSize = new Blob([svgStr]).size;
  const pathCount = (svgStr.match(/<path/g)||[]).length;

  document.getElementById('svg-meta').innerHTML =
    '<div class="meta-chip">Paths: <b>' + pathCount + '</b></div>' +
    '<div class="meta-chip">Size: <b>' + (byteSize/1024).toFixed(1) + ' KB</b></div>';

  const svgDark = recolor(svgStr, '#000000');
  const svgLight = recolor(svgStr, '#ffffff');
  const svgColor = recolor(svgStr, selectedColor);

  document.getElementById('preview-grid').innerHTML =
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
      setTimeout(() => copyBtn.textContent = 'Copy code', 2000);
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
  // Favicons
  {group:'Favicons',  label:'16×16',      w:16,   h:16,   mode:'dark',  bg:'transparent'},
  {group:'Favicons',  label:'32×32',      w:32,   h:32,   mode:'dark',  bg:'transparent'},
  {group:'Favicons',  label:'48×48',      w:48,   h:48,   mode:'dark',  bg:'transparent'},
  {group:'Favicons',  label:'64×64',      w:64,   h:64,   mode:'dark',  bg:'transparent'},
  {group:'Favicons',  label:'Apple Touch',w:180,  h:180,  mode:'dark',  bg:'transparent'},
  {group:'Favicons',  label:'Android',    w:192,  h:192,  mode:'dark',  bg:'transparent'},
  {group:'Favicons',  label:'PWA 512',    w:512,  h:512,  mode:'dark',  bg:'transparent'},
  // Light mode logos
  {group:'Light Mode',label:'100px',      w:100,  h:100,  mode:'dark',  bg:'transparent'},
  {group:'Light Mode',label:'200px',      w:200,  h:200,  mode:'dark',  bg:'transparent'},
  {group:'Light Mode',label:'400px',      w:400,  h:400,  mode:'dark',  bg:'transparent'},
  {group:'Light Mode',label:'800px',      w:800,  h:800,  mode:'dark',  bg:'transparent'},
  {group:'Light Mode',label:'OG 1200×630',w:1200, h:630,  mode:'dark',  bg:'#ffffff'},
  // Dark mode logos
  {group:'Dark Mode', label:'100px',      w:100,  h:100,  mode:'light', bg:'transparent'},
  {group:'Dark Mode', label:'200px',      w:200,  h:200,  mode:'light', bg:'transparent'},
  {group:'Dark Mode', label:'400px',      w:400,  h:400,  mode:'light', bg:'transparent'},
  {group:'Dark Mode', label:'800px',      w:800,  h:800,  mode:'light', bg:'transparent'},
  {group:'Dark Mode', label:'OG 1200×630',w:1200, h:630,  mode:'light', bg:'#111111'},
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
  EXPORTS.forEach(e => { if (!groups[e.group]) groups[e.group] = []; groups[e.group].push(e); });

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
      const card = buildExpCard(size, color);
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
        setTimeout(() => btn.textContent = '↓', 2000);
      };
    }
  }

  zipBtn.onclick = async () => {
    zipBtn.disabled = true; zipBtn.textContent = 'Building ZIP…';
    await downloadZip(allEntries, svgStr, 'logo-exports.zip');
    zipBtn.disabled = false; zipBtn.textContent = '↓ Download All (ZIP)';
  };
  favBtn.onclick = async () => {
    favBtn.disabled = true; favBtn.textContent = 'Building…';
    const favs = allEntries.filter(e => e.size.group === 'Favicons');
    await downloadZip(favs, svgStr, 'favicons.zip');
    favBtn.disabled = false; favBtn.textContent = '↓ Favicons ZIP';
  };
}

function buildExpCard(size, color) {
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
        ctx.fillStyle = size.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      const pad = 0.1;
      const W = canvas.width * (1-pad*2), H = canvas.height * (1-pad*2);
      const nat = img.naturalWidth || size.w, nah = img.naturalHeight || size.h;
      const ar = nat / nah;
      let dw, dh;
      if (ar > W/H) { dw=W; dh=W/ar; } else { dh=H; dw=H*ar; }
      ctx.drawImage(img, (canvas.width-dw)/2, (canvas.height-dh)/2, dw, dh);
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
    img.src = url;
  });
}

// ── Download single export ────────────────────────────────────────────────
async function dlExport(svgStr, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size.w; canvas.height = size.h;
  await renderToCanvas(svgStr, size, canvas);
  const slug = size.label.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  return new Promise(r => canvas.toBlob(blob => {
    dlBlob(blob, slug + '-' + size.w + 'x' + size.h + '.png');
    r();
  }, 'image/png'));
}

// ── ZIP all exports ───────────────────────────────────────────────────────
async function downloadZip(entries, rawSvg, filename) {
  const files = [];

  files.push({ name:'svg/logo-dark.svg',  data: enc(recolor(rawSvg,'#000000')) });
  files.push({ name:'svg/logo-light.svg', data: enc(recolor(rawSvg,'#ffffff')) });
  if (selectedColor !== '#000000' && selectedColor !== '#ffffff')
    files.push({ name:'svg/logo-color.svg', data: enc(recolor(rawSvg, selectedColor)) });

  for (const { svg, size } of entries) {
    const c = document.createElement('canvas');
    c.width = size.w; c.height = size.h;
    await renderToCanvas(svg, size, c);
    const buf = await new Promise(r => c.toBlob(b => b.arrayBuffer().then(r), 'image/png'));
    const folder = size.group.toLowerCase().replace(/[^a-z0-9]+/g,'-');
    const slug = size.label.toLowerCase().replace(/[^a-z0-9]+/g,'-');
    files.push({ name: folder + '/' + slug + '-' + size.w + 'x' + size.h + '.png', data: new Uint8Array(buf) });
  }

  const zip = buildZip(files);
  dlBlob(new Blob([zip], {type:'application/zip'}), filename);
}

function enc(str) { return new TextEncoder().encode(str); }

// ── Download helpers ──────────────────────────────────────────────────────
function dlText(str, name, mime) {
  dlBlob(new Blob([str],{type:mime}), name);
}
function dlBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
}
