// Browser audio fix: browsers cannot play DTS/TrueHD (Chrome and Firefox not even AC3/EAC3) and only play a file's
// default audio track. Before Lampa's own player starts a TorrServer stream, the home server probes the file; if the
// audio would not play, or the preferred-language track is not the default, it streams the video untouched with that
// track converted to AAC (selfhost/server.py, /audiofix/). Outside players (VLC, IINA...) handle all of this themselves.
(function (root) {
    var STREAM_PATH = '/audiofix/stream?';
    var INNER_PLAYERS = ['inner', 'ios', 'lampa'];
    // TV platforms play through their own native players, which decode these codecs.
    var NATIVE_PLATFORMS = ['tizen', 'webos', 'orsay', 'netcast'];
    var COPYABLE = ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac'];
    // ISO 639-2 audio tags in files vs. the two-letter codes of the language setting.
    var LANG3 = { eng: 'en', rus: 'ru', ukr: 'uk', lav: 'lv', lit: 'lt', est: 'et', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr',
        spa: 'es', ita: 'it', pol: 'pl', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh' };

    function langOf(track) {
        var code = (track.language || '').toLowerCase();
        return LANG3[code] || (code.length == 2 ? code : '');
    }

    function playable(codec, caps) {
        if (codec == 'aac' || codec == 'mp3') return true;
        return Boolean(caps[codec]);
    }

    // Pure decision: null = play the original stream; otherwise which track to use and how.
    function plan(probe, caps, langs) {
        if (!probe || !probe.audio || !probe.audio.length) return null;
        var tracks = probe.audio;
        var byDefault = tracks.filter(function (t) {
            return t.default;
        })[0] || tracks[0];

        var chosen = null;
        langs.forEach(function (lang) {
            if (chosen) return;
            var inLang = tracks.filter(function (t) {
                return langOf(t) == lang;
            });
            chosen = inLang.filter(function (t) {
                return t.default;
            })[0] || inLang[0] || null;
        });
        chosen = chosen || byDefault;

        var ok = playable(chosen.codec, caps);
        if (ok && chosen.index === byDefault.index) return null;
        return {
            audio: chosen.index,
            mode: ok && COPYABLE.indexOf(chosen.codec) >= 0 ? 'copy' : 'aac',
            duration: probe.duration || 0,
            video: probe.video || '',
            track: chosen
        };
    }

    function sourceOf(streamUrl) {
        var match = /[?&]src=([^&]*)/.exec(streamUrl);
        return match ? decodeURIComponent(match[1]) : '';
    }

    function streamUrl(origin, src, p) {
        return origin + STREAM_PATH + 'src=' + encodeURIComponent(src) + '&a=' + p.audio + '&c=' + p.mode +
            '&v=' + encodeURIComponent(p.video) + '&d=' + p.duration.toFixed(2);
    }

    function describe(p) {
        var lang = langOf(p.track);
        return (lang ? lang.toUpperCase() + ' ' : '') + p.track.codec.toUpperCase() + (p.mode == 'aac' ? ' → AAC' : '');
    }

    var core = { plan: plan, streamUrl: streamUrl, sourceOf: sourceOf, langOf: langOf, describe: describe };
    if (typeof module === 'object' && module.exports) module.exports = core;
    if (!root.document) return;

    function browserCaps() {
        var video = document.createElement('video');
        var can = function (type) {
            return Boolean(video.canPlayType(type)) || Boolean(root.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported(type));
        };
        return {
            ac3: can('audio/mp4; codecs="ac-3"'),
            eac3: can('audio/mp4; codecs="ec-3"'),
            opus: can('audio/mp4; codecs="opus"'),
            flac: can('audio/mp4; codecs="flac"')
        };
    }

    // Safari needs byte ranges for <video>, which a live conversion cannot offer; it already plays AC3/EAC3 itself.
    function supported() {
        var ua = navigator.userAgent;
        var safari = /safari/i.test(ua) && !/chrome|chromium|crios|android/i.test(ua);
        return Boolean(root.Proxy) && !safari && !NATIVE_PLATFORMS.some(function (p) {
            return Lampa.Platform.is(p);
        });
    }

    function shouldCheck(data) {
        if (!Lampa.Storage.field(HomeCommon.AUDIOFIX_KEY) || !supported() || !data || typeof data.url != 'string') return false;
        if (data.url.indexOf(STREAM_PATH) >= 0) return false;
        var player = Lampa.Storage.field(data.torrent_hash ? 'player_torrent' : 'player');
        return INNER_PLAYERS.indexOf(player) >= 0 && HomeCommon.isTorrServerUrl(data.url, HomeCommon.torrserverAddress());
    }

    function getJson(path, done) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', path, true);
        // The server allows 90 s for a fresh torrent's first read.
        xhr.timeout = 100000;
        xhr.onload = function () {
            var data = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {}
            done(xhr.status == 200 ? data : null);
        };
        xhr.onerror = xhr.ontimeout = function () {
            done(null);
        };
        xhr.send();
    }

    function probe(src, done) {
        getJson('./audiofix/probe?src=' + encodeURIComponent(src), done);
    }

    // Where a conversion asked to start at `time` really starts; `time` itself if the server cannot tell.
    function keyframe(src, time, done) {
        getJson('./audiofix/keyframe?src=' + encodeURIComponent(src) + '&t=' + time.toFixed(2), function (data) {
            done(data && typeof data.start == 'number' && data.start >= 0 && data.start <= time ? data.start : time);
        });
    }

    function wrapPlay() {
        var original = Lampa.Player.play;
        Lampa.Player.play = function (data) {
            var self = this;
            var args = arguments;
            if (!shouldCheck(data)) return original.apply(self, args);

            var cancelled = false;
            Lampa.Loading.start(function () {
                cancelled = true;
                Lampa.Loading.stop();
            }, 'Checking audio… (a new torrent can take a minute)');
            var src = Lampa.Torserver.toPlayUrl(data.url);
            probe(src, function (info) {
                Lampa.Loading.stop();
                if (cancelled) return;
                var p = plan(info, browserCaps(), HomeCommon.preferredLangs());
                if (p) {
                    data.url = streamUrl(location.origin, src, p);
                    Lampa.Noty.show('Audio: ' + describe(p));
                }
                original.apply(self, args);
            });
        };
    }

    function shiftedRanges(ranges, offset) {
        return {
            length: ranges.length,
            start: function (i) {
                return ranges.start(i) + offset;
            },
            end: function (i) {
                return ranges.end(i) + offset;
            }
        };
    }

    // A converted stream always starts at 0. This <video> stand-in keeps Lampa's clock on the real movie time:
    // seeking inside what is loaded is a normal seek; seeking further restarts the conversion at the new time.
    function createVideo(call) {
        var real = document.createElement('video');
        real.className = 'player-video__video';
        real.setAttribute('playsinline', 'true');
        // wantPlay: the player's last play()/pause(). Lampa seeks as pause, seek, play; the play can arrive while the
        // new start is still being looked up, so it is applied once the new stream is loaded.
        var state = { base: '', offset: 0, duration: 0, pending: null, seeks: 0, wantPlay: false };

        var loaded = function (rel) {
            for (var i = 0; i < real.buffered.length; i++) {
                if (real.buffered.start(i) <= rel && rel <= real.buffered.end(i) - 1) return true;
            }
            return false;
        };
        var startPlaying = function () {
            var started = real.play();
            if (started && started.catch) started.catch(function () {});
            return started;
        };

        // The conversion starts at the keyframe before `time` (the server keeps audio with it), so the clock uses that.
        // Only the newest of quick repeated seeks goes through; a paused player stays paused.
        var restart = function (time) {
            var token = ++state.seeks;
            state.pending = time;
            real.pause();
            keyframe(sourceOf(state.base), time, function (start) {
                if (token !== state.seeks) return;
                state.pending = null;
                state.offset = start;
                real.src = state.base + '&t=' + start.toFixed(2);
                real.load();
                if (state.wantPlay) startPlaying();
            });
        };

        var proxy = new Proxy(real, {
            get: function (target, prop) {
                if (prop == 'currentTime') return state.pending !== null ? state.pending : state.offset + target.currentTime;
                if (prop == 'duration') return state.duration || (target.duration + state.offset);
                if (prop == 'src') return state.base;
                if (prop == 'buffered' || prop == 'seekable') return shiftedRanges(target[prop], state.offset);
                if (prop == 'paused' && state.pending !== null) return !state.wantPlay;
                if (prop == 'play') return function () {
                    state.wantPlay = true;
                    return state.pending !== null ? Promise.resolve() : startPlaying();
                };
                if (prop == 'pause') return function () {
                    state.wantPlay = false;
                    target.pause();
                };
                var value = target[prop];
                return typeof value == 'function' ? value.bind(target) : value;
            },
            set: function (target, prop, value) {
                if (prop == 'src') {
                    var match = /[?&]d=([\d.]+)/.exec(value);
                    state.base = String(value).replace(/&t=[\d.]+/, '');
                    state.duration = match ? parseFloat(match[1]) : 0;
                    state.offset = 0;
                    state.pending = null;
                    state.seeks++;
                    target.src = state.base;
                } else if (prop == 'currentTime') {
                    var time = Math.max(0, Math.min(value, state.duration ? state.duration - 1 : value));
                    var rel = time - state.offset;
                    if (rel >= 0 && loaded(rel)) target.currentTime = rel;
                    else restart(time);
                } else target[prop] = value;
                return true;
            }
        });
        call(proxy);
        return $(real);
    }

    function start() {
        Lampa.SettingsApi.addParam({
            component: 'homesync',
            param: { name: HomeCommon.AUDIOFIX_KEY, type: 'trigger', default: true },
            field: { name: 'Fix browser audio', description: 'Convert audio this browser cannot play (DTS, AC3...) to AAC on the home server, and pick the audio track by language priority.' }
        });
        Lampa.PlayerVideo.registerTube({
            verify: function (src) {
                return typeof src == 'string' && src.indexOf(location.origin + STREAM_PATH) === 0;
            },
            create: createVideo
        });
        wrapPlay();
    }

    var wait = setInterval(function () {
        if (!root.Lampa || !Lampa.Listener || !Lampa.PlayerVideo || !root.HomeCommon) return;
        clearInterval(wait);
        if (root.appready) start();
        else Lampa.Listener.follow('app', function (e) {
            if (e.type == 'ready') start();
        });
    }, 100);
})(typeof window !== 'undefined' ? window : globalThis);
