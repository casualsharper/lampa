"""Self-hosted Lampa server: serves the app, home sync (per-person favorites, history and watch progress stored as
JSON files), send-to-device and the browser audio fix (needs ffmpeg). Standard library only. Meant for the LAN;
there is no login.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import OrderedDict, deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

WEB_ROOT = os.environ.get('LAMPA_ROOT', os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.environ.get('HOMESYNC_DATA', '/data')
PORT = int(os.environ.get('PORT', '8080'))
TORRSERVER = os.environ.get('TORRSERVER', '')

TORRSERVER_RE = re.compile(r'^[A-Za-z0-9.-]+(:[0-9]{1,5})?$')

CATEGORIES = ('like', 'wath', 'book', 'history', 'look', 'viewed', 'scheduled', 'continued', 'thrown')
OPS = ('add', 'added', 'remove')
PROFILE_RE = re.compile(r'^[A-Za-z0-9_-]{1,32}$')

MAX_BODY = 2 * 1024 * 1024
MAX_CARD_BYTES = 20 * 1024
MAX_TIMELINE_BYTES = 1024
# Per title: the torrent last played, so "Continue watching" can reopen it (continue.js).
MAX_RESUME_BYTES = 2048
# The side menu's order is the longest setting.
MAX_PREF_BYTES = 2048
MAX_ITEMS = 10000
MAX_TIMELINES = 50000
MAX_PREFS = 100
# Maps where the newest entry per key wins: state field, request field, max bytes per entry, max entries.
NEWEST_WINS = (
    ('file_view', 'timelines', MAX_TIMELINE_BYTES, MAX_TIMELINES),
    ('resume', 'resume', MAX_RESUME_BYTES, MAX_ITEMS),
    # Per-person settings such as audio language priority: { name: { value, updated } }.
    ('prefs', 'prefs', MAX_PREF_BYTES, MAX_PREFS),
)

DEVICE_RE = re.compile(r'^[A-Za-z0-9_-]{8,40}$')
POLL_SECONDS = 25
# A device that polled within this window counts as online (one poll lasts up to POLL_SECONDS).
ONLINE_SECONDS = POLL_SECONDS + 20
MAX_DEVICES = 50
MAX_QUEUE = 10
MAX_CAST_BODY = 8 * 1024
MAX_NAME = 40

FFMPEG = shutil.which('ffmpeg')
FFPROBE = shutil.which('ffprobe')
# Each conversion is one ffmpeg process copying video and re-encoding one audio track; a seek starts a new one.
MAX_CONVERSIONS = 3
# A fresh torrent can take a minute to deliver the needed pieces (an MP4 keeps its index at the end of the file).
PROBE_TIMEOUT = 90
# Longest wait for one read from TorrServer before ffmpeg gives up, in microseconds.
READ_TIMEOUT_US = '60000000'
# Codecs a browser can take inside MP4 as they are; anything else (DTS, TrueHD, PCM...) is re-encoded to AAC.
COPYABLE_AUDIO = ('aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac')
CHUNK = 64 * 1024

lock = threading.Lock()


class BadRequest(Exception):
    pass


def empty_state():
    favorite = {name: [] for name in CATEGORIES}
    favorite['card'] = []
    state = {'favorite': favorite}
    for field, _, _, _ in NEWEST_WINS:
        state[field] = {}
    return state


def profile_path(name):
    return os.path.join(DATA_DIR, name + '.json')


def load(name):
    try:
        with open(profile_path(name), encoding='utf-8') as f:
            state = json.load(f)
    except FileNotFoundError:
        return empty_state()
    base = empty_state()
    base['favorite'].update(state.get('favorite', {}))
    for field, _, _, _ in NEWEST_WINS:
        base[field].update(state.get(field, {}))
    return base


def save(name, state):
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, profile_path(name))
    except BaseException:
        os.unlink(tmp)
        raise


def data_dir_problem():
    """Returns why home sync cannot write its data folder, or None when it can."""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        fd, probe = tempfile.mkstemp(dir=DATA_DIR, suffix='.check')
        os.close(fd)
        os.unlink(probe)
    except OSError as e:
        return str(e)
    return None


def report_data_problem(problem):
    sys.stderr.write('homesync: cannot write %s (%s). Lampa still runs, but profiles are not saved until the folder '
                     'is writable by uid %d, e.g. sudo chown -R %d:%d <folder on the NAS>\n'
                     % (DATA_DIR, problem, os.getuid(), os.getuid(), os.getgid()))
    sys.stderr.flush()


def profiles():
    return sorted(f[:-5] for f in os.listdir(DATA_DIR) if f.endswith('.json') and PROFILE_RE.match(f[:-5]))


def same_id(a, b):
    # Lampa compares ids with ==, so 123 and "123" are the same card.
    return str(a) == str(b)


def valid_id(value):
    return isinstance(value, (int, str)) and not isinstance(value, bool) and 0 < len(str(value)) <= 64


def json_size(value):
    return len(json.dumps(value, ensure_ascii=False))


def apply_op(favorite, op):
    """Replays Lampa's own Favorite.add/remove so concurrent edits from several devices merge instead of overwriting."""
    if not isinstance(op, dict) or op.get('op') not in OPS or op.get('where') not in CATEGORIES or not valid_id(op.get('id')):
        raise BadRequest('bad op')

    items = favorite[op['where']]
    items[:] = [i for i in items if not same_id(i, op['id'])]

    if op['op'] == 'remove':
        return

    items.insert(0, op['id'])
    card = op.get('card')
    if isinstance(card, dict) and same_id(card.get('id'), op['id']) and json_size(card) <= MAX_CARD_BYTES:
        if not any(same_id(c.get('id'), op['id']) for c in favorite['card']):
            favorite['card'].append(card)


def prune_cards(favorite):
    used = {str(i) for name in CATEGORIES for i in favorite[name]}
    favorite['card'] = [c for c in favorite['card'] if str(c.get('id')) in used]


def merge_newest(target, entries, max_bytes, what):
    """Keeps, per key, the entry with the newest 'updated', so devices syncing in any order agree."""
    if not isinstance(entries, dict):
        raise BadRequest('bad ' + what)
    for key, entry in entries.items():
        if not (isinstance(key, str) and 0 < len(key) <= 64 and isinstance(entry, dict) and json_size(entry) <= max_bytes):
            raise BadRequest('bad ' + what)
        current = target.get(key)
        current_updated = current.get('updated', 0) if isinstance(current, dict) else 0
        if entry.get('updated', 0) >= current_updated:
            target[key] = entry


def check_limits(state):
    favorite = state['favorite']
    if (any(len(favorite[name]) > MAX_ITEMS for name in CATEGORIES + ('card',))
            or any(len(state[field]) > limit for field, _, _, limit in NEWEST_WINS)):
        raise BadRequest('too much data')


def apply_changes(state, body):
    if not isinstance(body, dict) or not isinstance(body.get('ops', []), list):
        raise BadRequest('bad body')
    for op in body.get('ops', []):
        apply_op(state['favorite'], op)
    prune_cards(state['favorite'])
    for field, sent, max_bytes, _ in NEWEST_WINS:
        merge_newest(state[field], body.get(sent, {}), max_bytes, sent)
    check_limits(state)


def content_security_policy(torrserver):
    """Browser-enforced allowlist: Lampa may only reach this server, TMDB, TorrServer and YouTube trailers.

    Blocks CUB (cub.best and mirrors) and ad SDKs even if a future Lampa version adds new calls.
    'unsafe-eval': Lampa loads interface languages with eval().
    """
    ts = ' http://' + torrserver if torrserver else ''
    return '; '.join([
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://s.ytimg.com",
        "connect-src 'self' https://api.themoviedb.org https://image.tmdb.org" + ts,
        "img-src 'self' data: blob: https://image.tmdb.org https://img.youtube.com https://i.ytimg.com" + ts,
        "media-src 'self' blob: data:" + ts,
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ])


CSP = content_security_policy(TORRSERVER)


def hidden(path):
    # The repo is the web root: keep git metadata (and anything dotted, including ..), the server code and the sync data out of reach.
    parts = [p for p in path.split('/') if p]
    return any(p.startswith('.') for p in parts) or (bool(parts) and parts[0].lower() in ('selfhost', 'data'))


def clean_name(value):
    if not isinstance(value, str):
        raise BadRequest('bad name')
    name = ''.join(ch for ch in value if ch.isprintable()).strip()[:MAX_NAME]
    if not name:
        raise BadRequest('bad name')
    return name


def clean_cast_command(command):
    """Only these two shapes reach a device, so a sender cannot make it run anything else."""
    if not isinstance(command, dict):
        raise BadRequest('bad command')
    if command.get('action') == 'open':
        card = command.get('card')
        if not (isinstance(card, dict) and isinstance(card.get('id'), int) and not isinstance(card.get('id'), bool)
                and card['id'] > 0 and card.get('method') in ('movie', 'tv')):
            raise BadRequest('bad card')
        return {'action': 'open', 'card': {'id': card['id'], 'method': card['method']}}
    if command.get('action') == 'play':
        url = command.get('url')
        if not (isinstance(url, str) and len(url) <= 2048 and re.match(r'^https?://', url)):
            raise BadRequest('bad url')
        title = command.get('title') if isinstance(command.get('title'), str) else ''
        timeline = command.get('timeline') if isinstance(command.get('timeline'), dict) else {}
        timeline = {k: timeline[k] for k in ('hash', 'time', 'duration', 'percent')
                    if isinstance(timeline.get(k), (int, float)) and not isinstance(timeline.get(k), bool)}
        return {'action': 'play', 'url': url, 'title': title[:200], 'timeline': timeline}
    raise BadRequest('bad action')


class Cast:
    """Send-to-device: each Lampa long-polls for commands; anyone on the LAN can queue one for an online device."""

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.cond = threading.Condition()
        self.devices = {}
        self.queues = {}

    def _touch(self, device, name):
        if device not in self.devices and len(self.devices) >= MAX_DEVICES:
            oldest = min(self.devices, key=lambda d: self.devices[d]['seen'])
            del self.devices[oldest]
            self.queues.pop(oldest, None)
        self.devices[device] = {'name': name, 'seen': self.clock()}
        self.queues.setdefault(device, deque(maxlen=MAX_QUEUE))

    def online(self):
        with self.cond:
            now = self.clock()
            found = [{'id': d, 'name': info['name']} for d, info in self.devices.items() if now - info['seen'] <= ONLINE_SECONDS]
        return sorted(found, key=lambda d: d['name'].lower())

    def poll(self, device, name, timeout=None):
        with self.cond:
            self._touch(device, name)
            self.cond.wait_for(lambda: self.queues[device], POLL_SECONDS if timeout is None else timeout)
            self._touch(device, name)
            commands = list(self.queues[device])
            self.queues[device].clear()
        return commands

    def send(self, to, command):
        with self.cond:
            info = self.devices.get(to)
            if not info or self.clock() - info['seen'] > ONLINE_SECONDS:
                return False
            self.queues[to].append(command)
            self.cond.notify_all()
        return True


CAST = Cast()


def torrserver_source(src):
    """The audio fix only ever reads from our TorrServer, so the NAS cannot be used to fetch other addresses."""
    if not (isinstance(src, str) and TORRSERVER and len(src) <= 4096):
        return None
    parts = urlsplit(src)
    if parts.scheme != 'http' or parts.netloc.lower() != TORRSERVER.lower() or parts.username or parts.password:
        return None
    return src


def probe_args(src):
    return [FFPROBE, '-v', 'error', '-protocol_whitelist', 'http,tcp', '-rw_timeout', READ_TIMEOUT_US,
            '-print_format', 'json', '-show_streams', '-show_format', src]


def parse_probe(info):
    streams = info.get('streams') or []
    video = next((s for s in streams if s.get('codec_type') == 'video' and not (s.get('disposition') or {}).get('attached_pic')), None)
    audio = []
    for s in streams:
        if s.get('codec_type') != 'audio':
            continue
        tags = s.get('tags') or {}
        audio.append({
            'index': s.get('index'),
            'codec': s.get('codec_name') or '',
            'language': (tags.get('language') or '').lower(),
            'title': tags.get('title') or '',
            'channels': s.get('channels') or 0,
            'default': bool((s.get('disposition') or {}).get('default')),
        })
    try:
        duration = float((info.get('format') or {}).get('duration') or 0)
    except ValueError:
        duration = 0
    return {
        'container': (info.get('format') or {}).get('format_name') or '',
        'duration': duration,
        'video': video.get('codec_name') if video else None,
        'audio': audio,
    }


def keyframe_args(src, start):
    return [FFPROBE, '-v', 'error', '-protocol_whitelist', 'http,tcp', '-rw_timeout', READ_TIMEOUT_US,
            '-read_intervals', '%.2f%%+#1' % start, '-select_streams', 'v:0', '-show_entries', 'packet=pts_time',
            '-of', 'csv=p=0', src]


def parse_keyframe(output, start):
    """The time a stream started at `start` really begins: the keyframe at or before it (what -noaccurate_seek lands on)."""
    for line in output.decode('ascii', 'replace').split():
        try:
            found = float(line.strip(','))
        except ValueError:
            continue
        return found if 0 <= found <= start else start
    return start


def stream_args(src, audio_index, mode, start, video_codec):
    args = [FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'http,tcp', '-rw_timeout', READ_TIMEOUT_US]
    if start > 0:
        # Copied video can only start at a keyframe. An exact seek starts the audio later than that, and browsers play
        # straight through the gap: audio ran ahead by up to a keyframe interval. Both start at the keyframe instead.
        args += ['-noaccurate_seek', '-ss', '%.2f' % start]
    args += ['-i', src, '-map', '0:v:0', '-map', '0:%d' % audio_index, '-c:v', 'copy']
    if video_codec == 'hevc':
        args += ['-tag:v', 'hvc1']
    if mode == 'copy':
        args += ['-c:a', 'copy']
    else:
        # Browsers play stereo AAC everywhere; surround AAC support varies.
        # aresample follows the source timestamps (silence for gaps, stretch for drift), so audio stays on the video's clock.
        args += ['-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', '192k', '-ac', '2']
    return args + ['-sn', '-dn', '-map_metadata', '-1', '-f', 'mp4',
                   '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1']


def parse_src_and_time(q):
    one = lambda name: (q.get(name) or [''])[0]
    src = torrserver_source(one('src'))
    if not src:
        raise BadRequest('src must be a stream from this TorrServer')
    try:
        start = float(one('t') or 0)
    except ValueError:
        raise BadRequest('bad time')
    if not 0 <= start < 24 * 3600:
        raise BadRequest('bad time')
    return src, start


def parse_stream_query(query):
    q = parse_qs(query)
    one = lambda name: (q.get(name) or [''])[0]
    src, start = parse_src_and_time(q)
    try:
        audio_index = int(one('a'))
    except ValueError:
        raise BadRequest('bad track')
    mode = one('c')
    video_codec = one('v')
    if not (0 <= audio_index < 100 and mode in ('copy', 'aac') and re.match(r'^[a-z0-9_]{0,20}$', video_codec)):
        raise BadRequest('bad parameters')
    return src, audio_index, mode, start, video_codec


class ProbeCache:
    def __init__(self, size=64):
        self.size = size
        self.items = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            if key in self.items:
                self.items.move_to_end(key)
                return self.items[key]
        return None

    def put(self, key, value):
        with self.lock:
            self.items[key] = value
            self.items.move_to_end(key)
            while len(self.items) > self.size:
                self.items.popitem(last=False)


PROBES = ProbeCache()
CONVERSIONS = threading.BoundedSemaphore(MAX_CONVERSIONS)


class Handler(SimpleHTTPRequestHandler):
    server_version = 'lampa'
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map, **{
        '.js': 'text/javascript',
        '.webmanifest': 'application/manifest+json',
    })

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    def end_headers(self):
        # App files: browsers check back on every load (a cheap 304 when unchanged), so files copied onto the server
        # take effect at the next reload instead of whenever a browser's guessed cache time runs out.
        self.send_header('Cache-Control', self.__dict__.pop('cache_control', 'no-cache'))
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def send_body(self, code, content_type, data):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.cache_control = 'no-store'
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, code, value):
        data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_body(code, 'application/json; charset=utf-8', data)

    def route(self):
        return unquote(urlsplit(self.path).path)

    def profile_name(self, path):
        prefix = '/homesync/profile/'
        if not path.startswith(prefix):
            return None
        name = path[len(prefix):]
        return name if PROFILE_RE.match(name) else None

    def list_directory(self, path):
        self.send_error(404)
        return None

    def do_HEAD(self):
        path = self.route()
        if path.startswith('/homesync/') or path == '/config.js' or hidden(path):
            return self.send_error(404)
        super().do_HEAD()

    def do_GET(self):
        path = self.route()
        if path == '/config.js':
            # Lets defaults.js pick up this server's TorrServer address without it living in the code.
            data = ('window.home_config = ' + json.dumps({'torrserver': TORRSERVER}) + ';\n').encode('utf-8')
            return self.send_body(200, 'text/javascript; charset=utf-8', data)
        if path == '/audiofix/probe':
            return self.audiofix_probe()
        if path == '/audiofix/stream':
            return self.audiofix_stream()
        if path == '/audiofix/keyframe':
            return self.audiofix_keyframe()
        if path == '/homesync/cast/devices':
            return self.send_json(200, CAST.online())
        if path == '/homesync/profiles':
            with lock:
                return self.with_data(lambda: self.send_json(200, profiles()))
        if path.startswith('/homesync/'):
            name = self.profile_name(path)
            if not name:
                return self.send_json(404, {'error': 'not found'})
            with lock:
                return self.with_data(lambda: self.send_json(200, load(name)))
        if hidden(path):
            return self.send_error(404)
        super().do_GET()

    def read_json(self, limit):
        """Returns the parsed body, or None after answering the error itself."""
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = -1
        if not 0 <= length <= limit:
            self.send_json(413, {'error': 'body too large'})
            return None
        try:
            return json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            self.send_json(400, {'error': 'bad json'})
            return None

    def do_POST(self):
        path = self.route()
        if path in ('/homesync/cast/poll', '/homesync/cast/send'):
            body = self.read_json(MAX_CAST_BODY)
            if body is None:
                return
            try:
                return self.cast_poll(body) if path.endswith('/poll') else self.cast_send(body)
            except BadRequest as e:
                return self.send_json(400, {'error': str(e)})

        name = self.profile_name(path)
        if not name:
            return self.send_json(404, {'error': 'not found'})
        body = self.read_json(MAX_BODY)
        if body is None:
            return
        with lock:
            self.with_data(lambda: self.apply_and_save(name, body))

    def cast_poll(self, body):
        device = body.get('device') if isinstance(body, dict) else None
        if not (isinstance(device, str) and DEVICE_RE.match(device)):
            raise BadRequest('bad device')
        self.send_json(200, {'commands': CAST.poll(device, clean_name(body.get('name')))})

    def cast_send(self, body):
        if not isinstance(body, dict) or not isinstance(body.get('to'), str):
            raise BadRequest('bad target')
        command = clean_cast_command(body.get('command'))
        command['from'] = clean_name(body.get('from'))
        if not CAST.send(body['to'], command):
            return self.send_json(404, {'error': 'device offline'})
        self.send_json(200, {'ok': True})

    def apply_and_save(self, name, body):
        state = load(name)
        try:
            apply_changes(state, body)
        except BadRequest as e:
            return self.send_json(400, {'error': str(e)})
        save(name, state)
        self.send_json(200, state)

    def with_data(self, action):
        # Lampa shows a notice on 503; without this the request would just drop and sync would retry silently.
        try:
            action()
        except ConnectionError:
            raise
        except OSError as e:
            report_data_problem(e)
            self.send_json(503, {'error': 'data folder not writable'})

    def audiofix_probe(self):
        if not (FFMPEG and FFPROBE):
            return self.send_json(501, {'error': 'ffmpeg is not installed'})
        src = torrserver_source((parse_qs(urlsplit(self.path).query).get('src') or [''])[0])
        if not src:
            return self.send_json(400, {'error': 'src must be a stream from this TorrServer'})
        cached = PROBES.get(src)
        if cached is None:
            try:
                done = subprocess.run(probe_args(src), capture_output=True, timeout=PROBE_TIMEOUT)
                cached = parse_probe(json.loads(done.stdout or b'{}'))
            except (subprocess.TimeoutExpired, ValueError):
                return self.send_json(504, {'error': 'probe failed'})
            if not cached['audio']:
                return self.send_json(502, {'error': 'no audio found'})
            PROBES.put(src, cached)
        self.send_json(200, cached)

    def audiofix_keyframe(self):
        if not FFPROBE:
            return self.send_json(501, {'error': 'ffmpeg is not installed'})
        try:
            src, start = parse_src_and_time(parse_qs(urlsplit(self.path).query))
        except BadRequest as e:
            return self.send_json(400, {'error': str(e)})
        if start <= 0:
            return self.send_json(200, {'start': 0})
        try:
            done = subprocess.run(keyframe_args(src, start), capture_output=True, timeout=PROBE_TIMEOUT)
        except subprocess.TimeoutExpired:
            return self.send_json(504, {'error': 'keyframe lookup failed'})
        self.send_json(200, {'start': parse_keyframe(done.stdout, start)})

    def audiofix_stream(self):
        if not FFMPEG:
            return self.send_json(501, {'error': 'ffmpeg is not installed'})
        try:
            src, audio_index, mode, start, video_codec = parse_stream_query(urlsplit(self.path).query)
        except BadRequest as e:
            return self.send_json(400, {'error': str(e)})
        if not CONVERSIONS.acquire(blocking=False):
            return self.send_json(503, {'error': 'too many conversions'})
        proc = None
        try:
            proc = subprocess.Popen(stream_args(src, audio_index, mode, start, video_codec),
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.cache_control = 'no-store'
            self.end_headers()
            self.close_connection = True
            while True:
                chunk = proc.stdout.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if proc:
                proc.kill()
                proc.wait()
            CONVERSIONS.release()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    if TORRSERVER and not TORRSERVER_RE.match(TORRSERVER):
        sys.exit('TORRSERVER must look like host:port, got %r' % TORRSERVER)
    problem = data_dir_problem()
    if problem:
        report_data_problem(problem)
    httpd = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    httpd.daemon_threads = True
    httpd.serve_forever()
