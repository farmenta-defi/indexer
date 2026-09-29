import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { before, describe, it } from "node:test";

// Runs the limiter of the installed Ponder, where test/ponderPatch.test.ts reads its constants
// as text (FAR-84). A limiter that declares a floor of 15 and lowers the limit with another
// number passes there and fails here.
//
// Ponder's own createRpc sends requests to a local JSON-RPC server that answers 429 to every
// third one, until the limit has been lowered LOWERINGS times. Ponder logs the limit, rounded
// down, each time it lowers it.

const LOWERINGS = 12;
const FLOOR_RPS = 15;

type Logged = { msg: string; rps_limit?: number };
type Rpc = { request: (body: { method: string }) => Promise<unknown> };

const lowered: number[] = [];

before(async () => {
  const { createRpc } = (await import(new URL("../node_modules/ponder/dist/esm/rpc/index.js", import.meta.url).href)) as {
    createRpc: (options: unknown) => Rpc;
  };

  let seen = 0;
  let refusing = true;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen += 1;
      if (refusing && seen % 3 === 0) {
        response.writeHead(429).end("Too Many Requests");
        return;
      }
      const { id } = JSON.parse(body) as { id: number };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const nothing = () => {};
  const stops: (() => unknown)[] = [];
  const common = {
    logger: {
      trace: nothing,
      info: nothing,
      warn: nothing,
      error: nothing,
      debug: (logged: Logged) => {
        if (logged.msg === "JSON-RPC provider rate limited" && logged.rps_limit !== undefined) lowered.push(logged.rps_limit);
      },
    },
    metrics: new Proxy({}, { get: () => ({ observe: nothing, inc: nothing }) }),
    shutdown: { add: (stop: () => unknown) => stops.push(stop) },
  };
  const rpc = createRpc({
    common,
    chain: { name: "local", id: 4663, rpc: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    concurrency: 25,
  });

  let running = true;
  const callers = Array.from({ length: 40 }, async () => {
    while (running) await rpc.request({ method: "eth_chainId" }).catch(nothing);
  });

  const deadline = Date.now() + 60_000;
  while (lowered.length < LOWERINGS && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));

  refusing = false;
  running = false;
  await Promise.all(callers);
  for (const stop of stops) await stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("limiter of the installed Ponder", () => {
  describe("positive", () => {
    it("lowers the limit by 5% on a 429, from the initial 20", () => {
      assert.ok(lowered.length >= LOWERINGS, `lowered ${lowered.length} times in 60 seconds`);
      assert.deepEqual(lowered.slice(0, 4), [19, 18, 17, 16]);
    });
  });

  describe("negative", () => {
    it(`never lowers it below ${FLOOR_RPS}`, () => {
      assert.equal(Math.min(...lowered), FLOOR_RPS);
    });
  });

  describe("edge case", () => {
    it("keeps it at the floor on every 429 that comes after the floor was reached", () => {
      assert.deepEqual([...new Set(lowered.slice(4))], [FLOOR_RPS]);
    });
  });
});
