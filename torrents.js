// Torrent list helpers, read from release titles (the only information the parser gives):
// - "Play best" picks the torrent most likely to play on this device, in the viewer's preferred audio language.
// - The episode picker narrows a series list to one season, its packs, or one episode (plus packs that contain it).
(function (root) {
    var OUTSIDE_PLAYERS_KEEP = ['inner', 'ios', 'lampa'];

    // Tokens trackers use for audio languages. Voice-over tags (dub, mvo...) only mean Russian on Cyrillic titles.
    var LANG_TOKENS = {
        en: ['en', 'eng', 'english'],
        ru: ['ru', 'rus', 'russian', 'рус', 'русский', 'дубляж', 'дублированный'],
        uk: ['ua', 'ukr', 'ukrainian', 'укр', 'украинский', 'українська'],
        lv: ['lv', 'lav', 'latvian', 'latviešu', 'латышский'],
        lt: ['lt', 'lit', 'lithuanian'],
        et: ['et', 'est', 'estonian'],
        de: ['de', 'ger', 'deu', 'german', 'deutsch'],
        fr: ['fr', 'fre', 'fra', 'french'],
        // "LAT" in release names is Latin-American Spanish, not Latvian.
        es: ['es', 'spa', 'esp', 'spanish', 'lat', 'latino', 'castellano'],
        it: ['it', 'ita', 'italian'],
        pl: ['pl', 'pol', 'polish'],
        ja: ['ja', 'jap', 'jpn', 'japanese'],
        ko: ['ko', 'kor', 'korean'],
        zh: ['zh', 'chi', 'chn', 'chinese']
    };
    var RU_VOICE_TOKENS = ['dub', 'mvo', 'dvo', 'avo', 'vo', 'многоголосый', 'двухголосый', 'одноголосый', 'авторский'];
    var ORIGINAL_TOKENS = ['original', 'orig', 'оригинал', 'оригинальная'];
    var SUB_TOKENS = ['sub', 'subs', 'subtitles', 'суб', 'субтитры'];
    // Two-letter codes are everyday words in titles ("It", "De", "Es"); only trust them inside a language list.
    var AMBIGUOUS = ['en', 'ru', 'ua', 'lv', 'lt', 'et', 'de', 'fr', 'es', 'it', 'pl', 'ja', 'ko', 'zh', 'vo'];
    var RELEASE_MARKERS = ['dl', 'rip', 'web', 'webrip', 'dlrip', 'bdrip', 'hdrip', 'bluray', 'remux', 'hdtv', 'dvdrip',
        '2160p', '1080p', '1080i', '720p', '480p', 'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1'];

    var TOKEN_TO_LANG = {};
    for (var code in LANG_TOKENS) {
        LANG_TOKENS[code].forEach(function (token) {
            TOKEN_TO_LANG[token] = code;
        });
    }

    function tokenize(title) {
        return (title || '').toLowerCase().split(/[\s.,;:|()\[\]{}\/\\_+\-–—"'«»!?]+/).filter(Boolean);
    }

    function has(tokens, list) {
        return tokens.some(function (t) {
            return list.indexOf(t) >= 0;
        });
    }

    function parseTitle(title, originalLanguage) {
        var tokens = tokenize(title);
        var text = ' ' + tokens.join(' ') + ' ';
        var cyrillic = /[а-яё]/i.test(title || '');
        var langs = [];
        var add = function (code) {
            if (code && langs.indexOf(code) < 0) langs.push(code);
        };
        // A language list is something like "Rus, Eng" or "2x Ukr | Eng": it sits after the release info.
        var listStart = -1;
        tokens.forEach(function (token, i) {
            if (RELEASE_MARKERS.indexOf(token) >= 0) listStart = i;
        });

        tokens.forEach(function (token, i) {
            if (SUB_TOKENS.indexOf(tokens[i + 1]) >= 0) return;
            var code = TOKEN_TO_LANG[token.replace(/^\d+x/, '')];
            if (code && (AMBIGUOUS.indexOf(token) < 0 || i > listStart)) add(code);
            if (cyrillic && RU_VOICE_TOKENS.indexOf(token) >= 0 && (token !== 'vo' || i > listStart)) add('ru');
            if (ORIGINAL_TOKENS.indexOf(token) >= 0 && originalLanguage) add(originalLanguage);
            // DUAL = the original audio plus English.
            if (token == 'dual') {
                add('en');
                if (originalLanguage) add(originalLanguage);
            }
        });

        // Scene releases (Latin-only names, no language tags) carry English audio by convention.
        var assumed = !langs.length && !cyrillic;
        if (assumed) add('en');

        var res = 0;
        if (/ (2160p|4k|uhd) /.test(text)) res = 2160;
        else if (/ 1080[pi] /.test(text)) res = 1080;
        else if (/ 720p /.test(text)) res = 720;
        else if (/ (480p|576p|dvdrip|sd) /.test(text)) res = 480;

        return {
            res: res,
            hevc: / (hevc|x265|h265|h 265) /.test(text),
            av1: / av1 /.test(text),
            audio: {
                dts: / dts(hd|x)? /.test(text) || / dts ma /.test(text),
                truehd: / (truehd|atmos) /.test(text),
                ac3: / (ac3|dd5|dd|dolby digital) /.test(text) && !/ (ddp|dd\+|eac3|e ac3) /.test(text),
                eac3: / (ddp|eac3|e ac3|ddp5) /.test(text),
                aac: / aac /.test(text)
            },
            mp4: / mp4 /.test(text),
            cam: has(tokens, ['cam', 'camrip', 'ts', 'telesync', 'hdts', 'tc', 'telecine', 'hdcam']),
            langs: langs,
            langsAssumed: assumed
        };
    }

    // caps: what the current player can decode. Outside players (VLC, IINA...) decode everything.
    function playability(parsed, caps) {
        if (caps.everything) return { ok: true };
        if (parsed.hevc && !caps.hevc) return { ok: false, why: 'HEVC video' };
        if (parsed.av1 && !caps.av1) return { ok: false, why: 'AV1 video' };
        if (!parsed.mp4 && !caps.mkv) return { ok: false, why: 'MKV file' };
        var a = parsed.audio;
        var anyAudioListed = a.dts || a.truehd || a.ac3 || a.eac3 || a.aac;
        var playableAudio = a.aac || (a.ac3 && caps.ac3) || (a.eac3 && caps.eac3);
        if (anyAudioListed && !playableAudio) return { ok: false, why: a.dts ? 'DTS audio' : a.truehd ? 'TrueHD audio' : 'Dolby audio' };
        return { ok: true };
    }

    function score(parsed, seeders, langPriority) {
        var points = 0;
        var langRank = -1;
        langPriority.forEach(function (code, i) {
            if (langRank < 0 && parsed.langs.indexOf(code) >= 0) langRank = i;
        });
        if (langRank >= 0) points += Math.max(1000 - langRank * 350, 100);
        else if (!parsed.langs.length) points += 50;

        points += { 2160: 60, 1080: 80, 720: 40, 480: 0, 0: 20 }[parsed.res];
        if (parsed.cam) points -= 500;
        if (seeders > 0) points += Math.min(200, 40 * Math.log(1 + seeders) / Math.LN2);
        else points -= 300;

        return { points: points, langRank: langRank };
    }

    // With one episode picked, a release of exactly that episode beats a pack: a pack means choosing the file again.
    function exactEpisodeBonus(title, pick) {
        if (!pick || !pick.episode) return 0;
        var e = parseEpisodes(title);
        return e && e.from === pick.episode && e.to === pick.episode ? 300 : 0;
    }

    // Returns { element, parsed, playable, why } or null. Unplayable ones only win when nothing playable exists.
    function pickBest(elements, options) {
        var ranked = elements.map(function (element) {
            var parsed = parseTitle(element.Title, options.originalLanguage);
            var play = playability(parsed, options.caps);
            var seeders = parseInt(element.Seeders, 10) || 0;
            var points = score(parsed, seeders, options.langs).points + exactEpisodeBonus(element.Title, options.pick);
            return { element: element, parsed: parsed, seeders: seeders, playable: play.ok, why: play.why, points: points };
        });
        ranked.sort(function (a, b) {
            return (b.playable - a.playable) || (b.points - a.points) || (b.seeders - a.seeders);
        });
        return ranked[0] || null;
    }

    // Returns { seasons: [...], from, to } or null; from/to are null for whole-season packs.
    function parseEpisodes(title) {
        var t = title || '';
        var m = t.match(/S(\d{1,2})[ ._-]?E(\d{1,3})(?:[-–]?E?(\d{1,3}))?/i);
        if (m) return { seasons: [+m[1]], from: +m[2], to: +(m[3] || m[2]) };
        m = t.match(/(?:^|[^\d])(\d{1,2})x(\d{2,3})(?:-(\d{2,3}))?(?![\dp])/i);
        if (m) return { seasons: [+m[1]], from: +m[2], to: +(m[3] || m[2]) };

        var seasons = [];
        m = t.match(/S(\d{1,2})[ ._]?-[ ._]?S(\d{1,2})/i) || t.match(/(?:сезон[ыа]?|seasons?)[: ._]*(\d{1,2})[ ]?-[ ]?(\d{1,2})/i);
        if (m) {
            for (var s = +m[1]; s <= +m[2] && seasons.length < 40; s++) seasons.push(s);
        } else {
            m = t.match(/(?:^|[^a-z\d])S(\d{1,2})(?![\d])/i) || t.match(/(?:сезон|season)[: ._]*(\d{1,2})/i) || t.match(/(\d{1,2})[ -]?(?:й )?сезон/i);
            if (m) seasons.push(+m[1]);
        }
        if (!seasons.length) return null;

        // Russian trackers: "Сезон: 2 / Серии: 1-10 из 10" is a pack of those episodes.
        m = t.match(/сери[ияй]:?\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?/i);
        if (m && seasons.length == 1) return { seasons: seasons, from: +m[1], to: +(m[2] || m[1]) };
        return { seasons: seasons, from: null, to: null };
    }

    // One entry per single episode seen, plus one per season with packs, sorted; null when the list is not a series.
    function groupEpisodes(elements) {
        var groups = {};
        elements.forEach(function (element) {
            var e = parseEpisodes(element.Title);
            if (!e) return;
            e.seasons.forEach(function (season) {
                var key = e.from === null || e.from != e.to ? season + ':pack' : season + ':' + e.from;
                if (!groups[key]) groups[key] = { season: season, episode: e.from === null || e.from != e.to ? null : e.from, count: 0 };
                groups[key].count++;
            });
        });
        var list = Object.keys(groups).map(function (key) {
            return groups[key];
        });
        if (list.length < 2) return null;
        return list.sort(function (a, b) {
            return (a.season - b.season) || ((a.episode === null ? -1 : a.episode) - (b.episode === null ? -1 : b.episode));
        });
    }

    // The picker's groups per season, for a season menu that opens into its episodes; null when there is no picker.
    function groupSeasons(elements) {
        var groups = groupEpisodes(elements);
        if (!groups) return null;
        var seasons = [];
        groups.forEach(function (g) {
            var last = seasons[seasons.length - 1];
            if (!last || last.season != g.season) seasons.push(last = { season: g.season, count: 0, groups: [] });
            last.groups.push(g);
        });
        seasons.forEach(function (s) {
            s.count = elements.filter(function (element) {
                var e = parseEpisodes(element.Title);
                return e && e.seasons.indexOf(s.season) >= 0;
            }).length;
        });
        return seasons;
    }

    // Picks: { season } a whole season, { season, packs: true } its packs, { season, episode } one episode.
    function groupPick(group) {
        return group.episode === null ? { season: group.season, packs: true } : { season: group.season, episode: group.episode };
    }

    function pickLabel(pick) {
        if (pick.packs) return 'Season ' + pick.season + ' packs';
        return pick.episode ? 'S' + pick.season + 'E' + pick.episode : 'Season ' + pick.season;
    }

    // An episode pick keeps that episode and any pack covering it; a packs pick keeps the season's packs.
    function matchesPick(title, pick) {
        var e = parseEpisodes(title);
        if (!e || e.seasons.indexOf(pick.season) < 0) return false;
        var isPack = e.from === null || e.from != e.to;
        if (pick.packs) return isPack;
        if (!pick.episode) return true;
        return e.from === null || (e.from <= pick.episode && pick.episode <= e.to);
    }

    var core = { parseTitle: parseTitle, playability: playability, score: score, pickBest: pickBest,
        parseEpisodes: parseEpisodes, groupEpisodes: groupEpisodes, groupSeasons: groupSeasons, groupPick: groupPick,
        pickLabel: pickLabel, matchesPick: matchesPick };
    if (typeof module === 'object' && module.exports) module.exports = core;
    if (!root.document) return;

    function browserCaps() {
        var player = root.Lampa ? Lampa.Storage.field('player_torrent') : 'inner';
        if (OUTSIDE_PLAYERS_KEEP.indexOf(player) < 0) return { everything: true };

        var video = document.createElement('video');
        var can = function (type) {
            return Boolean(video.canPlayType(type)) || Boolean(root.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported(type));
        };
        var ua = navigator.userAgent;
        var safari = /safari/i.test(ua) && !/chrome|chromium|crios|android/i.test(ua);
        return {
            hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"'),
            av1: can('video/mp4; codecs="av01.0.08M.08"'),
            ac3: can('audio/mp4; codecs="ac-3"'),
            eac3: can('audio/mp4; codecs="ec-3"'),
            mkv: !safari
        };
    }

    function describe(best) {
        var parts = [];
        if (best.parsed.res) parts.push(best.parsed.res + 'p');
        if (best.parsed.langs.length) parts.push(best.parsed.langs.join('/').toUpperCase() + (best.parsed.langsAssumed ? ' (assumed)' : ''));
        parts.push(best.seeders + ' seeds');
        if (!best.playable) parts.push('may not play here: ' + best.why);
        return parts.join(' · ');
    }

    // The picked episode belongs to one show and survives the torrent list being rebuilt (e.g. after playing);
    // it is forgotten when another page than this show's opens. Memory only, never stored.
    var remembered = null;

    function pickFor(movie) {
        return remembered && movie && remembered.movie == movie.id ? remembered.pick : null;
    }

    function setPick(movie, pick) {
        remembered = pick && movie ? { movie: movie.id, pick: pick } : null;
    }

    // continue.js opens the torrent list already narrowed to the episode to watch.
    root.HomeTorrents = {
        pickEpisode: function (movie, season, episode) {
            setPick(movie, { season: season, episode: episode });
        }
    };

    function forgetOnLeave(e) {
        if (e.type != 'start' || !remembered || !e.object) return;
        var o = e.object;
        var id = o.movie ? o.movie.id : o.card ? o.card.id : o.id;
        if (!(o.component == 'full' || o.component == 'torrents') || id != remembered.movie) remembered = null;
    }

    // Applied inside Lampa's own filtering, so paging, sorting and Play best all see the narrowed list.
    function onFiltred(e) {
        e.data.component.homeEpisodeSource = e.data.results;
        var pick = pickFor(e.data.movie);
        if (!pick) return;
        var narrowed = e.data.results.filter(function (element) {
            return matchesPick(element.Title, pick);
        });
        // Another filter can leave the pick empty; an empty list would also hide the picker, so drop the pick.
        if (narrowed.length) e.data.results = narrowed;
        else setPick(e.data.movie, null);
    }

    function samePick(a, b) {
        return Boolean(a) && Boolean(b) && a.season == b.season && Boolean(a.packs) == Boolean(b.packs) && (a.episode || 0) == (b.episode || 0);
    }

    // Seasons first; a season opens into "all of it", its packs and its episodes. One season opens straight away.
    function choosePick(e, seasons) {
        var enabled = Lampa.Controller.enabled().name;
        var current = pickFor(e.movie);
        var close = function () {
            Lampa.Controller.toggle(enabled);
        };
        var apply = function (item) {
            setPick(e.movie, item.pick);
            close();
            e.component.applyFilter();
        };

        var showSeason = function (s, back) {
            var items = [{ title: 'All of season ' + s.season + ' (' + s.count + ')', pick: { season: s.season } }].concat(s.groups.map(function (g) {
                var pick = groupPick(g);
                return { title: (pick.packs ? 'Season packs' : pickLabel(pick)) + ' (' + g.count + ')', pick: pick };
            }));
            items.forEach(function (item) {
                item.selected = samePick(item.pick, current);
            });
            Lampa.Select.show({ title: 'Season ' + s.season, items: items, onSelect: apply, onBack: back });
        };

        var showSeasons = function () {
            var items = [{ title: 'All episodes', pick: null, selected: !current }].concat(seasons.map(function (s) {
                return { title: 'Season ' + s.season + ' (' + s.count + ')', season: s, selected: Boolean(current) && current.season == s.season };
            }));
            Lampa.Select.show({
                title: 'Episode',
                items: items,
                onSelect: function (item) {
                    if (item.season) showSeason(item.season, showSeasons);
                    else apply(item);
                },
                onBack: close
            });
        };

        if (seasons.length == 1) showSeason(seasons[0], close);
        else showSeasons();
    }

    function addEpisodeRow(e) {
        var seasons = groupSeasons(e.component.homeEpisodeSource || e.results);
        if (!seasons) return;
        var pick = pickFor(e.movie);

        var row = $('<div class="torrent-item selector playbest"><div class="torrent-item__title"></div><div class="playbest__why">Choose a season or episode to see only its releases</div></div>');
        row.find('.torrent-item__title').text('Episode: ' + (pick ? pickLabel(pick) : 'all'));
        row.on('hover:enter', function () {
            choosePick(e, seasons);
        });
        e.scroll.append(row);
    }

    function addRow(e) {
        var options = {
            caps: browserCaps(),
            langs: HomeCommon.preferredLangs(),
            originalLanguage: e.movie && e.movie.original_language,
            pick: pickFor(e.movie)
        };
        var best = pickBest(e.results, options);
        if (!best) return;

        var row = $('<div class="torrent-item selector playbest"><div class="torrent-item__title"></div><div class="playbest__why"></div></div>');
        row.find('.torrent-item__title').text('▶ Play best: ' + best.element.Title);
        row.find('.playbest__why').text(describe(best));
        row.on('hover:enter', function () {
            best.element.poster = e.movie.img;
            e.component.start();
            Lampa.Torrent.start(best.element, e.movie);
        });
        e.scroll.append(row);
    }

    function start() {
        var style = document.createElement('style');
        style.textContent = '.playbest { border: 0.15em solid rgba(255,255,255,0.4); } .playbest__why { margin-top: 0.5em; opacity: 0.7; }';
        document.head.appendChild(style);

        ['1st', '2nd', '3rd'].forEach(function (place, i) {
            Lampa.SettingsApi.addParam({
                component: 'homesync',
                param: { name: HomeCommon.LANG_KEYS[i], type: 'select', values: HomeCommon.LANGUAGES, default: i === 0 ? 'en' : 'none' },
                field: { name: place + ' audio language', description: i === 0 ? 'Preferred audio, best first. Used by "Play best" and "Fix browser audio".' : '' }
            });
        });
        Lampa.Listener.follow('activity', forgetOnLeave);
        Lampa.Listener.follow('torrent', function (e) {
            if (e.type == 'filtred') onFiltred(e);
            if (e.type == 'results') {
                addEpisodeRow(e);
                if (e.results && e.results.length) addRow(e);
            }
        });
    }

    var wait = setInterval(function () {
        if (!root.Lampa || !Lampa.Listener || !Lampa.SettingsApi) return;
        clearInterval(wait);
        if (root.appready) start();
        else Lampa.Listener.follow('app', function (e) {
            if (e.type == 'ready') start();
        });
    }, 100);
})(typeof window !== 'undefined' ? window : globalThis);
