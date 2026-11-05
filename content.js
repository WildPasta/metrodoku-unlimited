/*
 * Metrodoku Unlimited - Content Script (Manifest V3)
 *
 * Read-only companion for https://metrodoku.fr/?archive-date=YYYY-MM-DD pages:
 * rarity badges on validated cells, percentages in the solutions modal (sorted
 * most-common-first), and the "score d'originalité" restored — the site
 * computes it in archive mode but hides it; we port its exact formulas
 * (app.js v=20260515-1) on top of the cached snapshot.
 *
 * Privacy: the Supabase publishable key is read per-run from the site's own
 * js/config.js and kept in memory only. Network calls: two same-origin
 * fetches (config.js, stations.json) and one read-only RPC per archive date.
 */
(() => {
    "use strict";

    const ARCHIVE_DATE_PARAM = "archive-date";
    const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
    const CONFIG_PATH = "js/config.js";
    const STATIONS_PATH = "data/stations.json";
    const NOTE_TEXT = "pas de statistiques pour cette date";

    // Score d'originalité — verbatim from app.js v=20260515-1 and config.js
    // (MAX_WRONG_ANSWERS is re-read per-run from config.js; fallback in step).
    const SCORE_BONUS_PER_CORRECT_ANSWER = 15;
    const SCORE_PENALTY_PER_MISTAKE = 20;
    const FALLBACK_MAX_WRONG_ANSWERS = 3;
    // storage.js saveGameState() key format for archive games.
    const ARCHIVE_STATE_PREFIX = "metrodoku:archive:";
    const SCORE_HEADER_DISPLAY_ID = "score-display";
    const SCORE_HEADER_VALUE_ID = "score-value";
    const SCORE_ENDGAME_VALUE_ID = "endgame-score-value";
    const SCORE_ENDGAME_CARD_SELECTOR = ".endgame-stat-card";

    // Site-refactor tripwire: if these break, we no-op loudly, never mis-inject.
    const SELECTORS = {
        // Set only by setAnsweredCell (validation + resume), never by the
        // game-over reveal — exactly the player's validated answers. Do not
        // gate on solution-mode: it appears only at game over.
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
        config: null, // {url, key, maxWrongAnswers} — memory only, never persisted
        stationsById: null, // Map<id, nom>
        stationIdByName: null, // Map<nom, id>
        snapshots: new Map(), // dateKey -> {status: "ok"|"empty", stats}
        current: null, // {dateKey, snapshot}
        lastCellKey: null, // cell key whose solutions modal was last opened
        bootToken: 0, // guards against stale async boots on SPA navigation
        wrongFlashCount: 0, // fallback mistake tracker (localStorage unreadable)
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
        // Visuals mirror the site's .answer-rarity-badge / .solutions-item-percentage styles.
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
                // MAX_WRONG_ANSWERS (score penalty cap) lives in the same config.js;
                // keep the known default if the site renames it.
                const maxWrong = text.match(/MAX_WRONG_ANSWERS\s*=\s*(\d+)/);
                state.config = {
                    url: url[1].replace(/\/+$/, ""),
                    key: key[1],
                    maxWrongAnswers: maxWrong ? Number(maxWrong[1]) : FALLBACK_MAX_WRONG_ANSWERS,
                };
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

    // Idempotent badge builder, shared by the live path (cell just validated
    // mid-game) and the game-over pass. Only site-validated cells, only real
    // distribution numbers — a station absent from the snapshot gets no badge.
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

    // Observer-driven: runs the moment a cell validates, and again over all
    // answered cells at game over (no-op on already-badged ones).
    function decorateCells() {
        safe(() => {
            document.querySelectorAll(SELECTORS.cell).forEach(ensureCellBadge);
        }, "decorateCells");
    }

    // Per-cell solutions modal: rows expose only the station *name*, so ids
    // come from stations.json. Rows get a % and are re-sorted most-common-first
    // (stable ties; unknown stations keep native order at the bottom).
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
            // Move only when the order actually differs (appendChild fires
            // mutation records even for no-op moves → infinite re-decorate
            // loop otherwise), and compare against .solutions-item children
            // only: desiredOrder never holds other nodes (headers…), so a
            // raw children list would never match.
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
        updateScoreDisplays();
    }

    // ------------------------------------------------- score d'originalité
    // Port of the site's own scoring (app.js v=20260515-1: getScoreSummary,
    // getAnswerScore and friends). The site computes it for archives too but
    // hides the UI (shouldShowRarityUi() → false), so we recompute the same
    // number from the cached snapshot and feed the site's own displays.

    function roundScore(value) {
        return Math.round(value * 10) / 10;
    }

    function formatScoreValue(value) {
        if (Math.abs(value - Math.round(value)) < 0.001) {
            return String(Math.round(value));
        }

        return value.toLocaleString("fr-FR", {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        });
    }

    // buildScoreLabel() (app.js): the total is rounded to an integer for display.
    function buildScoreLabel(score, maxScore) {
        return `${formatScoreValue(Math.round(score))}/${formatScoreValue(maxScore)}`;
    }

    function getMaxWrongAnswers() {
        const value = state.config ? Number(state.config.maxWrongAnswers) : NaN;
        return Number.isFinite(value) && value > 0 ? value : FALLBACK_MAX_WRONG_ANSWERS;
    }

    // The site persists archive games in localStorage under
    // `metrodoku:archive:<dateKey>` (version 1) with a `remainingMistakes`
    // countdown: mistakesMade = MAX − remaining.
    function readPersistedArchiveState(dateKey) {
        return safe(() => {
            const raw = window.localStorage.getItem(ARCHIVE_STATE_PREFIX + dateKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== 1 || parsed.dateKey !== dateKey) return null;
            if (!Array.isArray(parsed.answers)) return null;
            return parsed;
        }, "readPersistedArchiveState") || null;
    }

    function countMistakes(dateKey) {
        const max = getMaxWrongAnswers();
        const persisted = readPersistedArchiveState(dateKey);
        if (persisted && Number.isFinite(Number(persisted.remainingMistakes))) {
            const remaining = Math.min(Math.max(Number(persisted.remainingMistakes), 0), max);
            return max - remaining;
        }
        // localStorage unavailable: fall back to the live wrong-flash tracker.
        return state.wrongFlashCount;
    }

    // Validated answers. Preferred: the site's persisted records
    // ({rowId, columnId, stationId, scoreValue?}). Fallback: validated DOM
    // cells — the game-over reveal never marks them, so they are exactly the
    // player's answers (no stored scoreValue → computed from the snapshot).
    function collectValidatedAnswers(dateKey) {
        const persisted = readPersistedArchiveState(dateKey);
        if (persisted) {
            return persisted.answers.filter((record) => record && record.rowId && record.columnId && record.stationId != null);
        }
        return safe(() => Array.from(document.querySelectorAll(SELECTORS.cell)).map((cell) => ({
            rowId: cell.dataset.row,
            columnId: cell.dataset.col,
            stationId: cell.dataset.stationId,
        })), "collectValidatedAnswers.dom") || [];
    }

    // getAnswerScore() port (stored scoreValue handled by the caller): rank
    // score over the cell's snapshot distribution — N = station-set size
    // (verified live: map == the cell's possible answers, all isComplete),
    // strict < so ties share rank; rarest → 100, most common → 100/N. Like
    // the site, this never returns null: absent station → weight 0 → 100,
    // unusable stats → flat 100 (the site's terminal fallback).
    function computeAnswerScore(cellStats, stationId) {
        const stations = cellStats && cellStats.stations ? cellStats.stations : null;
        if (!stations || Object.keys(stations).length === 0) {
            return 100; // site terminal fallback (no usable cell stats)
        }
        if (Object.prototype.hasOwnProperty.call(stations, stationId)) {
            const n = Object.keys(stations).length;
            const targetCount = Number(stations[stationId]) || 0;
            const betterRanksCount = Object.keys(stations).reduce((count, id) => {
                return (Number(stations[id]) || 0) < targetCount ? count + 1 : count;
            }, 0);
            const rank = betterRanksCount + 1;
            return roundScore((100 * (n - rank + 1)) / n);
        }
        // Absent from the distribution: weight 0 → maximally rare → 100.
        return 100;
    }

    // getScoreSummary() port: Σ per-answer scores (stored scoreValue wins),
    // +15 per validated cell, −20 per mistake, clamped to [0, cells × 100].
    function computeScoreSummary() {
        const current = state.current;
        if (!current || !current.snapshot || current.snapshot.status !== "ok") return null;
        const stats = current.snapshot.stats;
        const answers = collectValidatedAnswers(current.dateKey);
        const mistakes = countMistakes(current.dateKey);
        const maxScore = Object.keys(stats).length * 100;
        let baseScore = 0;
        answers.forEach((record) => {
            const cellStats = stats[`${record.rowId}:${record.columnId}`];
            // JSON null/"" means "not locked": recompute (Number(null) === 0
            // would silently zero it).
            const raw = record.scoreValue;
            const stored = raw == null || raw === "" ? NaN : Number(raw);
            const score = Number.isFinite(stored)
                ? roundScore(stored)
                : computeAnswerScore(cellStats, String(record.stationId));
            if (score != null) baseScore += score;
        });
        const bonus = answers.length * SCORE_BONUS_PER_CORRECT_ANSWER;
        const penalty = mistakes * SCORE_PENALTY_PER_MISTAKE;
        const score = Math.min(maxScore, Math.max(0, baseScore + bonus - penalty));
        return { score: roundScore(score), maxScore, mistakes };
    }

    // Guarded writes only (skip if the node already carries the value): the
    // site's refreshScoreDisplays() re-hides and empties the displays on
    // archive pages, and unguarded writes would ping-pong mutations forever.
    function updateScoreDisplays() {
        safe(() => {
            const summary = computeScoreSummary();
            if (!summary) return;
            const label = buildScoreLabel(summary.score, summary.maxScore);
            const display = document.getElementById(SCORE_HEADER_DISPLAY_ID);
            if (display && display.hidden) display.hidden = false;
            const value = document.getElementById(SCORE_HEADER_VALUE_ID);
            if (value && value.textContent !== label) value.textContent = label;
            const endgameValue = document.getElementById(SCORE_ENDGAME_VALUE_ID);
            if (endgameValue) {
                const card = endgameValue.closest(SCORE_ENDGAME_CARD_SELECTOR);
                if (card && card.hidden) card.hidden = false;
                if (endgameValue.textContent !== label) endgameValue.textContent = label;
            }
        }, "updateScoreDisplays");
    }

    // Fallback mistake tracker (localStorage unreadable): counts wrong-flash
    // class transitions absent → present. The site's remove+re-add restart
    // yields exactly one transition per flash; the timeout's later removal
    // (oldValue already has the class) is not counted.
    function countWrongFlashes(mutations) {
        (mutations || []).forEach((mutation) => {
            if (!mutation || mutation.type !== "attributes" || mutation.attributeName !== "class") return;
            const target = mutation.target;
            if (!target || !target.classList || !target.classList.contains("wrong-flash")) return;
            const oldValue = String(mutation.oldValue || "");
            if (oldValue.split(/\s+/).indexOf("wrong-flash") !== -1) return;
            state.wrongFlashCount += 1;
        });
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
            // Live score introspection (score d'originalité) — re-computed on call.
            hook.scoreSummary = () => safe(() => computeScoreSummary(), "debugHook.scoreSummary") || null;
        }, "applyDebugHook");
    }

    // ------------------------------------------------------------------- boot

    function handleNavChange() {
        const dateKey = dateKeyFromUrl();
        if (dateKey === (state.current && state.current.dateKey)) return false;
        state.bootToken += 1;
        state.current = null;
        state.lastCellKey = null;
        state.wrongFlashCount = 0;
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

        // SPA navigation: pushState fires no observable event from the
        // isolated world, so poll the URL — the safety net behind the
        // observer's instant path (also covers back/forward → no popstate).
        setInterval(() => {
            safe(() => {
                if (handleNavChange()) run();
            }, "navPoll");
        }, 1000);

        const observer = new MutationObserver((mutations) => {
            safe(() => {
                countWrongFlashes(mutations);
                if (handleNavChange()) run();
                if (state.current && state.current.snapshot && state.current.snapshot.status === "ok") {
                    decorateCells();
                    decorateSolutionsModal();
                    updateScoreDisplays();
                }
            }, "observer");
        });
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class", "hidden"],
            attributeOldValue: true,
        });

        run();
    }

    safe(install, "install");
})();
