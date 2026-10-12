/**
 * The canonical screenshot draft host contract lives in contracts. Keep the
 * dedicated daemon turn on that renderer, as with deck-framework.ts; UI and
 * CLI requests both reach this turn through the same capture-draft service.
 */
export { renderCaptureDraftPrompt } from '@mish/contracts';
