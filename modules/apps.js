const path=require('path'),fs=require('fs');
const STORAGE=path.join(__dirname,'..','storage'),DB=path.join(STORAGE,'apps.json');
if(!fs.existsSync(STORAGE))fs.mkdirSync(STORAGE,{recursive:true});
let db={notes:[],todos:[],passwords:[],bookmarks:[]};
try{if(fs.existsSync(DB))db=Object.assign(db,JSON.parse(fs.readFileSync(DB,'utf8')));}catch(e){}
let sT=null;function save(){clearTimeout(sT);sT=setTimeout(()=>{try{fs.writeFileSync(DB,JSON.stringify(db,null,2));}catch(e){}},400);}
module.exports.mount=function(app,ctx){
  const{requireAuth,toRel,BASE_ROOT,activeMounts}=ctx;
  app.get('/api/apps/:key',requireAuth,(req,res)=>{const k=req.params.key;if(!(k in db))return res.status(404).json({error:'unknown'});res.json({data:db[k]});});
  app.post('/api/apps/:key',requireAuth,(req,res)=>{const k=req.params.key;if(!(k in db))return res.status(404).json({error:'unknown'});db[k]=req.body&&req.body.data||[];save();res.json({ok:true});});
  app.get('/api/apps/music/list',requireAuth,async(req,res)=>{const exts=['.mp3','.wav','.flac','.ogg','.m4a','.aac'];const out=[];async function walk(dir,d){if(d>6||out.length>500)return;let es;try{es=await fs.promises.readdir(dir,{withFileTypes:true});}catch(e){return;}for(const e of es){if(e.name.startsWith('.'))continue;const fp=path.join(dir,e.name);try{if(e.isDirectory()){await walk(fp,d+1);}else if(exts.includes(path.extname(e.name).toLowerCase())){const s=await fs.promises.stat(fp);out.push({path:toRel(fp),name:e.name,size:s.size});}}catch(e){}}}
    await walk(BASE_ROOT,0);for(const m of (activeMounts||[])){try{await walk(m.path,0);}catch(e){}}res.json({items:out});});
  console.log('[apps] mounted: notes, todos, passwords, bookmarks, music');
};