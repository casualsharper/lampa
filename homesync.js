// Per-person favorites, history, watch progress and settings synced through the home server (selfhost/server.py), replacing CUB account sync.
(function () {
    var API = './homesync/';
    var PROFILE_KEY = 'homesync_profile';
    var QUEUE_KEY = 'homesync_queue';
    var PROFILE_RE = /^[A-Za-z0-9_-]{1,32}$/;
    var CATEGORIES = ['like', 'wath', 'book', 'history', 'look', 'viewed', 'scheduled', 'continued', 'thrown'];
    var FAVORITE_DELAY = 1000;
    // Progress changes every few seconds during playback; batch it.
    var TIMELINE_DELAY = 10000;
    var RETRY_DELAY = 30000;
    // Queue fields where the newest entry per key wins (server: NEWEST_WINS): the server state field, and where each
    // lives on this device. Settings are kept as { name: { value, updated } } next to Lampa's own copy of each value.
    var NEWEST_WINS = {
        timelines: { state: 'file_view', local: 'file_view' },
        resume: { state: 'resume', local: HomeCommon.RESUME_KEY },
        prefs: { state: 'prefs', local: 'homesync_prefs' }
    };

    var flushTimer = null;
    var flushDelay = 0;
    var flushing = false;
    var started = false;
    var problem = '';
    var problemShown = false;

    function problemText(status) {
        return status == 503
            ? "Home sync can't save: the server's data folder is not writable"
            : 'Home sync is not reachable. Changes stay on this device until it is.';
    }

    // Once per session, so a NAS that is down does not repeat the notice on every retry.
    function reportProblem(status) {
        if (problemShown) return;
        problem = problemText(status);
        if (started) showProblem();
    }

    function showProblem() {
        problemShown = true;
        Lampa.Noty.show(problem, { time: 10000 });
    }

    function profile() {
        return localStorage.getItem(PROFILE_KEY) || '';
    }

    function profilePath(name) {
        return 'profile/' + encodeURIComponent(name);
    }

    function emptyQueue() {
        var queue = { ops: [] };
        for (var field in NEWEST_WINS) queue[field] = {};
        return queue;
    }

    function readQueue() {
        try {
            var queue = JSON.parse(localStorage.getItem(QUEUE_KEY));
            if (queue && queue.ops instanceof Array && queue.timelines) {
                // Queues saved before a field existed.
                for (var field in NEWEST_WINS) queue[field] = queue[field] || {};
                return queue;
            }
        } catch (e) {}
        return emptyQueue();
    }

    // Read straight from localStorage: continue.js writes its map there, past Lampa.Storage's in-memory copy.
    function readLocal(key) {
        try {
            var value = JSON.parse(localStorage.getItem(key));
            if (value && typeof value == 'object') return value;
        } catch (e) {}
        return {};
    }

    function writeQueue(queue) {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    }

    function queueEmpty(queue) {
        return !queue.ops.length && Object.keys(NEWEST_WINS).every(function (field) {
            return !Object.keys(queue[field]).length;
        });
    }

    function send(method, path, body, async, done) {
        var xhr = new XMLHttpRequest();
        var finished = false;
        var finish = function (status, data) {
            if (finished) return;
            finished = true;
            done(status, data);
        };

        xhr.open(method, API + path, async);
        if (async) xhr.timeout = 10000;
        xhr.onload = function () {
            var data = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {}
            finish(xhr.status, data);
        };
        xhr.onerror = xhr.ontimeout = function () {
            finish(0, null);
        };

        try {
            if (body) {
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.send(JSON.stringify(body));
            } else xhr.send();
        } catch (e) {
            finish(0, null);
        }
    }

    // The profile's settings replace this device's. live: Lampa is running, so its in-memory copy is updated too
    // (without a change event, which would queue them straight back).
    function applyPrefs(prefs, live) {
        Object.keys(prefs || {}).forEach(function (name) {
            var entry = prefs[name];
            if (!HomeCommon.isProfilePref(name) || !entry || typeof entry.value != 'string') return;
            if (live) Lampa.Storage.set(name, entry.value, true);
            else localStorage.setItem(name, entry.value);
        });
    }

    function localProfilePrefs() {
        var names = [];
        for (var i = 0; i < localStorage.length; i++) {
            if (HomeCommon.isProfilePref(localStorage.key(i))) names.push(localStorage.key(i));
        }
        return names;
    }

    function storeLocalMaps(state, live) {
        for (var field in NEWEST_WINS) {
            var map = state[NEWEST_WINS[field].state] || {};
            if (live) Lampa.Storage.set(NEWEST_WINS[field].local, map, true);
            else localStorage.setItem(NEWEST_WINS[field].local, JSON.stringify(map));
        }
        applyPrefs(state.prefs, live);
    }

    function storeRaw(state) {
        localStorage.setItem('favorite', JSON.stringify(state.favorite));
        storeLocalMaps(state, false);
    }

    // Blocking on purpose: it runs before Lampa reads localStorage, so the app starts with this person's lists.
    function syncBeforeStart() {
        var name = profile();
        if (!name) return;

        send('POST', profilePath(name), readQueue(), false, function (status, state) {
            if (status == 200 && state) {
                writeQueue(emptyQueue());
                storeRaw(state);
            } else if (status == 400) {
                // The server will never accept this queue; keep it from blocking every later sync.
                writeQueue(emptyQueue());
            } else reportProblem(status);
        });
    }

    var heldState = null;

    // Favorite.read() makes Lampa refresh the page. During playback, or while a torrent is being opened (file list,
    // preload, audio check), that throws the viewer back to the series page, so the reload waits until they leave.
    function busy() {
        var active = Lampa.Activity.active();
        return Lampa.Player.opened() || Boolean(document.querySelector('.modal')) || Boolean(active && active.component == 'torrents');
    }

    function applyHeld() {
        if (!heldState || busy()) return;
        var state = heldState;
        heldState = null;
        applyLive(state);
    }

    function applyLive(state) {
        if (busy()) {
            heldState = state;
            return;
        }
        // A held state is older than what was watched meanwhile; send that first and apply the merged answer instead.
        if (!queueEmpty(readQueue())) return flush(true);
        Lampa.Storage.set('favorite', state.favorite, true);
        storeLocalMaps(state, true);
        Lampa.Favorite.read();
        Lampa.Timeline.read();
        Lampa.Listener.send('state:changed', { target: 'homesync', reason: 'read' });
    }

    function findCard(id) {
        var cards = Lampa.Favorite.full().card;
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].id == id) return cards[i];
        }
    }

    function schedule(delay) {
        if (flushTimer && flushDelay <= delay) return;
        clearTimeout(flushTimer);
        flushDelay = delay;
        flushTimer = setTimeout(function () {
            flushTimer = null;
            flush(false);
        }, delay);
    }

    function flush(refresh) {
        var name = profile();
        if (!name || flushing) return;

        var queue = readQueue();
        if (queueEmpty(queue) && !refresh) return;

        queue.ops.forEach(function (op) {
            if (op.op != 'remove' && !op.card) op.card = findCard(op.id);
        });

        flushing = true;
        send('POST', profilePath(name), queue, true, function (status, state) {
            flushing = false;
            if (status != 200 && status != 400) {
                reportProblem(status);
                return schedule(RETRY_DELAY);
            }

            var rest = readQueue();
            rest.ops = rest.ops.slice(queue.ops.length);
            Object.keys(NEWEST_WINS).forEach(function (field) {
                for (var key in queue[field]) {
                    if (rest[field][key] && rest[field][key].updated === queue[field][key].updated) delete rest[field][key];
                }
            });
            writeQueue(rest);

            if (!queueEmpty(rest)) return schedule(FAVORITE_DELAY);
            // Own changes are already in Lampa, so only a refresh (start, back to the tab) loads what other devices did.
            // And only when nothing local is still unsent, or that change would flicker away.
            if (status == 200 && state && refresh) applyLive(state);
        });
    }

    function onStateChanged(e) {
        if (!profile() || e.reason != 'update') return;

        var queue;
        if (e.target == 'favorite' && e.card && (e.method == 'add' || e.method == 'added' || e.method == 'remove')) {
            queue = readQueue();
            queue.ops.push({ op: e.method, where: e.type, id: e.card.id });
            writeQueue(queue);
            schedule(FAVORITE_DELAY);
        } else if (e.target == 'timeline' && e.data && e.data.road) {
            queue = readQueue();
            queue.timelines[e.data.hash] = e.data.road;
            writeQueue(queue);
            schedule(TIMELINE_DELAY);
        } else if (e.target == 'resume' && e.data && e.data.key) {
            queue = readQueue();
            queue.resume[e.data.key] = e.data.entry;
            writeQueue(queue);
            schedule(FAVORITE_DELAY);
        }
    }

    function onSettingChanged(e) {
        if (!profile() || !HomeCommon.isProfilePref(e.name)) return;
        var entry = { value: HomeCommon.prefText(e.value), updated: Date.now() };
        var local = readLocal(NEWEST_WINS.prefs.local);
        local[e.name] = entry;
        localStorage.setItem(NEWEST_WINS.prefs.local, JSON.stringify(local));
        var queue = readQueue();
        queue.prefs[e.name] = entry;
        writeQueue(queue);
        schedule(FAVORITE_DELAY);
    }

    // A device picking its first profile brings its existing lists along instead of losing them.
    function localDataAsQueue() {
        var queue = emptyQueue();
        var favorite = Lampa.Favorite.full();

        CATEGORIES.forEach(function (where) {
            var ids = (favorite[where] || []).slice().reverse();
            ids.forEach(function (id) {
                queue.ops.push({ op: 'add', where: where, id: id, card: findCard(id) });
            });
        });

        Object.keys(NEWEST_WINS).forEach(function (field) {
            var local = readLocal(NEWEST_WINS[field].local);
            for (var key in local) {
                if (local[key] && typeof local[key] == 'object') queue[field][key] = local[key];
            }
        });
        // Settings made before any profile existed. Dated 0, so a profile that already has its own keeps them.
        localProfilePrefs().forEach(function (name) {
            if (!queue.prefs[name]) queue.prefs[name] = { value: localStorage.getItem(name), updated: 0 };
        });
        return queue;
    }

    function switchTo(name) {
        var current = profile();
        var queue = emptyQueue();

        if (!current) queue = localDataAsQueue();
        else send('POST', profilePath(current), readQueue(), false, function () {});

        localStorage.setItem(PROFILE_KEY, name);
        writeQueue(queue);
        // If the NAS is unreachable on reload, show empty lists rather than the previous person's.
        if (current) {
            ['favorite'].concat(Object.keys(NEWEST_WINS).map(function (field) {
                return NEWEST_WINS[field].local;
            }), localProfilePrefs()).forEach(function (key) {
                localStorage.removeItem(key);
            });
        }
        location.reload();
    }

    function askName(back) {
        Lampa.Input.edit({ title: 'Profile name', value: '', free: true, nosave: true }, function (value) {
            if (!PROFILE_RE.test(value)) {
                Lampa.Noty.show('Use letters, digits, - or _ (up to 32)');
                return back();
            }
            switchTo(value);
        });
    }

    function pickProfile() {
        var enabled = Lampa.Controller.enabled().name;
        var back = function () {
            Lampa.Controller.toggle(enabled);
        };

        send('GET', 'profiles', null, true, function (status, list) {
            if (status != 200 || !(list instanceof Array)) {
                Lampa.Noty.show(problemText(status), { time: 10000 });
                return;
            }

            var current = profile();
            var items = list.map(function (name) {
                return { title: name, name: name, selected: name == current };
            });
            items.push({ title: 'New profile', create: true });

            Lampa.Select.show({
                title: 'Who is watching?',
                items: items,
                onSelect: function (item) {
                    if (item.create) askName(back);
                    else if (item.name == current) back();
                    else switchTo(item.name);
                },
                onBack: back
            });
        });
    }

    var HEADER_CSS = [
        '.homesync-head { padding: 0.2em; }',
        '.homesync-head__avatar { width: 2.4em; height: 2.4em; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 600; color: #fff; }'
    ].join('\n');

    // Same name always gets the same color, so people recognise their profile at a glance.
    function avatarColor(name) {
        var hash = 0;
        for (var i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
        return 'hsl(' + hash + ', 55%, 45%)';
    }

    function addHeaderButton() {
        var name = profile();
        var style = document.createElement('style');
        style.textContent = HEADER_CSS;
        document.head.appendChild(style);

        var button = $('<div class="head__action selector homesync-head"><span class="homesync-head__avatar"></span></div>');
        button.attr('title', name ? 'Profile: ' + name : 'Choose profile');
        button.find('.homesync-head__avatar').text(name ? name.charAt(0).toUpperCase() : '?').css('background', name ? avatarColor(name) : '#666');
        // Last in the header icons, right before the status dots (Lampa.Head.addElement would put it first).
        Lampa.Head.render().find('.head__actions').append(button);
        button.on('hover:enter', pickProfile);
    }

    function start() {
        started = true;
        addHeaderButton();
        if (problem && !problemShown) showProblem();

        Lampa.SettingsApi.addComponent({
            component: 'homesync',
            name: 'Profile',
            icon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="currentColor" stroke-width="2"/></svg>'
        });
        Lampa.SettingsApi.addParam({
            component: 'homesync',
            param: { name: 'homesync_switch', type: 'button' },
            field: { name: profile() ? 'Profile: ' + profile() + ' (switch)' : 'Choose profile' },
            onChange: pickProfile
        });

        Lampa.Listener.follow('state:changed', onStateChanged);
        Lampa.Storage.listener.follow('change', onSettingChanged);
        var applyHeldSoon = function () {
            setTimeout(applyHeld, 500);
        };
        Lampa.Player.listener.follow('destroy', applyHeldSoon);
        Lampa.Listener.follow('activity', function (e) {
            if (e.type == 'start') applyHeldSoon();
        });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState == 'visible') flush(true);
        });

        if (!profile()) afterFirstScreen(pickProfile);
        else if (!queueEmpty(readQueue())) schedule(FAVORITE_DELAY);
    }

    // The home screen grabs focus once its rows load; a picker opened before that gets hidden behind it.
    function afterFirstScreen(call) {
        var done = false;
        var run = function () {
            if (done) return;
            done = true;
            setTimeout(call, 300);
        };
        Lampa.Controller.listener.follow('toggle', function (e) {
            if (e.name != 'select') run();
        });
        setTimeout(run, 5000);
    }

    syncBeforeStart();

    var waitForLampa = setInterval(function () {
        if (!window.Lampa || !Lampa.Listener) return;
        clearInterval(waitForLampa);
        if (window.appready) start();
        else Lampa.Listener.follow('app', function (e) {
            if (e.type == 'ready') start();
        });
    }, 100);
})();
