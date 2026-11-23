import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishVideoTool, handlePublishVideo } from '../dist/tools/publish.js';
import { handleListAccounts } from '../dist/tools/accounts.js';
import { defaultInstallLocations } from '../dist/runner.js';
import { existsSync } from 'node:fs';

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('MATRIXMEDIA_BIN is used and publish_video forwards --phone for xhs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mm-bin-'));
  const bin = path.join(dir, 'fake-matrixmedia');
  const argsLog = path.join(dir, 'args.json');
  await writeFile(
    bin,
    `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ resultStatus: 'success', message: 'ok' }));
`,
    'utf8'
  );
  await chmod(bin, 0o755);
  try {
    await withEnv({ MATRIXMEDIA_BIN: bin }, async () => {
      const out = JSON.parse(
        await handlePublishVideo({
          platform: 'xhs',
          phone: '13800138000',
          file: '/tmp/v.mp4',
          title: 't',
        })
      );
      assert.equal(out.status, 'success');
      const argv = JSON.parse(await readFile(argsLog, 'utf8'));
      assert.deepEqual(argv.slice(0, 4), ['cli', 'publish', '-p', 'xhs']);
      const i = argv.indexOf('--phone');
      assert.ok(i > 0 && argv[i + 1] === '13800138000');
      assert.ok(!argv.includes('--partition'));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publish_video exposes dySyncToutiao schema and forwards --dy-sync-toutiao only when true', async () => {
  const prop = publishVideoTool.inputSchema.properties?.dySyncToutiao;
  assert.ok(prop, 'publish_video schema must include dySyncToutiao');
  assert.equal(prop.type, 'boolean');
  assert.ok(
    !(publishVideoTool.inputSchema.required || []).includes('dySyncToutiao'),
    'dySyncToutiao must be optional'
  );
  assert.match(String(prop.description || ''), /Douyin|dy/i);
  assert.match(String(prop.description || ''), /Toutiao|tt/i);

  const dir = await mkdtemp(path.join(tmpdir(), 'mm-dy-sync-'));
  const bin = path.join(dir, 'fake-matrixmedia');
  const argsLog = path.join(dir, 'args.json');
  await writeFile(
    bin,
    `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ resultStatus: 'success', message: 'ok' }));
`,
    'utf8'
  );
  await chmod(bin, 0o755);
  try {
    await withEnv({ MATRIXMEDIA_BIN: bin }, async () => {
      await handlePublishVideo({
        platform: 'dy',
        phone: '13800138000',
        file: '/tmp/v.mp4',
        title: 't',
        dySyncToutiao: true,
      });
      const argvTrue = JSON.parse(await readFile(argsLog, 'utf8'));
      assert.ok(
        argvTrue.includes('--dy-sync-toutiao'),
        `expected --dy-sync-toutiao in ${JSON.stringify(argvTrue)}`
      );

      await handlePublishVideo({
        platform: 'dy',
        phone: '13800138000',
        file: '/tmp/v.mp4',
        title: 't',
        dySyncToutiao: false,
      });
      const argvFalse = JSON.parse(await readFile(argsLog, 'utf8'));
      assert.ok(
        !argvFalse.includes('--dy-sync-toutiao'),
        `did not expect --dy-sync-toutiao when false: ${JSON.stringify(argvFalse)}`
      );

      await handlePublishVideo({
        platform: 'dy',
        phone: '13800138000',
        file: '/tmp/v.mp4',
        title: 't',
      });
      const argvOmitted = JSON.parse(await readFile(argsLog, 'utf8'));
      assert.ok(
        !argvOmitted.includes('--dy-sync-toutiao'),
        `did not expect --dy-sync-toutiao when omitted: ${JSON.stringify(argvOmitted)}`
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('publish_video rejects unknown platform', async () => {
  await assert.rejects(
    handlePublishVideo({ platform: 'weibo', phone: '1', file: '/tmp/v.mp4', title: 't' }),
    /platform must be one of/
  );
});

const appInstalledHere = defaultInstallLocations().some(p => existsSync(p));

test('missing app yields an actionable install hint', { skip: appInstalledHere && 'MatrixMedia installed at a default location on this machine' }, async () => {
  const empty = await mkdtemp(path.join(tmpdir(), 'mm-empty-'));
  try {
    await withEnv(
      { MATRIXMEDIA_BIN: undefined, MATRIXMEDIA_DIR: empty, PATH: empty, HOME: empty },
      async () => {
        await assert.rejects(handleListAccounts({}), /未找到 MatrixMedia/);
      }
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
