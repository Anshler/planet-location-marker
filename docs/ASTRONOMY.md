# The astronomy behind Planet Location Marker

Every position in the app is computed in the browser by
[Astronomy Engine](https://github.com/cosinekitty/astronomy) 2.1.19, vendored as
`vendor/astronomy-engine/astronomy.js`. Our code wraps it in a small, tested set of frame
conversions so that the Earth, the observer, the beams and the star sky all agree. This document
explains those conversions, the formulas we add on top, how accurate the result is, and where the
methods come from.

All of this code lives in `js/astro/` and is *pure*: no DOM and no three.js. It runs identically in
the page, in the module worker (`js/astro/worker.js`) and in the Node test suite
(`test/astro.*.test.mjs`).

---

## 1. Time

- **Input.** App time is UTC milliseconds (`Date` epoch, i.e. UT). `AE.MakeTime(new Date(ms))`
  derives Terrestrial Time internally with ΔT from the Espenak–Meeus polynomials. We never pass TT
  ourselves.
- **Sidereal time.** `AE.SiderealTime(time)` returns Greenwich *apparent* sidereal time (GAST, in
  hours). It is measured from the true equinox of date, so it includes the equation of the
  equinoxes.
- **Range.** The clock is clamped to 1000-01-01 … 3000-01-01. A "Reduced accuracy" badge appears
  outside 1800–2200 (see §8).
- **Julian date.** `jdUT = ms / 86 400 000 + 2 440 587.5`, kept in the snapshot for display.

---

## 2. Frames

| Frame | Definition | Used for |
|---|---|---|
| **EQJ** | Mean equator and equinox of J2000.0 (≈ ICRS); +z = north celestial pole, +x = vernal equinox | Astronomy Engine's native frame. Everything we draw is expressed in it, through S. |
| **EQD** | True equator and equinox of date | Displayed apparent RA/Dec and alt/az only. |
| **EF** (Earth-fixed) | +x = latitude 0 / longitude 0, +y = 90° E, +z = north pole (polar motion ignored) | The Earth texture, the pin, picking. |
| **Scene** | three.js world: **+Y = J2000 north pole**, 1 unit = Earth equatorial radius (6378.137 km), Earth's centre at the origin | Rendering. |

### The mapping S (EQJ → scene)

```
        ⎡1  0  0⎤
    S = ⎢0  0  1⎥        scene = S · eqj   ⇔   (x, y, z)_eqj → (x, z, −y)_scene
        ⎣0 −1  0⎦        S⁻¹ = Sᵀ          ⇔   eqj = (x_s, −z_s, y_s)
```

S is a proper rotation (−90° about X). It follows that:

- `raDecToScene(α, δ) = (cos δ cos α, sin δ, −cos δ sin α)`;
- `sceneToRaDec(d)`: `α = atan2(−d_z, d_x)` wrapped to [0°, 360°), `δ = asin(d_y)`.

**Matrix layout gotcha.** Astronomy Engine's `RotateVector` computes
`x′ = rot[0][0]·x + rot[1][0]·y + rot[2][0]·z`. A row-major matrix M therefore has
`M[i][j] = rot[j][i]`. `frames.aeRotToM3` does this transpose, and a test checks it against
`RotateVector` on random vectors to 1e-15.

### Earth orientation (every snapshot)

```
time    = AE.MakeTime(new Date(tMs))
GAST    = AE.SiderealTime(time) · 15°
PN      = aeRotToM3(AE.Rotation_EQD_EQJ(time))     // undoes nutation (IAU 2000B) and precession (IAU 2006)
E       = PN · Rz(GAST)                            // EF → EQJ;  Rz(θ) = [c −s 0; s c 0; 0 0 1]
earthMatrix = embed(S · E · Sᵀ)                    // column-major 4×4 for three.js, rotation only
```

three's `SphereGeometry` puts u = 0.5 (longitude 0) at local +X and u = 0.75 (90° E) at local −Z.
That is exactly S·EF, so an equirectangular Earth texture needs no offset:

- `latLonToLocal(φ, λ) = (cos φ cos λ, sin φ, −cos φ sin λ)`;
- `localToLatLon(v)`: `φ = asin(v_y)`, `λ = atan2(−v_z, v_x)`.

With E = Rz(θ) alone, S·Rz(θ)·Sᵀ is three's `rotation.y = θ`, which was v1's convention.

**The sky is static; the Earth moves.** Stars, constellations, the Milky Way, the grids and the
ecliptic are placed once at load, in J2000 scene coordinates. Precession and nutation appear
because the Earth's axis (`earthMatrix`) moves inside that fixed sky. Over centuries the celestial
pole visibly drifts away from Polaris.

---

## 3. The observer

```
obs       = new AE.Observer(φ, λ, h)                        // geodetic WGS84 latitude, longitude, metres
posLocal  = latLonToLocal(φ, λ);   posS = earthMatrix · posLocal
up        = posLocal
east      = normalize((up_z, 0, −up_x))                     // = (−sin λ, 0, −cos λ)
north     = cross(up, east)                                 // order matters: this points north
{east, north, up}S = earthMatrix · {…}Local
```

The pin is placed at the **geodetic** latitude on a **unit sphere**. Its normal therefore equals
the WGS84 geodetic zenith that Astronomy Engine uses, so our altitudes match its altitudes. The
cost is a displacement of the pin's *position* of at most about 21 km against the true ellipsoid
point (§8).

Altitude and azimuth of a direction `d`: `alt = asin(d·up)`, `az = atan2(d·east, d·north)` wrapped
to [0°, 360°), measured from north through east.

---

## 4. Bodies (`js/astro/snapshot.js`)

The Sun, the Moon and the seven planets, in the fixed `BODIES` order.

### Every frame (`detail: 'frame'`, about 0.15 ms for all nine)

```
eq        = AE.Equator(body, time, obs, ofdate=false, aberration=false)
dirS      = S · normalize(eq.vec)        // topocentric, astrometric J2000, light-time corrected → beams, glyphs, labels
distAU    = eq.dist;  distER = distAU · 23 454.8;  lightTimeS = distAU · 499.004784
geo       = AE.GeoVector(body, time, true)          // the Moon: AE.GeoMoon(time)
geoDirS   = S · normalize(geo)                       // geocentric → sub-points, footprint, lighting
sunDirS   = geoDirS of the Sun
{altGeom, azGeom} from dirS against the observer's ENU basis
observer.sunAltDeg = altGeom of the Sun;  twilight class from it
```

- **Light time.** `Equator` iterates light-time, so the beam points where the body *was* when the
  light now arriving left it. The panel says this in words: "The light you see from Saturn left
  1 h 21 min ago."
- **Parallax.** Directions are topocentric. The Moon's parallax reaches about 1°, so the Moon beam
  from Hanoi and the one from Paris do not point the same way.
- **Cheap extras.** The frame pass also refreshes magnitude and phase (`AE.Illumination`), angular
  size, J2000 RA/Dec, elongation (the Sun–body angle from the geocentric vectors), sub-points and
  the eclipse flags. Its alt/az is the geometric value plus refraction (§6), within about 21″ of
  the full value.

### Four times a second (`detail: 'full'`, drives the panels)

```
eqd   = AE.Equator(body, time, obs, ofdate=true, aberration=true)    // apparent RA/Dec of date
hor   = AE.Horizon(time, obs, eqd.ra, eqd.dec, 'normal')            // refracted alt/az
constellation = AE.Constellation(raJ2000, decJ2000)
moonPhaseDeg  = AE.MoonPhase(time)
```

- **Sub-points.** `subLat` and `subLon` come from `Eᵀ · geoDirS` through `localToLatLon`. This is
  the same construction the Earth shader uses for the sub-point dots.
- **Elongation side.** "Morning" when the body's ecliptic longitude is west of the Sun's, otherwise
  "evening".
- **Up.** The Sun and Moon count as up while their upper limb clears the horizon: refracted
  altitude plus the semi-diameter, above 0.

### Why the drawing uses astrometric J2000 and the tables use apparent of-date

The star catalogue is astrometric J2000, so beams drawn in the same frame land on the right stars.
The printed alt/az is what an observer would measure. The two differ by two things:

- annual aberration, at most 20.5″;
- atmospheric refraction, about 34′ at the horizon and 0 at the zenith.

Both are stated in the About panel.

### The Moon at true scale

The Moon is drawn as a sphere of radius 0.2724 (1737.4 km) at `moonPosS = S · GeoMoon · AU_ER`,
about 60 Earth radii away. Its orientation is the IAU rotation model:

```
ax = AE.RotationAxis('Moon', time)                        // pole RA α, Dec δ, prime-meridian angle W
R  = Rz(90° + α) · Rx(90° − δ) · Rz(W)                     // body-fixed → EQJ
moonMatrix = embed(S·R·Sᵀ, translation = moonPosS)
```

Libration falls out of this for free. The shader lights the Moon with Lommel–Seeliger reflectance
from the true Sun direction. The phase you see is therefore correct by construction, not drawn from
`MoonPhase`, with faint earthshine on the night side.

---

## 5. The star sky (`data/sky.json`, `js/data/catalog.js`)

- **Stars.** 5,044 Hipparcos stars to magnitude 6 (via d3-celestial), at their **J2000** positions.
  Proper motion is not applied (§8).
- **Colour.** B−V is turned into a colour temperature with Ballesteros' formula,
  `T = 4600 K · (1/(0.92·(B−V) + 1.7) + 1/(0.92·(B−V) + 0.62))`. Planck's law at that temperature
  is then integrated against the CIE 1931 observer (Wyman–Sloan–Shirley fit) into linear sRGB,
  normalised so the brightest channel is 1.
- **Size and brightness.** Both come from the flux relative to the tier's limiting magnitude,
  `10^(−0.4·(m − m_lim))`.
- **Constellations.** The 88 figures come from d3-celestial. The Milky Way is a 2048×1024 raster
  of its outline levels, sampled through `sceneDirToRaDecUv`.
- **Planet glyphs.** Their size and brightness follow the live magnitude from `AE.Illumination`.

---

## 6. Refraction, extinction, twilight, exposure (`js/astro/photometry.js`)

- **Refraction.** `refractionDeg(h)` uses the Sæmundsson formula for a true altitude h,
  `R = 1.02′ / tan(h + 10.3°/(h + 5.11°))`, clamped at −1° and tapered to 0 at the nadir.
  `refractionDeg(0) ≈ 0.483°`. It mirrors Astronomy Engine's `Refraction('normal', h)` exactly, so
  the 'frame' pass and `AE.Horizon(…, 'normal')` in the tables agree.
- **Airmass.** Kasten–Young (1989). It feeds `extinctionMag` (k = 0.2 mag per airmass) for
  Tonight's visibility notes.
- **Twilight classes** by solar altitude:

  | Solar altitude | Class |
  |---|---|
  | above −0.833° | day |
  | to −6° | civil |
  | to −12° | nautical |
  | to −18° | astronomical |
  | below | night |

- **Sky-view exposure.** It blends from 1 in orbit view (skyBlend 0) to these curves in sky view:
  - stars: `1 − smoothstep(−18°, −4°, h☉)`;
  - planets: `max(0.15, 1 − 0.85·smoothstep(−8°, 4°, h☉))`;
  - Milky Way: `1 − smoothstep(−20°, −10°, h☉)`.

  Stars fade with the dawn, and Venus and Jupiter stay visible in twilight. The daylight dome is
  the Preetham–Shirley–Smits analytic sky driven by the true Sun.

---

## 7. Almanac, events and paths (worker)

- **Rise, transit, set.** These use `SearchRiseSet(±1)`, with the upper limb and standard
  refraction for the Sun and Moon, and `SearchHourAngle(0)`. When there is no rise or set, the
  status is *circumpolar* or *never*, decided from the altitudes at transit and anti-transit.
- **Twilight times.** `SearchAltitude(Sun, …, −6° / −12° / −18°)`.
- **Tonight.** The night in progress (or the coming one, if the Sun is up) is sampled every 10
  minutes over the noon-to-noon window centred on the Sun's anti-transit; only the dark part counts.
  - "Dark" means the Sun is below −6°, or below −12° for objects fainter than magnitude 4.
  - "Up" means altitude above 5°.
  - *Excellent* means higher than 30° in astronomical darkness.
  - A body is *not visible* when within 12° of the Sun (7° for the Moon and Venus, which are
    bright enough to be seen closer to it).
  - The equipment hint follows the magnitude.
- **Events** for the next 12 months:
  - Moon quarters;
  - oppositions and conjunctions (`SearchRelativeLongitude` 180°/0°);
  - greatest elongations of Mercury and Venus;
  - lunar eclipses;
  - global solar eclipses, with the point of greatest eclipse;
  - local solar eclipses with the obscuration here;
  - equinoxes and solstices (`Seasons`).
- **Retrograde paths.** ±180 days of geocentric `GeoVector(…, true)` through S, one sample per
  day (the Moon: ±14 days at 2 h). The stationary points are the sign changes of dλ/dt in ecliptic
  longitude, refined by bisection to 10 minutes.

### Eclipses in the render

The true-scale Sun, Moon and Earth geometry gives eclipses without special cases.

- **Disc overlap.** `discVisible(rs, ro, d)` is the visible fraction of a disc of angular radius
  `rs` behind a disc of radius `ro` at separation `d`. It is computed from the circle–circle
  overlap area, `A = rs²·acos(…) + ro²·acos(…) − ½√(…)`, and returns `1 − A/(π rs²)`. It is
  mirrored exactly in GLSL and in `shadow.js`.
- **Solar eclipse.** Each Earth fragment dims by the fraction of the solar disc hidden by the Moon
  as seen from that point. The umbra and penumbra appear in the right place.
- **Lunar eclipse.** Each Moon fragment dims by Earth's disc as seen from the Moon, with a red
  "all the sunsets" term where the Sun is (nearly) hidden. That term is exposed for totality and
  scaled by `1 / (1 + lit / 0.015)` (`lit` = `eclipse.moonLitFraction`), so during the partial
  phases the sunlit cap stays grey-white and the umbra reads dark, as the eye sees it.
- **Sky view in a solar eclipse.** The Sun's glare scales with the part of the disc left visible
  (adapted as `(1 − obscuration)^0.56`, like the daylight), the ground darkens with the sky, and
  past 98.5 % a compact pearly corona (e-folding 0.2°) takes over.
- **Flags.** The snapshot flags `eclipse.solar` and `eclipse.lunar` when the geocentric Sun–Moon
  separation is under 1.6°, or the Moon–antisun separation is under 1.65°.
- **Eclipse magnitudes.** `AE.Illumination` ignores shadows, so the snapshot dims the magnitudes
  itself, in both detail levels:
  - **Sun.** It adds `−2.5·log10(max(1 − obscuration, 1e-6))`, using the obscuration at the
    observer. Totality therefore floors at +15 mag (about −11.7, roughly the corona).
  - **Moon.** `lunarEclipseLight` (`shadow.js`) averages, over 72 quadrature points on the lunar
    disc, the fraction of the Sun that each point sees past the Earth's shadow disc. The shadow
    disc is the mean radius plus 88 km, Astronomy Engine's value, which enlarges the umbra by about
    2 %. The hidden part keeps refracted light: 10⁻⁴ of full at the umbra's edge, falling to 10⁻⁵
    on the axis. `eclipse.moonLitFraction` is the direct-sunlight part.
  - **Results.** Totality reads about −2 to −1 (2026-03-03: −1.7; the central eclipse of
    2029-06-26: −0.9), which is Danjon-typical. Deep
    penumbral phases dim by 0.5–0.7 mag, and penumbral eclipses by up to about 0.6 mag.
  - **Accuracy.** The quadrature is within 0.03 mag of a brute-force grid. The real umbra's
    brightness varies with the atmosphere by a few magnitudes (Danjon L 0–4), and the model
    ignores solar limb darkening.
- **Jumping to an eclipse.** The camera flies over the event's point of greatest eclipse (from
  Astronomy Engine), or, when there is none (a partial eclipse), over the point where the shadow
  axis meets the Earth: `P = m − t·ŝ` with `|P| = 1`, solved for the nearer root (`shadowPoint` in
  `js/app/actions.js`). For 2027-02-06 15:59:33 UTC the axis gives 31.1° S, 48.5° W, within 30 km
  of the published point of greatest eclipse (31.3° S, 48.5° W; tested in
  `test/app.actions.test.mjs`).

---

## 8. Accuracy budget

| Source of error | Typical size | Notes |
|---|---|---|
| Astronomy Engine positions, 1800–2200 | ≲ 1′ | Checked by its author against JPL Horizons and NOVAS. Planets from truncated VSOP87; the Moon from the *Improved Lunar Ephemeris* (Brown's theory) as adapted by Montenbruck & Pfleger. |
| Outside 1800–2200 | grows with distance from 2000 | The uncertainty in ΔT (the Earth's irregular rotation) dominates far from the present. It is about a minute of time around the year 1000, which is 0.25° of Earth rotation. Toward 3000 it grows to tens of minutes, because ΔT must be extrapolated. That moves where on Earth a given sky is seen by several degrees of longitude. The truncated series also lose precision. Hence the "Reduced accuracy" badge. |
| Frame consistency: our Earth matrix against `Rotation_EQJ_HOR` | 0.007″ measured | The test bound is 0.05″ over 300 random epochs and sites, 1900–2150. |
| Drawn (astrometric) against tabulated (apparent) direction | ≤ 20.8″ measured | Annual aberration. Refraction is added on top in the tables. |
| Pin on a sphere against the WGS84 ellipsoid | ≤ 21 km in position | ≤ 11″ on the Moon's direction, negligible for everything farther. The zenith direction is exact (geodetic). |
| Beam far endpoint at 2000 Earth radii | `camDist / 2000` rad | 0.1° at the default 3.4 ER view. The beam is a line from the pin, so seen from elsewhere it converges at 2000 ER. |
| Polar motion (ignored) | ≤ 0.5″ (≈ 15 m) | |
| Star proper motion (catalogue fixed at J2000) | 0.2″–10″/yr | Negligible within a few centuries. The fastest naked-eye stars shift by up to about a degree 1000 years from 2000. |
| Refraction model | several ′ near the horizon | Real refraction depends on temperature and pressure. Rise and set times are good to about a minute. |
| Float32 on the GPU | ≈ 0.01″ | Unit vectors in single precision. |
| Sub-points, footprint | geocentric | The footprint is the hemisphere where the body's geocentric direction is above the horizon. Parallax and refraction are not applied. It is a guide, not a contact time. |

**Validation.** The tests in `test/astro.*.test.mjs` check these values from SPEC §D.5:

- sidereal time on 2026-06-21 12:00 UTC is 5.98009 h (±1e-4 h);
- the subsolar point at that moment is +23.438°, +0.454°;
- the subsolar points at the 2026 March equinox and December solstice;
- Sirius and Betelgeuse positions from the decoded catalogue;
- `Constellation(5.919 h, 7.407°)` is Ori;
- the next global solar eclipse after 2026-10-11 is annular, on 2027-02-06;
- the Mars opposition of 2025-01-16 and its retrograde from about 7 Dec 2024 to 24 Feb 2025;
- `discVisibleFraction` against numerical integration;
- 200 random alt/az cases against `AE.Horizon`, within 30″.

---

## 9. Sources

- **Astronomy Engine.** Don Cross, <https://github.com/cosinekitty/astronomy>, MIT. This covers the
  API reference and the model notes on VSOP87, the lunar theory, IAU 2000B nutation, IAU 2006
  precession and Espenak–Meeus ΔT.
- **VSOP87.** P. Bretagnon & G. Francou (1988), "Planetary theories in rectangular and spherical
  variables: VSOP87 solutions", *A&A* 202, 309.
- **Lunar theory.** *Improved Lunar Ephemeris 1952–1959* (1954), after E. W. Brown. Also
  O. Montenbruck & T. Pfleger, *Astronomy on the Personal Computer*, Springer.
- **Precession.** N. Capitaine, P. T. Wallace & J. Chapront (2003), "Expressions for IAU 2000
  precession quantities", *A&A* 412, 567 (adopted as IAU 2006).
- **Nutation.** D. D. McCarthy & B. J. Luzum (2003), "An abridged model of the precession-nutation
  of the celestial pole" (IAU 2000B), *Celest. Mech. Dyn. Astr.* 85, 37.
- **ΔT.** F. Espenak & J. Meeus (2006), *Five Millennium Canon of Solar Eclipses*, NASA/TP-2006-214141.
- **Meeus.** J. Meeus (1998), *Astronomical Algorithms*, 2nd ed., Willmann-Bell. Used for
  refraction, rise and set, and the general methods.
- **Refraction.** Þ. Sæmundsson (1986), *Sky & Telescope* 72, 70.
- **Airmass.** F. Kasten & A. T. Young (1989), "Revised optical air mass tables and approximation
  formula", *Applied Optics* 28, 4735.
- **Star colours.** F. J. Ballesteros (2012), "New insights into black bodies", *EPL* 97, 34008.
- **Rotational elements.** B. A. Archinal et al. (2018), "Report of the IAU Working Group on
  Cartographic Coordinates and Rotational Elements: 2015", *Celest. Mech. Dyn. Astr.* 130, 22.
- **Daylight sky.** A. J. Preetham, P. Shirley & B. Smits (1999), "A Practical Analytic Model for
  Daylight", SIGGRAPH '99.
- **Star data.** ESA (1997), *The Hipparcos and Tycho Catalogues*, ESA SP-1200, via d3-celestial
  (Olaf Frohn, BSD-3-Clause).
- **Cities.** GeoNames gazetteer, CC BY 4.0.
