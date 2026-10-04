'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./store.js');
const withDefault = () => ({ ...S.empty(), tasks: [{ id: 'default', name: '默认任务', createdAt: '1970-01-01T00:00:00.000Z' }] });
test('创建、加减、历史和持久化往返一致，原状态不被修改', () => {
  const initial = withDefault();
  const created = S.create(initial, '  喝水  ');
  const id = created.counters[0].id;
  assert.equal(initial.counters.length, 0);
  assert.equal(created.counters[0].name, '喝水');
  assert.equal(created.history.length, 0);
  let state = created;
  for (let i = 0; i < 30; i++) state = S.change(state, id, 1);
  state = S.change(state, id, -1);
  assert.equal(created.counters[0].value, 0);
  assert.equal(state.counters[0].value, 29);
  assert.equal(state.history.length, 31);
  assert.deepEqual([state.history[0].before, state.history[0].after, state.history[0].delta], [30, 29, -1]);
  assert.equal(state.history[0].name, '喝水');
  assert.deepEqual(S.parse(JSON.stringify(state)), state);
});
test('零不能继续减少，同名计数器独立记录，名称按原文保存', () => {
  let state = S.create(withDefault(), '<img onerror=alert(1)>');
  state = S.create(state, '<img onerror=alert(1)>');
  const id = state.counters[0].id;
  assert.notEqual(id, state.counters[1].id);
  assert.equal(S.change(state, id, -1), state);
  state = S.change(state, id, 1);
  assert.equal(state.counters[1].value, 0);
  assert.equal(state.history[0].counterId, id);
  assert.equal(state.history[0].name, '<img onerror=alert(1)>');
});
test('无效输入、损坏存储和数值上限有保护', () => {
  assert.deepEqual(S.parse(null), S.empty());
  assert.deepEqual(S.empty(), { version: 3, tasks: [], counters: [], history: [], snapshots: [] });
  assert.throws(() => S.create(withDefault(), '   '));
  assert.throws(() => S.create(withDefault(), '字'.repeat(41)));
  assert.throws(() => S.create(S.empty(), '没有任务'));
  assert.throws(() => S.parse('{invalid'));
  assert.throws(() => S.parse('{"version":1,"counters":[{}],"history":[]}'));
  let state = S.create(withDefault(), '测试');
  const id = state.counters[0].id;
  assert.throws(() => S.change(state, id, 2));
  assert.throws(() => S.change(state, 'missing', 1));
  state.counters[0].value = Number.MAX_SAFE_INTEGER;
  assert.throws(() => S.change(state, id, 1));
  state = S.change(state, id, -1);
  assert.equal(state.counters[0].value, Number.MAX_SAFE_INTEGER - 1);
});

test('v1 原键迁移到默认任务，原计数和历史完整保留', () => {
  const old = {
    version: 1,
    counters: [{ id: 'c1', name: '旧类型', value: 3, createdAt: '2024-01-01T00:00:00.000Z' }],
    history: [{ id: 'h1', counterId: 'c1', name: '旧类型', delta: 1, before: 2,
      after: 3, at: '2024-01-02T00:00:00.000Z' }]
  };
  assert.equal(S.KEY, 'diandian-counter-v1');
  const migrated = S.parse(JSON.stringify(old));
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.tasks.map(t => t.id), ['default']);
  assert.deepEqual(migrated.counters[0], { ...old.counters[0], taskId: 'default' });
  assert.deepEqual(migrated.history, old.history);
  assert.deepEqual(migrated.snapshots, []);
  assert.deepEqual(S.parse(JSON.stringify(migrated)), migrated);
});

test('空旧数据迁移后仍无任务；v2 无内容默认任务自动移除', () => {
  const oldV1 = { version: 1, counters: [], history: [] };
  assert.deepEqual(S.parse(JSON.stringify(oldV1)), S.empty());
  const oldV2 = { ...withDefault(), version: 2 };
  assert.deepEqual(S.parse(JSON.stringify(oldV2)), S.empty());
});

test('最后一个任务删除后解析仍为空，旧 v2 默认任务有历史关联时保留', () => {
  const at = '2025-01-01T00:00:00.000Z';
  let state = withDefault();
  state = S.removeTask(state, 'default', at);
  assert.deepEqual(S.parse(JSON.stringify(state)), S.empty());
  state = S.create(withDefault(), '旧类型', at);
  state = S.change(state, state.counters[0].id, 1, at);
  const legacyV2 = { ...state, version: 2 };
  assert.deepEqual(S.parse(JSON.stringify(legacyV2)).tasks.map(t => t.id), ['default']);
  state = S.removeTask(state, 'default', at);
  assert.deepEqual(S.parse(JSON.stringify(state)), state);
});

test('不同任务的类型和新历史分别归属自己的任务', () => {
  const original = S.empty();
  let state = S.createTask(original, '  项目乙  ', '2025-01-01T00:00:00.000Z');
  const task = state.tasks[0];
  assert.equal(original.tasks.length, 0);
  assert.equal(task.name, '项目乙');
  state = S.create(state, '任务内类型', '2025-01-02T00:00:00.000Z', task.id);
  state = S.create(state, '自动归入首个任务');
  assert.deepEqual(state.counters.map(c => c.taskId), [task.id, task.id]);
  state = S.change(state, state.counters[0].id, 1, '2025-01-03T00:00:00.000Z');
  assert.equal(state.history[0].taskId, task.id);
  assert.equal(state.history[0].taskName, '项目乙');
  assert.deepEqual(S.parse(JSON.stringify(state)), state);
  assert.throws(() => S.create(state, '未知任务', undefined, 'missing'));
  assert.throws(() => S.createTask(state, '  '));
  assert.throws(() => S.createTask(state, '字'.repeat(41)));
});

test('保存整页快照冻结当时全部类型和数量，不改计数或历史', () => {
  let state = S.createTask(S.empty(), '甲');
  const taskId = state.tasks[0].id;
  assert.throws(() => S.savePage(state, taskId));
  state = S.create(state, 'A', undefined, taskId);
  state = S.create(state, 'B', undefined, taskId);
  state = S.createTask(state, '乙');
  const otherId = state.tasks[1].id;
  state = S.create(state, '其他任务', undefined, otherId);
  state = S.change(state, state.counters[0].id, 1);
  const before = state;
  const saved = S.savePage(state, taskId, '2025-03-04T05:06:07.000Z');
  assert.equal(before.snapshots.length, 0);
  assert.deepEqual(saved.counters, before.counters);
  assert.deepEqual(saved.history, before.history);
  assert.deepEqual(saved.snapshots[0].items, [
    { id: state.counters[0].id, name: 'A', value: 1 },
    { id: state.counters[1].id, name: 'B', value: 0 }
  ]);
  assert.equal(saved.snapshots[0].taskName, '甲');
  assert.equal(saved.snapshots[0].at, '2025-03-04T05:06:07.000Z');
  const changed = S.change(saved, state.counters[0].id, 1);
  assert.equal(changed.snapshots[0].items[0].value, 1);
  assert.deepEqual(S.parse(JSON.stringify(changed)), changed);
  assert.throws(() => S.savePage(state, 'missing'));
});

test('v2 拒绝损坏的任务、引用、快照与数值', () => {
  const base = S.create(withDefault(), 'A');
  const invalid = mutate => {
    const copy = JSON.parse(JSON.stringify(base));
    mutate(copy);
    assert.throws(() => S.parse(JSON.stringify(copy)));
  };
  invalid(d => { d.tasks.push({ ...d.tasks[0] }); });
  invalid(d => { d.tasks[0].name = ' '; });
  invalid(d => { d.counters[0].taskId = 'missing'; });
  invalid(d => { d.counters[0].value = 1.5; });
  invalid(d => { d.counters[0].createdAt = 'not a date'; });
  invalid(d => { d.history.push({ id: 'h', counterId: 'missing', name: 'A', delta: 1,
    before: 0, after: 1, at: '2025-01-01T00:00:00.000Z' }); });
  invalid(d => { d.snapshots.push({ id: 's', taskId: 'default', taskName: '默认任务',
    at: '2025-01-01T00:00:00.000Z', items: [{ id: 'missing', name: 'A', value: 1 }] }); });
});

test('删除类型只隐藏活跃类型，旧历史与快照引用仍可校验', () => {
  const at = '2025-07-01T12:00:00.000Z';
  let state = S.create(withDefault(), '苹果');
  state = S.create(state, '香蕉');
  const apple = state.counters[0].id;
  state = S.change(state, apple, 1);
  state = S.savePage(state, 'default');
  const before = state;
  state = S.removeCounter(state, apple, at);
  assert.equal(before.counters[0].deletedAt, undefined);
  assert.equal(state.counters[0].deletedAt, at);
  assert.deepEqual(state.history, before.history);
  assert.deepEqual(state.snapshots, before.snapshots);
  assert.throws(() => S.change(state, apple, 1));
  state = S.savePage(state, 'default');
  assert.deepEqual(state.snapshots[0].items.map(i => i.name), ['香蕉']);
  assert.deepEqual(S.parse(JSON.stringify(state)), state);
  assert.equal(S.removeCounter(state, apple), state);
  assert.equal(S.removeCounter(state, 'missing'), state);
});

test('删除任务保留历史引用；默认任务也可删除且不能继续添加', () => {
  let state = S.create(withDefault(), '默认类型');
  state = S.createTask(state, '专项');
  const taskId = state.tasks[1].id;
  state = S.create(state, '专项类型', undefined, taskId);
  state = S.change(state, state.counters[1].id, 1);
  state = S.savePage(state, taskId);
  const priorHistory = state.history, priorSnapshots = state.snapshots;
  state = S.removeTask(state, taskId, '2025-08-01T00:00:00.000Z');
  assert.equal(state.tasks[1].deletedAt, '2025-08-01T00:00:00.000Z');
  assert.equal(state.counters[0].deletedAt, undefined);
  assert.equal(state.counters[1].deletedAt, '2025-08-01T00:00:00.000Z');
  assert.deepEqual(state.history, priorHistory);
  assert.deepEqual(state.snapshots, priorSnapshots);
  assert.throws(() => S.create(state, '新类型', undefined, taskId));
  assert.throws(() => S.savePage(state, taskId));
  assert.equal(S.removeTask(state, taskId), state);
  assert.equal(S.removeTask(state, 'missing'), state);
  state = S.removeTask(state, 'default', '2025-08-02T00:00:00.000Z');
  assert.equal(state.tasks.some(t => t.id === 'default'), false);
  assert.equal(state.counters.some(c => c.taskId === 'default'), false);
  assert.throws(() => S.create(state, '已删除任务', undefined, 'default'));
  assert.equal(S.removeTask(state, 'default'), state);
  assert.throws(() => S.create(state, '没有活跃任务'));
  assert.deepEqual(S.parse(JSON.stringify(state)), state);
});

test('删除单条快照或历史只影响目标记录，且未知 ID 幂等', () => {
  let state = S.create(withDefault(), 'A');
  state = S.change(state, state.counters[0].id, 1);
  state = S.change(state, state.counters[0].id, 1);
  state = S.savePage(state, 'default');
  state = S.savePage(state, 'default');
  const removedSnapshot = state.snapshots[0].id;
  const removedHistory = state.history[0].id;
  const withoutSnapshot = S.removeSnapshot(state, removedSnapshot);
  assert.deepEqual(withoutSnapshot.snapshots, [state.snapshots[1]]);
  assert.deepEqual(withoutSnapshot.history, state.history);
  const withoutHistory = S.removeHistory(withoutSnapshot, removedHistory);
  assert.deepEqual(withoutHistory.history, [state.history[1]]);
  assert.deepEqual(withoutHistory.snapshots, [state.snapshots[1]]);
  assert.equal(S.removeSnapshot(withoutHistory, removedSnapshot), withoutHistory);
  assert.equal(S.removeHistory(withoutHistory, removedHistory), withoutHistory);
  assert.deepEqual(S.parse(JSON.stringify(withoutHistory)), withoutHistory);
});

test('v2 默认任务删除标记无效，v3 删除标记与引用可保留', () => {
  const state = { ...S.create(withDefault(), 'A'), version: 2 };
  const invalid = mutate => {
    const copy = JSON.parse(JSON.stringify(state));
    mutate(copy);
    assert.throws(() => S.parse(JSON.stringify(copy)));
  };
  invalid(d => { d.tasks[0].deletedAt = '2025-01-01T00:00:00.000Z'; });
  invalid(d => { d.tasks[0].deletedAt = null; });
  invalid(d => { d.counters[0].deletedAt = 'invalid'; });
  assert.throws(() => S.removeCounter(state, state.counters[0].id, 'invalid'));
});
