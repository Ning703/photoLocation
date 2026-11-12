export const CARD_WIDTH = 88;
export const CARD_HEIGHT = 94;
const GAP = 10;
const MERCATOR_LIMIT = 85.0511287798;
const filenames = new Intl.Collator('zh-CN', { numeric: true });

export function displayLatitude(lat) {
  return Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat));
}

export function nearestLongitude(lng, center) {
  return lng + 360 * Math.round((center - lng) / 360);
}

export function longitudeExtent(longitudes, center) {
  const ordered = longitudes.map(lng => ((lng % 360) + 360) % 360).sort((a, b) => a - b);
  let gap = -1;
  let end = ordered[0];
  for (let index = 0; index < ordered.length; index++) {
    const current = ordered[index];
    const next = index + 1 < ordered.length ? ordered[index + 1] : ordered[0] + 360;
    if (next - current > gap) {
      gap = next - current;
      end = current;
    }
  }
  const start = end - (360 - gap);
  const midpoint = (start + end) / 2;
  const offset = nearestLongitude(midpoint, center) - midpoint;
  return [start + offset, end + offset];
}

export function comparePhotos(first, second) {
  return (second.capturedAt || '').localeCompare(first.capturedAt || '') ||
    filenames.compare(first.name, second.name) ||
    first.id.localeCompare(second.id);
}

// Points are already ordered by cover preference. Keeping the cover position
// fixed prevents merging one card from making another card start to overlap.
export function groupPoints(points) {
  const spacingX = CARD_WIDTH + GAP;
  const spacingY = CARD_HEIGHT + GAP;
  const cells = new Map();
  const groups = [];
  const key = (x, y) => x + ',' + y;

  for (const point of points) {
    const cellX = Math.floor(point.x / spacingX);
    const cellY = Math.floor(point.y / spacingY);
    let closest;
    let bestDistance = Infinity;
    for (let row = cellY - 1; row <= cellY + 1; row++) {
      for (let column = cellX - 1; column <= cellX + 1; column++) {
        const group = cells.get(key(column, row));
        if (!group) continue;
        const dx = Math.abs(group.anchor.x - point.x);
        const dy = Math.abs(group.anchor.y - point.y);
        const distance = dx * dx + dy * dy;
        if (dx < spacingX && dy < spacingY && distance < bestDistance) {
          bestDistance = distance;
          closest = group;
        }
      }
    }
    if (closest) {
      closest.photos.push(point.photo);
    } else {
      const group = { anchor: point, photos: [point.photo] };
      cells.set(key(cellX, cellY), group);
      groups.push(group);
    }
  }
  return groups;
}
