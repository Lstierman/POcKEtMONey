// A visible Chrome window for the scrapers, driven slowly, with its own profile (.scrape-profile/, git-ignored) so
// logins and Cloudflare clearance survive between runs.
// When a site shows a check ("Verify you are human", a login), the scraper stops and waits for YOU to complete it in
// the window; it never clicks or solves those itself.
const path = require('path'), fs = require('fs');
const root = path.join(__dirname, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function chromePath() {
  const c = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  const f = c.find(p => fs.existsSync(p));
  if (!f) throw new Error('Chrome not found; set CHROME_PATH');
  return f;
}

const CHECK_TITLE = /just a moment|attention required|verify you are human|einen moment|sign in|anmelden|einloggen|security check/i;
const CHECK_URL = /challenges\.cloudflare|signin\.ebay|\/splashui\/challenge|captcha/i;

class Browser {
  constructor(opts = {}) { this.gap = opts.gapMs || 7000; this.waitHuman = opts.waitHumanMs || 600e3; this.last = {}; this.pages = 0; }
  async open() {
    let puppeteer;
    try { puppeteer = require('puppeteer-core'); } catch (e) { throw new Error('run "npm install" first (needs puppeteer-core)'); }
    this.b = await puppeteer.launch({ executablePath: chromePath(), headless: false, defaultViewport: null,
      userDataDir: path.join(root, '.scrape-profile'), args: ['--window-size=1250,950'] });
    this.p = (await this.b.pages())[0] || await this.b.newPage();
    return this;
  }
  async close() { if (this.b) await this.b.close(); }
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
      process.stdout.write(`\n>>> ${host} wants a check or login. Please complete it in the Chrome window (waiting up to ${Math.round(this.waitHuman / 60e3)} min)…\n\x07`);
      const t0 = Date.now();
      while (await this.blocked()) {
        if (Date.now() - t0 > this.waitHuman) throw Object.assign(new Error(host + ': check not completed'), { human: true });
        await sleep(2000);
      }
      if (!this.p.url().startsWith(url.split('?')[0])) await this.p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      console.log('>>> thanks, continuing');
    }
    if (ready) await this.p.waitForSelector(ready, { timeout: 20000 }).catch(() => {});
    await sleep(800 + Math.random() * 1200);
    return this.p;
  }
}

module.exports = { Browser, sleep };
