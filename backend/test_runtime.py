"""HTTP boundary tests; fake pipeline has no access to the user's resource library."""
import json
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from runtime import install, source_slug


class PipelineHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def _gate(self):
        if self.headers.get('X-Deny'):
            self._json({'error': 'authentication required'}, 401)
            return False
        return True

    def _read_json(self):
        return json.loads(self.rfile.read(int(self.headers['Content-Length'])))

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._json({'delegated': self.path, 'index': self.server.index})

    def do_POST(self):
        self._json({'delegated': self.path})


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='reslib-boundary-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.opener = build_opener(ProxyHandler({}))
        self.background_calls = []
        self.scans = []
        self.lib = types.SimpleNamespace(
            Handler=PipelineHandler, LOG_DIR=self.base,
            load_settings=lambda: {'auto_scrape': True, 'anime_version_preferences': {'old': 'version'}},
            _load_meta_cached=lambda: (None, {'work': {'title': 'test'}}),
            _start_background=lambda: self.background_calls.append(True),
            build_index=self.scan,
            _set_server_index=lambda server, value: setattr(server, 'index', value),
        )

    def scan(self):
        self.scans.append(True)
        return {'generation': len(self.scans)}

    def serve(self, role):
        handler = install(self.lib, role, self.base / 'index.html', '9.0.0')
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        server.index = {}
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.url = f'http://127.0.0.1:{server.server_port}'

    def request(self, route, body=None, headers=None, method=None, timeout=None):
        data = json.dumps(body).encode() if body is not None else None
        req = Request(self.url + route, data=data, headers=headers or {}, method=method)
        try:
            response = self.opener.open(req, timeout=timeout)
        except HTTPError as exc:
            response = exc
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None

    def test_display_blocks_management_and_keeps_playback(self):
        self.serve('display')
        for route in ['settings', 'archive', 'reindex', 'scrape', 'subs', 'subscriptions', 'cache', 'comic/cache', 'health', 'links', 'categories', 'resources']:
            with self.subTest(route=route):
                self.assertEqual(self.request('/api/' + route, {})[0], 403)
                self.assertEqual(self.request('/api/' + route)[0], 403)
                self.assertEqual(self.request('/api/' + route, method='HEAD')[0], 403)
        for route in ['progress', 'prepare', 'play', 'login', 'logout']:
            self.assertEqual(self.request('/api/' + route, {})[0], 200)
        for route in ['/api/comic', '/api/comic/page', '/api/sub', '/file', '/play', '/opds']:
            self.assertEqual(self.request(route)[0], 200)
        self.assertEqual(self.request('/api/extras')[1], {'meta': {'work': {'title': 'test'}}})
        self.lib._start_background()
        self.assertEqual(self.background_calls, [])

    def test_preferences_cannot_mutate_management_settings(self):
        self.serve('display')
        self.assertEqual(self.request('/api/preferences')[1]['anime_version_preferences'], {'old': 'version'})
        self.assertEqual(self.request('/api/preferences', {'auto_scrape': False})[0], 400)
        value = {'anime_version_preferences': {'work': 'edition-2'}}
        self.assertEqual(self.request('/api/preferences', value)[1], value)
        self.assertEqual(self.request('/api/preferences')[1], value)
        self.assertTrue(self.lib.load_settings()['auto_scrape'])

    def test_index_read_refreshes_without_management_endpoint(self):
        self.serve('display')
        self.request('/api/library')
        self.request('/api/library')
        self.assertEqual(len(self.scans), 1)
        self.request('/api/library?refresh=1')
        self.assertEqual(len(self.scans), 2)

    def test_first_index_read_on_a_fresh_process_scans_immediately(self):
        """A freshly started process reports a small monotonic clock and must still build the index."""
        self.serve('display')
        with patch('runtime.time.monotonic', return_value=3.0):
            self.request('/api/library')
        self.assertEqual(len(self.scans), 1)

    def test_service_identity_remains_responsive_during_a_blocked_scan(self):
        for role in ('display', 'management'):
            with self.subTest(role=role):
                started, release = threading.Event(), threading.Event()

                def blocked_scan():
                    started.set()
                    if not release.wait(5):
                        raise RuntimeError('test scan was not released')
                    return {'generation': 1}

                self.lib.build_index = blocked_scan
                self.serve(role)
                results = []
                refresh = threading.Thread(target=lambda: results.append(self.request('/api/library?refresh=1')))
                refresh.start()
                try:
                    self.assertTrue(started.wait(2), 'refresh must be scanning')
                    code, identity = self.request('/api/service', timeout=0.5)
                    self.assertEqual(code, 200)
                    self.assertEqual(identity, {'application': 'moonshadow-reslib', 'role': role, 'version': '9.0.0'})
                    self.assertEqual(self.request('/api/service', headers={'X-Deny': 'true'}, timeout=0.5)[0], 401)
                finally:
                    release.set()
                    refresh.join(2)
                self.assertFalse(refresh.is_alive())
                self.assertEqual(results[0][0], 200)

    def test_management_preserves_gate_and_owns_scheduler(self):
        self.serve('management')
        self.assertEqual(self.request('/api/settings', {}, {'X-Deny': 'true'})[0], 401)
        self.assertEqual(self.request('/api/settings', {}, {'Origin': 'http://127.0.0.1:8777'})[0], 403)
        self.assertEqual(self.request('/api/settings', {}, {'Origin': self.url})[0], 200)
        self.lib._start_background()
        self.assertEqual(self.background_calls, [True])
        self.assertEqual(self.request('/api/service')[1]['role'], 'management')
        self.assertEqual(self.request('/api/links')[1]['opds'], 'http://127.0.0.1:8777/opds')

    def test_management_categories_keep_pipeline_partitions_and_novel_children(self):
        archive_dirs = ('动画', '电影', '漫画', '韩漫', '小说', '音乐', '游戏', '助眠', 'AV')
        self.lib.build_index = lambda: {
            'comic': [{'count': 2, 'size': 100}],
            'manhwa': [{'count': 3, 'size': 200}],
            'novel': [{'subcategory': '日系轻小说', 'count': 4, 'size': 300},
                      {'subcategory': '网文', 'count': 1, 'size': 50}],
            'game': [{'count': 5, 'size': 400}],
        }
        classifier = types.SimpleNamespace(CATEGORY_DIRS=archive_dirs,
                                            NOVEL_SUBCATEGORIES=('日系轻小说', '网文'))
        with patch.dict('sys.modules', {'classify': classifier}):
            self.serve('management')
            code, catalog = self.request('/api/categories')
            self.assertEqual(code, 200)
            categories = {c['id']: c for c in catalog['categories']}
            self.assertEqual({c['label'] for c in categories.values()}, set(archive_dirs))
            self.assertEqual(categories['comic']['items'], 2)
            self.assertEqual(categories['manhwa']['items'], 3)
            self.assertEqual(categories['game']['count'], 1)
            self.assertEqual(categories['game']['size'], 400)
            self.assertEqual([c['count'] for c in categories['novel']['children']], [1, 1])
            values = {c['value'] for c in catalog['archive_categories']}
            self.assertEqual(values, set(archive_dirs) | {'小说/日系轻小说', '小说/网文'})
            self.assertEqual(self.request('/api/library')[1]['index']['game'][0]['count'], 5)

    def test_source_update_preserves_progress_and_rejects_unsupported_links(self):
        subs = {'示例漫画': {'slug': 'old', 'known': 12, 'pending': 2, 'enabled': False}}
        fake = types.SimpleNamespace(load_subs=lambda: json.loads(json.dumps(subs)),
                                     save_subs=lambda value: subs.update(value))
        with patch.dict('sys.modules', {'subscribe': fake}):
            self.serve('management')
            body = {'action': 'update', 'name': '示例漫画', 'source_url': 'https://www.baozimh.com/comic/new-source'}
            self.assertEqual(self.request('/api/subscriptions', body)[0], 200)
            self.assertEqual(subs['示例漫画']['known'], 12)
            self.assertEqual(subs['示例漫画']['pending'], 2)
            self.assertFalse(subs['示例漫画']['enabled'])
            self.assertEqual(subs['示例漫画']['slug'], 'new-source')
            body['source_url'] = 'https://example.com/comic/other'
            self.assertEqual(self.request('/api/subscriptions', body)[0], 400)
            self.assertEqual(subs['示例漫画']['slug'], 'new-source')

    def test_slug_parsing(self):
        self.assertEqual(source_slug('sample-123'), 'sample-123')
        for value in ['../settings', 'file:///private', 'https://baozimh.com.evil/comic/a', 'https://baozimh.com/chapter/a']:
            with self.assertRaises(ValueError):
                source_slug(value)

    def test_management_saves_reader_links_and_rejects_non_web_addresses(self):
        self.serve('management')
        code, value = self.request('/api/links', {'display': 'http://192.168.1.10:8777/'})
        self.assertEqual(code, 200)
        self.assertEqual(value['opds'], 'http://192.168.1.10:8777/opds')
        self.assertEqual(self.request('/api/links')[1], value)
        for url in ['javascript:alert(1)', 'http://user:password@host', 'http://host/path', 'http://host:99999']:
            self.assertEqual(self.request('/api/links', {'display': url})[0], 400)


if __name__ == '__main__':
    unittest.main()
