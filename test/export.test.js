const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Work on a temp copy of the data so tests never touch data/expenses.json
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-')), 'expenses.json');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'expenses.json'), tmp);
process.env.EXPENSES_FILE = tmp;

const app = require('../src/app');
const server = app.listen(0);
after(() => server.close());

function request(method, urlPath, data) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? null : JSON.stringify(data);
    const req = http.request(
      {
        port: server.address().port,
        path: urlPath,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          const json = res.headers['content-type']?.includes('json') ? JSON.parse(body) : body;
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const HEADER = 'date,category,amount,note';
const lines = (body) => body.split('\n').filter((l) => l !== '');

test('GET /expenses/export.csv returns September as CSV, header first, date ascending', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2026-09-01&to=2026-09-30');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'text/csv; charset=utf-8');
  const [header, ...rows] = lines(res.body);
  assert.strictEqual(header, HEADER);
  assert.strictEqual(rows.length, 18);
  const dates = rows.map((r) => r.slice(0, 10));
  assert.ok(dates.every((d) => d >= '2026-09-01' && d <= '2026-09-30'));
  assert.deepStrictEqual(dates, [...dates].sort());
});

test('GET /expenses/export.csv range is inclusive on both ends', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2026-09-05&to=2026-09-05');
  assert.strictEqual(res.status, 200);
  const rows = lines(res.body).slice(1);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.startsWith('2026-09-05,')));
});

test('GET /expenses/export.csv includes rows on both edge days of a multi-day range', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2026-09-05&to=2026-09-19');
  assert.strictEqual(res.status, 200);
  const rows = lines(res.body).slice(1);
  assert.ok(rows[0].startsWith('2026-09-05,'), rows[0]);
  assert.ok(rows[rows.length - 1].startsWith('2026-09-19,'), rows[rows.length - 1]);
});

test('GET /expenses/export.csv quotes a note that contains a comma', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2026-09-05&to=2026-09-05');
  assert.ok(lines(res.body).some((r) => r.endsWith(',"Groceries: rice, dal, oil"')), res.body);
});

test('GET /expenses/export.csv doubles a double quote and quotes a newline inside a note', async () => {
  const add = await request('POST', '/expenses', { date: '2026-11-15', amount: 50, category: 'misc', note: 'Said "hi", left' });
  assert.strictEqual(add.status, 201);
  const add2 = await request('POST', '/expenses', { date: '2026-11-16', amount: 60, category: 'misc', note: 'line one\nline two' });
  assert.strictEqual(add2.status, 201);
  const res = await request('GET', '/expenses/export.csv?from=2026-11-15&to=2026-11-16');
  assert.strictEqual(res.body, `${HEADER}\n2026-11-15,misc,50,"Said ""hi"", left"\n2026-11-16,misc,60,"line one\nline two"\n`);
});

test('GET /expenses/export.csv quotes a category that contains a comma', async () => {
  const add = await request('POST', '/expenses', { date: '2026-11-17', amount: 70, category: 'food, dining', note: 'Lunch' });
  assert.strictEqual(add.status, 201);
  const res = await request('GET', '/expenses/export.csv?from=2026-11-17&to=2026-11-17');
  assert.deepStrictEqual(lines(res.body), [HEADER, '2026-11-17,"food, dining",70,Lunch']);
});

test('GET /expenses/export.csv rejects missing, invalid or reversed dates with 400', async () => {
  const cases = [
    '',
    '?to=2026-09-30',
    '?from=2026-09-01',
    '?from=2026-13-45&to=2026-09-30',
    '?from=2026-02-30&to=2026-09-30',
    '?from=2026/2/30&to=2026-09-30',
    '?from=05-09-2026&to=2026-09-30',
    '?from=2026/09-05&to=2026-09-30',
    '?from=2026.09.05&to=2026-09-30',
    '?from=2026-09-30&to=2026-09-01',
  ];
  for (const q of cases) {
    const res = await request('GET', '/expenses/export.csv' + q);
    assert.strictEqual(res.status, 400, q);
    assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0, q);
  }
});

test('GET /expenses/export.csv sets Content-Disposition with the range in the filename', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2026-09-01&to=2026-09-30');
  assert.strictEqual(res.headers['content-disposition'], 'attachment; filename="expenses-2026-09-01-2026-09-30.csv"');
});

test('GET /expenses/export.csv returns only the header for an empty range', async () => {
  const res = await request('GET', '/expenses/export.csv?from=2030-01-01&to=2030-01-31');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(lines(res.body), [HEADER]);
});

test('GET /expenses/export.csv accepts YYYY/MM/DD and dates without leading zeros', async () => {
  const base = await request('GET', '/expenses/export.csv?from=2026-09-01&to=2026-09-30');
  for (const q of ['?from=2026/09/01&to=2026/09/30', '?from=2026-9-1&to=2026-9-30', '?from=2026/9/1&to=2026/9/30']) {
    const res = await request('GET', '/expenses/export.csv' + q);
    assert.strictEqual(res.status, 200, q);
    assert.strictEqual(res.body, base.body, q);
    assert.strictEqual(res.headers['content-disposition'], base.headers['content-disposition'], q);
  }
});
