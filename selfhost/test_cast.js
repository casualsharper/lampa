const test = require('node:test');
const assert = require('node:assert');
const cast = require('../cast.js');
const common = require('../common.js');

test('only streams from our own TorrServer are accepted', () => {
    assert.strictEqual(common.isTorrServerUrl('http://192.168.1.10:8090/stream/a.mkv?play', '192.168.1.10:8090'), true);
    assert.strictEqual(common.isTorrServerUrl('http://192.168.1.10:8090/stream/a.mkv', 'http://192.168.1.10:8090'), true);
    assert.strictEqual(common.isTorrServerUrl('http://evil.example/a.mkv', '192.168.1.10:8090'), false);
    assert.strictEqual(common.isTorrServerUrl('http://192.168.1.10:9999/a.mkv', '192.168.1.10:8090'), false);
    assert.strictEqual(common.isTorrServerUrl('javascript:alert(1)//192.168.1.10:8090', '192.168.1.10:8090'), false);
    assert.strictEqual(common.isTorrServerUrl('http://192.168.1.10:8090/a', ''), false);
});

test('cards are sent as movie or tv', () => {
    assert.strictEqual(cast.methodOf({ title: 'Movie', original_title: 'Movie' }), 'movie');
    assert.strictEqual(cast.methodOf({ name: 'Show', original_name: 'Show' }), 'tv');
    assert.strictEqual(cast.methodOf({ number_of_seasons: 3 }), 'tv');
});

test('a default device name comes from the browser', () => {
    assert.strictEqual(cast.defaultName('Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit'), 'TV');
    assert.strictEqual(cast.defaultName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone');
    assert.strictEqual(cast.defaultName('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'Android');
    assert.strictEqual(cast.defaultName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'Mac');
    assert.strictEqual(cast.defaultName(''), 'Device');
});
