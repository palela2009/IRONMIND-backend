export const normalizedEmail = (email: unknown): string | null =>
  typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;

export const verifiedEmailFrom = (claims: { email?: unknown; email_verified?: unknown }): string | null =>
  claims.email_verified === true ? normalizedEmail(claims.email) : null;

export const isOwner = (verifiedEmail?: string | null): boolean => {
  const email = normalizedEmail(verifiedEmail);
  if (!email) return false;
  return (process.env.OWNER_EMAILS ?? '').split(',').some((entry) => normalizedEmail(entry) === email);
};
