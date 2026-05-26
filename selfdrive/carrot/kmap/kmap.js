(function () {
  "use strict";

  const KAKAO_JS_KEY = "3492cfb289f76c41d54b83d0923e4fcc";
  const KAKAO_SDK_URL = "https://dapi.kakao.com/v2/maps/sdk.js";
  const SDK_TIMEOUT_MS = 9000;
  const DEFAULT_CENTER = Object.freeze({ lat: 37.5665, lon: 126.9780 });
  const INTERP_BASE_MS = 1100;
  const INTERP_MAX_MS = 1800;
  const INTERP_MIN_MS = 350;
  const NAV_STALE_MS = 2500;

  const root = document.getElementById("kmapRoot");
  const kakaoMapEl = document.getElementById("kakaoMap");
  const overlayCanvas = document.getElementById("overlayCanvas");
  const surface = document.getElementById("mapSurface");
  const marker = document.getElementById("vehicleMarker");
  const statusText = document.getElementById("statusText");
  const demoPanel = document.getElementById("demoPanel");
  const demoMove = document.getElementById("demoMove");
  const demoMode = document.getElementById("demoMode");

  const state = {
    lat: DEFAULT_CENTER.lat,
    lon: DEFAULT_CENTER.lon,
    heading: 0,
    speed: 0,
    level: 4,
    lastTs: 0,
    provider: "mock",
    kakaoReady: false,
    map: null,
    markerOverlay: null,
    markerEl: null,
    lastLevelChangeAt: 0,
    debug: false,
    status: "idle",
    error: "",
    sdkLoadedAt: 0,
  };

  const navState = {
    active: false,
    path: "",
    points: [],
    road: "",
    turn: null,
    goal: null,
    sdi: null,
    dirty: true,
    updatedAt: 0,
    staleTimer: 0,
    lastViewRange: 0,
    lastCanvasWidth: 0,
    lastCanvasHeight: 0,
  };

  // RAF-driven interpolation state. `display` is what's currently on screen.
  // `source` is where the last interp segment started; `target` is the most
  // recent sample. We lerp display from source -> target across `durationMs`.
  const interp = {
    source: { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lon, heading: 0 },
    target: { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lon, heading: 0 },
    display: { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lon, heading: 0 },
    segmentStart: 0,
    durationMs: INTERP_BASE_MS,
    lastSampleAt: 0,
    raf: 0,
    active: false,
  };

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function validLatLon(lat, lon) {
    return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  }

  function normalizeHeading(value) {
    const heading = finiteNumber(value);
    if (heading === null) return state.heading;
    return ((heading % 360) + 360) % 360;
  }

  function levelForSpeed(speed) {
    if (speed >= 105) return 6;
    if (speed >= 70) return 5;
    if (speed >= 25) return 4;
    if (speed >= 4) return 3;
    return 2;
  }

  function motionForSpeed(speed) {
    if (speed >= 105) return "highway";
    if (speed >= 70) return "fast";
    if (speed >= 25) return "city";
    if (speed >= 4) return "slow";
    return "parked";
  }

  function viewRangeMeters(speedKph) {
    if (speedKph >= 100) return 400;
    if (speedKph >= 60) return 280;
    if (speedKph >= 30) return 200;
    return 140;
  }

  function resizeOverlayCanvas() {
    if (!overlayCanvas) return false;
    const rect = overlayCanvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width));
    const cssHeight = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);
    if (overlayCanvas.width === width && overlayCanvas.height === height) return false;
    overlayCanvas.width = width;
    overlayCanvas.height = height;
    navState.lastCanvasWidth = cssWidth;
    navState.lastCanvasHeight = cssHeight;
    navState.dirty = true;
    return true;
  }

  function parsePath(path) {
    if (!path) return [];
    const points = [];
    const chunks = String(path).split(";");
    for (const chunk of chunks) {
      if (!chunk) continue;
      const parts = chunk.split(",");
      if (parts.length < 2) continue;
      const x = finiteNumber(parts[0]);
      const y = finiteNumber(parts[1]);
      const d = finiteNumber(parts[2]);
      if (x === null || y === null) continue;
      const forward = x;
      const lateral = y;
      if (forward < -20 || forward > 1200 || Math.abs(lateral) > 80) continue;
      points.push({ forward, lateral, d: d === null ? forward : d });
      if (points.length >= 160) break;
    }
    return points;
  }

  function clearNav() {
    if (!navState.active && navState.points.length === 0 && !navState.path) return;
    if (navState.staleTimer) {
      window.clearTimeout(navState.staleTimer);
      navState.staleTimer = 0;
    }
    navState.active = false;
    navState.path = "";
    navState.points = [];
    navState.road = "";
    navState.turn = null;
    navState.goal = null;
    navState.sdi = null;
    navState.updatedAt = 0;
    navState.dirty = true;
    renderOverlay();
    updateStatus();
  }

  function expireNavIfStale(now = Date.now()) {
    if (!navState.active || !navState.updatedAt) return false;
    if (now - navState.updatedAt <= NAV_STALE_MS) return false;
    clearNav();
    return true;
  }

  function setNav(payload) {
    const path = String(payload.path || "").trim();
    if (!payload.active || !path) {
      clearNav();
      return;
    }
    navState.active = true;
    navState.path = path;
    navState.points = parsePath(path);
    navState.road = String(payload.road || "");
    navState.turn = payload.turn || null;
    navState.goal = payload.goal || null;
    navState.sdi = payload.sdi || null;
    navState.updatedAt = Date.now();
    if (navState.staleTimer) window.clearTimeout(navState.staleTimer);
    navState.staleTimer = window.setTimeout(clearNav, NAV_STALE_MS + 150);
    navState.dirty = true;
    renderOverlay();
    updateStatus();
  }

  function clearOverlay(ctx, width, height) {
    ctx.clearRect(0, 0, width, height);
  }

  function pathPointToCanvas(point, cx, cy, pxPerMeter) {
    const headingRad = (interp.display.heading || state.heading || 0) * Math.PI / 180;
    const sin = Math.sin(headingRad);
    const cos = Math.cos(headingRad);
    return {
      x: cx + (point.lateral * cos + point.forward * sin) * pxPerMeter,
      y: cy + (point.lateral * sin - point.forward * cos) * pxPerMeter,
    };
  }

  function renderOverlay() {
    if (!overlayCanvas) return;
    const resized = resizeOverlayCanvas();
    const ctx = overlayCanvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = overlayCanvas.width / dpr;
    const height = overlayCanvas.height / dpr;
    const viewRange = viewRangeMeters(state.speed);
    expireNavIfStale();
    if (Math.abs(viewRange - navState.lastViewRange) > 1) {
      navState.lastViewRange = viewRange;
      navState.dirty = true;
    }
    if (!navState.dirty && !resized) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clearOverlay(ctx, width, height);
    if (!navState.active || navState.points.length < 2) {
      ctx.restore();
      navState.dirty = false;
      return;
    }

    const cx = width / 2;
    const cy = height / 2;
    const pxPerMeter = height / viewRange;
    const maxY = viewRange * 0.66;
    const minY = -viewRange * 0.18;
    const visible = navState.points.filter((point) => point.forward >= minY && point.forward <= maxY);
    if (visible.length < 2) {
      ctx.restore();
      navState.dirty = false;
      return;
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    visible.forEach((point, index) => {
      const canvasPoint = pathPointToCanvas(point, cx, cy, pxPerMeter);
      if (index === 0) ctx.moveTo(canvasPoint.x, canvasPoint.y);
      else ctx.lineTo(canvasPoint.x, canvasPoint.y);
    });
    ctx.strokeStyle = "rgba(0, 0, 0, .55)";
    ctx.lineWidth = Math.max(7, Math.min(13, width * 0.026));
    ctx.stroke();

    ctx.beginPath();
    visible.forEach((point, index) => {
      const canvasPoint = pathPointToCanvas(point, cx, cy, pxPerMeter);
      if (index === 0) ctx.moveTo(canvasPoint.x, canvasPoint.y);
      else ctx.lineTo(canvasPoint.x, canvasPoint.y);
    });
    const gradient = ctx.createLinearGradient(cx, cy, cx, Math.max(0, cy - maxY * pxPerMeter));
    gradient.addColorStop(0, "rgba(255, 184, 68, .98)");
    gradient.addColorStop(1, "rgba(255, 92, 48, .90)");
    ctx.strokeStyle = gradient;
    ctx.lineWidth = Math.max(4, Math.min(8, width * 0.016));
    ctx.stroke();

    ctx.restore();
    navState.dirty = false;
  }

  function relayoutKakaoMap() {
    if (!state.map || !window.kakao?.maps) return;
    try {
      window.kakao.maps.event.trigger(state.map, "resize");
      state.map.setCenter(new window.kakao.maps.LatLng(state.lat, state.lon));
    } catch (_) {
      // Resize events can race while the iframe is still settling.
    }
  }

  function bindMapResizeObserver() {
    if (typeof ResizeObserver !== "function" || !kakaoMapEl) return;
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(relayoutKakaoMap);
    });
    observer.observe(kakaoMapEl);
  }

  function applyMotionState() {
    root.dataset.motion = motionForSpeed(state.speed);
    root.style.setProperty("--kmap-level", String(state.level));
  }

  function setKakaoLevel(position) {
    if (!state.map) return;
    const now = Date.now();
    if (state.level === state.map.getLevel?.() || now - state.lastLevelChangeAt <= 2800) return;
    state.map.setLevel(state.level, { animate: false, anchor: position });
    state.lastLevelChangeAt = now;
  }

  function easeOutCubic(t) {
    const c = 1 - t;
    return 1 - c * c * c;
  }

  function lerpAngle(a, b, t) {
    const diff = (((b - a) % 360) + 540) % 360 - 180;
    return ((a + diff * t) % 360 + 360) % 360;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function setMode(mode) {
    root.dataset.mode = "box";
  }

  function setProvider(provider) {
    state.provider = provider === "kakao" ? "kakao" : "mock";
    root.dataset.provider = state.provider;
  }

  function updateStatus() {
    if (!statusText) return;
    const label = state.provider === "kakao" ? "kakao" : "mock";
    const age = state.lastTs ? Math.max(0, Math.round((Date.now() - state.lastTs) / 1000)) : 0;
    const parts = [
      label,
      state.status,
      `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`,
      `${Math.round(state.heading)}deg`,
      `${Math.round(state.speed)}km/h`,
      `L${state.level}`,
      `${age}s`,
    ];
    if (navState.active) parts.push(`P${navState.points.length}`);
    if (state.error) parts.push(state.error);
    statusText.textContent = parts.join(" / ");
  }

  function updateMockPan(lat, lon) {
    const x = Math.round((((lon * 10000) % 90) - 45) * 0.8);
    const y = Math.round((((lat * 10000) % 90) - 45) * 0.8);
    surface.style.setProperty("--map-pan-x", `${x}px`);
    surface.style.setProperty("--map-pan-y", `${y}px`);
  }

  function applyMarkerRotation(heading) {
    const rotation = `${heading}deg`;
    marker.style.setProperty("--heading", rotation);
  }

  function applyKakaoPosition(lat, lon) {
    if (!state.map || !window.kakao?.maps) return;
    const position = new window.kakao.maps.LatLng(lat, lon);
    state.map.setCenter(position);
    setKakaoLevel(position);
  }

  function renderDisplay() {
    applyMarkerRotation(interp.display.heading);
    updateMockPan(interp.display.lat, interp.display.lon);
    applyKakaoPosition(interp.display.lat, interp.display.lon);
    renderOverlay();
  }

  function ensureRenderLoop() {
    if (interp.raf) return;
    const step = () => {
      interp.raf = 0;
      const now = performance.now();
      const elapsed = now - interp.segmentStart;
      const duration = Math.max(60, interp.durationMs);
      const tRaw = Math.min(1, elapsed / duration);
      const t = easeOutCubic(tRaw);
      interp.display.lat = lerp(interp.source.lat, interp.target.lat, t);
      interp.display.lon = lerp(interp.source.lon, interp.target.lon, t);
      interp.display.heading = lerpAngle(interp.source.heading, interp.target.heading, t);
      renderDisplay();
      // Keep ticking while we haven't reached target, or for a small grace
      // window after to absorb late samples without visible stutter.
      const idleMs = now - interp.lastSampleAt;
      if (tRaw < 1 || idleMs < 2500) {
        interp.raf = window.requestAnimationFrame(step);
      } else {
        interp.active = false;
      }
    };
    interp.active = true;
    interp.raf = window.requestAnimationFrame(step);
  }

  function seedInterp(lat, lon, heading) {
    interp.source.lat = interp.target.lat = interp.display.lat = lat;
    interp.source.lon = interp.target.lon = interp.display.lon = lon;
    interp.source.heading = interp.target.heading = interp.display.heading = heading;
    interp.segmentStart = performance.now();
    interp.lastSampleAt = interp.segmentStart;
  }

  function pushSample(lat, lon, heading) {
    const now = performance.now();
    // Estimate sample interval from observed cadence so interpolation tracks
    // the actual upstream rate (1Hz vs 2Hz vs render-request bursts).
    if (interp.lastSampleAt > 0) {
      const dt = now - interp.lastSampleAt;
      if (dt > INTERP_MIN_MS && dt < 4000) {
        interp.durationMs = Math.max(INTERP_MIN_MS, Math.min(INTERP_MAX_MS, dt * 1.05));
      }
    } else {
      interp.durationMs = INTERP_BASE_MS;
    }
    interp.source.lat = interp.display.lat;
    interp.source.lon = interp.display.lon;
    interp.source.heading = interp.display.heading;
    interp.target.lat = lat;
    interp.target.lon = lon;
    interp.target.heading = heading;
    interp.segmentStart = now;
    interp.lastSampleAt = now;
    ensureRenderLoop();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-kmap-sdk="kakao"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => reject(new Error("kakao_sdk_load_failed")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.defer = true;
      script.dataset.kmapSdk = "kakao";
      script.onload = resolve;
      script.onerror = () => reject(new Error("kakao_sdk_load_failed"));
      document.head.appendChild(script);
    });
  }

  function waitForKakaoLoad() {
    return new Promise((resolve, reject) => {
      if (!window.kakao?.maps?.load) {
        reject(new Error("kakao_sdk_unavailable"));
        return;
      }
      window.kakao.maps.load(resolve);
    });
  }

  function initKakaoMap() {
    if (!window.kakao?.maps || !kakaoMapEl || state.map) return;
    const center = new window.kakao.maps.LatLng(state.lat, state.lon);
    state.map = new window.kakao.maps.Map(kakaoMapEl, {
      center,
      level: state.level,
      draggable: false,
      scrollwheel: false,
      disableDoubleClickZoom: true,
      keyboardShortcuts: false,
    });
    if (state.map.setCopyrightPosition && window.kakao.maps.CopyrightPosition) {
      state.map.setCopyrightPosition(window.kakao.maps.CopyrightPosition.BOTTOMRIGHT, true);
    }

    // Marker stays as a shell-positioned div (#vehicleMarker) instead of a
    // Kakao CustomOverlay child of the map. This keeps the marker outside
    // the map's opacity/filter stack so we can fade the map underneath
    // without dimming the marker. The map auto-centers on the vehicle each
    // frame, so a fixed 50%/50% marker visually tracks position.
    applyMarkerRotation(interp.display.heading);
    setProvider("kakao");
    if (state.status === "idle") state.status = "waiting";
  }

  async function initProvider() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mock") === "1") {
      setProvider("mock");
      return;
    }

    try {
      const appkey = params.get("appkey") || KAKAO_JS_KEY;
      const sdkUrl = `${KAKAO_SDK_URL}?appkey=${encodeURIComponent(appkey)}&autoload=false`;
      await Promise.race([
        loadScript(sdkUrl).then(waitForKakaoLoad),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("kakao_sdk_timeout")), SDK_TIMEOUT_MS)),
      ]);
      state.kakaoReady = true;
      state.sdkLoadedAt = Date.now();
      initKakaoMap();
    } catch (error) {
      setProvider("mock");
      postError(error?.message || "kakao_sdk_load_failed", { soft: true });
    }
  }

  function applyVehicle(payload) {
    const lat = finiteNumber(payload.lat);
    const lon = finiteNumber(payload.lon);
    if (!validLatLon(lat, lon)) {
      root.dataset.status = "invalid";
      state.status = "invalid";
      updateStatus();
      return false;
    }

    const speed = finiteNumber(payload.speed);
    const isFirstSample = state.lastTs === 0;
    state.lat = lat;
    state.lon = lon;
    state.heading = normalizeHeading(payload.heading);
    state.speed = speed === null ? state.speed : Math.max(0, speed);
    state.lastTs = finiteNumber(payload.ts) || Date.now();
    setMode("box");
    state.level = levelForSpeed(state.speed);
    applyMotionState();

    if (isFirstSample) {
      seedInterp(state.lat, state.lon, state.heading);
      renderDisplay();
    } else {
      pushSample(state.lat, state.lon, state.heading);
    }
    state.error = "";
    state.status = "ready";
    updateStatus();
    root.dataset.status = "ready";
    return true;
  }

  function handleMessage(event) {
    const data = event.data || {};
    if (data.source !== "carrot-vision") return;
    if (data.type === "vehicle") {
      applyVehicle(data);
    } else if (data.type === "nav") {
      setNav(data);
    }
  }

  function postReady() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          source: "carrot-kmap",
          type: "ready",
          provider: state.provider,
          // sdkLoadedAt is only non-zero when the Kakao SDK actually executed
          // (= 1 quota count). Parent uses this to track daily SDK load count.
          sdkLoadedAt: state.provider === "kakao" ? state.sdkLoadedAt || Date.now() : 0,
        }, "*");
      }
    } catch (_) {
      // Standalone file preview can ignore parent messaging failures.
    }
  }

  function postError(error, options = {}) {
    state.error = error || "";
    state.status = options.soft ? "fallback" : "error";
    updateStatus();
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          source: "carrot-kmap",
          type: options.soft ? "ready" : "error",
          provider: state.provider,
          error,
          fallback: options.soft ? "mock" : "",
        }, "*");
      }
    } catch (_) {
      // Standalone file preview can ignore parent messaging failures.
    }
  }

  function runDemoStep() {
    const next = {
      source: "carrot-vision",
      type: "vehicle",
      lat: state.lat + 0.0008,
      lon: state.lon + 0.0011,
      heading: state.heading + 28,
      speed: state.speed >= 100 ? 8 : state.speed + 18,
      ts: Date.now(),
    };
    applyVehicle(next);
  }

  function initDemoControls() {
    const params = new URLSearchParams(window.location.search);
    const embedded = window.parent && window.parent !== window;
    root.dataset.embedded = embedded ? "1" : "0";
    state.debug = params.get("debug") === "1";
    root.dataset.debug = state.debug ? "1" : "0";
    if (embedded || params.get("demo") === "0") {
      demoPanel.hidden = true;
    } else {
      demoMove.addEventListener("click", runDemoStep);
      demoMode.hidden = true;
    }
    const requestedMode = params.get("mode");
    if (requestedMode) setMode(requestedMode);
  }

  async function init() {
    window.addEventListener("message", handleMessage);
    initDemoControls();
    state.status = "waiting";
    root.dataset.status = "waiting";
    applyMotionState();
    bindMapResizeObserver();
    resizeOverlayCanvas();
    window.addEventListener("resize", () => {
      relayoutKakaoMap();
      navState.dirty = true;
      renderOverlay();
    });
    await initProvider();
    updateStatus();
    postReady();
  }

  init();
})();
