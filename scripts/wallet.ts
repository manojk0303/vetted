/**
 * Throwaway testnet wallet helper.
 *   npm run wallet:new     -> generate a key and write it to .env (refuses to overwrite)
 *   npm run wallet:status  -> Sepolia ETH + test USDC balances
 *   npm run wallet:mint    -> mint 10 test USDC to the wallet (needs ~0.001 Sepolia ETH for gas)
 */
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadConfig, SEPOLIA } from "../src/core/config.js";

const cmd = process.argv[2];
const abi = parseAbi(["function mint(address to, uint256 amount)", "function balanceOf(address) view returns (uint256)"]);

async function main() {
  if (cmd === "new") {
    const env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : fs.readFileSync(".env.example", "utf8");
    if (/^EVM_PRIVATE_KEY=0x[0-9a-fA-F]{64}/m.test(env)) {
      console.log("A key already exists in .env. Not overwriting. Delete it manually if you really want a new one.");
      return;
    }
    const pk = generatePrivateKey();
    const next = /^EVM_PRIVATE_KEY=.*$/m.test(env) ? env.replace(/^EVM_PRIVATE_KEY=.*$/m, `EVM_PRIVATE_KEY=${pk}`) : `${env}\nEVM_PRIVATE_KEY=${pk}\n`;
    fs.writeFileSync(".env", next, { mode: 0o600 });
    console.log(`New TESTNET wallet: ${privateKeyToAccount(pk).address}`);
    console.log("Key written to .env (git-ignored). Fund it with ~0.01 Sepolia ETH, then: npm run wallet:mint");
    return;
  }

  const cfg = loadConfig();
  if (!cfg.privateKey) throw new Error("No EVM_PRIVATE_KEY. Run: npm run wallet:new");
  const account = privateKeyToAccount(cfg.privateKey);
  const pub = createPublicClient({ chain: sepolia, transport: http(cfg.rpcUrl) });

  const status = async () => {
    const [eth, usdc] = await Promise.all([
      pub.getBalance({ address: account.address }),
      pub.readContract({ address: SEPOLIA.usdc, abi, functionName: "balanceOf", args: [account.address] }),
    ]);
    console.log(`address : ${account.address}`);
    console.log(`ETH     : ${formatEther(eth)} (Sepolia, for the mint tx only; x402 payments are gasless)`);
    console.log(`USDC    : ${Number(usdc) / 1e6} (test token ${SEPOLIA.usdc})`);
    return { eth, usdc };
  };

  if (cmd === "status") {
    await status();
  } else if (cmd === "mint") {
    const { eth } = await status();
    if (eth === 0n) throw new Error("Wallet has no Sepolia ETH for gas. Use a public Sepolia faucet first.");
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(cfg.rpcUrl) });
    // `--to 0xADDR [--amount 1]` mints to another address (e.g. a test buyer agent); our wallet pays the gas.
    const ti = process.argv.indexOf("--to");
    const to = (ti > 0 ? process.argv[ti + 1] : account.address) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("--to must be a 0x address");
    const ai = process.argv.indexOf("--amount");
    const amount = BigInt(Math.round(Number(ai > 0 ? process.argv[ai + 1] : 10) * 1e6));
    console.log(`minting ${Number(amount) / 1e6} test USDC to ${to}`);
    const hash = await wallet.writeContract({ address: SEPOLIA.usdc, abi, functionName: "mint", args: [to, amount] });
    console.log(`mint tx: https://sepolia.etherscan.io/tx/${hash}`);
    await pub.waitForTransactionReceipt({ hash });
    await status();
  } else {
    console.log("usage: tsx scripts/wallet.ts new|status|mint");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
