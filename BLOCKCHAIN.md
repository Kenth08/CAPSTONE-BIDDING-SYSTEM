# Blockchain Anchoring — setup & demo guide

This layer records the whole procurement lifecycle — submission → head review →
bidding → evaluation → award — on a public Ethereum testnet as a tamper-evident
audit trail. It sits **on top of** the existing system: no existing feature,
endpoint, or permission changed behaviour.

- **What goes on-chain:** a SHA-256 hash of each record plus its key document,
  and four short strings (entity type, procurement code, stage, hash).
- **What never goes on-chain:** documents, supplier names, bid amounts, emails,
  any personal data. The contract even *rejects* anything that isn't exactly a
  66-character hash, so it cannot be misused as a document store.
- **Where authority lives:** the database is still the source of truth for the
  business record. The chain is an independent witness — if a row or a file were
  edited afterwards, its hash would no longer match what was published.

---

## 1. What you need to install (one-time)

| # | Thing | Why | Cost |
|---|-------|-----|------|
| 1 | **[MetaMask](https://metamask.io/download)** browser extension | signs the anchoring transactions in the demo | free |
| 2 | **Sepolia test ETH** (~0.05) from a [faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) | pays gas on the test network | free |
| 3 | **[Remix IDE](https://remix.ethereum.org)** (browser, nothing to install) | compiles & deploys the contract | free |
| 4 | `npm install` in `frontend/` | pulls in `ethers` v6 (already added to package.json) | — |

Nothing else. Sepolia is Ethereum's public **test** network — its ETH has no
monetary value, so a real blockchain can be demonstrated for free.

> Without MetaMask the app still works end to end. Every transition is still
> hashed and stored; records simply show **"Not anchored"** with an *Anchor now*
> button that can be used later.

---

## 2. Deploy the contract (5 minutes)

Full step-by-step with screenshots-worth of detail:
**[`contracts/README.md`](contracts/README.md)**. In short:

1. MetaMask → switch to the **Sepolia** test network, fund it from a faucet.
2. Remix → new file `ProcurementLedger.sol` → paste
   [`contracts/ProcurementLedger.sol`](contracts/ProcurementLedger.sol) →
   compile with Solidity **0.8.20+**.
3. Deploy tab → Environment = **Injected Provider - MetaMask** → **Deploy** →
   confirm in MetaMask.
4. Copy the deployed contract address.

The ABI is already exported to
[`contracts/ProcurementLedger.abi.json`](contracts/ProcurementLedger.abi.json)
and embedded in `frontend/src/blockchain/contract.js` — you don't need to copy it
out of Remix.

---

## 3. Configure and migrate

**`frontend/.env`** (copy from `frontend/.env.example`):

```
VITE_LEDGER_ADDRESS=0xYourDeployedContractAddress
VITE_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

**`backend/.env`** (optional — only for the public page's server-side read
fallback and the server-signing path):

```
LEDGER_CONTRACT_ADDRESS=0xYourDeployedContractAddress
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

Then create the anchor table and restart both servers:

```bash
cd backend
python manage.py migrate          # adds procurement.BlockchainAnchor (0015)
python manage.py runserver

cd ../frontend
npm install                       # ethers v6
npm run dev                       # restart: Vite reads .env only at startup
```

---

## 4. The demo flow, end to end

Log in as each role in turn. After every action, MetaMask pops up once; confirm
it and watch the anchoring card in the bottom-right go
**Waiting for MetaMask → Anchoring on Sepolia → Anchored on-chain** with a link
to Etherscan.

| # | Who | Action | Anchored as |
|---|-----|--------|-------------|
| 1 | **Admin** | Planning → create a procurement (uploads the 5 documents) | `PROJECT / SUBMITTED` |
| 2 | **Head** | Pending Approval → **Approve** (or Reject / Request Revision) | `PROJECT / HEAD_APPROVED` · `HEAD_REJECTED` · `REVISION_REQUESTED` |
| 3 | **Admin** | Projects → **Publish** | `PROJECT / BIDDING_OPEN` |
| 4 | **Supplier** | Bid Opportunities → **Submit bid** (with quotation) | `BID / BID_SUBMITTED` |
| 5 | **Admin** | Bids → open a bid → **Qualify** / **Disqualify** | `BID / BID_QUALIFIED` · `BID_DISQUALIFIED` |
| 6 | **Admin** | **Select winner** | `AWARD / AWARDED` |

Where to see it in the UI:

- **Admin** → Bids → a procurement: badge in the header + the full
  **Blockchain Audit Trail** panel under the bids table, with an *Anchor now*
  button for any step still pending.
- **Head** → Pending Approval → *Details*: the trail so far, so the Head can see
  the Admin's submission was anchored before deciding.
- **Supplier** → My Bids → a bid: **Blockchain Proof of Submission** — their own
  tamper-evident receipt.
- **Public** → `/public` → **Verify on the Blockchain**: no login needed.

### 5. The public verification demo (the money shot)

Open `/public` in a **logged-out** browser (or a private window):

1. Type the procurement reference (e.g. `P-2026-001`) → **Verify**.
2. The page reads the trail from **two independent places** — this app's API and
   the Sepolia contract itself (via a plain RPC call, no wallet, no gas) — and
   matches them by hash. Each step shows **Verified on-chain** with an Etherscan
   link, or *Recorded, not yet anchored*.
3. **Check a document:** pick any file. The browser hashes it locally with
   WebCrypto (the file is never uploaded) and compares that hash with the
   document hash anchored for this procurement. Change one byte of the file and
   re-check — it no longer matches.

To *show* tamper-evidence: open Django admin → `Blockchain anchors` (deliberately
read-only) and note a `data_hash`. Anything that altered a project's budget after
the fact would produce a different hash, so its step would stop matching the
ledger and the public page would report **"Not found on the ledger"**.

---

## 6. How it works (implementation map)

| Concern | Where |
|---------|-------|
| Solidity ledger (append-only, indexed by procurement code) | `contracts/ProcurementLedger.sol` |
| Hashing + canonical payloads + anchor recording | `backend/procurement/blockchain.py` |
| Anchor storage | `backend/procurement/models.py` → `BlockchainAnchor` (migration `0015`) |
| Anchors on transitions, `/anchor/` + public trail endpoints | `backend/procurement/views.py` |
| Contract address / ABI / network config | `frontend/src/blockchain/contract.js` |
| MetaMask signing, network switch, chain reads, file hashing | `frontend/src/blockchain/anchor.js` |
| "Anchoring…" progress + retry, shared by all dashboards | `frontend/src/blockchain/anchorStore.js` |
| Badge + trail panel + activity card | `frontend/src/components/BlockchainTrail.jsx`, `AnchorActivity.jsx` |
| Public verifier | `frontend/src/components/PublicVerifier.jsx` |

### The hash

```python
data_hash = "0x" + sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")))
```

`payload` holds the record's stable business fields (code, budget, status,
timestamps…) plus `document_hash` — the SHA-256 of the document that mattered at
that step (Purchase Request at submission, Bid Evaluation Criteria at
publication, the quotation at bidding/award). Sorted keys and compact separators
make it reproducible byte-for-byte by anyone, forever.

### New API surface (all additive)

| Method | Endpoint | Notes |
|--------|----------|-------|
| — | every existing transition endpoint | now also returns `anchor: { id, stage, data_hash, attach_url, … }` |
| `POST` | `/projects/{id}/anchor/` | attach a confirmed tx (Admin or Head) |
| `POST` | `/bids/{id}/anchor/` | attach a confirmed tx (scoped to your own bids) |
| `POST` | `/awards/{id}/anchor/` | attach a confirmed tx (Admin) |
| `GET` | `/projects/{id}/anchors/` | a procurement's full trail (authenticated) |
| `GET` | `/public/procurement/{code}/anchors/` | public trail, hashes only, **no auth** |

`/projects/`, `/bids/` and `/awards/` list/detail responses also include an
`anchors` array (bulk-loaded in one query, so no N+1).

---

## 7. Failure handling (by design)

| What happens | Result |
|---|---|
| MetaMask prompt declined | Status change **stands**. Record shows "Not anchored"; *Anchor now* retries with the same hash. |
| Wrong network | The app asks MetaMask to switch to Sepolia (adds it if missing) before signing. |
| No test ETH / RPC down | Same as declined — un-anchored and retryable. |
| MetaMask not installed | Everything works; anchoring is reported as unavailable. |
| Tx confirmed but saving the reference failed | Reported as *"Anchored, not saved"*; retry re-saves without paying gas again. |
| Anchor write itself errors (storage, DB) | Swallowed and logged — never turns a successful approval into an error. |

The anchor-attach endpoints are idempotent: a double-click or a retry after a
flaky response can never rewrite an existing entry in the trail.

---

## 8. Known limitations

1. **Anyone can write to the ledger.** The demo contract is unrestricted;
   authorization is enforced in Django, and hashes are only ever produced
   server-side after a legitimate transition. A stranger writing junk anchors
   adds noise but cannot forge a record — no verifier will ever match a hash they
   didn't compute. To lock it down, the contract owner calls
   `setWriter(<signer>, true)` then `setRestricted(true)`.
2. **Anchoring depends on someone signing.** In the MetaMask demo the on-chain
   write happens in a browser, so a step stays un-anchored until it's confirmed.
   Section 9 removes that dependency.
3. **Sepolia is a testnet.** Its data is not guaranteed forever. A production
   deployment would target a mainnet or an L2 (Base, Arbitrum, Polygon) — the
   only change needed is the contract address, the RPC URL, and the chain id.

---

## 9. Stretch goal: server-side signing (no MetaMask)

For production, the backend can sign anchor transactions itself, so anchoring
happens automatically and never depends on whoever is at the keyboard:

```bash
pip install web3            # also uncomment it in backend/requirements.txt
```

```
# backend/.env
BLOCKCHAIN_SERVER_SIGNING=True
BLOCKCHAIN_PRIVATE_KEY=0x<throwaway test wallet key, funded with Sepolia ETH>
LEDGER_CONTRACT_ADDRESS=0xYourDeployedContractAddress
```

With the flag on, `record_anchor()` submits and confirms the transaction inline
(`procurement/blockchain.py` → `submit_anchor_server_side`), so records arrive
already anchored and the frontend has nothing left to sign. MetaMask remains the
default path when the flag is off. The private key is read from the environment
only — never hardcoded, never committed. Use a wallet that holds nothing but
test ETH.
