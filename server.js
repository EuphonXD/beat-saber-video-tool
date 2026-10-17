#!/usr/bin/env node
/* =====================================================================
 *  Beat Saber 视频工具 · 网页版（本地服务，零依赖）
 *  文件: server.js    运行: node server.js（或双击 启动网页版.bat）
 *  功能: 歌曲总览/补链接 · 一键下载(实时进度) · cookies 检测与导入 ·
 *        代理设置（直连 / 本机代理 / 自定义）· 试看（偏移调整/频谱对比/自动对齐）· 日志
 *  仅监听 127.0.0.1，不对外网开放。
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const urlmod = require('url');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TOOL = __dirname;                                   // 工具根目录
const PUBLIC_DIR = path.join(TOOL, 'public');
const CONFIG_PATH = path.join(TOOL, '工具配置.json');
const LINKS_PATH = path.join(TOOL, '视频链接.txt');
const LOG_DIR = path.join(TOOL, '日志');
const WEB_LOG = path.join(LOG_DIR, '网页版日志.txt');
const STATUS_PATH = path.join(TOOL, '网页版状态.json');
const AUDIO_CACHE_DIR = path.join(TOOL, '缓存音频');

const DEFAULT_GAME = 'D:\\steam\\steamapps\\common\\Beat Saber';
const TEST_VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const LOCAL_PROXY = 'http://127.0.0.1:7890';
const PORT_START = parseInt(process.env.BSWEBUI_PORT || '8770', 10);

/* ---------------- 基础工具 ---------------- */
function nowStr() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function ensureDir(p) { try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch (e) {} }

function loadConfig() {
  let cfg = {};
  try {
    let raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    cfg = JSON.parse(raw);
  } catch (e) { cfg = {}; }
  const def = {
    '游戏目录': DEFAULT_GAME, '代理': '', '视频高度': 1080,
    'yt-dlp路径': '', 'ffmpeg路径': '', '浏览器cookies': '', 'cookie文件': '',
    '代理模式': 'direct', '自定义代理': '', 'cookie来源': 'auto'
  };
  for (const k in def) { if (cfg[k] === undefined || cfg[k] === null) cfg[k] = def[k]; }
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, '\uFEFF' + JSON.stringify(cfg, null, 2), 'utf8');
}
function effectiveProxy(cfg) {
  const mode = cfg['代理模式'] || 'local';
  if (mode === 'direct') return '';
  if (mode === 'local') return LOCAL_PROXY;
  if (mode === 'custom') return String(cfg['自定义代理'] || '');
  return String(cfg['代理'] || '');
}
function findYtdlp(cfg) {
  const p1 = String(cfg['yt-dlp路径'] || '');
  if (p1 && fs.existsSync(p1)) return p1;
  const p2 = path.join(TOOL, 'bin', 'yt-dlp.exe');
  if (fs.existsSync(p2)) return p2;
  return 'yt-dlp.exe';
}
function findFfmpeg(cfg) {
  const cands = [
    String(cfg['ffmpeg路径'] || ''),
    'D:\\ffmpeg-6.0-essentials_build\\bin\\ffmpeg.exe',
    path.join(String(cfg['游戏目录'] || ''), 'Libs', 'ffmpeg.exe')
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return '';
}
function nodeExePath() {
  const p = 'C:\\Program Files\\nodejs\\node.exe';
  if (fs.existsSync(p)) return p;
  return process.execPath;
}

/* ---------------- 歌曲扫描（与 bs-video.ps1 同逻辑） ---------------- */
function scanSongs(cfg) {
  const rows = [];
  const cl = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels');
  if (!fs.existsSync(cl)) return rows;
  let dirs = [];
  try { dirs = fs.readdirSync(cl, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch (e) { return rows; }
  let idx = 0;
  for (const folder of dirs) {
    idx++;
    const dir = path.join(cl, folder);
    let name = '(无 Info.dat)', artist = '', mapper = '';
    const infoF = path.join(dir, 'Info.dat');
    if (fs.existsSync(infoF)) {
      try {
        const j = JSON.parse(fs.readFileSync(infoF, 'utf8'));
        name = String(j._songName || '');
        artist = String(j._songAuthorName || '');
        mapper = String(j._levelAuthorName || '');
      } catch (e) { name = '(解析失败)'; }
    }
    const vcfg = readVideoConfig(dir);
    const hasCfg = !!vcfg.obj;
    let videoID = '', videoFile = '', offset = null;
    if (hasCfg) {
      try {
        videoID = String(vcfg.obj.videoID || '');
        videoFile = String(vcfg.obj.videoFile || '');
        offset = (vcfg.obj.offset === undefined || vcfg.obj.offset === null) ? null : Number(vcfg.obj.offset);
      } catch (e) {}
    }
    let vf = null;
    try {
      vf = fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isFile() && /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(d.name))
        .map(d => d.name)[0] || null;
    } catch (e) {}
    let status = '需添加链接', videoInfo = '';
    if (vf) {
      status = '已下载';
      try { videoInfo = vf + ' | ' + (fs.statSync(path.join(dir, vf)).size / 1048576).toFixed(1) + ' MB'; } catch (e) { videoInfo = vf; }
    } else if (hasCfg && videoID && !isLocalVideoId(videoID)) { status = '待下载(已有链接)'; videoInfo = 'YT:' + videoID; }
    else if (hasCfg) { status = '待下载(无链接)'; }
    let videoSizeMB = '';
    if (vf) { try { videoSizeMB = (fs.statSync(path.join(dir, vf)).size / 1048576).toFixed(1); } catch (e) {} }
    rows.push({ idx: idx, folder: folder, name: name, artist: artist, mapper: mapper, status: status, videoInfo: videoInfo, videoID: videoID, videoFile: videoFile, hasVideo: !!vf, videoSizeMB: videoSizeMB, offset: offset, hasConfig: hasCfg });
  }
  return rows;
}

/* ---------------- 链接表 ---------------- */
function readLinksMap() {
  const map = {};
  try {
    let raw = fs.readFileSync(LINKS_PATH, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.trim().indexOf('#') === 0) continue;
      const parts = line.split('|');
      if (parts.length >= 4) {
        const folder = parts[1].trim(); const u = parts[3].trim();
        if (folder && u) map[folder] = u;
      }
    }
  } catch (e) {}
  return map;
}
function updateLink(folder, u) {
  let raw = '';
  try { raw = fs.readFileSync(LINKS_PATH, 'utf8'); if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); } catch (e) {}
  const lines = raw ? raw.split(/\r?\n/) : [];
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().indexOf('#') === 0) continue;
    const parts = l.split('|');
    if (parts.length >= 4 && parts[1].trim() === folder) {
      parts[3] = ' ' + String(u || '');
      lines[i] = parts.join('|');
      found = true;
      break;
    }
  }
  if (!found) {
    if (!lines.length) lines.push('# ============ Beat Saber 视频链接填写表 ============');
    const cfg = loadConfig();
    const rows = scanSongs(cfg);
    let r = null;
    for (const x of rows) { if (x.folder === folder) { r = x; break; } }
    const i2 = r ? r.idx : (rows.length + 1);
    const nm = r ? r.name : folder;
    lines.push(i2 + ' | ' + folder + ' | ' + nm + ' | ' + String(u || ''));
  }
  fs.writeFileSync(LINKS_PATH, '\uFEFF' + lines.join('\r\n'), 'utf8');
  return { ok: true };
}

/* ---------------- 偏移修改 ---------------- */
function updateOffset(folder, offset) {
  const cfg = loadConfig();
  const dir = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels', folder);
  let cur = readVideoConfig(dir);
  if (!cur.obj) {
    // 目录里有视频但还没配置文件 → 顺手建一个（Theater 兼容）
    let vids = [];
    try { vids = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(d.name)).map(d => d.name); } catch (e) {}
    if (!vids.length) return { error: '该歌曲还没有视频配置（先下载视频或放个本地视频）' };
    writeVideoConfig(dir, vids.find(v => /^video\./i.test(v)) || vids[0], folder);
    cur = readVideoConfig(dir);
  }
  const n = Number(offset);
  if (isNaN(n)) return { error: '偏移必须是毫秒数字' };
  const ms = Math.round(n);
  if (Math.abs(ms) > 600000) return { error: '偏移超出合理范围（±600000 ms）' };
  cur.obj.offset = ms;
  syncDownloadedFormats(cur.obj, dir);          // 顺手保证 Theater 能识别本地视频
  fs.writeFileSync(cur.path, JSON.stringify(cur.obj, null, 2), 'utf8');
  return { ok: true, offset: cur.obj.offset, config: cur.name };
}

/* ---------------- 日志 ---------------- */
const jobs = { running: false, stopFlag: false, queue: [], current: null, results: [], log: [], stats: { ok: 0, fail: 0, skip: 0 }, child: null, startedAt: 0 };
function addLog(s) {
  const line = nowStr() + '  ' + s;
  jobs.log.push(line);
  if (jobs.log.length > 800) jobs.log.splice(0, jobs.log.length - 800);
  try { ensureDir(LOG_DIR); fs.appendFileSync(WEB_LOG, line + '\r\n'); } catch (e) {}
}

/* ---------------- yt-dlp 调用 ---------------- */
function resolveVideoId(u) {
  if (!u) return '';
  let m = String(u).match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_\-]{11})/);
  if (m) return m[1];
  m = String(u).match(/^([A-Za-z0-9_\-]{11})$/);
  if (m) return m[1];
  return '';
}
function probeWithYtdlp(ytdlp, extraArgs, cfg) {
  return new Promise(resolve => {
    const args = ['--simulate', '--no-warnings', '--no-playlist', '--socket-timeout', '15'];
    const proxy = effectiveProxy(cfg);
    if (proxy) args.push('--proxy', proxy);
    for (const a of extraArgs) args.push(a);
    args.push(TEST_VIDEO_URL);
    let out = '', err = '', settled = false;
    const finish = r => { if (!settled) { settled = true; resolve(r); } };
    let ch;
    try { ch = spawn(ytdlp, args, { windowsHide: true }); }
    catch (e) { return finish({ ok: false, detail: '无法启动 yt-dlp: ' + e.message }); }
    const timer = setTimeout(() => { try { killTree(ch); } catch (e) {} finish({ ok: false, detail: '检测超时（30 秒）' }); }, 30000);
    ch.stdout.on('data', d => out += d.toString('utf8'));
    ch.stderr.on('data', d => err += d.toString('utf8'));
    ch.on('error', e => { clearTimeout(timer); finish({ ok: false, detail: '无法启动 yt-dlp: ' + e.message }); });
    ch.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return finish({ ok: true, detail: '可用（已通过登录验证）' });
      const all = (err + '\n' + out).trim().split(/\r?\n/).filter(Boolean);
      let last = all.length ? all[all.length - 1] : ('退出码 ' + code);
      if (last.length > 170) last = last.slice(0, 170) + '…';
      finish({ ok: false, detail: last || ('退出码 ' + code) });
    });
  });
}
function killTree(ch) {
  try {
    if (process.platform === 'win32' && ch.pid) {
      spawn('taskkill', ['/pid', String(ch.pid), '/T', '/F'], { windowsHide: true });
    } else { ch.kill('SIGKILL'); }
  } catch (e) { try { ch.kill(); } catch (e2) {} }
}

/* ---------------- cookies 检测 ---------------- */
const cookieState = { running: false, doneAt: 0, browsers: [], file: null, effective: null };
function browserPresent(br) {
  try {
    const LA = process.env.LOCALAPPDATA || '';
    const AP = process.env.APPDATA || '';
    if (br === 'edge') return fs.existsSync(path.join(LA, 'Microsoft', 'Edge', 'User Data'));
    if (br === 'chrome') return fs.existsSync(path.join(LA, 'Google', 'Chrome', 'User Data'));
    if (br === 'firefox') return fs.existsSync(path.join(AP, 'Mozilla', 'Firefox', 'Profiles'));
  } catch (e) {}
  return false;
}
function detectDefaultBrowser() {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const ch = spawn('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId'], { windowsHide: true });
      let out = '';
      ch.stdout.on('data', d => out += d.toString());
      ch.on('error', () => finish(''));
      ch.on('close', () => {
        const m = out.match(/ProgId\s+REG_SZ\s+(\S+)/);
        const p = (m ? m[1] : '').toLowerCase();
        if (p.indexOf('edge') >= 0) finish('edge');
        else if (p.indexOf('chrome') >= 0) finish('chrome');
        else if (p.indexOf('firefox') >= 0) finish('firefox');
        else finish('');
      });
      setTimeout(() => { try { ch.kill(); } catch (e) {} finish(''); }, 5000);
    } catch (e) { finish(''); }
  });
}
async function detectCookies() {
  if (cookieState.running) return;
  cookieState.running = true;
  try {
    const cfg = loadConfig();
    const ytdlp = findYtdlp(cfg);
    const def = await detectDefaultBrowser();
    let order = ['edge', 'chrome', 'firefox'];
    if (def) order = [def].concat(order.filter(x => x !== def));
    const browsers = [];
    for (const br of order) {
      const label = br === 'edge' ? 'Edge' : br === 'chrome' ? 'Chrome' : 'Firefox';
      if (!browserPresent(br)) {
        browsers.push({ name: br, label: label, present: false, status: 'skip', detail: '未检测到（未安装或没有用户配置）' });
        continue;
      }
      const r = await probeWithYtdlp(ytdlp, ['--cookies-from-browser', br], cfg);
      browsers.push({ name: br, label: label, present: true, status: (r.ok ? 'ok' : 'fail'), detail: r.detail + (br === def ? '（系统默认浏览器）' : '') });
    }
    let file = { exists: false, status: 'skip', detail: '工具目录下没有 cookies.txt' };
    const cf = path.join(TOOL, 'cookies.txt');
    if (fs.existsSync(cf)) {
      file.exists = true;
      const r = await probeWithYtdlp(ytdlp, ['--cookies', cf], cfg);
      file.status = r.ok ? 'ok' : 'fail';
      file.detail = r.detail;
    }
    cookieState.browsers = browsers;
    cookieState.file = file;
    cookieState.doneAt = Date.now();
    // 解析生效来源
    const mode = cfg['cookie来源'] || 'auto';
    let eff = null;
    const okBr = browsers.find(b => b.status === 'ok');
    if (mode === 'auto') {
      if (okBr) eff = { type: 'browser', value: okBr.name, label: '浏览器 ' + okBr.label };
      else if (file.status === 'ok') eff = { type: 'file', value: 'cookies.txt', label: 'cookies.txt 文件' };
    } else if (mode === 'browser') {
      if (okBr) eff = { type: 'browser', value: okBr.name, label: '浏览器 ' + okBr.label };
    } else if (mode === 'file') {
      if (file.status === 'ok') eff = { type: 'file', value: 'cookies.txt', label: 'cookies.txt 文件' };
    }
    cookieState.effective = eff;
    addLog('cookies 检测完成：' + (eff ? ('生效来源 = ' + eff.label) : '没有可用来源'));
    try { fs.writeFileSync(STATUS_PATH, JSON.stringify(cookieState, null, 2), 'utf8'); } catch (e) {}
  } catch (e) {
    addLog('cookies 检测出错: ' + e.message);
  }
  cookieState.running = false;
}

/* ---------------- PoToken ---------------- */
function pingPot(cb) {
  let settled = false;
  const done = v => { if (!settled) { settled = true; cb(v); } };
  try {
    const req = http.get('http://127.0.0.1:4416/ping', { timeout: 4000 }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => done(b.indexOf('server_uptime') >= 0));
    });
    req.on('error', () => done(false));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} done(false); });
  } catch (e) { done(false); }
}
function ensurePot() {
  return new Promise(resolve => {
    pingPot(ok => {
      if (ok) return resolve(true);
      addLog('启动 YouTube 反爬组件 PoToken (BgutilPOT)...');
      try { spawn('schtasks', ['/run', '/tn', 'BgutilPOT'], { windowsHide: true }); } catch (e) {}
      setTimeout(() => pingPot(ok2 => resolve(ok2)), 6500);
    });
  });
}

/* ---------------- 下载任务 ---------------- */
function buildCookieArgs(cfg) {
  const args = [];
  let eff = cookieState.effective;
  if (!eff || (Date.now() - cookieState.doneAt) > 10 * 60 * 1000) {
    // 兜底：优先浏览器历史结果，其次文件
    const okBr = cookieState.browsers.find(b => b.status === 'ok');
    if (okBr) eff = { type: 'browser', value: okBr.name };
    else if (cookieState.file && cookieState.file.status === 'ok') eff = { type: 'file', value: 'cookies.txt' };
    else if (fs.existsSync(path.join(TOOL, 'cookies.txt'))) eff = { type: 'file', value: 'cookies.txt' };
    else eff = null;
  }
  const mode = cfg['cookie来源'] || 'auto';
  if (mode === 'none') return args;
  if (mode === 'file') {
    const cf = path.join(TOOL, 'cookies.txt');
    if (fs.existsSync(cf)) args.push('--cookies', cf);
    return args;
  }
  if (mode === 'browser') {
    const okBr = cookieState.browsers.find(b => b.status === 'ok');
    if (okBr) args.push('--cookies-from-browser', okBr.name);
    return args;
  }
  // auto
  if (eff && eff.type === 'browser') args.push('--cookies-from-browser', eff.value);
  else if (eff && eff.type === 'file' && fs.existsSync(path.join(TOOL, 'cookies.txt'))) args.push('--cookies', path.join(TOOL, 'cookies.txt'));
  return args;
}
function startDownload(opts) {
  if (jobs.running) return { error: '已有下载任务进行中' };
  const cfg = loadConfig();
  const ytdlp = findYtdlp(cfg);
  if (!fs.existsSync(ytdlp) && ytdlp === 'yt-dlp.exe') { /* 交给 PATH */ }
  const rows = scanSongs(cfg);
  const byFolder = {};
  for (const r of rows) byFolder[r.folder] = r;
  const linkMap = readLinksMap();
  const only = (opts && opts.folders) ? opts.folders : null;
  const list = [];
  if (only && only.length) {
    for (const f of only) {
      const r = byFolder[f];
      if (!r) continue;
      let u = linkMap[f];
      if (!u && r.videoID && !isLocalVideoId(r.videoID)) u = 'https://www.youtube.com/watch?v=' + r.videoID;
      if (!u) continue;
      list.push({ folder: f, url: u, row: r, force: !!(opts && opts.force) });
    }
  } else {
    for (const r of rows) {
      let u = linkMap[r.folder];
      if (!u && r.videoID && !isLocalVideoId(r.videoID)) u = 'https://www.youtube.com/watch?v=' + r.videoID;
      if (!u) continue;
      list.push({ folder: r.folder, url: u, row: r, force: !!(opts && opts.force) });
    }
  }
  const tasks = [];
  for (const t of list) {
    t.vid = resolveVideoId(t.url);
    if (t.vid) tasks.push(t);
  }
  if (!tasks.length) return { error: '没有找到可下载的歌曲（需要链接）' };
  jobs.queue = tasks;
  jobs.running = true;
  jobs.stopFlag = false;
  jobs.current = null;
  jobs.results = [];
  jobs.log = [];
  jobs.stats = { ok: 0, fail: 0, skip: 0 };
  jobs.startedAt = Date.now();
  addLog('任务开始：共 ' + tasks.length + ' 首待处理');
  addLog('代理: ' + (effectiveProxy(cfg) || '（直连）'));
  runNextTask();
  return { ok: true, count: tasks.length };
}
function runNextTask() {
  if (jobs.stopFlag) { finishJobs('已手动停止'); return; }
  if (!jobs.queue.length) { finishJobs('全部完成'); return; }
  const t = jobs.queue.shift();
  runOneTask(t).catch(e => {
    jobs.stats.fail++;
    jobs.results.push({ folder: t.folder, name: t.row.name, status: 'fail', detail: e.message });
    addLog('异常: ' + t.folder + ' — ' + e.message);
    runNextTask();
  });
}
async function runOneTask(t) {
  const cfg = loadConfig();
  const ytdlp = findYtdlp(cfg);
  const songDir = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels', t.folder);
  if (!fs.existsSync(songDir)) {
    jobs.stats.skip++;
    jobs.results.push({ folder: t.folder, name: t.row.name, status: 'skip', detail: '目录不存在' });
    return runNextTask();
  }
  const target = t.row.videoFile || 'video.mp4';
  const targetPath = path.join(songDir, target);
  let exist = null;
  if (fs.existsSync(targetPath)) { try { exist = fs.statSync(targetPath); } catch (e) {} }
  else {
    try {
      const vids = fs.readdirSync(songDir, { withFileTypes: true }).filter(d => d.isFile() && /\.(mp4|webm|mkv|mov)$/i.test(d.name));
      if (vids.length) exist = fs.statSync(path.join(songDir, vids[0].name));
    } catch (e) {}
  }
  if (exist && exist.size > 512000 && !t.force) {
    jobs.stats.skip++;
    jobs.results.push({ folder: t.folder, name: t.row.name, status: 'skip', detail: '已有视频，跳过' });
    addLog('跳过（已有视频）: ' + t.row.name);
    return runNextTask();
  }

  const potOk = await ensurePot();
  if (!potOk) addLog('提示: PoToken 未就绪，下载可能受影响');

  const outTemplate = path.join(songDir, target.replace(/\.mp4$/i, '.%(ext)s'));
  const argsList = ['--no-playlist', '--no-warnings', '--newline', '--no-mtime', '--retries', '3', '--fragment-retries', '5', '--socket-timeout', '20'];
  const proxy = effectiveProxy(cfg);
  if (proxy) argsList.push('--proxy', proxy);
  const ff = findFfmpeg(cfg);
  if (ff) argsList.push('--ffmpeg-location', path.dirname(ff));
  argsList.push('--js-runtimes', 'node:' + nodeExePath());
  const ck = buildCookieArgs(cfg);
  for (const a of ck) argsList.push(a);
  argsList.push('-f', 'bv*[ext=mp4][vcodec^=avc1][height<=' + (cfg['视频高度'] || 1080) + ']+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b');
  argsList.push('--merge-output-format', 'mp4');
  argsList.push('--print', 'after_move:VID:%(id)s');
  argsList.push('--print', 'after_move:TITLE:%(title)s');
  argsList.push('--print', 'after_move:AUTHOR:%(uploader)s');
  argsList.push('--print', 'after_move:DURATION:%(duration)s');
  argsList.push('--print', 'after_move:FILE:%(filepath)s');
  argsList.push('-o', outTemplate);
  argsList.push(t.url);

  addLog('下载: ' + t.row.name + ' (' + t.folder + ')' + (ck.length ? ' [cookies: ' + (ck[0] === '--cookies' ? '文件' : ck[1]) + ']' : ' [无 cookies]'));
  jobs.current = { folder: t.folder, name: t.row.name, pct: 0, status: 'downloading', detail: '' };

  const outLines = [];
  const exitInfo = await new Promise(resolve => {
    let ch;
    try { ch = spawn(ytdlp, argsList, { windowsHide: true }); }
    catch (e) { return resolve({ code: -1, err: '无法启动 yt-dlp: ' + e.message }); }
    jobs.child = ch;
    let buf = '';
    const onData = d => {
      buf += d.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const ln of lines) {
        outLines.push(ln);
        const mp = ln.match(/\[download\]\s+([\d.]+)%/);
        if (mp && jobs.current) jobs.current.pct = parseFloat(mp[1]);
      }
    };
    ch.stdout.on('data', onData);
    ch.stderr.on('data', onData);
    ch.on('error', e => resolve({ code: -1, err: '无法启动 yt-dlp: ' + e.message }));
    ch.on('close', code => resolve({ code: code }));
  });
  jobs.child = null;
  if (jobs.stopFlag) { finishJobs('已手动停止'); return; }

  let vid2 = '', title = '', author = '', dur = 0;
  for (const ln of outLines) {
    if (/^VID:(.+)$/.test(ln)) vid2 = RegExp.$1.trim();
    else if (/^TITLE:(.+)$/.test(ln)) title = RegExp.$1.trim();
    else if (/^AUTHOR:(.+)$/.test(ln)) author = RegExp.$1.trim();
    else if (/^DURATION:(\d+)/.test(ln)) dur = parseInt(RegExp.$1, 10);
  }
  if (exitInfo.code === 0 && fs.existsSync(targetPath)) {
    let sizeMB = 0;
    try { sizeMB = (fs.statSync(targetPath).size / 1048576).toFixed(1); } catch (e) {}
    // 编码检查与转码
    if (ff) {
      const ffprobe = path.join(path.dirname(ff), 'ffprobe.exe');
      if (fs.existsSync(ffprobe)) {
        const codec = await runCapture(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', targetPath], 20000);
        if (codec && codec.trim() && codec.trim().toLowerCase().indexOf('h264') < 0) {
          addLog('编码为 ' + codec.trim() + '，转换为 H.264...');
          const tmpOut = path.join(songDir, 'video_conv.mp4');
          await runCapture(ff, ['-y', '-loglevel', 'error', '-i', targetPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmpOut], 15 * 60 * 1000);
          if (fs.existsSync(tmpOut)) { try { fs.renameSync(tmpOut, targetPath); addLog('已转换为 H.264'); } catch (e) {} }
        }
      }
    }
    // 写视频配置（仅当原本没有；v1.17：合并写 + 登记 downloadedFormats，让 Theater 识别本地文件）
    if (!t.row.videoFile) {
      try {
        const cur = readVideoConfig(songDir);
        const obj = cur.obj || {};
        if (!obj.videoID) obj.videoID = vid2 || t.vid;
        if (!obj.title) obj.title = title;
        if (!obj.author) obj.author = author;
        if (obj.duration === undefined) obj.duration = dur;
        if (obj.offset === undefined) obj.offset = 0;
        if (obj.configByMapper === undefined) obj.configByMapper = false;
        obj.videoFile = target;
        syncDownloadedFormats(obj, songDir);
        fs.writeFileSync(cur.path, JSON.stringify(obj, null, 2), 'utf8');
      } catch (e) {}
    }
    jobs.stats.ok++;
    jobs.results.push({ folder: t.folder, name: t.row.name, status: 'ok', detail: sizeMB + ' MB' });
    addLog('完成: ' + t.row.name + ' (' + sizeMB + ' MB)');
    if (jobs.current) { jobs.current.status = 'done'; jobs.current.pct = 100; }
  } else {
    let errLine = '';
    for (let i = outLines.length - 1; i >= 0; i--) {
      if (/ERROR|错误|Sign in|confirm/i.test(outLines[i])) { errLine = outLines[i]; break; }
    }
    if (!errLine && outLines.length) errLine = outLines[outLines.length - 1];
    if (errLine && errLine.length > 200) errLine = errLine.slice(0, 200) + '…';
    jobs.stats.fail++;
    jobs.results.push({ folder: t.folder, name: t.row.name, status: 'fail', detail: errLine || '未知错误' });
    addLog('失败: ' + t.row.name + ' — ' + (errLine || '未知错误'));
    if (jobs.current) jobs.current.status = 'failed';
  }
  await sleep(400);
  runNextTask();
}
function finishJobs(reason) {
  if (!jobs.running && !jobs.current) return;
  jobs.running = false;
  jobs.current = null;
  jobs.queue = [];
  addLog('任务结束：' + reason + '（成功 ' + jobs.stats.ok + ' / 跳过 ' + jobs.stats.skip + ' / 失败 ' + jobs.stats.fail + '）');
}
function stopDownload() {
  if (!jobs.running) return { error: '没有进行中的任务' };
  jobs.stopFlag = true;
  if (jobs.child) killTree(jobs.child);
  return { ok: true };
}
function runCapture(exe, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '';
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    let ch;
    try { ch = spawn(exe, args, { windowsHide: true }); } catch (e) { return done(''); }
    const timer = setTimeout(() => { try { killTree(ch); } catch (e) {} done(out); }, timeoutMs || 60000);
    ch.stdout.on('data', d => out += d.toString('utf8'));
    ch.on('error', () => { clearTimeout(timer); done(''); });
    ch.on('close', () => { clearTimeout(timer); done(out); });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- 音频提取与自动对齐（试看用） ---------------- */
function songDirOf(cfg, folder) {
  return path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels', folder);
}
function findSongAudio(cfg, folder) {
  const dir = songDirOf(cfg, folder);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'Info.dat'), 'utf8'));
    const f = String(j._songFilename || '');
    if (f) { const p = path.join(dir, f); if (fs.existsSync(p)) return p; }
  } catch (e) {}
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name);
    const pref = ['song.egg', 'song.ogg', 'song.wav', 'song.mp3', 'song.m4a', 'song.flac'];
    for (const p of pref) { const hit = names.find(n => n.toLowerCase() === p); if (hit) return path.join(dir, hit); }
    const hit = names.find(n => /\.(egg|ogg|wav|mp3|m4a|flac)$/i.test(n));
    if (hit) return path.join(dir, hit);
  } catch (e) {}
  return '';
}
/* ---------- 歌曲时长（读音频文件时长，缓存到 工具目录/歌曲时长.json） ---------- */
let _durCache = null;
function durCachePath() { return path.join(TOOL, '歌曲时长.json'); }
function loadDurCache() {
  if (_durCache) return _durCache;
  try { _durCache = JSON.parse(fs.readFileSync(durCachePath(), 'utf8')); } catch (e) { _durCache = {}; }
  if (!_durCache || typeof _durCache !== 'object') _durCache = {};
  return _durCache;
}
function saveDurCache() { try { fs.writeFileSync(durCachePath(), JSON.stringify(_durCache || {}), 'utf8'); } catch (e) {} }
function fmtDurText(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec <= 0) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => (n < 10 ? '0' + n : '' + n);
  return (h > 0 ? (h + ':' + p(m)) : m) + ':' + p(s);
}
function probeAudioDuration(cfg, folder) {
  const ff = findFfmpeg(cfg);
  const probe = ff ? ffprobePath(ff) : '';
  const src = findSongAudio(cfg, folder);
  if (!probe || !src) return Promise.resolve(0);
  let sig = '';
  try { const st = fs.statSync(src); sig = st.size + ':' + Math.round(st.mtimeMs); } catch (e) { return Promise.resolve(0); }
  const cache = loadDurCache();
  const hit = cache[folder];
  if (hit && hit.sig === sig && Number(hit.dur) > 0) return Promise.resolve(Number(hit.dur));
  return runCapture(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src], 30000)
    .then(function (out) {
      const d = parseFloat(String(out).trim());
      const dur = (isFinite(d) && d > 0) ? Math.round(d * 10) / 10 : 0;
      if (dur > 0) cache[folder] = { sig: sig, dur: dur, file: path.basename(src) };
      return dur;
    }).catch(function () { return 0; });
}
async function durationMapFor(cfg, folders) {
  const uniq = [], seen = Object.create(null);
  for (const f of (folders || [])) { if (f && !seen[f]) { seen[f] = 1; uniq.push(f); } }
  const out = Object.create(null);
  if (!uniq.length) return out;
  const q = uniq.slice();
  const CONC = 6;
  async function worker() {
    while (q.length) {
      const f = q.shift();
      try { out[f] = await probeAudioDuration(cfg, f); } catch (e) { out[f] = 0; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONC, uniq.length)) }, worker));
  saveDurCache();
  return out;
}

/* ---------- 本地视频 → Cinema 可播的 video.mp4 ---------- */
function runFfmpeg(ff, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ch;
    try { ch = spawn(ff, args, { windowsHide: true }); } catch (e) { return reject(e); }
    let err = '';
    if (ch.stderr) ch.stderr.on('data', d => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    const timer = setTimeout(() => { try { ch.kill(); } catch (e) {} reject(new Error('ffmpeg 处理超时')); }, timeoutMs || 3600000);
    ch.on('error', e => { clearTimeout(timer); reject(new Error('无法启动 ffmpeg: ' + e.message)); });
    ch.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(err); else reject(new Error('ffmpeg 退出码 ' + code + (err ? ('\n' + err.slice(-600)) : '')));
    });
  });
}

function ffprobePath(ff) {
  try {
    const p = path.join(path.dirname(ff), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(p)) return p;
  } catch (e) {}
  return '';
}

// 把任意本地视频整理成 Cinema 能播的 video.mp4（H.264 + AAC）
// 原因：Cinema 会强制用 <videoFile>.mp4 去找文件；且 Unity 只稳吃 H.264，其它编码会黑屏/无画面
async function ensureCinemaMp4(srcPath, songDir, cfg) {
  const ff = findFfmpeg(cfg || loadConfig());
  if (!ff) throw new Error('未找到 ffmpeg（请检查工具配置或游戏目录 Libs）');
  const outPath = path.join(songDir, 'video.mp4');
  let converted = false;
  let needEncode = (path.extname(srcPath).toLowerCase() !== '.mp4');
  if (!needEncode) {
    const probe = ffprobePath(ff);
    if (probe) {
      try {
        const vcodec = (await runFfmpeg(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', srcPath], 120000)).trim().toLowerCase();
        if (vcodec && vcodec !== 'h264') needEncode = true;
      } catch (e) {}
    }
  }
  if (needEncode) {
    await runFfmpeg(ff, ['-y', '-i', srcPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath], 7200000);
    converted = true;
  } else if (path.resolve(srcPath) !== path.resolve(outPath)) {
    fs.copyFileSync(srcPath, outPath);
  }
  const st = fs.statSync(outPath);
  return { name: 'video.mp4', sizeMB: (st.size / 1048576).toFixed(1), converted: converted };
}

// 本地视频用的唯一 ID（Cinema 要求 videoID/videoUrl 至少一个非空）
// 每首歌不同（由文件夹名派生，稳定可复现），避免所有本地视频共用 "local" 造成冲突
function localVideoId(folder) {
  const h = crypto.createHash('sha1').update(String(folder || 'x')).digest('hex').slice(0, 10);
  return 'local-' + h;
}
function isLocalVideoId(id) { return /^local(-|$)/i.test(String(id || '')); }
/* ---------- Theater / Cinema 视频配置兼容层（v1.17） ----------
 * Theater（Cinema 的后继）规则：
 *  - 配置文件：优先用已存在的 legacy `cinema-video.json`，否则用 `theater-video.json`
 *  - 视频文件：默认按 "<title>.mp4" / "<videoID>.mp4" 找；老式 `video.mp4` 必须显式登记进
 *    `downloadedFormats: { "Mp4"|"Webm": "<绝对路径>" }` 才会被判定为“已下载”
 */
function videoConfigName(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'cinema-video.json'))) return 'cinema-video.json';
    if (fs.existsSync(path.join(dir, 'theater-video.json'))) return 'theater-video.json';
  } catch (e) {}
  return 'theater-video.json';
}
function readVideoConfig(dir) {
  const name = videoConfigName(dir);
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return { name: name, path: p, obj: null };
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return { name: name, path: p, obj: JSON.parse(raw) };
  } catch (e) { return { name: name, path: p, obj: null }; }
}
function syncDownloadedFormats(obj, songDir) {
  try {
    const vids = fs.readdirSync(songDir, { withFileTypes: true })
      .filter(d => d.isFile() && /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(d.name)).map(d => d.name);
    if (!vids.length) return obj;
    const main = vids.find(v => /^video\./i.test(v)) || vids[0];
    const fmt = /\.webm$/i.test(main) ? 'Webm' : 'Mp4';
    if (!obj.downloadedFormats || typeof obj.downloadedFormats !== 'object') obj.downloadedFormats = {};
    obj.downloadedFormats[fmt] = path.join(songDir, main);
    if (!obj.videoFile) obj.videoFile = main;
  } catch (e) {}
  return obj;
}
function writeVideoConfig(songDir, targetName, folder) {
  const cur = readVideoConfig(songDir);
  const obj = cur.obj || { offset: 0, configByMapper: false };
  if (targetName) obj.videoFile = targetName;
  if (obj.offset === undefined || obj.offset === null) obj.offset = 0;
  if (!obj.videoID && !obj.videoUrl) obj.videoID = localVideoId(folder || path.basename(songDir));
  syncDownloadedFormats(obj, songDir);
  fs.writeFileSync(cur.path, JSON.stringify(obj, null, 2), 'utf8');
  return obj;
}
function writeCinemaConfig(songDir, targetName, folder) { return writeVideoConfig(songDir, targetName, folder); }

function findVideoFile(cfg, folder) {
  const dir = songDirOf(cfg, folder);
  try {
    const cj = readVideoConfig(dir).obj || {};
    for (const k of Object.keys(cj.downloadedFormats || {})) {
      const p = String(cj.downloadedFormats[k] || '');
      if (!p) continue;
      if (fs.existsSync(p)) return p;
      const alt = path.join(dir, path.basename(p));
      if (fs.existsSync(alt)) return alt;
    }
    if (cj.videoFile) { const p = path.join(dir, String(cj.videoFile)); if (fs.existsSync(p)) return p; }
  } catch (e) {}
  try {
    const vids = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(d.name));
    if (vids.length) return path.join(dir, vids[0].name);
  } catch (e) {}
  return '';
}
const audioBuilds = new Map();
function audioCachePath(folder, kind) {
  ensureDir(AUDIO_CACHE_DIR);
  const safe = String(folder).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  return path.join(AUDIO_CACHE_DIR, safe + '__' + kind + '.mp3');
}
function ensureAudioFile(cfg, folder, kind) {
  const src = kind === 'video' ? findVideoFile(cfg, folder) : findSongAudio(cfg, folder);
  if (!src) return Promise.reject(new Error(kind === 'video' ? '找不到视频文件' : '找不到歌曲音频文件（song.egg 等）'));
  const out = audioCachePath(folder, kind);
  try {
    if (fs.existsSync(out)) {
      const so = fs.statSync(out), ss2 = fs.statSync(src);
      if (so.size > 1000 && so.mtimeMs >= ss2.mtimeMs) return Promise.resolve(out);
    }
  } catch (e) {}
  if (audioBuilds.has(out)) return audioBuilds.get(out);
  const p = new Promise((resolve, reject) => {
    const ff = findFfmpeg(cfg);
    if (!ff) return reject(new Error('未找到 ffmpeg'));
    const tmp = out + '.part';
    try { fs.unlinkSync(tmp); } catch (e) {}
    const args = ['-y', '-loglevel', 'error', '-i', src, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', tmp];
    let err = '', ch;
    try { ch = spawn(ff, args, { windowsHide: true }); } catch (e) { return reject(new Error('无法启动 ffmpeg: ' + e.message)); }
    const timer = setTimeout(() => { try { killTree(ch); } catch (e) {} reject(new Error('音频转换超时')); }, 180000);
    ch.stderr.on('data', d => { if (err.length < 4000) err += d.toString('utf8'); });
    ch.on('error', e => { clearTimeout(timer); reject(new Error('无法启动 ffmpeg: ' + e.message)); });
    ch.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 1000) {
        try { fs.renameSync(tmp, out); resolve(out); }
        catch (e) { reject(new Error('写入缓存失败: ' + e.message)); }
      } else {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        const last = err.split(/\r?\n/).filter(Boolean).pop() || ('退出码 ' + code);
        reject(new Error('音频提取失败：' + last.slice(0, 160)));
      }
    });
  });
  audioBuilds.set(out, p);
  p.catch(() => {}).then(() => { audioBuilds.delete(out); });
  return p;
}
function serveFileRange(req, res, file, ctype) {
  const stat = fs.statSync(file);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (end >= stat.size) end = stat.size - 1;
      if (start >= stat.size || start > end) { res.writeHead(416); return res.end(); }
      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': ctype
      });
      return fs.createReadStream(file, { start: start, end: end }).pipe(res);
    }
  }
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': ctype, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

/* -------- PCM 解码 / 包络 / 互相关（自动对齐核心） -------- */
function decodePcm16(ff, src, sr) {
  return new Promise((resolve, reject) => {
    const MAXBYTES = sr * 2 * 1800;
    const args = ['-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', 'pipe:1'];
    let ch;
    try { ch = spawn(ff, args, { windowsHide: true }); } catch (e) { return reject(new Error('无法启动 ffmpeg: ' + e.message)); }
    const chunks = []; let total = 0, err = '';
    const timer = setTimeout(() => { try { killTree(ch); } catch (e) {} reject(new Error('音频解码超时')); }, 180000);
    ch.stdout.on('data', d => { if (total < MAXBYTES) { chunks.push(d); total += d.length; } });
    ch.stderr.on('data', d => { if (err.length < 2000) err += d.toString('utf8'); });
    ch.on('error', e => { clearTimeout(timer); reject(new Error('无法启动 ffmpeg: ' + e.message)); });
    ch.on('close', code => {
      clearTimeout(timer);
      if (total > 0 && code === 0) return resolve(Buffer.concat(chunks));
      const last = err.split(/\r?\n/).filter(Boolean).pop() || ('退出码 ' + code);
      reject(new Error('无法解码音频：' + last.slice(0, 160)));
    });
  });
}
function envelopeFromPcm(buf, sr, hopMs) {
  const hop = Math.max(1, Math.round(sr * hopMs / 1000));
  const n = Math.floor(buf.length / 2 / hop);
  const e = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const off = f * hop * 2;
    let sum = 0;
    for (let i = 0; i < hop; i++) { const v = buf.readInt16LE(off + i * 2); sum += v * v; }
    e[f] = Math.sqrt(sum / hop);
  }
  return e;
}
function localContrast(e, win) {
  const n = e.length, out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += e[i];
    if (i >= win) sum -= e[i - win];
    const cnt = Math.min(i + 1, win);
    out[i] = e[i] - sum / cnt;
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += out[i] * out[i];
  const std = Math.sqrt(ss / Math.max(1, n)) || 1;
  for (let i = 0; i < n; i++) out[i] /= std;
  return out;
}
function poolMax(a, factor) {
  const n = Math.floor(a.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = a[i * factor];
    for (let j = 1; j < factor; j++) { const v = a[i * factor + j]; if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}
function prefixSq(a) {
  const p = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) p[i + 1] = p[i] + a[i] * a[i];
  return p;
}
function nccScan(s, v, kmin, kmax, minOverlap, excl) {
  const Ns = s.length, Nv = v.length;
  const ps = prefixSq(s), pv = prefixSq(v);
  const count = kmax - kmin + 1;
  const arr = new Float64Array(count);
  let best = -2, bestK = kmin;
  for (let idx = 0; idx < count; idx++) {
    const k = kmin + idx;
    const i0 = Math.max(0, -k), i1 = Math.min(Ns, Nv - k);
    let sc = -2;
    if (i1 - i0 >= minOverlap) {
      let dot = 0;
      for (let i = i0; i < i1; i++) dot += s[i] * v[i + k];
      const es = ps[i1] - ps[i0], ev = pv[i1 + k] - pv[i0 + k];
      sc = dot / (Math.sqrt(es * ev) + 1e-9);
    }
    arr[idx] = sc;
    if (sc > best) { best = sc; bestK = k; }
  }
  let second = -2;
  for (let idx = 0; idx < count; idx++) {
    const k = kmin + idx;
    if (Math.abs(k - bestK) < excl) continue;
    if (arr[idx] > second) second = arr[idx];
  }
  return { bestK: bestK, best: best, second: second };
}
let autoSyncBusy = false;
async function autoSyncFolder(folder) {
  if (autoSyncBusy) throw new Error('已有分析任务在进行中，请稍候再试');
  const cfg = loadConfig();
  const songSrc = findSongAudio(cfg, folder);
  if (!songSrc) throw new Error('找不到歌曲音频文件（song.egg 等）');
  const videoSrc = findVideoFile(cfg, folder);
  if (!videoSrc) throw new Error('找不到视频文件');
  const ff = findFfmpeg(cfg);
  if (!ff) throw new Error('未找到 ffmpeg（请检查游戏目录 Libs 或工具配置）');
  autoSyncBusy = true;
  const t0 = Date.now();
  try {
    const SR = 8000, HOP = 5, FINE_FPS = 200, POOL = 8;
    const pcmS = await decodePcm16(ff, songSrc, SR);
    const pcmV = await decodePcm16(ff, videoSrc, SR);
    const eS = localContrast(envelopeFromPcm(pcmS, SR, HOP), 400);
    const eV = localContrast(envelopeFromPcm(pcmV, SR, HOP), 400);
    if (eS.length < 400 || eV.length < 400) throw new Error('音频过短，无法对齐');
    const cs = poolMax(eS, POOL), cv = poolMax(eV, POOL);
    const minC = Math.max(300, Math.floor(0.25 * Math.min(cs.length, cv.length)));
    const maxLagC = 150 * 25;
    const kmin = Math.max(-(cs.length - 1), -maxLagC);
    const kmax = Math.min(cv.length - 1, maxLagC);
    if (kmin > kmax) throw new Error('两条音轨重叠太少，无法对齐');
    const coarse = nccScan(cs, cv, kmin, kmax, minC, 25 * 2);
    const rad = 0.8 * FINE_FPS;
    const fmin = Math.round(Math.max(-(eS.length - 1), coarse.bestK * POOL - rad));
    const fmax = Math.round(Math.min(eV.length - 1, coarse.bestK * POOL + rad));
    const minF = Math.max(2400, Math.floor(0.25 * Math.min(eS.length, eV.length)));
    const fine = nccScan(eS, eV, fmin, fmax, minF, FINE_FPS * 2);
    if (fine.best <= -1.5) throw new Error('两条音轨重叠太少，无法对齐');
    const kF = fine.bestK;
    const offsetMs = Math.round(kF * HOP);
    const songDur = eS.length * HOP / 1000, videoDur = eV.length * HOP / 1000;
    const i0 = Math.max(0, -kF), i1 = Math.min(eS.length, eV.length - kF);
    const ovA = i0 * HOP / 1000, ovB = i1 * HOP / 1000;
    let seek = (ovA + ovB) / 2;
    seek = Math.min(Math.max(seek, 10), Math.max(10, songDur - 15));
    const ratio = fine.second > 0.02 ? (fine.best / fine.second) : (fine.best > 0.04 ? 9.9 : 0);
    return {
      ok: true, folder: folder,
      offsetMs: offsetMs,
      peak: Number(fine.best.toFixed(4)),
      peakCoarse: Number(coarse.best.toFixed(4)),
      ratio: Number(Math.min(ratio, 9.9).toFixed(3)),
      songDurSec: Number(songDur.toFixed(1)), videoDurSec: Number(videoDur.toFixed(1)),
      overlapStartSec: Number(ovA.toFixed(1)), overlapEndSec: Number(ovB.toFixed(1)),
      suggestSeekSec: Number(seek.toFixed(1)),
      elapsedMs: Date.now() - t0
    };
  } finally {
    autoSyncBusy = false;
  }
}

/* ---------------- HTTP 服务 ---------------- */
/* ---------- 视频维护：删视频 / 删音频 ---------- */
function listVideoFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(d.name)).map(d => d.name); }
  catch (e) { return []; }
}
function deleteVideoForFolder(folder) {
  const cfg = loadConfig();
  const dir = songDirOf(cfg, folder);
  if (!fs.existsSync(dir)) throw new Error('歌曲目录不存在');
  const removed = [];
  for (const nm of ['cinema-video.json', 'theater-video.json']) {
    const cfgFile = path.join(dir, nm);
    if (fs.existsSync(cfgFile)) { fs.unlinkSync(cfgFile); removed.push(nm); }
  }
  for (const n of listVideoFiles(dir)) { fs.unlinkSync(path.join(dir, n)); removed.push(n); }
  if (!removed.length) throw new Error('这个歌目录里没有视频文件');
  return removed;
}
async function stripVideoAudioForFolder(folder) {
  const cfg = loadConfig();
  const v = findVideoFile(cfg, folder);
  if (!v) throw new Error('找不到视频文件');
  const ff = findFfmpeg(cfg);
  if (!ff) throw new Error('未找到 ffmpeg');
  const ext = path.extname(v);
  const dir = path.dirname(v);
  const tmp = path.join(dir, path.basename(v, ext) + '.noaudio' + ext);
  try { fs.unlinkSync(tmp); } catch (e) {}
  const before = fs.statSync(v).size;
  await runFfmpeg(ff, ['-y', '-v', 'error', '-i', v, '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', tmp], 1800000);
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) throw new Error('处理失败（未生成输出文件）');
  const after = fs.statSync(tmp).size;
  fs.renameSync(tmp, v);
  return { name: path.basename(v), beforeMB: (before / 1048576).toFixed(1), afterMB: (after / 1048576).toFixed(1), savedMB: ((before - after) / 1048576).toFixed(1) };
}

/* ---------- 查重：按文件夹名前缀（谱面 ID）分组 ---------- */
const dupState = { running: false, done: 0, total: 0, phase: '', error: '', groups: [], startedAt: 0, finishedAt: 0, exactCount: 0, nearCount: 0 };

// 取文件夹名第一个空格之前的部分作为 ID，例如：
//   "10af0 (mousou zei - Dack)" -> "10af0"
function songFolderKey(folder) {
  const s = String(folder || '').trim();
  if (/\(built\s*in\)/i.test(s)) return '';            // 官方 OST 不算
  const sp = s.search(/[\s(（\[]/);
  const k = (sp > 0 ? s.slice(0, sp) : s).trim();
  if (!/^[0-9A-Za-z]{4,8}$/.test(k)) return '';          // 前缀要像谱面 ID
  if (!/[0-9]/.test(k)) return '';                        // 且必须含数字（排除 "Jaroslav" 之类作者名）
  return k;
}
function runFolderDup() {
  if (dupState.running) return;
  dupState.running = true; dupState.done = 0; dupState.phase = '按文件夹 ID 分组…';
  dupState.groups = []; dupState.error = ''; dupState.startedAt = Date.now(); dupState.finishedAt = 0;
  dupState.exactCount = 0; dupState.nearCount = 0;
  try {
    const cfg = loadConfig();
    const rows = scanSongs(cfg);
    dupState.total = rows.length; dupState.done = rows.length;
    const map = new Map();
    for (const r of rows) {
      const key = songFolderKey(r.folder);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    const groups = [];
    for (const [key, arr] of map) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => (b.hasVideo ? 1 : 0) - (a.hasVideo ? 1 : 0) || (b.hasConfig ? 1 : 0) - (a.hasConfig ? 1 : 0));
      groups.push({
        kind: 'id', key: key, dur: 0, score: 1,
        members: arr.map(r => ({
          folder: r.folder, name: r.name, artist: r.artist, hasVideo: !!r.hasVideo,
          videoSizeMB: r.videoSizeMB || '', dur: 0, offset: r.offset
        }))
      });
    }
    groups.sort((a, b) => (b.members.length - a.members.length) || a.key.localeCompare(b.key));
    dupState.groups = groups;
    dupState.exactCount = groups.length;
    let extra = 0;
    groups.forEach(g => { extra += g.members.length - 1; });
    dupState.phase = '完成';
    addLog('查重（文件夹 ID）完成：' + groups.length + ' 组重复、冗余 ' + extra + ' 个文件夹（共 ' + rows.length + ' 个）');
  } catch (e) {
    dupState.error = e.message || String(e);
    addLog('查重失败：' + dupState.error);
  }
  dupState.running = false;
  dupState.finishedAt = Date.now();
}

/* ---------- 谱面（游戏内内容）解析 ---------- */
const DIFF_ORDER = ['expertplus', 'expert', 'hard', 'normal', 'easy'];
function pickKey(o, keys) { for (const k of keys) { if (o && o[k] !== undefined && o[k] !== null) return o[k]; } return undefined; }
function readInfoDat(dir) {
  const cands = ['Info.dat', 'info.dat', 'Info.JSON', 'info.json'];
  for (const c of cands) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {} }
  }
  try {
    const hit = fs.readdirSync(dir).find(n => /^info\.(dat|json)$/i.test(n));
    if (hit) return JSON.parse(fs.readFileSync(path.join(dir, hit), 'utf8'));
  } catch (e) {}
  return null;
}
function beatmapDiffs(info, dir) {
  const sets = pickKey(info, ['_difficultyBeatmapSets', 'difficultyBeatmapSets']) || [];
  const out = [];
  for (const s of sets) {
    const ch = String(pickKey(s, ['_beatmapCharacteristicName', 'beatmapCharacteristicName']) || '');
    const list = pickKey(s, ['_difficultyBeatmaps', 'difficultyBeatmaps']) || [];
    for (const d of list) {
      const name = String(pickKey(d, ['_difficulty', 'difficulty']) || '');
      const file = String(pickKey(d, ['_beatmapFilename', 'beatmapFilename']) || '');
      const njs = Number(pickKey(d, ['_noteJumpMovementSpeed', 'noteJumpMovementSpeed']) || 0);
      if (!name || !file) continue;
      if (!fs.existsSync(path.join(dir, file))) continue;
      out.push({ name: name, file: file, njs: njs, ch: ch });
    }
  }
  /* v4 格式（Info.version 4.x）：难度平铺在顶层 difficultyBeatmaps，文件名为 beatmapDataFilename（如 ExpertPlusStandard.dat） */
  if (!out.length && info && Array.isArray(info.difficultyBeatmaps)) {
    for (const d of info.difficultyBeatmaps) {
      const name = String(pickKey(d, ['difficulty']) || '');
      const ch = String(pickKey(d, ['characteristic']) || '');
      let file = String(pickKey(d, ['beatmapDataFilename']) || '');
      if (!name) continue;
      if (!file) file = name + ch + '.dat';
      if (!fs.existsSync(path.join(dir, file))) {
        let hit = null;
        try { const want = (name + ch + '.dat').toLowerCase(); hit = fs.readdirSync(dir).find(n => n.toLowerCase() === want); } catch (e) {}
        if (!hit) { try { hit = fs.readdirSync(dir).find(n => /\.dat$/i.test(n) && n.toLowerCase().indexOf(name.toLowerCase()) === 0); } catch (e) {} }
        if (hit) file = hit; else continue;
      }
      out.push({ name: name, file: file, njs: Number(pickKey(d, ['noteJumpMovementSpeed']) || 0), ch: ch });
    }
  }
  return out;
}
/* ---------- 给"只认 v2 格式"的 bs-viewer 做格式转换（只在打包 zip 时用于临时副本，不动原文件） ---------- */
function convertDiffToV2(o) {
  const notes = [];
  for (const n of (o.colorNotes || [])) notes.push({ _time: Number(n.b), _lineIndex: Number(n.x), _lineLayer: Number(n.y), _type: Number(n.c), _cutDirection: Number(n.d) });
  for (const b of (o.bombNotes || [])) notes.push({ _time: Number(b.b), _lineIndex: Number(b.x), _lineLayer: Number(b.y), _type: 3, _cutDirection: 0 });
  notes.sort((a, b) => a._time - b._time);
  const obstacles = [];
  for (const ob of (o.obstacles || [])) obstacles.push({ _time: Number(ob.b), _lineIndex: Number(ob.x), _type: Math.max(0, Math.min(2, Number(ob.y || 0) + Number(ob.h || 1) - 1)), _duration: Number(ob.d || 0), _width: Number(ob.w || 1) });
  const events = [];
  for (const ev of (o.basicBeatmapEvents || [])) events.push({ _time: Number(ev.b), _type: Number(ev.et), _value: Number(ev.i || 0), _floatValue: Number(ev.f || 0) });
  for (const rv of (o.rotationEvents || [])) events.push({ _time: Number(rv.b), _type: Number(rv.e) === 0 ? 14 : 15, _value: Number(rv.r || 0), _floatValue: 0 });
  return { _version: '2.0.0', _notes: notes, _obstacles: obstacles, _events: events };
}
function convertInfoToV2(o) {
  if (!o || o._difficultyBeatmapSets || !Array.isArray(o.difficultyBeatmaps)) return null;
  const groups = {};
  for (const d of o.difficultyBeatmaps) {
    const ch = String(d.characteristic || 'Standard');
    (groups[ch] = groups[ch] || []).push({
      _difficulty: String(d.difficulty || ''),
      _beatmapFilename: String(d.beatmapDataFilename || (String(d.difficulty || '') + ch + '.dat')),
      _noteJumpMovementSpeed: Number(d.noteJumpMovementSpeed || 0),
      _noteJumpStartBeatOffset: Number(d.noteJumpStartBeatOffset || 0)
    });
  }
  const song = o.song || {}, audio = o.audio || {};
  const da = o.difficultyBeatmaps[0] && o.difficultyBeatmaps[0].beatmapAuthors;
  const mappers = (da && da.mappers) || [];
  return {
    _version: '2.0.0',
    _songName: String(song.title || ''), _songSubName: String(song.subTitle || ''), _songAuthorName: String(song.author || ''), _levelAuthorName: String(mappers[0] || ''),
    _beatsPerMinute: Number(audio.bpm || 120), _songTimeOffset: 0, _shuffle: 0, _shufflePeriod: 0.5,
    _previewStartTime: Number(audio.previewStartTime || 0), _previewDuration: Number(audio.previewDuration || 0),
    _songFilename: String(audio.songFilename || ''), _coverImageFilename: String(o.coverImageFilename || ''),
    _environmentName: String((o.environmentNames && o.environmentNames[0]) || 'DefaultEnvironment'),
    _difficultyBeatmapSets: Object.keys(groups).map(ch => ({ _beatmapCharacteristicName: ch, _difficultyBeatmaps: groups[ch] }))
  };
}
function parseBeatmapForFolder(cfg, folder, diffWanted) {
  const dir = songDirOf(cfg, folder);
  if (!fs.existsSync(dir)) throw new Error('歌曲目录不存在');
  const info = readInfoDat(dir);
  if (!info) throw new Error('读不到 Info.dat');
  let bpm = Number(pickKey(info, ['_beatsPerMinute', 'beatsPerMinute']) || 0);
  if (!(bpm > 0) && info.audio && info.audio.bpm) bpm = Number(info.audio.bpm) || 0;   /* v4：BPM 在 audio.bpm */
  const songOffset = Number(pickKey(info, ['_songTimeOffset', 'songTimeOffset']) || 0);
  const all = beatmapDiffs(info, dir);
  if (!all.length) throw new Error('这首歌没有可读的难度文件');
  // 优先 Standard 特征，其次任意；难度由难到易排
  const std = all.filter(d => /standard/i.test(d.ch));
  const pool = std.length ? std : all;
  const rank = d => { const i = DIFF_ORDER.indexOf(String(d.name).toLowerCase().replace(/[\s_]/g, '')); return i < 0 ? 99 : i; };
  pool.sort((a, b) => rank(a) - rank(b));
  let sel = null;
  if (diffWanted) sel = pool.find(d => String(d.name).toLowerCase() === String(diffWanted).toLowerCase());
  if (!sel) sel = pool[0];
  let dat = null;
  try { dat = JSON.parse(fs.readFileSync(path.join(dir, sel.file), 'utf8')); } catch (e) { throw new Error('难度文件解析失败：' + sel.file); }
  const bps = bpm > 0 ? bpm / 60 : 0;
  const sec = b => (bps > 0 ? b / bps : 0) + songOffset;
  const r3 = v => Math.round(v * 1000) / 1000;
  const notes = [], bombs = [], obstacles = [];
  const rawNotes = pickKey(dat, ['_notes', 'colorNotes']) || [];
  for (const n of rawNotes) {
    const b = Number(pickKey(n, ['_time', 'b']));
    const x = Number(pickKey(n, ['_lineIndex', 'x']));
    const y = Number(pickKey(n, ['_lineLayer', 'y']));
    const c = Number(pickKey(n, ['_type', 'c']));
    const d = Number(pickKey(n, ['_cutDirection', 'd']));
    if (!isFinite(b)) continue;
    notes.push([r3(sec(b)), x, y, c, d]);
  }
  for (const n of (pickKey(dat, ['_bombs', 'bombNotes']) || [])) {
    const b = Number(pickKey(n, ['_time', 'b']));
    if (!isFinite(b)) continue;
    bombs.push([r3(sec(b)), Number(pickKey(n, ['_lineIndex', 'x'])), Number(pickKey(n, ['_lineLayer', 'y']))]);
  }
  for (const o of (pickKey(dat, ['_obstacles', 'obstacles']) || [])) {
    const b = Number(pickKey(o, ['_time', 'b']));
    if (!isFinite(b)) continue;
    obstacles.push([r3(sec(b)), Number(pickKey(o, ['_lineIndex', 'x'])), Number(pickKey(o, ['_width', 'w']) || 1), r3(Number(pickKey(o, ['_duration', 'd']) || 0) / (bps > 0 ? bps : 1))]);
  }
  notes.sort((a, b) => a[0] - b[0]);
  const dur = notes.length ? (notes[notes.length - 1][0] - notes[0][0]) : 0;
  return {
    folder: folder, bpm: bpm, songTimeOffset: songOffset, difficulty: sel.name, njs: sel.njs,
    diffs: pool.map(d => d.name), counts: { notes: notes.length, bombs: bombs.length, obstacles: obstacles.length },
    nps: dur > 0 ? Math.round(notes.length / dur * 100) / 100 : 0,
    firstNote: notes.length ? notes[0][0] : 0, lastNote: notes.length ? notes[notes.length - 1][0] : 0,
    notes: notes, bombs: bombs, obstacles: obstacles
  };
}

/* ---------- 删除歌曲（移到回收目录，可恢复） ---------- */
function moveSongToTrash(folder) {
  const cfg = loadConfig();
  const dir = songDirOf(cfg, folder);
  if (!fs.existsSync(dir)) throw new Error('歌曲目录不存在');
  const trashRoot = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels_已删除');
  ensureDir(trashRoot);
  let dest = path.join(trashRoot, String(folder));
  if (fs.existsSync(dest)) dest = dest + '_' + Date.now();
  fs.renameSync(dir, dest);
  return dest;
}

function sendJSON(res, obj, code) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
  res.end(body);
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 5 * 1024 * 1024) { req.destroy(); } });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
function serveStatic(res, filePath) {
  try {
    if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('404'); }
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': data.length });
    res.end(data);
  } catch (e) { res.writeHead(500); res.end('500'); }
}
function serveVideo(req, res, folder) {
  const cfg = loadConfig();
  const rows = scanSongs(cfg);
  let r = null;
  for (const x of rows) { if (x.folder === folder) { r = x; break; } }
  if (!r) { res.writeHead(404); return res.end('not found'); }
  const dir = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels', folder);
  let file = r.videoFile ? path.join(dir, r.videoFile) : '';
  if (!file || !fs.existsSync(file)) {
    try {
      const vids = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && /\.(mp4|webm|mkv|mov|m4v|avi)$/i.test(d.name));
      if (vids.length) file = path.join(dir, vids[0].name);
    } catch (e) {}
  }
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end('no video'); }
  const stat = fs.statSync(file);
  const ctype = /\.webm$/i.test(file) ? 'video/webm' : 'video/mp4';
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size) { res.writeHead(416); return res.end(); }
      res.writeHead(206, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': ctype });
      return fs.createReadStream(file, { start: start, end: end }).pipe(res);
    }
  }
  res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': ctype, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

/* ================= 播放列表（PlaylistManager .bplist） =================
 * 谱面 hash 算法（PlaylistManager 用它匹配本地谱面；已用 75 个真实谱面验证命中 72 个）：
 *   sha1( Info.dat 原始字节 + 按 Info.dat 里 _difficultyBeatmapSets 顺序的各难度 .dat 原始字节 )
 */
const PL_BACKUP_DIR = path.join(TOOL, '播放列表备份');
const PL_HASH_CACHE = Object.create(null);

function playlistsDirOf(cfg) { return path.join(String(cfg['游戏目录'] || DEFAULT_GAME), 'Playlists'); }
function safeFileToken(s) {
  const t = String(s == null ? '' : s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return t || 'playlist';
}
function readJsonTolerant(p) {
  let raw = fs.readFileSync(p, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}
function plStatSig(p) { try { const s = fs.statSync(p); return s.size + ':' + Math.round(s.mtimeMs); } catch (e) { return '-'; } }
function localMapHash(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return ''; }
  const infoName = files.find(n => /^info\.(dat|json)$/i.test(n));
  if (!infoName) return '';
  const infoPath = path.join(dir, infoName);
  const info = readInfoDat(dir);
  if (!info) return '';
  const lower = Object.create(null);
  files.forEach(n => { lower[n.toLowerCase()] = n; });
  const diffPaths = [];
  const sets = pickKey(info, ['_difficultyBeatmapSets', 'difficultyBeatmapSets']) || [];
  for (const s of sets) {
    const list = pickKey(s, ['_difficultyBeatmaps', 'difficultyBeatmaps']) || [];
    for (const d of list) {
      const fn = String(pickKey(d, ['_beatmapFilename', 'beatmapFilename']) || '');
      if (!fn) continue;
      const fp = path.join(dir, lower[fn.toLowerCase()] || fn);
      if (fs.existsSync(fp)) diffPaths.push(fp);
    }
  }
  const sig = plStatSig(infoPath) + '|' + diffPaths.map(plStatSig).join('|');
  const cached = PL_HASH_CACHE[dir];
  if (cached && cached.sig === sig) return cached.hash;
  try {
    const h = crypto.createHash('sha1');
    h.update(fs.readFileSync(infoPath));
    for (const fp of diffPaths) h.update(fs.readFileSync(fp));
    const hash = h.digest('hex');
    PL_HASH_CACHE[dir] = { sig: sig, hash: hash };
    return hash;
  } catch (e) { return ''; }
}
function localSongIndex(cfg) {
  const rows = scanSongs(cfg);
  const cl = path.join(String(cfg['游戏目录'] || DEFAULT_GAME), 'Beat Saber_Data', 'CustomLevels');
  const byHash = Object.create(null), byKey = Object.create(null), byFolder = Object.create(null);
  for (const r of rows) {
    const hash = localMapHash(path.join(cl, r.folder));
    const key = songFolderKey(r.folder);
    byFolder[r.folder] = { folder: r.folder, name: r.name, artist: r.artist, mapper: r.mapper, hasVideo: !!r.hasVideo, offset: r.offset, key: key, hash: hash };
    if (hash) byHash[hash] = byFolder[r.folder];
    if (key) byKey[key.toLowerCase()] = byFolder[r.folder];
  }
  return { rows: rows, byHash: byHash, byKey: byKey, byFolder: byFolder };
}
function matchPlEntry(entry, idx) {
  const h = String((entry && entry.hash) || '').trim().toLowerCase();
  if (h && idx.byHash[h]) return idx.byHash[h];
  const k = String((entry && entry.key) || '').trim().toLowerCase();
  if (k && idx.byKey[k]) return idx.byKey[k];
  return null;
}
function entryFromFolder(idx, folder) {
  const it = idx.byFolder[folder];
  if (!it) return null;
  const e = {};
  if (it.key) e.key = it.key;
  if (it.hash) e.hash = it.hash;
  e.songName = it.name || folder;
  if (it.mapper) e.levelAuthorName = it.mapper;
  return e;
}
function plKeyOf(e) {
  if (e.hash) return 'h:' + String(e.hash).toLowerCase();
  if (e.key) return 'k:' + String(e.key).toLowerCase();
  return 'n:' + String(e.songName || '').toLowerCase();
}
function plList(cfg) {
  const dir = playlistsDirOf(cfg);
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /\.(bplist|json)$/i.test(n)); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const full = path.join(dir, n);
    let st; try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    let obj = null, err = '';
    try { obj = readJsonTolerant(full); } catch (e) { err = e.message; }
    out.push({ file: n, mtime: st.mtimeMs, sizeKB: Math.round(st.size / 1024), obj: obj, error: err });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
function backupPlFile(dir, f) {
  ensureDir(PL_BACKUP_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.copyFileSync(path.join(dir, f), path.join(PL_BACKUP_DIR, f + '.bak_' + ts)); } catch (e) {}
}
function writePlFile(dir, f, obj) { ensureDir(dir); fs.writeFileSync(path.join(dir, f), JSON.stringify(obj, null, 2), 'utf8'); }
/* ---------- 无缝挑战（SetlistChallenge）配置目录 ---------- */
function challengesDirOf(cfg) {
  return path.join(String(cfg['游戏目录'] || DEFAULT_GAME), 'UserData', 'SetlistChallenge');
}
function writeJson(dir, f, obj) { ensureDir(dir); fs.writeFileSync(path.join(dir, f), JSON.stringify(obj, null, 2), 'utf8'); }
function plList2(dir, filterRe) {
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(function (n) { return filterRe.test(n); }); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const full = path.join(dir, n);
    let st; try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    let obj = null, err = '';
    try { obj = readJsonTolerant(full); } catch (e) { err = e.message; }
    out.push({ file: n, mtime: st.mtimeMs, obj: obj, error: err });
  }
  out.sort(function (a, b) { return b.mtime - a.mtime; });
  return out;
}
function plNormalizeSongs(arr) {
  const out = [];
  for (const raw of (Array.isArray(arr) ? arr : [])) {
    const s = raw || {};
    const e = {};
    if (s.key) e.key = String(s.key);
    if (s.hash) e.hash = String(s.hash).toLowerCase();
    e.songName = String(s.songName || '');
    if (s.levelAuthorName) e.levelAuthorName = String(s.levelAuthorName);
    if (!e.songName && !e.hash && !e.key) continue;
    out.push(e);
  }
  return out;
}
function plEntryFromBody(body, idx) {
  const folders = Array.isArray(body.folders) ? body.folders : null;
  if (folders && folders.length) return folders.map(fo => entryFromFolder(idx, String(fo))).filter(Boolean);
  if (Array.isArray(body.songs)) return plNormalizeSongs(body.songs);
  return [];
}
function plDedupe(songs) {
  const seen = Object.create(null); const uniq = [];
  for (const e of songs) { const k = plKeyOf(e); if (!seen[k]) { seen[k] = 1; uniq.push(e); } }
  return uniq;
}

/* ================= 难度评分（游戏内显示的星级 · BeatLeader 预测 + ScoreSaber 回退） ================= */
const SS_STARS_CACHE = Object.create(null);   // hash(lower) -> { ts, stars }
const SS_DIFFS = [['Easy', 1], ['Normal', 3], ['Hard', 5], ['Expert', 7], ['ExpertPlus', 9]];
async function httpJsonDirectFirst(url) {
  // 直连优先（本机直连可通 beatsaver/scoresaber/beatleader），失败再退回工具配置的代理
  const out1 = await runCapture(curlBin(), ['-s', '-m', '12', '-A', BS_UA, url], 16000);
  if (out1 && out1.trim().charAt(0) === '{') return out1;
  const p = effectiveProxy(loadConfig());
  if (p) { const out2 = await runCapture(curlBin(), ['-s', '-m', '12', '-A', BS_UA, '--proxy', p, url], 16000); if (out2 && out2.trim().charAt(0) === '{') return out2; }
  return out1 || '';
}
async function blStarsByHash(hash) {
  // BeatLeader：对所有图（含未上榜）都给出按谱面计算的预测星级
  const h = String(hash || '').toLowerCase();
  if (!h) return null;
  const out = await httpJsonDirectFirst('https://api.beatleader.com/map/hash/' + encodeURIComponent(h));
  if (!out) return null;
  let j; try { j = JSON.parse(out); } catch (e) { return null; }
  const stars = {};
  (j.difficulties || []).forEach(function (x) {
    const mode = String(x.modeName || 'Standard');
    if (mode && mode !== 'Standard') return;
    const mr = x.modifiersRating || {};
    const s = Number(mr.ssStars || 0);
    const dn = String(x.difficultyName || '');
    if (dn && s > 0) stars[dn] = Math.round(s * 100) / 100;
  });
  return stars;
}
async function ssStarsByHash(hash) {
  const h = String(hash || '').toLowerCase();
  if (!h) return null;
  const stars = {};
  const res = await Promise.all(SS_DIFFS.map(async function (pair) {
    const url = 'https://scoresaber.com/api/leaderboard/by-hash/' + encodeURIComponent(h) + '/info?difficulty=' + pair[1] + '&gameMode=SoloStandard';
    const out = await httpJsonDirectFirst(url);
    if (!out) return null;
    try { const j = JSON.parse(out); return { n: pair[0], s: Number(j.stars || 0) }; } catch (e) { return null; }
  }));
  res.forEach(function (r) { if (r && r.s > 0) stars[r.n] = Math.round(r.s * 100) / 100; });
  return stars;
}
async function starsByHash(hash) {
  const h = String(hash || '').toLowerCase();
  if (!h) return null;
  const now = Date.now();
  const c = SS_STARS_CACHE[h];
  if (c && (now - c.ts) < 6 * 3600 * 1000) return c.stars;
  let stars = {};
  try { stars = (await blStarsByHash(h)) || {}; } catch (e) { stars = {}; }
  if (!Object.keys(stars).length) { try { const s2 = await ssStarsByHash(h); if (s2) stars = s2; } catch (e) {} }
  SS_STARS_CACHE[h] = { ts: now, stars: stars };
  return stars;
}

/* ================= 谱面下载（BeatSaver → CustomLevels） ================= */
const MAP_TMP_DIR = path.join(TOOL, 'tmp');
const BS_UA = 'BeatSaberVideoTool/1.0 (local)'; const mapJob = { running: false, total: 0, done: 0, ok: 0, skipped: 0, fail: 0, current: '', results: [], startedAt: 0, finishedAt: 0, stop: false };
function curlBin() { return process.platform === 'win32' ? 'curl.exe' : 'curl'; }
function bsProxyArg(cfg) { const p = effectiveProxy(cfg); return p ? ['--proxy', p] : []; }
function sanitizeFolderName(s) {
  return String(s == null ? '' : s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 110) || 'map';
}
async function bsGetJson(apiPath, cfg) {
  const url = 'https://api.beatsaver.com' + apiPath;
  const tryGet = async (proxyArgs) => {
    const out = await runCapture(curlBin(), ['-s', '-m', '25', '-A', BS_UA].concat(proxyArgs).concat([url]), 30000);
    if (out && out.trim().charAt(0) === '{') { try { return JSON.parse(out); } catch (e) {} }
    return null;
  };
  /* 直连优先 → 工具配置的代理 */
  let j = await tryGet([]);
  if (j) return j;
  const p = effectiveProxy(cfg);
  if (p) { j = await tryGet(['--proxy', p]); if (j) return j; }
  return null;
}
async function bsDownloadZip(url, dest, cfg) {
  ensureDir(path.dirname(dest));
  const attempt = async (proxyArgs) => {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e) {}
    const args = ['-sL', '-m', '300', '-A', BS_UA, '-o', dest, '-w', '%{http_code}'].concat(proxyArgs).concat([url]);
    const out = (await runCapture(curlBin(), args, 320000)).trim();
    const code = out.slice(-3);
    if (code !== '200') return { ok: false, detail: 'HTTP ' + (code || '?') };
    let size = 0;
    try { size = fs.statSync(dest).size; } catch (e) { return { ok: false, detail: '无文件' }; }
    if (size < 2000) return { ok: false, detail: '文件过小(' + size + 'B)' };
    return { ok: true, size: size };
  };
  /* 直连优先 → 工具配置的代理 */
  let r = await attempt([]);
  if (!r.ok) {
    const p = effectiveProxy(cfg);
    if (p) { r = await attempt(['--proxy', p]); if (r.ok) return r; }
  }
  return r;
}
function extractZip(zipPath, destDir) {
  return new Promise(resolve => {
    ensureDir(destDir);
    const tries = (process.platform === 'win32')
      ? [['tar', ['-xf', zipPath, '-C', destDir]]]
      : [['unzip', ['-o', '-q', zipPath, '-d', destDir]], ['python3', ['-m', 'zipfile', '-e', zipPath, destDir]]];
    let i = 0;
    (function next() {
      if (i >= tries.length) return resolve({ ok: false, detail: '解压失败' });
      const exe = tries[i][0], args = tries[i][1]; i++;
      let ch;
      try { ch = spawn(exe, args, { windowsHide: true }); } catch (e) { return next(); }
      let err = '';
      ch.stderr.on('data', d => { err += d.toString(); });
      ch.on('error', () => next());
      ch.on('close', code => {
        try {
          const files = fs.readdirSync(destDir);
          const hasInfo = files.some(f => /^info\.(dat|json)$/i.test(f));
          if (code === 0 && hasInfo) return resolve({ ok: true, files: files.length });
        } catch (e) {}
        next();
      });
    })();
  });
}
function pickBeatSaverMap(json, key) {
  if (!json || typeof json !== 'object') return null;
  if (Array.isArray(json)) return json[0] || null;
  if (json.id || json.versions) return json;
  if (key && json[key]) return json[key];
  const ks = Object.keys(json);
  return ks.length ? json[ks[0]] : null;
}
async function installMapEntry(item, cfg) {
  const idx = localSongIndex(cfg);
  const h = String(item.hash || '').trim().toLowerCase();
  const k = String(item.key || '').trim().toLowerCase();
  const hit = (h && idx.byHash[h]) || (k && idx.byKey[k]);
  if (hit) return { ok: true, skipped: true, folder: hit.folder };
  let map = null;
  if (k) map = pickBeatSaverMap(await bsGetJson('/maps/ids/' + encodeURIComponent(k), cfg), k);
  if ((!map || !map.versions) && h) map = pickBeatSaverMap(await bsGetJson('/maps/hash/' + encodeURIComponent(h), cfg), '');
  if (!map) return { ok: false, error: 'BeatSaver 查不到该谱面（key=' + (k || '-') + ' / hash=' + (h ? h.slice(0, 10) : '-') + '）' };
  const id = String(map.id || k || '').trim();
  if (id && idx.byKey[id.toLowerCase()]) return { ok: true, skipped: true, folder: idx.byKey[id.toLowerCase()].folder };
  const versions = Array.isArray(map.versions) ? map.versions : [];
  const ver = versions[0];
  if (!ver || !ver.downloadURL) return { ok: false, error: '该谱面没有可下载的版本' };
  const md = map.metadata || {};
  const sn = String(md.songName || item.songName || id || '谱面');
  const au = String(md.levelAuthorName || '');
  const folderName = sanitizeFolderName((id ? id + ' ' : '') + '(' + sn + (au ? (' - ' + au) : '') + ')');
  const cl = path.join(String(cfg['游戏目录'] || DEFAULT_GAME), 'Beat Saber_Data', 'CustomLevels');
  let dest = path.join(cl, folderName);
  if (fs.existsSync(dest)) dest = path.join(cl, sanitizeFolderName(folderName + ' (' + String(ver.hash || '').slice(0, 6) + ')'));
  const zipPath = path.join(MAP_TMP_DIR, sanitizeFolderName((id || ver.hash || 'map')) + '.zip');
  const dl = await bsDownloadZip(ver.downloadURL, zipPath, cfg);
  if (!dl.ok) return { ok: false, error: '下载失败：' + dl.detail };
  const ex = await extractZip(zipPath, dest);
  try { fs.unlinkSync(zipPath); } catch (e) {}
  if (!ex.ok) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch (e) {} return { ok: false, error: '解压失败' }; }
  return { ok: true, folder: path.basename(dest), id: id, sizeMB: (dl.size / 1048576).toFixed(1) };
}
async function runMapJob(items) {
  const cfg = loadConfig();
  mapJob.running = true; mapJob.stop = false;
  mapJob.total = items.length; mapJob.done = 0; mapJob.ok = 0; mapJob.skipped = 0; mapJob.fail = 0;
  mapJob.results = []; mapJob.startedAt = Date.now(); mapJob.finishedAt = 0;
  addLog('[谱面下载] 开始：共 ' + items.length + ' 首待补');
  for (const it of items) {
    if (mapJob.stop) break;
    mapJob.current = String(it.key || it.hash || '') + ' ' + String(it.songName || '');
    let r;
    try { r = await installMapEntry(it, cfg); } catch (e) { r = { ok: false, error: e.message }; }
    if (r && r.ok && r.skipped) mapJob.skipped++;
    else if (r && r.ok) mapJob.ok++;
    else mapJob.fail++;
    mapJob.results.push({ key: it.key || '', hash: it.hash || '', songName: it.songName || '', ok: !!(r && r.ok), skipped: !!(r && r.skipped), folder: (r && r.folder) || '', error: (r && r.error) || '' });
    mapJob.done++;
    addLog('[谱面下载] ' + mapJob.done + '/' + mapJob.total + ' ' + ((r && r.ok) ? (r.skipped ? ('已存在，跳过 ' + r.folder) : ('安装 ' + r.folder + ' (' + r.sizeMB + 'MB)')) : ('失败：' + ((r && r.error) || '未知'))));
    await sleep(200);
  }
  mapJob.running = false; mapJob.current = ''; mapJob.finishedAt = Date.now();
  addLog('[谱面下载] 结束：安装 ' + mapJob.ok + ' · 跳过 ' + mapJob.skipped + ' · 失败 ' + mapJob.fail + (mapJob.stop ? '（已中止）' : ''));
}

const server = http.createServer(async (req, res) => {
  const parsed = urlmod.parse(req.url, true);
  const p = parsed.pathname;
  const q = parsed.query || {};
  try {
    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    if (p.indexOf('/public/') === 0) return serveStatic(res, path.join(PUBLIC_DIR, p.slice('/public/'.length)));
    if (p.indexOf('/bs-viewer/') === 0) return serveStatic(res, path.join(PUBLIC_DIR, 'viewer', p.slice('/bs-viewer/'.length)));

    if (p === '/api/state' && req.method === 'GET') {
      const cfg = loadConfig();
      return sendJSON(res, {
        version: 'v1.20-web (2026-09-29)',
        port: port,
        toolDir: TOOL,
        config: {
          '游戏目录': cfg['游戏目录'], '代理模式': cfg['代理模式'], '自定义代理': cfg['自定义代理'],
          '代理': effectiveProxy(cfg), '视频高度': cfg['视频高度'], 'cookie来源': cfg['cookie来源'],
          ytdlp: findYtdlp(cfg), ffmpeg: findFfmpeg(cfg)
        },
        cookies: cookieState,
        jobs: { running: jobs.running, stats: jobs.stats, queueLen: jobs.queue.length, current: jobs.current, startedAt: jobs.startedAt }
      });
    }
    if (p === '/api/songs' && req.method === 'GET') {
      const cfg = loadConfig();
      const rows = scanSongs(cfg);
      const linkMap = readLinksMap();
      const dm = await durationMapFor(cfg, rows.map(function (r) { return r.folder; }));
      for (const r of rows) {
        r.link = linkMap[r.folder] || '';
        if (!r.link && r.videoID && !isLocalVideoId(r.videoID)) r.link = 'https://www.youtube.com/watch?v=' + r.videoID;
        r.key = songFolderKey(r.folder);
        const h = localMapHash(path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels', r.folder));
        r.hash = h;
        r.levelId = h ? ('custom_level_' + String(h).toUpperCase()) : '';
        r.durSec = dm[r.folder] || 0;
        r.durText = fmtDurText(r.durSec);
      }
      return sendJSON(res, { ok: true, rows: rows });
    }
    if (p === '/api/link' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.folder) return sendJSON(res, { error: '参数不完整' }, 400);
      return sendJSON(res, updateLink(body.folder, body.url || ''));
    }
    if (p === '/api/offset' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.folder) return sendJSON(res, { error: '参数不完整' }, 400);
      return sendJSON(res, updateOffset(body.folder, body.offset));
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJSON(res, { error: '数据格式错误' }, 400);
      const cfg = loadConfig();
      if (body['代理模式'] !== undefined) cfg['代理模式'] = String(body['代理模式']);
      if (body['自定义代理'] !== undefined) cfg['自定义代理'] = String(body['自定义代理']);
      if (body['视频高度'] !== undefined) cfg['视频高度'] = parseInt(body['视频高度'], 10) || 1080;
      if (body['cookie来源'] !== undefined) cfg['cookie来源'] = String(body['cookie来源']);
      cfg['代理'] = effectiveProxy(cfg);
      if (fs.existsSync(path.join(TOOL, 'cookies.txt'))) cfg['cookie文件'] = 'cookies.txt';
      saveConfig(cfg);
      addLog('设置已保存：代理=' + (effectiveProxy(cfg) || '直连') + '，cookies来源=' + cfg['cookie来源']);
      return sendJSON(res, { ok: true, config: cfg });
    }
    if (p === '/api/cookies/detect' && req.method === 'POST') {
      detectCookies();
      return sendJSON(res, { ok: true, started: true });
    }
    if (p === '/api/cookies/import' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.content || String(body.content).indexOf('\t') < 0) return sendJSON(res, { error: '内容为空或不是有效的 cookies.txt（Netscape 格式应为 Tab 分隔）' }, 400);
      fs.writeFileSync(path.join(TOOL, 'cookies.txt'), String(body.content), 'utf8');
      addLog('已导入 cookies.txt（' + String(body.content).split('\n').length + ' 行）');
      detectCookies();
      return sendJSON(res, { ok: true });
    }
    if (p === '/api/cookies/fetchurl' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.url) return sendJSON(res, { error: '缺少 URL' }, 400);
      const ok = await fetchToFile(String(body.url), path.join(TOOL, 'cookies.txt'));
      if (ok) { addLog('已从 URL 导入 cookies: ' + body.url); detectCookies(); return sendJSON(res, { ok: true }); }
      return sendJSON(res, { error: '下载失败（检查 URL / 网络 / 代理）' }, 400);
    }
    if (p === '/api/proxy/test' && req.method === 'POST') {
      const body = await readBody(req) || {};
      const cfg = loadConfig();
      let proxy = '';
      if (body['代理模式'] !== undefined) {
        const c2 = { '代理模式': body['代理模式'], '自定义代理': body['自定义代理'] || '' };
        proxy = effectiveProxy(c2);
      } else proxy = effectiveProxy(cfg);
      const r = await testProxy(proxy);
      addLog('代理测试 [' + (proxy || '直连') + '] → ' + (r.ok ? ('OK ' + r.detail) : ('失败 ' + r.detail)));
      return sendJSON(res, r);
    }
    if (p === '/api/download' && req.method === 'POST') {
      const body = await readBody(req) || {};
      return sendJSON(res, startDownload({ folders: body.folders || null, force: !!body.force }));
    }
    if (p === '/api/stop' && req.method === 'POST') return sendJSON(res, stopDownload());
    if (p === '/api/pot/start' && req.method === 'POST') {
      const ok = await ensurePot();
      return sendJSON(res, { ok: ok });
    }
    if (p === '/api/jobs' && req.method === 'GET') {
      const tail = parseInt(q.tail || '200', 10);
      return sendJSON(res, {
        running: jobs.running, stopFlag: jobs.stopFlag, current: jobs.current,
        queue: jobs.queue.map(t => ({ folder: t.folder, name: t.row.name })),
        results: jobs.results, stats: jobs.stats,
        log: jobs.log.slice(-tail)
      });
    }
    if (p === '/api/video' && req.method === 'GET') return serveVideo(req, res, q.folder || '');
    /* ---------- 3D 预览：把本地图打包成 zip 喂给 bs-viewer ---------- */
    if (p === '/api/mapzip' && req.method === 'GET') {
      const cfg = loadConfig();
      const folder = String(q.folder || '');
      if (!folder) return sendJSON(res, { error: '缺少 folder' }, 400);
      const cl = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels');
      const dir = path.join(cl, folder);
      if (!fs.existsSync(dir)) return sendJSON(res, { error: '歌曲目录不存在' }, 404);
      let key = 'v2c0'; try { key = 'v2c' + Math.round(fs.statSync(dir).mtimeMs); } catch (e) {}
      const h = crypto.createHash('md5').update(folder).digest('hex').slice(0, 12);
      const zipPath = path.join(MAP_TMP_DIR, 'mapzip-' + h + '-' + key + '.zip');
      if (!fs.existsSync(zipPath)) {
        ensureDir(MAP_TMP_DIR);
        let names = [];
        try { names = fs.readdirSync(dir).filter(n => !/\.(mp4|webm|mkv|mov|avi|wmv)$/i.test(n)); } catch (e) {}
        if (!names.length) return sendJSON(res, { error: '歌曲目录为空' }, 500);
        /* bs-viewer 只支持 v2：Info/diff 需要时转成 v2 后放进 staging 再打包（原始文件不动） */
        const stage = path.join(MAP_TMP_DIR, 'stage-' + h + '-' + key);
        let tarFrom = dir;
        try {
          fs.rmSync(stage, { recursive: true, force: true });
          ensureDir(stage);
          let converted = 0;
          for (const n of names) {
            const src = path.join(dir, n), dst = path.join(stage, n);
            let done = false;
            try {
              if (/^info\.(dat|json)$/i.test(n)) {
                const o = JSON.parse(fs.readFileSync(src, 'utf8'));
                const c = convertInfoToV2(o);
                if (c) { fs.writeFileSync(dst, JSON.stringify(c), 'utf8'); done = true; converted++; }
              } else if (/\.dat$/i.test(n) && !/^(bpm|audio)info\.dat$/i.test(n)) {
                const o = JSON.parse(fs.readFileSync(src, 'utf8'));
                if (o && o.colorNotes && !o._notes) { fs.writeFileSync(dst, JSON.stringify(convertDiffToV2(o)), 'utf8'); done = true; converted++; }
              }
            } catch (e) {}
            if (!done) fs.copyFileSync(src, dst);
          }
          tarFrom = stage;
          if (converted) addLog('3D 预览格式转换: ' + folder + '（' + converted + ' 个文件 v3/v4→v2）');
        } catch (e) { try { tarFrom = dir; } catch (e2) {} }
        const out = await runCapture('tar', ['-a', '-c', '-f', zipPath, '-C', tarFrom].concat(names), 180000);
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
        if (!fs.existsSync(zipPath)) {
          addLog('3D 预览打包失败: ' + folder + ' | ' + String(out || '').slice(0, 300));
          return sendJSON(res, { error: '打包失败（需要 Windows 自带 tar）' }, 500);
        }
        addLog('3D 预览打包: ' + folder + ' → ' + path.basename(zipPath));
      }
      return serveStatic(res, zipPath);
    }
    if (p === '/api/audio' && req.method === 'GET') {
      const folder = q.folder || '';
      const kind = q.track === 'video' ? 'video' : 'song';
      if (!folder) { res.writeHead(400); return res.end('missing folder'); }
      const cfg = loadConfig();
      try {
        const f = await ensureAudioFile(cfg, folder, kind);
        return serveFileRange(req, res, f, 'audio/mpeg');
      } catch (e) {
        return sendJSON(res, { error: e.message }, 404);
      }
    }
    if (p === '/api/autosync' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.folder) return sendJSON(res, { error: '参数不完整' }, 400);
      try {
        const r = await autoSyncFolder(String(body.folder));
        addLog('自动对齐 ' + body.folder + ' → ' + r.offsetMs + ' ms（峰值 ' + r.peak + '，对比度 ' + r.ratio + '，用时 ' + (r.elapsedMs / 1000).toFixed(1) + 's）');
        return sendJSON(res, r);
      } catch (e) {
        addLog('自动对齐失败 ' + body.folder + '：' + e.message);
        return sendJSON(res, { error: e.message }, 409);
      }
    }
    if (p === '/api/deletevideo' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.folder) return sendJSON(res, { error: '参数不完整' }, 400);
      try {
        const removed = deleteVideoForFolder(String(body.folder));
        addLog('删除视频: ' + body.folder + '（' + removed.join(', ') + '）');
        return sendJSON(res, { ok: true, removed: removed });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 409);
      }
    }
    if (p === '/api/stripaudio' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.folder) return sendJSON(res, { error: '参数不完整' }, 400);
      try {
        const r = await stripVideoAudioForFolder(String(body.folder));
        addLog('删除视频音频: ' + body.folder + ' → ' + r.name + '  ' + r.beforeMB + 'MB → ' + r.afterMB + 'MB（省 ' + r.savedMB + 'MB）');
        return sendJSON(res, r);
      } catch (e) {
        addLog('删除视频音频失败 ' + body.folder + '：' + e.message);
        return sendJSON(res, { error: e.message }, 409);
      }
    }
    if (p === '/api/audiocheck/start' && req.method === 'POST') {
      let force = false;
      try { const b = await readBody(req); force = !!(b && b.force); } catch (e) {}
      if (!dupState.running) runFolderDup();
      return sendJSON(res, { ok: true, running: true, force: force });
    }
    if (p === '/api/audiocheck/status' && req.method === 'GET') {
      return sendJSON(res, {
        running: dupState.running, done: dupState.done, total: dupState.total, phase: dupState.phase,
        error: dupState.error, groups: dupState.groups, exactCount: dupState.exactCount, nearCount: dupState.nearCount,
        startedAt: dupState.startedAt, finishedAt: dupState.finishedAt
      });
    }
    if (p === '/api/audiocheck/clear' && req.method === 'POST') {
      return sendJSON(res, { ok: true });
    }
    if (p === '/api/beatmap' && req.method === 'GET') {
      const folder = q.folder || '';
      if (!folder) return sendJSON(res, { error: '缺少 folder' }, 400);
      try {
        const r = parseBeatmapForFolder(loadConfig(), String(folder), q.diff ? String(q.diff) : '');
        return sendJSON(res, r);
      } catch (e) {
        return sendJSON(res, { error: e.message }, 409);
      }
    }
    if (p === '/api/deletesong' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.folder) return sendJSON(res, { error: '参数不完整' }, 400);
      try {
        const dest = moveSongToTrash(String(body.folder));
        addLog('移出重复歌曲: ' + body.folder + ' → ' + dest);
        return sendJSON(res, { ok: true, dest: dest });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 409);
      }
    }
    if (p === '/api/uselocal' && req.method === 'POST') {
      const contentType = req.headers['content-type'] || '';
      if (contentType.indexOf('multipart/form-data') >= 0) {
        // Multipart file upload (streaming)
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) { res.writeHead(400); return res.end('Missing boundary'); }
        const boundary = boundaryMatch[1];
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', async () => {
          try {
            const bodyBuf = Buffer.concat(chunks);
            const boundaryStr = '--' + boundary;
            const boundaryBuf = Buffer.from(boundaryStr);
            let folder = '', fileName = '', fileBuf = null;
            let start = bodyBuf.indexOf(boundaryBuf) + boundaryBuf.length + 2; // skip CRLF
            while (start < bodyBuf.length) {
              const end = bodyBuf.indexOf(boundaryBuf, start);
              if (end < 0) break;
              const headerEnd = bodyBuf.indexOf('\r\n\r\n', start);
              if (headerEnd < 0 || headerEnd >= end) break;
              const headers = bodyBuf.slice(start, headerEnd).toString('utf8');
              const dataStart = headerEnd + 4;
              const dataEnd = end - 2; // before CRLF
              const nameMatch = headers.match(/name="([^"]+)"/);
              const fileMatch = headers.match(/filename="([^"]+)"/);
              if (nameMatch) {
                if (nameMatch[1] === 'folder') folder = bodyBuf.slice(dataStart, dataEnd).toString('utf8');
                else if (nameMatch[1] === 'file' && fileMatch) {
                  fileName = fileMatch[1];
                  fileBuf = bodyBuf.slice(dataStart, dataEnd);
                }
              }
              start = end + boundaryBuf.length + 2;
            }
            if (!folder || !fileBuf) { res.writeHead(400); return res.end(JSON.stringify({error:'缺少 folder 或 file'})); }
            const cfg = loadConfig();
            const songDir = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels', folder);
            if (!fs.existsSync(songDir)) { res.writeHead(400); return res.end(JSON.stringify({error:'歌曲目录不存在'})); }
            const ext = path.extname(fileName).toLowerCase();
            if (!/\.(mp4|webm|mkv|mov|m4v|avi)$/.test(ext)) { res.writeHead(400); return res.end(JSON.stringify({error:'不支持的视频格式'})); }
            const tmpPath = path.join(songDir, '_uselocal_src' + ext);
            fs.writeFileSync(tmpPath, fileBuf);
            let out;
            try { out = await ensureCinemaMp4(tmpPath, songDir, cfg); }
            finally { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {} }
            writeCinemaConfig(songDir, out.name, folder);
            addLog('已使用本地视频: ' + folder + ' <- ' + fileName + ' (' + out.sizeMB + ' MB' + (out.converted ? ', 已转码为 H.264 MP4' : '') + ')');
            sendJSON(res, { ok: true, sizeMB: out.sizeMB, target: out.name, converted: !!out.converted });
          } catch (e) {
            try { sendJSON(res, { error: '处理上传失败: ' + e.message }, 500); } catch (e2) {}
          }
        });
        req.on('error', () => { try { sendJSON(res, { error: '上传中断' }, 500); } catch (e) {} });
        return;
      } else {
        // JSON body: direct file path copy
        const body = await readBody(req);
        if (!body || !body.folder || !body.filePath) return sendJSON(res, { error: '缺少 folder 或 filePath' }, 400);
        const cfg = loadConfig();
        const songDir = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels', body.folder);
        if (!fs.existsSync(songDir)) return sendJSON(res, { error: '歌曲目录不存在' }, 400);
        const srcFile = String(body.filePath);
        if (!fs.existsSync(srcFile)) return sendJSON(res, { error: '源文件不存在' }, 400);
        const ext = path.extname(srcFile).toLowerCase();
        if (!/\.(mp4|webm|mkv|mov|m4v|avi)$/.test(ext)) return sendJSON(res, { error: '不支持的视频格式' }, 400);
        try {
          const out = await ensureCinemaMp4(srcFile, songDir, cfg);
          writeCinemaConfig(songDir, out.name, body.folder);
          addLog('已使用本地视频: ' + body.folder + ' <- ' + path.basename(srcFile) + ' (' + out.sizeMB + ' MB' + (out.converted ? ', 已转码为 H.264 MP4' : '') + ')');
          sendJSON(res, { ok: true, sizeMB: out.sizeMB, target: out.name, converted: !!out.converted });
        } catch (e) {
          sendJSON(res, { error: '处理视频失败: ' + e.message }, 500);
        }
      }
    }
    if (p === '/api/openfolder' && req.method === 'GET') {
      const f = q.folder || '';
      const cfg = loadConfig();
      const dir = path.join(String(cfg['游戏目录']), 'Beat Saber_Data', 'CustomLevels', f);
      if (fs.existsSync(dir)) { try { spawn('explorer.exe', [dir], { windowsHide: false }); } catch (e) {} return sendJSON(res, { ok: true }); }
      return sendJSON(res, { error: '目录不存在' }, 400);
    }

    /* ---------- 播放列表 ---------- */
    if (p === '/api/playlists' && req.method === 'GET') {
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      const idx = localSongIndex(cfg);
      const items = plList(cfg);
      const pre = items.map(function (it) {
        var obj = it.obj || {};
        var songs = Array.isArray(obj.songs) ? obj.songs : [];
        var matched = 0, folders = [];
        for (var i = 0; i < songs.length; i++) { var m = matchPlEntry(songs[i], idx); if (m) { matched++; if (m.folder) folders.push(m.folder); } }
        return { it: it, obj: obj, songs: songs, matched: matched, folders: folders };
      });
      var allFolders = [];
      pre.forEach(function (x) { for (var j = 0; j < x.folders.length; j++) allFolders.push(x.folders[j]); });
      const dm = await durationMapFor(cfg, allFolders);
      const list = pre.map(function (x) {
        var obj = x.obj;
        var durSec = 0;
        for (var j = 0; j < x.folders.length; j++) durSec += (dm[x.folders[j]] || 0);
        durSec = Math.round(durSec);
        return {
          file: x.it.file,
          title: String(obj.playlistTitle || x.it.file.replace(/\.(bplist|json)$/i, '')),
          author: String(obj.playlistAuthor || ''),
          description: String(obj.playlistDescription || ''),
          count: x.songs.length, matched: x.matched, missing: x.songs.length - x.matched,
          durSec: durSec, durText: fmtDurText(durSec),
          hasImage: !!(obj.image && String(obj.image).length > 64),
          mtime: x.it.mtime, sizeKB: x.it.sizeKB, error: x.it.error || ''
        };
      });
      return sendJSON(res, { ok: true, dir: dir, dirExists: fs.existsSync(dir), playlists: list });
    }
    if (p === '/api/playlists/detail' && req.method === 'GET') {
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      const f = path.basename(String(q.file || ''));
      const full = path.join(dir, f);
      if (!f || !fs.existsSync(full)) return sendJSON(res, { error: '播放列表不存在' }, 404);
      let obj; try { obj = readJsonTolerant(full); } catch (e) { return sendJSON(res, { error: '解析失败：' + e.message }, 400); }
      const idx = localSongIndex(cfg);
      const songs = (Array.isArray(obj.songs) ? obj.songs : []).map(function (s, i) {
        s = s || {}; var m = matchPlEntry(s, idx);
        return {
          i: i, key: String(s.key || ''), hash: String(s.hash || ''), songName: String(s.songName || ''),
          levelAuthorName: String(s.levelAuthorName || s.uploader || ''), matched: !!m,
          folder: m ? m.folder : '', name: m ? m.name : '', artist: m ? m.artist : '', mapper: m ? m.mapper : '',
          hasVideo: m ? !!m.hasVideo : false, offset: m ? m.offset : null, durSec: 0
        };
      });
      const dm = await durationMapFor(cfg, songs.filter(function (s) { return s.matched && s.folder; }).map(function (s) { return s.folder; }));
      var totalSec = 0;
      songs.forEach(function (s) { s.durSec = s.matched ? (dm[s.folder] || 0) : 0; totalSec += s.durSec; });
      totalSec = Math.round(totalSec);
      return sendJSON(res, {
        ok: true, file: f, title: String(obj.playlistTitle || ''), author: String(obj.playlistAuthor || ''),
        description: String(obj.playlistDescription || ''), hasImage: !!obj.image,
        durSec: totalSec, durText: fmtDurText(totalSec), songs: songs
      });
    }
    if (p === '/api/playlists/save' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.file) return sendJSON(res, { error: '参数不完整' }, 400);
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      const f = path.basename(String(body.file));
      const full = path.join(dir, f);
      if (!fs.existsSync(full)) return sendJSON(res, { error: '播放列表不存在：' + f }, 404);
      let obj; try { obj = readJsonTolerant(full); } catch (e) { obj = {}; }
      if (body.title !== undefined) obj.playlistTitle = String(body.title);
      if (body.author !== undefined) obj.playlistAuthor = String(body.author);
      if (body.description !== undefined) obj.playlistDescription = String(body.description);
      if (body.songs !== undefined) obj.songs = plNormalizeSongs(body.songs);
      backupPlFile(dir, f);
      writePlFile(dir, f, obj);
      addLog('播放列表已保存：' + f + '（' + ((obj.songs || []).length) + ' 首）');
      return sendJSON(res, { ok: true, file: f, count: (obj.songs || []).length });
    }
    if (p === '/api/playlists/create' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJSON(res, { error: '数据格式错误' }, 400);
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      const idx = localSongIndex(cfg);
      const raw = plEntryFromBody(body, idx);
      const songs = plDedupe(raw);
      const title = String(body.title || '').trim() || '新建播放列表';
      let f = safeFileToken(title) + '.bplist';
      let n = 2;
      while (fs.existsSync(path.join(dir, f)) && n < 1000) { f = safeFileToken(title) + ' (' + n + ').bplist'; n++; }
      writePlFile(dir, f, {
        playlistTitle: title,
        playlistAuthor: String(body.author || ''),
        playlistDescription: String(body.description || ''),
        songs: songs
      });
      addLog('新建播放列表：' + f + '（' + songs.length + ' 首' + (raw.length - songs.length ? '，去重 ' + (raw.length - songs.length) : '') + '）');
      return sendJSON(res, { ok: true, file: f, count: songs.length, skipped: raw.length - songs.length });
    }
    if (p === '/api/playlists/add' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.file) return sendJSON(res, { error: '参数不完整' }, 400);
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      const f = path.basename(String(body.file));
      const full = path.join(dir, f);
      if (!fs.existsSync(full)) return sendJSON(res, { error: '播放列表不存在：' + f }, 404);
      const idx = localSongIndex(cfg);
      let obj; try { obj = readJsonTolerant(full); } catch (e) { obj = {}; }
      const songs = Array.isArray(obj.songs) ? obj.songs : [];
      const seen = Object.create(null);
      songs.forEach(function (s) { seen[plKeyOf(s)] = 1; });
      let added = 0, skipped = 0;
      for (const e of plEntryFromBody(body, idx)) {
        const k = plKeyOf(e);
        if (seen[k]) { skipped++; continue; }
        seen[k] = 1; songs.push(e); added++;
      }
      if (!added) return sendJSON(res, { ok: true, added: 0, skipped: skipped, count: songs.length });
      obj.songs = songs;
      backupPlFile(dir, f);
      writePlFile(dir, f, obj);
      addLog('播放列表追加：' + f + ' +' + added + ' 首（' + songs.length + ' 总计）');
      return sendJSON(res, { ok: true, added: added, skipped: skipped, count: songs.length });
    }
    if (p === '/api/playlists/copy' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.file) return sendJSON(res, { error: '参数不完整' }, 400);
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      const f = path.basename(String(body.file));
      if (!fs.existsSync(path.join(dir, f))) return sendJSON(res, { error: '播放列表不存在' }, 404);
      let obj; try { obj = readJsonTolerant(path.join(dir, f)); } catch (e) { return sendJSON(res, { error: '解析失败' }, 400); }
      const base = String(obj.playlistTitle || f.replace(/\.(bplist|json)$/i, ''));
      obj.playlistTitle = base + ' 副本';
      let nf = safeFileToken(base) + ' 副本.bplist';
      let n = 2;
      while (fs.existsSync(path.join(dir, nf)) && n < 1000) { nf = safeFileToken(base) + ' 副本 (' + n + ').bplist'; n++; }
      writePlFile(dir, nf, obj);
      addLog('复制播放列表：' + f + ' → ' + nf);
      return sendJSON(res, { ok: true, file: nf });
    }
    if (p === '/api/playlists/delete' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.file) return sendJSON(res, { error: '参数不完整' }, 400);
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      const f = path.basename(String(body.file));
      const full = path.join(dir, f);
      if (!fs.existsSync(full)) return sendJSON(res, { error: '播放列表不存在' }, 404);
      backupPlFile(dir, f);
      try { fs.unlinkSync(full); } catch (e) { return sendJSON(res, { error: '删除失败：' + e.message }, 500); }
      addLog('删除播放列表：' + f + '（已备份到 播放列表备份/）');
      return sendJSON(res, { ok: true, file: f });
    }
    if (p === '/api/playlists/image' && req.method === 'GET') {
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      const f = path.basename(String(q.file || ''));
      const full = path.join(dir, f);
      if (!f || !fs.existsSync(full)) { res.writeHead(404); return res.end('404'); }
      let obj; try { obj = readJsonTolerant(full); } catch (e) { res.writeHead(404); return res.end('404'); }
      let img = String(obj.image || '');
      let mime = 'image/png';
      const mm = img.match(/^data:(image\/[a-z+]+);base64,(.*)$/i);
      if (mm) { mime = mm[1]; img = mm[2]; }
      else if (/^\/9j\//.test(img)) mime = 'image/jpeg';
      else if (/^iVBOR/.test(img)) mime = 'image/png';
      else if (/^R0lGOD/.test(img)) mime = 'image/gif';
      if (!img) { res.writeHead(404); return res.end('404'); }
      const buf = Buffer.from(img, 'base64');
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      return res.end(buf);
    }
    if (p === '/api/playlists/openfolder' && req.method === 'GET') {
      const cfg = loadConfig();
      const dir = playlistsDirOf(cfg);
      try { ensureDir(dir); spawn('explorer.exe', [dir], { windowsHide: false }); } catch (e) {}
      return sendJSON(res, { ok: true });
    }

    /* ---------- 谱面下载（补「本地没有」的歌） ---------- */
    if (p === '/api/mapdownload/start' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.items) || !body.items.length) return sendJSON(res, { error: '没有要下载的谱面' }, 400);
      if (mapJob.running) return sendJSON(res, { error: '已有谱面下载任务在进行中', running: true }, 409);
      const items = body.items.map(function (x) { return { key: String((x && x.key) || '').trim(), hash: String((x && x.hash) || '').trim(), songName: String((x && x.songName) || '') }; })
        .filter(function (x) { return x.key || x.hash; });
      if (!items.length) return sendJSON(res, { error: '这些条目没有 key/hash，无法定位谱面' }, 400);
      runMapJob(items);
      return sendJSON(res, { ok: true, total: items.length });
    }
    if (p === '/api/mapdownload/status' && req.method === 'GET') return sendJSON(res, mapJob);
    if (p === '/api/mapdownload/stop' && req.method === 'POST') { mapJob.stop = true; return sendJSON(res, { ok: true }); }

    /* ---------- 无缝挑战（SetlistChallenge，配置给游戏内 mod 读） ---------- */
    if (p === '/api/durations' && req.method === 'GET') {
      const cfg = loadConfig();
      const folders = String(q.folders || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 500);
      const dm = await durationMapFor(cfg, folders);
      const durations = {};
      folders.forEach(function (f) { durations[f] = dm[f] || 0; });
      return sendJSON(res, { ok: true, durations: durations });
    }
    if (p === '/api/mapstars' && req.method === 'GET') {
      const cfg = loadConfig();
      const folders = String(q.folders || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 80);
      const out = {};
      const queue = folders.slice();
      const CONC = 4;
      async function worker() {
        while (queue.length) {
          const fo = queue.shift();
          try {
            const hash = localMapHash(songDirOf(cfg, fo));
            if (!hash) { out[fo] = null; continue; }
            const stars = await starsByHash(hash);
            out[fo] = { hash: hash, stars: stars || {} };
          } catch (e) { out[fo] = null; }
        }
      }
      await Promise.all(Array.from({ length: Math.max(1, Math.min(CONC, folders.length)) }, worker));
      return sendJSON(res, { ok: true, stars: out });
    }
    if (p === '/api/challenges' && req.method === 'GET') {
      const cfg = loadConfig();
      const dir = challengesDirOf(cfg);
      const rows = scanSongs(cfg);
      const byFolder = Object.create(null);
      rows.forEach(function (r) { byFolder[r.folder] = r; });
      const items = plList2(dir, /^[^_].*\.json$/);
      var allFolders = [];
      items.forEach(function (it) {
        var obj = it.obj || {};
        if (String(obj.mode || 'setlist') === 'random' || !Array.isArray(obj.entries)) return;
        obj.entries.forEach(function (e) { var f = String((e && e.folder) || ''); if (f && byFolder[f]) allFolders.push(f); });
      });
      const dm = await durationMapFor(cfg, allFolders);
      const list = items.map(function (it) {
        var obj = it.obj || {};
        var mode = String(obj.mode || 'setlist');
        var durSec = 0;
        if (mode !== 'random' && Array.isArray(obj.entries)) obj.entries.forEach(function (e) { var f = String((e && e.folder) || ''); if (f && byFolder[f]) durSec += (dm[f] || 0); });
        durSec = Math.round(durSec);
        return {
          file: it.file,
          title: String(obj.title || it.file.replace(/\.json$/i, '')),
          mode: mode,
          failEndsRun: obj.failEndsRun === undefined ? null : obj.failEndsRun,
          skipResults: obj.skipResults === undefined ? null : obj.skipResults,
          shuffle: !!obj.shuffle,
          count: Array.isArray(obj.entries) ? obj.entries.length : 0,
          durSec: durSec, durText: fmtDurText(durSec),
          filter: obj.filter || null,
          mtime: it.mtime, error: it.error || ''
        };
      });
      return sendJSON(res, { ok: true, dir: dir, challenges: list });
    }
    if (p === '/api/challenges/detail' && req.method === 'GET') {
      const cfg = loadConfig();
      const dir = challengesDirOf(cfg);
      const f = path.basename(String(q.file || ''));
      const full = path.join(dir, f);
      if (!f || !fs.existsSync(full)) return sendJSON(res, { error: '挑战不存在' }, 404);
      let obj; try { obj = readJsonTolerant(full); } catch (e) { return sendJSON(res, { error: '解析失败：' + e.message }, 400); }
      // 把每条 entry 跟本地曲库对一下（能不能找到、歌名/难度）
      const rows = scanSongs(cfg);
      const byFolder = {}; rows.forEach(function (r) { byFolder[r.folder] = r; });
      const entries = (Array.isArray(obj.entries) ? obj.entries : []).map(function (e, i) {
        e = e || {};
        const r = byFolder[String(e.folder || '')];
        return {
          i: i, folder: String(e.folder || ''), levelId: String(e.levelId || ''),
          characteristic: String(e.characteristic || 'Standard'), difficulty: String(e.difficulty || 'ExpertPlus'),
          found: !!r, name: r ? r.name : '', artist: r ? r.artist : '', mapper: r ? r.mapper : '',
          hasVideo: r ? !!r.hasVideo : false, durSec: 0
        };
      });
      const dm = await durationMapFor(cfg, entries.filter(function (e) { return e.found && e.folder; }).map(function (e) { return e.folder; }));
      var totalSec = 0;
      entries.forEach(function (e) { e.durSec = e.found ? (dm[e.folder] || 0) : 0; totalSec += e.durSec; });
      totalSec = Math.round(totalSec);
      return sendJSON(res, {
        ok: true, file: f, title: String(obj.title || ''), mode: String(obj.mode || 'setlist'),
        failEndsRun: obj.failEndsRun === undefined ? null : obj.failEndsRun,
        skipResults: obj.skipResults === undefined ? null : obj.skipResults,
        shuffle: !!obj.shuffle, filter: obj.filter || null,
        durSec: totalSec, durText: fmtDurText(totalSec), entries: entries
      });
    }
    if (p === '/api/challenges/save' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJSON(res, { error: '数据格式错误' }, 400);
      const cfg = loadConfig();
      const dir = challengesDirOf(cfg);
      ensureDir(dir);
      const title = String(body.title || '').trim() || '未命名挑战';
      let f = body.file ? safeFileToken(String(body.file).replace(/\.json$/i, '')) + '.json' : safeFileToken(title) + '.json';
      // 新建时避重
      if (!body.file) { let n = 2; while (fs.existsSync(path.join(dir, f)) && n < 1000) { f = safeFileToken(title) + ' (' + n + ').json'; n++; } }
      const full = path.join(dir, f);
      // 读取已有（保底保留未知字段）+ 合并
      let obj = {};
      if (fs.existsSync(full)) { try { if (fs.existsSync(full)) fs.copyFileSync(full, path.join(dir, f + '.bak_' + new Date().toISOString().replace(/[:.]/g, '-'))); } catch (e) {} try { obj = readJsonTolerant(full); } catch (e) { obj = {}; } }
      obj.title = title;
      obj.mode = (String(body.mode || 'setlist') === 'random') ? 'random' : 'setlist';
      obj.failEndsRun = (body.failEndsRun === null || body.failEndsRun === undefined) ? undefined : !!body.failEndsRun;
      obj.skipResults = (body.skipResults === null || body.skipResults === undefined) ? undefined : !!body.skipResults;
      obj.shuffle = !!body.shuffle;
      if (obj.mode === 'random') {
        obj.filter = body.filter || obj.filter || {};
      } else {
        obj.entries = (Array.isArray(body.entries) ? body.entries : []).map(function (e) {
          const o = {
            folder: String((e && e.folder) || ''),
            characteristic: String((e && e.characteristic) || 'Standard'),
            difficulty: String((e && e.difficulty) || 'ExpertPlus')
          };
          if (e && e.levelId) o.levelId = String(e.levelId);
          return o;
        }).filter(function (e) { return e.folder || e.levelId; });
      }
      if (obj.failEndsRun === undefined) delete obj.failEndsRun;
      if (obj.skipResults === undefined) delete obj.skipResults;
      writeJson(dir, f, obj);
      addLog('保存挑战：' + f + '（' + (obj.mode === 'random' ? ('随机 ' + (obj.filter && obj.filter.count || '?') + ' 首') : (obj.entries || []).length + ' 首') + '）');
      return sendJSON(res, { ok: true, file: f });
    }
    if (p === '/api/challenges/delete' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.file) return sendJSON(res, { error: '参数不完整' }, 400);
      const cfg = loadConfig();
      const dir = challengesDirOf(cfg);
      const f = path.basename(String(body.file));
      const full = path.join(dir, f);
      if (!fs.existsSync(full)) return sendJSON(res, { error: '挑战不存在' }, 404);
      try { fs.copyFileSync(full, path.join(dir, f + '.bak_' + new Date().toISOString().replace(/[:.]/g, '-'))); } catch (e) {}
      fs.unlinkSync(full);
      addLog('删除挑战：' + f);
      return sendJSON(res, { ok: true });
    }
    if (p === '/api/challenges/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJSON(res, { error: '数据格式错误' }, 400);
      const cfg = loadConfig();
      const dir = challengesDirOf(cfg);
      ensureDir(dir);
      const sp = path.join(dir, 'settings.json');
      let s = { FailEndsRun: false, SkipResults: true, ShowProgressHud: true, TransitionReactionTimeMs: 500, TransitionGraceMs: 800 };
      if (fs.existsSync(sp)) { try { s = Object.assign(s, readJsonTolerant(sp)); } catch (e) {} }
      ['FailEndsRun', 'SkipResults', 'ShowProgressHud', 'TransitionReactionTimeMs', 'TransitionGraceMs'].forEach(function (k) {
        if (body[k] !== undefined && body[k] !== null) s[k] = body[k];
      });
      writeJson(dir, 'settings.json', s);
      return sendJSON(res, { ok: true, settings: s });
    }
    if (p === '/api/challenges/settings' && req.method === 'GET') {
      const cfg = loadConfig();
      const sp = path.join(challengesDirOf(cfg), 'settings.json');
      let s = null;
      if (fs.existsSync(sp)) { try { s = readJsonTolerant(sp); } catch (e) {} }
      return sendJSON(res, { ok: true, settings: s });
    }
    if (p === '/api/challenges/openfolder' && req.method === 'GET') {
      const cfg = loadConfig();
      const dir = challengesDirOf(cfg);
      try { ensureDir(dir); spawn('explorer.exe', [dir], { windowsHide: false }); } catch (e) {}
      return sendJSON(res, { ok: true });
    }

    res.writeHead(404); res.end('404');
  } catch (e) {
    try { sendJSON(res, { error: e.message }, 500); } catch (e2) {}
  }
});

function fetchToFile(u, dest) {
  return new Promise(resolve => {
    try {
      const lib = (String(u).indexOf('https:') === 0) ? require('https') : http;
      const req = lib.get(u, { timeout: 15000 }, res => {
        if (res.statusCode !== 200) { return resolve(false); }
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          try { fs.writeFileSync(dest, Buffer.concat(chunks)); resolve(true); } catch (e) { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(false); });
    } catch (e) { resolve(false); }
  });
}
function testProxy(proxy) {
  return new Promise(resolve => {
    const args = ['-s', '-o', 'NUL', '-w', '%{http_code}', '-m', '15'];
    if (proxy) args.push('--proxy', proxy);
    args.push('https://www.youtube.com/robots.txt');
    const t0 = Date.now();
    let out = '';
    const ch = spawn('curl.exe', args, { windowsHide: true });
    const timer = setTimeout(() => { try { killTree(ch); } catch (e) {} resolve({ ok: false, detail: '超时' }); }, 20000);
    ch.stdout.on('data', d => out += d.toString());
    ch.on('error', () => { clearTimeout(timer); resolve({ ok: false, detail: 'curl 不可用' }); });
    ch.on('close', () => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const code = out.trim();
      if (code === '200' || code === '301' || code === '302') resolve({ ok: true, detail: 'HTTP ' + code + ' / ' + ms + 'ms' });
      else resolve({ ok: false, detail: 'HTTP ' + (code || '?') });
    });
  });
}

/* ---------------- 启动 ---------------- */
let port = PORT_START;
function tryListen() {
  server.listen(port, '127.0.0.1', () => {
    console.log('');
    console.log('==========================================================');
    console.log('  Beat Saber 视频工具 · 网页版 已启动');
    console.log('  地址:   http://127.0.0.1:' + port);
    console.log('  工具目录: ' + TOOL);
    console.log('  （关闭本窗口即停止服务）');
    console.log('==========================================================');
    console.log('');
    if (process.argv.indexOf('--no-open') < 0) {
      try { spawn('cmd', ['/c', 'start', '', 'http://127.0.0.1:' + port + '/'], { windowsHide: true }); } catch (e) {}
    }
    setTimeout(() => { detectCookies(); }, 2000);
  });
}
server.on('error', e => {
  if (e.code === 'EADDRINUSE' && port < PORT_START + 12) {
    port++;
    tryListen();
  } else {
    console.error('启动失败: ' + e.message);
    process.exit(1);
  }
});
tryListen();


