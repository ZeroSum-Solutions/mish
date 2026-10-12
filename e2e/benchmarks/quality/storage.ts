import { randomUUID } from 'node:crypto';
import { writeFile,rename,link,unlink } from 'node:fs/promises';
/** Readers see the previous complete JSON or the new complete JSON; create mode never overwrites. */
export async function writeJsonAtomic(file:string,value:unknown,exclusive=false) {
  const temporary=`${file}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
    if(exclusive) await link(temporary,file); else await rename(temporary,file);
  } finally {await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}
