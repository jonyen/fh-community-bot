// Logs in to the CREA Rent Manager tenant portal and stops. Creates nothing.
// Confirms the credentials and that login from this machine works.
//
//   doppler run -- node scripts/crea-twa-login-check.mjs
//   (or in CI: gh workflow run crea-login-check)
import { createRentManagerTwaService } from "../src/services/rentManagerTwa.js";

const { CREA_TWA_USERNAME, CREA_TWA_PASSWORD, CREA_TWA_URL } = process.env;
if (!CREA_TWA_USERNAME || !CREA_TWA_PASSWORD) {
  console.error("Set CREA_TWA_USERNAME and CREA_TWA_PASSWORD");
  process.exit(1);
}

const twa = createRentManagerTwaService({
  ...(CREA_TWA_URL ? { baseUrl: CREA_TWA_URL } : {}),
  username: CREA_TWA_USERNAME,
  password: CREA_TWA_PASSWORD,
  phone: "unused",
});

try {
  await twa.login();
  console.log("Login OK");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
