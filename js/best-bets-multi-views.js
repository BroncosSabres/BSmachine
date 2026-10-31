// best-bets-multi-views.js — the Multi Generator's result cards for bonus bet
// combos and system multis (best-bets-multi.js draws them), and the pieces
// every type's cards share: tiles and leg rows.
import { esc, odds, pct, signedPct, signCls, selectionText, bookLabel, sportTag, kickoffText, money } from './best-bets-shared.js';
import { marketOf, marketLabel } from './best-bets-filters.js';
import { sizeName } from './multi-system.js';

export function agoText(iso) {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return !isFinite(mins) ? '' : mins < 60 ? `${mins}m ago` : mins < 2880 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`;
}

export function tile(label, value, title, strong = false) {
  return `<div class="rounded-lg border ${strong ? 'border-amber-400 bg-amber-400/5' : 'border-gray-700'} px-2.5 py-1.5" title="${esc(title)}">
    <div class="text-[10px] uppercase tracking-wider ${strong ? 'text-amber-300' : 'text-gray-500'} font-semibold">${label}</div>
    <div class="text-base font-bold tabular-nums ${strong ? 'text-amber-300' : 'text-gray-100'}">${value}</div></div>`;
}

// A leg of a result: { id, row, price, p, pModel, basis, edge }. opts: book,
// showGame (the game under it), locked (it is), num (its number in the set)
export function legRow(l, { book, showGame = true, locked = false, num = null } = {}) {
  const r = l.row;
  const chanceTitle = l.basis === 'cal' ? `Calibrated chance; the model's is ${pct(l.pModel)}` : "The model's chance";
  return `<div class="flex items-start gap-2 sm:gap-3 py-2 border-t border-gray-700/60">
    ${num != null ? `<div class="w-4 shrink-0 text-xs font-bold text-gray-500 tabular-nums pt-0.5">${num}</div>` : ''}
    <div class="min-w-0 flex-1">
      <div class="font-semibold text-gray-100 leading-snug">${esc(selectionText(r))}
        <span class="text-[11px] font-normal text-gray-500">${esc(marketLabel(marketOf(r)))}</span></div>
      ${showGame ? `<div class="text-[11px] text-gray-500 leading-snug">${sportTag(r.sport)} · ${esc(r.home_team)} v ${esc(r.away_team)} · ${esc(kickoffText(r.kickoff))}</div>` : ''}
    </div>
    <div class="text-right tabular-nums shrink-0" title="${esc(`${bookLabel(book)}'s price when last checked (${agoText(r.checked_at)}); the average across the bookies ${odds(r.back)}. Check it at the bookie before you bet.`)}">
      <div class="font-semibold text-amber-400">${odds(l.price)}</div>
      <div class="hidden sm:block text-[11px] text-gray-500">avg ${odds(r.back)} · ${agoText(r.checked_at)}</div>
    </div>
    <div class="text-right tabular-nums w-14 sm:w-16 shrink-0" title="${esc(`${chanceTitle}. Below: the expected return per unit on this leg alone at ${bookLabel(book)}'s price.`)}">
      <div class="text-gray-100">${pct(l.p)}</div>
      <div class="text-[11px] ${signCls(l.edge)}">${signedPct(l.edge)}</div>
    </div>
    <div class="flex flex-col sm:flex-row gap-1 shrink-0">
      <button type="button" data-lock="${esc(l.id)}" aria-pressed="${locked}" title="${locked ? 'Unlock this leg' : 'Keep this leg in every multi, then generate again'}"
              class="w-7 h-7 rounded border ${locked ? 'border-amber-400 bg-amber-400/10' : 'border-gray-700 hover:border-gray-500'} text-xs">🔒</button>
      <button type="button" data-excl="${esc(l.id)}" title="Leave this leg out, then generate again"
              class="w-7 h-7 rounded border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-white text-xs">✕</button>
    </div>
  </div>`;
}

const legLine = (l, i) => `${i + 1}. ${selectionText(l.row)} (${marketLabel(marketOf(l.row))}) @ ${odds(l.price)} · ${l.row.home_team} v ${l.row.away_team}, ${kickoffText(l.row.kickoff)}`;
const comboLegs = (mask, n) => Array.from({ length: n }, (_, i) => i).filter(i => mask & (1 << i)).map(i => i + 1);
const cents = x => (x > 0 && x < 0.01 ? '<$0.01' : money(x));
// A profit in dollars: -$0.61 for a loss
const profit = x => (x < 0 ? `-${money(-x)}` : money(x));

// --- bonus bet combos -------------------------------------------------------------
// out: { settings, book, perK: [{ K, n, count, best, complete, reason, groups,
// dropped }], results: [{ K, n, count, legs, ev, stats, combos }] }; bonus: the
// bonus to split (the settings' now: the cash scales with it)

// The best set for each number of legs per combo, to pick one (filterK)
export function combosSummaryHtml(out, bonus, filterK) {
  const chip = (k, label, title, on) => `<button type="button" data-combo-k="${k}" aria-pressed="${on}" title="${esc(title)}"
    class="px-2 py-1 rounded-md border text-xs ${on ? 'border-amber-400 bg-amber-400/10 text-amber-200' : 'border-gray-700 text-gray-300 hover:border-gray-500'}">${label}</button>`;
  const items = out.perK.map(pk => {
    const b = pk.best;
    const head = `${pk.K} legs`;
    if (!b) {
      const why = pk.reason === 'few-groups' ? 'too few games with legs' : pk.reason === 'no-n' ? `no number of legs makes about ${out.settings.bets} bets`
        : pk.reason?.startsWith('locked') ? "the locked legs don't fit" : 'none in the window';
      return `<span class="px-2 py-1 rounded-md border border-gray-800 text-xs text-gray-500" title="${esc(`${pk.K} legs per combo: ${why}`)}">${head}: –</span>`;
    }
    const title = `${pk.K} legs per combo: the best is ${pk.n} legs, ${pk.count} bets of ${cents(bonus / pk.count)}. Expected cash ${money(b.stats.ev * bonus)} `
      + `(${pct(b.stats.ev, 0)} of the bonus), nothing back ${pct(b.stats.pNothing)}${pk.complete ? '' : '. The search was cut short: the best found'}`;
    return chip(pk.K, `${head}: <span class="font-semibold tabular-nums">${pct(b.stats.ev, 0)}</span> <span class="text-gray-500">· ${pk.count} bets${pk.complete ? '' : ' ·⏱'}</span>`, title, filterK === pk.K);
  });
  return `<div class="flex flex-wrap items-center gap-1.5 text-xs text-gray-500"><span title="The expected cash each number of legs per combo makes at best, as a share of the bonus. Pick one to see only those.">Best by legs per combo:</span>
    ${chip('', 'All', 'Every number of legs per combo', filterK == null)} ${items.join(' ')}</div>`;
}

export function combosCardHtml(res, i, out, { bonus, sortBy, lockedIds }) {
  const s = res.stats, per = bonus / res.count, sgm = res.combos.some(c => c.sgm);
  const comboRows = res.combos.map(c => `<div class="flex items-center gap-3 py-1 border-t border-gray-700/40 tabular-nums">
      <span class="flex-1 text-gray-300">${comboLegs(c.mask, res.legs.length).join(' + ')}${c.sgm ? ' <span class="text-[10px] text-amber-300/80" title="Has legs of one game: priced as the bookie\'s Same Game Multi would be at the model\'s correlation (an estimate: check the bookie\'s quote)">SGM est.</span>' : ''}</span>
      <span class="w-14 text-right text-amber-400 font-semibold">${odds(c.price)}</span>
      <span class="w-14 text-right text-gray-300">${pct(c.p)}</span>
      <span class="w-20 text-right text-gray-400">${money(per * (c.price - 1))}</span></div>`).join('');
  return `<div class="rounded-xl border border-gray-700 bg-gray-800/40 p-3">
    <div class="flex items-baseline justify-between gap-3 flex-wrap">
      <div class="text-sm text-gray-300"><span class="font-bold text-gray-100">#${i + 1}</span> ·
        ${res.legs.length} legs, ${res.K} per combo → <span class="font-bold text-gray-100">${res.count} bets of ${cents(per)}</span> at ${esc(bookLabel(out.book))} ·
        combos <span class="tabular-nums text-amber-400 font-semibold">${odds(s.lo)}–${odds(s.hi)}</span>${sgm ? ' <span class="text-[11px] text-amber-300/80">some SGM est.</span>' : ''}</div>
      <button type="button" data-copy="${i}" class="text-xs text-blue-400 hover:underline">Copy combos</button>
    </div>
    <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
      ${tile('Expected cash', `${money(s.ev * bonus)} <span class="text-xs font-semibold text-gray-400">${pct(s.ev, 0)}</span>`, `${sortBy === 'ev' ? 'What they are sorted by. ' : ''}The cash the ${money(bonus)} of bonus bets returns on average: each combo's chance times what it pays (its price less 1 a dollar: a bonus bet's stake doesn't come back), added up. ${pct(s.ev, 1)} of the bonus.`, sortBy === 'ev')}
      ${tile('Nothing back', pct(s.pNothing), `${sortBy === 'nothing' ? 'What they are sorted by: the' : 'The'} chance no combo wins${sgm ? '' : `: fewer than ${res.K} of the ${res.legs.length} legs win`}`, sortBy === 'nothing')}
      ${tile('Median cash', money(s.median * bonus), 'Half the time the combos return at least this much')}
      ${tile('10–90%', `${money(s.p10 * bonus)}–${money(s.p90 * bonus)}`, 'The cash 8 times in 10: between the 10th and the 90th percentile')}
    </div>
    <div class="mt-2">${res.legs.map((l, j) => legRow(l, { book: out.book, locked: lockedIds.has(l.id), num: j + 1 })).join('')}</div>
    <details class="mt-2 border-t border-gray-700/60 pt-2">
      <summary class="cursor-pointer select-none text-xs text-gray-400">The ${res.count} combos <span class="text-gray-500">(legs by number, price, chance, cash if it wins)</span></summary>
      <div class="mt-1 text-xs">${comboRows}</div>
    </details>
  </div>`;
}

export function combosText(res, out, bonus) {
  const per = bonus / res.count;
  return [`Bonus bet combos at ${bookLabel(out.book)}: ${res.legs.length} legs, ${res.K} per combo, ${res.count} bets of ${cents(per)}`,
          ...res.legs.map(legLine), '',
          ...res.combos.map((c, j) => `Bet ${j + 1}: legs ${comboLegs(c.mask, res.legs.length).join(' + ')} @ ${odds(c.price)}${c.sgm ? ' (SGM est.)' : ''}`)].join('\n');
}

// --- system multis ------------------------------------------------------------------
// stake: { unit: dollars (or bank shares, when dollars is false) per unit of
// Kelly's stakes, dollars, label: how they were sized }

export function systemCardHtml(res, i, out, { stake, sortBy, lockedIds }) {
  const n = res.legs.length, ks = out.ks;
  const total = ks.reduce((t, _, j) => t + res.s[j] * res.stats.levels[j].count, 0) * stake.unit;
  const amount = x => (stake.dollars ? cents(x) : pct(x, x < 0.001 ? 3 : 2));
  const st = res.stats;
  const none = !(total > 0);
  const rows = res.stats.levels.map((lv, j) => {
    const each = res.s[j] * stake.unit;
    return `<tr class="border-t border-gray-700/40 tabular-nums">
      <td class="py-1 pr-2 text-left text-gray-200">${sizeName(lv.k, n)}</td>
      <td class="py-1 px-2 text-right text-gray-400">${lv.count}</td>
      <td class="py-1 px-2 text-right font-semibold ${each > 0 ? 'text-gray-100' : 'text-gray-600'}">${each > 0 ? amount(each) : '–'}</td>
      <td class="py-1 px-2 text-right ${each > 0 ? 'text-gray-300' : 'text-gray-600'}">${each > 0 ? amount(each * lv.count) : '–'}</td>
      <td class="py-1 px-2 text-right ${signCls(lv.ev)}">${signedPct(lv.ev)}</td>
      <td class="py-1 pl-2 text-right text-gray-400">${pct(lv.pReturn)}</td></tr>`;
  }).join('');
  return `<div class="rounded-xl border border-gray-700 bg-gray-800/40 p-3">
    <div class="flex items-baseline justify-between gap-3 flex-wrap">
      <div class="text-sm text-gray-300"><span class="font-bold text-gray-100">#${i + 1}</span> ·
        ${n} legs, ${ks.length === 1 ? sizeName(ks[0], n).toLowerCase() : `sizes ${ks[0]}–${ks.at(-1)}`} at ${esc(bookLabel(out.book))} ·
        <span class="font-bold text-gray-100">${none ? 'no stake' : `${amount(total)} in all`}</span></div>
      ${none ? '' : `<button type="button" data-copy="${i}" class="text-xs text-blue-400 hover:underline">Copy betslip</button>`}
    </div>
    ${none ? `<p class="mt-2 text-xs text-amber-300">No stake: at the cautious chances the stakes are worked out on, no size of combo grows the bank. Try other sizes or legs.</p>` : `
    <div class="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-2">
      ${tile('Stake', amount(total), stake.label)}
      ${tile('Expected profit', `<span class="${signCls(st.ev)}">${stake.dollars ? profit(st.ev * total) : signedPct(st.ev)}</span>${stake.dollars ? ` <span class="text-xs font-semibold ${signCls(st.ev)}">${signedPct(st.ev)}</span>` : ''}`, `${sortBy === 'ev' ? 'What they are sorted by. ' : ''}The profit on average at the legs' chances shown, and as a share of the stake`, sortBy === 'ev')}
      ${tile('Profit chance', pct(st.pProfit), 'The chance the combos that win pay back more than the whole stake')}
      ${tile('Nothing back', pct(st.pNothing), `The chance no combo staked wins: fewer legs win than the smallest size staked`)}
      ${tile('Median', `<span class="${signCls(st.median)}">${stake.dollars ? profit(st.median * total) : signedPct(st.median)}</span>`, 'Half the time the profit is at least this (a loss when negative)')}
    </div>`}
    <div class="mt-2 overflow-x-auto"><table class="w-full text-xs">
      <thead><tr class="text-[10px] uppercase tracking-wider text-gray-500">
        <th class="py-1 pr-2 text-left font-semibold">Size</th>
        <th class="py-1 px-2 text-right font-semibold" title="Combos of this size">Bets</th>
        <th class="py-1 px-2 text-right font-semibold" title="The stake on each combo of this size">Each</th>
        <th class="py-1 px-2 text-right font-semibold">Total</th>
        <th class="py-1 px-2 text-right font-semibold" title="The expected return per dollar on this size's combos, at the legs' chances shown">EV</th>
        <th class="py-1 pl-2 text-right font-semibold" title="The chance at least one combo of this size wins: at least this many legs win">Any wins</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
    <div class="mt-2">${res.legs.map((l, j) => legRow(l, { book: out.book, locked: lockedIds.has(l.id), num: j + 1 })).join('')}</div>
  </div>`;
}

export function systemText(res, out, stake) {
  const n = res.legs.length;
  const lines = res.stats.levels.map((lv, j) => ({ lv, each: res.s[j] * stake.unit })).filter(x => x.each > 0)
    .map(({ lv, each }) => `${sizeName(lv.k, n)} (${lv.count}): ${stake.dollars ? cents(each) : pct(each, 3)} each = ${stake.dollars ? cents(each * lv.count) : pct(each * lv.count, 2)}`);
  return [`System multi at ${bookLabel(out.book)}: ${n} legs`, ...res.legs.map(legLine), '', ...lines].join('\n');
}
