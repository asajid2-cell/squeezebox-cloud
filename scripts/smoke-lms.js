import { LmsClient } from "../server/lmsClient.js";

const client = new LmsClient({ timeoutMs: 1500 });

try {
  const status = await client.status();
  const spotify = await client.spotifyStatus();
  console.log("LMS smoke:", JSON.stringify({ status, spotify }, null, 2));
  if (!status.online) process.exit(1);
} catch (error) {
  console.log(`LMS smoke skipped/unavailable: ${error.message}`);
}

