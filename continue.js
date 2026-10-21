// Continue watching: a button on the title page that plays the last episode (or movie) from where it stopped, or the
// next episode once it is finished; cards with progress show the episode and a progress bar.
// Progress comes from Lampa's own timeline (synced by homesync.js); the torrent last played per title is kept next to it.
(function (root) {
    // Percent from which an episode counts as finished, so Continue moves on to the next one.
    var FINISHED = 90;
    var MAX_MAGNET = 1200;
    var HASH_RE = /^[a-f0-9]{40}$/;
    var MAGNET_RE = /^magnet:\?xt=urn:btih:[a-f0-9]{40}(&tr=[^&]+)*$/;

    // Newest progress per title: { 'tv_1399': road, ... }; roads link to their title through road.card.
    function latestByTitle(fileView) {
        var latest = {};
        Object.keys(fileView || {}).forEach(function (hash) {
            var road = fileView[hash];
            if (!road || typeof road != 'object' || !road.card) return;
            var current = latest[road.card];
            if (!current || (road.updated || 0) > (current.updated || 0)) latest[road.card] = road;
        });
        return latest;
    }

    // The episode after season/episode that has already aired, or null at the end of what is out.
    function nextEpisode(card, season, episode) {
        var seasons = (card.seasons || []).filter(function (s) {
            return s.season_number > 0 && s.episode_count > 0;
        }).sort(function (a, b) {
            return a.season_number - b.season_number;
        });
        var current = seasons.filter(function (s) {
            return s.season_number == season;
        })[0];
        var later = seasons.filter(function (s) {
            return s.season_number > season;
        })[0];
        var next = current && episode < current.episode_count ? { season: season, episode: episode + 1 }
            : later ? { season: later.season_number, episode: 1 } : null;

        var aired = card.last_episode_to_air;
        if (next && aired && (next.season > aired.season_number || (next.season == aired.season_number && next.episode > aired.episode_number))) return null;
        return next;
    }

    // What Continue plays: the last played episode or movie, or the next episode once that one is finished.
    // { season, episode } for a series, {} for a movie, null when there is nothing to continue.
    function continueTarget(road, card) {
        if (!road) return null;
        var series = road.season !== undefined && road.episode !== undefined;
        if ((road.percent || 0) < FINISHED) return series ? { season: road.season, episode: road.episode } : {};
        return series ? nextEpisode(card, road.season, road.episode) : null;
    }

    // Episodes in a torrent as short ranges ("1:1-10,2:1-3"), so a 200-episode pack still fits the synced entry.
    function packEpisodes(pairs) {
        var bySeason = {};
        pairs.forEach(function (p) {
            if (p.season > 0 && p.episode > 0) (bySeason[p.season] = bySeason[p.season] || []).push(p.episode);
        });
        var parts = [];
        Object.keys(bySeason).map(Number).sort(function (a, b) {
            return a - b;
        }).forEach(function (season) {
            var eps = bySeason[season].sort(function (a, b) {
                return a - b;
            }).filter(function (e, i, all) {
                return all.indexOf(e) == i;
            });
            var start = eps[0];
            eps.forEach(function (e, i) {
                if (eps[i + 1] == e + 1) return;
                parts.push(season + ':' + (start == e ? e : start + '-' + e));
                start = eps[i + 1];
            });
        });
        return parts.join(',');
    }

    function hasEpisode(packed, season, episode) {
        return String(packed || '').split(',').some(function (part) {
            var m = /^(\d+):(\d+)(?:-(\d+))?$/.exec(part);
            return Boolean(m) && +m[1] == season && +m[2] <= episode && episode <= +(m[3] || m[2]);
        });
    }

    // Rebuilt from the info hash, keeping only the original's trackers: a parser's download link can carry an API key.
    function magnetFor(hash, original) {
        hash = String(hash || '').toLowerCase();
        if (!HASH_RE.test(hash)) return null;
        var magnet = 'magnet:?xt=urn:btih:' + hash;
        if (/^magnet:\?/i.test(original || '')) {
            original.slice(8).split('&').forEach(function (param) {
                if (!/^tr=[^&]+$/.test(param) || magnet.length + param.length + 1 > MAX_MAGNET) return;
                magnet += '&' + param;
            });
        }
        return magnet;
    }

    function validMagnet(magnet) {
        return typeof magnet == 'string' && magnet.length <= MAX_MAGNET && MAGNET_RE.test(magnet);
    }

    // Why Continue cannot play from the saved torrent, said before it opens the search instead; null when it can.
    function fallbackReason(resume, target) {
        var series = target.season !== undefined;
        if (!resume || !validMagnet(resume.magnet)) return 'No saved torrent for this on this profile. Pick a release.';
        if (series && !hasEpisode(resume.episodes, target.season, target.episode)) {
            return 'S' + target.season + 'E' + target.episode + " isn't in the last torrent. Pick a release.";
        }
        return null;
    }

    function badgeText(road) {
        return road.season !== undefined && road.episode !== undefined ? 'S' + road.season + ' E' + road.episode : '';
    }

    var core = { latestByTitle: latestByTitle, nextEpisode: nextEpisode, continueTarget: continueTarget, packEpisodes: packEpisodes,
        hasEpisode: hasEpisode, magnetFor: magnetFor, validMagnet: validMagnet, fallbackReason: fallbackReason, badgeText: badgeText };
    if (typeof module === 'object' && module.exports) module.exports = core;
    if (!root.document) return;

    var CSS = [
        '.home-progress__ep { position: absolute; left: 0.6em; bottom: 0.9em; z-index: 2; padding: 0.25em 0.55em; border-radius: 0.4em; background: rgba(0,0,0,0.72); color: #fff; font-size: 0.95em; font-weight: 600; }',
        '.home-progress__bar { position: absolute; left: 0.6em; right: 0.6em; bottom: 0.35em; z-index: 2; height: 0.28em; border-radius: 1em; overflow: hidden; background: rgba(255,255,255,0.25); }',
        '.home-progress__bar > div { height: 100%; background: #fff; }',
        '.card--home-progress .card__vote { bottom: 1em; }'
    ].join('\n');
    var LIST_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';

    var latest = null;
    var lastTorrent = null;
    // Set while Continue opens a torrent: which file to start once Lampa lists its files.
    var pending = null;

    function titleKey(card) {
        var link = card && card.id ? Lampa.Timeline.link(card, 1, 1) : null;
        return link ? link.card : null;
    }

    function progress() {
        if (!latest) latest = latestByTitle(Lampa.Storage.get(Lampa.Timeline.filename(), '{}'));
        return latest;
    }

    function readResume() {
        try {
            return JSON.parse(localStorage.getItem(HomeCommon.RESUME_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function saveResume(key, entry) {
        var all = readResume();
        all[key] = entry;
        localStorage.setItem(HomeCommon.RESUME_KEY, JSON.stringify(all));
        Lampa.Listener.send('state:changed', { target: 'resume', reason: 'update', data: { key: key, entry: entry } });
    }

    function rememberTorrent(e) {
        var key = titleKey(e.element.card);
        var magnet = magnetFor(e.element.torrent_hash, lastTorrent && lastTorrent.magnet);
        if (!key || !magnet) return;
        saveResume(key, {
            magnet: magnet,
            title: String((lastTorrent && lastTorrent.title) || '').slice(0, 300),
            file: e.element.id,
            episodes: packEpisodes(e.items || []),
            updated: Date.now()
        });
    }

    function wrapTorrentStart() {
        var start = Lampa.Torrent.start;
        Lampa.Torrent.start = function (object) {
            lastTorrent = object ? { title: object.title || object.Title, magnet: object.MagnetUri } : null;
            return start.apply(this, arguments);
        };
        var open = Lampa.Torrent.open;
        Lampa.Torrent.open = function () {
            lastTorrent = null;
            return open.apply(this, arguments);
        };
    }

    function isPendingFile(element) {
        if (String(element.torrent_hash).toLowerCase() != pending.hash) return false;
        return pending.season !== undefined ? element.season == pending.season && element.episode == pending.episode : element.id == pending.file;
    }

    function onTorrentFile(e) {
        if (e.type == 'onenter' && e.element) rememberTorrent(e);
        if (!pending) return;
        if (e.type == 'render' && isPendingFile(e.element)) pending.item = e.item;
        else if (e.type == 'list_close') pending = null;
        else if (e.type == 'list_open') {
            var current = pending;
            // After Lampa has rendered the whole list, so the player gets the full playlist (next-episode autoplay).
            setTimeout(function () {
                if (pending !== current) return;
                pending = null;
                if (current.item) current.item.trigger('hover:enter');
            }, 0);
        }
    }

    function continueWith(movie, target, body) {
        var resume = readResume()[titleKey(movie)];
        var series = target.season !== undefined;
        var reason = fallbackReason(resume, target);

        if (!reason) {
            pending = { hash: resume.magnet.slice(20, 60), season: target.season, episode: target.episode, file: resume.file };
            Lampa.Torrent.start({ title: resume.title || movie.title || movie.name, MagnetUri: resume.magnet, poster: movie.img }, movie);
            return;
        }
        // Not in the torrent played last (or none known): the torrent search, narrowed to the episode.
        Lampa.Noty.show(reason);
        if (series && root.HomeTorrents) HomeTorrents.pickEpisode(movie, target.season, target.episode);
        body.find('.view--torrent').trigger('hover:enter');
    }

    function addButton(e) {
        var movie = e.data && e.data.movie;
        var target = continueTarget(progress()[titleKey(movie)], movie || {});
        var buttons = e.body.find('.full-start-new__buttons');
        var play = buttons.find('.button--play');
        if (!target || !play.length) return;

        var button = $('<div class="full-start__button selector button--home-continue"><svg><use xlink:href="#sprite-play"></use></svg><span>Continue watching</span></div>');
        button.on('hover:enter', function () {
            continueWith(movie, target, e.body);
        });
        play.before(button);
        // Collapsed buttons show only their icon; Watch opens the source list, so it gets a list icon next to Continue.
        play.find('svg').replaceWith(LIST_ICON);

        var start = e.link.items && e.link.items[0];
        if (start) {
            start.last = button[0];
            button.on('hover:focus hover:enter hover:hover hover:touch', function () {
                start.last = button[0];
            });
        }
    }

    function decorate(card) {
        var data = card.card_data;
        if (!data) return;
        var road = progress()[titleKey(data)];
        var view = card.querySelector('.card__view');
        $(card).removeClass('card--home-progress').find('.home-progress__ep, .home-progress__bar').remove();
        if (!view || !road || !road.percent) return;

        var text = badgeText(road);
        if (text) $('<div class="home-progress__ep"></div>').text(text).appendTo(view);
        $('<div class="home-progress__bar"><div></div></div>').appendTo(view).children().css('width', Math.min(100, road.percent) + '%');
        $(card).addClass('card--home-progress');
    }

    function decorateAll() {
        latest = null;
        Array.prototype.forEach.call(document.querySelectorAll('.card'), decorate);
    }

    function watchCards() {
        new MutationObserver(function (mutations) {
            mutations.forEach(function (m) {
                Array.prototype.forEach.call(m.addedNodes, function (node) {
                    if (node.nodeType != 1) return;
                    if (node.classList.contains('card')) decorate(node);
                    else Array.prototype.forEach.call(node.querySelectorAll('.card'), decorate);
                });
            });
        }).observe(document.body, { childList: true, subtree: true });
    }

    function start() {
        var style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        wrapTorrentStart();
        Lampa.Listener.follow('torrent_file', onTorrentFile);
        Lampa.Listener.follow('full', function (e) {
            if (e.type == 'complite') addButton(e);
        });
        Lampa.Listener.follow('state:changed', function (e) {
            if (e.target == 'timeline') latest = null;
            // Another device's progress arrived: cards already on screen get the new badges.
            if (e.target == 'homesync') decorateAll();
        });
        Lampa.Player.listener.follow('destroy', function () {
            setTimeout(decorateAll, 300);
        });
        watchCards();
        decorateAll();
    }

    var wait = setInterval(function () {
        if (!root.Lampa || !Lampa.Listener || !Lampa.Torrent || !root.HomeCommon) return;
        clearInterval(wait);
        // Before the home screen builds its rows; Lampa's English for this row is "Continue browsing".
        Lampa.Lang.add({ title_continue: { en: 'Continue watching' } });
        if (root.appready) start();
        else Lampa.Listener.follow('app', function (e) {
            if (e.type == 'ready') start();
        });
    }, 100);
})(typeof window !== 'undefined' ? window : globalThis);
