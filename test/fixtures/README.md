# Real logs

`position-<tokenId>.json` holds every PositionManager `Transfer` and PoolManager
`ModifyLiquidity` log of one fixture position (spec §14, §18), from its mint up to block
54,200,000 on Robinhood Chain (4663). That block is `ForkTest.FORK_BLOCK` in the
`smart-contract` repo, whose `test/fork/PositionFixtures.t.sol` asserts the same positions
against `getPoolAndPositionInfo` and `getPositionLiquidity`.

Fetched on 17 Sep 2026 with `eth_getLogs` from the official RPC: `Transfer` filtered on the
tokenId topic, `ModifyLiquidity` on `sender = PositionManager` and then on `salt`, which is
not indexed. `timestamp` is the block's, added from `eth_getBlockByNumber`. Nothing is edited.
