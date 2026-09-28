// Universal Autonomous Transport Engine for Carris Metropolitana
// Calculates fastest route from ANY user origin (Lisbon, Alcochete, Seixal, Montijo)
// to User's Home (Esteval, Montijo) or to Lisbon Oriente.

let localBusData = null;

// Default Home coordinates: Rua Rui de Pina / Bairro Esteval, Montijo
const DEFAULT_HOME = {
  name: "Casa (Rua Rui de Pina, Montijo)",
  address: "Rua Rui de Pina, Montijo",
  lat: 38.7020955,
  lon: -8.9594818
};

// Lisbon Oriente Hub coordinates
const LISBOA_ORIENTE = {
  name: "Lisboa (Gare do Oriente)",
  lat: 38.7679,
  lon: -9.0991
};

function getSavedHome() {
  try {
    const raw = localStorage.getItem('cm_user_home');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.lat && parsed.lon) return parsed;
    }
  } catch (e) {}
  return DEFAULT_HOME;
}

function saveHomeLocation(name, lat, lon) {
  const home = { name, lat: parseFloat(lat), lon: parseFloat(lon) };
  localStorage.setItem('cm_user_home', JSON.stringify(home));
  return home;
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function loadLocalBusData() {
  if (localBusData) return localBusData;
  try {
    const res = await fetch('/bus_data.json');
    localBusData = await res.json();
    return localBusData;
  } catch (e) {
    console.error('Falha ao carregar bus_data.json:', e);
    return null;
  }
}

async function fetchLiveVehicles() {
  try {
    const res = await fetch('https://api.carrismetropolitana.pt/v2/vehicles', {
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.warn('Erro ao consultar veículos em tempo real:', e);
    return [];
  }
}

// Universal Routing Function
async function getSmartRecommendation(userLat, userLon, preferredTarget = 'auto') {
  const data = await loadLocalBusData();
  if (!data) throw new Error('Dados de linhas e paragens indisponíveis');

  const home = getSavedHome();
  const distToHome = calculateDistanceKm(userLat, userLon, home.lat, home.lon);
  const distToOriente = calculateDistanceKm(userLat, userLon, LISBOA_ORIENTE.lat, LISBOA_ORIENTE.lon);

  // Determine destination
  let targetMode = preferredTarget;
  if (targetMode === 'auto') {
    // If user is near Home (< 1.5 km), destination is Lisbon (Oriente)
    // Otherwise, destination is Casa!
    if (distToHome < 1.5) {
      targetMode = 'lisboa';
    } else {
      targetMode = 'home';
    }
  }

  const isGoingHome = targetMode === 'home';
  const destCoords = isGoingHome ? { lat: home.lat, lon: home.lon, name: home.name } : LISBOA_ORIENTE;

  const now = new Date();
  const lisbonTimeStr = now.toLocaleTimeString('pt-PT', {
    timeZone: 'Europe/Lisbon',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const [nowH, nowM, nowS] = lisbonTimeStr.split(':').map(Number);
  const nowSeconds = nowH * 3600 + nowM * 60 + nowS;

  const stopsMap = new Map();
  data.stops.forEach(s => stopsMap.set(s.id, s));

  // Find all candidate trip segments across all patterns
  // An eligible pattern trip must have:
  // - Boarding stop near User (within max 2.5 km walk)
  // - Drop-off stop near Destination (within max 2.5 km walk)
  // - Boarding stop index < Drop-off stop index
  const evaluatedOptions = [];

  const liveVehicles = await fetchLiveVehicles();

  for (const [patternId, pattern] of Object.entries(data.patterns)) {
    if (!pattern.path || pattern.path.length < 2 || !pattern.trips) continue;

    // Search boarding stops near user
    const boardingStops = [];
    pattern.path.forEach((pItem, idx) => {
      const s = stopsMap.get(pItem.stop_id);
      if (s) {
        const d = calculateDistanceKm(userLat, userLon, s.lat, s.lon);
        if (d <= 3.0) { // Max 3km walking to bus stop
          boardingStops.push({ index: idx, stop: s, distanceKm: d, walkMin: Math.round((d / 4.8) * 60) });
        }
      }
    });

    if (boardingStops.length === 0) continue;

    // Search dropoff stops near destination
    const dropoffStops = [];
    pattern.path.forEach((pItem, idx) => {
      const s = stopsMap.get(pItem.stop_id);
      if (s) {
        const d = calculateDistanceKm(destCoords.lat, destCoords.lon, s.lat, s.lon);
        if (d <= 3.0) { // Max 3km walking from final bus stop
          dropoffStops.push({ index: idx, stop: s, distanceKm: d, walkMin: Math.round((d / 4.8) * 60) });
        }
      }
    });

    if (dropoffStops.length === 0) continue;

    // Check valid pairs where boarding happens before dropoff
    for (const b of boardingStops) {
      for (const d of dropoffStops) {
        if (b.index < d.index) {
          // This pattern serves the route!
          // Find next departures
          pattern.trips.forEach(trip => {
            const bSched = trip.schedule.find(sc => sc.stop_id === b.stop.id);
            const dSched = trip.schedule.find(sc => sc.stop_id === d.stop.id);

            if (bSched && bSched.arrival_time && dSched && dSched.arrival_time) {
              const [bh, bm, bs] = bSched.arrival_time.split(':').map(Number);
              const bSec = bh * 3600 + bm * (bs !== undefined ? 60 : 0) + (bs || 0);

              const [dh, dm, ds] = dSched.arrival_time.split(':').map(Number);
              const dSec = dh * 3600 + dm * (ds !== undefined ? 60 : 0) + (ds || 0);

              let diffToBoard = bSec - nowSeconds;
              if (diffToBoard < -1800) diffToBoard += 86400;

              let rideDurationSec = dSec - bSec;
              if (rideDurationSec < 0) rideDurationSec += 86400;
              const rideDurationMin = Math.round(rideDurationSec / 60);

              // Look ahead up to 5 hours
              if (diffToBoard >= 0 && diffToBoard <= 5 * 3600) {
                const waitMin = Math.max(0, Math.round(diffToBoard / 60) - b.walkMin);
                const totalTravelTimeMin = b.walkMin + waitMin + rideDurationMin + d.walkMin;

                evaluatedOptions.push({
                  line: pattern.line_id,
                  headsign: pattern.headsign,
                  color: pattern.color || '#FDB71A',
                  patternId,
                  // Origin
                  originStop: b.stop,
                  originWalkKm: parseFloat(b.distanceKm.toFixed(2)),
                  originWalkMin: b.walkMin,
                  departureTime: bSched.arrival_time.substring(0, 5),
                  minutesUntilDeparture: Math.round(diffToBoard / 60),
                  // Destination
                  destStop: d.stop,
                  destWalkKm: parseFloat(d.distanceKm.toFixed(2)),
                  destWalkMin: d.walkMin,
                  arrivalTime: dSched.arrival_time.substring(0, 5),
                  // Durations
                  rideDurationMin,
                  totalTravelTimeMin,
                  canCatch: Math.round(diffToBoard / 60) >= b.walkMin
                });
              }
            }
          });
        }
      }
    }
  }

  // Deduplicate and Sort
  // 1. Sort by totalTravelTimeMin (Fastest to get home/Oriente)
  evaluatedOptions.sort((a, b) => a.totalTravelTimeMin - b.totalTravelTimeMin);

  // Group unique departure choices
  const seenKeys = new Set();
  const uniqueOptions = [];
  for (const opt of evaluatedOptions) {
    const key = `${opt.line}-${opt.originStop.id}-${opt.departureTime}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueOptions.push(opt);
    }
  }

  // Next bus departing soonest (regardless of total ride, the very next departure leaving towards destination)
  const sortedByDeparture = [...uniqueOptions].sort((a, b) => a.minutesUntilDeparture - b.minutesUntilDeparture);
  const nextDepartureSoonest = sortedByDeparture[0] || null;

  // Fastest overall travel time option
  const fastestOverall = uniqueOptions[0] || null;

  // Real-time live vehicles matching relevant lines
  const activeLineIds = new Set(uniqueOptions.map(o => o.line));
  const nearbyVehicles = liveVehicles.filter(v => activeLineIds.has(String(v.line_id))).map(v => {
    const distToUser = calculateDistanceKm(v.lat, v.lon, userLat, userLon);
    return {
      id: v.id,
      line: v.line_id,
      lat: v.lat,
      lon: v.lon,
      speed: v.speed,
      distanceKm: parseFloat(distToUser.toFixed(2)),
      nextStopId: v.stop_id
    };
  }).sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    currentTime: lisbonTimeStr,
    targetMode,
    destination: destCoords,
    homeLocation: home,
    fastestOption: fastestOverall,
    nextDepartureSoonest: nextDepartureSoonest,
    allOptions: uniqueOptions.slice(0, 8),
    nearbyVehicles: nearbyVehicles.slice(0, 5)
  };
}

// Fallback compatibility with previous app structure
async function getClientSideRecommendation(lat, lon) {
  return await getSmartRecommendation(lat, lon, 'auto');
}
