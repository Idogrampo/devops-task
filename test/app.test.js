const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const port = 18999;
let server;

before(async () => {
    server = spawn('node', ['app.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
        try { await fetch(`http://127.0.0.1:${port}/live`); return; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    throw new Error('server did not start');
});

after(() => server.kill());

for (const [path, expected] of [['/my-app', 200], ['/ready', 200], ['/live', 200], ['/metrics', 200]]) {
    test(`GET ${path} -> ${expected}`, async () => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.strictEqual(res.status, expected);
    });
}

test('counter increments on /my-app', async () => {
    await fetch(`http://127.0.0.1:${port}/my-app`);
    const body = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(body, /root_access_total [1-9]/);
});
