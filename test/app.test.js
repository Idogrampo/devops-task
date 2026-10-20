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
