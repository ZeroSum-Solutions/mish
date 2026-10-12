/** Existing transcript form-loop and delimiter sanitizers, shared by hosts. */
export function sanitizePriorAssistantTurnForTranscript(content: string, summarizeArtifacts: (content: string) => string = value => value): string {
  const forms = content.replace(/<(question-form|ask-question)\b[^>]*>[\s\S]*?<\/\1>/g, '[question-form was emitted here on a prior turn; the user already answered, see their reply below.]');
  const schemas = forms.replace(/```(?:json)?\s*\n([\s\S]*?)\n```/g, (match, body: string) => /"questions"\s*:\s*\[/.test(body) ? '[form schema was echoed here on a prior turn; stripped to avoid a loop.]' : match);
  return summarizeArtifacts(schemas);
}
export function escapeTranscriptRoleDelimiters(content: string): string {
  return content.replace(/^(## (?:user|assistant)[ \t]*)(\r?)$/gm, '\\$1$2');
}
