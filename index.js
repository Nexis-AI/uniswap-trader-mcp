const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const { z } = require("zod");
const ethers = require("ethers");
const { randomUUID } = require("crypto");
const SafeProtocolKit = require("@safe-global/protocol-kit");
const Safe = SafeProtocolKit.default ?? SafeProtocolKit;
const { OperationType } = require("@safe-global/types-kit");
const { 
  Token,
  CurrencyAmount,
  TradeType,
  Percent,
  SwapRouter
} = require("@uniswap/sdk-core");
const { AlphaRouter, SwapType } = require("@uniswap/smart-order-router");

// Define minimal ERC20 ABI with decimals function added
const ERC20ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)"
];

// Define minimal SwapRouter ABI for Uniswap V3 (only exactInput and exactOutput)
const SwapRouterABI = [
  "function exactInput(tuple(address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, address[] path) params) external payable returns (uint256 amountOut)",
  "function exactOutput(tuple(address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, address[] path) params) external payable returns (uint256 amountIn)",
  "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)"
];

// Define minimal WETH9 ABI for deposit and withdraw
const WETHABI = [
  "function deposit() external payable",
  "function withdraw(uint256 wad) external",
  "function balanceOf(address account) external view returns (uint256)"
];

// Load environment variables and chain configurations
require('dotenv').config();
const CHAIN_CONFIGS = require('./chainConfigs');

// Import utilities from ethers.utils for v5
const { parseUnits, formatUnits } = ethers.utils;

const ERC20_INTERFACE = new ethers.utils.Interface(ERC20ABI);


function parseSafeAddressesJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("SAFE_ADDRESSES_JSON must be a JSON object mapping chainId -> Safe address");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse SAFE_ADDRESSES_JSON: ${error.message}`);
  }
}

function getGuardrails() {
  const maxSlippagePct = Number(process.env.UNISWAP_MAX_SLIPPAGE_PCT ?? "1");
  const maxDeadlineMinutes = Number(process.env.UNISWAP_MAX_DEADLINE_MINUTES ?? "30");
  const requireZeroResetApprove = (process.env.UNISWAP_REQUIRE_ZERO_RESET_APPROVE ?? "true").toLowerCase() === "true";

  if (!Number.isFinite(maxSlippagePct) || maxSlippagePct <= 0 || maxSlippagePct > 50) {
    throw new Error("UNISWAP_MAX_SLIPPAGE_PCT must be a number between (0, 50].");
  }
  if (!Number.isFinite(maxDeadlineMinutes) || maxDeadlineMinutes <= 0 || maxDeadlineMinutes > 24 * 60) {
    throw new Error("UNISWAP_MAX_DEADLINE_MINUTES must be a number between (0, 1440].");
  }

  return { maxSlippagePct, maxDeadlineMinutes, requireZeroResetApprove };
}

// Initialize MCP server
const server = new McpServer({
  name: "Uniswap Trader MCP",
  version: "2.0.0",
  description: "An MCP server for AI agents to automate trading strategies on Uniswap DEX across multiple blockchains"
});

// Get provider and router for a specific chain
function getChainContext(chainId) {
  const config = CHAIN_CONFIGS[chainId];
  if (!config) {
    const supportedChains = Object.entries(CHAIN_CONFIGS)
      .map(([id, { name }]) => `${id} - ${name}`)
      .join(', ');
    throw new Error(`Unsupported chainId: ${chainId}. Supported chains: ${supportedChains}`);
  }
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const router = new AlphaRouter({ chainId, provider });
  return { provider, router, config };
}

// Create a token instance, fetching decimals for ERC-20 tokens
async function createToken(chainId, address, provider, symbol = "UNKNOWN", name = "Unknown Token") {
  const config = CHAIN_CONFIGS[chainId];
  if (!address || address.toLowerCase() === "native") {
    return new Token(chainId, config.weth, 18, symbol, name); // Native token defaults to 18 decimals
  }
  const tokenContract = new ethers.Contract(address, ERC20ABI, provider);
  const decimals = await tokenContract.decimals();
  return new Token(chainId, ethers.utils.getAddress(address), decimals, symbol, name);
}

// Check balance, throw error if insufficient for the intended action
async function assertHasBalance(provider, accountAddress, tokenAddress, requiredAmountWei, isNative = false) {
  const required = ethers.BigNumber.from(requiredAmountWei ?? "0");
  if (required.lte(0)) return;

  if (isNative) {
    const balance = await provider.getBalance(accountAddress);
    if (balance.lt(required)) {
      throw new Error(
        `Insufficient native balance. Required ${formatUnits(required, 18)}; have ${formatUnits(balance, 18)} at ${accountAddress}.`
      );
    }
    return;
  }

  const tokenContract = new ethers.Contract(tokenAddress, ERC20ABI, provider);
  const [balance, symbol, decimals] = await Promise.all([
    tokenContract.balanceOf(accountAddress),
    tokenContract.symbol(),
    tokenContract.decimals(),
  ]);
  if (balance.lt(required)) {
    throw new Error(
      `Insufficient ${symbol} balance. Required ${formatUnits(required, decimals)}; have ${formatUnits(balance, decimals)} at ${accountAddress}.`
    );
  }
}

// Tool: Get price quote with Smart Order Router
server.tool(
  "getPrice",
  "Get a price quote for a Uniswap swap, supporting multi-hop routes",
  {
    chainId: z.number().default(1).describe("Chain ID (1: Ethereum, 10: Optimism, 137: Polygon, 42161: Arbitrum, 42220: Celo, 56: BNB Chain, 43114: Avalanche, 8453: Base)"),
    tokenIn: z.string().describe("Input token address ('NATIVE' for native token like ETH)"),
    tokenOut: z.string().describe("Output token address ('NATIVE' for native token like ETH)"),
    amountIn: z.string().optional().describe("Exact input amount (required for exactIn trades)"),
    amountOut: z.string().optional().describe("Exact output amount (required for exactOut trades)"),
    tradeType: z.enum(["exactIn", "exactOut"]).default("exactIn").describe("Trade type: exactIn requires amountIn, exactOut requires amountOut")
  },
  async ({ chainId, tokenIn, tokenOut, amountIn, amountOut, tradeType }) => {
    try {
      const { provider, router, config } = getChainContext(chainId);
      
      const tokenA = await createToken(chainId, tokenIn, provider);
      const tokenB = await createToken(chainId, tokenOut, provider);

      if (tradeType === "exactIn" && !amountIn) {
        throw new Error("amountIn is required for exactIn trades");
      }
      if (tradeType === "exactOut" && !amountOut) {
        throw new Error("amountOut is required for exactOut trades");
      }

      const amount = tradeType === "exactIn" ? amountIn : amountOut;
      const decimals = tradeType === "exactIn" ? tokenA.decimals : tokenB.decimals;
      const amountWei = parseUnits(amount, decimals).toString();
      const route = await router.route(
        CurrencyAmount.fromRawAmount(
          tradeType === "exactIn" ? tokenA : tokenB,
          amountWei
        ),
        tradeType === "exactIn" ? tokenB : tokenA,
        tradeType === "exactIn" ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT,
        {
          recipient: ethers.constants.AddressZero,
          slippageTolerance: new Percent(5, 1000),
          deadline: Math.floor(Date.now() / 1000) + 20 * 60,
          type: SwapType.SWAP_ROUTER_02,
        }
      );
      if (!route) throw new Error("No route found");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            chainId,
            tradeType,
            price: route.trade.executionPrice.toSignificant(6),
            inputAmount: route.trade.inputAmount.toSignificant(6),
            outputAmount: route.trade.outputAmount.toSignificant(6),
            minimumReceived: route.trade.minimumAmountOut(new Percent(5, 1000)).toSignificant(6),
            maximumInput: route.trade.maximumAmountIn(new Percent(5, 1000)).toSignificant(6),
            route: route.trade.swaps.map(swap => ({
              tokenIn: swap.inputAmount.currency.address,
              tokenOut: swap.outputAmount.currency.address,
              fee: swap.route.pools[0].fee
            })),
            estimatedGas: route.estimatedGasUsed.toString()
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Failed to get price: ${error.message}. Check network connection.`);
    }
  }
);

// Tool: Execute swap with Smart Order Router
server.tool(
  "executeSwap",
  "Prepare or execute a swap on Uniswap via a Safe Smart Account (agent-based execution with guardrails)",
  {
    chainId: z.number().default(1).describe("Chain ID (1: Ethereum, 10: Optimism, 137: Polygon, 42161: Arbitrum, 42220: Celo, 56: BNB Chain, 43114: Avalanche, 8453: Base)"),
    tokenIn: z.string().describe("Input token address ('NATIVE' for native token like ETH)"),
    tokenOut: z.string().describe("Output token address ('NATIVE' for native token like ETH)"),
    amountIn: z.string().optional().describe("Exact input amount (required for exactIn trades)"),
    amountOut: z.string().optional().describe("Exact output amount (required for exactOut trades)"),
    tradeType: z.enum(["exactIn", "exactOut"]).default("exactIn").describe("Trade type: exactIn requires amountIn, exactOut requires amountOut"),
    slippageTolerance: z.number().optional().default(0.5).describe("Slippage tolerance in percentage"),
    deadline: z.number().optional().default(20).describe("Transaction deadline in minutes"),
    mode: z.enum(["prepare", "execute"]).optional().default("prepare").describe("prepare returns Safe transaction details; execute broadcasts on-chain (requires Safe threshold=1 or enough signatures)"),
    safeAddress: z.string().optional().describe("Address of the Safe Smart Account. If not provided, defaults to server-configured SAFE_ADDRESS.")
  },
  async ({ chainId, tokenIn, tokenOut, amountIn, amountOut, tradeType, slippageTolerance, deadline, mode, safeAddress: userSafeAddress }) => {
    try {
      const { provider, router, config } = getChainContext(chainId);
      const guardrails = getGuardrails();
      if (slippageTolerance > guardrails.maxSlippagePct) {
        throw new Error(
          `slippageTolerance ${slippageTolerance}% exceeds UNISWAP_MAX_SLIPPAGE_PCT ${guardrails.maxSlippagePct}%.`
        );
      }
      if (deadline > guardrails.maxDeadlineMinutes) {
        throw new Error(
          `deadline ${deadline} minutes exceeds UNISWAP_MAX_DEADLINE_MINUTES ${guardrails.maxDeadlineMinutes} minutes.`
        );
      }

      // Determine Safe Address: Tool argument > Chain specific env > Global env
      let safeAddress = userSafeAddress;
      if (!safeAddress) {
        const chainSpecific = process.env[`SAFE_ADDRESS_${chainId}`];
        if (chainSpecific) {
          safeAddress = ethers.utils.getAddress(chainSpecific);
        } else {
             const fromJson = parseSafeAddressesJson(process.env.SAFE_ADDRESSES_JSON);
             if (fromJson && (fromJson[chainId] || fromJson[String(chainId)])) {
                 const addr = fromJson[chainId] ?? fromJson[String(chainId)];
                 safeAddress = ethers.utils.getAddress(addr);
             } else {
                 const single = process.env.SAFE_ADDRESS;
                 if (single) {
                     safeAddress = ethers.utils.getAddress(single);
                 }
             }
        }
      }

      if (!safeAddress) {
         throw new Error(
            `Missing Safe address (Safe 4337 Wallet). Please provide 'safeAddress' as an argument, or configure SAFE_ADDRESS on the server.`
         );
      }
      safeAddress = ethers.utils.getAddress(safeAddress);

      // Handle Agent Key (Optional)
      const agentPrivateKey = process.env.SAFE_AGENT_PRIVATE_KEY;
      const agentAddress = agentPrivateKey ? new ethers.Wallet(agentPrivateKey).address : null;

      if (mode === "execute" && !agentPrivateKey) {
        throw new Error("Cannot use mode='execute' because SAFE_AGENT_PRIVATE_KEY is not set on the server.");
      }

      const protocolKit = await Safe.init({
        provider: config.rpcUrl,
        signer: agentPrivateKey, // Optional, can be undefined/null
        safeAddress,
      });

      const isSafeDeployed = await protocolKit.isSafeDeployed();
      if (!isSafeDeployed) throw new Error(`Safe not deployed on chainId ${chainId} at ${safeAddress}`);

      // Owner check logic only if we have an agent/signer
      let isAgentOwner = false;
      let threshold = 1;
      try {
        const [owners, thr] = await Promise.all([protocolKit.getOwners(), protocolKit.getThreshold()]);
        threshold = thr;
        if (agentAddress) {
            isAgentOwner = owners.map((o) => o.toLowerCase()).includes(agentAddress.toLowerCase());
        }
      } catch (e) {
        // If getting owners fails, we might just proceed (could be a connection issue or limited access)
        console.warn("Failed to fetch Safe owners/threshold:", e.message);
      }
      
      const isNativeIn = !tokenIn || tokenIn.toLowerCase() === "native";
      const isNativeOut = !tokenOut || tokenOut.toLowerCase() === "native";
      
      const tokenA = await createToken(chainId, isNativeIn ? config.weth : tokenIn, provider);
      const tokenB = await createToken(chainId, isNativeOut ? config.weth : tokenOut, provider);

      if (tradeType === "exactIn" && !amountIn) {
        throw new Error("amountIn is required for exactIn trades");
      }
      if (tradeType === "exactOut" && !amountOut) {
        throw new Error("amountOut is required for exactOut trades");
      }

      const amount = tradeType === "exactIn" ? amountIn : amountOut;
      const decimals = tradeType === "exactIn" ? tokenA.decimals : tokenB.decimals;
      const amountWei = parseUnits(amount, decimals).toString();
      
      const slippagePercent = new Percent(Math.floor(slippageTolerance * 100), 10000);
      const deadlineSeconds = Math.floor(Date.now() / 1000) + (deadline * 60);

      const route = await router.route(
        CurrencyAmount.fromRawAmount(
          tradeType === "exactIn" ? tokenA : tokenB,
          amountWei
        ),
        tradeType === "exactIn" ? tokenB : tokenA,
        tradeType === "exactIn" ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT,
        {
          recipient: safeAddress,
          slippageTolerance: slippagePercent,
          deadline: deadlineSeconds,
          type: SwapType.SWAP_ROUTER_02,
        }
      );

      if (!route) throw new Error("No route found");

      const maxInput = route.trade.maximumAmountIn(slippagePercent);
      const maxInputWei = maxInput.quotient.toString();
      const swapValueWei = isNativeIn ? maxInputWei : route.methodParameters.value;

      // Check balance before swap (exactOut needs up to maxInput)
      try {
        await assertHasBalance(provider, safeAddress, isNativeIn ? null : tokenA.address, maxInputWei, isNativeIn);
      } catch (balanceError) {
         // In prepare mode, we might want to warn but allow proceeding (user might top up before executing)
         // But asserting balance is good practice. We'll keep it but add context.
         throw new Error(`Balance check failed: ${balanceError.message}`);
      }

      const metaTxs = [];

      // Approve token if not native input
      if (!isNativeIn) {
        const tokenContractRead = new ethers.Contract(tokenA.address, ERC20ABI, provider);
        const currentAllowance = await tokenContractRead.allowance(safeAddress, config.swapRouter);
        const requiredAllowance = ethers.BigNumber.from(maxInputWei);

        if (currentAllowance.lt(requiredAllowance)) {
          if (guardrails.requireZeroResetApprove && !currentAllowance.isZero()) {
            metaTxs.push({
              to: tokenA.address,
              value: "0",
              data: ERC20_INTERFACE.encodeFunctionData("approve", [config.swapRouter, "0"]),
              operation: OperationType.Call,
            });
          }
          metaTxs.push({
            to: tokenA.address,
            value: "0",
            data: ERC20_INTERFACE.encodeFunctionData("approve", [config.swapRouter, maxInputWei]),
            operation: OperationType.Call,
          });
        }
      }

      // Swap meta-transaction (router handles wrapping/unwrapping via calldata when needed)
      metaTxs.push({
        to: config.swapRouter,
        value: swapValueWei,
        data: route.methodParameters.calldata,
        operation: OperationType.Call,
      });

      // For exactOut native output, unwrap WETH -> native ETH inside the Safe
      if (isNativeOut && tradeType === "exactOut") {
        metaTxs.push({
          to: config.weth,
          value: "0",
          data: new ethers.utils.Interface(WETHABI).encodeFunctionData("withdraw", [amountWei]),
          operation: OperationType.Call,
        });
      }

      const safeTx = await protocolKit.createTransaction({
        transactions: metaTxs,
        onlyCalls: true,
      });

      const safeTxHash = await protocolKit.getTransactionHash(safeTx);
      
      // If we have a private key, we can try to sign. Otherwise, we just return the hash/tx data.
      let safeSignature = null;
      if (agentPrivateKey) {
         safeSignature = await protocolKit.signHash(safeTxHash);
      }

      if (mode === "prepare") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              chainId,
              safeAddress,
              agentAddress: agentAddress ?? "NONE (Non-custodial)",
              isAgentOwner,
              safeThreshold: threshold,
              mode,
              tradeType,
              fromToken: isNativeIn ? "NATIVE" : tokenIn,
              toToken: isNativeOut ? "NATIVE" : tokenOut,
              inputAmount: route.trade.inputAmount.toSignificant(6),
              outputAmount: route.trade.outputAmount.toSignificant(6),
              minimumReceived: route.trade.minimumAmountOut(slippagePercent).toSignificant(6),
              maximumInput: route.trade.maximumAmountIn(slippagePercent).toSignificant(6),
              slippageTolerancePct: slippageTolerance,
              deadlineSeconds,
              safeTxHash,
              safeSignature: safeSignature ? { signer: safeSignature.signer, data: safeSignature.data, isContractSignature: safeSignature.isContractSignature } : null,
              metaTransactions: metaTxs,
              estimatedGas: route.estimatedGasUsed.toString(),
              route: route.trade.swaps.map(swap => ({
                tokenIn: swap.inputAmount.currency.address,
                tokenOut: swap.outputAmount.currency.address,
                fee: swap.route.pools[0].fee
              }))
            }, null, 2)
          }]
        };
      }

      // Execute Mode
      if (threshold > 1) {
        throw new Error(
          `Safe threshold is ${threshold}; cannot execute with a single agent signature. Use mode=prepare and collect additional signatures, then execute via Safe.`
        );
      }
      if (!isAgentOwner) {
        throw new Error(
          `Agent signer ${agentAddress} is not an owner of Safe ${safeAddress} on chainId ${chainId}.`
        );
      }
      // If we fell through here, we must have an agentPrivateKey (checked earlier) and it must be an owner.
      const txResponse = await protocolKit.executeTransaction(safeTx);
      const receipt = await provider.waitForTransaction(txResponse.hash);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            chainId,
            safeAddress,
            safeTxHash,
            txHash: txResponse.hash,
            tradeType,
            amountIn: route.trade.inputAmount.toSignificant(6),
            outputAmount: route.trade.outputAmount.toSignificant(6),
            minimumReceived: route.trade.minimumAmountOut(slippagePercent).toSignificant(6),
            maximumInput: route.trade.maximumAmountIn(slippagePercent).toSignificant(6),
            fromToken: isNativeIn ? "NATIVE" : tokenIn,
            toToken: isNativeOut ? "NATIVE" : tokenOut,
            route: route.trade.swaps.map(swap => ({
              tokenIn: swap.inputAmount.currency.address,
              tokenOut: swap.outputAmount.currency.address,
              fee: swap.route.pools[0].fee
            })),
            gasUsed: receipt?.gasUsed?.toString?.() ?? null
          }, null, 2)
        }]
      };
    } catch (error) {
      throw new Error(`Swap failed: ${error.message}. Check wallet funds and network connection.`);
    }
  }
);

// Prompt: Generate swap suggestion with Smart Order Router
server.prompt(
  "suggestSwap",
  { 
    amount: z.string().describe("Amount to swap"),
    token: z.string().describe("Starting token address ('NATIVE' for native token like ETH)"),
    tradeType: z.enum(["exactIn", "exactOut"]).default("exactIn").describe("Trade type")
  },
  ({ amount, token, tradeType }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Suggest the best token swap for ${amount} at ${token} on Uniswap V3 using smart order routing. Consider liquidity, fees, and optimal multi-hop paths. Trade type: ${tradeType}.`
      }
    }]
  })
);

const resolveTransportMode = () => {
  const explicit = (process.env.MCP_TRANSPORT || "").trim().toLowerCase();
  if (explicit === "http" || explicit === "stdio") return explicit;
  return process.env.PORT ? "http" : "stdio";
};

const resolvePort = () => {
  const raw = process.env.PORT || process.env.MCP_PORT || "8080";
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 8080;
};

// Start the server using stdio transport (default for local MCP clients)
async function startStdioServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
}

// Start the server using Streamable HTTP transport (for hosted deployments)
async function startHttpServer() {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  const port = resolvePort();
  const transports = new Map();

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const ensureTransport = async (sessionId, body) => {
    if (sessionId && transports.has(sessionId)) {
      return transports.get(sessionId);
    }

    if (!sessionId && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      await server.connect(transport);
      return transport;
    }

    return null;
  };

  const handleMcpRequest = async (req, res) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    try {
      const transport = await ensureTransport(sessionId, req.body);
      if (!transport) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: missing or invalid session" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", handleMcpRequest);
  app.get("/mcp", handleMcpRequest);
  app.delete("/mcp", handleMcpRequest);

  app.listen(port, (error) => {
    if (error) {
      console.error("Failed to start HTTP server:", error);
      process.exit(1);
    }
    console.log(`Uniswap MCP HTTP server listening on port ${port}`);
  });
}

if (require.main === module) {
  const mode = resolveTransportMode();
  if (mode === "http") {
    startHttpServer();
  } else {
    startStdioServer();
  }
}

module.exports = {
  parseSafeAddressesJson,
  getGuardrails,
};
