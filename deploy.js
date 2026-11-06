/**
 * FLYchat — Script Deploy Otomatis
 * Jalankan: node deploy.js
 *
 * Script ini akan:
 * 1. Cek semua dependency (git, vercel CLI, railway CLI)
 * 2. Push ke GitHub (buat repo baru otomatis)
 * 3. Deploy backend ke Railway
 * 4. Deploy frontend ke Vercel
 * 5. Update config.js dengan URL yang didapat
 */

'use strict';
const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const http = require('https');
const readline = require('readline');

const ROOT = __dirname;

/* ── helpers ── */
const log  = (msg)  => console.log(`\n  ${msg}`);
const ok   = (msg)  => console.log(`  ✅ ${msg}`);
const err  = (msg)  => console.log(`  ❌ ${msg}`);
const info = (msg)  => console.log(`  ℹ️  ${msg}`);
const hr   = ()     => console.log('\n' + '─'.repeat(50));

function run(cmd, opts = {}) {
  try {
    const result = execSync(cmd, { cwd: ROOT, stdio: opts.silent ? 'pipe' : 'inherit', encoding: 'utf8' });
    return result?.trim() || '';
  } catch (e) {
    if (opts.ignoreError) return '';
    throw e;
  }
}

function runSilent(cmd) {
  return run(cmd, { silent: true, ignoreError: true });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`\n  ${question}: `, ans => { rl.close(); resolve(ans.trim()); }));
}

function hasCommand(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'pipe', shell: true });
  return r.status === 0;
}

function readEnv() {
  const env = {};
  const lines = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n');
  lines.forEach(l => {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim();
  });
  return env;
}

/* ════════════════════════════════════════
   MAIN
════════════════════════════════════════ */
(async () => {
  console.log('\n🦋 FLYchat — Deploy Otomatis\n' + '─'.repeat(50));

  /* ── Step 1: Cek environment ── */
  hr();
  log('Step 1: Cek tools yang dibutuhkan...');

  const hasGit     = hasCommand('git');
  const hasVercel  = hasCommand('vercel');
  const hasRailway = hasCommand('railway');
  const hasGhCli   = hasCommand('gh');
  const hasNpx     = fs.existsSync('C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js');

  ok(`Git: ${hasGit ? 'ada' : 'TIDAK ADA — install dari https://git-scm.com'}`);
  ok(`Vercel CLI: ${hasVercel ? 'ada' : 'belum — akan diinstall otomatis'}`);
  ok(`Railway CLI: ${hasRailway ? 'ada' : 'belum — akan diinstall otomatis'}`);
  ok(`GitHub CLI: ${hasGhCli ? 'ada' : 'opsional — bisa skip'}`);

  if (!hasGit) {
    err('Git tidak ditemukan. Install dari: https://git-scm.com/download/win');
    err('Setelah install, restart terminal dan jalankan lagi: node deploy.js');
    process.exit(1);
  }

  /* ── Step 2: Install CLI jika belum ada ── */
  hr();
  log('Step 2: Install Vercel CLI & Railway CLI...');

  const npxCmd = hasNpx
    ? 'node "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js"'
    : 'npx';
  const npmCmd = 'node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"';

  if (!hasVercel) {
    info('Menginstall Vercel CLI...');
    try {
      execSync(`${npmCmd} install -g vercel`, { stdio: 'inherit', cwd: ROOT });
      ok('Vercel CLI terinstall');
    } catch {
      info('Coba cara lain...');
      execSync(`${npmCmd} install vercel --save-dev`, { stdio: 'inherit', cwd: ROOT });
      ok('Vercel CLI terinstall (lokal)');
    }
  } else { ok('Vercel CLI sudah ada'); }

  if (!hasRailway) {
    info('Menginstall Railway CLI...');
    try {
      execSync(`${npmCmd} install -g @railway/cli`, { stdio: 'inherit', cwd: ROOT });
      ok('Railway CLI terinstall');
    } catch {
      execSync(`${npmCmd} install @railway/cli --save-dev`, { stdio: 'inherit', cwd: ROOT });
      ok('Railway CLI terinstall (lokal)');
    }
  } else { ok('Railway CLI sudah ada'); }

  /* ── Step 3: Setup GitHub remote ── */
  hr();
  log('Step 3: Push kode ke GitHub...');

  const currentRemote = runSilent('git remote get-url origin');
  let githubUrl = currentRemote;

  if (!currentRemote) {
    info('Belum ada remote GitHub.');
    info('Silakan buka: https://github.com/new');
    info('Buat repo baru bernama: flychat (set ke Public)');
    info('Jangan centang "Initialize with README"');
    githubUrl = await ask('Paste URL repo GitHub kamu (contoh: https://github.com/username/flychat)');

    if (!githubUrl || !githubUrl.includes('github.com')) {
      err('URL GitHub tidak valid. Coba lagi dengan: node deploy.js');
      process.exit(1);
    }

    run(`git remote add origin ${githubUrl}`);
    ok(`Remote GitHub ditambahkan: ${githubUrl}`);
  } else {
    ok(`GitHub remote sudah ada: ${currentRemote}`);
  }

  // Push
  info('Push kode ke GitHub...');
  try {
    run('git push -u origin master');
    ok('Kode berhasil di-push ke GitHub!');
  } catch {
    try {
      run('git push -u origin main');
      ok('Kode berhasil di-push ke GitHub!');
    } catch (e2) {
      err('Push gagal. Pastikan kamu sudah login GitHub di terminal.');
      info('Coba: git push -u origin master');
      info('Jika minta login, masukkan username dan Personal Access Token GitHub');
      info('Buat token di: https://github.com/settings/tokens (centang repo)');
      process.exit(1);
    }
  }

  /* ── Step 4: Deploy ke Railway ── */
  hr();
  log('Step 4: Deploy backend ke Railway...');
  info('Membuka browser untuk login Railway...');

  const env = readEnv();

  // Cek apakah railway CLI tersedia
  const railwayCli = hasRailway ? 'railway' :
    fs.existsSync(path.join(ROOT, 'node_modules/.bin/railway')) ? './node_modules/.bin/railway' :
    fs.existsSync(path.join(ROOT, 'node_modules/@railway/cli/bin/railway.js')) ? `node "${path.join(ROOT, 'node_modules/@railway/cli/bin/railway.js')}"` :
    null;

  if (!railwayCli) {
    info('Railway CLI tidak ditemukan. Deploy Railway manual:');
    info('1. Buka: https://railway.app/new');
    info('2. Login → New Project → Deploy from GitHub → pilih repo flychat');
    info('3. Tambahkan environment variables berikut di Railway Settings:');
    console.log(`\n  DATABASE_URL  = ${env.DATABASE_URL}`);
    console.log(`  JWT_SECRET    = ${env.JWT_SECRET}`);
    console.log(`  PORT          = 3000`);
    console.log(`  NODE_ENV      = production`);
    console.log(`  UPLOAD_DIR    = uploads`);
    console.log(`  MAX_FILE_SIZE_MB = 50`);
    console.log('');
  } else {
    try {
      execSync(`${railwayCli} login --browserless`, { stdio: 'inherit', cwd: ROOT });
      execSync(`${railwayCli} link --environment production`, { stdio: 'inherit', cwd: ROOT });

      // Set env vars
      const railwayEnvVars = [
        `DATABASE_URL="${env.DATABASE_URL}"`,
        `JWT_SECRET="${env.JWT_SECRET}"`,
        `PORT=3000`,
        `NODE_ENV=production`,
        `UPLOAD_DIR=uploads`,
        `MAX_FILE_SIZE_MB=50`
      ];
      for (const envVar of railwayEnvVars) {
        execSync(`${railwayCli} variables set ${envVar}`, { stdio: 'pipe', cwd: ROOT });
      }
      ok('Environment variables Railway diset!');
      execSync(`${railwayCli} up --detach`, { stdio: 'inherit', cwd: ROOT });
      ok('Deploy Railway dimulai!');
    } catch (e) {
      info('Railway CLI error. Deploy manual via web:');
      info('1. https://railway.app/new → Deploy from GitHub → flychat');
      info('2. Set environment variables di Settings tab');
    }
  }

  const railwayUrl = await ask(
    'Setelah Railway selesai deploy, paste URL Railway kamu\n  (contoh: https://flychat-production.up.railway.app)\n  Tekan Enter untuk skip dan set nanti'
  );

  /* ── Step 5: Update config.js dengan Railway URL ── */
  if (railwayUrl && railwayUrl.startsWith('https://')) {
    hr();
    log('Step 5: Update config.js dengan Railway URL...');

    const configPath = path.join(ROOT, 'public', 'config.js');
    fs.writeFileSync(configPath, `/**
 * FLYchat Runtime Config — PRODUCTION
 * Backend: Railway | Frontend: Vercel
 */
window.__FLYCHAT_API__ = '${railwayUrl.replace(/\/$/, '')}';
`);
    ok(`config.js diupdate: ${railwayUrl}`);

    // Update CORS di .env untuk Railway
    const envContent = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    if (!envContent.includes('FRONTEND_URL')) {
      fs.appendFileSync(path.join(ROOT, '.env'), `\n# Vercel frontend URL (isi setelah deploy Vercel)\nFRONTEND_URL=https://flychat.vercel.app\n`);
    }

    // Commit perubahan
    run('git add public/config.js .env');
    run('git commit -m "chore: set Railway API URL for production"', { ignoreError: true });
    run('git push', { ignoreError: true });
    ok('config.js sudah di-commit dan di-push!');
  }

  /* ── Step 6: Deploy ke Vercel ── */
  hr();
  log('Step 6: Deploy frontend ke Vercel...');

  const vercelCli = hasVercel ? 'vercel' :
    fs.existsSync(path.join(ROOT, 'node_modules/.bin/vercel')) ? './node_modules/.bin/vercel' :
    fs.existsSync(path.join(ROOT, 'node_modules/vercel/src/index.js')) ? `node "${path.join(ROOT, 'node_modules/vercel/src/index.js')}"` :
    `${npxCmd} vercel`;

  info('Login ke Vercel (akan buka browser atau kirim email)...');
  try {
    execSync(`${vercelCli} login`, { stdio: 'inherit', cwd: ROOT });
    ok('Login Vercel berhasil!');

    // Deploy dengan settings yang benar
    info('Deploy ke Vercel...');
    execSync(`${vercelCli} deploy --prod --yes`, { stdio: 'inherit', cwd: ROOT });
    ok('Deploy Vercel selesai!');
  } catch (e) {
    info('Vercel CLI error. Coba deploy manual:');
    info('1. Buka: https://vercel.com/new');
    info('2. Import repo GitHub → flychat');
    info('3. Settings:');
    info('   - Framework: Other');
    info('   - Output Directory: public');
    info('   - Build Command: (kosongkan)');
    info('4. Klik Deploy');
  }

  /* ── Summary ── */
  hr();
  console.log('\n🦋 Deploy Selesai!\n');
  console.log('  Langkah selanjutnya:');
  console.log('  1. Buka Vercel → dapat URL production (contoh: https://flychat.vercel.app)');
  console.log('  2. Buka Railway → Settings → tambahkan env var:');
  console.log('     FRONTEND_URL = https://flychat.vercel.app');
  console.log('  3. Buka URL Vercel di browser → coba register akun baru!\n');

  if (railwayUrl) {
    console.log(`  🔗 Backend: ${railwayUrl}`);
  }
  console.log('  📖 Panduan lengkap: SETUP.md\n');

})().catch(e => {
  console.error('\n❌ Deploy error:', e.message);
  console.log('\n  Jalankan ulang: node deploy.js');
  process.exit(1);
});
