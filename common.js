// Helpers shared by our Lampa scripts (loaded before them as window.HomeCommon).
(function (root) {
    // Audio language order: three dropdowns in Settings → Profile. The older typed list is the fallback until one is set.
    var LANG_KEYS = ['playbest_lang_1', 'playbest_lang_2', 'playbest_lang_3'];
    var LEGACY_LANG_KEY = 'playbest_langs';
    // Per title, the torrent last played (continue.js); synced per profile by homesync.js.
    var RESUME_KEY = 'homesync_resume';
    var AUDIOFIX_KEY = 'audiofix';
    // Settings that belong to the person, synced per profile by homesync.js. Everything else stays per device:
    // player, TorrServer, parser (and its keys), screen size and performance options, theme, navigation, screensaver,
    // subtitle looks, parental control.
    var PROFILE_PREFS = LANG_KEYS.concat([
        AUDIOFIX_KEY, 'language', 'subtitles_lang',
        'tmdb_lang', 'poster_size', 'tmdb_only_released', 'source', 'start_page', 'adult_content_view', 'lgbt_content_block',
        'card_quality', 'card_episodes', 'card_interfice_poster', 'card_interfice_cover',
        'menu_sort', 'menu_hide', 'parse_lang', 'parse_in_search'
    ]);
    // Home rows shown, Settings → Channels.
    var PROFILE_PREF_PREFIXES = ['content_rows_'];

    function isProfilePref(name) {
        return PROFILE_PREFS.indexOf(name) >= 0 || PROFILE_PREF_PREFIXES.some(function (prefix) {
            return String(name).indexOf(prefix) === 0 && name.length > prefix.length;
        });
    }

    // Stored as text: lists (menu order) as JSON, everything else as Lampa writes it to localStorage.
    function prefText(value) {
        return value !== null && typeof value == 'object' ? JSON.stringify(value) : String(value);
    }
    var LANGUAGES = {
        none: '—', en: 'English', ru: 'Русский', uk: 'Українська', lv: 'Latviešu', lt: 'Lietuvių', et: 'Eesti',
        de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', pl: 'Polski', ja: '日本語', ko: '한국어', zh: '中文'
    };

    function hostOf(address) {
        return String(address || '').replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    }

    // Only streams from our own TorrServer are trusted, so a LAN device or page cannot push an arbitrary URL.
    function isTorrServerUrl(url, torrserver) {
        return Boolean(torrserver) && /^https?:\/\//i.test(url) && hostOf(url) === hostOf(torrserver);
    }

    function torrserverAddress() {
        return (root.home_config && root.home_config.torrserver) || (root.Lampa ? Lampa.Storage.get('torrserver_url', '') : '');
    }

    function parseLangList(value) {
        return (value || '').toLowerCase().split(/[\s,;]+/).filter(function (code) {
            return /^[a-z]{2}$/.test(code);
        });
    }

    // slots: the three dropdown values (null = never set); legacy: the old typed list.
    function languageOrder(slots, legacy) {
        if (slots.every(function (s) {
            return s === null || s === undefined;
        })) return parseLangList(legacy || 'en');
        var order = [];
        slots.forEach(function (code, i) {
            if (code === null || code === undefined) code = i === 0 ? 'en' : 'none';
            if (code != 'none' && LANGUAGES[code] && order.indexOf(code) < 0) order.push(code);
        });
        return order;
    }

    // The viewer's audio language order, used by Play best and the audio fix.
    function preferredLangs() {
        if (!root.Lampa) return ['en'];
        return languageOrder(LANG_KEYS.map(function (key) {
            return localStorage.getItem(key);
        }), Lampa.Storage.get(LEGACY_LANG_KEY, 'en') + '');
    }

    var common = { hostOf: hostOf, isTorrServerUrl: isTorrServerUrl, torrserverAddress: torrserverAddress,
        parseLangList: parseLangList, languageOrder: languageOrder, preferredLangs: preferredLangs,
        LANG_KEYS: LANG_KEYS, LANGUAGES: LANGUAGES, RESUME_KEY: RESUME_KEY, AUDIOFIX_KEY: AUDIOFIX_KEY,
        isProfilePref: isProfilePref, prefText: prefText };
    if (typeof module === 'object' && module.exports) module.exports = common;
    root.HomeCommon = common;
})(typeof window !== 'undefined' ? window : globalThis);
