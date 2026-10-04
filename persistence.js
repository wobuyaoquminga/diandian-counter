(function (root) {
  'use strict';

  const DATABASE_NAME = 'diandian-counter';
  const DATABASE_VERSION = 1;
  const STORE_NAME = 'state';

  function create(storeAPI, legacyStorage) {
    if (!storeAPI || typeof storeAPI.KEY !== 'string' ||
      typeof storeAPI.parse !== 'function') throw new TypeError('缺少计数器存储接口');

    let db = null;
    let opening = null;
    let loading = null;
    let loaded = false;
    let closed = false;
    let fatalError = null;

    function unavailable() {
      if (closed) return new Error('数据库已关闭，请重新打开页面');
      return fatalError || new Error('数据尚未加载，无法保存');
    }

    function fail(error) {
      fatalError = error instanceof Error ? error : new Error(String(error));
      loaded = false;
      if (db) { db.close(); db = null; }
      return fatalError;
    }

    function openDatabase() {
      if (closed || fatalError) return Promise.reject(unavailable());
      if (db) return Promise.resolve(db);
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        if (!root.indexedDB) {
          reject(new Error('此浏览器不支持 IndexedDB，无法安全保存数据'));
          return;
        }
        let request;
        try { request = root.indexedDB.open(DATABASE_NAME, DATABASE_VERSION); }
        catch (error) { reject(error); return; }
        let settled = false;
        function rejectOnce(error) {
          if (settled) return;
          settled = true;
          reject(error);
        }
        request.onupgradeneeded = () => {
          try {
            if (!request.result.objectStoreNames.contains(STORE_NAME))
              request.result.createObjectStore(STORE_NAME);
          } catch (error) {
            rejectOnce(error);
            request.transaction.abort();
          }
        };
        request.onblocked = () => rejectOnce(new Error('数据库升级被其他页面阻止，请关闭其他页面后重试'));
        request.onerror = () => rejectOnce(request.error || new Error('无法打开本地数据库'));
        request.onsuccess = () => {
          const opened = request.result;
          if (settled || closed || fatalError) {
            opened.close();
            if (!settled) rejectOnce(unavailable());
            return;
          }
          opened.onversionchange = () => fail(new Error('数据库版本已变化，请刷新页面后重试'));
          opened.onclose = () => {
            if (db === opened && !closed && !fatalError)
              fail(new Error('本地数据库意外关闭，请刷新页面后重试'));
          };
          db = opened;
          settled = true;
          resolve(opened);
        };
      });
      return opening;
    }

    function run(mode, work) {
      if (!db || closed || fatalError || !loaded) return Promise.reject(unavailable());
      return new Promise((resolve, reject) => {
        let tx;
        try { tx = transaction(db, mode); }
        catch (error) { reject(error); return; }
        let result;
        let cause = null;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(cause || tx.error || new Error('数据库事务已中止'));
        tx.onerror = () => { /* onabort supplies the final transaction error. */ };
        try { work(tx.objectStore(STORE_NAME), value => { result = value; }, error => { cause = error; tx.abort(); }); }
        catch (error) {
          cause = error;
          try { tx.abort(); } catch (_) { reject(error); }
        }
      });
    }

    function transaction(connection, mode) {
      if (mode === 'readwrite') {
        try { return connection.transaction(STORE_NAME, mode, { durability: 'strict' }); }
        catch (error) { if (error.name !== 'TypeError') throw error; }
      }
      return connection.transaction(STORE_NAME, mode);
    }

    function load() {
      if (closed || fatalError) return Promise.reject(unavailable());
      if (loaded) return read();
      if (loading) return loading;
      loading = openDatabase().then(opened => new Promise((resolve, reject) => {
        let tx;
        try { tx = transaction(opened, 'readwrite'); }
        catch (error) { reject(error); return; }
        let state;
        let cause = null;
        tx.oncomplete = () => {
          if (closed || fatalError) { reject(unavailable()); return; }
          loaded = true;
          resolve(state);
        };
        tx.onabort = () => reject(cause || tx.error || new Error('初始化数据库失败'));
        tx.onerror = () => { /* onabort supplies the final transaction error. */ };
        const abort = error => {
          cause = error;
          try { tx.abort(); } catch (_) { reject(error); }
        };
        let request;
        try { request = tx.objectStore(STORE_NAME).get(storeAPI.KEY); }
        catch (error) { abort(error); return; }
        request.onsuccess = () => {
          try {
            if (request.result !== undefined) {
              // Validation is done once on load, outside the hot commit path.
              state = storeAPI.parse(JSON.stringify(request.result));
              if (state.version !== request.result.version) tx.objectStore(STORE_NAME).put(state, storeAPI.KEY);
              return;
            }
            const raw = legacyStorage ? legacyStorage.getItem(storeAPI.KEY) : null;
            state = storeAPI.parse(raw);
            tx.objectStore(STORE_NAME).put(state, storeAPI.KEY);
          } catch (error) { abort(error); }
        };
      })).catch(error => { throw fail(error); });
      return loading;
    }

    function read() {
      return run('readonly', (store, set, abort) => {
        const request = store.get(storeAPI.KEY);
        request.onsuccess = () => {
          if (request.result === undefined) {
            abort(new Error('本地数据不存在，请刷新页面'));
            return;
          }
          set(request.result);
        };
      });
    }

    function commit(transform) {
      if (typeof transform !== 'function') return Promise.reject(new TypeError('提交操作必须是函数'));
      return run('readwrite', (store, set, abort) => {
        const request = store.get(storeAPI.KEY);
        request.onsuccess = () => {
          try {
            if (request.result === undefined) throw new Error('本地数据不存在，请刷新页面');
            const next = transform(request.result);
            if (!next || typeof next !== 'object' || typeof next.then === 'function')
              throw new TypeError('提交操作必须同步返回数据对象');
            store.put(next, storeAPI.KEY);
            set(next);
          } catch (error) { abort(error); }
        };
      });
    }

    function close() {
      closed = true;
      loaded = false;
      if (db) { db.close(); db = null; }
    }

    return { load, commit, read, close };
  }

  const api = { create };
  root.CounterPersistence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
