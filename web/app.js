import {
  CARD_HEIGHT, CARD_WIDTH, comparePhotos, displayLatitude,
  groupPoints, longitudeExtent, nearestLongitude,
} from './map-layout.mjs';

const byId = id => document.getElementById(id);
const mapElement = byId('map');
const stage = byId('map-stage');
const map = L.map(mapElement, {
  zoomControl: false,
  minZoom: 1,
  maxZoom: 21,
  zoomAnimation: false,
  markerZoomAnimation: false,
}).setView([25, 0], 2);
const osmCredit = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
const baseMaps = {
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: osmCredit,
  },
  'osm-de': {
    url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
    attribution: osmCredit + ' · <a href="https://openstreetmap.de/germanstyle/">FOSSGIS</a>' +
      ' <a href="https://creativecommons.org/licenses/by-sa/2.0/">CC BY-SA 2.0</a>',
  },
};
const baseMapSelect = byId('basemap');
const retryTiles = byId('retry-tiles');
let tiles;

function switchBaseMap() {
  tiles?.remove();
  retryTiles.hidden = true;
  const { url, attribution } = baseMaps[baseMapSelect.value];
  const layer = L.tileLayer(url, { maxNativeZoom: 19, attribution });
  let tileBatchFailed = false;
  layer.on({
    loading: () => { tileBatchFailed = false; },
    tileerror: () => {
      tileBatchFailed = true;
      if (tiles === layer) retryTiles.hidden = false;
    },
    load: () => {
      if (tiles === layer) retryTiles.hidden = !tileBatchFailed;
    },
  });
  tiles = layer;
  layer.addTo(map);
}

baseMapSelect.addEventListener('change', switchBaseMap);
switchBaseMap();
L.control.scale({ imperial: false }).addTo(map);
const markers = L.layerGroup().addTo(map);

let state = { revision: -1, folders: [], photos: [], scanning: false };
let orderedPhotos = [];
let galleryItems = [];
let galleryTrigger = null;
let viewerIndex = 0;
let hasFit = false;
let mapFrame = 0;
let zooming = false;
let polling;
let toastTimeout;
let locationWatch = null;
let locationMarker = null;

const folderList = byId('folders');
const gallery = byId('gallery');
const viewer = byId('viewer');
const fullImage = byId('full-image');
const zoomIn = byId('zoom-in');
const zoomOut = byId('zoom-out');
const fit = byId('fit');
const locationButton = byId('my-location');
const locationLabel = byId('location-label');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, data) {
  const options = data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
  const response = await fetch('/api' + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败。');
  return result;
}

function showToast(message) {
  clearTimeout(toastTimeout);
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 3800);
}

function stopLocation() {
  if (locationWatch !== null) navigator.geolocation.clearWatch(locationWatch);
  locationWatch = null;
  locationMarker?.remove();
  locationMarker = null;
  locationButton.setAttribute('aria-pressed', 'false');
  locationLabel.textContent = '我的位置';
  renderEmpty();
}

function showLocation({ coords }) {
  const point = L.latLng(displayLatitude(coords.latitude), nearestLongitude(coords.longitude, map.getCenter().lng));
  locationLabel.textContent = '我的位置';
  if (locationMarker) {
    locationMarker.setLatLng(point);
    return;
  }

  const icon = L.divIcon({ className: 'current-location-marker', iconSize: [16, 16], iconAnchor: [8, 8] });
  locationMarker = L.marker(point, { icon, interactive: false, keyboard: false, zIndexOffset: 10000 }).addTo(map);
  renderEmpty();

  const galleryPadding = matchMedia('(max-width: 760px)').matches
    ? [0, gallery.offsetHeight + 24]
    : [gallery.offsetWidth + 16, 0];
  map.fitBounds([point, point], {
    paddingBottomRight: gallery.hidden ? [0, 0] : galleryPadding,
    maxZoom: Math.max(15, map.getZoom()),
    animate: false,
  });
  showToast('已定位到当前位置。');
}

function toggleLocation() {
  if (locationWatch !== null) {
    stopLocation();
    showToast('已关闭定位。');
    return;
  }
  if (!window.isSecureContext || !navigator.geolocation) {
    showToast('当前页面无法使用定位，请用 Edge 或 Chrome 打开应用的本机地址。');
    return;
  }

  locationButton.setAttribute('aria-pressed', 'true');
  locationLabel.textContent = '定位中…';
  const watch = navigator.geolocation.watchPosition(
    position => {
      if (locationWatch === watch) showLocation(position);
    },
    error => {
      if (locationWatch !== watch) return;
      if (error.code === GeolocationPositionError.PERMISSION_DENIED) {
        stopLocation();
        showToast('定位权限未开启，请检查浏览器和 Windows 的位置权限。');
      } else {
        locationLabel.textContent = '等待定位…';
        showToast(locationMarker ? '定位暂时不可用，蓝点为上次位置。' : '暂时无法获取位置，正在等待定位。');
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
  );
  locationWatch = watch;
}

function wrapLocationMarker() {
  if (!locationMarker) return;
  const point = locationMarker.getLatLng();
  const longitude = nearestLongitude(point.lng, map.getCenter().lng);
  if (longitude !== point.lng) locationMarker.setLatLng([point.lat, longitude]);
}

function renderFolders() {
  const activeKey = document.activeElement?.dataset.folderControl;
  const scroll = folderList.scrollTop;
  const items = state.folders.map(folder => {
    const item = element('li');
    const label = element('label', 'folder-option');
    label.title = folder.path;
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = folder.enabled;
    checkbox.dataset.folderControl = 'include-' + folder.id;
    checkbox.setAttribute('aria-label', '显示 ' + folder.name);
    checkbox.addEventListener('change', async () => {
      try {
        await mutateFolder(folder.id, 'enabled', { enabled: checkbox.checked });
      } catch (error) {
        checkbox.checked = folder.enabled;
        showToast(error.message);
      }
    });
    const copy = element('span', 'folder-copy');
    const meta = folder.scanning ? '正在扫描…' : folder.located + ' 张定位照片' +
      (folder.withoutGps ? ' · ' + folder.withoutGps + ' 张无定位' : '') +
      (folder.inaccessible ? ' · 有路径无法访问' : '');
    copy.append(element('span', 'folder-name', folder.name), element('span', 'folder-meta', meta));
    label.append(checkbox, copy);
    const remove = element('button', 'icon-button', '×');
    remove.type = 'button';
    remove.dataset.folderControl = 'remove-' + folder.id;
    remove.setAttribute('aria-label', '移除 ' + folder.name);
    remove.title = '移除文件夹';
    remove.addEventListener('click', () => {
      mutateFolder(folder.id, 'remove', {}).catch(error => showToast(error.message));
    });
    item.append(label, remove);
    return item;
  });
  folderList.replaceChildren(...items);
  folderList.scrollTop = scroll;
  if (activeKey) {
    folderList.querySelector('[data-folder-control="' + activeKey + '"]')?.focus({ preventScroll: true });
  }
  byId('folder-hint').hidden = state.folders.length > 0;
  byId('rescan').disabled = !state.folders.length || state.scanning;
  byId('photo-count').textContent = state.photos.length;
  byId('skip-count').textContent = state.stats?.withoutGps ?? 0;
  const summary = byId('scan-summary');
  const messages = [];
  if (state.scanning) messages.push('正在扫描所选文件夹…');
  if (state.stats?.unreadable) messages.push(state.stats.unreadable + ' 个文件无法读取');
  if (state.stats?.inaccessible) messages.push(state.stats.inaccessible + ' 个目录或项目无法访问');
  if (state.folderMemoryError) messages.push(state.folderMemoryError);
  if (state.heifAvailable === false) messages.push('缺少 HEIC 支持，请安装 requirements.txt 中的依赖。');
  summary.textContent = messages.join(' · ');
  summary.hidden = !messages.length;
}

function renderEmpty() {
  const empty = byId('empty-map');
  empty.hidden = state.photos.length > 0 || locationMarker !== null;
  fit.disabled = !state.photos.length;
  const title = byId('empty-title');
  const note = byId('empty-note');
  const pick = byId('empty-pick');
  pick.hidden = state.scanning;
  if (state.scanning) {
    title.textContent = '正在读取照片';
    note.textContent = '正在查找所选文件夹内的 GPS 信息。';
  } else if (state.folders.length && !state.folders.some(folder => folder.enabled)) {
    title.textContent = '未选中文件夹';
    note.textContent = '勾选一个文件夹来显示其中的定位照片。';
  } else if (state.folders.length) {
    title.textContent = '没有找到定位照片';
    note.textContent = '请选择包含 GPS 拍摄信息的照片文件夹。';
  } else {
    title.textContent = '把照片放到地图上';
    note.textContent = '选择文件夹，查看照片的拍摄地点。';
  }
}

function updateState(next) {
  if (next.revision <= state.revision) return;
  state = next;
  orderedPhotos = [...state.photos].sort(comparePhotos);
  renderFolders();
  renderEmpty();
  if (!gallery.hidden) {
    const current = new Set(state.photos.map(photo => photo.id));
    if (galleryItems.some(photo => !current.has(photo.id))) closeGallery(false);
  }
  if (!hasFit && state.photos.length && !state.scanning) {
    hasFit = true;
    if (!locationMarker) fitPhotos();
  }
  scheduleMap();
  clearTimeout(polling);
  if (state.scanning) polling = setTimeout(loadCatalog, 380);
}

async function loadCatalog() {
  try {
    const snapshot = await api('/catalog');
    const previous = state.revision;
    updateState(snapshot);
    if (state.scanning && previous === state.revision) polling = setTimeout(loadCatalog, 380);
  } catch (error) {
    showToast(error.message);
    if (state.scanning) polling = setTimeout(loadCatalog, 1500);
  }
}

async function mutateFolder(id, action, data) {
  updateState(await api('/folders/' + id + '/' + action, data));
}

async function pickFolders() {
  const buttons = document.querySelectorAll('[data-pick]');
  for (const button of buttons) button.disabled = true;
  showToast('请选择要导入的文件夹。');
  try {
    const result = await api('/folders/pick', {});
    updateState(result.catalog);
    if (result.rejected) showToast(result.rejected + ' 个文件夹无法访问。');
    else if (result.added) showToast('已添加 ' + result.added + ' 个文件夹。');
    else if (!result.cancelled) showToast('所选文件夹已在列表中。');
    else byId('toast').hidden = true;
  } catch (error) {
    showToast(error.message);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function fitPhotos() {
  if (!orderedPhotos.length) return;
  const latitudes = orderedPhotos.map(photo => displayLatitude(photo.lat));
  const [west, east] = longitudeExtent(orderedPhotos.map(photo => photo.lng), map.getCenter().lng);
  let south = latitudes[0];
  let north = south;
  for (const lat of latitudes) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  const height = map.getSize().y;
  map.fitBounds([[south, west], [north, east]], {
    paddingTopLeft: [60, Math.min(116, height / 4)],
    paddingBottomRight: [60, 45],
    maxZoom: 17,
    animate: false,
  });
}

function photoUrl(photo, size) {
  return '/api/photos/' + photo.id + '/' + size;
}

function markerButton(group) {
  const photo = group.anchor.photo;
  const total = group.photos.length;
  const button = element('button', 'marker-card');
  button.type = 'button';
  button.dataset.photo = photo.id;
  button.title = total + ' 张照片';
  button.setAttribute('aria-label', '查看此处的 ' + total + ' 张照片');
  const frame = element('span', 'marker-frame');
  const crop = element('span', 'marker-photo');
  const image = element('img');
  image.src = photoUrl(photo, 'thumbnail');
  image.alt = '';
  image.decoding = 'async';
  image.addEventListener('error', () => { image.hidden = true; });
  crop.append(image);
  frame.append(crop);
  button.append(frame, element('span', 'marker-count', total));
  L.DomEvent.disableClickPropagation(button);
  button.addEventListener('click', () => openGallery(group, button));
  return button;
}

function renderMarkers() {
  if (zooming) return;
  const focusPhoto = document.activeElement?.dataset.photo;
  const center = map.getCenter().lng;
  const size = map.getSize();
  const points = orderedPhotos.map(photo => {
    const position = L.latLng(displayLatitude(photo.lat), nearestLongitude(photo.lng, center));
    const point = map.latLngToLayerPoint(position);
    return { photo, position, x: point.x, y: point.y };
  });
  const groups = groupPoints(points);
  markers.clearLayers();
  let restored = false;
  for (const group of groups) {
    const { x, y, position } = group.anchor;
    const view = map.layerPointToContainerPoint(L.point(x, y));
    if (view.x < -CARD_WIDTH || view.y < 0 ||
        view.x > size.x + CARD_WIDTH || view.y > size.y + CARD_HEIGHT) continue;
    const button = markerButton(group);
    const icon = L.divIcon({
      html: button,
      className: 'photo-marker',
      iconSize: [CARD_WIDTH, CARD_HEIGHT],
      iconAnchor: [CARD_WIDTH / 2, CARD_HEIGHT - 2],
    });
    L.marker(position, { icon, keyboard: false, autoPanOnFocus: false }).addTo(markers);
    if (focusPhoto === button.dataset.photo) {
      button.focus({ preventScroll: true });
      restored = true;
    }
  }
  if (focusPhoto && !restored) mapElement.focus({ preventScroll: true });
  zoomIn.disabled = map.getZoom() >= map.getMaxZoom();
  zoomOut.disabled = map.getZoom() <= map.getMinZoom();
  mapElement.classList.remove('zooming');
}

function scheduleMap() {
  if (mapFrame) return;
  mapFrame = requestAnimationFrame(() => {
    mapFrame = 0;
    renderMarkers();
  });
}

function coordinates(photo) {
  const format = (value, positive, negative) => Math.abs(value).toFixed(5) + '° ' +
    (value < 0 ? negative : positive);
  return format(photo.lat, 'N', 'S') + '  ·  ' + format(photo.lng, 'E', 'W');
}

function openGallery(group, trigger) {
  galleryItems = group.photos;
  galleryTrigger = trigger;
  byId('gallery-title').textContent = group.photos.length + ' 张照片';
  byId('gallery-location').textContent = coordinates(group.anchor.photo);
  const items = document.createDocumentFragment();
  let previousDay;
  let dayPhotos;
  galleryItems.forEach((photo, index) => {
    const day = photo.capturedAt?.slice(0, 10) ?? '';
    if (day !== previousDay) {
      const section = element('section', 'gallery-day-group');
      const heading = element('h3', 'gallery-day');
      if (day) {
        const date = element('time', '', day);
        date.dateTime = day;
        heading.append(date);
      } else {
        heading.textContent = '拍摄日期未知';
      }
      dayPhotos = element('div', 'gallery-photos');
      section.append(heading, dayPhotos);
      items.append(section);
      previousDay = day;
    }

    const button = element('button', 'gallery-item');
    button.type = 'button';
    button.setAttribute('aria-label', '预览第 ' + (index + 1) + ' 张照片');
    const thumbnail = element('span', 'gallery-thumbnail');
    const image = element('img');
    image.alt = '';
    image.src = photoUrl(photo, 'thumbnail');
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => { image.hidden = true; });
    thumbnail.append(image);
    button.append(thumbnail);
    button.addEventListener('click', () => openViewer(index));
    dayPhotos.append(button);
  });
  const grid = byId('gallery-grid');
  grid.replaceChildren(items);
  grid.scrollTop = 0;
  gallery.hidden = false;
  stage.classList.add('has-gallery');
  byId('close-gallery').focus({ preventScroll: true });
}

function closeGallery(restoreFocus = true) {
  if (viewer.open) viewer.close();
  gallery.hidden = true;
  stage.classList.remove('has-gallery');
  galleryItems = [];
  if (restoreFocus) {
    const target = galleryTrigger?.isConnected ? galleryTrigger : mapElement;
    target.focus({ preventScroll: true });
  }
  galleryTrigger = null;
}

function showPhoto(index) {
  if (index < 0 || index >= galleryItems.length) return;
  viewerIndex = index;
  const photo = galleryItems[index];
  byId('viewer-title').textContent = photo.name;
  byId('viewer-position').textContent = (index + 1) + ' / ' + galleryItems.length;
  const date = photo.capturedAt?.replace('T', ' ');
  const outside = displayLatitude(photo.lat) !== photo.lat ? ' · 标记显示在极区边缘' : '';
  byId('viewer-details').textContent = coordinates(photo) + (date ? '  ·  ' + date : '') + outside;
  byId('viewer-status').hidden = true;
  byId('preview-error').hidden = true;
  fullImage.hidden = false;
  fullImage.alt = photo.name;
  fullImage.src = photoUrl(photo, 'preview');
  byId('previous').disabled = index === 0;
  byId('next').disabled = index + 1 === galleryItems.length;
}

function openViewer(index) {
  showPhoto(index);
  viewer.showModal();
}

async function nativeAction(action) {
  const photo = galleryItems[viewerIndex];
  const status = byId('viewer-status');
  try {
    await api('/photos/' + photo.id + '/' + action, {});
    status.textContent = action === 'open' ? '已请求 Windows 打开原图。' : '已请求 Windows 定位原图。';
  } catch (error) {
    status.textContent = error.message;
  }
  status.hidden = false;
}

map.on('zoomstart', () => {
  zooming = true;
  mapElement.classList.add('zooming');
});
map.on('zoomend', () => {
  zooming = false;
  scheduleMap();
});
map.on('moveend', scheduleMap);
map.on('moveend', wrapLocationMarker);
new ResizeObserver(() => {
  map.invalidateSize({ pan: false });
  scheduleMap();
}).observe(mapElement);

for (const button of document.querySelectorAll('[data-pick]')) button.addEventListener('click', pickFolders);
byId('rescan').addEventListener('click', async () => {
  try {
    updateState(await api('/folders/rescan', {}));
  } catch (error) {
    showToast(error.message);
  }
});
byId('toggle-folders').addEventListener('click', event => {
  const expanded = document.querySelector('.sidebar').classList.toggle('is-expanded');
  event.currentTarget.setAttribute('aria-expanded', expanded);
});
fit.addEventListener('click', fitPhotos);
locationButton.addEventListener('click', toggleLocation);
window.addEventListener('pagehide', stopLocation);
retryTiles.addEventListener('click', () => {
  retryTiles.hidden = true;
  tiles.redraw();
});
zoomIn.addEventListener('click', () => map.zoomIn());
zoomOut.addEventListener('click', () => map.zoomOut());
byId('close-gallery').addEventListener('click', () => closeGallery());
byId('close-viewer').addEventListener('click', () => viewer.close());
byId('previous').addEventListener('click', () => showPhoto(viewerIndex - 1));
byId('next').addEventListener('click', () => showPhoto(viewerIndex + 1));
byId('reveal').addEventListener('click', () => nativeAction('reveal'));
byId('open-original').addEventListener('click', () => nativeAction('open'));
fullImage.addEventListener('error', () => {
  fullImage.hidden = true;
  byId('preview-error').hidden = false;
});
viewer.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  showPhoto(viewerIndex + (event.key === 'ArrowLeft' ? -1 : 1));
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !viewer.open && !gallery.hidden) closeGallery();
});

loadCatalog();
