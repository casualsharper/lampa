const test = require('node:test');
const assert = require('node:assert');
const crop = require('../autocrop.js');

// A grey picture inside black bars, `bars` in pixels per side.
function frame(width, height, bars, picture = 120) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const inside = y >= bars.top && y < height - bars.bottom && x >= bars.left && x < width - bars.right;
            const i = (y * width + x) * 4;
            pixels[i] = pixels[i + 1] = pixels[i + 2] = inside ? picture : 0;
            pixels[i + 3] = 255;
        }
    }
    return pixels;
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const sides = (top, bottom, left, right) => ({ top, bottom, left, right });

test('finds each bar on its own side', () => {
    const bars = crop.findBars(frame(100, 50, sides(6, 4, 3, 1)), 100, 50);
    assert.deepStrictEqual(bars, { top: 6 / 50, bottom: 4 / 50, left: 3 / 100, right: 1 / 100 });
});

test('a frame that is black all over is no sample', () => {
    assert.strictEqual(crop.findBars(frame(40, 20, sides(0, 0, 0, 0), 0), 40, 20), null);
});

test('a few bright specks still leave a bar black, a lit line is picture', () => {
    const width = 100;
    const pixels = frame(width, 50, sides(6, 0, 0, 0));
    const light = (y, count) => {
        for (let x = 0; x < count; x++) pixels[(y * width + x) * 4] = pixels[(y * width + x) * 4 + 1] = pixels[(y * width + x) * 4 + 2] = 255;
    };
    light(0, 2);
    assert.strictEqual(crop.findBars(pixels, width, 50).top, 6 / 50);
    light(2, 3);
    assert.strictEqual(crop.findBars(pixels, width, 50).top, 2 / 50);
});

test('needs five frames and keeps the thinnest bar per side', () => {
    const film = sides(0.13, 0.13, 0, 0);
    const darkTop = sides(0.30, 0.13, 0, 0);
    const darkBottom = sides(0.13, 0.25, 0, 0);
    assert.strictEqual(crop.combine([film, film, null, darkTop, darkBottom]), null);
    assert.deepStrictEqual(crop.combine([darkTop, film, null, darkBottom, darkTop, darkBottom]), sides(0.13, 0.13, 0, 0));
});

test('bars under 2% are ignored', () => {
    const thin = sides(0.019, 0.13, 0.02, 0);
    assert.deepStrictEqual(crop.combine([thin, thin, thin, thin, thin]), sides(0, 0.13, 0.02, 0));
});

test('a 2.39:1 film in a 16:9 file fills the width of a 21:9 screen', () => {
    const bars = sides(140 / 1080, 140 / 1080, 0, 0);
    const t = crop.cropTransform(1920, 1080, bars, 1720, 720);
    const fit = 720 / 1080;
    near(1920 * fit * t.zoom, 1720);
    assert.ok(800 * fit * t.zoom <= 720);
    near(t.x, 0);
    near(t.y, 0);
});

test('zoom stops at the screen height when the picture is narrower than the screen', () => {
    const bars = sides(0.1, 0.1, 0.125, 0.125);
    const t = crop.cropTransform(1920, 1080, bars, 3440, 1440);
    const fit = 1440 / 1080;
    near(1080 * 0.8 * fit * t.zoom, 1440);
    assert.ok(1920 * 0.75 * fit * t.zoom <= 3440);
});

test('an off-centre picture is moved back to the middle', () => {
    const t = crop.cropTransform(1920, 1080, sides(0.2, 0.1, 0.04, 0.02), 1720, 720);
    const fit = 720 / 1080;
    near(t.y, -0.05 * 1080 * fit * t.zoom);
    near(t.x, -0.01 * 1920 * fit * t.zoom);
});

test('no zoom when the picture already fills the screen or nothing was found', () => {
    assert.strictEqual(crop.cropTransform(1920, 1080, sides(140 / 1080, 140 / 1080, 0, 0), 1920, 1080), null);
    assert.strictEqual(crop.cropTransform(1920, 1080, null, 1720, 720), null);
    assert.strictEqual(crop.cropTransform(0, 0, sides(0.1, 0.1, 0, 0), 1720, 720), null);
});
