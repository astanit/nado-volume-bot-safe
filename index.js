/**
 * Nado Volume Bot — максимальный объём без потерь
 * Chain: Ink Mainnet. @nadohq/client
 * Product IDs 1, 2 — BTC-perp и ETH-perp (или актуальные на app.nado.xyz)
 * Для депозита 50$ размер 15 USDC0 — безопасно.
 */
require('dotenv').config();
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
  ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS,
  subaccountToHex,
} = require('@nadohq/client');

let WebSocketImpl;
try {
  WebSocketImpl = globalThis.WebSocket;
} catch (_) {}
if (!WebSocketImpl) {
  try {
    WebSocketImpl = require('ws');
  } catch (_) {
    throw new Error('WebSocket: Node 22+ или npm install ws');
  }
}

// --- Конфиг ---
const CHAIN_ENV = 'inkMainnet'; // Ink Mainnet
const PRODUCT_IDS = [1, 2]; // BTC-perp, ETH-perp (проверь на app.nado.xyz)
const SPREAD_PCT = 0.00015; // 0.015% от mid
// Для депозита 50$ размер 15 USDC0 — безопасно. Настраивается через .env ORDER_SIZE
const ORDER_SIZE = process.env.ORDER_SIZE || '15';
const TICK_MS_MIN = 180;
const TICK_MS_MAX = 250;
const WS_RECONNECT_MS = 30000;
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
    log('ERROR: PRIVATE_KEY не задан в .env');
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

  const client = createNadoClient(CHAIN_ENV, {
    publicClient,
    walletClient,
  });

  const defaultAppendix = String(packOrderAppendix({ orderExecutionType: 'default' }));
  const subaccountHex = subaccountToHex({
    subaccountOwner: account.address,
    subaccountName: process.env.SUBACCOUNT_NAME || '',
  });

  const lastBidAsk = new Map();
  let volumeQuoteLast5Min = 0;
  let lastVolumeResetTime = Date.now();
  let subscribeId = 0;
  let ws = null;
  let scheduledClose = false;
  let wsReconnectTimer = null;

  function getExpirationSec() {
    return Math.floor(Date.now() / 1000) + 86400;
  }

  function buildSubscribeMessage(streamType, streamParams) {
    const params = client.ws.subscription.buildSubscriptionParams(streamType, streamParams);
    return client.ws.subscription.buildSubscriptionMessage(++subscribeId, 'subscribe', params);
  }

  function connectWs() {
    const url = ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS[CHAIN_ENV];
    if (ws && (ws.readyState === 1 || ws.readyState === 0)) {
      try {
        ws.close();
      } catch (_) {}
      ws = null;
    }
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      log(`ERROR: WS connect ${err && err.message ? err.message : err}`);
      scheduleReconnect();
      return;
    }
    ws.on('open', () => {
      log('WS: подключено');
      subscribeId = 0;
      for (const productId of PRODUCT_IDS) {
        const msg = buildSubscribeMessage('best_bid_offer', { product_id: productId });
        ws.send(JSON.stringify(msg));
      }
      const fillMsg = buildSubscribeMessage('fill', { subaccount: subaccountHex });
      ws.send(JSON.stringify(fillMsg));
    });
    ws.on('message', (data) => {
      safeRun(() => {
        const payload =
          typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
        if (payload.type === 'best_bid_offer') {
          const productId = payload.product_id;
          const bid = parseFloat(payload.bid_price);
          const ask = parseFloat(payload.ask_price);
          if (Number.isFinite(bid) && Number.isFinite(ask)) {
            lastBidAsk.set(productId, { bid, ask, mid: (bid + ask) / 2 });
          }
        } else if (payload.type === 'fill') {
          const price = parseFloat(payload.price);
          const filledQty = parseFloat(payload.filled_qty);
          if (Number.isFinite(price) && Number.isFinite(filledQty) && filledQty !== 0) {
            volumeQuoteLast5Min += Math.abs(price * filledQty);
          }
        }
      });
    });
    ws.on('error', (err) => {
      log(`ERROR: WS ${err && err.message ? err.message : err}`);
    });
    ws.on('close', () => {
      log('WS: закрыто');
      ws = null;
      if (scheduledClose) {
        scheduledClose = false;
        setTimeout(connectWs, 100);
      } else {
        scheduleReconnect();
      }
    });
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      log('WS: переподключение…');
      connectWs();
    }, WS_RECONNECT_MS);
  }

  connectWs();
  setInterval(() => {
    if (ws && ws.readyState === 1) {
      scheduledClose = true;
      try {
        ws.close();
      } catch (_) {}
    }
  }, WS_RECONNECT_MS);

  function nextTickDelay() {
    return TICK_MS_MIN + Math.floor(Math.random() * (TICK_MS_MAX - TICK_MS_MIN + 1));
  }

  function tick() {
    runTick()
      .catch((err) => {
        log(`ERROR: tick ${err && err.message ? err.message : err}`);
      })
      .finally(() => {
        setTimeout(tick, nextTickDelay());
      });
  }

  function toNum(v) {
    if (v == null) return NaN;
    if (typeof v === 'object' && v != null && typeof v.toNumber === 'function')
      return v.toNumber();
    return Number(v);
  }

  async function runTick() {
    const havePrices = PRODUCT_IDS.every((id) => lastBidAsk.has(id));
    if (!havePrices) {
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
      } catch (err) {
        log(`ERROR: getLatestMarketPrices ${err && err.message ? err.message : err}`);
        return;
      }
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

  // Лог каждые 60 сек: Mid | Размер ордера | Объём за 5 мин
  setInterval(() => {
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

  tick();
  log(
    `Nado volume bot запущен. Chain: ${CHAIN_ENV}, products: ${PRODUCT_IDS.join(', ')}, spread: ${SPREAD_PCT * 100}%, ORDER_SIZE: ${ORDER_SIZE} USDC0`
  );
}

safeRun(runBot);
if (process.listeners('uncaughtException').length === 0) {
  process.on('uncaughtException', (err) => {
    log(`FATAL: ${err && err.message ? err.message : err}`);
  });
}
if (process.listeners('unhandledRejection').length === 0) {
  process.on('unhandledRejection', (reason) => {
    log(`FATAL: unhandledRejection ${reason}`);
  });
}
