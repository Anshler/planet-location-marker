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
- **Calendars** (`core/tz.js`). Instants are UTC and `t=` is a proleptic Gregorian ISO instant at
  every epoch. Displayed calendar dates before Friday 15 October 1582 are **Julian**, as the records
  of the time give them (4 July 1054, 29 February 1504): `toCalendar` goes Gregorian → Julian Day
  Number → Julian (the standard integer algorithms; JDN 2299160 = 4 Oct 1582 Julian, 2299161 =
  15 Oct 1582 Gregorian, 2451545 = 1 Jan 2000), weekdays are shared (Thursday 4 → Friday 15
  October), the Julian calendar's leap day comes every fourth year (29 Feb 1500 exists), and typed
  dates on or before 4 Oct 1582 are read as Julian (the ten days between never existed). One
  worldwide cut-over is a simplification: Britain and its colonies switched in 1752, Russia in 1918,
  so a British date between 1582 and 1752 in the records is still Julian. The clock's floor,
  1 January 1000 proleptic Gregorian, shows as 27 December 999 (Julian).

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

**The sky is static; the Earth moves.** Stars, constellations, the Milky Way and the ecliptic are
placed once at load, in J2000 scene coordinates. Precession and nutation appear because the
Earth's axis (`earthMatrix`) moves inside that fixed sky. Over centuries the celestial pole
visibly drifts away from Polaris. The one exception among the stars is proper motion: the 1,183
stars that move at least 100 mas/yr are moved to the snapshot's epoch (§5d).

The two grids are the exceptions. The alt-az grid follows the observer. The equatorial grid is
drawn **of date**: it is built in J2000 RA/Dec and turned by `S·PN·Sᵀ = earthMatrix · RotY(−GAST)`,
since `S·Rz(θ)·Sᵀ` is three's `rotation.y = θ`. Its pole is therefore `earthMatrix·ŷ`, the pole the
sky turns around, and its 0h line is the true equinox of date. In 1066 that pole is 5.2° from
the J2000 one. The ecliptic stays J2000, because its plane moves only about 47″ per century.

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
v         = S · normalize(AE.Equator(Sun, time, obs, false, true).vec) − dirS☉   // the Sun's annual aberration
dirS☾     = normalize(dirS☾ − (v − dirS☾·(dirS☾·v)))       // the Moon made astrometric too (below)
distAU    = eq.dist;  distER = distAU · 23 454.8;  lightTimeS = distAU · 499.004784
angDiam   = 2·asin(R / (distAU · AU))                      // the Sun: 2·sunAngularRadius(distAU)
geo       = AE.GeoVector(body, time, true)          // the Moon: AE.GeoMoon(time)
geoDirS   = S · normalize(geo)                       // geocentric → sub-points, footprint, lighting
sunDirS   = geoDirS of the Sun
{altGeom, azGeom} from dirS against the observer's ENU basis
observer.sunAltDeg = altGeom of the Sun;  twilight class from it
```

- **The Moon's astrometric direction.** Astronomy Engine's Moon is geometric (no light time, no
  aberration), which for the Moon is its apparent place: over the 1.3 s light time the Earth's
  orbital motion and annual aberration cancel to 0.7″. Every other `dirS` is astrometric, so the
  raw Moon sat about 20″ off against the Sun and the stars. The snapshot removes the aberration a
  star in the Moon's direction has, with the Earth's velocity over c taken from the Sun's apparent
  minus astrometric direction (its unknown radial part is ≤ 0.35″). The Sun–Moon and star–Moon
  separations between `dirS` vectors are then the apparent ones: 9.2″ at Luxor's greatest eclipse
  on 2027-08-02, not 19″. This costs one `Equator` call (≈ 0.007 ms).

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
  altitude plus the semi-diameter, above 0. The beams, the Sky panel and the labels in both views
  use this flag. The sky view draws bodies refracted (§6), so at the almanac's sunset the drawn
  Sun's upper limb touches the horizon while the panel still says "up". With the illustrative
  landscape on, sky-view labels test the same apparent altitude against the silhouette instead of
  0 (§6, *Illustrative landscape*).

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

### The solar system to scale (`js/astro/orrery.js`, the 'powers of ten' zoom)

Zoomed out past 150 Earth radii the globe view goes on into the solar system (`render/orrery.js`).
Every snapshot, at both details, carries heliocentric positions in AU, scene axes, Sun at the
origin:

```
helio.earthS = S · AE.HelioVector('Earth', t)                 // geometric
helio.posS[i] = helio.earthS + S · GEO_i                       // GEO_i = GeoVector(body, t, true) / GeoMoon
helio.posS[Sun] = 0
```

So the line the orrery draws from the Earth to a body is exactly the body's geocentric direction
(`geoDirS`), and within the beam's topocentric parallax (≤ 25″ for planets, ≤ 1° for the Moon) of
the beam itself. A body is drawn where its light left it (light-time), at most 2 × 10⁻⁴ AU (Jupiter)
off its geometric orbit: far below a pixel.

**One linear scale.** The globe scene maps into the orrery by x_AU = earthS + x_R / AU_ER, and the
orrery camera is the globe camera mapped across the same way. A uniform scale keeps every direction,
so the beams, the orrery's lines and the stars at infinity agree at every zoom: distances are to
scale, only the bodies are enlarged (sprites with a minimum size; the Earth and the Moon at true
size while that is larger). Compressing heliocentric distance (a log scale) was rejected: it bends
the Earth→planet lines away from the planets' true directions, so Mars would no longer be "in Leo"
on the orrery while its beam says it is. Bodies off the screen get an arrow where their line leaves
it, labelled like a beam.

**Orbits.** One sidereal period (`AE.PlanetOrbitalPeriod`) of each planet's `HelioVector`, centred on
the current time, 256 samples, and one sidereal month of `GeoMoon` (128) around the moving Earth,
from the worker (`orbitPolylines`); re-sampled only when sim time moves a century away (perihelion
precession is ~0.3° a century, sub-pixel).

**The camera.** Distance D from a pivot that slides from the Earth (150 R) to the Sun (4 AU) as
w = 2u² − u⁴, u = D / 4 AU (0.1 R off the Earth at 150 R; the Earth stays within about two thirds
of the half-frame); the view direction is fixed in J2000 ecliptic coordinates (not the turning
Earth), lifted to at least 35° above the ecliptic while zooming out through 3000 R–1.5 AU, with the
camera's up turning from celestial to ecliptic north between 1000 R and 0.5 AU. The crossfade from
the globe runs over 80 → 150 R, smooth in log distance.

**The retrograde figure.** For a selected planet the orrery keeps its last 24 sight lines at fixed
sim-time steps of a 110th of the synodic period (Mars 7.1 d, Jupiter 3.6 d, Mercury 1.05 d), each
from the Earth's heliocentric position through the planet's (both `HelioVector` at t_k = ⌊t / step⌋ ·
step − k · step, so the set does not depend on the frame rate), extended to a backdrop 2.5 × the
largest Earth–planet distance of the set. That is the textbook figure: as the Earth overtakes an
outer planet (or an inner one overtakes the Earth) the lines' ends on the backdrop turn back and
fold into a loop. The fold needs the backdrop farther than v⊕ / ω_retro (≈ 2.5 AU for Mars at
opposition), hence the 2.5 ×. The true loop on the sky is the trails layer's path at infinity, which
the extended lines point into.

### Planet discs, Jupiter's moons and the libration (`js/astro/disc.js`, `js/astro/moons.js`)

The globe's planet medallions (`render/planets.js`) and the Details card's eyepiece portrait
(`ui/eyepiece.js`) draw each body as seen from the observer, from snapshot fields filled at both
detail levels (they cost ≈ 0.03 ms together):

```
ax      = AE.RotationAxis(planet, t − lightTime)          // the instant the light left
R       = Rz(90° + α) · Rx(90° − δ) · Rz(W)               // as for the Moon
poleS   = S · R·ẑ;   primeS = S · R·x̂;   spinDeg = W      // the Moon's from its own matrix
lightS  = normalize(dirS☉ · d☉ − dirS · d)                // body → Sun, from the two topocentric vectors
ringTiltDeg = AE.Illumination(Saturn).ring_tilt           // positive while the south face is seen
galilean = AE.JupiterMoons(t − lightTime♃) / R♃ (scene frame) + flags     // below
libration = AE.Libration(t)                               // 'full' only: it feeds the card
```

- **The disc frame.** `discFrame(dirS, up)` builds `ez` toward the observer, `ey` the projection
  of `up` on the sky plane and `ex = ey × ez`. The medallions and the card use the planet's pole as
  up (planet north up; on a north-up sky east is then left). A true-scale view passes a camera's up
  instead. In that frame `discView` gives the sub-observer latitude `asin(pole·ẑ)` (for Saturn the
  ring opening B), the phase angle `acos(light·ẑ)`, the bright limb's direction and the central
  meridian. The phase angle from `lightS` matches `Illumination`'s within 0.04° for the planets
  (the Moon differs by its ≈ 1° parallax: ours is topocentric, AE's geocentric), and Saturn's
  opening matches `−ring_tilt` within 0.02° (2026-11-03: 6.5°, south face).
- **The impostor.** The shader (`shaders/planets.glsl.js`, and its JS port in the card) ray-traces
  an oblate spheroid (Jupiter 0.065, Saturn 0.098, Mars 0.006) along the IAU pole, lit from
  `lightS`: Venus's crescent and Mars's gibbous disc are exact. Saturn's rings are the plane through
  the centre normal to the pole, with Cassini radii (C, B, Cassini division, A, Encke gap) and
  representative optical depths; the slant opacity is `1 − e^(−τ/|μ|)`, the globe shades the rings
  and the rings shade the globe along the same Sun ray. **Illustrative:** Jupiter's and Saturn's
  belt colours and turbulence, the Great Red Spot (held at System II 55° W, converted to System III
  with the IAU rates, so only right within a year or two of 2026), Mars's albedo (a dozen Gaussian
  areas, fixed polar caps), Mercury's mottling, the tints of Venus, Uranus and Neptune.
- **Magnified on purpose.** A medallion is ~26 CSS px (40 when selected), whatever the planet's
  true 3″–60″; the card's portrait likewise. Both say "magnified".
- **Jupiter's moons.** `AE.JupiterMoons` (L1.2 theory: arcsecond-level near the present, degrading
  far from it) at `t − lightTime♃`, the same instant as Jupiter's astrometric `dirS`; without it Io
  is ~6° off along its orbit. Flags come from lines through each moon against the oblate globe
  (stretched to a unit sphere): the line of sight (**transit** in front, **occulted** behind) and
  the Sun ray (**eclipsed** in Jupiter's shadow; otherwise, on the sunward side, its **shadow**
  falls on Jupiter, flagged when that point faces us). Umbra only, moons as points, so contacts are
  within about a minute: the triple shadow transit of 2015-01-24 comes out 06:28–06:53 UT against
  the published 06:28–06:52 (test). Beyond Jupiter's limb the drawings space the moons by
  `1 + 0.6 · ln r` (true side and order, compressed distance); on the disc they are true.
- **Libration.** `AE.Libration` gives the sub-Earth point (elon, elat). The card names its
  direction ("toward the north-east limb", selenographic) and the limb feature whose distance from
  the disc centre shrank most against the mean (Mare Crisium, Marginis, Smythii, Humboldtianum,
  Australe, Grimaldi, Orientale, Bailly). The portrait samples `moon_1024.jpg` through the Moon's
  pole and prime meridian, so phase, libration and orientation (lunar north up) are the model's.
- **Saturn edge-on.** `saturnEdgeOn(t)` scans the sign of `ring_tilt` forward (adaptive steps, then
  a bisection to a day): from 2026, the run of crossings is Oct 2038 to Jul 2039 (three crossings).

---

## 5. The star sky (`data/sky.json`, `js/data/catalog.js`)

- **Stars.** 5,044 Hipparcos stars to magnitude 6 (via d3-celestial), at their **J2000** positions
  (epoch and equinox), the fastest of them moved by proper motion (§5d). The max tier adds 36,367
  more to V 8.0 (§5f).
- **The telescope's aperture gain.** A narrow sky view reaches fainter stars, 2·log10(25°/FOV)
  magnitudes deeper (3.5 at most), and draws faint stars that much brighter, up to the look of a
  mag-2.5 star (brighter stars keep theirs).
- **Colour.** B−V is turned into a colour temperature with Ballesteros' formula,
  `T = 4600 K · (1/(0.92·(B−V) + 1.7) + 1/(0.92·(B−V) + 0.62))`. Planck's law at that temperature
  is then integrated against the CIE 1931 observer (Wyman–Sloan–Shirley fit) into linear sRGB,
  normalised so the brightest channel is 1.
- **Size and brightness.** Both come from the flux relative to the tier's limiting magnitude,
  `10^(−0.4·(m − m_lim))`.
- **Constellations.** The 88 figures come from d3-celestial. The Milky Way is a 2048×1024 raster
  of its outline levels, sampled through `sceneDirToRaDecUv`.
- **Planet glyphs.** Their size and brightness follow the live magnitude from `AE.Illumination`.

### 5a. Guest stars: the supernovae of 1006–1604 (`js/astro/guest-stars.js`)

- **Where.** Each is a fixed J2000 direction, its remnant's position: SN 1006 (Lupus,
  15h02m48s −41°55′), SN 1054 (the Crab, 5h34m32s +22°01′, 1.1° from ζ Tauri, "near" which the
  Song records place it), SN 1181 (Pa 30, 0h53m11s +67°30′; the identification is recent, Ritter
  et al. 2021, earlier 3C 58), Tycho's (0h25m20s +64°08′) and Kepler's (17h30m42s −21°29′). The
  sky is static in EQJ, so precession comes from the Earth's orientation like every star. Alt/az,
  rise, transit and set use Astronomy Engine's user-defined star (`DefineStar` on `Body.Star8`).
- **When and how bright.** Dated as recorded (Julian before 1582): first sighting, peak and last
  sighting. Before the first recorded local day the star is not drawn. From the first sighting to
  the peak it brightens by 1.2 mag (linear); after the peak a template fades it: type Ia (1006,
  1181, 1572, 1604) 0.1 mag/day for 20 days, 0.03 mag/day to day 50, then a tail of 0.0155 mag/day
  (0.025 for SN 1181, seen for 185 days); SN 1054 2.0 mag over its 23 days of daylight visibility,
  then 0.0159 mag/day, so each crosses mag 5–6 near its last recorded sighting (tested). Peaks:
  −7.5, −6, 0, −4, −2.5, each uncertain by about ±1 mag (±0.5 for 1572 and 1604).
- **Drawn** as stars by the star field's own shader (render/extras.js), so they twinkle, redden
  and fade into twilight like the catalogue; a −6 star fades from view only in full daylight.
  **Illustrative:** the light curve between the records. The Chaco Canyon pictograph "may record"
  SN 1054; that reading is debated.

### 5b. Comets: Halley at five apparitions (`js/astro/comets.js`)

- **Elements.** Heliocentric osculating elements {q, e, i, Ω, ω, T} in the ecliptic and equinox of
  **J2000**, one set per apparition, from JPL Horizons: DASTCOM records 90000018 (1066, solution
  SAO/1066), 90000023 (1456), 90000029 (1910), and osculating elements at perihelion integrated from
  record 90000030 for 1986 and 2061. The old solutions go back to Yeomans & Kiang (1981), whose
  tables are referred to **B1950**; Horizons serves them in J2000. For elements quoted in B1950,
  `elementsB1950ToJ2000` rotates the orbit's P and Q vectors: B1950 ecliptic (ε = 23.4457889°) →
  B1950 equator → FK5 J2000 equator (the FK4 → FK5 matrix of Standish 1982) → J2000 ecliptic
  (ε = 84381.448″). Marsden's B1950 elements of 1986 (Ω = 58.1440°) come out within 0.001° of
  Horizons' J2000 set (Ω = 58.8599°): without the rotation the node would be 0.7° out.
- **Motion.** Two-body Kepler propagation around the Sun (k = 0.01720209895): Newton on Kepler's
  equation from Danby's starter (elliptic), Newton on e sinh H − H = M (hyperbolic), Barker's
  closed form (parabolic). Time is TT (Astronomy Engine's ΔT); T is TDB (≈ TT). Each set is used
  within ±548 days of its perihelion, nowhere else (the comet is not drawn).
- **Where it is seen.** Geocentric = comet(t − τ) − Earth(t) (the snapshot's heliocentric Earth),
  the light time τ iterated three times, then the observer's place on the globe taken off
  (`topocentricScene`) and mapped through S: astrometric J2000, like the bodies.
- **Accuracy.** Against Horizons' own ephemeris from the same records: under 0.3′ at all five
  apparitions (11 dates tested), distances within 2e-4 AU. The two-body model ignores planetary
  perturbations over the ±1.5 years and non-gravitational forces. The *absolute* accuracy for 1066
  and 1456 is about a degree (perihelion time and ΔT), shown as 'approximate'.
- **Brightness.** JPL's total magnitude law m = M1 + 5 log Δ + k1 log r with M1 = 5.5, k1 = 8
  (Horizons' T-mag: 5.06 on 1986-03-15, tested). Drawn while brighter than mag 9.
- **Tails** (illustrative, physically guided). The ion tail runs straight along the heliocentric
  radius vector (anti-Sun) at the light-time epoch; the dust tail curves in the orbit plane:
  comet + L·(s·r̂ − 0.55·s²·v̂), lagging behind the motion. Lengths grow as r⁻² inside 2.5 AU,
  0.04/r² AU (ion, ≤ 0.15 AU) and 0.025/r² AU (dust, ≤ 0.08 AU), widths 0.0006–0.0036 AU and
  0.001–0.01 AU. The 3D samples are projected from the observer, so foreshortening is real (the
  Earth passed through the tail on 19 May 1910). Brightness and length are a model, not a prediction.

### 5c. Spacecraft (`js/astro/craft.js`, `data/craft.json`)

- **Data.** JPL Horizons heliocentric geometric ICRF state vectors (TDB) for Voyager 1 (-31),
  Voyager 2 (-32), New Horizons (-98) and JWST (-170), sampled every 4 days (1 day for JWST) and
  every 2 hours within ±6 days of each flyby, then thinned to adaptive knots: an interval is split
  at its worst sample until cubic Hermite interpolation of the knots' positions and velocities is
  within max(1.2e-5 AU, 2e-5 × the distance from the Earth) of every sample (≈ 4″ far out, about
  1,800 km for JWST). 589 knots (365 of them JWST's halo orbit), 32 KB (`scripts/build-craft.mjs`).
- **Accuracy.** Against Horizons' astrometric RA/Dec: Voyager 1 0.0001°, Voyager 2 at Neptune
  0.0007°, New Horizons at Pluto 0.001°, JWST 0.01° (tested). Past the data (2100 for the Voyagers,
  2050 for New Horizons) they coast in straight lines, labelled 'projected'; JWST is not shown after
  2031-11 (its halo orbit is unknown) or anything before launch.
- **Radio time.** One way, for a message sent now: τ with |craft(t + τ) − Earth(t)| = cτ, iterated.
  Voyager 1 passes one light-day in mid-November 2026 (crossing 24 h on 17–18 November). The beam
  points to where its signal comes from now (light-time corrected).
- **DSN.** 'In view of' Goldstone (35.43° N, 116.89° W), Madrid (40.43° N, 4.25° W) or Canberra
  (35.40° S, 148.98° E) when the craft is at least 6° above that complex's horizon (topocentric,
  geometric). A visibility test, not the DSN schedule: Voyager 2, at −60° declination, is only ever
  in Canberra's view.

### 5c′. Satellites: the ISS, Tiangong, Hubble and bright rocket bodies (`js/astro/sgp4.js`, `js/astro/satellites.js`)

- **Elements.** Two-line element sets (TLEs) from CelesTrak's GP service for six objects: the ISS
  (NORAD 25544), Tiangong's Tianhe core (48274), Hubble (20580) and three SL-16 (Zenit-2) second
  stages (22285, 25407, 31793), in `data/tle.json` (`scripts/fetch-tle.mjs`; the deploy refreshes the
  staged copy daily, the page never goes online for it). Every set is checked: both checksums, the
  catalogue number, near-Earth (period < 225 min), under 30 days old when fetched.
- **Propagation.** Near-Earth SGP4 as revised by Vallado, Crawford, Hujsak & Kelso (2006,
  "Revisiting Spacetrack Report #3", AIAA 2006-6753), with the WGS-72 constants the element sets
  are fitted with: secular J2/J4 and drag (`bstar`), long-period J3, Kepler's equation for the
  true longitude, short-period J2 corrections; the perigee < 220 km simplification and the
  < 156 km atmosphere fix are kept. SDP4 (deep space) is not implemented: such orbits are rejected.
  **Verified** against Vallado's published TEME vectors for every near-Earth case of
  `SGP4-VER.TLE` (00005, 06251, 22312, 28057, 28350, 28872, 29141, 29238, 88888; 158 rows): within
  0.01 mm in position and 0.001 mm/s in velocity (`test/astro.sgp4.test.mjs`).
- **Frames.** SGP4's TEME (true equator, mean equinox of date) becomes Earth-fixed through GMST
  (IAU 1982, Vallado's `gstime`, with UTC for UT1: ≤ 0.4 km at the equator); polar motion (≈ 10 m)
  is ignored. The observer stands on the WGS-84 ellipsoid (geodetic latitude, height). For the
  scene, the topocentric vector goes through the snapshot's `earthMatrix` = S·PN·Rz(GAST)·Sᵀ, so
  EQJ = PN·Rz(GAST − GMST)·TEME, i.e. TEME is turned by the equation of the equinoxes and the
  precession–nutation matrix, as it should be. Between two snapshots the satellite moves with
  time while the Earth's orientation is the snapshot's: against the stars that costs ≤ 7.5″
  (0.5 s of the Earth's turn); against the drawn horizon and globe nothing.
- **Sun and shadow.** The Sun from the Astronomical Almanac's low-precision formulae (mean
  longitude, mean anomaly, equation of centre, obliquity of date; ≈ 0.01°, tested against Astronomy
  Engine to 0.02° and 2e-4 AU). The satellite is lit by the fraction of the Sun's disc the Earth's
  disc leaves uncovered, both seen from the satellite (`shadow.discVisibleFraction`: Sun radius
  asin(R☉/d), Earth radius asin(6378.137 km/r)): a penumbra-correct fade over a few seconds. No
  atmosphere is added to the Earth's disc; real satellites redden and fade a few seconds earlier
  and later than this geometric edge.
- **Brightness (approximate).** m = m₀ − 15.75 + 2.5·log10(ρ² / f), ρ the range in km and
  f = (1 + cos φ)/2 the illuminated fraction of a diffuse sphere at phase angle φ (Sun–satellite–
  observer), so m₀ is the magnitude at 1000 km, half lit (the McCants / Heavens-Above convention),
  minus 2.5·log10 of the sunlit fraction; nothing in the umbra. Standard magnitudes: ISS −1.8,
  Tiangong −0.6, Hubble +2.2, the Zenit stages +2.3 — estimates good to about ±0.5 mag; attitude,
  solar-panel glints and tumbling change the real brightness by a magnitude or more. Atmospheric
  extinction is applied by the star shader in sky view, not in the pass list.
- **Staleness.** TLE positions drift by a few km a day (along-track mostly, more after a reboost or
  under high solar activity), so a satellite is drawn only within 14 days of its elements' epoch,
  is flagged approximate after 3 days, and its card gives the elements' date and age.
- **Passes** (worker): rise and set found on 60 s steps and bisected to 0.5 s; inside, 5 s samples
  of 'visible' — at least 10° up, at least half the Sun's disc on it, the Sun at most −6° (civil
  twilight's end) — refined by bisection; the peak by golden-section search on altitude. A pass is
  listed when its visible part lasts at least 60 s. Times inherit the elements' error: tens of
  seconds after a few days for the ISS. Geometric altitudes (≥ 10°, refraction ≤ 0.1°).

### 5d. Proper motion and the precessing pole (`js/data/catalog.js`, `js/astro/precession.js`)

- **Data.** Proper motions come from Hipparcos, the New Reduction (van Leeuwen 2007; the NASA
  HEASARC table, `scripts/build-stars.mjs` → `data/raw/hip2.json`). sky.json carries `pm` (μα·cos δ
  and μδ, mas/yr) for the 1,183 base stars moving at least 100 mas/yr; slower stars drift less than
  1.7′ per millennium and stay at J2000.
- **Model.** Linear motion in the tangent plane, renormalised:
  `p(t) = normalise(p₀ + t·(μα*·ê_α + μδ·ê_δ))`, t in Julian years from J2000.0, updated in whole
  years (render/sky.js, per snapshot). Radial velocities are not in Hipparcos, so the foreshortening
  of a star's motion as its distance changes is ignored. Arcturus in the year 1000 sits 0.64° from
  its J2000 place, and within 1′ of a rigorous space-motion calculation that includes its −5.2 km/s
  radial velocity (tested); α Centauri moves 1.03° per millennium. Constellation endpoints on a
  moving star (snapped within 0.03° at decode) and star-name labels move with it.
- **The pole and the equinox of date.** `poleOfDate(t)` and `equinoxOfDate(t)` apply Astronomy
  Engine's `Rotation_EQD_EQJ` (IAU 2006 precession, IAU 2000B nutation) to the true pole and the
  true equinox of date: the same pole as the snapshot's `earthMatrix·ŷ` (tested to 1e-6°). Polaris
  is 6.21° from it in 1000, 0.74° in 2000, 0.63° in 2026, 0.46° in 2100 (closest, 2102) and 5.05° in
  3000. The March equinox point leaves Pisces for Aquarius between 2597 and 2600 (IAU boundaries).
  The star card gives a star's distance from the pole of date when it is within 20°.
- **The precession circle (illustrative).** The full 25,772-year circle is drawn as a turn about the
  J2000 ecliptic pole at a fixed obliquity (23.4393°) and a constant 50.287″/yr. Over 1000–3000 it
  agrees with Astronomy Engine to 0.03° (tested); far from the present the obliquity swings
  (22.1–24.5°) and the ecliptic moves, so the pole stars of other ages (Thuban 2830 BCE, within 0.2°;
  Errai ≈ 4100; Alderamin ≈ 7500; Deneb ≈ 10,200, 7° off; Vega ≈ 13,700, 5° off) are labelled
  illustrative. The 1000–3000 track with century ticks is Astronomy Engine's own.

### 5e. Star cards: designations, distance, 'the light left …' (`js/astro/stars.js`, `js/astro/lighttime.js`)

- **Data.** `data/starinfo.json` (built with sky.json): the parallax and its error for every base
  star (Hipparcos New Reduction), and the proper name, Bayer letter, Flamsteed number and variable
  name from d3-celestial's starnames. Designations print with the IAU genitive (α Orionis, 58 Ori).
- **Distance.** d = 1000/ϖ pc (ϖ in mas), 1 pc = 3.2616 ly, with σ_d = d·σ_ϖ/ϖ. A parallax under
  3σ (or ≤ 0) gives only a lower bound ('too far for Hipparcos to measure'). Betelgeuse: 6.55 ±
  0.83 mas, about 500 ly ± 13 % (interferometric and modern estimates are nearer 550–650 ly; the card
  says 'about' and shows the error). Deep (max-tier) stars ship their parallax without an error; a
  typical 1 mas is assumed and the card says so.
- **When the light left.** The simulated year minus the light-time, rounded to what σ supports: the
  year itself (σ < 1.5 yr, under 100 ly), the decade (σ < 8 yr), the century (σ < 80 yr), else
  'about N years ago, give or take'. A moment of history is quoted only within that uncertainty
  ('around the 1500s — when Copernicus put the Sun at the centre'); past 5,000 years, an event
  within 10 % of the light-time or the first one after the light left ('before people painted the
  first cave art').
- **Kind (illustrative).** Colour words and a spectral letter from B−V (B < 0, A < 0.3, F < 0.58,
  G < 0.81, K < 1.4, M), and giant or supergiant from the absolute magnitude against a rough main
  sequence (supergiant: M_V < −3.5 and 3 mag over it; giant: 2.5 mag over it). Real classes come
  from spectra.

### 5f. Deep-sky objects and the max tier's deeper stars (`js/astro/dso.js`, `render/dso.js`)

- **Data.** `data/dso.json` (`scripts/build-dso.mjs`, 10 KB): the 110 Messier objects (positions,
  magnitudes and sizes from d3-celestial's messier.json; the Orion Nebula's position corrected to
  the catalogue value) and 30 showpieces (the Magellanic Clouds, ω Centauri, 47 Tucanae, the Carina
  Nebula, the Double Cluster, …) hand-entered from NGC/IC values; distances (SEDS, NED, Harris
  2010) and position angles (RC3/NED) rounded. Positions agree with published J2000 values within
  0.05° (tested for nine objects). Distances are uncertain by 10–30 % (galaxies more): the light-time
  line says 'about'.
- **Visibility (illustrative).** An object counts as fainter than its total magnitude by
  0.8·log10(major axis in ′) (M31 3.4 → 5.2, M13 5.8 → 6.8, the LMC 0.9 → 3.2) and is compared with
  the stars' own limit at its place (twilight, moonlight, light pollution, the aperture gain). Real
  detection depends on surface-brightness contrast; this keeps naked-eye showpieces right (M31,
  M42, ω Cen, the Clouds under a dark sky; not under a city's) and makes most Messier objects
  telescope-only.
- **Drawing (illustrative).** True size and position angle; per-type profiles (exponential disc and
  bulge, King profile, ring, fbm noise) kept to faint grey smudges, with structure (arms, resolved
  stars, noise octaves) fading in only as an object grows past ~20 px. Asterisms are not drawn.
- **Deeper stars (max).** `data/stars8.json` (`scripts/build-stars.mjs`): the 36,367 stars of
  d3-celestial's stars.8 (Hipparcos, V 6.01–8.00) not in the base catalogue, with their parallax. The
  max tier appends them to the star field (`mergeDeepStars`; base indices unchanged), so a dark
  wide field reaches the naked eye's 6.5 and the aperture gain reveals real stars to V 8 (≈ 1 per
  square degree; the Beehive's members at a 1° field). Their proper motion is not applied.

---

## 6. Refraction, extinction, twilight, exposure (`js/astro/photometry.js`)

- **Refraction.** `refractionDeg(h)` uses the Sæmundsson formula for a true altitude h,
  `R = 1.02′ / tan(h + 10.3°/(h + 5.11°))`, clamped at −1° and tapered to 0 at the nadir.
  `refractionDeg(0) ≈ 0.483°`. It mirrors Astronomy Engine's `Refraction('normal', h)` exactly, so
  the 'frame' pass and `AE.Horizon(…, 'normal')` in the tables agree.
- **Refraction in the sky view.** The sky view draws apparent positions. Every direction at
  infinity (stars, Milky Way, constellation lines, grids of the celestial sphere, trails, the Sun,
  planets, Baily's beads, the selection reticle) is lifted toward the zenith by `k·R(h)`, keeping its
  azimuth: `refractLift` in `REFRACT_CHUNK` (`shaders/sky.glsl.js`), with `k` the view blend (0 in
  orbit view), and `liftByRefraction` in JS for picking, labels and the flare, the same formula.
  The alt-az grid is not lifted: it is drawn in apparent coordinates already. The Moon, a 3D mesh,
  is lifted vertex by vertex about the camera, which also flattens it near the horizon. The Sun's
  disc is flattened per fragment: each fragment's apparent altitude goes back to true altitude
  through Bennett's formula `R = 1′ / tan(h + 7.31°/(h + 4.4°))` (`refractionFromApparentDeg`, the
  inverse of Sæmundsson to 0.1′ above −0.6°), relative to the centre. At the horizon the vertical
  diameter shrinks by about a fifth and the lower limb is squeezed most. Result: at
  `SearchRiseSet`'s sunset (Paris, 2026-11-03 16:27:08 UTC) the geometric centre is at −0.83° but
  the drawn upper limb sits on the horizon (within 0.1°, tested), where it used to be drawn 0.84°
  under the ground. The lift is physical (the standard 'normal' refraction, 10 °C, 1010 hPa); the
  eclipse geometry (`obscurationAtObserver`) stays unrefracted, which is off by the differential
  refraction across the discs (≲ 0.1° at the horizon) for an eclipse on the horizon.
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

  The world map (§6c) draws the same boundaries across the whole Earth as contour lines.

- **Sky-view exposure.** It blends from 1 in orbit view (skyBlend 0) to these curves in sky view:
  - stars: `min(max(1 − smoothstep(−18°, −4°, h☉), eclipse term), sky term)`;
  - planets: `max(0.15, 1 − 0.85·smoothstep(−8°, 4°, h☉))`;
  - Milky Way: `1 − smoothstep(−20°, −10°, h☉)`.

  Stars fade with the dawn, and Venus and Jupiter stay visible in twilight. The sky term is the
  exposure that puts the star limit at the night sky's own zenith limit (§6a: the Moon and light
  pollution). The daylight dome is the Preetham–Shirley–Smits analytic sky driven by the true Sun.
- **Star limit.** The star shader shows stars to `lim = −1 + (m_tier + 1)·√e` for star exposure
  `e`, where `m_tier` is the tier's dark-sky limit (5.0 / 6.0 / 6.5); `starLimitMag` and
  `starExposureForLimit` convert both ways. A star of magnitude m is drawn at
  `smoothstep(lim + 0.35, lim − 0.45, m)·smoothstep(0, 0.04, e)` (`starVisibility`). Star names use
  the same curve, so a name never outlives its star; constellation names need `e ≳ 0.3`.
- **Totality's stars.** The eclipse term is specified in magnitudes, so every tier shows the same
  stars. The photosphere left shines `L = (1 − obscuration)^1.4` of full (limb darkening makes the
  last crescent dimmer than its area). On top of the totality sky's own 10⁻⁵ of daylight, the limit
  is `m = 2.0 − 1.25·log10(1 + L / 10⁻⁵)`, since against a bright background the threshold flux grows
  about as √B. In totality that is magnitude 2.0: the planets and roughly the first- and
  second-magnitude stars. Real totality skies reach about 1.5 to 3 with the umbra's size and haze,
  so 2.0 is a mid value. At 10⁻⁴ of the sunlight left (Luxor: about 20 s before second contact) only
  Sirius-class stars show (m ≈ 0.7). The old term reached magnitude 5.7 on high (the Beehive
  cluster) and started 2.8 minutes before second contact. The Milky Way stays a function of h☉
  (dark only at night). The frame loop uses the same star exposure to decide whether twinkle
  needs frames.

- **Low Sun.** Preetham keeps the forward-scattered (Mie) glow of a setting Sun nearly white,
  and on screen that glow washed the reddened disc out to cream. The sky view corrects it:
  - below 12°, the Mie lobe is tinted with the Sun's own extinction colour (`extinctionRGB` in
    `render/bodies.js`, k = 0.10/0.17/0.30 mag per airmass in R/G/B, normalised to red);
  - below 12°, the sky's highlight knee drops toward luminance 0.4, so the aureole keeps its hue
    under ACES. It lets go again between 0° and −3°, where the twilight model takes over;
  - the Sun's disc covers the sky behind it, as the real disc outshines the air in front of it;
  - the lens flare dims with the Sun's green transmission, at 3× by day easing to 1× below 6°,
    with no floor.

  The disc then reads amber at +1.5°, orange at +1° and deep orange to red below +0.5°.

- **The ground in twilight and moonlight** (`GROUND_FRAG`, display-referred, illustrative). The
  land's skylight follows the dome's own twilight factor, `smoothFall(4°, −1°, h☉)·e^(h☉/5.5°)`, in
  a blue-grey: about 0.025 at −3°, 0.015 at −6° and 0.003 at −12° (linear, before ACES), gone by
  −17°. The horizon haze band above it gets more of the same light, so the horizon stays about
  twice as bright as the land and still reads. A bright Moon silvers the land: its brightness
  `√(10^(−0.4(m − m_full)))` (m_full = −12.7), times `√sin h☾`, times the sunlight left on it in a
  lunar eclipse, only once the daylight has gone. These levels are tuned to read on a display, not
  measured. On a portrait screen the sky view's default look is 25° up (15° otherwise) when the
  link carries no camera, so the ground takes less of the screen.

- **Illustrative landscape** (`js/geo/horizon.js`, layer "Illustrative landscape", on by default).
  The sky view's horizon is a made-up silhouette for each place, not surveyed terrain:
  - a far ridge from periodic value noise, at most 0.5° (a 1.5° ridge would move sunset by
    minutes against the panel);
  - a near band of tree crowns, or of rooftops (flat or gabled, chimneys, the odd tower or dome)
    where the cities within 30 km (data/cities.json, weighted by `e^(−d/6 km)`) add up to a town,
    at most 1.2°. Trees thin out past the Arctic tree line (66–72° N) and stop south of 60° S, where
    the far ridge of ice or rock is the horizon. Deserts still get trees: there is no land-cover
    data;
  - flat sea in the azimuths whose far ground (6–30 km out) is water on the ocean mask the globe
    already loads, with a Fresnel sky reflection and an analytic glitter path under the Sun and the
    Moon (Cox–Munk slopes, variance 0.02: one calm wind).

  Everything random is seeded by the place rounded to 0.1°, so a place keeps its horizon. The
  profile has 2048 azimuth samples, linear in between, uploaded as a float texture; the flare,
  picking and the labels read the same array, so nothing is drawn behind a hill and still clickable
  or flaring. The almanac, the rise and set times, the Sky panel's up/down and the beams keep the
  mathematical horizon: with the landscape on, the Sun disappears behind a 0.3° ridge about two
  minutes before the printed sunset at mid-latitudes. Turn the layer off to see the flat horizon
  (the old look).

## 6a. Night-sky brightness, light pollution and night vision (`js/astro/skyglow.js`)

The night sky has its own light: airglow, the Moon's scattered light and the glow of cities.
`computeSkyglow` fills `snap.skyglow` after every snapshot (the frame loop owns the site) and
`js/render/shaders/skyglow.glsl.js` evaluates the same model per direction. Brightness is kept in
natural-sky units R = B / B_nat, where B_nat ≈ 54 nL is a dark site's moonless zenith
(22.0 mag/arcsec²), so a direction's SQM reading is `22.0 − 2.5·log10 R`.

- **Units.** `B(nL) = 34.08·exp(20.7233 − 0.92104·V)` for V in mag/arcsec² (KS91 eq. 1).
- **Natural sky** (physical). Airglow brightens toward the horizon as it is seen through more of
  its layer: `R = X·10^(−0.4·k·(X − 1))`, `X = (1 − 0.96·sin²Z)^−½`, k = 0.172 (KS91 eq. 2). That is
  1 at the zenith and about 2.7 at the horizon.
- **Moonlit sky** (physical, Krisciunas & Schaefer 1991 eqs. 15–21):
  `B = f(ρ)·I*·10^(−0.4·k·X(Z_moon))·(1 − 10^(−0.4·k·X(Z)))`, with
  `f(ρ) = 10^5.36·(1.06 + cos²ρ) + 10^(6.15 − ρ/40)` (Rayleigh plus Mie, ρ ≥ 10°) and
  `I* = 10^(−0.4·(3.84 + 0.026·|α| + 4·10⁻⁹·α⁴))` for phase angle α. A lunar eclipse scales I* by the
  Moon's unshadowed light (plus 2·10⁻⁴ for the copper Moon). A full Moon at 60° makes the zenith
  about 17.9 mag/arcsec²; a quarter Moon about 10× less.
- **Light pollution** (an estimate). Each city of population P in `data/cities.json` within 300 km
  adds Walker's law (1977), `I = 0.01·P·d^−2.5` at 45° toward the city, relative to the natural sky.
  Walker's law diverges near a city, so it is combined harmonically with a city-core cap
  `40·(P/10⁶)^⅓` (city-centre readings grow slowly with size: about 19.5 for 15 000 people, 18.0 for a
  million, 17.2 for ten million). With a nearness `n = r²/(r² + d²)` (urban radius
  `r = 0.006·√P` km), the city adds `W·(n + 0.35·(1 − n))` at the zenith and
  `W·(1.6·n + (1 − n)·(0.3 + 3.1·lobe))` at the horizon in each of 16 azimuth bins, with
  `lobe = ((1 + cos Δaz)/2)^(2 + 10·(1 − n))`. Between them the dome falls from the horizon to the
  zenith value as `(e^(−h/34°) − e^(−90°/34°)) / (1 − e^(−90°/34°))`, which puts a distant city's
  45° value back on Walker's law. The shape is Garstang-like but fitted, not modelled. Only large
  cities are listed, so small-town glow is missing. Calibration: Ho Chi Minh City, Paris and New York
  come out Bortle 9 (SQM 16.6–17.7); Paranal and Mauna Kea come out Bortle 1.
- **Sky darkness setting.** 'Auto' uses that estimate. A Bortle class 1…9 uses a uniform dome at the
  class's representative SQM (21.995, 21.94, 21.79, 21.09, 20.0, 19.22, 18.66, 18.09, 17.4), with the
  horizon 1.6× the zenith. 'Pristine' has no artificial light. The setting is persisted, and a link
  carries it as `sky=`.
- **Bortle class** from the moonless zenith SQM, by the lower bounds 21.99, 21.89, 21.69, 20.49,
  19.50, 18.94, 18.38 and 17.80 for classes 1…8. A reading below 17.80 is class 9.
- **Limiting magnitude** (`photometry.limitingMag`): `m = 7.93 − 5·log10(10^(4.316 − SQM/5) + 1)`.
  This is the Schaefer-type fit behind Unihedron's SQM → NELM conversion: 6.6 at 22.0, 6.1 at 21.0,
  4.1 at 18.2. The zenith value caps the star exposure (above), and the star shader moves each
  star's limit by its own sky's limit minus the zenith's. So stars near the Moon and under a light
  dome go first. The Sky panel says 'Bortle 8 · limiting mag 4.1' once the Sun is 15° down, text
  mode included.
- **Milky Way and zodiacal light** fade with the local excess over the natural sky,
  `Δm = 2.5·log10(R / R_nat)`. The Milky Way is scaled by `1 − smoothstep(0.1, 3.4, Δm)`, so it is gone
  by about Bortle 6–7 or under a full Moon. The zodiacal light uses `1 − smoothstep(0.1, 1.5, Δm)`,
  so it shows at Bortle 1–4 without the Moon.
- **Zodiacal light and gegenschein** (medium tier and up). These are drawn in the Milky Way pass
  from Leinert et al. (1998, A&AS 127, 1) Table 17, in S10 units (1 S10 = 27.78 mag/arcsec², so the
  natural sky is about 205 S10): 19 helio-ecliptic longitudes |Δλ| by 11 latitudes |β|, interpolated
  bilinearly in log brightness (`skyglow.js` `zodiacalS10`, mirrored in the shader). The eight blank
  cells within about 12° of the Sun are extrapolated; they are never seen at night. Only the excess
  over the ecliptic poles' 77 S10 is drawn, since the natural sky already contains that. So the cone
  leans along the ecliptic, about 3–4 times brighter there than at the same distance straight above
  or below the Sun, and the gegenschein is the table's broad bump opposite the Sun. The display gain
  puts the band 90° from the Sun at the edge of visibility and the cone 30° from it at about the
  Milky Way's brightness, faded by extinction toward the horizon and by twilight.
- **Airglow colour** (illustrative). The horizon airglow band leans from blue-grey toward the green
  of the 557.7 nm [O I] line under a dark sky (the dark-sky gate at the zenith), subtly, since night
  vision is nearly colourless.
- **The dome and the ground** (display mapping, illustrative). In sky view at night, the dome adds
  the moonlit sky (blue Rayleigh light, a white Mie aureole round the Moon) and the light dome
  (sodium/LED orange) as `0.0029·R^0.6` in display units. A city's R ≈ 100 reads as a dim orange sky;
  a full Moon's R ≈ 40 reads as a deep slate blue; R ≲ 5 vanishes in ACES's toe. The ground takes
  the Moon's and the cities' light at the same scale. Both fade out between h☉ = −12° and −4°.
- **Night vision** (illustrative). `adaptingLuminance` adds three parts:
  - the twilight sky's zenith luminance, interpolated in log10 cd/m² through −4.6, −2.6, 0 and 2.2
    at h☉ = −18°, −12°, −6° and 0° (dimmed by a solar eclipse);
  - the night sky (1 nL = 10⁻⁵/π cd/m²);
  - in towns, 0.01 cd/m² per unit of artificial zenith light, for lit streets.

  `scotopicWeight` falls from 1 to 0 across the mesopic range 0.005–3 cd/m² (smoothstep in log L).
  In sky view the final pass (medium tier and up) mixes dim pixels toward their rod luminance
  `0.06·R + 0.56·G + 0.38·B`, tinted blue (0.86, 1.0, 1.40), by up to 50 % of that weight. Bright
  stars, planets and the Moon keep their colour. A dark site is fully scotopic; a city centre stays
  mesopic. There is no dark-adaptation timer.
- **Chromatic scintillation** (illustrative, high and max tiers). Dispersion splits each colour's
  path through the turbulence, so bright low stars flash colours. The star shader adds per-channel
  phases `(0, 0.9, 1.7)·X` (Kasten–Young airmass) to a ~3 Hz tone, with amplitude
  `0.45·smoothstep(1.5, 40, F)·(1 − sin h)²` (F = flux relative to magnitude 2.5) around a constant
  luminance. Sirius on the horizon cycles through green, pink and orange. Reduced motion turns
  twinkle off, and twinkle-only frames stay capped at 30 Hz.

---

## 6b. The globe's night side and clouds: moonlight, city lights, aurora (`js/astro/geomag.js`, `render/earth.js`, `render/aurora.js`)

### Moonlight and moonglint (perceptual)

- **Moonlight.** The night hemisphere is lit toward the Moon: `albedo·(0.002 + 0.02·K·max(N·M, 0))`
  in a cool, desaturated tint, where M is the direction to the true Moon (`snap.moonPosS`) and
  `K = phaseFrac × eclipse.moonLitFraction` (AE's illuminated fraction, and zero in a total lunar
  eclipse). The 0.002 floor stands for starlight and airglow. The geometry takes care of the phase
  too: at new Moon the Moon stands over the day side, so the night side goes black and the cities
  stand out. Real moonlight is about 4·10⁻⁶ of sunlight; the 0.02 is a perceptual gain, like the
  clearer-than-life haze. The cloud deck gets the same term (wrapped, as clouds are volumes).
- **Moonglint** (Medium and up). The ocean's GGX sheen lobe (α 0.2) plus a soft core (α 0.09),
  evaluated with M instead of the Sun, times `0.6·K`, on open water outside clouds on the night
  side: the silver path of astronaut photos. Only its core can reach the bloom threshold.

### City lights at close zoom (illustrative below a texel)

Magnified (lod < 0), the night map is read with the 4-tap cubic B-spline instead of bilinear, on the
4096 and 8192 map alike. Below lod −1.5, an Earth-fixed point field (2×2 cells per texel, one hashed
point each, normalised so each cell keeps its energy, radius never under a pixel) breaks the blobs
into grain: invented detail, faint, and gone before the texels shrink to a couple of pixels.
Texels whose brightest channel is near 1 (clipped cores, about 4.6 % of the lit texels) get up to
2.5× more light, so city centres bloom harder than suburbs. A per-cell jitter of ±0.015 in the Sun's
cosine (about ±0.9°) switches lights on progressively across the terminator.

### Sculpted clouds (illustrative relief)

The one cloud map is read as a height field, h = density × 0.004 Earth radii (a heuristic that
treats thin cirrus as low cloud). Relief normals come from central differences on mip lod + 1
(every cloud tier; on Max the 8192 map, so the relief is finer). High and Max march 4 taps toward the
Sun and darken the deck where taller cloud stands above the rising sun ray, `exp(−1.6·Σ excess / H)`,
so a low Sun lays long shadows across lower decks. Reflectance follows a Beer-powder curve,
`(1 − e^−τ)(1 − ½e^−2τ)` with τ = 8 × density, so thin wisps read grey. A Henyey-Greenstein forward
lobe (g = 0.6), on thin cloud only and soft-capped at 3.5×, adds silver linings when the Sun is
behind the clouds near the limb. When magnified, value noise at 2 and 8 cells per texel (each
octave only once its cells span a few pixels) erodes the edges. At home distance a texel of the
4096 map is a few pixels, so this reads as texture in the terminator band, not an orbital-photo
landscape. The ground's cloud shadows use the unmodified density, so they stay registered.

### Aurora (`js/astro/geomag.js`; modelled oval, illustrative curtains)

- **Geomagnetic frame.** The centred dipole of IGRF-14: the boreal pole is at
  `(−g11, −h11, −g10)/B0` in Earth-fixed coordinates, with g10, g11, h11 interpolated linearly between
  the 5-year epochs 1900–2025 and extrapolated with the 2025–2030 secular variation (12.6, 10.0,
  −21.5 nT/yr). 2020: 80.6° N, 72.7° W; 2025: 80.8° N, 72.8° W. **Outside 1900–2030 the nearest end is
  held** (the 1900 or 2030 pole): the field is not modelled for the clock's 1000–3000 range, so far
  from the present the oval is drawn where it would be in 1900 or 2030. Magnetic local time is the
  angle about that axis from the Sun's direction (noon) plus 12 h.
- **Oval boundaries.** Starkov (1994), as tabulated by Sigernes et al. (2011, Table 1): in corrected
  geomagnetic colatitude, `θ = A0 + A1·cos 15°(t + α1) + A2·cos 15°(2t + α2) + A3·cos 15°(3t + α3)`
  over MLT t (h), each Ai and αi a cubic in log10|AL|, with `AL = 18 − 12.3·Kp + 27.2·Kp² − 2·Kp³`.
  The poleward and equatorward edges at MLT 0…23 h form the 48-float `snap.aurora.ovals`. Kp 3: the
  equatorward edge is at 64° near midnight and 73° near noon; Kp 7: 60° and 70°. The centred dipole
  stands in for corrected geomagnetic coordinates, which differ by a few degrees in places, and the
  same oval is mirrored into the south.
- **Activity is a setting, not data.** Settings → Aurora activity: quiet, typical, storm (Kp 1, 3,
  7). The app fetches no space-weather feed (offline-first; no external URLs), so the Settings hint
  and the Sky panel say "modelled … not a forecast". The Sky panel line ("Under the aurora oval",
  "Aurora oval low in the north") appears once the Sun is 12° down and the oval is within about 8° of
  latitude (≈ 900 km, where an aurora at 110 km is still above the horizon).
- **Drawn emission (illustrative).** Inside the band: three folded arcs that fade in and out along
  the oval, fine rays, a faint diffuse glow just equatorward, brightest before magnetic midnight and
  faint at the dayside cusp; green 557.7 nm, with red 630.0 nm toward the poleward edge, on the
  dayside and, in storms, low down. Their drift is a whole number of laps per 65 536 s of simulated
  time. Seen from above, the surface and cloud shaders add the column where the view ray crosses the
  110 km shell (so it sits at its altitude), brightened by the slant of the path up to 2.5×. On High
  and Max a shell marches the view ray through 90–300 km in altitude steps with vertical profiles
  that each integrate to that column (green from a sharp ~100 km edge with a ray-dependent upward
  tail, red around 235 km, a violet fringe at the bottom in storms), so curtains stand above the
  limb; it takes over from the face-on term as n·V falls from 0.45 to 0.15. Only on the night side
  (Sun more than about 2° below the point's horizon). Brightness is perceptual and stays under the
  bloom threshold except in the storm setting and at the limb.

## 6c. The world map and two places (`js/geo/mapview.js`, `js/astro/parallax.js`)

### The world map (equirectangular, lit like the globe)

The map is the globe's own equirectangular texture laid flat: x = λ, y = φ (radians, one plane unit
each), longitude 0 in the middle. φ is the latitude of the point on the unit sphere, the one the
texture, the pin and the sub-points use (the pin sits at the geodetic latitude, §3). Every point is
lit from the sphere it came from: the Sun's altitude at a place is asin(n·s) with n the sphere's
normal and s the geocentric Sun, so the terminator and the twilight bands are geocentric and
unrefracted. The contour lines are where that altitude is −0.833° (sunrise and sunset: the upper
limb on the refracted horizon, gold), −6° (civil), −12° (nautical) and −18° (astronomical twilight,
fading blue); a place's own Sky now panel, which uses the topocentric, refracted Sun, agrees within
a fraction of a degree of altitude (a few kilometres to ~100 km across the map, most near the poles).
Sub-points are geocentric (§8). The Moon's shadow in an eclipse is the same umbra and penumbra as on
the globe. The rows within one sphere segment of each pole (1.4°–5.6° by tier) are not drawn.

### Two places and the Moon's parallax

Seen at the same instant from two places, a body's topocentric directions differ by its parallax.
`compareSight` measures the angle θ between the two `dirS` and the baseline B between the two pins
(a chord through the Earth, Earth radii × 6378.137 km), splits off B⊥, the part square to the mean
line of sight, and reports d = B⊥ / (2 sin(θ/2)): the distance at which the two sightlines meet,
the triangulation Lalande (Berlin) and Lacaille (the Cape of Good Hope) used in 1751–52. From Berlin
and Cape Town (B ≈ 8,700 km) the Moon is ~1.35° apart and d lands within 1 % of its topocentric
distance; the Sun moves by ~12″ and planets by under 2″, so their beams stay parallel on the globe.
The small error comes from the pins sitting on a sphere instead of WGS84 (§8) and from the baseline
not being exactly square to both lines.

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
  - lunar eclipses. A partial or total one is *visible here* when the Moon's centre is above the
    horizon at any time between U1 and U4 (sampled every 5 minutes, crossings bisected), so
    eclipses at moonrise and moonset count; a penumbral one is judged at mid-eclipse. Contacts
    P1, U1, U2, U3, U4 and P4 are the peak ∓ `sd_penum`, `sd_partial`, `sd_total`. `visibleMs`,
    where a jump lands, is mid-eclipse when the Moon is up then, else 15 minutes inside the visible
    part nearest it (after moonrise or before moonset), so a jump never lands on a Moon below
    the horizon;
  - global solar eclipses, with the point of greatest eclipse and the central duration there
    (`SearchLocalSolarEclipse` at that point);
  - local solar eclipses with the obscuration here and all of Astronomy Engine's local
    circumstances: C1–C4 and maximum, the central duration, and the Sun's altitude at each. The
    detail reads "Totality 13:01:49–13:08:14 (6 m 25 s), Sun 82° up. Partial phases 11:40–14:26."
    in the observer's zone (seconds truncated, like a clock). "Total" or "annular … visible here"
    needs the central phase itself above the horizon, by Astronomy Engine's refracted Sun-centre
    altitude plus 0.27° for the upper limb. Only part of it above gives "at sunrise" or "at
    sunset"; none of it gives a partial eclipse with the central phase below the horizon. The
    obscuration is quoted only when maximum itself is above the horizon ("Partial solar eclipse
    visible here at sunrise" otherwise), and `visibleMs` is then 10 minutes after sunrise (or
    before sunset), bisected on the upper limb;
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
- **The Sun's size.** Every solar radius is `sunAngularRadius(d) = asin(R☉ / d)` with
  R☉ = 695 700 km (`js/astro/bodies.js`, Astronomy Engine's value), at the live distance: 943.5″
  at aphelion, 975.5″ at perihelion. The globe shaders used to take a constant 960″, which drew the
  umbra of 2027-08-02 about 19 % too narrow (104 km instead of 129 km half-width) and the antumbra
  of 2027-02-06 too wide.
- **Solar eclipse.** Each Earth fragment dims by the fraction of the solar disc hidden by the Moon
  as seen from that point. The umbra and penumbra appear in the right place. This uses the
  geocentric aberrated Sun and the geometric Moon, Astronomy Engine's eclipse geometry.
- **Lunar eclipse.** Each Moon fragment dims by Earth's disc as seen from the Moon, with a red
  "all the sunsets" term where the Sun is (nearly) hidden. That term is exposed for totality and
  scaled by `1 / (1 + lit / 0.015)` (`lit` = `eclipse.moonLitFraction`), so during the partial
  phases the sunlit cap stays grey-white and the umbra reads dark, as the eye sees it.
- **One geometry at the observer.** The obscuration at the observer, the discs drawn in sky view,
  the lens flare and the Sky panel all use the same two discs:
  - the Sun's and the Moon's `dirS` (WGS84 topocentric; their separation is the apparent one, §4);
  - the radii `asin(R / d)` at the topocentric distances.

  In sky view the Moon mesh sits at `eye + dirS☾ · distER☾`, so from the eye it has exactly that
  direction and size. Orbit view keeps the geocentric `moonPosS`, and the transitions blend the
  two, which differ by ≤ 0.01 Earth radii. Second and third contact then fall within 0.1 s of
  `AE.SearchLocalSolarEclipse` (2026-08-12 at Burgos and Reykjavik, 2027-08-02 at Luxor, 2028-07-22
  at Sydney, and the annular 2027-02-06 at Accra; tested). The frame snapshot is refreshed every
  0.5 s of simulated time, which bounds the visible lag. Before, the drawn discs reached totality
  35 s late at Luxor, the sky darkened 17.5 s early, and the panel could read "Partial solar
  eclipse, 100.0 % of the Sun covered". The panel now says *Total* exactly while the obscuration
  is 1.
- **Sky view in a solar eclipse.** The Sun's glare scales with the part of the disc left visible
  (adapted as `(1 − obscuration)^0.56`, like the daylight), and the ground darkens with the sky.
  In totality (obscuration exactly 1) the photosphere is not drawn at all. Otherwise the disc's
  1 px anti-aliased rim, and its 3 px minimum size in a wide view, left a ring of sunlight around
  the Moon. The stars follow §6. Totality has its own subsection below.

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
- **Jumping to an eclipse.** In globe view the camera flies over the event's point of greatest
  eclipse (from Astronomy Engine), or, when there is none (a partial eclipse), over the point where
  the shadow axis meets the Earth: `P = m − t·ŝ` with `|P| = 1`, solved for the nearer root
  (`shadowPoint` in `js/astro/eclipse-path.js`, re-exported by `js/app/actions.js`). For
  2027-02-06 15:59:33 UTC the axis gives 31.1° S, 48.5° W, within 30 km of the published point of
  greatest eclipse (31.3° S, 48.5° W; tested in `test/app.actions.test.mjs`). In sky view a local
  total or annular eclipse lands 20 s before C2 (C3 when only C3 is above the horizon), playing at
  1×, at a 5° field aimed at the Sun's place half-way to C3, so the Sun's drift (≈ 0.25°/min)
  keeps it in the field through totality; a partial lands on `visibleMs` at 10°.
- **Path of a central eclipse** (`eclipsePath`, `js/astro/eclipse-path.js`, the astro worker's
  `eclipsePath` op). Astronomy Engine's own shadow model, so it agrees with its local
  circumstances:
  - The axis runs from the geocentric aberrated Sun through the geometric Moon. Both are taken to
    the Earth-fixed frame of date with `E(t)ᵀ` (§2, Earth orientation), and the axis is intersected with AE's
    ellipsoid (a = 6378.1366 km, b/a = 0.996647) by dilating z, nearer root. Geodetic latitude
    is `atan(z / ((b/a)²·ρ))`.
  - The umbra's radius at axial distance τ from the Moon is `k(τ) = R☾ − τ·(R☉ − R☾)/|S→M|`
    (R☾ = 1737.4 km, AE's mean radius; R☉ = 695 700 km). A negative k is the antumbra (annular);
    a sign change along the path makes it hybrid.
  - Each limit is where an edge ray of the cone meets the ellipsoid. The ray is the cone's
    generator in the plane of the axis and ê: it leaves the Moon's limb at ±R☾·ê and closes on
    the axis at the cone's half-angle, so it is exactly |k(τ)| from the axis at every τ. ê is
    square to the axis and to the shadow's motion over the ground (the centre point ±5 s,
    projected square to the axis), the envelope condition of the moving footprint.
  - The ends, where the axis first and last touches the Earth, are bisected to 20 ms. Rows are a
    minute apart and split wherever consecutive points are more than 120 km apart, which happens
    near the ends, where the ground speed diverges. There the footprint stretches along the horizon
    and a limit ray that misses the Earth is clamped to the limb, so the limits fan out into the
    sunrise and sunset curves.
  - Results against NASA's *Five Millennium Canon*: 2027-08-02 greatest 25.49° N 33.19° E (NASA
    25.50° N 33.18° E), width 261 km (258); 2026-08-12 65.22° N 25.25° W, 299 km (294);
    2027-02-06 annular 31.29° S 48.47° W, 278 km (282); 2023-04-20 hybrid, 52 km (49). The
    widths run about 1.5 % from NASA's, which shrinks the Moon's radius for the umbral limits
    (k = 0.272281); the duration at greatest eclipse and for cities is AE's
    `SearchLocalSolarEclipse` C2–C3, the event card's number (Luxor 384.7 s).
  - `citiesInPath` screens the offline cities by cross-track distance against the local
    half-width plus 25 km, then confirms the largest with `SearchLocalSolarEclipse` (≈ 1.4 ms
    each, at most 4n + 8): a city counts when its central phase has the Sun's upper limb up at
    C2 or C3. Aswan, 99.8 % covered, is just outside on 2027-08-02; Luxor and Qena are inside.
- **The path on the globe** (`render/eclipse-path.js`, from `ribbonMesh`). The samples go on the
  globe's sphere at their geodetic latitude, like the pin and the texture (≤ 21 km off the
  ellipsoid, a tenth of the band). Each row gets 9 vertices across the band, slerped from the
  centre point to each limit on the sphere, so the fanned ends (limits thousands of km apart) stay
  on it; the ribbon floats at r = 1.007, just over the cloud shell (≈ 45 km; at the chase's oblique
  view that is ≲ 55 km of parallax). The live marker sits at `pathFrameLocal(path, t)`, the same
  unit-vector interpolation as `pathAt`, with a ring at 1.25 × the shadow's radius on the centre
  line and a chevron along the motion (the centre line ±60 s). The ribbon leaves a soft hole 0.9–2.2
  shadow radii around it, so the umbra reads as the shader's own dark spot: the shader's umbra is
  where the snapshot's axis meets the sphere (`shadowPoint`), within ~20 km of the marker.
- **Getting out of the umbra's way.** `umbraNear(snap, near, far)` is 1 while the snapshot's axis
  meets the sphere within `near` of the observer's zenith direction, easing to 0 at `far`: the pin
  (0.28 → 0.42 rad) keeps only its disc's rim and cardinal ticks and shrinks; the beams (0.035 →
  0.07 rad) leave a hole of 0.03 Earth radii around their roots on screen. At the default zoom the
  umbra of 2027-08-02 is ~9 px in radius, which the pin head and seven converging beams used to
  cover.
- **The shadow chase** samples nothing new: the camera target is `pathFrameLocal` at the frame
  snapshot's instant (refreshed every frame while the clock runs faster than real time), and the
  clock covers the path (3 h 23 min on 2027-08-02) in 40 s (~300×), easing quadratically into and out of greatest
  eclipse (`clock.setRange({ease})`).

### Totality from the ground (`js/astro/totality.js`, `render/bodies.js`, `render/totality.js`)

Everything is placed by the snapshot's Sun–Moon `dirS` pair, the discs that give the obscuration
and AE's contacts to 0.1 s; the shapes are illustrative.

- **The last crescent.** Once it is under ~1.6 px wide, the Sun shader stops drawing the disc's
  anti-aliased rim (which lit ±45° of limb at FOV 5°) and draws the sliver as a one-pixel ring just
  outside the limb, carrying its true width `w(θ) = ρ☉ − (b + √(b² − σ² + ρ☾²))`, `b = ê(θ)·δ`
  (δ the Moon's offset on screen, σ = |δ|): flux-conserving, correctly long.
- **Display adaptation.** The eye, adapted to the darkening sky, sees the last crescent and the
  beads dazzle: with `L = (1 − obscuration)^1.4` the photosphere is drawn ×`(L/0.02)^−0.6`
  (1 until 2 % of the light is left, capped at 40), so the crescent totals ∝ `L^0.4` like the
  daylight (`photosphereAdapt`).
- **Baily's beads and the diamond ring.** `bailysBeads` samples the limb ±60° around the contact
  point every 0.25°, against a fixed 720-entry lunar limb profile (harmonics plus 46 seeded
  mountains and valleys, ±2.2″, counted from the Moon's IAU north pole). A bead is a run where the
  profile opens the limb beyond the smooth-limb crescent; its flux uses linear limb darkening.
  At Luxor the smooth-limb gap closes at 0.39″/s; beads exist from about 20 s before second
  contact to 5 s after it (and mirror at third), the brightest carrying ~10⁻⁵ of the Sun one
  second after C2. Up to eight are drawn as HDR point sprites (`render/totality.js`), as the
  larger of their share of the adapted photosphere and a zoom-independent point-source floor;
  bloom and the lens flare's starburst (moved to the brightest bead, at most 45 %) make the
  diamond ring, and the low tier gets six analytic rays. The profile is not LOLA/Watts data and
  ignores libration: bead count and timing are typical, not predicted.
- **Corona** (`DISC_FRAG`, `SUN_ECLIPSE`). Baumbach's K+F law
  `I(ρ) = 0.0532ρ^−2.5 + 1.425ρ^−7 + 2.565ρ^−17` (10⁻⁶ of the mean disc), shown as `1.05·I^0.743`
  so the 1250:1 range from ρ 1.05 to 4 fits a display. Ludendorff flattening stretches the
  isophotes along the solar equator, ε from 0.04 at maximum to 0.30 at minimum on an idealised
  11-year cycle phased to cycle 25 (2027-08-02: ε ≈ 0.17). Four helmet streamers at seeded
  latitudes (narrower near solar minimum), polar plumes and fibrous noise in (θ, log ρ) are seeded
  by the UTC date, oriented by the Sun's IAU rotation pole (`AE.RotationAxis('Sun')` →
  `snap.sunPoleS`) projected on screen. It fades in as `1 / (1 + √(L / 2·10⁻⁵))`, faint with 1 % of
  the Sun left and full at second contact (`coronaVisibility`). A stylised minimum size, like the
  planet glyphs': the outer corona is stretched about the limb until its ρ = 3 isophote is at
  least 30 CSS px from the centre (at FOV 70° the true one is ~9 px); the inner corona stays on
  the limb.
- **Chromosphere and prominences.** A pink H-alpha rim at least 2.5 px tall flashes on the
  contact limb from 3″ before second contact and fades over ~20 s (`chromosphereFlash`); four
  seeded prominences, one 0.14–0.20 R☉ (it clears this eclipse's 0.07 R☉ lunar overhang), the
  rest 0.04–0.08 R☉. The Moon's depth pass hides whatever lies behind its disc, so both show only
  where its limb really uncovers them. Invented, not a prediction.
- **360° horizon.** In totality the dome is indigo at the zenith and a yellow-orange band shading
  to rose glows all round the horizon: sunlight scattered from outside the umbra. Its azimuthal
  shape comes from the umbra's edge distance: walking `t` km along azimuth `az` shifts the Moon's
  apparent centre by `−t·g⊥/D`, the edge is where `|δ − t·g⊥/D| = ρ☾ − ρ☉`, and the glow per
  azimuth is `exp(−t / 100 km)`, fitted by its mean and two harmonics (`umbraHorizonGlow`). With
  a high Sun it is brightest toward the nearest edge; with a low one the stretched shadow darkens
  the Sun's azimuth. The ground catches a little of the light.

## 7a. Finding it in the real sky (`js/astro/sky-guide.js`, `render/ruler.js`, `camera/aim.js`)

- **Angles you can measure by hand.** Held at arm's length a fist covers about 10° and a finger
  about 1°; three fingers are about 5° (`handSpan`: fingers below 3.5°, 'half a fist' to 7.5°,
  then fists rounded to halves). Hands and arms vary by ±20 %, so the wording is always 'about'.
- **'Find it'.** Which way to face is the apparent azimuth in 16 compass points; how far up is the
  apparent (refracted) altitude in hands. The neighbour is the nearest signpost within 40° and at
  least 3° up: the Moon and the planets brighter than the Sun's-altitude limit (mag 2 below −8°,
  0 in twilight, −3.5 by day), and below −8° of Sun 24 bright stars (J2000 RA/Dec to ~0.01°,
  proper motion ignored, placed with the snapshot's observer ENU, which already carries
  precession, so no precession error), never the Sun. A neighbour more than 1.5 mag fainter than
  the target is used only when nothing comparable is near (Jupiter is no easier to find from
  Regulus). The offset is the target's direction projected on the neighbour's upright frame:
  right is the horizontal direction 90° clockwise of its azimuth, up is toward the zenith, and the
  direction words come from the 45° sector of `atan2(up, right)`, the count from the true
  separation.
- **The ruler** measures between the drawn, refraction-lifted places, the angle a hand held up to
  the real sky would span; it differs from the astrometric separation by at most ~0.5° near the
  horizon. Ends on bodies follow their topocentric direction; ends on stars or empty sky are
  fixed in the J2000 scene frame, so they turn with the sky.
- **Pointing the phone.** W3C DeviceOrientation: R = Rz(α)·Rx(β)·Ry(γ) takes device axes to
  east-north-up; the rear camera looks along the device's −z, the screen's up is the device axis at
  `screen.orientation.angle`. Android's `deviceorientationabsolute` gives α from magnetic north;
  iOS gives a relative α and `webkitCompassHeading`, which is taken as the camera's heading while
  the phone is within 40° of upright and turned into a smoothed correction. Magnetic declination
  (up to ~20°), nearby metal and sensor error put the compass 5–15° out: 'Align' adds the
  azimuth that puts a centred body (or bright star) at its true azimuth. Altitude comes from
  gravity and is good to a degree or two.

## 7b. More events, meteor showers, the year planner and the Sun's paths (Phase 6)

**More events** (`js/astro/events.js`, all in the worker, ≈ 7 ms more for 730 days once warm;
transits and apsides are cached across calls):

- **Moon–star occultations.** Aldebaran, Regulus, Spica, Antares and the Pleiades (Alcyone) as
  fixed J2000 unit vectors (Hipparcos via SIMBAD; proper motion, ≤ 0.2″/yr, and the stars' 20″ of
  annual aberration are ignored). The topocentric astrometric Moon (`Equator(ofdate=false,
  aberration=false)`, consistent with J2000 star places) is tabulated every 6 h; each monthly pass
  is minimised on a Catmull–Rom interpolation of that table (≈ 0.02°, the diurnal parallax being
  the fastest term), and only passes within 0.15° of the limit, with the Moon up and the Sun down,
  are refined against AE. Listed: occultations (separation < the Moon's semi-diameter; for the
  Pleiades < 0.75°) and passes closer than 0.5° (1° for the cluster), with the Moon ≥ 3° up and the
  Sun ≤ −3° here. Checked against a brute-force 20-minute scan at eight sites (55 of 56 found; the
  miss sits on the 3° gate).
- **Venus at greatest brilliancy**: `AE.SearchPeakMagnitude` (2026-11-27 01:47 UT, mag −4.87).
- **Transits** of Mercury and Venus: `AE.SearchTransit`, with the Sun's upper limb up at the start,
  greatest transit and end deciding what is seen here (2032-11-13: 06:41–11:07 UT, greatest 08:54
  UT, as NASA lists it).
- **The Moon's distance**: per calendar year, `AE.SearchLunarApsis` gives the closest perigee and
  the farthest apogee; every perigee within 24 h of full Moon (the phase angle 180° ± 12.2°) is a
  "perigee full Moon". The quarter's own "a supermoon" note (full Moon closer than 361,900 km) stays.
  Sizes are against the mean 384,400 km (larger ∝ 1/d, brighter ∝ 1/d²).
- **Saturn's ring-plane crossings**: the sign of `Illumination('Saturn').ring_tilt`, sampled every
  10 days and bisected to seconds; crossings closer than 400 days are one edge-on season, listed
  once (2038-10-15, 2039-04-01, 2039-07-09).
- **Mars at opposition** says "perihelic" below 1.42 AU from the Sun and "aphelic" above 1.6 AU.

**Meteor showers** (`js/astro/meteors.js`). The thirteen annual showers of the IMO calendar's
working list, each with the solar longitude of maximum λ☉ (J2000.0), its activity window, radiant
and drift, V∞, population index r and ZHR. Streams are fixed to the stars, so the peak in the equinox
of date is at λ☉ + p_A, with the IAU 2006 general precession p_A = 5028.796″T + 1.105″T²; the
instant is `AE.SearchSunLongitude` of that. This reproduces the IMO's published maxima (Geminids
2023-12-14 19h and 2024-12-14 01h UT, Perseids 2024-08-12 13–16h, Quadrantids 2025-01-03 15h) and
puts the Perseids of 1066 at λ_date ≈ 127°, late July. History: `validFrom` keeps the Geminids
(first seen ~1862), Quadrantids (~1835), Ursids (~1900) and Draconids (1926) out of earlier years;
the Quadrantids are cut off after 2400 (their stream is being moved off Earth's path; the year is
illustrative). Outbursts and storms are not modelled. Activity is ZHR(λ) = ZHRmax·10^(−B|λ − λmax|)
inside the window (Jenniskens 1994 slopes where given, broad illustrative ones otherwise, e.g. the
Geminids' B+ 0.39 / B− 0.81). The expected rate is the IMO's ZHR definition turned around:
HR = ZHR·sin h·r^(lm − 6.5), with lm from the zenith sky's brightness (`skyglow.js`: airglow,
moonlight by KS91, the site's light pollution) plus twilight, capped at 6.5. The Events entry
samples the night around the peak hourly (geometric altitudes from RA/Dec of date and the sidereal
clock) and quotes the best hour: "about N meteors an hour from a dark site, M under this sky". These
are expectations for one observer under a clear sky; rounded, and labelled illustrative.

**The meteors drawn in sky view** are illustrative (`render/meteors.js`). Simulated time is cut into
10 s buckets; each bucket's count per source is a Poisson draw with the source's rate (×1.6 for the
paths the horizon cut removes), and each meteor's start (3–100° from the radiant, uniform over the
sphere), length (∝ sin ψ, foreshortened near the radiant), duration (0.3–0.8 s, slower meteors
longer) and magnitude (P(m) ∝ r^m) are hashes of (bucket, source, index). Meteors move along great
circles away from their radiant. Live, they play for wall-clock time with launches capped at 2.5 a
second; paused, an hour's meteors are composited, star-aligned. The sporadic background is 8 an
hour under a perfect sky, with random radiants.

**The year planner** (`js/astro/planner.js`). 365 nights from the first of the month, sampled every
20 minutes from 15:00 to 09:00 local standard time. One RA/Dec of date per body per night
(`GeoVector` rotated by `Rotation_EQJ_EQD`, refreshed monthly), the Moon at three nodes a night;
altitudes from sin h = sin φ sin δ + cos φ cos δ cos H with the sidereal clock running. No refraction,
no parallax: within ~1° of `AE.Horizon` for the planets and the Sun, ~2.5° for the Moon. Visible
means ≥ 10° up, the Sun below −6° (−12° for planets fainter than mag 4, as `tonight`) and ≥ 12° from
the Sun. Magnitudes from `AE.Illumination` every third night.

**The Sun's paths** (`js/astro/sunpath.js`). Apparent (refracted) alt/az every 10 minutes over today
(from the zone's midnight) and over this year's solstices and March equinox (from local mean
midnight), the noon analemma at local mean noon (UT 12h − λ/15) each day, and the subsolar point
(δ☉, RA☉ − GAST) at the current UT time of day each day. Sampling at a fixed UT is the same as at a
fixed standard-time reading anywhere, so no zone or DST logic enters. Checked against Paris: noon
altitudes 64.6° and 17.7° at the solstices, sunrise azimuths 52° and 126° (where the geometric
altitude crosses −0.833°, as AE.SearchRiseSet does; the apparent one would count refraction twice); the subsolar 8 spans
±23.44° and −4.1° … +3.6° of longitude at 12:00 UT (the equation of time).

## 7c. Standing on Mars (`js/astro/host-mars.js`, `js/astro/mars-clock.js`; phase 1, the sky view)

**Directions.** For each of the nine slots (slot 4 is the Earth) the Mars-centred vector is
`AE.BackdatePosition(t, 'Mars', target, true)`: light time and aberration corrected, the Moon
included. The site's own position on a sphere of Mars's mean radius (3389.5 km, IAU 2015) is taken
off, which moves the Earth by up to 13″ and Phobos by up to ~20°. The stars, the constellations and the
Milky Way are the same J2000 sky (the parallax between Earth and Mars is far below a milliarcsecond
except for a handful of stars, ~1″ for α Centauri). There is no refraction on Mars (~0.01° at the
horizon), but the sky view's drawing still lifts low objects by the Earth's refraction (≤ 0.6°), a
known simplification of phase 1.

**The local frame.** `AE.RotationAxis('Mars', t)` (IAU WGCCRE 2015: pole RA/Dec and the prime
meridian W through Airy-0) → `frames.iauBodyMatrix`; up, north and east at a planetocentric latitude
and east longitude on the sphere; alt/az from `frames.dirToAltAz`. Planetocentric and planetographic
latitude differ by up to 0.34° (Mars's flattening, 1/170); the site is taken as planetocentric.

**Magnitudes and phases** come from the Mars-centred geometry with astronomy-engine's own phase laws
(Mercury, Venus, Jupiter, Uranus, Neptune; Saturn with its ring tilt as seen from Mars; the Moon's
Allen-style law), and the Earth from Mallama & Hilton (2018): V = −3.99 − 1.060·10⁻³α + 2.054·10⁻⁴α².
The Earth peaks near −2.5 as an evening or morning star, at most ~47° from the Sun; the Moon within
0.3° of it at +1 … +4. The Sun is 21–25′ across, two thirds of its size from Earth (1/r).

**The Mars clock** follows Allison & McEwen (2000) as implemented by NASA GISS's Mars24: the mean
anomaly, the fictitious mean Sun and seven planetary perturbers give Ls; the equation of time
(EOT, C-1), MSD = (JD_TT − 2451549.5)/1.0274912517 + 44796.0 − 0.0009626, MTC = 24·frac(MSD),
LMST = MTC + λE/15, LTST = LMST + EOT/15, the planetographic solar declination
asin(0.42565 sin Ls) + 0.25° sin Ls and the heliocentric distance. TT comes from astronomy-engine's ΔT,
so the clock agrees with Mars24's worked example A (2000-01-06) to 0.35 s (Mars24 uses the leap
second table). Mission sols are counted from 0 at the landing sol, changing at the landing site's
local mean midnight (Mars 2020 from 2021-02-18 20:44 UTC SCET, MSL 2012-08-06 05:04, InSight
2018-11-26 19:45); other sites show the local MSD. The clock and the IAU frame agree: at local true
solar noon the Sun's azimuth is within 0.7° of the meridian (test), and the clock-only solar altitude
(used by the time bar's strip) is within 0.3° of the full geometry.

**Phobos and Deimos** come from JPL SSD's mean elements in their Laplace planes (epoch 2000 Jan 1.5
TDB, MAR099, Brozović, Jacobson & Park 2025: a, e, i, node, ω, M, the Laplace poles), with the
mean-longitude rates of Jacobson (2010) (1128.8445850 and 285.1618970 °/day: the sidereal periods
7 h 39.2 min and 30.3 h) and Phobos's apsidal and nodal periods of 1.1316 and 2.2617 yr. JPL's table
prints those as 1.1 and 2.3 yr; with the rounded values Phobos's track misses the Sun by 1.3° at
Perseverance's sol-397 transit (2022-04-02, 08:20:37 LMST), with these it crosses the disc (0.12°
from the centre) 2–3 minutes late. Phobos's tidal acceleration (ṅ = 1.270·10⁻³ °/yr², Jacobson 2010)
adds ½ṅT². Each moon is placed topocentrically, lit by the Sun with a lunar-like phase law from its
absolute magnitude (Phobos 11.8, Deimos 12.89), and goes dark in Mars's cylindrical shadow. Mean
elements ignore the short-period terms: positions are good to about a degree over decades (the
cards say so). Phobos orbits faster than Mars turns, so it rises in the west (tested: every rise
over three sols is at azimuth 180–360°) and crosses the sky in ~4.5 h, twice a sol.

**What is illustrative.** The sky's colour (`shaders/mars.glsl.js`): a butterscotch dust sky
brightening toward the horizon and the Sun, a narrow blue forward-scattering lobe around a low Sun,
and a long blue-then-brown twilight, tuned by eye to rover images, not a radiative-transfer model.
The dust extinction of the Sun and planets (0.20–0.23 mag per airmass, nearly grey) is chosen so the
setting Sun stays a disc as in rover sunsets. The landscape is the procedural ridge without trees or
roofs, in Mars colours. The light-time beam is a guide, not a ray.

---

## 8. Accuracy budget

| Source of error | Typical size | Notes |
|---|---|---|
| Astronomy Engine positions, 1800–2200 | ≲ 1′ | Checked by its author against JPL Horizons and NOVAS. Planets from truncated VSOP87; the Moon from the *Improved Lunar Ephemeris* (Brown's theory) as adapted by Montenbruck & Pfleger. |
| Outside 1800–2200 | grows with distance from 2000 | The uncertainty in ΔT (the Earth's irregular rotation) dominates far from the present. It is about a minute of time around the year 1000, which is 0.25° of Earth rotation. Toward 3000 it grows to tens of minutes, because ΔT must be extrapolated. That moves where on Earth a given sky is seen by several degrees of longitude. The truncated series also lose precision. Hence the "Reduced accuracy" badge. |
| Frame consistency: our Earth matrix against `Rotation_EQJ_HOR` | 0.007″ measured | The test bound is 0.05″ over 300 random epochs and sites, 1900–2150. |
| Drawn (astrometric) against tabulated (apparent) direction | ≤ 20.8″ measured | Annual aberration. Refraction is added on top in the tables. The Moon's `dirS` is made astrometric too, so drawn Sun–Moon and star–Moon separations are the apparent ones (§4). |
| Eclipse contacts at the observer (obscuration, sky-view discs, panel) against `AE.SearchLocalSolarEclipse` | < 0.1 s measured | Same discs and radii as AE. The 0.5 s frame-snapshot cadence bounds the visible lag. |
| Planet medallions and the eyepiece portrait | geometry exact, size magnified | Phase, pole, ring opening and the Galilean moons' sides and flags follow the models (moon flags within ~1 min); Jupiter's and Saturn's belts, the Red Spot's longitude, Mars's markings and the moons' spacing beyond the limb are illustrative (§4). |
| Baily's beads, corona, prominences | illustrative | Placed by the true contact geometry, but the limb profile (±2.2″, no libration) and the corona's streamers, plumes and prominences are invented per date. Bead timing is typical to a few seconds. |
| Standing on Mars: directions and the local frame | ≲ 1′ (AE), site on a sphere | Mars-centred vectors from `BackdatePosition`; the IAU rotation model is good to arcminutes; planetocentric latitude on a sphere (≤ 0.34° from planetographic). Drawn low objects keep the Earth's refraction lift (≤ 0.6°). |
| Mars clock (MSD, LMST, Ls) | ≈ 1 s against Mars24 | ΔT from astronomy-engine instead of Mars24's leap seconds; mission sols assume the landing's local mean midnight. |
| Phobos and Deimos | ~1° (Phobos), illustrative badge | Mean elements without short-period terms; Phobos's sol-397 transit reproduced within 3 minutes. |
| Mars sky colour and dust extinction | illustrative | Tuned to rover images (§7c). |
| Pin on a sphere against the WGS84 ellipsoid | ≤ 21 km in position | ≤ 11″ on the Moon's direction from the pin (globe view, the umbra on the globe), negligible for everything farther. The sky view and the observer's obscuration use AE's WGS84 topocentric directions. The zenith direction is exact (geodetic). |
| Beam far endpoint at 2000 Earth radii | `camDist / 2000` rad | 0.1° at the default 3.4 ER view. The beam is a line from the pin, so seen from elsewhere it converges at 2000 ER. |
| Polar motion (ignored) | ≤ 0.5″ (≈ 15 m) | |
| Star proper motion | < 1.7′ per millennium (stars under 100 mas/yr, left at J2000); ≲ 1′ (the 1,183 movers, linear, no radial velocity) | §5d. Arcturus in 1000 within 1′ of a rigorous space-motion calculation. The max tier's deeper stars do not move. |
| Star distances and light-times | Hipparcos σ_ϖ (Betelgeuse ± 13 %) | §5e. The departure year is rounded to that error. |
| Deep-sky objects | position ≤ 0.05°; distance 10–30 %; drawing illustrative | §5f. |
| Precession circle beyond 1000–3000 | 1–7° | Fixed obliquity and rate; labelled illustrative (§5d). Within 1000–3000 the track is Astronomy Engine's. |
| Refraction model | several ′ near the horizon | Real refraction depends on temperature and pressure. Rise and set times are good to about a minute. The sky view draws the same model (§6). |
| Aurora oval | a few degrees of latitude | Starkov's statistical oval for a chosen Kp, not live activity; centred dipole instead of corrected geomagnetic coordinates; the dipole held at 1900 or 2030 outside those years. Arcs, rays and their motion are illustrative (§6b). |
| 'Point at the sky' heading | 5–15° until aligned | Phone compasses are magnetic and easily disturbed; 'Align' on a body removes the offset for that place and phone. The UI says 'approximate'. |
| Hand units ('fists') | ±20 % | Hands and arms differ; the wording says 'about'. |
| Illustrative landscape | up to 0.5° (ridge), 1.2° (trees, roofs) | Invented per place. Bodies set behind it minutes before the almanac's (mathematical-horizon) times; the layer can be turned off. |
| Float32 on the GPU | ≈ 0.01″ | Unit vectors in single precision. |
| Solar-system zoom: Earth→body line against the beam | ≤ 25″ (planets), ≤ 1° (Moon) | Geocentric against topocentric direction; distances to scale, bodies enlarged (§4). In AU on the GPU the orrery's points are good to ~10⁻⁷ AU (≈ 15 km) near the Earth. |
| Sub-points, footprint | geocentric | The footprint is the hemisphere where the body's geocentric direction is above the horizon. Parallax and refraction are not applied. It is a guide, not a contact time. |
| World map twilight lines | ≲ 1° of solar altitude | Geocentric and unrefracted, from the sphere's normal (§6c); the panels use the topocentric, refracted Sun. |
| Parallax distance (two places) | ≲ 1 % | Small-angle triangulation over the pins' chord (§6c). |
| Halley's Comet | < 0.3′ against Horizons (same orbits); ≈ 1° absolute in 1066 and 1456 | Two-body propagation within ±1.5 years of each perihelion (§5b). Tails illustrative. |
| Guest stars | position exact (remnant); brightness ±1 mag | Light curves are templates between the recorded dates (§5a). |
| Spacecraft | ≤ 0.001° (0.01° JWST) | Hermite knots against Horizons; straight-line 'projected' past 2100 / 2050 (§5c). |
| Satellites (SGP4) | ≤ 1 mm against Vallado's vectors; a few km a day from the elements' epoch | The propagator is exact to the published test cases; the error is the element set's own (§5c′). Shown within 14 days of the epoch only. |
| Satellite brightness | ±0.5 mag (standard magnitudes), more with attitude | Diffuse-sphere phase law; glints and tumbling not modelled (§5c′). |
| Earth's shadow on a satellite | a few seconds | Geometric Earth disc, no atmosphere; penumbra from the Sun's disc (§5c′). |
| Calendar | exact | Julian before 15 Oct 1582 everywhere; the local adoption date is not modelled (§1). |
| Meteor-shower peaks | ≲ 1 h against the IMO calendar | λ☉ (J2000) + precession through `SearchSunLongitude` (§7b). Real maxima vary from year to year; outbursts are not modelled. |
| Meteor rates | a factor of ~2 | Expected values for one observer (ZHR, r, the radiant's altitude, the modelled sky's limiting magnitude). The meteors drawn are illustrative. |
| Star occultations | ~0.01° in separation, ~1 min in time | Fixed J2000 stars without proper motion or annual aberration; grazes near the Moon's limb may be misjudged (§7b). |
| Year planner | ~1° (planets, Sun), ~2.5° (Moon) | Analytic altitudes from one RA/Dec a night, no refraction or parallax (§7b). |

**Validation.** The tests in `test/astro.*.test.mjs` check these values from SPEC §D.5:

- sidereal time on 2026-06-21 12:00 UTC is 5.98009 h (±1e-4 h);
- the subsolar point at that moment is +23.438°, +0.454°;
- the subsolar points at the 2026 March equinox and December solstice;
- Sirius and Betelgeuse positions from the decoded catalogue;
- `Constellation(5.919 h, 7.407°)` is Ori;
- the next global solar eclipse after 2026-10-11 is annular, on 2027-02-06;
- the Mars opposition of 2025-01-16 and its retrograde from about 7 Dec 2024 to 24 Feb 2025;
- the orrery's lines along each body's geocentric direction (to 1e-6 rad), its orbits at the right
  radii with the snapshot's Earth on its own, and Mars's sight lines turning back at the 2027
  opposition;
- `discVisibleFraction` against numerical integration;
- 200 random alt/az cases against `AE.Horizon`, within 30″;
- second and third contacts of the snapshot's obscuration and drawn discs within 1 s of
  `AE.SearchLocalSolarEclipse` for the eclipses of 2026, 2027 (total and annular) and 2028, and a
  Sky panel that never reads "Partial … 100.0 %";
- the globe's umbra half-width on 2027-08-02 (≈ 129 km) and totality's star limit (≤ 2.5);
- SGP4 against Vallado's published vectors for every near-Earth case (158 rows, ≤ 1 mm), GMST at
  J2000.0 and Vallado's example 3-5, the low-precision Sun against Astronomy Engine (0.02°), and
  each listed satellite pass visible from start to end;
- Polaris from the pole of date in 1000, 2000, 2026, 2100 and 3000 (6.21°, 0.74°, 0.63°, 0.46°,
  5.05°), the equinox entering Aquarius in 2597–2600, Arcturus's proper motion against a rigorous
  space-motion calculation (< 1′), and nine deep-sky positions against published J2000 values;
- eclipse paths against NASA (greatest point within 15 km, width within 8–10 km) for 2027-08-02,
  2026-08-12, 2027-02-06 and 2023-04-20, date-line-safe longitudes (2028-07-22), and Luxor's
  contacts and totality in the event card within 1 s of `AE.SearchLocalSolarEclipse`.

---

## 9. Sources

- **Mars time.** M. Allison & M. McEwen (2000), "A post-Pathfinder evaluation of areocentric solar
  coordinates with improved timing recipes for Mars seasonal/diurnal climate studies", *Planet. Space
  Sci.* 48, 215; NASA GISS Mars24 Sunclock, "Algorithm and Worked Examples",
  <https://www.giss.nasa.gov/tools/mars24/help/algorithm.html>.
- **Mars's rotation.** B. A. Archinal et al. (2018), "Report of the IAU Working Group on Cartographic
  Coordinates and Rotational Elements: 2015", *Celest. Mech. Dyn. Astr.* 130, 22 (as coded in
  Astronomy Engine's `RotationAxis`).
- **Phobos and Deimos.** JPL SSD Planetary Satellite Mean Elements, <https://ssd.jpl.nasa.gov/sats/elem/>
  (MAR099; M. Brozović, R. A. Jacobson & R. S. Park 2025, "Revised Ephemerides of the Martian
  Satellites, Phobos and Deimos", *AJ*); R. A. Jacobson (2010), "The orbits and masses of the Martian
  satellites and the libration of Phobos", *AJ* 139, 668. Perseverance's sol-397 transit: NASA/JPL-Caltech/ASU
  Mastcam-Z release, 20 April 2022.
- **The Earth's brightness.** A. Mallama & J. L. Hilton (2018), "Computing apparent planetary
  magnitudes for The Astronomical Almanac", *Astronomy and Computing* 25, 10.

- **JPL Horizons.** NASA/JPL-Caltech, <https://ssd.jpl.nasa.gov/horizons/>: spacecraft state
  vectors (`data/craft.json`), Halley's per-apparition elements and the reference ephemerides in
  `test/astro.comets.test.mjs` and `test/astro.craft.test.mjs` (retrieved 2026-11-04).
- **Satellites.** Element sets: CelesTrak (T. S. Kelso), <https://celestrak.org>, GP data of the 18th
  Space Defense Squadron (`data/tle.json`, retrieved 2026-11-04 and daily by the deploy). SGP4:
  D. A. Vallado, P. Crawford, R. Hujsak & T. S. Kelso (2006), "Revisiting Spacetrack Report #3",
  AIAA 2006-6753 (rev. 3), and F. R. Hoots & R. L. Roehrich (1980), *Spacetrack Report No. 3*; the
  verification files SGP4-VER.TLE and tcppver.out as distributed with python-sgp4 (B. Rhodes, MIT)
  (`test/fixtures/sgp4-vallado.json`, near-Earth cases). Low-precision Sun: *The Astronomical
  Almanac*, section C ("Low precision formulas for the Sun"). Standard magnitudes after the
  McCants / Heavens-Above convention (1000 km, 50 % illuminated), rounded estimates.
- **Halley's orbits.** D. K. Yeomans & T. Kiang (1981), "The long-term motion of comet Halley",
  *MNRAS* 197, 633. FK4 → FK5: E. M. Standish (1982), *A&A* 115, 20.
- **Historical supernovae.** F. R. Stephenson & D. A. Green (2002), *Historical Supernovae and their
  Remnants*, OUP; P. F. Winkler et al. (2003), *ApJ* 585, 324 (SN 1006); G. W. Collins et al.
  (1999), *PASP* 111, 871 (SN 1054); A. Ritter et al. (2021), *ApJL* 918, L33 (Pa 30, SN 1181);
  O. Krause et al. (2008), *Nature* 456, 617 (Tycho's).
- **Calendars.** E. G. Richards, "Calendars", in *Explanatory Supplement to the Astronomical
  Almanac* (3rd ed., 2013), ch. 15 (Julian Day Number algorithms).
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
- **Meteor showers.** International Meteor Organization, *Meteor Shower Calendar* (working list:
  λ☉ of maxima in J2000.0, radiants, drift, V∞, r, ZHR), <https://www.imo.net/resources/calendar/>.
  Activity slopes: P. Jenniskens (1994), "Meteor stream activity I. The annual streams", *A&A* 287, 990.
- **Bright-star positions** for occultations: the Hipparcos new reduction, F. van Leeuwen (2007),
  *A&A* 474, 653, via SIMBAD (CDS, Strasbourg).
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
- **Moonlit and natural night sky.** K. Krisciunas & B. E. Schaefer (1991), "A model of the
  brightness of moonlight", *PASP* 103, 1033.
- **Light pollution.** M. F. Walker (1977), "The effects of urban lighting on the brightness of the
  night sky", *PASP* 89, 405. Shape after R. H. Garstang (1986), *PASP* 98, 364.
- **Limiting magnitude.** B. E. Schaefer (1990), "Telescopic limiting magnitudes", *PASP* 102, 212,
  in the SQM → NELM form used by Unihedron.
- **Bortle scale.** J. E. Bortle (2001), "Introducing the Bortle Dark-Sky Scale", *Sky & Telescope*
  101(2), 126. SQM bounds as commonly tabulated.
- **Zodiacal light.** Ch. Leinert et al. (1998), "The 1997 reference of diffuse night sky
  brightness", *A&AS* 127, 1 (Table 17).
- **Geomagnetic field.** P. Alken et al. (2021), "International Geomagnetic Reference Field: the
  thirteenth generation", *Earth Planets Space* 73, 49; IGRF-14 (IAGA V-MOD, 2024) for the 2025
  coefficients and 2025–2030 secular variation.
- **Auroral oval.** Ya. I. Feldstein & G. V. Starkov (1967), *Planet. Space Sci.* 15, 209;
  G. V. Starkov (1994), "Mathematical model of the auroral boundaries", *Geomagn. Aeron.* 34, 331;
  F. Sigernes et al. (2011), "Auroral oval nowcasting", *Opt. Pura Apl.* 44, 599 (Table 1 and the
  Kp–AL relation).
- **Cloud rendering.** M. Mikkelsen (2010), "Bump Mapping Unparametrized Surfaces on the GPU" (tried
  and not used, §6b); A. Schneider (2015), "The real-time volumetric cloudscapes of Horizon Zero
  Dawn" (Beer-powder), SIGGRAPH Advances in Real-Time Rendering.
- **Star data.** ESA (1997), *The Hipparcos and Tycho Catalogues*, ESA SP-1200, via d3-celestial
  (Olaf Frohn, BSD-3-Clause).
- **Parallaxes and proper motions.** F. van Leeuwen (2007), "Validation of the new Hipparcos
  reduction", *A&A* 474, 653, via NASA HEASARC (`hipnewcat`). Space motion: ESA (1997), *The
  Hipparcos and Tycho Catalogues*, Vol. 1, §1.2.8.
- **Deep-sky objects.** d3-celestial's messier.json; SEDS Messier database; NASA/IPAC Extragalactic
  Database (NED); W. E. Harris (2010 edition), *Catalog of Parameters for Milky Way Globular
  Clusters*; G. de Vaucouleurs et al. (1991), *Third Reference Catalogue of Bright Galaxies* (RC3).
- **Cities.** GeoNames gazetteer, CC BY 4.0.
