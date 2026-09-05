// api-config.js
// Single source of truth for the backend origin and sport-nested API paths.
// New sport-specific pages should use apiUrl() rather than hardcoding BACKEND.
export const BACKEND = 'https://bsmachine-backend.onrender.com/api';

export function apiUrl(sport, path) {
  return `${BACKEND}/${sport}/${path}`;
}
