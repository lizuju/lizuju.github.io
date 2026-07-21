import { json2satrec } from 'satellite.js/dist/io.js';
import { gstime, propagate } from 'satellite.js/dist/propagation.js';
import { eciToGeodetic } from 'satellite.js/dist/transforms.js';

const EARTH_RADIUS_KM = 6371;

let satellites = [];

function toScenePosition(satrec, date) {
    const state = propagate(satrec, date);
    if (!state?.position) return null;

    const geodetic = eciToGeodetic(state.position, gstime(date));
    const altitude = Math.max(0, geodetic.height);
    const radius = 1.02 + Math.log1p(altitude / 350) * 0.15;
    const latitudeCosine = Math.cos(geodetic.latitude);

    return {
        x: radius * latitudeCosine * Math.cos(geodetic.longitude),
        y: radius * Math.sin(geodetic.latitude),
        z: -radius * latitudeCosine * Math.sin(geodetic.longitude),
        latitude: geodetic.latitude * 180 / Math.PI,
        longitude: geodetic.longitude * 180 / Math.PI,
        altitude,
        speed: state.velocity
            ? Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z)
            : 0
    };
}

function writePosition(buffer, index, position) {
    const offset = index * 3;
    if (!position) {
        buffer[offset] = Number.NaN;
        buffer[offset + 1] = Number.NaN;
        buffer[offset + 2] = Number.NaN;
        return;
    }

    buffer[offset] = position.x;
    buffer[offset + 1] = position.y;
    buffer[offset + 2] = position.z;
}

function propagateSatellites(timestamp, selectedIndex) {
    const date = new Date(timestamp);
    const nextDate = new Date(timestamp + 1000);
    const positions = new Float32Array(satellites.length * 3);
    const nextPositions = new Float32Array(satellites.length * 3);
    let selected = null;

    satellites.forEach((satrec, index) => {
        const position = toScenePosition(satrec, date);
        const nextPosition = toScenePosition(satrec, nextDate);
        writePosition(positions, index, position);
        writePosition(nextPositions, index, nextPosition);

        if (index === selectedIndex && position) {
            selected = {
                latitude: position.latitude,
                longitude: position.longitude,
                altitude: position.altitude,
                speed: position.speed
            };
        }
    });

    self.postMessage({
        type: 'positions',
        timestamp,
        positions,
        nextPositions,
        selected
    }, [positions.buffer, nextPositions.buffer]);
}

function calculateOrbit(index, timestamp) {
    const satrec = satellites[index];
    if (!satrec) return;

    const periodMinutes = Math.min(1440, Math.max(80, (Math.PI * 2) / satrec.no));
    const points = new Float32Array(181 * 3);

    for (let sample = 0; sample <= 180; sample += 1) {
        const date = new Date(timestamp + periodMinutes * 60000 * sample / 180);
        writePosition(points, sample, toScenePosition(satrec, date));
    }

    self.postMessage({ type: 'orbit', index, points }, [points.buffer]);
}

self.addEventListener('message', (event) => {
    const { type } = event.data;
    if (type === 'init') {
        satellites = event.data.records.map((record) => json2satrec(record));
        self.postMessage({ type: 'ready', count: satellites.length });
        return;
    }
    if (type === 'propagate') {
        propagateSatellites(event.data.timestamp, event.data.selectedIndex);
        return;
    }
    if (type === 'orbit') {
        calculateOrbit(event.data.index, event.data.timestamp);
    }
});
