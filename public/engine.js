// Autonomous Client-side Transport Engine for Carris Metropolitana
// Works completely standalone inside the APK without requiring any local backend server.

let localBusData = null;

const PATTERN_DIRECTIONS = {
  '4706_0_1': 'montijo_to_lisbon',
  '4706_0_2': 'lisbon_to_montijo',
  '4707_0_1': 'lisbon_to_montijo',
  '4707_0_2': 'montijo_to_lisbon',
  '4708_0_1': 'montijo_to_lisbon',
  '4708_0_2': 'lisbon_to_montijo'
};

const MONTIJO_LINES = ['4706', '4707', '4708'];

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

function detectRegion(lat, lon) {
  const distToOriente = calculateDistanceKm(lat, lon, 38.7679, -9.0991);
  const distToMontijoCenter = calculateDistanceKm(lat, lon, 38.7065, -8.9737);

  if (distToOriente < distToMontijoCenter) {
    return {
      currentRegion: 'lisbon',
      regionName: 'Lisboa / Margem Norte',
      destinationRegion: 'montijo',
      destinationName: 'Montijo',
      targetDirection: 'lisbon_to_montijo'
    };
  } else {
    return {
      currentRegion: 'montijo',
      regionName: 'Montijo / Margem Sul',
      destinationRegion: 'lisbon',
      destinationName: 'Lisboa (Oriente)',
      targetDirection: 'montijo_to_lisbon'
    };
  }
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
    const vehicles = await res.json();
    return vehicles.filter(v => MONTIJO_LINES.includes(String(v.line_id)));
  } catch (e) {
    console.warn('Erro ao consultar veículos em tempo real:', e);
    return [];
  }
}

async function getClientSideRecommendation(lat, lon) {
  const data = await loadLocalBusData();
  if (!data) throw new Error('Dados estáticos de autocarro indisponíveis');

  const regionInfo = detectRegion(lat, lon);
  const targetDirection = regionInfo.targetDirection;

  const activePatternIds = Object.keys(PATTERN_DIRECTIONS).filter(
    pid => PATTERN_DIRECTIONS[pid] === targetDirection
  );

  const patternStopMap = new Map();
  activePatternIds.forEach(pid => {
    const pattern = data.patterns[pid];
    if (pattern && pattern.path) {
      pattern.path.forEach(pathItem => {
        if (!patternStopMap.has(pathItem.stop_id)) {
          patternStopMap.set(pathItem.stop_id, []);
        }
        patternStopMap.get(pathItem.stop_id).push({
          pattern_id: pid,
          line_id: pattern.line_id,
          headsign: pattern.headsign,
          color: pattern.color
        });
      });
    }
  });

  const stopsWithDistance = data.stops
    .filter(s => patternStopMap.has(s.id))
    .map(s => {
      const dist = calculateDistanceKm(lat, lon, s.lat, s.lon);
      return {
        ...s,
        distanceKm: parseFloat(dist.toFixed(2)),
        walkTimeMin: Math.round((dist / 4.8) * 60),
        servesPatterns: patternStopMap.get(s.id)
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const liveVehicles = await fetchLiveVehicles();

  const nearestStops = stopsWithDistance.slice(0, 5);

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

  const stopResults = nearestStops.map(stop => {
    const upcomingTrips = [];

    stop.servesPatterns.forEach(sp => {
      const pattern = data.patterns[sp.pattern_id];
      if (!pattern || !pattern.trips) return;

      pattern.trips.forEach(trip => {
        const stopSched = trip.schedule.find(sc => sc.stop_id === stop.id);
        if (stopSched && stopSched.arrival_time) {
          const [th, tm, ts] = stopSched.arrival_time.split(':').map(Number);
          const tripSeconds = th * 3600 + tm * (ts !== undefined ? 60 : 0) + (ts || 0);

          let diffSec = tripSeconds - nowSeconds;
          if (diffSec < -1800) diffSec += 86400;

          if (diffSec >= 0 && diffSec <= 4 * 3600) {
            upcomingTrips.push({
              line: pattern.line_id,
              headsign: pattern.headsign,
              color: pattern.color,
              scheduledTime: stopSched.arrival_time.substring(0, 5),
              minutesUntil: Math.round(diffSec / 60),
              rawDiffSec: diffSec
            });
          }
        }
      });
    });

    upcomingTrips.sort((a, b) => a.rawDiffSec - b.rawDiffSec);

    const relevantVehicles = liveVehicles.filter(v => {
      const vPat = v.pattern_id || '';
      return activePatternIds.some(pid => vPat.includes(pid));
    }).map(v => {
      const distToStop = calculateDistanceKm(v.lat, v.lon, stop.lat, stop.lon);
      return {
        id: v.id,
        line: v.line_id,
        lat: v.lat,
        lon: v.lon,
        speed: v.speed,
        distanceToStopKm: parseFloat(distToStop.toFixed(2)),
        nextStopId: v.stop_id
      };
    }).sort((a, b) => a.distanceToStopKm - b.distanceToStopKm);

    return {
      stopId: stop.id,
      stopName: stop.tts_name || stop.long_name,
      lat: stop.lat,
      lon: stop.lon,
      distanceKm: stop.distanceKm,
      walkMinutes: stop.walkTimeMin,
      lines: stop.lines || stop.line_ids || [],
      nextDepartures: upcomingTrips.slice(0, 4),
      nearbyVehicles: relevantVehicles.slice(0, 2)
    };
  });

  let bestOption = null;
  let minTotalTime = Infinity;

  stopResults.forEach(stop => {
    if (stop.nextDepartures.length > 0) {
      const nextDep = stop.nextDepartures[0];
      const waitTime = Math.max(0, nextDep.minutesUntil - stop.walkMinutes);
      const totalTravelStartTime = stop.walkMinutes + waitTime;
      if (totalTravelStartTime < minTotalTime) {
        minTotalTime = totalTravelStartTime;
        bestOption = {
          stopName: stop.stopName,
          stopId: stop.stopId,
          stopLat: stop.lat,
          stopLon: stop.lon,
          line: nextDep.line,
          headsign: nextDep.headsign,
          color: nextDep.color,
          departureTime: nextDep.scheduledTime,
          minutesUntilDeparture: nextDep.minutesUntil,
          walkDistanceKm: stop.distanceKm,
          walkMinutes: stop.walkMinutes,
          totalMinutesToBus: totalTravelStartTime,
          canCatch: nextDep.minutesUntil >= stop.walkMinutes,
          nearbyLiveVehicle: stop.nearbyVehicles[0] || null
        };
      }
    }
  });

  return {
    currentTime: lisbonTimeStr,
    region: regionInfo,
    bestOption,
    nearestStops: stopResults,
    activeVehiclesCount: liveVehicles.length
  };
}
