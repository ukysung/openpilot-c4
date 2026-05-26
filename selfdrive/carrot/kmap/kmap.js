(function () {
  "use strict";

  const KAKAO_JS_KEY = "3492cfb289f76c41d54b83d0923e4fcc";
  const KAKAO_SDK_URL = "https://dapi.kakao.com/v2/maps/sdk.js";
  const SDK_TIMEOUT_MS = 9000;
  const DEFAULT_CENTER = Object.freeze({ lat: 37.5665, lon: 126.9780 });
  const INTERP_BASE_MS = 1100;
  const INTERP_MAX_MS = 1800;
  const INTERP_MIN_MS = 350;
  const NAV_STALE_MS = 5000;
  const EARTH_RADIUS_M = 6378137;

  const root = document.getElementById("kmapRoot");
  const kakaoMapEl = document.getElementById("kakaoMap");
  const overlayCanvas = document.getElementById("overlayCanvas");
  const surface = document.getElementById("mapSurface");
  const marker = document.getElementById("vehicleMarker");
  const statusText = document.getElementById("statusText");
  const compass = document.getElementById("compass");
  const navInfo = document.getElementById("navInfo");
  const navRoad = document.getElementById("navRoad");
  const navMeta = document.getElementById("navMeta");
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
    mode: "box",
    overlayHeadingUp: true,
    showGrid: false,
    showCompass: true,
    curvatureColor: false,
    kakaoReady: false,
    map: null,
    markerOverlay: null,
    markerEl: null,
    lastLevelChangeAt: 0,
    debug: false,
    status: "idle",
    error: "",
    sdkLoadedAt: 0,
    lastDebugPostAt: 0,
    overlayRaf: 0,
  };

  const navState = {
    active: false,
    path: "",
    points: [],
    road: "",
    turn: null,
    goal: null,
    sdi: null,
    origin: null,
    heading: null,
    dirty: true,
    updatedAt: 0,
    staleTimer: 0,
    lastViewRange: 0,
    lastCanvasWidth: 0,
    lastCanvasHeight: 0,
    lastProjectionSig: "",
  };

  const routeState = {
    active: false,
    expanded: false,
    coordinates: [],
    bounds: null,
    dirty: true,
    fitted: false,
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

  function boolParam(params, key, fallback) {
    const value = params.get(key);
    if (value === null) return fallback;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
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

  function expandedFallbackRange(speedKph) {
    return Math.round(viewRangeMeters(speedKph) * 2.2);
  }

  function kakaoDisplayLevel() {
    if (routeState.expanded && !routeState.active) {
      return Math.min(8, state.level + 2);
    }
    return state.level;
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
    routeState.dirty = true;
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

  function formatDistance(meters) {
    const value = finiteNumber(meters);
    if (value === null || value <= 0) return "";
    if (value < 950) return `${Math.round(value)}m`;
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}km`;
  }

  function formatDuration(seconds) {
    const value = finiteNumber(seconds);
    if (value === null || value <= 0) return "";
    const minutes = Math.max(1, Math.round(value / 60));
    if (minutes < 60) return `${minutes}분`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
  }

  function updateNavInfo() {
    if (!navInfo || !navRoad || !navMeta) return;
    if (!navState.active) {
      navInfo.hidden = true;
      navRoad.textContent = "";
      navMeta.textContent = "";
      return;
    }

    const road = navState.road || navState.turn?.text || "";
    const goalDist = formatDistance(navState.goal?.dist);
    const goalTime = formatDuration(navState.goal?.timeSec);
    const turnDist = formatDistance(navState.turn?.dist);
    const sdiDist = formatDistance(navState.sdi?.dist);
    const sdiLimit = finiteNumber(navState.sdi?.limit);
    const meta = [];
    if (goalDist) meta.push(goalTime ? `${goalDist} · ${goalTime}` : goalDist);
    if (turnDist) meta.push(`회전 ${turnDist}`);
    if (sdiDist) meta.push(sdiLimit && sdiLimit > 0 ? `${sdiLimit} 제한 ${sdiDist}` : `단속 ${sdiDist}`);

    if (!road && meta.length === 0) {
      navInfo.hidden = true;
      return;
    }
    navRoad.textContent = road || "경로 안내";
    navMeta.textContent = meta.slice(0, 2).join(" / ");
    navMeta.hidden = navMeta.textContent.length === 0;
    navInfo.hidden = false;
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
    navState.origin = null;
    navState.heading = null;
    navState.updatedAt = 0;
    navState.dirty = true;
    updateNavInfo();
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
    const originLat = finiteNumber(payload.origin?.lat);
    const originLon = finiteNumber(payload.origin?.lon);
    navState.origin = validLatLon(originLat, originLon)
      ? {
          lat: originLat,
          lon: originLon,
          distanceM: finiteNumber(payload.origin?.distanceM),
          index: finiteNumber(payload.origin?.index),
          ratio: finiteNumber(payload.origin?.ratio),
        }
      : null;
    navState.heading = finiteNumber(payload.heading);
    navState.updatedAt = Date.now();
    if (navState.staleTimer) window.clearTimeout(navState.staleTimer);
    navState.staleTimer = window.setTimeout(clearNav, NAV_STALE_MS + 150);
    navState.dirty = true;
    updateNavInfo();
    renderOverlay();
    updateStatus();
  }

  function routeBounds(coordinates) {
    if (!coordinates.length) return null;
    const bounds = {
      minLat: coordinates[0].lat,
      maxLat: coordinates[0].lat,
      minLon: coordinates[0].lon,
      maxLon: coordinates[0].lon,
    };
    for (const point of coordinates) {
      bounds.minLat = Math.min(bounds.minLat, point.lat);
      bounds.maxLat = Math.max(bounds.maxLat, point.lat);
      bounds.minLon = Math.min(bounds.minLon, point.lon);
      bounds.maxLon = Math.max(bounds.maxLon, point.lon);
    }
    return bounds;
  }

  function setRoute(payload) {
    const raw = Array.isArray(payload.coordinates) ? payload.coordinates : [];
    const coordinates = [];
    for (const point of raw) {
      const lat = finiteNumber(point?.lat ?? point?.latitude);
      const lon = finiteNumber(point?.lon ?? point?.longitude);
      if (!validLatLon(lat, lon)) continue;
      coordinates.push({ lat, lon });
      if (coordinates.length >= 1200) break;
    }
    routeState.active = Boolean(payload.active) && coordinates.length > 1;
    routeState.coordinates = routeState.active ? coordinates : [];
    routeState.bounds = routeState.active ? routeBounds(coordinates) : null;
    routeState.dirty = true;
    routeState.fitted = false;
    if (routeState.expanded) fitRouteView();
    applyMarkerPosition();
    renderOverlay();
    updateStatus();
  }

  function setExpanded(expanded) {
    routeState.expanded = Boolean(expanded);
    routeState.dirty = true;
    routeState.fitted = false;
    if (routeState.expanded) {
      fitRouteView();
    } else {
      applyKakaoPosition(state.lat, state.lon, true);
    }
    if (routeState.expanded && !routeState.active) applyKakaoPosition(state.lat, state.lon, true);
    applyMarkerPosition();
    renderOverlay();
  }

  function clearOverlay(ctx, width, height) {
    ctx.clearRect(0, 0, width, height);
  }

  function shouldUseMapProjection() {
    return state.provider === "kakao" && state.map && window.kakao?.maps;
  }

  function localPointToLatLng(point) {
    const originLat = finiteNumber(navState.origin?.lat) ?? finiteNumber(interp.display.lat) ?? state.lat;
    const originLon = finiteNumber(navState.origin?.lon) ?? finiteNumber(interp.display.lon) ?? state.lon;
    if (!validLatLon(originLat, originLon)) return null;

    const heading = finiteNumber(navState.heading) ?? finiteNumber(interp.display.heading) ?? state.heading ?? 0;
    const headingRad = heading * Math.PI / 180;
    const forward = finiteNumber(point?.forward) ?? 0;
    const lateral = finiteNumber(point?.lateral) ?? 0;
    const northMeters = forward * Math.cos(headingRad) - lateral * Math.sin(headingRad);
    const eastMeters = forward * Math.sin(headingRad) + lateral * Math.cos(headingRad);
    const latRad = originLat * Math.PI / 180;
    const nextLat = originLat + (northMeters / EARTH_RADIUS_M) * 180 / Math.PI;
    const nextLon = originLon + (eastMeters / (EARTH_RADIUS_M * Math.max(0.01, Math.cos(latRad)))) * 180 / Math.PI;
    return new window.kakao.maps.LatLng(nextLat, nextLon);
  }

  function projectedPathPointToCanvas(point) {
    if (!shouldUseMapProjection()) return null;
    try {
      const latlng = localPointToLatLng(point);
      const projected = latlng ? state.map.getProjection()?.containerPointFromCoords?.(latlng) : null;
      if (projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
        return { x: projected.x, y: projected.y };
      }
    } catch (_) {
      // Projection can be temporarily unavailable while Kakao is relayouting.
    }
    return null;
  }

  function summarizePathPoint(point) {
    if (!point) return null;
    let latlng = null;
    let projected = null;
    if (shouldUseMapProjection()) {
      try {
        latlng = localPointToLatLng(point);
        projected = latlng ? state.map.getProjection()?.containerPointFromCoords?.(latlng) : null;
      } catch (_) {
        latlng = null;
        projected = null;
      }
    }
    return {
      forward: finiteNumber(point.forward),
      lateral: finiteNumber(point.lateral),
      d: finiteNumber(point.d),
      lat: latlng?.getLat?.() ?? null,
      lon: latlng?.getLng?.() ?? null,
      canvasX: Number.isFinite(projected?.x) ? projected.x : null,
      canvasY: Number.isFinite(projected?.y) ? projected.y : null,
    };
  }

  function buildDebugSnapshot(reason = "") {
    const rect = overlayCanvas?.getBoundingClientRect?.();
    const center = state.map?.getCenter?.();
    const points = navState.points || [];
    const sampleIndexes = points.length
      ? Array.from(new Set([0, Math.floor(points.length / 2), points.length - 1]))
      : [];
    return {
      reason,
      ts: Date.now(),
      provider: state.provider,
      status: state.status,
      error: state.error,
      map: {
        projection: shouldUseMapProjection(),
        level: state.map?.getLevel?.() ?? null,
        centerLat: center?.getLat?.() ?? null,
        centerLon: center?.getLng?.() ?? null,
      },
      vehicle: {
        lat: state.lat,
        lon: state.lon,
        heading: state.heading,
        speed: state.speed,
        displayLat: interp.display.lat,
        displayLon: interp.display.lon,
        displayHeading: interp.display.heading,
      },
      canvas: {
        cssWidth: rect?.width ?? 0,
        cssHeight: rect?.height ?? 0,
        width: overlayCanvas?.width || 0,
        height: overlayCanvas?.height || 0,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      },
      nav: {
        active: navState.active,
        points: points.length,
        pathLength: navState.path.length,
        updatedAgeMs: navState.updatedAt ? Date.now() - navState.updatedAt : null,
        origin: navState.origin,
        heading: navState.heading,
        road: navState.road,
        turn: navState.turn,
        goal: navState.goal,
        sdi: navState.sdi,
        projectionSig: navState.lastProjectionSig,
        samples: sampleIndexes.map((index) => ({ index, ...summarizePathPoint(points[index]) })),
      },
      route: {
        active: routeState.active,
        expanded: routeState.expanded,
        coordinates: routeState.coordinates.length,
      },
      options: {
        headingUp: state.overlayHeadingUp,
        showGrid: state.showGrid,
        showCompass: state.showCompass,
        curvatureColor: state.curvatureColor,
      },
    };
  }

  function postDebugSnapshot(reason = "", force = false) {
    if (!state.debug && !force) return;
    const now = Date.now();
    if (!force && now - state.lastDebugPostAt < 1000) return;
    state.lastDebugPostAt = now;
    try {
      if (window.parent && window.parent !== window) {
        let snapshot = null;
        try {
          snapshot = buildDebugSnapshot(reason);
        } catch (error) {
          snapshot = {
            reason,
            ts: Date.now(),
            provider: state.provider,
            status: state.status,
            error: error?.message || "debug_snapshot_failed",
          };
        }
        window.parent.postMessage({
          source: "carrot-kmap",
          type: "debug-snapshot",
          snapshot,
        }, "*");
      }
    } catch (_) {
      // Standalone file preview can ignore parent messaging failures.
    }
  }

  function requestOverlayRender(reason = "") {
    navState.dirty = true;
    routeState.dirty = true;
    if (state.overlayRaf) return;
    state.overlayRaf = window.requestAnimationFrame(() => {
      state.overlayRaf = 0;
      renderOverlay();
      postDebugSnapshot(reason);
    });
  }

  function pathPointToCanvas(point, cx, cy, pxPerMeter) {
    const projected = projectedPathPointToCanvas(point);
    if (projected) return projected;

    const headingRad = state.overlayHeadingUp ? 0 : (interp.display.heading || state.heading || 0) * Math.PI / 180;
    const sin = Math.sin(headingRad);
    const cos = Math.cos(headingRad);
    return {
      x: cx + (point.lateral * cos + point.forward * sin) * pxPerMeter,
      y: cy + (point.lateral * sin - point.forward * cos) * pxPerMeter,
    };
  }

  function pathDistance(point) {
    const distance = finiteNumber(point?.d);
    return distance === null ? finiteNumber(point?.forward) ?? 0 : distance;
  }

  function pointAlongPath(points, targetDistance) {
    const target = finiteNumber(targetDistance);
    if (!Array.isArray(points) || points.length === 0 || target === null || target < 0) return null;
    let previous = points[0];
    let previousDistance = pathDistance(previous);
    if (target <= previousDistance) return previous;
    for (let index = 1; index < points.length; index += 1) {
      const current = points[index];
      const currentDistance = pathDistance(current);
      if (target <= currentDistance) {
        const span = Math.max(0.001, currentDistance - previousDistance);
        const ratio = Math.max(0, Math.min(1, (target - previousDistance) / span));
        return {
          forward: previous.forward + (current.forward - previous.forward) * ratio,
          lateral: previous.lateral + (current.lateral - previous.lateral) * ratio,
          d: target,
        };
      }
      previous = current;
      previousDistance = currentDistance;
    }
    return points[points.length - 1];
  }

  function drawTurnMarker(ctx, cx, cy, pxPerMeter, minY, maxY, width) {
    const turnDistance = finiteNumber(navState.turn?.dist);
    if (turnDistance === null || turnDistance <= 0 || !navState.points.length) return;
    const point = pointAlongPath(navState.points, turnDistance);
    if (!point || point.forward < minY || point.forward > maxY) return;

    const before = pointAlongPath(navState.points, Math.max(0, turnDistance - 10)) || point;
    const after = pointAlongPath(navState.points, turnDistance + 10) || point;
    const canvasPoint = pathPointToCanvas(point, cx, cy, pxPerMeter);
    const beforePoint = pathPointToCanvas(before, cx, cy, pxPerMeter);
    const afterPoint = pathPointToCanvas(after, cx, cy, pxPerMeter);
    const angle = Math.atan2(afterPoint.y - beforePoint.y, afterPoint.x - beforePoint.x) + Math.PI / 2;
    const radius = Math.max(11, Math.min(18, width * 0.038));

    ctx.save();
    ctx.translate(canvasPoint.x, canvasPoint.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(9, 12, 16, .62)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(radius * 0.72, radius * 0.76);
    ctx.lineTo(0, radius * 0.42);
    ctx.lineTo(-radius * 0.72, radius * 0.76);
    ctx.closePath();
    ctx.strokeStyle = "rgba(0, 0, 0, .55)";
    ctx.lineWidth = Math.max(2, radius * 0.18);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 125, 32, .96)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, radius * 0.18, Math.max(2.2, radius * 0.17), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.82)";
    ctx.fill();
    ctx.restore();
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  function drawSdiMarker(ctx, cx, cy, pxPerMeter, minY, maxY, width) {
    const sdiDistance = finiteNumber(navState.sdi?.dist);
    const sdiType = finiteNumber(navState.sdi?.type);
    if (sdiDistance === null || sdiDistance <= 0 || sdiType === null || sdiType < 0 || !navState.points.length) return;
    const point = pointAlongPath(navState.points, sdiDistance);
    if (!point || point.forward < minY || point.forward > maxY) return;

    const canvasPoint = pathPointToCanvas(point, cx, cy, pxPerMeter);
    const size = Math.max(9, Math.min(15, width * 0.031));
    const limit = finiteNumber(navState.sdi?.limit);

    ctx.save();
    ctx.translate(canvasPoint.x, canvasPoint.y);
    ctx.beginPath();
    roundedRectPath(ctx, -size * 0.72, -size * 0.52, size * 1.44, size * 1.04, size * 0.22);
    ctx.fillStyle = "rgba(7, 10, 14, .66)";
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, size * 0.16);
    ctx.strokeStyle = "rgba(255,255,255,.82)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 120, 34, .96)";
    ctx.fill();
    if (limit && limit > 0 && size >= 12) {
      ctx.font = `900 ${Math.max(7, size * 0.48)}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText(String(Math.round(limit)), 0, size * 1.08);
    }
    ctx.restore();
  }

  function segmentCurvature(points, index, cx, cy, pxPerMeter) {
    if (index <= 0 || index >= points.length - 1) return 0;
    const previous = pathPointToCanvas(points[index - 1], cx, cy, pxPerMeter);
    const current = pathPointToCanvas(points[index], cx, cy, pxPerMeter);
    const next = pathPointToCanvas(points[index + 1], cx, cy, pxPerMeter);
    const a = Math.atan2(current.y - previous.y, current.x - previous.x);
    const b = Math.atan2(next.y - current.y, next.x - current.x);
    return Math.abs((((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  }

  function drawPathColorStroke(ctx, points, cx, cy, pxPerMeter, width, maxY) {
    if (!state.curvatureColor) {
      ctx.beginPath();
      points.forEach((point, index) => {
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
      return;
    }

    ctx.lineWidth = Math.max(4, Math.min(8, width * 0.016));
    for (let index = 1; index < points.length; index += 1) {
      const from = pathPointToCanvas(points[index - 1], cx, cy, pxPerMeter);
      const to = pathPointToCanvas(points[index], cx, cy, pxPerMeter);
      const curve = segmentCurvature(points, index, cx, cy, pxPerMeter);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = curve > 0.32 ? "rgba(255, 83, 46, .96)" : curve > 0.16 ? "rgba(255, 184, 68, .96)" : "rgba(255, 132, 42, .94)";
      ctx.stroke();
    }
  }

  function fitRouteView() {
    if (!routeState.expanded || !routeState.active || !routeState.bounds || !state.map || !window.kakao?.maps) return;
    try {
      const bounds = new window.kakao.maps.LatLngBounds();
      for (const point of routeState.coordinates) {
        bounds.extend(new window.kakao.maps.LatLng(point.lat, point.lon));
      }
      window.kakao.maps.event.trigger(state.map, "resize");
      state.map.setBounds(bounds);
      routeState.fitted = true;
      routeState.dirty = true;
    } catch (_) {
      // If Kakao projection is not ready yet, the canvas fallback still draws the route.
    }
  }

  function routePointToCanvas(point, bounds, width, height) {
    try {
      const projection = state.map?.getProjection?.();
      const projected = projection?.containerPointFromCoords?.(new window.kakao.maps.LatLng(point.lat, point.lon));
      if (projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
        return { x: projected.x, y: projected.y };
      }
    } catch (_) {
      // Fall through to normalized bounds projection.
    }
    const pad = Math.max(18, Math.min(width, height) * 0.08);
    const lonSpan = Math.max(0.000001, bounds.maxLon - bounds.minLon);
    const latSpan = Math.max(0.000001, bounds.maxLat - bounds.minLat);
    return {
      x: pad + ((point.lon - bounds.minLon) / lonSpan) * Math.max(1, width - pad * 2),
      y: pad + ((bounds.maxLat - point.lat) / latSpan) * Math.max(1, height - pad * 2),
    };
  }

  function renderFullRoute(ctx, width, height) {
    if (!routeState.expanded || !routeState.active || !routeState.bounds || routeState.coordinates.length < 2) return false;
    const points = routeState.coordinates;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    points.forEach((point, index) => {
      const canvasPoint = routePointToCanvas(point, routeState.bounds, width, height);
      if (index === 0) ctx.moveTo(canvasPoint.x, canvasPoint.y);
      else ctx.lineTo(canvasPoint.x, canvasPoint.y);
    });
    ctx.strokeStyle = "rgba(0, 0, 0, .50)";
    ctx.lineWidth = Math.max(7, Math.min(14, width * 0.018));
    ctx.stroke();

    ctx.beginPath();
    points.forEach((point, index) => {
      const canvasPoint = routePointToCanvas(point, routeState.bounds, width, height);
      if (index === 0) ctx.moveTo(canvasPoint.x, canvasPoint.y);
      else ctx.lineTo(canvasPoint.x, canvasPoint.y);
    });
    ctx.strokeStyle = "rgba(255, 118, 36, .94)";
    ctx.lineWidth = Math.max(4, Math.min(8, width * 0.010));
    ctx.stroke();
    routeState.dirty = false;
    return true;
  }

  function renderOverlay() {
    if (!overlayCanvas) return;
    const resized = resizeOverlayCanvas();
    const ctx = overlayCanvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = overlayCanvas.width / dpr;
    const height = overlayCanvas.height / dpr;
    const viewRange = routeState.expanded && !routeState.active ? expandedFallbackRange(state.speed) : viewRangeMeters(state.speed);
    expireNavIfStale();
    if (Math.abs(viewRange - navState.lastViewRange) > 1) {
      navState.lastViewRange = viewRange;
      navState.dirty = true;
    }
    const projectedPath = shouldUseMapProjection();
    if (projectedPath && navState.active) {
      const projectionSig = [
        navState.origin ? navState.origin.lat.toFixed(6) : "",
        navState.origin ? navState.origin.lon.toFixed(6) : "",
        Number.isFinite(navState.heading) ? Math.round(navState.heading) : "",
        interp.display.lat.toFixed(6),
        interp.display.lon.toFixed(6),
        Math.round(interp.display.heading),
        state.map?.getLevel?.() ?? "",
        Math.round(width),
        Math.round(height),
      ].join("|");
      if (projectionSig !== navState.lastProjectionSig) {
        navState.lastProjectionSig = projectionSig;
        navState.dirty = true;
      }
    }
    if (!navState.dirty && !routeState.dirty && !resized) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clearOverlay(ctx, width, height);
    if (routeState.expanded && routeState.active) {
      if (renderFullRoute(ctx, width, height)) {
        ctx.restore();
        navState.dirty = false;
        return;
      }
    }
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
    const visible = projectedPath ? navState.points : navState.points.filter((point) => point.forward >= minY && point.forward <= maxY);
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

    drawPathColorStroke(ctx, visible, cx, cy, pxPerMeter, width, maxY);

    drawTurnMarker(ctx, cx, cy, pxPerMeter, projectedPath ? -Infinity : minY, projectedPath ? Infinity : maxY, width);
    drawSdiMarker(ctx, cx, cy, pxPerMeter, projectedPath ? -Infinity : minY, projectedPath ? Infinity : maxY, width);

    ctx.restore();
    navState.dirty = false;
  }

  function relayoutKakaoMap() {
    if (!state.map || !window.kakao?.maps) return;
    try {
      window.kakao.maps.event.trigger(state.map, "resize");
      if (routeState.expanded && routeState.active) {
        fitRouteView();
        requestOverlayRender("relayout-route");
        return;
      }
      state.map.setCenter(new window.kakao.maps.LatLng(state.lat, state.lon));
      requestOverlayRender("relayout");
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

  function setKakaoLevel(position, force = false) {
    if (!state.map) return;
    const now = Date.now();
    const level = kakaoDisplayLevel();
    if (level === state.map.getLevel?.() || (!force && now - state.lastLevelChangeAt <= 2800)) return;
    state.map.setLevel(level, { animate: false, anchor: position });
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
    state.mode = "box";
    root.dataset.mode = state.mode;
  }

  function setProvider(provider) {
    state.provider = provider === "kakao" ? "kakao" : "mock";
    root.dataset.provider = state.provider;
  }

  function applyOverlayOptions(params) {
    state.overlayHeadingUp = boolParam(params, "heading_up", true);
    state.showGrid = boolParam(params, "grid", false);
    state.showCompass = boolParam(params, "compass", true);
    state.curvatureColor = boolParam(params, "curvature", false);
    root.dataset.grid = state.showGrid ? "1" : "0";
    root.dataset.headingUp = state.overlayHeadingUp ? "1" : "0";
    root.dataset.curvature = state.curvatureColor ? "1" : "0";
    navState.dirty = true;
    routeState.dirty = true;
  }

  function updateStatus() {
    if (!statusText) return;
    const label = state.provider;
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
    if (routeState.active) parts.push(`R${routeState.coordinates.length}`);
    if (routeState.expanded) parts.push("expanded");
    if (!state.overlayHeadingUp) parts.push("north-up");
    if (state.curvatureColor) parts.push("curve");
    if (state.error) parts.push(state.error);
    statusText.textContent = parts.join(" / ");
  }

  function updateCompass() {
    if (!compass) return;
    compass.hidden = !state.showCompass;
    if (compass.hidden) return;
    const rotation = state.overlayHeadingUp ? -(interp.display.heading || state.heading || 0) : 0;
    compass.style.setProperty("--compass-rotation", `${rotation}deg`);
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

  function applyMarkerPosition() {
    if (routeState.expanded && routeState.active && routeState.bounds) {
      const point = routePointToCanvas({ lat: state.lat, lon: state.lon }, routeState.bounds, overlayCanvas?.clientWidth || 1, overlayCanvas?.clientHeight || 1);
      marker.style.setProperty("--vehicle-marker-left", `${point.x}px`);
      marker.style.setProperty("--vehicle-marker-top", `${point.y}px`);
      return;
    }
    marker.style.setProperty("--vehicle-marker-left", "50%");
    marker.style.setProperty("--vehicle-marker-top", "50%");
  }

  function applyKakaoPosition(lat, lon, forceLevel = false) {
    if (!state.map || !window.kakao?.maps) return;
    if (routeState.expanded && routeState.active) return;
    const position = new window.kakao.maps.LatLng(lat, lon);
    state.map.setCenter(position);
    setKakaoLevel(position, forceLevel);
    requestOverlayRender("position");
  }

  function renderDisplay() {
    applyMarkerRotation(interp.display.heading);
    updateCompass();
    applyMarkerPosition();
    updateMockPan(interp.display.lat, interp.display.lon);
    applyKakaoPosition(interp.display.lat, interp.display.lon);
    renderOverlay();
    postDebugSnapshot("render");
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
    for (const eventName of ["center_changed", "zoom_changed", "bounds_changed", "idle"]) {
      try {
        window.kakao.maps.event.addListener(state.map, eventName, () => requestOverlayRender(eventName));
      } catch (_) {
        // Older SDK surfaces can ignore optional event hooks.
      }
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
    setMode(state.mode);
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
    } else if (data.type === "route") {
      setRoute(data);
    } else if (data.type === "expanded") {
      setExpanded(data.expanded);
    } else if (data.type === "debug-request") {
      postDebugSnapshot("request", true);
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
          snapshot: buildDebugSnapshot("ready"),
        }, "*");
      }
    } catch (_) {
      // Standalone file preview can ignore parent messaging failures.
    }
  }

  function postToggleExpanded() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          source: "carrot-kmap",
          type: "toggle-expanded",
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
          snapshot: buildDebugSnapshot(options.soft ? "fallback" : "error"),
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
    applyOverlayOptions(params);
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
    root.addEventListener("click", (event) => {
      if (event.target?.closest?.("button")) return;
      postToggleExpanded();
    }, true);
    initDemoControls();
    state.status = "waiting";
    root.dataset.status = "waiting";
    applyMotionState();
    bindMapResizeObserver();
    resizeOverlayCanvas();
    window.addEventListener("resize", () => {
      relayoutKakaoMap();
      navState.dirty = true;
      routeState.dirty = true;
      renderOverlay();
    });
    await initProvider();
    updateStatus();
    postReady();
  }

  window.KmapDebug = {
    snapshot: buildDebugSnapshot,
    post: () => postDebugSnapshot("manual", true),
  };

  init();
})();
