(function () {
  "use strict";

  const DEFAULT_KMAP_URL = "https://jominki354.github.io/kmap/";
  // FRAME_VERSION QUOTA POLICY (Kakao counts 1 quota per SDK script load):
  //   - Every bump invalidates the iframe URL for every user → forces a
  //     full SDK reload on the next session → +1 quota per user.
  //   - Only bump when the iframe contents (kmap/index.html, kmap.css,
  //     kmap.js) actually change in user-visible ways. Changes inside
  //     this bridge file (carrot_map.js) do NOT require a bump.
  //   - Try to batch multiple iframe-side changes into one bump per week.
  const FRAME_VERSION = "2605-15";
  const SEND_INTERVAL_MS = 500;
  const IFRAME_TIMEOUT_MS = 15000;
  const LOCATION_MAX_AGE_MS = 5000;
  // Quota guard windows
  const VISION_WARMUP_MS = 3500;           // require N ms of stable vision-active before loading SDK
  const RETRY_AFTER_MS = 15000;            // recover from transient iframe/network stalls
  const DAILY_WARN_THRESHOLD = 12;          // console.warn when this many SDK loads/day on one device
  const DAILY_HARD_CAP = 30;                // circuit breaker: stop loading further today after this count
  const DEV_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
  const SDK_COUNT_STORAGE_PREFIX = "carrot_kmap_sdk_count_";
  const SDK_LAST_LOAD_STORAGE = "carrot_kmap_last_load";

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeBool(value) {
    if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
    return Boolean(value);
  }

  function isLandscape() {
    if (typeof window.matchMedia === "function") {
      try {
        return window.matchMedia("(orientation: landscape)").matches;
      } catch {}
    }
    return Number(window.innerWidth || 0) >= Number(window.innerHeight || 0);
  }

  function getSetting(key, fallback) {
    const settings = window.CarrotWebSettingsState || {};
    return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
  }

  function isCarrotPageActive() {
    return document.body?.dataset?.page === "carrot";
  }

  function isVisionActive() {
    if (typeof window.isCarrotVisionActive === "function") return window.isCarrotVisionActive();
    return Boolean(window.CarrotVisionState?.active);
  }

  function validLatLon(lat, lon) {
    return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  }

  function normalizeHeading(value, fallback = 0) {
    const heading = finiteNumber(value);
    if (heading === null) return fallback;
    return ((heading % 360) + 360) % 360;
  }

  function resolveTargetOrigin(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.protocol === "file:" ? "*" : parsed.origin;
    } catch {
      return "*";
    }
  }

  function buildFrameUrl(url, options = {}) {
    try {
      const parsed = new URL(url, window.location.href);
      parsed.searchParams.set("cv", FRAME_VERSION);
      parsed.searchParams.set("demo", "0");
      parsed.searchParams.set("mode", "box");
      if (options.debug) {
        parsed.searchParams.set("debug", "1");
      } else {
        parsed.searchParams.delete("debug");
      }
      if (options.forceMock) {
        parsed.searchParams.set("mock", "1");
      } else {
        parsed.searchParams.delete("mock");
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function isDevHost() {
    // Only true-loopback hostnames are auto-dev. Comma devices serve from
    // private LAN IPs (192.168.x.x, 10.x.x.x, etc.) in *production*, so
    // those must NOT be auto-classified as dev — that was causing every
    // user to be silently forced into mock mode.
    const host = (window.location.hostname || "").toLowerCase();
    if (DEV_HOSTNAMES.has(host)) return true;
    // Explicit opt-in for developers running on a private LAN: set
    //   localStorage.setItem('carrot_kmap_dev_mock', '1')
    // or open the page with ?devmock=1 in the URL once per browser.
    try {
      if (window.localStorage?.getItem("carrot_kmap_dev_mock") === "1") return true;
    } catch {}
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("devmock") === "1") {
        try { window.localStorage?.setItem("carrot_kmap_dev_mock", "1"); } catch {}
        return true;
      }
      if (params.get("devmock") === "0") {
        try { window.localStorage?.removeItem("carrot_kmap_dev_mock"); } catch {}
      }
    } catch {}
    return false;
  }

  function todayKey() {
    return SDK_COUNT_STORAGE_PREFIX + new Date().toISOString().slice(0, 10);
  }

  function readSdkLoadCount() {
    try {
      return Number(window.localStorage?.getItem(todayKey())) || 0;
    } catch {
      return 0;
    }
  }

  function writeSdkLoadCount(value) {
    try {
      window.localStorage?.setItem(todayKey(), String(value));
    } catch {
      // Storage may be disabled (private mode / quota); ignore.
    }
  }

  function writeLastLoad(record) {
    try {
      window.localStorage?.setItem(SDK_LAST_LOAD_STORAGE, JSON.stringify(record));
    } catch {
      // ignore
    }
  }

  function pruneOldSdkCounters() {
    try {
      const today = todayKey();
      const keep = new Set([today]);
      const yesterday = SDK_COUNT_STORAGE_PREFIX + new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      keep.add(yesterday);
      const storage = window.localStorage;
      if (!storage) return;
      const remove = [];
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (k && k.startsWith(SDK_COUNT_STORAGE_PREFIX) && !keep.has(k)) remove.push(k);
      }
      for (const k of remove) storage.removeItem(k);
    } catch {
      // ignore
    }
  }

  class CarrotMap {
    constructor() {
      this.dock = document.getElementById("carrotMapDock");
      this.frame = document.getElementById("carrotMapFrame");
      this.loaded = false;
      this.ready = false;
      this.failed = false;
      this.frameUrl = "";
      this.targetOrigin = "*";
      this.sendTimer = 0;
      this.loadTimer = 0;
      this.lastSendAt = 0;
      this.lastHeading = 0;
      this.lastPayloadSig = "";
      this.lastEnabled = false;
      this.resizeObserver = null;
      this.layoutRaf = 0;
      // Quota guards
      this.visionActiveSinceMs = 0;
      this.warmupTimer = 0;
      this.retryTimer = 0;
      this.circuitTrippedToday = false;

      this.handleMessage = this.handleMessage.bind(this);
      this.sync = this.sync.bind(this);
      this.tick = this.tick.bind(this);
      this.updateLayout = this.updateLayout.bind(this);
      this.handleVisibility = this.handleVisibility.bind(this);

      pruneOldSdkCounters();
      this.circuitTrippedToday = readSdkLoadCount() >= DAILY_HARD_CAP;
    }

    init() {
      if (!this.dock || !this.frame) return;
      this.frame.setAttribute("loading", "eager");
      window.addEventListener("message", this.handleMessage);
      window.addEventListener("resize", this.requestLayout);
      window.addEventListener("orientationchange", this.requestLayout);
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", this.requestLayout);
        window.visualViewport.addEventListener("scroll", this.requestLayout);
      }
      window.addEventListener("online", this.sync);
      window.addEventListener("offline", this.sync);
      window.addEventListener("carrot:pagechange", this.sync);
      window.addEventListener("carrot:visionchange", this.sync);
      window.addEventListener("carrot:websettingschange", this.sync);
      window.addEventListener("carrot:render-request", this.tick);
      document.addEventListener("visibilitychange", this.handleVisibility);
      const stage = document.getElementById("carrotStage");
      if (stage && typeof ResizeObserver === "function") {
        this.resizeObserver = new ResizeObserver(this.requestLayout);
        this.resizeObserver.observe(stage);
      }
      this.frame.addEventListener("load", () => {
        this.loaded = true;
        this.clearLoadTimer();
        this.tick();
      });
      this.updateLayout();
      this.sync();
    }

    requestLayout = () => {
      if (this.layoutRaf) return;
      this.layoutRaf = window.requestAnimationFrame(() => {
        this.layoutRaf = 0;
        this.updateLayout();
      });
    };

    settings() {
      const enabled = normalizeBool(getSetting("kmap_enabled", false));
      const rawUrl = String(getSetting("kmap_url", DEFAULT_KMAP_URL) || DEFAULT_KMAP_URL).trim();
      const debug = normalizeBool(getSetting("kmap_debug", false));
      const baseUrl = rawUrl || DEFAULT_KMAP_URL;
      // Strong quota guards: development hosts and the daily circuit breaker
      // force the iframe into mock mode so Kakao SDK is never loaded.
      const forceMock = isDevHost() || this.circuitTrippedToday;
      const url = buildFrameUrl(baseUrl, { debug, forceMock });
      return { enabled, url, debug, forceMock };
    }

    shouldRun() {
      const settings = this.settings();
      if (!settings.enabled) return false;
      if (!isCarrotPageActive()) return false;
      if (!isVisionActive()) return false;
      if (!isLandscape()) return false;
      if (window.navigator.onLine === false) return false;
      if (document.visibilityState === "hidden") return false;
      if (this.failed) return false;
      return true;
    }

    handleVisibility() {
      if (document.visibilityState !== "visible") {
        this.cancelWarmup();
        this.visionActiveSinceMs = 0;
        this.stopSending();
        return;
      }
      this.sync();
    }

    cancelWarmup() {
      if (!this.warmupTimer) return;
      window.clearTimeout(this.warmupTimer);
      this.warmupTimer = 0;
    }

    cancelRetry() {
      if (!this.retryTimer) return;
      window.clearTimeout(this.retryTimer);
      this.retryTimer = 0;
    }

    sync() {
      this.updateLayout();
      const settings = this.settings();
      if (settings.enabled && !this.lastEnabled) {
        this.failed = false;
        this.dock?.removeAttribute("data-error");
      }
      this.lastEnabled = settings.enabled;
      if (!this.shouldRun()) {
        this.cancelWarmup();
        this.visionActiveSinceMs = 0;
        this.stopSending();
        this.hide();
        return;
      }

      // Warm-up gate: don't load the Kakao SDK until vision has been
      // active for VISION_WARMUP_MS. This kills quota churn from quick
      // page taps / brief orientation flips. If the iframe is already
      // loaded (or we're forced into mock), skip the wait.
      const alreadyLoaded = this.frameUrl === settings.url && this.frame.getAttribute("src");
      if (!alreadyLoaded && !settings.forceMock) {
        const now = Date.now();
        if (this.visionActiveSinceMs === 0) this.visionActiveSinceMs = now;
        const elapsed = now - this.visionActiveSinceMs;
        if (elapsed < VISION_WARMUP_MS) {
          // Do NOT call this.show() here — the iframe hasn't loaded yet,
          // so showing the dock now flashes an empty white box. The dock
          // will be revealed by handleMessage("ready") once the iframe
          // actually has content to display.
          this.cancelWarmup();
          this.warmupTimer = window.setTimeout(() => {
            this.warmupTimer = 0;
            this.sync();
          }, VISION_WARMUP_MS - elapsed + 50);
          return;
        }
      }

      this.ensureFrame();
      // Don't show the dock until the iframe reports ready. Otherwise an
      // empty/opaque box flashes on screen while Kakao SDK is still loading.
      if (this.ready) this.show();
      this.startSending();
      this.tick();
    }

    ensureFrame() {
      const { url, forceMock } = this.settings();
      if (this.frameUrl === url && this.frame.getAttribute("src")) return;

      this.ready = false;
      this.loaded = false;
      this.failed = false;
      this.cancelRetry();
      this.frameUrl = url;
      this.targetOrigin = resolveTargetOrigin(url);
      this.lastPayloadSig = "";
      // Hide while the new iframe is loading so we don't flash an empty
      // box. show() will run again from handleMessage("ready").
      this.hide();
      this.frame.setAttribute("src", url);
      this.clearLoadTimer();
      this.loadTimer = window.setTimeout(() => {
        if (!this.ready && !this.loaded) this.fail("iframe_timeout");
      }, IFRAME_TIMEOUT_MS);
    }

    recordSdkLoad() {
      const next = readSdkLoadCount() + 1;
      writeSdkLoadCount(next);
      writeLastLoad({ url: this.frameUrl, at: Date.now() });
      if (next >= DAILY_HARD_CAP) {
        this.circuitTrippedToday = true;
        try { console.warn(`[CarrotMap] daily SDK load cap (${DAILY_HARD_CAP}) reached — forcing mock for the rest of today`); } catch {}
      } else if (next === DAILY_WARN_THRESHOLD) {
        try { console.warn(`[CarrotMap] SDK loaded ${next}x today (warn threshold)`); } catch {}
      }
      return next;
    }

    clearLoadTimer() {
      if (!this.loadTimer) return;
      window.clearTimeout(this.loadTimer);
      this.loadTimer = 0;
    }

    startSending() {
      if (this.sendTimer) return;
      this.sendTimer = window.setInterval(this.tick, SEND_INTERVAL_MS);
    }

    stopSending() {
      if (!this.sendTimer) return;
      window.clearInterval(this.sendTimer);
      this.sendTimer = 0;
    }

    fail(reason) {
      this.failed = true;
      this.ready = false;
      this.stopSending();
      this.hide();
      this.dock?.setAttribute("data-error", reason || "failed");
      this.clearLoadTimer();
      this.cancelRetry();
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = 0;
        this.failed = false;
        this.loaded = false;
        this.ready = false;
        this.frameUrl = "";
        this.lastPayloadSig = "";
        this.dock?.removeAttribute("data-error");
        this.frame?.removeAttribute("src");
        this.sync();
      }, RETRY_AFTER_MS);
    }

    hide() {
      if (!this.dock) return;
      this.dock.hidden = true;
      this.dock.classList.remove("is-visible");
    }

    show() {
      if (!this.dock) return;
      this.dock.hidden = false;
      this.dock.classList.add("is-visible");
    }

    handleMessage(event) {
      const data = event.data || {};
      if (data.source !== "carrot-kmap") return;
      if (data.type === "ready") {
        this.failed = false;
        this.ready = true;
        this.loaded = true;
        this.cancelRetry();
        this.clearLoadTimer();
        this.dock?.removeAttribute("data-error");
        // Only the Kakao provider actually consumes quota. Mock loads
        // (forceMock=1, dev host, fallback) report sdkLoadedAt=0.
        if (Number(data.sdkLoadedAt) > 0 && data.provider === "kakao") {
          this.recordSdkLoad();
        }
        // Now safe to reveal the dock — iframe has actual content.
        if (this.shouldRun()) this.show();
        this.tick();
      } else if (data.type === "error") {
        this.fail(data.error || "iframe_error");
      }
    }

    readLocation() {
      const runtimeState = window.CarrotLiveRuntimeState;
      if (!runtimeState?.ok) return null;

      const services = runtimeState.services || {};
      const carrotMan = services.carrotMan || {};
      const gps = services.gpsLocationExternal || {};
      const fetchedAtMs = finiteNumber(runtimeState.fetchedAtMs) || Date.now();
      if (Date.now() - fetchedAtMs > LOCATION_MAX_AGE_MS) return null;

      const lat = finiteNumber(carrotMan.xPosLat);
      const lon = finiteNumber(carrotMan.xPosLon);
      if (validLatLon(lat, lon)) {
        const heading = normalizeHeading(carrotMan.xPosAngle, this.lastHeading);
        this.lastHeading = heading;
        return {
          lat,
          lon,
          heading,
          speed: Math.max(0, finiteNumber(carrotMan.xPosSpeed) ?? 0),
          ts: fetchedAtMs,
        };
      }

      const gpsLat = finiteNumber(gps.latitude);
      const gpsLon = finiteNumber(gps.longitude);
      if (!validLatLon(gpsLat, gpsLon)) return null;
      const gpsHeading = normalizeHeading(gps.bearingDeg, this.lastHeading);
      this.lastHeading = gpsHeading;
      const gpsSpeed = finiteNumber(gps.speed);
      return {
        lat: gpsLat,
        lon: gpsLon,
        heading: gpsHeading,
        speed: gpsSpeed === null ? 0 : Math.max(0, gpsSpeed * 3.6),
        ts: fetchedAtMs,
      };
    }

    buildPayload() {
      const location = this.readLocation();
      if (!location) return null;
      return {
        source: "carrot-vision",
        type: "vehicle",
        ...location,
      };
    }

    tick() {
      if (!this.shouldRun()) {
        this.sync();
        return;
      }
      if (!this.frame?.contentWindow) return;
      if (!this.ready) return;
      const payload = this.buildPayload();
      if (!payload) {
        this.show();
        return;
      }
      const now = Date.now();
      if (now - this.lastSendAt < SEND_INTERVAL_MS - 80) return;
      const sig = [
        payload.lat.toFixed(5),
        payload.lon.toFixed(5),
        Math.round(payload.heading),
        Math.round(payload.speed),
      ].join("|");
      if (sig === this.lastPayloadSig && now - this.lastSendAt < SEND_INTERVAL_MS * 4) return;
      this.lastPayloadSig = sig;
      this.lastSendAt = now;
      this.frame.contentWindow.postMessage(payload, this.targetOrigin);
      this.show();
    }

    updateLayout() {
      if (!this.dock) return;
      const stage = document.getElementById("carrotStage");
      const stageWidth = stage?.clientWidth || window.innerWidth || 0;
      const stageHeight = stage?.clientHeight || window.innerHeight || 0;
      if (!stageWidth || !stageHeight) return;

      const landscape = stageWidth >= stageHeight;
      const compact = landscape && (stageHeight <= 520 || stageWidth <= 900);
      const short = landscape && stageHeight <= 430;
      const ultraWide = landscape && (stageWidth / stageHeight >= 2.15);
      const right = Math.round(clamp(stageWidth * 0.038, 18, ultraWide ? 72 : 58));
      const minWidth = compact ? 160 : 200;
      const maxWidth = ultraWide ? 520 : 490;
      const widthByStage = clamp(stageWidth * (ultraWide ? 0.22 : 0.28), minWidth, maxWidth);
      const aspect = short ? 1.08 : 1.16;
      const heightByStage = stageHeight * (short ? 0.86 : compact ? 0.84 : 0.82);
      const widthByHeight = heightByStage / aspect;
      const width = Math.round(Math.max(140, Math.min(widthByStage, widthByHeight)));
      const height = Math.round(Math.min(heightByStage, width * aspect));
      const offsetY = 0;

      this.dock.dataset.mode = "box";
      this.dock.style.setProperty("--carrot-map-right", `${right}px`);
      this.dock.style.setProperty("--carrot-map-size", `${width}px`);
      this.dock.style.setProperty("--carrot-map-width", `${width}px`);
      this.dock.style.setProperty("--carrot-map-height", `${height}px`);
      this.dock.style.setProperty("--carrot-map-offset-y", `${offsetY}px`);
    }
  }

  const instance = new CarrotMap();
  window.CarrotMap = instance;

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", () => instance.init(), { once: true });
  } else {
    instance.init();
  }
})();
