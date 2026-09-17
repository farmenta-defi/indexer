import { Hono } from "hono";

// Ponder serves /health, /ready and /status itself. /status carries the last indexed block
// and its timestamp per chain, which is what the lag watchdog reads (FAR-36). Query routes
// arrive with the tables (FAR-34, FAR-35).
const app = new Hono();

export default app;
