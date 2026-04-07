import * as THREE from 'three';
import { DEG, OBLIQUITY, EARTH_RADIUS_AU, C_AU_PER_DAY } from './constants.js';
import { julianDate, gmst, heliocentricPosition, heliocentricEarthPosition, latLonToVector3 } from './astronomy.js';
import { PLANETS } from './planets.js';
import { scene, earth, earthMaterial, sunLight, atmosphereMaterial, createSunSprite } from './scene.js';
import { state } from './state.js';

const sunSprite = createSunSprite();

/* ---------------- PLANET COORD READOUTS ---------------- */

const planetCoordEls = {};
for (const planet of PLANETS) {
    const el = document.createElement('div');
    el.textContent = `${planet.name}: -`;
    document.getElementById('coords').appendChild(el);
    planetCoordEls[planet.name] = el;
}

/* ---------------- PLANET LABELS ---------------- */

function createLabel(text, color = 0xffffff) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = '40px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 5;
    ctx.strokeText(text, 8, 32);
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.fillText(text, 8, 32);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
    );
    sprite.scale.set(1, 0.125, 1);
    return sprite;
}

/* ---------------- TIME ---------------- */

export function parseDateTimeInTZ(value, tz) {
    if (!value) return null;
    const [datePart, timePart = '00:00:00'] = value.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour = 0, minute = 0, second = 0] = timePart.split(':').map(Number);
    // Parse as UTC to avoid any browser-timezone influence
    const naive = Date.UTC(year, month - 1, day, hour, minute, second);

    // Find what the selected timezone displays at UTC=naive
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(new Date(naive));
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    const tzAsUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
                             Number(p.hour), Number(p.minute), Number(p.second));
    // naive - tzAsUTC = the tz offset at that moment; subtract it to get true UTC
    return new Date(naive + (naive - tzAsUTC));
}

export function getUTCDate() {
    return parseDateTimeInTZ(dateTimeInput.value, timezoneSelect.value);
}

/* ---------------- UPDATE ---------------- */

export function updateScene() {
    const date = getUTCDate();
    if (!date) return;

    const JD = julianDate(date);
    earth.rotation.y = gmst(date);

    const earthPos = heliocentricEarthPosition(JD);

    // Ecliptic → equatorial (rotate around X by obliquity), then equatorial → scene (Y=north)
    const sunEq = earthPos.clone().negate()
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), OBLIQUITY);
    const sunDir = new THREE.Vector3(sunEq.x, sunEq.z, -sunEq.y).normalize();
    sunSprite.position.copy(sunDir).multiplyScalar(900);
    sunLight.position.copy(sunDir).multiplyScalar(100);
    atmosphereMaterial.uniforms.sunDirection.value.copy(sunDir);

    if (!state.redMarker) return;

    const latRad = state.currentLat * DEG;
    const lonRad = state.currentLon * DEG;
    const theta = gmst(date) + lonRad;
    const observerEquatorial = new THREE.Vector3(
        Math.cos(latRad) * Math.cos(theta),
        Math.cos(latRad) * Math.sin(theta),
        Math.sin(latRad)
    ).multiplyScalar(EARTH_RADIUS_AU);

    const observerWorld = earth.localToWorld(latLonToVector3(state.currentLat, state.currentLon));

    for (const planet of PLANETS) {
        // Light-travel-time corrected heliocentric position
        let pos = heliocentricPosition(planet.orbital, JD);
        for (let i = 0; i < 2; i++) {
            const lt = pos.clone().sub(earthPos).length() / C_AU_PER_DAY;
            pos = heliocentricPosition(planet.orbital, JD - lt);
        }

        // Ecliptic → equatorial → topocentric → scene frame
        let geo = pos.clone().sub(earthPos);
        geo.applyAxisAngle(new THREE.Vector3(1, 0, 0), OBLIQUITY);
        const topo = geo.clone().sub(observerEquatorial).normalize();
        const topoScene = new THREE.Vector3(topo.x, topo.z, -topo.y);

        // RA/Dec
        let ra = Math.atan2(topo.y, topo.x);
        if (ra < 0) ra += 2 * Math.PI;
        const dec = Math.asin(topo.z);
        planetCoordEls[planet.name].textContent =
            `${planet.name} RA: ${(ra * 12 / Math.PI).toFixed(2)} h, Dec: ${(dec * 180 / Math.PI).toFixed(2)}°`;

        // Dispose previous scene objects
        const prev = state.planetObjects[planet.name] ?? {};
        if (prev.line)   { scene.remove(prev.line);   prev.line.geometry.dispose(); }
        if (prev.marker) { prev.marker.geometry.dispose(); prev.marker.material.dispose(); scene.remove(prev.marker); }
        if (prev.label)  { prev.label.material.map.dispose(); prev.label.material.dispose(); scene.remove(prev.label); }

        // Create new scene objects
        const end = observerWorld.clone().add(topoScene.clone().multiplyScalar(5));
        const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([observerWorld, end]),
            new THREE.LineBasicMaterial({ color: planet.color })
        );
        const marker = new THREE.Mesh(
            new THREE.ConeGeometry(0.025, 0.2, 12),
            new THREE.MeshBasicMaterial({ color: planet.color })
        );
        marker.position.copy(observerWorld.clone().add(topoScene.clone().multiplyScalar(2.2)));
        marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), topoScene);
        const label = createLabel(planet.name, planet.color);
        label.position.copy(observerWorld.clone().add(topoScene.clone().multiplyScalar(2.2)));

        scene.add(line, marker, label);
        state.planetObjects[planet.name] = { line, marker, label };
    }
}

/* ---------------- UI ---------------- */

searchBtn.onclick = async () => {
    const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchBox.value)}`
    );
    const data = await response.json();
    if (!data.length) return;

    const lat = Number.parseFloat(data[0].lat);
    const lon = Number.parseFloat(data[0].lon);

    state.currentLat = lat;
    state.currentLon = lon;

    earthCoords.innerText = `Lat: ${lat.toFixed(4)}, Lon: ${lon.toFixed(4)}`;

    if (state.redMarker) {
        state.redMarker.traverse(obj => {
            if (obj.isMesh) { obj.geometry.dispose(); obj.material.dispose(); }
        });
        earth.remove(state.redMarker);
    }

    const pinNormal = latLonToVector3(lat, lon);
    const SPIKE_H   = 0.075;
    const HEAD_R    = 0.025;
    const pinMat    = new THREE.MeshBasicMaterial({ color: 0xff0000 });

    const spikeMesh = new THREE.Mesh(new THREE.ConeGeometry(0.015, SPIKE_H, 12), pinMat);
    spikeMesh.rotation.x = Math.PI;           // flip tip to -Y (toward Earth)
    spikeMesh.position.y = -SPIKE_H / 2;      // tip at y = -SPIKE_H, base at y = 0

    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 16, 16), pinMat);
    headMesh.position.y = 0;                  // dome center at spike base

    const pinGroup = new THREE.Group();
    pinGroup.add(spikeMesh, headMesh);
    pinGroup.position.copy(pinNormal.clone().multiplyScalar(1 + SPIKE_H));
    pinGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pinNormal);

    state.redMarker = pinGroup;
    state.onMarkerSet?.();
    state.onExternalChange?.();
    earth.add(state.redMarker);

    if (state.locationLabel) {
        state.locationLabel.material.map.dispose();
        state.locationLabel.material.dispose();
        earth.remove(state.locationLabel);
    }

    const locationName = data[0].display_name.split(',')[0];
    state.locationLabel = createLabel(locationName);
    state.locationLabel.position.copy(pinNormal.clone().multiplyScalar(1 + SPIKE_H + 0.075));
    earth.add(state.locationLabel);

    updateScene();
};

opacitySlider.addEventListener("input", e => {
    earthMaterial.opacity = Number.parseFloat(e.target.value);
});

["dateTimeInput", "timezoneSelect"].forEach(id => {
    document.getElementById(id).addEventListener("change", () => {
        state.onExternalChange?.();
        updateScene();
    });
});

Intl.supportedValuesOf("timeZone").forEach(tz => {
    const option = document.createElement("option");
    option.value = tz;
    option.textContent = tz;
    timezoneSelect.appendChild(option);
});
timezoneSelect.value = Intl.DateTimeFormat().resolvedOptions().timeZone;

function setDefaults() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    dateTimeInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
setDefaults();
updateScene();

// start at north pole
searchBox.value = "north pole";
searchBtn.onclick();
