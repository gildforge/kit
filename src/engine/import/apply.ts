import type { ImportRecord } from '../api/import-contract.js'
import { DIR,readJson,writeJson } from '../meta-files.js'
import type { MemFS } from '../memfs.js'
import { importedAuthor } from './source.js'
export function importRecordPath(record:ImportRecord):string {
  if(record.kind==='label')return '.gild/import/labels.json'
  const root=`.gild/${record.number}`
  if(record.kind==='issue'||record.kind==='pull'){const sub=record.kind==='pull'?'pr':'issue';return `${root}/${sub}/${sub}.json`}
  if(record.kind==='patch')return `${root}/pr/patch-${String(record.part).padStart(6,'0')}.patch`
  if(record.kind==='body'){const name=record.record==='issue'?'issue.json':record.record==='pull'?'pr.json':`${record.record==='review'?'r':'c'}-${Date.parse(record.createdAt)}-${record.id}.json`;return `${root}/${record.target}/${name}`}
  return `${root}/${record.target}/${record.kind==='review'?'r':'c'}-${Date.parse(record.createdAt)}-${record.id}.json`
}
/** One existing forge write per bounded batch. Deterministic paths make a
 * replay safe even when Git committed a batch but the checkpoint was lost. */
export async function applyImportBatch(fs:MemFS,records:ImportRecord[]) {
  let changed=false
  const put=async(path:string,value:unknown)=>{
    if(JSON.stringify(await readJson(fs,path))===JSON.stringify(value)) return
    await writeJson(fs,path,value);changed=true
  }
  for(const record of records) {
    if(record.kind==='label') {
      const labels=await readJson<Record<string,{name:string;color:string;description:string}>>(fs,`${DIR}/.gild/import/labels.json`)??{}
      labels[record.name]={name:record.name,color:record.color,description:record.description}
      await put(`${DIR}/.gild/import/labels.json`,labels);continue
    }
    const root=`${DIR}/.gild/${record.number}`
    if(record.kind==='body') {
      if(record.part>=record.parts)throw Error('Invalid source body chunk')
      const name=record.record==='issue'?'issue.json':record.record==='pull'?'pr.json':`${record.record==='review'?'r':'c'}-${Date.parse(record.createdAt)}-${record.id}.json`
      const file=`${DIR}/${importRecordPath(record)}`,data=await readJson<any>(fs,file)
      if(!data || data.imported?.updatedAt!==record.version)throw Error('Source body has no current parent')
      const directory=`${root}/import/body-${record.target}-${name}-${Date.parse(record.version)}`
      const chunk=`${directory}/${record.part}.txt`
      if(await fs.readFile(chunk,{encoding:'utf8'}).catch(()=>null)!==record.text){await fs.writeFile(chunk,record.text);changed=true}
      if(record.part===record.parts-1){let body='';for(let i=0;i<record.parts;i++)body+=await fs.readFile(`${directory}/${i}.txt`,{encoding:'utf8'});await put(file,{...data,body})}
      continue
    }
    if(record.kind==='issue' || record.kind==='pull') {
      const kind=record.kind==='issue'?'issue':'pr',path=`${DIR}/${importRecordPath(record)}`
      const existing=await readJson<{imported?:{id:string;forge:string}}>(fs,path)
      const opposite=await readJson(fs,`${root}/${kind==='issue'?'pr':'issue'}/${kind==='issue'?'pr':'issue'}.json`)
      if(opposite || (existing && (existing.imported?.id!==record.imported.id || existing.imported?.forge!==record.imported.forge))) throw Error('Import number conflicts with existing repository metadata')
      const {kind:_kind,...data}=record
      if(record.bodyParts && existing) data.body=(existing as any).body??''
      await put(path,{schema:1,...data,author:importedAuthor(record.imported.forge,record.imported.author),updatedAt:record.imported.updatedAt,...(kind==='issue'?{claim:null}:{})})
      const counter=Number(await fs.readFile(`${DIR}/.gild/next`,{encoding:'utf8'}).catch(()=> '1'))
      if(counter<=record.number) {await fs.writeFile(`${DIR}/.gild/next`,`${record.number+1}\n`);changed=true}
    } else if(record.kind==='patch') {
      const path=`${DIR}/${importRecordPath(record)}`
      if(await fs.readFile(path,{encoding:'utf8'}).catch(()=>null)!==record.text) {await fs.writeFile(path,record.text);changed=true}
    } else {
      const {kind,id,target,...data}=record
      if(!await readJson(fs,`${root}/${target}/${target}.json`)) throw Error('Import comment has no parent item')
      const file=`${kind==='review'?'r':'c'}-${Date.parse(record.createdAt)}-${id}.json`
      if(record.bodyParts) data.body=(await readJson<any>(fs,`${root}/${target}/${file}`))?.body??''
      await put(`${DIR}/${importRecordPath(record)}`,{...data,id,author:importedAuthor(record.imported.forge,record.imported.author)})
    }
  }
  return changed
}
