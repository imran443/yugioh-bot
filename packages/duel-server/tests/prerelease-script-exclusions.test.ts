import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { applyPrereleaseSmokeResult } from "../scripts/prerelease-script-exclusions.js";
import { downloadReleasedCardData, type PreparedCardData } from "../scripts/released-card-data.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"preview-exclude-"));roots.push(root);
 const create=(file:string,rows:Array<[number,number,string]>)=>{
  const db=new Database(join(root,file));db.exec("CREATE TABLE datas(id INTEGER PRIMARY KEY,ot INTEGER,alias INTEGER,type INTEGER);CREATE TABLE texts(id INTEGER PRIMARY KEY,name TEXT)");
  for(const [code,alias,name] of rows){db.prepare("INSERT INTO datas VALUES(?,3,?,33)").run(code,alias);db.prepare("INSERT INTO texts VALUES(?,?)").run(code,name);}db.close();
 };
 create("cards.cdb",[[12,0,"Released"]]);create("prerelease-a.cdb",[[22,0,"Broken"],[100000001,0,"Broken"],[100000050,100000001,"Broken artwork"],[23,0,"Healthy"]]);
 const request=async(url:string)=>url.includes("/git/trees/")?Response.json({truncated:false,tree:["cards.cdb","prerelease-a.cdb"].map(path=>({path,type:"blob"}))}):new Response(new Uint8Array(await readFile(join(root,url.split("/").pop()!))));
 // Synthetic cards must not consume the repository's production remap overrides.
 return downloadReleasedCardData("a".repeat(40),join(root,"bundle"),request,{overrideBytes:"{}\n"});
}
it("excludes only broken previews/artwork families and suppresses remaps whose destination was excluded",async()=>{
 const database=await fixture();expect(database.remaps).toEqual({100000001:22});
 await applyPrereleaseSmokeResult(database,{checked:3,excluded:[{code:22,errors:["card-script-error"]}]});
 expect([...database.prereleaseCodes]).toEqual([23]);
 expect(database.remaps).toEqual({});expect(database.prerelease.map(card=>card.code)).toEqual([23]);
 const artifact=JSON.parse(database.remapBytes);
 expect(artifact.scriptSmoke.checked).toBe(3);
 expect(artifact.scriptSmoke.excluded.map((card:any)=>card.code)).toEqual([22,100000050]);
 expect(artifact.scriptSmoke.excluded[1].errors).toEqual(["main-card-excluded"]);
 expect(artifact.scriptSmoke.suppressedRemaps).toEqual([{old:100000001,target:22}]);
 const db=new Database(database.path);try{expect(db.prepare("SELECT id FROM datas ORDER BY id").all()).toEqual([{id:12},{id:23}]);}finally{db.close();}
});
it("refuses a released exclusion instead of deleting released data",async()=>{
 const database=await fixture();
 await expect(applyPrereleaseSmokeResult(database,{checked:3,excluded:[{code:12,errors:["released error"]}]})).rejects.toThrow(/released/i);
});
it("refuses diagnostic text in the hashed artifact before deleting any preview",async()=>{
 const database=await fixture(),before=database.remapBytes;
 await expect(applyPrereleaseSmokeResult(database,{checked:3,excluded:[{code:22,errors:["random stderr 55ms"]}]})).rejects.toThrow(/reason/);
 expect(database.remapBytes).toBe(before);expect([...database.prereleaseCodes]).toEqual([22,23,100000050]);
});
