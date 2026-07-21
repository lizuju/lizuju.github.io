import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const DATA_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json';
const CACHE_NAME = 'gavin-satellite-data-v1';
const CACHE_TIMESTAMP_KEY = 'gavin-satellite-data-timestamp';
const CACHE_TTL = 2 * 60 * 60 * 1000;
const COLORS = {
    starlink: new THREE.Color('#65d6ff'),
    oneweb: new THREE.Color('#c17cff'),
    stations: new THREE.Color('#ffffff'),
    gps: new THREE.Color('#55dc91'),
    beidou: new THREE.Color('#ffd34e'),
    glonass: new THREE.Color('#ff9949'),
    galileo: new THREE.Color('#7d8cff'),
    iridium: new THREE.Color('#ff70ad'),
    weather: new THREE.Color('#39d0c3'),
    other: new THREE.Color('#9fb5d0')
};

const windowElement = document.querySelector('[data-satellite-window]');
const viewport = document.querySelector('[data-satellite-viewport]');
const canvas = document.querySelector('[data-satellite-canvas]');
const loading = document.querySelector('[data-satellite-loading]');
const status = document.querySelector('[data-satellite-status]');
const count = document.querySelector('[data-satellite-count]');
const clock = document.querySelector('[data-satellite-clock]');
const searchInput = document.querySelector('[data-satellite-search]');
const searchButton = document.querySelector('[data-satellite-search-button]');
const emptyDetails = document.querySelector('[data-satellite-empty]');
const details = document.querySelector('[data-satellite-details]');
const nameField = document.querySelector('[data-satellite-name]');
const noradField = document.querySelector('[data-satellite-norad]');
const altitudeField = document.querySelector('[data-satellite-altitude]');
const positionField = document.querySelector('[data-satellite-position]');
const groupField = document.querySelector('[data-satellite-group]');
const speedField = document.querySelector('[data-satellite-speed]');
const periodField = document.querySelector('[data-satellite-period]');
const inclinationField = document.querySelector('[data-satellite-inclination]');
const ageField = document.querySelector('[data-satellite-age]');
const groupTag = document.querySelector('[data-satellite-group-tag]');

let renderer;
let scene;
let camera;
let controls;
let points;
let pointPositions;
let currentPositions;
let nextPositions;
let positionTimestamp = 0;
let worker;
let resizeObserver;
let frameId;
let lastFrameTime = 0;
let lastPropagationTime = 0;
let lastClockSecond = -1;
let initialized = false;
let dataLoaded = false;
let loadingPromise;
let records = [];
let selectedIndex = -1;
let selectedState;
let orbitLine;
let orbitVisible = true;
let selectedMarker;

function copy() {
    const language = document.documentElement.lang === 'en' ? 'en' : 'zh-CN';
    return window.PORTFOLIO_DATA.CONTENT[language];
}

function classifySatellite(record) {
    const name = String(record.OBJECT_NAME || '').toUpperCase();
    if (name.includes('STARLINK')) return 'starlink';
    if (/\bONEWEB\b/.test(name)) return 'oneweb';
    if (/\b(ISS|TIANGONG|CSS)\b|SPACE STATION/.test(name)) return 'stations';
    if (/\b(GPS|NAVSTAR)\b/.test(name)) return 'gps';
    if (/\b(BEIDOU|BEI DOU|BDS)\b/.test(name)) return 'beidou';
    if (/\bGLONASS\b/.test(name)) return 'glonass';
    if (/\bGALILEO\b/.test(name)) return 'galileo';
    if (/\bIRIDIUM\b/.test(name)) return 'iridium';
    if (/\b(NOAA|GOES|METOP|METEOR|HIMAWARI|FENGYUN|FENG YUN|FY-\d|ELEKTRO|SUOMI NPP|JPSS)\b/.test(name)) {
        return 'weather';
    }
    return 'other';
}

function formatCoordinate(value, positive, negative) {
    return `${Math.abs(value).toFixed(2)}° ${value >= 0 ? positive : negative}`;
}

function formatPeriod(record) {
    const meanMotion = Number(record.MEAN_MOTION);
    return meanMotion > 0 ? `${(1440 / meanMotion).toFixed(1)} min` : '-';
}

function formatInclination(record) {
    const inclination = Number(record.INCLINATION);
    return Number.isFinite(inclination) ? `${inclination.toFixed(2)}°` : '-';
}

function formatElementAge(record) {
    const epoch = Date.parse(record.EPOCH);
    if (!Number.isFinite(epoch)) return '-';
    const age = Math.max(0, (Date.now() - epoch) / 86400000);
    return `${age.toFixed(1)} ${copy().satelliteAgeUnit}`;
}

function isActive() {
    return initialized
        && !document.hidden
        && !windowElement.classList.contains('is-minimized')
        && !windowElement.classList.contains('is-closed');
}

function setStatus(key) {
    status.textContent = copy()[key];
}

function setLoading(visible, key = 'satelliteLoading') {
    loading.hidden = !visible;
    const label = loading.querySelector('strong');
    label.textContent = copy()[key];
}

function createStars() {
    const starPositions = new Float32Array(900 * 3);
    let seed = 4127;
    for (let index = 0; index < starPositions.length; index += 3) {
        seed = (seed * 16807) % 2147483647;
        const longitude = seed / 2147483647 * Math.PI * 2;
        seed = (seed * 16807) % 2147483647;
        const latitude = Math.acos(2 * (seed / 2147483647) - 1);
        seed = (seed * 16807) % 2147483647;
        const radius = 4.5 + seed / 2147483647 * 3;
        starPositions[index] = radius * Math.sin(latitude) * Math.cos(longitude);
        starPositions[index + 1] = radius * Math.cos(latitude);
        starPositions[index + 2] = radius * Math.sin(latitude) * Math.sin(longitude);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({
        color: 0x8ba9c7,
        size: 0.012,
        sizeAttenuation: true
    }));
}

function initializeScene() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setClearColor(0x020713, 1);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0.2, 3.45);

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;
    controls.minDistance = 1.65;
    controls.maxDistance = 7;

    scene.add(new THREE.AmbientLight(0x7387a8, 0.65));
    const sunlight = new THREE.DirectionalLight(0xffffff, 1.25);
    sunlight.position.set(3, 2, 4);
    scene.add(sunlight, createStars());

    const earthMaterial = new THREE.MeshPhongMaterial({
        color: 0x6e8eaa,
        shininess: 5,
        specular: 0x1b2d42
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 48), earthMaterial);
    scene.add(earth);

    new THREE.TextureLoader().load(
        'assets/satellite-tracker/earth-blue-marble.jpg',
        (texture) => {
            texture.encoding = THREE.sRGBEncoding;
            earthMaterial.map = texture;
            earthMaterial.needsUpdate = true;
            renderNow();
        }
    );

    const atmosphere = new THREE.Mesh(
        new THREE.SphereGeometry(1.018, 72, 48),
        new THREE.MeshBasicMaterial({
            color: 0x67b7ff,
            transparent: true,
            opacity: 0.09,
            side: THREE.BackSide
        })
    );
    atmosphere.scale.setScalar(1.06);
    scene.add(atmosphere);

    selectedMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    selectedMarker.visible = false;
    scene.add(selectedMarker);

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);
    resize();
    renderNow();
}

function resize() {
    if (!renderer) return;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderNow();
}

function renderNow() {
    if (!renderer) return;
    controls?.update();
    renderer.render(scene, camera);
    canvas.dataset.rendered = 'true';
}

function updateClock(timestamp) {
    const second = Math.floor(timestamp / 1000);
    if (second === lastClockSecond) return;
    lastClockSecond = second;
    clock.textContent = `UTC ${new Date(timestamp).toISOString().slice(11, 19)}`;
}

function interpolatePositions(timestamp) {
    if (!pointPositions || !currentPositions || !nextPositions) return;
    const progress = Math.min(1, Math.max(0, (timestamp - positionTimestamp) / 1000));

    for (let index = 0; index < pointPositions.length; index += 1) {
        pointPositions[index] = currentPositions[index]
            + (nextPositions[index] - currentPositions[index]) * progress;
    }
    points.geometry.attributes.position.needsUpdate = true;

    if (selectedIndex >= 0) {
        const offset = selectedIndex * 3;
        selectedMarker.position.set(
            pointPositions[offset],
            pointPositions[offset + 1],
            pointPositions[offset + 2]
        );
        selectedMarker.visible = Number.isFinite(pointPositions[offset]);
    }
}

function animate(timestamp) {
    frameId = 0;
    if (!isActive()) return;

    updateClock(Date.now());
    if (timestamp - lastPropagationTime >= 1000 && dataLoaded) {
        lastPropagationTime = timestamp;
        worker.postMessage({
            type: 'propagate',
            timestamp: Date.now(),
            selectedIndex
        });
    }

    if (timestamp - lastFrameTime >= 1000 / 30) {
        lastFrameTime = timestamp;
        interpolatePositions(Date.now());
        controls.update();
        renderer.render(scene, camera);
        canvas.dataset.rendered = 'true';
    }
    frameId = window.requestAnimationFrame(animate);
}

function syncAnimation() {
    if (isActive() && !frameId) {
        lastFrameTime = 0;
        lastPropagationTime = 0;
        frameId = window.requestAnimationFrame(animate);
        return;
    }
    if (!isActive() && frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
    }
}

async function readCachedData() {
    if (!('caches' in window)) return null;
    try {
        const cache = await caches.open(CACHE_NAME);
        const response = await cache.match(DATA_URL);
        if (!response) return null;
        return {
            records: await response.json(),
            timestamp: Number(localStorage.getItem(CACHE_TIMESTAMP_KEY)) || 0
        };
    } catch {
        return null;
    }
}

async function cacheData(nextRecords) {
    if (!('caches' in window)) return;
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(DATA_URL, new Response(JSON.stringify(nextRecords), {
            headers: { 'Content-Type': 'application/json' }
        }));
        localStorage.setItem(CACHE_TIMESTAMP_KEY, String(Date.now()));
    } catch {
        // The live visualization can continue without persistent browser cache.
    }
}

async function fetchRecords() {
    const cached = await readCachedData();
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.records;

    try {
        const response = await fetch(DATA_URL, {
            cache: 'no-store',
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`CelesTrak responded with ${response.status}`);
        const nextRecords = await response.json();
        if (!Array.isArray(nextRecords) || !nextRecords.length) throw new Error('CelesTrak returned no records');
        await cacheData(nextRecords);
        return nextRecords;
    } catch (error) {
        if (cached?.records?.length) return cached.records;
        throw error;
    }
}

function initializePoints() {
    pointPositions = new Float32Array(records.length * 3);
    const colorValues = new Float32Array(records.length * 3);
    const categoryCounts = Object.fromEntries(Object.keys(COLORS).map((category) => [category, 0]));

    records.forEach((record, index) => {
        record.category = classifySatellite(record);
        categoryCounts[record.category] += 1;
        const color = COLORS[record.category];
        colorValues.set([color.r, color.g, color.b], index * 3);
    });

    points?.geometry.dispose();
    points?.material.dispose();
    if (points) scene.remove(points);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colorValues, 3));
    points = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 0.022,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.92
    }));
    scene.add(points);

    Object.entries(categoryCounts).forEach(([category, value]) => {
        document.querySelector(`[data-satellite-group-count="${category}"]`).textContent = value.toLocaleString();
    });
    count.textContent = records.length.toLocaleString();
}

function updateSelectedDetails() {
    if (selectedIndex < 0 || !records[selectedIndex]) {
        details.hidden = true;
        emptyDetails.hidden = false;
        selectedMarker.visible = false;
        return;
    }

    const record = records[selectedIndex];
    details.hidden = false;
    emptyDetails.hidden = true;
    nameField.textContent = record.OBJECT_NAME || '-';
    noradField.textContent = String(record.NORAD_CAT_ID || '-');
    groupField.textContent = copy()[`satellite${record.category[0].toUpperCase()}${record.category.slice(1)}`];
    groupTag.dataset.category = record.category;
    altitudeField.textContent = selectedState ? `${selectedState.altitude.toFixed(1)} km` : '-';
    speedField.textContent = selectedState ? `${selectedState.speed.toFixed(2)} km/s` : '-';
    positionField.textContent = selectedState
        ? `${formatCoordinate(selectedState.latitude, 'N', 'S')} / ${formatCoordinate(selectedState.longitude, 'E', 'W')}`
        : '-';
    periodField.textContent = formatPeriod(record);
    inclinationField.textContent = formatInclination(record);
    ageField.textContent = formatElementAge(record);
}

function selectSatellite(index) {
    if (!records[index]) return;
    selectedIndex = index;
    selectedState = null;
    updateSelectedDetails();
    worker.postMessage({ type: 'orbit', index, timestamp: Date.now() });
    worker.postMessage({ type: 'propagate', timestamp: Date.now(), selectedIndex });
}

function runSearch() {
    const query = searchInput.value.trim().toUpperCase();
    if (!query) return;
    const index = records.findIndex((record) => (
        String(record.OBJECT_NAME || '').toUpperCase().includes(query)
        || String(record.NORAD_CAT_ID || '') === query
    ));
    if (index < 0) {
        setStatus('satelliteSearchEmpty');
        return;
    }
    selectSatellite(index);
    setStatus('satelliteReady');
}

function handleCanvasClick(event) {
    if (!points) return;
    const rect = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
        (event.clientX - rect.left) / rect.width * 2 - 1,
        -(event.clientY - rect.top) / rect.height * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.035;
    raycaster.setFromCamera(mouse, camera);
    const hit = raycaster.intersectObject(points, false)[0];
    if (hit) selectSatellite(hit.index);
}

function handleWorkerMessage(event) {
    if (event.data.type === 'ready') {
        dataLoaded = true;
        setLoading(false);
        setStatus('satelliteReady');
        worker.postMessage({ type: 'propagate', timestamp: Date.now(), selectedIndex });
        syncAnimation();
        return;
    }
    if (event.data.type === 'positions') {
        currentPositions = event.data.positions;
        nextPositions = event.data.nextPositions;
        positionTimestamp = event.data.timestamp;
        selectedState = event.data.selected;
        updateSelectedDetails();
        interpolatePositions(Date.now());
        renderNow();
        return;
    }
    if (event.data.type === 'orbit') {
        orbitLine?.geometry.dispose();
        orbitLine?.material.dispose();
        if (orbitLine) scene.remove(orbitLine);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(event.data.points, 3));
        orbitLine = new THREE.Line(geometry, new THREE.LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.62
        }));
        orbitLine.visible = orbitVisible;
        scene.add(orbitLine);
        renderNow();
    }
}

async function loadData() {
    if (loadingPromise) return loadingPromise;
    setLoading(true);
    setStatus('satelliteLoading');

    loadingPromise = fetchRecords()
        .then((nextRecords) => {
            records = nextRecords;
            selectedIndex = -1;
            selectedState = null;
            initializePoints();
            updateSelectedDetails();
            worker.postMessage({ type: 'init', records });
        })
        .catch(() => {
            setLoading(true, 'satelliteLoadError');
            setStatus('satelliteLoadError');
            loadingPromise = null;
        });
    return loadingPromise;
}

function initialize() {
    if (initialized) return;
    initialized = true;
    initializeScene();
    worker = new Worker(new URL('./worker.js', import.meta.url));
    worker.addEventListener('message', handleWorkerMessage);
    new MutationObserver(syncAnimation).observe(windowElement, {
        attributes: true,
        attributeFilter: ['class']
    });
    document.addEventListener('visibilitychange', syncAnimation);
    canvas.addEventListener('click', handleCanvasClick);
    searchButton.addEventListener('click', runSearch);
    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') runSearch();
    });
}

function open() {
    initialize();
    loadData();
    syncAnimation();
    window.requestAnimationFrame(resize);
}

function refresh() {
    loadingPromise = null;
    dataLoaded = false;
    loadData();
}

function resetView() {
    if (!camera || !controls) return;
    camera.position.set(0, 0.2, 3.45);
    controls.target.set(0, 0, 0);
    controls.update();
    renderNow();
}

function toggleOrbit() {
    orbitVisible = !orbitVisible;
    if (orbitLine) orbitLine.visible = orbitVisible;
    renderNow();
}

function about() {
    setStatus('satelliteAboutStatus');
}

window.addEventListener('portfolio-language-change', () => {
    updateSelectedDetails();
    if (dataLoaded) setStatus('satelliteReady');
});

window.SatelliteTracker = {
    about,
    open,
    refresh,
    renderNow,
    resetView,
    toggleOrbit
};
