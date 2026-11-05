// Auto-crop: many releases carry black bars inside the frame (a 2.39:1 film in a 1920x1080 file). On a wide screen
// that shows as bars on all four sides. This finds the bars in a few frames and zooms the picture evenly until the
// real image fits the screen. Only with Lampa's "Default" size; the other sizes are the viewer's own zoom choice.
(function (root) {
    var KEY = 'autocrop';
    var SAMPLE_WIDTH = 320;
    var BLACK_LUMA = 24;
    // Share of pixels in a line allowed above BLACK_LUMA: compression noise and the odd bright speck in a bar.
    var NOISE_SHARE = 0.02;
    var MIN_BAR = 0.02;
    var MIN_ZOOM = 1.01;
    var SAMPLES_NEEDED = 5;
    var FIRST_SAMPLE_MS = 3000;
    var SAMPLE_EVERY_MS = 4000;
    var RECHECK_EVERY_MS = 30000;

    function luma(pixels, i) {
        return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }

    function isBlackLine(pixels, width, height, index, vertical) {
        var count = vertical ? height : width;
        var bright = 0;
        for (var n = 0; n < count; n++) {
            var x = vertical ? index : n;
            var y = vertical ? n : index;
            if (luma(pixels, (y * width + x) * 4) > BLACK_LUMA) bright++;
        }
        return bright <= count * NOISE_SHARE;
    }

    // Bars as shares of the frame (0..1) per side; null for a frame that is black all over (fade, scene cut).
    function findBars(pixels, width, height) {
        var row = function (y) {
            return isBlackLine(pixels, width, height, y, false);
        };
        var column = function (x) {
            return isBlackLine(pixels, width, height, x, true);
        };
        var top = 0;
        while (top < height && row(top)) top++;
        if (top == height) return null;
        var bottom = 0;
        while (row(height - 1 - bottom)) bottom++;
        var left = 0;
        while (column(left)) left++;
        var right = 0;
        while (column(width - 1 - right)) right++;
        return { top: top / height, bottom: bottom / height, left: left / width, right: right / width };
    }

    // Thinnest bar per side: a dark scene looks like a bar in one frame, not in all. So later frames only shrink the crop.
    function combine(samples) {
        var found = samples.filter(Boolean);
        if (found.length < SAMPLES_NEEDED) return null;
        var bars = {};
        ['top', 'bottom', 'left', 'right'].forEach(function (side) {
            var thinnest = Math.min.apply(null, found.map(function (s) {
                return s[side];
            }));
            bars[side] = thinnest < MIN_BAR ? 0 : thinnest;
        });
        return bars;
    }

    // For a video shown with object-fit: contain in a screenW x screenH box.
    function cropTransform(videoW, videoH, bars, screenW, screenH) {
        if (!bars || !videoW || !videoH) return null;
        var fit = Math.min(screenW / videoW, screenH / videoH);
        var pictureW = videoW * (1 - bars.left - bars.right) * fit;
        var pictureH = videoH * (1 - bars.top - bars.bottom) * fit;
        var zoom = Math.min(screenW / pictureW, screenH / pictureH);
        if (zoom < MIN_ZOOM) return null;
        return {
            zoom: zoom,
            x: -(bars.left - bars.right) / 2 * videoW * fit * zoom,
            y: -(bars.top - bars.bottom) / 2 * videoH * fit * zoom
        };
    }

    var core = { findBars: findBars, combine: combine, cropTransform: cropTransform };
    if (typeof module === 'object' && module.exports) module.exports = core;
    if (!root.document) return;

    var state = { video: null, samples: [], bars: null, lastTime: -1, timer: null, canvas: null };

    function realVideo() {
        return Lampa.PlayerVideo.render().find('video.player-video__video')[0] || null;
    }

    function enabled() {
        return Lampa.Storage.field(KEY) && Lampa.Storage.get('player_size', 'default') == 'default';
    }

    // Lampa owns the video's `transform` and rewrites it on every resize; the separate `scale` and `translate`
    // properties stack on top of it and stay ours.
    function apply() {
        var video = state.video;
        if (!video) return;
        var crop = enabled() ? cropTransform(video.videoWidth, video.videoHeight, state.bars, root.innerWidth, root.innerHeight) : null;
        video.style.scale = crop ? crop.zoom.toFixed(4) : '';
        video.style.translate = crop ? Math.round(crop.x) + 'px ' + Math.round(crop.y) + 'px' : '';
    }

    function sample() {
        var video = state.video;
        if (!video || video !== realVideo() || !video.videoWidth || video.currentTime == state.lastTime) return true;
        state.lastTime = video.currentTime;
        var canvas = state.canvas || (state.canvas = document.createElement('canvas'));
        canvas.width = SAMPLE_WIDTH;
        canvas.height = Math.max(1, Math.round(SAMPLE_WIDTH * video.videoHeight / video.videoWidth));
        var context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        var pixels;
        try {
            pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (e) {
            // A stream from another host without CORS headers cannot be read back.
            console.log('Autocrop', 'frame not readable, crop off:', e.message);
            return false;
        }
        state.samples.push(findBars(pixels, canvas.width, canvas.height));
        var bars = combine(state.samples);
        if (bars) {
            state.bars = bars;
            state.samples = [bars];
            apply();
        }
        return true;
    }

    function schedule(delay) {
        clearTimeout(state.timer);
        state.timer = setTimeout(function () {
            if (!sample()) return;
            schedule(state.bars ? RECHECK_EVERY_MS : SAMPLE_EVERY_MS);
        }, delay);
    }

    function reset() {
        clearTimeout(state.timer);
        if (state.video) {
            state.video.style.scale = '';
            state.video.style.translate = '';
        }
        state.video = null;
        state.samples = [];
        state.bars = null;
        state.lastTime = -1;
    }

    function start() {
        Lampa.SettingsApi.addParam({
            component: 'homesync',
            param: { name: KEY, type: 'trigger', default: true },
            field: { name: 'Crop black bars', description: 'Zoom past black bars that are part of the video, so a wide film fills a wide screen. Only with the player\'s Default size.' }
        });
        Lampa.PlayerVideo.listener.follow('loadeddata', function () {
            var video = realVideo();
            if (video === state.video) return;
            reset();
            if (!video || !Lampa.Storage.field(KEY)) return;
            state.video = video;
            schedule(FIRST_SAMPLE_MS);
        });
        Lampa.PlayerVideo.listener.follow('destroy', reset);
        Lampa.Listener.follow('resize_end', apply);
        Lampa.Storage.listener.follow('change', function (e) {
            if (e.name == 'player_size' || e.name == KEY) apply();
        });
    }

    var wait = setInterval(function () {
        if (!root.Lampa || !Lampa.Listener || !Lampa.PlayerVideo || !Lampa.SettingsApi) return;
        clearInterval(wait);
        if (root.appready) start();
        else Lampa.Listener.follow('app', function (e) {
            if (e.type == 'ready') start();
        });
    }, 100);
})(typeof window !== 'undefined' ? window : globalThis);
