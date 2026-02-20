require('dotenv').config();
const { createPublicClient, createWalletClient, http, parseUnits, formatUnits, getContract } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function diagnose() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { log('⛔ PRIVATE_KEY не задан'); process.exit(1); }

  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);
  const chainConfig = CHAIN_ENV_TO_CHAIN.inkMainnet;

  const publicClient = createPublicClient({ chain: chainConfig, transport: http() });
  const walletClient = createWalletClient({ account, chain: chainConfig, transport: http() });
  const client = createNadoClient('inkMainnet', { publicClient, walletClient });

  log('');
  log('══════════════════════════════════════════');
  log(`  Адрес кошелька: ${account.address}`);
  log('══════════════════════════════════════════');
  log('');

  // ═══ 1. ПОЛНЫЙ ДАМП SDK ═══
  log('── 1. ВСЕ методы SDK (полный список) ──');
  const allMethods = [];
  
  function dumpObj(obj, prefix = '') {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof val === 'function') {
        allMethods.push(path);
        log(`  📌 ${path}()`);
      } else if (typeof val === 'object' && val !== null && !path.includes('.context')) {
        // Идём на 1 уровень глубже
        if (prefix.split('.').length < 2) {
          dumpObj(val, path);
        }
      } else if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        log(`  📎 ${path} = ${String(val).slice(0, 200)}`);
      }
    }
  }
  
  dumpObj(client);
  log(`  Итого методов: ${allMethods.length}`);
  log('');

  await sleep(500);

  // ═══ 2. CONTEXT — ищем sub-account, vault address и т.д. ═══
  log('── 2. Context клиента ──');
  if (client.context) {
    const ctx = client.context;
    for (const k of Object.keys(ctx)) {
      const v = ctx[k];
      if (typeof v === 'string' || typeof v === 'number') {
        log(`  context.${k} = ${v}`);
      } else if (typeof v === 'object' && v !== null) {
        // Если это не огромный объект, дампим ключи
        const subKeys = Object.keys(v);
        if (subKeys.length < 20) {
          for (const sk of subKeys) {
            if (typeof v[sk] === 'string' || typeof v[sk] === 'number') {
              log(`  context.${k}.${sk} = ${v[sk]}`);
            }
          }
        } else {
          log(`  context.${k} = [object with ${subKeys.length} keys]`);
        }
      }
    }
  }
  log('');

  await sleep(500);

  // ═══ 3. ИЩЕМ DEPOSIT / REGISTER МЕТОДЫ ═══
  log('── 3. Поиск deposit/register/vault методов ──');
  
  const depositMethods = allMethods.filter(m =>
    /deposit|register|create|init|vault|approve|sub.?account|collateral|fund/i.test(m)
  );
  
  if (depositMethods.length > 0) {
    log(`  Найдены: [${depositMethods.join(', ')}]`);
  } else {
    log('  ❌ Ни одного метода deposit/register не найдено');
  }
  log('');

  // ═══ 4. ПРОБУЕМ ВЫЗВАТЬ НАЙДЕННЫЕ МЕТОДЫ ═══
  log('── 4. Пробуем вызвать методы ──');
  
  for (const methodPath of depositMethods) {
    const parts = methodPath.split('.');
    let fn = client;
    for (const p of parts) fn = fn[p];
    
    if (typeof fn !== 'function') continue;
    
    // Пробуем разные варианты аргументов
    const variants = [
      {},
      { address: account.address },
      { amount: '0' },
      { address: account.address, amount: '0' },
    ];
    
    for (const args of variants) {
      try {
        log(`  Пробую ${methodPath}(${JSON.stringify(args)}) ...`);
        const res = await fn(args);
        const dump = JSON.stringify(res, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v
        ).slice(0, 500);
        log(`  ✅ ${methodPath} → ${dump}`);
        break;
      } catch (e) {
        const msg = (e?.message || '').slice(0, 200);
        log(`     → ${msg}`);
      }
    }
    
    await sleep(1000);
  }
  log('');

  // ═══ 5. ИЩЕМ АДРЕСА КОНТРАКТОВ NADO В КОНФИГЕ ═══
  log('── 5. Адреса контрактов из SDK ──');
  
  function findAddresses(obj, prefix = '', depth = 0) {
    if (depth > 3 || !obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof val === 'string' && /^0x[a-fA-F0-9]{40}$/.test(val)) {
        log(`  📍 ${path} = ${val}`);
      } else if (typeof val === 'object' && val !== null) {
        findAddresses(val, path, depth + 1);
      }
    }
  }
  
  findAddresses(CHAIN_ENV_TO_CHAIN.inkMainnet, 'chainConfig');
  if (client.context) findAddresses(client.context, 'context');
  log('');

  await sleep(500);

  // ═══ 6. ПРОВЕРЯЕМ ON-CHAIN — был ли deposit на контракт ═══
  log('── 6. On-chain проверка ──');
  
  // Проверяем нативный баланс
  try {
    const ethBal = await publicClient.getBalance({ address: account.address });
    log(`  ETH баланс: ${formatUnits(ethBal, 18)}`);
  } catch (e) {
    log(`  ❌ getBalance: ${e.message}`);
  }

  // Распространённые адреса USDC на Ink
  const possibleUSDC = [
    '0x0200C29006150606B650577BBE7B6248F6995ABD', // возможный USDC на Ink
    '0xF1815bd50389c46847f0Bda824eC8da914045D14', // другой
  ];

  const erc20Abi = [
    { name: 'balanceOf', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }] },
    { name: 'allowance', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }] },
    { name: 'symbol', type: 'function', stateMutability: 'view',
      inputs: [], outputs: [{ name: '', type: 'string' }] },
    { name: 'decimals', type: 'function', stateMutability: 'view',
      inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  ];

  for (const tokenAddr of possibleUSDC) {
    try {
      const token = getContract({
        address: tokenAddr,
        abi: erc20Abi,
        client: publicClient,
      });
      const [symbol, decimals, balance] = await Promise.all([
        token.read.symbol(),
        token.read.decimals(),
        token.read.balanceOf([account.address]),
      ]);
      log(`  Token ${tokenAddr}: ${symbol} balance = ${formatUnits(balance, decimals)}`);
    } catch (e) {
      log(`  Token ${tokenAddr}: не найден или ошибка`);
    }
  }
  log('');

  // ═══ 7. ПРОВЕРЯЕМ ВСЕ account/user МЕТОДЫ ═══
  log('── 7. Все методы с данными об аккаунте ──');
  
  const accountMethods = allMethods.filter(m =>
    /account|user|trader|balance|position|portfolio|info|state|status/i.test(m)
  );
  
  for (const methodPath of accountMethods) {
    const parts = methodPath.split('.');
    let fn = client;
    for (const p of parts) fn = fn[p];
    if (typeof fn !== 'function') continue;

    try {
      log(`  ${methodPath}({ address }) ...`);
      const res = await fn({ address: account.address });
      const dump = JSON.stringify(res, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v
      ).slice(0, 500);
      log(`  ✅ → ${dump}`);
    } catch (e) {
      log(`  ❌ → ${(e?.message || '').slice(0, 200)}`);
    }

    await sleep(1000);
  }
  log('');

  // ═══ 8. ИТОГ ═══
  log('══════════════════════════════════════════════════════');
  log('  ДИАГНОСТИКА ЗАВЕРШЕНА');
  log('  Скопируйте ВЕСЬ лог и отправьте — я скажу что делать');
  log('══════════════════════════════════════════════════════');
}

diagnose().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});