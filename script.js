const EPSG_32637 = '+proj=utm +zone=37 +datum=WGS84 +units=m +no_defs +type=crs';
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const state = {
  sites: [],
  site: null,
  area: null,
  element: null,
  lastBBox: null,
  activeTab: 'home',
  locations: new Map(),
  overviewMap: null,
  overviewMarkers: [],
  overviewMapAnimating: false,
  miniMap: null,
};

const el = {
  tabButtons: document.querySelectorAll('.tab-button'),
  tabLinks: document.querySelectorAll('[data-go-tab]'),
  tabViews: {
    home: document.getElementById('homeView'),
    overview: document.getElementById('overviewView'),
    explore: document.getElementById('exploreView'),
    compare: document.getElementById('compareView'),
  },
  overviewMap: document.getElementById('overviewMap'),
  overviewStatus: document.getElementById('overviewStatus'),
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
  siteInfoHeading: document.getElementById('siteInfoHeading'),
  siteInfoMeta: document.getElementById('siteInfoMeta'),
  siteLocationText: document.getElementById('siteLocationText'),
  miniSiteMap: document.getElementById('miniSiteMap'),
  landscapeZoomButton: document.getElementById('landscapeZoomButton'),
  sitePhoto: document.getElementById('sitePhoto'),
  photoModal: document.getElementById('photoModal'),
  photoModalImage: document.getElementById('photoModalImage'),
  photoModalClose: document.getElementById('photoModalClose'),
  photoCard: document.getElementById('photoCard'),
  interpretation: document.getElementById('interpretation'),
  resetButton: document.getElementById('resetButton'),
};

const tiffCache = new Map();

const comparePanels = {
  a: {
    key: 'a',
    siteSelect: document.getElementById('compareASite'),
    areaSelect: document.getElementById('compareAArea'),
    elementSelect: document.getElementById('compareAElement'),
    structuresToggle: document.getElementById('compareAStructures'),
    canvas: document.getElementById('compareACanvas'),
    loading: document.getElementById('compareALoading'),
    title: document.getElementById('compareATitle'),
    subtitle: document.getElementById('compareASubtitle'),
    legendTitle: document.getElementById('compareALegendTitle'),
    legendMin: document.getElementById('compareALegendMin'),
    legendMax: document.getElementById('compareALegendMax'),
    site: null,
    area: null,
    element: null,
    renderToken: 0,
  },
  b: {
    key: 'b',
    siteSelect: document.getElementById('compareBSite'),
    areaSelect: document.getElementById('compareBArea'),
    elementSelect: document.getElementById('compareBElement'),
    structuresToggle: document.getElementById('compareBStructures'),
    canvas: document.getElementById('compareBCanvas'),
    loading: document.getElementById('compareBLoading'),
    title: document.getElementById('compareBTitle'),
    subtitle: document.getElementById('compareBSubtitle'),
    legendTitle: document.getElementById('compareBLegendTitle'),
    legendMin: document.getElementById('compareBLegendMin'),
    legendMax: document.getElementById('compareBLegendMax'),
    site: null,
    area: null,
    element: null,
    renderToken: 0,
  },
};

const elementNotes = {
  P: 'Phosphorus is often useful for detecting organic residues, dung accumulation, and intensive activity areas.',
  Ca: 'Calcium can reflect ash, bone, dung, or other activity-related enrichment depending on the context.',
  Fe: 'Iron can help highlight combustion, sediment differences, and activity-related soil modification.',
  Mn: 'Manganese may capture subtle soil and activity contrasts, especially when read together with other elements.',
  Sr: 'Strontium can be useful when comparing animal-related and sedimentary signals.',
  Al: 'Aluminium is useful as a background or sediment control element.',
  Si: 'Silicon can help evaluate sediment background and mineralogical contrasts.',
  K: 'Potassium can help compare ash, dung, and sediment-related enrichment patterns.',
  Cl: 'Chlorine may highlight salts or local activity signatures when interpreted with other elements.',
  S: 'Sulfur can be useful for activity-related contrasts and should be read alongside other elements.',
  Ni: 'Nickel can support broader sediment and geochemical comparisons.'
};

function defineProjection() {
  if (!window.proj4) {
    console.warn('proj4js is not available; site locations cannot be derived.');
    return;
  }
  // GeoTIFF rasters are stored in UTM zone 37N; proj4 converts their centers to WGS84.
  proj4.defs('EPSG:32637', EPSG_32637);
}

function setLoading(target, show, message = 'Loading raster...') {
  if (!target) return;
  target.textContent = message;
  target.classList.toggle('hidden', !show);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
  return response.json();
}

async function loadGeoTiff(url) {
  if (tiffCache.has(url)) return tiffCache.get(url);

  // Full-file fetch avoids GeoTIFF.js range-request failures on simple static servers.
  const promise = fetch(url, { cache: 'no-store' })
    .then(response => {
      if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
      return response.arrayBuffer();
    })
    .then(buffer => GeoTIFF.fromArrayBuffer(buffer));

  tiffCache.set(url, promise);
  return promise;
}

function getFirstRasterKey(area) {
  return area && area.rasters ? Object.keys(area.rasters)[0] : null;
}

function formatNumber(v) {
  if (!Number.isFinite(v)) return '-';
  const pct = v * 100;
  const abs = Math.abs(pct);
  if (abs >= 10) return pct.toFixed(1) + ' %';
  if (abs >= 1) return pct.toFixed(2) + ' %';
  if (abs >= 0.1) return pct.toFixed(3) + ' %';
  if (abs >= 0.01) return pct.toFixed(4) + ' %';
  if (abs >= 0.001) return pct.toFixed(5) + ' %';
  return pct.toExponential(2) + ' %';
}

function colorRamp(t) {
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
  const xs = [];
  const ys = [];

  function visit(coords) {
    if (!coords) return;
    if (typeof coords[0] === 'number') {
      xs.push(coords[0]);
      ys.push(coords[1]);
      return;
    }
    coords.forEach(visit);
  }

  if (!geojson || !Array.isArray(geojson.features)) return null;
  geojson.features.forEach(feature => {
    if (feature.geometry) visit(feature.geometry.coordinates);
  });

  if (!xs.length || !ys.length) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function unionBBox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function padBBox(bbox, pct = 0.08) {
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  return [bbox[0] - w * pct, bbox[1] - h * pct, bbox[2] + w * pct, bbox[3] + h * pct];
}

function makeProjector(bbox, canvas) {
  const [minX, minY, maxX, maxY] = bbox;
  const margin = 96;
  const usableW = canvas.width - margin * 2;
  const usableH = canvas.height - margin * 2;
  const scale = Math.min(usableW / (maxX - minX), usableH / (maxY - minY));
  const drawW = (maxX - minX) * scale;
  const drawH = (maxY - minY) * scale;
  const offsetX = (canvas.width - drawW) / 2;
  const offsetY = (canvas.height - drawH) / 2;
  return ([x, y]) => [offsetX + (x - minX) * scale, offsetY + (maxY - y) * scale];
}

function drawRaster(ctx, raster, width, height, bbox, viewBBox, legendMin, legendMax) {
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext('2d');
  const imageData = tctx.createImageData(width, height);

  let min = Infinity;
  let max = -Infinity;
  for (const v of raster) {
    if (Number.isFinite(v) && v !== -9999) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    min = 0;
    max = 1;
  }

  for (let i = 0; i < raster.length; i++) {
    const v = raster[i];
    const offset = i * 4;
    if (!Number.isFinite(v) || v === -9999) {
      imageData.data[offset + 3] = 0;
      continue;
    }
    const [r, g, b] = colorRamp((v - min) / (max - min));
    imageData.data[offset] = r;
    imageData.data[offset + 1] = g;
    imageData.data[offset + 2] = b;
    imageData.data[offset + 3] = 210;
  }
  tctx.putImageData(imageData, 0, 0);

  const project = makeProjector(viewBBox, ctx.canvas);
  const [x0, y0] = project([bbox[0], bbox[3]]);
  const [x1, y1] = project([bbox[2], bbox[1]]);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, x0, y0, x1 - x0, y1 - y0);

  if (legendMin) legendMin.textContent = formatNumber(min);
  if (legendMax) legendMax.textContent = formatNumber(max);
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
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawPolygon(rings) {
    rings.forEach(ring => {
      ctx.beginPath();
      ring.forEach((pt, i) => {
        const [x, y] = project(pt);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    });
  }

  geojson.features.forEach(feature => {
    const geometry = feature.geometry;
    if (!geometry) return;
    if (geometry.type === 'LineString') drawLine(geometry.coordinates);
    if (geometry.type === 'MultiLineString') geometry.coordinates.forEach(drawLine);
    if (geometry.type === 'Polygon') drawPolygon(geometry.coordinates);
    if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(drawPolygon);
  });
  ctx.restore();
}

function drawNorthArrowAndScale(ctx, viewBBox) {
  ctx.save();
  ctx.fillStyle = '#1f2722';
  ctx.strokeStyle = '#1f2722';
  ctx.lineWidth = 2;
  ctx.font = 'bold 16px system-ui';
  ctx.fillText('N', 38, 30);
  ctx.beginPath();
  ctx.moveTo(46, 80);
  ctx.lineTo(46, 40);
  ctx.lineTo(39, 52);
  ctx.moveTo(46, 40);
  ctx.lineTo(53, 52);
  ctx.stroke();

  const metersPerPixel = (viewBBox[2] - viewBBox[0]) / ctx.canvas.width;
  const meters = Math.max(5, Math.round((metersPerPixel * 90) / 5) * 5);
  const scalePx = Math.min(130, Math.max(48, meters / metersPerPixel));
  const x1 = ctx.canvas.width - 42;
  const x0 = x1 - scalePx;
  const y0 = 62;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y0);
  ctx.moveTo(x0, y0 - 5);
  ctx.lineTo(x0, y0 + 5);
  ctx.moveTo(x1, y0 - 5);
  ctx.lineTo(x1, y0 + 5);
  ctx.stroke();
  ctx.font = '13px system-ui';
  ctx.fillText(`${meters} m`, x0, y0 - 9);
  ctx.restore();
}

async function renderRasterPanel(panel) {
  // Shared renderer used by Explore and by both Compare canvases.
  if (!panel.site || !panel.area || !panel.element || !panel.canvas) return;

  const token = (panel.renderToken || 0) + 1;
  panel.renderToken = token;
  setLoading(panel.loading, true);

  const ctx = panel.canvas.getContext('2d');
  ctx.clearRect(0, 0, panel.canvas.width, panel.canvas.height);
  ctx.fillStyle = '#fbfcf8';
  ctx.fillRect(0, 0, panel.canvas.width, panel.canvas.height);

  try {
    const rasterPath = panel.area.rasters[panel.element];
    if (!rasterPath) throw new Error(`No raster configured for ${panel.element}`);

    panel.title.textContent = `${panel.site.name} - ${panel.area.label} - ${panel.element}`;
    panel.subtitle.textContent = `Loading ${rasterPath}`;

    const tiff = await loadGeoTiff(rasterPath);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const bbox = image.getBoundingBox();
    const data = await image.readRasters({ interleave: true });

    let structures = null;
    let structuresBBox = null;
    if (panel.area.structures) {
      structures = await fetchJson(panel.area.structures);
      structuresBBox = getGeometryBBox(structures);
    }

    if (panel.renderToken !== token) return;

    const viewBBox = padBBox(unionBBox(bbox, structuresBBox));
    drawRaster(ctx, data, width, height, bbox, viewBBox, panel.legendMin, panel.legendMax);
    if (panel.showStructures() && structures) drawGeoJSON(ctx, structures, viewBBox);
    drawNorthArrowAndScale(ctx, viewBBox);

    panel.title.textContent = `${panel.site.name} - ${panel.area.label} - ${panel.element}`;
    panel.subtitle.textContent = `${width} x ${height} raster cells - EPSG:32637`;
    panel.legendTitle.textContent = `${panel.element} concentration (%)`;

    return { bbox, viewBBox, width, height };
  } catch (err) {
    console.error(err);
    ctx.fillStyle = '#7b1d1d';
    ctx.font = '20px system-ui';
    ctx.fillText('Could not load this layer.', 40, 80);
    ctx.font = '15px system-ui';
    ctx.fillText(err.message || 'Check file paths and browser console.', 40, 110);
    if (panel.subtitle) panel.subtitle.textContent = err.message || 'Layer failed to load.';
  } finally {
    if (panel.renderToken === token) setLoading(panel.loading, false);
  }
}

function makeExplorePanel() {
  return {
    site: state.site,
    area: state.area,
    element: state.element,
    canvas: el.mapCanvas,
    loading: el.loading,
    title: el.mapTitle,
    subtitle: el.mapSubtitle,
    legendTitle: el.legendTitle,
    legendMin: el.legendMin,
    legendMax: el.legendMax,
    showStructures: () => el.structuresToggle.checked,
    renderToken: state.exploreRenderToken || 0,
  };
}

async function renderExplore() {
  if (!state.site || !state.area || !state.element) return;
  updateExploreInfo();
  const panel = makeExplorePanel();
  const result = await renderRasterPanel(panel);
  state.exploreRenderToken = panel.renderToken;
  if (result) state.lastBBox = result.viewBBox;
  el.interpretation.textContent = elementNotes[state.element] || 'Use this element to explore spatial patterning in the selected area.';
}

function initTabs() {
  el.tabButtons.forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });
  el.tabLinks.forEach(button => {
    button.addEventListener('click', () => switchTab(button.dataset.goTab));
  });
}

function switchTab(tabName) {
  state.activeTab = tabName;
  el.tabButtons.forEach(button => {
    button.classList.toggle('active', button.dataset.tab === tabName);
  });
  Object.entries(el.tabViews).forEach(([key, view]) => {
    const active = key === tabName;
    view.hidden = !active;
    view.classList.toggle('active', active);
  });

  window.setTimeout(() => {
    if (tabName === 'overview' && state.overviewMap) {
      state.overviewMap.invalidateSize();
      fitOverviewToMarkers();
    }
    if (tabName === 'explore') {
      if (state.miniMap) state.miniMap.invalidateSize();
      renderExplore();
    }
    if (tabName === 'compare') renderCompare();
  }, 0);
}

function fitOverviewToMarkers() {
  if (!state.overviewMap || !state.overviewMarkers.length) return;
  const group = L.featureGroup(state.overviewMarkers);
  const bounds = group.getBounds().pad(0.75);
  const latitudeSpan = bounds.getNorth() - bounds.getSouth();
  const defaultCenter = [bounds.getCenter().lat + latitudeSpan * 0.2, bounds.getCenter().lng];
  state.overviewMap.fitBounds(bounds, { padding: [28, 28], animate: false });
  state.overviewMap.setView(defaultCenter, state.overviewMap.getZoom(), { animate: false });
}

async function deriveSiteLocations() {
  // Site coordinates are derived only from local GeoTIFF bounding boxes, never hard-coded.
  if (!window.GeoTIFF || !window.proj4) {
    console.warn('GeoTIFF.js or proj4js is not available; overview locations were not derived.');
    return;
  }

  await Promise.all(state.sites.map(async site => {
    try {
      const area = site.areas.find(item => getFirstRasterKey(item));
      const element = getFirstRasterKey(area);
      if (!area || !element) throw new Error('No raster-backed area available.');

      const tiff = await loadGeoTiff(area.rasters[element]);
      const image = await tiff.getImage();
      const bbox = image.getBoundingBox();
      const centerX = (bbox[0] + bbox[2]) / 2;
      const centerY = (bbox[1] + bbox[3]) / 2;
      const [lon, lat] = proj4('EPSG:32637', 'WGS84', [centerX, centerY]);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Invalid WGS84 conversion.');
      state.locations.set(site.id, { lat, lon, centerX, centerY, bbox, sourceArea: area.id, sourceElement: element });
    } catch (err) {
      console.warn(`Could not derive location for ${site.name}:`, err);
    }
  }));
}

function createImageryLayer() {
  return L.tileLayer(ESRI_IMAGERY, {
    maxNativeZoom: 19,
    maxZoom: 21,
    attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  });
}

function initOverviewMap() {
  // Overview uses Esri World Imagery through Leaflet, with markers from derived coordinates.
  if (!window.L || !el.overviewMap) {
    console.warn('Leaflet is not available.');
    return;
  }

  if (!state.overviewMap) {
    state.overviewMap = L.map(el.overviewMap, {
      scrollWheelZoom: true,
      doubleClickZoom: true,
      touchZoom: true,
      zoomAnimationThreshold: 20,
    });
    createImageryLayer().addTo(state.overviewMap);
  }

  state.overviewMarkers.forEach(marker => marker.remove());
  state.overviewMarkers = [];

  state.sites.forEach(site => {
    const location = state.locations.get(site.id);
    if (!location) return;
    const marker = L.marker([location.lat, location.lon])
      .addTo(state.overviewMap)
      .bindPopup(`<strong>${site.name}</strong>`)
      .bindTooltip(site.name, {
        direction: 'top',
        offset: [0, -10],
        opacity: 0.95,
      });
    marker.on('click', () => {
      selectExploreSite(site.id);
      switchTab('explore');
    });
    state.overviewMarkers.push(marker);
  });

  if (state.overviewMarkers.length) {
    fitOverviewToMarkers();
    el.overviewStatus.hidden = true;
  } else {
    console.warn('No site locations could be derived from the available GeoTIFFs.');
    el.overviewStatus.hidden = true;
  }
}

function updateMiniMap() {
  if (!window.L || !el.miniSiteMap || !state.site) return;
  const location = state.locations.get(state.site.id);
  if (!location) return;

  if (!state.miniMap) {
    state.miniMap = L.map(el.miniSiteMap, {
      zoomControl: false,
      attributionControl: false,
      dragging: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      touchZoom: true,
      boxZoom: true,
      keyboard: true,
    });
    createImageryLayer().addTo(state.miniMap);
  }

  state.miniMap.setView([location.lat, location.lon], 18);
  window.setTimeout(() => state.miniMap.invalidateSize(), 0);
}

function wait(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function flyMapTo(map, center, zoom, duration) {
  return new Promise(resolve => {
    if (!map) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      map.off('moveend', finish);
      resolve();
    };

    map.once('moveend', finish);
    map.flyTo(center, zoom, {
      animate: true,
      duration,
      easeLinearity: .2,
    });
    window.setTimeout(finish, (duration + .9) * 1000);
  });
}

async function runLandscapeZoom() {
  if (!state.overviewMap || state.overviewMapAnimating) return;

  const originalCenter = state.overviewMap.getCenter();
  const originalZoom = state.overviewMap.getZoom();
  const e4Location = state.locations.get('E4');
  const landscapeCenter = e4Location
    ? [e4Location.lat, e4Location.lon]
    : [originalCenter.lat, originalCenter.lng];
  state.overviewMapAnimating = true;
  if (el.landscapeZoomButton) el.landscapeZoomButton.disabled = true;

  try {
    const closeupZoom = Math.min(originalZoom + 4, 20);
    const regionalZoom = Math.max(originalZoom - 8, 8);
    const continentalZoom = Math.max(originalZoom - 11, 5);

    await flyMapTo(state.overviewMap, landscapeCenter, closeupZoom, 2.2);
    await wait(1500);
    for (let zoom = closeupZoom - 4; zoom > regionalZoom; zoom -= 4) {
      await flyMapTo(state.overviewMap, landscapeCenter, zoom, 1.4);
    }
    await flyMapTo(state.overviewMap, landscapeCenter, regionalZoom, 1.8);
    await wait(450);
    await flyMapTo(state.overviewMap, landscapeCenter, continentalZoom, 2.4);
    await wait(700);
    await flyMapTo(state.overviewMap, originalCenter, originalZoom, 2.6);
  } finally {
    state.overviewMapAnimating = false;
    if (el.landscapeZoomButton) el.landscapeZoomButton.disabled = false;
  }
}

function initLandscapeZoomButton() {
  if (!el.landscapeZoomButton) return;
  el.landscapeZoomButton.addEventListener('click', runLandscapeZoom);
}

function updateExploreInfo() {
  if (!state.site || !state.area) return;
  el.photoCard.hidden = !el.photoToggle.checked;
  el.siteInfoHeading.textContent = `${state.site.name} - ${state.area.label}`;
  el.siteInfoMeta.textContent = '';

  if (!el.photoToggle.checked) return;

  const location = state.locations.get(state.site.id);
  if (location) {
    el.siteLocationText.textContent = `Lat ${location.lat.toFixed(5)}, Lon ${location.lon.toFixed(5)} - UTM ${Math.round(location.centerX)}, ${Math.round(location.centerY)}`;
    updateMiniMap();
  } else {
    el.siteLocationText.textContent = '';
  }

  if (state.area.photo) {
    el.sitePhoto.src = state.area.photo;
    el.sitePhoto.alt = `Field photograph for ${state.site.name}, ${state.area.label}`;
    el.sitePhoto.style.display = '';
  } else {
    el.sitePhoto.removeAttribute('src');
    el.sitePhoto.style.display = 'none';
  }
}

function openPhotoModal() {
  if (!el.sitePhoto.src || el.sitePhoto.style.display === 'none') return;
  el.photoModalImage.src = el.sitePhoto.src;
  el.photoModalImage.alt = el.sitePhoto.alt;
  el.photoModal.hidden = false;
  document.body.classList.add('modal-open');
}

function closePhotoModal() {
  el.photoModal.hidden = true;
  el.photoModalImage.removeAttribute('src');
  document.body.classList.remove('modal-open');
}

function populateSiteOptions(select, selectedId) {
  select.innerHTML = '';
  state.sites.forEach(site => select.add(new Option(site.name, site.id)));
  if (selectedId) select.value = selectedId;
}

function populateAreaOptions(select, site, selectedId) {
  select.innerHTML = '';
  site.areas.forEach(area => select.add(new Option(area.label, area.id)));
  select.value = selectedId && site.areas.some(area => area.id === selectedId) ? selectedId : site.areas[0].id;
}

function populateElementOptions(select, area, selectedElement) {
  select.innerHTML = '';
  const elements = Object.keys(area.rasters);
  elements.forEach(element => select.add(new Option(element, element)));
  select.value = selectedElement && elements.includes(selectedElement) ? selectedElement : elements[0];
}

function populateExploreSelectors() {
  populateSiteOptions(el.siteSelect, state.site.id);
  populateAreaOptions(el.areaSelect, state.site, state.area && state.area.id);
  state.area = state.site.areas.find(area => area.id === el.areaSelect.value);
  populateElementOptions(el.elementSelect, state.area, state.element);
  state.element = el.elementSelect.value;
}

function selectExploreSite(siteId) {
  const site = state.sites.find(item => item.id === siteId) || state.sites[0];
  state.site = site;
  state.area = site.areas[0];
  state.element = getFirstRasterKey(state.area);
  populateExploreSelectors();
  renderExplore();
}

function bindExploreSelectors() {
  el.siteSelect.addEventListener('change', () => {
    selectExploreSite(el.siteSelect.value);
  });

  el.areaSelect.addEventListener('change', () => {
    state.area = state.site.areas.find(area => area.id === el.areaSelect.value);
    populateElementOptions(el.elementSelect, state.area, state.element);
    state.element = el.elementSelect.value;
    renderExplore();
  });

  el.elementSelect.addEventListener('change', () => {
    state.element = el.elementSelect.value;
    renderExplore();
  });

  el.structuresToggle.addEventListener('change', renderExplore);
  el.photoToggle.addEventListener('change', updateExploreInfo);
  el.resetButton.addEventListener('click', renderExplore);
  el.sitePhoto.addEventListener('click', openPhotoModal);
  el.photoModalClose.addEventListener('click', closePhotoModal);
  el.photoModal.addEventListener('click', event => {
    if (event.target === el.photoModal) closePhotoModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !el.photoModal.hidden) closePhotoModal();
  });
}

function setupComparePanel(panel, site) {
  panel.site = site;
  panel.area = site.areas[0];
  panel.element = getFirstRasterKey(panel.area);
  populateSiteOptions(panel.siteSelect, site.id);
  populateAreaOptions(panel.areaSelect, panel.site, panel.area.id);
  populateElementOptions(panel.elementSelect, panel.area, panel.element);
}

function updateCompareArea(panel, selectedAreaId, selectedElement) {
  populateAreaOptions(panel.areaSelect, panel.site, selectedAreaId);
  panel.area = panel.site.areas.find(area => area.id === panel.areaSelect.value);
  populateElementOptions(panel.elementSelect, panel.area, selectedElement || panel.element);
  panel.element = panel.elementSelect.value;
}

function bindComparePanel(panel) {
  panel.siteSelect.addEventListener('change', () => {
    panel.site = state.sites.find(site => site.id === panel.siteSelect.value);
    updateCompareArea(panel);
    renderComparePanel(panel);
  });

  panel.areaSelect.addEventListener('change', () => {
    updateCompareArea(panel, panel.areaSelect.value, panel.element);
    renderComparePanel(panel);
  });

  panel.elementSelect.addEventListener('change', () => {
    panel.element = panel.elementSelect.value;
    renderComparePanel(panel);
  });

  panel.structuresToggle.addEventListener('change', () => renderComparePanel(panel));
}

function renderComparePanel(panel) {
  panel.showStructures = () => panel.structuresToggle.checked;
  return renderRasterPanel(panel);
}

function renderCompare() {
  renderComparePanel(comparePanels.a);
  renderComparePanel(comparePanels.b);
}

function initCompare() {
  // Compare starts with two independent panels so users can change site, area, or element freely.
  const firstSite = state.sites[0];
  const secondSite = state.sites[1] || state.sites[0];
  setupComparePanel(comparePanels.a, firstSite);
  setupComparePanel(comparePanels.b, secondSite);
  bindComparePanel(comparePanels.a);
  bindComparePanel(comparePanels.b);
  renderCompare();
}

async function init() {
  defineProjection();
  initTabs();
  initLandscapeZoomButton();

  try {
    const config = await fetchJson(`data/sites.json?v=${Date.now()}`);
    state.sites = config.sites || [];
    if (!state.sites.length) throw new Error('No sites configured.');

    state.site = state.sites[0];
    state.area = state.site.areas[0];
    state.element = getFirstRasterKey(state.area);
    populateExploreSelectors();
    bindExploreSelectors();
    initCompare();
    renderExplore();

    await deriveSiteLocations();
    initOverviewMap();
    updateExploreInfo();
  } catch (err) {
    console.error(err);
    setLoading(el.loading, true, 'Could not load data/sites.json');
    if (el.overviewStatus) el.overviewStatus.hidden = true;
  }
}

init();
