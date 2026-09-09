// Prices live on the server so the client cannot decide what anything costs. The client has
// its own copy of the *visual* definition for each id; only these numbers are authoritative.
export const FRAME_PRICES: Record<string, number> = {
  bronze: 150,
  steel: 250,
  gold: 400,
  neon: 600,
  galaxy: 900,
  mythic: 1500,
};

export const NAME_EFFECT_PRICES: Record<string, number> = {
  gold: 300,
  crimson: 300,
  ice: 400,
  toxic: 500,
  void: 700,
};

// Deliberately expensive. At roughly 50-100 coins a day this is three to four weeks of play
// for one week of Pro - clearly worse value than paying, which is the point. It rewards the
// most engaged free users with a taste of Pro rather than replacing the subscription.
export const PRO_WEEK_PRICE = 2000;
export const PRO_WEEK_DAYS = 7;
