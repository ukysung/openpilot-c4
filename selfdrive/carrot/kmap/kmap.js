(function () {
  "use strict";

  const KAKAO_JS_KEY = "3492cfb289f76c41d54b83d0923e4fcc";
  const KAKAO_SDK_URL = "https://dapi.kakao.com/v2/maps/sdk.js";
  const SDK_TIMEOUT_MS = 9000;
  const DEFAULT_CENTER = Object.freeze({ lat: 37.5665, lon: 126.9780 });
  const INTERP_BASE_MS = 1100;
  const INTERP_MAX_MS = 1800;
  const INTERP_MIN_MS = 350;

  const root = document.getElementById("kmapRoot");
  const kakaoMapEl = document.getElementById("kakaoMap");
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
    if (data.source !== "carrot-vision" || data.type !== "vehicle") return;
    applyVehicle(data);
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
    window.addEventListener("resize", relayoutKakaoMap);
    await initProvider();
    updateStatus();
    postReady();
  }

  init();
})();
