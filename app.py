"""Run the photo map on the Windows loopback interface."""

from argparse import ArgumentParser
from http import HTTPStatus
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import hmac
import json
import mimetypes
import os
import secrets
import shutil
import subprocess
import threading
import webbrowser

from catalog import Catalog, resized_jpeg, validate_file

ROOT = Path(__file__).resolve().parent
WEB = ROOT / 'web'
FOLDER_STATE_PATH = ROOT / 'photo-folders.local.json'
TILE_ORIGINS = 'https://tile.openstreetmap.org https://tile.openstreetmap.de'


class PhotoMapServer(ThreadingHTTPServer):
    def __init__(self, port, powershell, folder_state_path=None):
        super().__init__(('127.0.0.1', port), Handler)
        self.catalog = Catalog(folder_state_path)
        self.host = f'127.0.0.1:{self.server_port}'
        self.origin = f'http://{self.host}'
        self.cookie_name = f'photo_map_{self.server_port}'
        self.token = secrets.token_urlsafe(32)
        self.powershell = powershell
        self.picker_lock = threading.Lock()

    def choose_folders(self):
        args = [self.powershell, '-NoLogo', '-NoProfile', '-STA', '-File', str(ROOT / 'pick-folders.ps1')]
        sample = ROOT / 'testPic'
        if sample.is_dir():
            args += ['-InitialDirectory', str(sample)]
        completed = subprocess.run(args, capture_output=True, encoding='utf-8', errors='replace',
                                   creationflags=subprocess.CREATE_NO_WINDOW, check=True)
        return json.loads(completed.stdout)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, content, media_type, *, cookie=False):
        self.send_response(status)
        self.send_header('Content-Type', media_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('Content-Security-Policy',
                         "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                         f"img-src 'self' data: {TILE_ORIGINS}; connect-src 'self'; "
                         "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.send_header('Cache-Control', 'no-store')
        if cookie:
            self.send_header('Set-Cookie', f'{self.server.cookie_name}={self.server.token}; Path=/; HttpOnly; SameSite=Strict')
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def send_json(self, value, status=HTTPStatus.OK):
        self.reply(status, json.dumps(value, ensure_ascii=False).encode('utf-8'),
                   'application/json; charset=utf-8')

    def fail(self, status, message):
        self.send_json({'error': message}, status)

    def valid_host(self):
        if self.headers.get('Host') == self.server.host:
            return True
        self.fail(HTTPStatus.FORBIDDEN, '请使用应用启动时显示的本机地址。')
        return False

    def authenticated(self):
        try:
            value = SimpleCookie(self.headers.get('Cookie', '')).get(self.server.cookie_name)
            if value and hmac.compare_digest(value.value.encode('utf-8'), self.server.token.encode('ascii')):
                return True
        except CookieError:
            pass
        self.fail(HTTPStatus.FORBIDDEN, '本机会话已失效，请刷新页面。')
        return False

    def do_GET(self):
        if not self.valid_host():
            return
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            if self.authenticated():
                self.get_api(path)
            return
        asset = (WEB / ('index.html' if path == '/' else path.lstrip('/'))).resolve()
        if not asset.is_relative_to(WEB) or not asset.is_file():
            self.fail(HTTPStatus.NOT_FOUND, '页面不存在。')
            return
        media_type = 'text/javascript' if asset.suffix in {'.js', '.mjs'} else mimetypes.guess_type(asset)[0]
        media_type = media_type or 'application/octet-stream'
        if media_type.startswith('text/'):
            media_type += '; charset=utf-8'
        self.reply(HTTPStatus.OK, asset.read_bytes(), media_type, cookie=path == '/')

    def get_api(self, path):
        if path == '/api/catalog':
            self.send_json(self.server.catalog.snapshot())
            return
        parts = path.split('/')
        if len(parts) != 5 or parts[2] != 'photos' or parts[4] not in {'thumbnail', 'preview'}:
            self.fail(HTTPStatus.NOT_FOUND, '请求不存在。')
            return
        try:
            photo = self.server.catalog.photo(parts[3])
            info = validate_file(photo.path)
        except (KeyError, OSError, RuntimeError):
            self.fail(HTTPStatus.NOT_FOUND, '照片已移除或文件位置已变化。')
            return
        try:
            size = 320 if parts[4] == 'thumbnail' else 1600
            data = resized_jpeg(photo.path, size, info.st_mtime_ns, info.st_size)
        except Exception:
            self.fail(HTTPStatus.UNPROCESSABLE_ENTITY, '照片无法预览。')
            return
        self.reply(HTTPStatus.OK, data, 'image/jpeg')

    def do_POST(self):
        if not self.valid_host():
            return
        if self.headers.get('Origin') != self.server.origin:
            self.fail(HTTPStatus.FORBIDDEN, '请求必须来自当前本机页面。')
            return
        if not self.authenticated():
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 2048 or self.headers.get_content_type() != 'application/json':
                raise ValueError()
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError()
        except (ValueError, UnicodeError):
            self.fail(HTTPStatus.BAD_REQUEST, '请求格式无效。')
            return
        self.post_api(urlsplit(self.path).path, payload)

    def post_api(self, path, payload):
        catalog = self.server.catalog
        if path == '/api/folders/pick':
            self.pick()
            return
        if path == '/api/folders/rescan':
            catalog.rescan()
            self.send_json(catalog.snapshot())
            return
        parts = path.split('/')
        if len(parts) == 5:
            resource, item_id, action = parts[2:]
            try:
                if resource == 'folders' and action == 'remove':
                    catalog.remove(item_id)
                    self.send_json(catalog.snapshot())
                    return
                if resource == 'folders' and action == 'enabled' and isinstance(payload.get('enabled'), bool):
                    catalog.enable(item_id, payload['enabled'])
                    self.send_json(catalog.snapshot())
                    return
                if resource == 'photos' and action in {'open', 'reveal'}:
                    self.open_photo(catalog.photo(item_id), action)
                    return
            except KeyError:
                self.fail(HTTPStatus.NOT_FOUND, '该项目已从相册移除。')
                return
        self.fail(HTTPStatus.NOT_FOUND, '请求不存在。')

    def pick(self):
        if not self.server.picker_lock.acquire(blocking=False):
            self.fail(HTTPStatus.CONFLICT, '文件夹选择窗口已经打开。')
            return
        try:
            paths = self.server.choose_folders()
            added, rejected = self.server.catalog.add(paths)
            self.send_json(dict(added=added, rejected=rejected, cancelled=not paths,
                                catalog=self.server.catalog.snapshot()))
        except (OSError, ValueError, subprocess.SubprocessError):
            self.fail(HTTPStatus.SERVICE_UNAVAILABLE, '无法打开文件夹选择窗口。请在 Windows 上重新启动应用。')
        finally:
            self.server.picker_lock.release()

    def open_photo(self, photo, action):
        try:
            validate_file(photo.path)
        except (OSError, RuntimeError):
            self.fail(HTTPStatus.NOT_FOUND, '找不到原图，请重新扫描文件夹。')
            return
        try:
            if action == 'open':
                os.startfile(photo.path)
            else:
                explorer = Path(os.environ['SystemRoot']) / 'explorer.exe'
                subprocess.Popen(f'"{explorer}" /select,"{photo.path}"', executable=str(explorer))
        except OSError:
            self.fail(HTTPStatus.SERVICE_UNAVAILABLE, 'Windows 无法执行此操作，请检查默认应用与文件权限。')
            return
        self.send_json({'ok': True})


def main():
    parser = ArgumentParser(description='启动本机照片地图')
    parser.add_argument('--powershell', default=shutil.which('pwsh.exe') or shutil.which('powershell.exe'))
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if os.name != 'nt' or not args.powershell:
        parser.error('请在 Windows 上通过 PowerShell 运行 start.ps1。')

    with PhotoMapServer(args.port, args.powershell, FOLDER_STATE_PATH) as server:
        print(server.origin + '/', flush=True)
        if not args.no_browser:
            threading.Thread(target=webbrowser.open, args=(server.origin + '/',), daemon=True).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.catalog.executor.shutdown(wait=False, cancel_futures=True)


if __name__ == '__main__':
    main()
