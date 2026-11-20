require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { get } = require("@vercel/blob");

const { verifyRecency, buildAndSaveMemoryIndex } = require("./buildDailyGraph");

// ==========================================
// 1. GLOBAL MEMORY (State)
// ==========================================
// These hold the pre-indexed data in RAM for instant O(1) lookups.
let routeStops = {}; 
let routeTrips = {}; 
let stopRoutes = {}; 
let engineReady = false;
let lastLoadedAt = 0;
let initPromise = null;

const MAX_TRANSFERS = 3;
const INDEX_BLOB_PATH = "raptorIndex.json";
const INDEX_REFRESH_INTERVAL = 5 * 60 * 1000;

// ==========================================
// 2. INITIALIZATION (Runs once on startup)
// ==========================================


async function initEngine() {
    if (initPromise) {
        return await initPromise;
    }

    initPromise = (async function () {
        try {
            console.log("Loading RAPTOR index...");

            let masterIndex;

            if (process.env.BLOB_READ_WRITE_TOKEN) {
                console.log("Using private Vercel Blob storage...");

                // STEP 1: Retrieve the current manifest.
                const manifestResult = await get("current.json", {
                    access: "private",
                    useCache: false
                });

                if (
                    !manifestResult ||
                    manifestResult.statusCode !== 200 ||
                    !manifestResult.stream
                ) {
                    throw new Error("Could not retrieve current.json manifest.");
                }

                const manifestText = await new Response(
                    manifestResult.stream
                ).text();

                const manifest = JSON.parse(manifestText);

                // STEP 2: Validate the manifest.
                if (
                    !manifest ||
                    typeof manifest.indexPath !== "string" ||
                    !manifest.indexPath.startsWith("snapshots/") ||
                    !manifest.indexPath.endsWith("-raptorIndex.json")
                ) {
                    throw new Error("Invalid or unsafe RAPTOR manifest.");
                }

                console.log("Loading snapshot version:", manifest.version);

                // STEP 3: Retrieve the versioned RAPTOR index.
                const result = await get(manifest.indexPath, {
                    access: "private",
                    useCache: false
                });

                if (!result || result.statusCode !== 200 || !result.stream) {
                    throw new Error("Could not retrieve RAPTOR snapshot.");
                }

                const jsonText = await new Response(result.stream).text();
                masterIndex = JSON.parse(jsonText);
            }
            else {
                console.log("Using local filesystem...");

                const indexPath = path.join(
                    __dirname,
                    "..",
                    "processed",
                    "raptorIndex.json"
                );

                if (!fs.existsSync(indexPath) || !(await verifyRecency())) {
                    buildAndSaveMemoryIndex();
                    console.log("Local data update complete.");
                }

                masterIndex = JSON.parse(
                    fs.readFileSync(indexPath, "utf8")
                );
            }

            // STEP 4: Validate the actual RAPTOR index.
            if (
                !masterIndex ||
                !masterIndex.routeStops ||
                !masterIndex.routeTrips ||
                !masterIndex.stopRoutes
            ) {
                throw new Error("Invalid RAPTOR index structure.");
            }

            // Replace memory only after successful loading and validation.
            routeStops = masterIndex.routeStops;
            routeTrips = masterIndex.routeTrips;
            stopRoutes = masterIndex.stopRoutes;

            engineReady = true;
            lastLoadedAt = Date.now();

            console.log("RAPTOR Engine Online.");
            console.log("Indexed routes:", Object.keys(routeTrips).length);

            return true;
        }
        catch (error) {
            console.error("RAPTOR initialization failed:", error);
            return engineReady;
        }
        finally {
            initPromise = null;
        }
    })();

    return await initPromise;
}

// ==========================================
// 3. CORE ALGORITHM (The Math)
// ==========================================
/**
 * @param {Object} walkableOrigins - e.g., { "StopA": 480, "StopB": 485 } (StopUID -> minutes past midnight)
 * @param {string} destinationStops - e.g., "StopZ"
 */
function runRAPTOR(walkableOrigins, destinationStops) {
    const targetDestinations = Array.isArray(destinationStops) ? new Set(destinationStops) : new Set([destinationStops]);
    
    const earliestArrival = Array.from({ length: MAX_TRANSFERS + 1 }, () => new Map());
    const journeyState = Array.from({ length: MAX_TRANSFERS + 1 }, () => new Map());
    
    const bestArrival = new Map();
    const bestEffort = new Map(); // NEW: Tracks the effort (walk time) to break ties

    // Load Round 0 (Walk to starting stops)
    let markedStops = new Set();
    for (const [stopUID, time] of Object.entries(walkableOrigins)) {
        earliestArrival[0].set(stopUID, time);
        bestArrival.set(stopUID, time);
        bestEffort.set(stopUID, time); // Initial effort is the starting walk time
        markedStops.add(stopUID);
    }

    for (let k = 1; k <= MAX_TRANSFERS; k++) {
        
        for (const [stop, time] of earliestArrival[k - 1].entries()) {
            earliestArrival[k].set(stop, time);
        }

        const Q = new Map(); 

        for (const stop of markedStops) {
            const routesPassingThrough = stopRoutes[stop] || [];
            
            for (const routeKey of routesPassingThrough) {
                const stopsOnRoute = routeStops[routeKey];
                const stopIndex = stopsOnRoute.indexOf(stop);

                if (!Q.has(routeKey) || stopIndex < Q.get(routeKey).index) {
                    Q.set(routeKey, { index: stopIndex, stopUID: stop });
                }
            }
        }

        markedStops.clear(); 

        for (const [routeKey, boardPoint] of Q.entries()) {
            
            let activeTrip = null;
            let boardStop = null;
            let boardTime = null; 
            let boardEffort = null; // NEW: Tracks the effort used to catch this specific bus
            
            const stopsOnRoute = routeStops[routeKey];
            const tripsOnRoute = routeTrips[routeKey];

            for (let i = boardPoint.index; i < stopsOnRoute.length; i++) {
                const currentStop = stopsOnRoute[i];
                
                // Step A: ALIGHTING TIE-BREAKER
                if (activeTrip !== null) {
                    const arrivalAtStop = activeTrip.schedule[i].arr;
                    const currentBestTime = bestArrival.get(currentStop) ?? Infinity;
                    const currentBestEffort = bestEffort.get(currentStop) ?? Infinity;

                    // Update if it's faster OR if it's a tie but required less walk effort
                    const isFaster = arrivalAtStop < currentBestTime;
                    const isTieButLessEffort = (arrivalAtStop === currentBestTime) && (boardEffort < currentBestEffort);

                    if (isFaster || isTieButLessEffort) {
                        earliestArrival[k].set(currentStop, arrivalAtStop);
                        bestArrival.set(currentStop, arrivalAtStop);
                        bestEffort.set(currentStop, boardEffort); // Save the effort that won the tie
                        markedStops.add(currentStop);
                        
                        journeyState[k].set(currentStop, {
                            route: routeKey,
                            tripId: activeTrip.tripId,
                            boardedAt: boardStop,
                            boardTime: boardTime, 
                            alightedAt: currentStop,
                            time: arrivalAtStop
                        });
                    }
                }

                // Step B: BOARDING TIE-BREAKER
                if (earliestArrival[k - 1].has(currentStop)) {
                    const myArrivalTime = earliestArrival[k - 1].get(currentStop);
                    
                    for (const trip of tripsOnRoute) {
                        const tripDeparture = trip.schedule[i].dep;
                        
                        if (tripDeparture >= myArrivalTime) {
                            const currentTripIndex = tripsOnRoute.indexOf(trip);
                            const activeTripIndex = activeTrip ? tripsOnRoute.indexOf(activeTrip) : Infinity;
                            
                            let shouldBoard = currentTripIndex < activeTripIndex;
                            
                            // NEW: If it's the exact same bus trip, but we reached this stop with less walking effort, 
                            // overwrite the boarding location!
                            if (currentTripIndex === activeTripIndex && myArrivalTime < boardEffort) {
                                shouldBoard = true;
                            }
                            
                            if (shouldBoard) {
                                activeTrip = trip;
                                boardStop = currentStop;
                                boardTime = tripDeparture; 
                                boardEffort = myArrivalTime; // Update running effort
                            }
                            break; 
                        }
                    }
                }
            }
        }

        if (markedStops.size === 0) break;
    }

    // (Keep the existing CHOOSE THE BEST SURVIVING DESTINATION block exactly the same)
    const validJourneys = [];

    for (const destStop of targetDestinations) {
        const absoluteBestTime = bestArrival.get(destStop);
        
        if (absoluteBestTime !== undefined && absoluteBestTime !== Infinity) {
            const pathSequence = buildPathSequence(destStop, earliestArrival, journeyState);
            
            validJourneys.push({
                origin: pathSequence.length > 0 ? pathSequence[0].boardedAt : null,
                destination: destStop,
                arrivalTime: absoluteBestTime,
                journey: pathSequence
            });
        }
    }

    return validJourneys.sort((a, b) => a.arrivalTime - b.arrivalTime);
}

// ==========================================
// PATH RECONSTRUCTION (Deterministic Loop-Free)
// ==========================================
function buildPathSequence(destinationStop, earliestArrival, journeyState) {
    // 1. Determine which round yielded the absolute fastest arrival time at destination
    let bestK = -1;
    let minTime = Infinity;

    for (let k = 1; k <= MAX_TRANSFERS; k++) {
        if (earliestArrival[k] && earliestArrival[k].has(destinationStop)) {
            const time = earliestArrival[k].get(destinationStop);
            if (time < minTime) {
                minTime = time;
                bestK = k;
            }
        }
    }

    // Destination was never reached
    if (bestK === -1) return [];

    const path = [];
    let currentStop = destinationStop;
    let currentK = bestK;

    // 2. Trace backward through the timeline layers
    while (currentK > 0 && journeyState[currentK].has(currentStop)) {
        const step = journeyState[currentK].get(currentStop);
        
        path.unshift({
            route: step.route,
            tripId: step.tripId,
            boardedAt: step.boardedAt,
            boardTime: minutesToTime(step.boardTime), // <-- NEW: Formatted beautifully for the UI
            alightedAt: step.alightedAt,
            arrivalTime: minutesToTime(step.time)
        });
        
        // Jump backward to the stop where we caught this bus
        currentStop = step.boardedAt;
        
        // Drop down to the previous round layer to find out how we got to that boarding stop
        currentK--;
    }

    return path;
}

// Helper: Converts 330 -> "05:30"
function minutesToTime(minutes) {
    if (minutes === null || minutes === undefined) return null;
    const h = Math.floor(minutes / 60).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
}

// ==========================================
// 5. PUBLIC API (The Wrapper)
// ==========================================
async function findRoute(walkableOrigins, destinationStop) {
    const indexIsStale =
        Date.now() - lastLoadedAt >= INDEX_REFRESH_INTERVAL;

    if (!engineReady || indexIsStale) {
        const success = await initEngine();

        if (!success) {
            return { error: "Engine failed to initialize." };
        }
    }

    return runRAPTOR(walkableOrigins, destinationStop);
}

// Export for use in your main server/API file
module.exports = { initEngine, findRoute };

// ==========================================
// CLI TESTER
// ==========================================
async function main()
{
    await initEngine();

    const testOrigins = {
        "KEE306429": 480,
        "KEE306430": 485
    };

    const testDestination = "KEE309534";

    const result = await findRoute(testOrigins, testDestination);
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch(console.error);
}