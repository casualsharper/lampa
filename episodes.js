// New-episode alerts without CUB: episodes of favorite series that aired recently go to the notification bell.
// Air dates come from Lampa's own schedule (TimeTable, fed by TMDB); each profile gets its own alert list.
(function (root) {
    var WINDOW_DAYS = 14;
    var CHECK_EVERY = 3 * 3600 * 1000;
    // Lampa fills its schedule some seconds after start, so check a few times early; pointing at the bell checks too.
    var EARLY_CHECKS = [3000, 10000, 30000];
    // Lampa's bell dialog is sized for TVs; on desktop browsers it is made compact. Old TV browsers ignore :has().
    var COMPACT_CSS = [
        'body.platform--browser .modal:has(.notice) .modal__content { width: 44em; max-width: 92vw; }',
        'body.platform--browser .modal:has(.notice) .modal__title { font-size: 1.5em; }',
        'body.platform--browser .modal:has(.notice) .notice { padding: 0.8em; }',
        'body.platform--browser .modal:has(.notice) .notice__left { width: 3.6em; }',
        'body.platform--browser .modal:has(.notice) .notice__img, body.platform--browser .modal:has(.notice) .notice__img svg { width: 3.6em; height: auto; }',
        'body.platform--browser .modal:has(.notice) .notice__descr { font-size: 1.05em; }'
    ].join('\n');

    function escapeHtml(text) {
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function episodeCode(ep) {
        return 'S' + ep.season_number + 'E' + ep.episode_number;
    }

    // "S2E1–E10" for a run in one season, otherwise a short list.
    function episodeRange(eps) {
        var first = eps[0];
        var last = eps[eps.length - 1];
        var oneRun = eps.every(function (ep, i) {
            return ep.season_number == first.season_number && ep.episode_number == first.episode_number + i;
        });
        if (oneRun) return episodeCode(first) + '–E' + last.episode_number;
        var codes = eps.slice(0, 4).map(episodeCode).join(', ');
        return eps.length > 4 ? codes + '…' : codes;
    }

    // Pure part, testable without Lampa: schedule + favorite cards -> one notice per series per release day,
    // so a season dropped at once is one alert, not ten.
    function recentEpisodes(schedule, cards, now, parseDate) {
        // Air dates are calendar days (midnight); the extra day keeps "14 days ago" in regardless of the time now.
        var from = now - (WINDOW_DAYS + 1) * 24 * 3600 * 1000;
        var notices = [];
        schedule.forEach(function (entry) {
            var card = cards.filter(function (c) {
                return c.id == entry.id && c.original_name;
            })[0];
            if (!card) return;

            var byDay = {};
            (entry.episodes || []).forEach(function (ep) {
                if (!ep.air_date) return;
                var aired = parseDate(ep.air_date);
                if (!(aired >= from && aired <= now)) return;
                (byDay[ep.air_date] = byDay[ep.air_date] || []).push(ep);
            });

            Object.keys(byDay).sort().forEach(function (day) {
                var eps = byDay[day].sort(function (a, b) {
                    return (a.season_number - b.season_number) || (a.episode_number - b.episode_number);
                });
                var text = eps.length == 1
                    ? 'New episode ' + episodeCode(eps[0]) + (eps[0].name ? ' · ' + eps[0].name : '')
                    : eps.length + ' new episodes · ' + episodeRange(eps);
                notices.push({
                    id: 'eps:' + card.id + ':' + day,
                    from: 'home',
                    title: escapeHtml(card.name || card.original_name),
                    text: escapeHtml(text),
                    // Discovery time, not air time: the bell only counts notices newer than when it was last opened.
                    time: now,
                    poster: card.poster_path,
                    method: 'tv',
                    card: card
                });
            });
        });
        return notices;
    }

    var core = { recentEpisodes: recentEpisodes, escapeHtml: escapeHtml };
    if (typeof module === 'object' && module.exports) module.exports = core;
    if (!root.document) return;

    function start() {
        var profile = localStorage.getItem('homesync_profile') || 'default';
        // Version in the name: alerts stored one per episode, before grouping, stay behind in the old database.
        var source = new Lampa.NoticeClassLampa({ name: 'New episodes', db_name: 'notice_episodes2_' + profile });
        // Takes over Lampa's own source slot: with CUB off nothing else posts there, its old CUB-era notices stop
        // showing, and code that reads Notice.classes.lampa keeps working. One source means no tab bar.
        Lampa.Notice.addClass('lampa', source);

        var check = function () {
            var notices = recentEpisodes(Lampa.TimeTable.all(), Lampa.Favorite.full().card, Date.now(), function (date) {
                return Lampa.Utils.parseToDate(date).getTime();
            });
            notices.forEach(function (notice) {
                notice.card.source = notice.card.source || 'tmdb';
                // Rejected when already listed; that is the de-duplication.
                source.push(notice, function () {}, function () {});
            });
        };
        EARLY_CHECKS.forEach(function (delay) {
            setTimeout(check, delay);
        });
        setInterval(check, CHECK_EVERY);
        // Focus (remote) and hover (mouse) come right before opening the bell.
        Lampa.Head.render().find('.notice--icon').on('hover:focus hover:hover', check);

        var style = document.createElement('style');
        style.textContent = COMPACT_CSS;
        document.head.appendChild(style);
    }

    var wait = setInterval(function () {
        if (!root.Lampa || !Lampa.Listener || !Lampa.NoticeClassLampa) return;
        clearInterval(wait);
        if (root.appready) start();
        else Lampa.Listener.follow('app', function (e) {
            if (e.type == 'ready') start();
        });
    }, 100);
})(typeof window !== 'undefined' ? window : globalThis);
