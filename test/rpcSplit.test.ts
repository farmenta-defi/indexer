import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitRequest, type SplitCounts } from "../config/rpc.ts";

type Call = { method: string; params?: unknown };

function recorder(answer: (call: Call) => unknown) {
  const calls: string[] = [];
  const request = async (call: Call) => {
    calls.push(call.method);
    return answer(call);
  };
  return { calls, request };
}

const BLOCK = { number: "0x10", hash: "0xabc" };

function setup(freeAnswer: (call: Call) => unknown) {
  const counts: SplitCounts = { free: 0, fallback: 0, paid: 0 };
  const paid = recorder(() => "paid");
  const free = recorder(freeAnswer);
  return { counts, paid, free, request: splitRequest(paid.request, free.request, counts) };
}

describe("splitRequest", () => {
  it("answers block reads from the free RPC", async () => {
    const { counts, paid, free, request } = setup(() => BLOCK);
    assert.deepEqual(await request({ method: "eth_getBlockByNumber", params: ["0x10", true] }), BLOCK);
    assert.deepEqual(await request({ method: "eth_getBlockByHash", params: ["0xabc", true] }), BLOCK);
    assert.deepEqual(free.calls, ["eth_getBlockByNumber", "eth_getBlockByHash"]);
    assert.deepEqual(paid.calls, []);
    assert.deepEqual(counts, { free: 2, fallback: 0, paid: 0 });
  });

  it("sends everything else to the paid RPC only", async () => {
    const { counts, paid, free, request } = setup(() => BLOCK);
    assert.equal(await request({ method: "eth_getLogs", params: [{ blockHash: "0xabc" }] }), "paid");
    assert.equal(await request({ method: "eth_chainId" }), "paid");
    assert.deepEqual(free.calls, []);
    assert.deepEqual(paid.calls, ["eth_getLogs", "eth_chainId"]);
    assert.deepEqual(counts, { free: 0, fallback: 0, paid: 2 });
  });

  it("falls back to the paid RPC when the free one fails", async () => {
    const { counts, paid, request } = setup(() => {
      throw new Error("429 Too Many Requests");
    });
    assert.equal(await request({ method: "eth_getBlockByNumber", params: ["latest", true] }), "paid");
    assert.deepEqual(paid.calls, ["eth_getBlockByNumber"]);
    assert.deepEqual(counts, { free: 0, fallback: 1, paid: 1 });
  });

  it("falls back to the paid RPC when the free one has not seen the block", async () => {
    const { counts, paid, request } = setup(() => null);
    assert.equal(await request({ method: "eth_getBlockByNumber", params: ["0x99", true] }), "paid");
    assert.deepEqual(paid.calls, ["eth_getBlockByNumber"]);
    assert.deepEqual(counts, { free: 0, fallback: 1, paid: 1 });
  });

  it("passes the paid RPC's error through", async () => {
    const counts: SplitCounts = { free: 0, fallback: 0, paid: 0 };
    const request = splitRequest(
      async () => {
        throw new Error("paid down");
      },
      async () => {
        throw new Error("free down");
      },
      counts,
    );
    await assert.rejects(request({ method: "eth_getBlockByNumber", params: ["0x1", true] }), /paid down/);
  });
});
