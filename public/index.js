// Initialize map
const map = L.map('map');

// Global data indices
let raptorIndex;
let shapeIndex;
let stopInfo;
let routeInfo;
let keelungBoundary;

// Dedicated layer group to hold all active route drawings (lines, markers, labels)
// This allows us to clear the map instantly when switching modes
const currentRouteLayer = L.featureGroup().addTo(map);

map.createPane('walkingDotsPane');
map.getPane('walkingDotsPane').style.zIndex = 700;
map.getPane('walkingDotsPane').style.pointerEvents = 'none';

const redIcon = new L.Icon({
    iconUrl: "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png",
    shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41]
});

// --- 1. CORE DATA & UTILITIES ---

async function loadData() {
    [raptorIndex, shapeIndex, stopInfo, routeInfo, keelungBoundary] = await Promise.all([
        fetch("/processed/raptorIndex.json").then(r => r.json()),
        fetch("/processed/shapeIndex.json").then(r => r.json()),
        fetch("/processed/stopInfo.json").then(r => r.json()),
        fetch("/processed/routeInfo.json").then(r => r.json()),
        fetch("/api/keelung-boundary").then(r => {
            if (!r.ok) {
                throw new Error("Failed to load Keelung boundary.");
            }
            return r.json();
        })
    ]);
}

async function geocode(place) {
    if (place === "USERCURRENTPOS") {
        return getUserLocation();
    }

    // Nominatim endpoint
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`;

    try {
        const res = await fetch(url, {
            headers: {
                "Accept": "application/json"
            }
        });

        const data = await res.json();

        if (!data || data.length === 0) {
            console.log(`Location not found: ${place}`);
            return null;
        }

        const result = data[0];

        // Nominatim directly provides latitude and longitude
        const lat = parseFloat(result.lat);
        const lng = parseFloat(result.lon);

        // Nominatim provides a display_name directly
        const displayName = result.display_name || place;

        return {
            lat: lat,
            lng: lng,
            displayName: displayName
        };

    } catch (err) {
        console.error("Nominatim Geocoding error:", err);
        return null;
    }
}

async function centerMapOnUserLocation() {
    try {
        const location = await getUserLocation();
        map.setView(
            [location.lat, location.lng],
            14
        );
    } catch (error) {
        // default to NTOU
        map.setView([25.1500, 121.7750], 14);
    }
}

function isInsideKeelung(coords) {
    const point = turf.point([coords.lng, coords.lat]);

    if (keelungBoundary.type === "FeatureCollection") {
        return keelungBoundary.features.some(feature =>
            turf.booleanPointInPolygon(point, feature)
        );
    }

    return turf.booleanPointInPolygon(point, keelungBoundary);
}

function findClosestVertexIndex(polylinePoints, targetLat, targetLng) {
    let closestIdx = 0;
    let minDistance = Infinity;
    for (let i = 0; i < polylinePoints.length; i++) {
        const dLat = polylinePoints[i][0] - targetLat;
        const dLng = polylinePoints[i][1] - targetLng;
        const dist = dLat * dLat + dLng * dLng;
        if (dist < minDistance) {
            minDistance = dist;
            closestIdx = i;
        }
    }
    return closestIdx;
}

function getUserLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            return reject(new Error("Geolocation is not supported by this browser."));
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                resolve({
                    lat: position.coords.latitude,
                    lng: position.coords.longitude,
                    displayName: "Your Device Location"
                });
            },
            (error) => {
                reject(error);
            },
            {
                enableHighAccuracy: true, // Forces device to use GPS hardware if available
                timeout: 8000,            // Give up after 8 seconds
                maximumAge: 0             // Force fresh location data, no caching
            }
        );
    });
}

function getCurrentTimeFormatted() {
    const now = new Date();
    // Get hours and minutes, pad with leading zeros if needed
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

// Helper to turn the "minutes since midnight" back into HH:MM
function formatMinutesToTime(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = Math.floor(totalMinutes % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return (hours * 60) + minutes;
}

function getStopName(stopUID) {
    return stopInfo[stopUID]?.name_en || stopUID;
}

function getBusCode(busUID) {
    const routeUID = busUID.split('_').slice(0, 2).join('_');
    return routeInfo[routeUID]?.name_en || routeUID;
}

function countStops(routeId, boardUID, alightUID) {
    // 1. Get the array of stops directly
    const stops = raptorIndex.routeStops[routeId];
    
    // 2. Safety check: if route doesn't exist, return 0
    if (!stops || !Array.isArray(stops)) {
        console.warn("Route ID not found or invalid format:", routeId);
        return 0;
    }
    
    // 3. Find indices directly in the array
    const boardIdx = stops.indexOf(boardUID);
    const alightIdx = stops.indexOf(alightUID);
    
    // 4. Handle cases where stops aren't found (maybe the bus route changed?)
    if (boardIdx === -1 || alightIdx === -1) return 0;
    
    return Math.abs(alightIdx - boardIdx);
}

function generateRouteSummary(result) {
    if (!result || !result.journey) return "I couldn't find a viable route.";
    
    const legs = result.journey;
    
    const descriptions = legs.map((leg) => {
        const originName = getStopName(leg.boardedAt);
        const destName = getStopName(leg.alightedAt);
        const boardTime = leg.boardTime;
        const busCode = getBusCode(leg.route);
        const stopCount = countStops(leg.route, leg.boardedAt, leg.alightedAt);
        
        return `Ride ${busCode} Bus at ${boardTime} from ${originName} to ${destName} (${stopCount} stops)`;
    });

    let summary = `I've mapped out your trip. ${descriptions.join(", then ")}. `;
    
    summary += `You'll arrive at your final destination at approximately ${formatMinutesToTime(result.finalDoorArrivalTime)}.`;

    return summary;
}

// --- 2. VEHICLE ROUTING ENGINE (OSRM) ---

async function getOSRMRoute(profile, start, end) {
    const url = `https://router.project-osrm.org/route/v1/${profile}/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    return data.routes[0].geometry.coordinates;
}

async function getVehicleOSRMRoute(start, end) {
    return getOSRMRoute('driving', start, end);
}

async function getWalkingValhallaRoute(start, end) {
    const requestPayload = {
        locations: [
            { lat: start.lat, lon: start.lng },
            { lat: end.lat, lon: end.lng }
        ],
        costing: "pedestrian", 
        units: "kilometers"
    };

    const url = `https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(requestPayload))}`;

    try {
        const res = await fetch(url);
        const data = await res.json();

        // Safety check
        if (!data.trip || !data.trip.legs || data.trip.legs.length === 0) {
            console.warn("Valhalla returned no trip legs:", data);
            return [];
        }

        const polylineString = data.trip.legs[0].shape;
        const decodedPoints = polyline.decode(polylineString, 6);
        return decodedPoints.map(([lat, lng]) => [lng, lat]); 

    } catch (err) {
        console.error("Valhalla walking route error:", err);
        return [];
    }
}

async function getWalkingOSRMRoute(start, end) {
    return getOSRMRoute('foot', start, end);
}

async function handleVehicleRouting(startCoords, endCoords) {
    // Drop destination marker
    L.marker([endCoords.lat, endCoords.lng], { icon: redIcon })
        .addTo(currentRouteLayer)
        .bindPopup(endCoords.displayName);

    // Fetch and map coordinates
    const coords = await getVehicleOSRMRoute(startCoords, endCoords);
    const latlngs = coords.map(c => [c[1], c[0]]);

    // Draw driving polyline
    L.polyline(latlngs, {
        color: "#2563eb",
        weight: 5,
        opacity: 0.8
    }).addTo(currentRouteLayer);
}

async function drawWalkingDotRoute(startCoords, endCoords) {
    //const coords = await getWalkingOSRMRoute(startCoords, endCoords);
    const coords = await getWalkingValhallaRoute(startCoords, endCoords);
    console.log("walk: ", coords);
    const latlngs = coords.map(c => [c[1], c[0]]);

    if (latlngs.length === 0) return;

    const sampledPoints = [latlngs[0]];
    const spacingMeters = 28;

    const toMeters = (a, b) => {
        const latScale = 111320;
        const lngScale = 111320 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
        const dLat = (b[0] - a[0]) * latScale;
        const dLng = (b[1] - a[1]) * lngScale;
        return Math.sqrt((dLat * dLat) + (dLng * dLng));
    };

    const interpolatePoint = (a, b, fraction) => [
        a[0] + ((b[0] - a[0]) * fraction),
        a[1] + ((b[1] - a[1]) * fraction)
    ];

    let distanceSinceLastDot = 0;
    let previousPoint = latlngs[0];

    for (let i = 1; i < latlngs.length; i++) {
        const currentPoint = latlngs[i];
        let segmentStart = previousPoint;
        let segmentLength = toMeters(segmentStart, currentPoint);

        while (distanceSinceLastDot + segmentLength >= spacingMeters) {
            const remaining = spacingMeters - distanceSinceLastDot;
            const fraction = remaining / segmentLength;
            const nextDot = interpolatePoint(segmentStart, currentPoint, fraction);
            sampledPoints.push(nextDot);

            segmentStart = nextDot;
            segmentLength = toMeters(segmentStart, currentPoint);
            distanceSinceLastDot = 0;
        }

        distanceSinceLastDot += segmentLength;
        previousPoint = currentPoint;
    }

    const lastPoint = latlngs[latlngs.length - 1];
    const sampledLastPoint = sampledPoints[sampledPoints.length - 1];
    if (sampledLastPoint[0] !== lastPoint[0] || sampledLastPoint[1] !== lastPoint[1]) {
        sampledPoints.push(lastPoint);
    }

    for (const point of sampledPoints) {
        L.circleMarker(point, {
            pane: 'walkingDotsPane',
            color: '#2563eb',
            fillColor: '#2563eb',
            fillOpacity: 0.98,
            weight: 2,
            radius: 3,
            opacity: 0.98
        }).addTo(currentRouteLayer);
    }
}


// --- 3. BUS TRANSIT ROUTING ENGINE (RAPTOR) ---

async function fetchBusRoutingAPI(startGps, endGps, departureTimeStr, maxWalkMinutes) {
    const response = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startGps, endGps, departureTimeStr, maxWalkMinutes })
    });
    const result = await response.text();
    return JSON.parse(result);
}

function drawBusLineLeg(leg) {
    const { route, boardedAt, alightedAt } = leg;
    if (!route || !boardedAt || !alightedAt) return;

    const stopSequence = raptorIndex.routeStops[route];
    if (!stopSequence) return;

    const shapeEntry = shapeIndex[route];
    if (!shapeEntry || !shapeEntry.polyline) return;

    const allCoords = polyline.decode(shapeEntry.polyline); 
    const boardStopData = stopInfo[boardedAt];
    const alightStopData = stopInfo[alightedAt];

    let startShapeIdx = 0;
    let endShapeIdx = allCoords.length - 1;
    if (boardStopData) {
        startShapeIdx = findClosestVertexIndex(allCoords, boardStopData.lat, boardStopData.lng);
    }
    if (alightStopData) {
        endShapeIdx = findClosestVertexIndex(allCoords, alightStopData.lat, alightStopData.lng);
    }

    if (startShapeIdx > endShapeIdx) {
        const temp = startShapeIdx;
        startShapeIdx = endShapeIdx;
        endShapeIdx = temp;
    }
    const slicedCoords = allCoords.slice(startShapeIdx, endShapeIdx + 1);

    // Main Bus Route Line
    const busPolyline = L.polyline(slicedCoords, {
        color: '#2563eb', 
        weight: 6,
        opacity: 0.9
    }).addTo(currentRouteLayer);

    const boardName = boardStopData ? boardStopData.name_en : boardedAt;
    const alightName = alightStopData ? alightStopData.name_en : alightedAt;
    busPolyline.bindPopup(`Boarding at: ${boardName}<br>Alight at: ${alightName}`);

    // Station Checkpoint White Circles
    const circleStyle = { color: '#2563eb', fillColor: 'white', fillOpacity: 1, weight: 3, radius: 5 };
    L.circleMarker(slicedCoords[0], circleStyle).addTo(currentRouteLayer);
    L.circleMarker(slicedCoords[slicedCoords.length - 1], circleStyle).addTo(currentRouteLayer);

    // Floating Badge Label
    const baseRouteId = route.substring(0, route.lastIndexOf('_'));
    const routeName = (routeInfo[baseRouteId] && routeInfo[baseRouteId].name_en) ? routeInfo[baseRouteId].name_en : route;
    const midIndex = Math.floor(slicedCoords.length / 2);
    const midCoord = slicedCoords[midIndex];

    const labelIcon = L.divIcon({
        className: '', 
        html: `<div style="background: white; border: 2px solid #2563eb; color: #2563eb; padding: 2px 8px; border-radius: 12px; font-weight: bold; font-family: sans-serif; font-size: 12px; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3); transform: translate(-50%, -50%); display: inline-block;">${routeName}</div>`,
        iconSize: [0, 0] 
    });

    L.marker(midCoord, { icon: labelIcon }).addTo(currentRouteLayer);
}

async function handleBusRouting(startCoords, endCoords, departureTimeStr, maxWalkMinutes) {
    L.marker([endCoords.lat, endCoords.lng], { icon: redIcon })
        .addTo(currentRouteLayer)
        .bindPopup(`<b>Destination:</b><br>${endCoords.displayName}`);

    // Map geocode format {lat, lng} to RAPTOR engine format {lat, lon}
    const startGps = { lat: startCoords.lat, lon: startCoords.lng };
    const endGps = { lat: endCoords.lat, lon: endCoords.lng };

    const finalItinerary = await fetchBusRoutingAPI(startGps, endGps, departureTimeStr, maxWalkMinutes);
    console.log("Bus Itinerary:", finalItinerary);

    if (finalItinerary && finalItinerary.journey && finalItinerary.journey.length > 0) {
        // walk to first bus station
        let stopUID = finalItinerary.journey[0].boardedAt;
        let stopLat = stopInfo[stopUID].lat;
        let stopLon = stopInfo[stopUID].lng;
        await drawWalkingDotRoute(
            startCoords,
            { lat: stopLat, lng: stopLon, displayName: getStopName(stopUID) }
        );
        

        for (const leg of finalItinerary.journey) {
            drawBusLineLeg(leg);
        }

        // walk to destination
        stopUID = finalItinerary.journey[finalItinerary.journey.length - 1].alightedAt;
        stopLat = stopInfo[stopUID].lat;
        stopLon = stopInfo[stopUID].lng;
        await drawWalkingDotRoute(
            { lat: stopLat, lng: stopLon, displayName: getStopName(stopUID) },
            endCoords
        );
        return finalItinerary;

    } else {
        console.log("No valid bus routes found for this itinerary.");
    }
}


// --- 4. THE UNIFIED WRAPPER (MULTIPLEXER) ---

async function smartRoute(origin, destination, transportationMode, departureTimeStr, maxWalkMinutes = 12) {
    try {
        console.log(`--- Initiating Smart Route [Mode: ${transportationMode}] ---`);
        
        // 1. Wipe out any previous routes, labels, and markers
        currentRouteLayer.clearLayers();

        // 2. Geocode natural language text to structured coordinates
        const startCoords = await geocode(origin);
        const endCoords = await geocode(destination);

        if (!startCoords || !endCoords) {
            alert("Could not map one or both locations. Please try another name.");
            return;
        }

        // 3. Validate geographical boundaries for bus routing
        if (transportationMode === 'bus') {
            const originInside = isInsideKeelung(startCoords);
            const destinationInside = isInsideKeelung(endCoords);

            if (!originInside || !destinationInside) {

                let outsideLocations = [];

                if (!originInside) outsideLocations.push("starting location");
                if (!destinationInside) outsideLocations.push("destination");

                console.log("Route rejected: Location outside Keelung.");

                await centerMapOnUserLocation();
                return {
                    boundaryError: true,
                    message: `Sorry! Our bus routing service currently only supports locations within Keelung City. Your ${outsideLocations.join(" and ")} appears to be outside our supported area. Please choose another location within Keelung!`
                };
            }
        }

        // 4. Branching execution path based on mode selection
        let result = null;

        if (transportationMode === 'vehicle') {
            await handleVehicleRouting(startCoords, endCoords);
        } else if (transportationMode === 'bus') {
            result = await handleBusRouting(startCoords, endCoords, departureTimeStr, maxWalkMinutes);
        } else {
            console.error(`Unknown transportation mode: ${transportationMode}`);
            return;
        }

        // 5. Dynamic Camera Fitting: Bound perfectly around whatever shapes were generated
        const activeLayers = currentRouteLayer.getLayers();
        if (activeLayers.length > 0) {
            map.fitBounds(currentRouteLayer.getBounds(), { padding: [30, 30] });
        }

        //console.log("result :", result);
        return result;

    } catch (error) {
        console.error("Smart routing failed to complete execution:", error);
    }
}


// --- 5. INITIALIZATION & UI ---

// OpenStreetMap basic tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

function setupChatUI() {
    const messages = document.getElementById('messages');
    const input = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');

    requestAnimationFrame(() => {
        messages.classList.add('slide-up');
    });

    function appendMessage(kind, text, animate = false) {
        const el = document.createElement('div');
        el.className = 'message ' + (kind === 'user' ? 'user' : 'bot');

        messages.appendChild(el);
        messages.scrollTop = messages.scrollHeight;

        if (animate && kind === 'bot') {
            let i = 0;
            const speed = 12;

            const timer = setInterval(() => {
                if (i < text.length) {
                    i++;
                    el.innerHTML = DOMPurify.sanitize(
                        marked.parse(text.substring(0, i))
                    );
                    messages.scrollTop = messages.scrollHeight;
                } else {
                    clearInterval(timer);
                    el.innerHTML = DOMPurify.sanitize(
                        marked.parse(text)
                    );
                }
            }, speed);

        } else if (kind === 'bot') {
            el.innerHTML = DOMPurify.sanitize(marked.parse(text));
        } else {
            el.textContent = text;
        }
        messages.scrollTop = messages.scrollHeight;
    }

    async function sendMessage() {
        const text = input.value.trim();
        if (!text) return;

        const time = getCurrentTimeFormatted();
        const payload = {
            message: text,
            timestamp: time
        };

        // 1. Render the user's message instantly on-screen
        appendMessage('user', text);

        input.value = '';
        input.style.height = 'auto'; 
        sendBtn.classList.add('empty');
        input.focus();

        try {
            // 2. Fire the payload over to your local server router
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            
            //console.log(await response);

            // 3. Render the text reply directly from Gemini
            if (data.actionType === "ROUTE_DATA") {
                console.log(data.data.departureTimeStr);
                const baseTimeStr = data.data.departureTimeStr === "NOW" ? time : data.data.departureTimeStr;
                console.log("DEBUG: Base Departure Time:", baseTimeStr, "Delay:", data.data.delay);
                const totalMinutes = timeToMinutes(baseTimeStr) + (data.data.delay || 0);
                const adjustedDepartureTime = formatMinutesToTime(totalMinutes);

                const result = await smartRoute(
                    data.data.origin,
                    data.data.destination,
                    data.data.transportationMode,
                    adjustedDepartureTime,
                    data.data.maxWalkMinutes || 12,
                );
                
                //console.log("DEBUG: Result from smartRoute:", result);

                if(result) {
                    if (result.boundaryError){
                        appendMessage('bot', result.message, true);
                    }
                    else{
                        const humanMessage = generateRouteSummary(result);
                        appendMessage('bot', humanMessage, true);
                    }
                }

            } else if (data.reply) {
                appendMessage('bot', data.reply, true);
            } else if (data.error) {
                appendMessage('bot', `System Error: ${data.error}`, true);
            } else {
                appendMessage('bot', "I connected to the server, but got an empty response.", true);
            }

        } catch (error) {
            console.error("Chat Pipeline Error:", error);
            appendMessage('bot', "Couldn't reach the server. Is the backend running?", true);
        }
    }

    appendMessage('bot',"Hello! How may I help you today?",true);

    sendBtn.addEventListener('click', sendMessage);

    input.addEventListener('input', () => {
        if (input.value.trim().length > 0) {
            sendBtn.classList.remove('empty');
        } else {
            sendBtn.classList.add('empty');
        }
    });
    if (!input.value.trim()) {
        sendBtn.classList.add('empty');
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}

async function init() {
    await loadData();
    setupChatUI();

    // Setup initial camera viewpoint anchor
    await centerMapOnUserLocation();
}

document.addEventListener('DOMContentLoaded', init);