/**
 * 生成 Linux 发布包 dist/zviewer-linux-x64.tar.gz（自定义 ustar 写入器）。
 *
 * 为什么不用 tar 命令：Windows 自带 bsdtar 不支持 --mode，node-tar 的
 * onWriteEntry 改 mode 会被 pkg 流程覆盖，最终可执行文件权限丢失
 * （部署后无法运行）。这里直接写 ustar 头，把 zviewer-backend /
 * zviewer-cert / start.sh 固定为 0755。
 *
 * ⚠ 校验和必须在「typeflag 已写入、校验位填空格」之后计算：目录条目
 * 的 typeflag 是 '5'，若用 '0' 参与求和，GNU tar / bsdtar 会判定
 * 归档损坏（Skipping to next header / Exiting with failure status）。
 *
 * 用法：先 node build-all.js --skip-build --linux，再 node scripts/make-linux-tar.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'linux');
const OUT = path.join(ROOT, 'dist', 'zviewer-linux-x64.tar.gz');
const EXECUTABLES = new Set(['zviewer-backend', 'zviewer-cert', 'start.sh']);

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(name, size, mode, typeflag, mtimeSec) {
  const buf = Buffer.alloc(512);
  const write = (str, offset, length) => {
    Buffer.from(str, 'utf8').copy(buf, offset, 0, Math.min(length, Buffer.byteLength(str)));
  };
  write(name, 0, 100);
  write(octal(mode, 8), 100, 8);
  write(octal(0, 8), 108, 8); // uid
  write(octal(0, 8), 116, 8); // gid
  write(octal(size, 12), 124, 12);
  // 用条目自身的 mtime：同一份 dist/linux 重复打包结果完全一致（便于校验 sha256）
  write(octal(Math.floor(mtimeSec), 12), 136, 12);
  buf.write(typeflag, 156, 1); // typeflag 必须先写，校验和覆盖它
  buf.fill(0x20, 148, 156); // 校验位占位（空格）
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  write('root', 265, 32); // uname
  write('root', 297, 32); // gname
  let sum = 0;
  for (const b of buf) sum += b;
  write(octal(sum, 7), 148, 7);
  buf.write(' ', 155, 1);
  return buf;
}

function walk(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    const stat = fs.statSync(full);
    if (entry.isDirectory()) {
      out.push({ type: 'dir', name: rel + '/', size: 0, mode: 0o755, path: full, mtime: stat.mtimeMs / 1000 });
      walk(full, rel, out);
    } else {
      out.push({
        type: 'file',
        name: rel,
        size: stat.size,
        mode: EXECUTABLES.has(entry.name) ? 0o755 : 0o644,
        path: full,
        mtime: stat.mtimeMs / 1000,
      });
    }
  }
}

if (!fs.existsSync(SRC)) {
  console.error('未找到 ' + SRC + '，请先执行: node build-all.js --skip-build --linux');
  process.exit(1);
}

const entries = [];
walk(SRC, '', entries);

const chunks = [];
for (const e of entries) {
  chunks.push(header(e.name, e.size, e.mode, e.type === 'dir' ? '5' : '0', e.mtime));
  if (e.type === 'file') {
    const data = fs.readFileSync(e.path);
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
}
chunks.push(Buffer.alloc(1024)); // 归档结束标记（两个 512 零块）

const tar = Buffer.concat(chunks);
const gz = zlib.gzipSync(tar, { level: 9, mtime: 0 });
fs.writeFileSync(OUT, gz);
console.log('entries:', entries.length, 'tar:', tar.length, 'gzip:', gz.length, '->', OUT);
for (const e of entries.filter((x) => EXECUTABLES.has(path.basename(x.name)))) {
  console.log('  ' + e.name + ' mode=' + e.mode.toString(8));
}
