// Client-safe: shown on the login page and in settings.
/** Messages for the closed set of refusal codes; the login page and settings render these. */
export const REFUSALS: Record<string, string> = {
  custodes_not_configured: "Sign-in with Custodes is not configured.",
  custodes_flow_invalid:
    "That sign-in attempt expired or was already used. Please start again.",
  custodes_unavailable:
    "Custodes could not be reached. Please try again in a moment.",
  custodes_denied: "Custodes did not complete the sign-in.",
  custodes_rejected:
    "Custodes returned a sign-in reply that could not be verified.",
  custodes_unlinked:
    "This Custodes account is not linked to an Astropath account. Sign in with your existing method, then choose Link Custodes account in Settings, or open an invitation link.",
  custodes_link_session:
    "Linking needs the same Astropath session that started it. Sign in to Astropath and try again.",
  custodes_already_linked:
    "This Custodes account is already linked to a different Astropath account.",
  custodes_user_linked:
    "This Astropath account is already linked to a different Custodes account.",
  custodes_no_access:
    "This account does not have workspace access. Contact the owner.",
  custodes_invite_email:
    "The Custodes account's verified email does not match the invitation.",
  custodes_invite_account_exists:
    "An Astropath account already exists for this email. Sign in as that account, link Custodes in Settings, then open the invitation again.",
  invalid_invite:
    "This invitation is invalid, expired, or already used. Ask the owner for a new link.",
  invitation_account_mismatch:
    "Sign in with the email address this invitation was sent to.",
};
