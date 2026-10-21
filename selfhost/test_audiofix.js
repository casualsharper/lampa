const test = require('node:test');
const assert = require('node:assert');
const af = require('../audiofix.js');

const CHROME = { ac3: false, eac3: false, opus: true, flac: true };
const EDGE = { ac3: true, eac3: true, opus: true, flac: true };
const track = (index, codec, language, isDefault) => ({ index, codec, language, default: isDefault });
const probe = (audio, extra) => Object.assign({ duration: 5400, video: 'h264', container: 'matroska,webm', audio }, extra);

test('plays the original when the default track is playable and wanted', () => {
    assert.strictEqual(af.plan(probe([track(1, 'aac', 'eng', true)]), CHROME, ['en']), null);
    assert.strictEqual(af.plan(probe([track(1, 'ac3', 'eng', true)]), EDGE, ['en']), null);
});

test('converts an unplayable default track to AAC', () => {
    const p = af.plan(probe([track(1, 'dts', 'eng', true)]), CHROME, ['en']);
    assert.deepStrictEqual([p.audio, p.mode, p.duration], [1, 'aac', 5400]);
    assert.strictEqual(af.plan(probe([track(1, 'ac3', 'eng', true)]), CHROME, ['en']).mode, 'aac');
});

test('switches to the preferred language even when the default plays fine', () => {
    const p = af.plan(probe([track(1, 'aac', 'rus', true), track(2, 'aac', 'eng', false)]), CHROME, ['en', 'ru']);
    assert.deepStrictEqual([p.audio, p.mode], [2, 'copy']);
});

test('language order decides; unknown languages fall back to the default track', () => {
    const tracks = [track(1, 'ac3', 'rus', true), track(2, 'dts', 'eng', false), track(3, 'aac', 'lav', false)];
    assert.strictEqual(af.plan(probe(tracks), CHROME, ['lv', 'en']).audio, 3);
    assert.strictEqual(af.plan(probe(tracks), CHROME, ['en', 'lv']).audio, 2);
    assert.strictEqual(af.plan(probe(tracks), CHROME, ['de']).audio, 1);
    assert.strictEqual(af.plan(probe([track(1, 'ac3', 'und', true)]), CHROME, ['en']).audio, 1);
});

test('copy only for codecs a browser can take inside MP4', () => {
    assert.strictEqual(af.plan(probe([track(1, 'aac', 'rus', true), track(2, 'ac3', 'eng', false)]), EDGE, ['en']).mode, 'copy');
    assert.strictEqual(af.plan(probe([track(1, 'aac', 'rus', true), track(2, 'truehd', 'eng', false)]), EDGE, ['en']).mode, 'aac');
});

test('no audio or failed probe means play the original', () => {
    assert.strictEqual(af.plan(null, CHROME, ['en']), null);
    assert.strictEqual(af.plan(probe([]), CHROME, ['en']), null);
});

test('stream URL carries source, track, mode, video codec and duration', () => {
    const p = { audio: 2, mode: 'aac', video: 'hevc', duration: 5400.5, track: track(2, 'dts', 'eng', false) };
    const url = af.streamUrl('http://lampa.lan', 'http://ts:8090/stream/a b.mkv?link=x&index=1&play', p);
    assert.strictEqual(url, 'http://lampa.lan/audiofix/stream?src=http%3A%2F%2Fts%3A8090%2Fstream%2Fa%20b.mkv%3Flink%3Dx%26index%3D1%26play&a=2&c=aac&v=hevc&d=5400.50');
    assert.strictEqual(af.describe(p), 'EN DTS → AAC');
});

test('the source stream is read back from a conversion URL, also after a seek', () => {
    const src = 'http://ts:8090/stream/a b.mkv?link=x&index=1&play';
    const url = af.streamUrl('http://lampa.lan', src, { audio: 1, mode: 'aac', video: 'h264', duration: 60 });
    assert.strictEqual(af.sourceOf(url), src);
    assert.strictEqual(af.sourceOf(url + '&t=30.00'), src);
    assert.strictEqual(af.sourceOf('http://lampa.lan/x'), '');
});
