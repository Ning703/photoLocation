import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARD_HEIGHT, CARD_WIDTH, comparePhotos, displayLatitude,
  groupPoints, longitudeExtent, nearestLongitude,
} from '../web/map-layout.mjs';

test('fit uses the short arc at the date line and keeps every point inside', () => {
  assert.deepEqual(longitudeExtent([179, -179], 0), [179, 181]);
  assert.deepEqual(longitudeExtent([179, -179], -170), [-181, -179]);
  assert.equal(nearestLongitude(-179, 180), 181);
  const cities = [-122.4, -70.25, 2.35, 121.2, 151.2];
  const [west, east] = longitudeExtent(cities, 0);
  for (const lng of cities) {
    const wrapped = nearestLongitude(lng, (west + east) / 2);
    assert(wrapped >= west - 1e-8 && wrapped <= east + 1e-8);
  }
  assert.equal(displayLatitude(-33.5), -33.5);
  assert(displayLatitude(89) < 86);
  assert(displayLatitude(-89) > -86);
});

test('clusters preserve every photo and keep complete card rectangles apart at each scale', () => {
  for (const scale of [.25, 1, 4, 30]) {
    const points = Array.from({ length: 250 }, (_, id) => ({
      photo: { id }, x: (((id * 29) % 419) - 270) * scale, y: ((id * 43) % 279) * scale,
    }));
    const groups = groupPoints(points);
    const ids = groups.flatMap(group => group.photos.map(photo => photo.id)).sort((a, b) => a - b);
    assert.deepEqual(ids, points.map(point => point.photo.id));
    for (let index = 0; index < groups.length; index++) {
      const point = groups[index].anchor;
      for (const other of groups.slice(index + 1)) {
        assert(Math.abs(point.x - other.anchor.x) >= CARD_WIDTH ||
               Math.abs(point.y - other.anchor.y) >= CARD_HEIGHT);
      }
    }
  }
  const sameLocation = Array.from({ length: 103 }, (_, id) => ({ x: 1, y: 2, photo: { id } }));
  const [onlyGroup] = groupPoints(sameLocation);
  assert.equal(onlyGroup.photos.length, 103);
  assert.equal(onlyGroup.anchor, sameLocation[0]);
});

test('newest dated photo becomes the cover and undated photos come last', () => {
  const input = [
    { id: 'x', name: 'A.jpg', capturedAt: null },
    { id: 'y', name: 'B.jpg', capturedAt: '2025-01-12T00:00:00' },
    { id: 'z', name: 'C.jpg', capturedAt: '2025-11-12T00:00:00' },
  ];
  assert.deepEqual(input.sort(comparePhotos).map(photo => photo.id), ['z', 'y', 'x']);
});
