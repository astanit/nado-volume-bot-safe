/**
 * Nado Volume Bot — по документации @nadohq/client (docs.nado.xyz)
 * SDK экспортирует createNadoClient; используем как getNadoClient для совместимости.
 * Orderbook: polling getLatestMarketPrices (в SDK нет client.on/subscribe для orderbook).
 */
require('dotenv').config();
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

// getNadoClient — алиас createNadoClient (официальный экспорт из @nadohq/client)
const getNadoClient = createNadoClient;

// --- Конфиг ---
const CHAIN_ENV = 'inkMainnet'; // Ink Mainnet
const PRODUCT_IDS = [1, 2]; // 1 = BTC-perp, 2 = ETH-perp
const SPREAD_PCT = 0.00015; // 0.015% от mid
const ORDER_SIZE = String(process.env.ORDER_SIZE || 15);
const TICK_MS = 200; // каждые 200 мс
const LOG_INTERVAL_MS = 60 * 1000; // лог каждые 60 сек
const VOLUME_WINDOW_MS = 5 * 60 * 1000; // объём за 5 мин

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function safeRun(fn) {
  try {
    return fn();
  } catch (e) {
    log(`ERROR: ${e && e.message ? e.message : String(e)}`);
    return undefined;
  }
}

function runBot() {
  const rawKey = process.env.PRIVATE_KEY;
  if (!rawKey) {
    log('ERROR: PRIVATE_KEY не задан в process.env.PRIVATE_KEY');
    process.exit(1);
  }
  const privateKey =
    typeof rawKey === 'string' && !rawKey.startsWith('0x') ? `0x${rawKey}` : rawKey;

  const chain = CHAIN_ENV_TO_CHAIN[CHAIN_ENV];
  const publicClient = createPublicClient({ chain, transport: http() });
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(),
  });

  const client = getNadoClient(CHAIN_ENV, {
    publicClient,
    walletClient,
  });

  const defaultAppendix = String(packOrderAppendix({ orderExecutionType: 'default' }));

  const lastBidAsk = new Map();
  let volumeQuoteLast5Min = 0;
  let lastVolumeResetTime = Date.now();
  let tickInterval = null;
  let logInterval = null;
  let reconnectScheduled = false;

  function getExpirationSec() {
    return Math.floor(Date.now() / 1000) + 86400;
  }

  function toNum(v) {
    if (v == null) return NaN;
    if (typeof v === 'object' && v != null && typeof v.toNumber === 'function')
      return v.toNumber();
    return Number(v);
  }

  async function fetchPrices() {
    try {
      const { marketPrices } = await client.market.getLatestMarketPrices({
        productIds: PRODUCT_IDS,
      });
      for (const mp of marketPrices) {
        const bid = toNum(mp.bid);
        const ask = toNum(mp.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask)) {
          lastBidAsk.set(mp.productId, { bid, ask, mid: (bid + ask) / 2 });
        }
      }
      reconnectScheduled = false;
    } catch (err) {
      log(`ERROR: getLatestMarketPrices ${err && err.message ? err.message : err}`);
      if (!reconnectScheduled) {
        reconnectScheduled = true;
        log('Авто-reconnect через 5 сек…');
        setTimeout(() => {
          fetchPrices().catch(() => {});
        }, 5000);
      }
    }
  }

  async function runTick() {
    const havePrices = PRODUCT_IDS.every((id) => lastBidAsk.has(id));
    if (!havePrices) {
      await fetchPrices();
      return;
    }

    const exp = String(getExpirationSec());

    try {
      await client.market.cancelProductOrders({ productIds: PRODUCT_IDS });
    } catch (err) {
      log(`ERROR: cancelProductOrders ${err && err.message ? err.message : err}`);
      return;
    }

    for (const productId of PRODUCT_IDS) {
      const book = lastBidAsk.get(productId);
      if (!book || !Number.isFinite(book.mid)) continue;
      const buyPrice = Math.floor(book.mid * (1 - SPREAD_PCT) * 1e6) / 1e6;
      const sellPrice = Math.ceil(book.mid * (1 + SPREAD_PCT) * 1e6) / 1e6;
      try {
        await client.market.placeOrder({
          productId,
          order: {
            price: String(buyPrice),
            amount: ORDER_SIZE,
            expiration: exp,
            appendix: defaultAppendix,
          },
        });
      } catch (err) {
        log(`ERROR: place buy ${productId} ${err && err.message ? err.message : err}`);
      }
      try {
        await client.market.placeOrder({
          productId,
          order: {
            price: String(sellPrice),
            amount: String(-Number(ORDER_SIZE)),
            expiration: exp,
            appendix: defaultAppendix,
          },
        });
      } catch (err) {
        log(`ERROR: place sell ${productId} ${err && err.message ? err.message : err}`);
      }
    }
  }

  function scheduleTick() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      runTick().catch((err) => {
        log(`ERROR: tick ${err && err.message ? err.message : err}`);
      });
    }, TICK_MS);
  }

  async function start() {
    await fetchPrices();
    scheduleTick();
  }

  if (logInterval) clearInterval(logInterval);
  logInterval = setInterval(() => {
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
    log(`Mid: ${midStr} | Размер ордера: ${ORDER_SIZE} | Объём за 5 мин: ${vol} USDC`);
  }, LOG_INTERVAL_MS);

  start().catch((err) => {
    log(`ERROR: start ${err && err.message ? err.message : err}`);
    log('Авто-reconnect через 5 сек…');
    setTimeout(() => start().catch(() => {}), 5000);
  });

  log(
    `Nado volume bot запущен. Chain: ${CHAIN_ENV}, products: ${PRODUCT_IDS.join(', ')}, spread: ${SPREAD_PCT * 100}%, ORDER_SIZE: ${ORDER_SIZE}`
  );
}

safeRun(runBot);
process.on('uncaughtException', (err) => {
  log(`FATAL: uncaughtException ${err && err.message ? err.message : err}`);
});
process.on('unhandledRejection', (reason) => {
  log(`FATAL: unhandledRejection ${reason}`);
});
