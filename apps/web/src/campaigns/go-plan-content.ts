import type { Locale } from '../i18n';

export interface GoPlanCampaignCopy {
  eyebrow: string;
  headline: string;
  description: string;
  benefit: string;
  status: string;
  cta: string;
  renewal: string;
  boundary: string;
  newBadge: string;
  closeAria: string;
  providersAria: string;
  workbenchBadge: string;
  workbenchBadgeAria: string;
}

const english: GoPlanCampaignCopy = {
  eyebrow: 'NEW PLAN · LAUNCH OFFER',
  headline: 'Low-cost design plan for everyone',
  description: 'Professional design intelligence at a lower cost—so every idea moves faster from prompt to finished work.',
  benefit: 'Go first month $5 · unlimited use',
  status: 'UNLIMITED',
  cta: 'View Go plan · Limited-time 50% off',
  renewal: 'Then $10 / month',
  boundary: 'Allowance details and offer terms are shown on Pricing.',
  newBadge: 'NEW',
  closeAria: 'Close dialog',
  providersAria: 'Model providers available on Go',
  workbenchBadge: 'The new Go Plan · ¥5 for the first month · Unlimited model usage',
  workbenchBadgeAria: 'The new Go Plan, ¥5 for the first month, unlimited model usage — view Pricing',
};

const localized: Record<Locale, GoPlanCampaignCopy> = {
  en: english,

};

export function getGoPlanCampaignCopy(locale: Locale): GoPlanCampaignCopy {
  return localized[locale];
}
