(function () {
  "use strict";

  const DEFAULT_KMAP_URL = "https://jominki354.github.io/kmap/";
  // FRAME_VERSION QUOTA POLICY (Kakao counts 1 quota per SDK script load):
  //   - Every bump invalidates the iframe URL for every user, forcing a
  //     full SDK reload on the next session and +1 quota per user.
  //   - Only bump when the iframe contents (kmap/index.html, kmap.css,
  //     kmap.js) actually change in user-visible ways. Changes inside
  //     this bridge file (carrot_map.js) do NOT require a bump.
  //   - Try to batch multiple iframe-side changes into one bump per week.
  const FRAME_VERSION = "2605-33";
  const SEND_INTERVAL_MS = 500;
  const NAV_KEEPALIVE_MS = 1200;
  const IFRAME_TIMEOUT_MS = 15000;
  const LOCATION_MAX_AGE_MS = 5000;
  const EXPANDED_AUTO_HIDE_MS = 8000;
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

  function setBoolSearchParam(params, key, value) {
    params.set(key, normalizeBool(value) ? "1" : "0");
  }

  function buildFrameUrl(url, options = {}) {
    try {
      const parsed = new URL(url, window.location.href);
      parsed.searchParams.set("cv", FRAME_VERSION);
      parsed.searchParams.set("demo", "0");
      parsed.searchParams.set("mode", "box");
      setBoolSearchParam(parsed.searchParams, "heading_up", options.headingUp ?? true);
      setBoolSearchParam(parsed.searchParams, "grid", options.showGrid ?? false);
      setBoolSearchParam(parsed.searchParams, "compass", options.showCompass ?? true);
      setBoolSearchParam(parsed.searchParams, "curvature", options.curvatureColor ?? false);
      if (options.debug) {
        parsed.searchParams.set("debug", "1");
      } else {
        parsed.searchParams.delete("debug");
      }
      if (options.forceMock) {
        parsed.searchParams.set("mock", "1");
        parsed.searchParams.delete("provider");
      } else {
        parsed.searchParams.delete("mock");
        parsed.searchParams.delete("provider");
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function isDevHost() {
    // Only true-loopback hostnames are auto-dev. Comma devices serve from
    // private LAN IPs (192.168.x.x, 10.x.x.x, etc.) in *production*, so
    // those must NOT be auto-classified as dev; that was causing every
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
      this.lastNavPayloadSig = "";
      this.lastNavPayloadSentAt = 0;
      this.lastRoutePayloadSig = "";
      this.lastEnabled = false;
      this.resizeObserver = null;
      this.layoutRaf = 0;
      this.expanded = false;
      this.expandedTimer = 0;
      this.lastFrameDebug = null;
      this.debugWaiters = [];
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
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") this.setExpanded(false);
      });
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
      const headingUp = normalizeBool(getSetting("kmap_overlay_heading_up", true));
      const showGrid = normalizeBool(getSetting("kmap_overlay_show_grid", false));
      const showCompass = normalizeBool(getSetting("kmap_overlay_show_compass", true));
      const curvatureColor = normalizeBool(getSetting("kmap_overlay_curvature_color", false));
      const debug = normalizeBool(getSetting("kmap_debug", false));
      const baseUrl = rawUrl || DEFAULT_KMAP_URL;
      // Strong quota guards: development hosts and the daily circuit breaker
      // force the iframe into mock mode so Kakao SDK is never loaded.
      const forceMock = isDevHost() || this.circuitTrippedToday;
      const url = buildFrameUrl(baseUrl, { debug, forceMock, headingUp, showGrid, showCompass, curvatureColor });
      return { enabled, url, debug, forceMock, mode: "box", headingUp, showGrid, showCompass, curvatureColor };
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
          // Do NOT call this.show() here; the iframe hasn't loaded yet,
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
      this.lastNavPayloadSig = "";
      this.lastNavPayloadSentAt = 0;
      this.lastRoutePayloadSig = "";
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
        try { console.warn(`[CarrotMap] daily SDK load cap (${DAILY_HARD_CAP}) reached; forcing mock for the rest of today`); } catch {}
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
        this.lastNavPayloadSig = "";
        this.lastRoutePayloadSig = "";
        this.dock?.removeAttribute("data-error");
        this.frame?.removeAttribute("src");
        this.sync();
      }, RETRY_AFTER_MS);
    }

    hide() {
      if (!this.dock) return;
      this.setExpanded(false);
      this.dock.hidden = true;
      this.dock.classList.remove("is-visible");
    }

    show() {
      if (!this.dock) return;
      this.dock.hidden = false;
      this.dock.classList.add("is-visible");
    }

    sendExpandedState() {
      if (!this.ready || !this.frame?.contentWindow) return;
      this.safePostMessage({
        source: "carrot-vision",
        type: "expanded",
        expanded: this.expanded,
      });
    }

    setExpanded(expanded) {
      const next = Boolean(expanded);
      if (this.expandedTimer) {
        window.clearTimeout(this.expandedTimer);
        this.expandedTimer = 0;
      }
      this.expanded = next;
      this.dock?.classList.toggle("is-expanded", next);
      this.updateLayout();
      this.sendExpandedState();
      if (next) {
        this.lastRoutePayloadSig = "";
        this.tick();
        this.expandedTimer = window.setTimeout(() => {
          this.expandedTimer = 0;
          this.setExpanded(false);
        }, EXPANDED_AUTO_HIDE_MS);
      }
    }

    toggleExpanded() {
      if (!this.shouldRun() || !this.ready) return;
      this.setExpanded(!this.expanded);
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
        // Now safe to reveal the dock; iframe has actual content.
        if (this.shouldRun()) this.show();
        this.sendExpandedState();
        this.tick();
      } else if (data.type === "error") {
        this.fail(data.error || "iframe_error");
      } else if (data.type === "toggle-expanded") {
        this.toggleExpanded();
      } else if (data.type === "debug-snapshot") {
        this.lastFrameDebug = data.snapshot || null;
        const waiters = this.debugWaiters.splice(0);
        for (const waiter of waiters) waiter(this.lastFrameDebug);
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

    buildVehiclePayload() {
      const location = this.readLocation();
      if (!location) return null;
      return {
        source: "carrot-vision",
        type: "vehicle",
        ...location,
      };
    }

    buildNavClearPayload(reason) {
      return {
        source: "carrot-vision",
        type: "nav",
        active: false,
        path: "",
        turn: null,
        goal: null,
        sdi: null,
        road: "",
        clearReason: reason || "none",
        ts: Date.now(),
      };
    }

    buildNavPayload() {
      const runtimeState = window.CarrotLiveRuntimeState;
      if (!runtimeState?.ok) return this.buildNavClearPayload("runtime");

      const services = runtimeState.services || {};
      const carrotMan = services.carrotMan || {};
      const fetchedAtMs = finiteNumber(runtimeState.fetchedAtMs) || Date.now();
      if (Date.now() - fetchedAtMs > LOCATION_MAX_AGE_MS) return this.buildNavClearPayload("stale");

      const path = String(carrotMan.naviPaths || "").trim();
      const activeCarrot = finiteNumber(carrotMan.activeCarrot) ?? 0;
      const turnInfo = finiteNumber(carrotMan.xTurnInfo) ?? -1;
      const turnDist = finiteNumber(carrotMan.xDistToTurn) ?? 0;
      const sdiType = finiteNumber(carrotMan.xSpdType) ?? -1;
      const sdiDist = finiteNumber(carrotMan.xSpdDist) ?? 0;
      const goalDist = finiteNumber(carrotMan.nGoPosDist) ?? 0;
      const active = activeCarrot > 1 || path.length > 0 || turnDist > 0 || sdiDist > 0 || goalDist > 0;

      return {
        source: "carrot-vision",
        type: "nav",
        active,
        path,
        turn: {
          info: turnInfo,
          dist: turnDist,
          countdown: finiteNumber(carrotMan.xTurnCountDown) ?? 0,
          text: String(carrotMan.szTBTMainText || ""),
        },
        goal: {
          dist: goalDist,
          timeSec: finiteNumber(carrotMan.nGoPosTime) ?? 0,
        },
        sdi: {
          type: sdiType,
          limit: finiteNumber(carrotMan.xSpdLimit) ?? 0,
          dist: sdiDist,
          countdown: finiteNumber(carrotMan.xSpdCountDown) ?? 0,
          text: String(carrotMan.szSdiDescr || ""),
        },
        road: String(carrotMan.szPosRoadName || ""),
        clearReason: "",
        ts: fetchedAtMs,
      };
    }

    sendNavPayload(payload) {
      if (!payload || !this.frame?.contentWindow) return;
      const now = Date.now();
      const sig = [
        payload.active ? "1" : "0",
        payload.path,
        payload.turn?.info ?? "",
        payload.turn?.dist ?? "",
        payload.turn?.text ?? "",
        payload.goal?.dist ?? "",
        payload.goal?.timeSec ?? "",
        payload.sdi?.type ?? "",
        payload.sdi?.limit ?? "",
        payload.sdi?.dist ?? "",
        payload.sdi?.text ?? "",
        payload.road ?? "",
        payload.clearReason ?? "",
      ].join("|");
      if (sig === this.lastNavPayloadSig && now - this.lastNavPayloadSentAt < NAV_KEEPALIVE_MS) return;
      this.lastNavPayloadSig = sig;
      this.lastNavPayloadSentAt = now;
      this.safePostMessage(payload);
    }

    normalizeRouteCoordinates(coordinates) {
      if (!Array.isArray(coordinates) || coordinates.length < 2) return [];
      const clean = [];
      for (const point of coordinates) {
        const lat = finiteNumber(point?.lat ?? point?.latitude);
        const lon = finiteNumber(point?.lon ?? point?.longitude);
        if (!validLatLon(lat, lon)) continue;
        clean.push({ lat, lon });
      }
      if (clean.length <= 900) return clean;
      const stride = Math.ceil(clean.length / 900);
      const sampled = clean.filter((_, index) => index % stride === 0);
      const last = clean[clean.length - 1];
      const sampledLast = sampled[sampled.length - 1];
      if (!sampledLast || sampledLast.lat !== last.lat || sampledLast.lon !== last.lon) sampled.push(last);
      return sampled;
    }

    buildRoutePayload() {
      const empty = { source: "carrot-vision", type: "route", active: false, coordinates: [], count: 0, ts: Date.now() };
      const runtimeState = window.CarrotLiveRuntimeState;
      if (!runtimeState?.ok) return empty;
      const fetchedAtMs = finiteNumber(runtimeState.fetchedAtMs) || Date.now();
      if (Date.now() - fetchedAtMs > LOCATION_MAX_AGE_MS) return empty;
      const navRoute = runtimeState.services?.navRoute || {};
      const coordinates = this.normalizeRouteCoordinates(navRoute.coordinates || []);
      return {
        source: "carrot-vision",
        type: "route",
        active: coordinates.length > 1,
        coordinates,
        count: finiteNumber(navRoute.count) ?? coordinates.length,
        ts: fetchedAtMs,
      };
    }

    sendRoutePayload(payload) {
      if (!payload || !this.frame?.contentWindow) return;
      const coordinates = payload.coordinates || [];
      const first = coordinates[0] || {};
      const middle = coordinates[Math.floor(coordinates.length / 2)] || {};
      const last = coordinates[coordinates.length - 1] || {};
      const sig = [
        payload.active ? "1" : "0",
        coordinates.length,
        payload.count ?? "",
        finiteNumber(first.lat)?.toFixed(6) ?? "",
        finiteNumber(first.lon)?.toFixed(6) ?? "",
        finiteNumber(middle.lat)?.toFixed(6) ?? "",
        finiteNumber(middle.lon)?.toFixed(6) ?? "",
        finiteNumber(last.lat)?.toFixed(6) ?? "",
        finiteNumber(last.lon)?.toFixed(6) ?? "",
      ].join("|");
      if (sig === this.lastRoutePayloadSig) return;
      this.lastRoutePayloadSig = sig;
      this.safePostMessage(payload);
    }

    tick() {
      if (!this.shouldRun()) {
        this.sync();
        return;
      }
      if (!this.frame?.contentWindow) return;
      if (!this.ready) return;
      const payload = this.buildVehiclePayload();
      const navPayload = this.buildNavPayload();
      const routePayload = this.buildRoutePayload();
      if (!payload) {
        this.sendNavPayload(navPayload);
        this.sendRoutePayload(routePayload);
        this.show();
        return;
      }
      const now = Date.now();
      if (now - this.lastSendAt < SEND_INTERVAL_MS - 80) {
        this.sendNavPayload(navPayload);
        this.sendRoutePayload(routePayload);
        return;
      }
      const sig = [
        payload.lat.toFixed(5),
        payload.lon.toFixed(5),
        Math.round(payload.heading),
        Math.round(payload.speed),
      ].join("|");
      if (sig === this.lastPayloadSig && now - this.lastSendAt < SEND_INTERVAL_MS * 4) {
        this.sendNavPayload(navPayload);
        this.sendRoutePayload(routePayload);
        return;
      }
      this.lastPayloadSig = sig;
      this.lastSendAt = now;
      this.safePostMessage(payload);
      this.sendNavPayload(navPayload);
      this.sendRoutePayload(routePayload);
      this.show();
    }

    safePostMessage(payload) {
      if (!payload || !this.frame?.contentWindow) return false;
      try {
        this.frame.contentWindow.postMessage(payload, this.targetOrigin);
        return true;
      } catch (error) {
        if (window.CARROT_MAP_DEBUG) {
          console.warn("[carrot-map] postMessage skipped", error);
        }
        return false;
      }
    }

    debugSnapshot() {
      const runtimeState = window.CarrotLiveRuntimeState || {};
      const vehicle = this.buildVehiclePayload();
      const nav = this.buildNavPayload();
      const route = this.buildRoutePayload();
      this.safePostMessage({ source: "carrot-vision", type: "debug-request" });
      return {
        ts: Date.now(),
        page: document.body?.dataset?.page || "",
        vision: isVisionActive(),
        online: navigator.onLine,
        visibility: document.visibilityState,
        landscape: isLandscape(),
        ready: this.ready,
        loaded: this.loaded,
        failed: this.failed,
        expanded: this.expanded,
        frameUrl: this.frameUrl,
        targetOrigin: this.targetOrigin,
        dockHidden: this.dock?.hidden,
        dockClass: this.dock?.className || "",
        dockError: this.dock?.dataset?.error || "",
        settings: this.settings(),
        runtime: {
          ok: Boolean(runtimeState.ok),
          fetchedAtMs: runtimeState.fetchedAtMs || 0,
          ageMs: runtimeState.fetchedAtMs ? Date.now() - runtimeState.fetchedAtMs : null,
          services: Object.keys(runtimeState.services || {}),
        },
        payloads: {
          vehicle,
          nav: nav ? {
            active: nav.active,
            pathLength: String(nav.path || "").length,
            pathPoints: String(nav.path || "").split(";").filter(Boolean).length,
            turn: nav.turn,
            goal: nav.goal,
            sdi: nav.sdi,
            road: nav.road,
            clearReason: nav.clearReason,
          } : null,
          route: route ? {
            active: route.active,
            coordinates: route.coordinates?.length || 0,
            count: route.count || 0,
          } : null,
        },
        iframe: this.lastFrameDebug,
      };
    }

    debugSnapshotAsync(timeoutMs = 1500) {
      const initial = this.debugSnapshot();
      if (!this.ready || !this.frame?.contentWindow) return Promise.resolve(initial);
      return new Promise((resolve) => {
        let done = false;
        const finish = (iframeSnapshot) => {
          if (done) return;
          done = true;
          resolve({ ...this.debugSnapshot(), iframe: iframeSnapshot || this.lastFrameDebug });
        };
        this.debugWaiters.push(finish);
        window.setTimeout(() => finish(this.lastFrameDebug), Math.max(200, Number(timeoutMs) || 1500));
      });
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
      let finalRight = right;
      let finalWidth = width;
      let finalHeight = height;
      let finalOffsetY = offsetY;

      if (this.expanded) {
        const margin = Math.round(clamp(Math.min(stageWidth, stageHeight) * 0.045, 18, 46));
        const expandedMaxWidth = stageWidth - margin * 2;
        const expandedMaxHeight = stageHeight - margin * 2;
        const expandedHeight = Math.round(clamp(stageHeight * 0.84, 320, expandedMaxHeight));
        const expandedWidth = Math.round(Math.min(expandedMaxWidth, Math.max(width * 1.45, expandedHeight * 1.22)));
        finalRight = margin;
        finalWidth = expandedWidth;
        finalHeight = Math.min(expandedMaxHeight, expandedHeight);
        finalOffsetY = 0;
      }

      this.dock.dataset.mode = "box";
      this.dock.style.setProperty("--carrot-map-right", `${finalRight}px`);
      this.dock.style.setProperty("--carrot-map-size", `${finalWidth}px`);
      this.dock.style.setProperty("--carrot-map-width", `${finalWidth}px`);
      this.dock.style.setProperty("--carrot-map-height", `${finalHeight}px`);
      this.dock.style.setProperty("--carrot-map-offset-y", `${finalOffsetY}px`);
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
