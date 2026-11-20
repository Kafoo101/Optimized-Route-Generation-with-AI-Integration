
require("dotenv").config();

const { put, get } = require("@vercel/blob");
const { fetchDailyETA } = require("./fetchTDXData");
const { buildMemoryIndex } = require("./buildDailyGraph");

async function verifyBlob(pathname) {
    const result = await get(pathname, {
        access: "private",
        useCache: false
    });

    if (!result || result.statusCode !== 200 || !result.stream) {
        throw new Error("Blob verification failed: " + pathname);
    }

    const content = await new Response(result.stream).text();

    return JSON.parse(content);
}

async function updateDailyData() {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
        throw new Error("BLOB_READ_WRITE_TOKEN is missing.");
    }

    console.log("Fetching latest TDX timetable...");

    const rawData = await fetchDailyETA();

    if (!Array.isArray(rawData) || rawData.length === 0) {
        throw new Error("TDX returned empty or invalid data.");
    }

    console.log("Building RAPTOR index...");

    const masterIndex = buildMemoryIndex(rawData);

    const routeCount = Object.keys(masterIndex.routeTrips).length;

    if (
        routeCount === 0 ||
        Object.keys(masterIndex.routeStops).length === 0 ||
        Object.keys(masterIndex.stopRoutes).length === 0
    ) {
        throw new Error("Generated RAPTOR index is invalid.");
    }

    const version = Date.now().toString();

    const rawPath = `snapshots/${version}-dailySchedule.json`;
    const indexPath = `snapshots/${version}-raptorIndex.json`;

    console.log("Uploading new timetable snapshot...");

    await put(rawPath, JSON.stringify(rawData), {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/json"
    });

    console.log("Uploading new RAPTOR index snapshot...");

    await put(indexPath, JSON.stringify(masterIndex), {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/json"
    });

    console.log("Verifying both snapshots...");

    const verifiedRaw = await verifyBlob(rawPath);
    const verifiedIndex = await verifyBlob(indexPath);

    if (
        !Array.isArray(verifiedRaw) ||
        !verifiedIndex.routeTrips ||
        Object.keys(verifiedIndex.routeTrips).length !== routeCount
    ) {
        throw new Error("Uploaded snapshots failed validation.");
    }

    // Publish the new version only after both files are verified.
    const manifest = {
        version: version,
        updatedAt: new Date().toISOString(),
        busDate: masterIndex.timeStamp.lastUpdated,
        rawPath: rawPath,
        indexPath: indexPath,
        recordCount: rawData.length,
        routeCount: routeCount
    };

    console.log("Publishing current manifest...");

    await put("current.json", JSON.stringify(manifest), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json"
    });

    // Confirm that the published manifest points to this update.
    const publishedManifest = await verifyBlob("current.json");

    if (publishedManifest.version !== version) {
        throw new Error("Manifest verification failed.");
    }

    console.log("--------------------------------");
    console.log("DAILY DATA UPDATE SUCCESSFUL");
    console.log("Version:", version);
    console.log("Timetable records:", rawData.length);
    console.log("RAPTOR routes:", routeCount);
    console.log("--------------------------------");

    return manifest;
}

module.exports = { updateDailyData };

// Allow manual local execution.
if (require.main === module) {
    updateDailyData().catch(function (error) {
        console.error("DAILY UPDATE FAILED:", error);
        process.exitCode = 1;
    });
}