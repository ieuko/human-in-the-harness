import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("別々のCLIプロセスで登録・質問・回答・結果の回収ができる", t => {
  const directory = mkdtempSync(join(tmpdir(), "hith-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, "store.sqlite");
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args, "--database", database], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const created = run("submit", "--prompt", "次の処理を提案してください", "--key", "example");
  assert.equal(created.status, "pending");
  const question = run("respond", created.id, "--revision", "1", "--kind", "question", "--text", "優先条件は？");
  assert.equal(question.request.status, "in_progress");
  const response = run("respond", created.id, "--revision", "1", "--payload", '{"next":"調査"}', "--input-id", "answer");
  assert.equal(response.input.disposition, "accepted");
  assert.deepEqual(run("get", created.id).result, { next: "調査" });
  assert.equal(run("events", "--request", created.id).length, 3);
});

test("競合する別プロセスの回答は、一つだけが最終結果に適用される", async t => {
  const directory = mkdtempSync(join(tmpdir(), "hith-race-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, "store.sqlite");
  const created = spawnSync(process.execPath, [cli, "submit", "--prompt", "確認", "--database", database], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const { id } = JSON.parse(created.stdout);
  const respond = (label: string) => new Promise<{ input: { disposition: string } }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "respond", id, "--revision", "1", "--text", label, "--database", database]);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => { if (code !== 0) reject(new Error(stderr)); else resolve(JSON.parse(stdout)); });
  });
  const results = await Promise.all([respond("回答A"), respond("回答B")]);
  assert.deepEqual(results.map(r => r.input.disposition).sort(), ["accepted", "late"]);
});
