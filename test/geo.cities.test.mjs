// Tests for js/geo/cities.js (offline search, nearest, byTz with ADDENDUM A2 canonicalisation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadCities, foldText, placeToObserver, placeLabel } from '../js/geo/cities.js';
import { canonTz } from '../js/core/tz.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cities.sample.json', import.meta.url), 'utf8'));
const idx = loadCities(fixture, { canonTz });
const names = (results) => results.map((p) => `${p.name}/${p.cc}`);

test('loads valid rows, skips malformed ones, resolves country names', () => {
    assert.equal(idx.size, 25);
    assert.equal(idx.list.length, 25);
    const hcm = idx.list[0];
    assert.deepEqual(hcm, {
        name: 'Ho Chi Minh City', admin: 'Ho Chi Minh', country: 'Vietnam', cc: 'VN', lat: 10.823, lon: 106.6297,
        tz: 'Asia/Ho_Chi_Minh', pop: 14002598, source: 'offline',
    });
    assert.equal(idx.countryName('vn'), 'Vietnam');
    assert.equal(idx.countryName('XX'), 'XX');
    assert.equal(idx.countryName(null), '');
    assert.equal(idx.countries.FR, 'France');
});

test('spec cases: "ho chi" and "sao paulo"', () => {
    assert.equal(idx.search('ho chi')[0].name, 'Ho Chi Minh City');
    assert.equal(idx.search('sao paulo')[0].name, 'São Paulo');
    assert.equal(idx.search('SÃO PAULO')[0].name, 'São Paulo');
    assert.equal(idx.search('São')[0].name, 'São Paulo');
});

test('diacritics, special letters and punctuation fold away', () => {
    assert.equal(foldText('Đà Lạt'), 'da lat');
    assert.equal(foldText("N'Djamena"), 'ndjamena');
    assert.equal(foldText('Saint-Denis'), 'saint denis');
    assert.equal(foldText('St. John’s'), 'st johns');
    assert.equal(foldText('Malmö  Łódź Æbeltoft'), 'malmo lodz aebeltoft');
    assert.equal(foldText('東京'), '東京', 'other scripts are kept');
    assert.equal(foldText(null), '');
    assert.equal(idx.search('zurich')[0].name, 'Zürich');
    assert.equal(idx.search('zuerich')[0].name, 'Zürich', 'GeoNames ascii spelling');
    assert.equal(idx.search('da lat')[0].name, 'Đà Lạt');
    assert.equal(idx.search('đà lạt')[0].name, 'Đà Lạt');
    assert.equal(idx.search('ndjamena')[0].name, "N'Djamena");
    assert.equal(idx.search("n'djamena")[0].name, "N'Djamena");
    assert.equal(idx.search('reykjavik')[0].name, 'Reykjavík');
    assert.equal(idx.search('st johns')[0].name, "St. John's");
});

test('ranking: exact > prefix > word-prefix > substring, population breaks ties', () => {
    const mini = loadCities({
        countries: { US: 'United States' },
        rows: [
            ['Bigspringfieldton', 'Bigspringfieldton', 'US', 'X', 1, 1, 'UTC', 9_000_000],
            ['West Springfield', 'West Springfield', 'US', 'X', 2, 2, 'UTC', 5_000_000],
            ['Springfield Gardens', 'Springfield Gardens', 'US', 'X', 3, 3, 'UTC', 1_000_000],
            ['Springfield', 'Springfield', 'US', 'Illinois', 4, 4, 'UTC', 100],
            ['Springfield', 'Springfield', 'US', 'Missouri', 5, 5, 'UTC', 160_000],
        ],
    });
    const r = mini.search('springfield');
    assert.deepEqual(r.map((p) => [p.name, p.admin]), [
        ['Springfield', 'Missouri'], ['Springfield', 'Illinois'], ['Springfield Gardens', 'X'], ['West Springfield', 'X'], ['Bigspringfieldton', 'X'],
    ]);
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].score >= r[i].score, 'scores are sorted');
    assert.deepEqual(names(idx.search('paris')), ['Paris/FR', 'Paris/US']);
    assert.deepEqual(names(idx.search('london')), ['London/GB', 'London/CA']);
});

test('"name, country" and "name region" qualifiers', () => {
    assert.deepEqual(names(idx.search('paris, us')), ['Paris/US']);
    assert.deepEqual(names(idx.search('paris, texas')), ['Paris/US']);
    assert.deepEqual(names(idx.search('Paris, France')), ['Paris/FR']);
    assert.deepEqual(names(idx.search('paris, fr')), ['Paris/FR']);
    assert.equal(idx.search('paris texas')[0].cc, 'US', 'without a comma');
    assert.equal(idx.search('london canada')[0].cc, 'CA');
    assert.equal(idx.search('london ontario')[0].cc, 'CA');
    assert.equal(idx.search('london, uk')[0].cc, 'GB', 'common abbreviations');
    assert.equal(idx.search('springfield, illinois')[0].name, 'Springfield');
    assert.deepEqual(names(idx.search('paris, frnace')), ['Paris/FR', 'Paris/US'], 'a qualifier typo falls back to the name');
    assert.equal(idx.search('ho chi minh, vietnam')[0].name, 'Ho Chi Minh City');
});

test('former names and colloquial aliases', () => {
    assert.equal(idx.search('saigon')[0].name, 'Ho Chi Minh City');
    assert.equal(idx.search('Sài Gòn')[0].name, 'Ho Chi Minh City');
    assert.equal(idx.search('kiev')[0].name, 'Kyiv');
    assert.equal(idx.search('calcutta')[0].name, 'Kolkata');
    assert.equal(idx.search('bombay')[0].name, 'Mumbai');
    assert.equal(idx.search('nyc')[0].name, 'New York City');
    assert.equal(idx.search('washington dc')[0].name, 'Washington');
    assert.equal(idx.search('Washington, D.C.')[0].name, 'Washington');
});

test('typo tolerance', () => {
    assert.equal(idx.search('tokio')[0].name, 'Tokyo');
    assert.equal(idx.search('sydnee')[0].name, 'Sydney');
    assert.equal(idx.search('mumbia')[0].name, 'Mumbai', 'transposition');
    assert.equal(idx.search('dalat')[0].name, 'Đà Lạt', 'missing space');
    assert.equal(idx.search('kathmandoo')[0].name, 'Kathmandu', 'two edits on a long query');
    assert.deepEqual(idx.search('xyzzy'), []);
    assert.deepEqual(idx.search('tok').map((p) => p.name), ['Tokyo'], 'no fuzzy noise on short queries');
});

test('limits, junk and result isolation', () => {
    assert.ok(idx.search('a').length <= 8);
    assert.equal(idx.search('a', 3).length, 3);
    assert.equal(idx.search('a', 0).length, 8, 'invalid limit → default');
    for (const q of ['', '   ', '!!!', null, undefined, 42, {}]) assert.deepEqual(idx.search(q), [], String(q));
    const [first] = idx.search('lyon');
    assert.equal(first.source, 'offline');
    assert.equal(typeof first.score, 'number');
    first.name = 'Mutated';
    assert.equal(idx.search('lyon')[0].name, 'Lyon', 'results are copies');
    assert.equal('score' in idx.list.find((p) => p.name === 'Lyon'), false);
});

test('nearest', () => {
    const paris = idx.nearest(48.85, 2.35);
    assert.equal(paris.city.name, 'Paris');
    assert.equal(paris.city.cc, 'FR');
    assert.ok(paris.km < 1);
    assert.equal(idx.nearest(45.76, 4.84).city.name, 'Lyon');
    const fiji = idx.nearest(-18.1, -179.5);
    assert.equal(fiji.city.name, 'Suva', 'across the antimeridian');
    assert.ok(fiji.km < 250);
    const ocean = idx.nearest(0, -30, 300);
    assert.equal(ocean.city, null, 'nothing within 300 km of the mid-Atlantic');
    assert.ok(ocean.km > 300 && Number.isFinite(ocean.km));
    assert.deepEqual(idx.nearest('x', 2), { city: null, km: Infinity });
    assert.deepEqual(loadCities(null).nearest(0, 0), { city: null, km: Infinity });
});

test('A2: byTz matches canonical zones (Asia/Saigon ≡ Asia/Ho_Chi_Minh)', () => {
    assert.equal(idx.byTz('Asia/Saigon').name, 'Ho Chi Minh City');
    assert.equal(idx.byTz('Asia/Ho_Chi_Minh').name, 'Ho Chi Minh City', 'largest of four cities in the zone');
    assert.equal(idx.byTz('asia/saigon').name, 'Ho Chi Minh City');
    assert.equal(idx.byTz('Asia/Calcutta').name, 'Mumbai');
    assert.equal(idx.byTz('Asia/Kolkata').name, 'Mumbai');
    assert.equal(idx.byTz('Europe/Kiev').name, 'Kyiv');
    assert.equal(idx.byTz('America/Buenos_Aires').name, 'Buenos Aires');
    assert.equal(idx.byTz('Asia/Katmandu').name, 'Kathmandu');
    assert.equal(idx.byTz('Europe/London').name, 'London');
    assert.equal(idx.byTz('UTC'), null, 'no city lives in UTC: the caller falls back to Greenwich');
    for (const bad of ['Nope/Nope', '', '  ', null, undefined, 7]) assert.equal(idx.byTz(bad), null, String(bad));
});

test('A2: the default identity canonicaliser only matches exact ids', () => {
    const plain = loadCities(fixture);
    assert.equal(plain.byTz('Asia/Ho_Chi_Minh').name, 'Ho Chi Minh City');
    assert.equal(plain.byTz('Asia/Saigon'), null, 'why main.js must pass tz.canonTz');
    const throwing = loadCities(fixture, { canonTz: () => { throw new Error('boom'); } });
    assert.equal(throwing.byTz('Asia/Saigon'), null, 'a broken canonicaliser never throws out');
});

test('robust to odd documents', () => {
    for (const doc of [null, undefined, 42, 'cities', {}, { rows: 'x' }, { rows: [null, 5, []] }, { fields: [], rows: [] }]) {
        const c = loadCities(doc);
        assert.equal(c.size, 0);
        assert.deepEqual(c.search('paris'), []);
        assert.equal(c.byTz('Europe/Paris'), null);
    }
    const custom = loadCities({ fields: ['lat', 'lon', 'name', 'cc'], rows: [[10, 20, 'Somewhere', 'zz']] });
    assert.equal(custom.size, 1);
    assert.deepEqual(custom.list[0], { name: 'Somewhere', admin: '', country: 'ZZ', cc: 'ZZ', lat: 10, lon: 20, tz: null, pop: 0, source: 'offline' });
    assert.equal(custom.search('somewhere')[0].name, 'Somewhere');
});

test('placeToObserver and placeLabel', () => {
    const lyon = idx.search('lyon')[0];
    assert.deepEqual(placeToObserver(lyon), {
        latDeg: 45.7491, lonDeg: 4.8479, elevM: 0, name: 'Lyon', country: 'France', tz: 'Europe/Paris', tzApprox: false, source: 'city', cc: 'FR',
    });
    assert.equal(placeToObserver(lyon, 'search').source, 'search');
    assert.equal(placeLabel(lyon), 'Lyon, France');
    const spring = idx.search('springfield')[0];
    assert.equal(placeLabel(spring, { admin: true }), 'Springfield, Illinois, United States');
    assert.equal(placeLabel(idx.search('tokyo')[0], { admin: true }), 'Tokyo, Japan', 'admin equal to the name is skipped');
});

const REAL = new URL('../data/cities.json', import.meta.url);
test('real data/cities.json (when built): A9 default for Asia/Saigon and search speed', { skip: !existsSync(REAL) && 'data/cities.json not built yet' }, () => {
    const real = loadCities(JSON.parse(readFileSync(REAL, 'utf8')), { canonTz });
    assert.ok(real.size > 1000, `${real.size} cities`);
    assert.equal(real.byTz('Asia/Saigon').name, 'Ho Chi Minh City', 'this developer machine must land on Ho Chi Minh City');
    assert.equal(real.byTz('Asia/Ho_Chi_Minh').name, 'Ho Chi Minh City');
    assert.equal(real.byTz('Europe/London').name, 'London');
    assert.equal(real.search('ho chi')[0].name, 'Ho Chi Minh City');
    assert.equal(real.search('sao paulo')[0].name, 'São Paulo');
    const t0 = performance.now();
    for (const q of ['p', 'pa', 'par', 'pari', 'paris', 'londn', 'tokio', 'sao paulo', 'new york', 'paris, us']) real.search(q);
    const per = (performance.now() - t0) / 10;
    assert.ok(per < 25, `search takes ${per.toFixed(2)} ms per keystroke`);
});
