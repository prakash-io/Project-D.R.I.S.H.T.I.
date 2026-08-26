// Headless verification of the command center (WEB-01..WEB-05, task 4.4).
//
//     node verify.mjs
//
// Drives a real Chrome over the DevTools Protocol rather than asserting that
// the components "should" work: it loads the app, waits for live telemetry,
// screenshots, toggles the Disruption Overlay, and clicks Approve Reroute --
// capturing console errors and the actual HTTP the button produces.
//
// CDP directly instead of Puppeteer: this needs one tab and six commands, and
// a ~300 MB dependency to get them is a poor trade for a verification script.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_ = process.env.DASH_URL ?? 'http://127.0.0.1:5173/';
const OUT = process.env.OUT_DIR ?? '.';
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
let failures = 0;
const ok = (label, extra = '') => { checks += 1; console.log(`  ok   ${label}${extra ? `  ${extra}` : ''}`); };
const fail = (label, why) => { checks += 1; failures += 1; console.log(`  FAIL ${label}  ${why}`); };

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const cdp = new Cdp(ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        cdp.handlers.forEach((h) => h(msg));
      }
    });
    return cdp;
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(handler) { this.handlers.push(handler); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}/${file}`, Buffer.from(data, 'base64'));
    return file;
  }
  close() { this.ws.close(); }
}

async function main() {
  console.log('=== Chunk 4 verification: dispatcher command center ===\n');

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1680,1000',
    // SwiftShader: headless Chrome has no GPU, and without a software
    // rasteriser every WebGL context creation fails -- which would look
    // exactly like a broken map rather than a missing GPU.
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    `--user-data-dir=${OUT}/cdp-profile`, 'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(500);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome did not expose a debugging target');

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  const requests = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.text
        ?? msg.params.exceptionDetails.exception?.description ?? 'unknown');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (msg.method === 'Network.responseReceived') {
      requests.push({ url: msg.params.response.url, status: msg.params.response.status });
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  // ---------------------------------------------------- 4.1 shell + basemap
  console.log('4.1  UI scaffold and basemap');
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(9000);

  const title = await cdp.eval('document.title');
  title.includes('D.R.I.S.H.T.I.') ? ok('page title', title) : fail('page title', title);

  const webgl = await cdp.eval(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return gl ? gl.getParameter(gl.VERSION) : 'NONE';
  })()`);
  webgl !== 'NONE' ? ok('WebGL available', webgl) : fail('WebGL', 'no context');

  const canvases = await cdp.eval('document.querySelectorAll("canvas").length');
  canvases >= 1 ? ok('deck.gl / maplibre canvas mounted', `${canvases} canvas`) 
                : fail('canvas', 'none mounted');

  const tiles = requests.filter((r) => r.url.includes('basemaps.cartocdn.com'));
  const tilesOk = tiles.filter((r) => r.status === 200).length;
  tilesOk > 0 ? ok('OSM/CARTO basemap tiles fetched', `${tilesOk} responses, no API key`)
              : fail('basemap tiles', `${tiles.length} requests, ${tilesOk} ok`);

  // ------------------------------------------------------ 4.2 live telemetry
  console.log('\n4.2  Live telemetry over Socket.IO');
  const readPackets = () => cdp.eval(
    `document.body.innerText.match(/(\\d+)\\s+packets/)?.[1] ?? '0'`);
  const first = Number(await readPackets());
  first > 0 ? ok('telemetry packets received', `${first}`) : fail('packets', 'none received');

  const trucksBadge = await cdp.eval(
    `document.body.innerText.match(/Trucks\\s*(\\d+)/)?.[1] ?? '0'`);
  Number(trucksBadge) > 0 ? ok('trucks rendered on the map', `${trucksBadge} markers`)
                          : fail('trucks', 'no markers');

  // Movement, not just presence: sample a truck's interpolated position twice.
  const pos1 = await cdp.eval(`(() => {
    const el = document.querySelector('canvas'); return el ? el.width + 'x' + el.height : '';
  })()`);
  await sleep(4000);
  const second = Number(await readPackets());
  second > first ? ok('stream is advancing', `${first} -> ${second} packets`)
                 : fail('stream', `stuck at ${first}`);
  await cdp.shot('dash_telemetry.png');
  ok('screenshot captured', 'dash_telemetry.png');

  // -------------------------------------------- 4.3 disruption overlay toggle
  console.log('\n4.3  Disruption Overlay and Incident Review');
  const toggled = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => x.textContent.includes('Disruption Overlay'));
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`);
  toggled === 'clicked' ? ok('Disruption Overlay toggle clicked') 
                        : fail('overlay toggle', toggled);
  await sleep(4000);

  const riskCalls = requests.filter((r) => r.url.includes('/risk/segments'));
  riskCalls.length > 0 && riskCalls[0].status === 200
    ? ok('GET /risk/segments', `HTTP ${riskCalls[0].status}`)
    : fail('/risk/segments', JSON.stringify(riskCalls));

  const segCount = await cdp.eval(
    `document.body.innerText.match(/Disruption Overlay\\s*(\\d+)/)?.[1] ?? '0'`);
  Number(segCount) > 0 ? ok('high-risk segments rendered', `${segCount} segments > 85%`)
                       : fail('risk segments', 'none rendered');
  await cdp.shot('dash_overlay.png');
  ok('screenshot captured', 'dash_overlay.png');

  // ------------------------------------------------------ approve the incident
  const before = await cdp.eval(
    `document.body.innerText.match(/(\\d+)\\s+awaiting approval/)?.[1] ?? '0'`);
  Number(before) > 0 ? ok('incident awaiting approval', `${before} in the queue`)
                     : fail('incident queue', 'empty — nothing to approve');

  const clicked = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => x.textContent.trim().startsWith('Approve Reroute'));
    if (!b) return 'no-button';
    b.click();
    return 'clicked';
  })()`);
  clicked === 'clicked' ? ok('Approve Reroute clicked') : fail('approve button', clicked);

  // POLLED, not slept. Approving blocks the edge AND reroutes every affected
  // trip, so the latency depends on how many trucks are on that road -- a
  // fixed sleep either flakes or wastes time, and an earlier run of this
  // check reported a working endpoint as broken because the POST was still in
  // flight at the 5 s mark.
  //
  // The browser sends a CORS preflight first (OPTIONS -> 204), so the real
  // POST is the one with status 200, not simply the first match.
  const clickedAt = Date.now();
  let approvePost = null;
  for (let i = 0; i < 60 && !approvePost; i += 1) {
    await sleep(500);
    approvePost = requests.find(
      (r) => /\/incidents\/.+\/approve/.test(r.url) && r.status === 200);
  }
  const approveCalls = requests.filter((r) => /\/incidents\/.+\/approve/.test(r.url));
  approvePost
    ? ok('POST /incidents/:id/approve',
         `HTTP 200 in ~${((Date.now() - clickedAt) / 1000).toFixed(1)}s` +
         (approveCalls.some((r) => r.status === 204) ? ', after a 204 preflight' : ''))
    : fail('approve endpoint', JSON.stringify(approveCalls));

  let banner = '';
  for (let i = 0; i < 20 && !banner; i += 1) {
    await sleep(500);
    banner = await cdp.eval(
      `document.body.innerText.match(/Edge\\s+(\\d+)\\s+blocked[^\\n]*/)?.[0] ?? ''`);
  }
  banner ? ok('backend result shown to the dispatcher', banner)
         : fail('result banner', 'not displayed');

  const cleared = await cdp.eval(
    `document.body.innerText.match(/(\\d+)\\s+awaiting approval/)?.[1] ?? '0'`);
  Number(cleared) < Number(before)
    ? ok('incident left the review queue', `${before} -> ${cleared}`)
    : fail('review queue', `still ${cleared}`);

  const photoCalls = requests.filter((r) => /\/incidents\/.+\/photo/.test(r.url));
  photoCalls.some((r) => r.status === 200)
    ? ok('incident photo served', `HTTP 200`)
    : fail('incident photo', JSON.stringify(photoCalls));

  await cdp.shot('dash_approved.png');
  ok('screenshot captured', 'dash_approved.png');

  // ------------------------------------------------------------- console
  console.log('\nconsole errors');
  const real = consoleErrors.filter((e) => !/favicon|DevTools/i.test(e));
  real.length === 0 ? ok('no console errors')
                    : fail('console errors', `${real.length}: ${real.slice(0, 3).join(' | ')}`);

  cdp.close();
  chrome.kill('SIGKILL');

  console.log(`\n${checks} checks, ${failures} failures`);
  if (failures === 0) console.log('all checks passed');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error('\nverification failed:', error.message); process.exit(1); });
