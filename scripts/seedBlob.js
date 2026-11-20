require("dotenv").config();

const { put, get } = require("@vercel/blob");
const { fetchDailyETA } = require("./fetchTDXData");
const { buildMemoryIndex } = require("./buildDailyGraph");

const RAW_PATH = "dailySchedule.json";
const INDEX_PATH = "raptorIndex.json";

async function verifyBlob(pathname) {
    const result = await get(pathname, {
        access: "private",
        useCache: false
    });

    if (!result || result.statusCode !== 200 || !result.stream) {
        throw new Error(`Could not retrieve ${pathname} from Blob.`);
    }

    const content = await new Response(result.stream).text();

    // Confirm that the uploaded content is valid JSON.
    JSON.parse(content);

    console.log(`Verified ${pathname} (${content.length} characters).`);
}

async function seedBlob() {
    try {
        if (!process.env.BLOB_READ_WRITE_TOKEN) {
            throw new Error("BLOB_READ_WRITE_TOKEN is missing from .env");
        }

        console.log("Fetching latest Keelung timetable from TDX...");

        const rawData = await fetchDailyETA();

        if (!Array.isArray(rawData) || rawData.length === 0) {
            throw new Error("TDX returned empty or invalid timetable data.");
        }

        console.log(`Received ${rawData.length} timetable records.`);

        console.log("Building RAPTOR index...");

        const masterIndex = buildMemoryIndex(rawData);

        const routeCount = Object.keys(masterIndex.routeTrips).length;

        if (
            routeCount === 0 ||
            Object.keys(masterIndex.routeStops).length === 0 ||
            Object.keys(masterIndex.stopRoutes).length === 0
        ) {
            throw new Error("Generated RAPTOR index is empty or invalid.");
        }

        const rawJSON = JSON.stringify(rawData);
        const indexJSON = JSON.stringify(masterIndex);

        console.log(`Generated index for ${routeCount} routes.`);

        console.log("Uploading dailySchedule.json...");

        await put(RAW_PATH, rawJSON, {
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: "application/json"
        });

        console.log("Uploading raptorIndex.json...");

        await put(INDEX_PATH, indexJSON, {
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: "application/json"
        });

        console.log("Verifying uploaded files...");

        await verifyBlob(RAW_PATH);
        await verifyBlob(INDEX_PATH);

        console.log("--------------------------------");
        console.log("INITIAL BLOB POPULATION SUCCESSFUL");
        console.log(`Timetable records: ${rawData.length}`);
        console.log(`RAPTOR routes: ${routeCount}`);
        console.log("--------------------------------");
    }
    catch (error) {
        console.error("BLOB SEEDING FAILED:", error.message);
        process.exitCode = 1;
    }
}

seedBlob();