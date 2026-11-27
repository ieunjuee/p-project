// data/build_db.py 옵션 테스트: --out, --fraud-rate, --seed, 함정 정상 시나리오
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows에는 python3 명령이 없는 경우가 많아 python으로 다시 시도
const PYTHON = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

function build(args, env = {}) {
  return spawnSync(PYTHON, ['data/build_db.py', ...args], {
    cwd: root, encoding: 'utf-8', env: { ...process.env, PYTHONUTF8: '1', ...env },
  });
}

function buildTo(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insurelens-'));
  const run = build([...args, '--out', dir]);
  assert.equal(run.status, 0, run.stderr);
  return { dir, labels: JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf-8')) };
}

const hash = (file) => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const WEB_FILES = ['data/insure.db', 'dist/data/insure.db', 'dist/data/mock.json', 'dist/data/labels.json'];

test('--out 은 지정한 폴더에만 만들고 화면용 파일은 건드리지 않는다', { skip: !PYTHON && 'Python 없음' }, () => {
  const before = WEB_FILES.map(hash);
  const { dir } = buildTo(['--seed', '11', '--people', '200']);
  assert.deepEqual(WEB_FILES.map(hash), before);
  for (const name of ['insure.db', 'mock.json', 'labels.json']) assert.ok(fs.existsSync(path.join(dir, name)), name);
});

test('--fraud-rate 를 주면 위험 시나리오 비율이 그 값에 맞는다', { skip: !PYTHON && 'Python 없음' }, () => {
  const { labels } = buildTo(['--seed', '12', '--people', '1000', '--fraud-rate', '0.05']);
  const rows = Object.values(labels);
  assert.equal(rows.length, 1000);
  const rate = rows.filter((r) => r.is_suspicious === 1).length / rows.length;
  assert.ok(Math.abs(rate - 0.05) <= 0.005, `위험 비율 ${rate}`);
});

test('같은 seed는 같은 데이터, 다른 seed는 다른 데이터를 만든다', { skip: !PYTHON && 'Python 없음' }, () => {
  const a = buildTo(['--seed', '13', '--people', '200']);
  const b = buildTo(['--seed', '13', '--people', '200']);
  const c = buildTo(['--seed', '14', '--people', '200']);
  const read = (d) => fs.readFileSync(path.join(d.dir, 'labels.json'), 'utf-8');
  assert.equal(read(a), read(b));
  assert.notEqual(read(a), read(c));
});

test('잘못된 위험 비율은 거부한다', { skip: !PYTHON && 'Python 없음' }, () => {
  for (const bad of ['0', '1', '1.5', '-0.1']) {
    const run = build(['--fraud-rate', bad, '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'insurelens-'))]);
    assert.notEqual(run.status, 0, `--fraud-rate ${bad}`);
  }
});

test('--stress 는 함정 정상을 정상으로 더하고, 기본 데이터에는 넣지 않는다', { skip: !PYTHON && 'Python 없음' }, () => {
  const { labels } = buildTo(['--seed', '15', '--people', '1000', '--fraud-rate', '0.05', '--stress']);
  const plain = buildTo(['--seed', '15', '--people', '1000', '--fraud-rate', '0.05']).labels;
  for (const name of ['정상고액입원', '정상다병원이용', '경계정상']) {
    const rows = Object.values(labels).filter((r) => r.scenario === name);
    assert.ok(rows.length > 0, `${name} 없음`);
    assert.ok(rows.every((r) => r.is_suspicious === 0), `${name}에 위험 표시`);
    assert.ok(!Object.values(plain).some((r) => r.scenario === name), `기본 데이터에 ${name}`);
  }
  assert.notEqual(build(['--stress']).status, 0, '--out 없는 --stress 는 거부');
});
