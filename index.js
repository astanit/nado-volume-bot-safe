/**
 * Nado Volume Bot — docs.nado.xyz 2026
 * getNadoClient({ privateKey, chain }) — обёртка над createNadoClient
 * SDK не имеет client.subscribe / client.on('orderbook') — используем polling getLatestMarketPrices
 */
require('dotenv').config();
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
  QUOTE_PRODUCT_ID,
} = require('@nadohq/client');

function getNadoClient({ privateKey, chain }) {
  const chainEnv = chain || 'inkMainnet';
  const pk =
    typeof privateKey === 'string' && !privateKey.startsWith('0x')
      ? `0x${privateKey}`
      : privateKey;
  const account = privateKeyToAccount(pk);
  const chainConfig = CHAIN_ENV_TO_CHAIN[chainEnv];
  const publicClient = createPublicClient({ chain: chainConfig, transport: http() });
  const walletClient = createWalletClient({
    account,
    chain: chainConfig,
    transport: http(),
  });
  return createNadoClient(chainEnv, { publicClient, walletClient });
}

// --- Конфиг ---
const PRODUCT_IDS = [1, 2]; // BTC-perp, ETH-perp
const SPREAD_PCT = 0.00015;
const ORDER_SIZE = '15';
const MIN_BALANCE_USDC = 30;
const TICK_MS = 200;
const LOG_INTERVAL_MS = 60 * 1000;
const VOLUME_WINDOW_MS = 5 * 60 * 1000;
const WAIT_LOG_MS = 10 * 1000;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function toNum(v) {
  if (v == null) return NaN;
  if (typeof v === 'object' && v != null && typeof v.toNumber === 'function')
    return v.toNumber();
  return Number(v);
}

function runBot() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    log('ERROR: PRIVATE_KEY не задан');
    process.exit(1);
  }

  const nadoClient = getNadoClient({
    privateKey,
    chain: 'inkMainnet',
  });

  const account = privateKeyToAccount(
    typeof privateKey === 'string' && !privateKey.startsWith('0x')
      ? `0x${privateKey}`
      : privateKey
  );
  const subaccountOwner = account.address;
  const subaccountName = 'default';

  const defaultAppendix = String(packOrderAppendix({ orderExecutionType: 'default' }));

  const lastBidAsk = new Map();
  let volumeQuoteLast5Min = 0;
  let lastVolumeResetTime = Date.now();
  let balanceUsdc = 0;
  let hasStarted = false;
  let tickInterval = null;
  let waitLogInterval = null;
  let reconnectTimeout = null;

  function getExpirationSec() {
    return Math.floor(Date.now() / 1000) + 86400;
  }

  async function getBalanceUsdc() {
    try {
      const summary = await nadoClient.subaccount.getSubaccountSummary({
        subaccountOwner,
        subaccountName,
      });
      if (!summary || !summary.balances) return 0;
      const quoteBal = summary.balances.find((b) => b.productId === QUOTE_PRODUCT_ID);
      if (!quoteBal) return 0;
      return toNum(quoteBal.amount);
    } catch (err) {
      log(`ERROR getSubaccountSummary: ${err && err.message ? err.message : err}`);
      scheduleReconnect();
      return 0;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimeout) return;
    log('Reconnect через 5 сек…');
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      runTick().catch(() => {});
    }, 5000);
  }

  async function fetchPrices() {
    try {
      const { marketPrices } = await nadoClient.market.getLatestMarketPrices({
        productIds: PRODUCT_IDS,
      });
      for (const mp of marketPrices) {
        const bid = toNum(mp.bid);
        const ask = toNum(mp.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask)) {
          lastBidAsk.set(mp.productId, { bid, ask, mid: (bid + ask) / 2 });
        }
      }
    } catch (err) {
      log(`ERROR getLatestMarketPrices: ${err && err.message ? err.message : err}`);
      scheduleReconnect();
    }
  }

  async function runTick() {
    if (balanceUsdc < MIN_BALANCE_USDC) return;

    const havePrices = PRODUCT_IDS.every((id) => lastBidAsk.has(id));
    if (!havePrices) {
      await fetchPrices();
      return;
    }

    const exp = String(getExpirationSec());

    try {
      await nadoClient.market.cancelProductOrders({ productIds: PRODUCT_IDS });
    } catch (err) {
      if (String(err?.code) !== '2024' && !String(err?.message || '').includes('2024')) {
        log(`ERROR cancelProductOrders: ${err && err.message ? err.message : err}`);
      }
      return;
    }

    for (const productId of PRODUCT_IDS) {
      const book = lastBidAsk.get(productId);
      if (!book || !Number.isFinite(book.mid)) continue;
      const buyPrice = Math.floor(book.mid * (1 - SPREAD_PCT) * 1e6) / 1e6;
      const sellPrice = Math.ceil(book.mid * (1 + SPREAD_PCT) * 1e6) / 1e6;
      try {
        await nadoClient.market.placeOrder({
          productId,
          order: {
            price: String(buyPrice),
            amount: ORDER_SIZE,
            expiration: exp,
            appendix: defaultAppendix,
          },
        });
      } catch (err) {
        if (String(err?.code) !== '2024' && !String(err?.message || '').includes('2024')) {
          log(`ERROR place buy ${productId}: ${err && err.message ? err.message : err}`);
        }
      }
      try {
        await nadoClient.market.placeOrder({
          productId,
          order: {
            price: String(sellPrice),
            amount: String(-Number(ORDER_SIZE)),
            expiration: exp,
            appendix: defaultAppendix,
          },
        });
      } catch (err) {
        if (String(err?.code) !== '2024' && !String(err?.message || '').includes('2024')) {
          log(`ERROR place sell ${productId}: ${err && err.message ? err.message : err}`);
        }
      }
    }
  }

  function startTickLoop() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => runTick().catch(() => {}), TICK_MS);
  }

  function startWaitLoop() {
    if (waitLogInterval) clearInterval(waitLogInterval);
    waitLogInterval = setInterval(() => log('Жду баланса...'), WAIT_LOG_MS);
  }

  function stopWaitLoop() {
    if (waitLogInterval) {
      clearInterval(waitLogInterval);
      waitLogInterval = null;
    }
  }

  async function balanceCheckLoop() {
    for (;;) {
      balanceUsdc = await getBalanceUsdc();
      if (balanceUsdc >= MIN_BALANCE_USDC) {
        stopWaitLoop();
        if (!hasStarted) {
          hasStarted = true;
          log(`Баланс ${balanceUsdc.toFixed(2)} USDC0 — запуск маркетмейкинга`);
          await fetchPrices();
          startTickLoop();
        }
      } else {
        if (!hasStarted) startWaitLoop();
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  setInterval(async () => {
    balanceUsdc = await getBalanceUsdc();
    const now = Date.now();
    if (now - lastVolumeResetTime >= VOLUME_WINDOW_MS) {
      volumeQuoteLast5Min = 0;
      lastVolumeResetTime = now;
    }
    const midFirst =
      PRODUCT_IDS.length > 0 && lastBidAsk.has(PRODUCT_IDS[0])
        ? lastBidAsk.get(PRODUCT_IDS[0]).mid
        : null;
    const midStr =
      midFirst != null && Number.isFinite(midFirst)
        ? String(Math.round(midFirst * 100) / 100)
        : '—';
    const vol = Math.round(volumeQuoteLast5Min * 100) / 100;
    log(`Mid: ${midStr} | Объём за 5 мин: ${vol} USDC | Баланс: ${balanceUsdc.toFixed(2)} USDC0`);
  }, LOG_INTERVAL_MS);

  balanceCheckLoop().catch((err) => {
    log(`ERROR: ${err && err.message ? err.message : err}`);
    setTimeout(() => balanceCheckLoop().catch(() => {}), 5000);
  });

  log('Nado volume bot запущен. chain: inkMainnet, ORDER_SIZE: 15, products: 1, 2');
}

try {
  runBot();
} catch (e) {
  console.error('ERROR:', e && e.message ? e.message : e);
}
process.on('uncaughtException', (err) => {
  log(`FATAL: ${err && err.message ? err.message : err}`);
});
process.on('unhandledRejection', (reason) => {
  log(`FATAL unhandledRejection: ${reason}`);
});
