require('dotenv').config();
const {
  createPublicClient, createWalletClient, http,
  formatUnits, parseUnits, encodeFunctionData, getContract
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  createNadoClient,
  CHAIN_ENV_TO_CHAIN,
  packOrderAppendix,
} = require('@nadohq/client');

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { log('⛔ PRIVATE_KEY not set'); process.exit(1); }

  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(pk);
  const chainConfig = CHAIN_ENV_TO_CHAIN.inkMainnet;
  const publicClient = createPublicClient({ chain: chainConfig, transport: http() });
  const walletClient = createWalletClient({ account, chain: chainConfig, transport: http() });
  const client = createNadoClient('inkMainnet', { publicClient, walletClient });

  log(`Кошелёк: ${account.address}`);
  log('');

  // ═══════════════════════════════════════════════
  // 1. РЕАЛЬНЫЕ МЕТОДЫ NADO SDK (без context/viem)
  // ═══════════════════════════════════════════════
  log('═══ 1. МЕТОДЫ NADO SDK (top-level) ═══');

  for (const ns of Object.keys(client)) {
    if (ns === 'context') continue;

    const val = client[ns];

    if (typeof val === 'function') {
      log(`  client.${ns}()`);
      continue;
    }

    if (typeof val === 'object' && val !== null) {
      const methods = Object.keys(val).filter(m => typeof val[m] === 'function');
      const props   = Object.keys(val).filter(m => typeof val[m] !== 'function');

      if (methods.length > 0) {
        log(`  📂 client.${ns}:`);
        for (const m of methods) {
          log(`      .${m}()`);
        }
      }
      if (props.length > 0) {
        for (const p of props) {
          const v = val[p];
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            log(`      .${p} = ${v}`);
          }
        }
      }
    }
  }
  log('');

  // ═══════════════════════════════════════════════
  // 2. ИЩЕМ DEPOSIT / SUBACCOUNT МЕТОДЫ
  // ═══════════════════════════════════════════════
  log('═══ 2. ПОИСК DEPOSIT/SUBACCOUNT ═══');

  for (const ns of Object.keys(client)) {
    if (ns === 'context') continue;
    const val = client[ns];
    if (typeof val !== 'object' || val === null) continue;

    for (const m of Object.keys(val)) {
      if (typeof val[m] !== 'function') continue;
      if (/deposit|withdraw|collateral|sub.?account|register|init|create|fund|approve/i.test(m)) {
        log(`  ✅ client.${ns}.${m}()`);
      }
    }
  }
  log('');

  // ═══════════════════════════════════════════════
  // 3. ПРОБУЕМ ВСЕ МЕТОДЫ account/subaccount
  // ═══════════════════════════════════════════════
  log('═══ 3. ВЫЗЫВАЕМ ACCOUNT-МЕТОДЫ ═══');

  for (const ns of Object.keys(client)) {
    if (ns === 'context') continue;
    const val = client[ns];
    if (typeof val !== 'object' || val === null) continue;

    // Пробуем все методы в namespace'ах account, subaccount, deposit, vault
    if (!/account|sub|deposit|vault|user|portfolio|balance|spot|clearinghouse|endpoint/i.test(ns)) continue;

    for (const m of Object.keys(val)) {
      if (typeof val[m] !== 'function') continue;

      const paramSets = [
        {},
        { address: account.address },
        { sender: account.address },
        { owner: account.address },
        account.address,  // иногда просто строка
      ];

      for (const params of paramSets) {
        try {
          const res = await val[m](params);
          const dump = JSON.stringify(res, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v
          ).slice(0, 400);
          log(`  ✅ ${ns}.${m}(${typeof params === 'string' ? `"${params}"` : JSON.stringify(params)}) →`);
          log(`     ${dump}`);
          break;
        } catch (e) {
          // тихо пропускаем
        }
      }
      await sleep(500);
    }
  }
  log('');

  // ═══════════════════════════════════════════════
  // 4. ЧИТАЕМ ENDPOINT КОНТРАКТ НА ЧЕЙНЕ
  // ═══════════════════════════════════════════════
  log('═══ 4. ON-CHAIN: ENDPOINT КОНТРАКТ ═══');

  const endpointAddr = '0x05ec92D78ED421f3D3Ada77FFdE167106565974E';
  const clearinghouseAddr = '0xD218103918C19D0A10cf35300E4CfAfbD444c5fE';

  // Пробуем прочитать quote token (USDC) из endpoint
  const commonSelectors = [
    { name: 'getQuote',        sig: 'function getQuote() view returns (address)',           args: [] },
    { name: 'quote',           sig: 'function quote() view returns (address)',              args: [] },
    { name: 'quoteToken',      sig: 'function quoteToken() view returns (address)',         args: [] },
    { name: 'usdc',            sig: 'function usdc() view returns (address)',               args: [] },
    { name: 'collateralToken', sig: 'function collateralToken() view returns (address)',    args: [] },
    { name: 'token',           sig: 'function token() view returns (address)',              args: [] },
    { name: 'getNumSubaccounts',
      sig: 'function getNumSubaccounts(address owner) view returns (uint64)',
      args: [account.address] },
    { name: 'getSubaccountId',
      sig: 'function getSubaccountId(bytes32 subaccount) view returns (uint64)',
      args: [`${account.address}${'0'.repeat(24)}`] },  // address + 12 zero bytes
    { name: 'nSubaccounts',
      sig: 'function nSubaccounts() view returns (uint64)',
      args: [] },
    { name: 'owner',
      sig: 'function owner() view returns (address)',
      args: [] },
  ];

  for (const target of [endpointAddr, clearinghouseAddr]) {
    const label = target === endpointAddr ? 'Endpoint' : 'Clearinghouse';
    log(`  ${label} (${target}):`);

    for (const { name, sig, args } of commonSelectors) {
      try {
        const res = await publicClient.readContract({
          address: target,
          abi: [{ type: 'function', ...parseSig(sig) }],
          functionName: name,
          args,
        });
        const val = typeof res === 'bigint' ? res.toString() : res;
        log(`    ✅ ${name}(${args.join(',')}) = ${val}`);
      } catch (e) {
        // молча пропускаем
      }
    }
    await sleep(500);
  }
  log('');

  // ═══════════════════════════════════════════════
  // 5. BYTECODE — проверяем депозит-функции контракта
  // ═══════════════════════════════════════════════
  log('═══ 5. ПРОВЕРКА DEPOSIT-ФУНКЦИЙ КОНТРАКТА ═══');

  // Селекторы Vertex-like функций
  const knownSelectors = {
    'e8e33700': 'depositCollateral(bytes12,uint32,uint128)',
    'd0e30db0': 'deposit()',
    'b6b55f25': 'deposit(uint256)',
    '47e7ef24': 'deposit(address,uint256)',
    'f340fa01': 'deposit(address)',
    '6e553f65': 'deposit(uint256,address)',
    'a0712d68': 'mint(uint256)',
    '2e1a7d4d': 'withdraw(uint256)',
    'b460af94': 'withdraw(uint256,address,address)',
  };

  try {
    const code = await publicClient.getBytecode({ address: endpointAddr });
    if (code) {
      log(`  Endpoint bytecode: ${code.length} символов`);
      const codeHex = code.toLowerCase();

      for (const [sel, name] of Object.entries(knownSelectors)) {
        if (codeHex.includes(sel)) {
          log(`  ✅ НАЙДЕН: ${name} (0x${sel})`);
        }
      }
    }
  } catch (e) {
    log(`  ❌ getBytecode: ${e.message}`);
  }

  try {
    const code = await publicClient.getBytecode({ address: clearinghouseAddr });
    if (code) {
      log(`  Clearinghouse bytecode: ${code.length} символов`);
      const codeHex = code.toLowerCase();

      for (const [sel, name] of Object.entries(knownSelectors)) {
        if (codeHex.includes(sel)) {
          log(`  ✅ НАЙДЕН в CH: ${name} (0x${sel})`);
        }
      }
    }
  } catch (e) {
    log(`  ❌ getBytecode CH: ${e.message}`);
  }
  log('');

  // ═══════════════════════════════════════════════
  // 6. ИЩЕМ USDC НА INK CHAIN
  // ═══════════════════════════════════════════════
  log('═══ 6. ПОИСК USDC НА INK ═══');

  const tokenCandidates = [
    '0xF1815bd50389c46847f0Bda824eC8da914045D14', // USDC.e
    '0x0200C29006150606B650577BBE7B6248F6995ABD',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC Base-style
    '0xd988097fb8612cc24eeC14542bC03424c656005f',
    '0x7f5c764cBc14f9669B88837ca1490cCa17c31607',
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  ];

  const erc20Abi = [
    { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
    { name: 'balanceOf', type: 'function', stateMutability: 'view',
      inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    { name: 'allowance', type: 'function', stateMutability: 'view',
      inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  ];

  for (const addr of tokenCandidates) {
    try {
      const tok = getContract({ address: addr, abi: erc20Abi, client: publicClient });
      const [sym, dec, bal] = await Promise.all([
        tok.read.symbol(),
        tok.read.decimals(),
        tok.read.balanceOf([account.address]),
      ]);

      let allowEndpoint = 0n, allowCH = 0n;
      try { allowEndpoint = await tok.read.allowance([account.address, endpointAddr]); } catch {}
      try { allowCH = await tok.read.allowance([account.address, clearinghouseAddr]); } catch {}

      log(`  ${addr}:`);
      log(`    ${sym} | decimals=${dec} | balance=${formatUnits(bal, dec)}`);
      log(`    allowance→endpoint=${formatUnits(allowEndpoint, dec)} allowance→CH=${formatUnits(allowCH, dec)}`);
    } catch {
      // не ERC20 или не существует
    }
  }
  log('');

  // ═══════════════════════════════════════════════
  // 7. СМОТРИМ НЕТ ЛИ DEPOSIT ИВЕНТОВ ОТ ЭТОГО АДРЕСА
  // ═══════════════════════════════════════════════
  log('═══ 7. ПРОВЕРКА DEPOSIT EVENTS ═══');

  try {
    // Ищем Transfer events USDC.e -> endpoint (deposit)
    const usdcAddr = '0xF1815bd50389c46847f0Bda824eC8da914045D14';
    const logs = await publicClient.getLogs({
      address: usdcAddr,
      event: {
        type: 'event',
        name: 'Transfer',
        inputs: [
          { type: 'address', indexed: true, name: 'from' },
          { type: 'address', indexed: true, name: 'to' },
          { type: 'uint256', indexed: false, name: 'value' },
        ],
      },
      args: { from: account.address },
      fromBlock: 0n,
      toBlock: 'latest',
    });

    if (logs.length === 0) {
      log('  ⛔ НЕТ НИ ОДНОГО Transfer USDC.e ОТ ЭТОГО АДРЕСА');
      log('  → Этот кошелёк НИКОГДА не отправлял USDC.e на Ink chain');
    } else {
      log(`  Найдено ${logs.length} Transfer(ов):`);
      for (const l of logs.slice(0, 10)) {
        log(`    → to=${l.args.to} amount=${formatUnits(l.args.value, 6)} block=${l.blockNumber}`);
      }
    }
  } catch (e) {
    log(`  ❌ getLogs: ${(e.message || '').slice(0, 200)}`);
  }
  log('');

  log('══════════════════════════════════════════════════');
  log('  ПОЛНАЯ ДИАГНОСТИКА ЗАВЕРШЕНА');
  log('  Скопируйте ВЕСЬ лог — он покажет точную причину');
  log('══════════════════════════════════════════════════');
}

// Helper: парсит function signature в ABI-объект
function parseSig(sig) {
  const match = sig.match(/function\s+(\w+)\((.*?)\)\s*(?:view\s+)?returns\s*\((.*?)\)/);
  if (!match) return {};

  const [, name, inputsStr, outputsStr] = match;

  const parseParams = (str) =>
    str
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const parts = s.split(/\s+/);
        return { type: parts[0], name: parts[1] || '' };
      });

  return {
    name,
    stateMutability: sig.includes('view') ? 'view' : 'nonpayable',
    inputs: parseParams(inputsStr),
    outputs: parseParams(outputsStr),
  };
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });