// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ProcurementLedger
 * @notice Append-only, tamper-evident audit trail for the e-procurement
 *         lifecycle (submission -> head review -> bidding -> evaluation ->
 *         award).
 *
 * WHAT GOES ON-CHAIN
 *   Only a SHA-256 hash of each record plus minimal event metadata. No
 *   documents, no bid amounts, no supplier names, no personal data. The hash is
 *   computed off-chain by the Django backend over a canonical JSON payload that
 *   includes the SHA-256 of the relevant document, so anyone holding the
 *   original record + file can recompute the hash and prove it was not altered
 *   after the fact.
 *
 * IMMUTABILITY
 *   There is no update or delete function, by design. Anchors can only ever be
 *   appended, so the trail for a procurement can be replayed in order forever.
 *
 * ACCESS CONTROL — IMPORTANT LIMITATION FOR THE DEMO
 *   The ledger deploys UNRESTRICTED: any address can call recordEvent(). Real
 *   authorization (who may approve, publish, award...) is enforced by the Django
 *   backend's role permissions, and the hash itself is only ever produced
 *   server-side after a legitimate transition — so a third party writing junk
 *   anchors cannot forge a procurement record, it can only add noise that no
 *   verifier will match. To harden this in production, the owner can call
 *   setRestricted(true) and setWriter(addr, true) to limit writes to the
 *   official signer address(es); reads always stay open to everyone.
 */
contract ProcurementLedger {
    /// @dev One recorded lifecycle event. `dataHash` is "0x" + 64 hex chars.
    struct Anchor {
        string entityType; // "PROJECT" | "BID" | "AWARD"
        string entityRef;  // procurement code, e.g. "P-2026-001"
        string stage;      // "SUBMITTED", "HEAD_APPROVED", "BIDDING_OPEN", ...
        string dataHash;   // SHA-256 of the canonical off-chain payload
        address actor;     // wallet that signed this anchor
        uint256 timestamp; // block time when it was recorded
    }

    /// @dev Every anchor ever recorded, in write order. Index == anchor id.
    Anchor[] private _anchors;

    /// @dev entityRef (procurement code) -> anchor ids, so a procurement's whole
    ///      trail can be read back with one lookup + one read per anchor.
    mapping(string => uint256[]) private _idsByRef;

    // ── Optional write restriction (see the notice above) ────────────────────
    address public owner;
    bool public restricted;
    mapping(address => bool) public authorizedWriters;

    event AnchorRecorded(
        uint256 indexed id,
        string entityType,
        string entityRef,
        string stage,
        string dataHash,
        address actor,
        uint256 timestamp
    );
    event WriterAuthorized(address indexed writer, bool allowed);
    event RestrictedSet(bool restricted);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor() {
        owner = msg.sender;
        authorizedWriters[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit WriterAuthorized(msg.sender, true);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "ProcurementLedger: not owner");
        _;
    }

    modifier canWrite() {
        require(
            !restricted || authorizedWriters[msg.sender],
            "ProcurementLedger: writer not authorized"
        );
        _;
    }

    /**
     * @notice Append one lifecycle anchor. Anyone may call this while the
     *         ledger is unrestricted (the demo default).
     * @param entityType "PROJECT", "BID" or "AWARD".
     * @param entityRef  The procurement code the anchor belongs to.
     * @param stage      The lifecycle stage being recorded.
     * @param dataHash   "0x"-prefixed SHA-256 of the canonical payload.
     * @return id        The new anchor's id (also emitted in AnchorRecorded).
     */
    function recordEvent(
        string calldata entityType,
        string calldata entityRef,
        string calldata stage,
        string calldata dataHash
    ) external canWrite returns (uint256 id) {
        require(bytes(entityType).length > 0 && bytes(entityType).length <= 16, "ProcurementLedger: bad entityType");
        require(bytes(entityRef).length > 0 && bytes(entityRef).length <= 64, "ProcurementLedger: bad entityRef");
        require(bytes(stage).length > 0 && bytes(stage).length <= 32, "ProcurementLedger: bad stage");
        // 0x + 64 hex characters — a SHA-256 digest and nothing else, so the
        // ledger can never be used to smuggle a document or personal data.
        require(bytes(dataHash).length == 66, "ProcurementLedger: dataHash must be 0x + 64 hex");

        _anchors.push(
            Anchor({
                entityType: entityType,
                entityRef: entityRef,
                stage: stage,
                dataHash: dataHash,
                actor: msg.sender,
                timestamp: block.timestamp
            })
        );
        id = _anchors.length - 1;
        _idsByRef[entityRef].push(id);

        emit AnchorRecorded(id, entityType, entityRef, stage, dataHash, msg.sender, block.timestamp);
    }

    // ── Reads (always public, no gas, no wallet needed) ──────────────────────

    /// @notice Total number of anchors ever recorded.
    function total() external view returns (uint256) {
        return _anchors.length;
    }

    /// @notice Anchor ids recorded for one procurement code, in write order.
    function getAnchorIds(string calldata entityRef) external view returns (uint256[] memory) {
        return _idsByRef[entityRef];
    }

    /// @notice How many anchors one procurement code has.
    function countByRef(string calldata entityRef) external view returns (uint256) {
        return _idsByRef[entityRef].length;
    }

    /// @notice Read a single anchor by id.
    function getAnchor(uint256 id) external view returns (Anchor memory) {
        require(id < _anchors.length, "ProcurementLedger: unknown anchor");
        return _anchors[id];
    }

    /// @notice Read a procurement's entire trail in one call — what the public
    ///         verification page uses (one RPC round-trip instead of N+1).
    function getAnchorsByRef(string calldata entityRef) external view returns (Anchor[] memory) {
        uint256[] storage ids = _idsByRef[entityRef];
        Anchor[] memory out = new Anchor[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = _anchors[ids[i]];
        }
        return out;
    }

    // ── Owner controls (stretch goal: lock writes down in production) ─────────

    function setRestricted(bool value) external onlyOwner {
        restricted = value;
        emit RestrictedSet(value);
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        require(writer != address(0), "ProcurementLedger: zero address");
        authorizedWriters[writer] = allowed;
        emit WriterAuthorized(writer, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ProcurementLedger: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
