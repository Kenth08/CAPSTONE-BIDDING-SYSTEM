# ProcurementLedger — deploy notes (Sepolia + Remix + MetaMask)

Everything here is a one-time setup. Once the contract is deployed you only ever
paste its address into two `.env` files.

## 0. What you need

| Thing | Where | Cost |
|---|---|---|
| MetaMask browser extension | <https://metamask.io/download> | free |
| Sepolia test ETH (~0.05 is plenty) | see step 2 | free |
| Remix IDE (browser, nothing to install) | <https://remix.ethereum.org> | free |

Sepolia is Ethereum's public **test** network. The ETH on it has no monetary
value — it exists so demos like this one can write real transactions to a real
blockchain for free.

## 1. Install MetaMask and switch to Sepolia

1. Install the MetaMask extension and create a wallet. **Write the recovery
   phrase down offline; never paste it anywhere.**
2. Open MetaMask → network dropdown (top-left) → **Show test networks** (enable
   it in Settings → Advanced if you don't see it) → pick **Sepolia**.
3. Copy your account address (`0x…`).

## 2. Get free Sepolia test ETH

Use any faucet — one is usually enough, and each transaction costs a tiny
fraction of an ETH:

- <https://cloud.google.com/application/web3/faucet/ethereum/sepolia>
- <https://www.alchemy.com/faucets/ethereum-sepolia>
- <https://sepolia-faucet.pk910.de> (proof-of-work faucet, no sign-up)

Paste your address, request the funds, wait ~30 seconds, and confirm the balance
shows up in MetaMask on Sepolia.

## 3. Deploy `ProcurementLedger.sol` in Remix

1. Go to <https://remix.ethereum.org>.
2. In the **File explorer**, create a new file `ProcurementLedger.sol` and paste
   the contents of [`ProcurementLedger.sol`](ProcurementLedger.sol).
3. **Solidity compiler** tab → compiler version **0.8.20** or newer → click
   **Compile ProcurementLedger.sol**. It should compile with no errors.
4. **Deploy & run transactions** tab → set **Environment** to
   **Injected Provider - MetaMask**. MetaMask pops up: approve the connection.
   Remix should now show `Custom (11155111) network` — that's Sepolia. If it
   shows anything else, switch networks in MetaMask and reload Remix.
5. Make sure **Contract** is `ProcurementLedger` → click the orange **Deploy**
   button → confirm the transaction in MetaMask.
6. When it confirms, copy the deployed contract address from the **Deployed
   Contracts** panel (the little copy icon). It looks like `0xAbC…123`.
7. Open `https://sepolia.etherscan.io/address/<that address>` to confirm it's
   live.

The ABI is already exported for you in
[`ProcurementLedger.abi.json`](ProcurementLedger.abi.json) and is embedded in
`frontend/src/blockchain/contract.js`, so you do **not** need to copy the ABI out
of Remix. (If you change the Solidity, re-copy the ABI from Remix's compiler tab
→ **ABI** button into both of those files.)

## 4. Paste the address into the app

**Frontend** — `frontend/.env` (create it from `frontend/.env.example`):

```
VITE_LEDGER_ADDRESS=0xYourDeployedContractAddress
VITE_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

**Backend** — `backend/.env` (only needed for the public verification page's
read fallback and the optional server-signing path):

```
LEDGER_CONTRACT_ADDRESS=0xYourDeployedContractAddress
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

Restart `npm run dev` after editing `.env` — Vite only reads env vars at startup.

## 5. Smoke-test the contract without the app (optional)

Still in Remix, under **Deployed Contracts**, expand `ProcurementLedger`:

- Call `recordEvent` with
  `"PROJECT"`, `"P-2026-001"`, `"SUBMITTED"`,
  `"0x0000000000000000000000000000000000000000000000000000000000000001"`
  → confirm in MetaMask.
- Call `getAnchorIds("P-2026-001")` → returns `[0]`.
- Call `total()` → returns `1`.

`dataHash` must be exactly 66 characters (`0x` + 64 hex) or the call reverts —
that guard is what keeps documents and personal data off the chain.

## Access control

The ledger deploys **unrestricted**: any address can append an anchor. Real
authorization lives in Django (`IsAdminRole` / `IsHeadRole` / `IsSupplierRole`),
and hashes are only ever produced server-side after a legitimate status change,
so an outsider writing junk anchors adds noise but cannot forge a procurement
record — no verifier will ever match a hash they didn't compute.

To lock writes to your official signer (stretch goal, from the owner account):

```
setWriter(0xYourBackendSignerAddress, true)
setRestricted(true)
```

Reads stay open to everyone regardless.
