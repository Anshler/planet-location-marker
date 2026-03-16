import * as THREE from 'three';
import { DEG, OBLIQUITY, EARTH_RADIUS_AU, C_AU_PER_DAY } from './constants.js';
import { julianDate, gmst, heliocentricPosition, latLonToVector3 } from './astronomy.js';
import { scene, earth, earthMaterial, sunLight, atmosphereMaterial, createSunSprite } from './scene.js';
import { state } from './state.js';

const sunSprite = createSunSprite();

/* ---------------- MARS LABEL ---------------- */

function createLabel(text) {
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
    ctx.fillStyle = 'white';
    ctx.fillText(text, 8, 32);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
    );
    sprite.scale.set(1, 0.125, 1);
    return sprite;
}

/* ---------------- TIME ---------------- */

function getUTCDate() {
    if (!dateInput.value || !timeInput.value) return null;
    const local = new Date(`${dateInput.value}T${timeInput.value}`);
    const tz = timezoneSelect.value;
    const offset = new Date(local.toLocaleString("en-US", { timeZone: tz }));
    const utc = new Date(local.toLocaleString("en-US", { timeZone: "UTC" }));
    return new Date(local.getTime() + (utc - offset));
}

/* ---------------- UPDATE ---------------- */

export function updateScene() {
    const date = getUTCDate();
    if (!date) return;

    const JD = julianDate(date);
    earth.rotation.y = -gmst(date);

    const earthPos = heliocentricPosition("earth", JD);

    const sunDir = earthPos.clone().negate()
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), -OBLIQUITY)
        .normalize();
    sunSprite.position.copy(sunDir).multiplyScalar(900);
    sunLight.position.copy(sunDir).multiplyScalar(100);
    atmosphereMaterial.uniforms.sunDirection.value.copy(sunDir);

    if (!state.redMarker) return;

    let marsPos = heliocentricPosition("mars", JD);

    for (let i = 0; i < 2; i++) {
        const geoTemp = marsPos.clone().sub(earthPos);
        const lt = geoTemp.length() / C_AU_PER_DAY;
        marsPos = heliocentricPosition("mars", JD - lt);
    }

    let geo = marsPos.clone().sub(earthPos);
    geo.applyAxisAngle(new THREE.Vector3(1, 0, 0), -OBLIQUITY);

    const latRad = state.currentLat * DEG;
    const lonRad = state.currentLon * DEG;

    const theta = gmst(date) + lonRad;

    const observerEquatorial = new THREE.Vector3(
        Math.cos(latRad) * Math.cos(theta),
        Math.cos(latRad) * Math.sin(theta),
        Math.sin(latRad)
    ).multiplyScalar(EARTH_RADIUS_AU);

    const topo = geo.clone().sub(observerEquatorial).normalize();

    let ra = Math.atan2(topo.y, topo.x);
    if (ra < 0) ra += 2 * Math.PI;

    const dec = Math.asin(topo.z);

    const raHours = ra * 12 / Math.PI;
    const decDeg = dec * 180 / Math.PI;

    marsCoords.innerText =
        `Mars RA: ${raHours.toFixed(2)} h, ` +
        `Dec: ${decDeg.toFixed(2)}°`;

    const observerWorld = earth.localToWorld(latLonToVector3(state.currentLat, state.currentLon));

    if (state.marsLine) {
        scene.remove(state.marsLine);
        state.marsLine.geometry.dispose();
    }

    const end = observerWorld.clone().add(topo.clone().multiplyScalar(5));

    state.marsLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([observerWorld, end]),
        new THREE.LineBasicMaterial({ color: 0xffffff })
    );
    scene.add(state.marsLine);

    if (state.blueMarker) {
        state.blueMarker.geometry.dispose();
        state.blueMarker.material.dispose();
        scene.remove(state.blueMarker);
    }

    state.blueMarker = new THREE.Mesh(
        new THREE.ConeGeometry(0.025, 0.2, 12),
        new THREE.MeshBasicMaterial({ color: 0x00aaff })
    );
    state.blueMarker.position.copy(
        observerWorld.clone().add(topo.clone().multiplyScalar(2.2))
    );
    state.blueMarker.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        topo
    );
    scene.add(state.blueMarker);

    if (state.marsLabel) {
        state.marsLabel.material.map.dispose();
        state.marsLabel.material.dispose();
        scene.remove(state.marsLabel);
    }

    state.marsLabel = createLabel('Mars');
    state.marsLabel.position.copy(
        observerWorld.clone().add(topo.clone().multiplyScalar(2.2))
    );
    scene.add(state.marsLabel);
}

/* ---------------- UI ---------------- */

searchBtn.onclick = async () => {
    const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchBox.value)}`
    );
    const data = await response.json();
    if (!data.length) return;

    const lat = parseFloat(data[0].lat);
    const lon = parseFloat(data[0].lon);

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
    earthMaterial.opacity = parseFloat(e.target.value);
});

["dateInput", "timeInput", "timezoneSelect"].forEach(id => {
    document.getElementById(id).addEventListener("change", updateScene);
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
    dateInput.value = now.toISOString().split("T")[0];
    timeInput.value = now.toTimeString().split(" ")[0];
}
setDefaults();
updateScene();

// start at north pole
searchBox.value = "north pole";
searchBtn.onclick();
