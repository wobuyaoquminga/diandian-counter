'use strict';
const S = CounterStore;
const $ = id => document.getElementById(id);
let state = S.empty(), storageReady = false, selectedTaskId = '', visibleHistory = 60, historyMode = 'pages', createMode = 'type', createSession = 0, toastTimer;
const numberFormat = new Intl.NumberFormat('zh-CN');
const timeFormat = new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const number = n => numberFormat.format(n);
const total = items => number(items.reduce((sum, c) => sum + BigInt(c.value), 0n));
const dateText = at => timeFormat.format(new Date(at));
let repository, changeChannel, syncTimer, writeQueue = Promise.resolve();
let renderedTasks = null;
const counterRows = new Map();
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
function storageError(message) { storageReady = false; $('storage-status').textContent = '本地存储不可用'; setWriteControls(false); toast(message); }
function setWriteControls(enabled) { ['new-task', 'new-counter', 'empty-create', 'save-page', 'create-submit', 'delete-task'].forEach(id => { $(id).disabled = !enabled; }); }
try { selectedTaskId = localStorage.getItem(S.KEY + '-active-task') || ''; } catch (_) { /* A missing page preference does not invalidate counts. */ }
async function persist(transform) {
  if (!storageReady) { toast('无法保存数据，请检查本地存储是否可用后重新打开。'); return false; }
  try {
    state = await repository.commit(transform);
  } catch (e) { toast(e.name === 'QuotaExceededError' ? '本地存储空间不足，本次操作未保存。请先导出数据。' : '操作未保存：' + e.message); return false; }
  if (changeChannel) changeChannel.postMessage('changed');
  render(); return true;
}
function commit(transform) {
  // IndexedDB serializes read/modify/write transactions across all tabs.
  const job = writeQueue.then(() => persist(transform));
  writeQueue = job.catch(() => { toast('页面刷新异常，请重新打开检查。'); return false; });
  return writeQueue;
}
function el(tag, className, content) { const node = document.createElement(tag); if (className) node.className = className; if (content !== undefined) node.textContent = content; return node; }
function activeTasks() { return state.tasks.filter(t => !t.deletedAt); }
function currentTask() { return state.tasks.find(t => t.id === selectedTaskId && !t.deletedAt) || activeTasks()[0]; }
function renderCounters() {
  const task = currentTask(), hasTask = !!task;
  $('task-empty').hidden = hasTask; $('task-content').hidden = !hasTask;
  $('nav-count').textContent = activeTasks().length;
  ['new-counter', 'empty-create', 'save-page', 'delete-task'].forEach(id => { $(id).disabled = !storageReady || !hasTask; });
  if (!task) {
    selectedTaskId = ''; renderedTasks = null; $('task-select').replaceChildren();
    $('task-title').textContent = ''; $('page-save-status').textContent = ''; $('task-page-position').textContent = '';
    ['counter-total', 'value-total', 'today-total', 'section-count'].forEach(id => { $(id).textContent = '0'; });
    $('counter-grid').replaceChildren(); counterRows.clear();
    try { localStorage.removeItem(S.KEY + '-active-task'); } catch (_) {}
    return;
  }
  selectedTaskId = task.id;
  try { if (storageReady && localStorage.getItem(S.KEY + '-active-task') !== task.id) localStorage.setItem(S.KEY + '-active-task', task.id); } catch (_) { /* Page preference must not interrupt counting. */ }
  const tasks = activeTasks();
  const counters = state.counters.filter(c => c.taskId === task.id && !c.deletedAt), snapshots = state.snapshots.filter(p => p.taskId === task.id);
  $('nav-count').textContent = tasks.length; $('task-title').textContent = task.name;
  $('delete-task').textContent = '删除任务';
  $('delete-task').disabled = !storageReady;
  $('task-page-position').textContent = (tasks.findIndex(t => t.id === task.id) + 1) + ' / ' + tasks.length;
  const select = $('task-select');
  const taskSignature = JSON.stringify(tasks.map(t => [t.id, t.name]));
  if (renderedTasks !== taskSignature) {
    select.replaceChildren();
    tasks.forEach(t => { const option = el('option', '', t.name); option.value = t.id; select.append(option); }); renderedTasks = taskSignature;
  }
  select.value = task.id;
  $('counter-total').textContent = number(counters.length); $('value-total').textContent = total(counters); $('today-total').textContent = number(snapshots.length); $('section-count').textContent = counters.length;
  $('counter-empty').hidden = counters.length > 0; $('save-page').disabled = !storageReady || counters.length === 0;
  const latest = snapshots[0];
  const matches = latest && latest.items.length === counters.length && latest.items.every((item, i) => item.id === counters[i].id && item.name === counters[i].name && item.value === counters[i].value);
  $('page-save-status').textContent = latest ? (matches ? '已保存 · ' : '有变化 · 上次保存 ') + dateText(latest.at) : '尚未保存';
  const grid = $('counter-grid');
  const activeIds = new Set(counters.map(c => c.id));
  for (const [id, cached] of counterRows) { if (!activeIds.has(id)) { cached.row.remove(); counterRows.delete(id); } }
  counters.forEach((counter, i) => {
    let cached = counterRows.get(counter.id);
    if (cached) {
      cached.index.textContent = String(i + 1).padStart(2, '0');
      if (cached.name.textContent !== counter.name) {
        cached.name.textContent = counter.name;
        cached.name.setAttribute('aria-label', counter.name + '，加一');
        cached.output.setAttribute('aria-label', counter.name + '的数量');
        cached.minus.setAttribute('aria-label', counter.name + '减一');
        cached.plus.setAttribute('aria-label', counter.name + '加一');
      }
      if (cached.value !== counter.value) {
        cached.output.textContent = number(counter.value);
        cached.output.classList.toggle('long-value', counter.value >= 1000000);
        cached.name.disabled = cached.plus.disabled = counter.value === Number.MAX_SAFE_INTEGER;
        cached.minus.disabled = counter.value === 0;
        cached.value = counter.value;
      }
      return;
    }
    const row = el('article', 'counter-card'), index = el('span', 'row-index', String(i + 1).padStart(2, '0'));
    index.setAttribute('aria-hidden', 'true');
    const name = el('button', 'counter-name', counter.name);
    name.type = 'button'; name.title = '点击名称，数量加一'; name.setAttribute('aria-label', counter.name + '，加一'); name.dataset.counter = counter.id; name.dataset.action = 'name';
    name.disabled = counter.value === Number.MAX_SAFE_INTEGER;
    name.addEventListener('click', () => commit(data => S.change(data, counter.id, 1)));
    const controls = el('div', 'card-controls'), value = el('output', 'counter-value', number(counter.value));
    value.setAttribute('aria-label', counter.name + '的数量');
    if (counter.value >= 1000000) value.classList.add('long-value');
    [-1, 1].forEach(delta => {
      const button = el('button', 'step-button' + (delta > 0 ? ' plus' : ''), delta > 0 ? '+' : '−');
      button.type = 'button'; button.dataset.counter = counter.id; button.dataset.action = String(delta); button.setAttribute('aria-label', counter.name + (delta > 0 ? '加一' : '减一'));
      button.disabled = delta < 0 ? counter.value === 0 : counter.value === Number.MAX_SAFE_INTEGER;
      button.addEventListener('click', () => commit(data => S.change(data, counter.id, delta)));
      if (delta > 0) controls.append(value); controls.append(button);
    });
    const remove = el('button', 'delete-type icon-button danger', '×'); remove.type = 'button'; remove.title = '删除此类型'; remove.setAttribute('aria-label', '删除类型' + counter.name);
    remove.addEventListener('click', () => askDelete('删除类型', '删除“' + counter.name + '”及当前数量？已保存的历史页面和加减记录会保留。', data => S.removeCounter(data, counter.id)));
    row.append(index, name, controls, remove); grid.append(row);
    counterRows.set(counter.id, { row, index, output: value, name, minus: controls.querySelector('button'), plus: controls.querySelector('.plus'), value: counter.value });
  });
}
function renderSnapshot(snapshot) {
  const card = el('article', 'snapshot-card'), heading = el('div', 'snapshot-heading'), info = el('div', 'history-info');
  info.append(el('strong', '', snapshot.taskName), el('small', '', dateText(snapshot.at) + ' · ' + snapshot.items.length + ' 种类型 · 总数量 ' + total(snapshot.items)));
  const button = el('button', 'secondary', '导出本页'); button.type = 'button'; button.setAttribute('aria-label', '导出' + snapshot.taskName + '的保存页面');
  button.addEventListener('click', () => download({ app: '点点计数', page: snapshot }, '点点计数-页面-' + snapshot.at.replace(/[:.]/g, '-') + '.json'));
  const remove = el('button', 'secondary danger', '删除'); remove.type = 'button'; remove.setAttribute('aria-label', '删除' + snapshot.taskName + '的保存页面');
  remove.addEventListener('click', () => askDelete('删除历史页面', '删除“' + snapshot.taskName + '”在 ' + dateText(snapshot.at) + ' 保存的页面？当前计数和其他记录不会变化。', data => S.removeSnapshot(data, snapshot.id)));
  const actions = el('div', 'snapshot-actions'); actions.append(button, remove); heading.append(info, actions);
  const details = el('details', 'snapshot-details'); details.open = snapshot.items.length <= 12; details.append(el('summary', '', '本页类型与数量（' + snapshot.items.length + '）'));
  let loaded = 0;
  const more = el('button', 'secondary load-more', '显示更多类型'); more.type = 'button';
  function appendItems() {
    more.remove();
    const end = Math.min(loaded + 100, snapshot.items.length);
    const fragment = document.createDocumentFragment();
    for (; loaded < end; loaded++) { const item = snapshot.items[loaded], row = el('div', 'snapshot-item'); row.append(el('span', '', item.name), el('strong', '', number(item.value))); fragment.append(row); }
    details.append(fragment);
    if (loaded < snapshot.items.length) details.append(more);
  }
  more.addEventListener('click', appendItems);
  if (details.open) appendItems();
  details.addEventListener('toggle', () => { if (details.open && loaded === 0) appendItems(); });
  card.append(heading, details); return card;
}
function renderHistory() {
  if (location.hash !== '#history') return;
  const query = $('history-search').value.trim().toLocaleLowerCase(), source = historyMode === 'pages' ? state.snapshots : state.history;
  const records = query ? source.filter(h => ((h.taskName || '') + ' ' + (h.name || '') + ' ' + (h.items || []).map(item => item.name).join(' ')).toLocaleLowerCase().includes(query)) : source;
  ['saved-pages-tab', 'changes-tab'].forEach((id, i) => { const active = historyMode === (i ? 'changes' : 'pages'); $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', String(active)); });
  $('history-heading-text').textContent = historyMode === 'pages' ? '保存记录' : '加减明细'; $('history-total').textContent = number(records.length);
  $('export-history').disabled = !state.counters.length && !state.history.length && !state.snapshots.length;
  $('history-empty').hidden = records.length > 0;
  $('history-empty').querySelector('h2').textContent = query ? '无匹配记录' : '暂无记录';
  const list = $('history-list'); list.replaceChildren();
  records.slice(0, visibleHistory).forEach(h => {
    if (historyMode === 'pages') { list.append(renderSnapshot(h)); return; }
    const row = el('div', 'history-row'), info = el('div', 'history-info');
    info.append(el('strong', '', h.name), el('small', '', (h.taskName || '旧数据') + ' · ' + dateText(h.at)));
    const remove = el('button', 'icon-button danger', '×'); remove.type = 'button'; remove.setAttribute('aria-label', '删除' + h.name + '的加减记录');
    remove.addEventListener('click', () => askDelete('删除加减记录', '删除“' + h.name + '”在 ' + dateText(h.at) + ' 的这条加减记录？当前计数不会变化。', data => S.removeHistory(data, h.id)));
    row.append(info, el('span', 'history-change', number(h.before) + ' → ' + number(h.after)), el('span', 'delta' + (h.delta < 0 ? ' negative' : ''), h.delta > 0 ? '+1' : '−1'), remove); list.append(row);
  });
  $('load-more').hidden = records.length <= visibleHistory;
}
function render() { if (location.hash === '#history') renderHistory(); else { renderCounters(); $('breadcrumb').textContent = (currentTask()?.name || '计数任务'); } }
function navigate() {
  const history = location.hash === '#history';
  if (location.hash.startsWith('#task/')) { try { const id = decodeURIComponent(location.hash.slice(6)); if (activeTasks().some(t => t.id === id)) selectedTaskId = id; } catch (_) {} }
  $('counters-page').hidden = history; $('history-page').hidden = !history; render(); $('breadcrumb').textContent = history ? '历史记录' : (currentTask()?.name || '计数任务');
  document.querySelectorAll('[data-page]').forEach(a => { const active = a.dataset.page === (history ? 'history' : 'counters'); a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
function openCreate(mode = 'type') {
  if (!storageReady) { toast('本地数据尚未就绪，暂时无法添加。'); return; }
  if (mode === 'type' && !currentTask()) return;
  createSession++;
  createMode = mode; $('create-form').reset(); $('form-error').textContent = ''; const isTask = mode === 'task';
  $('create-title').textContent = isTask ? '新建任务' : '添加类型';
  $('name-label').textContent = isTask ? '任务名称' : '类型名称'; $('counter-name').placeholder = isTask ? '例如：水果盘点' : '例如：苹果'; $('create-submit').textContent = isTask ? '创建' : '添加';
  $('create-dialog').showModal(); $('counter-name').focus();
}
$('new-task').addEventListener('click', () => openCreate('task')); $('new-counter').addEventListener('click', () => openCreate()); $('empty-create').addEventListener('click', () => openCreate());
$('task-select').addEventListener('change', event => { selectedTaskId = event.target.value; location.hash = 'task/' + encodeURIComponent(selectedTaskId); render(); });
$('save-page').addEventListener('click', async () => { const id = selectedTaskId; if (await commit(data => S.savePage(data, id))) toast('已保存'); });
$('delete-task').addEventListener('click', () => { const task = currentTask(); if (!task) return; askDelete('删除任务', '删除“' + task.name + '”及其类型和数量？历史记录保留。', data => S.removeTask(data, task.id)); });
let pendingDeletion;
function askDelete(title, description, transform) {
  if (!storageReady || $('delete-confirm').disabled) return;
  pendingDeletion = transform;
  $('delete-title').textContent = title; $('delete-description').textContent = description;
  $('delete-dialog').showModal();
}
$('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
$('delete-confirm').addEventListener('click', async () => {
  if (!pendingDeletion || $('delete-confirm').disabled) return;
  const transform = pendingDeletion; $('delete-confirm').disabled = true;
  const success = await commit(transform);
  $('delete-confirm').disabled = false;
  if (success) { $('delete-dialog').close(); pendingDeletion = null; toast('删除已完成'); }
});
['close-dialog', 'cancel-dialog'].forEach(id => $(id).addEventListener('click', () => $('create-dialog').close()));
$('create-form').addEventListener('submit', async event => {
  event.preventDefault(); const name = $('counter-name').value.trim();
  if (!name) { $('form-error').textContent = '请输入' + (createMode === 'task' ? '任务名称' : '类型名称'); $('counter-name').focus(); return; }
  if ($('create-submit').disabled) return;
  const mode = createMode, taskId = selectedTaskId, session = createSession;
  let newId;
  $('create-submit').disabled = true;
  const success = await commit(data => { if (mode === 'task') { const next = S.createTask(data, name); newId = next.tasks[next.tasks.length - 1].id; return next; } return S.create(data, name, undefined, taskId); });
  $('create-submit').disabled = !storageReady;
  if (success) { if (session === createSession) $('create-dialog').close(); if (newId) { selectedTaskId = newId; location.hash = 'task/' + encodeURIComponent(newId); render(); } toast(mode === 'task' ? '任务已创建' : '类型已添加'); }
});
['saved-pages-tab', 'changes-tab'].forEach((id, i) => $(id).addEventListener('click', () => { historyMode = i ? 'changes' : 'pages'; visibleHistory = 60; renderHistory(); }));
let searchTimer;
$('history-search').addEventListener('input', () => { visibleHistory = 60; clearTimeout(searchTimer); searchTimer = setTimeout(renderHistory, 120); }); $('load-more').addEventListener('click', () => { visibleHistory += 60; renderHistory(); });
function download(data, filename) {
  try {
  const json = JSON.stringify(data, null, 2);
  if (window.DiandianAndroid && typeof window.DiandianAndroid.exportJson === 'function') {
    window.DiandianAndroid.exportJson(json, filename);
    return;
  }
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('数据已导出');
  } catch (e) { toast('无法导出记录，请稍后重试。'); }
}
$('export-history').addEventListener('click', async () => { if (await refreshState()) download({ app: '点点计数', exportedAt: new Date().toISOString(), ...state }, '点点计数-' + new Date().toLocaleDateString('sv-SE') + '.json'); });
window.addEventListener('hashchange', navigate);
function refreshState() {
  const refresh = writeQueue.then(async () => { if (!storageReady) return false; state = await repository.read(); render(); return true; });
  writeQueue = refresh.catch(() => { storageError('无法读取本地记录，请重新打开检查。'); return false; });
  return writeQueue;
}
window.addEventListener('focus', () => { if (storageReady) refreshState(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && storageReady) refreshState(); });
function updateDate() { $('today').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }); }
async function initialize() {
  setWriteControls(false);
  updateDate();
  try {
    repository = CounterPersistence.create(S, localStorage);
    state = await repository.load(); storageReady = true;
    try { changeChannel = new BroadcastChannel('diandian-counter-updates'); changeChannel.onmessage = () => { clearTimeout(syncTimer); syncTimer = setTimeout(refreshState, 60); }; } catch (_) { /* Focus also refreshes browsers without BroadcastChannel. */ }
    setWriteControls(true); $('loading-status').hidden = true; navigate();
  } catch (e) { $('loading-status').textContent = '本地记录暂时无法读取，原数据未覆盖。请关闭其他窗口后重新打开。'; storageError('数据读取失败：' + e.message); }
}
initialize(); setInterval(updateDate, 60000);
