// competition.js
// NRL and NRLW share the /nrl/pages/ files; the URL alone decides which one
// a page shows (?comp=nrlw). Nothing is remembered between pages, so a link
// always lands on the competition it names.
export function getCompetition() {
  const params = new URLSearchParams(window.location.search);
  const comp = params.get('comp') || params.get('competition');
  return comp === 'nrlw' ? 'nrlw' : 'nrl';
}

// Query string to append to same-competition links ('' for NRL).
export function compQuery() {
  return getCompetition() === 'nrlw' ? '?comp=nrlw' : '';
}

export function compLabel() {
  return getCompetition() === 'nrlw' ? 'NRLW' : 'NRL';
}
