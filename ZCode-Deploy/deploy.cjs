#!/usr/bin/env node
// ============================================
// ZCode 一键人格部署工具  v2.1 (macOS 引擎)
// 移植自 deploy.ps1 (v2.0, Windows PowerShell)
// 适配 macOS: /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
//
// 与 Windows 版完全同源的六补丁逻辑:
//   1. 锚点按语义字面量定位 + 花括号配平, 不依赖压缩变量名
//   2. 任一补丁未命中即中止, 不写入, 退出码 1, 打印注入点诊断
//   3. 写入前 node --check 语法校验
//   4. 备份轮转 (保留 6 份); ZCode 更新后 .bak 自动刷新, restore 不降级
//
// 用法: node deploy.cjs <install|restore|status|diag|help> [--allow-partial] [--no-restart]
// (也兼容 PS 风格旗标 -AllowPartial / -NoRestart)
// ============================================
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ToolVersion = '2.1.0-mac';
const ScriptDir = __dirname;
const PromptFile = path.join(ScriptDir, '人格.txt');
const BackupDir = path.join(ScriptDir, 'backups');
const DirCache = path.join(ScriptDir, 'zcode-dir.txt');

const Marker = 'ZP:PERSONA';
const IdentityLit = '"You are ZCode, an interactive coding agent"';
const LitIdentity = 'name:"Agent Identity",source:"identity"';
const LitDate = 'name:"Current Date",source:"current_date"';
const LitSkills = 'name:"Skills",source:"skills"';
const LitUserCtx = 'name:"Request User Context",source:"request_user_context"';

const CJS_REL = 'Contents/Resources/glm/zcode.cjs';
const META_REL = 'Contents/Resources/glm/.node-bundle-meta.json';

// ---------- 输出 ----------
const C = { cyan: '\x1b[36m', green: '\x1b[32m', gray: '\x1b[90m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };
function Info(m) { console.log(C.cyan + m + C.reset); }
function Good(m) { console.log(C.green + '  [OK] ' + m + C.reset); }
function Skipd(m) { console.log(C.gray + '  [跳过] ' + m + C.reset); }
function Warn2(m) { console.log(C.yellow + '  [警告] ' + m + C.reset); }
function Bad(m) { console.log(C.red + '  [失败] ' + m + C.reset); }
function Note(m) { console.log(C.gray + '  ' + m + C.reset); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ZCode 安装目录检测 (macOS) ----------
function testZcodeDir(dir) {
    if (!dir) return false;
    return fs.existsSync(path.join(dir, CJS_REL));
}

function zcodeDirFromProcesses() {
    try {
        const out = cp.execSync('ps -Ao command', { encoding: 'utf8', timeout: 10000 });
        for (const line of out.split('\n')) {
            const m = line.match(/^(.+?ZCode\.app)\/Contents\/MacOS\//);
            if (m && testZcodeDir(m[1])) return m[1];
        }
    } catch (e) { /* ps 失败忽略 */ }
    return null;
}

function findZcodeDir() {
    if (process.env.ZCODE_DIR && testZcodeDir(process.env.ZCODE_DIR)) return process.env.ZCODE_DIR;
    const fromProc = zcodeDirFromProcesses();
    if (fromProc) return fromProc;
    if (fs.existsSync(DirCache)) {
        const d = fs.readFileSync(DirCache, 'utf8').trim();
        if (testZcodeDir(d)) return d;
    }
    const cands = ['/Applications/ZCode.app', path.join(os.homedir(), 'Applications/ZCode.app')];
    for (const c of cands) if (testZcodeDir(c)) return c;
    // 轻量扫描 (两个应用目录, 只看一层)
    for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
        try {
            for (const e of fs.readdirSync(root)) {
                const p = path.join(root, e);
                if (/^zcode\.app$/i.test(e) && testZcodeDir(p)) return p;
            }
        } catch (e) { /* 权限问题忽略 */ }
    }
    return null;
}

// ---------- 通用定位工具 ----------
function findEnclosingFunction(content, anchorIdx, back = 20000) {
    if (anchorIdx <= 0) return null;
    const start = Math.max(0, anchorIdx - back);
    const head = content.slice(start, anchorIdx);
    const re = /function\s+([A-Za-z_$][\w$]*)\s*\(([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)?\)\s*\{/g;
    let best = null, m;
    while ((m = re.exec(head)) !== null) {
        const open = start + m.index + m[0].length - 1;
        let depth = 0, close = -1;
        for (let i = open; i < content.length; i++) {
            const ch = content[i];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { close = i; break; } }
        }
        if (close > anchorIdx) best = { name: m[1], param: m[2] || '', braceAt: open, closeAt: close };
    }
    return best;
}

function testNullApplied(content, literal) {
    const idx = content.indexOf(literal);
    if (idx < 0) return false;
    const fn = findEnclosingFunction(content, idx);
    if (!fn) return false;
    if (fn.braceAt + 1 >= content.length) return false;
    return content.slice(fn.braceAt + 1, fn.braceAt + 13).startsWith('return null;');
}

function getPersonaExpr() {
    const js = PromptFile.split('\\').join('/').split('"').join('\\"');
    return '(function(){/*' + Marker + '*/try{return require("fs").readFileSync("' + js + '","utf8")}catch(e){return null}})()';
}

// ---------- 六个补丁 ----------
// 补丁 1: 清空 CLI Prefix 里的 "You are ZCode ..." 身份声明
function patchCliPrefix(c) {
    if (!c.includes(IdentityLit)) return { status: 'skip', content: c, name: '' };
    const rx = new RegExp('([A-Za-z_$][\\w$]*)=' + IdentityLit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const m = rx.exec(c);
    if (!m) return { status: 'missing', content: c, name: '' };
    const name = m[1];
    return { status: 'ok', content: c.slice(0, m.index) + name + '=""' + c.slice(m.index + m[0].length), name };
}

// 补丁 2: customSystemPrompt 改为读外部人格文件 (热换人格的唯一入口)
function patchCustomPrompt(c, expr) {
    const rx = /([A-Za-z_$][\w$]*)=this\.config\.customSystemPrompt\?\.trim\(\),([A-Za-z_$][\w$]*)=!!\1,/;
    const m = rx.exec(c);
    if (!m) {
        if (c.includes(Marker)) return { status: 'skip', content: c, name: '' };
        return { status: 'missing', content: c, name: '' };
    }
    const v = m[1], f = m[2];
    const rep = v + '=' + expr + '?.trim(),' + f + '=!!' + v + ',';
    return { status: 'ok', content: c.slice(0, m.index) + rep + c.slice(m.index + m[0].length), name: v };
}

// 补丁 3: Agent Identity 片段改读外部人格文件 (保留原逻辑作为兜底)
function patchAgentIdentity(c, expr) {
    const idx = c.indexOf(LitIdentity);
    if (idx < 0) return { status: 'missing', content: c, name: '' };
    const fn = findEnclosingFunction(c, idx);
    if (!fn) return { status: 'missing', content: c, name: '' };
    const bodyStart = fn.braceAt + 1;
    const seg = c.slice(bodyStart, idx);
    if (seg.includes(Marker)) return { status: 'skip', content: c, name: fn.name };
    const rxLet = /let\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]{1,120});/g;
    let last = null, m;
    while ((m = rxLet.exec(seg)) !== null) last = m;
    if (!last) return { status: 'missing', content: c, name: fn.name };
    const v = last[1], orig = last[2];
    if (orig.includes(Marker)) return { status: 'skip', content: c, name: fn.name };
    const absStart = bodyStart + last.index;
    const rep = 'let ' + v + ';try{' + v + '=' + expr + '}catch(_ze){' + v + '=' + orig + '}';
    return { status: 'ok', content: c.slice(0, absStart) + rep + c.slice(absStart + last[0].length), name: fn.name };
}

// 补丁 4/5/6: 直接让产物函数返回 null (日期提醒 / Skills 列表 / User Context)
function patchNullSection(c, literal) {
    const idx = c.indexOf(literal);
    if (idx < 0) return { status: 'missing', content: c, name: '' };
    const fn = findEnclosingFunction(c, idx);
    if (!fn) return { status: 'missing', content: c, name: '' };
    if (fn.braceAt + 1 >= c.length) return { status: 'missing', content: c, name: fn.name };
    if (c.slice(fn.braceAt + 1, fn.braceAt + 13).startsWith('return null;')) {
        return { status: 'skip', content: c, name: fn.name };
    }
    return { status: 'ok', content: c.slice(0, fn.braceAt + 1) + 'return null;' + c.slice(fn.braceAt + 1), name: fn.name };
}

// ---------- 备份 ----------
function archiveCurrent(file, kind) {
    fs.mkdirSync(BackupDir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const dest = path.join(BackupDir, 'zcode.cjs.' + kind + '-' + stamp + '.bak');
    fs.copyFileSync(file, dest);
    const baks = fs.readdirSync(BackupDir).filter((f) => f.endsWith('.bak'))
        .map((f) => ({ f, t: fs.statSync(path.join(BackupDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    for (const x of baks.slice(6)) { try { fs.unlinkSync(path.join(BackupDir, x.f)); } catch (e) { } }
    return dest;
}

function checkSyntax(content) {
    const tmp = path.join(os.tmpdir(), 'zcode-syntax-' + Math.random().toString(36).slice(2) + '.cjs');
    try {
        fs.writeFileSync(tmp, content, 'utf8');
        const r = cp.spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', timeout: 60000 });
        if (r.status !== 0) return { ok: false, err: ((r.stderr || '') + (r.stdout || '')).trim() };
        return { ok: true, err: '' };
    } catch (e) {
        return { ok: false, err: String(e.message || e) };
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) { }
    }
}

// ---------- 重启 (macOS) ----------
function zcodeRunning() {
    try {
        const out = cp.execSync("pgrep -f 'ZCode.app/Contents/MacOS/ZCode'", { encoding: 'utf8', timeout: 8000 });
        return out.split('\n').filter((s) => s.trim()).length;
    } catch (e) { return 0; }
}

function stopZCode() {
    try { cp.execSync("osascript -e 'tell application \"ZCode\" to quit'", { timeout: 10000, stdio: 'ignore' }); } catch (e) { }
    for (let i = 0; i < 6; i++) {
        if (zcodeRunning() === 0) break;
        cp.execSync('sleep 1');
    }
    if (zcodeRunning() > 0) {
        try { cp.execSync("pkill -f 'ZCode.app/Contents/MacOS/ZCode'", { timeout: 8000, stdio: 'ignore' }); } catch (e) { }
        cp.execSync('sleep 2');
    }
}

function startZCode(appPath) {
    if (!fs.existsSync(appPath)) { Warn2('未找到 ' + appPath + '，请手动启动 ZCode'); return; }
    try { cp.spawn('open', [appPath], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { }
    cp.execSync('sleep 5');
    Good('ZCode 已启动 (' + zcodeRunning() + ' 个进程)');
}

async function restartZCode(appPath, noRestart) {
    if (noRestart) { Note('已跳过 ZCode 重启 (--no-restart)'); return; }
    stopZCode();
    startZCode(appPath);
}

// ---------- 报告 ----------
function getPatchReport(c) {
    return [
        { name: 'CLI Prefix 身份声明', ok: !c.includes(IdentityLit) },
        { name: 'customSystemPrompt 读人格文件', ok: c.includes(Marker) },
        { name: 'Agent Identity 读人格文件', ok: testNullApplied(c, LitIdentity) || (c.includes(Marker) && testNullApplied(c, LitDate)) },
        { name: '日期提醒已移除', ok: testNullApplied(c, LitDate) },
        { name: 'Skills 列表已移除', ok: testNullApplied(c, LitSkills) },
        { name: 'User Context 已移除', ok: testNullApplied(c, LitUserCtx) },
    ];
}

function showSections(c) {
    const rx = /name:"([^"]{1,48})",source:"([^"]{1,48})",injectionTarget:"([^"]{1,24})"/g;
    let i = 0, m;
    while ((m = rx.exec(c)) !== null) {
        i++;
        const fn = findEnclosingFunction(c, m.index);
        const fnName = fn ? fn.name : '?';
        Note(String(i).padStart(2) + '. ' + m[1].padEnd(30) + ' source=' + m[2].padEnd(26) + ' target=' + m[3].padEnd(12) + ' fn=' + fnName);
    }
    if (i === 0) Note('(未识别到任何注入片段)');
}

function getBundleInfo(zdir) {
    const meta = path.join(zdir, META_REL);
    if (fs.existsSync(meta)) {
        try { return fs.readFileSync(meta, 'utf8').replace(/\s+/g, ' ').trim(); } catch (e) { return ''; }
    }
    return '';
}

// ============================================
// 主流程
// ============================================
async function main() {
    const argv = process.argv.slice(2);
    const actions = ['install', 'restore', 'status', 'diag', 'help'];
    let action = 'status';
    for (const a of argv) if (actions.includes(a)) action = a;
    const allowPartial = argv.includes('-AllowPartial') || argv.includes('--allow-partial');
    const noRestart = argv.includes('-NoRestart') || argv.includes('--no-restart');

    const ZcodeDir = findZcodeDir();
    if (!ZcodeDir) {
        Bad('未找到 ZCode 安装目录');
        Note('可用环境变量 ZCODE_DIR 手动指定，例如： export ZCODE_DIR=/Applications/ZCode.app');
        process.exit(1);
    }

    const ZcodeCjs = path.join(ZcodeDir, CJS_REL);
    const ZcodeBackup = ZcodeCjs + '.bak';
    const ZcodeApp = ZcodeDir;
    const nodeExe = process.execPath;

    try { fs.writeFileSync(DirCache, ZcodeDir + '\n', 'utf8'); } catch (e) { }

    Info('ZCode 目录:  ' + ZcodeDir);
    Info('目标文件:    ' + ZcodeCjs);
    Info('人格文件:    ' + PromptFile);
    console.log('');

    if (action === 'help') {
        Info('ZCode-Deploy v' + ToolVersion);
        console.log('');
        Note('用法: ./deploy.sh <动作> [选项]   或   node deploy.cjs <动作> [选项]');
        console.log('');
        Note('动作:');
        Note('  install         部署（备份原版 -> 打补丁 -> 语法校验 -> 重启 ZCode）');
        Note('  restore         还原原版（保留人格文件）');
        Note('  status          查看部署状态与补丁校验');
        Note('  diag            列出全部注入片段及其产物函数（排查用）');
        Note('  help            显示本帮助');
        console.log('');
        Note('选项:');
        Note('  --allow-partial   有补丁未命中时也强行部署（默认中止，不写入）');
        Note('  --no-restart      部署/还原后不重启 ZCode');
        console.log('');
        Note('人格文件: ' + PromptFile);
        Note('安装目录: 可用环境变量 ZCODE_DIR 手工指定（指到 ZCode.app 这一层）');
        return;
    }

    if (action === 'status') {
        Info('=== ZCode 部署状态 ===');
        Note('工具版本:   v' + ToolVersion);
        console.log('');
        if (!fs.existsSync(ZcodeCjs)) { Bad('目标文件不存在: ' + ZcodeCjs); process.exit(1); }
        const st = fs.statSync(ZcodeCjs);
        const content = fs.readFileSync(ZcodeCjs, 'utf8');
        const patched = content.includes(Marker);
        Note('文件大小:   ' + st.size + ' bytes');
        Note('修改时间:   ' + st.mtime.toISOString().replace('T', ' ').slice(0, 19));
        const bundle = getBundleInfo(ZcodeDir);
        if (bundle) Note('bundle:     ' + bundle);
        Note('人格文件:   ' + (fs.existsSync(PromptFile) ? fs.statSync(PromptFile).size + ' bytes' : '缺失'));
        Note('原版备份:   ' + (fs.existsSync(ZcodeBackup)
            ? fs.statSync(ZcodeBackup).size + ' bytes / ' + fs.statSync(ZcodeBackup).mtime.toISOString().slice(0, 19).replace('T', ' ')
            : '无'));
        console.log('');
        if (patched) console.log(C.yellow + '模式: 自定义人格 (已部署)' + C.reset);
        else console.log(C.green + '模式: ZCode 原版 (未部署)' + C.reset);
        console.log('');
        Info('--- 补丁校验 ---');
        for (const r of getPatchReport(content)) { if (r.ok) Good(r.name); else Warn2(r.name); }
        if (fs.existsSync(ZcodeBackup)) {
            const bakLen = fs.statSync(ZcodeBackup).size;
            if (!patched && bakLen !== st.size) {
                console.log('');
                Warn2('备份与当前版本大小不一致 —— 说明 ZCode 更新过。重跑 install 会自动刷新 .bak。');
            }
        }
        return;
    }

    if (action === 'diag') {
        Info('=== 注入片段定位 (诊断) ===');
        console.log('');
        const content = fs.readFileSync(ZcodeCjs, 'utf8');
        Note('文件: ' + ZcodeCjs + '  (' + content.length + ' chars)');
        Note('已部署: ' + content.includes(Marker));
        console.log('');
        showSections(content);
        return;
    }

    if (action === 'install') {
        Info('[1/6] 检查人格文件...');
        if (!fs.existsSync(PromptFile)) { Bad('未找到 ' + PromptFile); process.exit(1); }
        Good(PromptFile + ' (' + fs.statSync(PromptFile).size + ' bytes)');

        Info('[2/6] 读取并备份目标文件...');
        let content = fs.readFileSync(ZcodeCjs, 'utf8');
        const alreadyPatched = content.includes(Marker);
        if (alreadyPatched) {
            const arch = archiveCurrent(ZcodeCjs, 'patched');
            Note('已归档当前已破解版本 -> ' + arch);
        } else {
            const arch = archiveCurrent(ZcodeCjs, 'stock');
            Note('已归档当前原版 -> ' + arch);
        }
        if (!alreadyPatched) {
            if (fs.existsSync(ZcodeBackup) && fs.statSync(ZcodeBackup).size === fs.statSync(ZcodeCjs).size) {
                Skipd('zcode.cjs.bak 已是最新原版');
            } else {
                fs.copyFileSync(ZcodeCjs, ZcodeBackup);
                Good('已刷新 zcode.cjs.bak (新版原版，restore 不再降级)');
            }
        } else if (!fs.existsSync(ZcodeBackup)) {
            Warn2('缺少原版备份 .bak，restore 将不可用');
        }

        Info('[3/6] 应用补丁...');
        const expr = getPersonaExpr();
        const results = [];
        const steps = [
            [1, 'CLI Prefix 身份声明置空', () => patchCliPrefix(content)],
            [2, 'customSystemPrompt 读人格文件', () => patchCustomPrompt(content, expr)],
            [3, 'Agent Identity 读人格文件', () => patchAgentIdentity(content, expr)],
            [4, '日期提醒移除', () => patchNullSection(content, LitDate)],
            [5, 'Skills 列表移除', () => patchNullSection(content, LitSkills)],
            [6, 'User Context 移除', () => patchNullSection(content, LitUserCtx)],
        ];
        for (const [id, label, fn] of steps) {
            const r = fn();
            content = r.content;
            results.push({ id, label, status: r.status, fn: r.name });
        }
        for (const x of results) {
            const tag = x.fn ? ' (' + x.fn + ')' : '';
            if (x.status === 'ok') Good('[' + x.id + '] ' + x.label + tag);
            else if (x.status === 'skip') Skipd('[' + x.id + '] ' + x.label + tag);
            else Bad('[' + x.id + '] ' + x.label + tag + ' — 未找到目标');
        }

        const missing = results.filter((x) => x.status === 'missing');
        if (missing.length > 0 && !allowPartial) {
            console.log('');
            Bad('有 ' + missing.length + ' 个补丁未命中，ZCode 版本可能又变了。未做任何修改。');
            Note('请把下面这段诊断结果发给维护者：');
            console.log('');
            showSections(fs.readFileSync(ZcodeCjs, 'utf8'));
            console.log('');
            Note('如确认可以接受不完整结果，可加 --allow-partial 强制部署。');
            process.exit(1);
        }

        Info('[4/6] 语法校验 (node --check)...');
        const syn = checkSyntax(content);
        if (!syn.ok) {
            Bad('补丁后语法校验失败，已放弃写入，原文件未被修改');
            Note(syn.err);
            process.exit(1);
        }
        Good('语法校验通过');

        Info('[5/6] 写入 zcode.cjs...');
        const bytes = fs.readFileSync(ZcodeCjs);
        const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
        const mode = fs.statSync(ZcodeCjs).mode;
        const tmpWrite = ZcodeCjs + '.tmp-' + Math.random().toString(36).slice(2);
        fs.writeFileSync(tmpWrite, content, { encoding: 'utf8' });
        fs.chmodSync(tmpWrite, mode);
        fs.renameSync(tmpWrite, ZcodeCjs);
        Good('已写入 (' + fs.statSync(ZcodeCjs).size + ' bytes, BOM=' + hasBom + ')');

        console.log('');
        Info('--- 写入后自检 ---');
        for (const r2 of getPatchReport(content)) { if (r2.ok) Good(r2.name); else Warn2(r2.name); }
        Note('人格文件路径(已写入 cjs): ' + PromptFile);

        Info('[6/6] 重启 ZCode...');
        await restartZCode(ZcodeApp, noRestart);

        console.log('');
        console.log(C.green + '=== 部署完成 ===' + C.reset);
        Note('人格文件: ' + PromptFile + '   (改这个文件即可热换人格，开新对话生效)');
        Note('注意: 本文件夹被移动后需要重跑 install（路径已写入 zcode.cjs）');
        return;
    }

    if (action === 'restore') {
        Info('[1/4] 检查备份...');
        if (!fs.existsSync(ZcodeBackup)) {
            Bad('备份不存在: ' + ZcodeBackup);
            if (fs.existsSync(BackupDir)) {
                Note('备份目录中可用档案:');
                fs.readdirSync(BackupDir).filter((f) => f.endsWith('.bak'))
                    .map((f) => ({ f, t: fs.statSync(path.join(BackupDir, f)).mtimeMs }))
                    .sort((a, b) => b.t - a.t).slice(0, 10)
                    .forEach((x) => {
                        const s = fs.statSync(path.join(BackupDir, x.f));
                        Note('  ' + x.f + '  (' + s.size + ' bytes, ' + new Date(x.t).toISOString().slice(0, 19).replace('T', ' ') + ')');
                    });
            }
            process.exit(1);
        }
        Good('备份: ' + ZcodeBackup + ' (' + fs.statSync(ZcodeBackup).size + ' bytes)');

        Info('[2/4] 校验备份并归档当前版本...');
        const bakContent = fs.readFileSync(ZcodeBackup, 'utf8');
        const syn = checkSyntax(bakContent);
        if (!syn.ok) { Bad('备份文件语法校验失败，已中止还原'); Note(syn.err); process.exit(1); }
        const cur = fs.readFileSync(ZcodeCjs, 'utf8');
        if (cur.includes(Marker)) {
            const arch = archiveCurrent(ZcodeCjs, 'patched');
            Note('已归档当前已破解版本 -> ' + arch);
        }

        Info('[3/4] 还原代码...');
        {
            const mode = fs.statSync(ZcodeCjs).mode;
            const tmpWrite = ZcodeCjs + '.tmp-' + Math.random().toString(36).slice(2);
            fs.copyFileSync(ZcodeBackup, tmpWrite);
            fs.chmodSync(tmpWrite, mode);
            fs.renameSync(tmpWrite, ZcodeCjs);
        }
        Good('已还原为原版');

        if (fs.existsSync(PromptFile)) Skipd('人格文件保留: ' + PromptFile);

        Info('[4/4] 重启 ZCode...');
        await restartZCode(ZcodeApp, noRestart);

        console.log('');
        console.log(C.green + '=== 恢复完成 ===' + C.reset);
        return;
    }
}

main().catch((e) => { Bad('未预期的错误: ' + (e.stack || e.message || e)); process.exit(1); });
