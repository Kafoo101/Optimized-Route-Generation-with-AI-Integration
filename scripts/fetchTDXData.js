const CLIENT_ID = process.env.TDX_ID;
const CLIENT_SECRET = process.env.TDX_SECRET;

const AUTH_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const DAILY_ETA_API = "https://tdx.transportdata.tw/api/basic/v2/Bus/DailyTimeTable/City/Keelung?$format=JSON";

// TOKEN CACHE
let cachedToken = null;
let tokenExpireTime = 0;

// GET ACCESS TOKEN
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpireTime) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await res.json();

  cachedToken = data.access_token;
  tokenExpireTime = Date.now() + (data.expires_in - 60) * 1000;

  return cachedToken;
}

// Fetch Daily ETA data
async function fetchDailyETA() {
  const token = await getAccessToken();

  const res = await fetch(DAILY_ETA_API, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return await res.json();
}

module.exports = { fetchDailyETA };