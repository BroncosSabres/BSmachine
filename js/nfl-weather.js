// Weather badge text for NFL games. The backend serves the simulation
// variants matching the latest gameday forecast (or 'dome' indoors), blended
// by how likely each is given the forecast and how far out it is; each
// prediction carries `weather: {bin, mix?, source, fetched_at, temp_f,
// wind_mph, gust_mph, precip_mm, snow_cm, precip_prob, locked}`, where bin is
// the most likely variant and mix ([[bin, share], ...], most likely first)
// is there when several are blended.

const PRECIP_LABEL = { clear: 'Dry', rain: 'Rain', snow: 'Snow' };
const WIND_LABEL = { calm: 'light wind', breezy: 'breezy', windy: 'windy' };

function forecastDetail(w) {
  const parts = [];
  if (w.temp_f != null) parts.push(`${Math.round(w.temp_f)}°F`);
  if (w.wind_mph != null) {
    parts.push(`wind ${Math.round(w.wind_mph)} mph` + (w.gust_mph != null ? ` (gusts ${Math.round(w.gust_mph)})` : ''));
  }
  if (w.snow_cm) parts.push(`${w.snow_cm} cm snow`);
  else if (w.precip_mm) parts.push(`${w.precip_mm} mm rain`);
  if (w.precip_prob != null) parts.push(`${w.precip_prob}% chance of precipitation`);
  return parts.join(', ');
}

function binLabel(bin) {
  if (bin === 'dome') return 'Roof closed';
  const [precip, wind] = bin.split('_');
  return `${PRECIP_LABEL[precip] || precip}, ${WIND_LABEL[wind] || wind}`;
}

const pct = share => `${Math.round(share * 100)}%`;

// Returns {text, title} for a game's weather, or null when there's nothing to
// show (pre-weather predictions, or an open-air game with no forecast yet).
export function nflWeatherLabel(weather) {
  if (!weather || !weather.bin || weather.bin === 'legacy') return null;
  const mix = Array.isArray(weather.mix) && weather.mix.length > 1 ? weather.mix : null;
  if (weather.bin === 'dome' && !mix) {
    return { text: 'Indoors', title: 'Roof closed: predictions assume indoor conditions' };
  }
  if (weather.source !== 'forecast') return null;
  const text = mix ? `${binLabel(weather.bin)} · ${pct(mix[0][1])}` : binLabel(weather.bin);
  const when = weather.fetched_at
    ? new Date(weather.fetched_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    : null;
  const detail = forecastDetail(weather);
  const blend = mix
    ? ` Predictions blend the conditions by how likely each is: ${mix.map(([b, s]) => `${binLabel(b)} ${pct(s)}`).join(', ')}.`
    : ' Predictions are adjusted for these conditions.';
  const title = `${weather.locked ? 'Kickoff forecast' : 'Forecast'}${when ? ` (updated ${when})` : ''}`
    + (detail ? `: ${detail}` : '') + '.' + blend;
  return { text, title };
}
