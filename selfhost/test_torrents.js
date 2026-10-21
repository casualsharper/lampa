const test = require('node:test');
const assert = require('node:assert');
const pb = require('../torrents.js');
const common = require('../common.js');

const CHROME = { hevc: false, av1: true, ac3: false, eac3: false, mkv: true };
const SAFARI = { hevc: true, av1: false, ac3: true, eac3: true, mkv: false };
const OUTSIDE = { everything: true };

const t = (Title, Seeders) => ({ Title, Seeders });

test('reads resolution, codecs and audio from a release title', () => {
    const p = pb.parseTitle('Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.HEVC-FLUX');
    assert.strictEqual(p.res, 2160);
    assert.strictEqual(p.hevc, true);
    assert.strictEqual(p.audio.eac3, true);
    assert.strictEqual(p.audio.truehd, true);
    assert.strictEqual(p.audio.ac3, false);
    assert.strictEqual(p.cam, false);
});

test('reads audio languages from a tracker language list', () => {
    assert.deepStrictEqual(pb.parseTitle('Дюна 2024 WEB-DL 1080p | Дубляж, Eng').langs, ['ru', 'en']);
    assert.deepStrictEqual(pb.parseTitle('Dune 2024 1080p BDRip x264 | 2x Ukr | Eng').langs, ['uk', 'en']);
    assert.deepStrictEqual(pb.parseTitle('Film 2024 1080p WEB-DL | Latvian, Rus').langs, ['lv', 'ru']);
    assert.deepStrictEqual(pb.parseTitle('Cyberpunk Edgerunners S02 2160p WEB-DL DV HDR MULTi ENG LAT FRE ITA JAP H265-BTM').langs, ['en', 'es', 'fr', 'it', 'ja']);
});

test('does not mistake title words or subtitles for audio languages', () => {
    assert.deepStrictEqual(pb.parseTitle('Film 2024 1080p WEB-DL | Rus | Eng Sub').langs, ['ru']);
    assert.deepStrictEqual(pb.parseTitle('It Ends With Us 2024 1080p WEB-DL | Rus').langs, ['ru']);
    assert.deepStrictEqual(pb.parseTitle('Дюна 2024 1080p WEB-DL DUB').langs, ['ru']);
});

test('unlabeled Latin-only release names count as English, DUAL as original plus English', () => {
    const scene = pb.parseTitle('It Ends With Us 2024 1080p WEB-DL');
    assert.deepStrictEqual([scene.langs, scene.langsAssumed], [['en'], true]);
    assert.deepStrictEqual(pb.parseTitle('Cyberpunk.Edgerunners.S02.1080p.NF.WEB-DL.DUAL.DDP5.1.H.264-VARYG', 'ja').langs, ['en', 'ja']);
    const labeled = pb.parseTitle('Film 2024 1080p | Ukr');
    assert.deepStrictEqual([labeled.langs, labeled.langsAssumed], [['uk'], false]);
    assert.deepStrictEqual(pb.parseTitle('Фильм 2024 1080p WEB-DL').langs, []);
});

test('the Cyberpunk case: a busy 1080p English release beats a thin 4K one', () => {
    const list = [t('Cyberpunk.Edgerunners.S02.2160p.WEB-DL.DV.HDR.MULTi.ENG.LAT.FRE.ITA.JAP.H265-BTM', 360),
        t('Cyberpunk.Edgerunners.S02.1080p.NF.WEB-DL.DUAL.DDP5.1.H.264-VARYG', 4555)];
    assert.strictEqual(pb.pickBest(list, { caps: OUTSIDE, langs: ['en'], originalLanguage: 'ja' }).element.Title, list[1].Title);
});

test('"Original" counts as the movie original language', () => {
    assert.deepStrictEqual(pb.parseTitle('Дюна 2024 1080p | Дубляж, Оригинал', 'en').langs, ['ru', 'en']);
    assert.deepStrictEqual(pb.parseTitle('Дюна 2024 1080p | Дубляж, Оригинал').langs, ['ru']);
});

test('flags CAM and telesync releases', () => {
    assert.strictEqual(pb.parseTitle('Film 2026 HDTS x264').cam, true);
    assert.strictEqual(pb.parseTitle('Film 2026 CAMRip').cam, true);
});

test('browser playability follows the device', () => {
    const hevc = pb.parseTitle('Film 2024 2160p WEB-DL HEVC AAC');
    assert.deepStrictEqual(pb.playability(hevc, CHROME), { ok: false, why: 'HEVC video' });
    assert.deepStrictEqual(pb.playability(hevc, SAFARI), { ok: false, why: 'MKV file' });
    assert.deepStrictEqual(pb.playability(pb.parseTitle('Film 2024 1080p x264 DTS'), CHROME), { ok: false, why: 'DTS audio' });
    assert.deepStrictEqual(pb.playability(pb.parseTitle('Film 2024 1080p x264 DTS AAC'), CHROME), { ok: true });
    assert.deepStrictEqual(pb.playability(pb.parseTitle('Film 2024 1080p x264 AC3'), { ...SAFARI, mkv: true }), { ok: true });
    assert.deepStrictEqual(pb.playability(pb.parseTitle('Film 2024 2160p HEVC DTS'), OUTSIDE), { ok: true });
});

test('picks a playable release over a better but unplayable one', () => {
    const best = pb.pickBest([
        t('Film 2024 2160p HEVC DTS | Eng', 500),
        t('Film 2024 1080p x264 AAC | Eng', 20),
    ], { caps: CHROME, langs: ['en'] });
    assert.strictEqual(best.element.Title, 'Film 2024 1080p x264 AAC | Eng');
    assert.strictEqual(best.playable, true);
});

test('language priority beats seeders, then seeders break ties', () => {
    const list = [t('Film 2024 1080p WEB-DL | Rus', 900), t('Film 2024 1080p WEB-DL | Eng', 15), t('Film 2024 1080p BDRip | Eng', 40)];
    assert.strictEqual(pb.pickBest(list, { caps: OUTSIDE, langs: ['en', 'ru'] }).element.Title, 'Film 2024 1080p BDRip | Eng');
    assert.strictEqual(pb.pickBest(list, { caps: OUTSIDE, langs: ['ru', 'en'] }).element.Title, 'Film 2024 1080p WEB-DL | Rus');
});

test('CAM and dead torrents lose to normal ones', () => {
    const best = pb.pickBest([t('Film 2026 CAMRip | Eng', 999), t('Film 2026 1080p WEB-DL | Eng', 0), t('Film 2026 720p WEB-DL | Eng', 5)],
        { caps: OUTSIDE, langs: ['en'] });
    assert.strictEqual(best.element.Title, 'Film 2026 720p WEB-DL | Eng');
});

test('when nothing is playable it still picks one and says why', () => {
    const best = pb.pickBest([t('Film 2024 2160p HEVC | Eng', 10)], { caps: CHROME, langs: ['en'] });
    assert.strictEqual(best.playable, false);
    assert.strictEqual(best.why, 'HEVC video');
});

test('empty list and bad language settings are handled', () => {
    assert.strictEqual(pb.pickBest([], { caps: CHROME, langs: ['en'] }), null);
    assert.deepStrictEqual(common.parseLangList(' EN, lv;ru  english x '), ['en', 'lv', 'ru']);
    assert.deepStrictEqual(common.parseLangList(''), []);
});

test('reads season and episode numbers from release titles', () => {
    assert.deepStrictEqual(pb.parseEpisodes('Cyberpunk Edgerunners S02E10 1080p WEB H264-SUGOI'), { seasons: [2], from: 10, to: 10 });
    assert.deepStrictEqual(pb.parseEpisodes('Show.S01E01-E05.1080p'), { seasons: [1], from: 1, to: 5 });
    assert.deepStrictEqual(pb.parseEpisodes('Show S03E07E08 720p'), { seasons: [3], from: 7, to: 8 });
    assert.deepStrictEqual(pb.parseEpisodes('Show 2x05 HDTV'), { seasons: [2], from: 5, to: 5 });
    assert.deepStrictEqual(pb.parseEpisodes('Show S02 1080p WEB-DL'), { seasons: [2], from: null, to: null });
    assert.deepStrictEqual(pb.parseEpisodes('Show Season 3 Complete 1080p'), { seasons: [3], from: null, to: null });
    assert.deepStrictEqual(pb.parseEpisodes('Show S01-S03 1080p'), { seasons: [1, 2, 3], from: null, to: null });
    assert.deepStrictEqual(pb.parseEpisodes('Шоу (Сезон: 2 / Серии: 1-10 из 10) WEB-DL 1080p'), { seasons: [2], from: 1, to: 10 });
    assert.deepStrictEqual(pb.parseEpisodes('Шоу / 2 сезон / WEB-DL 1080p'), { seasons: [2], from: null, to: null });
});

test('movies and resolutions are not mistaken for episodes', () => {
    assert.strictEqual(pb.parseEpisodes('Dune Part Two 2024 1080p WEB-DL x264'), null);
    assert.strictEqual(pb.parseEpisodes('Film 1920x1080 2024'), null);
    assert.strictEqual(pb.parseEpisodes('Film 2024 x265 HEVC'), null);
});

test('groups a series list into episodes and season packs, in order', () => {
    const groups = pb.groupEpisodes([t('Show S02E10 1080p'), t('Show S02E10 720p'), t('Show S02E09 1080p'), t('Show S02 complete'), t('Show S01E01')]);
    assert.deepStrictEqual(groups.map((g) => [g.season, g.episode, g.count]), [[1, 1, 1], [2, null, 1], [2, 9, 1], [2, 10, 2]]);
});

test('no picker for movies or a single episode', () => {
    assert.strictEqual(pb.groupEpisodes([t('Dune 2024 1080p'), t('Dune 2024 2160p')]), null);
    assert.strictEqual(pb.groupEpisodes([t('Show S02E10 1080p'), t('Show S02E10 720p')]), null);
});

test('an episode pick keeps that episode and packs containing it', () => {
    const pick = { season: 2, episode: 5 };
    assert.strictEqual(pb.matchesPick('Show S02E05 1080p', pick), true);
    assert.strictEqual(pb.matchesPick('Show S02 complete', pick), true);
    assert.strictEqual(pb.matchesPick('Show S02E01-E06 1080p', pick), true);
    assert.strictEqual(pb.matchesPick('Show S02E06 1080p', pick), false);
    assert.strictEqual(pb.matchesPick('Show S01E05 1080p', pick), false);
    assert.strictEqual(pb.matchesPick('Show S01-S03 1080p', pick), true);
    assert.strictEqual(pb.matchesPick('Dune 2024 1080p', pick), false);
});

test('a packs pick keeps only that season packs', () => {
    const pick = { season: 2, packs: true };
    assert.strictEqual(pb.matchesPick('Show S02 complete', pick), true);
    assert.strictEqual(pb.matchesPick('Show S02E01-E06', pick), true);
    assert.strictEqual(pb.matchesPick('Show S02E05', pick), false);
});

test('a season pick keeps everything in that season, single episodes and packs', () => {
    const pick = { season: 2 };
    assert.strictEqual(pb.matchesPick('Show S02E05', pick), true);
    assert.strictEqual(pb.matchesPick('Show S02 complete', pick), true);
    assert.strictEqual(pb.matchesPick('Show S01-S03 1080p', pick), true);
    assert.strictEqual(pb.matchesPick('Show S01E05', pick), false);
    assert.strictEqual(pb.matchesPick('Dune 2024 1080p', pick), false);
});

test('seasons group their packs and episodes; counts are torrents covering the season', () => {
    const seasons = pb.groupSeasons([t('Show S01E01'), t('Show S01E02'), t('Show S01E02 720p'), t('Show S01 complete'),
        t('Show S02E01'), t('Show S01-S02 1080p'), t('Dune 2024')]);
    assert.deepStrictEqual(seasons.map((s) => [s.season, s.count, s.groups.map((g) => pb.pickLabel(pb.groupPick(g)))]), [
        [1, 5, ['Season 1 packs', 'S1E1', 'S1E2']],
        [2, 2, ['Season 2 packs', 'S2E1']],
    ]);
    assert.strictEqual(pb.groupSeasons([t('Dune 2024 1080p')]), null);
});

test('pick labels', () => {
    assert.strictEqual(pb.pickLabel({ season: 3 }), 'Season 3');
    assert.strictEqual(pb.pickLabel({ season: 3, packs: true }), 'Season 3 packs');
    assert.strictEqual(pb.pickLabel({ season: 3, episode: 4 }), 'S3E4');
});

test('with an episode picked, Play best prefers that exact episode over a busier pack', () => {
    const list = [t('Show S02 complete 1080p x264 AAC | Eng', 400), t('Show S02E07 1080p x264 AAC | Eng', 120)];
    assert.strictEqual(pb.pickBest(list, { caps: OUTSIDE, langs: ['en'], pick: { season: 2, episode: 7 } }).element.Title, 'Show S02E07 1080p x264 AAC | Eng');
    assert.strictEqual(pb.pickBest(list, { caps: OUTSIDE, langs: ['en'] }).element.Title, 'Show S02 complete 1080p x264 AAC | Eng');
    assert.strictEqual(pb.pickBest(list, { caps: OUTSIDE, langs: ['en'], pick: { season: 2 } }).element.Title, 'Show S02 complete 1080p x264 AAC | Eng');
});

test('audio language order from the three dropdowns, with the old typed list as fallback', () => {
    assert.deepStrictEqual(common.languageOrder(['en', 'ru', 'none'], ''), ['en', 'ru']);
    assert.deepStrictEqual(common.languageOrder(['lv', 'lv', 'en'], ''), ['lv', 'en']);
    assert.deepStrictEqual(common.languageOrder(['none', 'ru', null], ''), ['ru']);
    assert.deepStrictEqual(common.languageOrder([null, 'ru', null], ''), ['en', 'ru']);
    assert.deepStrictEqual(common.languageOrder(['xx', 'de', 'none'], ''), ['de']);
    assert.deepStrictEqual(common.languageOrder([null, null, null], 'lv, ru'), ['lv', 'ru']);
    assert.deepStrictEqual(common.languageOrder([null, null, null], ''), ['en']);
});
