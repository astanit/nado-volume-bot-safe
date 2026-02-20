/**
 * Nado Volume Bot — финальная версия 2026
 */
require('dotenv').config();
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

function getNadoClient({ privateKey, chain }) {
  const chainEnv = chain || 'inkMainnet';
  const pk = typeof privateKey === 'string' && !privateKey.startsWith('0x') ? `0x${privateKey}` : privateKey;
  const account = privateKeyToAccount(pk);
  const chainConfig = CHAIN_ENV_TO_CHAIN[chainEnv];
  const publicClient = createPublicClient({ chain: chainConfig, transport: http() });
  const walletClient = createWalletClient({ account, chain: chainConfig, transport: http() });
  return createNadoClient(chainEnv, { publicClient, walletClient });
}

// --- Конфиг ---
const PRODUCT_IDS = [1, 2];
const QUOTE_PRODUCT_ID = 0;
const SPREAD_PCT = 0.00015;
const ORDER_SIZE = '15';
const MIN_BALANCE_USDC = 30;
const TICK_MS = 200;
const LOG_INTERVAL_MS = 60 * 1000;

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

  const nadoClient = getNadoClient({ privateKey, chain: 'inkMainnet' });
  const address = nadoClient.context.walletClient?.account?.address;
  if (!address) return log('ERROR: нет адреса');

  const subaccountOwner = address;
  const possibleNames = ['default', 'sub', '']; // пробуем все варианты
  let subaccountName = 'default';

  const defaultAppendix = String(packOrderAppendix({ orderExecutionType: 'default' }));

  const lastBidAsk = new Map();
  let volumeQuoteLast5Min = 0;
  let lastVolumeResetTime = Date.now();
  let balanceUsdc = 0;
  let hasStarted = false;
  let debugCount = 0;

  function getExpirationSec() {
    return Math.floor(Date.now() / 1000) + 86400;
  }

  async function getBalanceUsdc() {
    for (const name of possibleNames) {
      try {
        const summary = await nadoClient.subaccount.getSubaccountSummary({
          subaccountOwner,
          subaccountName: name,
        });

        if (!summary) continue;

        if (debugCount < 5) {
          debugCount++;
          log(`DEBUG summary для subaccountName="${name}": ${JSON.stringify(summary, null, 2)}`);
        }

        // 1. Пробуем массив balances
        if (summary.balances && Array.isArray(summary.balances)) {
          const quote = summary.balances.find(b => Number(b.productId) === QUOTE_PRODUCT_ID || b.asset === 'USDT0' || b.asset === 'USDC0');
          if (quote) {
            const bal = toNum(quote.available || quote.free || quote.amount || quote.equity || quote.total || quote.settled || quote.margin || 0);
            if (bal > 0) {
              subaccountName = name;
              log(`✅ Баланс найден в subaccountName="${name}" → ${bal.toFixed(2)} USDC0`);
              return bal;
            }
          }
        }

        // 2. Пробуем top-level поля (как в твоём дашборде)
        const topBal = toNum(
          summary.availableMargin ||
          summary.totalEquity ||
          summary.equity ||
          summary.available ||
          summary.balance ||
          0
        );
        if (topBal > 0) {
          subaccountName = name;
          log(`✅ Баланс найден (top-level) в subaccountName="${name}" → ${topBal.toFixed(2)} USDC0`);
          return topBal;
        }
      } catch (e) {}
    }
    return 0;
  }

  async function fetchPrices() {
    try {
      const { marketPrices } = await nadoClient.market.getLatestMarketPrices({ productIds: PRODUCT_IDS });
      for (const mp of marketPrices) {
        const bid = toNum(mp.bid);
        const ask = toNum(mp.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask)) {
          lastBidAsk.set(mp.productId, { bid, ask, mid: (bid + ask) / 2 });
        }
      }
    } catch (e) {
      log(`ERROR prices: ${e.message || e}`);
    }
  }

  async function runTick() {
    if (balanceUsdc < MIN_BALANCE_USDC) return;

    await fetchPrices();

    const exp = String(getExpirationSec());

    try {
      await nadoClient.market.cancelProductOrders({ productIds: PRODUCT_IDS });
    } catch (e) {
      if (!String(e.message || '').includes('2024')) log(`cancel error: ${e.message || e}`);
    }

    for (const productId of PRODUCT_IDS) {
      const book = lastBidAsk.get(productId);
      if (!book || !Number.isFinite(book.mid)) continue;

      const buyPrice = Math.floor(book.mid * (1 - SPREAD_PCT) * 1e6) / 1e6;
      const sellPrice = Math.ceil(book.mid * (1 + SPREAD_PCT) * 1e6) / 1e6;

      await nadoClient.market.placeOrder({
        productId,
        order: { price: String(buyPrice), amount: ORDER_SIZE, expiration: exp, appendix: defaultAppendix }
      }).catch(() => {});

      await nadoClient.market.placeOrder({
        productId,
        order: { price: String(sellPrice), amount: String(-Number(ORDER_SIZE)), expiration: exp, appendix: defaultAppendix }
      }).catch(() => {});
    }
  }

  // Логи каждые 60 сек + авто-запуск когда баланс появился
  setInterval(async () => {
    balanceUsdc = await getBalanceUsdc();

    const now = Date.now();
    if (now - lastVolumeResetTime >= 5 * 60 * 1000) {
      volumeQuoteLast5Min = 0;
      lastVolumeResetTime = now;
    }

    const mid = lastBidAsk.size > 0 ? Array.from(lastBidAsk.values())[0].mid : null;
    const midStr = Number.isFinite(mid) ? mid.toFixed(2) : '—';
    const vol = Math.round(volumeQuoteLast5Min * 100) / 100;

    log(`Mid: ${midStr} | Объём за 5 мин: ${vol} USDC | Баланс: ${balanceUsdc.toFixed(2)} USDC0 (sub: ${subaccountName})`);

    if (balanceUsdc >= MIN_BALANCE_USDC && !hasStarted) {
      hasStarted = true;
      log('🚀 Баланс появился — запускаю маркетмейкинг!');
      await fetchPrices();
      setInterval(() => runTick().catch(() => {}), TICK_MS);
    }
  }, LOG_INTERVAL_MS);

  log('Nado volume bot запущен (ожидаю баланс ≥ 30$)');
}

try {
  runBot();
} catch (e) {
  console.error('FATAL:', e);
}