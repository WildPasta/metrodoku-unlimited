/*
 * métrodoku archive rarity — content script (Manifest V3).
 *
 * Read-only companion for https://metrodoku.fr/?archive-date=YYYY-MM-DD pages.
 * After the site reveals the solutions (game over), it annotates:
 *   - each answered grid cell with the rarity % of the station played there,
 *   - each station row of the per-cell solutions modal with its %, reordered
 *     most-common-first (rarest last; stable ties, unknown stations bottom).
 * Since v0.1.1, the cell badge also appears LIVE in archive mode: as soon as
 * the site validates a placement (cell gains .correct + data-station-id), the
 * badge is injected from the cached snapshot distribution — parity with the
 * site's native daily behavior (the site itself reserves no rarity badge in
 * archive mode: shouldShowRarityUi() returns false there).
 *
 * Privacy: the publishable key is discovered per-run from the site's own
 * js/config.js and kept in memory only. Nothing is persisted; the only
 * network calls are the same-origin config.js/stations.json fetches and one
 * read-only RPC per archive date.
 */
(() => {
    "use strict";

    const ARCHIVE_DATE_PARAM = "archive-date";
    const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
    const CONFIG_PATH = "js/config.js";
    const STATIONS_PATH = "data/stations.json";
    const NOTE_TEXT = "pas de statistiques pour cette date";

    // Centralised selectors (site-refactor tripwire: if these break, we no-op loudly, never mis-inject).
    const SELECTORS = {
        // Validation marker set by the site's setAnsweredCell (app.js):
        // cell.classList.add("correct"); cell.dataset.stationId = station.id;
        // then cell.disabled = true. Same code path for daily and archive
        // games; ".grid.solution-mode" is only added later, at game over
        // (app.js grid refresh), so it must NOT gate live badges.
        cell: "button.cell.correct[data-station-id]",
        answerCard: ".answer-card",
        solutionsList: "#solutions-list",
        solutionsItem: ".solutions-item",
        solutionsName: ".solutions-item-name",
        solutionsMeta: ".solutions-item-meta",
    };

    const STYLE_ID = "mxd-archive-rarity-style";
    const NOTE_ID = "mxd-archive-rarity-note";

    const state = {
        config: null, // {url, key} — memory only, never persisted
        stationsById: null, // Map<id, nom>
        stationIdByName: null, // Map<nom, id>
        snapshots: new Map(), // dateKey -> {status: "ok"|"empty", stats}
        current: null, // {dateKey, snapshot}
        lastCellKey: null, // cell key whose solutions modal was last opened
        bootToken: 0, // guards against stale async boots on SPA navigation
    };

    // ------------------------------------------------------------------ utils

    function safe(fn, label) {
        try {
            return fn();
        } catch (error) {
            console.warn(`[metrodoku-archive-rarity] ${label}:`, error);
            return undefined;
        }
    }

    function dateKeyFromUrl() {
        return safe(() => {
            const value = (new URLSearchParams(window.location.search).get(ARCHIVE_DATE_PARAM) || "").trim();
            return DATE_KEY_RE.test(value) ? value : null;
        }, "dateKeyFromUrl") || null;
    }

    // The site's own formula (rarity.js): Math.round(weight / total * 1000) / 10.
    function percentFor(weight, total) {
        if (!Number.isFinite(weight) || !Number.isFinite(total) || total <= 0) {
            return null;
        }
        return Math.round((weight / total) * 1000) / 10;
    }

    // Mirrors the site's rarity tier labels so badges look native.
    function rarityLabel(percentage) {
        if (percentage <= 1) return `mythique - ${percentage}%`;
        if (percentage <= 2) return `très rare - ${percentage}%`;
        if (percentage <= 5) return `rare - ${percentage}%`;
        if (percentage <= 10) return `peu commun - ${percentage}%`;
        if (percentage <= 20) return `commun - ${percentage}%`;
        return `très commun - ${percentage}%`;
    }

    // ------------------------------------------------------------------ style

    function injectStyleOnce() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        // Visuals mirror the site's own .answer-rarity-badge / .solutions-item-percentage
        // (styles/grid.css, styles/modals.css) with fallbacks for the CSS variables.
        style.textContent = [
            ".mxd-cell-badge {",
            "    display: flex; align-items: center; justify-content: center;",
            "    width: calc(100% + 24px); min-height: 25px; margin: 0 -12px 10px; padding: 6px 10px;",
            "    box-sizing: border-box;",
            "    background: var(--color-surface-subtle, rgba(15, 23, 42, 0.05));",
            "    color: var(--color-text-muted, #475569);",
            "    text-align: center; font-family: inherit;",
            "    font-size: 0.62rem; font-weight: 800; line-height: 1.15; letter-spacing: 0;",
            "    pointer-events: none;",
            "}",
            ".mxd-solutions-pct {",
            "    color: #475569; font-size: 0.82rem; font-weight: 700;",
            "    font-variant-numeric: tabular-nums; white-space: nowrap;",
            "    pointer-events: none;",
            "}",
            ".mxd-note {",
            "    position: fixed; left: 16px; bottom: 16px; z-index: 9999;",
            "    max-width: 300px; padding: 8px 12px; border-radius: 8px;",
            "    background: var(--color-surface-subtle, rgba(15, 23, 42, 0.06));",
            "    color: var(--color-text-muted, #475569);",
            "    font: 700 0.72rem/1.35 'Helvetica', sans-serif;",
            "    pointer-events: none;",
            "}",
        ].join("\n");
        (document.head || document.documentElement).appendChild(style);
    }

    // ------------------------------------------------------------- data layer

    function ensureConfig() {
        if (state.config) return Promise.resolve(state.config);
        return fetch(new URL(CONFIG_PATH, window.location.origin), { credentials: "omit" })
            .then((res) => {
                if (!res.ok) throw new Error(`config.js HTTP ${res.status}`);
                return res.text();
            })
            .then((text) => {
                const url = text.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
                const key = text.match(/SUPABASE_PUBLISHABLE_KEY\s*=\s*["']([^"']+)["']/);
                if (!url || !key) throw new Error("config.js parse failed");
                state.config = { url: url[1].replace(/\/+$/, ""), key: key[1] };
                return state.config;
            });
    }

    function ensureStations() {
        if (state.stationsById) return Promise.resolve();
        return fetch(new URL(STATIONS_PATH, window.location.origin), { credentials: "omit" })
            .then((res) => {
                if (!res.ok) throw new Error(`stations.json HTTP ${res.status}`);
                return res.json();
            })
            .then((records) => {
                const byId = new Map();
                const byName = new Map();
                (Array.isArray(records) ? records : []).forEach((record) => {
                    if (!record || !record.id || !record.nom) return;
                    byId.set(String(record.id), String(record.nom));
                    if (!byName.has(String(record.nom))) byName.set(String(record.nom), String(record.id));
                });
                state.stationsById = byId;
                state.stationIdByName = byName;
            });
    }

    // One read-only snapshot RPC per archive date; cached in memory for the page's lifetime.
    function fetchSnapshot(config, dateKey) {
        return fetch(`${config.url}/rest/v1/rpc/get_daily_rarity_snapshot`, {
            method: "POST",
            credentials: "omit",
            headers: {
                "Content-Type": "application/json",
                apikey: config.key,
                Authorization: `Bearer ${config.key}`,
            },
            body: JSON.stringify({ p_date_key: dateKey }),
        }).then((res) => {
            if (!res.ok) throw new Error(`snapshot RPC HTTP ${res.status}`);
            return res.json();
        }).then((payload) => {
            const row = Array.isArray(payload) ? payload[0] : null;
            const stats = row && row.snapshot && row.snapshot.stats;
            if (!stats || typeof stats !== "object" || Object.keys(stats).length === 0) {
                return { status: "empty", stats: null };
            }
            return { status: "ok", stats };
        });
    }

    // ------------------------------------------------------------- DOM states

    function showNoStatsNote() {
        safe(() => {
            let note = document.getElementById(NOTE_ID);
            if (!note) {
                note = document.createElement("div");
                note.id = NOTE_ID;
                note.className = "mxd-note";
                note.setAttribute("aria-hidden", "true");
                document.body.appendChild(note);
            }
            note.textContent = NOTE_TEXT;
        }, "showNoStatsNote");
    }

    function removeNoStatsNote() {
        safe(() => {
            const note = document.getElementById(NOTE_ID);
            if (note) note.remove();
        }, "removeNoStatsNote");
    }

    function resetDom() {
        safe(() => {
            document.querySelectorAll(".mxd-cell-badge, .mxd-solutions-pct").forEach((el) => el.remove());
            removeNoStatsNote();
        }, "resetDom");
    }

    // ------------------------------------------------------------- decoration

    // One idempotent badge builder shared by BOTH trigger paths: the live
    // archive path (cell just became .correct[data-station-id] mid-game) and
    // the solution-mode path (post-gameover re-annotation). Only injects from
    // the cached snapshot distribution — never invents numbers (a station
    // absent from the distribution gets no badge), never touches a cell the
    // site has not validated, and never duplicates (a card that already
    // carries a badge is left untouched).
    function ensureCellBadge(cell) {
        const current = state.current;
        if (!current || !current.snapshot || current.snapshot.status !== "ok") return;
        const cellKey = `${cell.dataset.row}:${cell.dataset.col}`;
        const cellStats = current.snapshot.stats[cellKey];
        if (!cellStats) return;
        const weight = Number((cellStats.stations || {})[cell.dataset.stationId]);
        const percentage = percentFor(weight, Number(cellStats.totalAnswers));
        if (percentage == null) return;
        const card = cell.querySelector(SELECTORS.answerCard);
        if (!card || card.querySelector(".mxd-cell-badge")) return;
        const badge = document.createElement("div");
        badge.className = "mxd-cell-badge";
        badge.textContent = rarityLabel(percentage);
        badge.setAttribute("aria-label", `Jouee par ${percentage}% des joueurs sur cette case`);
        card.prepend(badge);
    }

    // Annotate every validated cell. In archive mode the MutationObserver
    // fires the moment the site marks a cell .correct, so the badge appears
    // immediately on validation; at game over the same function re-runs over
    // all answered cells and is a no-op for already-badged ones (no dupes).
    function decorateCells() {
        safe(() => {
            document.querySelectorAll(SELECTORS.cell).forEach(ensureCellBadge);
        }, "decorateCells");
    }

    // Percentages on each station row of the per-cell solutions modal.
    // Rows expose only the station *name*, so ids are matched via stations.json.
    // Rows are then reordered in the same decorated pass: most common first,
    // rarest last. Stations with no computable percentage (absent from the
    // distribution) keep their native relative order at the bottom, and the
    // sort is stable — ties keep the site's native relative order (index
    // tiebreak). appendChild moves are no-ops on an already-sorted list, so
    // repeated passes (modal re-scopes per cell) stay idempotent.
    function decorateSolutionsModal() {
        safe(() => {
            const current = state.current;
            if (!current || !current.snapshot || current.snapshot.status !== "ok") return;
            const list = document.querySelector(SELECTORS.solutionsList);
            if (!list || list.children.length === 0 || !state.lastCellKey) return;
            const cellStats = current.snapshot.stats[state.lastCellKey];
            if (!cellStats) return;
            const total = Number(cellStats.totalAnswers);
            const stations = cellStats.stations || {};
            const items = Array.from(list.querySelectorAll(SELECTORS.solutionsItem));
            const percentageByItem = new Map();
            items.forEach((item, index) => {
                const nameEl = item.querySelector(SELECTORS.solutionsName);
                const name = nameEl ? (nameEl.textContent || "").trim() : "";
                const stationId = name ? state.stationIdByName && state.stationIdByName.get(name) : null;
                const percentage = stationId != null ? percentFor(Number(stations[stationId]), total) : null;
                percentageByItem.set(item, percentage);
                if (percentage == null) return; // not in the distribution -> no invented numbers
                if (item.querySelector(".mxd-solutions-pct")) return; // already annotated (self-heals after resetDom)
                const meta = item.querySelector(SELECTORS.solutionsMeta) || item;
                const span = document.createElement("span");
                span.className = "mxd-solutions-pct";
                span.textContent = `${percentage}%`;
                span.setAttribute("aria-label", `Choisie par ${percentage}% des joueurs sur cette case (archive)`);
                meta.appendChild(span);
            });
            const desiredOrder = items
                .map((item, index) => ({ item, index, percentage: percentageByItem.get(item) }))
                .sort((a, b) => {
                    const pa = a.percentage;
                    const pb = b.percentage;
                    if (pa == null && pb == null) return a.index - b.index;
                    if (pa == null) return 1;
                    if (pb == null) return -1;
                    return (pb - pa) || (a.index - b.index); // descending, stable
                })
                .map((entry) => entry.item);
            // Only move nodes when the order actually differs: browsers fire
            // childList mutation records even for no-op appendChild moves, and
            // re-decorating on those records would loop forever. Compare against
            // the .solutions-item children only — desiredOrder never contains
            // other nodes (headers, empty states…), so a raw children comparison
            // would be permanently unequal and appendChild on every mutation
            // batch would self-sustain an infinite mutation loop.
            const currentItems = Array.from(list.children).filter((child) => child.matches(SELECTORS.solutionsItem));
            const needsMove = currentItems.length !== desiredOrder.length
                || currentItems.some((child, i) => child !== desiredOrder[i]);
            if (needsMove) desiredOrder.forEach((item) => list.appendChild(item));
        }, "decorateSolutionsModal");
    }

    function decorateAll() {
        injectStyleOnce();
        decorateCells();
        decorateSolutionsModal();
    }

    // ------------------------------------------------------------- debug hook

    function applyDebugHook(dateKey, snapshot) {
        safe(() => {
            const hook = { dateKey, totals: {}, shares: {} };
            if (snapshot && snapshot.status === "ok") {
                Object.keys(snapshot.stats).forEach((cellKey) => {
                    const cellStats = snapshot.stats[cellKey] || {};
                    const total = Number(cellStats.totalAnswers);
                    if (!Number.isFinite(total)) return;
                    hook.totals[cellKey] = total;
                    const shares = {};
                    const stations = cellStats.stations || {};
                    Object.keys(stations).forEach((stationId) => {
                        const percentage = percentFor(Number(stations[stationId]), total);
                        if (percentage != null) shares[stationId] = percentage;
                    });
                    hook.shares[cellKey] = shares;
                });
            }
            window.__metrodokuArchiveStats = hook;
        }, "applyDebugHook");
    }

    // ------------------------------------------------------------------- boot

    function handleNavChange() {
        const dateKey = dateKeyFromUrl();
        if (dateKey === (state.current && state.current.dateKey)) return false;
        state.bootToken += 1;
        state.current = null;
        state.lastCellKey = null;
        resetDom();
        return dateKey != null;
    }

    function boot(dateKey) {
        const token = state.bootToken;
        state.current = { dateKey, snapshot: null };
        injectStyleOnce();
        Promise.all([ensureConfig(), ensureStations()])
            .then(([config]) => {
                if (token !== state.bootToken) return null;
                const cached = state.snapshots.get(dateKey);
                return cached || fetchSnapshot(config, dateKey);
            })
            .then((snapshot) => {
                if (token !== state.bootToken || !snapshot) return;
                state.snapshots.set(dateKey, snapshot);
                state.current = { dateKey, snapshot };
                applyDebugHook(dateKey, snapshot);
                if (snapshot.status === "empty") showNoStatsNote();
                else removeNoStatsNote();
                decorateAll();
            })
            .catch((error) => {
                console.warn("[metrodoku-archive-rarity] snapshot unavailable:", error);
                if (token === state.bootToken) removeNoStatsNote();
            });
    }

    function run() {
        safe(() => {
            const dateKey = dateKeyFromUrl();
            if (!dateKey) return; // daily page: no archive mode, zero network calls
            boot(dateKey);
        }, "run");
    }

    function install() {
        // Track which cell the solutions modal was opened from (it only opens on cell click).
        document.addEventListener("click", (event) => {
            safe(() => {
                const cell = event.target && event.target.closest && event.target.closest(".cell");
                if (cell && cell.dataset && cell.dataset.row && cell.dataset.col) {
                    state.lastCellKey = `${cell.dataset.row}:${cell.dataset.col}`;
                }
            }, "clickCapture");
        }, true);

        // SPA navigation: date param changes without a full page load.
        // pushState/replaceState fire no event a content script can observe
        // (history monkey-patching cannot cross the isolated world), so poll
        // the URL — deterministic and independent of DOM churn. The observer's
        // handleNavChange call remains the instant path; this poll is the
        // safety net, and it also covers back/forward (hence no popstate).
        setInterval(() => {
            safe(() => {
                if (handleNavChange()) run();
            }, "navPoll");
        }, 1000);

        const observer = new MutationObserver(() => {
            safe(() => {
                if (handleNavChange()) run();
                if (state.current && state.current.snapshot && state.current.snapshot.status === "ok") {
                    decorateCells();
                    decorateSolutionsModal();
                }
            }, "observer");
        });
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class", "hidden"],
        });

        run();
    }

    safe(install, "install");
})();
