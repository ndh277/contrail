// Client-side configuration. These values are public by design: they are only
// safe because of the API key's HTTP-referrer restriction (https://ndh277.github.io/*)
// and the Firestore security rules. Never put anything else secret here.

export const CONFIG = {
  // M3: Google Maps JavaScript API key (Maps JavaScript API + Map Tiles API only).
  googleMapsApiKey: "",
  // M4: Firebase web app config object, e.g. { apiKey, authDomain, projectId, appId }.
  firebase: null,
};
