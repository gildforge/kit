// One resolver for legacy indexed and prepared database read paths.
export const SHA=/^[a-f0-9]{40}$/
export function refHash(refs:readonly {name:string;hash:string}[],defaultBranch:string,ref?:string){
  return ref&&SHA.test(ref)?ref:
    refs.find(r=>r.name===(ref?.replace(/^refs\/(heads|tags)\//,'')??defaultBranch))?.hash
}
