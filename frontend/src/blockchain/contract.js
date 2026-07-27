// ProcurementLedger contract configuration.
//
// The deployed address and the RPC endpoint are environment variables, never
// hardcoded, so the same build can point at a re-deployed contract without a
// code change. Copy frontend/.env.example to frontend/.env and fill it in — see
// contracts/README.md for how to deploy and where the address comes from.
//
// The ABI is a verbatim copy of contracts/ProcurementLedger.abi.json. If you
// ever change the Solidity, re-copy the ABI from Remix into BOTH files.

/** Deployed ProcurementLedger address on Sepolia, e.g. "0xAbC…". */
export const LEDGER_ADDRESS = import.meta.env.VITE_LEDGER_ADDRESS || ''

/** Read-only Sepolia RPC used by the public verification page (no wallet, no gas).
 *  Defaults to a public endpoint so the page works with zero configuration. */
export const SEPOLIA_RPC_URL =
  import.meta.env.VITE_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'

/** Sepolia chain id: 11155111 (0xaa36a7). MetaMask compares the hex form. */
export const SEPOLIA_CHAIN_ID = 11155111
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7'

export const SEPOLIA_NETWORK = {
  chainId: SEPOLIA_CHAIN_ID_HEX,
  chainName: 'Sepolia test network',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [SEPOLIA_RPC_URL],
  blockExplorerUrls: ['https://sepolia.etherscan.io'],
}

export const ETHERSCAN_TX_URL = 'https://sepolia.etherscan.io/tx/'
export const ETHERSCAN_ADDRESS_URL = 'https://sepolia.etherscan.io/address/'

/** True when a contract address has been configured — the UI hides/greys the
 *  blockchain features instead of throwing when it hasn't. */
export const isLedgerConfigured = () => /^0x[0-9a-fA-F]{40}$/.test(LEDGER_ADDRESS)

export const txUrl = (txHash) => (txHash ? ETHERSCAN_TX_URL + txHash : '')
export const contractUrl = () => (LEDGER_ADDRESS ? ETHERSCAN_ADDRESS_URL + LEDGER_ADDRESS : '')

export const LEDGER_ABI = [
  { inputs: [], stateMutability: 'nonpayable', type: 'constructor' },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'uint256', name: 'id', type: 'uint256' },
      { indexed: false, internalType: 'string', name: 'entityType', type: 'string' },
      { indexed: false, internalType: 'string', name: 'entityRef', type: 'string' },
      { indexed: false, internalType: 'string', name: 'stage', type: 'string' },
      { indexed: false, internalType: 'string', name: 'dataHash', type: 'string' },
      { indexed: false, internalType: 'address', name: 'actor', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'timestamp', type: 'uint256' },
    ],
    name: 'AnchorRecorded',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'previousOwner', type: 'address' },
      { indexed: true, internalType: 'address', name: 'newOwner', type: 'address' },
    ],
    name: 'OwnershipTransferred',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [{ indexed: false, internalType: 'bool', name: 'restricted', type: 'bool' }],
    name: 'RestrictedSet',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'writer', type: 'address' },
      { indexed: false, internalType: 'bool', name: 'allowed', type: 'bool' },
    ],
    name: 'WriterAuthorized',
    type: 'event',
  },
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'authorizedWriters',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'string', name: 'entityRef', type: 'string' }],
    name: 'countByRef',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'id', type: 'uint256' }],
    name: 'getAnchor',
    outputs: [
      {
        components: [
          { internalType: 'string', name: 'entityType', type: 'string' },
          { internalType: 'string', name: 'entityRef', type: 'string' },
          { internalType: 'string', name: 'stage', type: 'string' },
          { internalType: 'string', name: 'dataHash', type: 'string' },
          { internalType: 'address', name: 'actor', type: 'address' },
          { internalType: 'uint256', name: 'timestamp', type: 'uint256' },
        ],
        internalType: 'struct ProcurementLedger.Anchor',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'string', name: 'entityRef', type: 'string' }],
    name: 'getAnchorIds',
    outputs: [{ internalType: 'uint256[]', name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'string', name: 'entityRef', type: 'string' }],
    name: 'getAnchorsByRef',
    outputs: [
      {
        components: [
          { internalType: 'string', name: 'entityType', type: 'string' },
          { internalType: 'string', name: 'entityRef', type: 'string' },
          { internalType: 'string', name: 'stage', type: 'string' },
          { internalType: 'string', name: 'dataHash', type: 'string' },
          { internalType: 'address', name: 'actor', type: 'address' },
          { internalType: 'uint256', name: 'timestamp', type: 'uint256' },
        ],
        internalType: 'struct ProcurementLedger.Anchor[]',
        name: '',
        type: 'tuple[]',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'string', name: 'entityType', type: 'string' },
      { internalType: 'string', name: 'entityRef', type: 'string' },
      { internalType: 'string', name: 'stage', type: 'string' },
      { internalType: 'string', name: 'dataHash', type: 'string' },
    ],
    name: 'recordEvent',
    outputs: [{ internalType: 'uint256', name: 'id', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'restricted',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bool', name: 'value', type: 'bool' }],
    name: 'setRestricted',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'writer', type: 'address' },
      { internalType: 'bool', name: 'allowed', type: 'bool' },
    ],
    name: 'setWriter',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'total',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'newOwner', type: 'address' }],
    name: 'transferOwnership',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
]
