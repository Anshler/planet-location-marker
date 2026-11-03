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
  altitude plus the semi-diameter, above 0. The beams, the Sky panel and orbit-view labels use
  this flag. Sky-view labels use the geometric altitude instead, because bodies are drawn there
  without refraction: for a few minutes around sunset the drawn Sun is already below the ground.

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
- **Zodiacal light and gegenschein** (illustrative, medium tier and up). These are drawn in the Milky
  Way pass from a smooth fit to the shape of Leinert et al. (1998, A&AS 127, 1) Table 17, in S10
  units (1 S10 = 27.78 mag/arcsec², so the natural sky is about 205 S10). On the ecliptic the value
  is ≈ 230·(90°/Δλ)^1.7 sunward of 90° and ≈ 175 beyond. Off the ecliptic it falls by a 22° Lorentzian
  in β times cos²β, down to 60 S10 at the poles. The gegenschein adds 50 S10 (9° × 7°) opposite the
  Sun. The display gain puts the band 90° from the Sun at the edge of visibility and the cone 30°
  from it near the Milky Way's brightness, faded by extinction toward the horizon and by twilight.
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
| Baily's beads, corona, prominences | illustrative | Placed by the true contact geometry, but the limb profile (±2.2″, no libration) and the corona's streamers, plumes and prominences are invented per date. Bead timing is typical to a few seconds. |
| Pin on a sphere against the WGS84 ellipsoid | ≤ 21 km in position | ≤ 11″ on the Moon's direction from the pin (globe view, the umbra on the globe), negligible for everything farther. The sky view and the observer's obscuration use AE's WGS84 topocentric directions. The zenith direction is exact (geodetic). |
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
  brightness", *A&AS* 127, 1 (Table 17, shape only).
- **Star data.** ESA (1997), *The Hipparcos and Tycho Catalogues*, ESA SP-1200, via d3-celestial
  (Olaf Frohn, BSD-3-Clause).
- **Cities.** GeoNames gazetteer, CC BY 4.0.
