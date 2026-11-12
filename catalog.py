"""Read and index geotagged images without changing source files."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock
import json
import math
import os
import stat
import struct
import uuid

from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener
except ImportError:
    register_heif_opener = None

if register_heif_opener:
    register_heif_opener()

EXTENSIONS = {'.jpg', '.jpeg', '.jpe', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic', '.heif'}
Image.init()
IMAGE_FORMATS = tuple(
    kind for kind in ('JPEG', 'PNG', 'WEBP', 'TIFF', 'AVIF', 'HEIF') if kind in Image.OPEN
)
LINK_TAGS = {stat.IO_REPARSE_TAG_MOUNT_POINT, stat.IO_REPARSE_TAG_SYMLINK}


def path_key(path):
    return os.path.normcase(str(path))


def is_link(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or getattr(info, 'st_reparse_tag', 0) in LINK_TAGS


def degrees(values, reference, positive, negative, limit):
    if isinstance(reference, bytes):
        reference = reference.decode('ascii')
    reference = reference.strip('\x00 ').upper()
    if reference not in (positive, negative):
        raise ValueError('Invalid hemisphere')
    whole, minutes, seconds = map(float, values)
    if not (0 <= whole <= limit and 0 <= minutes < 60 and 0 <= seconds < 60):
        raise ValueError('Invalid GPS components')
    coordinate = whole + minutes / 60 + seconds / 3600
    if not math.isfinite(coordinate) or coordinate > limit:
        raise ValueError('Invalid coordinate')
    return coordinate if reference == positive else -coordinate


def gps_position(exif):
    try:
        gps = exif.get_ifd(0x8825)
        latitude = degrees(gps[2], gps[1], 'N', 'S', 90)
        longitude = degrees(gps[4], gps[3], 'E', 'W', 180)
    except (AttributeError, KeyError, TypeError, ValueError, ZeroDivisionError, OverflowError):
        return None
    if latitude == 0 and longitude == 0:
        return None
    return latitude, longitude


def capture_date(exif):
    try:
        date = exif.get_ifd(0x8769).get(36867) or exif.get(36867) or exif.get(306)
        return datetime.strptime(date, '%Y:%m:%d %H:%M:%S').isoformat()
    except (KeyError, TypeError, ValueError, OSError):
        return None


@dataclass(frozen=True)
class Photo:
    id: str
    path: Path
    lat: float
    lng: float
    captured_at: str | None

    def public(self, folder_id):
        return dict(id=self.id, name=self.path.name, lat=self.lat, lng=self.lng,
                    capturedAt=self.captured_at, folderId=folder_id)


@dataclass
class ScanResult:
    photos: dict[str, Photo] = field(default_factory=dict)
    without_gps: set[str] = field(default_factory=set)
    unreadable: set[str] = field(default_factory=set)
    inaccessible: int = 0


def scan_folder(root):
    result = ScanResult()

    def inaccessible(_error):
        result.inaccessible += 1

    for directory, subdirs, files in os.walk(root, onerror=inaccessible):
        base = Path(directory)
        traversable = []
        for name in subdirs:
            try:
                if not is_link(base / name):
                    traversable.append(name)
            except OSError as error:
                inaccessible(error)
        subdirs[:] = traversable
        for name in files:
            path = base / name
            if path.suffix.lower() not in EXTENSIONS:
                continue
            try:
                if is_link(path):
                    continue
                with Image.open(path, formats=IMAGE_FORMATS) as image:
                    exif = image.getexif()
                    position = gps_position(exif)
                    if position is None:
                        result.without_gps.add(path_key(path))
                        continue
                    photo_id = uuid.uuid5(uuid.NAMESPACE_URL, path_key(path)).hex
                    result.photos[photo_id] = Photo(photo_id, path, *position, capture_date(exif))
            except (OSError, ValueError, TypeError, SyntaxError, IndexError, OverflowError,
                    ZeroDivisionError, RuntimeError, struct.error, Image.DecompressionBombError):
                result.unreadable.add(path_key(path))
    return result


def validate_file(path):
    if path_key(path.resolve(strict=True)) != path_key(path) or not path.is_file():
        raise FileNotFoundError(path.name)
    return path.stat()


@lru_cache(maxsize=64)
def resized_jpeg(path, size, modified_ns, file_size):
    with Image.open(path, formats=IMAGE_FORMATS) as image:
        image.draft('RGB', (size, size))
        image = ImageOps.exif_transpose(image)
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        if 'A' in image.getbands() or 'transparency' in image.info:
            rgba = image.convert('RGBA')
            image = Image.new('RGB', rgba.size, '#f8fafc')
            image.paste(rgba, mask=rgba.getchannel('A'))
        else:
            image = image.convert('RGB')
        output = BytesIO()
        image.save(output, format='JPEG', quality=86)
        return output.getvalue()


@dataclass
class Folder:
    id: str
    path: Path
    enabled: bool = True
    scanning: bool = False
    result: ScanResult = field(default_factory=ScanResult)


class Catalog:
    def __init__(self, folder_state_path=None):
        self.lock = RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='photo-scan')
        self.folders = {}
        self.photos = {}
        self.revision = 0
        self.folder_state_path = folder_state_path
        self.folder_memory_error = None
        self._restore_folders()

    def _restore_folders(self):
        if self.folder_state_path is None:
            return
        try:
            records = json.loads(self.folder_state_path.read_text(encoding='utf-8'))
            if not isinstance(records, list):
                raise ValueError('Invalid folder list')
        except FileNotFoundError:
            return
        except (OSError, ValueError, RecursionError):
            self.folder_memory_error = '无法读取上次打开的文件夹列表。'
            return

        known = set()
        with self.lock:
            for record in records:
                if not isinstance(record, dict) or not isinstance(record.get('path'), str):
                    self.folder_memory_error = '无法读取部分已记忆的文件夹。'
                    continue
                root = Path(record['path'])
                enabled = record.get('enabled')
                if not root.is_absolute() or not isinstance(enabled, bool):
                    self.folder_memory_error = '无法读取部分已记忆的文件夹。'
                    continue
                key = path_key(root)
                if key in known:
                    continue
                known.add(key)
                folder = Folder(uuid.uuid4().hex, root, enabled)
                self.folders[folder.id] = folder
                self._enqueue(folder)

    def _save_folders(self):
        target = self.folder_state_path
        if target is None:
            return
        records = [dict(path=str(folder.path), enabled=folder.enabled) for folder in self.folders.values()]
        temporary_path = None
        try:
            with NamedTemporaryFile(mode='w', encoding='utf-8', dir=target.parent,
                                    prefix=target.name + '.', suffix='.tmp', delete=False) as temporary:
                temporary_path = Path(temporary.name)
                json.dump(records, temporary, ensure_ascii=False, indent=2)
                temporary.write('\n')
                temporary.flush()
                os.fsync(temporary.fileno())
            temporary_path.replace(target)
        except (OSError, UnicodeError):
            self.folder_memory_error = '无法保存文件夹列表。'
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass
        else:
            self.folder_memory_error = None

    def _reindex(self):
        self.photos = {}
        for folder in self.folders.values():
            if folder.enabled:
                for photo in folder.result.photos.values():
                    self.photos.setdefault(photo.id, (photo, folder.id))
        self.revision += 1

    def _scan(self, folder):
        try:
            result = scan_folder(folder.path)
        except Exception:
            # A failed scan releases the job and leaves the other folders usable.
            result = ScanResult(inaccessible=1)
        with self.lock:
            if self.folders.get(folder.id) is folder:
                folder.result = result
                folder.scanning = False
                self._reindex()

    def _enqueue(self, folder):
        if not folder.scanning:
            folder.scanning = True
            self.executor.submit(self._scan, folder)

    def add(self, paths):
        added = 0
        rejected = 0
        with self.lock:
            known = {path_key(folder.path) for folder in self.folders.values()}
            for path in paths:
                try:
                    root = Path(path).resolve(strict=True)
                    if not root.is_dir():
                        raise NotADirectoryError(path)
                except (OSError, RuntimeError):
                    rejected += 1
                    continue
                key = path_key(root)
                if key in known:
                    continue
                folder = Folder(uuid.uuid4().hex, root)
                self.folders[folder.id] = folder
                known.add(key)
                self._enqueue(folder)
                added += 1
            if added:
                self._reindex()
                self._save_folders()
        return added, rejected

    def rescan(self):
        with self.lock:
            for folder in self.folders.values():
                self._enqueue(folder)
            self.revision += 1

    def remove(self, folder_id):
        with self.lock:
            self.folders.pop(folder_id)
            self._reindex()
            self._save_folders()

    def enable(self, folder_id, enabled):
        with self.lock:
            self.folders[folder_id].enabled = enabled
            self._reindex()
            self._save_folders()

    def photo(self, photo_id):
        with self.lock:
            return self.photos[photo_id][0]

    def snapshot(self):
        with self.lock:
            folders = [dict(id=f.id, name=f.path.name or str(f.path), path=str(f.path),
                            enabled=f.enabled, scanning=f.scanning, located=len(f.result.photos),
                            withoutGps=len(f.result.without_gps), unreadable=len(f.result.unreadable),
                            inaccessible=f.result.inaccessible) for f in self.folders.values()]
            photos = [photo.public(folder_id) for photo, folder_id in self.photos.values()]
            enabled_results = [folder.result for folder in self.folders.values() if folder.enabled]
            stats = dict(
                withoutGps=len(set().union(*(result.without_gps for result in enabled_results))),
                unreadable=len(set().union(*(result.unreadable for result in enabled_results))),
                inaccessible=sum(result.inaccessible for result in enabled_results),
            )
            return dict(revision=self.revision, folders=folders, photos=photos, stats=stats,
                        scanning=any(folder.scanning for folder in self.folders.values()),
                        folderMemoryError=self.folder_memory_error,
                        heifAvailable=register_heif_opener is not None)
