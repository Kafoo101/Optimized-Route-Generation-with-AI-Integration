const fs = require("fs");
const path = require("path");
const { fetchDailyETA } = require("./fetchTDXData");

// ==========================================
// CONFIGURATION
// ==========================================
const PROCESSED_DIR = path.join(__dirname, "..", "processed");

const INPUT_FILE = path.join(PROCESSED_DIR, "dailySchedule.json");
const OUTPUT_FILE = path.join(PROCESSED_DIR, "raptorIndex.json");

if (!fs.existsSync(PROCESSED_DIR)) {
    fs.mkdirSync(PROCESSED_DIR, { recursive: true });
}

// ==========================================
// TIME CONVERSION
// ==========================================
function timeToMinutes(timeString) {
    if (!timeString) return null;

    let [hours, minutes] = timeString.split(":").map(Number);

    if (hours < 2) {
        hours += 24;
    }

    return (hours * 60) + minutes;
}

// ==========================================
// 1. RECENCY CHECK (LOCAL DEVELOPMENT)
// ==========================================
async function verifyRecency() {
    if (!fs.existsSync(OUTPUT_FILE)) {
        return false;
    }

    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));

    if (!data.timeStamp || !data.timeStamp.lastUpdated) {
        return false;
    }

    const lastUpdated = new Date(data.timeStamp.lastUpdated);
    const today = new Date();

    if (
        !Number.isNaN(lastUpdated.getTime()) &&
        lastUpdated.toDateString() === today.toDateString()
    ) {
        console.log("Data is up to date, proceeding...");
        return true;
    }

    console.log("Data is not up to date, fetching latest TDX data...");

    const result = await fetchDailyETA();

    if (!Array.isArray(result) || result.length === 0) {
        throw new Error("TDX returned empty or invalid timetable data.");
    }

    fs.writeFileSync(
        INPUT_FILE,
        JSON.stringify(result, null, 2),
        "utf8"
    );

    return false;
}

// ==========================================
// 2. PURE RAPTOR INDEX BUILDER
// ==========================================
// Accepts raw TDX data and returns the RAPTOR index.
// Does NOT read or write any files.
function buildMemoryIndex(rawData) {
    if (!Array.isArray(rawData) || rawData.length === 0) {
        throw new Error("Cannot build RAPTOR index: raw timetable data is empty.");
    }

    console.log("Starting unified daily RAPTOR index build...");

    const timeStamp = {};
    const routeStops = {};
    const routeTrips = {};
    const stopRoutes = {};

    timeStamp.lastUpdated = rawData[0].BusDate;

    for (const route of rawData) {
        if (!route.Timetables || route.Timetables.length === 0) {
            continue;
        }

        const routeKey =
            `${route.RouteUID}_${route.SubRouteUID}_${route.Direction}`;

        routeTrips[routeKey] = [];

        for (const trip of route.Timetables) {
            if (!trip.StopTimes || trip.StopTimes.length === 0) {
                continue;
            }

            const sortedStops = [...trip.StopTimes].sort(
                (a, b) => a.StopSequence - b.StopSequence
            );

            const schedule = [];

            for (const stop of sortedStops) {
                const stopUID = stop.StopUID;

                schedule.push({
                    seq: stop.StopSequence,
                    stop: stopUID,
                    arr: timeToMinutes(stop.ArrivalTime),
                    dep: timeToMinutes(stop.DepartureTime)
                });

                if (!stopRoutes[stopUID]) {
                    stopRoutes[stopUID] = [];
                }

                if (!stopRoutes[stopUID].includes(routeKey)) {
                    stopRoutes[stopUID].push(routeKey);
                }
            }

            routeTrips[routeKey].push({
                tripId: trip.TripID,
                schedule: schedule
            });

            if (!routeStops[routeKey]) {
                routeStops[routeKey] = schedule.map(s => s.stop);
            }
        }
    }

    const masterIndex = {
        timeStamp,
        routeStops,
        routeTrips,
        stopRoutes
    };

    console.log("Successfully generated RAPTOR index in memory.");

    return masterIndex;
}

// ==========================================
// 3. LOCAL FILE BUILDER
// ==========================================
// Retained for local development.
// Vercel Blob integration will use buildMemoryIndex()
// directly instead of this function.
function buildAndSaveMemoryIndex() {
    if (!fs.existsSync(INPUT_FILE)) {
        throw new Error(`Raw TDX file missing at: ${INPUT_FILE}`);
    }

    const rawData = JSON.parse(
        fs.readFileSync(INPUT_FILE, "utf8")
    );

    const masterIndex = buildMemoryIndex(rawData);

    fs.writeFileSync(
        OUTPUT_FILE,
        JSON.stringify(masterIndex, null, 2),
        "utf8"
    );

    console.log(
        `Successfully saved RAPTOR index at: ${OUTPUT_FILE}`
    );

    return masterIndex;
}

// ==========================================
// EXPORTS
// ==========================================
module.exports = {
    verifyRecency,
    buildMemoryIndex,
    buildAndSaveMemoryIndex
};