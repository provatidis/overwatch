// Settings shared by the page and the daily snapshot job.

// Thresholds for the three thesis checks. Each check is Healthy at or above
// `good`, Watch at or above `watch`, and Alert below that.
export const THRESHOLDS = {
  bankroll30d:  { good: -0.05, watch: -0.15 }, // change in treasury stablecoins over 30 days
  quarter:      { good: 0,     watch: -0.15 }, // last full quarter's house result vs the one before
  buybackShare: { good: 0.30,  watch: 0.15 }   // buybacks ÷ house result over the last 90 days
};

export const OVER = {
  maxSupply: 69_420_000,
  decimals: 18,
  // OVER contracts (Chainlink CCT: lock/release on Ethereum, burn/mint on the L2s).
  tokens: {
    ethereum: '0x90ce5720c17587d28e4af120ae2d313b3bad1722',
    optimism: '0xedf38688b27036816a50185caa430d5479e1c63e',
    arbitrum: '0x5829d6fe7528bc8e92c4e81cc8f20a528820b51a',
    base:     '0x7750c092e284e2c7366f50c8306f43c7eb2e82a2'
  },
  // Wallets counted as the Overtime treasury on every chain.
  treasury: [
    '0x1777c6d588fd931751762836811529c0073d6376' // treasury, sole liquidity provider since OIP-265
  ],
  // Holders that are not circulating supply (bridge pools that back tokens on other chains).
  // Holders whose explorer name matches LOCKED_NAME are detected automatically as well.
  locked: { ethereum: ['0x9054f2df5f2ac59b39a175c27a00165989d17d2b'] }, // Chainlink LockReleaseTokenPool
  snapshotSpace: 'thalesgov.eth'
};

export const LOCKED_NAME = /LockRelease|TokenPool/i;
export const DEAD = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead'
];

export const CHAIN_NAMES = { ethereum: 'Ethereum', optimism: 'Optimism', arbitrum: 'Arbitrum', base: 'Base' };
export const EXPLORERS = { ethereum: 'https://etherscan.io/address/', optimism: 'https://optimistic.etherscan.io/address/', arbitrum: 'https://arbiscan.io/address/', base: 'https://basescan.org/address/' };

// Proposal titles that touch what holders get: buybacks, burns, treasury, fees.
export const HOLDER_VALUE = /buyback|burn|treasur|distribut|redemption|redeem|revenue|fee|tokenomic|emission|incentive|liquidity|safebox|payout/i;

export const ANNOTATIONS = [{ t: Date.UTC(2026, 6, 21) / 1000, label: 'OIP-265' }];
