// -----------------------------------------------------------------------------
// Audit feedback wrapper
//
// Every piece of feedback that the runtime injects into the model's context
// to drive a guard (Ralph Gate, side-effect guard, tdd-react failure, etc.)
// MUST go through this wrapper. The model otherwise has no signal that the
// text is feedback for the audit pipeline rather than a user-facing message,
// and it tends to over-apply the audit vocabulary (e.g. "I did not run
// Bash", "the Coherence Guard", "task list") when it tries to defend
// itself.
//
// The wrapper uses generic "el usuario" wording rather than a user-specific
// name, because Monolito is multi-profile: a hardcoded name here would be
// wrong for any other chat or profile.
// -----------------------------------------------------------------------------

export const AUDIT_FEEDBACK_OPEN =
  "=== AUDIT FEEDBACK (procesá esto internamente, NO respondas al usuario con esto) ==="

export const AUDIT_FEEDBACK_CLOSE = "=== END AUDIT FEEDBACK ==="

export const AUDIT_FEEDBACK_TAIL =
  "Recordatorio: tu próxima respuesta al usuario debe ser natural, " +
  "no un reporte sobre este feedback ni sobre qué tools ejecutaste."

function escapeAuditFeedbackMarkers(content: string): string {
  return content
    .replaceAll(AUDIT_FEEDBACK_OPEN, "[AUDIT_FEEDBACK_OPEN escaped]")
    .replaceAll(AUDIT_FEEDBACK_CLOSE, "[AUDIT_FEEDBACK_CLOSE escaped]")
}

/**
 * Wrap arbitrary audit feedback content with the canonical demarcation
 * markers and the standard "respond naturally" tail. Canonical marker
 * collisions inside the body are neutralized so untrusted feedback cannot
 * terminate or restart the envelope early.
 */
export function wrapAuditFeedback(content: string): string {
  return [
    AUDIT_FEEDBACK_OPEN,
    "",
    escapeAuditFeedbackMarkers(content.trim()),
    "",
    AUDIT_FEEDBACK_CLOSE,
    "",
    AUDIT_FEEDBACK_TAIL,
  ].join("\n")
}
