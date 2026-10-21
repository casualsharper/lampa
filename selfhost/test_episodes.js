const test = require('node:test');
const assert = require('node:assert');
const { recentEpisodes, escapeHtml } = require('../episodes.js');

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-21T12:00:00Z');
const parse = (date) => Date.parse(date + 'T00:00:00Z');
const show = { id: 1399, name: 'Show', original_name: 'Show', poster_path: '/p.jpg' };

test('alerts for episodes aired in the last 14 days of favorite series', () => {
    const schedule = [{ id: 1399, episodes: [
        { season_number: 2, episode_number: 5, air_date: '2026-10-20', name: 'Five' },
        { season_number: 2, episode_number: 4, air_date: '2026-10-01' },
        { season_number: 2, episode_number: 6, air_date: '2026-10-28' },
    ] }];
    const notices = recentEpisodes(schedule, [show], NOW, parse);
    assert.strictEqual(notices.length, 1);
    assert.strictEqual(notices[0].id, 'eps:1399:2026-10-20');
    assert.strictEqual(notices[0].text, 'New episode S2E5 · Five');
    assert.strictEqual(notices[0].method, 'tv');
    assert.strictEqual(notices[0].time, NOW);
});

test('ignores series not in favorites, movies and episodes without a date', () => {
    const schedule = [
        { id: 1, episodes: [{ season_number: 1, episode_number: 1, air_date: '2026-10-20' }] },
        { id: 1399, episodes: [{ season_number: 1, episode_number: 1 }] },
        { id: 550, episodes: [{ season_number: 1, episode_number: 1, air_date: '2026-10-20' }] },
    ];
    const movie = { id: 550, title: 'Movie' };
    assert.deepStrictEqual(recentEpisodes(schedule, [show, movie], NOW, parse), []);
});

test('the window edge: 14 days back is in, older is out', () => {
    const schedule = [{ id: 1399, episodes: [
        { season_number: 1, episode_number: 1, air_date: new Date(NOW - 14 * DAY).toISOString().slice(0, 10) },
        { season_number: 1, episode_number: 2, air_date: new Date(NOW - 15 * DAY).toISOString().slice(0, 10) },
    ] }];
    assert.deepStrictEqual(recentEpisodes(schedule, [show], NOW, parse).map((n) => n.text), ['New episode S1E1']);
});

test('show and episode names are escaped (the bell renders HTML)', () => {
    const schedule = [{ id: 7, episodes: [{ season_number: 1, episode_number: 1, air_date: '2026-10-20', name: '<img src=x onerror=alert(1)>' }] }];
    const notices = recentEpisodes(schedule, [{ id: 7, original_name: 'A & <b>B</b>' }], NOW, parse);
    assert.strictEqual(notices[0].title, 'A &amp; &lt;b&gt;B&lt;/b&gt;');
    assert.ok(!notices[0].text.includes('<'));
    assert.strictEqual(escapeHtml('"x"'), '&quot;x&quot;');
});

test('a season released at once is one alert per series and day', () => {
    const episodes = [];
    for (let e = 10; e >= 1; e--) episodes.push({ season_number: 2, episode_number: e, air_date: '2026-10-20' });
    episodes.push({ season_number: 1, episode_number: 9, air_date: '2026-10-12', name: 'Old one' });
    const notices = recentEpisodes([{ id: 1399, episodes }], [show], NOW, parse);
    assert.deepStrictEqual(notices.map((n) => [n.id, n.text]), [
        ['eps:1399:2026-10-12', 'New episode S1E9 · Old one'],
        ['eps:1399:2026-10-20', '10 new episodes · S2E1–E10'],
    ]);
});

test('non-consecutive episodes on one day are listed, long lists shortened', () => {
    const day = (list) => list.map(([s, e]) => ({ season_number: s, episode_number: e, air_date: '2026-10-20' }));
    const text = (list) => recentEpisodes([{ id: 1399, episodes: day(list) }], [show], NOW, parse)[0].text;
    assert.strictEqual(text([[2, 1], [2, 3]]), '2 new episodes · S2E1, S2E3');
    assert.strictEqual(text([[1, 10], [2, 1]]), '2 new episodes · S1E10, S2E1');
    assert.strictEqual(text([[2, 1], [2, 3], [2, 5], [2, 7], [2, 9]]), '5 new episodes · S2E1, S2E3, S2E5, S2E7…');
});
