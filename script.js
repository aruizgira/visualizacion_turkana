const state = {
  sites: [],
  site: null,
  area: null,
  element: null,
  lastBBox: null,
};

const el = {
  siteSelect: document.getElementById('siteSelect'),
  areaSelect: document.getElementById('areaSelect'),
  elementSelect: document.getElementById('elementSelect'),
  structuresToggle: document.getElementById('structuresToggle'),
  photoToggle: document.getElementById('photoToggle'),
  mapCanvas: document.getElementById('mapCanvas'),
  loading: document.getElementById('loading'),
  mapTitle: document.getElementById('mapTitle'),
  mapSubtitle: document.getElementById('mapSubtitle'),
  legendTitle: document.getElementById('legendTitle'),
  legendMin: document.getElementById('legendMin'),
  legendMax: document.getElementById('legendMax'),
  sitePhoto: document.getElementById('sitePhoto'),
  photoCard: document.getElementById('photoCard'),
  interpretation: document.getElementById('interpretation'),
  resetButton: document.getElementById('resetButton'),
};

const elementNotes = {
  P: 'Phosphorus is often useful for detecting organic residues, dung accumulation, and intensive activity areas.',
  Ca: 'Calcium can reflect ash, bone, dung, or other activity-related enrichment depending on the context.',
  Fe: 'Iron can help highlight combustion, sediment differences, and activity-related soil modification.',
  Mn: 'Manganese may capture subtle soil and activity contrasts, especially when read together with other elements.',
  Sr: 'Strontium can be useful when comparing animal-related and sedimentary signals.',
  Al: 'Aluminium is useful as a background or sediment control element.',
  Si: 'Silicon can help evaluate sediment background and mineralogical contrasts.'
};

function setLoading(show, message = 'Loading raster…') {
  el.loading.textContent = message;
  el.loading.classList.toggle('hidden', !show);
}

function formatNumber(v) {
  if (!Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 1) return v.toFixed(3);
  return v.toExponential(2);
}

function colorRamp(t) {
  // Viridis-like 5-stop interpolation
  const stops = [
    [0.00, [68, 1, 84]],
    [0.25, [59, 82, 139]],
    [0.50, [33, 145, 140]],
    [0.75, [94, 201, 98]],
    [1.00, [253, 231, 37]]
  ];
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (t >= a && t <= b) {
      const u = (t - a) / (b - a);
      return ca.map((c, j) => Math.round(c + (cb[j] - c) * u));
    }
  }
  return stops[stops.length - 1][1];
}

function getGeometryBBox(geojson) {
  const xs = [], ys = [];
  function visit(coords) {
    if (typeof coords[0] === 'number') {
      xs.push(coords[0]); ys.push(coords[1]);
    } else coords.forEach(visit);
  }
  geojson.features.forEach(f => visit(f.geometry.coordinates));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function unionBBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function padBBox(bbox, pct = 0.08) {
  const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
  return [bbox[0] - w * pct, bbox[1] - h * pct, bbox[2] + w * pct, bbox[3] + h * pct];
}

function makeProjector(bbox, canvas) {
  const [minX, minY, maxX, maxY] = bbox;
  const margin = 42;
  const usableW = canvas.width - margin * 2;
  const usableH = canvas.height - margin * 2;
  const scale = Math.min(usableW / (maxX - minX), usableH / (maxY - minY));
  const drawW = (maxX - minX) * scale;
  const drawH = (maxY - minY) * scale;
  const offsetX = (canvas.width - drawW) / 2;
  const offsetY = (canvas.height - drawH) / 2;
  return ([x, y]) => [offsetX + (x - minX) * scale, offsetY + (maxY - y) * scale];
}

function drawRaster(ctx, raster, width, height, bbox, viewBBox) {
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext('2d');
  const imageData = tctx.createImageData(width, height);

  let min = Infinity, max = -Infinity;
  for (const v of raster) {
    if (Number.isFinite(v) && v !== -9999) { min = Math.min(min, v); max = Math.max(max, v); }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) { min = 0; max = 1; }

  for (let i = 0; i < raster.length; i++) {
    const v = raster[i];
    const o = i * 4;
    if (!Number.isFinite(v) || v === -9999) {
      imageData.data[o + 3] = 0;
      continue;
    }
    const [r, g, b] = colorRamp((v - min) / (max - min));
    imageData.data[o] = r;
    imageData.data[o + 1] = g;
    imageData.data[o + 2] = b;
    imageData.data[o + 3] = 210;
  }
  tctx.putImageData(imageData, 0, 0);

  const project = makeProjector(viewBBox, ctx.canvas);
  const [x0, y0] = project([bbox[0], bbox[3]]);
  const [x1, y1] = project([bbox[2], bbox[1]]);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, x0, y0, x1 - x0, y1 - y0);

  el.legendMin.textContent = formatNumber(min);
  el.legendMax.textContent = formatNumber(max);
}

function drawGeoJSON(ctx, geojson, viewBBox) {
  const project = makeProjector(viewBBox, ctx.canvas);
  ctx.save();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  function drawLine(coords) {
    if (!coords || coords.length === 0) return;
    ctx.beginPath();
    coords.forEach((pt, i) => {
      const [x, y] = project(pt);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawPolygon(rings) {
    rings.forEach(ring => {
      ctx.beginPath();
      ring.forEach((pt, i) => {
        const [x, y] = project(pt);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    });
  }

  geojson.features.forEach(f => {
    const g = f.geometry;
    if (!g) return;
    if (g.type === 'LineString') drawLine(g.coordinates);
    if (g.type === 'MultiLineString') g.coordinates.forEach(drawLine);
    if (g.type === 'Polygon') drawPolygon(g.coordinates);
    if (g.type === 'MultiPolygon') g.coordinates.forEach(drawPolygon);
  });
  ctx.restore();
}

function drawNorthArrowAndScale(ctx, viewBBox) {
  ctx.save();
  ctx.fillStyle = '#1f2722';
  ctx.strokeStyle = '#1f2722';
  ctx.lineWidth = 2;
  ctx.font = 'bold 16px system-ui';
  ctx.fillText('N', 38, 38);
  ctx.beginPath();
  ctx.moveTo(46, 48); ctx.lineTo(46, 86); ctx.lineTo(39, 74); ctx.moveTo(46, 86); ctx.lineTo(53, 74); ctx.stroke();

  const meters = Math.max(5, Math.round(((viewBBox[2] - viewBBox[0]) / 4) / 5) * 5);
  const project = makeProjector(viewBBox, ctx.canvas);
  const [x0, y0] = project([viewBBox[0] + (viewBBox[2]-viewBBox[0])*.08, viewBBox[1] + (viewBBox[3]-viewBBox[1])*.08]);
  const [x1] = project([viewBBox[0] + (viewBBox[2]-viewBBox[0])*.08 + meters, viewBBox[1]]);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.stroke();
  ctx.fillText(`${meters} m`, x0, y0 - 8);
  ctx.restore();
}

async function render() {
  if (!state.area || !state.element) return;
  setLoading(true);
  const canvas = el.mapCanvas;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fdfbf6';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  try {
    const rasterPath = state.area.rasters[state.element];
    const tiff = await GeoTIFF.fromUrl(rasterPath);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
    const data = await image.readRasters({ interleave: true });

    let structures = null, structuresBBox = null;
    if (state.area.structures) {
      structures = await fetch(state.area.structures).then(r => r.json());
      structuresBBox = getGeometryBBox(structures);
    }
    const viewBBox = padBBox(unionBBox(bbox, structuresBBox));
    state.lastBBox = viewBBox;

    drawRaster(ctx, data, width, height, bbox, viewBBox);
    if (el.structuresToggle.checked && structures) drawGeoJSON(ctx, structures, viewBBox);
    drawNorthArrowAndScale(ctx, viewBBox);

    el.mapTitle.textContent = `${state.site.name} · ${state.area.label} · ${state.element}`;
    el.mapSubtitle.textContent = `${width} × ${height} raster cells · EPSG:32637`;
    el.legendTitle.textContent = `${state.element} concentration`;
    el.interpretation.textContent = elementNotes[state.element] || 'Use this element to explore spatial patterning in the selected area.';

    if (state.area.photo) {
      el.sitePhoto.src = state.area.photo;
      el.photoCard.style.display = el.photoToggle.checked ? '' : 'none';
    } else {
      el.photoCard.style.display = 'none';
    }
  } catch (err) {
    console.error(err);
    ctx.fillStyle = '#7b1d1d';
    ctx.font = '20px system-ui';
    ctx.fillText('Could not load this layer. Check file paths and browser console.', 40, 80);
  } finally {
    setLoading(false);
  }
}

function populateSelectors() {
  el.siteSelect.innerHTML = '';
  state.sites.forEach(site => el.siteSelect.add(new Option(site.name, site.id)));
  state.site = state.sites[0];

  function populateAreas() {
    el.areaSelect.innerHTML = '';
    state.site.areas.forEach(area => el.areaSelect.add(new Option(area.label, area.id)));
    state.area = state.site.areas[0];
    populateElements();
  }

  function populateElements() {
    el.elementSelect.innerHTML = '';
    Object.keys(state.area.rasters).forEach(k => el.elementSelect.add(new Option(k, k)));
    state.element = Object.keys(state.area.rasters)[0];
    render();
  }

  el.siteSelect.addEventListener('change', () => {
    state.site = state.sites.find(s => s.id === el.siteSelect.value);
    populateAreas();
  });

  el.areaSelect.addEventListener('change', () => {
    state.area = state.site.areas.find(a => a.id === el.areaSelect.value);
    populateElements();
  });

  el.elementSelect.addEventListener('change', () => {
    state.element = el.elementSelect.value;
    render();
  });

  el.structuresToggle.addEventListener('change', render);
  el.photoToggle.addEventListener('change', () => { el.photoCard.style.display = el.photoToggle.checked ? '' : 'none'; });
  el.resetButton.addEventListener('click', render);

  populateAreas();
}

fetch('data/sites.json')
  .then(r => r.json())
  .then(config => {
    state.sites = config.sites;
    populateSelectors();
  })
  .catch(err => {
    console.error(err);
    setLoading(true, 'Could not load data/sites.json');
  });
