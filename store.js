(function (root) {
  'use strict';
  const KEY = 'diandian-counter-v1';
  const DEFAULT_TASK = { id: 'default', name: '默认任务', createdAt: '1970-01-01T00:00:00.000Z' };

  function empty() { return { version: 3, tasks: [], counters: [], history: [], snapshots: [] }; }
  function validCount(n) { return Number.isSafeInteger(n) && n >= 0; }
  function validId(id) { return typeof id === 'string' && !!id.trim(); }
  function validName(name) { return typeof name === 'string' && !!name.trim(); }
  function validDate(value) { return typeof value === 'string' && !!value.trim() && Number.isFinite(Date.parse(value)); }
  function fail(message) { throw new Error(message); }
  function uniqueIds(items, message) {
    const ids = new Set();
    for (const item of items) {
      if (!item || !validId(item.id) || ids.has(item.id)) fail(message);
      ids.add(item.id);
    }
  }
  function validateLegacy(data) {
    if (!Array.isArray(data.counters) || !Array.isArray(data.history)) fail('保存的数据格式不正确');
    uniqueIds(data.counters, '计数器数据不完整');
    for (const c of data.counters) {
      if (!validName(c.name) || !validCount(c.value) || !validDate(c.createdAt)) fail('计数器数据不完整');
    }
    for (const h of data.history) {
      if (!h || !validId(h.id) || !validId(h.counterId) || !validName(h.name) ||
        !validCount(h.before) || !validCount(h.after) || ![-1, 1].includes(h.delta) ||
        h.after - h.before !== h.delta || !validDate(h.at)) fail('历史记录数据不完整');
    }
  }
  function validateState(data, requireDefault = false) {
    if (!Array.isArray(data.tasks) || !Array.isArray(data.counters) ||
      !Array.isArray(data.history) || !Array.isArray(data.snapshots)) fail('保存的数据格式不正确');
    uniqueIds(data.tasks, '任务数据不完整');
    const tasks = new Map();
    for (const task of data.tasks) {
      if (!validName(task.name) || task.name.length > 40 || !validDate(task.createdAt) ||
        (Object.prototype.hasOwnProperty.call(task, 'deletedAt') && !validDate(task.deletedAt))) fail('任务数据不完整');
      tasks.set(task.id, task);
    }
    if (requireDefault && (!tasks.has('default') || tasks.get('default').deletedAt !== undefined)) fail('缺少默认任务');
    uniqueIds(data.counters, '计数器数据不完整');
    const counters = new Map();
    for (const counter of data.counters) {
      if (!validName(counter.name) || !validCount(counter.value) || !validDate(counter.createdAt) ||
        (Object.prototype.hasOwnProperty.call(counter, 'deletedAt') && !validDate(counter.deletedAt)) ||
        !validId(counter.taskId) || !tasks.has(counter.taskId)) fail('计数器数据不完整');
      counters.set(counter.id, counter);
    }
    uniqueIds(data.history, '历史记录数据不完整');
    for (const h of data.history) {
      if (!validId(h.counterId) || !counters.has(h.counterId) || !validName(h.name) ||
        !validCount(h.before) || !validCount(h.after) || ![-1, 1].includes(h.delta) ||
        h.after - h.before !== h.delta || !validDate(h.at)) fail('历史记录数据不完整');
      const hasTaskId = Object.prototype.hasOwnProperty.call(h, 'taskId');
      const hasTaskName = Object.prototype.hasOwnProperty.call(h, 'taskName');
      if (hasTaskId !== hasTaskName || (hasTaskId &&
        (!validId(h.taskId) || !tasks.has(h.taskId) || !validName(h.taskName) ||
          counters.get(h.counterId).taskId !== h.taskId))) fail('历史记录数据不完整');
    }
    uniqueIds(data.snapshots, '快照数据不完整');
    for (const snapshot of data.snapshots) {
      if (!validId(snapshot.taskId) || !tasks.has(snapshot.taskId) ||
        !validName(snapshot.taskName) || !validDate(snapshot.at) ||
        !Array.isArray(snapshot.items) || snapshot.items.length === 0) fail('快照数据不完整');
      uniqueIds(snapshot.items, '快照数据不完整');
      for (const item of snapshot.items) {
        if (!validName(item.name) || !validCount(item.value) || !counters.has(item.id) ||
          counters.get(item.id).taskId !== snapshot.taskId) fail('快照数据不完整');
      }
    }
  }
  function parse(raw) {
    if (raw === null) return empty();
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') fail('保存的数据格式不正确');
    if (data.version === 1) {
      validateLegacy(data);
      const hasData = data.counters.length > 0 || data.history.length > 0;
      return { ...data, version: 3, tasks: hasData ? [{ ...DEFAULT_TASK }] : [],
        counters: data.counters.map(c => ({ ...c, taskId: 'default' })), snapshots: [] };
    }
    if (data.version !== 2 && data.version !== 3) fail('保存的数据格式不正确');
    validateState(data, data.version === 2);
    if (data.version === 3) return data;
    const defaultHasReferences = data.counters.some(c => c.taskId === 'default') ||
      data.history.some(h => h.taskId === 'default') ||
      data.snapshots.some(s => s.taskId === 'default');
    return { ...data, version: 3,
      tasks: defaultHasReferences ? data.tasks : data.tasks.filter(t => t.id !== 'default') };
  }
  function uid() {
    return (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID() :
      Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  function cleanName(name, emptyMessage) {
    if (typeof name !== 'string') fail(emptyMessage);
    const cleaned = name.trim();
    if (!cleaned) fail(emptyMessage);
    if (cleaned.length > 40) fail('名称最多 40 个字符');
    return cleaned;
  }
  function taskFor(data, taskId) {
    const task = taskId === undefined
      ? data.tasks.find(t => t.deletedAt === undefined)
      : data.tasks.find(t => t.id === taskId);
    if (!task || task.deletedAt !== undefined) fail('找不到这个任务');
    return task;
  }
  function create(data, name, at = new Date().toISOString(), taskId) {
    const task = taskFor(data, taskId);
    const counter = { id: uid(), taskId: task.id, name: cleanName(name, '请输入计数器名称'), value: 0, createdAt: at };
    return { ...data, counters: [...data.counters, counter] };
  }
  function createTask(data, name, at = new Date().toISOString()) {
    const task = { id: uid(), name: cleanName(name, '请输入任务名称'), createdAt: at };
    return { ...data, tasks: [...data.tasks, task] };
  }
  function change(data, id, delta, at = new Date().toISOString()) {
    if (delta !== 1 && delta !== -1) fail('只能加一或减一');
    const counter = data.counters.find(c => c.id === id);
    if (!counter || counter.deletedAt !== undefined) fail('找不到这个计数器');
    const after = counter.value + delta;
    if (after < 0) return data;
    if (!validCount(after)) fail('数量已达到支持的上限');
    const task = taskFor(data, counter.taskId);
    const record = { id: uid(), counterId: id, name: counter.name, taskId: task.id,
      taskName: task.name, delta, before: counter.value, after, at };
    return { ...data, counters: data.counters.map(c => c.id === id ? { ...c, value: after } : c),
      history: [record, ...data.history] };
  }
  function savePage(data, taskId, at = new Date().toISOString()) {
    const task = taskFor(data, taskId);
    const items = data.counters.filter(c => c.taskId === taskId && c.deletedAt === undefined)
      .map(c => ({ id: c.id, name: c.name, value: c.value }));
    if (!items.length) fail('当前任务没有计数器');
    const snapshot = { id: uid(), taskId, taskName: task.name, at, items };
    return { ...data, snapshots: [snapshot, ...data.snapshots] };
  }
  function removeCounter(data, id, at = new Date().toISOString()) {
    const counter = data.counters.find(c => c.id === id && c.deletedAt === undefined);
    if (!counter) return data;
    if (!validDate(at)) fail('删除时间不正确');
    return { ...data, counters: data.counters.map(c => c.id === id ? { ...c, deletedAt: at } : c) };
  }
  function removeTask(data, id, at = new Date().toISOString()) {
    const task = data.tasks.find(t => t.id === id && t.deletedAt === undefined);
    if (!task) return data;
    if (!validDate(at)) fail('删除时间不正确');
    const counterIds = new Set(data.counters.filter(c => c.taskId === id).map(c => c.id));
    const referenced = data.history.some(h => counterIds.has(h.counterId)) || data.snapshots.some(s => s.taskId === id);
    if (!referenced) return { ...data, tasks: data.tasks.filter(t => t.id !== id),
      counters: data.counters.filter(c => c.taskId !== id) };
    return { ...data,
      tasks: data.tasks.map(t => t.id === id ? { ...t, deletedAt: at } : t),
      counters: data.counters.map(c => c.taskId === id && c.deletedAt === undefined ? { ...c, deletedAt: at } : c) };
  }
  function removeSnapshot(data, id) {
    if (!data.snapshots.some(s => s.id === id)) return data;
    return { ...data, snapshots: data.snapshots.filter(s => s.id !== id) };
  }
  function removeHistory(data, id) {
    if (!data.history.some(h => h.id === id)) return data;
    return { ...data, history: data.history.filter(h => h.id !== id) };
  }
  const api = { KEY, empty, parse, create, change, createTask, savePage,
    removeCounter, removeTask, removeSnapshot, removeHistory };
  root.CounterStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
