import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, resolveTaskFile } from '../src/config.js';

test('config uses the default run limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-defaults-'));
  const config = await loadConfig(root);

  assert.deepEqual(config.limits, { turns: 200, durationMinutes: 60 });
});

test('config resolves relative and absolute directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-config-'));
  const tasks = path.join(root, 'tasks');
  await mkdir(tasks);
  await writeFile(path.join(root, 'bbx.config.json'), JSON.stringify({
    tasksDir: './tasks',
    artifactsDir: '/tmp/bbx-external-artifacts',
    limits: { turns: 7, durationMinutes: 2 },
  }));

  const config = await loadConfig(root);
  assert.equal(config.tasksDir, tasks);
  assert.equal(config.artifactsDir, '/tmp/bbx-external-artifacts');
  assert.deepEqual(config.limits, { turns: 7, durationMinutes: 2 });
});

test('task lookup accepts nested txt tasks and rejects traversal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-task-'));
  const tasks = path.join(root, 'tasks');
  await mkdir(path.join(tasks, 'nested'), { recursive: true });
  await writeFile(path.join(tasks, 'nested', 'demo.txt'), 'Do the work.');
  await writeFile(path.join(root, 'outside.txt'), 'No.');

  const config = await loadConfig(root);
  const task = await resolveTaskFile(config, 'nested/demo');
  assert.equal(task.prompt, 'Do the work.');
  assert.equal(task.path, await realpath(path.join(tasks, 'nested', 'demo.txt')));
  await assert.rejects(() => resolveTaskFile(config, '../outside'), /inside|not found/);
});

test('task lookup rejects empty prompts before a run starts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bbx-empty-task-'));
  const tasks = path.join(root, 'tasks');
  await mkdir(tasks);
  await writeFile(path.join(tasks, 'empty.txt'), '  \n\t');

  const config = await loadConfig(root);
  await assert.rejects(() => resolveTaskFile(config, 'empty'), /Task is empty/);
});
