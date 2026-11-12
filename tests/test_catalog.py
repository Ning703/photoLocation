from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep
import json
import unittest
from unittest.mock import patch

from PIL import Image
from PIL.TiffImagePlugin import IFDRational

from catalog import Catalog, gps_position, register_heif_opener, resized_jpeg, scan_folder


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def wait_for_scan(catalog):
    deadline = monotonic() + 10
    while monotonic() < deadline:
        snapshot = catalog.snapshot()
        if not snapshot['scanning']:
            return snapshot
        sleep(.03)
    raise AssertionError('Scan did not finish')


def location_exif():
    exif = Image.Exif()
    exif[0x8825] = {
        1: 'S', 2: tuple(map(IFDRational, (33, 30, 0))),
        3: 'W', 4: tuple(map(IFDRational, (70, 15, 0))),
    }
    exif[274] = 6
    exif[306] = '2025:10:11 12:30:55'
    return exif


class CatalogTests(unittest.TestCase):
    def test_folder_memory_restores_paths_visibility_and_new_photos(self):
        with TemporaryDirectory(dir=PROJECT_ROOT) as temporary, Image.new('RGB', (16, 16)) as image:
            root = Path(temporary).resolve()
            state_path = root / 'folders.json'
            enabled = root / '旅行 照片'
            hidden = root / 'Hidden'
            removed = root / 'Removed'
            for folder in (enabled, hidden, removed):
                folder.mkdir()
                image.save(folder / 'first.jpg', exif=location_exif())

            original = Catalog(state_path)
            with original.executor:
                self.assertEqual(original.add([enabled, hidden, removed]), (3, 0))
                _, second, third = original.snapshot()['folders']
                original.enable(second['id'], False)
                original.remove(third['id'])

            self.assertEqual(json.loads(state_path.read_text(encoding='utf-8')), [
                {'path': str(enabled), 'enabled': True},
                {'path': str(hidden), 'enabled': False},
            ])
            image.save(enabled / 'added_while_closed.jpg', exif=location_exif())

            restored = Catalog(state_path)
            with restored.executor:
                snapshot = wait_for_scan(restored)
                self.assertEqual([(folder['path'], folder['enabled']) for folder in snapshot['folders']],
                                 [(str(enabled), True), (str(hidden), False)])
                self.assertEqual({photo['name'] for photo in snapshot['photos']},
                                 {'first.jpg', 'added_while_closed.jpg'})
                for folder in snapshot['folders']:
                    restored.remove(folder['id'])

            empty = Catalog(state_path)
            with empty.executor:
                self.assertEqual(empty.snapshot()['folders'], [])

    def test_folder_memory_keeps_unavailable_path_for_rescan(self):
        with TemporaryDirectory(dir=PROJECT_ROOT) as temporary:
            root = Path(temporary).resolve()
            state_path = root / 'folders.json'
            folder = root / 'Removable'
            folder.mkdir()
            original = Catalog(state_path)
            with original.executor:
                original.add([folder])
            folder.rmdir()

            restored = Catalog(state_path)
            with restored.executor:
                missing, = wait_for_scan(restored)['folders']
                self.assertEqual(missing['path'], str(folder))
                self.assertEqual(missing['inaccessible'], 1)
                folder.mkdir()
                with Image.new('RGB', (16, 16)) as image:
                    image.save(folder / 'returned.jpg', exif=location_exif())
                restored.rescan()
                self.assertEqual(len(wait_for_scan(restored)['photos']), 1)

    def test_folder_memory_reports_read_and_save_errors(self):
        with TemporaryDirectory(dir=PROJECT_ROOT) as temporary:
            root = Path(temporary).resolve()
            state_path = root / 'folders.json'
            state_path.write_text('{', encoding='utf-8')
            catalog = Catalog(state_path)
            with catalog.executor:
                self.assertTrue(catalog.snapshot()['folderMemoryError'])
                self.assertEqual(catalog.add([root]), (1, 0))
                snapshot = catalog.snapshot()
                self.assertIsNone(snapshot['folderMemoryError'])
                saved = state_path.read_bytes()
                folder, = snapshot['folders']
                with patch.object(Path, 'replace', side_effect=PermissionError):
                    catalog.enable(folder['id'], False)
                self.assertTrue(catalog.snapshot()['folderMemoryError'])
                self.assertEqual(state_path.read_bytes(), saved)
                self.assertFalse(list(root.glob('*.tmp')))

    def test_folder_filters_and_deduplication(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        expected = {'02': 5, '05': 4, 'Folder01': 3, 'Folder03': 4}
        with Image.new('RGB', (16, 16)) as image:
            for name, count in expected.items():
                folder = root / name
                folder.mkdir()
                for index in range(count):
                    image.save(folder / f'{index}.jpg', exif=location_exif())
            image.save(root / 'Folder03' / 'no-location.jpg')

        catalog = Catalog()
        self.addCleanup(catalog.executor.shutdown)
        children = [root / name for name in expected]
        self.assertEqual(catalog.add(children), (4, 0))
        self.assertEqual(catalog.add(children), (0, 0))
        snapshot = wait_for_scan(catalog)
        self.assertEqual({f['name']: f['located'] for f in snapshot['folders']}, expected)
        self.assertEqual(len(snapshot['photos']), 16)
        self.assertEqual(snapshot['stats']['withoutGps'], 1)
        first = snapshot['folders'][0]
        catalog.enable(first['id'], False)
        self.assertEqual(len(catalog.snapshot()['photos']), 11)
        catalog.enable(first['id'], True)
        catalog.add([root])
        snapshot = wait_for_scan(catalog)
        self.assertEqual(len(snapshot['photos']), 16)
        self.assertEqual(snapshot['stats']['withoutGps'], 1)
        catalog.remove(snapshot['folders'][-1]['id'])
        catalog.remove(first['id'])
        catalog.rescan()
        self.assertEqual(len(wait_for_scan(catalog)['photos']), 11)

    def test_metadata_and_rotation_with_corrupt_neighbor(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / '南半球 照片.JPG'
            Image.new('RGB', (80, 40), '#23a281').save(path, exif=location_exif())
            Image.new('RGB', (15, 15)).save(root / 'no-location.png')
            (root / 'invalid.jpg').write_bytes(b'broken')
            contents = path.read_bytes()

            scan = scan_folder(root)
            self.assertEqual(len(scan.without_gps), 1)
            self.assertEqual(len(scan.unreadable), 1)
            photo, = scan.photos.values()
            self.assertEqual((photo.lat, photo.lng), (-33.5, -70.25))
            self.assertEqual(photo.captured_at, '2025-10-11T12:30:55')
            stat = path.stat()
            data = resized_jpeg(path, 24, stat.st_mtime_ns, stat.st_size)
            with Image.open(BytesIO(data)) as preview:
                self.assertEqual(preview.size, (12, 24))
            self.assertEqual(path.read_bytes(), contents)

    @unittest.skipUnless(register_heif_opener, 'pillow-heif is not installed')
    def test_heic_gps_and_preview(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / 'camera.heic'
            Image.new('RGB', (80, 40)).save(path, format='HEIF', exif=location_exif())
            photo, = scan_folder(root).photos.values()
            self.assertEqual((photo.lat, photo.lng), (-33.5, -70.25))
            stat = path.stat()
            data = resized_jpeg(path, 24, stat.st_mtime_ns, stat.st_size)
            with Image.open(BytesIO(data)) as preview:
                self.assertEqual(max(preview.size), 24)

    def test_reject_incomplete_and_invalid_gps(self):
        exif = Image.Exif()
        exif.load(location_exif().tobytes())
        gps = exif.get_ifd(0x8825)
        self.assertEqual(gps_position(exif), (-33.5, -70.25))
        gps[1] = 'W'
        self.assertIsNone(gps_position(exif))
        gps[1] = 'N'
        gps[2] = (90, 0, 1)
        self.assertIsNone(gps_position(exif))
        gps[2] = (33, 30, 0)
        del gps[4]
        self.assertIsNone(gps_position(exif))

    def test_gps_direction_tags_determine_signs(self):
        exif = Image.Exif()
        exif.load(location_exif().tobytes())
        gps = exif.get_ifd(0x8825)
        for latitude, lat_sign in [('N', 1), ('S', -1)]:
            for longitude, lng_sign in [('E', 1), ('W', -1)]:
                with self.subTest(latitude=latitude, longitude=longitude):
                    gps[1], gps[3] = latitude, longitude
                    self.assertEqual(gps_position(exif), (lat_sign * 33.5, lng_sign * 70.25))

    def test_only_a_pair_of_zero_coordinates_counts_as_no_location(self):
        positions = {
            'zero.jpg': ((0, 0, 0), (0, 0, 0)),
            'equator.jpg': ((0, 0, 0), (70, 15, 0)),
            'prime-meridian.jpg': ((33, 30, 0), (0, 0, 0)),
        }
        with TemporaryDirectory() as temporary, Image.new('RGB', (16, 16)) as image:
            root = Path(temporary).resolve()
            for filename, (latitude, longitude) in positions.items():
                exif = location_exif()
                gps = exif[0x8825]
                gps[2] = tuple(map(IFDRational, latitude))
                gps[4] = tuple(map(IFDRational, longitude))
                image.save(root / filename, exif=exif)

            scan = scan_folder(root)
            self.assertEqual(len(scan.without_gps), 1)
            self.assertEqual({photo.path.name: (photo.lat, photo.lng) for photo in scan.photos.values()},
                             {'equator.jpg': (0, -70.25), 'prime-meridian.jpg': (-33.5, 0)})


if __name__ == '__main__':
    unittest.main()
