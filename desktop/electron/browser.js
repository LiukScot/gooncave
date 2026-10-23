// The browser engine the core sends FurAffinity and Rule34 page requests through, so they
// pass Cloudflare's browser check, and the windows where the person signs in to them.
const { BaseWindow, WebContentsView, session } = require('electron');

/** How long the worker lives after the last request. */
const IDLE_MS = 60_000;
/** Height of the explanation above a check or sign-in page. */
const HEADER = 64;
/** What the worker does not load: its scripts only fetch pages. Cloudflare's check loads in full. */
const HEAVY = new Set(['image', 'media', 'font', 'ping', 'cspReport']);

/** Errors the core turns into messages for the person. */
const UNREACHABLE = 'unreachable';
const CLOSED = 'closed';

/** Logs why a page did not load; the load events decide what happens next. */
const logLoad = (error) => {
  // A load replaced by a redirect or another load is not a failure.
  if (error?.code !== 'ERR_ABORTED') console.error(`GoonCave's browser could not load a page: ${error}`);
};

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Queues a page's loads, failures and its window closing, to be awaited one at a time. */
class Events {
  constructor(contents, window) {
    this.queue = [];
    this.waiter = null;
    const push = (event) => {
      if (this.waiter) {
        this.waiter(event);
        this.waiter = null;
      } else {
        this.queue.push(event);
      }
    };
    const loaded = () => push('loaded');
    // Code -3 is a load replaced by another one, which reports on its own.
    const failed = (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) push('failed');
    };
    const closed = () => push('closed');
    contents.on('did-finish-load', loaded);
    contents.on('did-fail-load', failed);
    window?.on('closed', closed);
    this.dispose = () => {
      if (!contents.isDestroyed()) {
        contents.off('did-finish-load', loaded);
        contents.off('did-fail-load', failed);
      }
      window?.off('closed', closed);
    };
  }

  next() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

class Engine {
  /**
   * `scripts` holds the bodies of async functions the core runs in a site's pages: `fetch`
   * gets `url` as its argument. `parent` returns the app window, if any, to hold the
   * windows this opens.
   */
  constructor(scripts, parent) {
    this.scripts = scripts;
    this.parent = parent;
    this.session = session.fromPartition('persist:browser');
    this.session.setSpellCheckerEnabled(false);
    this.session.setPermissionRequestHandler((_contents, _permission, allow) => allow(false));
    /** Stays on a page of the last site it fetched so its scripts can fetch other pages of it. */
    this.worker = null;
    this.hidden = null;
    /** The cookie domain, like `.furaffinity.net`, of the site the worker is on. */
    this.domain = '';
    this.busy = 0;
    this.idle = null;
    /** One fetch at a time, so a check window never sees a second request. */
    this.queue = Promise.resolve();
    this.session.webRequest.onBeforeRequest((details, reply) => reply({ cancel: this.blocks(details) }));
  }

  blocks({ url, resourceType, webContentsId }) {
    if (!this.worker || webContentsId !== this.worker.webContents.id) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    if (parsed.hostname === 'challenges.cloudflare.com' || parsed.pathname.startsWith('/cdn-cgi/')) return false;
    if (HEAVY.has(resourceType)) return true;
    // Other sites' scripts (ads, analytics) only cost memory.
    const host = `.${parsed.hostname}`;
    return !host.endsWith(this.domain);
  }

  view() {
    if (this.worker) return this.worker;
    this.hidden = new BaseWindow({ show: false, width: 900, height: 760 - HEADER });
    this.worker = new WebContentsView({
      webPreferences: { session: this.session, spellcheck: false, backgroundThrottling: false }
    });
    this.worker.setBounds({ x: 0, y: 0, width: 900, height: 760 - HEADER });
    this.hidden.contentView.addChildView(this.worker);
    // A worker whose page process ended cannot run scripts; the next request makes another.
    const worker = this.worker;
    worker.webContents.on('render-process-gone', () => {
      if (this.worker === worker) this.drop();
    });
    return worker;
  }

  /** Ends the worker and every process it started; the next request makes a new one. */
  drop() {
    const { worker, hidden } = this;
    this.worker = null;
    this.hidden = null;
    if (worker && !worker.webContents.isDestroyed()) worker.webContents.close();
    if (hidden && !hidden.isDestroyed()) hidden.destroy();
  }

  parkWhenIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.busy === 0) this.drop();
    }, IDLE_MS);
  }

  /** A window with `message` above `view`. */
  framed(title, message, view) {
    const parent = this.parent();
    const window = new BaseWindow({ width: 900, height: 760, title, parent: parent ?? undefined });
    const header = new WebContentsView({ webPreferences: { spellcheck: false } });
    const page = `<!doctype html><meta name="color-scheme" content="light dark"><body style="margin:0;padding:12px 16px;font:14px/1.4 system-ui,sans-serif">${escapeHtml(message)}`;
    header.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
      .catch((error) => console.error(`Cannot show the window's explanation: ${error}`));
    window.contentView.addChildView(header);
    window.contentView.addChildView(view);
    const layout = () => {
      const { width, height } = window.getContentBounds();
      header.setBounds({ x: 0, y: 0, width, height: HEADER });
      view.setBounds({ x: 0, y: HEADER, width, height: Math.max(0, height - HEADER) });
    };
    layout();
    window.on('resize', layout);
    window.on('closed', () => {
      if (!header.webContents.isDestroyed()) header.webContents.close();
    });
    return window;
  }

  async run(contents, script, url = null) {
    try {
      return await contents.executeJavaScript(`(async (url) => {\n${script}\n})(${JSON.stringify(url)})`);
    } catch (error) {
      console.error(`Browser script failed: ${error}`);
      throw new Error(UNREACHABLE, { cause: error });
    }
  }

  async challenged() {
    try {
      return (await this.run(this.view().webContents, this.scripts.challenged)) === true;
    } catch {
      return false;
    }
  }

  /** Puts the worker on `origin`, showing Cloudflare's check to the person when it asks for one. */
  async ready(origin, check, force) {
    const on = (url) => url.startsWith(origin) && url.slice(origin.length).startsWith('/');
    // A move to another site starts a new worker, so the old site's page process ends.
    if (this.worker && this.worker.webContents.getURL() && !on(this.worker.webContents.getURL())) this.drop();
    const view = this.view();
    if (on(view.webContents.getURL()) && !force && !(await this.challenged())) return;
    const loading = new Events(view.webContents, null);
    // A text page is enough to run the fetches and costs a fraction of a site's home page.
    // When a fetch still meets the check, the home page earns a new clearance.
    view.webContents.loadURL(`${origin}${force ? '/' : '/robots.txt'}`).catch(logLoad);
    const loaded = await loading.next();
    loading.dispose();
    if (loaded !== 'loaded') throw new Error(UNREACHABLE);
    if (!(await this.challenged())) return;
    this.hidden.contentView.removeChildView(view);
    const window = this.framed(check.title, check.message, view);
    const events = new Events(view.webContents, window);
    try {
      for (;;) {
        const event = await events.next();
        if (event === 'closed') throw new Error(CLOSED);
        if (event === 'loaded' && !(await this.challenged())) return;
      }
    } finally {
      events.dispose();
      // Hands the worker back so it keeps running without a window.
      if (!window.isDestroyed()) {
        window.contentView.removeChildView(view);
        window.destroy();
      }
      if (this.worker === view && this.hidden) {
        view.setBounds({ x: 0, y: 0, width: 900, height: 760 - HEADER });
        this.hidden.contentView.addChildView(view);
      }
    }
  }

  /**
   * GETs `url` with the engine's cookies, after storing `cookies` (`[name, value]` pairs).
   * `diagnostics` (Developer mode) logs which cookies a favorite removal carries, by name.
   */
  fetch({ url, origin, domain, cookies, check, diagnostics }) {
    const task = this.queue.then(async () => {
      this.busy += 1;
      try {
        this.domain = domain;
        for (const [name, value] of cookies) {
          await this.session.cookies
            .set({ url: origin, name, value, domain, path: '/', secure: true, httpOnly: true })
            .catch((error) => console.error(`Cannot store the session in GoonCave's browser: ${error}`));
        }
        if (diagnostics === true && url.includes('s=delete')) {
          const jar = await this.session.cookies.get({ url: `${origin}/` });
          console.error(
            `[developer] unfavorite on ${origin}: GoonCave sent cookies ${cookies.map(([name]) => name).join(', ')}; the browser holds ${jar.map((c) => `${c.name} (${c.domain})`).join(', ')}`
          );
        }
        let force = false;
        for (;;) {
          await this.ready(origin, check, force);
          const page = await this.run(this.view().webContents, this.scripts.fetch, url);
          if (page?.challenged === true && !force) {
            // The clearance expired since the worker's page loaded; get a new one.
            force = true;
            continue;
          }
          if (!Number.isInteger(page?.status)) throw new Error(UNREACHABLE);
          return { status: page.status, body: typeof page.body === 'string' ? page.body : '' };
        }
      } finally {
        this.busy -= 1;
        this.parkWhenIdle();
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  /** The session cookie (`a=…; b=…`) the engine holds at `base`, when it holds all of it. */
  async sessionCookie(base, names) {
    const jar = await this.session.cookies.get({ url: `${base}/` });
    const parts = names.map((name) => {
      const cookie = jar.find((found) => found.name === name);
      return cookie && `${name}=${cookie.value}`;
    });
    return parts.every(Boolean) ? parts.join('; ') : null;
  }

  /** Lets the person sign in at `base`. Returns the session and account, or null when closed. */
  async signIn({ base, login, title, message, session: names, account }) {
    const view = new WebContentsView({ webPreferences: { session: this.session, spellcheck: false } });
    const window = this.framed(title, message, view);
    const events = new Events(view.webContents, window);
    view.webContents.loadURL(`${base}${login}`).catch(logLoad);
    try {
      // An expired session leaves its cookies behind, so they count only once they change
      // or the page shows a signed-in account.
      const stale = await this.sessionCookie(base, names);
      for (;;) {
        const event = await events.next();
        if (event === 'closed') return null;
        if (event === 'failed') continue;
        const current = await this.sessionCookie(base, names);
        if (!current) continue;
        let username = null;
        if (account) {
          username = current.split('; ').find((pair) => pair.startsWith(`${account}=`))?.slice(account.length + 1) ?? null;
        } else {
          username = await this.run(view.webContents, this.scripts.username).catch(() => null);
        }
        if (typeof username !== 'string' || username === '') username = null;
        if (username || current !== stale) return { session: current, username };
      }
    } finally {
      events.dispose();
      if (!window.isDestroyed()) window.destroy();
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }
}

module.exports = { Engine, CLOSED, UNREACHABLE };
