const test = require('node:test');
const assert = require('node:assert');
const common = require('../common.js');

test('personal settings sync, device settings do not', () => {
    for (const name of ['playbest_lang_1', 'audiofix', 'language', 'tmdb_lang', 'menu_sort', 'menu_hide', 'content_rows_continue_watch']) {
        assert.ok(common.isProfilePref(name), name);
    }
    for (const name of ['player', 'player_torrent', 'torrserver_url', 'jackett_key', 'interface_size', 'device_name',
        'favorite', 'file_view', 'homesync_profile', 'content_rows_', 'content_rows', 'homesync_prefs']) {
        assert.ok(!common.isProfilePref(name), name);
    }
});

test('settings are stored as the text Lampa keeps in localStorage', () => {
    assert.strictEqual(common.prefText(['Home', 'Movies']), '["Home","Movies"]');
    assert.strictEqual(common.prefText(true), 'true');
    assert.strictEqual(common.prefText('ru'), 'ru');
    assert.strictEqual(common.prefText(5), '5');
});
