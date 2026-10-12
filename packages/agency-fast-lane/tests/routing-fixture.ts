import {readFile} from 'node:fs/promises';
import {loadAtlasData as loadPublicAtlasData, type FamilyRegistry} from '../src/atlas.ts';
export async function loadAtlasData() {
 const data = await loadPublicAtlasData();
 const synthetic = JSON.parse(await readFile(new URL('./fixtures/routing-families.json', import.meta.url), 'utf8')) as FamilyRegistry['families'];
 return {...data, registry: {families: [...synthetic, ...data.registry.families]}};
}
export async function loadFamilyRegistry() { return (await loadAtlasData()).registry; }
