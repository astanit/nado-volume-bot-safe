require('dotenv').config();
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

function getNadoClient({ privateKey }) {
  const pk = typeof privateKey === 'string' && !privateKey.startsWith('0x') ? `0x${privateKey}` : privateKey;
  const account = privateKeyToAccount(pk);
  const chainConfig = CHAIN_ENV_TO_CHAIN.inkMainnet;
  const publicClient = createPublicClient({ chain: chainConfig, transport: http() });
  const walletClient = createWalletClient({ account, chain: chainConfig, transport: http() });
  return createNadoClient('inkMainnet', { publicClient, walletClient });
}

const PRODUCT_IDS = [1, 2];
const SPREAD_PCT = 0.00015;
const ORDER_SIZE = '15';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

function runBot() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return log('ERROR: PRIVATE_KEY не задан');

  const nadoClient = getNadoClient({ privateKey });
  const address = nadoClient.context.walletClient?.account?.address;
  if (!address) return log('ERROR: нет адреса');

  const defaultAppendix = String(packOrderAppendix({ orderExecutionType: 'default' }));
  const lastBidAsk = new Map();

  function getExpirationSec() {
    return Math.floor(Date.now() / 1000) + 86400;
  }

  async function fetchPrices() {
    try {
      const { marketPrices } = await nadoClient.market.getLatestMarketPrices({ productIds: PRODUCT_IDS });
      for (const mp of marketPrices) {
        const bid = toNum(mp.bid);
        const ask = toNum(mp.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask)) {
          lastBidAsk.set(mp.productId, { mid: (bid + ask) / 2 });
        }
      }
    } catch (e) {}
  }

  async function runTick() {
    await fetchPrices();

    const exp = String(getExpirationSec());

    // cancel
    try { await nadoClient.market.cancelProductOrders({ productIds: PRODUCT_IDS }); } catch {}

    for (const productId of PRODUCT_IDS) {
      const book = lastBidAsk.get(productId);
      if (!book || !Number.isFinite(book.mid)) continue;

      const buyPrice = Math.floor(book.mid * (1 - SPREAD_PCT) * 1e6) / 1e6;
      const sellPrice = Math.ceil(book.mid * (1 + SPREAD_PCT) * 1e6) / 1e6;

      // buy
      await nadoClient.market.placeOrder({
        productId,
        order: { price: String(buyPrice), amount: ORDER_SIZE, expiration: exp, appendix: defaultAppendix }
      }).catch(() => {});

      // sell
      await nadoClient.market.placeOrder({
        productId,
        order: { price: String(sellPrice), amount: String(-Number(ORDER_SIZE)), expiration: exp, appendix: defaultAppendix }
      }).catch(() => {});
    }
  }

  log('🚀 Запускаю маркетмейкинг сразу (баланс в приложении уже есть)');

  // первый fetch + запуск цикла
  fetchPrices().then(() => {
    setInterval(() => runTick().catch(() => {}), 200);
  });

  // тихий лог каждые 60 сек
  setInterval(async () => {
    const mid = lastBidAsk.size ? Array.from(lastBidAsk.values())[0].mid : null;
    log(`Mid: ${Number.isFinite(mid) ? mid.toFixed(2) : '—'} | Ордера ставятся каждые 200 мс`);
  }, 60000);
}

try { runBot(); } catch (e) { console.error('FATAL:', e); }