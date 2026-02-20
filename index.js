require('dotenv').config();
const { createPublicClient, createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

/* ───────── helpers ───────── */

function log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }
function logErr(tag, e) {
  // ← ВСЕГДА логируем ошибки
  const text = e?.shortMessage || e?.message || JSON.stringify(e);
  console.error(`[${new Date().toISOString()}] ❌ ${tag}: ${text}`);
}

function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

/* ───────── client ───────── */

function getNadoClient({ privateKey }) {
  const pk =
    typeof privateKey === 'string' && !privateKey.startsWith('0x')
      ? `0x${privateKey}`
      : privateKey;

  const account     = privateKeyToAccount(pk);
  const chainConfig = CHAIN_ENV_TO_CHAIN.inkMainnet;

  const publicClient = createPublicClient({
    chain: chainConfig,
    transport: http(),
  });
  const walletClient = createWalletClient({
    account,
    chain: chainConfig,
    transport: http(),
  });

  return createNadoClient('inkMainnet', { publicClient, walletClient });
}

/* ───────── config ───────── */

const PRODUCT_IDS  = [1, 2];
const SPREAD_PCT   = 0.00015;
const ORDER_SIZE   = '15';
const TICK_MS      = 200;
const MIN_BALANCE  = 1;          // минимальный баланс (USDC и т.п.)

/* ───────── bot ───────── */

async function runBot() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return log('ERROR: PRIVATE_KEY не задан');

  const nadoClient = getNadoClient({ privateKey });
  const address    = nadoClient.context.walletClient?.account?.address;
  if (!address) return log('ERROR: не удалось получить адрес кошелька');

  log(`Кошелёк: ${address}`);

  const defaultAppendix = String(
    packOrderAppendix({ orderExecutionType: 'default' }),
  );
  const lastBidAsk = new Map();

  /* ── 1. ПРОВЕРКА БАЛАНСА ── */

  async function checkBalance() {
    try {
      // Пробуем несколько вариантов API (зависит от версии SDK)
      let balance = null;

      // Вариант A — getAccountInfo / getBalance
      if (typeof nadoClient.account?.getAccountInfo === 'function') {
        const info = await nadoClient.account.getAccountInfo({ address });
        balance = toNum(info?.balance ?? info?.collateral ?? info?.equity);
        log(`[getAccountInfo] Баланс: ${balance}`);
      }
      // Вариант B — getPortfolio
      else if (typeof nadoClient.account?.getPortfolio === 'function') {
        const portfolio = await nadoClient.account.getPortfolio({ address });
        balance = toNum(portfolio?.balance ?? portfolio?.collateral);
        log(`[getPortfolio] Баланс: ${balance}`);
      }
      // Вариант C — getBalance
      else if (typeof nadoClient.account?.getBalance === 'function') {
        const res = await nadoClient.account.getBalance({ address });
        balance = toNum(res?.balance ?? res);
        log(`[getBalance] Баланс: ${balance}`);
      }
      // Вариант D — перебираем все доступные методы account.*
      else {
        const methods = nadoClient.account
          ? Object.keys(nadoClient.account)
          : [];
        log(`⚠️  Не найден метод баланса. Доступные методы account: [${methods.join(', ')}]`);

        // Также выводим все namespace клиента
        const namespaces = Object.keys(nadoClient).filter(
          (k) => typeof nadoClient[k] === 'object' && nadoClient[k] !== null,
        );
        log(`   Namespaces клиента: [${namespaces.join(', ')}]`);

        // Пытаемся вызвать первый «похожий» метод
        for (const method of methods) {
          if (/balance|info|portfolio|collateral|equity/i.test(method)) {
            try {
              const res = await nadoClient.account[method]({ address });
              log(`   account.${method}() → ${JSON.stringify(res).slice(0, 300)}`);
              balance = toNum(res?.balance ?? res?.collateral ?? res);
            } catch (inner) {
              logErr(`account.${method}`, inner);
            }
          }
        }
      }

      if (balance === null || balance === undefined) {
        log('⚠️  Не удалось определить баланс — попробуем ставить ордера и смотреть на ошибку');
        return true; // пробуем дальше
      }

      if (balance < MIN_BALANCE) {
        log(`⛔ Баланс (${balance}) < ${MIN_BALANCE}. Нужно пополнить депозит на Nado.`);
        return false;
      }

      log(`✅ Баланс: ${balance}`);
      return true;
    } catch (e) {
      logErr('checkBalance', e);
      return false;
    }
  }

  /* ── 2. ЦЕНЫ ── */

  async function fetchPrices() {
    try {
      const { marketPrices } = await nadoClient.market.getLatestMarketPrices({
        productIds: PRODUCT_IDS,
      });

      for (const mp of marketPrices) {
        const bid = toNum(mp.bid);
        const ask = toNum(mp.ask);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          lastBidAsk.set(mp.productId, { bid, ask, mid: (bid + ask) / 2 });
        }
      }

      log(`Prices fetched: ${lastBidAsk.size} products`);
    } catch (e) {
      logErr('fetchPrices', e);   // ← теперь ошибка ВИДНА
    }
  }

  /* ── 3. ОРДЕРА ── */

  function getExpirationSec() {
    return Math.floor(Date.now() / 1000) + 86400;
  }

  async function runTick() {
    await fetchPrices();

    const exp = String(getExpirationSec());

    // cancel existing
    try {
      await nadoClient.market.cancelProductOrders({ productIds: PRODUCT_IDS });
    } catch (e) {
      logErr('cancelOrders', e);  // ← видим ошибку
    }

    for (const productId of PRODUCT_IDS) {
      const book = lastBidAsk.get(productId);
      if (!book || !Number.isFinite(book.mid) || book.mid <= 0) {
        log(`⚠️  Нет mid для productId=${productId}, пропускаю`);
        continue;
      }

      const buyPrice  = (Math.floor(book.mid * (1 - SPREAD_PCT) * 1e6) / 1e6).toFixed(6);
      const sellPrice = (Math.ceil(book.mid * (1 + SPREAD_PCT) * 1e6) / 1e6).toFixed(6);

      // ── BUY ──
      try {
        const txBuy = await nadoClient.market.placeOrder({
          productId,
          order: {
            price:      buyPrice,
            amount:     ORDER_SIZE,               // положительный = buy
            expiration: exp,
            appendix:   defaultAppendix,
          },
        });
        log(`✅ BUY  pid=${productId} price=${buyPrice} tx=${txBuy?.hash ?? JSON.stringify(txBuy).slice(0, 120)}`);
      } catch (e) {
        logErr(`placeOrder BUY pid=${productId}`, e);  // ← ВИДИМ причину
      }

      // ── SELL ──
      try {
        const txSell = await nadoClient.market.placeOrder({
          productId,
          order: {
            price:      sellPrice,
            amount:     String(-Number(ORDER_SIZE)),  // отрицательный = sell
            expiration: exp,
            appendix:   defaultAppendix,
          },
        });
        log(`✅ SELL pid=${productId} price=${sellPrice} tx=${txSell?.hash ?? JSON.stringify(txSell).slice(0, 120)}`);
      } catch (e) {
        logErr(`placeOrder SELL pid=${productId}`, e);  // ← ВИДИМ причину
      }
    }
  }

  /* ── 4. ЗАПУСК ── */

  log('🚀 Проверяю баланс перед стартом…');

  const hasBalance = await checkBalance();
  if (!hasBalance) {
    log('⛔ Бот остановлен: нет баланса. Пополните депозит в Nado и перезапустите.');
    return;
  }

  await fetchPrices();

  if (lastBidAsk.size === 0) {
    log('⚠️  Не получил ни одной цены. Проверьте PRODUCT_IDS и доступность API.');
  }

  log('✅ Запускаю цикл маркетмейкинга');

  setInterval(() => {
    runTick().catch((e) => logErr('runTick', e));
  }, TICK_MS);

  // мониторинг
  setInterval(async () => {
    const entries = Array.from(lastBidAsk.entries())
      .map(([pid, v]) => `pid${pid}=${v.mid.toFixed(2)}`)
      .join(' | ');
    log(`Mid: ${entries || '—'}`);
  }, 60_000);
}

runBot().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});