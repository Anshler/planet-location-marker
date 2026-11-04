// Shared type contract for Planet Location Marker v2 (SPEC §C.1).
//
// JSDoc only: this module has no runtime code. Reference the types from other modules with
// `/** @typedef {import('../core/types.js').AppState} AppState */` or inline
// `@param {import('../core/types.js').Observer} obs`.
//
// The first block is the SPEC §C.1 contract verbatim. The second block adds shapes that the G2
// modules (store, bus, clock, url-state, quality, tz, cities, geocode) return, so callers can type
// against them too.

// ───────────────────────────── SPEC §C.1 (verbatim) ─────────────────────────────

/** @typedef {'sun'|'moon'|'mercury'|'venus'|'mars'|'jupiter'|'saturn'|'uranus'|'neptune'} BodyId */
/** @typedef {{latDeg:number, lonDeg:number, elevM:number, name:string, country:string, tz:string|null, tzApprox:boolean,
 *   source:'default'|'url'|'saved'|'tzguess'|'click'|'city'|'search'|'geo'|'manual'}} Observer */
/** @typedef {{beams:boolean, ghostBeams:boolean, sunMoonBeams:boolean, stars:boolean, constellations:boolean,
 *   constellationNames:boolean, starNames:boolean, milkyWay:boolean, clouds:boolean, atmosphere:boolean, ecliptic:boolean,
 *   eqGrid:boolean, altAzGrid:boolean, horizon:boolean, footprint:boolean, subpoints:boolean, trails:boolean, labels:boolean,
 *   landscape:boolean, spacecraft:boolean, deepSky:boolean, precession:boolean}} Layers `landscape`: the sky view's illustrative landscape (geo/horizon.js);
 *   `spacecraft`: the radio beams to Voyager 1 and 2, New Horizons and JWST (astro/craft.js), off by default;
 *   `deepSky`: the Messier objects and showpieces (astro/dso.js, render/dso.js), on by default; `precession`: the
 *   pole's precession circle, the pole of date and the equinox points (render/precession.js), off by default */
/** A selection (core/selection.js): one of the nine BodyIds, or an extra object's namespaced id
 * `<kind>:<key>` with kind star | dso | comet | craft | guest (e.g. 'comet:halley', 'craft:voyager1'),
 * resolved by the extras registry (astro/extras.js). BODY_IDS stays the contract for the nine.
 * @typedef {BodyId|string} SelectionId */
/** The solar eclipse in focus: set by actions.jumpToEvent for a solar eclipse event, cleared by any
 * other jump and once simulated time is more than a day from `peakMs` (main.js, eclipseFocusExpired).
 * `peakMs` is the event's instant (global greatest eclipse, or the local maximum when `local`);
 * either works for eclipsePath / actions.eclipsePath. `kind` is the event's eclipseKind.
 * @typedef {{peakMs:number, kind:'total'|'annular'|'partial'|null, local:boolean, eventId:string|null}} EclipseFocus */
/** The guided tour on screen (js/app/tours.js): its lower-third caption and step, null when none plays.
 * While it is set, layers are not saved to prefs, the URL hash is not written and the UI narrator is
 * quiet (unless `paused`); the tour restores the state it found when it ends.
 * @typedef {{id:string, title:string, step:number, steps:number, caption:string, paused:boolean, ambient:boolean}} TourState */
/** The angle ruler (sky view; render/ruler.js), null when off: the ends set so far (0–2), their names,
 * the angle between the drawn places and its reading ('11.9° · about 1 fist'). Not in the URL.
 * @typedef {{ends:number, from:string|null, to:string|null, deg:number|null, text:string, fists:string}} RulerState */
/** 'Point at the sky' (camera/aim.js), null when off: the sensor in use ('starting' until the first
 * reading, 'compass' | 'ios' | 'relative'), the Align offset (degrees) and what it was aligned on.
 * @typedef {{source:string, offsetDeg:number, aligned:string|null}} AimState */
/** `observer2`: a second place to compare with (ROADMAP two-observers), or null. view.mode 'map' is
 * the flat world map (the globe unrolled; camera/rig.js, geo/mapview.js).
 * @typedef {{ observer:Observer, observer2:Observer|null, selection:SelectionId|null,
 *   view:{mode:'orbit'|'sky'|'map', earthLock:boolean, track:'none'|'body'|'stars', vantage:'none'|'l1'|'moon', system:boolean},
 *   layers:Layers,
 *   display:{tzMode:'observer'|'device'|'utc', hour12:boolean, skyDark:'auto'|'pristine'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9',
 *     aurora:'quiet'|'typical'|'storm'},
 *   quality:{setting:'auto'|'low'|'medium'|'high'|'max', active:'low'|'medium'|'high'|'max', ceiling:'low'|'medium'|'high'},
 *   ui:{panel:'sky'|'details'|'events'|'layers'|'settings'|'about', sheet:'peek'|'half'|'full', cinema:boolean, help:boolean, palette:boolean,
 *       ruler?:RulerState|null, aim?:AimState|null,
 *       eclipse:EclipseFocus|null, tour:TourState|null},
 *   status:{phase:'boot'|'loading'|'ready'|'error', progress:number, webgl:boolean, onlineSearch:'unknown'|'ok'|'down',
 *           reducedMotion:boolean, coarse:boolean, introPlaying:boolean} }} AppState */
/** BodyState: every vector is in SCENE frame (see section D).
 * @typedef {{ id:BodyId,
 *   dirS:Float64Array,      // topocentric (WGS84) astrometric J2000 unit vector (beams, glyphs, labels, sky-view Moon)
 *   geoDirS:Float64Array,   // geocentric unit vector (sub-points, footprint)
 *   distAU:number, distER:number, lightTimeS:number,
 *   altGeomDeg:number, azGeomDeg:number,          // from dirS against the observer ENU, unrefracted (always filled)
 *   // filled when detail==='full', otherwise left unchanged from the last full computation:
 *   altDeg:number, azDeg:number,                  // apparent, refracted ('normal')
 *   raJ2000H:number, decJ2000Deg:number, raDateH:number, decDateDeg:number,
 *   mag:number, phaseFrac:number, phaseAngleDeg:number, elongDeg:number, elongSide:'morning'|'evening'|null,
 *   angDiamArcsec:number, constellation:{symbol:string,name:string}, subLatDeg:number, subLonDeg:number, above:boolean,
 *   // disc drawing (astro/disc.js), every detail level:
 *   poleS:Float64Array,     // IAU north pole (planets and the Moon; the Sun's at 'full' or in solar eclipses)
 *   primeS:Float64Array,    // prime meridian direction, on the body's equator (planets, the Moon)
 *   spinDeg:number,         // IAU prime-meridian angle W, 0…360 (planets: at t − light time)
 *   lightS:Float64Array,    // unit vector from the body toward the Sun (the Sun: toward the observer)
 *   ringTiltDeg:number }} BodyState  // Saturn: AE Illumination ring_tilt (positive: south face seen); 0 otherwise */
/** @typedef {{ tMs:number, jdUT:number, detail:'frame'|'full', gastDeg:number,
 *   earthMatrix:Float64Array,  // 16, column-major: earth-geometry-local → world (rotation only)
 *   earthQuat:Float64Array,    // 4, (x,y,z,w), same rotation
 *   sunDirS:Float64Array,      // 3, geocentric unit vector to the Sun
 *   moonPosS:Float64Array,     // 3, geocentric Moon centre in Earth radii
 *   moonMatrix:Float64Array,   // 16, column-major: moon-geometry-local → world (rotation + translation moonPosS)
 *   sunPoleS:Float64Array,     // 3, the Sun's north rotation pole (IAU); refreshed at 'full', and at 'frame' while eclipse.solar
 *   moonPhaseDeg:number,
 *   observer:{latDeg:number, lonDeg:number, elevM:number, posS:Float64Array, upS:Float64Array, northS:Float64Array,
 *             eastS:Float64Array, sunAltDeg:number, twilight:'day'|'civil'|'nautical'|'astronomical'|'night'},
 *   bodies:BodyState[],        // always 9, in BODIES order
 *   eclipse:{solar:boolean, lunar:boolean, obscurationAtObserver:number, moonLitFraction:number,
 *            beads:import('../astro/totality.js').Beads},  // Baily's beads near C2/C3 of a total eclipse, else count 0
 *   galilean:import('../astro/moons.js').Galilean,  // Jupiter's four moons (every detail level)
 *   libration:{elonDeg:number, elatDeg:number},     // the Moon's libration; refreshed at 'full' only
 *   skyglow:import('../astro/skyglow.js').Skyglow,  // the night sky's brightness; filled by the frame loop
 *   aurora:import('../astro/geomag.js').Aurora,     // geomagnetic pole, magnetic noon, oval table; filled by the frame loop
 *   helio:{earthS:Float64Array, posS:Float64Array}, // heliocentric AU, scene axes, Sun at the origin (every detail level):
 *                              // the Earth's position, and per BODIES index (×3) the Earth + the body's geocentric vector
 *   second:object|null         // the second place's Snapshot at the same instant (two-observers); set by the frame loop
 *   }} Snapshot */
/** TierCfg. `dprCap` is Infinity on max (no cap). `msaa` is a request: postfx clamps it to MAX_SAMPLES.
 *  The last three keys are max-only; absent means the 1024 Moon, 8x anisotropy and a one-tap cloud shadow.
 * @typedef {{ name:'low'|'medium'|'high'|'max', dprCap:number, composer:boolean, msaa:number,
 *   bloom:null|{strength:number, radius:number, threshold:number, scale:number},
 *   earthSegments:[number,number], dayTex:'day2k'|'day4k'|'day8k', oceanMask:'derived'|'roughness2k'|'roughness',
 *   clouds:'none'|'clouds2k'|'brc4k'|'clouds8k', cloudShadows:boolean, bump:boolean, atmosphere:'analytic'|'raymarch', atmoSteps:number,
 *   starMagLimit:number, flare:boolean, labelCap:number, twinkle:boolean, beamGlowPx:number, finalPass:boolean,
 *   moonTex?:'moon'|'moon4k', anisotropy?:number, cloudShadowTaps?:number, supersample?:number, streakPx?:number }} TierCfg
 * supersample: idle supersampling's sample cap (0 = off); streakPx: the fast-time streak cap (device px, 0 = off). */
/** @typedef {{ dtMs:number, timeS:number, camera:any, viewMode:'orbit'|'sky', skyBlend:number, snap:Snapshot,
 *   pulsesActive:boolean, simRate:number, exposure:{stars:number, planets:number, milkyWay:number, vision:number},
 *   moonFront:boolean, mapK:number, map:object|null, systemBlend:number }} FrameInfo `moonFront`: the camera is in lunar orbit (or flying there), so the Moon
 *   draws in front of everything and the near plane ignores it (camera/rig.js, astro/vantage.js). `mapK`: the globe → flat
 *   map morph, 0 … 1 (rig.mapK); `map`: the map plane's frame (geo/mapview.js createMapFrame) while mapK > 0, else null.
 *   `systemBlend` (0…1): the globe → orrery crossfade of the solar-system zoom (rig.systemBlend; the camera 80 → 150 R out). */
/** @typedef {{name:string, admin:string, country:string, cc:string, lat:number, lon:number, tz:string|null, pop:number,
 *   source:'offline'|'open-meteo'|'photon'|'nominatim', score?:number}} Place */
/** @typedef {{id:string, kind:'moon-phase'|'opposition'|'conjunction'|'max-elongation'|'lunar-eclipse'|'solar-eclipse'|
 *   'local-solar-eclipse'|'equinox'|'solstice', bodyId:BodyId|null, tMs:number, title:string, detail:string,
 *   select:BodyId|null, view:'orbit'|'sky'|null}} AstroEvent */

// ─────────────────────── Additional shared shapes (G2 modules) ───────────────────────

/** Render-module contract (SPEC §C.1). Every method is optional except `object3d` and `dispose`.
 * @typedef {{ object3d:any, apply?:(snap:Snapshot)=>void, update?:(fi:FrameInfo)=>void, setLayers?:(layers:Layers)=>void,
 *   setViewMode?:(mode:'orbit'|'sky', skyBlend:number)=>void, setSelection?:(id:BodyId|null)=>void,
 *   setQuality?:(cfg:TierCfg)=>void, dispose:()=>void }} RenderModule */
/** Label anchor fed to the label pool (SPEC §C.6).
 * @typedef {{ id:string, text:string, kind:'body'|'observer'|'star'|'constellation'|'cardinal'|'trail'|'ruler', priority:number,
 *   color?:string, dirS?:Float64Array|Float32Array, posS?:Float64Array, offsetPx?:ArrayLike<number>, ariaLabel?:string,
 *   interactive:boolean, selected?:boolean, below?:boolean, hidden?:boolean, faint?:boolean }} LabelAnchor */

/** Store returned by `createStore` (js/core/store.js).
 * @typedef {{ get:()=>AppState,
 *   set:(patch:Partial<AppState>|((s:AppState)=>Partial<AppState>|null|undefined), source?:string)=>boolean,
 *   subscribe:<T>(selector:((s:AppState)=>T)|string|null, cb:(value:T, prev:T|undefined, state:AppState, source:string|undefined)=>void,
 *     opts?:{immediate?:boolean})=>(()=>void) }} Store */
/** Event bus returned by `createBus` (js/core/bus.js).
 * @typedef {'readout'|'toast'|'announce'|'almanac'|'events'|'intro'} BusEventType */
/** @typedef {{message:string, kind:'info'|'warn'|'error', actionLabel?:string, onAction?:()=>void, timeoutMs?:number}} ToastPayload */
/** @typedef {{ on:(type:BusEventType, fn:(payload:any)=>void)=>(()=>void),
 *   once:(type:BusEventType, fn?:(payload:any)=>void)=>((()=>void)|Promise<any>),
 *   off:(type:BusEventType, fn:(payload:any)=>void)=>void, emit:(type:BusEventType, payload?:any)=>void,
 *   clear:()=>void }} Bus */

/** Clock change event (js/core/clock.js). Extra fields describe the clock right after the change.
 * @typedef {{type:'play'|'pause'|'rate'|'jump'|'live'|'range'|'clamp', tMs:number, rate:number, playing:boolean, live:boolean}} ClockEvent */
/** @typedef {{fromMs:number, toMs:number, durationS:number, loop:'once'|'loop'|'pingpong', ease:'in'|'out'|'inOut'|null, strideMs?:number|null}} ClockRange */
/** @typedef {{ readonly tMs:number, readonly rate:number, readonly baseRate:number, readonly playing:boolean,
 *   readonly live:boolean, readonly range:ClockRange|null, readonly tweening:boolean,
 *   tick:(wallMs?:number)=>number, play:()=>void, pause:()=>void, toggle:()=>void,
 *   setRate:(r:number)=>void, faster:()=>void, slower:()=>void, reverse:()=>void,
 *   setTime:(ms:number, opts?:{animateMs?:number})=>void,
 *   step:(kind:'minute'|'hour'|'day'|'siderealDay'|'month'|'year'|number, n?:number, opts?:{animateMs?:number})=>void,
 *   goLive:(opts?:{animateMs?:number})=>void,
 *   setRange:(range:(Partial<ClockRange>&{fromMs:number,toMs:number})|null)=>boolean, progress:()=>number|null,
 *   seek:(p:number)=>boolean, isAnimating:()=>boolean, onChange:(cb:(ev:ClockEvent)=>void)=>(()=>void) }} Clock */

/** Camera view as carried by the URL `cam=` key (js/core/url-state.js). 'map': the map's centre and the camera's
 * distance from the plane (plane units: the map is 2π × π).
 * @typedef {{mode:'orbit', latDeg:number, lonDeg:number, distance:number}|{mode:'sky', azDeg:number, altDeg:number, fovDeg:number}
 *   |{mode:'map', latDeg:number, lonDeg:number, distance:number}} CamView */
/** Result of `parseHash`. Every key is optional; `invalid` lists keys that were present but rejected or clamped.
 * @typedef {{ observer?:Observer&{cc:string}, observer2?:Observer&{cc:string}, tMs?:number, live?:boolean, rate?:number, playing?:boolean,
 *   view?:'orbit'|'sky'|'map', earthLock?:boolean, selection?:SelectionId|null, layers?:Layers,
 *   quality?:'auto'|'low'|'medium'|'high'|'max', skyDark?:string, aurora?:'quiet'|'typical'|'storm', cam?:CamView, track?:'body'|'stars', vantage?:'l1'|'moon', intro?:boolean, debug?:boolean, tour?:string, invalid?:string[] }} HashState */

/** Device probe for `detectTier` (js/core/quality.js).
 * @typedef {{webgl2:boolean, rendererString?:string, maxTextureSize?:number, dpr?:number, deviceMemory?:number, cores?:number,
 *   coarse?:boolean, screenW?:number, screenH?:number, saveData?:boolean}} TierProbe */
/** @typedef {{tier:'low'|'medium'|'high', ceiling:'low'|'medium'|'high', textMode:boolean, reason:string}} TierDecision */
/** @typedef {{ sample:(dtMs:number)=>('low'|'medium'|'high'|null), idle:(dtMs:number)=>void, probe:()=>boolean,
 *   pin:(tier:'low'|'medium'|'high'|'max'|null)=>('low'|'medium'|'high'|'max'),
 *   config:()=>TierCfg, reset:()=>void, readonly tier:'low'|'medium'|'high'|'max', readonly ceiling:'low'|'medium'|'high',
 *   readonly start:'low'|'medium'|'high', readonly pinned:'low'|'medium'|'high'|'max'|null, readonly dprCap:number,
 *   readonly emaMs:number|null, readonly cadenceMs:number|null, readonly budgetMs:number }} Governor */

/** Wall-clock fields in a time zone (js/core/tz.js). `mo` is 1-based.
 * @typedef {{y:number, mo:number, d:number, h:number, mi:number, s:number}} ZonedFields */
/** @typedef {ZonedFields & {offsetMin:number, abbr:string}} ZonedTime */

/** Offline city index returned by `loadCities` (js/geo/cities.js).
 * @typedef {{ list:Place[], countries:Record<string,string>, size:number,
 *   search:(q:string, limit?:number)=>Place[], nearest:(lat:number, lon:number, maxKm?:number)=>{city:Place|null, km:number},
 *   byTz:(tz:string)=>Place|null, countryName:(cc:string)=>string }} CityIndex */
/** Online geocoder returned by `createGeocoder` (js/geo/geocode.js). `search` never rejects.
 * @typedef {{places:Place[], provider:string|null, error?:string, stale?:boolean, cached?:boolean}} GeocodeResult */
/** @typedef {{ search:(q:string, opts?:{signal?:AbortSignal, enter?:boolean})=>Promise<GeocodeResult>,
 *   status:()=>('unknown'|'ok'|'down'), reset:()=>void,
 *   providers:()=>{id:string, label:string, enterOnly:boolean, failures:number, tripped:boolean}[] }} Geocoder */

export {};
