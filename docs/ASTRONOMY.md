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

**The sky is static; the Earth moves.** Stars, constellations, the Milky Way and the ecliptic are
placed once at load, in J2000 scene coordinates. Precession and nutation appear because the
Earth's axis (`earthMatrix`) moves inside that fixed sky. Over centuries the celestial pole
visibly drifts away from Polaris.

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
| Pin on a sphere against the WGS84 ellipsoid | ≤ 21 km in position | ≤ 11″ on the Moon's direction from the pin (globe view, the umbra on the globe), negligible for everything farther. The sky view and the observer's obscuration use AE's WGS84 topocentric directions. The zenith direction is exact (geodetic). |
| Beam far endpoint at 2000 Earth radii | `camDist / 2000` rad | 0.1° at the default 3.4 ER view. The beam is a line from the pin, so seen from elsewhere it converges at 2000 ER. |
| Polar motion (ignored) | ≤ 0.5″ (≈ 15 m) | |
| Star proper motion (catalogue fixed at J2000) | 0.2″–10″/yr | Negligible within a few centuries. The fastest naked-eye stars shift by up to about a degree 1000 years from 2000. |
| Refraction model | several ′ near the horizon | Real refraction depends on temperature and pressure. Rise and set times are good to about a minute. The sky view draws the same model (§6). |
| Aurora oval | a few degrees of latitude | Starkov's statistical oval for a chosen Kp, not live activity; centred dipole instead of corrected geomagnetic coordinates; the dipole held at 1900 or 2030 outside those years. Arcs, rays and their motion are illustrative (§6b). |
| Illustrative landscape | up to 0.5° (ridge), 1.2° (trees, roofs) | Invented per place. Bodies set behind it minutes before the almanac's (mathematical-horizon) times; the layer can be turned off. |
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
- 200 random alt/az cases against `AE.Horizon`, within 30″;
- second and third contacts of the snapshot's obscuration and drawn discs within 1 s of
  `AE.SearchLocalSolarEclipse` for the eclipses of 2026, 2027 (total and annular) and 2028, and a
  Sky panel that never reads "Partial … 100.0 %";
- the globe's umbra half-width on 2027-08-02 (≈ 129 km) and totality's star limit (≤ 2.5);
- eclipse paths against NASA (greatest point within 15 km, width within 8–10 km) for 2027-08-02,
  2026-08-12, 2027-02-06 and 2023-04-20, date-line-safe longitudes (2028-07-22), and Luxor's
  contacts and totality in the event card within 1 s of `AE.SearchLocalSolarEclipse`.

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
- **Cities.** GeoNames gazetteer, CC BY 4.0.
