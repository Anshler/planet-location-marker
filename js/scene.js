import * as THREE from 'three';
import { OrbitControls }   from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer }  from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/* ---------------- SCENE ---------------- */

export const scene = new THREE.Scene();

export const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 0, 4);

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.physicallyCorrectLights = true;
document.body.appendChild(renderer.domElement);

export const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    0.5, 0.5, 0.4
));

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;

scene.add(new THREE.AmbientLight(0xffffff, 0.05));

export const sunLight = new THREE.DirectionalLight(0xffffff, 3);
sunLight.position.set(1, 0, 0);
scene.add(sunLight);

/* ---------------- EARTH ---------------- */

const loader = new THREE.TextureLoader();

const dayTexture    = loader.load("https://threejs.org/examples/textures/land_ocean_ice_cloud_2048.jpg");
const nightTexture  = loader.load("https://threejs.org/examples/textures/planets/earth_night_4096.jpg");
const normalMap     = loader.load("https://threejs.org/examples/textures/planets/earth_normal_2048.jpg");

export const earthMaterial = new THREE.MeshStandardMaterial({
    map: dayTexture,
    lightMap: nightTexture,
    lightMapIntensity: 1.5,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 0.25,
    metalness: 0,
    transparent: true,
    opacity: 1
});

const earthGeometry = new THREE.SphereGeometry(1, 128, 128);
earthGeometry.setAttribute(
    'uv2',
    new THREE.BufferAttribute(earthGeometry.attributes.uv.array, 2)
);

export const earth = new THREE.Mesh(earthGeometry, earthMaterial);
scene.add(earth);

/* ---------------- ATMOSPHERE ---------------- */

const atmosphereGeometry = new THREE.SphereGeometry(1.015, 128, 128);

export const atmosphereMaterial = new THREE.ShaderMaterial({
    uniforms: {
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
        glowColor:    { value: new THREE.Color(0x4da6ff) }
    },
    vertexShader: `
        varying vec3 vNormal;
        varying vec3 vWorldPosition;

        void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
    `,
    fragmentShader: `
        uniform vec3 sunDirection;
        uniform vec3 glowColor;

        varying vec3 vNormal;
        varying vec3 vWorldPosition;

        void main() {

            // View direction
            vec3 viewDir = normalize(cameraPosition - vWorldPosition);

            // Fresnel effect (strong at limb)
            float fresnel = pow(1.0 - dot(viewDir, vNormal), 4.0);

            // Sun scattering (day side brighter)
            float sunFactor = max(dot(vNormal, sunDirection), 0.0);

            // Combine effects
            float intensity = fresnel * (0.4 + sunFactor * 0.6);

            gl_FragColor = vec4(glowColor, intensity * 0.6);
        }
    `,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false
});

const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
earth.add(atmosphere);

/* ---------------- STARFIELD ---------------- */

const starGeometry = new THREE.BufferGeometry();
const starVertices = [];

for (let i = 0; i < 15000; i++) {
    const r = 1000;
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos((Math.random() * 2) - 1);

    starVertices.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi)
    );
}

starGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(starVertices, 3)
);

const starMaterial = new THREE.PointsMaterial({
    size: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false
});

const stars = new THREE.Points(starGeometry, starMaterial);
scene.add(stars);

export function createSunSprite() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0,   'rgba(255,255,220,1)');
    grad.addColorStop(0.15,'rgba(255,220,80,0.9)');
    grad.addColorStop(1,   'rgba(255,200,50,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
        map: texture,
        color: new THREE.Color(10, 6, 3),
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(80, 80, 1);
    scene.add(sprite);
    return sprite;
}
