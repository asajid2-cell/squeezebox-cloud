import "@testing-library/jest-dom/vitest";

// Admin auth now requires an explicit password (no insecure default). Tests log in with "admin".
process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD = process.env.CLOUD_SQUEEZE_ADMIN_PASSWORD || "admin";

