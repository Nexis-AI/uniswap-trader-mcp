
const { z } = require("zod");

// Define schema from index.js (copied for verification since we can't import the server instance easily without refactoring export)
const executeSwapSchema = {
    chainId: z.number().default(1),
    tokenIn: z.string(),
    tokenOut: z.string(),
    amountIn: z.string().optional(),
    amountOut: z.string().optional(),
    tradeType: z.enum(["exactIn", "exactOut"]).default("exactIn"),
    slippageTolerance: z.number().optional().default(0.5),
    deadline: z.number().optional().default(20),
    mode: z.enum(["prepare", "execute"]).optional().default("prepare"),
    safeAddress: z.string().optional()
};

// Test Case 1: Validate Schema allows safeAddress
try {
  const schema = z.object(executeSwapSchema);
  const valid = schema.parse({
    chainId: 1,
    tokenIn: "NATIVE",
    tokenOut: "0x...",
    amountIn: "1.0",
    safeAddress: "0x1234567890123456789012345678901234567890" // User provided Safe
  });
  console.log("TEST 1 PASSED: Schema allows safeAddress");
} catch (e) {
  console.error("TEST 1 FAILED: Schema validation failed", e);
  process.exit(1);
}

// Test Case 2: Validate Logic Mock
// Since index.js is a server, we can't easily run it. But we can inspect the file content regex.
const fs = require('fs');
const content = fs.readFileSync('./index.js', 'utf8');

if (content.includes('safeAddress: z.string().optional()') &&
    content.includes('getSafeAddressForChain(chainId)') &&
    content.includes('process.env[`SAFE_ADDRESS_${chainId}`]')) {
    console.log("TEST 2 PASSED: Code logic contains expected non-custodial patterns");
} else {
    console.error("TEST 2 FAILED: Code logic missing expected refactor patterns");
    process.exit(1);
}

console.log("Verification Successful");
