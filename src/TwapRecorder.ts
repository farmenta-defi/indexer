import { ponder } from "ponder:registry";

import { onRecorded } from "./handlers/twapRecorder.ts";

ponder.on("TwapRecorder:Recorded", ({ event, context }) => onRecorded(context.db, event));
