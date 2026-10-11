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
 *   eqGrid:boolean, altAzGrid:boolean, horizon:boolean, footprint:boolean, subpoints:boolean, trails:boolean, labels:boolean}} Layers */
/** @typedef {{ observer:Observer, selection:BodyId|null,
 *   view:{mode:'orbit'|'sky', earthLock:boolean},
 *   layers:Layers,
 *   display:{tzMode:'observer'|'device'|'utc', hour12:boolean},
 *   quality:{setting:'auto'|'low'|'medium'|'high', active:'low'|'medium'|'high', ceiling:'low'|'medium'|'high'},
 *   ui:{panel:'sky'|'details'|'events'|'layers'|'settings'|'about', sheet:'peek'|'half'|'full', cinema:boolean, help:boolean, palette:boolean},
 *   status:{phase:'boot'|'loading'|'ready'|'error', progress:number, webgl:boolean, onlineSearch:'unknown'|'ok'|'down',
 *           reducedMotion:boolean, coarse:boolean, introPlaying:boolean} }} AppState */
/** BodyState: every vector is in SCENE frame (see section D).
 * @typedef {{ id:BodyId,
 *   dirS:Float64Array,      // topocentric astrometric J2000 unit vector (beams, glyphs, labels)
 *   geoDirS:Float64Array,   // geocentric unit vector (sub-points, footprint)
 *   distAU:number, distER:number, lightTimeS:number,
 *   altGeomDeg:number, azGeomDeg:number,          // from dirS against the observer ENU, unrefracted (always filled)
 *   // filled when detail==='full', otherwise left unchanged from the last full computation:
 *   altDeg:number, azDeg:number,                  // apparent, refracted ('normal')
 *   raJ2000H:number, decJ2000Deg:number, raDateH:number, decDateDeg:number,
 *   mag:number, phaseFrac:number, phaseAngleDeg:number, elongDeg:number, elongSide:'morning'|'evening'|null,
 *   angDiamArcsec:number, constellation:{symbol:string,name:string}, subLatDeg:number, subLonDeg:number, above:boolean }} BodyState */
/** @typedef {{ tMs:number, jdUT:number, detail:'frame'|'full', gastDeg:number,
 *   earthMatrix:Float64Array,  // 16, column-major: earth-geometry-local → world (rotation only)
 *   earthQuat:Float64Array,    // 4, (x,y,z,w), same rotation
 *   sunDirS:Float64Array,      // 3, geocentric unit vector to the Sun
 *   moonPosS:Float64Array,     // 3, geocentric Moon centre in Earth radii
 *   moonMatrix:Float64Array,   // 16, column-major: moon-geometry-local → world (rotation + translation moonPosS)
 *   moonPhaseDeg:number,
 *   observer:{latDeg:number, lonDeg:number, elevM:number, posS:Float64Array, upS:Float64Array, northS:Float64Array,
 *             eastS:Float64Array, sunAltDeg:number, twilight:'day'|'civil'|'nautical'|'astronomical'|'night'},
 *   bodies:BodyState[],        // always 9, in BODIES order
 *   eclipse:{solar:boolean, lunar:boolean, obscurationAtObserver:number, moonLitFraction:number} }} Snapshot */
/** @typedef {{ name:'low'|'medium'|'high', dprCap:number, composer:boolean, msaa:number,
 *   bloom:null|{strength:number, radius:number, threshold:number, scale:number},
 *   earthSegments:[number,number], dayTex:'day2k'|'day4k', oceanMask:'derived'|'specular'|'roughness',
 *   clouds:'none'|'clouds1k'|'brc4k', cloudShadows:boolean, bump:boolean, atmosphere:'analytic'|'raymarch', atmoSteps:number,
 *   starMagLimit:number, flare:boolean, labelCap:number, twinkle:boolean, beamGlowPx:number, finalPass:boolean }} TierCfg */
/** @typedef {{ dtMs:number, timeS:number, camera:any, viewMode:'orbit'|'sky', skyBlend:number, snap:Snapshot,
 *   pulsesActive:boolean, exposure:{stars:number, planets:number, milkyWay:number} }} FrameInfo */
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
 * @typedef {{ id:string, text:string, kind:'body'|'observer'|'star'|'constellation'|'cardinal'|'trail', priority:number,
 *   color?:string, dirS?:Float64Array|Float32Array, posS?:Float64Array, offsetPx?:[number,number], ariaLabel?:string,
 *   interactive:boolean }} LabelAnchor */

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
/** @typedef {{fromMs:number, toMs:number, durationS:number, loop:'once'|'loop'|'pingpong'}} ClockRange */
/** @typedef {{ readonly tMs:number, readonly rate:number, readonly baseRate:number, readonly playing:boolean,
 *   readonly live:boolean, readonly range:ClockRange|null, readonly tweening:boolean,
 *   tick:(wallMs?:number)=>number, play:()=>void, pause:()=>void, toggle:()=>void,
 *   setRate:(r:number)=>void, faster:()=>void, slower:()=>void, reverse:()=>void,
 *   setTime:(ms:number, opts?:{animateMs?:number})=>void,
 *   step:(kind:'minute'|'hour'|'day'|'siderealDay'|'month'|'year'|number, n?:number, opts?:{animateMs?:number})=>void,
 *   goLive:(opts?:{animateMs?:number})=>void,
 *   setRange:(range:(Partial<ClockRange>&{fromMs:number,toMs:number})|null)=>boolean, progress:()=>number|null,
 *   seek:(p:number)=>boolean, isAnimating:()=>boolean, onChange:(cb:(ev:ClockEvent)=>void)=>(()=>void) }} Clock */

/** Camera view as carried by the URL `cam=` key (js/core/url-state.js).
 * @typedef {{mode:'orbit', latDeg:number, lonDeg:number, distance:number}|{mode:'sky', azDeg:number, altDeg:number, fovDeg:number}} CamView */
/** Result of `parseHash`. Every key is optional; `invalid` lists keys that were present but rejected or clamped.
 * @typedef {{ observer?:Observer&{cc:string}, tMs?:number, live?:boolean, rate?:number, playing?:boolean,
 *   view?:'orbit'|'sky', earthLock?:boolean, selection?:BodyId|null, layers?:Layers,
 *   quality?:'auto'|'low'|'medium'|'high', cam?:CamView, intro?:boolean, debug?:boolean, invalid?:string[] }} HashState */

/** Device probe for `detectTier` (js/core/quality.js).
 * @typedef {{webgl2:boolean, rendererString?:string, maxTextureSize?:number, dpr?:number, deviceMemory?:number, cores?:number,
 *   coarse?:boolean, screenW?:number, screenH?:number, saveData?:boolean}} TierProbe */
/** @typedef {{tier:'low'|'medium'|'high', ceiling:'low'|'medium'|'high', textMode:boolean, reason:string}} TierDecision */
/** @typedef {{ sample:(dtMs:number)=>('low'|'medium'|'high'|null), pin:(tier:'low'|'medium'|'high'|null)=>('low'|'medium'|'high'),
 *   config:()=>TierCfg, reset:()=>void, readonly tier:'low'|'medium'|'high', readonly ceiling:'low'|'medium'|'high',
 *   readonly pinned:'low'|'medium'|'high'|null, readonly dprCap:number, readonly emaMs:number|null }} Governor */

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
