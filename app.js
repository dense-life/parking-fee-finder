const DATA_URL = "data/parking_lots.json";
const PAGE_SIZE = 30;

const state = {
  items: [],
  filtered: [],
  shown: PAGE_SIZE,
  origin: null,
  query: "",
  durationMinutes: 120,
  radiusKm: 5,
  freeOnly: false,
  sort: "recommended",
  meta: null,
  map: null,
  markerGroup: null,
  markers: new Map(),
  userMarker: null,
  userAccuracy: null,
  demo: false,
};

const elements = {
  form: document.querySelector("#search-form"),
  query: document.querySelector("#place-query"),
  clear: document.querySelector("#clear-query"),
  locate: document.querySelector("#locate-button"),
  duration: document.querySelector("#duration"),
  radius: document.querySelector("#radius"),
  radiusField: document.querySelector("#radius-field"),
  freeOnly: document.querySelector("#free-only"),
  sort: document.querySelector("#sort-by"),
  count: document.querySelector("#result-count"),
  status: document.querySelector("#status-panel"),
  list: document.querySelector("#results-list"),
  more: document.querySelector("#load-more"),
  locationStatus: document.querySelector("#location-status"),
  updated: document.querySelector("#data-updated"),
  map: document.querySelector("#parking-map"),
  mapSection: document.querySelector(".map-section"),
  mapCaption: document.querySelector("#map-caption"),
  mapCount: document.querySelector("#map-count"),
  demoBanner: document.querySelector("#demo-banner"),
};

const DEFAULT_MAP_CENTER = [36.25, 127.85];
const MAX_MAP_MARKERS = 100;

function initMap() {
  if (!window.L) {
    elements.mapSection.classList.add("is-error");
    elements.map.textContent = "지도를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.";
    elements.mapCaption.textContent = "지도 라이브러리 연결 필요";
    return;
  }
  state.map = L.map(elements.map, { scrollWheelZoom: false }).setView(DEFAULT_MAP_CENTER, 7);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
  }).addTo(state.map);
  state.markerGroup = L.layerGroup().addTo(state.map);
  state.map.whenReady(() => window.setTimeout(() => state.map.invalidateSize(), 120));
}

function clean(value) {
  return String(value ?? "").trim();
}

function numberValue(value) {
  const normalized = clean(value).replace(/,/g, "");
  if (!normalized) return null;
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function normalizeItem(item) {
  return {
    id: clean(item.id || item.prkplceNo),
    name: clean(item.name || item.prkplceNm) || "이름 정보 없음",
    type: clean(item.type || item.prkplceType),
    category: clean(item.category || item.prkplceSe),
    address: clean(item.address || item.rdnmadr || item.lnmadr),
    lotAddress: clean(item.lnmadr),
    spaces: numberValue(item.spaces ?? item.prkcmprt),
    basicTime: numberValue(item.basicTime),
    basicCharge: numberValue(item.basicCharge),
    addUnitTime: numberValue(item.addUnitTime),
    addUnitCharge: numberValue(item.addUnitCharge),
    dailyTime: numberValue(item.dailyTime ?? item.dayCmmtktAdjTime),
    dailyCharge: numberValue(item.dailyCharge ?? item.dayCmmtkt),
    monthlyCharge: numberValue(item.monthlyCharge ?? item.monthCmmtkt),
    feeInfo: clean(item.feeInfo || item.parkingchrgeInfo),
    note: clean(item.note || item.spcmnt),
    days: clean(item.days || item.operDay),
    weekdayOpen: clean(item.weekdayOpen || item.weekdayOperOpenHhmm),
    weekdayClose: clean(item.weekdayClose || item.weekdayOperColseHhmm || item.weekdayOperCloseHhmm),
    saturdayOpen: clean(item.saturdayOpen || item.satOperOperOpenHhmm),
    saturdayClose: clean(item.saturdayClose || item.satOperCloseHhmm),
    holidayOpen: clean(item.holidayOpen || item.holidayOperOpenHhmm),
    holidayClose: clean(item.holidayClose || item.holidayCloseOpenHhmm),
    payment: clean(item.payment || item.metpay),
    phone: clean(item.phone || item.phoneNumber),
    manager: clean(item.manager || item.institutionNm),
    latitude: numberValue(item.latitude),
    longitude: numberValue(item.longitude),
    referenceDate: clean(item.referenceDate),
  };
}

function formatWon(amount) {
  return `${Math.max(0, Math.round(amount)).toLocaleString("ko-KR")}원`;
}

function estimatedFee(lot, minutes) {
  const text = `${lot.feeInfo} ${lot.note}`;
  if (/무료/.test(text) && !(lot.basicCharge > 0) && !(lot.addUnitCharge > 0)) {
    return { amount: 0, label: "무료", known: true, method: "무료로 안내된 주차장" };
  }
  if (lot.basicCharge === null || lot.basicTime === null) {
    return { amount: null, label: "요금 확인 필요", known: false, method: lot.feeInfo || "요금 정보 미등록" };
  }
  if (lot.basicCharge === 0 && (!lot.addUnitCharge || lot.addUnitCharge === 0)) {
    if (/무료|무료주차/.test(text)) {
      return { amount: 0, label: "무료", known: true, method: "무료로 안내된 주차장" };
    }
    return { amount: null, label: "요금 확인 필요", known: false, method: lot.feeInfo || "요금 기준이 불명확합니다" };
  }

  const baseMinutes = Math.max(0, lot.basicTime);
  let amount = lot.basicCharge;
  if (minutes > baseMinutes) {
    if (lot.addUnitTime === null || lot.addUnitTime <= 0 || lot.addUnitCharge === null) {
      return { amount: null, label: "요금 확인 필요", known: false, method: lot.feeInfo || "추가 요금 기준 미등록" };
    }
    amount += Math.ceil((minutes - baseMinutes) / lot.addUnitTime) * lot.addUnitCharge;
  }

  let method = `${baseMinutes}분 ${formatWon(lot.basicCharge)} 이후 ${lot.addUnitTime || 0}분마다 ${formatWon(lot.addUnitCharge || 0)}`;
  if (lot.dailyTime && lot.dailyTime > 0 && lot.dailyCharge !== null && minutes >= lot.dailyTime && lot.dailyCharge < amount) {
    amount = lot.dailyCharge;
    method += ` · 1일권 적용`;
  }
  return { amount, label: formatWon(amount), known: true, method: `등록 요금 기준 단순 예상 · ${method}` };
}

function haversineKm(a, b) {
  const rad = (degree) => (degree * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const lat1 = rad(a.latitude);
  const lat2 = rad(b.latitude);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function isFree(lot) {
  const text = `${lot.feeInfo} ${lot.note}`;
  return /무료/.test(text) && !(lot.basicCharge > 0) && !(lot.addUnitCharge > 0);
}

function isCoordValid(lot) {
  return lot.latitude !== null && lot.longitude !== null && Math.abs(lot.latitude) <= 90 && Math.abs(lot.longitude) <= 180;
}

function setStatus(title, description, isError = false) {
  elements.status.hidden = false;
  elements.status.classList.toggle("is-error", isError);
  elements.status.querySelector("strong").textContent = title;
  elements.status.querySelector("p").textContent = description;
}

function clearStatus() {
  elements.status.hidden = true;
  elements.status.classList.remove("is-error");
}

function formatDistance(distance) {
  if (!Number.isFinite(distance)) return "거리 미확인";
  if (distance < 1) return `${Math.round(distance * 1000)}m`;
  return `${distance.toFixed(1)}km`;
}

function formatTime(open, close) {
  if (!open && !close) return "정보 없음";
  if (/24:00|23:59/.test(close) && open === "00:00") return "24시간 운영";
  return `${open || "미상"}–${close || "미상"}`;
}

function openMapUrl(lot) {
  const query = `${lot.name} ${lot.address}`.trim();
  if (isCoordValid(lot)) {
    return `https://map.naver.com/p/search/${encodeURIComponent(query)}`;
  }
  return `https://map.naver.com/p/search/${encodeURIComponent(query)}`;
}

function createCard(lot, index) {
  const fee = estimatedFee(lot, state.durationMinutes);
  const distance = state.origin && isCoordValid(lot) ? haversineKm(state.origin, lot) : null;
  const card = document.createElement("article");
  card.className = "parking-card";
  card.dataset.mapKey = String(lot.mapKey);
  card.style.animationDelay = `${Math.min(index, 10) * 18}ms`;

  const top = document.createElement("div");
  top.className = "card-top";
  const headingArea = document.createElement("div");
  const name = document.createElement("h3");
  name.className = "parking-name";
  name.textContent = lot.name;
  headingArea.append(name);

  const tags = document.createElement("div");
  tags.className = "parking-type";
  if (lot.category) tags.append(createTag(lot.category, /공영/.test(lot.category)));
  if (lot.type) tags.append(createTag(lot.type, false));
  if (isFree(lot)) tags.append(createTag("무료", true));
  headingArea.append(tags);
  const distanceLabel = document.createElement("span");
  distanceLabel.className = "distance";
  distanceLabel.textContent = state.origin ? formatDistance(distance) : "";
  top.append(headingArea, distanceLabel);

  const address = document.createElement("p");
  address.className = "address-line";
  const pin = document.createElement("span");
  pin.textContent = "⌖";
  const addressText = document.createElement("span");
  addressText.textContent = lot.address || lot.lotAddress || "주소 정보 없음";
  address.append(pin, addressText);

  const details = document.createElement("div");
  details.className = "card-details";
  details.append(
    createDetail("운영시간 (평일)", formatTime(lot.weekdayOpen, lot.weekdayClose)),
    createDetail("주차 구획", lot.spaces !== null && lot.spaces > 0 ? `${lot.spaces.toLocaleString("ko-KR")}면` : "정보 없음"),
    createDetail("요금 정보", lot.feeInfo || (lot.basicCharge !== null ? "기본 요금 등록" : "정보 없음")),
  );

  const feeBox = document.createElement("div");
  feeBox.className = "fee-box";
  const feeText = document.createElement("div");
  const caption = document.createElement("div");
  caption.className = "fee-caption";
  caption.textContent = `${Math.floor(state.durationMinutes / 60)}시간${state.durationMinutes % 60 ? ` ${state.durationMinutes % 60}분` : ""} 예상 요금`;
  const value = document.createElement("div");
  value.className = `fee-value${fee.known ? "" : " unknown"}`;
  value.textContent = fee.label;
  const note = document.createElement("div");
  note.className = "fee-note";
  note.textContent = fee.known ? "추가 할인·감면 전 금액" : fee.method;
  feeText.append(caption, value, note);

  const map = document.createElement("a");
  map.className = "map-link";
  map.href = openMapUrl(lot);
  map.target = "_blank";
  map.rel = "noreferrer";
  map.innerHTML = '<span aria-hidden="true">↗</span> 지도에서 보기';
  feeBox.append(feeText, map);
  card.append(top, address, details, feeBox);
  return card;
}

function createTag(text, isPublic) {
  const tag = document.createElement("span");
  tag.className = `tag${isPublic ? " public" : ""}`;
  tag.textContent = text;
  return tag;
}

function createDetail(label, value) {
  const wrapper = document.createElement("div");
  const labelNode = document.createElement("span");
  labelNode.className = "detail-label";
  labelNode.textContent = label;
  const valueNode = document.createElement("span");
  valueNode.className = "detail-value";
  valueNode.textContent = value;
  wrapper.append(labelNode, valueNode);
  return wrapper;
}

function popupNode(lot) {
  const wrapper = document.createElement("div");
  const title = document.createElement("p");
  title.className = "map-popup-title";
  title.textContent = lot.name;
  const address = document.createElement("p");
  address.className = "map-popup-info";
  address.textContent = lot.address || lot.lotAddress || "주소 정보 없음";
  const fee = document.createElement("p");
  fee.className = "map-popup-info";
  fee.textContent = `예상 ${Math.floor(state.durationMinutes / 60)}시간 요금: ${estimatedFee(lot, state.durationMinutes).label}`;
  const link = document.createElement("a");
  link.className = "map-popup-link";
  link.href = openMapUrl(lot);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "네이버 지도에서 보기 ↗";
  wrapper.append(title, address, fee, link);
  return wrapper;
}

function renderMap() {
  if (!state.map || !state.markerGroup) return;
  state.markerGroup.clearLayers();
  state.markers.clear();
  state.userMarker = null;
  state.userAccuracy = null;

  const hasSearch = Boolean(state.query || state.origin || state.freeOnly);
  if (!hasSearch) {
    elements.mapCaption.textContent = "검색 결과 주차장을 표시합니다";
    elements.mapCount.textContent = "검색 후 지도에 위치가 표시됩니다";
    state.map.setView(DEFAULT_MAP_CENTER, 7);
    return;
  }

  const coordinateItems = state.filtered.filter(isCoordValid);
  const mapItems = coordinateItems.slice(0, MAX_MAP_MARKERS);
  const mapPoints = [];

  mapItems.forEach((lot) => {
    const marker = L.marker([lot.latitude, lot.longitude], {
      icon: L.divIcon({ className: "parking-marker", html: "<span><b>P</b></span>", iconSize: [30, 38], iconAnchor: [15, 36] }),
      title: lot.name,
      keyboard: true,
    }).addTo(state.markerGroup);
    marker.bindPopup(popupNode(lot), { maxWidth: 250 });
    marker.on("click", () => {
      const card = elements.list.querySelector(`[data-map-key="${lot.mapKey}"]`);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    state.markers.set(String(lot.mapKey), marker);
    mapPoints.push([lot.latitude, lot.longitude]);
  });

  if (state.origin) {
    const userIcon = L.divIcon({ className: "user-marker", html: "<span>나</span>", iconSize: [34, 34], iconAnchor: [17, 17] });
    state.userMarker = L.marker([state.origin.latitude, state.origin.longitude], { icon: userIcon, title: "내 위치", zIndexOffset: 1000 }).addTo(state.markerGroup);
    state.userMarker.bindPopup("내 위치");
    if (state.origin.accuracy && state.origin.accuracy < 1500) {
      state.userAccuracy = L.circle([state.origin.latitude, state.origin.longitude], {
        radius: Math.max(25, state.origin.accuracy),
        color: "#4285f4",
        weight: 1,
        opacity: 0.55,
        fillColor: "#4285f4",
        fillOpacity: 0.09,
      }).addTo(state.markerGroup);
    }
    mapPoints.push([state.origin.latitude, state.origin.longitude]);
  }

  elements.mapCaption.textContent = state.origin
    ? `내 위치 기준 ${state.radiusKm}km 안의 주차장`
    : `${state.query || "조건"} 검색 결과`;
  const missingCoordinates = Math.max(0, state.filtered.length - coordinateItems.length);
  elements.mapCount.textContent = `${mapItems.length}곳 표시${missingCoordinates ? ` · 위치 미등록 ${missingCoordinates}곳` : ""}${coordinateItems.length > MAX_MAP_MARKERS ? ` · 지도는 가까운 ${MAX_MAP_MARKERS}곳까지` : ""}`;

  if (mapPoints.length === 1) {
    state.map.setView(mapPoints[0], 14);
  } else if (mapPoints.length > 1) {
    state.map.fitBounds(mapPoints, { padding: [24, 24], maxZoom: 15 });
  } else {
    state.map.setView(DEFAULT_MAP_CENTER, 7);
  }
  window.setTimeout(() => state.map.invalidateSize(), 80);
}

function applySearch() {
  state.query = clean(elements.query.value).toLocaleLowerCase("ko-KR");
  state.durationMinutes = Number(elements.duration.value) || 120;
  state.radiusKm = Number(elements.radius.value) || 5;
  state.freeOnly = elements.freeOnly.checked;
  state.sort = elements.sort.value;
  state.shown = PAGE_SIZE;

  const words = state.query.split(/\s+/).filter(Boolean);
  let results = state.items.filter((lot, index) => {
    lot.mapKey = index;
    if (words.length && !words.every((word) => `${lot.name} ${lot.address} ${lot.lotAddress} ${lot.category} ${lot.type}`.toLocaleLowerCase("ko-KR").includes(word))) return false;
    if (state.freeOnly && !isFree(lot)) return false;
    if (state.origin && isCoordValid(lot)) lot.distanceKm = haversineKm(state.origin, lot);
    else lot.distanceKm = null;
    if (state.origin && (lot.distanceKm === null || lot.distanceKm > state.radiusKm)) return false;
    lot.feeEstimate = estimatedFee(lot, state.durationMinutes);
    return true;
  });

  if (state.sort === "distance" && state.origin) {
    results.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  } else if (state.sort === "price") {
    results.sort((a, b) => (a.feeEstimate.amount ?? Infinity) - (b.feeEstimate.amount ?? Infinity));
  } else if (state.sort === "spaces") {
    results.sort((a, b) => (b.spaces ?? -1) - (a.spaces ?? -1));
  } else if (state.origin) {
    results.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  } else {
    results.sort((a, b) => (a.feeEstimate.amount ?? Infinity) - (b.feeEstimate.amount ?? Infinity));
  }

  state.filtered = results;
  elements.count.textContent = state.query || state.origin || state.freeOnly ? `${results.length.toLocaleString("ko-KR")}곳` : "검색 전";
  renderResults();
}

function renderResults() {
  elements.list.replaceChildren();
  renderMap();
  if (!state.query && !state.origin && !state.freeOnly) {
    setStatus("지역을 검색하거나 내 위치를 확인해 주세요.", "주차 요금과 운영시간은 제공기관의 등록 정보이며, 실시간 빈자리 정보는 아닙니다.");
    elements.more.hidden = true;
    return;
  }
  if (!state.filtered.length) {
    setStatus("검색 결과가 없습니다.", "지역명이나 주소를 짧게 바꾸어 다시 검색해 보세요. 예: ‘강남구’, ‘해운대구’.");
    elements.more.hidden = true;
    return;
  }
  clearStatus();
  state.filtered.slice(0, state.shown).forEach((lot, index) => elements.list.append(createCard(lot, index)));
  const remaining = Math.max(0, state.filtered.length - state.shown);
  elements.more.hidden = remaining === 0;
  if (remaining > 0) elements.more.textContent = `주차장 더 보기 (${remaining}곳)`;
}

async function loadData() {
  try {
    state.demo = new URLSearchParams(window.location.search).get("demo") === "1";
    const dataUrl = state.demo ? "data/demo_parking_lots.json" : DATA_URL;
    const response = await fetch(dataUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`데이터 요청 실패 (${response.status})`);
    const payload = await response.json();
    state.items = (Array.isArray(payload) ? payload : payload.items || []).map(normalizeItem).filter((lot) => lot.name !== "이름 정보 없음" || lot.address);
    state.meta = Array.isArray(payload) ? null : payload.meta || null;
    if (state.demo) {
      elements.demoBanner.hidden = false;
      elements.query.value = "서울 중구";
      elements.clear.hidden = false;
      elements.updated.textContent = "데모 데이터 · 실제 데이터가 아닙니다.";
      applySearch();
      return;
    }
    if (!state.items.length) {
      elements.updated.textContent = "주차장 데이터가 아직 준비되지 않았습니다.";
      setStatus("주차장 정보 준비 중입니다.", "데이터가 갱신된 뒤 다시 이용해 주세요.");
      return;
    }
    const updatedAt = state.meta?.fetchedAt ? new Date(state.meta.fetchedAt) : null;
    elements.updated.textContent = updatedAt && !Number.isNaN(updatedAt.valueOf())
      ? `데이터 수집: ${updatedAt.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })} · 최대 기준일 ${state.meta?.maxReferenceDate || "미확인"}`
      : "데이터 기준일은 주차장별로 다를 수 있습니다.";
    elements.count.textContent = "검색 전";
  } catch (error) {
    elements.updated.textContent = "주차장 데이터를 불러오지 못했습니다.";
    setStatus("데이터를 불러오지 못했습니다.", "잠시 뒤 새로고침해 주세요. 문제가 계속되면 운영자에게 알려주세요.", true);
    console.error(error);
  }
}

function requestLocation() {
  if (!navigator.geolocation) {
    elements.locationStatus.textContent = "이 브라우저는 위치 확인을 지원하지 않습니다.";
    return;
  }
  elements.locate.disabled = true;
  elements.locationStatus.textContent = "위치 확인 중…";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.origin = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy };
      elements.locationStatus.textContent = `내 위치 기준 · ${state.radiusKm}km · 거리순`;
      elements.radiusField.hidden = false;
      elements.sort.value = "distance";
      elements.locate.disabled = false;
      applySearch();
    },
    (error) => {
      elements.locate.disabled = false;
      elements.locationStatus.textContent = error.code === error.PERMISSION_DENIED ? "위치 권한을 허용하면 주변 주차장을 볼 수 있어요." : "위치를 확인하지 못했습니다. 지역명을 검색해 주세요.";
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.origin = null;
  elements.radiusField.hidden = true;
  elements.locationStatus.textContent = "";
  applySearch();
});
elements.query.addEventListener("input", () => { elements.clear.hidden = !elements.query.value; });
elements.clear.addEventListener("click", () => {
  elements.query.value = "";
  elements.clear.hidden = true;
  elements.query.focus();
});
elements.locate.addEventListener("click", requestLocation);
elements.duration.addEventListener("change", applySearch);
elements.radius.addEventListener("change", () => {
  elements.locationStatus.textContent = `내 위치 기준 · ${elements.radius.value}km · 거리순`;
  applySearch();
});
elements.freeOnly.addEventListener("change", applySearch);
elements.sort.addEventListener("change", applySearch);
elements.more.addEventListener("click", () => { state.shown += PAGE_SIZE; renderResults(); });
elements.list.addEventListener("click", (event) => {
  if (event.target.closest("a, button")) return;
  const card = event.target.closest(".parking-card");
  const marker = card ? state.markers.get(card.dataset.mapKey) : null;
  if (marker && state.map) {
    state.map.setView(marker.getLatLng(), Math.max(15, state.map.getZoom()), { animate: true });
    marker.openPopup();
  }
});

initMap();
loadData();
