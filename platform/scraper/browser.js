// The Chrome the scraper drives: one tab, its own profile (.scrape-profile/, git-ignored) so logins and Cloudflare
// clearance survive between runs, loaded at a human pace.
// When a site shows a check ("Verify you are human", a login), the scraper stops and waits for YOU to complete it in
// the window; it never clicks or solves those itself. In headless mode nobody can, so the job fails with `human` set
// and the platform backs off.
//
// To stay light on the CPU: images, media and fonts are not downloaded (switched back on while a check is showing,
// so you can see it), the page's JavaScript runs throttled (scrape.rendererCpuThrottle), and Chrome runs at low
// process priority.
const path = require('path'), fs = require('fs'), os = require('os');
const root = path.join(__dirname, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function chromePath() {
  const c = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const f = c.find(p => fs.existsSync(p));
  if (!f) throw new Error('Chrome not found; set CHROME_PATH');
  return f;
}

const CHECK_TITLE = /just a moment|attention required|verify you are human|einen moment|sign in|anmelden|einloggen|security check/i;
const CHECK_URL = /challenges\.cloudflare|signin\.ebay|\/splashui\/challenge|captcha/i;

class Browser {
  constructor(opts = {}) {
    this.gap = opts.gapMs || 7000; this.waitHuman = opts.waitHumanMs || 600e3; this.headless = !!opts.headless;
    this.block = new Set(opts.blockResources || []); this.throttle = opts.cpuThrottle || 1;
    this.onHuman = opts.onHuman || (() => {}); this.last = {}; this.pages = 0; this.allowAll = false;
  }
  async open() {
    let puppeteer;
    try { puppeteer = require('puppeteer-core'); } catch (e) { throw new Error('run "npm install" first (needs puppeteer-core)'); }
    this.b = await puppeteer.launch({ executablePath: chromePath(), headless: this.headless, defaultViewport: null,
      userDataDir: path.join(root, '.scrape-profile'),
      args: ['--window-size=1250,950', '--renderer-process-limit=2', '--disable-background-networking', '--disable-extensions', '--mute-audio'] });
    try { os.setPriority(this.b.process().pid, os.constants.priority.PRIORITY_LOW); } catch (e) {}
    this.p = (await this.b.pages())[0] || await this.b.newPage();
    if (this.block.size) {
      await this.p.setRequestInterception(true);
      this.p.on('request', r => { if (r.isInterceptResolutionHandled()) return; (!this.allowAll && this.block.has(r.resourceType()) ? r.abort() : r.continue()).catch(() => {}); });
    }
    if (this.throttle > 1) await this.p.emulateCPUThrottling(this.throttle).catch(() => {});
    return this;
  }
  // a DevTools session on the browser itself, for measuring every Chrome process's CPU time
  async cdp() { return this.b.target().createCDPSession(); }
  async close() { if (this.b) { const b = this.b; this.b = null; await b.close().catch(() => {}); } }
  async blocked() {
    try { return CHECK_TITLE.test(await this.p.title()) || CHECK_URL.test(this.p.url()); } catch (e) { return true; }
  }
  // load a page: waits so the same site is never hit more often than every `gap` ms (plus jitter), then waits for a human
  // if a check is showing. `ready` is a CSS selector the real page has.
  async visit(url, ready) {
    const host = new URL(url).host, wait = (this.last[host] || 0) + this.gap + Math.random() * this.gap * 0.6 - Date.now();
    if (wait > 0) await sleep(wait);
    this.last[host] = Date.now(); this.pages++;
    await this.p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    if (await this.blocked()) {
      if (this.headless) throw Object.assign(new Error(host + ' shows a check; run with scrape.headless=false to complete it'), { human: true });
      this.allowAll = true; await this.p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      this.onHuman(host);
      process.stdout.write(`\n>>> ${host} wants a check or login. Please complete it in the Chrome window (waiting up to ${Math.round(this.waitHuman / 60e3)} min)…\n\x07`);
      const t0 = Date.now();
      try {
        while (await this.blocked()) {
          if (Date.now() - t0 > this.waitHuman) throw Object.assign(new Error(host + ': check not completed'), { human: true });
          await sleep(2000);
        }
      } finally { this.allowAll = false; }
      if (!this.p.url().startsWith(url.split('?')[0])) await this.p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      console.log('>>> thanks, continuing');
    }
    if (ready) await this.p.waitForSelector(ready, { timeout: 20000 }).catch(() => {});
    await sleep(800 + Math.random() * 1200);
    return this.p;
  }
}

module.exports = { Browser, sleep, chromePath };
