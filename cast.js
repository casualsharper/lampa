// Send to device: pick a movie or a torrent file on one device, and another device on the LAN opens or plays it.
// Replaces CUB's broadcast; commands go through the home server (selfhost/server.py, /homesync/cast/).
(function (root) {
    var API = './homesync/cast/';
    var DEVICE_KEY = 'cast_device';
    // Lampa's own setting (Settings → Other → Device name), originally for CUB's broadcast.
    var NAME_KEY = 'device_name';
    var POLL_TIMEOUT = 35000;
    var RETRY_DELAY = 10000;

    function defaultName(ua) {
        if (/Android TV|AFT|BRAVIA|SMART-TV|SmartTV|Tizen|Web0S|webOS|GoogleTV/i.test(ua)) return 'TV';
        if (/iPhone/.test(ua)) return 'iPhone';
        if (/iPad/.test(ua)) return 'iPad';
        if (/Android/.test(ua)) return 'Android';
        if (/Macintosh/.test(ua)) return 'Mac';
        if (/Windows/.test(ua)) return 'Windows PC';
        return 'Device';
    }

    function methodOf(card) {
        return card.number_of_seasons || card.original_name || (card.name && !card.title) ? 'tv' : 'movie';
    }

    var core = { defaultName: defaultName, methodOf: methodOf };
    if (typeof module === 'object' && module.exports) module.exports = core;
    if (!root.document) return;

    function deviceId() {
        var id = localStorage.getItem(DEVICE_KEY);
        if (!id || !/^[A-Za-z0-9_-]{8,40}$/.test(id)) {
            var bytes = new Uint8Array(8);
            root.crypto.getRandomValues(bytes);
            id = 'd-' + Array.prototype.map.call(bytes, function (b) {
                return ('0' + b.toString(16)).slice(-2);
            }).join('');
            localStorage.setItem(DEVICE_KEY, id);
        }
        return id;
    }

    function deviceName() {
        return Lampa.Storage.get(NAME_KEY, '') || defaultName(navigator.userAgent);
    }

    function escape(text) {
        return $('<div>').text(text).html();
    }

    function request(method, path, body, timeout, done) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, API + path, true);
        xhr.timeout = timeout;
        xhr.onload = function () {
            var data = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {}
            done(xhr.status, data);
        };
        xhr.onerror = xhr.ontimeout = function () {
            done(0, null);
        };
        if (body) {
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(body));
        } else xhr.send();
    }

    function run(command) {
        var from = escape(command.from);
        if (command.action == 'open') {
            Lampa.Noty.show('Opened from ' + from);
            Lampa.Activity.push({ url: '', component: 'full', id: command.card.id, method: command.card.method, card: { id: command.card.id, source: 'tmdb' }, source: 'tmdb' });
        } else if (command.action == 'play') {
            if (!HomeCommon.isTorrServerUrl(command.url, HomeCommon.torrserverAddress())) return Lampa.Noty.show('Ignored a stream from ' + from + ': not from this TorrServer');
            Lampa.Noty.show('Playing from ' + from);
            var data = { url: command.url, title: command.title || command.from };
            if (command.timeline && command.timeline.hash) data.timeline = command.timeline;
            Lampa.Player.play(data);
        }
    }

    function poll() {
        request('POST', 'poll', { device: deviceId(), name: deviceName() }, POLL_TIMEOUT, function (status, data) {
            if (status == 200 && data && data.commands) {
                data.commands.forEach(run);
                poll();
            } else setTimeout(poll, RETRY_DELAY);
        });
    }

    function chooseDevice(title, onPick) {
        request('GET', 'devices', null, 10000, function (status, list) {
            if (status != 200 || !(list instanceof Array)) return Lampa.Noty.show('Home server is not reachable');
            var me = deviceId();
            var others = list.filter(function (d) {
                return d.id != me;
            });
            if (!others.length) return Lampa.Noty.show('No other device is online. Open Lampa on it first.');

            var enabled = Lampa.Controller.enabled().name;
            Lampa.Select.show({
                title: title,
                items: others.map(function (d) {
                    return { title: escape(d.name), id: d.id, name: d.name };
                }),
                onSelect: function (item) {
                    Lampa.Controller.toggle(enabled);
                    onPick(item);
                },
                onBack: function () {
                    Lampa.Controller.toggle(enabled);
                }
            });
        });
    }

    function send(target, command) {
        request('POST', 'send', { to: target.id, from: deviceName(), command: command }, 10000, function (status) {
            var name = escape(target.name);
            Lampa.Noty.show(status == 200 ? 'Sent to ' + name : status == 404 ? name + ' went offline' : 'Could not send to ' + name);
        });
    }

    function start() {
        Lampa.Listener.follow('full', function (e) {
            if (e.type != 'options' || !e.link || !e.link.card) return;
            var card = e.link.card;
            e.options.push({
                title: 'Send to device',
                onSelect: function () {
                    chooseDevice('Send to device', function (target) {
                        send(target, { action: 'open', card: { id: card.id, method: methodOf(card) } });
                    });
                }
            });
        });

        Lampa.Listener.follow('torrent_file', function (e) {
            if (e.type != 'onlong' || !e.element || !e.element.url) return;
            e.menu.push({
                title: 'Play on another device',
                onSelect: function () {
                    chooseDevice('Play on', function (target) {
                        send(target, { action: 'play', url: Lampa.Torserver.toPlayUrl(e.element.url), title: e.element.title, timeline: e.element.timeline });
                    });
                }
            });
        });

        poll();
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
