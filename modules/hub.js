const path=require('path'),fs=require('fs'),crypto=require('crypto'),WebSocket=require('ws');
const STORAGE=path.join(__dirname,'..','storage'),DB=path.join(STORAGE,'hub.json');
if(!fs.existsSync(STORAGE))fs.mkdirSync(STORAGE,{recursive:true});
let state={messages:[],identities:{}};
try{if(fs.existsSync(DB))state=JSON.parse(fs.readFileSync(DB,'utf8'));}catch(e){console.warn('[hub]',e.message);}
state.messages=Array.isArray(state.messages)?state.messages:[];state.identities=state.identities||{};
let saveT=null;function save(){clearTimeout(saveT);saveT=setTimeout(()=>{try{fs.writeFileSync(DB,JSON.stringify(state));}catch(e){}},700);}
function color(s){let h=0;for(const c of String(s))h=(h*31+c.charCodeAt(0))|0;return['#0078d4','#d13438','#107c10','#8764b8','#c239b3','#ff8c00','#00b7c3','#e3008c','#498205','#5c2e91'][Math.abs(h)%10];}
module.exports.attach=function(httpServer,deps){
  const sessions=deps.sessions,log=deps.log||(()=>{}),clients=new Map();
  const wss=new WebSocket.Server({server:httpServer,path:'/ws'});
  const send=(ws,o)=>{if(ws.readyState===1)try{ws.send(JSON.stringify(o));}catch(e){}};
  const bc=o=>{for(const ws of clients.keys())send(ws,o);};
  const list=()=>[...clients.values()].map(c=>({id:c.id,nick:c.nick,color:c.color,ip:c.ip,joinedAt:c.joinedAt}));
  const bcPresence=()=>bc({type:'presence',users:list()});
  const findNick=n=>{for(const c of clients.values())if(c.nick===n)return c;return null;};
  wss.on('connection',(ws,req)=>{
    const url=new URL(req.url,'http://x'),token=url.searchParams.get('token');
    if(!token||!sessions.has(token)){try{ws.close(4001,'auth');}catch(e){}return;}
    const nick=((url.searchParams.get('nick')||'').trim().slice(0,24))||('Гость-'+crypto.randomBytes(2).toString('hex'));
    const c={id:crypto.randomBytes(6).toString('hex'),nick,color:color(nick+Date.now()+Math.random()),ip:(req.socket.remoteAddress||'').replace('::ffff:','').replace('::1','localhost'),joinedAt:Date.now()};
    clients.set(ws,c);
    send(ws,{type:'hello',me:{id:c.id,nick:c.nick,color:c.color},history:state.messages.slice(-200)});
    bcPresence();bc({type:'system',text:nick+' присоединился'});log('hub_join',{ip:c.ip},{nick});
    ws.on('message',raw=>{
      let m;try{m=JSON.parse(raw);}catch(e){return;}if(!m||typeof m!=='object')return;
      if(m.type==='chat'){
        const text=String(m.text||'').slice(0,4000).trim(),to=m.to?String(m.to).slice(0,24):null;
        const file=m.file&&typeof m.file==='object'?{name:String(m.file.name||'').slice(0,200),size:Number(m.file.size)||0,path:String(m.file.path||'').slice(0,500)}:null;
        if(!text&&!file)return;
        const room=to?('dm:'+[c.nick,to].sort().join('|')):'global';
        const entry={id:crypto.randomBytes(8).toString('hex'),ts:Date.now(),room,to,from:{id:c.id,nick:c.nick,color:c.color},text,file};
        state.messages.push(entry);if(state.messages.length>3000)state.messages=state.messages.slice(-3000);save();
        if(to){send(ws,{type:'chat',entry});const t=findNick(to);if(t)send(t.ws||t,{type:'chat',entry});}
        else bc({type:'chat',entry});
        return;
      }
      if(m.type==='typing'){const to=m.to?String(m.to).slice(0,24):null,p={type:'typing',from:c.nick,to};if(to){const t=findNick(to);if(t)send(t,{type:'typing',from:c.nick,to:null});}else bc(p);return;}
      if(m.type==='rename'){const nn=String(m.nick||'').trim().slice(0,24);if(!nn)return;const old=c.nick;c.nick=nn;c.color=color(nn+Math.random());bc({type:'system',text:old+' теперь '+nn});bcPresence();send(ws,{type:'hello-me',me:{id:c.id,nick:nn,color:c.color}});return;}
    });
    ws.on('close',()=>{clients.delete(ws);bc({type:'system',text:nick+' покинул'});bcPresence();});
    ws.on('error',()=>{});
  });
  return{notifyFile:m=>bc({type:'file-added',file:m,ts:Date.now()}),broadcast:bc,presence:list};
};