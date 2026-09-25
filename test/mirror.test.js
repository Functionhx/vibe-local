import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorRoots, mirrorBase, MIRROR_SOURCES, fmtBytes } from '../src/mirror.js';
import { parsers } from '../src/upstream/parsers/index.js';

test('mirrorRoots 用替换语义的环境变量，不用追加语义的 extraRoots', () => {
  const r = mirrorRoots('somehost');
  // 这是本项目踩过坑的设计决定：extraRoots 是追加，会把默认根一起扫进来，
  // 导致本机数据混入远程结果。实测 255 + 369 = 624 确认过。
  assert.ok(r.env, '应返回 env 而非 extraRoots');
  assert.equal(r.env.extraRoots, undefined, '不应返回 extraRoots');
  assert.ok(r.env['claude-code'].VIBE_USAGE_CLAUDE_DIRS, 'claude 应走 REPLACE 型环境变量');
  assert.ok(r.env.codex.CODEX_HOME, 'codex 应走 CODEX_HOME');
  assert.ok(r.env.opencode.VIBE_USAGE_OPENCODE_DIRS !== undefined);
});

test('镜像覆盖注册表里的每一个 parser，没有例外', () => {
  // 这条守的是一个曾经存在的缺口：gemini-cli 的路径硬编码、无覆盖入口，导致
  // "镜像方案里有个工具永远只能是本机的"。现在它已被移除，此断言确保今后新增
  // parser 时不会再悄悄引入这类例外。
  const r = mirrorRoots('somehost');
  const covered = new Set(Object.keys(r.env));
  const registered = Object.keys(parsers);
  const uncovered = registered.filter((s) => !covered.has(s));
  assert.deepEqual(uncovered, [], `这些 parser 无法被镜像：${uncovered.join(', ')}`);
  assert.equal(registered.length, 3);
});

test('镜像路径按 host 隔离', () => {
  assert.notEqual(mirrorBase('a'), mirrorBase('b'));
  assert.ok(mirrorBase('a').endsWith(join('mirror', 'a')));
});

test('codex 只镜像 sessions 与 archived_sessions，不镜像 packages', () => {
  const codex = MIRROR_SOURCES.find((s) => s.id === 'codex');
  assert.deepEqual(codex.paths.sort(), ['archived_sessions', 'sessions']);
  // 服务器上 ~/.codex 里 packages/ 能占一半以上（沙箱 npm 包），parser 不读它。
  assert.ok(!codex.paths.some((p) => p.includes('packages')));
});

test('fmtBytes', () => {
  assert.equal(fmtBytes(500), '500 KB');
  assert.equal(fmtBytes(2048), '2 MB');
  assert.equal(fmtBytes(1024 * 1024 * 3), '3.0 GB');
});

test('mirrorStatus 能把"目录在但为空"判为未同步', () => {
  // 在子进程里跑，因为 STATE_DIR 是 import 时读取的环境变量
  const dir = mkdtempSync(join(tmpdir(), 'vibe-mirror-test-'));
  try {
    const code = `
      import { mirrorStatus } from '${process.cwd()}/src/mirror.js';
      console.log(JSON.stringify(mirrorStatus('t')));
    `;
    // 场景一：什么都不存在
    let r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
      { env: { ...process.env, VIBE_LOCAL_DIR: dir }, encoding: 'utf8' });
    let st = JSON.parse(r.stdout.trim());
    assert.equal(st.present.length, 0);
    assert.ok(st.missing.includes('codex/sessions'));

    // 场景二：目录建出来了但没内容 —— rsync 会先建空目录，光判 existsSync 会误判
    mkdirSync(join(dir, 'mirror', 't', 'codex', 'sessions'), { recursive: true });
    r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
      { env: { ...process.env, VIBE_LOCAL_DIR: dir }, encoding: 'utf8' });
    st = JSON.parse(r.stdout.trim());
    assert.ok(st.missing.includes('codex/sessions'), '空目录应判为未同步');

    // 场景三：有内容了
    writeFileSync(join(dir, 'mirror', 't', 'codex', 'sessions', 'a.jsonl'), '{}');
    r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
      { env: { ...process.env, VIBE_LOCAL_DIR: dir }, encoding: 'utf8' });
    st = JSON.parse(r.stdout.trim());
    assert.ok(st.present.includes('codex/sessions'), '有内容应判为已同步');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
