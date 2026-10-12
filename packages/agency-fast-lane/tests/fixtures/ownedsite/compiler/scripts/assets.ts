import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
export const readApprovedAsset = (root: string, asset: {file: string}) => readFile(join(root, asset.file));
