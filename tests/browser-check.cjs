// Run with Node.js and Playwright installed. PLAYWRIGHT_MODULE may specify its path.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const pw = process.env.PLAYWRIGHT_MODULE || path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
const { chromium } = require(pw);
const S = require('../store.js');
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
const server = http.createServer((req, res) => {
  const name = req.url.split('?')[0];
  if (!['/index.html', '/app.js', '/store.js', '/persistence.js', '/styles.css'].includes(name)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type':mime[path.extname(name)] + ';charset=utf-8' }); res.end(fs.readFileSync(path.join(root, name)));
});
const waitValue = (page, value) => page.waitForFunction(expected => document.querySelector('output')?.textContent === expected, String(value));
function fixture() {
  const state = { ...S.empty(), tasks: [{ id:'default', name:'测试任务', createdAt:'2026-10-04T00:00:00.000Z' }] };
  const at = '2026-10-04T00:00:00.000Z';
  for (let i=0;i<80;i++) state.counters.push({ id:'c'+i, taskId:'default', name:'类型'+i, value:0, createdAt:at });
  for (let i=0;i<6000;i++) state.history.push({ id:'h'+i, counterId:'c0', name:'类型0', taskId:'default', taskName:'测试任务', before:i, after:i+1, delta:1, at });
  for (let i=0;i<40;i++) state.snapshots.push({ id:'s'+i, taskId:'default', taskName:'测试任务', at, items:state.counters.map(({id,name,value})=>({id,name,value})) });
  return state;
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/index.html';
  const browser = await chromium.launch({ executablePath:process.env.BROWSER_EXE || process.env.EDGE_EXE || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  try {
    const context = await browser.newContext({viewport:{width:390,height:844}});
    const page = await context.newPage(), errors=[];
    page.on('pageerror', e=>errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(()=>storageReady);
    assert.equal(await page.locator('#task-select option').count(),0,'fresh install has no default task');
    assert.equal(await page.locator('#task-empty').isVisible(),true);
    await page.screenshot({path:path.join(root,'preview-empty.png'),fullPage:true});
    assert.equal(await page.locator('#new-counter').isVisible(),false);
    await page.locator('#new-task').click(); await page.getByLabel('任务名称',{exact:true}).fill('测试任务'); await page.locator('#create-submit').click();
    await page.waitForFunction(()=>document.querySelector('#task-title').textContent==='测试任务');
    await page.locator('#new-counter').click(); await page.getByLabel('类型名称',{exact:true}).fill('苹果'); await page.locator('#create-submit').click();
    await page.waitForFunction(()=>document.querySelectorAll('.counter-card').length===1);
    await page.evaluate(()=>{window.originalRow=document.querySelector('.counter-card'); for(let i=0;i<30;i++) document.querySelector('.counter-name').click();});
    await waitValue(page,30);
    await page.screenshot({path:path.join(root,'preview-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1280,height:900}); await page.screenshot({path:path.join(root,'preview.png'),fullPage:true}); await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>window.originalRow===document.querySelector('.counter-card')),true,'counter DOM survives rapid clicks');
    assert.equal(await page.locator('.history-row').count(),0,'hidden history not rendered');
    await page.locator('#save-page').click();
    await page.waitForFunction(()=>state.snapshots.length===1);
    await page.locator('.plus').click(); await waitValue(page,31);
    await page.getByRole('link',{name:'历史记录'}).click();
    assert.equal(await page.locator('.snapshot-item strong').textContent(),'30','saved snapshot unchanged');
    await page.getByRole('searchbox').fill('missing'); await page.waitForFunction(()=>document.querySelectorAll('.snapshot-card').length===0);
    await page.getByRole('searchbox').fill('苹果'); await page.waitForFunction(()=>document.querySelectorAll('.snapshot-card').length===1);
    const download = page.waitForEvent('download'); await page.getByRole('button',{name:'导出测试任务的保存页面'}).click();
    assert.match((await download).suggestedFilename(),/\.json$/);
    await page.getByRole('searchbox').fill(''); await page.locator('#changes-tab').click();
    assert.equal(await page.locator('.history-row').count(),31);
    await page.getByRole('link',{name:/计数任务/}).click();
    const other=await context.newPage(); await other.goto(url); await other.waitForFunction(()=>storageReady);
    // Simultaneous writes from two tabs must produce 40 increments, never 20.
    await Promise.all([page,other].map(p=>p.evaluate(async()=>{const id=state.counters[0].id; await Promise.all(Array.from({length:20},()=>commit(s=>S.change(s,id,1))));})));
    await waitValue(page,71); await waitValue(other,71);
    const good=await page.evaluate(async()=>JSON.stringify(await repository.read()));
    await page.evaluate(()=>{window.realPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('full','QuotaExceededError');};});
    await page.locator('.plus').click(); await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('空间不足'));
    assert.equal(await page.locator('output').textContent(),'71'); assert.equal(await page.evaluate(async()=>JSON.stringify(await repository.read())),good,'quota failure does not alter persisted state');
    await page.evaluate(()=>{IDBObjectStore.prototype.put=window.realPut;});
    await page.reload(); await waitValue(page,71);
    await other.close();
    await page.locator('#new-task').click(); await page.getByLabel('任务名称',{exact:true}).fill('水果盘点'); await page.locator('#create-submit').click();
    await page.waitForFunction(()=>document.querySelector('#task-title').textContent==='水果盘点');
    assert.equal(await page.locator('.counter-card').count(),0,'new task isolated');
    await page.locator('#new-counter').click(); await page.getByLabel('类型名称',{exact:true}).fill('<img onerror=alert(1)>'); await page.locator('#create-submit').click();
    await page.waitForFunction(()=>document.querySelectorAll('.counter-card').length===1);
    assert.equal(await page.locator('.counter-card img').count(),0);
    assert.equal(await page.locator('.step-button').first().isDisabled(),true);
    await page.reload(); assert.equal(await page.locator('#task-title').textContent(),'水果盘点');
    await page.locator('#new-counter').click(); await page.getByLabel('类型名称',{exact:true}).fill('香蕉'); await page.locator('#create-submit').click();
    await page.waitForFunction(()=>document.querySelectorAll('.counter-card').length===2);
    await page.locator('.plus').first().click(); await waitValue(page,1);
    await page.locator('#save-page').click(); await page.waitForFunction(()=>state.snapshots.length===2);
    await page.locator('.delete-type').first().click(); await page.locator('#delete-cancel').click();
    assert.equal(await page.locator('.counter-card').count(),2,'cancel leaves types intact');
    await page.locator('.delete-type').first().click(); await page.locator('#delete-confirm').click();
    await page.waitForFunction(()=>document.querySelectorAll('.counter-card').length===1);
    assert.equal(await page.locator('.row-index').textContent(),'01');
    assert.equal(await page.locator('.counter-name').textContent(),'香蕉');
    await page.reload(); await page.waitForFunction(()=>storageReady); assert.equal(await page.locator('.counter-card').count(),1,'deleted type stays removed on reload');
    await page.locator('#delete-task').click(); await page.locator('#delete-confirm').click();
    await page.waitForFunction(()=>document.querySelector('#task-title').textContent==='测试任务');
    await waitValue(page,71); assert.equal(await page.locator('#task-select option').count(),1);
    await page.getByRole('link',{name:'历史记录'}).click();
    assert.equal(await page.locator('.snapshot-card').count(),2,'task/type deletion preserves saved pages');
    await page.getByRole('button',{name:'删除水果盘点的保存页面',exact:true}).click(); await page.locator('#delete-confirm').click();
    await page.waitForFunction(()=>document.querySelectorAll('.snapshot-card').length===1);
    await page.locator('#changes-tab').click();
    const before=await page.evaluate(()=>state.history.length);
    await page.locator('.history-row .danger').first().click(); await page.locator('#delete-confirm').click();
    await page.waitForFunction(n=>state.history.length===n,before-1);
    await page.getByRole('link',{name:/计数任务/}).click(); await waitValue(page,71);
    await page.locator('#delete-task').click(); await page.locator('#delete-confirm').click();
    await page.waitForFunction(()=>document.querySelectorAll('.counter-card').length===0);
    await page.reload(); await page.waitForFunction(()=>storageReady);
    assert.equal(await page.locator('#task-select option').count(),0,'last task stays deleted after reload');
    assert.equal(await page.locator('#task-empty').isVisible(),true);
    assert.equal(await page.locator('#task-content').isVisible(),false);
    assert.equal(await page.locator('.counter-card').count(),0);
    await page.locator('#new-task').click(); await page.getByLabel('任务名称',{exact:true}).fill('重新开始'); await page.locator('#create-submit').click();
    await page.waitForFunction(()=>document.querySelector('#task-title').textContent==='重新开始');
    assert.equal(await page.locator('#task-select option').count(),1,'can create again from empty state');
    assert.equal(await page.evaluate(()=>state.snapshots.length),1,'default clear preserves saved history');
    await page.setViewportSize({width:320,height:900}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.getByRole('link',{name:'历史记录'}).click();
    let staleDownloads=0; page.on('download',()=>staleDownloads++);
    await page.evaluate(()=>{repository.read=async()=>{throw new Error('injected read error');};});
    await page.locator('#export-history').click();
    await page.waitForFunction(()=>document.querySelector('#storage-status').textContent==='本地存储不可用');
    assert.equal(staleDownloads,0,'failed refresh must not export stale data');
    assert.deepEqual(errors,[]);
    await context.close();
    const corruptContext=await browser.newContext();
    await corruptContext.addInitScript(()=>localStorage.setItem('diandian-counter-v1','{broken'));
    const corrupt=await corruptContext.newPage(); await corrupt.goto(url);
    await corrupt.waitForFunction(()=>document.querySelector('#storage-status').textContent==='本地存储不可用');
    assert.equal(await corrupt.locator('#new-counter').isDisabled(),true);
    assert.equal(await corrupt.evaluate(()=>localStorage.getItem(CounterStore.KEY)),'{broken','failed migration preserves original data');
    assert.equal(await corrupt.evaluate(()=>commit(s=>S.create(s,'should not save'))),false);
    await corruptContext.close();
    for (const origin of ['file', 'android-https']) {
      const ctx=await browser.newContext();
      const legacy=S.create(S.createTask(S.empty(),'旧任务'),'旧计数'); legacy.counters[0].value=7;
      await ctx.addInitScript(raw=>localStorage.setItem('diandian-counter-v1',raw),JSON.stringify(legacy));
      if (origin==='android-https') await ctx.route('https://appassets.androidplatform.net/**', route=>{
        const asset=new URL(route.request().url()).pathname.slice(1);
        if(!['index.html','app.js','store.js','persistence.js','styles.css'].includes(asset)) return route.abort();
        return route.fulfill({path:path.join(root,asset),contentType:mime[path.extname(asset)]});
      });
      const p=await ctx.newPage();
      await p.goto(origin==='file' ? pathToFileURL(path.join(root,'index.html')).href : 'https://appassets.androidplatform.net/index.html');
      await waitValue(p,7);
      await p.locator('.plus').click(); await waitValue(p,8); await p.reload(); await waitValue(p,8);
      const legacyValue=await p.evaluate(()=>S.parse(localStorage.getItem(S.KEY)).counters[0].value);
      assert.equal(legacyValue,7,'legacy backup unchanged on '+origin);
      await ctx.close();
    }
    console.log('PASS: file and Android HTTPS origins migrate legacy data, retain backup and restore new counts after reload.');
    console.log('PASS: rapid clicks, stable DOM, immutable page history, search/export, multi-tab concurrency, quota rollback, corruption protection, task isolation, XSS text, zero limit, refresh, narrow screen.');

    const data=fixture();
    const timings={};
    for(const variant of ['optimized']) {
      const ctx=await browser.newContext();
      const baseline=path.join(root,'android/.build/baseline-app.js');
      if(variant==='baseline' && !fs.existsSync(baseline)){await ctx.close();continue;}
      if(variant==='baseline') await ctx.route('**/app.js', route=>route.fulfill({path:baseline,contentType:'application/javascript'}));
      await ctx.addInitScript(raw=>localStorage.setItem('diandian-counter-v1',raw),JSON.stringify(data));
      const p=await ctx.newPage(); await p.goto(url); await p.waitForFunction(()=>storageReady);
      timings[variant]=await p.evaluate(async()=>{const id=state.counters[0].id;const start=performance.now();for(let i=0;i<20;i++)await commit(s=>S.change(s,id,1));return Math.round(performance.now()-start);});
      await waitValue(p,20);
      if(variant==='optimized') {
        assert.equal(await p.locator('.snapshot-card').count(),0,'large hidden history not rendered');
        await p.getByRole('link',{name:'历史记录'}).click();
        assert.equal(await p.locator('.snapshot-card').count(),40);
        assert.equal(await p.locator('.snapshot-item').count(),0,'large snapshots lazy loaded');
        await p.locator('.snapshot-details summary').first().click();
        await p.waitForFunction(()=>document.querySelectorAll('.snapshot-item').length===80);
      }
      await ctx.close();
    }
    console.log('PERF 80 types + 6000 history entries + 40 saved pages; 20 saved increments (ms): '+JSON.stringify(timings));
    console.log('PASS: large-history counts remain exact; large snapshots load on demand.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
