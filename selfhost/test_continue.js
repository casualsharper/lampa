const test = require('node:test');
const assert = require('node:assert');
const c = require('../continue.js');

const HASH = 'a'.repeat(40);
const show = {
    seasons: [
        { season_number: 0, episode_count: 3 },
        { season_number: 1, episode_count: 10 },
        { season_number: 2, episode_count: 8 },
    ],
    last_episode_to_air: { season_number: 2, episode_number: 5 },
};

test('the newest progress per title wins; roads without a title link are ignored', () => {
    const latest = c.latestByTitle({
        h1: { card: 'tv_1', season: 1, episode: 2, percent: 100, updated: 100 },
        h2: { card: 'tv_1', season: 1, episode: 1, percent: 40, updated: 300 },
        h3: { card: 'movie_2', percent: 10, updated: 5 },
        h4: { percent: 50, updated: 999 },
        h5: 37,
    });
    assert.deepStrictEqual(Object.keys(latest).sort(), ['movie_2', 'tv_1']);
    assert.strictEqual(latest.tv_1.episode, 1);
});

test('an unfinished episode or movie continues itself', () => {
    assert.deepStrictEqual(c.continueTarget({ season: 2, episode: 3, percent: 89 }, show), { season: 2, episode: 3 });
    assert.deepStrictEqual(c.continueTarget({ percent: 10 }, {}), {});
    assert.deepStrictEqual(c.continueTarget({ season: 1, episode: 1, percent: 0 }, show), { season: 1, episode: 1 });
});

test('a finished episode continues with the next one, across seasons', () => {
    assert.deepStrictEqual(c.continueTarget({ season: 1, episode: 4, percent: 90 }, show), { season: 1, episode: 5 });
    assert.deepStrictEqual(c.continueTarget({ season: 1, episode: 10, percent: 100 }, show), { season: 2, episode: 1 });
});

test('nothing to continue: finished movie, no road, or the next episode has not aired', () => {
    assert.strictEqual(c.continueTarget({ percent: 95 }, {}), null);
    assert.strictEqual(c.continueTarget(null, show), null);
    assert.strictEqual(c.continueTarget({ season: 2, episode: 5, percent: 100 }, show), null);
    assert.strictEqual(c.nextEpisode({ seasons: [{ season_number: 1, episode_count: 2 }] }, 1, 2), null);
    assert.strictEqual(c.nextEpisode({}, 1, 1), null);
});

test('specials (season 0) are not part of the order', () => {
    assert.deepStrictEqual(c.nextEpisode(show, 0, 3), { season: 1, episode: 1 });
});

test('torrent episodes pack into ranges and are found again', () => {
    const pairs = [[1, 3], [1, 1], [1, 2], [2, 1], [1, 7], [2, 2], [1, 2], [0, 1], [undefined, undefined]]
        .map(([season, episode]) => ({ season, episode }));
    const packed = c.packEpisodes(pairs);
    assert.strictEqual(packed, '1:1-3,1:7,2:1-2');
    assert.ok(c.hasEpisode(packed, 1, 2));
    assert.ok(c.hasEpisode(packed, 1, 7));
    assert.ok(c.hasEpisode(packed, 2, 2));
    assert.ok(!c.hasEpisode(packed, 1, 4));
    assert.ok(!c.hasEpisode(packed, 3, 1));
    assert.ok(!c.hasEpisode('', 1, 1));
    assert.ok(!c.hasEpisode('junk,1:x', 1, 1));
    assert.strictEqual(c.packEpisodes([]), '');
});

test('magnet keeps only the hash and trackers, never a download link', () => {
    assert.strictEqual(c.magnetFor(HASH.toUpperCase(), 'http://jackett/dl?apikey=secret'), 'magnet:?xt=urn:btih:' + HASH);
    const magnet = c.magnetFor(HASH, 'magnet:?xt=urn:btih:' + HASH + '&dn=Show&tr=udp%3A%2F%2Ft1&tr=udp%3A%2F%2Ft2');
    assert.strictEqual(magnet, 'magnet:?xt=urn:btih:' + HASH + '&tr=udp%3A%2F%2Ft1&tr=udp%3A%2F%2Ft2');
    assert.ok(c.validMagnet(magnet));
    assert.strictEqual(c.magnetFor('not-a-hash', ''), null);
});

test('long tracker lists are cut to keep the synced entry small', () => {
    const trackers = Array.from({ length: 100 }, (_, i) => '&tr=udp%3A%2F%2Ftracker' + i + '.example.org%3A1337').join('');
    const magnet = c.magnetFor(HASH, 'magnet:?xt=urn:btih:' + HASH + trackers);
    assert.ok(magnet.length <= 1200);
    assert.ok(c.validMagnet(magnet));
});

test('synced magnets from elsewhere must be plain hash-and-tracker magnets', () => {
    assert.ok(!c.validMagnet('http://evil/x'));
    assert.ok(!c.validMagnet('magnet:?xt=urn:btih:' + HASH + '&xs=http://evil/x.torrent'));
    assert.ok(!c.validMagnet('magnet:?xt=urn:btih:short'));
    assert.ok(!c.validMagnet(null));
});

test('badge names the episode for series only', () => {
    assert.strictEqual(c.badgeText({ season: 5, episode: 14 }), 'S5 E14');
    assert.strictEqual(c.badgeText({ percent: 30 }), '');
});

test('Continue says why it opens the search instead of playing', () => {
    const resume = { magnet: 'magnet:?xt=urn:btih:' + HASH, episodes: '9:1-7' };
    assert.strictEqual(c.fallbackReason(resume, { season: 9, episode: 7 }), null);
    assert.strictEqual(c.fallbackReason(resume, { season: 9, episode: 8 }), "S9E8 isn't in the last torrent. Pick a release.");
    assert.strictEqual(c.fallbackReason(undefined, { season: 1, episode: 1 }), 'No saved torrent for this on this profile. Pick a release.');
    assert.strictEqual(c.fallbackReason({ magnet: 'http://x/y.torrent' }, {}), 'No saved torrent for this on this profile. Pick a release.');
    assert.strictEqual(c.fallbackReason({ magnet: 'magnet:?xt=urn:btih:' + HASH }, {}), null);
});
