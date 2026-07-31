#!/usr/bin/env node
/*
 * デプロイ前チェック (1コマンド)
 *   - .gs/.js: 構文チェック (node --check) + switch の重複 case + case ハンドラ未定義の疑い
 *   - .html  : <script type="text/babel"> 全ブロックを @babel/core で変換チェック
 *
 * 使い方:
 *   node predeploy_check.js Code.gs admin-index.html participants-index.html
 *
 * 備考: babel チェックには @babel/core と @babel/preset-react が必要。
 *   見つからない場合はその項目のみスキップ (警告) し、他は実行する。
 */
const fs = require('fs');
const { execSync } = require('child_process');

let hardFail = 0;
let warn = 0;

// ---- プロジェクト固有の既知グローバル (外部ファイルで追加可) ----
function loadExtraGlobals() {
  try {
    const j = JSON.parse(fs.readFileSync('predeploy_globals.json', 'utf8'));
    if (Array.isArray(j)) return j.filter(x => typeof x === 'string');
  } catch (e) {}
  return [];
}

// ---- ビルド前進チェック用の状態 (前回値を記録) ----
const STATE_FILE = '.predeploy_state.json';
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}
const buildState = loadState();

// ---- babel のロード (ローカル → 既知のパスの順) ----
function loadBabel() {
  const tries = ['@babel/core', '/tmp/babelcheck/node_modules/@babel/core'];
  for (const p of tries) {
    try {
      const core = require(p);
      let preset;
      try { preset = require(p.replace('/core', '/preset-react')); } catch (e) { preset = p.replace('/core', '/preset-react'); }
      return { core, preset };
    } catch (e) {}
  }
  return null;
}

// ---- 構文チェック (.gs/.js) ----
function checkSyntax(file) {
  let target = file;
  let tmp = null;
  if (/\.gs$/.test(file)) {
    // node --check は .gs 拡張子を ESM 解決でエラーにするため、一時 .js にコピー
    const os = require('os'); const path = require('path');
    tmp = path.join(os.tmpdir(), 'predeploy_' + Date.now() + '.js');
    fs.copyFileSync(file, tmp);
    target = tmp;
  }
  try {
    execSync(`node --check "${target}"`, { stdio: 'pipe' });
    console.log(`  [syntax] OK`);
  } catch (e) {
    console.error(`  [syntax] FAIL: ${String(e.stderr || e.message).split('\n')[0]}`);
    hardFail++;
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (e) {} }
  }
}

// ---- 重複 case ラベル (関数単位) ----
function checkDupCases(src) {
  const lines = src.split('\n');
  let func = '(top)';
  const seen = {};
  let dup = 0;
  lines.forEach((line, i) => {
    const fm = line.match(/^function\s+([A-Za-z0-9_$]+)\s*\(/);
    if (fm) { func = fm[1]; seen[func] = seen[func] || {}; return; }
    const cm = line.match(/^\s*case\s+'([^']+)'\s*:/);
    if (cm) { seen[func] = seen[func] || {}; (seen[func][cm[1]] = seen[func][cm[1]] || []).push(i + 1); }
  });
  Object.keys(seen).forEach(fn => Object.keys(seen[fn]).forEach(name => {
    if (seen[fn][name].length > 1) { dup++; console.error(`  [dup-case] '${name}' in ${fn}() at lines ${seen[fn][name].join(', ')}`); }
  }));
  if (dup === 0) console.log('  [dup-case] OK'); else hardFail++;
}

// ---- case ハンドラの未定義疑い (heuristic / 警告のみ) ----
function checkUndefinedHandlers(src) {
  // 定義済み名を収集
  const defined = new Set();
  let m;
  const reFn = /function\s+([A-Za-z0-9_$]+)\s*\(/g;
  while ((m = reFn.exec(src))) defined.add(m[1]);
  const reAssign = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*function/g;
  while ((m = reAssign.exec(src))) defined.add(m[1]);
  // よくある組込/グローバル
  const KNOWN = new Set(['CFG', 'JSON', 'Number', 'String', 'Object', 'Array', 'Math', 'Date', 'Boolean', 'parseInt', 'parseFloat', 'Logger', 'ScriptApp', 'SpreadsheetApp', 'CacheService', 'LockService', 'Utilities', 'PropertiesService', 'Session', 'MailApp', 'GmailApp', 'UrlFetchApp'].concat(loadExtraGlobals()));
  const lines = src.split('\n');
  let unknown = 0;
  lines.forEach((line, i) => {
    if (!/^\s*case\s+'[^']+'\s*:/.test(line)) return;
    // 同一行内の 'return <fn>(' / ': <fn>(' から呼び出し名を抽出 (メソッド呼び出し .fn( は除外)
    const callRe = /(?:return|:|\?)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(line))) {
      const name = c[1];
      // 直前が '.' ならメソッド呼び出し → 除外
      const at = c.index + c[0].indexOf(name);
      if (at > 0 && line[at - 1] === '.') continue;
      if (['return', 'if', 'for', 'while', 'switch', 'function', 'typeof'].includes(name)) continue;
      if (defined.has(name) || KNOWN.has(name)) continue;
      unknown++; warn++;
      console.warn(`  [handler?] line ${i + 1}: '${name}(' が定義として見つかりません (別ファイル定義/動的なら無視可)`);
    }
  });
  if (unknown === 0) console.log('  [handler?] OK');
}

// ---- ビルド文字列が前回より進んでいるか (.html) ----
function checkBuildAdvanced(file, src) {
  const m = src.match(/__APP_BUILD\s*=\s*'([^']+)'/);
  if (!m) { console.log('  [build] (build 文字列なし)'); return; }
  const current = m[1];
  const prev = buildState[file];
  if (prev && prev === current) {
    console.warn(`  [build] WARN: build 文字列が前回と同じ ('${current}')。 変更があるなら更新忘れの可能性`);
    warn++;
  } else {
    console.log(`  [build] OK ('${current}'${prev ? ` ← '${prev}'` : ' / 初回'})`);
  }
  buildState[file] = current;  // 今回値を記録
}

// ---- babel ブロック検証 (.html) ----
function checkBabelBlocks(file, src, babel) {
  if (!babel) { console.warn('  [babel] スキップ (@babel/core 未検出。 npm i -D @babel/core @babel/preset-react)'); warn++; return; }
  const re = /<script[^>]*type=["']text\/babel["'][^>]*>/gi;
  let m, n = 0, fail = 0;
  function offToLine(off) { return src.slice(0, off).split('\n').length; }
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('</script>', start);
    const code = src.slice(start, end);
    const startLine = offToLine(start), endLine = offToLine(end);
    n++;
    try {
      babel.core.transformSync(code, { presets: [babel.preset], filename: 'block.jsx' });
    } catch (e) {
      fail++; hardFail++;
      console.error(`  [babel] BLOCK ${startLine}-${endLine} ERROR: ${e.message.split('\n')[0]}`);
    }
  }
  if (fail === 0) console.log(`  [babel] OK (${n} blocks)`);
}

// ---- main ----
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node predeploy_check.js <files...>'); process.exit(2); }
const babel = loadBabel();

files.forEach(file => {
  if (!fs.existsSync(file)) { console.error(`MISSING: ${file}`); hardFail++; return; }
  const src = fs.readFileSync(file, 'utf8');
  console.log(`\n== ${file} ==`);
  if (/\.(gs|js)$/.test(file)) {
    checkSyntax(file);
    checkDupCases(src);
    checkUndefinedHandlers(src);
  } else if (/\.html?$/.test(file)) {
    checkBuildAdvanced(file, src);
    checkBabelBlocks(file, src, babel);
  } else {
    console.log('  (スキップ: 対象外の拡張子)');
  }
});

saveState(buildState);
console.log(`\n結果: ${hardFail === 0 ? 'PASS' : 'FAIL'} (hardFail=${hardFail}, warn=${warn})`);
process.exit(hardFail === 0 ? 0 : 1);
