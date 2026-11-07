import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = join(projectRoot, "node_modules/typescript/bin/tsc");
const piCli = join(projectRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

if (!existsSync(compiler) || !existsSync(piCli)) {
  console.error("依存パッケージがありません。プロジェクトのフォルダで npm ci --ignore-scripts を実行してください。");
  process.exit(1);
}

console.error("Human-in-the-Harnessをビルドしています…");
const build = spawnSync(process.execPath, [compiler], { cwd: projectRoot, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const args = [
  piCli,
  "-e", join(projectRoot, "dist/src/adapters/pi.js"),
  "--append-system-prompt", join(projectRoot, "examples/pi/instructions.md"),
  ...process.argv.slice(2),
];

console.error("拡張を読み込んでpiを起動します。初回のモデル接続は /login、開示内容の確認は /human-context です。");
const child = spawn(process.execPath, args, {
  cwd: projectRoot,
  stdio: "inherit",
  env: { ...process.env, HITH_DATABASE: process.env.HITH_DATABASE ?? join(projectRoot, "var/hith.sqlite") },
});

// 端末のCtrl+Cは同じプロセスグループのpiが扱う。起動役だけを先に終了させない。
process.on("SIGINT", () => {});
process.on("SIGTERM", () => { child.kill("SIGTERM"); });
child.on("error", error => { console.error(`piを起動できません: ${error.message}`); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
