"""Applies the self-hosting changes to a pristine upstream Lampa checkout (run from the repo root).

Every patch must match exactly once. If upstream changes the code a patch targets, this exits non-zero
and names the patch, so the auto-update stops instead of shipping a half-patched app.
Minified names carry build-specific suffixes (init$s, listener$7, Utils$1), so patterns match any suffix.
"""
import hashlib
import os
import re
import sys

APP = 'app.min.js'
INDEX = 'index.html'


def find_name(source, pattern, what):
    match = re.search(pattern, source)
    if not match:
        sys.exit('patch.py: cannot find %s' % what)
    return match.group(1)


def app_patches(source):
    utils = find_name(source, r'\b(Utils\$\d+)\.protocol\(\)', 'Utils object')
    listener = find_name(source, r"\b(listener\$\d+)\.send\('external', data\)", 'player listener')
    manifest = find_name(source, r'\b(object\$\d+)\.cub_domain', 'manifest object')

    android_players = """
  // Resume position extra: VLC reads it as long, the others as int.
  var ANDROID_BROWSER_PLAYERS = {
    android_any: {},
    vlc: { pkg: 'org.videolan.vlc', position: 'l' },
    mx: { pkg: 'com.mxtech.videoplayer.ad', position: 'i' },
    mxpro: { pkg: 'com.mxtech.videoplayer.pro', position: 'i' },
    mpv: { pkg: 'is.xyz.mpv', position: 'i' },
    justplayer: { pkg: 'com.brouken.player', position: 'i' }
  };

  // Chrome on Android opens other apps only through intent: links. No package = Android's "Open with" list; a package that is not installed sends the user to Play Store.
  function androidPlayerIntent(url, data, player) {
    if (!/^https?:\\/\\//i.test(url)) url = 'http://' + url;
    var scheme = url.split(':')[0].toLowerCase();
    var title = UTILS.clearHtmlTags(data.title || '').trim();
    var position = data.timeline && data.timeline.time ? Math.round(data.timeline.time * 1000) : 0;
    var extras = 'type=video/*;';
    if (player.pkg) extras += 'package=' + player.pkg + ';';
    if (title) extras += 'S.title=' + encodeURIComponent(title) + ';';
    if (position && player.position) extras += player.position + '.position=' + position + ';';
    return 'intent:' + url.slice(scheme.length + 1) + '#Intent;scheme=' + scheme + ';' + extras + 'end';
  }
""".replace('UTILS', utils)

    android_launch = """
    } else if (Platform.androidBrowser() && ANDROID_BROWSER_PLAYERS.hasOwnProperty(Storage.field(player_need))) {
      Preroll.show(data, function () {
        LISTENER.send('external', data);
        window.location.assign(androidPlayerIntent(Torserver.toPlayUrl(data.url), data, ANDROID_BROWSER_PLAYERS[Storage.field(player_need)]));
      });""".replace('LISTENER', listener)

    android_settings = """if (Platform.androidBrowser()) {
      ['player', 'player_iptv', 'player_torrent'].forEach(function (name) {
        select(name, {
          'inner': '#{settings_param_player_inner}',
          'android_any': '#{settings_param_player_outside}',
          'vlc': 'VLC',
          'mx': 'MX Player',
          'mxpro': 'MX Player Pro',
          'mpv': 'mpv',
          'justplayer': 'Just Player'
        }, 'inner');
      });
    } else """

    return [
        ('ultrawide: size from a 16:9 width so tall layouts fit',
         r'fontSize: Math\.max\(window\.innerWidth / 84\.17 \* fs, 10\.6\)',
         'fontSize: Math.max(Math.min(window.innerWidth, window.innerHeight * 16 / 9) / 84.17 * fs, 10.6)'),

        ('android: allow torrent playback in Android browsers (no APK nag)',
         r"\n[ \t]*if \(navigator\.userAgent\.toLowerCase\(\)\.indexOf\('android'\) >= 0 && !Platform\.is\('android'\)\) return Platform\.install\('apk'\);",
         ''),

        ('android: Platform.androidBrowser()',
         r'(\n  function macOS\(\) \{[^}]*\}\n)',
         "\\1\n  function androidBrowser() {\n    return navigator.userAgent.toLowerCase().indexOf('android') > -1 && !is('android');\n  }\n"),

        ('android: export Platform.androidBrowser',
         r'(\n    macOS: macOS,\n)',
         '\\1    androidBrowser: androidBrowser,\n'),

        ('android: external player choices',
         r"(function init\$\w+\(\) \{\n    )(if \(Platform\.is\('tizen'\)\) \{\n      select\('player', )",
         lambda m: m.group(1) + android_settings + m.group(2)),

        ('android: show player settings in Android browsers',
         r"if \(!Platform\.any\(\)\) \{(\n\s*comp\.find\('\.is--player'\)\.remove\(\);)",
         'if (!Platform.any() && !Platform.androidBrowser()) {\\1'),

        ('android: launch external player',
         r"(\n    \} else if \(Platform\.desktop\(\) && Storage\.field\(player_need\) == 'other'\) \{)",
         lambda m: android_launch + m.group(1)),

        ('android: intent builder',
         r'(\n  function launchExternalPlayer\()',
         lambda m: android_players + m.group(1)),

        ('cub: no daily usage report',
         r"(\n  function init\$\w+\(\) \{\n)(    var today = new Date\(\);\n    var date = today\.toISOString\(\)\.split\('T'\)\[0\];\n\n    if \(Storage\.get\('metric_date'\))",
         '\\1    return;\n\\2'),

        ('outside players: open on the click instead of after the TorrServer preload',
         r"(\n  function preload\(data, run\) \{\n(?:[^\n]*\n){2}\s*var need_preload = has_server && has_preload)(;)",
         lambda m: OUTSIDE_PLAYER + m.group(1) + ' && !opensOutsidePlayer()' + m.group(2)),

        ('torrent list: publish the full filtered list (it only renders 20 at a time), and drop the "last watched" bar'
         ' (it only shows a season and episode, has no click action and cannot resume: it does not store the torrent)',
         r"(\n(\s*)scroll\.append\(history\.render\(true\)\);\n)(\s*this\.append\(filtred\.slice\(0, 20\)\);)",
         "\n\\2Lampa.Listener.send('torrent', {\n\\2  type: 'results',\n\\2  results: filtred,\n\\2  component: this,\n\\2  movie: object.movie,\n\\2  scroll: scroll\n\\2});\n\\3"),

        ('episode picker: let our code narrow the filtered torrent list',
         r"(return nopass \? false : passed;\n\s*\} else return true;\n\s*\}\);\n)(\s*\};)",
         "\\1      var custom = {\n        results: filtred,\n        component: this,\n        movie: object.movie\n      };\n      Lampa.Listener.send('torrent', {\n        type: 'filtred',\n        data: custom\n      });\n      filtred = custom.results;\n\\2"),

        ('send to device: let added torrent-file menu items run their own action',
         r"(onSelect: function onSelect\(a\) \{\n)(\s*)(if \(a\.timeclear\) \{)",
         "\\1\\2if (a.onSelect) {\n\\2  Controller.toggle(enabled);\n\\2  return a.onSelect();\n\\2}\n\n\\2\\3"),

        ('mouse: wheel scrolls the page, sideways swipe or Shift+wheel scrolls a row, amount follows the wheel',
         r"(\n    )function wheel\(e\) \{\n\s*var parent = \$\(e\.target\)\.parents\('\.scroll'\);\n(?:.*\n)*?\s*\} // [^\n]*\n",
         lambda m: m.group(1) + MOUSE_WHEEL.strip() + '\n'),

        ('play button: start the only source right away (upstream shows a one-item menu unless it can add "Add source", which it only does on Android)',
         r"if \(btns\.length == 1 && !window\.lampa_settings\.plugins_use\) \{",
         "if (btns.length == 1 && !(window.lampa_settings.plugins_use && Platform.is('android'))) {"),

        ('next episode: start it through Player.play like the first one (it called the internal function, skipping hooks such as the audio fix)',
         r"(e\.item\.continue_play = true;\n\s*)play\$\w+\(e\.item\);",
         '\\1Player.play(e.item);'),

        ('cub: no usage counters',
         r"(\n  function counter\(method, v1, v2, v3\) \{\n)(    \$\.ajax\(\{\n      dataType: 'json',\n      url: Utils\$\d+\.protocol\(\) \+ object\$\d+\.cub_domain \+ '/api/metric/stat)",
         '\\1    return;\n\\2'),

        ('cub: no usage histograms',
         r"(\n  function histogram\(method, value\) \{\n)(    \$\.ajax\(\{)",
         '\\1    return;\n\\2'),

        ('cub: no remote plugins from CUB (Shots, Engineer and whatever is added next); local libraries still load',
         r"(Utils\$\d+)\.putScriptOfMirrors\(include, function \(\) \{\}\);",
         lambda m: m.group(1) + ".putScriptOfMirrors(include.filter(function (url) {\n      return url.indexOf(" + manifest + ".cub_domain) < 0;\n    }), function () {});"),

        ('notifications: no CUB tab, and no tabs for empty sources (the CUB source stays: "Continue watching" reads it)',
         r"(for \(var name in this\.classes\) \{\n)(\s*)(var count = this\.classes\[name\]\.count\(\);)",
         "\\1\\2if (name == 'cub' || name != 'all' && !this.classes[name].items().length) continue;\n\\2\\3"),

        ('notifications: tab bar only when two or more sources have something ("All" plus one would repeat itself)',
         r"\n(\s*)html\.append\(navigation\);",
         "\n\\1if (tabs.length > 2) html.append(navigation);"),

        ('cub: no CUB tab in search results',
         r"if \((sources\$\d+)\[key\]\.discovery\) \{",
         "if (\\1[key].discovery && key !== 'cub') {"),

        ('cub: TMDB is the only catalog source',
         r"(select\('source', \{\n\s*'tmdb': 'TMDB'),\n\s*'cub': 'CUB'(\n\s*\}, 'tmdb'\);)",
         '\\1\\2'),

        ('cub: no CUB screensaver',
         r"\n\s*'cub': 'CUB',(\n\s*'aerial': 'Aerial')",
         '\\1'),

        ('cub: no "Change source to CUB" button on empty pages',
         r"this\.object\.source == 'tmdb' && params\.cub_button",
         'false'),

        ('cub: no "Change source to CUB" button on empty pages (older screens)',
         r"if \(object\.source == 'tmdb'\) \{(\n\s*button = \$\('<div class=\"empty__footer\"><div class=\"simple-button selector\">' \+ Lang\.translate\('change_source_on_cub'\))",
         'if (false) {\\1', 2),

        ('cub: no broadcast-to-device icon (it needs the CUB socket)',
         r"(function init\$\w+\(\) \{\n)(\s*var timer, activity;\n\s*var broadcast = Head\.addIcon\(Template\.string\('icon_broadcast'\))",
         '\\1    return;\n\\2'),

        ('cub: do not report watched titles to CUB',
         r"(function init\$\w+\(\) \{\n)(\s*Favorite\.listener\.follow\('add,added', function \(e\) \{\n\s*if \(e\.where == 'history')",
         '\\1    return;\n\\2'),

        ('cub: no video ads',
         r"(value: function load\(\) \{\n)(        var pos = 0;\n        var self = this;\n\n        var request = function request\(\) \{\n          var domain = object\$\d+\.cub_mirrors\[pos\];)",
         '\\1        return;\n\\2'),

        ('local: images and sounds from this server instead of GitHub',
         r"return window\.lampa_settings\.fix_widget \? 'http://lampa\.mx/' : 'https://yumata\.github\.io/lampa/';",
         "return './';"),

        ('local: TorrServer install picture from this server',
         r'src=\\"https://yumata\.github\.io/lampa/img/ili/tv\.png\\"',
         'src=\\\\"./img/ili/tv.png\\\\"'),
    ]


OUTSIDE_PLAYER = """
  // Browsers let a page open another app (iina://, intent:) only shortly after a click. Waiting for the preload
  // first gets the launch silently blocked on slow torrents; the outside player buffers on its own.
  function opensOutsidePlayer() {
    var player = Storage.field('player_torrent');
    return ['inner', 'ios', 'lampa'].indexOf(player) == -1 && (Platform.macOS() || Platform.is('apple') || Platform.androidBrowser());
  }
"""

OUR_SCRIPTS = ['config.js', 'defaults.js', 'common.js', 'homesync.js', 'torrents.js', 'episodes.js', 'cast.js', 'audiofix.js', 'continue.js']

# Replaces Lampa's Scroll wheel handler. Lampa decided by which screen half the mouse was on, throttled to one
# fixed 150px jump per 200ms, and ignored horizontal trackpad swipes.
MOUSE_WHEEL = """
    var wheel_sum = 0,
        wheel_last = 0,
        wheel_step_last = 0;

    function wheel(e) {
      // Lampa listens to both events; browsers with "wheel" fire both for one turn.
      if (e.type == 'mousewheel' && 'onwheel' in window) return;
      var dx = e.deltaX || 0,
          dy = e.deltaY || 0;
      if (!dx && !dy && e.wheelDelta) dy = -e.wheelDelta;
      if (e.deltaMode == 1) {
        dx *= 40;
        dy *= 40;
      }
      if (e.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      var sideways = Math.abs(dx) > Math.abs(dy);
      // Not our direction: let it bubble to the enclosing scroll (a row lets vertical wheel reach the page).
      if (Boolean(params.horizontal) != sideways) return;
      var delta = sideways ? dx : dy;
      if (!delta) return;
      e.preventDefault();
      e.stopPropagation();
      if (!_self.onWheel && !params.scroll_by_item) return _self.wheel(delta);

      // Step-wise scrolls (next row, next card): one step per wheel notch; trackpads add up to the same distance,
      // and a short gap between steps keeps a trackpad flick from jumping many rows at once.
      var now = Date.now();
      if (now - wheel_last > 300) wheel_sum = 0;
      wheel_last = now;
      wheel_sum += delta;
      if (Math.abs(wheel_sum) < 60 || now - wheel_step_last < 120) return;
      var step = wheel_sum > 0 ? scroll_step : -scroll_step;
      wheel_sum = 0;
      wheel_step_last = now;
      if (_self.onWheel) _self.onWheel(step);else _self.wheel(step);
    }
"""

def script_url(name):
    """Each script's URL carries a hash of its content. Browsers cache by URL, so one holding an older copy of a script
    cannot run it under a newer index.html (a mix of versions broke playback). config.js is generated per request."""
    if not os.path.exists(name):
        return './' + name
    with open(name, 'rb') as f:
        return './%s?v=%s' % (name, hashlib.sha1(f.read()).hexdigest()[:8])


def index_patches(source):
    return [
        ('index: load our scripts before Lampa',
         r'(\n([ \t]*)<script src="\./vender/keypad/keypad\.js"></script>\n)',
         '\\1' + ''.join('\\2<script src="%s"></script>\n' % script_url(name) for name in OUR_SCRIPTS)),
    ]


def apply(path, patches_for):
    with open(path, encoding='utf-8') as f:
        source = f.read()
    for patch in patches_for(source):
        name, pattern, replacement = patch[:3]
        expected = patch[3] if len(patch) > 3 else 1
        count = len(re.findall(pattern, source))
        if count != expected:
            sys.exit('patch.py: "%s" matched %d times in %s (expected %d)' % (name, count, path, expected))
        source = re.sub(pattern, replacement, source)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(source)


if __name__ == '__main__':
    apply(APP, app_patches)
    apply(INDEX, index_patches)
    print('patch.py: all patches applied')
