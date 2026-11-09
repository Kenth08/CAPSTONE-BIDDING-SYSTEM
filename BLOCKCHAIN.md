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

## What is on-chain and what is not

| Lifecycle event | Authoritative record | On-chain? (stage) | What the fingerprint covers | Who can see the details |
|---|---|---|---|---|
| Procurement filed | DB `Project` | Yes — `SUBMITTED` | code, name, category, type, ABC, periods, created_at + Purchase Request file hash | Admin, Head |
| Head approves / requests revision (rejecting is retired) | DB `Project` | Yes — `HEAD_APPROVED` / `HEAD_REJECTED` / `REVISION_REQUESTED` | same fields + the stage's document hash | Admin, Head |
| Published for bidding | DB `Project` | Yes — `BIDDING_OPEN` | same fields + Bid Evaluation Criteria file hash | everyone (public after publish) |
| Supplier submits a bid | DB `Bid` (audit log) | **No** (individually) | — | Admin, Head (D3), the bidder |
| Qualify / disqualify | DB `Bid.status` (audit log) | **No** (individually) | — | Admin, Head, the bidder |
| Evaluation completed (at award) | DB `Bid` rows + salts | Yes — `EVALUATION_COMPLETED` | bid count + one salted leaf per bid (id, supplier id, amount, submitted_at, quotation hash, final status) | hash: public; leaves: Admin; own leaf + salt: that bidder |
| Winning bid | DB `Bid` | Yes — `BID_SUBMITTED` (winner only, at award) | bid id, supplier id, amount, delivery timeline, submitted_at + quotation hash | Admin, Head, the winner |
| Award | DB `Award` | Yes — `AWARDED` | award id, bid id, supplier id, amount, status, awarded_at + winning quotation hash | winner name + date: public; amount: Admin, Head, winner |
| BAC Resolution / NOA / NTP issued | DB `Award` file + `*_issued_at` | Yes — `RESOLUTION_ISSUED` / `NOA_ISSUED` / `NTP_ISSUED` | award fields + file hash + issue date | Admin, Head, winner; NOA file public once awarded |
| A document re-issued | DB (file replaced) | Yes — a **new** anchor; the old one shows *superseded* | as above, for the new file and date | as above |

Every anchor on-chain is only `(entityType, procurementCode, stage, dataHash)` plus
the signer address and block time. **No amounts, names or documents.**

How "on-chain" is decided — the app never trusts a stored transaction hash:

- **Hash recorded, not yet on-chain** — the anchor exists; nobody has signed it.
- **Transaction reported** — a tx hash was submitted (MetaMask or server) but not checked.
- **Verified on-chain** — the server read the receipt (`confirm_anchors` on every
  deploy, or *Check on-chain* in the record) and found: its RPC really is Sepolia
  (`eth_chainId` = 11155111), status success, an `AnchorRecorded` event emitted
  by `LEDGER_CONTRACT_ADDRESS` with exactly this entity type, code, stage and
  hash that no other anchor row has already claimed, and the contract's own
  storage (`getAnchor(id)`) returning the same fields, signer and time.
  It then stores the record's **on-chain identity**: the contract's anchor id
  (`getAnchor(id)` — not the app's anchor id, not the tx hash), the event's log
  index, the chain timestamp, the chain id and the contract address, plus the
  block's depth and whether it is **final** (at or below the node's `finalized`
  block; never assumed when the node can't say). Anchors confirmed before
  these fields existed are re-read to fill them in; a node that has pruned the
  receipt leaves them empty rather than guessing, and never un-confirms them.
- **Reported transaction does not contain this record** — the receipt didn't
  match; the reference is kept, flagged, audit-logged, and can be signed again.

Separately, the **public verifier** reads the contract in the visitor's own
browser and matches each step by its hash, so it does not depend on the server.

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

> Without MetaMask the app still works end to end. Every anchored step is still
> hashed and stored; records simply show **"Hash recorded, not yet on-chain"**
> with an *Anchor now* button that can be used later.

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
**Waiting for MetaMask → Anchoring on Sepolia → Transaction submitted** with a link
to Etherscan.

| # | Who | Action | Anchored as |
|---|-----|--------|-------------|
| 1 | **Admin** | Planning → create a procurement (uploads the 5 documents) | `PROJECT / SUBMITTED` |
| 2 | **Head** | Pending Approval → **Approve** (or Request Revision) | `PROJECT / HEAD_APPROVED` · `REVISION_REQUESTED` (`HEAD_REJECTED` (older projects only: the Head can no longer reject)) |
| 3 | **Admin** | Projects → **Publish** | `PROJECT / BIDDING_OPEN` |
| 4 | **Supplier** | Bid Opportunities → **Submit bid** (with quotation) | *not anchored* — database record only |
| 5 | **Admin** | Bids → open a bid → **Qualify** / **Disqualify** | *not anchored* — database record, audit-logged |
| 6 | **Admin** | **Select winner** — MetaMask asks three times, in this order | `PROJECT / EVALUATION_COMPLETED` · `BID / BID_SUBMITTED` (winning bid only) · `AWARD / AWARDED` |
| 7 | **Admin** | Awards → generate or upload the **BAC Resolution** | `AWARD / RESOLUTION_ISSUED` |
| 8 | **Admin** | Awards → generate or upload the **Notice of Award** | `AWARD / NOA_ISSUED` |
| 9 | **Admin** | Awards → generate or upload the **Notice to Proceed** | `AWARD / NTP_ISSUED` |

Steps 4 and 5 deliberately write nothing on-chain one by one: anchoring every
bid would publish a fingerprint of each losing supplier's offer. Instead, step 6
first writes **one** `EVALUATION_COMPLETED` anchor: a salted commitment to every
bid received and its final outcome (see [What is on-chain](#what-is-on-chain-and-what-is-not)).
Then the winning bid (`BID_SUBMITTED`, written at award time — it fingerprints
the bid as submitted) and the award. `BID_QUALIFIED` and `BID_DISQUALIFIED`
exist in the stage vocabulary but are not written. Once awarded, qualify and
disqualify are refused by the server: the evaluation is final.

Steps 7–9 are the post-award instruments. They are **uploaded, never generated**:
a Notice of Award is a signed document in the real world, and only a stored file
has a stable hash worth anchoring (a PDF generated on the fly embeds a creation
timestamp, so it would hash differently every time and could never be verified
again). Each is anchored with its file hash **and its issue date** — the two
things a backdated notice would have to change.

The NTP matters most: it fixes when the supplier may legally start work, which
sets the delivery clock. Backdating an NTP to hide a late delivery is a classic
procurement fraud, and anchoring it makes that impossible to do quietly.
Re-uploading a document appends a *new* anchor rather than replacing the old
one, so a swap is visible in the trail instead of silently rewriting history.

Where to see it in the UI:

- **Admin** → Bids → a procurement: badge in the header + the full
  **Blockchain Audit Trail** panel under the bids table, with an *Anchor now*
  button for any step still pending.
- **Head** → Pending Approval → *Details*: the trail so far, so the Head can see
  the Admin's submission was anchored before deciding.
- **Supplier** → My Bids → a bid: the winning supplier sees **Winning bid & award
  on-chain**; every other bidder sees that their bid is a database record only.
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
   document hash BidBridge reports for each step. Change one byte of the file and
   re-check — it no longer matches. **What a match proves:** the file is the one
   BidBridge's database recorded for that step. The ledger holds the fingerprint
   of the step's whole record (which includes that document hash), not the
   document hash on its own, and the record itself is not public — so the link
   from file to on-chain fingerprint is BidBridge's word on this page (see
   section 8, limitation 7). Images are re-encoded on upload to strip metadata: verify the
   copy downloaded from BidBridge, not the original photo or scan.

To *show* tamper-evidence, two different things can be altered after the fact:

- **The business record** (e.g. an award amount or a losing bid's amount edited
  in the database). The server rebuilds the fingerprint from the record as it is
  now; it no longer equals the hash on-chain, so that step shows **"Record
  altered since it was recorded"** and a red banner (for a losing bid, it is the
  `EVALUATION_COMPLETED` step that turns red).
- **The stored hash itself** (someone edits `data_hash` to hide the change).
  The edited hash was never written on-chain, so the browser's own contract read
  can't find it: the step shows **"Not found on the ledger"**.
- **A file** swapped in storage: press **Re-check documents** — the step shows
  "the attached document has been replaced".

A document that was legitimately **re-issued** (e.g. a generated NOA replaced by
the signed scan) is shown as **Superseded** — a new anchor, not tampering.

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
| Server-side receipt + event check (`confirm_anchor`, `anchor_events`) | `backend/procurement/blockchain.py`, `management/commands/confirm_anchors.py` |
| Evaluation commitment (`anchor_evaluation`, `bid_leaf`, `inclusion_receipt`) | `backend/procurement/blockchain.py` (migration `0023`) |
| Role-scoped procurement record | `backend/procurement/record.py`, `frontend/src/components/ProcurementRecord.jsx` |
| Bidder's in-browser receipt check | `frontend/src/blockchain/receipt.js` (+ `receipt.test.js`) |
| One vocabulary for anchor states | `frontend/src/blockchain/anchorState.js` |

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
| `POST` | `/projects/{id}/verify-chain/` | server reads every reported tx back from Sepolia (Admin or Head; read-only on-chain) |
| `GET` | `/projects/{id}/record/` | the whole procurement + evidence, scoped to the caller (Admin, Head, or a Supplier who bid) |
| `GET` | `/public/procurement/{code}/` | public result: winner and date only, **no auth** |
| `GET` | `/public/procurement/{code}/anchors/{anchor_id}/packet/` | verification packet of a **project-stage** anchor of a public procurement, **no auth**; anything else is 404 |
| `GET` | `/public/procurement/{code}/anchors/{anchor_id}/` | one record of a public procurement in full (chain evidence + document versions), **no auth**; no payload |
| `GET` | `/projects/{id}/anchors/{anchor_id}/` | the same, scoped to the caller (a rival's bid record is 404); `packet_available` says whether this viewer can verify it |
| `GET` | `/files/awardversion/{version_id}/file/` | an earlier issue of a post-award document — same rule as that award's documents, never public |
| `GET` | `/projects/{id}/anchors/{anchor_id}/packet/` | verification packet scoped to the caller: Admin/Head all; winning supplier award records + own bid + own receipt; losing bidder own receipt only; others 404 |
| — | `/bids/{id}/select-winner/` | also returns `anchor_sequence` = [EVALUATION_COMPLETED, BID_SUBMITTED, AWARDED] |

`/projects/`, `/bids/` and `/awards/` list/detail responses also include an
`anchors` array (bulk-loaded in one query, so no N+1).

---

## 7. Failure handling (by design)

| What happens | Result |
|---|---|
| MetaMask prompt declined | Status change **stands**. Record shows "Hash recorded, not yet on-chain"; *Anchor now* retries with the same hash. When awarding, the remaining prompts are not shown. |
| Transaction reverts or is never mined | `confirm_anchors` (every deploy) or *Check on-chain* clears it, logs the failed hash, and the step can be signed again. |
| A reported tx hash does not record this step | Flagged **"Reported transaction does not contain this record"**, kept, audit-logged; never shown as verified; *Anchor now* is offered again. |
| Wrong network | The app asks MetaMask to switch to Sepolia (adds it if missing) before signing. Reads are refused off Sepolia: the server checks `eth_chainId` before confirming anything (`confirm_anchors` stops, *Check on-chain* says so), and the public verifier checks it before trusting a contract read. |
| RPC has pruned old receipts | Earlier confirmations stand; the on-chain identity stays empty until a history-keeping RPC is configured. An unreadable ledger is "can't tell", never "dropped". |
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
3. **"Verified on-chain" needs a server check.** There is no background worker:
   reported transactions are confirmed on every deploy (`confirm_anchors`) or on
   demand (*Check on-chain*). Until then they read "Transaction reported". The
   public verifier is independent of this — it reads the contract in the browser.
4. **The evaluation commitment proves the bids were fixed, not that the
   evaluation was fair.** It shows that after the award no bid was added,
   removed, re-priced or re-graded. Whether a qualify/disqualify decision was
   correct is a judgment the chain cannot make. Its contents are only checkable
   by the Admin (all leaves) and by each bidder for their own bid.
5. **"Signed by" is not an identity.** The ledger is unrestricted and no official
   signer address is configured, so the signer address is shown as-is.
6. **Sepolia is a testnet.** Its data is not guaranteed forever. A production
   deployment would target a mainnet or an L2 (Base, Arbitrum, Polygon) — the
   only change needed is the contract address, the RPC URL, and the chain id.
7. **Confidential records can't be verified by the public.** A *verification
   packet* (`procurement/packets.py`) ships a record's exact stored payload with
   the hashing rules and its on-chain identity, and the browser
   (`frontend/src/blockchain/packetVerify.js`) checks file → `document_hash` →
   payload → `dataHash` → `getAnchor(id)` → transaction itself. Project stages
   are public, so the public can verify the Purchase Request, Approved Budget and
   Bid Evaluation Criteria end to end. Award and bid payloads carry the amount and
   supplier id, so their packets go only to the Admin, the Head and the winning
   supplier; a public match against the Notice of Award is still a database
   match. The Terms of Reference and Technical Specifications are not
   fingerprinted at all yet.
8. **Old award-document files are kept only from Stage 4 on.** Every issue of a
   BAC Resolution / NOA / NTP is now kept as an `AwardDocumentVersion` (exact
   stored bytes, hash, issue date, anchor). Issues replaced *before* that table
   existed still appear as versions (from their anchors) but their file is
   marked "not preserved": the anchor never recorded where it was stored, and
   it is not guessed.
9. **Green means a selected document was verified, with complete record checks, nothing else.** The record details
   page (`/…/record/:id/anchor/:anchorId`, public `/public/procurement/:code/record/:anchorId`)
   shows the server's chain evidence in neutral colours; only the browser's own
   packet check can show green: a v3 record with all five documents recorded, a
   selected file matching the version it bound, and the transaction read back. With no
   file it is blue, **RECORD MATCH — DOCUMENT NOT CHECKED**. Server confirmation is blue
   "Confirmed on-chain" everywhere, and v1/v2 records keep a blue legacy status.

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
