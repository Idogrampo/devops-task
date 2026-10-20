const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const port = 18999;
const url = (path) => `http://127.0.0.1:${port}${path}`;
let server;

before(async () => {
    server = spawn('node', ['app.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
        try { await fetch(url('/live')); return; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
});

after(() => server.kill());

for (const [path, body] of [
    ['/my-app', 'Hello, World!'],
    ['/about', 'This is a sample Node.js application for Kubernetes deployment testing.'],
    ['/ready', 'Ready'],
    ['/live', 'Alive'],
]) {
    test(`GET ${path} returns 200 and its body`, async () => {
        const res = await fetch(url(path));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await res.text(), body);
    });
}

test('unknown route returns 404', async () => {
    const res = await fetch(url('/does-not-exist'));
    assert.strictEqual(res.status, 404);
});

test('/metrics serves Prometheus text format with default and custom metrics', async () => {
    const res = await fetch(url('/metrics'));
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    const body = await res.text();
    assert.match(body, /# TYPE root_access_total counter/);
    assert.match(body, /process_cpu_user_seconds_total/);
});

test('root_access_total counts each /my-app request', async () => {
    const read = async () => {
        const body = await (await fetch(url('/metrics'))).text();
        return Number(body.match(/^root_access_total (\d+)/m)[1]);
    };
    const before = await read();
    await fetch(url('/my-app'));
    await fetch(url('/my-app'));
    assert.strictEqual(await read(), before + 2);
});

test('/about does not touch the counter', async () => {
    const read = async () => Number((await (await fetch(url('/metrics'))).text()).match(/^root_access_total (\d+)/m)[1]);
    const before = await read();
    await fetch(url('/about'));
    assert.strictEqual(await read(), before);
});

test('requests are logged as JSON lines, probes are not', async () => {
    const lines = [];
    const logged = spawn('node', ['app.js'], { env: { ...process.env, PORT: String(port + 1) }, stdio: ['ignore', 'pipe', 'ignore'] });
    logged.stdout.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
    try {
        const base = `http://127.0.0.1:${port + 1}`;
        for (let i = 0; i < 50; i++) {
            try { await fetch(`${base}/live`); break; } catch { await new Promise(r => setTimeout(r, 100)); }
        }
        await fetch(`${base}/my-app`);
        await fetch(`${base}/ready`);
        await new Promise(r => setTimeout(r, 200));
        const entries = lines.filter(l => l.startsWith('{')).map(l => JSON.parse(l));
        assert.deepStrictEqual(entries.map(e => e.path), ['/my-app']);
        assert.strictEqual(entries[0].status, 200);
    } finally {
        logged.kill();
    }
});
