// Windows용 단일 실행 파일(dist/KRX-APEX.exe)을 만든다.  사용: npm run build
// 1) 서버 코드를 한 파일로 묶고  2) 화면 파일과 함께 Node SEA blob으로 만든 뒤  3) node.exe에 주입한다.
// 어느 OS에서 실행해도 Windows exe가 나온다(빌드하는 Node와 같은 버전의 node.exe를 받아 쓴다).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const bin = (name) => path.join(ROOT, 'node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });

async function main() {
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  console.log('1/4 서버 코드 묶기');
  run(bin('esbuild'), ['server.js', '--bundle', '--platform=node', '--format=cjs', '--outfile=build/app.cjs', '--log-level=warning']);

  console.log('2/4 실행 파일용 blob 만들기');
  const assets = Object.fromEntries(['index.html', 'style.css', 'app.js', 'chart.js', 'lwc.js', 'icon.svg'].map((f) => [f, path.join('public', f)]));
  fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
    main: 'build/app.cjs', output: 'build/sea.blob', disableExperimentalSEAWarning: true,
    useCodeCache: false, useSnapshot: false, assets,
  }, null, 2));
  run(process.execPath, ['--experimental-sea-config', 'build/sea-config.json']);

  console.log('3/4 Windows용 node.exe 준비');
  const nodeExe = path.join(BUILD, `node-${process.version}-win-x64.exe`);
  if (process.platform === 'win32' && process.arch === 'x64') {
    fs.copyFileSync(process.execPath, nodeExe); // Windows에서 빌드하면 지금 쓰는 node.exe를 그대로 쓴다
  } else if (!fs.existsSync(nodeExe)) {
    const url = `https://nodejs.org/dist/${process.version}/win-x64/node.exe`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`node.exe 다운로드 실패 (${res.status}) ${url}`);
    fs.writeFileSync(nodeExe, Buffer.from(await res.arrayBuffer()));
  }

  console.log('4/4 exe 만들기');
  const out = path.join(DIST, 'KRX-APEX.exe');
  fs.copyFileSync(nodeExe, out);
  run(bin('postject'), [out, 'NODE_SEA_BLOB', 'build/sea.blob', '--sentinel-fuse', FUSE, '--overwrite']);
  setIconAndInfo(out, out); // blob 주입 뒤에 아이콘·파일 정보를 넣는다(순서를 바꾸면 주입 도구가 exe를 읽지 못한다)
  hideConsole(out);
  console.log(`완료: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}

// exe 아이콘과 파일 정보(이름·버전)를 바꾼다. node.exe의 서명은 어차피 무효가 되므로 무시한다.
function setIconAndInfo(src, dest) {
  const ResEdit = require('resedit');
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(src), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'icon.ico')));
  const group = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group ? group.id : 1, group ? group.lang : 1033, icon.icons.map((i) => i.data));
  const info = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (info) {
    const version = require('./package.json').version;
    const lang = info.getAvailableLanguages()[0] || { lang: 1033, codepage: 1200 };
    info.setStringValues(lang, {
      ProductName: 'KRX::APEX Terminal', FileDescription: 'KRX::APEX Terminal', OriginalFilename: 'KRX-APEX.exe',
      InternalName: 'KRX-APEX', CompanyName: '', LegalCopyright: '', ProductVersion: version, FileVersion: version,
    });
    info.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(dest, Buffer.from(exe.generate()));
}

// 콘솔 창이 뜨지 않게 exe의 서브시스템을 콘솔(3)에서 GUI(2)로 바꾼다.
function hideConsole(file) {
  const fd = fs.openSync(file, 'r+');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0x3c);
  const at = b.readUInt32LE(0) + 24 + 68; // PE 헤더 → 옵션 헤더 → Subsystem
  fs.readSync(fd, b, 0, 2, at);
  if (b.readUInt16LE(0) !== 3) { fs.closeSync(fd); throw new Error(`예상과 다른 서브시스템 값: ${b.readUInt16LE(0)}`); }
  b.writeUInt16LE(2, 0);
  fs.writeSync(fd, b, 0, 2, at);
  fs.closeSync(fd);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
