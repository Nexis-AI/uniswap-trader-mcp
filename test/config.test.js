const test = require("node:test");
const assert = require("node:assert/strict");

// index.js loads chainConfigs.js which requires INFURA_KEY at import time
process.env.INFURA_KEY = process.env.INFURA_KEY || "test";

const { getSafeAddressForChain, parseSafeAddressesJson, getGuardrails } = require("../index.js");

function withEnv(tempEnv, fn) {
  const original = {};
  for (const key of Object.keys(tempEnv)) {
    original[key] = process.env[key];
    if (tempEnv[key] === undefined) delete process.env[key];
    else process.env[key] = tempEnv[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(tempEnv)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

test("parseSafeAddressesJson returns null for empty", () => {
  assert.equal(parseSafeAddressesJson(""), null);
  assert.equal(parseSafeAddressesJson(undefined), null);
});

test("parseSafeAddressesJson validates JSON object", () => {
  assert.throws(() => parseSafeAddressesJson("[]"), /must be a JSON object/i);
  assert.throws(() => parseSafeAddressesJson("{"), /Failed to parse SAFE_ADDRESSES_JSON/i);
});

test("getSafeAddressForChain prefers SAFE_ADDRESS_<chainId>", () => {
  withEnv(
    {
      SAFE_ADDRESS: "0x0000000000000000000000000000000000000002",
      SAFE_ADDRESSES_JSON: "{\"1\":\"0x0000000000000000000000000000000000000003\"}",
      SAFE_ADDRESS_1: "0x0000000000000000000000000000000000000001",
    },
    () => {
      assert.equal(getSafeAddressForChain(1), "0x0000000000000000000000000000000000000001");
    }
  );
});

test("getSafeAddressForChain falls back to SAFE_ADDRESSES_JSON", () => {
  withEnv(
    {
      SAFE_ADDRESS: "0x0000000000000000000000000000000000000002",
      SAFE_ADDRESSES_JSON: "{\"1\":\"0x0000000000000000000000000000000000000003\"}",
      SAFE_ADDRESS_1: undefined,
    },
    () => {
      assert.equal(getSafeAddressForChain(1), "0x0000000000000000000000000000000000000003");
    }
  );
});

test("getSafeAddressForChain falls back to SAFE_ADDRESS", () => {
  withEnv(
    {
      SAFE_ADDRESS: "0x0000000000000000000000000000000000000002",
      SAFE_ADDRESSES_JSON: undefined,
      SAFE_ADDRESS_1: undefined,
    },
    () => {
      assert.equal(getSafeAddressForChain(1), "0x0000000000000000000000000000000000000002");
    }
  );
});

test("getSafeAddressForChain throws when missing", () => {
  withEnv(
    {
      SAFE_ADDRESS: undefined,
      SAFE_ADDRESSES_JSON: undefined,
      SAFE_ADDRESS_1: undefined,
    },
    () => {
      assert.throws(() => getSafeAddressForChain(1), /Missing Safe address/i);
    }
  );
});

test("getGuardrails defaults and validation", () => {
  withEnv(
    {
      UNISWAP_MAX_SLIPPAGE_PCT: undefined,
      UNISWAP_MAX_DEADLINE_MINUTES: undefined,
      UNISWAP_REQUIRE_ZERO_RESET_APPROVE: undefined,
    },
    () => {
      assert.deepEqual(getGuardrails(), {
        maxSlippagePct: 1,
        maxDeadlineMinutes: 30,
        requireZeroResetApprove: true,
      });
    }
  );

  withEnv(
    {
      UNISWAP_MAX_SLIPPAGE_PCT: "-1",
    },
    () => {
      assert.throws(() => getGuardrails(), /UNISWAP_MAX_SLIPPAGE_PCT/i);
    }
  );
});
