#!/usr/bin/env node
import { WebSocketModule } from '../../job-hunter/scripts/workspace-dependencies.mjs';
/**
 * Improved reCAPTCHA solver — faster, better VLM prompt, multi-round.
 * Usage: node recaptcha-solve-v2.mjs [--submit] [--rounds N]
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

function loadWebSocket() {
  const homeDir = process.env.HOME || os.homedir();
  const candidates = [
    () => { const ws = WebSocketModule; return ws.WebSocket || ws; },
    () => { const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(); return require(path.join(globalRoot, 'ws')); },
    () => require(path.join(homeDir, '.local/share/pi/agent/skills/auto-job-application/scripts/node_modules/ws')),
  ];
  const errors = [];
  for (const loader of candidates) {
    try {
      const ws = loader();
      return ws.WebSocket || ws;
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`Cannot load ws module from any known location. Install with: cd ../../captcha-resolution/scripts && npm install\nErrors: ${errors.join('; ')}`);
}

const WebSocket = loadWebSocket();

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9225;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpJson(method, path, body=null, port=CDP_PORT) {
  return new Promise(r => { const req = http.request({method, host:CDP_HOST, port, path, headers: body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(JSON.stringify(body))}:undefined, timeout:15000}, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{r(JSON.parse(d))}catch{r(null)} }); }); req.on('timeout',()=>req.destroy()); req.on('error',()=>r(null)); if(body)req.write(JSON.stringify(body)); req.end(); });
}
function download(url) {
  return new Promise(r => {
    https.get(url, {headers:{'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36','Referer':'https://www.recaptcha.net/','Accept':'image/*'},timeout:8000},
      res => { const c=[]; res.on('data',d=>c.push(d)); res.on('end',()=>r(Buffer.concat(c))); })
    .on('timeout',function(){this.destroy();r(null)}).on('error',()=>r(null));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const shouldSubmit = args.includes('--submit');
  const cdpPortArg = args.indexOf('--cdp-port');
  const cdpPort = cdpPortArg >= 0 ? Number(args[cdpPortArg + 1]) : CDP_PORT;
  const maxRounds = parseInt(args.find(a => /^\d+$/.test(a)) || '5');

  const v = await httpJson('GET', '/json/version', null, cdpPort);
  if (!v || !v.webSocketDebuggerUrl) { console.error(`No browser WebSocket at ${CDP_HOST}:${cdpPort}. Start Chromium with --remote-debugging-port=${cdpPort}.`); process.exit(1); }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  ws._mid = 1; ws._p = {};
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && ws._p[m.id]) ws._p[m.id](m); });
  await new Promise(r => ws.on('open', r));
  const send = (m,p,s) => new Promise(r => { const id = ws._mid++; ws._p[id]=r; const msg={id,method:m,params:p}; if(s)msg.sessionId=s; ws.send(JSON.stringify(msg)); });

  // Find review tab
  let targets = await send('Target.getTargets');
  const reviewTab = targets.result.targetInfos.find(t => t.type==='page' && t.url.includes('review-module'));
  
  // Find anchor (last one)
  const anchors = targets.result.targetInfos.filter(t => t.url.includes('anchor') && t.url.includes('6Ldn8Qwp'));
  let anchor = anchors[anchors.length - 1];
  if (!anchor) { console.log('No anchor found'); ws.close(); process.exit(1); }
  console.log('Anchor:', anchor.targetId.substring(0,20));

  // Click anchor
  const attA = await send('Target.attachToTarget', {targetId: anchor.targetId, flatten: true});
  const aSess = attA.result.sessionId;
  await send('Runtime.evaluate', {expression:`document.getElementById('recaptcha-anchor')?.click?.()`, returnByValue:true}, aSess);
  await send('Target.detachFromTarget', {sessionId: aSess});
  console.log('Clicked anchor');

  for (let round = 0; round < maxRounds; round++) {
    console.log(`\n=== Round ${round + 1} ===`);
    
    // Wait for bframe
    await sleep(2500);
    targets = await send('Target.getTargets');
    const bframe = targets.result.targetInfos.filter(t => t.url.includes('bframe') && t.url.includes('6Ldn8Qwp')).pop();
    if (!bframe) { console.log('No bframe'); break; }

    const attBf = await send('Target.attachToTarget', {targetId: bframe.targetId, flatten: true});
    const bfSess = attBf.result.sessionId;

    // Get challenge info
    const info = await send('Runtime.evaluate', {
      expression: `(() => {
        const text = document.body?.innerText?.substring(0,300) || '';
        const imgs = document.querySelectorAll('.rc-imageselect-tile img');
        const img = imgs.length > 0 ? imgs[0].src : '';
        const table = document.querySelector('.rc-imageselect-table-33,.rc-imageselect-table-44');
        const grid = table?.className?.includes('33') ? 3 : table?.className?.includes('44') ? 4 : 3;
        const ids = Array.from(document.querySelectorAll('.rc-imageselect-tile')).map(t=>t.id);
        return JSON.stringify({text: text.substring(0,150), imgUrl: img, grid, ids});
      })()`,
      returnByValue: true
    }, bfSess);
    const ci = JSON.parse(info.result?.result?.value || '{}');
    console.log('Challenge:', ci.text?.substring(0,80));
    console.log('Grid:', ci.grid, '| IDs:', ci.ids?.join(','));

    if (!ci.imgUrl) { console.log('No image URL'); break; }

    // Download with retry
    let imgData = null;
    for (let i = 0; i < 20; i++) {
      imgData = await download(ci.imgUrl);
      if (imgData && imgData.length > 100) break;
      await sleep(150);
    }
    if (!imgData || imgData.length < 100) { console.log('Download failed'); break; }
    console.log('Downloaded:', imgData.length, 'bytes');

    const match = ci.text.match(/Select all (?:images|squares) with\s*\n?\s*([^\n]+)/);
    const challengeType = match ? match[1].trim() : 'unknown';
    const imgPath = `/tmp/captcha-round-${Date.now()}.jpg`;
    fs.writeFileSync(imgPath, imgData);

    // Create labeled image
    execSync(`python3 -c "
from PIL import Image, ImageDraw, ImageFont
img = Image.open('${imgPath}'); w,h=img.size; g=${ci.grid}; tw,th=w//g,h//g
try: font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',18)
except: font=ImageFont.load_default()
lab=img.copy(); draw=ImageDraw.Draw(lab)
for row in range(g):
    for col in range(g):
        tid=row*g+col; x,y=col*tw,row*th
        draw.rectangle([x,y,x+tw-1,y+th-1],outline='white',width=2)
        draw.text((x+3,y+3),str(tid),fill='lime',font=font)
lab.save('${imgPath}.labeled.png')
"`, {encoding:'utf8',timeout:5000});

    // Call VLM with improved prompt
    const b64 = fs.readFileSync(imgPath+'.labeled.png').toString('base64');
    const maxT = ci.grid*ci.grid;
    const vision = await new Promise(resolve => {
      const payload = JSON.stringify({
        model:'qwen3.6-35b-a3b-holo3-qwopus-instruct-qx64-hi-mlx',
        messages:[{role:'user',content:[
          {type:'image_url',image_url:{url:`data:image/png;base64,${b64}`}},
          {type:'text',text:`3x3 reCAPTCHA grid. Tiles 0-8. Challenge: "${challengeType}".

Describe what you see in EACH tile (0-8) one line each.
Then list ALL tiles that match "${challengeType}".

Reply ONLY JSON: {"descriptions":{"0":"...","1":"...",...},"tiles":[nums],"reasoning":"brief"}`}
        ]}],max_tokens:400,temperature:0.1
      });
      const req = http.request({method:'POST',hostname:'127.0.0.1',port:1234,path:'/v1/chat/completions',
        headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}}, res => {
          let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
            try{const j=JSON.parse(d);const c=j.choices?.[0]?.message?.content||'';
              const cl=c.replace(/<think[^>]*>[\s\S]*?<\/think>/g,'').trim();
              const m=cl.match(/\{[\s\S]*\}/); resolve(m?JSON.parse(m[0]):null);
            }catch{resolve(null);}
          });
      });
      req.on('error',()=>resolve(null)); req.write(payload); req.end();
    });

    const tiles = vision?.tiles || [];
    console.log('Vision tiles:', tiles.join(','), '| reasoning:', vision?.reasoning?.substring(0,80));
    if (vision?.descriptions) {
      Object.entries(vision.descriptions).forEach(([k,v]) => console.log(`  Tile ${k}: ${v?.substring(0,60)}`));
    }

    if (!tiles.length) { console.log('No tiles identified'); break; }

    // Click tiles
    const rects = await send('Runtime.evaluate', {
      expression:`(()=>Array.from(document.querySelectorAll('.rc-imageselect-tile')).map(t=>{const r=t.getBoundingClientRect();return{id:t.id,cx:Math.round(r.x+r.width/2),cy:Math.round(r.y+r.height/2)};}))()`,
      returnByValue:true
    }, bfSess);
    const tileRects = rects.result?.result?.value || [];
    for (const tid of tiles) {
      const t = tileRects.find(r=>r.id===String(tid));
      if(!t) continue;
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:t.cx,y:t.cy,button:'left',clickCount:1},bfSess);
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:t.cx,y:t.cy,button:'left',clickCount:1},bfSess);
      await sleep(80);
    }

    // Verify
    const vr = await send('Runtime.evaluate',{expression:`(()=>{const b=document.getElementById('recaptcha-verify-button');const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,returnByValue:true},bfSess);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:vr.result.result.value.x,y:vr.result.result.value.y,button:'left',clickCount:1},bfSess);
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:vr.result.result.value.x,y:vr.result.result.value.y,button:'left',clickCount:1},bfSess);

    console.log('Waiting for verification...');
    await sleep(5000);

    // Check anchor
    targets = await send('Target.getTargets');
    const newAnchors = targets.result.targetInfos.filter(t => t.url.includes('anchor') && t.url.includes('6Ldn8Qwp'));
    const lastAnchor = newAnchors[newAnchors.length - 1];
    if (lastAnchor) {
      const attA2 = await send('Target.attachToTarget',{targetId:lastAnchor.targetId,flatten:true});
      const aSess2 = attA2.result.sessionId;
      const chk = await send('Runtime.evaluate',{expression:`document.getElementById('recaptcha-anchor')?.getAttribute('aria-checked')||'unchecked'`,returnByValue:true},aSess2);
      const checked = chk.result?.result?.value;
      console.log('Anchor checked:', checked);
      await send('Target.detachFromTarget',{sessionId:aSess2});

      if (checked === 'true') {
        console.log('✅ reCAPTCHA SOLVED!');
        
        // Click submit if requested
        if (shouldSubmit && reviewTab) {
          const attR = await send('Target.attachToTarget', {targetId: reviewTab.id, flatten: true});
          if (attR?.result?.sessionId) {
            const rSess = attR.result.sessionId;
            const btn = await send('Runtime.evaluate',{expression:`(()=>{const b=document.querySelector('button[name="submit-application"]');return b?JSON.stringify({d:b.disabled,t:b.innerText.trim().substring(0,60)}):'no-btn';})()`,returnByValue:true},rSess);
            console.log('Submit:', btn.result?.result?.value);
            
            const st = JSON.parse(btn.result?.result?.value||'{}');
            if (!st.d) {
              const br = await send('Runtime.evaluate',{expression:`(()=>{const b=document.querySelector('button[name="submit-application"]');const r=b.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,returnByValue:true},rSess);
              await send('Input.dispatchMouseEvent',{type:'mousePressed',x:br.result.result.value.x,y:br.result.result.value.y,button:'left',clickCount:1},rSess);
              await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:br.result.result.value.x,y:br.result.result.value.y,button:'left',clickCount:1},rSess);
              await sleep(5000);
              const post = await send('Runtime.evaluate',{expression:`document.body?.innerText?.substring(0,500)||''`,returnByValue:true},rSess);
              console.log('Post:', post.result?.result?.value?.substring(0,300));
            }
            await send('Target.detachFromTarget',{sessionId:rSess});
          }
        }
        break;
      }
    }
    
    // Not solved - check for new challenge or retry
    console.log('Not solved - checking for new challenge...');
    targets = await send('Target.getTargets');
    const newBframe = targets.result.targetInfos.filter(t => t.url.includes('bframe') && t.url.includes('6Ldn8Qwp')).pop();
    if (newBframe) {
      const attBf2 = await send('Target.attachToTarget', {targetId: newBframe.targetId, flatten: true});
      const bfSess2 = attBf2.result.sessionId;
      const bftxt = await send('Runtime.evaluate', {expression:`document.body?.innerText?.substring(0,100)||''`, returnByValue:true}, bfSess2);
      const bt = bftxt.result?.result?.value || '';
      await send('Target.detachFromTarget',{sessionId:bfSess2});
      
      if (bt.includes('expired')) {
        console.log('Challenge expired - re-clicking anchor...');
        const attA3 = await send('Target.attachToTarget',{targetId:anchor.targetId,flatten:true});
        const aSess3 = attA3.result.sessionId;
        await send('Runtime.evaluate',{expression:`document.getElementById('recaptcha-anchor')?.click?.()`,returnByValue:true},aSess3);
        await send('Target.detachFromTarget',{sessionId:aSess3});
        await sleep(2000);
      } else if (bt.includes('Select all')) {
        console.log('New challenge appeared - continuing...');
        continue;
      }
    }
  }

  ws.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });