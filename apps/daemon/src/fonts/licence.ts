import type { FontProfile, ResourceCandidate } from '@open-design/contracts';
import type { FontCatalogueFamily } from './catalogue.js';

/** The licence facts every font family carries, whichever source it comes from. */
export interface FontLicenceFacts {
  licence: FontCatalogueFamily['licence'] & { noticeSha256?: string | null; reservedFontNameClause?: string | null };
}

/**
 * Per-family rights from the family's own licence metadata (AC-R11 preamble).
 * Recognised open licences permit viewing, web embedding and redistribution with
 * their notice. A restricted licence (Fontshare ITF FFL, Adobe hosted-use, any
 * proprietary terms) blocks byte operations. Anything else is unknown: reference-only
 * viewing stays possible and redistribution is blocked (AC-R11.3).
 */
const RECOGNISED: Record<string, string> = {
  'OFL-1.1': 'SIL Open Font License 1.1: use, embed and redistribute with the licence notice; do not sell the font by itself',
  'Apache-2.0': 'Apache License 2.0: use, embed and redistribute with the licence and NOTICE text',
};
const RESTRICTED = /^(itf-ffl|ffl|adobe|proprietary|commercial|restricted)/iu;
export type FontRights = 'permitted' | 'unknown' | 'restricted';

export function fontRights(type: string): FontRights {
  if (Object.hasOwn(RECOGNISED, type)) return 'permitted';
  return RESTRICTED.test(type) ? 'restricted' : 'unknown';
}

export function fontLicenceProfile(family: FontLicenceFacts): FontProfile['licence'] {
  const rights = fontRights(family.licence.type);
  const names = family.licence.reservedFontNames;
  const modification = rights === 'restricted'
    ? 'Restricted licence: no local modification, subsetting, conversion or redistribution.'
    : rights === 'unknown'
      ? 'Licence unknown: view for reference only; do not modify, subset or redistribute.'
      : names.length
        ? `Reserved Font Name ${names.map(name => `"${name}"`).join(', ')}: use upstream-provided subsets only; modifying or subsetting locally needs a separate licence and rename review.`
        : family.licence.reservedFontNameClause
          // The licence states a Reserved Font Name the snapshot could not parse into names: keep the clause itself.
          ? `Reserved Font Name clause "${family.licence.reservedFontNameClause.slice(0, 300)}": use upstream-provided subsets only; read the licence before modifying.`
          : 'Use upstream-provided subsets; a modified version must keep this licence and must not be sold by itself.';
  const grant = rights === 'permitted' ? 'permitted' : rights === 'unknown' ? 'unknown' : 'blocked';
  return {
    type: family.licence.type, recognised: rights === 'permitted', attribution: family.licence.attribution, url: family.licence.url,
    upstreamLicenceSha256: family.licence.upstreamLicenceSha256, reservedFontNames: names,
    commercialUse: grant, webEmbedding: grant, redistribution: rights === 'permitted' ? 'permitted' : 'blocked', modification,
    ...(family.licence.noticeSha256 !== undefined ? { noticeSha256: family.licence.noticeSha256 } : {}),
  };
}

export function fontOperationGrants(family: FontLicenceFacts): ResourceCandidate['operationGrants'] {
  const rights = fontRights(family.licence.type);
  if (rights === 'permitted') {
    const reason = RECOGNISED[family.licence.type]!;
    return (['host-preview', 'incorporation', 'private-save', 'private-reuse', 'export', 'redistribution'] as const).map(operation => ({ operation, state: 'permitted' as const, reason }));
  }
  if (rights === 'restricted') {
    return (['host-preview', 'incorporation', 'export', 'redistribution'] as const).map(operation => ({ operation, state: 'blocked' as const, reason: `${family.licence.type} restricts this operation; no blanket permission is inferred` }));
  }
  return [
    { operation: 'host-preview', state: 'permitted', reason: 'Licence unknown: reference-only viewing' },
    ...(['incorporation', 'export', 'redistribution'] as const).map(operation => ({ operation, state: 'blocked' as const, reason: 'Licence unknown: no redistribution until the per-font rights are recorded' })),
  ];
}
