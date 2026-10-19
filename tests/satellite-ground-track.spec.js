const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const THREE = require('three');

test.use({ timezoneId: 'Asia/Shanghai' });

const epoch = '2026-10-19T00:00:00.000Z';
const baseRecord = {
    OBJECT_NAME: 'ISS GROUND TRACK TEST',
    OBJECT_ID: '1998-067A',
    NORAD_CAT_ID: 25544,
    EPOCH: epoch,
    MEAN_MOTION: 15.49,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
    BSTAR: 0,
    ECCENTRICITY: 0.0005,
    INCLINATION: 51.64,
    RA_OF_ASC_NODE: 100,
    ARG_OF_PERICENTER: 20,
    MEAN_ANOMALY: 340
};

test('propagates ground tracks in the rotating Earth frame', async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'worker math only needs one project');
    const satellite = await import('satellite.js');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/SatelliteTracker/worker.js'), 'utf8')
        .replace(/^import .+;\r?\n/gm, '');
    const messages = [];
    let receive;
    vm.runInNewContext(source, {
        ...satellite,
        Date,
        Float32Array,
        self: {
            addEventListener: (_, listener) => { receive = listener; },
            postMessage: (message) => messages.push(message)
        }
    });
    const records = [baseRecord, {
        ...baseRecord,
        OBJECT_NAME: 'GEO GROUND TRACK TEST',
        NORAD_CAT_ID: 40000,
        MEAN_MOTION: 1.0027,
        ECCENTRICITY: 0.00001,
        INCLINATION: 0.01
    }, {
        ...baseRecord,
        OBJECT_NAME: 'MOLNIYA GROUND TRACK TEST',
        NORAD_CAT_ID: 40001,
        MEAN_MOTION: 2.006,
        ECCENTRICITY: 0.74,
        INCLINATION: 63.4
    }, {
        ...baseRecord,
        OBJECT_NAME: 'HIGH ORBIT GROUND TRACK TEST',
        NORAD_CAT_ID: 40002,
        MEAN_MOTION: 0.5,
        ECCENTRICITY: 0.3,
        INCLINATION: 37
    }];
    const timestamp = Date.parse(epoch);
    receive({ data: { type: 'init', records } });
    receive({ data: { type: 'orbit', index: 0, timestamp } });
    receive({ data: { type: 'orbit', index: 1, timestamp } });
    receive({ data: { type: 'orbit', index: 2, timestamp } });
    receive({ data: { type: 'orbit', index: 3, timestamp } });
    receive({ data: { type: 'propagate', selectedIndex: 1, timestamp } });

    const [iss, geo, molniya, highOrbit] = messages.filter((message) => message.type === 'orbit');
    const trackerSource = fs.readFileSync(path.resolve(__dirname, '../src/SatelliteTracker/index.js'), 'utf8');
    const lineSource = trackerSource.slice(trackerSource.indexOf('function createTrackLine('),
        trackerSource.indexOf('\nfunction handleWorkerMessage('));
    const createTrackLine = vm.runInNewContext(`${lineSource}\ncreateTrackLine;`, { THREE });
    for (const track of [iss, geo, molniya, highOrbit]) {
        expect(track.timestamp).toBe(timestamp);
        expect(track.periodMinutes).toBeCloseTo(2 * Math.PI / satellite.json2satrec(records[track.index]).no, 6);
        const samples = Math.max(180, Math.ceil(track.periodMinutes / 10));
        expect(track.points).toHaveLength((samples + 1) * 3);
        expect(track.groundPoints).toHaveLength((samples + 1) * 3);
        for (let offset = 0; offset < track.groundPoints.length; offset += 3) {
            expect(Math.hypot(...track.groundPoints.subarray(offset, offset + 3))).toBeCloseTo(1.006, 6);
        }
        const line = createTrackLine(track.groundPoints, 0x35f2dc, 1, true);
        const segments = line.geometry.attributes.position.array;
        for (let offset = 0; offset < segments.length; offset += 6) {
            const start = new THREE.Vector3().fromArray(segments, offset);
            const end = new THREE.Vector3().fromArray(segments, offset + 3);
            expect(start.length()).toBeCloseTo(1.006, 6);
            expect(end.length()).toBeCloseTo(1.006, 6);
            expect(start.add(end).multiplyScalar(0.5).length()).toBeGreaterThan(1);
        }
        if (track === molniya) expect(segments.length).toBeGreaterThan(180 * 6);
        line.geometry.dispose();
        line.material.dispose();
    }
    expect(highOrbit.periodMinutes).toBeGreaterThan(1440);
    expect(highOrbit.groundPoints.length / 3 - 1).toBeGreaterThan(180);

    const satrec = satellite.json2satrec(baseRecord);
    for (const sample of [0, 45, 90, 135, 180]) {
        const date = new Date(timestamp + iss.periodMinutes * 60000 * sample / 180);
        const state = satellite.propagate(satrec, date);
        const geodetic = satellite.eciToGeodetic(state.position, satellite.gstime(date));
        const point = iss.groundPoints.subarray(sample * 3, sample * 3 + 3);
        const latitude = Math.asin(point[1] / Math.hypot(...point));
        const longitude = Math.atan2(-point[2], point[0]);
        expect(latitude).toBeCloseTo(geodetic.latitude, 6);
        expect(longitude).toBeCloseTo(geodetic.longitude, 6);
    }
    const endDistance = (track) => Math.hypot(...track.groundPoints.subarray(0, 3)
        .map((value, index) => value - track.groundPoints[540 + index]));
    expect(endDistance(iss)).toBeGreaterThan(0.2);
    const geoStart = geo.groundPoints.subarray(0, 3);
    for (let offset = 3; offset < geo.groundPoints.length; offset += 3) {
        expect(Math.hypot(...geoStart.map((value, index) => value - geo.groundPoints[offset + index])))
            .toBeLessThan(0.01);
    }
    expect(messages.at(-1)).toMatchObject({ type: 'positions', selectedIndex: 1 });
});

test('clicks satellites and keeps the selected ground track live across window and language changes', async ({ page, isMobile }) => {
    test.skip(isMobile, 'satellite windows are available in the desktop layout');
    test.setTimeout(90000);
    const records = Array.from({ length: 8 }, (_, index) => ({
        ...baseRecord,
        OBJECT_NAME: `GROUND TRACK TEST ${index + 1}`,
        NORAD_CAT_ID: 60000 + index,
        EPOCH: new Date().toISOString().slice(0, -1),
        MEAN_ANOMALY: index * 45
    }));
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://celestrak.org/**', (route) => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(records)
    }));
    await page.addInitScript(() => {
        localStorage.removeItem('portfolio-lang');
        window.__groundTrackTest = { orbits: [], requests: [], uploads: [], positions: null };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            constructor(...args) {
                super(...args);
                window.__groundTrackTest.worker = this;
                window.__groundTrackTest.workerUrl = String(args[0]);
                this.addEventListener('message', ({ data }) => {
                    if (data.type === 'orbit') window.__groundTrackTest.orbits.push(data);
                    if (data.type === 'positions') window.__groundTrackTest.positions = data;
                });
            }
            postMessage(message, ...args) {
                if (message.type === 'orbit') window.__groundTrackTest.requests.push(message);
                return super.postMessage(message, ...args);
            }
        };
        for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
            if (!Context) continue;
            const bufferData = Context.prototype.bufferData;
            Context.prototype.bufferData = function (target, data, ...args) {
                if (data instanceof Float32Array && data.length >= 6 && data.length % 6 === 0
                    && data.every((_, index) => index % 3 !== 0
                        || Math.abs(Math.hypot(...data.subarray(index, index + 3)) - 1.006) < 0.00001)) {
                    window.__groundTrackTest.uploads.push(Array.from(data));
                }
                return bufferData.call(this, target, data, ...args);
            };
        }
    });
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    await expect(page.locator('[data-satellite-count]')).toHaveText(String(records.length), { timeout: 30000 });
    await expect.poll(() => page.evaluate(() => Boolean(window.__groundTrackTest.positions))).toBe(true);
    expect(await page.evaluate(() => new URL(window.__groundTrackTest.workerUrl).pathname))
        .toMatch(/\/[0-9]+\.[a-f0-9]+\.js$/);

    const canvas = page.locator('[data-satellite-canvas]');
    const box = await canvas.boundingBox();
    const camera = new THREE.PerspectiveCamera(42, box.width / box.height, 0.1, 100);
    camera.position.set(0, 0.2, 3.45);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const snapshot = await page.evaluate(() => {
        const state = window.__groundTrackTest.positions;
        const progress = Math.min(1, Math.max(0, (Date.now() - state.timestamp) / 1000));
        return Array.from(state.positions, (value, index) => value + (state.nextPositions[index] - value) * progress);
    });
    const visible = records.map((record, index) => {
        const position = new THREE.Vector3(...snapshot.slice(index * 3, index * 3 + 3));
        const ray = new THREE.Ray(camera.position, position.clone().sub(camera.position).normalize());
        const hit = ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
        const projected = position.clone().project(camera);
        return { index, projected, visible: (!hit || hit.distanceTo(camera.position) > position.distanceTo(camera.position))
            && Math.abs(projected.x) < 0.8 && Math.abs(projected.y) < 0.8 };
    }).filter((entry) => entry.visible);
    expect(visible.length).toBeGreaterThan(0);
    const selected = visible[0];
    await canvas.click({ position: {
        x: (selected.projected.x + 1) * box.width / 2,
        y: (1 - selected.projected.y) * box.height / 2
    } });
    await expect(page.locator('[data-satellite-name]')).toHaveText(records[selected.index].OBJECT_NAME);
    await expect(page.locator('[data-satellite-epoch]')).toHaveText(
        `${new Date(`${records[selected.index].EPOCH}Z`).toISOString().slice(0, 19).replace('T', ' ')} UTC`);
    await expect(page.locator('[data-i18n="satelliteGroundTrack"]')).toHaveText('地面轨迹 · 未来一圈');
    await expect(page.locator('[data-i18n="satelliteGroundPosition"]')).toHaveText('实时星下点');
    await expect.poll(() => page.evaluate(() => window.__groundTrackTest.uploads.length)).toBeGreaterThan(0);

    const nextIndex = (selected.index + 1) % records.length;
    await page.locator('[data-satellite-search]').fill(String(records[nextIndex].NORAD_CAT_ID));
    await page.locator('[data-satellite-search-button]').click();
    await expect(page.locator('[data-satellite-name]')).toHaveText(records[nextIndex].OBJECT_NAME);
    await expect.poll(() => page.evaluate(() => window.__groundTrackTest.orbits.at(-1)?.index)).toBe(nextIndex);
    await expect.poll(() => page.evaluate(() => window.__groundTrackTest.uploads.length)).toBeGreaterThan(1);
    const uploadCount = await page.evaluate(() => {
        const capture = window.__groundTrackTest;
        const oldOrbit = capture.orbits[0];
        capture.worker.dispatchEvent(new MessageEvent('message', { data: oldOrbit }));
        return capture.uploads.length;
    });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => window.__groundTrackTest.uploads.length)).toBe(uploadCount);

    await page.evaluate(() => {
        const now = Date.now.bind(Date);
        Date.now = () => now() + 31000;
    });
    await expect.poll(() => page.evaluate(() => window.__groundTrackTest.requests
        .filter((request) => request.index === window.__groundTrackTest.orbits.at(-1)?.index).length))
        .toBeGreaterThan(1);

    const satelliteWindow = page.locator('[data-satellite-window]');
    await satelliteWindow.locator('[data-satellite-action="minimize"]').click();
    await page.locator('[data-satellite-task]').click();
    await expect(page.locator('[data-satellite-name]')).toHaveText(records[nextIndex].OBJECT_NAME);
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('[data-i18n="satelliteGroundTrack"]')).toHaveText('Ground track · next orbit');
    await expect(page.locator('[data-i18n="satelliteGroundPosition"]')).toHaveText('Live ground position');
    await satelliteWindow.locator('[data-satellite-action="close"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    await expect(page.locator('[data-satellite-name]')).toHaveText(records[nextIndex].OBJECT_NAME);
    await expect(page.locator('[data-satellite-loading]')).toBeHidden();
    expect(errors).toEqual([]);
});

test('labels expired real-data cache fallback through selection, language changes and reopening', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'cache fallback only needs one browser project');
    test.setTimeout(90000);
    const dataUrl = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
    const cachedRecords = [{
        ...baseRecord,
        OBJECT_NAME: 'CACHED GROUND TRACK TEST',
        EPOCH: '2026-10-19T04:14:45.004128'
    }];
    let requests = 0;
    await page.route('https://celestrak.org/**', (route) => {
        requests += 1;
        return route.fulfill({ status: 503, body: 'Unavailable' });
    });
    await page.addInitScript(() => localStorage.removeItem('portfolio-lang'));
    await page.goto('/portfolio/');
    await page.evaluate(async ({ dataUrl, cachedRecords }) => {
        const cache = await caches.open('gavin-satellite-data-v1');
        await cache.put(dataUrl, new Response(JSON.stringify(cachedRecords), {
            headers: { 'Content-Type': 'application/json' }
        }));
        localStorage.setItem('gavin-satellite-data-timestamp', String(Date.now() - 3 * 60 * 60 * 1000));
    }, { dataUrl, cachedRecords });
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    const status = page.locator('[data-satellite-status]');
    await expect(status).toHaveAttribute('data-i18n', 'satelliteCached');
    await expect(status).toHaveText('联网刷新失败，正在使用缓存轨道数据推算');
    await expect(page.locator('[data-satellite-count]')).toHaveText('1');
    await expect(page.locator('[data-satellite-loading]')).toBeHidden();

    await page.locator('[data-satellite-search]').fill(String(cachedRecords[0].NORAD_CAT_ID));
    await page.locator('[data-satellite-search-button]').click();
    await expect(page.locator('[data-satellite-name]')).toHaveText(cachedRecords[0].OBJECT_NAME);
    await expect(page.locator('[data-satellite-altitude]')).toHaveText(/\d+\.\d km/);
    await expect(page.locator('[data-satellite-epoch]')).toHaveText('2026-10-19 04:14:45 UTC');
    await expect(status).toHaveAttribute('data-i18n', 'satelliteCached');
    await expect(status).toHaveText('联网刷新失败，正在使用缓存轨道数据推算');
    await page.locator('[data-taskbar-lang]').click();
    await expect(status).toHaveText('Refresh failed; propagating from cached orbital data');

    const satelliteWindow = page.locator('[data-satellite-window]');
    await satelliteWindow.locator('[data-satellite-action="minimize"]').click();
    await page.locator('[data-satellite-task]').click();
    await expect(status).toHaveAttribute('data-i18n', 'satelliteCached');
    await expect(status).toHaveText('Refresh failed; propagating from cached orbital data');
    await satelliteWindow.locator('[data-satellite-action="close"]').click();
    await page.locator('.desktop-shortcut[data-open-satellite]').click();
    await expect(status).toHaveAttribute('data-i18n', 'satelliteCached');
    await expect(status).toHaveText('Refresh failed; propagating from cached orbital data');
    await expect(page.locator('[data-satellite-name]')).toHaveText(cachedRecords[0].OBJECT_NAME);
    await expect(page.locator('[data-satellite-count]')).toHaveText('1');
    expect(requests).toBe(1);
    expect(await page.evaluate(async (dataUrl) => {
        const cache = await caches.open('gavin-satellite-data-v1');
        return (await cache.match(dataUrl)).json();
    }, dataUrl)).toEqual(cachedRecords);
});
