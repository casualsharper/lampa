import contextlib
import http.client
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

WEB_ROOT = tempfile.mkdtemp()
os.environ['HOMESYNC_DATA'] = tempfile.mkdtemp()
os.environ['LAMPA_ROOT'] = WEB_ROOT
os.environ['TORRSERVER'] = '10.0.0.5:8090'
import server  # noqa: E402

WEB_FILES = {
    'index.html': '<html>lampa</html>',
    'app.min.js': 'var app = 1;',
    'sub/inner.txt': 'inner',
    '.git/config': 'secret',
    'selfhost/server.py': 'secret',
    'data/p2.json': 'secret',
}
for name, text in WEB_FILES.items():
    os.makedirs(os.path.dirname(os.path.join(WEB_ROOT, name)), exist_ok=True)
    with open(os.path.join(WEB_ROOT, name), 'w') as f:
        f.write(text)
with open(os.path.join(os.path.dirname(WEB_ROOT), 'outside.txt'), 'w') as f:
    f.write('secret')


def card(id_, title='x'):
    return {'id': id_, 'title': title}


class HttpTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.root = 'http://127.0.0.1:%d/' % cls.httpd.server_address[1]
        cls.base = cls.root + 'homesync/'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        for f in os.listdir(server.DATA_DIR):
            os.unlink(os.path.join(server.DATA_DIR, f))

    def call(self, path, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method='POST' if data is not None else 'GET')
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def fetch(self, path):
        conn = http.client.HTTPConnection('127.0.0.1', self.httpd.server_address[1])
        conn.request('GET', path)
        response = conn.getresponse()
        result = response.status, response.read().decode(), response.getheader('Content-Security-Policy') or '', response.getheader('Content-Type') or ''
        conn.close()
        return result



class HomesyncTest(HttpTestBase):
    def add(self, profile, where, id_, op='add'):
        return self.call('profile/' + profile, {'ops': [{'op': op, 'where': where, 'id': id_, 'card': card(id_)}]})

    def test_new_profile_is_empty_and_not_listed_until_written(self):
        code, state = self.call('profile/p1')
        self.assertEqual(code, 200)
        self.assertEqual(state['favorite']['book'], [])
        self.assertEqual(state['file_view'], {})
        self.assertEqual(self.call('profiles')[1], [])

    def test_add_puts_newest_first_and_stores_card_once(self):
        self.add('p1', 'book', 1)
        self.add('p1', 'like', 1)
        _, state = self.add('p1', 'book', 2)
        self.assertEqual(state['favorite']['book'], [2, 1])
        self.assertEqual(sorted(c['id'] for c in state['favorite']['card']), [1, 2])
        self.assertEqual(self.call('profiles')[1], ['p1'])

    def test_added_moves_existing_item_to_top(self):
        self.add('p1', 'history', 1)
        self.add('p1', 'history', 2)
        _, state = self.add('p1', 'history', 1, op='added')
        self.assertEqual(state['favorite']['history'], [1, 2])

    def test_remove_drops_card_only_when_unused(self):
        self.add('p1', 'book', 1)
        self.add('p1', 'like', 1)
        _, state = self.call('profile/p1', {'ops': [{'op': 'remove', 'where': 'book', 'id': 1}]})
        self.assertEqual([c['id'] for c in state['favorite']['card']], [1])
        _, state = self.call('profile/p1', {'ops': [{'op': 'remove', 'where': 'like', 'id': '1'}]})
        self.assertEqual(state['favorite']['card'], [])

    def test_edits_from_two_devices_both_survive(self):
        self.add('p1', 'book', 1)
        self.add('p1', 'book', 2)
        self.call('profile/p1', {'ops': [{'op': 'remove', 'where': 'book', 'id': 1}]})
        _, state = self.add('p1', 'book', 3)
        self.assertEqual(state['favorite']['book'], [3, 2])

    def test_profiles_are_separate(self):
        self.add('p1', 'book', 1)
        _, state = self.call('profile/p2')
        self.assertEqual(state['favorite']['book'], [])
        self.assertEqual(self.call('profiles')[1], ['p1'])

    def test_timeline_keeps_newest_by_updated(self):
        self.call('profile/p1', {'timelines': {'h1': {'time': 50, 'updated': 200}}})
        _, state = self.call('profile/p1', {'timelines': {'h1': {'time': 10, 'updated': 100}, 'h2': {'time': 5, 'updated': 1}}})
        self.assertEqual(state['file_view']['h1']['time'], 50)
        self.assertEqual(state['file_view']['h2']['time'], 5)
        _, state = self.call('profile/p1', {'timelines': {'h1': {'time': 70, 'updated': 300}}})
        self.assertEqual(state['file_view']['h1']['time'], 70)

    def test_resume_keeps_newest_per_title_and_survives_reload(self):
        self.call('profile/p1', {'resume': {'tv_1': {'magnet': 'm2', 'updated': 200}}})
        _, state = self.call('profile/p1', {'resume': {'tv_1': {'magnet': 'm1', 'updated': 100}, 'movie_2': {'magnet': 'm3', 'updated': 1}}})
        self.assertEqual(state['resume']['tv_1']['magnet'], 'm2')
        self.assertEqual(state['resume']['movie_2']['magnet'], 'm3')
        self.assertEqual(self.call('profile/p1')[1]['resume']['tv_1']['magnet'], 'm2')

    def test_bad_resume_is_rejected_without_saving(self):
        for resume in ['nope', {'tv_1': 'nope'}, {'x' * 65: {}}, {'tv_1': {'magnet': 'm' * 3000}}]:
            self.assertEqual(self.call('profile/p1', {'resume': resume})[0], 400, resume)
        self.assertEqual(os.listdir(server.DATA_DIR), [])

    def test_prefs_keep_newest_per_setting(self):
        self.call('profile/p1', {'prefs': {'audiofix': {'value': 'false', 'updated': 200}}})
        _, state = self.call('profile/p1', {'prefs': {'audiofix': {'value': 'true', 'updated': 100},
                                                      'playbest_lang_1': {'value': 'ru', 'updated': 5}}})
        self.assertEqual(state['prefs'], {'audiofix': {'value': 'false', 'updated': 200},
                                          'playbest_lang_1': {'value': 'ru', 'updated': 5}})
        self.assertEqual(self.call('profile/p2')[1]['prefs'], {})

    def test_bad_or_too_many_prefs_are_rejected(self):
        self.assertEqual(self.call('profile/p1', {'prefs': {'x': {'value': 'v' * 3000}}})[0], 400)
        too_many = {'k%d' % i: {'value': '1', 'updated': 1} for i in range(server.MAX_PREFS + 1)}
        self.assertEqual(self.call('profile/p1', {'prefs': too_many})[0], 400)
        self.assertEqual(os.listdir(server.DATA_DIR), [])

    def test_profile_saved_before_resume_existed_loads(self):
        with open(os.path.join(server.DATA_DIR, 'p1.json'), 'w') as f:
            json.dump({'favorite': {'book': [1]}, 'file_view': {}}, f)
        _, state = self.call('profile/p1', {'resume': {'tv_1': {'updated': 1}}})
        self.assertEqual(state['favorite']['book'], [1])
        self.assertEqual(list(state['resume']), ['tv_1'])

    def test_bad_profile_names_are_rejected(self):
        for name in ['', '..%2Fetc', 'a%2Fb', 'a.b', 'x' * 33, 'sp%20ace']:
            self.assertEqual(self.call('profile/' + name)[0], 404, name)
            self.assertEqual(self.call('profile/' + name, {'ops': []})[0], 404, name)
        self.assertEqual(os.listdir(server.DATA_DIR), [])

    def test_bad_ops_are_rejected_without_saving(self):
        bad = [
            {'op': 'drop', 'where': 'book', 'id': 1},
            {'op': 'add', 'where': 'card', 'id': 1},
            {'op': 'add', 'where': 'book', 'id': True},
            {'op': 'add', 'where': 'book', 'id': 'x' * 65},
            'not an op',
        ]
        for op in bad:
            self.assertEqual(self.call('profile/p1', {'ops': [op]})[0], 400, op)
        self.assertEqual(self.call('profile/p1', {'ops': 'nope'})[0], 400)
        self.assertEqual(self.call('profile/p1', {'timelines': {'h': 'nope'}})[0], 400)
        self.assertEqual(self.call('profile/p1', raw=b'{broken')[0], 400)
        self.assertEqual(os.listdir(server.DATA_DIR), [])

    def test_oversized_card_is_not_stored(self):
        big = {'id': 1, 'overview': 'x' * (server.MAX_CARD_BYTES + 1)}
        _, state = self.call('profile/p1', {'ops': [{'op': 'add', 'where': 'book', 'id': 1, 'card': big}]})
        self.assertEqual(state['favorite']['book'], [1])
        self.assertEqual(state['favorite']['card'], [])

    def test_too_large_body_is_rejected_before_reading_it(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.httpd.server_address[1])
        conn.putrequest('POST', '/homesync/profile/p1')
        conn.putheader('Content-Length', str(server.MAX_BODY + 1))
        conn.endheaders()
        self.assertEqual(conn.getresponse().status, 413)
        conn.close()
        self.assertEqual(os.listdir(server.DATA_DIR), [])

    def test_unknown_path_is_404(self):
        self.assertEqual(self.call('nope')[0], 404)

    def test_serves_app_files_with_allowlist_header(self):
        code, body, csp, _ = self.fetch('/')
        self.assertEqual((code, body), (200, '<html>lampa</html>'))
        self.assertIn("connect-src 'self' https://api.themoviedb.org https://image.tmdb.org http://10.0.0.5:8090", csp)
        self.assertNotIn('cub', csp)
        code, body, _, content_type = self.fetch('/app.min.js?v=123')
        self.assertEqual((code, body), (200, 'var app = 1;'))
        self.assertTrue(content_type.startswith('text/javascript'))

    def test_config_js_carries_torrserver_address(self):
        code, body, _, content_type = self.fetch('/config.js')
        self.assertEqual(code, 200)
        self.assertEqual(body, 'window.home_config = {"torrserver": "10.0.0.5:8090"};\n')
        self.assertTrue(content_type.startswith('text/javascript'))

    def test_app_files_are_revalidated_and_api_answers_never_cached(self):
        def cache_control(path):
            conn = http.client.HTTPConnection('127.0.0.1', self.httpd.server_address[1])
            conn.request('GET', path)
            response = conn.getresponse()
            response.read()
            conn.close()
            return response.getheader('Cache-Control'), len(response.headers.get_all('Cache-Control') or [])
        self.assertEqual(cache_control('/index.html'), ('no-cache', 1))
        self.assertEqual(cache_control('/homesync/profiles'), ('no-store', 1))
        self.assertEqual(cache_control('/index.html'), ('no-cache', 1))

    def test_api_responses_also_carry_allowlist_header(self):
        self.assertIn('default-src', self.fetch('/homesync/profiles')[2])

    def test_git_server_code_listings_and_escapes_are_hidden(self):
        for path in ['/.git/config', '/%2Egit/config', '/selfhost/server.py', '/SelfHost/server.py', '/data/p2.json', '/Data/p2.json', '/SELFHOST/../selfhost/server.py',
                     '/sub/', '/../outside.txt', '/%2e%2e/outside.txt', '/sub/%2e%2e/%2e%2e/outside.txt']:
            code, body, _, _ = self.fetch(path)
            self.assertEqual(code, 404, path)
            self.assertNotIn('secret', body, path)
        self.assertEqual(self.fetch('/sub/inner.txt')[:2], (200, 'inner'))

    def test_torrserver_value_is_validated(self):
        for good in ['192.168.1.10:8090', 'nas.local:8090', 'nas']:
            self.assertTrue(server.TORRSERVER_RE.match(good), good)
        for bad in ["x'; script-src *", 'a b:1', 'http://x:1', 'x:1;y', 'x:123456']:
            self.assertFalse(server.TORRSERVER_RE.match(bad), bad)

    @unittest.skipIf(os.geteuid() == 0, 'root ignores folder permissions')
    def test_unwritable_data_folder_answers_503_and_is_reported(self):
        self.assertIsNone(server.data_dir_problem())
        os.chmod(server.DATA_DIR, 0o500)
        try:
            self.assertIsNotNone(server.data_dir_problem())
            with contextlib.redirect_stderr(io.StringIO()) as log:
                code, body = self.call('profile/p1', {'ops': []})
            self.assertEqual((code, body), (503, {'error': 'data folder not writable'}))
            self.assertIn('cannot write', log.getvalue())
            self.assertEqual(self.call('profiles'), (200, []))
        finally:
            os.chmod(server.DATA_DIR, 0o700)
        self.assertEqual(self.add('p1', 'book', 1)[0], 200)

    def test_csp_without_torrserver_has_no_empty_host(self):
        csp = server.content_security_policy('')
        self.assertNotIn('http://;', csp)
        self.assertNotIn('http:// ', csp)


if __name__ == '__main__':
    unittest.main()


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class CastTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.cast = server.Cast(clock=self.clock)

    def test_command_reaches_a_polling_device(self):
        self.cast.poll('tv-aaaaaaaa', 'TV', timeout=0)
        self.assertTrue(self.cast.send('tv-aaaaaaaa', {'action': 'open'}))
        self.assertEqual(self.cast.poll('tv-aaaaaaaa', 'TV', timeout=0), [{'action': 'open'}])
        self.assertEqual(self.cast.poll('tv-aaaaaaaa', 'TV', timeout=0), [])

    def test_waiting_poll_wakes_up_on_send(self):
        self.cast.poll('tv-aaaaaaaa', 'TV', timeout=0)
        got = []
        waiter = threading.Thread(target=lambda: got.extend(self.cast.poll('tv-aaaaaaaa', 'TV', timeout=5)))
        waiter.start()
        self.cast.send('tv-aaaaaaaa', {'action': 'play'})
        waiter.join(2)
        self.assertEqual(got, [{'action': 'play'}])

    def test_offline_and_unknown_devices_refuse_commands(self):
        self.assertFalse(self.cast.send('nobody-123', {'action': 'open'}))
        self.cast.poll('tv-aaaaaaaa', 'TV', timeout=0)
        self.clock.now += server.ONLINE_SECONDS + 1
        self.assertFalse(self.cast.send('tv-aaaaaaaa', {'action': 'open'}))
        self.assertEqual(self.cast.online(), [])

    def test_online_lists_names_sorted(self):
        self.cast.poll('phone-aaaa', 'phone', timeout=0)
        self.cast.poll('tv-bbbbbbbb', 'Living room', timeout=0)
        self.assertEqual([d['name'] for d in self.cast.online()], ['Living room', 'phone'])

    def test_device_count_is_capped_by_dropping_the_oldest(self):
        for i in range(server.MAX_DEVICES + 1):
            self.clock.now += 1
            self.cast.poll('device-%04d' % i, 'd%d' % i, timeout=0)
        self.assertEqual(len(self.cast.devices), server.MAX_DEVICES)
        self.assertNotIn('device-0000', self.cast.devices)

    def test_queue_keeps_only_the_latest_commands(self):
        self.cast.poll('tv-aaaaaaaa', 'TV', timeout=0)
        for i in range(server.MAX_QUEUE + 3):
            self.cast.send('tv-aaaaaaaa', {'n': i})
        got = self.cast.poll('tv-aaaaaaaa', 'TV', timeout=0)
        self.assertEqual(len(got), server.MAX_QUEUE)
        self.assertEqual(got[-1], {'n': server.MAX_QUEUE + 2})


class CastCommandTest(unittest.TestCase):
    def test_open_keeps_only_id_and_method(self):
        self.assertEqual(server.clean_cast_command({'action': 'open', 'card': {'id': 5, 'method': 'tv', 'x': '<script>'}}),
                         {'action': 'open', 'card': {'id': 5, 'method': 'tv'}})

    def test_play_keeps_url_title_and_numeric_timeline(self):
        cmd = server.clean_cast_command({'action': 'play', 'url': 'http://10.0.0.5:8090/stream/a.mkv?play', 'title': 't' * 300,
                                         'timeline': {'time': 61.5, 'percent': 4, 'hash': 123, 'evil': 'x', 'duration': True}})
        self.assertEqual(cmd['title'], 't' * 200)
        self.assertEqual(cmd['timeline'], {'time': 61.5, 'percent': 4, 'hash': 123})

    def test_bad_commands_are_rejected(self):
        bad = [None, {}, {'action': 'eval'}, {'action': 'open', 'card': {'id': '5', 'method': 'tv'}},
               {'action': 'open', 'card': {'id': True, 'method': 'tv'}}, {'action': 'open', 'card': {'id': 5, 'method': 'person'}},
               {'action': 'play', 'url': 'javascript:alert(1)'}, {'action': 'play', 'url': 'http://x/' + 'a' * 3000}]
        for command in bad:
            with self.assertRaises(server.BadRequest, msg=command):
                server.clean_cast_command(command)

    def test_names_are_trimmed_and_cleaned(self):
        self.assertEqual(server.clean_name('  TV\x00\n room  '), 'TV room')
        self.assertEqual(len(server.clean_name('x' * 100)), server.MAX_NAME)
        for bad in ['', '   ', None, 5]:
            with self.assertRaises(server.BadRequest):
                server.clean_name(bad)


class CastHttpTest(HttpTestBase):
    def setUp(self):
        super().setUp()
        server.CAST = server.Cast()
        self.poll_seconds, server.POLL_SECONDS = server.POLL_SECONDS, 0.2

    def tearDown(self):
        server.POLL_SECONDS = self.poll_seconds

    def test_send_then_poll_over_http(self):
        self.assertEqual(self.call('cast/poll', {'device': 'tv-aaaaaaaa', 'name': 'TV'}), (200, {'commands': []}))
        self.assertEqual(self.call('cast/devices'), (200, [{'id': 'tv-aaaaaaaa', 'name': 'TV'}]))
        command = {'action': 'open', 'card': {'id': 550, 'method': 'movie'}}
        self.assertEqual(self.call('cast/send', {'to': 'tv-aaaaaaaa', 'from': 'Phone', 'command': command}), (200, {'ok': True}))
        self.assertEqual(self.call('cast/poll', {'device': 'tv-aaaaaaaa', 'name': 'TV'}),
                         (200, {'commands': [{'action': 'open', 'card': {'id': 550, 'method': 'movie'}, 'from': 'Phone'}]}))

    def test_http_errors(self):
        self.assertEqual(self.call('cast/send', {'to': 'nobody-123', 'from': 'P', 'command': {'action': 'open', 'card': {'id': 1, 'method': 'tv'}}})[0], 404)
        self.assertEqual(self.call('cast/send', {'to': 'x', 'from': 'P', 'command': {'action': 'eval'}})[0], 400)
        self.assertEqual(self.call('cast/poll', {'device': '../etc', 'name': 'TV'})[0], 400)
        self.assertEqual(self.call('cast/poll', {'device': 'tv-aaaaaaaa'})[0], 400)
        self.assertEqual(self.call('cast/poll', raw=b'x' * (server.MAX_CAST_BODY + 1))[0], 413)


TS = 'http://10.0.0.5:8090'


class AudioFixUnitTest(unittest.TestCase):
    def test_only_streams_from_our_torrserver_are_accepted(self):
        self.assertEqual(server.torrserver_source(TS + '/stream/a.mkv?link=x&index=1&play'), TS + '/stream/a.mkv?link=x&index=1&play')
        for bad in ['http://example.com/a.mkv', 'http://10.0.0.5:22/', 'https://10.0.0.5:8090/a', 'file:///etc/passwd',
                    'http://user:pw@10.0.0.5:8090/a', 'http://10.0.0.5:8090@evil.com/a', None, 5, TS + '/' + 'a' * 5000]:
            self.assertIsNone(server.torrserver_source(bad), bad)

    def test_ffmpeg_arguments(self):
        args = server.stream_args(TS + '/s', 2, 'aac', 90.5, 'hevc')
        self.assertEqual(args[args.index('-ss') + 1], '90.50')
        self.assertLess(args.index('-ss'), args.index('-i'))
        self.assertLess(args.index('-noaccurate_seek'), args.index('-i'))
        self.assertEqual(args[args.index('-af') + 1], 'aresample=async=1')
        self.assertEqual(args[args.index('-protocol_whitelist') + 1], 'http,tcp')
        self.assertIn('0:2', args)
        self.assertEqual(args[args.index('-c:a') + 1], 'aac')
        self.assertEqual(args[args.index('-tag:v') + 1], 'hvc1')
        self.assertEqual(args[-1], 'pipe:1')
        plain = server.stream_args(TS + '/s', 1, 'copy', 0, 'h264')
        self.assertNotIn('-ss', plain)
        self.assertNotIn('-af', plain)
        self.assertNotIn('-tag:v', plain)
        self.assertEqual(plain[plain.index('-c:a') + 1], 'copy')

    def test_stream_query_validation(self):
        src = urllib.parse.quote(TS + '/stream/a.mkv?link=x&index=1&play', safe='')
        self.assertEqual(server.parse_stream_query('src=%s&a=2&c=aac&t=12.5&v=h264' % src)[1:], (2, 'aac', 12.5, 'h264'))
        for bad in ['src=%s&a=x&c=aac' % src, 'src=%s&a=2&c=flac' % src, 'src=%s&a=200&c=aac' % src,
                    'src=%s&a=2&c=aac&t=-1' % src, 'src=%s&a=2&c=aac&v=h264;rm' % src, 'src=http%3A%2F%2Fevil%2Fa&a=2&c=aac', 'a=2&c=aac']:
            with self.assertRaises(server.BadRequest, msg=bad):
                server.parse_stream_query(bad)

    def test_keyframe_lookup(self):
        args = server.keyframe_args(TS + '/s', 37)
        self.assertEqual(args[args.index('-read_intervals') + 1], '37.00%+#1')
        self.assertEqual(args[args.index('-protocol_whitelist') + 1], 'http,tcp')
        self.assertEqual(server.parse_keyframe(b'30.000000\n30.040000\n', 37), 30.0)
        self.assertEqual(server.parse_keyframe(b'N/A\n29.5,\n', 37), 29.5)
        # Nothing usable, or a keyframe after the asked time: keep the asked time.
        self.assertEqual(server.parse_keyframe(b'', 37), 37)
        self.assertEqual(server.parse_keyframe(b'38.0\n', 37), 37)

    def test_probe_output_is_reduced_to_what_lampa_needs(self):
        info = {'format': {'format_name': 'matroska,webm', 'duration': '5400.5'}, 'streams': [
            {'index': 0, 'codec_type': 'video', 'codec_name': 'hevc'},
            {'index': 1, 'codec_type': 'audio', 'codec_name': 'ac3', 'channels': 6, 'tags': {'language': 'RUS', 'title': 'Dub'}, 'disposition': {'default': 1}},
            {'index': 2, 'codec_type': 'audio', 'codec_name': 'dts', 'channels': 6, 'tags': {'language': 'eng'}},
            {'index': 3, 'codec_type': 'subtitle', 'codec_name': 'subrip'},
            {'index': 4, 'codec_type': 'video', 'codec_name': 'mjpeg', 'disposition': {'attached_pic': 1}}]}
        self.assertEqual(server.parse_probe(info), {
            'container': 'matroska,webm', 'duration': 5400.5, 'video': 'hevc',
            'audio': [{'index': 1, 'codec': 'ac3', 'language': 'rus', 'title': 'Dub', 'channels': 6, 'default': True},
                      {'index': 2, 'codec': 'dts', 'language': 'eng', 'title': '', 'channels': 6, 'default': False}]})
        self.assertEqual(server.parse_probe({})['audio'], [])
        self.assertEqual(server.parse_probe({'format': {'duration': 'N/A'}})['duration'], 0)

    def test_probe_cache_keeps_the_newest(self):
        cache = server.ProbeCache(size=2)
        cache.put('a', 1)
        cache.put('b', 2)
        cache.get('a')
        cache.put('c', 3)
        self.assertEqual((cache.get('a'), cache.get('b'), cache.get('c')), (1, None, 3))


class AudioFixHttpTest(HttpTestBase):
    def test_bad_requests_are_refused_before_running_anything(self):
        if not server.FFMPEG:
            self.skipTest('ffmpeg not installed')
        self.assertEqual(self.fetch('/audiofix/probe?src=http%3A%2F%2Fexample.com%2Fa.mkv')[0], 400)
        self.assertEqual(self.fetch('/audiofix/stream?src=http%3A%2F%2Fexample.com%2Fa.mkv&a=1&c=aac')[0], 400)
        self.assertEqual(self.fetch('/audiofix/keyframe?src=http%3A%2F%2Fexample.com%2Fa.mkv&t=5')[0], 400)
        src = urllib.parse.quote(TS + '/stream/a.mkv', safe='')
        self.assertEqual(self.fetch('/audiofix/keyframe?src=%s&t=-1' % src)[0], 400)
        code, body = self.fetch('/audiofix/keyframe?src=%s&t=0' % src)[:2]
        self.assertEqual((code, json.loads(body)), (200, {'start': 0}))

    def test_busy_server_says_so(self):
        if not server.FFMPEG:
            self.skipTest('ffmpeg not installed')
        taken = [server.CONVERSIONS.acquire(blocking=False) for _ in range(server.MAX_CONVERSIONS)]
        try:
            src = urllib.parse.quote(TS + '/stream/a.mkv', safe='')
            self.assertEqual(self.fetch('/audiofix/stream?src=%s&a=1&c=aac' % src)[0], 503)
        finally:
            for ok in taken:
                if ok:
                    server.CONVERSIONS.release()

    def test_without_ffmpeg_the_feature_reports_it(self):
        saved = server.FFMPEG, server.FFPROBE
        server.FFMPEG = server.FFPROBE = None
        try:
            self.assertEqual(self.fetch('/audiofix/probe?src=x')[0], 501)
            self.assertEqual(self.fetch('/audiofix/stream?src=x')[0], 501)
        finally:
            server.FFMPEG, server.FFPROBE = saved
