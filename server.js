const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache static data
let stopsCache = [];
let patternsCache = {};
let linesCache = {};
let lastStopsFetch = 0;

const MONTIJO_LINES = ['4706', '4707', '4708'];
const PATTERN_IDS = ['4706_0_1', '4706_0_2', '4707_0_1', '4707_0_2', '4708_0_1', '4708_0_2'];

// Direction mapping:
// 'lisbon_to_montijo':
//   4706_0_2: Oriente -> Montijo (Alto dos Moinhos)
//   4707_0_1: Oriente -> Montijo (Terminal Rodoviário)
//   4708_0_2: Oriente -> Alcochete via Montijo
// 'montijo_to_lisbon':
//   4706_0_1: Montijo -> Oriente
//   4707_0_2: Montijo (Terminal) -> Oriente
//   4708_0_1: Freeport via Montijo -> Oriente

const PATTERN_DIRECTIONS = {
  '4706_0_1': 'montijo_to_lisbon',
  '4706_0_2': 'lisbon_to_montijo',
  '4707_0_1': 'lisbon_to_montijo',
  '4707_0_2': 'montijo_to_lisbon',
  '4708_0_1': 'montijo_to_lisbon',
  '4708_0_2': 'lisbon_to_montijo'
};

async function fetchFromApi(endpoint) {
  const url = `https://api.carrismetropolitana.pt/v2/${endpoint}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${endpoint}: ${resp.status}`);
  }
  return resp.json();
}

async function initializeStaticData() {
  try {
    console.log('Carregando linhas e paragens da Carris Metropolitana...');
    const [lines, stops] = await Promise.all([
      fetchFromApi('lines'),
      fetchFromApi('stops')
    ]);

    lines.forEach(l => {
      if (MONTIJO_LINES.includes(l.id)) {
        linesCache[l.id] = l;
      }
    });

    const stopsById = {};
    stops.forEach(s => { stopsById[s.id] = s; });

    // Fetch patterns
    for (const pid of PATTERN_IDS) {
      try {
        const pData = await fetchFromApi(`patterns/${pid}`);
        if (Array.isArray(pData) && pData.length > 0) {
          // Take the primary pattern variant
          patternsCache[pid] = pData[0];
        }
      } catch (err) {
        console.error(`Erro ao carregar padrão ${pid}:`, err.message);
      }
    }

    // Filter relevant stops for these 3 lines
    stopsCache = stops.filter(s => {
      const lineIds = s.line_ids || [];
      return lineIds.some(lid => MONTIJO_LINES.includes(lid));
    });

    lastStopsFetch = Date.now();
    console.log(`Carregamento concluído: ${stopsCache.length} paragens relevantes e ${Object.keys(patternsCache).length} padrões carregados.`);
  } catch (error) {
    console.error('Falha ao inicializar dados estáticos:', error);
  }
}

// Distance calculation (Haversine formula in km)
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the Earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Check location region (Lisboa vs Margem Sul / Montijo)
function detectRegion(lat, lon) {
  // Approximate boundary:
  // Lisboa center approx ~38.72 to 38.77, Lon ~ -9.10 to -9.20
  // Montijo center approx ~38.70, Lon ~ -8.97
  // Tagus river divides north (Lisboa) and south (Montijo/Alcochete)
  // Latitude ~38.73 is around the river axis, but longitude is also key:
  // Lon < -9.05 is west (Lisbon side), Lon > -9.05 is east (Montijo / Alcochete side)
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

// Real-time vehicles for Montijo lines
app.get('/api/vehicles', async (req, res) => {
  try {
    const vehicles = await fetchFromApi('vehicles');
    const montijoVehicles = vehicles.filter(v => MONTIJO_LINES.includes(String(v.line_id)));
    res.json(montijoVehicles);
  } catch (err) {
    console.error('Erro ao buscar veículos:', err.message);
    res.status(500).json({ error: 'Erro ao carregar posições em tempo real' });
  }
});

// Best route calculation based on user coordinates
app.get('/api/recommendation', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Coordenadas lat e lon inválidas' });
    }

    const regionInfo = detectRegion(lat, lon);
    const targetDirection = regionInfo.targetDirection;

    // Patterns matching this direction
    const activePatternIds = Object.keys(PATTERN_DIRECTIONS).filter(
      pid => PATTERN_DIRECTIONS[pid] === targetDirection
    );

    // Collect all valid stop IDs along these patterns
    const patternStopMap = new Map();
    activePatternIds.forEach(pid => {
      const pattern = patternsCache[pid];
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

    // Find closest stops that serve this direction
    const stopsWithDistance = stopsCache
      .filter(s => patternStopMap.has(s.id))
      .map(s => {
        const dist = calculateDistanceKm(lat, lon, s.lat, s.lon);
        return {
          ...s,
          distanceKm: parseFloat(dist.toFixed(2)),
          walkTimeMin: Math.round((dist / 4.8) * 60), // Walking at 4.8 km/h
          servesPatterns: patternStopMap.get(s.id)
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);

    // Fetch current live vehicles
    let liveVehicles = [];
    try {
      const allVehicles = await fetchFromApi('vehicles');
      liveVehicles = allVehicles.filter(v => MONTIJO_LINES.includes(String(v.line_id)));
    } catch (e) {
      console.warn('Não foi possível obter veículos em tempo real:', e.message);
    }

    // Now calculate next departures for nearest stops
    const nearestStops = stopsWithDistance.slice(0, 5);

    // Current time in Lisbon (HH:MM:SS)
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

      // Check all patterns that pass by this stop
      stop.servesPatterns.forEach(sp => {
        const pattern = patternsCache[sp.pattern_id];
        if (!pattern || !pattern.trips) return;

        pattern.trips.forEach(trip => {
          const stopSched = trip.schedule.find(sc => sc.stop_id === stop.id);
          if (stopSched && stopSched.arrival_time) {
            const [th, tm, ts] = stopSched.arrival_time.split(':').map(Number);
            const tripSeconds = th * 3600 + tm * (ts !== undefined ? 60 : 0) + (ts || 0);

            let diffSec = tripSeconds - nowSeconds;
            // Handle next day wraps if late night
            if (diffSec < -1800) diffSec += 86400; // if it was earlier today (>30 min ago), wrap to tomorrow or ignore

            if (diffSec >= 0 && diffSec <= 4 * 3600) { // Next 4 hours
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

      // Check if there is any live vehicle currently heading towards this stop
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
        lines: stop.lines,
        nextDepartures: upcomingTrips.slice(0, 4),
        nearbyVehicles: relevantVehicles.slice(0, 2)
      };
    });

    // Determine the absolute best single option
    // Score based on: (walkMinutes) + (minutesUntilNextDeparture)
    let bestOption = null;
    let minTotalTime = Infinity;

    stopResults.forEach(stop => {
      if (stop.nextDepartures.length > 0) {
        const nextDep = stop.nextDepartures[0];
        // Can user walk in time?
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

    res.json({
      currentTime: lisbonTimeStr,
      region: regionInfo,
      bestOption,
      nearestStops: stopResults,
      activeVehiclesCount: liveVehicles.length
    });

  } catch (error) {
    console.error('Erro na recomendação:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server after loading initial metadata
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Servidor HTTP rodando em http://0.0.0.0:${PORT}`);
  await initializeStaticData();
});

try {
  if (fs.existsSync(path.join(__dirname, 'key.pem')) && fs.existsSync(path.join(__dirname, 'cert.pem'))) {
    const httpsOptions = {
      key: fs.readFileSync(path.join(__dirname, 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
    };
    https.createServer(httpsOptions, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`Servidor HTTPS (com GPS desbloqueado) rodando em https://0.0.0.0:${HTTPS_PORT}`);
    });
  }
} catch (e) {
  console.error('Erro ao iniciar HTTPS:', e.message);
}
