// data/cities.json format and content (SPEC §G, ADDENDUM A2/A9) + the build's selection rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FIELDS, parseCities, parseCountries, parseAdmin1, parseTimeZones, normaliseZones, selectCities, buildCities, serializeCities }
    from '../scripts/build-cities.mjs';
import { readZipEntry } from '../scripts/lib/zip.mjs';

const TEXT = fs.readFileSync(new URL('../data/cities.json', import.meta.url), 'utf8');
const DOC = JSON.parse(TEXT);
const COL = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
const rows = DOC.rows;
const byName = (n, cc) => rows.find((r) => r[COL.name] === n && (!cc || r[COL.cc] === cc));
const largestIn = (tz) => rows.filter((r) => r[COL.tz] === tz).sort((a, b) => b[COL.pop] - a[COL.pop])[0];

test('header and field list', () => {
    assert.equal(DOC.v, 1);
    assert.match(DOC.source, /GeoNames.*CC BY 4\.0/);
    assert.deepEqual(DOC.fields, ['name', 'ascii', 'cc', 'admin', 'lat', 'lon', 'tz', 'pop']);
    assert.ok(rows.length >= 1200 && rows.length <= 2200, `${rows.length} rows (target ≈ 1,500)`);
});

test('every row is well-formed', () => {
    const seen = new Set();
    for (const r of rows) {
        const [name, ascii, cc, admin, lat, lon, tz, pop] = r;
        assert.equal(r.length, 8);
        assert.ok(typeof name === 'string' && name.length > 0, 'name');
        assert.ok(typeof ascii === 'string' && /^[\x20-\x7e]+$/.test(ascii), `ascii "${ascii}"`);
        assert.ok(/^[A-Z]{2}$/.test(cc) && typeof DOC.countries[cc] === 'string', `country ${cc}`);
        assert.equal(typeof admin, 'string');
        assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180, `${name} coordinates`);
        assert.ok(Math.round(lat * 1e4) / 1e4 === lat && Math.round(lon * 1e4) / 1e4 === lon, `${name} 4 decimals`);
        assert.ok(Number.isInteger(pop) && pop >= 0, `${name} population`);
        assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: tz }), `${name} zone ${tz}`);
        const key = `${name}|${cc}|${lat}|${lon}`;
        assert.ok(!seen.has(key), `duplicate ${key}`);
        seen.add(key);
    }
    const used = new Set(rows.map((r) => r[COL.cc]));
    assert.deepEqual(Object.keys(DOC.countries).sort(), [...used].sort(), 'countries map lists exactly the used codes');
});

test('sorted by population, largest first', () => {
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i][COL.pop] <= rows[i - 1][COL.pop], `row ${i}`);
});

test('Vietnam: Ho Chi Minh City owns Asia/Ho_Chi_Minh; Hanoi present on the same zone', () => {
    const hcmc = byName('Ho Chi Minh City', 'VN');
    assert.ok(hcmc, 'Ho Chi Minh City present');
    assert.equal(hcmc[COL.tz], 'Asia/Ho_Chi_Minh');
    assert.equal(largestIn('Asia/Ho_Chi_Minh'), hcmc, 'largest city of its zone (the tz guess on Asia/Saigon systems)');
    const hanoi = byName('Hanoi', 'VN');
    assert.ok(hanoi, 'Hanoi present');
    assert.equal(hanoi[COL.tz], 'Asia/Ho_Chi_Minh');
    assert.equal(largestIn('Asia/Bangkok')[COL.name], 'Bangkok', 'Thailand’s zone resolves to Bangkok, not Hanoi');
});

test('well-known cities and capitals are present', () => {
    for (const [n, cc] of [['London', 'GB'], ['Tokyo', 'JP'], ['New York City', 'US'], ['São Paulo', 'BR'], ['Sydney', 'AU'],
        ['Canberra', 'AU'], ['Ottawa', 'CA'], ['Brasília', 'BR'], ['Wellington', 'NZ'], ['Bern', 'CH'], ['Reykjavík', 'IS'],
        ['Nairobi', 'KE'], ['Mumbai', 'IN'], ['Kyiv', 'UA'], ['Buenos Aires', 'AR']]) {
        assert.ok(byName(n, cc), `${n}, ${cc}`);
    }
    assert.equal(largestIn('Europe/London')[COL.name], 'London');
    assert.ok(new Set(rows.map((r) => r[COL.tz])).size >= 300, 'hundreds of zones covered');
});

// ---- selection rules on a synthetic fixture (no network, no cache needed)

const fixtureLine = (id, name, lat, lon, fcode, cc, pop, tz) =>
    [id, name, name, '', lat, lon, 'P', fcode, cc, '', '01', '', '', '', pop, '', '', tz, '2024-01-01'].join('\t');

test('selectCities: capitals, ≥ 500k, top 3 per country, largest per zone', () => {
    const cities = parseCities([
        fixtureLine(1, 'Bigcity', 10, 10, 'PPL', 'AA', 900000, 'Etc/A'),
        fixtureLine(2, 'Capital', 11, 11, 'PPLC', 'AA', 20000, 'Etc/A'),
        fixtureLine(3, 'Second', 12, 12, 'PPL', 'AA', 300000, 'Etc/A'),
        fixtureLine(4, 'Third', 13, 13, 'PPL', 'AA', 200000, 'Etc/A'),
        fixtureLine(5, 'Fourth', 14, 14, 'PPL', 'AA', 100000, 'Etc/A'),
        fixtureLine(6, 'Lonely', 15, 15, 'PPL', 'AA', 16000, 'Etc/B'),
    ].join('\n'));
    const names = selectCities(cities).map((c) => c.name);
    assert.deepEqual(names, ['Bigcity', 'Second', 'Third', 'Capital', 'Lonely']);
});

test('normaliseZones moves a city off a foreign zone only when its own zone is unique and identical', () => {
    const zones = parseTimeZones('CountryCode\tTimeZoneId\tGMT\tDST\traw\n'
        + 'TH\tAsia/Bangkok\t7.0\t7.0\t7.0\nVN\tAsia/Ho_Chi_Minh\t7.0\t7.0\t7.0\n'
        + 'RS\tEurope/Belgrade\t1.0\t2.0\t1.0\nUS\tAmerica/New_York\t-5.0\t-4.0\t-5.0\nUS\tAmerica/Chicago\t-6.0\t-5.0\t-6.0\n');
    const { cities, moved } = normaliseZones([
        { name: 'Hanoi', cc: 'VN', tz: 'Asia/Bangkok' },
        { name: 'Bangkok', cc: 'TH', tz: 'Asia/Bangkok' },
        { name: 'Pristina', cc: 'XK', tz: 'Europe/Belgrade' },
        { name: 'Odd', cc: 'US', tz: 'Asia/Bangkok' },
    ], zones);
    assert.deepEqual(cities.map((c) => c.tz), ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Europe/Belgrade', 'Asia/Bangkok']);
    assert.deepEqual(moved.map((m) => m.name), ['Hanoi']);
});

test('parsers and serializer round-trip', () => {
    assert.deepEqual(parseCountries('#ISO\tISO3\nVN\tVNM\t704\tVM\tVietnam\tHanoi\n'), { VN: 'Vietnam' });
    assert.deepEqual(parseAdmin1('VN.44\tHanoi\tHanoi\t1581129\n'), { 'VN.44': 'Hanoi' });
    const doc = buildCities({
        cities: parseCities(fixtureLine(7, 'Zed', 1.23456, -2.34567, 'PPLC', 'ZZ', 1000, 'Etc/UTC')),
        countries: { ZZ: 'Zedland' }, admin1: { 'ZZ.01': 'Zed Province' }, retrieved: '2026-10-10',
    });
    assert.deepEqual(doc.rows, [['Zed', 'Zed', 'ZZ', 'Zed Province', 1.2346, -2.3457, 'Etc/UTC', 1000]]);
    assert.deepEqual(JSON.parse(serializeCities(doc)), doc);
});

test('rebuild from the local GeoNames cache matches the committed file (skipped without cache)', (t) => {
    const cache = new URL('../data/raw/geonames/', import.meta.url);
    const files = ['cities15000.zip', 'countryInfo.txt', 'admin1CodesASCII.txt', 'timeZones.txt'];
    if (!files.every((f) => fs.existsSync(new URL(f, cache)))) {
        t.skip('data/raw/geonames/ not present (it is gitignored; run node scripts/build-cities.mjs)');
        return;
    }
    const read = (f) => fs.readFileSync(new URL(f, cache), 'utf8');
    const cities = parseCities(readZipEntry(fs.readFileSync(new URL('cities15000.zip', cache)), 'cities15000.txt').toString('utf8'));
    const norm = normaliseZones(cities, parseTimeZones(read('timeZones.txt')));
    const doc = buildCities({ cities: norm.cities, countries: parseCountries(read('countryInfo.txt')),
        admin1: parseAdmin1(read('admin1CodesASCII.txt')), retrieved: DOC.retrieved });
    assert.deepEqual(doc.rows, DOC.rows, 'data/cities.json differs from a rebuild of the cached dump');
});
