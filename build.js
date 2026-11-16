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
  const assets = Object.fromEntries(['index.html', 'style.css', 'app.js', 'chart.js'].map((f) => [f, path.join('public', f)]));
  fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify({
    main: 'build/app.cjs', output: 'build/sea.blob', disableExperimentalSEAWarning: true,
    useCodeCache: false, useSnapshot: false, assets,
  }, null, 2));
  run(process.execPath, ['--experimental-sea-config', 'build/sea-config.json']);

  console.log('3/4 Windows용 node.exe 준비');
  const nodeExe = path.join(BUILD, `node-${process.version}-win-x64.exe`);
  if (!fs.existsSync(nodeExe)) {
    const url = `https://nodejs.org/dist/${process.version}/win-x64/node.exe`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`node.exe 다운로드 실패 (${res.status}) ${url}`);
    fs.writeFileSync(nodeExe, Buffer.from(await res.arrayBuffer()));
  }

  console.log('4/4 exe 만들기');
  const out = path.join(DIST, 'KRX-APEX.exe');
  fs.copyFileSync(nodeExe, out);
  run(bin('postject'), [out, 'NODE_SEA_BLOB', 'build/sea.blob', '--sentinel-fuse', FUSE, '--overwrite']);
  console.log(`완료: ${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
