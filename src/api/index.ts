import { db } from "ponder:api";
import schema from "ponder:schema";
import { graphql } from "ponder";

import { createApp } from "./app.ts";

// Ponder serves /health, /ready and /status itself. /status carries the last indexed block
// and its timestamp per chain, which is what the lag watchdog reads (FAR-36).
const app = createApp(db, schema);

// Every table, as stored.
app.use("/graphql", graphql({ db, schema }));

export default app;
