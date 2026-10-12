// Owned pipeline test double; production compiler security is tested on retained public families.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderAgencySite(input: any, entry: string, approvedManifest: any, options: any = {}) {
 const schema = JSON.parse(readFileSync(join(import.meta.dirname,'families',input.family,'recipe.schema.json'),'utf8'));
 function check(value: any, node: any, at: string) {
  if (value === null && (node['x-atom'] || node.oneOf)) return;
  if(node.oneOf) node = node.oneOf.find((b: any) => b.type !== 'null');
  if(typeof value === 'string' && /[<>]/.test(value)) throw new Error(`${at}: markup is not allowed`);
  if(typeof value === 'string' && node.maxLength && value.length > node.maxLength) throw new Error(`${at}: at most ${node.maxLength} characters`);
  if(typeof value === 'string' && node['x-atom'] === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new Error(`${at}: invalid email`);
  if(Array.isArray(value)) value.forEach((v,i) => check(v,node.prefixItems?.[i] ?? node.items ?? {},`${at}[${i}]`));
  else if(value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => check(v,node.properties?.[k] ?? {},at ? `${at}.${k}` : k));
 }
 check(input,schema,'');
 const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const revision = entry.replace(/\.html$/, '');
 const assets = approvedManifest.assets.map((a: any) => ({...a,destination:`assets/agency-site/${revision}/${a.file}`}));
 const leaves = (v: any): string => v == null ? '' : typeof v === 'string' ? `<p>${escape(v)}</p>` : Array.isArray(v) ? v.map(leaves).join('') : Object.entries(v).filter(([k]) => !['id','type','assets','destinations','wordmark','colors','fonts'].includes(k)).map(([,x]) => leaves(x)).join('');
 const sections = input.sections.filter(Boolean).map((s: any) => `<section id="${s.id}" data-od-section="${s.id}">${s.type === 'hero' ? '<p class="rail-row">'+escape(s.content.railValue4)+'</p>' : ''}${leaves(s.text ?? s.content ?? {})}${leaves(s.items ?? {})}${s.type==='footer' ? Object.entries(s.content ?? {}).filter(([k,v]) => /Email/.test(k) && v).map(([,v]) => `<a href="mailto:${encodeURIComponent(String(v))}">Email</a>`).join('') + (s.content?.phone ? `<a href="tel:${String(s.content.phone).replace(/[^0-9+]/g,'')}">Call</a>` : '') : ''}</section>`).join('');
 let html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'"><title>${escape(input.brand.name)}</title></head><body><main><h1>${escape(input.brand.name)}</h1>${sections}</main></body></html>`;
 if(options.compose) html = options.compose(html);
 return {recipe:input,html,manifest:{entry,supportingFiles:assets.map((a:any) => a.destination),metadata:{agencySite:{recipeDigest:digest,revision,family:input.family,outputScope:'site'}}},approvedAssets:assets, ...(options.compose ? {composed:true} : {})};
}
