import {
  CARD_HEIGHT, CARD_WIDTH, comparePhotos, displayLatitude,
  groupPoints, longitudeExtent, nearestLongitude,
} from './map-layout.mjs';
import { savedLanguage, saveLanguage, translate } from './language.mjs';

let language = savedLanguage();
const t = (key, ...args) => translate(language, key, ...args);

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
let toastMessage;
let locationLabelKey = 'myLocation';
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
  if (!response.ok) {
    const error = new Error(result.error);
    error.code = result.errorCode;
    throw error;
  }
  return result;
}

function showToast(key, ...args) {
  toastMessage = [key, ...args];
  clearTimeout(toastTimeout);
  const toast = byId('toast');
  toast.textContent = t(...toastMessage);
  toast.hidden = false;
  toastTimeout = setTimeout(() => { toast.hidden = true; }, 3800);
}

function setLocationLabel(key) {
  locationLabelKey = key;
  locationLabel.textContent = t(key);
}

function stopLocation() {
  if (locationWatch !== null) navigator.geolocation.clearWatch(locationWatch);
  locationWatch = null;
  locationMarker?.remove();
  locationMarker = null;
  locationButton.setAttribute('aria-pressed', 'false');
  setLocationLabel('myLocation');
  renderEmpty();
}

function showLocation({ coords }) {
  const point = L.latLng(displayLatitude(coords.latitude), nearestLongitude(coords.longitude, map.getCenter().lng));
  setLocationLabel('myLocation');
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
  showToast('locationFound');
}

function toggleLocation() {
  if (locationWatch !== null) {
    stopLocation();
    showToast('locationOff');
    return;
  }
  if (!window.isSecureContext || !navigator.geolocation) {
    showToast('locationUnavailable');
    return;
  }

  locationButton.setAttribute('aria-pressed', 'true');
  setLocationLabel('locating');
  const watch = navigator.geolocation.watchPosition(
    position => {
      if (locationWatch === watch) showLocation(position);
    },
    error => {
      if (locationWatch !== watch) return;
      if (error.code === GeolocationPositionError.PERMISSION_DENIED) {
        stopLocation();
        showToast('locationDenied');
      } else {
        setLocationLabel('locationWaiting');
        showToast(locationMarker ? 'lastLocation' : 'waitingForLocation');
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
    checkbox.setAttribute('aria-label', t('showFolder', folder.name));
    checkbox.addEventListener('change', async () => {
      try {
        await mutateFolder(folder.id, 'enabled', { enabled: checkbox.checked });
      } catch (error) {
        checkbox.checked = folder.enabled;
        showToast(error.code ?? 'requestFailed');
      }
    });
    const copy = element('span', 'folder-copy');
    const meta = folder.scanning ? t('scanning') : [
      t('locatedCount', folder.located),
      folder.withoutGps && t('noGpsCount', folder.withoutGps),
      folder.inaccessible && t('inaccessibleFolder'),
    ].filter(Boolean).join(' · ');
    copy.append(element('span', 'folder-name', folder.name), element('span', 'folder-meta', meta));
    label.append(checkbox, copy);
    const remove = element('button', 'icon-button', '×');
    remove.type = 'button';
    remove.dataset.folderControl = 'remove-' + folder.id;
    remove.setAttribute('aria-label', t('removeNamedFolder', folder.name));
    remove.title = t('removeFolder');
    remove.addEventListener('click', () => {
      mutateFolder(folder.id, 'remove', {}).catch(error => showToast(error.code ?? 'requestFailed'));
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
  if (state.scanning) messages.push(t('scanningFolders'));
  if (state.stats?.unreadable) messages.push(t('unreadableCount', state.stats.unreadable));
  if (state.stats?.inaccessible) messages.push(t('inaccessibleCount', state.stats.inaccessible));
  if (state.folderMemoryErrorCode) messages.push(t(state.folderMemoryErrorCode));
  if (state.heifAvailable === false) messages.push(t('heifUnavailable'));
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
    title.textContent = t('readingPhotos');
    note.textContent = t('readingGps');
  } else if (state.folders.length && !state.folders.some(folder => folder.enabled)) {
    title.textContent = t('noFoldersSelected');
    note.textContent = t('selectFolderHint');
  } else if (state.folders.length) {
    title.textContent = t('noPhotosFound');
    note.textContent = t('selectGpsFolder');
  } else {
    title.textContent = t('emptyTitle');
    note.textContent = t('emptyNote');
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
    showToast(error.code ?? 'requestFailed');
    if (state.scanning) polling = setTimeout(loadCatalog, 1500);
  }
}

async function mutateFolder(id, action, data) {
  updateState(await api('/folders/' + id + '/' + action, data));
}

async function pickFolders() {
  const buttons = document.querySelectorAll('[data-pick]');
  for (const button of buttons) button.disabled = true;
  showToast('chooseImportFolders');
  try {
    const result = await api('/folders/pick', { language });
    updateState(result.catalog);
    if (result.rejected) showToast('rejectedFolders', result.rejected);
    else if (result.added) showToast('addedFolders', result.added);
    else if (!result.cancelled) showToast('existingFolders');
    else byId('toast').hidden = true;
  } catch (error) {
    showToast(error.code ?? 'requestFailed');
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

function labelMarker(button, count) {
  button.title = t('photoCount', count);
  button.setAttribute('aria-label', t('viewPhotosHere', count));
}

function markerButton(group) {
  const photo = group.anchor.photo;
  const total = group.photos.length;
  const button = element('button', 'marker-card');
  button.type = 'button';
  button.dataset.photo = photo.id;
  labelMarker(button, total);
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
  byId('gallery-title').textContent = t('photoCount', galleryItems.length);
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
        heading.dataset.text = 'dateUnknown';
        heading.textContent = t('dateUnknown');
      }
      dayPhotos = element('div', 'gallery-photos');
      section.append(heading, dayPhotos);
      items.append(section);
      previousDay = day;
    }

    const button = element('button', 'gallery-item');
    button.type = 'button';
    button.setAttribute('aria-label', t('previewPhoto', index + 1));
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

function renderViewerDetails(photo) {
  const date = photo.capturedAt?.replace('T', ' ');
  const outside = displayLatitude(photo.lat) !== photo.lat;
  byId('viewer-details').textContent = [
    coordinates(photo), date, outside && t('polarMarker'),
  ].filter(Boolean).join('  ·  ');
}

function showPhoto(index) {
  if (index < 0 || index >= galleryItems.length) return;
  viewerIndex = index;
  const photo = galleryItems[index];
  byId('viewer-title').textContent = photo.name;
  byId('viewer-position').textContent = (index + 1) + ' / ' + galleryItems.length;
  renderViewerDetails(photo);
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
    status.textContent = t(action === 'open' ? 'originalOpened' : 'originalRevealed');
  } catch (error) {
    status.textContent = t(error.code ?? 'requestFailed');
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
    showToast(error.code ?? 'requestFailed');
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

function applyLanguage() {
  document.documentElement.lang = language;
  document.title = t('appTitle');
  for (const node of document.querySelectorAll('[data-text]')) node.textContent = t(node.dataset.text);
  for (const node of document.querySelectorAll('[data-label]')) node.setAttribute('aria-label', t(node.dataset.label));
  for (const node of document.querySelectorAll('[data-title]')) node.title = t(node.dataset.title);

  const nextLanguage = byId('language-toggle').firstElementChild;
  nextLanguage.lang = language === 'en' ? 'zh-CN' : 'en';
  nextLanguage.textContent = language === 'en' ? '简体中文' : 'English';
  setLocationLabel(locationLabelKey);
  renderFolders();
  renderEmpty();
  for (const button of mapElement.querySelectorAll('.marker-card')) {
    labelMarker(button, Number(button.querySelector('.marker-count').textContent));
  }
  if (!gallery.hidden) {
    byId('gallery-title').textContent = t('photoCount', galleryItems.length);
    gallery.querySelectorAll('.gallery-item').forEach((button, index) => {
      button.setAttribute('aria-label', t('previewPhoto', index + 1));
    });
  }
  if (viewer.open) renderViewerDetails(galleryItems[viewerIndex]);
  const toast = byId('toast');
  if (!toast.hidden && toastMessage) toast.textContent = t(...toastMessage);
}

byId('language-toggle').addEventListener('click', () => {
  language = language === 'en' ? 'zh-CN' : 'en';
  saveLanguage(language);
  applyLanguage();
});

applyLanguage();
loadCatalog();
