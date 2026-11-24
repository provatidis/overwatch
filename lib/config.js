// Settings shared by the page and the daily snapshot job.

// Thresholds for the thesis checks. Each check is Healthy at or above
// `good`, Watch at or above `watch`, and Alert below that.
export const THRESHOLDS = {
  bankroll30d:  { good: -0.05, watch: -0.15 }, // change in the house's money (stablecoins, plus ETH and BTC at one price) over 30 days
  houseTrend:   { good: -0.10, watch: -0.25 }, // last 90 days' house result vs the 90 before (only once both are comparable)
  buybackCover: { good: 1.5,   watch: 1.0 },   // house result ÷ buybacks over the last 90 days (below 1× the treasury tops them up)
  buybackRate:  { good: 0.80,  watch: 0.50, raised: 1.20 }, // last 7 days' daily buybacks ÷ the 30 days before
  houseOver7d:  { good: -0.005, watch: -0.02 }  // change in OVER held by the house (wallets, admin multisigs, pools, casino) over 7 days
};

// On this day DefiLlama's revenue for Overtime switched from fees (plus the SafeBox share of
// profitable pool rounds) to the full betting result, after OIP-265 made the treasury the only
// liquidity provider. Periods on either side of it aren't comparable, and betting-pool money
// only belongs to the house from this day on.
export const METHOD_CHANGE = Date.UTC(2026, 6, 21) / 1000;

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
    '0x1777c6d588fd931751762836811529c0073d6376', // treasury, sole liquidity provider since OIP-265
    '0xdac09f37e132d91b962f30e6ec40d2d08b82b0fa'  // Safe on Ethereum; its OVER is in DefiLlama's Overtime treasury total
  ],
  // SafeBoxBuyback inventory on the chains listed in DefiLlama's Overtime adapter.
  buybackContracts: {
    optimism: '0x679c0174f6c288c4bcd5c95c9ec99d50357c59e7',
    base: '0xd5679539c29eebe69347ace5deef867b19dba7b7'
  },
  // Holders that are not circulating supply (bridge pools that back tokens on other chains).
  // Holders whose explorer name matches LOCKED_NAME are detected automatically as well.
  locked: { ethereum: ['0x9054f2df5f2ac59b39a175c27a00165989d17d2b'] }, // Chainlink LockReleaseTokenPool
  snapshotSpace: 'thalesgov.eth',
  // USDC sportsbook liquidity pools. Each round's capital sits in a round-pool contract
  // (round() → roundPools(round)); money already committed to open bets sits in the bet
  // contracts with the bettors' stakes and isn't counted.
  bettingPools: {
    optimism: { pool: '0x0fe1044Fc8C05482102Db14368fE88791E9B8698', usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
    arbitrum: { pool: '0x22D180F39A0eB66098cf839AF5e3C6b009383B6A', usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
    base:     { pool: '0xf86e90412F52fDad8aD8D1aa2dA5B2C9a7e5f018', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }
  },
  // OVER-collateral sportsbook pools, same round design. The treasury is their only liquidity
  // provider too, so OVER in them belongs to the house, not the free float.
  overPools: {
    optimism: '0x59a7A8Ae9d58D69a69b6A24770EC771110647226',
    arbitrum: '0xc5f5186b46c84bF63a9e166bfa2175D9bc391ce2',
    base:     '0xB4199DC163F3206643649E117A816ad0DECb6C3B'
  }
};

// The rest of the house's money, read straight from each chain: the treasury wallets' stablecoins,
// ETH and BTC (DefiLlama's treasury figure doesn't cover Base); the sportsbook pools in ETH and BTC,
// whose only liquidity provider is the treasury too; and the casino games and Speed Markets, which
// each hold a bankroll the treasury funds. Contract addresses are from Overtime's registry
// (v2.contracts.overtime.io), as DefiLlama's Overtime adapter lists them. Tokens: [address, decimals].
const USDC6 = a => [a, 6];
export const HOUSE = {
  tokens: {
    ethereum: {
      stable: { USDC: USDC6('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), USDT: USDC6('0xdac17f958d2ee523a2206206994597c13d831ec7') },
      eth: { WETH: ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 18] },
      btc: { WBTC: ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', 8], cbBTC: ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 8] }
    },
    optimism: {
      stable: { USDC: USDC6('0x0b2c639c533813f4aa9d7837caf62653d097ff85'), 'USDC.e': USDC6('0x7f5c764cbc14f9669b88837ca1490cca17c31607'), USDT: USDC6('0x94b008aa00579c1307b0ef2c499ad98a8ce58e58') },
      eth: { WETH: ['0x4200000000000000000000000000000000000006', 18] },
      btc: { WBTC: ['0x68f180fcce6836688e9084f035309e29bf0a2095', 8] }
    },
    arbitrum: {
      stable: { USDC: USDC6('0xaf88d065e77c8cc2239327c5edb3a432268e5831'), 'USDC.e': USDC6('0xff970a61a04b1ca14834a43f5de4533ebddb5cc8'), USDT: USDC6('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9') },
      eth: { WETH: ['0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 18] },
      btc: { WBTC: ['0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', 8], cbBTC: ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 8] }
    },
    base: {
      stable: { USDC: USDC6('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), USDbC: USDC6('0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca') },
      eth: { WETH: ['0x4200000000000000000000000000000000000006', 18] },
      btc: { cbBTC: ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 8] }
    }
  },
  // Sportsbook pools in ETH and BTC: the same round design as the USDC and OVER pools.
  otherPools: {
    optimism: [{ asset: 'eth', token: 'WETH', pool: '0x4f2822D4e60af7f9F70E7e45BC1941fe3461231e' }],
    arbitrum: [{ asset: 'eth', token: 'WETH', pool: '0xcB4728a1789B87E05c813B68DBc5E6A98a4856bA' }, { asset: 'btc', token: 'WBTC', pool: '0xbD08D8F8c17C22fb0a12Fe490F38f40c59B60d2A' }],
    base:     [{ asset: 'eth', token: 'WETH', pool: '0xcc4ED8cD7101B512B134360ED3cCB759caB33f17' }, { asset: 'btc', token: 'cbBTC', pool: '0x8d4f838327DedFc735e202731358AcFc260c207a' }]
  },
  // Casino games (each holds its own bankroll; the newer games share one) and Speed Markets.
  games: {
    optimism: {
      Dice: '0x278a57140870E8d697a2Bf7321fFd212c4243aDc', Roulette: '0x4ab51a404e6D37141b08b872a3382406B227fEa7', Baccarat: '0xf2680aA6A4D9E354A3C65DF035552A7f708Ba0cA',
      Blackjack: '0xf8c6314408BF0D9B0F790b1Ff88FDF4b29097AF2', Slots: '0xeC5757736E10500cC243a1B43a41bb973717298e', 'Casino shared bankroll': '0x4BACE3b2BC955C11166e35673c71Be1593b42F80',
      'Speed Markets': '0xE16B8a01490835EC1e76bAbbB3Cadd8921b32001', 'Chained Speed Markets': '0xFf8Cf5ABF583D0979C0B9c35d62dd1fD52cce7C7'
    },
    arbitrum: {
      Dice: '0xB444b352c3f070Bc4419EC732B5555847F477ab2', Roulette: '0xc9DF7fe74ff692D3c4D8259b9aD42f17a93E022b', Baccarat: '0x94f1834c60504D6EF01A74D8b7605ef61ac21C9d',
      Blackjack: '0x15EC8D1DFe47a2C4818dFDE8db2738aF48D26012', Slots: '0x0bE99020775d3a13c7649ee04a496BCc045d0Ea6', 'Casino shared bankroll': '0xA9d5789824aBc53d52224BA6D4eF6d41E99d8699',
      'Speed Markets': '0x02D0123a89Ae6ef27419d5EBb158d1ED4Cf24FA3', 'Chained Speed Markets': '0xe92B4c614b04c239d30c31A7ea1290AdDCb8217D'
    },
    base: {
      Dice: '0x2C1443084574a3Bd3D61c00aD7fc504eD3703eC2', Roulette: '0x18A852273002Cc23264B4B0D7EEd7A171509fc63', Baccarat: '0x1e20B82a849DA8797B775B4f3C97119d67198DC4',
      Blackjack: '0x1500b398AD5F6a0AdA60D1f2b433126bBFE9B0FC', Slots: '0x8B09Fc184eE075270244ad33FEF2B153e37911A0', 'Casino shared bankroll': '0xab487C74Bd9fb88Cea5D39F25C6a15C4A7734055',
      'Speed Markets': '0x85b827d133FEDC36B844b20f4a198dA583B25BAA', 'Chained Speed Markets': '0x6848F001ddDb4442d352C495c7B4a231e3889b70'
    }
  }
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

export const ANNOTATIONS = [{ t: METHOD_CHANGE, label: 'OIP-265' }];
